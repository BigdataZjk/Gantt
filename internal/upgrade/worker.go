package upgrade

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Progress struct {
	Total  int      `json:"total"`
	Stages []string `json:"stages"`
}

var upgradeStages = []struct {
	key, label, legacyHeading string
}{
	{"source", "校验并解压源码包", ""},
	{"version", "检查升级版本", ""},
	{"toolchain", "准备构建工具链", ""},
	{"dependencies", "安装前端依赖", "安装前端依赖（"},
	{"interfaces", "校验接口类型", "校验接口类型（"},
	{"frontend", "构建前端页面", "构建前端（"},
	{"backend", "编译服务端程序", "编译 Go 程序（"},
	{"package", "生成发行包", "解析数据库迁移版本（"},
	{"verify", "校验发行包", ""},
	{"scripts", "安装管理脚本", ""},
	{"stop", "停止旧服务", ""},
	{"backup", "备份现有数据", ""},
	{"switch", "切换程序版本", ""},
	{"start", "启动新服务", ""},
	{"health", "检查服务健康状态", ""},
	{"finalize", "保存部署结果", ""},
}

func (job *Job) recordProgress(line string) bool {
	if len(line) >= 10 && strings.HasPrefix(line, "==> [") && line[5] >= '1' && line[5] <= '8' && line[6:10] == "/8] " {
		step := int(line[5] - '0')
		if step > job.Step {
			job.Step = step
			return true
		}
	}
	key, marker := strings.CutPrefix(line, "RSM_UPGRADE_STAGE ")
	if job.Progress == nil && (!marker || key != "source") {
		return false
	}
	for _, stage := range upgradeStages {
		// Older source bundles still print a heading at the start of each build stage.
		legacy := job.Progress != nil && stage.legacyHeading != "" && strings.HasPrefix(line, "==> "+stage.legacyHeading)
		if !(marker && key == stage.key) && !legacy {
			continue
		}
		if job.Progress == nil {
			job.Progress = &Progress{Total: len(upgradeStages)}
		}
		if slices.Contains(job.Progress.Stages, stage.label) {
			return false
		}
		job.Progress.Stages = append(job.Progress.Stages, stage.label)
		return true
	}
	return false
}

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
	cmd.Env = append(os.Environ(), "RSM_NO_SYSTEM_PACKAGES=1", "RSM_VERBOSE=0", "RSM_ADDR=", "RSM_DIE_CODE=1", "NO_COLOR=1", "RSM_WEB_UPGRADE_PROGRESS=1")
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err = cmd.Start(); err != nil {
		return err
	}
	reader := bufio.NewReader(output)
	longLine := false
	for {
		line, partial, readErr := reader.ReadLine()
		if readErr != nil {
			break
		}
		if !longLine && !partial && job.recordProgress(string(line)) {
			_ = m.writeJob(job)
		}
		longLine = partial
	}
	return cmd.Wait()
}
