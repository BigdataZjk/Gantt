import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import type { State } from "../../../api/types";
import { useUiState } from "../../../app/uiState";
import { timeLabel } from "../../../lib/dates";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { useNotice } from "../../../ui/Notice";
import type { RequestPermissions } from "../../requests/types";
import styles from "../Settings.module.css";
import { LogManagementDialog } from "./LogManagementDialog";

export function LogsPanel({ state, permissions }: { state: State; permissions: RequestPermissions }) {
  const { ui, patch } = useUiState();
  const runner = useMutationRunner();
  const notice = useNotice();
  const [pageSizeText, setPageSizeText] = useState(String(ui.logPagination.pageSize));
  const [undoTarget, setUndoTarget] = useState<number | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);

  useEffect(() => {
    setPageSizeText(String(ui.logPagination.pageSize));
  }, [ui.logPagination.pageSize]);

  const pageSize = ui.logPagination.pageSize;
  const pages = Math.max(1, Math.ceil(state.logs.length / pageSize));
  const page = Math.max(1, Math.min(pages, ui.logPagination.page));
  const start = (page - 1) * pageSize;
  const entries = state.logs.slice(start, start + pageSize);
  const visibleEnd = Math.min(start + pageSize, state.logs.length);

  const setPage = (next: number) => patch({ logPagination: { ...ui.logPagination, page: Math.max(1, Math.min(pages, next)) } });

  const commitPageSize = () => {
    const value = Number(pageSizeText);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      setPageSizeText(String(pageSize));
      notice.error("请输入 1–200 之间的整数");
      return;
    }
    patch({ logPagination: { page: 1, pageSize: value } });
  };

  const undo = async () => {
    if (undoTarget === null) return;
    const result = await runner((baseRevision) => api.undoLog(baseRevision, undoTarget));
    if (result) {
      notice.notify("已撤回到所选操作之前");
      setUndoTarget(null);
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 500 }}>操作记录</h2>
          <p className={styles.caption}>全系统共用 · 最多保留 200 条{state.logPolicy?.operationRetentionDays ? `，自动清理 ${state.logPolicy.operationRetentionDays} 天前记录` : ""} · 最近 50 条内的数据变更可撤回。账号、密码和权限不撤回。</p>
        </div>
        {permissions.isAdmin ? <Button onClick={() => setManagementOpen(true)}><Settings2 aria-hidden="true" />日志管理</Button> : null}
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="操作记录">
          <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>状态</th><th>撤回</th></tr></thead>
          <tbody>
            {entries.length ? entries.map((entry) => {
              const canUndo = permissions.isAdmin && entry.reversible && !entry.undone;
              return (
                <tr key={entry.id}>
                  <td>{timeLabel(entry.createdAt)}</td>
                  <td>{entry.actor}</td>
                  <td className={entry.undone ? styles.undoneTag : ""}>{entry.action}</td>
                  <td className={styles.logStatus}>{entry.undone ? "已撤回" : entry.reversible ? "可撤回" : "不可撤回"}</td>
                  <td>
                    <Button size="sm" variant="quiet" disabled={!canUndo} onClick={() => setUndoTarget(entry.id)}>撤回到此动作</Button>
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={5} className={styles.empty}>暂无正式操作记录</td></tr>}
          </tbody>
        </table>
      </div>
      <nav className={styles.pagination} aria-label="操作记录分页">
        <span className={styles.caption}>共 {state.logs.length} 条{state.logs.length ? ` · ${start + 1}–${visibleEnd}` : ""}</span>
        <div className={styles.pageControls}>
          <label className={styles.pageSize}>
            <span>每页</span>
            <input
              type="number"
              min={1}
              max={200}
              step={1}
              value={pageSizeText}
              aria-label="操作记录每页行数"
              onChange={(event) => setPageSizeText(event.target.value)}
              onBlur={commitPageSize}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitPageSize(); } }}
            />
            <span>条</span>
          </label>
          <div className={styles.pageNav}>
            <Button size="sm" variant="quiet" disabled={page <= 1} aria-label="上一页操作记录" onClick={() => setPage(page - 1)}><ChevronLeft aria-hidden="true" /></Button>
            <span className={styles.pageNumber} aria-label={`第 ${page} 页，共 ${pages} 页`}>{page} / {pages}</span>
            <Button size="sm" variant="quiet" disabled={page >= pages} aria-label="下一页操作记录" onClick={() => setPage(page + 1)}><ChevronRight aria-hidden="true" /></Button>
          </div>
        </div>
      </nav>

      <Dialog
        open={undoTarget !== null}
        onOpenChange={(open) => { if (!open) setUndoTarget(null); }}
        title="撤回到此动作"
        footer={<><Button onClick={() => setUndoTarget(null)}>取消</Button><Button variant="primary" onClick={() => void undo()}>确认撤回</Button></>}
      >
        <p style={{ color: "var(--rsm-muted)" }}>将撤回该动作及其之后的数据变更。账号、密码和权限保持当前设置；撤回后会新增一条撤回日志。</p>
      </Dialog>
      {permissions.isAdmin && managementOpen ? <LogManagementDialog state={state} onClose={() => setManagementOpen(false)} /> : null}
    </>
  );
}
