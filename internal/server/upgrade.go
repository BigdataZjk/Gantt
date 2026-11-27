package server

import (
	"errors"
	"log/slog"
	"net/http"

	"rsm/internal/store"
	"rsm/internal/upgrade"
)

type upgradeState struct {
	CurrentVersion string       `json:"currentVersion"`
	Available      bool         `json:"available"`
	MaxSourceBytes int          `json:"maxSourceBytes"`
	Job            *upgrade.Job `json:"job,omitempty"`
}

func (s *Server) upgradeAccess(w http.ResponseWriter, r *http.Request) bool {
	user := actor(r)
	if user.ID == "" {
		s.fail(w, store.ErrUnauthorized)
		return false
	}
	if !user.Super() {
		s.fail(w, store.ErrForbidden)
		return false
	}
	return true
}

func (s *Server) upgradeStatus(w http.ResponseWriter, r *http.Request) {
	if !s.upgradeAccess(w, r) {
		return
	}
	manager := upgrade.Manager{Home: s.Store.Home}
	job, err := manager.Status()
	if err != nil {
		s.fail(w, err)
		return
	}
	s.sendUpgradeState(w, http.StatusOK, manager.Available(s.Version), job)
}

func (s *Server) stageUpgradeSource(w http.ResponseWriter, r *http.Request) {
	if !s.upgradeAccess(w, r) {
		return
	}
	manager := upgrade.Manager{Home: s.Store.Home}
	if !manager.Available(s.Version) {
		s.fail(w, store.Bad("网页升级需要通过 rsm.sh 运行的已安装实例"))
		return
	}
	if r.Header.Get("Content-Type") != "application/zip" {
		s.fail(w, store.Bad("请选择源码 ZIP 文件"))
		return
	}
	body := http.MaxBytesReader(w, r.Body, upgrade.MaxSourceBytes)
	defer body.Close()
	job, err := manager.Stage(s.Version, body)
	if err != nil {
		s.failUpgrade(w, err)
		return
	}
	s.sendUpgradeState(w, http.StatusOK, true, job)
}

func (s *Server) applyUpgrade(w http.ResponseWriter, r *http.Request) {
	if !s.upgradeAccess(w, r) {
		return
	}
	manager := upgrade.Manager{Home: s.Store.Home}
	if !manager.Available(s.Version) {
		s.fail(w, store.Bad("网页升级需要通过 rsm.sh 运行的已安装实例"))
		return
	}
	var input StartUpgradeInput
	if err := decode(w, r, &input); err != nil {
		s.fail(w, err)
		return
	}
	job, err := manager.Start(input.Sha256)
	if err != nil {
		s.failUpgrade(w, err)
		return
	}
	slog.Info("web upgrade started", "userId", actor(r).ID, "from", s.Version, "to", job.Version, "sha256", job.SHA256)
	s.sendUpgradeState(w, http.StatusAccepted, true, job)
}

func (s *Server) sendUpgradeState(w http.ResponseWriter, status int, available bool, job *upgrade.Job) {
	send(w, status, upgradeState{CurrentVersion: s.Version, Available: available, MaxSourceBytes: upgrade.MaxSourceBytes, Job: job})
}

func (s *Server) failUpgrade(w http.ResponseWriter, err error) {
	var maxBytes *http.MaxBytesError
	switch {
	case errors.As(err, &maxBytes):
		send(w, http.StatusRequestEntityTooLarge, map[string]string{"code": "upgrade_source_too_large", "error": "源码 ZIP 大小超过 16 MiB"})
	case errors.Is(err, upgrade.ErrBusy), errors.Is(err, upgrade.ErrStaged):
		send(w, http.StatusConflict, map[string]string{"code": "upgrade_conflict", "error": err.Error()})
	case errors.Is(err, upgrade.ErrSignature), errors.Is(err, upgrade.ErrSource), errors.Is(err, upgrade.ErrOlder):
		s.fail(w, store.Bad(err.Error()))
	default:
		s.fail(w, err)
	}
}
