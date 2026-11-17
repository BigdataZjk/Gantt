package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
)

var logTestTime = time.Date(2026, 11, 17, 4, 0, 0, 0, time.UTC)

func logStore(t *testing.T) *Store {
	t.Helper()
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	for _, row := range []struct{ id, role string }{{"admin", "superadmin"}, {"reader", "readonly"}} {
		cipher, encryptErr := s.Vault.Encrypt(row.id, "test")
		if encryptErr != nil {
			t.Fatal(encryptErr)
		}
		if _, e = s.DB.Exec("insert into users(id,username,role,password_hash,password_cipher) values (?,?,?,?,?)", row.id, row.id, row.role, "unchanged-test-hash", cipher); e != nil {
			t.Fatal(e)
		}
	}
	return s
}

func addLog(t *testing.T, s *Store, created string) int64 {
	t.Helper()
	result, e := s.DB.Exec("insert into history(actor,action,created_at,reversible,before_data) values ('admin','数据变更',?,1,?)", created, `{"requests":[],"domains":[],"nextId":1}`)
	if e != nil {
		t.Fatal(e)
	}
	id, _ := result.LastInsertId()
	return id
}

func logSnapshot(t *testing.T, s *Store) Snapshot {
	t.Helper()
	state, e := s.Snapshot(context.Background(), "admin")
	if e != nil {
		t.Fatal(e)
	}
	return state
}

func previewLogs(t *testing.T, s *Store, scope string, days int) history.CleanupPreview {
	t.Helper()
	p, e := s.PreviewLogCleanup(context.Background(), "admin", scope, days, logTestTime)
	if e != nil {
		t.Fatal(e)
	}
	return p
}

func seedRetainedRequests(t *testing.T, s *Store, count int) {
	t.Helper()
	data := requests.Empty()
	for index := 0; index < count; index++ {
		data.Requests = append(data.Requests, requests.Request{
			ID: int64(index + 1), Revision: 1, Name: fmt.Sprintf("长期保留需求%d", index+1),
			Priority: "P1", Status: "已完成", RequestType: "常规需求", Domain: "流量域",
			PRD: "https://example.com/prd", Requester: "历史提需人", RequestedAt: "2000-01-01",
			Developer: "admin", Project: "长期记录", Notes: "清理日志后必须完整保留",
			Archived: index%2 == 1,
		})
	}
	data.NextID = int64(count + 1)
	payload, e := json.Marshal(data)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.DB.Exec("update metadata set payload=? where id=1", string(payload)); e != nil {
		t.Fatal(e)
	}
}

func TestLogDefaultsPermissionsAndPolicyPersistence(t *testing.T) {
	s := logStore(t)
	ctx := context.Background()
	status, e := s.LogManagement(ctx, "admin")
	if e != nil || status.Policy != (history.LogPolicy{}) || status.LastAutomatic != nil || status.LastManual != nil {
		t.Fatal("existing installations must retain their current policy", status, e)
	}
	for _, who := range []string{"", "reader"} {
		want := ErrForbidden
		if who == "" {
			want = ErrUnauthorized
		}
		if _, e = s.LogManagement(ctx, who); !errors.Is(e, want) {
			t.Fatal(who, e)
		}
		if _, e = s.PreviewLogCleanup(ctx, who, "operations", 30, logTestTime); !errors.Is(e, want) {
			t.Fatal(who, e)
		}
	}
	base := int64(0)
	policy := history.LogPolicy{OperationRetentionDays: 90, ArchiveRetentionDays: 30}
	rev, e := s.SaveLogPolicy(ctx, "admin", &base, policy)
	if e != nil || rev != 1 {
		t.Fatal(rev, e)
	}
	if _, e = s.SaveLogPolicy(ctx, "admin", &base, history.LogPolicy{}); !errors.Is(e, ErrConflict) {
		t.Fatal("stale policy overwrote latest settings", e)
	}
	if e = s.Close(); e != nil {
		t.Fatal(e)
	}
	reopened, e := Open(s.Home)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.Close()
	if got := logSnapshot(t, reopened); got.LogPolicy != policy || got.Revision != 1 {
		t.Fatal("policy lost after restart", got.LogPolicy, got.Revision)
	}
	backup := filepath.Join(t.TempDir(), "logs-backup.tar.gz")
	if _, e = reopened.Backup(ctx, backup, "test"); e != nil {
		t.Fatal(e)
	}
	restoredHome := t.TempDir()
	if e = RestoreBackup(ctx, restoredHome, backup, "test"); e != nil {
		t.Fatal(e)
	}
	restored, e := Open(restoredHome)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	if got := logSnapshot(t, restored); got.LogPolicy != policy {
		t.Fatal("backup omitted global log policy", got.LogPolicy)
	}
}

func TestManualLogCleanupExactBoundaryAndBusinessIsolation(t *testing.T) {
	s := logStore(t)
	seedRetainedRequests(t, s, 2)
	ctx := context.Background()
	cutoff := history.LogCutoff(logTestTime, 7)
	if cutoff.UTC().Format(time.RFC3339) != "2026-11-09T16:00:00Z" {
		t.Fatal("cutoff must use China midnight", cutoff)
	}
	deleted := addLog(t, s, cutoff.Add(-time.Nanosecond).UTC().Format(time.RFC3339Nano))
	boundary := addLog(t, s, cutoff.UTC().Format(time.RFC3339))
	addLog(t, s, cutoff.Add(time.Nanosecond).UTC().Format(time.RFC3339Nano))
	addLog(t, s, "unknown-date")
	if _, e := s.DB.Exec("insert into versions values ('test','保留版本','admin',?,0,'{}')", now()); e != nil {
		t.Fatal(e)
	}
	before := logSnapshot(t, s)
	var payload, hash string
	_ = s.DB.QueryRow("select payload from metadata").Scan(&payload)
	_ = s.DB.QueryRow("select password_hash from users where id='admin'").Scan(&hash)
	p := previewLogs(t, s, "operations", 7)
	if p.Count != 1 || p.ReversibleCount != 1 || p.Bytes <= 0 || len(p.Token) != 64 {
		t.Fatal("incorrect cleanup preview", p)
	}
	base := before.Revision
	rev, run, e := s.CleanupLogs(ctx, "admin", &base, p, logTestTime)
	if e != nil || rev != base+1 || run.OperationsDeleted != 1 || run.ArchivesDeleted != 0 || run.Bytes != p.Bytes {
		t.Fatal(rev, run, e)
	}
	after := logSnapshot(t, s)
	if !reflect.DeepEqual(before.Requests, after.Requests) || !reflect.DeepEqual(before.Users, after.Users) || !reflect.DeepEqual(before.Versions, after.Versions) {
		t.Fatal("log cleanup changed business records")
	}
	var afterPayload, afterHash string
	_ = s.DB.QueryRow("select payload from metadata").Scan(&afterPayload)
	_ = s.DB.QueryRow("select password_hash from users where id='admin'").Scan(&afterHash)
	if afterPayload != payload || afterHash != hash {
		t.Fatal("cleanup changed stored data or credentials")
	}
	for _, entry := range after.Logs {
		if entry.ID == deleted {
			t.Fatal("expired entry remains")
		}
	}
	var count int
	_ = s.DB.QueryRow("select count(*) from history where id=?", boundary).Scan(&count)
	if count != 1 || len(after.Logs) != 4 || after.Logs[0].Reversible {
		t.Fatal("boundary was deleted or audit is reversible", after.Logs)
	}
	status, _ := s.LogManagement(ctx, "admin")
	if status.LastManual == nil || status.LastManual.OperationsDeleted != 1 {
		t.Fatal("cleanup result not persisted", status)
	}
	base = after.Revision
	if _, _, e = s.CleanupLogs(ctx, "admin", &base, p, logTestTime); !errors.Is(e, ErrConflict) {
		t.Fatal("stale confirmation accepted", e)
	}
}

func TestLogCleanupRejectsInvalidChangedAndEmptyPreviews(t *testing.T) {
	s := logStore(t)
	ctx := context.Background()
	for _, days := range []int{-1, 0, 3651} {
		if _, e := s.PreviewLogCleanup(ctx, "admin", "operations", days, logTestTime); e == nil {
			t.Fatal("invalid age accepted", days)
		}
		if _, e := s.SaveLogPolicy(ctx, "admin", nil, history.LogPolicy{ArchiveRetentionDays: days}); (days != 0) != (e != nil) {
			t.Fatal("invalid policy acceptance", days, e)
		}
	}
	if _, e := s.PreviewLogCleanup(ctx, "admin", "../../data", 1, logTestTime); e == nil {
		t.Fatal("invalid cleanup scope accepted")
	}
	p := previewLogs(t, s, "operations", 7)
	base := logSnapshot(t, s).Revision
	if _, _, e := s.CleanupLogs(ctx, "admin", &base, p, logTestTime); e == nil {
		t.Fatal("empty cleanup must not add an audit record")
	}
	addLog(t, s, "2026-01-01T00:00:00Z")
	p = previewLogs(t, s, "operations", 7)
	bad := p
	bad.Token = "tampered"
	if _, _, e := s.CleanupLogs(ctx, "admin", &base, bad, logTestTime); !errors.Is(e, ErrConflict) {
		t.Fatal("tampered preview accepted", e)
	}
	if _, _, e := s.CleanupLogs(ctx, "admin", &base, p, logTestTime.Add(24*time.Hour)); !errors.Is(e, ErrConflict) {
		t.Fatal("yesterday's cutoff accepted", e)
	}
	if _, e := s.SaveLogPolicy(ctx, "admin", &base, history.LogPolicy{}); e != nil {
		t.Fatal(e)
	}
	base++
	if _, _, e := s.CleanupLogs(ctx, "admin", &base, p, logTestTime); !errors.Is(e, ErrConflict) {
		t.Fatal("changed data did not invalidate preview", e)
	}
}

func TestCleanupDoesNotReenableExpiredUndo(t *testing.T) {
	s := logStore(t)
	for index := 0; index < 60; index++ {
		created := "2026-11-17T00:00:00Z"
		if index >= 10 {
			created = "2026-01-01T00:00:00Z"
		}
		addLog(t, s, created)
	}
	p := previewLogs(t, s, "operations", 7)
	base := p.Revision
	if p.Count != 50 {
		t.Fatal(p)
	}
	if _, _, e := s.CleanupLogs(context.Background(), "admin", &base, p, logTestTime); e != nil {
		t.Fatal(e)
	}
	var count int
	_ = s.DB.QueryRow("select count(*) from history where reversible=1 or before_data is not null").Scan(&count)
	if count != 0 {
		t.Fatal("cleaning recent rows revived older undo snapshots", count)
	}
}

func TestLogCleanupRollbackAndConcurrentPolicyChange(t *testing.T) {
	s := logStore(t)
	addLog(t, s, "2026-01-01T00:00:00Z")
	p := previewLogs(t, s, "operations", 7)
	base := p.Revision
	if _, e := s.DB.Exec("create trigger block_cleanup before delete on history begin select raise(abort,'cleanup failure'); end"); e != nil {
		t.Fatal(e)
	}
	if _, _, e := s.CleanupLogs(context.Background(), "admin", &base, p, logTestTime); e == nil {
		t.Fatal("database failure was hidden")
	}
	state := logSnapshot(t, s)
	status, _ := s.LogManagement(context.Background(), "admin")
	if state.Revision != base || len(state.Logs) != 1 || status.LastManual != nil {
		t.Fatal("failed cleanup partially committed")
	}
	_, _ = s.DB.Exec("drop trigger block_cleanup")
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.SaveLogPolicy(context.Background(), "admin", &base, history.LogPolicy{OperationRetentionDays: 90})
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for e := range results {
		if e == nil {
			ok++
		} else if errors.Is(e, ErrConflict) {
			conflicts++
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatal("concurrent policy writes lost conflict protection", ok, conflicts)
	}
}

func createLogFile(t *testing.T, s *Store, name string, at time.Time) string {
	t.Helper()
	dir := filepath.Join(s.Home, "logs")
	if e := os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, name)
	if e := os.WriteFile(path, []byte("preserve-log-content\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Chtimes(path, at, at); e != nil {
		t.Fatal(e)
	}
	return path
}

func TestArchiveCleanupPreservesActiveFilesAndContinuedWrites(t *testing.T) {
	s := logStore(t)
	cutoff := history.LogCutoff(logTestTime, 7)
	active := createLogFile(t, s, "rsm.log", cutoff.Add(-time.Hour))
	writer, e := os.OpenFile(active, os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		t.Fatal(e)
	}
	defer writer.Close()
	old := createLogFile(t, s, "rsm.log.1", cutoff.Add(-time.Hour))
	boundary := createLogFile(t, s, "service.log.1", cutoff)
	unknown := createLogFile(t, s, "unmanaged.log.1", cutoff.Add(-time.Hour))
	outside := filepath.Join(t.TempDir(), "external.log")
	_ = os.WriteFile(outside, []byte("external-data"), 0600)
	symlink := filepath.Join(s.Home, "logs", "deploy-details.log.1")
	if e = os.Symlink(outside, symlink); e != nil {
		t.Fatal(e)
	}
	p := previewLogs(t, s, "archives", 7)
	if p.Count != 1 || p.ReversibleCount != 0 {
		t.Fatal("archive selection included current, boundary or symlink files", p)
	}
	base := p.Revision
	_, run, e := s.CleanupLogs(context.Background(), "admin", &base, p, logTestTime)
	if e != nil || run.ArchivesDeleted != 1 || run.OperationsDeleted != 0 || run.Error != "" {
		t.Fatal(run, e)
	}
	if _, e = os.Stat(old); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("old archive not deleted", e)
	}
	for _, path := range []string{active, boundary, unknown, outside, symlink} {
		if _, e = os.Lstat(path); e != nil {
			t.Fatal("unrelated file deleted", path, e)
		}
	}
	if _, e = writer.WriteString("still-writing\n"); e != nil {
		t.Fatal(e)
	}
	content, _ := os.ReadFile(active)
	if string(content) != "preserve-log-content\nstill-writing\n" {
		t.Fatal("active log was unlinked or truncated")
	}
}

func TestArchivePreviewChangeAndUnsafeDirectory(t *testing.T) {
	s := logStore(t)
	file := createLogFile(t, s, "rsm.log.1", logTestTime.AddDate(0, 0, -40))
	p := previewLogs(t, s, "archives", 7)
	if e := os.WriteFile(file, []byte("updated archive"), 0600); e != nil {
		t.Fatal(e)
	}
	base := p.Revision
	if _, _, e := s.CleanupLogs(context.Background(), "admin", &base, p, logTestTime); !errors.Is(e, ErrConflict) {
		t.Fatal("changed archive deleted using an old preview", e)
	}
	root, files, _, _, e := s.logFiles()
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	_ = os.Remove(file)
	count, bytes, message := deleteArchivedLogs(root, files)
	if count != 0 || bytes != 0 || message == "" {
		t.Fatal("partial failure was reported as success", count, bytes, message)
	}
	_ = os.RemoveAll(filepath.Join(s.Home, "logs"))
	if e = os.Symlink(t.TempDir(), filepath.Join(s.Home, "logs")); e != nil {
		t.Fatal(e)
	}
	if _, e = s.PreviewLogCleanup(context.Background(), "admin", "archives", 7, logTestTime); e == nil {
		t.Fatal("followed a symlink outside the log directory")
	}
}

func TestArchiveReplacementInvalidatesPreview(t *testing.T) {
	s := logStore(t)
	file := createLogFile(t, s, "rsm.log.1", logTestTime.AddDate(0, 0, -40))
	before, e := os.Stat(file)
	if e != nil {
		t.Fatal(e)
	}
	content, e := os.ReadFile(file)
	if e != nil {
		t.Fatal(e)
	}
	p := previewLogs(t, s, "archives", 7)
	if e = os.Rename(file, filepath.Join(s.Home, "previous-archive")); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(file, content, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.Chtimes(file, before.ModTime(), before.ModTime()); e != nil {
		t.Fatal(e)
	}
	after, e := os.Stat(file)
	if e != nil || os.SameFile(before, after) {
		t.Fatal("replacement must have a different file identity", e)
	}
	base := p.Revision
	if _, _, e = s.CleanupLogs(context.Background(), "admin", &base, p, logTestTime); !errors.Is(e, ErrConflict) {
		t.Fatal("replacement archive deleted using an old preview", e)
	}
	if _, e = os.Stat(file); e != nil {
		t.Fatal("replacement archive was not preserved", e)
	}
	p = previewLogs(t, s, "archives", 7)
	if _, run, e := s.CleanupLogs(context.Background(), "admin", &base, p, logTestTime); e != nil || run.ArchivesDeleted != 1 {
		t.Fatal("fresh preview must allow cleanup", run, e)
	}
}

func TestAutomaticCleanupScheduleAndNoopAudit(t *testing.T) {
	s := logStore(t)
	seedRetainedRequests(t, s, 2)
	ctx := context.Background()
	before := logSnapshot(t, s)
	addLog(t, s, "2026-01-01T00:00:00Z")
	createLogFile(t, s, "rsm.log.1", logTestTime.AddDate(0, 0, -40))
	if _, changed, e := s.MaintainLogs(ctx, logTestTime); e != nil || changed {
		t.Fatal("default policy deleted existing history", changed, e)
	}
	base := int64(0)
	if _, e := s.SaveLogPolicy(ctx, "admin", &base, history.LogPolicy{OperationRetentionDays: 7, ArchiveRetentionDays: 30}); e != nil {
		t.Fatal(e)
	}
	rev, changed, e := s.MaintainLogs(ctx, logTestTime)
	if e != nil || !changed || rev != 2 {
		t.Fatal(rev, changed, e)
	}
	state := logSnapshot(t, s)
	if !reflect.DeepEqual(before.Requests, state.Requests) {
		t.Fatal("automatic log cleanup changed active or archived requests")
	}
	if state.Revision != 2 || len(state.Logs) != 2 || state.Logs[0].Actor != "系统" || state.Logs[0].Reversible {
		t.Fatal("automatic cleanup failed to append an irreversible audit", state.Logs)
	}
	status, _ := s.LogManagement(ctx, "admin")
	if status.LastAutomatic == nil || status.LastAutomatic.OperationsDeleted != 1 || status.LastAutomatic.ArchivesDeleted != 1 {
		t.Fatal(status.LastAutomatic)
	}
	for _, offset := range []time.Duration{time.Minute, time.Hour + time.Minute} {
		if _, changed, e = s.MaintainLogs(ctx, logTestTime.Add(offset)); e != nil || changed {
			t.Fatal("empty maintenance should not create more audit records", changed, e)
		}
	}
	if after := logSnapshot(t, s); after.Revision != state.Revision || len(after.Logs) != len(state.Logs) {
		t.Fatal("no-op cleanup changed public data")
	}
}

func TestAutomaticCleanupFailureIsVisibleAndAtomic(t *testing.T) {
	s := logStore(t)
	ctx := context.Background()
	addLog(t, s, "2026-01-01T00:00:00Z")
	_, e := s.SaveLogPolicy(ctx, "admin", nil, history.LogPolicy{OperationRetentionDays: 7})
	if e != nil {
		t.Fatal(e)
	}
	_, _ = s.DB.Exec("create trigger block_cleanup before delete on history begin select raise(abort,'cleanup failure'); end")
	if _, changed, e := s.MaintainLogs(ctx, logTestTime); e == nil || changed {
		t.Fatal("failed automatic cleanup reported success", changed, e)
	}
	status, e := s.LogManagement(ctx, "admin")
	if e != nil || status.LastAutomatic == nil || status.LastAutomatic.Error == "" || status.OperationCount != 2 {
		t.Fatal("failed maintenance status missing or records lost", status, e)
	}
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, e = s.MaintainLogs(ctx, logTestTime); !errors.Is(e, context.Canceled) {
		t.Fatal("maintenance ignored shutdown", e)
	}
}

func TestLogCountLimitStillApplies(t *testing.T) {
	s := logStore(t)
	seedRetainedRequests(t, s, 300)
	before := logSnapshot(t, s)
	for range 205 {
		addLog(t, s, "2026-11-17T00:00:00Z")
	}
	_, e := s.Change(context.Background(), "admin", nil, "admin", "验证原有上限", false, func(*sql.Tx, *requests.Data, auth.User) error { return nil })
	if e != nil {
		t.Fatal(e)
	}
	after := logSnapshot(t, s)
	if len(after.Logs) != 200 {
		t.Fatal("original count limit no longer enforced", len(after.Logs))
	}
	if !reflect.DeepEqual(before.Requests, after.Requests) {
		t.Fatal("200-entry log limit removed active or archived requests")
	}
}
