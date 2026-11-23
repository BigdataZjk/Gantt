import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import type { State } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { suggestDomainColor, isValidHex } from "../../../lib/color";
import { Button } from "../../../ui/Button";
import { Checkbox } from "../../../ui/Checkbox";
import { Dialog } from "../../../ui/Dialog";
import { ColorPicker } from "../../../ui/ColorPicker";
import { useNotice } from "../../../ui/Notice";
import { DomainTag } from "../../../ui/Tag";
import { DomainColorDialog } from "../DomainColorDialog";
import styles from "../Settings.module.css";

type FieldKey = "domain" | "project" | "requester";

export function FieldPanel({ state }: { state: State }) {
  const runner = useMutationRunner();
  const notice = useNotice();
  const { domainColor } = usePreferences();
  const [tab, setTab] = useState<FieldKey>("domain");
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [mergeError, setMergeError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");
  const [addError, setAddError] = useState("");
  const [colorDomain, setColorDomain] = useState<string | null>(null);
  const [deleteDomain, setDeleteDomain] = useState<string | null>(null);

  const allRequests = state.requests;
  const domainRows = useMemo(
    () =>
      state.domains.map((domain) => {
        const rows = allRequests.filter((row) => row.domain === domain.name);
        return { domain, pool: rows.filter((row) => !row.archived).length, archive: rows.filter((row) => row.archived).length, total: rows.length };
      }),
    [state.domains, allRequests],
  );

  const values = useMemo(() => {
    if (tab === "domain") return [] as string[];
    return [...new Set(allRequests.map((row) => row[tab]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [tab, allRequests]);

  const counts = (value: string) => {
    const rows = allRequests.filter((row) => row[tab as "project" | "requester"] === value);
    return { pool: rows.filter((row) => !row.archived).length, archive: rows.filter((row) => row.archived).length };
  };

  const switchTab = (next: FieldKey) => {
    setTab(next);
    setSelected([]);
  };

  const addDomain = async () => {
    const name = newName.trim();
    if (!name) {
      setAddError("请填写业务域名称");
      return;
    }
    if (state.domains.some((domain) => domain.name === name)) {
      setAddError("这个业务域已存在");
      return;
    }
    if (!isValidHex(newColor)) {
      setAddError("请选择有效颜色");
      return;
    }
    const result = await runner((baseRevision) => api.createDomain(baseRevision, name, newColor));
    if (result) {
      notice.notify("业务域已新增");
      setAddOpen(false);
      setNewName("");
    }
  };

  const mergeField = async () => {
    if (tab === "domain") return;
    const target = mergeTarget.trim();
    if (!target) {
      setMergeError("请填写合并后的名称");
      return;
    }
    if (!selected.length) {
      setMergeError("请选择要合并的名称");
      return;
    }
    const field = tab;
    const chosen = [...selected];
    const result = await runner((baseRevision) => api.mergeField(baseRevision, field, chosen, target));
    if (result) {
      notice.notify(`已更新为“${target}”`);
      setMergeOpen(false);
      setSelected([]);
    }
  };

  const tabItems: { key: FieldKey; label: string }[] = [
    { key: "domain", label: "业务域" },
    { key: "project", label: "项目" },
    { key: "requester", label: "提需人" },
  ];

  const allSelected = values.length > 0 && selected.length === values.length;

  return (
    <>
      <div className={styles.toolbar}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 500 }}>字段管理</h2>
          <p className={styles.caption}>仅超级管理员可见。正式更新记入操作记录，支持撤回和版本恢复。</p>
        </div>
      </div>
      <div className={styles.inline} style={{ marginBottom: 14 }}>
        {tabItems.map((item) => (
          <Button key={item.key} size="sm" aria-pressed={tab === item.key} style={tab === item.key ? { borderColor: "var(--rsm-accent)", background: "var(--rsm-soft)", color: "var(--rsm-accent)" } : undefined} onClick={() => switchTab(item.key)}>
            {item.label}
          </Button>
        ))}
      </div>

      {tab === "domain" ? (
        <>
          <div className={styles.toolbar} style={{ marginBottom: 10 }}>
            <span className={styles.caption}>全局默认色；个人自定义配色优先。仍有需求引用的业务域不能删除。</span>
            <Button size="sm" variant="primary" onClick={() => { setNewColor(suggestDomainColor(state.domains.map((domain) => domain.color))); setAddOpen(true); setAddError(""); setNewName(""); }}>
              <Plus aria-hidden="true" />新增业务域
            </Button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="业务域枚举">
              <thead><tr><th>业务域</th><th>默认颜色</th><th>需求池</th><th>归档</th><th>操作</th></tr></thead>
              <tbody>
                {domainRows.length ? domainRows.map(({ domain, pool, archive, total }) => (
                  <tr key={domain.id}>
                    <td><DomainTag name={domain.name} color={domainColor(domain.name, state.domains)} /></td>
                    <td><button type="button" className={styles.swatch} style={{ background: domainColor(domain.name, state.domains) }} aria-label={`双击修改${domain.name}全局默认颜色`} data-tooltip="双击修改全局默认色" onDoubleClick={() => setColorDomain(domain.name)} /></td>
                    <td>{pool}</td>
                    <td>{archive}</td>
                    <td><Button size="sm" variant="quiet" className={styles.dangerText} disabled={total > 0} data-tooltip={total ? `仍有 ${total} 条需求引用，请先调整这些需求的业务域` : "删除业务域"} onClick={() => setDeleteDomain(domain.name)}>删除</Button></td>
                  </tr>
                )) : <tr><td colSpan={5} className={styles.empty}>暂无业务域，新增后可在需求表单中选择。</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className={styles.toolbar} style={{ marginBottom: 10 }}>
            <span className={styles.caption}>合并会直接改写需求池与归档中所有匹配的需求，并记录日志、支持撤回。</span>
            <Button size="sm" variant="primary" disabled={!selected.length} onClick={() => { setMergeOpen(true); setMergeTarget(selected[0] ?? ""); setMergeError(""); }}>
              合并名称{selected.length ? `（${selected.length}）` : ""}
            </Button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label={`${tab === "project" ? "项目" : "提需人"}名称维护`}>
              <thead>
                <tr>
                  <th><Checkbox checked={allSelected} onCheckedChange={(checked) => setSelected(checked ? [...values] : [])} ariaLabel="全选" /></th>
                  <th>名称</th><th>需求池</th><th>归档</th>
                </tr>
              </thead>
              <tbody>
                {values.length ? values.map((value) => {
                  const item = counts(value);
                  return (
                    <tr key={value}>
                      <td><Checkbox checked={selected.includes(value)} onCheckedChange={() => setSelected((current) => (current.includes(value) ? current.filter((itemValue) => itemValue !== value) : [...current, value]))} ariaLabel={`选择${value}`} /></td>
                      <td>{value}</td>
                      <td>{item.pool}</td>
                      <td>{item.archive}</td>
                    </tr>
                  );
                }) : <tr><td colSpan={4} className={styles.empty}>暂无{tab === "project" ? "项目" : "提需人"}记录。</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      <DomainColorDialog
        open={Boolean(colorDomain)}
        title={colorDomain ? `${colorDomain}默认配色` : ""}
        caption="全局默认色，对所有用户生效"
        initialColor={colorDomain ? state.domains.find((domain) => domain.name === colorDomain)?.color ?? "#3b82f6" : "#3b82f6"}
        onOpenChange={(open) => { if (!open) setColorDomain(null); }}
        onSave={async (color) => {
          const domain = state.domains.find((item) => item.name === colorDomain);
          if (!domain) return false;
          const result = await runner((baseRevision) => api.updateDomain(baseRevision, domain.id, domain.name, color));
          if (result) {
            notice.notify("全局默认颜色已保存");
            return true;
          }
          return false;
        }}
      />

      <Dialog
        open={addOpen}
        onOpenChange={(open) => { if (!open) setAddOpen(false); }}
        title="新增业务域"
        caption="创建后可双击色块调整全局默认色"
        footer={<><Button onClick={() => setAddOpen(false)}>取消</Button><Button variant="primary" onClick={() => void addDomain()}>新增</Button></>}
      >
        <div className={styles.dialogForm}>
          <div className={styles.field}>
            <label htmlFor="rsm-domain-name">业务域名称</label>
            <input id="rsm-domain-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="填写业务域名称" autoFocus />
          </div>
          <ColorPicker value={newColor} onChange={setNewColor} />
          {addError ? <p className={styles.dialogError} role="alert">{addError}</p> : null}
        </div>
      </Dialog>

      <Dialog
        open={mergeOpen}
        onOpenChange={(open) => { if (!open) setMergeOpen(false); }}
        title={`合并${tab === "project" ? "项目" : "提需人"}`}
        caption={`已选 ${selected.length} 个名称`}
        footer={<><Button onClick={() => setMergeOpen(false)}>取消</Button><Button variant="primary" onClick={() => void mergeField()}>确认合并</Button></>}
      >
        <div className={styles.dialogForm}>
          <div className={styles.inline}>{selected.map((value) => <span key={value} style={{ padding: "2px 7px", borderRadius: 5, background: "var(--rsm-soft)" }}>{value}</span>)}</div>
          <div className={styles.field}>
            <label htmlFor="rsm-merge-target">更新为</label>
            <input id="rsm-merge-target" list="rsm-merge-values" value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)} placeholder="选择已有名称或填写新名称" />
            <datalist id="rsm-merge-values">{values.map((value) => <option key={value} value={value} />)}</datalist>
          </div>
          <p className={styles.captionSmall}>将直接更新这些需求的字段，原值记录在操作日志中。</p>
          {mergeError ? <p className={styles.dialogError} role="alert">{mergeError}</p> : null}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(deleteDomain)}
        onOpenChange={(open) => { if (!open) setDeleteDomain(null); }}
        title="删除业务域"
        caption={deleteDomain ?? undefined}
        footer={<><Button onClick={() => setDeleteDomain(null)}>取消</Button><Button variant="danger" onClick={async () => { const domain = state.domains.find((item) => item.name === deleteDomain); if (!domain) return; const result = await runner((baseRevision) => api.deleteDomain(baseRevision, domain.id)); if (result) { notice.notify("业务域已删除"); setDeleteDomain(null); } }}>确认删除</Button></>}
      >
        <p style={{ color: "var(--rsm-muted)" }}>删除“{deleteDomain}”？删除后不可恢复；仍有需求引用时请先调整相关需求。</p>
      </Dialog>
    </>
  );
}
