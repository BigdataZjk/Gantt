package upgrade

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const launchGrace = 30 * time.Second

var (
	ErrBusy       = errors.New("已有系统升级操作正在进行")
	ErrStaged     = errors.New("待升级的源码包已变更，请重新确认")
	digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type Job struct {
	Version   string `json:"version"`
	SHA256    string `json:"sha256"`
	Status    string `json:"status"`
	Step      int    `json:"step"`
	StartedAt string `json:"startedAt,omitempty"`
}

type Manager struct{ Home string }

func (m Manager) Available(version string) bool {
	if !versionPattern.MatchString(version) {
		return false
	}
	pid, err := os.ReadFile(filepath.Join(m.Home, "run", "rsm.pid"))
	if err != nil || strings.TrimSpace(string(pid)) != strconv.Itoa(os.Getpid()) {
		return false
	}
	script, err := os.Stat(filepath.Join(m.Home, "rsm.sh"))
	if err != nil || !script.Mode().IsRegular() || script.Mode()&0111 == 0 {
		return false
	}
	current, err := os.Stat(m.binary())
	if err != nil {
		return false
	}
	self, err := os.Executable()
	if err != nil {
		return false
	}
	running, err := os.Stat(self)
	return err == nil && os.SameFile(current, running)
}

func (m Manager) Stage(current string, body io.Reader) (*Job, error) {
	unlock, err := m.lock(false)
	if err != nil {
		return nil, err
	}
	defer unlock()
	previous, err := m.readJob()
	if err != nil {
		return nil, err
	}
	if previous != nil && previous.launching() {
		return nil, ErrBusy
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	version, err := verifySource(data, releaseKey)
	if err != nil {
		return nil, err
	}
	if olderVersion(version, current) {
		return nil, ErrOlder
	}
	job := &Job{Version: version, SHA256: sourceDigest(data), Status: "ready"}
	if err = atomicWrite(m.sourcePath(job), data); err != nil {
		return nil, err
	}
	if err = m.writeJob(job); err != nil {
		if previous == nil || previous.SHA256 != job.SHA256 {
			m.cleanSource(job)
		}
		return nil, err
	}
	if previous != nil && previous.SHA256 != job.SHA256 {
		m.cleanSource(previous)
	}
	return job, nil
}

func (m Manager) Start(sha256 string) (*Job, error) {
	unlock, err := m.lock(false)
	if err != nil {
		return nil, err
	}
	defer unlock()
	job, err := m.readJob()
	if err != nil {
		return nil, err
	}
	if job != nil && job.launching() {
		return nil, ErrBusy
	}
	if job == nil || job.Status != "ready" || job.SHA256 != sha256 {
		return nil, ErrStaged
	}
	job.Status = "starting"
	job.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err = m.writeJob(job); err != nil {
		return nil, err
	}
	if err = m.launch(job.StartedAt); err != nil {
		job.Status = "ready"
		job.StartedAt = ""
		return nil, errors.Join(err, m.writeJob(job))
	}
	return job, nil
}

func (m Manager) Status() (*Job, error) {
	job, err := m.readJob()
	if err != nil || job == nil || !job.interrupted() {
		return job, err
	}
	unlock, err := m.lock(false)
	if errors.Is(err, ErrBusy) {
		return job, nil
	}
	if err != nil {
		return nil, err
	}
	defer unlock()
	job, err = m.readJob()
	if err == nil && job != nil && job.interrupted() {
		job.Status = "failed"
		err = m.writeJob(job)
		m.cleanSource(job)
	}
	return job, err
}

func (j Job) launching() bool {
	started, err := time.Parse(time.RFC3339Nano, j.StartedAt)
	return j.Status == "starting" && err == nil && time.Since(started) < launchGrace
}

func (j Job) interrupted() bool {
	return j.Status == "running" || (j.Status == "starting" && !j.launching())
}

func (m Manager) root() string               { return filepath.Join(m.Home, "run", "web-upgrade") }
func (m Manager) jobPath() string            { return filepath.Join(m.root(), "job.json") }
func (m Manager) binary() string             { return filepath.Join(m.Home, "current", "rsm") }
func (m Manager) sourcePath(job *Job) string { return filepath.Join(m.root(), job.SHA256+".zip") }

func (m Manager) cleanSource(job *Job) {
	path := m.sourcePath(job)
	_ = os.Remove(path)
	_ = os.Remove(path + ".sha256")
}

func (m Manager) readJob() (*Job, error) {
	data, err := os.ReadFile(m.jobPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var job Job
	if err = json.Unmarshal(data, &job); err != nil || !digestPattern.MatchString(job.SHA256) {
		return nil, errors.New("无法读取升级任务状态")
	}
	return &job, nil
}

func (m Manager) writeJob(job *Job) error {
	data, err := json.Marshal(job)
	if err != nil {
		return err
	}
	return atomicWrite(m.jobPath(), data)
}

func (m Manager) lock(wait bool) (func(), error) {
	if err := os.MkdirAll(m.root(), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(m.root(), "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	mode := syscall.LOCK_EX
	if !wait {
		mode |= syscall.LOCK_NB
	}
	if err = syscall.Flock(int(file.Fd()), mode); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrBusy
		}
		return nil, err
	}
	return func() { _ = file.Close() }, nil
}

func atomicWrite(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	if err = errors.Join(err, file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
