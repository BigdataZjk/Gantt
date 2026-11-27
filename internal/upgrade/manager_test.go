package upgrade

import (
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestUpgradeSerializesJobsAndRecoversInterruptedStatus(t *testing.T) {
	manager := Manager{Home: t.TempDir()}
	unlock, err := manager.lock(false)
	if err != nil {
		t.Fatal(err)
	}
	job := &Job{Status: "running", Version: "0.1.9", SHA256: strings.Repeat("a", 64), Step: 4}
	job.recordProgress("RSM_UPGRADE_STAGE source")
	job.recordProgress("RSM_UPGRADE_STAGE frontend")
	if err = manager.writeJob(job); err == nil {
		err = atomicWrite(manager.sourcePath(job), []byte("staged source"))
	}
	if err != nil {
		unlock()
		t.Fatal(err)
	}
	if _, err = manager.Stage("0.1.8", strings.NewReader("")); !errors.Is(err, ErrBusy) {
		t.Error("upload was not blocked by the running worker", err)
	}
	if _, err = manager.Start(job.SHA256); !errors.Is(err, ErrBusy) {
		t.Error("second start was not blocked by the running worker", err)
	}
	if got, err := manager.Status(); err != nil || got == nil || got.Status != "running" || got.Step != job.Step {
		t.Error("running worker status was not preserved", got, err)
	}
	unlock()
	got, err := manager.Status()
	if err != nil || got == nil || got.Status != "failed" || got.Step != job.Step ||
		got.Progress == nil || !slices.Equal(got.Progress.Stages, job.Progress.Stages) {
		t.Fatal("interrupted worker status was not recovered", got, err)
	}
	if _, err = os.Stat(manager.sourcePath(job)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("interrupted upload was not removed", err)
	}
}

func TestUpgradeRecordsDetailedStagesAndLegacySteps(t *testing.T) {
	var job Job
	if !job.recordProgress("==> [4/8] 生成接口类型并构建发行包") || job.Step != 4 || job.Progress != nil {
		t.Fatal("legacy step should work without phase events", job)
	}
	if job.recordProgress("RSM_UPGRADE_STAGE frontend") {
		t.Fatal("nested build phases should not start a detailed plan on an older installer")
	}
	job = Job{}
	for _, line := range []string{
		"RSM_UPGRADE_STAGE source",
		"==> [1/8] 校验并解压源码包（保持当前服务运行）",
		"==> 构建前端（pnpm build → web/dist）",
		"RSM_UPGRADE_STAGE frontend",
		"RSM_UPGRADE_STAGE backend",
		"RSM_UPGRADE_STAGE unknown",
		"RSM_UPGRADE_STAGE health",
		"RSM_UPGRADE_STAGE finalize",
	} {
		job.recordProgress(line)
	}
	want := []string{"校验并解压源码包", "构建前端页面", "编译服务端程序", "检查服务健康状态", "保存部署结果"}
	if job.Step != 1 || job.Progress == nil || job.Progress.Total != len(upgradeStages) || !slices.Equal(job.Progress.Stages, want) {
		t.Fatalf("unexpected progress after fast and repeated stage events: %#v", job.Progress)
	}
}

func TestUpgradeBindsConfirmationAndLauncherToTheStagedJob(t *testing.T) {
	manager := Manager{Home: t.TempDir()}
	unlock, err := manager.lock(false)
	if err != nil {
		t.Fatal(err)
	}
	job := &Job{Status: "ready", Version: "0.1.9", SHA256: strings.Repeat("b", 64)}
	err = manager.writeJob(job)
	unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Start(strings.Repeat("a", 64)); !errors.Is(err, ErrStaged) {
		t.Fatal("a confirmation for a replaced ZIP was accepted", err)
	}
	if _, err = manager.Start(job.SHA256); err == nil {
		t.Fatal("launcher unexpectedly started without an installed RSM binary")
	}
	if got, err := manager.Status(); err != nil || got == nil || got.Status != "ready" || got.StartedAt != "" {
		t.Fatal("the validated package is not retryable after a launch error", got, err)
	}
	job.Status = "starting"
	job.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err = manager.writeJob(job); err != nil {
		t.Fatal(err)
	}
	if err = manager.Run("previous-worker"); !errors.Is(err, ErrStaged) {
		t.Fatal("an obsolete launcher could claim a newer job", err)
	}
}
