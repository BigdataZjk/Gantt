package store

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rsm/internal/auth"
	"rsm/internal/requests"
)

func backupFixture(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	hash, err := auth.Hash("backup-test-password")
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := s.Vault.Encrypt("owner", "backup-test-password")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Change(context.Background(), "", nil, "setup", "初始化", false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		_, err := tx.Exec("insert into users(id,username,role,password_hash,password_cipher) values ('owner','张金科','superadmin',?,?)", hash, cipher)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Home, "config.json"), []byte(`{"addr":"127.0.0.1:18080"}`), 0600); err != nil {
		t.Fatal(err)
	}
	return s
}

func backupChange(t *testing.T, s *Store, name string) int64 {
	t.Helper()
	rev, err := s.Change(context.Background(), "owner", nil, "admin", name, true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
		d.Requests = append(d.Requests, requests.Request{ID: d.NextID, Name: name, Revision: 1})
		d.NextID++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return rev
}

func readArchive(t *testing.T, path string) map[string][]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	files := map[string][]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		files[h.Name] = b
	}
	return files
}

func writeArchive(t *testing.T, path string, files map[string][]byte) {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tr := tar.NewWriter(gz)
	for name, content := range files {
		if err := tr.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tr.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := tr.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLiveBackupRestoresCommittedWALAndPreservesNewerData(t *testing.T) {
	ctx := context.Background()
	s := backupFixture(t)
	before := backupChange(t, s, "备份时已提交")
	backup := filepath.Join(t.TempDir(), "snapshot.tar.gz")
	m, err := s.Backup(ctx, backup, "0.1.0-test")
	if err != nil {
		t.Fatal(err)
	}
	if m.Revision != before || m.Version != "0.1.0-test" || len(m.Files) != 3 {
		t.Fatal("incomplete backup manifest", m)
	}
	if _, err := VerifyBackup(ctx, backup); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(backup); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("backup permission", err)
	}
	original, _ := os.ReadFile(backup)
	if _, err := s.Backup(ctx, backup, "overwrite"); err == nil {
		t.Fatal("overwrote existing backup")
	}
	unchanged, _ := os.ReadFile(backup)
	if !bytes.Equal(original, unchanged) {
		t.Fatal("existing backup changed")
	}

	after := backupChange(t, s, "备份后新增")
	token, err := s.Login(ctx, "张金科", "backup-test-password", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := RestoreBackup(ctx, s.Home, backup, "0.1.0-test"); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(s.Home)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	snap, err := restored.Snapshot(ctx, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Revision != before || len(snap.Requests) != 1 || snap.Requests[0].Name != "备份时已提交" {
		t.Fatal("restore missed committed WAL", snap)
	}
	if _, err := restored.Session(ctx, token); err == nil {
		t.Fatal("restored old session")
	}
	if password, err := restored.Password(ctx, "owner"); err != nil || password != "backup-test-password" {
		t.Fatal("key mismatch", err)
	}
	preserved, err := filepath.Glob(filepath.Join(s.Home, "backups", "pre-restore-*.tar.gz"))
	if err != nil || len(preserved) != 1 {
		t.Fatal("missing pre-restore backup", err)
	}
	pm, err := VerifyBackup(ctx, preserved[0])
	if err != nil || pm.Revision != after {
		t.Fatal("newer writes not preserved", pm, err)
	}
}

func TestInvalidBackupsLeaveExistingInstanceUntouched(t *testing.T) {
	s := backupFixture(t)
	before := backupChange(t, s, "不能丢失")
	good := filepath.Join(t.TempDir(), "good.tar.gz")
	if _, err := s.Backup(context.Background(), good, "test"); err != nil {
		t.Fatal(err)
	}
	contents := readArchive(t, good)
	raw, _ := os.ReadFile(good)
	for _, kind := range []string{"truncated", "checksum", "mismatched-key", "traversal", "future-schema", "invalid-database"} {
		t.Run(kind, func(t *testing.T) {
			files := map[string][]byte{}
			for name, b := range contents {
				files[name] = bytes.Clone(b)
			}
			var m BackupManifest
			if err := json.Unmarshal(files["manifest.json"], &m); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "invalid.tar.gz")
			switch kind {
			case "truncated":
				if err := os.WriteFile(path, raw[:len(raw)-8], 0600); err != nil {
					t.Fatal(err)
				}
			case "checksum":
				files["config.json"] = []byte(`{"addr":"changed"}`)
			case "mismatched-key":
				files["secrets/password.key"] = bytes.Repeat([]byte{42}, 32)
				m.Files["secrets/password.key"] = digest(files["secrets/password.key"])
			case "traversal":
				files["../outside"] = []byte("forbidden")
			case "future-schema":
				m.SchemaVersion = 99
			case "invalid-database":
				files["data/rsm.db"] = []byte("not a database")
				m.Files["data/rsm.db"] = digest(files["data/rsm.db"])
			}
			if kind != "truncated" {
				files["manifest.json"], _ = json.Marshal(m)
				writeArchive(t, path, files)
			}
			if _, err := VerifyBackup(context.Background(), path); err == nil {
				t.Fatal("invalid backup accepted")
			}
			if err := RestoreBackup(context.Background(), s.Home, path, "test"); err == nil {
				t.Fatal("invalid restore accepted")
			}
			snap, err := s.Snapshot(context.Background(), "owner")
			if err != nil || snap.Revision != before || len(snap.Requests) != 1 {
				t.Fatal("invalid restore changed live instance", err)
			}
		})
	}
}

func TestInstanceLockAndMissingVaultFailClosed(t *testing.T) {
	s := backupFixture(t)
	unlock, err := Lock(s.Home)
	if err != nil {
		t.Fatal(err)
	}
	if another, err := Lock(s.Home); err == nil {
		another()
		t.Fatal("second instance acquired lock")
	}
	unlock()
	release, err := Lock(s.Home)
	if err != nil {
		t.Fatal("lock not released", err)
	}
	release()
	s.Close()
	if err := os.Remove(filepath.Join(s.Home, "secrets", "password.key")); err != nil {
		t.Fatal(err)
	}
	if opened, err := Open(s.Home); err == nil {
		opened.Close()
		t.Fatal("silently generated replacement key")
	}
}

func TestConcurrentBackupIsTransactionallyConsistent(t *testing.T) {
	s := backupFixture(t)
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 12; i++ {
			_, err := s.Change(context.Background(), "owner", nil, "admin", "并发写入", true, func(_ *sql.Tx, d *requests.Data, _ auth.User) error {
				d.Requests = append(d.Requests, requests.Request{ID: d.NextID, Name: "事务需求"})
				d.NextID++
				return nil
			})
			if err != nil {
				done <- err
				return
			}
			time.Sleep(time.Millisecond)
		}
		done <- nil
	}()
	path := filepath.Join(t.TempDir(), "concurrent.tar.gz")
	if _, err := s.Backup(context.Background(), path, "test"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	m, err := VerifyBackup(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := RestoreBackup(context.Background(), target, path, "test"); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	snap, err := restored.Snapshot(context.Background(), "owner")
	if err != nil || int64(len(snap.Requests)) != m.Revision-1 {
		t.Fatal("partial transaction in snapshot", m.Revision, len(snap.Requests), err)
	}
	config, _ := os.ReadFile(filepath.Join(target, "config.json"))
	if !strings.Contains(string(config), "127.0.0.1:18080") {
		t.Fatal("config missing from restore")
	}
}

func TestRestoreHomeWithSpacesAndURICharacters(t *testing.T) {
	ctx := context.Background()
	s := backupFixture(t)
	revision := backupChange(t, s, "特殊路径备份")
	backup := filepath.Join(t.TempDir(), "snapshot.tar.gz")
	if _, err := s.Backup(ctx, backup, "test"); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(t.TempDir(), "空 格?#实例")
	if err := RestoreBackup(ctx, home, backup, "test"); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(home)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	snap, err := restored.Snapshot(ctx, "owner")
	if err != nil || snap.Revision != revision || len(snap.Requests) != 1 {
		t.Fatal("restore to special path failed", err, snap.Revision)
	}
}
