import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction, type RefObject, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import {
  AlarmClockPlus,
  ArrowBigDown,
  ArrowBigUp,
  ArrowDownWideNarrow,
  ArrowLeftToLine,
  CalendarOff,
  ChevronDown,
  CirclePause,
  Hourglass,
  ListOrdered,
  RotateCcw,
  X,
} from "lucide-react";
import type { ApiRequest, Calendar, State } from "../../../api/types";
import { usePreferences } from "../../../app/preferences";
import { useUiState } from "../../../app/uiState";
import { addDays, diffDays, enumerateDates, isWorkday, todayISO } from "../../../lib/dates";
import { colorFromHex } from "../../../lib/color";
import { Button } from "../../../ui/Button";
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem } from "../../../ui/ContextMenu";
import { Drawer } from "../../../ui/Drawer";
import { useNotice } from "../../../ui/Notice";
import { PriorityTag } from "../../../ui/Tag";
import {
  admissionSortOrderForRows,
  buildSequencePlan,
  currentLivePhase,
  dateHeaders,
  dayResolver,
  estimateCenters,
  groupRequests,
  holdLayout,
  monthGroups,
  moveSegmentDates,
  overlapBadges,
  planOf,
  removeSegment,
  requestActiveDays,
  resizeSegmentDates,
  segmentFillBounds,
  supplementRequest,
  type DayInfo,
  type OverlapBadge,
  type Plan as GanttPlan,
  type SequencePlan,
} from "./ganttMath";
import type { GanttUndo } from "./useGanttUndo";
import { isTextUndoTarget } from "./ganttUndo";
import type { RequestPermissions } from "../types";
import { requestMenuItems } from "../requestMenu";
import { reorderVisibleIds } from "../rowOrder";
import { useRequestReorder } from "../useRequestReorder";
import { unsupportedYears } from "../../../schedule";
import { SequencePreview } from "./SequencePreview";
import previewStyles from "./SequencePreview.module.css";
import styles from "./GanttView.module.css";

interface Props {
  state: State;
  undo: GanttUndo;
  permissions: RequestPermissions;
  rows: ApiRequest[];
  totalCount: number;
  draftHint: boolean;
  onOpen: (id: number) => void;
  onDelete: (row: ApiRequest) => void;
  onArchive: (row: ApiRequest) => void;
  onFitDaysChange: (days: number) => void;
}

type MenuState =
  | { type: "day"; rowId: number; date: string; phaseIndex: number; x: number; y: number }
  | { type: "request"; rowId: number; x: number; y: number }
  | null;

interface Preview {
  kind: "move" | "resize" | "add";
  rowId: number;
  phaseIndex: number;
  start?: string;
  end?: string;
  dates?: string[];
  valid: boolean;
  reason: string;
}

interface Gesture {
  kind: "move" | "resize" | "add";
  rowId: number;
  phaseIndex: number;
  pointerId: number;
  downX: number;
  downY: number;
  lastX: number;
  lastY: number;
  cellWidth: number;
  initialScroll: number;
  active: boolean;
  edge?: "start" | "end";
  originDate?: string;
  rowTop?: number;
  rowBottom?: number;
  wrapLeft?: number;
  wrapRight?: number;
}

interface BlankPointer {
  rowId: number;
  date: string;
  pointerId: number;
  x: number;
  y: number;
}

interface LastBlankClick {
  rowId: number;
  date: string;
  x: number;
  y: number;
  time: number;
}

interface NameColumnDrag {
  pointerId: number;
  startX: number;
  startWidth: number;
  nextWidth: number;
  frame: number;
}

const DEFAULT_NAME_COLUMN_WIDTH = 192;
const MIN_NAME_COLUMN_WIDTH = 120;
const MAX_NAME_COLUMN_SCALE = 1.2;
const MIN_TIMELINE_WIDTH = 80;
const PERSON_ROW_HEIGHT = 28;
const ROW_HEIGHT = { compact: 38, comfortable: 50 } as const;
type MarkerMode = "icon" | "tick" | "hidden";

export const GanttView = memo(function GanttView({ state, permissions, rows, totalCount, draftHint, onOpen, onDelete, onArchive, onFitDaysChange, undo }: Props) {
  const { ui, patch } = useUiState();
  const { domainColor, density } = usePreferences();
  const notice = useNotice();
  const calendar = state.calendar;
  const today = todayISO();
  const [viewport, setViewport] = useState({ width: 1200, height: 640 });
  const [nameColumnContentLimit, setNameColumnContentLimit] = useState(DEFAULT_NAME_COLUMN_WIDTH);
  const [draggedNameColumnWidth, setDraggedNameColumnWidth] = useState<number | null>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const scrollFrame = useRef(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [hovered, setHovered] = useState<{ rowId: number; phaseIndex: number } | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sequence, setSequence] = useState<{ plan: SequencePlan; revision: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nameMeasureRef = useRef<HTMLDivElement>(null);
  const nameColumnDrag = useRef<NameColumnDrag | null>(null);
  const dragHintRef = useRef<HTMLParagraphElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const blankRef = useRef<BlankPointer | null>(null);
  const lastBlankRef = useRef<LastBlankClick | null>(null);
  const suppressClickRef = useRef(0);

  const isAdmin = permissions.isAdmin;
  const maxNameColumnWidth = Math.max(1, Math.min(nameColumnContentLimit, viewport.width - MIN_TIMELINE_WIDTH));
  const minNameColumnWidth = Math.min(MIN_NAME_COLUMN_WIDTH, Math.max(1, Math.floor(maxNameColumnWidth / MAX_NAME_COLUMN_SCALE)));
  const clampNameColumnWidth = (value: number) => Math.min(maxNameColumnWidth, Math.max(minNameColumnWidth, Math.round(value)));
  const nameColumnWidth = clampNameColumnWidth(draggedNameColumnWidth ?? ui.ganttNameColumnWidth ?? DEFAULT_NAME_COLUMN_WIDTH);
  const availableWidth = Math.max(1, viewport.width - nameColumnWidth);
  const rowHeight = ROW_HEIGHT[density];
  const ganttRowHeight = Math.max(24, rowHeight - 14);
  const preferredDayWidth = ganttRowHeight * 1.125;
  const fitDays = Math.max(1, Math.floor(availableWidth / preferredDayWidth));
  const baseDayWidth = ui.ganttRange.end ? preferredDayWidth : availableWidth / fitDays;
  const minZoom = Math.min(1, Math.max(1.25, availableWidth / 365) / baseDayWidth);
  const zoom = Math.min(1, Math.max(minZoom, ui.ganttZoom || 1));
  const dayWidth = baseDayWidth * zoom;
  const markerMode: MarkerMode = zoom >= 0.6 && dayWidth >= 12 ? "icon" : zoom >= 0.3 && dayWidth >= 4 ? "tick" : "hidden";
  const normalStart = ui.ganttRange.start || addDays(today, -Math.min(7, Math.floor(fitDays / 3)));
  const normalEnd = ui.ganttRange.end || addDays(normalStart, fitDays - 1);
  const fitToViewport = !ui.ganttRange.end && zoom === 1;
  const axisStart = normalStart;
  const axisEnd = useMemo(() => {
    if (fitToViewport) return normalEnd;
    const baseDays = Math.max(1, diffDays(normalStart, normalEnd) + 1);
    const visible = Math.max(zoom <= minZoom + 0.0001 ? 365 : 1, Math.ceil(availableWidth / Math.max(1, dayWidth)));
    return addDays(axisStart, Math.max(baseDays, visible) - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axisStart, normalEnd, normalStart, zoom, minZoom, availableWidth, dayWidth, fitToViewport]);
  const dates = useMemo(() => enumerateDates(axisStart, axisEnd), [axisStart, axisEnd]);
  const tableWidth = nameColumnWidth + (fitToViewport ? availableWidth : dates.length * dayWidth);
  const showReturnToStart = scroll.left >= Math.max(1, Math.min(30, diffDays(axisStart, today) + 1)) * dayWidth;
  const missingYears = unsupportedYears(calendar as never, [axisStart, axisEnd]);

  const domainColors = useMemo(() => {
    const map = new Map<string, { fill: string; ink: string }>();
    for (const row of rows) {
      if (map.has(row.domain)) continue;
      const fill = domainColor(row.domain, state.domains);
      map.set(row.domain, { fill, ink: colorFromHex(fill).ink });
    }
    return map;
  }, [rows, domainColor, state.domains]);

  const groups = useMemo(() => groupRequests(rows, state.users, calendar, ui.ganttRowOrder).filter((group) => group.rows.length > 0), [rows, state.users, calendar, ui.ganttRowOrder]);
  const anyExpanded = groups.some((group) => !ui.collapsedPeople.includes(group.developer));

  const resolved = useMemo(() => {
    const map = new Map<number, ResolvedRow>();
    for (const row of rows) {
      const plan = planOf(row, calendar);
      map.set(row.id, {
        plan,
        resolve: dayResolver(row, calendar),
        fillBounds: segmentFillBounds(row, calendar),
        delivery: plan.delivery,
        activeDays: requestActiveDays(row, calendar),
        live: currentLivePhase(row, today, calendar),
      });
    }
    return map;
  }, [rows, calendar, today]);

  const reorder = useRequestReorder({
    containerRef: wrapRef,
    rows,
    headerHeight: 49,
    onStart: () => { setMenu(null); setHovered(null); setSelectedIds(new Set()); setAnchorId(null); },
    blockedReason: (source, target) => {
      if (source.developer !== target.developer) return "请在同一开发人分组内排序";
      if (Boolean(resolved.get(source.id)?.plan.segments.length) !== Boolean(resolved.get(target.id)?.plan.segments.length)) return "未排期需求保持在分组末尾";
      return "";
    },
    onReorder: (source, target, edge) => {
      const row = rows.find((candidate) => candidate.id === source);
      if (!row) return;
      const group = groups.find((candidate) => candidate.developer === row.developer);
      const all = groupRequests(state.requests.filter((candidate) => !candidate.archived), state.users, calendar, ui.ganttRowOrder).find((candidate) => candidate.developer === row.developer);
      if (!group || !all) return;
      const order = reorderVisibleIds(all.rows.map((candidate) => candidate.id), group.rows.map((candidate) => candidate.id), source, target, edge);
      if (order) patch({ ganttRowOrder: { ...ui.ganttRowOrder, [row.developer]: order } });
    },
  });

  const selectedList = useMemo(() => rows.filter((row) => selectedIds.has(row.id)), [rows, selectedIds]);
  const allVisibleIds = useMemo(() => {
    const list: number[] = [];
    for (const group of groups) {
      if (ui.collapsedPeople.includes(group.developer)) continue;
      for (const row of group.rows) {
        list.push(row.id);
      }
    }
    return list;
  }, [groups, ui.collapsedPeople]);

  useEffect(() => {
    const visible = new Set(allVisibleIds);
    setSelectedIds((current) => [...current].every((id) => visible.has(id)) ? current : new Set([...current].filter((id) => visible.has(id))));
    setAnchorId((current) => current !== null && !visible.has(current) ? null : current);
  }, [allVisibleIds]);

  useEffect(() => {
    if (!selectedIds.size) return;
    const clear = () => { setSelectedIds(new Set()); setAnchorId(null); };
    const pointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="menu"], [role="dialog"]')) return;
      const name = target?.closest('[data-request-select]');
      if (name && wrapRef.current?.contains(name)) {
        const rowId = Number(name.closest<HTMLElement>('[data-row]')?.dataset.row);
        if (event.button === 0 || (event.button === 2 && selectedIds.has(rowId))) return;
      }
      clear();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !gestureRef.current && !document.querySelector('[role="menu"], [role="dialog"]')) clear();
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", key);
    };
  }, [selectedIds]);

  useLayoutEffect(() => {
    onFitDaysChange(fitDays);
  }, [fitDays, onFitDaysChange]);

  useLayoutEffect(() => {
    const measure = nameMeasureRef.current;
    const label = measure?.querySelector(`.${styles.requestName}`);
    if (!rows.length || !measure || !label) {
      setNameColumnContentLimit(DEFAULT_NAME_COLUMN_WIDTH);
      return;
    }
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const { fontWeight, fontSize, fontFamily } = getComputedStyle(label);
    context.font = `${fontWeight} ${fontSize} ${fontFamily}`;
    let widest = 0;
    for (const { name } of rows) {
      const text = name.replace(/[ \t\n\r\f]+/g, " ").replace(/^ | $/g, "");
      widest = Math.max(widest, context.measureText(text).width);
    }
    setNameColumnContentLimit(Math.floor((widest + measure.getBoundingClientRect().width) * MAX_NAME_COLUMN_SCALE));
  }, [rows]);

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const update = () => {
      const { clientWidth: width, clientHeight: height } = node;
      setViewport((current) => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const preventBrowserZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    node.addEventListener("wheel", preventBrowserZoom, { passive: false });
    return () => {
      observer.disconnect();
      node.removeEventListener("wheel", preventBrowserZoom);
    };
  }, []);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const node = wrapRef.current;
      if (!node) return;
      // Native scrolling stays on the compositor; React updates only when the buffered window moves.
      const left = Math.floor(node.scrollLeft / (dayWidth * 3)) * dayWidth * 3;
      const top = Math.floor(node.scrollTop / (ganttRowHeight * 4)) * ganttRowHeight * 4;
      setScroll((current) => current.left === left && current.top === top ? current : { left, top });
    });
  };

  useEffect(() => () => {
    if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current);
    if (nameColumnDrag.current) window.cancelAnimationFrame(nameColumnDrag.current.frame);
  }, []);

  const clearSelection = () => {
    setSelectedIds(new Set());
    setAnchorId(null);
  };

  const selectRow = useCallback((id: number, event?: ReactMouseEvent) => {
    if (!isAdmin) return;
    const row = rows.find((candidate) => candidate.id === id);
    if (!row || row.archived) return;
    const next = new Set(selectedIds);
    if (event?.shiftKey && anchorId !== null) {
      if (!event.ctrlKey && !event.metaKey) next.clear();
      const from = allVisibleIds.indexOf(anchorId);
      const to = allVisibleIds.indexOf(id);
      if (from >= 0 && to >= 0) {
        for (const candidate of allVisibleIds.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(candidate);
      }
    } else if (event?.ctrlKey || event?.metaKey) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setAnchorId(id);
    } else {
      next.clear();
      next.add(id);
      setAnchorId(id);
    }
    setSelectedIds(next);
  }, [isAdmin, rows, selectedIds, anchorId, allVisibleIds]);

  const openDayMenuFor = (rowId: number, date: string, x: number, y: number) => {
    if (!isAdmin) return;
    const row = rows.find((candidate) => candidate.id === rowId && !candidate.archived);
    if (!row) return;
    const info = dayResolver(row, calendar)(date);
    setMenu({ type: "day", rowId, date, phaseIndex: info.phaseIndex, x, y });
  };

  const openNameMenu = useCallback((rowId: number, x: number, y: number) => {
    if (!selectedIds.has(rowId)) {
      setSelectedIds(new Set());
      setAnchorId(null);
    }
    setMenu({ type: "request", rowId, x, y });
  }, [selectedIds]);

  const startGesture = (gesture: Gesture) => {
    gestureRef.current = gesture;
    previewRef.current = null;
    setPreview(null);
  };

  const finishGesture = () => {
    gestureRef.current = null;
    previewRef.current = null;
    setPreview(null);
  };

  const applyUpdate = async (next: ApiRequest, message: string) => {
    const before = rows.find((row) => row.id === next.id);
    if (!before) return false;
    const saved = await undo.save([{ before, after: next }], message);
    return saved;
  };

  const commitPreview = async (gesture: Gesture, current: Preview) => {
    const row = rows.find((candidate) => candidate.id === gesture.rowId);
    if (!row || !current.valid) {
      if (current.reason) notice.error(current.reason);
      return;
    }
    let next: ApiRequest | null = null;
    if (current.kind === "move" && current.start) {
      next = moveSegmentDates(row, gesture.phaseIndex, current.start, calendar);
    } else if (current.kind === "resize" && current.start && current.end) {
      const original = planOf(row, calendar).segments[gesture.phaseIndex];
      if (original) {
        next = gesture.edge === "start"
          ? resizeSegmentDates(row, gesture.phaseIndex, "start", current.start, calendar)
          : resizeSegmentDates(row, gesture.phaseIndex, "end", current.end, calendar);
      }
    } else if (current.kind === "add" && current.dates?.length) {
      next = supplementRequest(row, current.dates, calendar).request;
    }
    if (!next || JSON.stringify(next) === JSON.stringify(row)) return;
    await applyUpdate(next, current.kind === "move" ? "排期段已移动，其他需求保持原日期" : current.kind === "resize" ? "排期已更新" : `已补入 ${current.dates?.length ?? 0} 个开发日`);
  };

  const computePreview = (gesture: Gesture, delta: number): Preview | null => {
    const row = rows.find((candidate) => candidate.id === gesture.rowId);
    if (!row) return null;
    const plan = planOf(row, calendar);
    const withinRow = gesture.lastY >= (gesture.rowTop ?? 0) - 2 && gesture.lastY <= (gesture.rowBottom ?? 0) + 2;
    const withinGrid = gesture.lastX >= (gesture.wrapLeft ?? 0) + nameColumnWidth && gesture.lastX <= (gesture.wrapRight ?? window.innerWidth);
    if (gesture.kind === "move") {
      const segment = plan.segments[gesture.phaseIndex];
      if (!segment) return null;
      const target = addDays(segment.start, delta);
      const candidate = moveSegmentDates(row, gesture.phaseIndex, target, calendar);
      const reason = !withinRow ? "只能在当前需求行内移动" : !withinGrid ? "请在日期网格内放置" : !candidate ? "与本需求其他段重叠或在日期范围外，不能放置" : "";
      const nextPlan = candidate ? planOf(candidate, calendar) : plan;
      const moved = nextPlan.segments.find((item) => item.start === target) ?? plan.segments[gesture.phaseIndex]!;
      return {
        kind: "move",
        rowId: gesture.rowId,
        phaseIndex: gesture.phaseIndex,
        start: candidate ? moved.start : target,
        end: candidate ? moved.end : segment.end,
        valid: !reason,
        reason,
      };
    }
    if (gesture.kind === "resize") {
      const segment = plan.segments[gesture.phaseIndex];
      if (!segment) return null;
      const target = gesture.edge === "start" ? addDays(segment.start, delta) : addDays(segment.end, delta);
      const candidate = resizeSegmentDates(row, gesture.phaseIndex, gesture.edge ?? "end", target, calendar);
      const reason = !withinRow ? "只能调整当前需求行内的排期" : !withinGrid ? "请在日期轴内调整" : !candidate ? "至少保留 1 个开发日，且不能越过相邻段" : "";
      const nextPlan = candidate ? planOf(candidate, calendar) : plan;
      const resized = nextPlan.segments[gesture.phaseIndex] ?? segment;
      return {
        kind: "resize",
        rowId: gesture.rowId,
        phaseIndex: gesture.phaseIndex,
        start: resized.start,
        end: resized.end,
        valid: !reason,
        reason,
      };
    }
    if (gesture.kind === "add") {
      const origin = gesture.originDate ?? "";
      const current = addDays(origin, delta);
      const start = current < origin ? current : origin;
      const end = current > origin ? current : origin;
      const days = dates.filter((date) => {
        if (date < start || date > end) return false;
        const info = dayResolver(row, calendar)(date);
        return isWorkday(date, calendar) && !(row.vacation ?? []).includes(date) && !info.inSegment;
      });
      const reason = !withinRow ? "只能补充当前需求行的开发日期" : !withinGrid ? "请在日期轴内选择" : !days.length ? "没有可补入的工作日" : "";
      return {
        kind: "add",
        rowId: gesture.rowId,
        phaseIndex: -1,
        dates: days,
        valid: !reason,
        reason,
      };
    }
    return null;
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) {
          return;
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      if (!gesture.active) {
        if (Math.hypot(gesture.lastX - gesture.downX, gesture.lastY - gesture.downY) < 3) return;
        gesture.active = true;
      }
      const delta = Math.round((gesture.lastX - gesture.downX + (wrapRef.current?.scrollLeft ?? 0) - gesture.initialScroll) / Math.max(1, gesture.cellWidth));
      const next = computePreview(gesture, delta);
      if (next) {
        previewRef.current = next;
        setPreview(next);
      }
      event.preventDefault();
    };
    const onUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        const blank = blankRef.current;
        if (blank && blank.pointerId === event.pointerId) {
          if (Math.hypot(event.clientX - blank.x, event.clientY - blank.y) <= 5) {
            lastBlankRef.current = { ...blank, time: performance.now() };
          }
          blankRef.current = null;
        }
        return;
      }
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      const current = previewRef.current ?? computePreview(gesture, Math.round((gesture.lastX - gesture.downX + (wrapRef.current?.scrollLeft ?? 0) - gesture.initialScroll) / Math.max(1, gesture.cellWidth)));
      if ((gesture.active || gesture.kind === "add") && current) {
        suppressClickRef.current = performance.now() + 350;
        void commitPreview(gesture, current);
      } else if (gesture.kind === "move" && gesture.active === false) {
        openDayMenuFor(gesture.rowId, gesture.originDate ?? "", event.clientX, event.clientY);
      }
      finishGesture();
      event.preventDefault();
    };
    const onCancel = () => {
      finishGesture();
      blankRef.current = null;
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, calendar, dates, dayWidth, domainColors, nameColumnWidth]);

  useEffect(() => {
    if (!isAdmin) return;
    const onUndo = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return;
      if (gestureRef.current) {
        event.preventDefault();
        suppressClickRef.current = performance.now() + 350;
        finishGesture();
        blankRef.current = null;
        return;
      }
      if (isTextUndoTarget(event.target)) return;
      if (undo.undo()) event.preventDefault();
    };
    window.addEventListener("keydown", onUndo);
    return () => window.removeEventListener("keydown", onUndo);
  }, [isAdmin, undo]);

  const beginPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.button === 0 && target.closest("[data-gantt-column-resize]")) {
      if (!event.isPrimary || gestureRef.current || nameColumnDrag.current || minNameColumnWidth === maxNameColumnWidth) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      nameColumnDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: nameColumnWidth, nextWidth: nameColumnWidth, frame: 0 };
      setDraggedNameColumnWidth(nameColumnWidth);
      return;
    }
    if (nameColumnDrag.current) return;
    reorder.onPointerDown(event);
    if (!isAdmin) {
      return;
    }
    if (event.button !== 0 && event.button !== 2) return;
    const cell = target.closest<HTMLElement>("td[data-date]");
    const rowElement = target.closest<HTMLElement>("tr[data-row]");
    if (!cell || !rowElement) return;
    const rowId = Number(rowElement.dataset.row);
    const row = rows.find((candidate) => candidate.id === rowId);
    if (!row || row.archived) return;
    const wrap = wrapRef.current;
    const rect = rowElement.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const baseGesture: Omit<Gesture, "kind" | "phaseIndex" | "edge" | "originDate"> = {
      rowId,
      pointerId: event.pointerId,
      downX: event.clientX,
      downY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      cellWidth: dayWidth,
      initialScroll: wrap?.scrollLeft ?? 0,
      active: false,
      rowTop: rect.top,
      rowBottom: rect.bottom,
      wrapLeft: wrapRect?.left,
      wrapRight: wrapRect?.right,
    };
    const bar = target.closest<HTMLElement>("[data-bar]");
    const resize = target.closest<HTMLElement>("[data-resize]");
    if (event.button === 2 && bar) {
      event.preventDefault();
      startGesture({ ...baseGesture, kind: "move", phaseIndex: Number(bar.dataset.phase), originDate: cell.dataset.date });
      return;
    }
    if (event.button === 0 && resize) {
      event.preventDefault();
      startGesture({ ...baseGesture, kind: "resize", phaseIndex: Number(resize.dataset.phase), edge: resize.dataset.edge === "start" ? "start" : "end" });
      return;
    }
    if (event.button !== 0 || bar) return;
    if (!isAdmin) return;
    const origin = cell.dataset.date ?? "";
    const last = lastBlankRef.current;
    if (last && last.rowId === rowId && last.date === origin && performance.now() - last.time < 550 && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 7) {
      event.preventDefault();
      lastBlankRef.current = null;
      clearSelection();
      startGesture({ ...baseGesture, kind: "add", phaseIndex: -1, originDate: origin });
      return;
    }
    blankRef.current = { rowId, date: origin, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (selectedIds.size) clearSelection();
  };

  const moveNameColumn = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = nameColumnDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextWidth = clampNameColumnWidth(drag.startWidth + event.clientX - drag.startX);
    if (nextWidth === drag.nextWidth) return;
    drag.nextWidth = nextWidth;
    if (drag.frame) return;
    drag.frame = window.requestAnimationFrame(() => {
      drag.frame = 0;
      setDraggedNameColumnWidth(drag.nextWidth);
    });
  };

  const finishNameColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = nameColumnDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    window.cancelAnimationFrame(drag.frame);
    nameColumnDrag.current = null;
    setDraggedNameColumnWidth(null);
    if (event.type !== "pointerup") return;
    const nextWidth = clampNameColumnWidth(drag.startWidth + event.clientX - drag.startX);
    if (nextWidth !== drag.startWidth) patch({ ganttNameColumnWidth: nextWidth });
  };

  const resizeNameColumnByKey = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (nameColumnDrag.current) return;
    let nextWidth = nameColumnWidth;
    switch (event.key) {
      case "ArrowLeft": nextWidth -= 8; break;
      case "ArrowRight": nextWidth += 8; break;
      case "Home": nextWidth = minNameColumnWidth; break;
      case "End": nextWidth = maxNameColumnWidth; break;
      default: return;
    }
    event.preventDefault();
    patch({ ganttNameColumnWidth: clampNameColumnWidth(nextWidth) });
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rowElement = target.closest<HTMLElement>("tr[data-row]");
    if (!rowElement) return;
    const rowId = Number(rowElement.dataset.row);
    const name = target.closest<HTMLElement>("[data-request-select]");
    if (name) {
      event.preventDefault();
      event.stopPropagation();
      name.querySelector("button")?.focus({ preventScroll: true });
      const point = contextMenuPoint(event);
      openNameMenu(rowId, point.x, point.y);
      return;
    }
    if (gestureRef.current) {
      event.preventDefault();
      return;
    }
    if (!isAdmin) return;
    const cell = target.closest<HTMLElement>("td[data-date]");
    if (!cell) return;
    event.preventDefault();
    openDayMenuFor(rowId, cell.dataset.date ?? "", event.clientX, event.clientY);
  };

  const applyDayMark = async (row: ApiRequest, date: string, mark: "leave" | "overtime" | "clear-leave" | "clear-overtime") => {
    const vacation = new Set(row.vacation ?? []);
    const overtime = new Set(row.overtime ?? []);
    const working = isWorkday(date, calendar);
    if (mark === "leave" && working) {
      vacation.add(date);
      overtime.delete(date);
    }
    if (mark === "clear-leave") vacation.delete(date);
    if (mark === "overtime" && !working) {
      overtime.add(date);
      vacation.delete(date);
    }
    if (mark === "clear-overtime") overtime.delete(date);
    const next: ApiRequest = { ...row, vacation: [...vacation].sort(), overtime: [...overtime].sort() };
    await applyUpdate(next, "当天标记已保存");
  };

  const applyRemoveSegment = async (row: ApiRequest, phaseIndex: number) => {
    const next = removeSegment(row, phaseIndex, calendar);
    await applyUpdate(next, planOf(next, calendar).segments.length ? "已删除此段排期" : "已清空排期日期，预估人天保留");
  };

  const applySortByAdmission = () => {
    if (!isAdmin || selectedIds.size < 2) return;
    let changed = false;
    const nextOrder = { ...ui.ganttRowOrder };
    const people = new Set(selectedList.map((row) => row.developer));
    for (const person of people) {
      const group = groups.find((candidate) => candidate.developer === person);
      if (!group) continue;
      const order = admissionSortOrderForRows(group.rows, [...selectedIds], calendar);
      if (order) {
        nextOrder[person] = order;
        changed = true;
      }
    }
    if (!changed) {
      notice.notify("已选需求已按准入日期排列");
      return;
    }
    patch({ ganttRowOrder: nextOrder });
    notice.notify("已按准入日期升序排列，排期日期未改变");
  };

  const openSequence = () => {
    if (!isAdmin || selectedIds.size < 2) return;
    const plan = buildSequencePlan(state.requests, [...selectedIds], calendar);
    setSequence({ plan, revision: state.revision });
    setMenu(null);
  };

  const applySequence = async () => {
    if (!sequence) return;
    if (sequence.revision !== state.revision) {
      const plan = buildSequencePlan(state.requests, sequence.plan.ids, calendar);
      setSequence({ plan, revision: state.revision });
      notice.notify("数据已变化，顺排预览已更新，请重新核对。");
      return;
    }
    if (!sequence.plan.changes.length) {
      setSequence(null);
      return;
    }
    const saved = await undo.save(sequence.plan.changes, `顺排已应用，移动 ${sequence.plan.changes.length} 条需求`);
    if (saved) {
      setSequence(null);
      clearSelection();
    }
  };

  const zoomFromWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    const wrap = wrapRef.current;
    if (!wrap || gestureRef.current || nameColumnDrag.current) return;
    const before = dayWidth;
    const offset = Math.max(0, event.clientX - wrap.getBoundingClientRect().left - wrap.clientLeft - nameColumnWidth);
    const anchor = (wrap.scrollLeft + offset) / Math.max(0.001, before);
    const nextZoom = Math.min(1, Math.max(minZoom, zoom * Math.exp(-event.deltaY * 0.0025)));
    if (Math.abs(nextZoom - zoom) < 0.0001) return;
    patch({ ganttZoom: nextZoom });
    window.requestAnimationFrame(() => {
      const node = wrapRef.current;
      if (!node) return;
      node.scrollLeft = Math.max(0, anchor * (baseDayWidth * nextZoom) - offset);
    });
  };

  const resetZoom = () => {
    patch({ ganttZoom: 1 });
    if (wrapRef.current) wrapRef.current.scrollLeft = 0;
    notice.notify("已恢复默认比例和缩放前的日期范围");
  };

  const toggleGroup = (developer: string) => {
    const collapsed = ui.collapsedPeople.includes(developer);
    patch({ collapsedPeople: collapsed ? ui.collapsedPeople.filter((value) => value !== developer) : [...ui.collapsedPeople, developer] });
  };

  const expandAll = (expand: boolean) => {
    const groupIds = groups.map((group) => group.developer);
    if (expand) patch({ collapsedPeople: ui.collapsedPeople.filter((person) => !groupIds.includes(person)) });
    else patch({ collapsedPeople: [...new Set([...ui.collapsedPeople, ...groupIds])] });
  };

  const menuItems = (): { header?: { title: string; caption?: string }; items: ContextMenuItem[] } => {
    if (!menu) return { items: [] };
    if (menu.type === "request") {
      const row = rows.find((candidate) => candidate.id === menu.rowId);
      if (!row) return { items: [] };
      const multiple = isAdmin && selectedIds.size >= 2 && selectedIds.has(row.id);
      const canSort = selectedList.some((item) => {
        const group = groups.find((candidate) => candidate.developer === item.developer);
        return group ? admissionSortOrderForRows(group.rows, [...selectedIds], calendar) !== null : false;
      });
      return {
        header: { title: row.name, caption: multiple ? `已选 ${selectedIds.size} 项` : undefined },
        items: [
          ...requestMenuItems(row, { canEdit: permissions.canEdit, onOpen, onDelete, onArchive }),
          ...(multiple ? [
            { key: "sequence", label: "顺排预览", icon: ListOrdered, separatorBefore: true, onSelect: openSequence },
            { key: "sort", label: "按准入日期排序", icon: ArrowDownWideNarrow, disabled: !canSort, onSelect: applySortByAdmission },
            { key: "clear", label: "取消选中", icon: X, onSelect: () => clearSelection() },
          ] : []),
        ],
      };
    }
    const row = rows.find((candidate) => candidate.id === menu.rowId);
    if (!row) return { items: [] };
    const working = isWorkday(menu.date, calendar);
    const info = dayResolver(row, calendar)(menu.date);
    const items: ContextMenuItem[] = [];
    if (working) {
      items.push({ key: "leave", label: info.dayType === "leave" ? "取消休假" : "休假", icon: CalendarOff, onSelect: () => void applyDayMark(row, menu.date, info.dayType === "leave" ? "clear-leave" : "leave") });
    } else {
      items.push({ key: "overtime", label: info.overtime ? "取消加班" : "加班", icon: AlarmClockPlus, onSelect: () => void applyDayMark(row, menu.date, info.overtime ? "clear-overtime" : "overtime") });
    }
    if (menu.phaseIndex >= 0) {
      items.push({ key: "delete", label: "删除此段排期", icon: X, danger: true, separatorBefore: true, onSelect: () => void applyRemoveSegment(row, menu.phaseIndex) });
    }
    return {
      header: { title: row.name, caption: `${row.developer ? state.users.find((user) => user.id === row.developer)?.username ?? "-" : "-"}　${menu.date} · ${working ? "工作日" : "休息日"}` },
      items,
    };
  };

  // ---------- 可见区虚拟化：日期列 + 人员/需求行 ----------
  const headerHeight = 49;
  const bufferDays = 4;
  const dateStart = Math.max(0, Math.min(dates.length, Math.floor(scroll.left / Math.max(1, dayWidth)) - bufferDays));
  const dateEnd = Math.max(dateStart, Math.min(dates.length, Math.ceil((scroll.left + availableWidth) / Math.max(1, dayWidth)) + bufferDays));
  const visibleDates = useMemo(() => dates.slice(dateStart, dateEnd), [dates, dateStart, dateEnd]);
  const leftHidden = dateStart;
  const rightHidden = dates.length - dateEnd;
  const visibleMonthGroups = useMemo(() => monthGroups(visibleDates), [visibleDates]);
  const visibleDateHeaders = useMemo(() => dateHeaders(visibleDates, dayWidth, today, calendar), [visibleDates, dayWidth, today, calendar]);

  type VirtualItem = { kind: "group"; group: (typeof groups)[number] } | { kind: "request"; row: ApiRequest; group: (typeof groups)[number] };
  const items: VirtualItem[] = [];
  for (const group of groups) {
    items.push({ kind: "group", group });
    if (!ui.collapsedPeople.includes(group.developer)) {
      for (const row of group.rows) items.push({ kind: "request", row, group });
    }
  }
  const itemHeights = items.map((item) => (item.kind === "group" ? PERSON_ROW_HEIGHT : ganttRowHeight));
  const offsets: number[] = [0];
  for (let index = 0; index < itemHeights.length; index += 1) offsets.push(offsets[index]! + itemHeights[index]!);
  const totalHeight = offsets[offsets.length - 1] ?? 0;
  const overscan = 280;
  const startPixel = Math.max(0, scroll.top - headerHeight - overscan);
  const endPixel = scroll.top - headerHeight + viewport.height + overscan;
  let firstItem = 0;
  while (firstItem < items.length && (offsets[firstItem + 1] ?? 0) <= startPixel) firstItem += 1;
  let lastItem = firstItem;
  while (lastItem < items.length && (offsets[lastItem] ?? 0) < endPixel) lastItem += 1;
  const topSpacer = offsets[firstItem] ?? 0;
  const bottomSpacer = Math.max(0, totalHeight - (offsets[lastItem] ?? totalHeight));
  const visibleItems = items.slice(firstItem, lastItem);
  const totalColumns = dates.length + 1;

  const showMarkers = markerMode !== "hidden";
  const badgeMap = useMemo(() => new Map((showMarkers ? groups : []).map((group) => [group.developer, overlapBadges(group.rows, visibleDates, calendar)])), [groups, visibleDates, calendar, showMarkers]);

  const sequenceOpen = Boolean(sequence);

  useLayoutEffect(() => {
    const hint = dragHintRef.current;
    const wrap = wrapRef.current;
    const gesture = gestureRef.current;
    if (!hint || !wrap || !preview || !gesture) return;
    const position = () => {
      const bounds = wrap.getBoundingClientRect();
      const start = preview.start ?? preview.dates?.[0];
      const end = preview.end ?? preview.dates?.at(-1);
      const gridLeft = bounds.left + nameColumnWidth + wrap.clientLeft;
      const gridRight = bounds.left + wrap.clientWidth;
      const left = start ? gridLeft + diffDays(axisStart, start) * dayWidth - wrap.scrollLeft : gesture.lastX;
      const right = end ? gridLeft + (diffDays(axisStart, end) + 1) * dayWidth - wrap.scrollLeft : gesture.lastX;
      const center = (Math.max(gridLeft, Math.min(gridRight, left)) + Math.max(gridLeft, Math.min(gridRight, right))) / 2;
      const { width, height } = hint.getBoundingClientRect();
      const rowTop = wrap.querySelector(`tr[data-row="${preview.rowId}"]`)?.getBoundingClientRect().top ?? gesture.rowTop ?? gesture.lastY;
      hint.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, center - width / 2))}px`;
      hint.style.top = `${Math.max(8, rowTop - height - 6)}px`;
    };
    let frame = 0;
    const schedulePosition = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; position(); });
    };
    position();
    wrap.addEventListener("scroll", schedulePosition, { passive: true });
    window.addEventListener("resize", schedulePosition);
    return () => {
      cancelAnimationFrame(frame);
      wrap.removeEventListener("scroll", schedulePosition);
      window.removeEventListener("resize", schedulePosition);
    };
  }, [preview, axisStart, dayWidth, nameColumnWidth]);

  return (
    <div className={styles.page}>
      <div className={styles.plotArea} data-scroll-container="gantt-content">
        {missingYears.length ? <p className={styles.calendarHint}>节假日日历未覆盖 {missingYears.join("、")} 年，该范围按普通周末计算。</p> : null}

        <div className={styles.calendarViewport} data-column-dragging={draggedNameColumnWidth !== null || undefined} style={{
          minHeight: Math.min(160, headerHeight + (items.length ? totalHeight : 64)),
          "--name-column-width": `${nameColumnWidth}px`,
          "--gantt-viewport-height": `${viewport.height}px`,
        } as CSSProperties}>
          <div ref={nameMeasureRef} className={styles.nameMeasure} aria-hidden="true">
            <div className={styles.nameContent}><PriorityTag value="P0" /><span className={styles.requestName} /></div>
          </div>
          <div ref={wrapRef} className={`${styles.calendarWrap} ${reorder.className}`} data-scroll-container="gantt"
            onWheel={zoomFromWheel} onContextMenu={onContextMenu} onPointerDown={beginPointer} onPointerMove={moveNameColumn}
            onPointerUp={finishNameColumnResize} onPointerCancel={finishNameColumnResize} onLostPointerCapture={finishNameColumnResize}
            onClickCapture={reorder.onClickCapture} onDoubleClickCapture={reorder.onDoubleClickCapture} onScroll={onScroll}>
            <table className={styles.calendar} aria-label="按天显示的人员需求排期" data-marker-mode={markerMode} style={{ width: tableWidth, ["--day-width" as string]: `${dayWidth}px`, ["--gantt-row-height" as string]: `${ganttRowHeight}px`, ["--person-row-height" as string]: `${PERSON_ROW_HEIGHT}px`, ["--marker-size" as string]: `${Math.max(8, 12 * zoom)}px`, ["--parallel-scale" as string]: zoom } as CSSProperties}>
              <thead>
                <tr>
                  <th className={styles.nameHead} rowSpan={2} scope="col">
                    <button type="button" className={styles.groupToggle} aria-label={anyExpanded ? "全部收起" : "全部展开"} aria-expanded={anyExpanded} disabled={!groups.length} data-tooltip={anyExpanded ? "收起当前筛选内的所有人员" : "展开当前筛选内的所有人员"} onClick={() => expandAll(!anyExpanded)}>
                      <span>优先级 / 需求</span><ChevronDown aria-hidden="true" />
                    </button>
                    <span className={styles.nameResizeHandle} data-gantt-column-resize role="separator" aria-label="调整需求列宽"
                      aria-orientation="vertical" aria-valuemin={minNameColumnWidth} aria-valuemax={maxNameColumnWidth} aria-valuenow={nameColumnWidth}
                      tabIndex={minNameColumnWidth < maxNameColumnWidth ? 0 : -1} onKeyDown={resizeNameColumnByKey} />
                  </th>
                  {leftHidden > 0 ? <th className={styles.monthSpacer} aria-hidden="true" colSpan={leftHidden} style={{ width: leftHidden * dayWidth }} /> : null}
                  {visibleMonthGroups.map((month) => {
                    const [year, number] = month.key.split("-").map(Number);
                    const label = month.count * dayWidth < 24 ? "" : month.count < 6 || month.count * dayWidth < 110 ? (number === 1 ? `${year} / ${number}` : `${number} 月`) : `${year} 年 ${number} 月`;
                    return (
                      <th key={month.key} className={`${styles.monthCell} ${month.count < 4 ? styles.monthShort : ""}`} colSpan={month.count} scope="colgroup" style={{ width: month.count * dayWidth }} data-tooltip={`${year} 年 ${number} 月`}>
                        <span className={styles.monthDimension}>
                          <span className={styles.monthArm} aria-hidden="true" />
                          <span className={styles.monthLabel}>{label}</span>
                          <span className={styles.monthArm} aria-hidden="true" />
                        </span>
                      </th>
                    );
                  })}
                  {rightHidden > 0 ? <th className={styles.monthSpacer} aria-hidden="true" colSpan={rightHidden} style={{ width: rightHidden * dayWidth }} /> : null}
                </tr>
                <tr>
                  {leftHidden > 0 ? <th className={styles.dateSpacer} aria-hidden="true" colSpan={leftHidden} style={{ width: leftHidden * dayWidth, height: 22 }} /> : null}
                  {visibleDateHeaders.map((header) => (
                    <th
                      key={header.date}
                      className={`${styles.dateCell} ${header.rest ? styles.rest : ""} ${header.current ? styles.current : ""} ${header.monthStart ? styles.monthStart : ""} ${dayWidth >= 20 ? styles.dateHeaderScale : ""}`}
                      scope="col"
                      aria-current={header.current ? "date" : undefined}
                      aria-label={`${header.date}${header.current ? "，今天" : ""}`}
                    >
                      <span className={styles.monthLabel} aria-hidden="true">{header.tick ? Number(header.date.slice(-2)) : ""}</span>
                    </th>
                  ))}
                  {rightHidden > 0 ? <th className={styles.dateSpacer} aria-hidden="true" colSpan={rightHidden} style={{ width: rightHidden * dayWidth, height: 22 }} /> : null}
                </tr>
              </thead>
              <tbody>
                {topSpacer > 0 ? <tr aria-hidden="true"><td colSpan={totalColumns} style={{ height: topSpacer, padding: 0, border: 0 }} /></tr> : null}
                {visibleItems.map((item) => {
                  if (item.kind === "group") {
                    const group = item.group;
                    const collapsed = ui.collapsedPeople.includes(group.developer);
                    return (
                      <tr key={`group-${group.developer || "__unassigned"}`} className={styles.personRow} onClick={() => toggleGroup(group.developer)}>
                        <th scope="rowgroup">
                          <button type="button" className={styles.personToggle} aria-expanded={!collapsed} aria-label={`${collapsed ? "展开" : "收起"}${group.name}的 ${group.rows.length} 条需求`} data-tooltip={`${group.name}${group.deleted ? "（已删除）" : ""} · ${group.rows.length} 条需求`}>
                            <ChevronDown className={styles.personChevron} aria-hidden="true" />
                            <span className={styles.personName}>{group.name}{group.deleted ? "（已删除）" : ""}</span>
                            <span className={styles.personCount}>{group.rows.length} 条</span>
                          </button>
                          <span className={styles.nameResizeHandle} data-gantt-column-resize aria-hidden="true" />
                        </th>
                        <td colSpan={dates.length} aria-hidden="true" />
                      </tr>
                    );
                  }
                  const row = item.row;
                  const data = resolved.get(row.id);
                  if (!data) return null;
                  return <GanttRequestRow
                    key={row.id}
                    row={row}
                    groupEnd={item.group.rows.at(-1)?.id === row.id}
                    data={data}
                    calendar={calendar}
                    visibleDates={visibleDates}
                    leftHidden={leftHidden}
                    rightHidden={rightHidden}
                    dayWidth={dayWidth}
                    markerMode={markerMode}
                    color={domainColors.get(row.domain) ?? DEFAULT_COLOR}
                    groupBadges={badgeMap.get(item.group.developer) ?? EMPTY_BADGES}
                    preview={preview?.rowId === row.id ? preview : null}
                    hoveredPhase={hovered?.rowId === row.id ? hovered.phaseIndex : -1}
                    rowSelected={selectedIds.has(row.id)}
                    isAdmin={isAdmin}
                    canEdit={permissions.canEdit}
                    today={today}
                    suppressClickRef={suppressClickRef}
                    selectRow={selectRow}
                    onOpen={onOpen}
                    onNameMenu={openNameMenu}
                    setHovered={setHovered}
                  />;
                })}
                {bottomSpacer > 0 ? <tr aria-hidden="true"><td colSpan={totalColumns} style={{ height: bottomSpacer, padding: 0, border: 0 }} /></tr> : null}
                {!items.length ? (
                  <tr><td className={styles.empty} colSpan={totalColumns}>没有匹配的需求</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {zoom < 0.999 ? (
            <button type="button" className={styles.resetZoom} aria-label="重置比例" data-tooltip="恢复默认比例及缩放前的日期范围" onClick={resetZoom}><RotateCcw aria-hidden="true" /></button>
          ) : null}
          {showReturnToStart ? (
            <button type="button" className={styles.returnToStart} aria-label="返回最左侧" data-tooltip="回到时间轴起点" onClick={() => wrapRef.current?.scrollTo({ left: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}>
              <ArrowLeftToLine aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.legend} aria-label="甘特图图例" data-testid="gantt-legend">
        <span className={styles.summary} aria-label="需求数量">{rows.length === totalCount ? `${totalCount} 条需求` : `显示 ${rows.length} / 共 ${totalCount} 条需求`}</span>
        <span data-tooltip="尚未预估开发人天，暂按 3 个工作日占位"><Hourglass aria-hidden="true" />待估人天</span>
        <span data-tooltip="两段之间含工作日的手动暂停，图标居中、细线连接两侧排期"><CirclePause aria-hidden="true" />HOLD</span>
        <span data-tooltip="同一开发人的连续交叠区域只显示一组箭头，需求保持原色"><span className={styles.parallelSymbol}><ArrowBigUp className={styles.arrowUp} preserveAspectRatio="none" aria-hidden="true" /><ArrowBigDown className={styles.arrowDown} preserveAspectRatio="none" aria-hidden="true" /></span>需求并行</span>
        <span data-tooltip="非工作日手动安排开发"><AlarmClockPlus aria-hidden="true" />加班</span>
        <span data-tooltip="个人主动请假，区别于法定节假日和周末"><CalendarOff aria-hidden="true" />休假</span>
        {isAdmin ? <span className={styles.selectionHint} data-tooltip="单击起始需求，再按住 Shift 单击末尾需求；右键选中需求可预览顺排，点击其他位置取消选择。">Shift 连选 · 右键顺排{selectedIds.size ? <strong role="status">已选 {selectedIds.size} 项</strong> : null}</span> : null}
        {draftHint ? <span className={styles.draftHint}>有未提交草稿</span> : null}
      </div>
      <p
        ref={dragHintRef}
        className={styles.dragStatus}
        aria-live="polite"
        data-slot="gantt-drag-hint"
      >
        {preview ? `${preview.valid ? "" : preview.reason ? preview.reason + " · " : ""}${preview.kind === "add" && preview.dates ? `松开补入 ${preview.dates.length} 个开发日` : preview.start && preview.end ? `${preview.start} 至 ${preview.end}` : ""}` : ""}
      </p>

      <ContextMenu open={Boolean(menu && rows.some((row) => row.id === menu.rowId))} x={menu?.x ?? 0} y={menu?.y ?? 0} onClose={() => setMenu(null)} header={menuItems().header} items={menuItems().items} ariaLabel={menu?.type === "request" ? "需求操作" : "编辑当天安排"} scrollContainer={wrapRef.current} />

      <Drawer
        open={sequenceOpen}
        onOpenChange={(open) => { if (!open) setSequence(null); }}
        title="顺排预览"
        className={previewStyles.drawer}
        caption={sequence ? `已选 ${sequence.plan.ids.length} 项，将移动 ${sequence.plan.changes.length} 项${sequence.plan.changes.some((change) => !change.selected) ? `，含 ${sequence.plan.changes.filter((change) => !change.selected).length} 项未选需求随动` : ""}` : undefined}
        footer={sequence ? (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setSequence(null)}>取消</Button>
            <Button variant="primary" disabled={!sequence.plan.changes.length} onClick={() => void applySequence()}>应用顺排</Button>
          </div>
        ) : null}
      >
        {sequence ? (
          <>
            <p className={styles.sequenceSummary}>按开发人分别向后顺排，开发人天不变，分段及 HOLD 标记保留。未选需求保持前后衔接和交叠关系；休假/加班标记随排期移动。</p>
            <SequencePreview requests={state.requests} users={state.users} calendar={calendar} sequence={sequence.plan} colorFor={(domain) => domainColor(domain, state.domains)} />
            {sequence.plan.warnings.length ? <ul className={styles.sequenceWarnings}>{sequence.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
});


interface ResolvedRow {
  plan: GanttPlan;
  resolve: (date: string) => DayInfo;
  fillBounds: ReturnType<typeof segmentFillBounds>;
  delivery: string;
  activeDays: number;
  live: number;
}

const DEFAULT_COLOR = { fill: "#8994a7", ink: "#ffffff" };
const EMPTY_BADGES = new Map<string, OverlapBadge>();

interface GanttRowProps {
  row: ApiRequest;
  groupEnd: boolean;
  data: ResolvedRow;
  calendar: Calendar;
  visibleDates: string[];
  leftHidden: number;
  rightHidden: number;
  dayWidth: number;
  markerMode: MarkerMode;
  color: { fill: string; ink: string };
  groupBadges: Map<string, OverlapBadge>;
  preview: Preview | null;
  hoveredPhase: number;
  rowSelected: boolean;
  isAdmin: boolean;
  canEdit: boolean;
  today: string;
  suppressClickRef: RefObject<number>;
  selectRow: (id: number, event?: ReactMouseEvent) => void;
  onOpen: (id: number) => void;
  onNameMenu: (id: number, x: number, y: number) => void;
  setHovered: Dispatch<SetStateAction<{ rowId: number; phaseIndex: number } | null>>;
}

const GanttRequestRow = memo(function GanttRequestRow({
  row, groupEnd, data: state, calendar, visibleDates, leftHidden, rightHidden, dayWidth, markerMode,
  color, groupBadges, preview, hoveredPhase, rowSelected, isAdmin, canEdit,
  today, suppressClickRef, selectRow, onOpen, onNameMenu, setHovered,
}: GanttRowProps) {
  const { plan, resolve, delivery, live } = state;
  const hovered = hoveredPhase >= 0 ? { rowId: row.id, phaseIndex: hoveredPhase } : null;
  const isHovered = Boolean(hovered);
  const holds = useMemo(() => holdLayout(row, visibleDates, calendar), [row, visibleDates, calendar]);
  const estimates = useMemo(() => estimateCenters(row, visibleDates, calendar), [row, visibleDates, calendar]);
  const previewCell = (_rowId: number, date: string): "valid" | "invalid" | null => {
    if (!preview) return null;
    const included = preview.kind === "add" ? preview.dates?.includes(date) : preview.start && preview.end && date >= preview.start && date <= preview.end;
    return included ? preview.valid ? "valid" : "invalid" : null;
  };
  return (
    <tr data-row={row.id} aria-selected={rowSelected} className={rowSelected ? styles.rowSelected : ""} style={{ "--task-fill": color.fill, "--task-ink": color.ink } as CSSProperties}>
      <th className={styles.nameCell} scope="row" data-request-select onClick={(event) => {
        if (!(event.target as Element).closest("[data-name]") && performance.now() >= suppressClickRef.current) selectRow(row.id, event);
      }}>
        <span className={styles.groupGuide} data-slot="gantt-group-guide" data-group-end={groupEnd ? "" : undefined} aria-hidden="true" />
        <div className={styles.nameContent} data-request-name>
          <PriorityTag value={row.priority} />
          <button
            type="button"
            className={styles.requestName}
            data-name
            data-tooltip={`${row.name}　${state.activeDays}人天`}
            aria-pressed={rowSelected}
            aria-haspopup="menu"
            onClick={(event) => { if (performance.now() < suppressClickRef.current) return; selectRow(row.id, event); }}
            onDoubleClick={() => { if (!canEdit) onOpen(row.id); }}
            onKeyDown={(event) => {
              if (isContextMenuKey(event)) {
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                onNameMenu(row.id, rect.left, rect.bottom);
              } else if (event.key === "Enter" && !canEdit) {
                event.preventDefault();
                onOpen(row.id);
              }
            }}
          >
            {row.name}
          </button>
        </div>
        <span className={styles.nameResizeHandle} data-gantt-column-resize aria-hidden="true" />
      </th>
      {leftHidden > 0 ? <td aria-hidden="true" colSpan={leftHidden} style={{ width: leftHidden * dayWidth }} /> : null}
      {visibleDates.map((date) => {
        const info = resolve(date);
        const phase = info.phaseIndex;
        const segment = plan.segments[phase];
        const fill = state.fillBounds[phase];
        const filled = Boolean(fill && date >= fill.start && date <= fill.end);
        const cellPreview = previewCell(row.id, date);
        const showDelivery = (rowSelected || (isHovered && hovered?.phaseIndex === phase)) && date === delivery && phase >= 0;
        const bar = phase >= 0;
        const classes = [
          styles.square,
          !isWorkday(date, calendar) ? styles.rest : "",
          date === today ? styles.current : "",
          info.dayType === "leave" ? styles.leaveDay : "",
          cellPreview === "valid" ? styles.dropValid : cellPreview === "invalid" ? styles.dropInvalid : "",
          cellPreview && date === preview?.start ? styles.previewStart : "",
          cellPreview && date === preview?.end ? styles.previewEnd : "",
          cellPreview === "valid" && preview?.kind === "add" ? styles.addPreview : "",
        ].filter(Boolean).join(" ");
        const badge = groupBadges.get(`${row.id}|${date}`);
        const hold = holds.get(date);
        const sharesHoldCenter = hold?.centerOffset === 0;
        const standaloneMarkerMode = sharesHoldCenter && markerMode === "icon" ? "tick" : markerMode;
        return (
          <td key={date} className={classes} data-date={date} data-tooltip={hold ? "手动标记的 HOLD 暂停间隔" : undefined} aria-label={`${row.name}，${date}${info.active ? "，开发排期" : ""}${info.hold ? "，HOLD" : ""}${info.dayType === "leave" ? "，休假" : info.overtime ? "，加班" : ""}`}>
            {hold ? (
              <span className={styles.holdFill} data-hold-connector aria-hidden="true">
                {hold.centerOffset !== null ? (
                  <span className={styles.holdCenter} style={{ left: `calc(50% + ${hold.centerOffset * dayWidth}px)` }}>
                    <CellMarker kind="hold" mode={markerMode} />
                  </span>
                ) : null}
              </span>
            ) : null}
            {bar ? (
              <div
                data-bar
                data-phase={phase}
                role="button"
                tabIndex={0}
                data-tooltip={`${row.name}　${state.activeDays}人天`}
                className={[styles.barPiece, info.active ? "" : styles.inactive, !filled ? styles.unfilled : "", info.active && (Number(row.days) || 0) === 0 ? styles.estimated : "", date === fill?.start ? styles.barStart : "", date === fill?.end ? styles.barEnd : "", filled && hovered?.rowId === row.id && hovered?.phaseIndex === phase ? styles.dayGrid : "", live === phase && info.active ? styles.livePhase : ""].filter(Boolean).join(" ")}
                aria-label={`${row.name}，${date}${info.active ? "，开发排期" : "，非开发日"}`}
                onPointerOver={() => setHovered((current) => current?.rowId === row.id && current.phaseIndex === phase ? current : { rowId: row.id, phaseIndex: phase })}
                onPointerOut={(event) => { if (!(event.relatedTarget as Element | null)?.closest?.("[data-bar]")) setHovered(null); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRow(row.id, event as unknown as ReactMouseEvent); } }}
              >
                {markerMode !== "hidden" && dayWidth >= 6 && live === phase && info.active ? <FloatingPoints seed={`${row.id}-${date}`} compact={markerMode !== "icon"} /> : null}
                {info.active && info.overtime ? <CellMarker kind="overtime" mode={markerMode} /> : null}
                {info.dayType === "leave" ? <CellMarker kind="leave" mode={markerMode} /> : null}
                {info.active && (Number(row.days) || 0) === 0 && estimates.has(date) ? <CellMarker kind="estimated" mode={markerMode} /> : null}
                {showDelivery ? <span className={styles.deliveryGuide} aria-hidden="true" /> : null}
                {isAdmin ? (
                  <>
                    {date === segment!.start ? <span className={styles.barHandle} data-resize data-edge="start" data-phase={phase} aria-hidden="true" /> : null}
                    {date === segment!.end ? <span className={styles.barHandle} data-resize data-edge="end" data-phase={phase} aria-hidden="true" /> : null}
                  </>
                ) : null}
              </div>
            ) : info.dayType === "leave" ? (
              <span className={styles.markOnly} data-hold-center={sharesHoldCenter ? "" : undefined}><CellMarker kind="leave" mode={standaloneMarkerMode} /></span>
            ) : info.dayType === "overtime" ? (
              <span className={styles.markOnly} data-hold-center={sharesHoldCenter ? "" : undefined}><CellMarker kind="overtime" mode={standaloneMarkerMode} /></span>
            ) : null}
            {badge ? (
              <span className={styles.parallelExchange} data-parallel data-marker="parallel" data-marker-mode={markerMode} style={{ left: `calc(50% + ${badge.offset / 24 * dayWidth}px)` }} aria-hidden="true">
                {markerMode === "tick" ? <span className={styles.parallelTicks} /> : (
                  <span className={styles.parallelSymbol}>
                    <ArrowBigUp className={styles.arrowUp} preserveAspectRatio="none" aria-hidden="true" />
                    <ArrowBigDown className={styles.arrowDown} preserveAspectRatio="none" aria-hidden="true" />
                  </span>
                )}
              </span>
            ) : null}
          </td>
        );
      })}
      {rightHidden > 0 ? <td aria-hidden="true" colSpan={rightHidden} style={{ width: rightHidden * dayWidth }} /> : null}
    </tr>
  );
});

const MARKER_ICONS = { hold: CirclePause, leave: CalendarOff, overtime: AlarmClockPlus, estimated: Hourglass };

function CellMarker({ kind, mode }: { kind: keyof typeof MARKER_ICONS; mode: MarkerMode }) {
  if (mode === "hidden") return null;
  const Icon = MARKER_ICONS[kind];
  return (
    <span className={styles.cellMarker} data-marker={kind} data-marker-mode={mode} aria-hidden="true">
      {mode === "icon" ? <Icon className={styles.cellIcon} /> : <span className={styles.markerTick} />}
    </span>
  );
}

function FloatingPoints({ seed, compact }: { seed: string; compact: boolean }) {
  const points = useMemo(() => {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 997;
    return Array.from({ length: compact ? 1 : 2 }, (_, index) => ({
      x: 18 + ((hash * (index + 3)) % 64),
      y: 25 + ((hash * (index + 5)) % 50),
      size: index % 2 === 0 ? 1.5 : 1,
      duration: 4.5 + index * 1.2,
      delay: -(index * 0.83 + (hash % 20) * 0.13),
    }));
  }, [seed, compact]);
  return (
    <span className={styles.floatingPoints} data-live-particles aria-hidden="true">
      <span className={styles.liveSheen} />
      {points.map((point, index) => (
        <i key={index} className={styles.floatingPoint} style={{ left: `${point.x}%`, top: `${point.y}%`, width: point.size, height: point.size, ["--point-duration" as string]: `${point.duration}s`, ["--point-delay" as string]: `${point.delay}s` } as CSSProperties} />
      ))}
    </span>
  );
}
