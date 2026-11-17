package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"rsm/internal/history"
	"rsm/internal/store"
)

func (s *Server) logManagement(w http.ResponseWriter, r *http.Request) {
	status, e := s.Store.LogManagement(r.Context(), actor(r).ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	send(w, 200, status)
}

func (s *Server) saveLogPolicy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base       *int64 `json:"baseRevision"`
		Operations *int   `json:"operationRetentionDays"`
		Archives   *int   `json:"archiveRetentionDays"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	if in.Operations == nil || in.Archives == nil {
		s.fail(w, store.Bad("请提供完整的日志保留策略"))
		return
	}
	rev, e := s.Store.SaveLogPolicy(r.Context(), actor(r).ID, in.Base, history.LogPolicy{OperationRetentionDays: *in.Operations, ArchiveRetentionDays: *in.Archives})
	s.finish(w, r, rev, e)
}

func (s *Server) previewLogCleanup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Scope string `json:"scope"`
		Days  *int   `json:"days"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if in.Days == nil {
		s.fail(w, store.Bad("请输入清理天数"))
		return
	}
	preview, e := s.Store.PreviewLogCleanup(r.Context(), actor(r).ID, in.Scope, *in.Days, time.Now())
	if e != nil {
		s.fail(w, e)
		return
	}
	send(w, 200, preview)
}

func (s *Server) cleanupLogs(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base   *int64 `json:"baseRevision"`
		Scope  string `json:"scope"`
		Days   *int   `json:"days"`
		Before string `json:"before"`
		Token  string `json:"token"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	if in.Days == nil || in.Token == "" || in.Before == "" {
		s.fail(w, store.Bad("请先预览待清理日志，再确认清理"))
		return
	}
	rev, run, e := s.Store.CleanupLogs(r.Context(), actor(r).ID, in.Base, history.CleanupPreview{Scope: in.Scope, Days: *in.Days, Before: in.Before, Token: in.Token}, time.Now())
	if e != nil {
		s.fail(w, e)
		return
	}
	s.changed(rev)
	snap, e := s.Store.Snapshot(r.Context(), actor(r).ID)
	if e != nil {
		s.fail(w, e)
		return
	}
	send(w, 200, struct {
		State any                `json:"state"`
		Run   history.CleanupRun `json:"cleanup"`
	}{struct {
		store.Snapshot
		ServerVersion string `json:"serverVersion"`
	}{snap, s.Version}, run})
}

func (s *Server) RunLogMaintenance(ctx context.Context) {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		rev, changed, e := s.Store.MaintainLogs(ctx, time.Now())
		if e != nil && ctx.Err() == nil {
			slog.Error("log maintenance failed", "error", e.Error())
		} else if changed {
			s.changed(rev)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
