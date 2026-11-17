import { useEffect, useRef, useState } from "react";
import { Archive, Clock3, FileText, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError } from "../../../api/client";
import { useMutationRunner, useRefreshState } from "../../../api/hooks";
import type { LogCleanupPreview, LogCleanupRun, LogManagement, LogPolicy, State } from "../../../api/types";
import { timeLabel } from "../../../lib/dates";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { useNotice } from "../../../ui/Notice";
import styles from "./LogManagementDialog.module.css";

const EMPTY_POLICY: LogPolicy = { operationRetentionDays: 0, archiveRetentionDays: 0 };

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validDays(text: string) {
  const number = Number(text);
  return text.trim() !== "" && Number.isInteger(number) && number >= 1 && number <= 3650;
}

function runLabel(run?: LogCleanupRun) {
  if (!run) return "尚未执行";
  return `${timeLabel(run.checkedAt)} · ${run.operationsDeleted} 条记录 / ${run.archivesDeleted} 个文件`;
}

export function LogManagementDialog({ state, onClose }: { state: State; onClose: () => void }) {
  const runner = useMutationRunner();
  const refreshState = useRefreshState();
  const notice = useNotice();
  const [details, setDetails] = useState<LogManagement | null>(null);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, setPending] = useState<"" | "policy" | "preview" | "cleanup">("");
  const [operationEnabled, setOperationEnabled] = useState(!!state.logPolicy?.operationRetentionDays);
  const [archiveEnabled, setArchiveEnabled] = useState(!!state.logPolicy?.archiveRetentionDays);
  const [operationDays, setOperationDays] = useState(String(state.logPolicy?.operationRetentionDays || 90));
  const [archiveDays, setArchiveDays] = useState(String(state.logPolicy?.archiveRetentionDays || 30));
  const [scope, setScope] = useState<LogCleanupPreview["scope"]>("operations");
  const [days, setDays] = useState("30");
  const [preview, setPreview] = useState<LogCleanupPreview | null>(null);
  const [actionError, setActionError] = useState("");
  const dirty = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    void api.logManagement().then((next) => {
      if (cancelled) return;
      setDetails(next);
      if (!dirty.current) {
        setOperationEnabled(next.policy.operationRetentionDays > 0);
        setArchiveEnabled(next.policy.archiveRetentionDays > 0);
        setOperationDays(String(next.policy.operationRetentionDays || 90));
        setArchiveDays(String(next.policy.archiveRetentionDays || 30));
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setLoadError(reason instanceof ApiError ? reason.message : "无法读取日志信息，请重试。");
    });
    return () => { cancelled = true; };
  }, [state.revision, refreshKey]);

  useEffect(() => {
    setPreview((current) => current && current.revision !== state.revision ? null : current);
  }, [state.revision]);

  const busy = pending !== "";
  const policy: LogPolicy = { operationRetentionDays: operationEnabled ? Number(operationDays) : 0, archiveRetentionDays: archiveEnabled ? Number(archiveDays) : 0 };
  const savedPolicy = details?.policy ?? state.logPolicy ?? EMPTY_POLICY;
  const policyValid = (!operationEnabled || validDays(operationDays)) && (!archiveEnabled || validDays(archiveDays));
  const policyChanged = policy.operationRetentionDays !== savedPolicy.operationRetentionDays || policy.archiveRetentionDays !== savedPolicy.archiveRetentionDays;

  const savePolicy = async () => {
    if (busy || !policyValid || !policyChanged || !details || loadError) return;
    setPending("policy");
    const result = await runner((base) => api.saveLogPolicy(base, policy));
    if (mounted.current) {
      if (result) {
        dirty.current = false;
        setDetails((current) => current ? { ...current, policy, lastAutomatic: undefined } : current);
        setPreview(null);
        notice.notify("日志保留策略已保存");
      }
      setPending("");
    }
  };

  const showPreview = async () => {
    if (busy || !validDays(days)) return;
    setPending("preview");
    setActionError("");
    setPreview(null);
    try {
      const next = await api.previewLogCleanup(scope, Number(days));
      if (!mounted.current) return;
      setPreview(next);
      if (next.revision !== state.revision) void refreshState();
    } catch (reason) {
      if (mounted.current) setActionError(reason instanceof ApiError ? reason.message : "无法预览日志，请检查网络后重试。");
    } finally {
      if (mounted.current) setPending("");
    }
  };

  const cleanup = async () => {
    if (busy || !preview?.count || preview.revision !== state.revision) return;
    setPending("cleanup");
    setActionError("");
    let summary: LogCleanupRun | undefined;
    const result = await runner(async (base) => {
      const next = await api.cleanupLogs(base, preview);
      summary = next.cleanup;
      return next.state;
    });
    if (mounted.current) {
      if (result && summary) {
        setPreview(null);
        setRefreshKey((key) => key + 1);
        if (summary.error) setActionError(summary.error);
        else notice.notify(`已清理 ${scope === "operations" ? `${summary.operationsDeleted} 条操作记录` : `${summary.archivesDeleted} 个归档文件`}`, "success");
      } else {
        setPreview(null);
        setActionError("清理未完成，请重新预览后重试。");
        setRefreshKey((key) => key + 1);
      }
      setPending("");
    }
  };

  const editDays = (text: string) => { setDays(text); setPreview(null); setActionError(""); };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="日志管理" caption="管理员设置 · 清理策略全系统共用" width={640} footer={<Button disabled={busy} onClick={onClose}>完成</Button>}>
      <div className={styles.content} aria-busy={busy}>
        <div className={styles.metrics}>
          <div><FileText aria-hidden="true" /><span>操作记录</span><strong>{details ? `${details.operationCount} 条` : "—"}</strong><small>{details ? `约 ${bytesLabel(details.operationBytes)}` : "读取中"}</small></div>
          <div><Archive aria-hidden="true" /><span>归档日志</span><strong>{details ? `${details.archiveCount} 个` : "—"}</strong><small>{details ? bytesLabel(details.archiveBytes) : "读取中"}</small></div>
          <div><Clock3 aria-hidden="true" /><span>当前文件 · 保留</span><strong>{details ? `${details.activeFileCount} 个` : "—"}</strong><small>{details ? bytesLabel(details.activeFileBytes) : "读取中"}</small></div>
        </div>
        {loadError ? <div className={styles.error} role="alert">{loadError}<Button size="sm" onClick={() => setRefreshKey((key) => key + 1)}><RefreshCw aria-hidden="true" />重试</Button></div> : null}

        <section className={styles.section} aria-labelledby="log-auto-title">
          <div className={styles.heading}><h4 id="log-auto-title">自动清理</h4><Button size="sm" variant="primary" disabled={busy || !details || !!loadError || !policyValid || !policyChanged} onClick={() => void savePolicy()}>{pending === "policy" ? "保存中…" : "保存策略"}</Button></div>
          <div className={styles.policyRow}>
            <div><span>操作记录</span><small>保留最近 200 条，可额外按天清理</small></div>
            <div className={styles.controls}>
              <input aria-label="操作记录自动清理天数" type="number" min={1} max={3650} step={1} value={operationDays} disabled={busy || !operationEnabled} onChange={(event) => { dirty.current = true; setOperationDays(event.target.value); }} />
              <span>天前</span>
              <button className={styles.switch} type="button" role="switch" aria-label="按天自动清理操作记录" aria-checked={operationEnabled} disabled={busy} onClick={() => { dirty.current = true; setOperationEnabled(!operationEnabled); }}><span /></button>
            </div>
          </div>
          <div className={styles.policyRow}>
            <div><span>归档文件日志</span><small>按归档文件最后写入时间判断</small></div>
            <div className={styles.controls}>
              <input aria-label="归档文件自动清理天数" type="number" min={1} max={3650} step={1} value={archiveDays} disabled={busy || !archiveEnabled} onChange={(event) => { dirty.current = true; setArchiveDays(event.target.value); }} />
              <span>天前</span>
              <button className={styles.switch} type="button" role="switch" aria-label="按天自动清理归档文件" aria-checked={archiveEnabled} disabled={busy} onClick={() => { dirty.current = true; setArchiveEnabled(!archiveEnabled); }}><span /></button>
            </div>
          </div>
          <p className={styles.hint}>{policyValid ? "每小时检查，保存后 1 分钟内首次执行。按天清理默认关闭；开启后会移除对应的撤回记录。" : "保留天数须为 1–3650 之间的整数。"}</p>
        </section>

        <section className={styles.section} aria-labelledby="log-manual-title">
          <div className={styles.heading}><h4 id="log-manual-title">手动清理</h4><span className={styles.muted}>先预览，再确认</span></div>
          <div className={styles.scope} role="group" aria-label="清理范围">
            <Button size="sm" aria-pressed={scope === "operations"} disabled={busy} onClick={() => { setScope("operations"); setPreview(null); setActionError(""); }}>操作记录</Button>
            <Button size="sm" aria-pressed={scope === "archives"} disabled={busy} onClick={() => { setScope("archives"); setPreview(null); setActionError(""); }}>归档文件日志</Button>
          </div>
          <div className={styles.manualRow}>
            <label className={styles.controls}><span>清理</span><input aria-label="手动清理天数" type="number" min={1} max={3650} step={1} value={days} disabled={busy} onChange={(event) => editDays(event.target.value)} /><span>天前</span></label>
            <div className={styles.presets}>{[7, 30, 90].map((value) => <Button key={value} size="sm" variant="quiet" aria-pressed={days === String(value)} disabled={busy} onClick={() => editDays(String(value))}>{value} 天</Button>)}</div>
            <Button size="sm" disabled={busy || !validDays(days)} onClick={() => void showPreview()}>{pending === "preview" ? "读取中…" : "预览清理"}</Button>
          </div>
          {!validDays(days) ? <p className={styles.error} role="alert">清理天数须为 1–3650 之间的整数。</p> : null}
          {preview ? <div className={preview.count ? styles.preview : styles.noResults} role="status">
            <p>北京时间 <strong>{timeLabel(preview.before)}</strong> 之前</p>
            <div className={styles.previewAction}><span>{preview.count ? <>将清理 <strong>{preview.count} {preview.scope === "operations" ? "条操作记录" : "个归档文件"}</strong> · 约 {bytesLabel(preview.bytes)}</> : "没有符合条件的日志，无需清理。"}</span>{preview.count ? <Button size="sm" variant="danger" disabled={busy || preview.revision !== state.revision} onClick={() => void cleanup()}><Trash2 aria-hidden="true" />{pending === "cleanup" ? "清理中…" : "确认清理"}</Button> : null}</div>
            {preview.count ? <p>{preview.scope === "operations" ? `含 ${preview.reversibleCount} 条当前可撤回记录，清理后无法再通过这些记录撤回。` : "仅删除已轮转的归档文件，当前日志继续写入。"} 清理不可恢复。</p> : null}
          </div> : null}
          {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
          <p className={styles.hint}>以北京时间 N 天前的零点为界，不含边界当天。文件清理仅处理系统的 .1 归档；当前文件在启动或部署时按大小轮转。</p>
        </section>

        <div className={styles.runs}>
          <div><span>最近自动检查</span><p>{runLabel(details?.lastAutomatic)}</p>{details?.lastAutomatic?.error ? <p className={styles.error}>{details.lastAutomatic.error}</p> : null}</div>
          <div><span>最近手动清理</span><p>{runLabel(details?.lastManual)}</p>{details?.lastManual?.error ? <p className={styles.error}>{details.lastManual.error}</p> : null}</div>
        </div>
        <p className={styles.hint}>清理保留需求、账号及版本快照。操作记录删除后的空间由数据库复用。</p>
      </div>
    </Dialog>
  );
}
