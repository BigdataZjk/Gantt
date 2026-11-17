package server

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strings"
	"time"

	"rsm/internal/auth"
	"rsm/internal/requests"
	"rsm/internal/store"
)

func (s *Server) saveVersion(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base  *int64 `json:"baseRevision"`
		Label string `json:"label"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	if len([]rune(in.Label)) > 160 {
		s.fail(w, store.Bad("版本备注最多160字"))
		return
	}
	rev, e := s.Store.Change(r.Context(), actor(r).ID, in.Base, "edit", "手动保存版本", false, func(tx *sql.Tx, d *requests.Data, u auth.User) error {
		var count int
		if e := tx.QueryRowContext(r.Context(), "select count(*) from versions").Scan(&count); e != nil {
			return e
		}
		if count >= 1000 {
			return store.Bad("版本已达1000份，请先删除不需要的版本")
		}
		for attempt := 0; attempt < 100; attempt++ {
			n, e := rand.Int(rand.Reader, big.NewInt(10000))
			if e != nil {
				return e
			}
			id := fmt.Sprintf("%04d", n.Int64())
			if e = tx.QueryRowContext(r.Context(), "select count(*) from versions where id=?", id).Scan(&count); e != nil {
				return e
			}
			if count != 0 {
				continue
			}
			_, e = tx.ExecContext(r.Context(), "insert into versions(id,label,actor,created_at,revision,payload) values (?,?,?,?,?,?)", id, strings.TrimSpace(in.Label), u.Username, time.Now().UTC().Format(time.RFC3339Nano), *in.Base, jsonValue(*d))
			return e
		}
		return store.Bad("版本编号暂时无法生成，请重试")
	})
	s.finish(w, r, rev, e)
}
func (s *Server) deleteVersion(w http.ResponseWriter, r *http.Request) {
	var in revisionInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	rev, e := s.Store.Change(r.Context(), actor(r).ID, in.Base, "edit", "删除版本："+r.PathValue("id"), false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		result, e := tx.ExecContext(r.Context(), "delete from versions where id=?", r.PathValue("id"))
		if e != nil {
			return e
		}
		n, _ := result.RowsAffected()
		if n != 1 {
			return store.ErrNotFound
		}
		return nil
	})
	s.finish(w, r, rev, e)
}
func (s *Server) restoreVersion(w http.ResponseWriter, r *http.Request) {
	var in revisionInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	rev, e := s.Store.Change(r.Context(), actor(r).ID, in.Base, "admin", "恢复版本："+r.PathValue("id"), true, func(tx *sql.Tx, d *requests.Data, _ auth.User) error {
		var raw string
		if e := tx.QueryRowContext(r.Context(), "select payload from versions where id=?", r.PathValue("id")).Scan(&raw); e != nil {
			return store.ErrNotFound
		}
		saved, e := store.DecodeData(raw)
		if e != nil {
			return e
		}
		store.RestoreData(d, saved)
		return nil
	})
	s.finish(w, r, rev, e)
}
func (s *Server) undo(w http.ResponseWriter, r *http.Request) {
	var in revisionInput
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	id, e := pathID(r)
	if e != nil {
		s.fail(w, e)
		return
	}
	rev, e := s.Store.Change(r.Context(), actor(r).ID, in.Base, "admin", "撤回到操作之前", false, func(tx *sql.Tx, d *requests.Data, _ auth.User) error {
		var raw sql.NullString
		var reversible, undone bool
		var newer int
		if e := tx.QueryRowContext(r.Context(), "select before_data,reversible,undone from history where id=?", id).Scan(&raw, &reversible, &undone); e != nil {
			return store.ErrNotFound
		}
		if e := tx.QueryRowContext(r.Context(), "select count(*) from history where id>?", id).Scan(&newer); e != nil {
			return e
		}
		if !reversible || undone || newer >= 50 || !raw.Valid {
			return store.Bad("此操作不可撤回，仅最近50条记录内的数据变更支持撤回")
		}
		saved, e := store.DecodeData(raw.String)
		if e != nil {
			return e
		}
		store.RestoreData(d, saved)
		_, e = tx.ExecContext(r.Context(), "update history set undone=1 where id>=? and reversible=1 and undone=0", id)
		return e
	})
	s.finish(w, r, rev, e)
}

func (s *Server) presence(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID string `json:"clientId"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if len(in.ID) < 8 || len(in.ID) > 100 {
		s.fail(w, store.Bad("访问标识无效"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for id, v := range s.visitors {
		if now.Sub(v.Seen) > 65*time.Second {
			delete(s.visitors, id)
		}
	}
	if len(s.visitors) >= 10000 {
		send(w, 429, map[string]string{"error": "在线访问数量过多", "code": "rate_limited"})
		return
	}
	s.visitors[in.ID] = visitor{actor(r).ID, now}
	us := []string{}
	seen := map[string]bool{}
	guests := 0
	for _, v := range s.visitors {
		if v.UserID == "" {
			guests++
		} else if !seen[v.UserID] {
			us = append(us, v.UserID)
			seen[v.UserID] = true
		}
	}
	sort.Strings(us)
	send(w, 200, map[string]any{"users": us, "guests": guests})
}
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if _, ok := w.(http.Flusher); !ok {
		s.fail(w, store.Bad("不支持事件流"))
		return
	}
	ch := make(chan int64, 1)
	s.mu.Lock()
	if len(s.subscribers) > 500 {
		s.mu.Unlock()
		send(w, 429, map[string]string{"error": "事件连接过多", "code": "rate_limited"})
		return
	}
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.subscribers, ch); s.mu.Unlock() }()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	emit := func(revision int64) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		b, _ := json.Marshal(map[string]int64{"revision": revision})
		if _, e := fmt.Fprintf(w, "event: change\ndata: %s\n\n", b); e != nil {
			return false
		}
		return rc.Flush() == nil
	}
	var rev int64
	if e := s.Store.DB.QueryRowContext(r.Context(), "select revision from metadata where id=1").Scan(&rev); e != nil {
		return
	}
	if !emit(rev) {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case revision := <-ch:
			if !emit(revision) {
				return
			}
		case <-ticker.C:
			_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, e := fmt.Fprint(w, ": heartbeat\n\n"); e != nil {
				return
			}
			if e := rc.Flush(); e != nil {
				return
			}
		}
	}
}
