package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
	"rsm/internal/settings"
	"rsm/internal/store"
)

func cookie(w http.ResponseWriter, r *http.Request, token string, remember bool) {
	c := &http.Cookie{Name: "rsm_session", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil}
	if remember {
		c.MaxAge = 30 * 24 * 60 * 60
	}
	if token == "" {
		c.MaxAge = -1
		c.Expires = time.Unix(1, 0)
	}
	http.SetCookie(w, c)
}
func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if !s.allowLogin(r) {
		send(w, 429, map[string]string{"error": "尝试过于频繁，请稍后再试", "code": "rate_limited"})
		return
	}
	hash, e := auth.Hash(in.Password)
	if e != nil {
		s.fail(w, store.Bad(e.Error()))
		return
	}
	id := auth.ID()
	cipher, e := s.Store.Vault.Encrypt(id, in.Password)
	if e != nil {
		s.fail(w, e)
		return
	}
	const username = "张金科"
	detail := history.Detail{Label: "初始化超级管理员", Subject: username, Tags: []history.Value{{Text: "superadmin", Kind: "role"}}}
	rev, e := s.Store.ChangeLogged(r.Context(), "", nil, "setup", &detail, false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		var count int
		if e := tx.QueryRowContext(r.Context(), "select count(*) from users").Scan(&count); e != nil {
			return e
		}
		if count != 0 {
			return store.ErrForbidden
		}
		_, e := tx.ExecContext(r.Context(), "insert into users(id,username,role,password_hash,password_cipher) values (?,?,'superadmin',?,?)", id, username, hash, cipher)
		return e
	})
	if e != nil {
		s.fail(w, e)
		return
	}
	token, e := s.Store.Login(r.Context(), username, in.Password, s.dummyHash)
	if e != nil {
		s.fail(w, e)
		return
	}
	cookie(w, r, token, true)
	s.clearLogin(r)
	s.changed(rev)
	s.state(w, withActor(r, auth.User{ID: id}))
}
func withActor(r *http.Request, u auth.User) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), actorKey{}, u))
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Remember *bool  `json:"remember"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if !s.allowLogin(r) {
		send(w, 429, map[string]string{"error": "尝试过于频繁，请一分钟后重试", "code": "rate_limited"})
		return
	}
	token, e := s.Store.Login(r.Context(), in.Username, in.Password, s.dummyHash)
	if e != nil {
		if e == store.ErrUnauthorized {
			send(w, 401, map[string]string{"error": "用户名或密码不正确，或账号不可用", "code": "unauthorized"})
		} else {
			s.fail(w, e)
		}
		return
	}
	cookie(w, r, token, in.Remember == nil || *in.Remember)
	s.clearLogin(r)
	u, e := s.Store.Session(r.Context(), token)
	if e != nil {
		s.fail(w, e)
		return
	}
	s.state(w, withActor(r, u))
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, e := r.Cookie("rsm_session"); e == nil {
		if e = s.Store.Logout(r.Context(), c.Value); e != nil {
			s.fail(w, e)
			return
		}
	}
	cookie(w, r, "", false)
	s.state(w, withActor(r, auth.User{}))
}
func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	u := actor(r)
	if !u.Admin() {
		s.fail(w, store.ErrForbidden)
		return
	}
	if in.Username == "" || in.Username != strings.TrimSpace(in.Username) || len([]rune(in.Username)) > 80 || strings.ContainsAny(in.Username, "\n\r\x00") || !auth.ValidRole(in.Role) || in.Role == "superadmin" {
		s.fail(w, store.Bad("用户名或角色无效"))
		return
	}
	if !u.Super() && in.Role == "admin" {
		s.fail(w, store.ErrForbidden)
		return
	}
	hash, e := auth.Hash(in.Password)
	if e != nil {
		s.fail(w, store.Bad(e.Error()))
		return
	}
	id := auth.ID()
	cipher, e := s.Store.Vault.Encrypt(id, in.Password)
	if e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "新增账号", Subject: in.Username, Tags: []history.Value{{Text: in.Role, Kind: "role"}}}
	rev, e := s.Store.ChangeLogged(r.Context(), u.ID, nil, "admin", &detail, false, func(tx *sql.Tx, _ *requests.Data, who auth.User) error {
		if !who.Super() && in.Role == "admin" {
			return store.ErrForbidden
		}
		var count int
		if e := tx.QueryRowContext(r.Context(), "select count(*) from users where username=?", in.Username).Scan(&count); e != nil {
			return e
		}
		if count != 0 {
			return store.Bad("用户名已存在，删除的账号名称也保留")
		}
		_, e := tx.ExecContext(r.Context(), "insert into users(id,username,role,password_hash,password_cipher) values (?,?,?,?,?)", id, in.Username, in.Role, hash, cipher)
		return e
	})
	s.finish(w, r, rev, e)
}
func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Role     *string `json:"role"`
		Disabled *bool   `json:"disabled"`
		Deleted  *bool   `json:"deleted"`
		Password string  `json:"password"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	who := actor(r)
	if !who.Admin() {
		s.fail(w, store.ErrForbidden)
		return
	}
	id := r.PathValue("id")
	var hash string
	var cipher []byte
	var e error
	if in.Password != "" {
		if !who.Super() {
			s.fail(w, store.ErrForbidden)
			return
		}
		hash, e = auth.Hash(in.Password)
		if e != nil {
			s.fail(w, store.Bad(e.Error()))
			return
		}
		cipher, e = s.Store.Vault.Encrypt(id, in.Password)
		if e != nil {
			s.fail(w, e)
			return
		}
	}
	noChange := errors.New("account unchanged")
	detail := history.Detail{Label: "更新账号资料"}
	rev, e := s.Store.ChangeLogged(r.Context(), who.ID, nil, "admin", &detail, false, func(tx *sql.Tx, _ *requests.Data, u auth.User) error {
		var name, role string
		var disabled, deleted bool
		if e := tx.QueryRowContext(r.Context(), "select username,role,disabled,deleted from users where id=?", id).Scan(&name, &role, &disabled, &deleted); e != nil {
			return store.ErrNotFound
		}
		if deleted {
			return store.Bad("已删除的账号不能修改")
		}
		oldRole, oldDisabled, oldDeleted := role, disabled, deleted
		if !u.Super() && (role == "admin" || role == "superadmin" || in.Password != "") {
			return store.ErrForbidden
		}
		if role == "superadmin" {
			if (in.Role != nil && *in.Role != "superadmin") || (in.Disabled != nil && *in.Disabled) || (in.Deleted != nil && *in.Deleted) {
				return store.Bad("初始超级管理员不可删除、停用或降权")
			}
		} else if in.Role != nil {
			if !auth.ValidRole(*in.Role) || *in.Role == "superadmin" {
				return store.Bad("角色无效")
			}
			if !u.Super() && *in.Role == "admin" {
				return store.ErrForbidden
			}
			role = *in.Role
		}
		if in.Disabled != nil {
			disabled = *in.Disabled
		}
		if in.Deleted != nil {
			deleted = *in.Deleted
		}
		if role == oldRole && disabled == oldDisabled && deleted == oldDeleted && hash == "" {
			return noChange
		}
		detail.Subject = name
		detail.Add("角色", logValue(oldRole, "role"), logValue(role, "role"))
		detail.Add("账号状态", accountStatus(oldDisabled, oldDeleted), accountStatus(disabled, deleted))
		if hash != "" {
			reset := history.Text("已重置")
			detail.Changes = append(detail.Changes, history.Change{Field: "密码", After: &reset})
		}
		if len(detail.Changes) == 1 {
			switch detail.Changes[0].Field {
			case "角色":
				detail.Label = "修改角色"
			case "账号状态":
				switch {
				case deleted:
					detail.Label = "删除账号"
				case disabled:
					detail.Label = "停用账号"
				default:
					detail.Label = "启用账号"
				}
			case "密码":
				detail.Label = "重置密码"
			}
		}
		if _, e := tx.ExecContext(r.Context(), "update users set role=?,disabled=?,deleted=? where id=?", role, disabled, deleted, id); e != nil {
			return e
		}
		if hash != "" {
			if _, e := tx.ExecContext(r.Context(), "update users set password_hash=?,password_cipher=? where id=?", hash, cipher, id); e != nil {
				return e
			}
		}
		_, e := tx.ExecContext(r.Context(), "delete from sessions where user_id=?", id)
		return e
	})
	if errors.Is(e, noChange) {
		s.state(w, r)
		return
	}
	if e == nil && id == who.ID {
		cookie(w, r, "", false)
		r = withActor(r, auth.User{})
	}
	s.finish(w, r, rev, e)
}
func accountStatus(disabled, deleted bool) history.Value {
	switch {
	case deleted:
		return history.Text("已删除")
	case disabled:
		return history.Text("已停用")
	default:
		return history.Text("已启用")
	}
}
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Current  string `json:"currentPassword"`
		Password string `json:"password"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	u := actor(r)
	if u.ID == "" {
		s.fail(w, store.ErrUnauthorized)
		return
	}
	if !s.allowLogin(r) {
		send(w, 429, map[string]string{"error": "尝试过于频繁，请稍后再试", "code": "rate_limited"})
		return
	}
	old, e := s.Store.PasswordHash(r.Context(), u.ID)
	if e != nil || !auth.Verify(in.Current, old) {
		s.fail(w, store.Bad("当前密码不正确"))
		return
	}
	hash, e := auth.Hash(in.Password)
	if e != nil {
		s.fail(w, store.Bad(e.Error()))
		return
	}
	cipher, e := s.Store.Vault.Encrypt(u.ID, in.Password)
	if e != nil {
		s.fail(w, e)
		return
	}
	detail := history.Detail{Label: "修改本人密码", Subject: u.Username, Tags: []history.Value{history.Text("已完成")}}
	rev, e := s.Store.ChangeLogged(r.Context(), u.ID, nil, "login", &detail, false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		result, e := tx.ExecContext(r.Context(), "update users set password_hash=?,password_cipher=? where id=? and password_hash=?", hash, cipher, u.ID, old)
		if e != nil {
			return e
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return store.ErrConflict
		}
		_, e = tx.ExecContext(r.Context(), "delete from sessions where user_id=?", u.ID)
		return e
	})
	if e != nil {
		s.fail(w, e)
		return
	}
	token, e := s.Store.Login(r.Context(), u.Username, in.Password, s.dummyHash)
	if e != nil {
		s.fail(w, e)
		return
	}
	cookie(w, r, token, true)
	s.clearLogin(r)
	s.finish(w, r, rev, nil)
}
func (s *Server) revealPassword(w http.ResponseWriter, r *http.Request) {
	if !actor(r).Super() {
		s.fail(w, store.ErrForbidden)
		return
	}
	password, e := s.Store.RevealPassword(r.Context(), actor(r).ID, r.PathValue("id"))
	if e != nil {
		s.fail(w, e)
		return
	}
	send(w, 200, map[string]string{"password": password})
}
func (s *Server) preferences(w http.ResponseWriter, r *http.Request) {
	var p settings.Preferences
	if e := decode(w, r, &p); e != nil {
		s.fail(w, e)
		return
	}
	if e := p.Validate(); e != nil {
		s.fail(w, store.Bad(e.Error()))
		return
	}
	if actor(r).ID == "" {
		s.fail(w, store.ErrUnauthorized)
		return
	}
	// Personal display choices deliberately do not create audit entries or a shared revision.
	b, e := json.Marshal(p)
	if e != nil {
		s.fail(w, e)
		return
	}
	result, e := s.Store.DB.ExecContext(r.Context(), "update users set preferences=? where id=? and disabled=0 and deleted=0", string(b), actor(r).ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	n, _ := result.RowsAffected()
	if n != 1 {
		s.fail(w, store.ErrUnauthorized)
		return
	}
	s.state(w, r)
}
func (s *Server) uploadAvatar(w http.ResponseWriter, r *http.Request) {
	if actor(r).ID == "" {
		s.fail(w, store.ErrUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	b, e := io.ReadAll(r.Body)
	if e != nil || len(b) == 0 {
		s.fail(w, store.Bad("头像不能为空且不得超过4 MiB"))
		return
	}
	typ := http.DetectContentType(b)
	if typ != "image/jpeg" && typ != "image/png" && typ != "image/gif" && typ != "image/webp" {
		s.fail(w, store.Bad("头像仅支持 JPG、PNG、WebP、GIF"))
		return
	}
	detail := history.Detail{Label: "更新头像", Tags: []history.Value{history.Text("已完成")}}
	rev, e := s.Store.ChangeLogged(r.Context(), actor(r).ID, nil, "login", &detail, false, func(tx *sql.Tx, _ *requests.Data, u auth.User) error {
		detail.Subject = u.Username
		_, e := tx.ExecContext(r.Context(), "update users set avatar=?,avatar_type=?,avatar_version=? where id=?", b, typ, auth.ID(), u.ID)
		return e
	})
	s.finish(w, r, rev, e)
}
func (s *Server) avatar(w http.ResponseWriter, r *http.Request) {
	b, typ, e := s.Store.Avatar(r.Context(), r.PathValue("id"))
	if e != nil || len(b) == 0 {
		s.fail(w, store.ErrNotFound)
		return
	}
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	w.Header().Set("Cache-Control", "private,max-age=300")
	_, _ = w.Write(b)
}
