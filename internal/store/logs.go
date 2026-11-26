package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
)

const logPolicyKey = "log-policy"
const lastAutomaticKey = "log-last-automatic"
const lastManualKey = "log-last-manual"

var managedLogNames = []string{"rsm.log", "service.log", "deploy-details.log", "deploy.log"}

type storedLog struct {
	ID         int64
	CreatedAt  string
	Bytes      int64
	Reversible bool
}

type archivedLog struct {
	Name     string
	Bytes    int64
	Modified string
	Identity string
	info     os.FileInfo
}

func readLogPolicy(ctx context.Context, q queryer) (history.LogPolicy, error) {
	var policy history.LogPolicy
	e := readSetting(ctx, q, logPolicyKey, &policy)
	return policy, e
}

func validLogDays(days int, optional bool) error {
	min := 1
	if optional {
		min = 0
	}
	if days < min || days > history.MaxRetentionDays {
		return Bad(fmt.Sprintf("日志保留天数须为 %d–%d 之间的整数", min, history.MaxRetentionDays))
	}
	return nil
}

func logAdmin(ctx context.Context, q queryer, actorID string) error {
	if actorID == "" {
		return ErrUnauthorized
	}
	u, e := user(ctx, q, actorID)
	if e != nil || u.Disabled || u.Deleted {
		return ErrUnauthorized
	}
	if !u.Admin() {
		return ErrForbidden
	}
	return nil
}

func readStoredLogs(ctx context.Context, q queryer) ([]storedLog, error) {
	rows, e := q.QueryContext(ctx, `select id,created_at,
        length(cast(actor as blob))+length(cast(action as blob))+length(cast(created_at as blob))+coalesce(length(cast(before_data as blob)),0)
          +coalesce(length(cast(preview as blob))+length(cast(payload as blob)),0),
        reversible,undone from history left join history_details on id=history_id order by id desc`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	items := []storedLog{}
	for rows.Next() {
		var item storedLog
		var undone bool
		if e = rows.Scan(&item.ID, &item.CreatedAt, &item.Bytes, &item.Reversible, &undone); e != nil {
			return nil, e
		}
		item.Reversible = item.Reversible && !undone && len(items) < 50
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) logFiles() (*os.Root, []archivedLog, int, int64, error) {
	path := filepath.Join(s.Home, "logs")
	info, e := os.Lstat(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil, []archivedLog{}, 0, 0, nil
	}
	if e != nil {
		return nil, nil, 0, 0, e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, 0, 0, errors.New("日志目录必须是实例内的普通目录")
	}
	root, e := os.OpenRoot(path)
	if e != nil {
		return nil, nil, 0, 0, e
	}
	archives := []archivedLog{}
	activeCount, activeBytes := 0, int64(0)
	for _, name := range managedLogNames {
		for _, suffix := range []string{"", ".1"} {
			info, e := root.Lstat(name + suffix)
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			if e != nil {
				root.Close()
				return nil, nil, 0, 0, e
			}
			if !info.Mode().IsRegular() {
				continue
			}
			if suffix == "" {
				activeCount++
				activeBytes += info.Size()
			} else {
				stat, ok := info.Sys().(*syscall.Stat_t)
				if !ok {
					root.Close()
					return nil, nil, 0, 0, errors.New("无法确认归档日志的文件身份")
				}
				archives = append(archives, archivedLog{
					Name: name + suffix, Bytes: info.Size(), Modified: info.ModTime().UTC().Format(time.RFC3339Nano),
					Identity: fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), info: info,
				})
			}
		}
	}
	return root, archives, activeCount, activeBytes, nil
}

func (s *Store) LogManagement(ctx context.Context, actorID string) (history.LogManagement, error) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	var out history.LogManagement
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	if e = logAdmin(ctx, tx, actorID); e != nil {
		return out, e
	}
	if out.Policy, e = readLogPolicy(ctx, tx); e != nil {
		return out, e
	}
	if e = readSetting(ctx, tx, lastAutomaticKey, &out.LastAutomatic); e != nil {
		return out, e
	}
	if e = readSetting(ctx, tx, lastManualKey, &out.LastManual); e != nil {
		return out, e
	}
	logs, e := readStoredLogs(ctx, tx)
	if e != nil {
		return out, e
	}
	out.OperationCount = len(logs)
	for _, item := range logs {
		out.OperationBytes += item.Bytes
		if out.OldestOperationAt == "" || item.CreatedAt < out.OldestOperationAt {
			out.OldestOperationAt = item.CreatedAt
		}
	}
	root, files, count, bytes, e := s.logFiles()
	if root != nil {
		defer root.Close()
	}
	if e != nil {
		return out, e
	}
	out.ActiveFileCount, out.ActiveFileBytes = count, bytes
	out.ArchiveCount = len(files)
	for _, file := range files {
		out.ArchiveBytes += file.Bytes
	}
	return out, tx.Commit()
}

func (s *Store) SaveLogPolicy(ctx context.Context, actorID string, base *int64, policy history.LogPolicy) (int64, error) {
	if e := validLogDays(policy.OperationRetentionDays, true); e != nil {
		return 0, e
	}
	if e := validLogDays(policy.ArchiveRetentionDays, true); e != nil {
		return 0, e
	}
	s.logMu.Lock()
	defer s.logMu.Unlock()
	detail := history.Detail{Label: "更新日志清理策略"}
	return s.ChangeLogged(ctx, actorID, base, "admin", &detail, false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		before, e := readLogPolicy(ctx, tx)
		if e != nil {
			return e
		}
		detail.Add("操作记录", retentionValue(before.OperationRetentionDays), retentionValue(policy.OperationRetentionDays))
		detail.Add("日志归档文件", retentionValue(before.ArchiveRetentionDays), retentionValue(policy.ArchiveRetentionDays))
		if e := writeSetting(ctx, tx, logPolicyKey, policy); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, "delete from system_settings where key=?", lastAutomaticKey)
		return e
	})
}

func retentionValue(days int) history.Value {
	if days == 0 {
		return history.Text("关闭")
	}
	return history.Text(fmt.Sprintf("保留 %d 天", days))
}

func selectLogCleanup(logs []storedLog, files []archivedLog, scope string, days int, revision int64, at time.Time) (history.CleanupPreview, []int64, []archivedLog, error) {
	out := history.CleanupPreview{Scope: scope, Days: days, Revision: revision}
	if scope != "operations" && scope != "archives" {
		return out, nil, nil, Bad("请选择操作记录或归档文件日志")
	}
	if e := validLogDays(days, false); e != nil {
		return out, nil, nil, e
	}
	cutoff := history.LogCutoff(at, days)
	out.Before = cutoff.UTC().Format(time.RFC3339)
	ids := []int64{}
	selectedLogs := []storedLog{}
	selectedFiles := []archivedLog{}
	if scope == "operations" {
		for _, item := range logs {
			created, e := time.Parse(time.RFC3339Nano, item.CreatedAt)
			if e == nil && created.Before(cutoff) {
				ids = append(ids, item.ID)
				selectedLogs = append(selectedLogs, item)
				out.Count++
				out.Bytes += item.Bytes
				if item.Reversible {
					out.ReversibleCount++
				}
			}
		}
	} else {
		for _, file := range files {
			if file.info.ModTime().Before(cutoff) {
				selectedFiles = append(selectedFiles, file)
				out.Count++
				out.Bytes += file.Bytes
			}
		}
	}
	raw, e := json.Marshal(struct {
		Preview history.CleanupPreview
		Logs    []storedLog
		Files   []archivedLog
	}{out, selectedLogs, selectedFiles})
	if e != nil {
		return out, nil, nil, e
	}
	hash := sha256.Sum256(raw)
	out.Token = hex.EncodeToString(hash[:])
	return out, ids, selectedFiles, nil
}

func (s *Store) PreviewLogCleanup(ctx context.Context, actorID, scope string, days int, at time.Time) (history.CleanupPreview, error) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	var out history.CleanupPreview
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	if e = logAdmin(ctx, tx, actorID); e != nil {
		return out, e
	}
	var rev int64
	if e = tx.QueryRowContext(ctx, "select revision from metadata where id=1").Scan(&rev); e != nil {
		return out, e
	}
	logs, e := readStoredLogs(ctx, tx)
	if e != nil {
		return out, e
	}
	root, files, _, _, e := s.logFiles()
	if root != nil {
		defer root.Close()
	}
	if e != nil {
		return out, e
	}
	out, _, _, e = selectLogCleanup(logs, files, scope, days, rev, at)
	if e != nil {
		return out, e
	}
	return out, tx.Commit()
}

func deleteStoredLogs(ctx context.Context, tx *sql.Tx, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	// 清理不能让原先已超出 50 条撤回窗口的操作重新获得撤回资格。
	if _, e := tx.ExecContext(ctx, "update history set reversible=0,before_data=null where id not in (select id from history order by id desc limit 50)"); e != nil {
		return e
	}
	for _, id := range ids {
		if _, e := tx.ExecContext(ctx, "delete from history where id=?", id); e != nil {
			return e
		}
	}
	return nil
}

func deleteArchivedLogs(root *os.Root, files []archivedLog) (int, int64, string) {
	deleted, bytes, failed := 0, int64(0), 0
	for _, file := range files {
		info, e := root.Lstat(file.Name)
		if e != nil || !info.Mode().IsRegular() || !os.SameFile(info, file.info) || info.Size() != file.Bytes || !info.ModTime().Equal(file.info.ModTime()) {
			failed++
			continue
		}
		if e = root.Remove(file.Name); e != nil {
			failed++
			continue
		}
		deleted++
		bytes += file.Bytes
	}
	message := ""
	if failed > 0 {
		message = fmt.Sprintf("%d 个归档文件已变动或无法删除，请刷新后重试", failed)
	}
	return deleted, bytes, message
}

func (s *Store) CleanupLogs(ctx context.Context, actorID string, base *int64, expected history.CleanupPreview, at time.Time) (int64, history.CleanupRun, error) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	if e := ctx.Err(); e != nil {
		return 0, history.CleanupRun{}, e
	}
	if expected.Scope == "archives" {
		// 文件删除后须完成审计提交，不能因浏览器取消请求而回滚数据库记录。
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
	}
	run := history.CleanupRun{CheckedAt: at.UTC().Format(time.RFC3339Nano)}
	detail := history.Detail{Label: "手动清理日志"}
	rev, e := s.ChangeLogged(ctx, actorID, base, "admin", &detail, false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		var currentRev int64
		if e := tx.QueryRowContext(ctx, "select revision from metadata where id=1").Scan(&currentRev); e != nil {
			return e
		}
		logs, e := readStoredLogs(ctx, tx)
		if e != nil {
			return e
		}
		root, files, _, _, e := s.logFiles()
		if root != nil {
			defer root.Close()
		}
		if e != nil {
			return e
		}
		preview, ids, selected, e := selectLogCleanup(logs, files, expected.Scope, expected.Days, currentRev, at)
		if e != nil {
			return e
		}
		if preview.Token != expected.Token || preview.Before != expected.Before {
			return ErrConflict
		}
		if preview.Count == 0 {
			return Bad("没有符合条件的日志，无需清理")
		}
		if e = deleteStoredLogs(ctx, tx, ids); e != nil {
			return e
		}
		run.OperationsDeleted = len(ids)
		detail.Tags = []history.Value{history.Text(fmt.Sprintf("%d 天前", expected.Days)), {Text: preview.Before, Kind: "timestamp"}}
		if expected.Scope == "operations" {
			run.Bytes = preview.Bytes
			detail.Tags = append(detail.Tags, cleanupCount(run.OperationsDeleted, "条操作记录"))
		} else {
			run.ArchivesDeleted, run.Bytes, run.Error = deleteArchivedLogs(root, selected)
			detail.Tags = append(detail.Tags, cleanupCount(run.ArchivesDeleted, "个日志归档文件"))
		}
		if run.Error != "" {
			detail.Tags = append(detail.Tags, history.Text(run.Error))
		}
		return writeSetting(ctx, tx, lastManualKey, run)
	})
	return rev, run, e
}

func (s *Store) MaintainLogs(ctx context.Context, at time.Time) (revision int64, changed bool, err error) {
	s.logMu.Lock()
	defer s.logMu.Unlock()
	run := history.CleanupRun{CheckedAt: at.UTC().Format(time.RFC3339Nano)}
	var deletedArchiveBytes int64
	defer func() {
		if err != nil && ctx.Err() == nil {
			run.OperationsDeleted = 0
			run.Bytes = deletedArchiveBytes
			run.Error = "自动清理未完成，请检查服务器日志"
			raw, _ := json.Marshal(run)
			_, _ = s.DB.ExecContext(ctx, "insert into system_settings(key,payload) values (?,?) on conflict(key) do update set payload=excluded.payload", lastAutomaticKey, string(raw))
		}
	}()
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return 0, false, e
	}
	defer tx.Rollback()
	policy, e := readLogPolicy(ctx, tx)
	if e != nil {
		return 0, false, e
	}
	if policy.OperationRetentionDays == 0 && policy.ArchiveRetentionDays == 0 {
		return 0, false, nil
	}
	var last *history.CleanupRun
	if e = readSetting(ctx, tx, lastAutomaticKey, &last); e != nil {
		return 0, false, e
	}
	if last != nil {
		checked, parseErr := time.Parse(time.RFC3339Nano, last.CheckedAt)
		if parseErr == nil && at.Sub(checked) >= 0 && at.Sub(checked) < time.Hour {
			return 0, false, nil
		}
	}
	if e = tx.QueryRowContext(ctx, "select revision from metadata where id=1").Scan(&revision); e != nil {
		return 0, false, e
	}
	logs, e := readStoredLogs(ctx, tx)
	if e != nil {
		return 0, false, e
	}
	root, files, _, _, e := s.logFiles()
	if root != nil {
		defer root.Close()
	}
	if e != nil {
		return 0, false, e
	}
	if policy.OperationRetentionDays > 0 {
		preview, ids, _, e := selectLogCleanup(logs, nil, "operations", policy.OperationRetentionDays, revision, at)
		if e != nil {
			return 0, false, e
		}
		if e = deleteStoredLogs(ctx, tx, ids); e != nil {
			return 0, false, e
		}
		run.OperationsDeleted = len(ids)
		run.Bytes = preview.Bytes
	}
	if policy.ArchiveRetentionDays > 0 {
		_, _, selected, e := selectLogCleanup(nil, files, "archives", policy.ArchiveRetentionDays, revision, at)
		if e != nil {
			return 0, false, e
		}
		var bytes int64
		run.ArchivesDeleted, bytes, run.Error = deleteArchivedLogs(root, selected)
		deletedArchiveBytes = bytes
		run.Bytes += bytes
	}
	if e = writeSetting(ctx, tx, lastAutomaticKey, run); e != nil {
		return 0, false, e
	}
	changed = run.OperationsDeleted+run.ArchivesDeleted > 0
	if changed {
		detail := history.Detail{Label: "自动清理日志", Tags: []history.Value{
			cleanupCount(run.OperationsDeleted, "条操作记录"), cleanupCount(run.ArchivesDeleted, "个日志归档文件"),
		}}
		if run.Error != "" {
			detail.Tags = append(detail.Tags, history.Text(run.Error))
		}
		if _, e = insertHistory(ctx, tx, "系统", "", run.CheckedAt, false, nil, &detail, nil); e != nil {
			return 0, false, e
		}
		if _, e = tx.ExecContext(ctx, "delete from history where id not in (select id from history order by id desc limit 200)"); e != nil {
			return 0, false, e
		}
		revision++
		if _, e = tx.ExecContext(ctx, "update metadata set revision=? where id=1", revision); e != nil {
			return 0, false, e
		}
	}
	return revision, changed, tx.Commit()
}

func cleanupCount(count int, unit string) history.Value {
	return history.Text(fmt.Sprintf("清理 %d %s", count, unit))
}
