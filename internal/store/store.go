package store

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
	"rsm/internal/schedule"
	"rsm/internal/settings"
)

//go:embed migrations/*.sql
var migrations embed.FS

var (
	ErrConflict     = errors.New("数据已被其他人更新，请核对最新版本后重新提交")
	ErrUnauthorized = errors.New("请先登录")
	ErrForbidden    = errors.New("没有执行此操作的权限")
	ErrNotFound     = errors.New("记录不存在")
)

type Invalid struct{ Message string }

func (e Invalid) Error() string { return e.Message }
func Bad(message string) error  { return Invalid{message} }

type Store struct {
	DB    *sql.DB
	Home  string
	Vault *auth.Vault
	logMu sync.Mutex
}
type Snapshot struct {
	Calendar      schedule.Calendar    `json:"calendar"`
	Revision      int64                `json:"revision"`
	Requests      []requests.Request   `json:"requests"`
	GanttRowOrder map[string][]int64   `json:"ganttRowOrder,omitempty"`
	Domains       []requests.Domain    `json:"domains"`
	Users         []auth.User          `json:"users"`
	Me            *auth.User           `json:"me"`
	Preferences   settings.Preferences `json:"preferences"`
	Announcement  string               `json:"announcement,omitempty"`
	Logs          []history.Entry      `json:"logs"`
	LogPolicy     history.LogPolicy    `json:"logPolicy"`
	Versions      []history.Version    `json:"versions"`
	SetupRequired bool                 `json:"setupRequired"`
}

func Open(home string) (*Store, error) {
	abs, e := filepath.Abs(home)
	if e != nil {
		return nil, e
	}
	home = abs
	if e = os.MkdirAll(filepath.Join(home, "data"), 0700); e != nil {
		return nil, e
	}
	path := filepath.Join(home, "data", "rsm.db")
	_, statErr := os.Stat(path)
	existing := statErr == nil
	vault, e := auth.OpenVault(home, existing)
	if e != nil {
		return nil, e
	}
	dsn := url.URL{Scheme: "file", Path: path}
	q := url.Values{"_journal_mode": {"WAL"}, "_foreign_keys": {"on"}, "_busy_timeout": {"5000"}, "_txlock": {"immediate"}, "_synchronous": {"NORMAL"}}
	dsn.RawQuery = q.Encode()
	db, e := sql.Open("sqlite3", dsn.String())
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &Store{DB: db, Home: home, Vault: vault}
	if e = db.Ping(); e != nil {
		db.Close()
		return nil, e
	}
	var schema int
	err := db.QueryRow("select schema_version from metadata where id=1").Scan(&schema)
	if err == nil && schema > 1 {
		db.Close()
		return nil, errors.New("数据库版本高于本程序支持范围，拒绝降级")
	}
	migration, _ := migrations.ReadFile("migrations/001_initial.sql")
	if _, e = db.Exec(string(migration)); e != nil {
		db.Close()
		return nil, e
	}
	b, _ := json.Marshal(requests.Empty())
	if _, e = db.Exec("insert or ignore into metadata(id,schema_version,revision,payload) values (1,1,0,?)", string(b)); e != nil {
		db.Close()
		return nil, e
	}
	if e = os.Chmod(path, 0600); e != nil {
		db.Close()
		return nil, e
	}
	_, _ = db.Exec("delete from sessions where expires_at < ?", time.Now().Unix())
	if e = s.backfillRequestTimes(context.Background()); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func now() string             { return time.Now().UTC().Format(time.RFC3339Nano) }

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func user(ctx context.Context, q queryer, id string) (auth.User, error) {
	var u auth.User
	e := q.QueryRowContext(ctx, "select id,username,role,disabled,deleted,avatar_version from users where id=?", id).Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &u.Deleted, &u.Avatar)
	if u.Avatar != "" {
		u.Avatar = "/api/avatars/" + u.ID + "?v=" + u.Avatar
	}
	return u, e
}
func readData(ctx context.Context, q queryer) (requests.Data, int64, error) {
	var raw string
	var revision int64
	var data requests.Data
	e := q.QueryRowContext(ctx, "select payload,revision from metadata where id=1").Scan(&raw, &revision)
	if e == nil {
		e = json.Unmarshal([]byte(raw), &data)
	}
	return data, revision, e
}
func Users(ctx context.Context, q queryer) ([]auth.User, error) {
	rows, e := q.QueryContext(ctx, "select id,username,role,disabled,deleted,avatar_version from users order by rowid")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []auth.User{}
	for rows.Next() {
		var u auth.User
		if e = rows.Scan(&u.ID, &u.Username, &u.Role, &u.Disabled, &u.Deleted, &u.Avatar); e != nil {
			return nil, e
		}
		if u.Avatar != "" {
			u.Avatar = "/api/avatars/" + u.ID + "?v=" + u.Avatar
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
func Developers(ctx context.Context, q queryer) (map[string]bool, error) {
	us, e := Users(ctx, q)
	if e != nil {
		return nil, e
	}
	m := map[string]bool{}
	for _, u := range us {
		m[u.ID] = !u.Disabled && !u.Deleted
	}
	return m, nil
}

func (s *Store) RevealPassword(ctx context.Context, actorID, targetID string) (string, error) {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return "", e
	}
	defer tx.Rollback()
	who, e := user(ctx, tx, actorID)
	if e != nil || who.Disabled || who.Deleted {
		return "", ErrUnauthorized
	}
	if !who.Super() {
		return "", ErrForbidden
	}
	var raw []byte
	if e = tx.QueryRowContext(ctx, "select password_cipher from users where id=?", targetID).Scan(&raw); e != nil {
		if errors.Is(e, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", e
	}
	return s.Vault.Decrypt(targetID, raw)
}

func (s *Store) Snapshot(ctx context.Context, actorID string) (Snapshot, error) {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return Snapshot{}, e
	}
	defer tx.Rollback()
	d, rev, e := readData(ctx, tx)
	if e != nil {
		return Snapshot{}, e
	}
	out := Snapshot{Revision: rev, Requests: d.Requests, GanttRowOrder: d.GanttRowOrder, Domains: d.Domains, Users: []auth.User{}, Preferences: settings.Default(), Logs: []history.Entry{}, Versions: []history.Version{}}
	out.Users, e = Users(ctx, tx)
	if e != nil {
		return out, e
	}
	out.Calendar, e = ReadCalendar(ctx, tx)
	if e != nil {
		return out, e
	}
	out.LogPolicy, e = readLogPolicy(ctx, tx)
	if e != nil {
		return out, e
	}
	if e = readSetting(ctx, tx, announcementKey, &out.Announcement); e != nil {
		return out, e
	}
	out.SetupRequired = len(out.Users) == 0
	if actorID != "" {
		u, err := user(ctx, tx, actorID)
		if err == nil && !u.Disabled && !u.Deleted {
			out.Me = &u
			var raw string
			if err = tx.QueryRowContext(ctx, "select preferences from users where id=?", actorID).Scan(&raw); err != nil {
				return out, err
			}
			_ = json.Unmarshal([]byte(raw), &out.Preferences)
		}
	}
	rows, e := tx.QueryContext(ctx, "select id,actor,action,created_at,reversible,undone,preview from history left join history_details on id=history_id order by id desc limit 200")
	if e != nil {
		return out, e
	}
	i := 0
	for rows.Next() {
		var x history.Entry
		var preview sql.NullString
		if e = rows.Scan(&x.ID, &x.Actor, &x.Action, &x.CreatedAt, &x.Reversible, &x.Undone, &preview); e != nil {
			rows.Close()
			return out, e
		}
		if preview.Valid {
			if e = json.Unmarshal([]byte(preview.String), &x.Detail); e != nil {
				rows.Close()
				return out, e
			}
		}
		x.Reversible = x.Reversible && i < 50 && !x.Undone
		out.Logs = append(out.Logs, x)
		i++
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	rows, e = tx.QueryContext(ctx, "select id,label,actor,created_at,revision from versions order by created_at desc")
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var v history.Version
		if e = rows.Scan(&v.ID, &v.Label, &v.Actor, &v.CreatedAt, &v.Revision); e != nil {
			rows.Close()
			return out, e
		}
		out.Versions = append(out.Versions, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	return out, tx.Commit()
}

func (s *Store) Session(ctx context.Context, token string) (auth.User, error) {
	if len(token) < 20 || len(token) > 200 {
		return auth.User{}, ErrUnauthorized
	}
	var id string
	e := s.DB.QueryRowContext(ctx, "select user_id from sessions where token_hash=? and expires_at>?", auth.TokenHash(token), time.Now().Unix()).Scan(&id)
	if e != nil {
		return auth.User{}, ErrUnauthorized
	}
	u, e := user(ctx, s.DB, id)
	if e != nil || u.Disabled || u.Deleted {
		return auth.User{}, ErrUnauthorized
	}
	return u, nil
}
func (s *Store) Login(ctx context.Context, username, password, dummyHash string) (string, error) {
	var id, hash string
	e := s.DB.QueryRowContext(ctx, "select id,password_hash from users where username=? and disabled=0 and deleted=0", username).Scan(&id, &hash)
	if e != nil {
		auth.Verify(password, dummyHash)
		return "", ErrUnauthorized
	}
	if !auth.Verify(password, hash) {
		return "", ErrUnauthorized
	}
	token := auth.Token()
	result, e := s.DB.ExecContext(ctx, "insert into sessions(token_hash,user_id,expires_at) select ?,id,? from users where id=? and password_hash=? and disabled=0 and deleted=0", auth.TokenHash(token), time.Now().Add(30*24*time.Hour).Unix(), id, hash)
	if e != nil {
		return "", e
	}
	n, e := result.RowsAffected()
	if e != nil || n != 1 {
		return "", ErrUnauthorized
	}
	return token, nil
}
func (s *Store) Logout(ctx context.Context, token string) error {
	_, e := s.DB.ExecContext(ctx, "delete from sessions where token_hash=?", auth.TokenHash(token))
	return e
}
func (s *Store) Password(ctx context.Context, id string) (string, error) {
	var raw []byte
	e := s.DB.QueryRowContext(ctx, "select password_cipher from users where id=?", id).Scan(&raw)
	if e != nil {
		return "", ErrNotFound
	}
	return s.Vault.Decrypt(id, raw)
}
func (s *Store) PasswordHash(ctx context.Context, id string) (string, error) {
	var hash string
	e := s.DB.QueryRowContext(ctx, "select password_hash from users where id=?", id).Scan(&hash)
	return hash, e
}
func (s *Store) Avatar(ctx context.Context, id string) ([]byte, string, error) {
	var b []byte
	var typ string
	e := s.DB.QueryRowContext(ctx, "select avatar,avatar_type from users where id=?", id).Scan(&b, &typ)
	if e != nil || len(b) == 0 {
		return nil, "", ErrNotFound
	}
	return b, typ, nil
}
func PreserveIDs(restored *requests.Data, current requests.Data) {
	if restored.NextID < current.NextID {
		restored.NextID = current.NextID
	}
	for i := range restored.Requests {
		restored.Requests[i].Revision++
		for _, r := range current.Requests {
			if restored.Requests[i].ID == r.ID && restored.Requests[i].Revision <= r.Revision {
				restored.Requests[i].Revision = r.Revision + 1
			}
		}
	}
}
func DecodeData(raw string) (requests.Data, error) {
	var d requests.Data
	e := json.Unmarshal([]byte(raw), &d)
	if e != nil {
		return d, fmt.Errorf("快照无法读取：%w", e)
	}
	return d, nil
}

func (s *Store) Change(ctx context.Context, actorID string, base *int64, permission, action string, reversible bool, fn func(*sql.Tx, *requests.Data, auth.User) error) (int64, error) {
	return s.change(ctx, actorID, base, permission, action, nil, reversible, nil, fn)
}

func (s *Store) ChangeLogged(ctx context.Context, actorID string, base *int64, permission string, detail *history.Detail, reversible bool, fn func(*sql.Tx, *requests.Data, auth.User) error) (int64, error) {
	return s.change(ctx, actorID, base, permission, "", detail, reversible, nil, fn)
}

func (s *Store) ChangeRequests(ctx context.Context, actorID string, base *int64, permission string, detail *history.Detail, fn func(*sql.Tx, *requests.Data, auth.User) error) (revision, operationID int64, err error) {
	revision, err = s.change(ctx, actorID, base, permission, "", detail, true, &operationID, fn)
	return
}

func (s *Store) change(ctx context.Context, actorID string, base *int64, permission, action string, detail *history.Detail, reversible bool, operationID *int64, fn func(*sql.Tx, *requests.Data, auth.User) error) (int64, error) {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback()
	who := auth.User{Username: "系统"}
	if permission != "setup" {
		if actorID == "" {
			return 0, ErrUnauthorized
		}
		who, e = user(ctx, tx, actorID)
		if e != nil || who.Disabled || who.Deleted {
			return 0, ErrUnauthorized
		}
		switch permission {
		case "edit":
			if !who.CanEdit() {
				return 0, ErrForbidden
			}
		case "admin":
			if !who.Admin() {
				return 0, ErrForbidden
			}
		case "super":
			if !who.Super() {
				return 0, ErrForbidden
			}
		case "login":
		default:
			return 0, ErrForbidden
		}
	}
	data, revision, e := readData(ctx, tx)
	if e != nil {
		return 0, e
	}
	if base != nil && *base != revision {
		return 0, ErrConflict
	}
	before, e := json.Marshal(data)
	if e != nil {
		return 0, e
	}
	schedules, e := readRequestSchedules(ctx, tx, data.Requests)
	if e != nil {
		return 0, e
	}
	if e = fn(tx, &data, who); e != nil {
		return 0, e
	}
	if e = checkP0ScheduleChanges(ctx, tx, revision, schedules, data.Requests); e != nil {
		return 0, e
	}
	after, e := json.Marshal(data)
	if e != nil {
		return 0, e
	}
	if _, e = tx.ExecContext(ctx, "update metadata set revision=?,payload=? where id=1", revision+1, string(after)); e != nil {
		return 0, e
	}
	var beforeValue any
	if reversible {
		beforeValue = string(before)
	}
	var operation *requestOperation
	if operationID != nil {
		previous, err := DecodeData(string(before))
		if err != nil {
			return 0, err
		}
		operation, e = captureRequestOperation(ctx, tx, who, previous, data)
		if e != nil {
			return 0, e
		}
	}
	logID, e := insertHistory(ctx, tx, who.Username, action, now(), reversible, beforeValue, detail, operation)
	if e != nil {
		return 0, e
	}
	if _, e = tx.ExecContext(ctx, "delete from history where id not in (select id from history order by id desc limit 200)"); e != nil {
		return 0, e
	}
	if e = tx.Commit(); e != nil {
		return 0, e
	}
	if operation != nil {
		*operationID = logID
	}
	return revision + 1, nil
}

func RestoreData(current *requests.Data, saved requests.Data) {
	if saved.NextID < current.NextID {
		saved.NextID = current.NextID
	}
	revisions := map[int64]int64{}
	for _, r := range current.Requests {
		revisions[r.ID] = r.Revision
	}
	for i := range saved.Requests {
		r := &saved.Requests[i]
		if r.Revision < revisions[r.ID] {
			r.Revision = revisions[r.ID]
		}
		r.Revision++
		if r.ID >= saved.NextID {
			saved.NextID = r.ID + 1
		}
	}
	*current = saved
}
