import { useMemo, useRef, useState } from "react";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarDays, RotateCcw } from "lucide-react";
import type { ApiRequest, State } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { useUiState } from "../../../app/uiState";
import { formatDays } from "../../../lib/format";
import { dateLabel } from "../../../lib/dates";
import { DomainTag, PriorityTag, RequestTypeTag, StatusTag } from "../../../ui/Tag";
import { ContextMenu, contextMenuPoint, isContextMenuKey } from "../../../ui/ContextMenu";
import type { RequestPermissions } from "../types";
import { deliveryOf } from "../filtering";
import { requestMenuItems } from "../requestMenu";
import { reorderVisibleIds, sortBySavedOrder } from "../rowOrder";
import { useRequestReorder } from "../useRequestReorder";
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
  x: number;
  y: number;
}

const WIDTHS: Record<string, number> = {
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

const HEADERS: Record<string, string> = {
  name: "需求名称",
  domain: "业务域",
  requestType: "需求类型",
  developer: "开发人",
  status: "状态",
  start: "准入日期",
  delivery: "交付日期",
  days: "开发人天",
  requester: "提需人",
  requestedAt: "提需日期",
  project: "项目",
  prd: "PRD 链接",
  wangyue: "望岳链接",
  brd: "BRD 链接",
  expected: "预期交付",
  review: "评审时间",
  notes: "备注",
};

export function RequestTable({ state, permissions, rows: incomingRows, totalCount, draftHint, archive, onOpen, onOpenDetails, onDelete, onArchive, onRestore }: Props) {
  const { ui, patch } = useUiState();
  const { domainColor, density } = usePreferences();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = density === "compact" ? 38 : 50;
  const rows = useMemo(() => archive ? incomingRows : sortBySavedOrder(incomingRows, ui.poolRowOrder), [archive, incomingRows, ui.poolRowOrder]);
  const reorder = useRequestReorder({
    containerRef: scrollRef,
    rows,
    enabled: !archive,
    headerHeight: 40,
    onStart: () => setMenu(null),
    onReorder: (source, target, edge) => {
      const all = sortBySavedOrder(state.requests.filter((row) => !row.archived), ui.poolRowOrder).map((row) => row.id);
      const order = reorderVisibleIds(all, rows.map((row) => row.id), source, target, edge);
      if (order) patch({ poolRowOrder: order });
    },
  });

  const visible = archive ? ui.archiveVisibleColumns : ui.visibleColumns;
  const keys = ui.columnOrder.filter((key) => visible.includes(key) && (!archive || key !== "status"));
  const columns = useMemo<ColumnDef<ApiRequest>[]>(
    () =>
      keys.map((key) => ({
        id: key,
        header: HEADERS[key] ?? key,
        accessorFn: (row) => row[key as keyof ApiRequest],
        size: WIDTHS[key] ?? 110,
      })),
    [keys],
  );

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  const template = keys.map((key) => `${WIDTHS[key] ?? 110}px`).join(" ") + (keys.length ? "" : "1fr");
  const totalWidth = keys.reduce((sum, key) => sum + (WIDTHS[key] ?? 110), 0);

  const canEdit = permissions.canEdit;

  const cellContent = (row: ApiRequest, key: string) => {
    switch (key) {
      case "name":
        return (
          <div className={styles.nameContent} data-request-name onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.querySelector("button")?.focus({ preventScroll: true });
            setMenu({ row, ...contextMenuPoint(event) });
          }}>
            <PriorityTag value={row.priority} />
            <button
              type="button"
              className={styles.nameButton}
              onDoubleClick={() => { if (archive || !canEdit) onOpenDetails(row.id); }}
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
  const menuItems = menuRow
    ? archive && canEdit
      ? [{ key: "restore", label: "恢复到需求池", icon: RotateCcw, onSelect: () => onRestore(menuRow) }]
      : requestMenuItems(menuRow, { canEdit: canEdit && !archive, onOpen: archive ? onOpenDetails : onOpen, onDelete, onArchive })
    : [];

  return (
    <>
      <div ref={scrollRef} {...reorder} className={`${styles.wrap} ${archive ? "" : reorder.className}`} data-scroll-container="table" role="table" aria-label={archive ? "归档需求列表" : "需求列表"} aria-rowcount={rows.length + 1}>
        <div className={styles.table} style={{ width: Math.max(totalWidth, 100) }}>
          <div className={styles.header} style={{ gridTemplateColumns: template }} role="row">
            {keys.map((key) => (
              <div key={key} role="columnheader" className={`${styles.headerCell} ${key === "name" ? styles.headerName : ""}`} style={key === "name" ? { width: WIDTHS.name } : undefined}>
                {HEADERS[key] ?? key}
              </div>
            ))}
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
                  {table.getRowModel().rows.find((candidate) => candidate.original.id === row.id)?.getVisibleCells().map((cell) => (
                    <div key={cell.id} role="cell" className={`${styles.cell} ${cell.column.id === "name" ? styles.nameCell : ""}`} data-key={cell.column.id}>
                      {cellContent(row, cell.column.id)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className={styles.footer} aria-label={archive ? "归档底部信息" : "需求池底部信息"}>
        <span className={styles.summary} aria-label="需求数量">{rows.length === totalCount ? `${totalCount} 条${archive ? "归档需求" : "需求"}` : `显示 ${rows.length} / 共 ${totalCount} 条${archive ? "归档需求" : "需求"}`}</span>
        {draftHint ? <span className={styles.draftHint}>有未提交草稿</span> : null}
        <span><CalendarDays aria-hidden="true" />日期：{new Date().getFullYear()} 年</span>
      </div>
      <ContextMenu
        open={Boolean(menuRow)}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        header={menuRow ? { title: menuRow.name } : undefined}
        items={menuItems}
        ariaLabel="需求操作"
        scrollContainer={scrollRef.current}
      />
    </>
  );
}
