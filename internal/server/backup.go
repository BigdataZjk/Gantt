package server

import (
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"rsm/internal/store"
)

func (s *Server) downloadBackup(w http.ResponseWriter, r *http.Request) {
	user := actor(r)
	if user.ID == "" {
		s.fail(w, store.ErrUnauthorized)
		return
	}
	if !user.Super() {
		s.fail(w, store.ErrForbidden)
		return
	}
	if !s.backupMu.TryLock() {
		send(w, http.StatusConflict, map[string]string{"code": "backup_in_progress", "error": "已有备份正在生成或下载，请稍后重试"})
		return
	}
	defer s.backupMu.Unlock()

	runDir := filepath.Join(s.Store.Home, "run")
	if err := os.MkdirAll(runDir, 0700); err != nil {
		s.fail(w, err)
		return
	}
	dir, err := os.MkdirTemp(runDir, "backup-download-")
	if err != nil {
		s.fail(w, err)
		return
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "backup.zip")
	if _, err = s.Store.Backup(r.Context(), path, s.Version); err != nil {
		s.fail(w, err)
		return
	}
	manifest, err := store.VerifyBackup(r.Context(), path)
	if err != nil {
		s.fail(w, err)
		return
	}
	createdAt, err := time.Parse(time.RFC3339Nano, manifest.CreatedAt)
	if err != nil {
		s.fail(w, err)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		s.fail(w, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		s.fail(w, err)
		return
	}

	stamp := createdAt.In(time.FixedZone("CST", 8*60*60)).Format("20060102-150405")
	name := "rsm-backup-v" + strings.TrimPrefix(manifest.Version, "v") + "-" + stamp + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("X-RSM-Backup-Created-At", manifest.CreatedAt)
	w.Header().Set("X-RSM-Backup-Revision", strconv.FormatInt(manifest.Revision, 10))
	if _, err = io.Copy(w, file); err != nil {
		if r.Context().Err() == nil {
			slog.Error("backup download interrupted", "error", err)
		}
		return
	}
	slog.Info("backup download completed", "userId", user.ID, "revision", manifest.Revision)
}
