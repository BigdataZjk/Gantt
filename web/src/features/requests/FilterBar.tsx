import { useMemo, useRef, useState, type ReactNode } from "react";
import { Columns3, SlidersHorizontal } from "lucide-react";
import type { State } from "../../api/types";
import { useUiState } from "../../app/uiState";
import { ARCHIVE_COLUMN_KEYS, COLUMN_CATALOG } from "../../lib/format";
import { addDays, isValidDate, todayISO } from "../../lib/dates";
import { Checkbox } from "../../ui/Checkbox";
import { DomainTag, PriorityTag, RequestTypeTag, StatusTag } from "../../ui/Tag";
import { FilterSelect } from "../../ui/FilterSelect";
import { Popover } from "../../ui/Popover";
import { Button } from "../../ui/Button";
import { usePreferences } from "../../app/preferences";
import { domainOptions, developerOptions } from "./filtering";
import styles from "./FilterBar.module.css";

const REQUEST_TYPES = ["常规需求", "数据需求"];
const STATUSES = ["待评审", "待开发", "开发中", "已完成", "HOLD"];

interface FilterBarProps {
  state: State;
  scopeRows: { priority: string }[];
  tab: "gantt" | "pool" | "archive";
  ganttFitDays: number;
  navigation: ReactNode;
}

export function FilterBar({ state, scopeRows, tab, ganttFitDays, navigation }: FilterBarProps) {
  const { ui, patch, patchFilters } = useUiState();
  const { domainColor } = usePreferences();
  const filters = ui.filters;
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [orderDraft, setOrderDraft] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [axisError, setAxisError] = useState("");
  const dragStart = useRef<{ key: string; order: string[] } | null>(null);
  const today = todayISO();
  const axisStart = ui.ganttRange.start || addDays(today, -Math.min(7, Math.floor(ganttFitDays / 3)));
  const axisEnd = ui.ganttRange.end || addDays(axisStart, ganttFitDays - 1);

  const setAxisDate = (edge: "start" | "end", value: string) => {
    if (!isValidDate(value)) {
      setAxisError("请选择完整的开始和结束日期");
      return;
    }
    const start = edge === "start" ? value : axisStart;
    const end = edge === "end" ? value : ui.ganttRange.end || addDays(start, ganttFitDays - 1);
    if (end < start) {
      setAxisError("结束日期不能早于开始日期，请调整显示范围");
      return;
    }
    setAxisError("");
    patch({ ganttRange: { start, end: edge === "end" || ui.ganttRange.end ? end : "" }, ganttZoom: 1 });
  };

  const domainChoices = useMemo(() => domainOptions(state.domains).map((option) => ({ ...option, node: <DomainTag name={option.label} color={domainColor(option.label, state.domains)} /> })), [state.domains, domainColor]);
  const developerChoices = useMemo(() => developerOptions(state.users).map((option) => ({ value: option.value, label: option.label, node: option.label })), [state.users]);
  const requestTypeChoices = REQUEST_TYPES.map((value) => ({ value, label: value, node: <RequestTypeTag value={value} /> }));
  const statusChoices = STATUSES.map((value) => ({ value, label: value, node: <StatusTag value={value} /> }));

  const domainCounts = new Map<string, number>();
  for (const row of scopeRows as unknown as { domain: string }[]) domainCounts.set(row.domain, (domainCounts.get(row.domain) ?? 0) + 1);
  const priorityCounts = new Map<string, number>();
  for (const row of scopeRows) priorityCounts.set(row.priority, (priorityCounts.get(row.priority) ?? 0) + 1);
  const prioritySelected = new Set(filters.priority);
  const allPriorities = prioritySelected.size === 3;
  const dateCount = Number(Boolean(filters.start)) + Number(Boolean(filters.end));

  const archive = tab === "archive";
  const order = (orderDraft ?? ui.columnOrder).filter((key) => !archive || ARCHIVE_COLUMN_KEYS.includes(key));
  const visible = new Set(archive ? ui.archiveVisibleColumns : ui.visibleColumns);

  const commitOrder = (nextOrder: string[]) => {
    const included = new Set(nextOrder);
    let index = 0;
    const next = ui.columnOrder.map((key) => (included.has(key) ? nextOrder[index++]! : key));
    patch({ columnOrder: next });
  };

  const toggleColumn = (key: string) => {
    const current = new Set(visible);
    if (current.has(key)) {
      if (current.size <= 1) return;
      current.delete(key);
    } else {
      current.add(key);
    }
    patch(archive ? { archiveVisibleColumns: [...current] } : { visibleColumns: [...current] });
  };

  const setPriority = (value: string) => {
    const next = new Set(prioritySelected);
    if (allPriorities) next.clear();
    if (next.has(value)) next.delete(value);
    else next.add(value);
    patchFilters({ priority: ["P0", "P1", "P2"].filter((priority) => next.has(priority)) });
  };

  return (
    <div className={styles.bar} role="group" aria-label="核心筛选">
      <div className={styles.views}>{navigation}</div>
      <div className={styles.filters}>
        <FilterSelect
          label="业务域"
          options={domainChoices}
          selected={filters.domain}
          onChange={(domain) => patchFilters({ domain })}
          renderTag={(value) => <DomainTag name={value} color={domainColor(value, state.domains)} />}
        />
        <FilterSelect label="需求类型" options={requestTypeChoices} selected={filters.requestType} onChange={(requestType) => patchFilters({ requestType })} renderTag={(value) => <RequestTypeTag value={value} />} />
        <FilterSelect label="状态" options={statusChoices} selected={filters.status} onChange={(status) => patchFilters({ status })} renderTag={(value) => <StatusTag value={value} />} />
        <FilterSelect label="开发人" options={developerChoices} selected={filters.developer} onChange={(developer) => patchFilters({ developer })} />
      </div>
      <div className={styles.priority} role="group" aria-label="按优先级筛选，可多选">
        {["P0", "P1", "P2"].map((priority) => (
          <button key={priority} type="button" className={styles.priorityButton} aria-pressed={prioritySelected.has(priority)} aria-label={`${priority}，${priorityCounts.get(priority) ?? 0} 条需求`} onClick={() => setPriority(priority)}>
            <PriorityTag value={priority} />
            <span className={styles.count}>{priorityCounts.get(priority) ?? 0}</span>
          </button>
        ))}
        {prioritySelected.size > 0 && !allPriorities ? <button type="button" className={styles.allButton} onClick={() => patchFilters({ priority: [] })}>全选</button> : null}
      </div>
      {tab === "gantt" ? (
        <div className={styles.ganttRange}>
          <div className={styles.axisControls} aria-label="甘特图显示日期范围">
            <label>
              开始
              <input type="date" aria-label="甘特图开始日期" value={axisStart} onChange={(event) => setAxisDate("start", event.target.value)} />
            </label>
            <span className={styles.endWrap}>
              <label>
                结束
                <input type="date" aria-label="甘特图结束日期" value={axisEnd} onChange={(event) => setAxisDate("end", event.target.value)} />
              </label>
              <div className={styles.axisPresets} aria-label="仅设置结束日期">
                {[30, 60].map((days) => (
                  <button key={days} type="button" className={styles.preset} data-tooltip={`结束日期设为今天起 ${days} 天后，开始日期保持不变`} onClick={(event) => {
                    setAxisDate("end", addDays(today, days));
                    if (event.detail > 0) event.currentTarget.blur();
                  }}>
                    {days}D
                  </button>
                ))}
              </div>
            </span>
          </div>
          {axisError ? <p className={styles.axisError} role="alert">{axisError}</p> : null}
        </div>
      ) : null}
      {tab !== "gantt" ? (
        <div className={styles.tools}>
          <Popover
            open={moreOpen}
            onOpenChange={setMoreOpen}
            trigger={
              <button type="button" className={styles.toolButton} data-open={moreOpen} aria-haspopup="dialog">
                <SlidersHorizontal aria-hidden="true" />
                更多筛选
                {dateCount ? <span className={styles.toolCount}>({dateCount})</span> : null}
              </button>
            }
            className={styles.dateForm}
          >
            <div className={styles.dateField}>
              <label htmlFor="rsm-filter-start">准入起</label>
              <input id="rsm-filter-start" type="date" value={filters.start} onChange={(event) => patchFilters({ start: event.target.value })} />
            </div>
            <div className={styles.dateField}>
              <label htmlFor="rsm-filter-end">交付止</label>
              <input id="rsm-filter-end" type="date" value={filters.end} onChange={(event) => patchFilters({ end: event.target.value })} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button size="sm" onClick={() => patchFilters({ start: "", end: "" })} disabled={!dateCount}>清空日期</Button>
            </div>
          </Popover>

          <Popover
            open={columnsOpen}
            onOpenChange={(open) => {
              setColumnsOpen(open);
              if (!open) {
                setOrderDraft(null);
                setDragging(null);
                dragStart.current = null;
              }
            }}
            trigger={
              <button type="button" className={styles.toolButton} data-open={columnsOpen} aria-haspopup="dialog">
                <Columns3 aria-hidden="true" />
                显示字段
              </button>
            }
            className={styles.columnPanel}
          >
            <p className={styles.dragHint}>按住任意字段上下拖动排序，勾选控制显隐</p>
            <div
              onPointerMove={(event) => {
                const start = dragStart.current;
                if (!start) return;
                const container = event.currentTarget as HTMLElement;
                const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("[data-column-row]") as HTMLElement | null;
                if (!row || !container.contains(row)) return;
                const key = row.dataset.columnRow!;
                if (!key || key === dragging) return;
                setDragging(key);
                setOrderDraft((current) => {
                  const list = [...(current ?? start.order)];
                  const from = list.indexOf(start.key);
                  const to = list.indexOf(key);
                  if (from < 0 || to < 0 || from === to) return list;
                  list.splice(from, 1);
                  list.splice(to, 0, start.key);
                  return list;
                });
              }}
              onPointerUp={() => {
                if (dragStart.current && orderDraft) commitOrder(orderDraft);
                dragStart.current = null;
                setDragging(null);
                setOrderDraft(null);
              }}
              onPointerLeave={() => {
                if (dragStart.current && orderDraft) commitOrder(orderDraft);
                dragStart.current = null;
                setDragging(null);
                setOrderDraft(null);
              }}
            >
              {order.map((key) => {
                const label = COLUMN_CATALOG.find((entry) => entry.key === key)?.label ?? key;
                return (
                  <div
                    key={key}
                    className={styles.columnRow}
                    data-column-row={key}
                    data-dragging={dragging === key}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      if ((event.target as HTMLElement).closest("input,button")) return;
                      event.preventDefault();
                      dragStart.current = { key, order: [...order] };
                      setDragging(key);
                      setOrderDraft([...order]);
                    }}
                  >
                    <Checkbox checked={visible.has(key)} onCheckedChange={() => toggleColumn(key)} label={label} ariaLabel={`显示字段：${label}`} />
                  </div>
                );
              })}
            </div>
          </Popover>
        </div>
      ) : null}
    </div>
  );
}
