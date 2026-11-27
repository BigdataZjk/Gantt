package upgrade

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func (m Manager) launch(startedAt string) error {
	args := []string{"run-web-upgrade", "--home", m.Home, "--started-at", startedAt}
	if runtime.GOOS == "linux" && os.Getenv("SYSTEMD_EXEC_PID") == strconv.Itoa(os.Getpid()) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		unit := "rsm-web-upgrade-" + sourceDigest([]byte(m.Home + "\n" + startedAt))[:12]
		options := []string{"--collect", "--quiet", "--service-type=exec", "--unit=" + unit}
		if os.Geteuid() != 0 {
			options = append(options, "--user")
		}
		options = append(options, "--")
		for _, arg := range append([]string{m.binary()}, args...) {
			options = append(options, strings.ReplaceAll(arg, "$", "$$"))
		}
		if output, err := exec.CommandContext(ctx, "systemd-run", options...).CombinedOutput(); err != nil {
			return fmt.Errorf("启动独立升级服务: %w: %s", err, strings.TrimSpace(string(output)))
		}
		return nil
	}
	cmd := exec.Command(m.binary(), args...)
	cmd.Dir = m.Home
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func (m Manager) Run(startedAt string) (err error) {
	unlock, err := m.lock(true)
	if err != nil {
		return err
	}
	defer unlock()
	job, err := m.readJob()
	if err != nil {
		return err
	}
	if job == nil || job.Status != "starting" || job.StartedAt != startedAt {
		return ErrStaged
	}
	job.Status = "running"
	if err = m.writeJob(job); err != nil {
		return err
	}
	defer func() {
		job.Status = "failed"
		if err == nil {
			job.Status = "succeeded"
		}
		err = errors.Join(err, m.writeJob(job))
		m.cleanSource(job)
	}()

	path := m.sourcePath(job)
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	version, err := verifySource(data, releaseKey)
	if err != nil || version != job.Version || sourceDigest(data) != job.SHA256 {
		return ErrStaged
	}
	if err = atomicWrite(path+".sha256", []byte(job.SHA256+"\n")); err != nil {
		return err
	}

	cmd := exec.Command(filepath.Join(m.Home, "rsm.sh"), "upgrade", path, "--home", m.Home, "--force")
	cmd.Dir = m.Home
	cmd.Env = append(os.Environ(), "RSM_NO_SYSTEM_PACKAGES=1", "RSM_VERBOSE=0", "RSM_ADDR=", "RSM_DIE_CODE=1", "NO_COLOR=1")
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err = cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(output)
	for scanner.Scan() {
		line := scanner.Text()
		if len(line) >= 10 && strings.HasPrefix(line, "==> [") && line[5] >= '1' && line[5] <= '8' && line[6:10] == "/8] " {
			step := int(line[5] - '0')
			if step > job.Step {
				job.Step = step
				_ = m.writeJob(job)
			}
		}
	}
	// Drain any remaining output when a dependency emits a line larger than the scanner limit.
	if scanner.Err() != nil {
		_, _ = io.Copy(io.Discard, output)
	}
	return cmd.Wait()
}
