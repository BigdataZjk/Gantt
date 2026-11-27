import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, ChevronDown, CircleAlert, FileUp, LoaderCircle } from "lucide-react";
import { api, ApiError } from "../../../api/client";
import type { UpgradeJob, UpgradeState } from "../../../api/types";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import styles from "../Settings.module.css";

const UPGRADE_KEY = ["system-upgrade"] as const;
const STEPS = [
  "校验并解压源码包",
  "检查版本",
  "准备构建工具链",
  "构建前端和服务端",
  "校验构建产物",
  "准备管理脚本",
  "停止服务并备份数据",
  "切换程序并检查服务健康",
];

function isActive(job?: UpgradeJob) {
  return job?.status === "starting" || job?.status === "running";
}

function UpgradeProgress({ job, connectionStatus }: { job: UpgradeJob; connectionStatus: string }) {
  if (job.status === "ready") return null;
  const { stages, total } = job.progress ?? { stages: STEPS.slice(0, job.step), total: STEPS.length };
  const active = isActive(job);
  const failed = job.status === "failed";
  const succeeded = job.status === "succeeded";
  const completed = succeeded ? total : Math.max(0, stages.length - 1);
  const current = stages.at(-1);
  const countLabel = `已完成 ${completed}/${total} 步`;
  let stageLabel = current ? `正在${current}` : "正在启动升级任务…";
  if (connectionStatus) stageLabel = current ? `${connectionStatus} · 上次记录 ${current}` : connectionStatus;
  if (failed) stageLabel = current ? `「${current}」阶段未完成，可查看服务器部署日志` : "升级任务启动失败，可查看服务器部署日志";
  if (succeeded) stageLabel = "新版本已通过健康检查";

  return (
    <>
      <div
        className={styles.upgradeProgress}
        role="progressbar"
        aria-label="升级进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={countLabel}
      >
        <span aria-hidden="true" style={{ transform: `scaleX(${completed / total})` }} />
      </div>
      <div className={styles.upgradeStageLine} role="status">
        <span title={stageLabel}>{stageLabel}</span>
        <span className={styles.caption}>{countLabel}</span>
      </div>
      {job.progress ? (
        <details className={styles.upgradeDetails}>
          <summary><ChevronDown aria-hidden="true" />升级步骤</summary>
          <ol className={styles.upgradeStages} aria-label="升级步骤" role="list">
            {stages.map((stage, index) => {
              const done = index < completed;
              const Icon = done ? Check : failed ? CircleAlert : LoaderCircle;
              return (
                <li key={stage} data-stage-status={done ? "done" : failed ? "failed" : "running"} aria-current={active && !done ? "step" : undefined}>
                  <Icon aria-label={done ? "已完成" : failed ? "未完成" : "进行中"} role="img" />
                  {stage}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
    </>
  );
}

export function UpgradePanel() {
  const fileInput = useRef<HTMLInputElement>(null);
  const watchedJob = useRef<string | undefined>(undefined);
  const client = useQueryClient();
  const [action, setAction] = useState<"upload" | "start" | null>(null);
  const [confirmation, setConfirmation] = useState<UpgradeState | null>(null);
  const [error, setError] = useState("");
  const status = useQuery({
    queryKey: UPGRADE_KEY,
    queryFn: ({ signal }) => api.upgradeStatus(signal),
    enabled: !action,
    retry: false,
    gcTime: 0,
    refetchInterval: (query) => isActive(query.state.data?.job) || query.state.status === "error" ? 1000 : 5000,
  });
  const data = status.data;
  const job = data?.job;
  const active = isActive(job);
  const startedAt = job?.startedAt;
  const canReload = status.isSuccess && data?.available && job?.status === "succeeded" && data.currentVersion === job.version;
  const connectionStatus = status.isError
    ? status.error instanceof ApiError && [401, 403].includes(status.error.status)
      ? status.error.message
      : "正在重新连接服务…"
    : "";
  const canUpload = data?.available && !action && !active && !status.isError;
  const target = confirmation?.job;
  const canConfirm = canUpload && job?.status === "ready" &&
    target?.sha256 === job.sha256 && confirmation?.currentVersion === data?.currentVersion;

  useEffect(() => {
    if (active) watchedJob.current = startedAt;
    if (!canReload || !startedAt || watchedJob.current !== startedAt) return;

    const timer = window.setTimeout(() => {
      watchedJob.current = undefined;
      window.location.reload();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [active, canReload, startedAt]);

  const submit = async (kind: "upload" | "start", perform: () => Promise<UpgradeState>) => {
    setAction(kind);
    setError("");
    await client.cancelQueries({ queryKey: UPGRADE_KEY });
    try {
      const next = await perform();
      if (kind === "start") watchedJob.current = next.job?.startedAt;
      client.setQueryData(UPGRADE_KEY, next);
      if (kind === "upload") setConfirmation(next);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "连接中断，请稍候核对升级状态");
    } finally {
      setAction(null);
    }
  };

  const upload = (file?: File) => {
    if (!file || !canUpload) return;
    if (!file.name.toLowerCase().endsWith(".zip") || !file.size) {
      setError("请选择发布的源码 ZIP 文件");
      return;
    }
    if (file.size > data.maxSourceBytes) {
      setError(`源码 ZIP 大小超过 ${data.maxSourceBytes / 1024 ** 2} MiB`);
      return;
    }
    void submit("upload", () => api.uploadUpgradeSource(file));
  };

  const start = () => {
    if (!canConfirm || !target) return;
    setConfirmation(null);
    void submit("start", () => api.applyUpgrade(target.sha256));
  };

  return (
    <>
      <section className={styles.maintenanceCard} aria-labelledby="upgrade-heading">
        <div className={styles.maintenanceCardHeader}>
          <div className={styles.maintenanceCardHeading}>
            <h2 id="upgrade-heading" className={styles.sectionTitle}>上传源码并更新</h2>
            <p className={styles.caption}>{data ? `当前版本 v${data.currentVersion}` : "正在读取当前版本…"}</p>
          </div>
          <input
            ref={fileInput}
            hidden
            type="file"
            accept=".zip,application/zip"
            aria-label="源码 ZIP 文件"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              upload(file);
            }}
          />
          <Button variant="primary" disabled={!canUpload} onClick={() => fileInput.current?.click()}>
            <FileUp aria-hidden="true" />{action === "upload" ? "正在上传并校验…" : "选择源码 ZIP"}
          </Button>
        </div>

        {data && !data.available && !active ? <p className={styles.caption}>网页升级需要通过 rsm.sh 启动已安装的实例。</p> : null}
        {error ? <p className={styles.uploadError} role="alert">{error}</p> : null}
        {connectionStatus && !active ? <p className={styles.caption} role="status">{connectionStatus}</p> : null}
        {job ? (
          <div className={styles.upgradeStatus} data-status={job.status}>
            <div className={styles.upgradeStatusLine}>
              <h3 role="status">
                {job.status === "ready" ? <><CheckCircle2 aria-hidden="true" />源码包校验通过 · v{job.version}</> : null}
                {active ? <>正在更新至 v{job.version}</> : null}
                {job.status === "succeeded" ? <><CheckCircle2 aria-hidden="true" />已完成更新 · v{job.version}</> : null}
                {job.status === "failed" ? <><CircleAlert aria-hidden="true" />更新未完成 · v{job.version}</> : null}
              </h3>
              {job.status === "ready" ? (
                <Button size="sm" disabled={!canUpload} onClick={() => setConfirmation(data ?? null)}>
                  {action === "start" ? "正在启动…" : "核对并安装"}
                </Button>
              ) : null}
            </div>
            <UpgradeProgress key={startedAt} job={job} connectionStatus={active ? connectionStatus : ""} />
          </div>
        ) : null}
      </section>

      <Dialog
        open={Boolean(target)}
        onOpenChange={(open) => { if (!open) setConfirmation(null); }}
        title={confirmation?.currentVersion === target?.version ? "确认同版本覆盖更新" : "确认系统升级"}
        footer={<><Button onClick={() => setConfirmation(null)}>取消</Button><Button variant="primary" disabled={!canConfirm} onClick={start}>开始更新</Button></>}
      >
        <div className={styles.upgradeDialogText}>
          <p>当前 <strong>v{confirmation?.currentVersion}</strong> → 安装 <strong>v{target?.version}</strong></p>
          <p>构建完成后会短暂停止服务、备份数据并切换。若新版启动检查失败，将尝试切回上一版。</p>
          {!canConfirm ? <p role="alert">升级状态已变化，请关闭后重新核对。</p> : null}
        </div>
      </Dialog>
    </>
  );
}
