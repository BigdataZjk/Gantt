import { useState } from "react";
import { Save } from "lucide-react";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import type { State, Version } from "../../../api/types";
import { timeLabel } from "../../../lib/dates";
import { Button } from "../../../ui/Button";
import { Dialog } from "../../../ui/Dialog";
import { useNotice } from "../../../ui/Notice";
import type { RequestPermissions } from "../../requests/types";
import styles from "../Settings.module.css";

type ConfirmState = { kind: "restore" | "delete"; version: Version } | null;

export function VersionsPanel({ state, permissions }: { state: State; permissions: RequestPermissions }) {
  const runner = useMutationRunner();
  const notice = useNotice();
  const [details, setDetails] = useState<Version | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  const saveVersion = async () => {
    let label = "";
    for (let index = 0; index < 40; index += 1) {
      const candidate = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
      if (!state.versions.some((version) => version.label === candidate)) {
        label = candidate;
        break;
      }
    }
    if (!label) label = String(Date.now()).slice(-4);
    const result = await runner((baseRevision) => api.saveVersion(baseRevision, label));
    if (result) notice.notify(`已保存版本 ${label}`);
  };

  const act = async (kind: "restore" | "delete", version: Version) => {
    const result = await runner((baseRevision) => (kind === "restore" ? api.restoreVersion(baseRevision, version.id) : api.deleteVersion(baseRevision, version.id)));
    if (result) {
      notice.notify(kind === "restore" ? "版本已恢复" : "版本已删除");
      setConfirm(null);
    }
  };

  return (
    <>
      <div className={styles.toolbar}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 500 }}>版本记录</h2>
          <p className={styles.caption}>全系统共用 · {state.versions.length} 个版本 · 仅手动保存，快照包含需求、项目与人员资料；账号密码与权限不参与回滚。</p>
        </div>
        <Button variant="primary" disabled={!permissions.canEdit} onClick={() => void saveVersion()}>
          <Save aria-hidden="true" />
          保存当前版本
        </Button>
      </div>
      <div className={`${styles.tableWrap} ${styles.tableFill}`}>
        <table className={styles.table} aria-label="版本记录">
          <thead><tr><th>版本号</th><th>保存时间</th><th>保存人</th><th>操作</th></tr></thead>
          <tbody>
            {state.versions.length ? state.versions.map((version) => (
              <tr key={version.id}>
                <td className={styles.versionNumber}>{version.label}</td>
                <td>{timeLabel(version.createdAt)}</td>
                <td>{version.actor}</td>
                <td>
                  <div className={styles.actions}>
                    <Button size="sm" variant="quiet" onClick={() => setDetails(version)}>查看</Button>
                    <Button size="sm" variant="quiet" disabled={!permissions.isAdmin} onClick={() => setConfirm({ kind: "restore", version })}>恢复</Button>
                    <Button size="sm" variant="quiet" className={styles.dangerText} disabled={!permissions.isAdmin} onClick={() => setConfirm({ kind: "delete", version })}>删除</Button>
                  </div>
                </td>
              </tr>
            )) : <tr><td colSpan={4} className={styles.empty}>暂无保存的版本</td></tr>}
          </tbody>
        </table>
      </div>

      <Dialog
        open={Boolean(details)}
        onOpenChange={(open) => { if (!open) setDetails(null); }}
        title={details ? `版本 ${details.label}` : "版本"}
        caption={details ? `${details.actor} · ${timeLabel(details.createdAt)}` : undefined}
        footer={<Button onClick={() => setDetails(null)}>关闭</Button>}
      >
        <p style={{ color: "var(--rsm-muted)" }}>该版本保存于修订号 {details?.revision}。恢复后账号、密码和权限保持当前设置；个人显示偏好不参与公共需求回滚。</p>
      </Dialog>

      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title={confirm ? `${confirm.kind === "restore" ? "恢复" : "删除"}版本 ${confirm.version.label}` : "版本"}
        footer={<><Button onClick={() => setConfirm(null)}>取消</Button><Button variant={confirm?.kind === "delete" ? "danger" : "primary"} onClick={() => confirm && void act(confirm.kind, confirm.version)}>{confirm?.kind === "delete" ? "确认删除" : "确认恢复"}</Button></>}
      >
        <p style={{ color: "var(--rsm-muted)" }}>{confirm?.kind === "restore" ? "将恢复该版本的需求与关联业务字段，账号、密码和权限保持当前设置。" : "将删除这个手动保存的版本，操作记录保留。"}</p>
      </Dialog>
    </>
  );
}
