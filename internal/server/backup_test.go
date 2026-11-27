package server_test

import (
	"context"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"rsm/internal/store"
)

func TestBackupDownloadRequiresSuperAdmin(t *testing.T) {
	f := newFixture(t)
	const path = "/api/backups/download"
	f.call("POST", path, nil, 401, false)
	f.call("POST", path, nil, 403, true, http.Header{"Origin": {"https://other.example"}})
	id := f.state().Me.ID
	for _, role := range []string{"admin", "collaborator", "readonly"} {
		t.Run(role, func(t *testing.T) {
			if _, err := f.db.DB.Exec("update users set role=? where id=?", role, id); err != nil {
				t.Fatal(err)
			}
			res, _ := f.call("POST", path, nil, 403, true)
			if res.Header().Get("Content-Disposition") != "" {
				t.Fatal("a denied request returned a backup attachment")
			}
		})
	}
}

func TestBackupDownloadRestoresArchivedSchedule(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	state := f.state()
	draft := example("需要保留的归档排期")
	draft.Developer, draft.Start = state.Me.ID, "2026-11-16"
	_, state = f.call("POST", "/api/requests", map[string]any{"baseRevision": state.Revision, "request": draft}, 200, true)
	_, archived := f.call("POST", fmt.Sprintf("/api/requests/%d/archive", state.Requests[0].ID), map[string]any{"baseRevision": state.Revision, "archived": true}, 200, true)
	const config = `{"addr":"0.0.0.0:1111"}`
	if err := os.WriteFile(filepath.Join(f.db.Home, "config.json"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}

	res, _ := f.call("POST", "/api/backups/download", nil, 200, true)
	if res.Header().Get("Content-Type") != "application/zip" || res.Header().Get("Cache-Control") != "no-store" ||
		res.Header().Get("Content-Length") != strconv.Itoa(res.Body.Len()) {
		t.Fatalf("invalid backup download headers: %v", res.Header())
	}
	path := filepath.Join(t.TempDir(), "backup.zip")
	if err := os.WriteFile(path, res.Body.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	manifest, err := store.VerifyBackup(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Revision != archived.Revision || res.Header().Get("X-RSM-Backup-Revision") != strconv.FormatInt(manifest.Revision, 10) ||
		res.Header().Get("X-RSM-Backup-Created-At") != manifest.CreatedAt {
		t.Fatalf("invalid backup metadata: %+v", manifest)
	}
	created, err := time.Parse(time.RFC3339Nano, manifest.CreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	disposition, params, err := mime.ParseMediaType(res.Header().Get("Content-Disposition"))
	wantFilename := "rsm-backup-vtest-" + created.In(time.FixedZone("CST", 8*60*60)).Format("20060102-150405") + ".zip"
	if err != nil || disposition != "attachment" || params["filename"] != wantFilename {
		t.Fatalf("invalid backup filename: %q (%v)", params["filename"], err)
	}
	if files, err := os.ReadDir(filepath.Join(f.db.Home, "run")); err != nil || len(files) != 0 {
		t.Fatalf("temporary backup was not cleaned up: %v (%v)", files, err)
	}
	if current := f.state(); current.Revision != archived.Revision || !reflect.DeepEqual(current.Requests, archived.Requests) {
		t.Fatal("generating a backup changed the source instance")
	}

	restoreHome := t.TempDir()
	if err := store.RestoreBackup(ctx, restoreHome, path, "test"); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(restoreHome)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if _, err = restored.Login(ctx, archived.Me.Username, "test-password-123", ""); err != nil {
		t.Fatal("backup did not restore the account", err)
	}
	snapshot, err := restored.Snapshot(ctx, archived.Me.ID)
	if err != nil || snapshot.Revision != archived.Revision || !reflect.DeepEqual(snapshot.Requests, archived.Requests) {
		t.Fatalf("backup did not restore the archived schedule: %v (%v)", snapshot.Requests, err)
	}
	if contents, err := os.ReadFile(filepath.Join(restoreHome, "config.json")); err != nil || string(contents) != config {
		t.Fatal("backup did not restore the configuration", err)
	}
}
