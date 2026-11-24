import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { api } from "../../../api/client";
import type { RequestHistory } from "../useRequestHistory";
import type { ApiRequest, State } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { useUiState } from "../../../app/uiState";
import { emptyRequestDraft } from "../../../lib/draft";
import { readStorage, writeStorage } from "../../../lib/storage";
import { validateRequest } from "../../../lib/validation";
import { Button } from "../../../ui/Button";
import { Checkbox } from "../../../ui/Checkbox";
import { DateShortcuts } from "../../../ui/DateShortcuts";
import { Drawer } from "../../../ui/Drawer";
import { EnumSelect } from "../../../ui/EnumSelect";
import { LinkField } from "../../../ui/LinkField";
import { useNotice } from "../../../ui/Notice";
import { DomainTag, PriorityTag, RequestTypeTag, StatusTag } from "../../../ui/Tag";
import { gaps, type Calendar } from "../../../schedule";
import type { EditorRequest, RequestPermissions } from "../types";
import {
  addSegment as addSegmentOp,
  changeDays,
  changeDelivery,
  changeSegmentEdge,
  changeStart,
  deliveryDisplay,
  normalizeForSubmit,
  planOfDraft,
  removeSegmentAt as removeSegmentOp,
  splitInitial,
  startDisplay,
  toggleHold,
} from "./scheduleDraft";
import styles from "./RequestDrawer.module.css";

interface Props {
  save: RequestHistory["save"];
  state: State;
  permissions: RequestPermissions;
  editor: EditorRequest | null;
  onClose: () => void;
}

interface History {
  developer: string[];
  requester: string[];
}

const STATUSES = ["待评审", "待开发", "开发中", "已完成", "HOLD"];
const REQUEST_TYPES = ["常规需求", "数据需求"];
const PRIORITIES = ["P0", "P1", "P2"];

function historyKey(userId: string): string {
  return `rsm.history.v1:${userId}`;
}

function readHistory(userId: string): History {
  const stored = readStorage<History>(historyKey(userId), { developer: [], requester: [] });
  return {
    developer: Array.isArray(stored.developer) ? stored.developer.filter((value): value is string => typeof value === "string") : [],
    requester: Array.isArray(stored.requester) ? stored.requester.filter((value): value is string => typeof value === "string") : [],
  };
}

function cloneRequest(request: ApiRequest): ApiRequest {
  return JSON.parse(JSON.stringify(request)) as ApiRequest;
}

function collapseForSubmit(draft: ApiRequest): ApiRequest {
  if ((draft.segments ?? []).length !== 1) return draft;
  const segment = draft.segments![0]!;
  return { ...draft, start: segment.start, delivery: segment.end, segments: [] };
}

export function RequestDrawer({ save, state, permissions, editor, onClose }: Props) {
  const { prefs } = usePreferences();
  const { ui, setDraft: setStoredDraft } = useUiState();
  const notice = useNotice();
  const calendar = state.calendar as Calendar;
  const [draft, setDraft] = useState<ApiRequest | null>(null);
  const [tab, setTab] = useState<"required" | "schedule" | "extra">("required");
  const [error, setError] = useState<{ message: string; field: string; tab?: "required" | "schedule" | "extra" } | null>(null);
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<History>({ developer: [], requester: [] });
  const [originalRevision, setOriginalRevision] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const mode = editor?.mode ?? null;

  useEffect(() => {
    if (!editor) {
      setDraft(null);
      return;
    }
    const source = editor.mode === "edit" && editor.id !== undefined ? state.requests.find((row) => row.id === editor.id && !row.archived) : null;
    if (editor.mode === "edit" && !source) {
      onClose();
      return;
    }
    const initial = source ? cloneRequest(source) : cloneRequest(ui.newDraft ?? emptyRequestDraft(prefs, state.me));
    setDraft(initial);
    setOriginalRevision(source?.revision ?? 0);
    setTab("required");
    setError(null);
    setPending(false);
    setHistory(readHistory(state.me?.id ?? "guest"));
    const timer = window.setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.mode, editor?.id]);

  useEffect(() => {
    if (!draft || mode !== "create") return;
    setStoredDraft(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, mode]);

  if (!editor || !draft) {
    return <Drawer open={false} onOpenChange={() => undefined} title="需求" children={null} />;
  }

  const isAdmin = permissions.isAdmin;
  const activeUsers = state.users.filter((user) => !user.deleted && !user.disabled);
  const developerName = state.users.find((user) => user.id === draft.developer)?.username ?? "";
  const remote = editor.mode === "edit" && editor.id !== undefined ? state.requests.find((row) => row.id === editor.id) : null;
  const remoteChanged = Boolean(remote && remote.revision !== originalRevision);
  const projects = [...new Set(state.requests.map((row) => row.project).filter(Boolean))];
  const segmentList = (draft.segments ?? []).length > 1 ? draft.segments! : [];
  const plan = planOfDraft(draft);
  const scheduleGaps = gaps(plan, calendar);
  const deliveryValue = deliveryDisplay(draft);
  const startValue = startDisplay(draft);

  const applyUpdate = (updater: (current: ApiRequest) => ApiRequest) => {
    setDraft((current) => (current ? updater(current) : current));
    setError(null);
  };

  const setField = <K extends keyof ApiRequest>(key: K, value: ApiRequest[K]) => applyUpdate((current) => ({ ...current, [key]: value }));

  const saveHistory = (next: History) => {
    setHistory(next);
    writeStorage(historyKey(state.me?.id ?? "guest"), next);
  };

  const useRequester = (value: string) => setField("requester", value);
  const useDeveloper = (value: string) => setField("developer", value);
  const removeHistory = (field: keyof History, value: string) => saveHistory({ ...history, [field]: history[field].filter((item) => item !== value) });

  const setDays = (value: string) => {
    const days = value === "" ? 0 : Number(value);
    if (!Number.isInteger(days) || days < 0) {
      setError({ message: "开发人天请填写 0 或正整数", field: "days", tab: "schedule" });
      return;
    }
    applyUpdate((current) => {
      const result = changeDays(current, calendar, days);
      if (result.error) setError({ message: result.error, field: "days", tab: "schedule" });
      return result.draft;
    });
  };

  const setStart = (value: string) => {
    applyUpdate((current) => {
      if (!value) return { ...current, start: "", delivery: "" };
      const result = changeStart(current, calendar, value);
      if (result.error) setError({ message: result.error, field: "start", tab: "schedule" });
      return result.draft;
    });
  };

  const setDelivery = (value: string) => {
    if (!value) return;
    applyUpdate((current) => {
      const result = changeDelivery(current, calendar, value);
      if (result.error) setError({ message: result.error, field: "delivery", tab: "schedule" });
      return result.draft;
    });
  };

  const setSegmentDate = (index: number, edge: "start" | "end", value: string) => {
    applyUpdate((current) => {
      const result = changeSegmentEdge(current, calendar, index, edge, value);
      if (result.error) setError({ message: result.error, field: "start", tab: "schedule" });
      return result.draft;
    });
  };

  const splitSegments = () => {
    applyUpdate((current) => {
      const result = splitInitial(current, calendar);
      if (result.error) setError({ message: result.error, field: "start", tab: "schedule" });
      return result.draft;
    });
  };

  const appendSegment = () => {
    applyUpdate((current) => {
      const result = addSegmentOp(current, calendar);
      if (result.error) setError({ message: result.error, field: "start", tab: "schedule" });
      return result.draft;
    });
  };

  const removeSegmentAt = (index: number) => {
    applyUpdate((current) => {
      const result = removeSegmentOp(current, calendar, index);
      if (result.error) setError({ message: result.error, field: "start", tab: "schedule" });
      return result.draft;
    });
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!draft || !permissions.canEdit || pending) return;
    let candidate = collapseForSubmit(cloneRequest(draft));
    candidate.name = candidate.name.trim();
    candidate.requester = candidate.requester.trim();
    for (const key of ["project", "prd", "brd", "wangyue"] as const) candidate[key] = String(candidate[key] ?? "").trim();
    if (!isAdmin && editor.mode === "edit" && editor.id !== undefined) {
      const source = state.requests.find((row) => row.id === editor.id);
      if (source) {
        for (const key of ["domain", "requestType", "wangyue", "developer", "days", "start", "delivery", "segments", "vacation", "overtime"] as const) {
          (candidate as unknown as Record<string, unknown>)[key] = JSON.parse(JSON.stringify(source[key]));
        }
      }
    }
    if (!isAdmin && editor.mode === "create") {
      candidate = { ...candidate, domain: "", requestType: "常规需求", wangyue: "", developer: "", days: 3, start: "", delivery: "", segments: [], vacation: [], overtime: [] };
    }
    if (isAdmin) {
      const normalized = normalizeForSubmit(candidate, calendar);
      if (normalized.error) {
        setError({ message: normalized.error, field: "start", tab: "schedule" });
        return;
      }
      candidate = normalized.draft;
    }
    const issue = validateRequest(candidate, { users: state.users, domains: state.domains, existingDeveloper: remote?.developer });
    if (issue) {
      setError({ message: issue.error, field: issue.field, tab: issue.tab === "schedule" && !isAdmin ? "required" : issue.tab });
      setTab(issue.tab === "schedule" && !isAdmin ? "required" : issue.tab);
      window.setTimeout(() => {
        const element = document.getElementById(`rsm-field-${issue.field}`);
        element?.focus({ preventScroll: false });
        element?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 30);
      return;
    }
    setPending(true);
    const isCreate = editor.mode === "create";
    const payload: ApiRequest = isCreate ? { ...candidate, id: 0, revision: 0, archived: false } : { ...candidate, id: editor.id!, revision: originalRevision, archived: false };
    const result = await save((baseRevision) => (isCreate ? api.createRequest(baseRevision, payload) : api.updateRequest(baseRevision, payload)));
    setPending(false);
    if (!result) return;
    const nextHistory: History = {
      developer: candidate.developer ? [candidate.developer, ...history.developer.filter((value) => value !== candidate.developer)].slice(0, 6) : history.developer,
      requester: candidate.requester ? [candidate.requester, ...history.requester.filter((value) => value !== candidate.requester)].slice(0, 6) : history.requester,
    };
    saveHistory(nextHistory);
    if (isCreate) setStoredDraft(null);
    notice.notify(isCreate ? "需求已创建" : "需求已保存");
    onClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (mode === "create") setStoredDraft(draft);
    onClose();
  };

  const estimated = Number(draft.days) === 0;
  const markHint = estimated ? "暂按 3 个工作日占位" : "按工作日自动计算";
  const visibleTabs: { key: "required" | "schedule" | "extra"; label: string }[] = [
    { key: "required", label: "必填信息" },
    ...(isAdmin ? [{ key: "schedule" as const, label: "开发信息" }] : []),
    { key: "extra", label: "补充信息" },
  ];

  return (
    <Drawer
      open={Boolean(editor)}
      onOpenChange={handleOpenChange}
      title={mode === "create" ? "新增需求" : "编辑需求"}
      caption={mode === "create" ? "草稿自动保留，提交成功后清空" : "关闭后放弃未保存的修改"}
      className={styles.drawer}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        {remoteChanged ? <p className={styles.warning} role="status">此需求已被其他协作者更新；保存时会提示冲突，请核对最新内容。</p> : null}
        <div className={styles.tabs} role="tablist" aria-label="需求信息分类">
          {visibleTabs.map((item) => (
            <button key={item.key} type="button" role="tab" className={styles.tab} aria-selected={tab === item.key} onClick={() => setTab(item.key)}>
              {item.label}
            </button>
          ))}
        </div>

        <section className={styles.panel} hidden={tab !== "required"} data-panel="required">
          <div className={styles.sectionTitle}>必填信息</div>
          <div className={styles.requiredGrid}>
            <div className={`${styles.row2} ${styles.titleRow}`}>
              <div className={styles.field}>
                <label htmlFor="rsm-field-name">需求名<span className={styles.required}>*</span></label>
                <input ref={nameRef} id="rsm-field-name" value={draft.name} placeholder="填写需求名称" onChange={(event) => setField("name", event.target.value)} />
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>优先级<span className={styles.required}>*</span></span>
                <div className={styles.priorityChoice} role="radiogroup" aria-label="需求优先级">
                  {PRIORITIES.map((priority) => (
                    <button key={priority} type="button" role="radio" aria-checked={draft.priority === priority} aria-pressed={draft.priority === priority} onClick={() => setField("priority", priority as ApiRequest["priority"])}>
                      <PriorityTag value={priority} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className={`${styles.row2} ${styles.prdRow}`}>
              <div className={styles.field}>
                <label htmlFor="rsm-field-status">状态<span className={styles.required}>*</span></label>
                <EnumSelect
                  id="rsm-field-status"
                  ariaLabel="状态"
                  value={draft.status}
                  options={STATUSES.map((status) => ({ value: status, label: status }))}
                  onChange={(status) => setField("status", status as ApiRequest["status"])}
                  renderValue={(value) => <StatusTag value={value} />}
                  renderOption={(option) => <StatusTag value={option.value} />}
                />
              </div>
              <LinkField id="rsm-field-prd" label="PRD 链接" value={draft.prd} onChange={(value) => setField("prd", value)} required />
            </div>
            <div className={`${styles.row2} ${styles.requesterRow}`}>
              <div className={styles.field}>
                <label htmlFor="rsm-field-requester">提需人<span className={styles.required}>*</span></label>
                <input id="rsm-field-requester" value={draft.requester} placeholder="姓名、称呼或团队" onChange={(event) => setField("requester", event.target.value)} />
                <div className={styles.history}>
                  {history.requester.length ? <span className={styles.historyLabel}>最近使用</span> : null}
                  {history.requester.slice(0, 4).map((value) => (
                    <span key={value} className={styles.historyTag}>
                      <button type="button" className={styles.historyUse} onClick={() => useRequester(value)} data-tooltip={value}>{value}</button>
                      <button type="button" className={styles.historyRemove} aria-label={`移除提需人建议 ${value}`} onClick={() => removeHistory("requester", value)}><X aria-hidden="true" /></button>
                    </span>
                  ))}
                </div>
              </div>
              <div className={styles.field}>
                <label htmlFor="rsm-field-requestedAt">提需日期<span className={styles.required}>*</span></label>
                <input id="rsm-field-requestedAt" type="date" value={draft.requestedAt} onChange={(event) => setField("requestedAt", event.target.value)} />
                <DateShortcuts label="提需日期" value={draft.requestedAt} onChange={(value) => setField("requestedAt", value)} />
              </div>
            </div>
          </div>
        </section>

        {isAdmin ? (
          <section className={styles.panel} hidden={tab !== "schedule"} data-panel="schedule">
            <div className={styles.sectionTitle}>开发信息</div>
            <p className={styles.sectionCaption}>选填 · 按需调整。协作者看不到这里的字段；打开编辑不会重算已保存的排期。</p>
            <div className={styles.grid2}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>业务域</span>
                <EnumSelect
                  ariaLabel="业务域"
                  value={draft.domain}
                  allowEmpty
                  emptyLabel="-"
                  options={state.domains.map((domain) => ({ value: domain.name, label: domain.name }))}
                  onChange={(domain) => setField("domain", domain)}
                  renderValue={(value) => (value ? <DomainTag name={value} color={state.domains.find((domain) => domain.name === value)?.color} /> : <span>-</span>)}
                  renderOption={(option) => (option.value ? <DomainTag name={option.value} color={state.domains.find((domain) => domain.name === option.value)?.color} /> : <span>-</span>)}
                />
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>需求类型</span>
                <EnumSelect
                  ariaLabel="需求类型"
                  value={draft.requestType}
                  options={REQUEST_TYPES.map((value) => ({ value, label: value }))}
                  onChange={(value) => setField("requestType", value as ApiRequest["requestType"])}
                  renderValue={(value) => <RequestTypeTag value={value} />}
                  renderOption={(option) => <RequestTypeTag value={option.value} />}
                />
              </div>
              <div className={styles.wide}>
                <LinkField id="rsm-field-wangyue" label="望岳工单链接" value={draft.wangyue} onChange={(value) => setField("wangyue", value)} wide />
              </div>
              <div className={styles.field}>
                <label htmlFor="rsm-field-developer">开发人</label>
                <EnumSelect
                  id="rsm-field-developer"
                  ariaLabel="开发人"
                  value={draft.developer}
                  allowEmpty
                  emptyLabel="-"
                  options={activeUsers.map((user) => ({ value: user.id, label: user.username }))}
                  onChange={(value) => setField("developer", value)}
                  renderValue={(value) => <span>{activeUsers.find((user) => user.id === value)?.username ?? "-"}</span>}
                />
                <div className={styles.history}>
                  {history.developer.filter((value) => activeUsers.some((user) => user.id === value)).length ? <span className={styles.historyLabel}>最近使用</span> : null}
                  {history.developer.filter((value) => activeUsers.some((user) => user.id === value)).slice(0, 4).map((value) => {
                    const user = activeUsers.find((candidate) => candidate.id === value);
                    return (
                      <span key={value} className={styles.historyTag}>
                        <button type="button" className={styles.historyUse} onClick={() => useDeveloper(value)} data-tooltip={user?.username}>{user?.username}</button>
                        <button type="button" className={styles.historyRemove} aria-label={`移除开发人建议 ${user?.username}`} onClick={() => removeHistory("developer", value)}><X aria-hidden="true" /></button>
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className={styles.field}>
                <label htmlFor="rsm-field-days">开发人天</label>
                <input id="rsm-field-days" type="number" min={0} step={1} value={draft.days} onChange={(event) => setDays(event.target.value)} />
                <span className={styles.help}>0 或留空代表待估{estimated ? " · 暂按 3 个工作日占位" : ""}</span>
              </div>
              <div className={styles.field}>
                <label htmlFor="rsm-field-start">准入日期</label>
                <input id="rsm-field-start" type="date" value={startValue} onChange={(event) => setStart(event.target.value)} />
                <DateShortcuts label="准入日期" value={startValue} onChange={setStart} />
              </div>
              <div className={styles.field}>
                <label htmlFor="rsm-field-delivery">交付日期</label>
                <input id="rsm-field-delivery" type="date" value={deliveryValue} min={startValue || undefined} disabled={!draft.start && !segmentList.length} onChange={(event) => setDelivery(event.target.value)} />
                <DateShortcuts label="交付日期" value={deliveryValue} onChange={setDelivery} />
                <span className={styles.help}>{startValue ? `${markHint} · 交付 ${deliveryValue || "-"}` : "尚未安排开始日期"}</span>
              </div>
            </div>
            <div className={styles.splitTools}>
              {segmentList.length <= 1 ? <Button size="sm" onClick={splitSegments}>更多操作 · 拆分排期</Button> : null}
            </div>
            {segmentList.length > 1 ? (
              <div className={styles.segments}>
                <details open>
                  <summary>分段排期 <span className={styles.help}>共 {segmentList.length} 段，{draft.days} 人天</span></summary>
                  <div className={styles.segmentChildren}>
                    {segmentList.map((segment, index) => {
                      const gap = scheduleGaps.find((item) => item.afterIndex === index);
                      return (
                        <section key={index} className={styles.segmentNode} aria-label={`第 ${index + 1} 段排期`}>
                          <div className={styles.segmentHead}>
                            <div><span>第 {index + 1} 段</span></div>
                            <Button size="sm" variant="dangerText" onClick={() => removeSegmentAt(index)} aria-label={`删除第 ${index + 1} 段`}>删除</Button>
                          </div>
                          {index > 0 ? (
                            <Checkbox
                              checked={Boolean(segment.holdBefore)}
                              onCheckedChange={(checked) => applyUpdate((current) => toggleHold(current, index, checked))}
                              label={<span>与上一段的间隔标记为 HOLD{gap ? `（${gap.workdays} 个工作日）` : "（间隔无工作日，不会显示 HOLD）"}</span>}
                            />
                          ) : null}
                          <div className={styles.segmentFields}>
                            <label>开始日期<input type="date" value={segment.start} onChange={(event) => setSegmentDate(index, "start", event.target.value)} /></label>
                            <label>结束日期<input type="date" value={segment.end} onChange={(event) => setSegmentDate(index, "end", event.target.value)} /></label>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                </details>
                <Button size="sm" className={styles.segmentAdd} onClick={appendSegment}><Plus aria-hidden="true" />添加一段</Button>
                <p className={styles.help}>人天与分段由排期模块统一计算；HOLD 是每段显式开关，不受状态影响。删除整段也可保存后在甘特图右键操作。</p>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className={styles.panel} hidden={tab !== "extra"} data-panel="extra">
          <div className={styles.sectionTitle}>补充信息</div>
          <p className={styles.sectionCaption}>选填</p>
          <div className={styles.grid2}>
            <div className={styles.field}>
              <label htmlFor="rsm-field-project">项目</label>
              <input id="rsm-field-project" value={draft.project} list="rsm-project-options" placeholder="选择或填写项目" onChange={(event) => setField("project", event.target.value)} />
              <datalist id="rsm-project-options">{projects.map((project) => <option key={project} value={project} />)}</datalist>
            </div>
            <div className={styles.wide}>
              <LinkField id="rsm-field-brd" label="BRD 链接" value={draft.brd} onChange={(value) => setField("brd", value)} wide />
            </div>
            <div className={styles.field}>
              <label htmlFor="rsm-field-review">评审日期</label>
              <input id="rsm-field-review" type="date" value={draft.review} onChange={(event) => setField("review", event.target.value)} />
              <DateShortcuts label="评审日期" value={draft.review} onChange={(value) => setField("review", value)} />
            </div>
            <div className={styles.field}>
              <label htmlFor="rsm-field-expected">预期交付日期</label>
              <input id="rsm-field-expected" type="date" value={draft.expected} onChange={(event) => setField("expected", event.target.value)} />
              <DateShortcuts label="预期交付日期" value={draft.expected} onChange={(value) => setField("expected", value)} />
            </div>
            <div className={styles.wide}>
              <label htmlFor="rsm-field-notes" className={styles.fieldLabel}>备注</label>
              <textarea id="rsm-field-notes" value={draft.notes} placeholder="补充说明或 HOLD 原因" onChange={(event) => setField("notes", event.target.value)} />
            </div>
          </div>
        </section>

        {error ? (
          <p className={styles.error} role="alert">
            {error.message}
            {error.tab && error.tab !== tab ? <button type="button" className={styles.errorLink} onClick={() => setTab(error.tab!)}>前往{error.tab === "schedule" ? "开发信息" : error.tab === "extra" ? "补充信息" : "必填信息"}修正</button> : null}
          </p>
        ) : null}
        <div className={styles.footer} style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--rsm-border)" }}>
          <span className={styles.help}>{mode === "create" ? "收起后可继续填写" : "正式保存后才记录变更"}{developerName ? ` · 开发人 ${developerName}` : ""}</span>
          <div className={styles.footerActions}>
            <Button onClick={() => handleOpenChange(false)}>{mode === "create" ? "收起" : "取消"}</Button>
            <Button type="submit" variant="primary" disabled={pending}>{pending ? "保存中…" : mode === "create" ? "创建需求" : "保存需求"}</Button>
          </div>
        </div>
      </form>
    </Drawer>
  );
}
