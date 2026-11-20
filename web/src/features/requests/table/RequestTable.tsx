import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, CalendarDays, ListX, RotateCcw } from "lucide-react";
import { api } from "../../../api/client";
import { useMutationRunner } from "../../../api/hooks";
import type { ApiRequest, State } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { useUiState } from "../../../app/uiState";
import { ARCHIVE_COLUMN_KEYS, COLUMN_CATALOG, formatDays } from "../../../lib/format";
import { dateLabel } from "../../../lib/dates";
import { DomainTag, PriorityTag, RequestTypeTag, StatusTag } from "../../../ui/Tag";
import { ContextMenu, contextMenuPoint, isContextMenuKey } from "../../../ui/ContextMenu";
import { useNotice } from "../../../ui/Notice";
import type { RequestPermissions } from "../types";
import { deliveryOf } from "../filtering";
import { requestMenuItems } from "../requestMenu";
import { reorderVisibleIds, sortBySavedOrder } from "../rowOrder";
import { useRequestReorder } from "../useRequestReorder";
import { useNameColumnResize } from "../useNameColumnResize";
import { newestRequests, sortRequests, toggleTableSort, type TableSort } from "./sorting";
import styles from "./RequestTable.module.css";

interface Props {
  state: State;
  permissions: RequestPermissions;
  rows: ApiRequest[];
  totalCount: number;
  draftHint: boolean;
  archive: boolean;
  onOpen: (id: number) => void;
  onOpenDetails: (id: number) => void;
  onDelete: (row: ApiRequest) => void;
  onArchive: (row: ApiRequest) => void;
  onRestore: (row: ApiRequest) => void;
}

interface MenuState {
  row: ApiRequest;
  priority?: boolean;
  x: number;
  y: number;
}

const WIDTHS: Record<string, number> = {
  requesterRank: 76,
  name: 230,
  domain: 104,
  requestType: 96,
  developer: 104,
  status: 92,
  start: 108,
  delivery: 108,
  days: 92,
  requester: 104,
  requestedAt: 108,
  project: 132,
  prd: 96,
  wangyue: 96,
  brd: 96,
  expected: 104,
  review: 104,
  notes: 220,
};

const HEADERS = Object.fromEntries(COLUMN_CATALOG.map(({ key, label }) => [key, label]));
const NAME_CLICK_DELAY_MS = 500;

export function RequestTable({ state, permissions, rows: incomingRows, totalCount, draftHint, archive, onOpen, onOpenDetails, onDelete, onArchive, onRestore }: Props) {
  const { ui, patch } = useUiState();
  const { domainColor, density } = usePreferences();
  const runner = useMutationRunner();
  const notice = useNotice();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [ranksAtEditStart, setRanksAtEditStart] = useState<ReadonlyMap<number, number> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nameMeasureRef = useRef<HTMLDivElement>(null);
  const rankQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingNameRank = useRef<{ id: number; timer: number } | null>(null);
  const [viewportWidth, setViewportWidth] = useState(1200);
  const canEdit = permissions.canEdit;
  const canRank = canEdit && !archive;
  const sorting = archive ? ui.archiveSorting : ui.poolSorting;
  const hasRanks = state.requests.some((row) => !row.archived && row.requesterRank);
  const nameResize = useNameColumnResize({
    rows: incomingRows, viewportWidth, defaultWidth: WIDTHS.name!, savedWidth: ui.poolNameColumnWidth,
    measureRef: nameMeasureRef, onSave: (width) => patch({ poolNameColumnWidth: width }),
  });
  const cancelNameRank = useCallback(() => {
    const pending = pendingNameRank.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingNameRank.current = null;
    return pending.id;
  }, []);
  const enqueueRank = (id?: number) => {
    rankQueue.current = rankQueue.current.then(async () => {
      const saved = await runner((base) => api.rankRequests(base, id));
      if (saved && id === undefined) notice.notify("已清除需求池优先级");
    });
  };
  const changeRank = (id?: number, waitForDoubleClick = false) => {
    if (id === undefined) setRanksAtEditStart(null);
    else if (sorting.some(({ key }) => key === "requesterRank")) {
      setRanksAtEditStart((ranks) => ranks ?? new Map(state.requests.map((row) => [row.id, row.requesterRank ?? 0])));
    }
    const previous = cancelNameRank();
    if (previous !== undefined) enqueueRank(previous);
    if (id === undefined || !waitForDoubleClick) {
      enqueueRank(id);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingNameRank.current = null;
      enqueueRank(id);
    }, NAME_CLICK_DELAY_MS);
    pendingNameRank.current = { id, timer };
  };
  useEffect(() => () => { cancelNameRank(); }, [canRank, cancelNameRank]);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewportWidth(element.clientWidth);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rowHeight = density === "compact" ? 38 : 50;
  const rows = useMemo(() => {
    const newest = newestRequests(incomingRows, archive);
    const ordered = archive ? newest : sortBySavedOrder(newest, ui.poolRowOrder, true);
    return sortRequests(ordered, sorting, state.users, ranksAtEditStart);
  }, [archive, incomingRows, ui.poolRowOrder, sorting, state.users, ranksAtEditStart]);
  const setSorting = (next: TableSort[]) => {
    setRanksAtEditStart(null);
    patch(archive ? { archiveSorting: next } : { poolSorting: next, ...(!next.length ? { poolRowOrder: [] } : {}) });
    setMenu(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  useEffect(() => {
    setMenu(null);
    setRanksAtEditStart(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [archive]);
  const reorder = useRequestReorder({
    containerRef: scrollRef,
    rows,
    enabled: !archive && !sorting.length,
    headerHeight: 40,
    onStart: () => setMenu(null),
    onReorder: (source, target) => {
      if (target.kind !== "row") return;
      const all = sortBySavedOrder(newestRequests(state.requests.filter((row) => !row.archived), false), ui.poolRowOrder, true).map((row) => row.id);
      const order = reorderVisibleIds(all, rows.map((row) => row.id), source.id, target.row.id, target.edge);
      if (order) patch({ poolRowOrder: order });
    },
  });

  const visible = archive ? ui.archiveVisibleColumns : ui.visibleColumns;
  const keys = useMemo(() => ui.columnOrder.filter((key) => visible.includes(key) && (!archive || ARCHIVE_COLUMN_KEYS.includes(key))), [ui.columnOrder, visible, archive]);
  const nameWidth = archive ? WIDTHS.name : nameResize.width;
  const columns = useMemo<ColumnDef<ApiRequest>[]>(
    () =>
      keys.map((key) => ({
        id: key,
        header: HEADERS[key] ?? key,
        accessorFn: (row) => row[key as keyof ApiRequest],
        size: key === "name" ? nameWidth : WIDTHS[key] ?? 110,
      })),
    [keys, nameWidth],
  );

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  const sizes = columns.map((column) => column.size ?? 110);
  const template = sizes.map((size) => `${size}px`).join(" ") || "1fr";
  const totalWidth = sizes.reduce((sum, size) => sum + size, 0);

  const cellContent = (row: ApiRequest, key: string) => {
    switch (key) {
      case "requesterRank": {
        const rank = row.requesterRank || 0;
        const badge = <span className={styles.rankBadge} data-rank={rank || undefined}>{rank || "–"}</span>;
        return canRank ? (
          <button type="button" className={styles.rankButton} aria-pressed={rank > 0}
            aria-label={rank ? `取消「${row.name}」优先级 ${rank}` : `标注「${row.name}」优先级`}
            onClick={() => changeRank(row.id)}
            onKeyDown={(event) => {
              if (!hasRanks || !isContextMenuKey(event)) return;
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ row, priority: true, x: rect.left, y: rect.bottom });
            }}>
            {badge}
          </button>
        ) : badge;
      }
      case "name":
        return (
          <div className={styles.nameContent} onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
            setMenu({ row, ...contextMenuPoint(event) });
          }}>
            <PriorityTag value={row.priority} />
            <button
              type="button"
              className={styles.nameButton}
              aria-pressed={canRank ? Boolean(row.requesterRank) : undefined}
              aria-description={canRank ? "单击标注或取消优先级，双击编辑" : undefined}
              onMouseDown={canRank ? (event) => {
                if (event.detail === 2 && pendingNameRank.current?.id === row.id) cancelNameRank();
              } : undefined}
              onClick={canRank ? (event) => {
                if (event.detail <= 1) changeRank(row.id, event.detail === 1);
              } : undefined}
              onDoubleClick={() => {
                if (pendingNameRank.current?.id === row.id) cancelNameRank();
                if (archive) onOpenDetails(row.id);
                else onOpen(row.id);
              }}
              onKeyDown={(event) => {
                if (isContextMenuKey(event)) {
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setMenu({ row, x: rect.left, y: rect.bottom });
                  return;
                }
                if (event.key === "Enter" && (archive || !canEdit)) {
                  event.preventDefault();
                  onOpenDetails(row.id);
                }
              }}
              aria-haspopup="menu"
            >
              {row.name}
            </button>
          </div>
        );
      case "domain":
        return <DomainTag name={row.domain} color={domainColor(row.domain, state.domains)} />;
      case "requestType":
        return <RequestTypeTag value={row.requestType} />;
      case "status":
        return <StatusTag value={row.status} />;
      case "developer": {
        const user = state.users.find((candidate) => candidate.id === row.developer);
        return <span className={user ? "" : styles.muted}>{user?.username ?? "-"}</span>;
      }
      case "start":
        return <span className={styles.date}>{dateLabel(row.start)}</span>;
      case "delivery":
        return <span className={styles.date}>{dateLabel(deliveryOf(row))}{Number(row.days) === 0 && row.start ? " 暂定" : ""}</span>;
      case "days":
        return <span>{formatDays(Number(row.days) || 0)}</span>;
      case "requestedAt":
      case "expected":
      case "review":
        return <span className={styles.date}>{dateLabel(row[key])}</span>;
      case "project":
        return row.project ? <span className={styles.project}><span className={styles.dot} data-project={row.project} />{row.project}</span> : <span className={styles.muted}>-</span>;
      case "prd":
      case "wangyue":
      case "brd": {
        const href = row[key];
        const labels: Record<string, string> = { prd: "查看 PRD", wangyue: "查看望岳", brd: "查看 BRD" };
        return href ? <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">{labels[key]}</a> : <span className={styles.muted}>-</span>;
      }
      case "notes":
        return <span className={row.notes ? "" : styles.muted}>{row.notes || "-"}</span>;
      default:
        return <span>{String(row[key as keyof ApiRequest] ?? "-")}</span>;
    }
  };

  const menuRow = menu ? rows.find((row) => row.id === menu.row.id) : undefined;
  const menuItems = menu?.priority
    ? canRank && hasRanks ? [{ key: "clearPriority", label: "清除优先级", icon: ListX, onSelect: () => changeRank() }] : []
    : menuRow
    ? archive && canEdit
      ? [{ key: "restore", label: "恢复到需求池", icon: RotateCcw, onSelect: () => onRestore(menuRow) }]
      : requestMenuItems(menuRow, { canEdit: canEdit && !archive, onOpen: archive ? onOpenDetails : onOpen, onDelete, onArchive })
    : [];

  return (
    <>
      <div className={styles.viewport} data-column-dragging={nameResize.dragging || undefined}>
        {!archive ? <div ref={nameMeasureRef} className={styles.nameMeasure} aria-hidden="true">
          <div className={styles.nameContent}><PriorityTag value="P0" /><span className={styles.nameButton} data-name-measure-label /></div>
        </div> : null}
        <div ref={scrollRef} {...reorder} {...nameResize.pointerHandlers} onPointerDown={(event) => {
          if ((event.target as Element).closest("[data-pool-column-resize]")) nameResize.begin(event);
          else if (!nameResize.dragging) reorder.onPointerDown(event);
        }} onMouseLeave={() => setRanksAtEditStart(null)} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setRanksAtEditStart(null);
        }} className={`${styles.wrap} ${archive ? "" : reorder.className}`} data-scroll-container="table" role="table" aria-label={archive ? "归档需求列表" : "需求列表"} aria-rowcount={rows.length + 1}>
          <div className={styles.table} style={{ width: Math.max(totalWidth, 100) }}>
            <div className={styles.header} style={{ gridTemplateColumns: template }} role="row">
              {keys.map((key) => {
                const label = HEADERS[key] ?? key;
                const index = sorting.findIndex((sort) => sort.key === key);
                const sort = sorting[index];
                const Icon = sort ? sort.direction === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
                return (
                  <div
                    key={key}
                    role="columnheader"
                    aria-label={label}
                    aria-sort={index === 0 ? sort?.direction === "asc" ? "ascending" : "descending" : undefined}
                    data-sorted={sort ? true : undefined}
                    className={`${styles.headerCell} ${key === "name" ? styles.headerName : ""}`}
                  >
                    <span className={styles.headerLabel}>{label}</span>
                    <button
                      type="button"
                      className={styles.sortButton}
                      aria-label={`${label}，${sort ? `第 ${index + 1} 排序，${sort.direction === "asc" ? "升序" : "降序"}，` : ""}点击${sort?.direction === "asc" ? "降序" : "升序"}`}
                      data-tooltip={sort ? `第 ${index + 1} 排序 · ${sort.direction === "asc" ? "升序" : "降序"}，点击切换` : "点击升序，可依次叠加其他字段"}
                      onClick={() => setSorting(toggleTableSort(sorting, key))}
                    >
                      <Icon aria-hidden="true" />
                    </button>
                    {sort && sorting.length > 1 ? <small className={styles.sortIndex} aria-hidden="true">{index + 1}</small> : null}
                    {!archive && key === "name" ? <span className={styles.nameResizeHandle} data-pool-column-resize {...nameResize.separatorProps} /> : null}
                  </div>
                );
              })}
            </div>
            <div className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
              {rows.length === 0 ? <div className={styles.empty}>{archive ? "暂无归档需求" : "没有匹配的需求"}</div> : null}
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]!;
                return (
                  <div
                    key={row.id}
                    role="row"
                    className={styles.row}
                    style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)`, gridTemplateColumns: template }}
                    data-row={row.id}
                  >
                    {table.getRowModel().rows[virtualRow.index]?.getVisibleCells().map((cell) => {
                      const key = cell.column.id;
                      return <div key={cell.id} role="cell" className={styles.cell} data-key={key} data-request-name={key === "name" || undefined} onContextMenu={key === "requesterRank" && canRank && hasRanks ? (event) => {
                        event.preventDefault();
                        event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
                        setMenu({ row, priority: true, ...contextMenuPoint(event) });
                      } : undefined}>
                        {cellContent(row, key)}
                        {!archive && key === "name" ? <span className={styles.nameResizeHandle} data-pool-column-resize aria-hidden="true" {...nameResize.handleProps} /> : null}
                      </div>;
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {sorting.length ? <button type="button" className={styles.resetSorting} aria-label="重置排序" data-tooltip="清除全部字段排序，恢复最新优先" onClick={() => setSorting([])}><RotateCcw aria-hidden="true" /><span className={styles.sortCount}>{sorting.length}</span></button> : null}
      </div>
      <div className={styles.footer} aria-label={archive ? "归档底部信息" : "需求池底部信息"}>
        <span className={styles.summary} aria-label="需求数量">{rows.length === totalCount ? `${totalCount} 条${archive ? "归档需求" : "需求"}` : `显示 ${rows.length} / 共 ${totalCount} 条${archive ? "归档需求" : "需求"}`}</span>
        {draftHint ? <span className={styles.draftHint}>有未提交草稿</span> : null}
        <span><CalendarDays aria-hidden="true" />日期：{new Date().getFullYear()} 年</span>
      </div>
      <ContextMenu
        open={Boolean(menuRow && menuItems.length)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        header={menu?.priority ? undefined : menuRow ? { title: menuRow.name } : undefined}
        items={menuItems}
        ariaLabel={menu?.priority ? "优先级操作" : "需求操作"}
        scrollContainer={scrollRef.current}
      />
    </>
  );
}
