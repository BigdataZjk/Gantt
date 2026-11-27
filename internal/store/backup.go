package store

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"rsm/internal/auth"
)

type BackupManifest struct {
	Format        int               `json:"format"`
	SchemaVersion int               `json:"schemaVersion"`
	Version       string            `json:"version"`
	Revision      int64             `json:"revision"`
	CreatedAt     string            `json:"createdAt"`
	Files         map[string]string `json:"files"`
}

func Lock(home string) (func(), error) {
	dir := filepath.Join(home, "run")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(filepath.Join(dir, "server.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("此实例仍在运行，或正在执行恢复")
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
func digest(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

func readOnlyDSN(path string) string {
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	return u.String()
}
func (s *Store) Backup(ctx context.Context, output, version string) (BackupManifest, error) {
	var manifest BackupManifest
	output, e := filepath.Abs(output)
	if e != nil {
		return manifest, e
	}
	if output == filepath.Join(s.Home, "data", "rsm.db") || output == filepath.Join(s.Home, "secrets", "password.key") {
		return manifest, errors.New("备份目标不能覆盖数据库或密钥")
	}
	if e = os.MkdirAll(filepath.Dir(output), 0700); e != nil {
		return manifest, e
	}
	temp, e := os.MkdirTemp("", "rsm-consistent-backup-")
	if e != nil {
		return manifest, e
	}
	defer os.RemoveAll(temp)
	path := filepath.Join(temp, "rsm.db")
	// Keep the live Store connection available while SQLite copies the snapshot.
	source, e := sql.Open("sqlite3", readOnlyDSN(filepath.Join(s.Home, "data", "rsm.db")))
	if e != nil {
		return manifest, e
	}
	_, e = source.ExecContext(ctx, "vacuum into ?", path)
	source.Close()
	if e != nil {
		return manifest, e
	}
	data, e := os.ReadFile(path)
	if e != nil {
		return manifest, e
	}
	key, e := os.ReadFile(filepath.Join(s.Home, "secrets", "password.key"))
	if e != nil {
		return manifest, e
	}
	files := map[string][]byte{"data/rsm.db": data, "secrets/password.key": key}
	cfg, e := os.ReadFile(filepath.Join(s.Home, "config.json"))
	if e == nil {
		files["config.json"] = cfg
	} else if !errors.Is(e, os.ErrNotExist) {
		return manifest, e
	}
	db, e := sql.Open("sqlite3", readOnlyDSN(path))
	if e != nil {
		return manifest, e
	}
	e = db.QueryRowContext(ctx, "select schema_version,revision from metadata where id=1").Scan(&manifest.SchemaVersion, &manifest.Revision)
	db.Close()
	if e != nil {
		return manifest, e
	}
	manifest.Format = 1
	manifest.Version = version
	manifest.CreatedAt = now()
	manifest.Files = map[string]string{}
	for name, b := range files {
		manifest.Files[name] = digest(b)
	}
	manifestJSON, e := json.MarshalIndent(manifest, "", "  ")
	if e != nil {
		return manifest, e
	}
	files["manifest.json"] = manifestJSON
	f, e := os.CreateTemp(filepath.Dir(output), ".rsm-backup-*.tmp")
	if e != nil {
		return manifest, e
	}
	name := f.Name()
	defer os.Remove(name)
	_ = f.Chmod(0600)
	e = writeBackupArchive(f, files, strings.EqualFold(filepath.Ext(output), ".zip"))
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return manifest, e
	}
	if closeErr != nil {
		return manifest, closeErr
	}
	if _, e = os.Stat(output); e == nil {
		return manifest, errors.New("备份文件已存在，拒绝覆盖")
	}
	if e = os.Link(name, output); e != nil {
		return manifest, e
	}
	return manifest, nil
}

func writeBackupArchive(output io.Writer, files map[string][]byte, zipFormat bool) error {
	if zipFormat {
		writer := zip.NewWriter(output)
		for _, name := range []string{"manifest.json", "data/rsm.db", "secrets/password.key", "config.json"} {
			content, ok := files[name]
			if !ok {
				continue
			}
			header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Now()}
			header.SetMode(0600)
			entry, err := writer.CreateHeader(header)
			if err != nil {
				return err
			}
			if _, err = entry.Write(content); err != nil {
				return err
			}
		}
		return writer.Close()
	}
	g := gzip.NewWriter(output)
	tw := tar.NewWriter(g)
	for _, name := range []string{"manifest.json", "data/rsm.db", "secrets/password.key", "config.json"} {
		b, ok := files[name]
		if !ok {
			continue
		}
		if e := tw.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(b)), Typeflag: tar.TypeReg, ModTime: time.Now()}); e != nil {
			return e
		}
		if _, e := tw.Write(b); e != nil {
			return e
		}
	}
	if e := tw.Close(); e != nil {
		return e
	}
	return g.Close()
}

func readBackupArchive(input string) (map[string][]byte, error) {
	f, e := os.Open(input)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	var signature [4]byte
	if _, e = f.ReadAt(signature[:], 0); e != nil {
		return nil, e
	}
	if signature[0] == 'P' && signature[1] == 'K' {
		info, e := f.Stat()
		if e != nil {
			return nil, e
		}
		reader, e := zip.NewReader(f, info.Size())
		if e != nil {
			return nil, e
		}
		if len(reader.File) > 4 {
			return nil, errors.New("备份内含多余文件")
		}
		files := map[string][]byte{}
		var total uint64
		for _, entry := range reader.File {
			_, duplicate := files[entry.Name]
			if !entry.Mode().IsRegular() || duplicate || !validBackupName(entry.Name) || entry.UncompressedSize64 > 1<<30 {
				return nil, errors.New("备份内含非法路径、类型或过大文件")
			}
			total += entry.UncompressedSize64
			if total > 1<<30 {
				return nil, errors.New("备份解压内容超过1 GiB")
			}
			content, e := entry.Open()
			if e != nil {
				return nil, e
			}
			data, readErr := io.ReadAll(io.LimitReader(content, int64(entry.UncompressedSize64)+1))
			closeErr := content.Close()
			if readErr != nil || closeErr != nil || uint64(len(data)) != entry.UncompressedSize64 {
				return nil, errors.New("备份文件不完整或 ZIP 校验失败")
			}
			files[entry.Name] = data
		}
		return files, nil
	}
	gz, e := gzip.NewReader(f)
	if e != nil {
		return nil, e
	}
	defer gz.Close()
	limited := &io.LimitedReader{R: gz, N: (1 << 30) + 1}
	tr := tar.NewReader(limited)
	files := map[string][]byte{}
	var total int64
	for {
		h, e := tr.Next()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			return nil, e
		}
		_, duplicate := files[h.Name]
		if h.Typeflag != tar.TypeReg || duplicate || !validBackupName(h.Name) || h.Size < 0 || h.Size > 1<<30 {
			return nil, errors.New("备份内含非法路径、类型或过大文件")
		}
		total += h.Size
		if total > 1<<30 {
			return nil, errors.New("备份解压内容超过1 GiB")
		}
		b, e := io.ReadAll(tr)
		if e != nil || int64(len(b)) != h.Size {
			return nil, errors.New("备份文件不完整")
		}
		files[h.Name] = b
	}
	// Reading through the gzip trailer detects truncated or corrupt archives.
	if _, e = io.Copy(io.Discard, limited); e != nil {
		return nil, e
	}
	if limited.N == 0 {
		return nil, errors.New("备份解压内容超过1 GiB")
	}
	return files, nil
}

func validBackupName(name string) bool {
	return name == "manifest.json" || name == "data/rsm.db" || name == "secrets/password.key" || name == "config.json"
}

func unpackBackup(input, dir string) (BackupManifest, error) {
	var manifest BackupManifest
	files, e := readBackupArchive(input)
	if e != nil {
		return manifest, e
	}
	if files["manifest.json"] == nil || files["data/rsm.db"] == nil || files["secrets/password.key"] == nil {
		return manifest, errors.New("备份缺少数据库、密钥或清单")
	}
	if e = json.Unmarshal(files["manifest.json"], &manifest); e != nil || manifest.Format != 1 || manifest.SchemaVersion != 1 {
		return manifest, errors.New("备份格式或数据库版本不兼容")
	}
	if len(files["secrets/password.key"]) != 32 {
		return manifest, errors.New("备份密码密钥无效")
	}
	for name, b := range files {
		if name == "manifest.json" {
			continue
		}
		if manifest.Files[name] != digest(b) {
			return manifest, fmt.Errorf("备份校验失败：%s", name)
		}
	}
	if len(manifest.Files) != len(files)-1 {
		return manifest, errors.New("备份清单与内容不一致")
	}
	for name, b := range files {
		if name == "manifest.json" {
			continue
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			return manifest, e
		}
		if e = os.WriteFile(path, b, 0600); e != nil {
			return manifest, e
		}
	}
	return manifest, nil
}
func verifyExtracted(ctx context.Context, dir string, m BackupManifest) error {
	path := filepath.Join(dir, "data", "rsm.db")
	db, e := sql.Open("sqlite3", readOnlyDSN(path))
	if e != nil {
		return e
	}
	defer db.Close()
	var check string
	if e = db.QueryRowContext(ctx, "pragma integrity_check").Scan(&check); e != nil {
		return e
	}
	if check != "ok" {
		return errors.New("备份数据库完整性校验失败")
	}
	var schema int
	var rev int64
	if e = db.QueryRowContext(ctx, "select schema_version,revision from metadata where id=1").Scan(&schema, &rev); e != nil {
		return e
	}
	if schema != m.SchemaVersion || rev != m.Revision {
		return errors.New("备份数据库与版本清单不一致")
	}
	vault, e := auth.OpenVault(dir, true)
	if e != nil {
		return e
	}
	rows, e := db.QueryContext(ctx, "select id,password_cipher from users")
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var raw []byte
		if e = rows.Scan(&id, &raw); e != nil {
			return e
		}
		if _, e = vault.Decrypt(id, raw); e != nil {
			return e
		}
	}
	return rows.Err()
}
func VerifyBackup(ctx context.Context, input string) (BackupManifest, error) {
	temp, e := os.MkdirTemp("", "rsm-backup-verify-")
	if e != nil {
		return BackupManifest{}, e
	}
	defer os.RemoveAll(temp)
	m, e := unpackBackup(input, temp)
	if e != nil {
		return m, e
	}
	return m, verifyExtracted(ctx, temp, m)
}
func RestoreBackup(ctx context.Context, home, input, version string) error {
	if e := os.MkdirAll(home, 0700); e != nil {
		return e
	}
	temp, e := os.MkdirTemp(home, ".restore-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(temp)
	m, e := unpackBackup(input, temp)
	if e != nil {
		return e
	}
	if e = verifyExtracted(ctx, temp, m); e != nil {
		return e
	}
	// An explicit restore always preserves the current state before replacing it.
	if _, e = os.Stat(filepath.Join(home, "data", "rsm.db")); e == nil {
		current, e := Open(home)
		if e != nil {
			return e
		}
		backupName := "pre-restore-v" + version + "-" + time.Now().In(time.FixedZone("CST", 8*60*60)).Format("20060102-150405.000000000") + ".zip"
		_, backupErr := current.Backup(ctx, filepath.Join(home, "backups", backupName), version)
		closeErr := current.Close()
		if backupErr != nil {
			return backupErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	old, e := os.MkdirTemp(home, ".restore-previous-")
	if e != nil {
		return e
	}
	keepOld := false
	defer func() {
		if !keepOld {
			_ = os.RemoveAll(old)
		}
	}()
	names := []string{"data", "secrets", "config.json"}
	moved := []string{}
	installed := []string{}
	rollback := func(cause error) error {
		failures := []error{cause}
		for _, name := range installed {
			if e := os.RemoveAll(filepath.Join(home, name)); e != nil {
				failures = append(failures, e)
			}
		}
		for _, name := range moved {
			if e := os.Rename(filepath.Join(old, name), filepath.Join(home, name)); e != nil {
				failures = append(failures, e)
			}
		}
		if len(failures) > 1 {
			keepOld = true
			failures = append(failures, fmt.Errorf("恢复失败且部分旧文件无法回移，已保留于 %s，请勿删除", old))
		}
		return errors.Join(failures...)
	}
	for _, name := range names {
		src := filepath.Join(temp, name)
		if _, e = os.Stat(src); errors.Is(e, os.ErrNotExist) {
			continue
		}
		if _, e = os.Stat(filepath.Join(home, name)); e == nil {
			if e = os.Rename(filepath.Join(home, name), filepath.Join(old, name)); e != nil {
				return rollback(e)
			}
			moved = append(moved, name)
		}
		if e = os.Rename(src, filepath.Join(home, name)); e != nil {
			return rollback(e)
		}
		installed = append(installed, name)
	}
	restored, e := Open(home)
	if e != nil {
		return rollback(e)
	}
	_, e = restored.DB.ExecContext(ctx, "delete from sessions")
	closeErr := restored.Close()
	if e != nil {
		return rollback(e)
	}
	if closeErr != nil {
		return rollback(closeErr)
	}
	return nil
}
