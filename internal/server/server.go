package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"rsm/internal/auth"
	"rsm/internal/store"
)

type Server struct {
	Store           *store.Store
	Version         string
	mux             *http.ServeMux
	dummyHash       string
	confirmationKey []byte
	mu              sync.Mutex
	subscribers     map[*eventSubscriber]struct{}
	visitors        map[string]visitor
	online          Presence
	attempts        map[string]attempt
	static          http.Handler
}
type visitor struct {
	userID     string
	seen       time.Time
	connection *eventSubscriber
}
type attempt struct {
	Count int
	Start time.Time
}
type actorKey struct{}

func New(db *store.Store, assets fs.FS, version string) *Server {
	dummy, _ := auth.Hash(auth.Token())
	s := &Server{Store: db, Version: version, mux: http.NewServeMux(), dummyHash: dummy, confirmationKey: []byte(auth.Token()), subscribers: map[*eventSubscriber]struct{}{}, visitors: map[string]visitor{}, online: Presence{Users: []string{}}, attempts: map[string]attempt{}}
	if assets != nil {
		s.static = http.FileServer(http.FS(assets))
	}
	s.routes()
	return s
}
func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.health)
	s.mux.HandleFunc("GET /api/state", s.state)
	s.mux.HandleFunc("GET /api/agent/snapshot", s.agentSnapshot)
	s.mux.HandleFunc("POST /api/setup", s.setup)
	s.mux.HandleFunc("POST /api/login", s.login)
	s.mux.HandleFunc("POST /api/logout", s.logout)
	s.mux.HandleFunc("POST /api/auth/password", s.changePassword)
	s.mux.HandleFunc("GET /api/auth/password/{id}", s.revealPassword)
	s.mux.HandleFunc("POST /api/users", s.createUser)
	s.mux.HandleFunc("PATCH /api/users/{id}", s.updateUser)
	s.mux.HandleFunc("PUT /api/preferences", s.preferences)
	s.mux.HandleFunc("POST /api/calendar/refresh", s.refreshCalendar)
	s.mux.HandleFunc("POST /api/calendar/import", s.importCalendar)
	s.mux.HandleFunc("POST /api/avatar", s.uploadAvatar)
	s.mux.HandleFunc("GET /api/avatars/{id}", s.avatar)
	s.mux.HandleFunc("POST /api/requests", s.createRequest)
	s.mux.HandleFunc("POST /api/requests/batch", s.batchRequests)
	s.mux.HandleFunc("PUT /api/requests/gantt-order", s.orderGantt)
	s.mux.HandleFunc("POST /api/requests/priority", s.rankRequests)
	s.mux.HandleFunc("PUT /api/requests/{id}", s.updateRequest)
	s.mux.HandleFunc("DELETE /api/requests/{id}", s.deleteRequest)
	s.mux.HandleFunc("POST /api/requests/{id}/archive", s.archiveRequest)
	s.mux.HandleFunc("POST /api/domains", s.createDomain)
	s.mux.HandleFunc("PUT /api/domains/{id}", s.updateDomain)
	s.mux.HandleFunc("DELETE /api/domains/{id}", s.deleteDomain)
	s.mux.HandleFunc("POST /api/fields/merge", s.mergeField)
	s.mux.HandleFunc("POST /api/versions", s.saveVersion)
	s.mux.HandleFunc("DELETE /api/versions/{id}", s.deleteVersion)
	s.mux.HandleFunc("POST /api/versions/{id}/restore", s.restoreVersion)
	s.mux.HandleFunc("POST /api/history/{id}/undo", s.undo)
	s.mux.HandleFunc("GET /api/history/{id}/detail", s.historyDetail)
	s.mux.HandleFunc("GET /api/logs/management", s.logManagement)
	s.mux.HandleFunc("PUT /api/logs/policy", s.saveLogPolicy)
	s.mux.HandleFunc("POST /api/logs/cleanup/preview", s.previewLogCleanup)
	s.mux.HandleFunc("POST /api/logs/cleanup", s.cleanupLogs)
	s.mux.HandleFunc("POST /api/presence", s.presence)
	s.mux.HandleFunc("GET /api/events", s.events)
	s.mux.HandleFunc("/", s.serveStatic)
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Frame-Options", "DENY")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		w.Header().Set("Cache-Control", "no-store")
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("request failed", "method", r.Method, "path", r.URL.Path)
			s.fail(w, errors.New("internal server error"))
		}
	}()
	if r.Method != "GET" && r.Method != "HEAD" {
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			s.fail(w, store.ErrForbidden)
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" && origin != "http://"+r.Host && origin != "https://"+r.Host {
			s.fail(w, store.ErrForbidden)
			return
		}
	}
	var u auth.User
	if cookie, e := r.Cookie("rsm_session"); e == nil {
		u, _ = s.Store.Session(r.Context(), cookie.Value)
	}
	r = r.WithContext(context.WithValue(r.Context(), actorKey{}, u))
	if u.ID != "" && r.Method != http.MethodGet && r.Method != http.MethodHead {
		r = s.withP0DeliveryConfirmation(r, u.ID)
	}
	s.mux.ServeHTTP(w, r)
}
func actor(r *http.Request) auth.User { u, _ := r.Context().Value(actorKey{}).(auth.User); return u }
func decode(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(value); e != nil {
		return store.Bad("请求内容无效")
	}
	var extra any
	if e := d.Decode(&extra); !errors.Is(e, io.EOF) {
		return store.Bad("请求只能包含一个 JSON 对象")
	}
	return nil
}
func send(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) fail(w http.ResponseWriter, e error) {
	status, code, message := http.StatusInternalServerError, "internal", "服务暂时无法完成此操作"
	var invalid store.Invalid
	var confirmation store.P0DeliveryConfirmation
	switch {
	case errors.As(e, &confirmation):
		send(w, http.StatusPreconditionRequired, map[string]any{
			"error": confirmation.Error(), "code": "p0_delivery_confirmation_required", "confirmation": confirmation,
		})
		return
	case errors.Is(e, store.ErrUnauthorized):
		status, code, message = 401, "unauthorized", e.Error()
	case errors.Is(e, store.ErrForbidden):
		status, code, message = 403, "forbidden", e.Error()
	case errors.Is(e, store.ErrConflict):
		status, code, message = 409, "conflict", e.Error()
	case errors.Is(e, store.ErrNotFound):
		status, code, message = 404, "not_found", e.Error()
	case errors.As(e, &invalid):
		status, code, message = 400, "invalid", invalid.Error()
	default:
		slog.Error("request operation failed", "error", e.Error())
	}
	send(w, status, map[string]string{"error": message, "code": code})
}
func (s *Server) changed(revision int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sub := range s.subscribers {
		ch := sub.changes
		select {
		case ch <- revision:
		default:
			latest := revision
			select {
			case buffered := <-ch:
				if buffered > latest {
					latest = buffered
				}
			default:
			}
			select {
			case ch <- latest:
			default:
			}
		}
	}
}
func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	snap, e := s.Store.Snapshot(r.Context(), actor(r).ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	send(w, 200, struct {
		store.Snapshot
		ServerVersion string `json:"serverVersion"`
	}{snap, s.Version})
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	var rev int64
	var schema int
	if e := s.Store.DB.QueryRowContext(r.Context(), "select revision,schema_version from metadata where id=1").Scan(&rev, &schema); e != nil {
		send(w, 503, map[string]any{"status": "unavailable"})
		return
	}
	send(w, 200, map[string]any{"status": "ok", "version": s.Version, "revision": rev, "schemaVersion": schema})
}
func (s *Server) finish(w http.ResponseWriter, r *http.Request, revision int64, e error) {
	if e != nil {
		s.fail(w, e)
		return
	}
	s.changed(revision)
	s.state(w, r)
}
func revision(value *int64) error {
	if value == nil || *value < 0 {
		return store.Bad("缺少有效的数据版本")
	}
	return nil
}
func pathID(r *http.Request) (int64, error) {
	id, e := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if e != nil || id < 1 {
		return 0, store.ErrNotFound
	}
	return id, nil
}
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" {
		s.fail(w, store.ErrNotFound)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(405)
		return
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if s.static == nil {
		http.Error(w, "请先构建前端资源", 503)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		w.Header().Set("Cache-Control", "public,max-age=31536000,immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	if r.URL.Path != "/" && !strings.Contains(r.URL.Path, ".") {
		copy := r.Clone(r.Context())
		u := *r.URL
		u.Path = "/"
		copy.URL = &u
		s.static.ServeHTTP(w, copy)
		return
	}
	s.static.ServeHTTP(w, r)
}
func (s *Server) allowLogin(r *http.Request) bool {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t := time.Now()
	for key, a := range s.attempts {
		if t.Sub(a.Start) > time.Minute {
			delete(s.attempts, key)
		}
	}
	a := s.attempts[host]
	if a.Count >= 12 {
		return false
	}
	if a.Count == 0 {
		a.Start = t
	}
	a.Count++
	s.attempts[host] = a
	return true
}

func (s *Server) clearLogin(r *http.Request) {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	s.mu.Lock()
	delete(s.attempts, host)
	s.mu.Unlock()
}
