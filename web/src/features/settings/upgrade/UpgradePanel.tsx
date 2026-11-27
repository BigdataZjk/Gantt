import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, FileUp, RefreshCw } from "lucide-react";
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

export function UpgradePanel() {
  const fileInput = useRef<HTMLInputElement>(null);
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
    refetchInterval: (query) => isActive(query.state.data?.job) || query.state.status === "error" ? 1500 : 5000,
  });
  const data = status.data;
  const job = data?.job;
  const active = isActive(job);
  const canUpload = data?.available && !action && !active && !status.isError;
  const target = confirmation?.job;
  const canConfirm = canUpload && job?.status === "ready" &&
    target?.sha256 === job.sha256 && confirmation?.currentVersion === data?.currentVersion;

  const submit = async (kind: "upload" | "start", perform: () => Promise<UpgradeState>) => {
    setAction(kind);
    setError("");
    await client.cancelQueries({ queryKey: UPGRADE_KEY });
    try {
      const next = await perform();
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
      <section className={`${styles.personalSettings} ${styles.maintenanceCard}`} aria-labelledby="upgrade-heading">
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

        {data && !data.available ? <p className={styles.caption}>网页升级需要通过 rsm.sh 启动已安装的实例。</p> : null}
        {error ? <p className={styles.uploadError} role="alert">{error}</p> : null}
        {status.isError ? (
          <p className={styles.caption} role="status">
            {status.error instanceof ApiError && [401, 403].includes(status.error.status)
              ? status.error.message
              : "正在重新连接服务，连接后会继续显示升级状态…"}
          </p>
        ) : null}
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
              {job.status === "succeeded" ? (
                <Button size="sm" onClick={() => location.reload()}><RefreshCw aria-hidden="true" />刷新页面</Button>
              ) : null}
            </div>
            {active ? (
              <>
                <progress className={styles.upgradeProgress} value={job.step} max={STEPS.length} aria-label="升级进度" />
                <p className={styles.caption} aria-live="polite">
                  {job.step ? `步骤 ${job.step}/${STEPS.length} · ${STEPS[job.step - 1]}` : "正在启动升级任务…"}
                </p>
              </>
            ) : null}
            {job.status === "failed" ? (
              <p className={styles.caption}>
                {job.step ? `${STEPS[job.step - 1]}阶段未完成。` : "升级任务启动失败。"}可查看服务器的部署日志。
              </p>
            ) : null}
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
