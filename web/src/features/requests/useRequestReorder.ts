import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { ApiRequest } from "../../api/types";
import type { DropEdge } from "./rowOrder";
import styles from "./RequestReorder.module.css";

export type RequestDrop =
  | { kind: "row"; row: ApiRequest; edge: DropEdge }
  | { kind: "group"; developer: string; name: string };

interface Options {
  containerRef: RefObject<HTMLDivElement | null>;
  rows: ApiRequest[];
  enabled?: boolean;
  headerHeight: number;
  resolveDrop?: (source: ApiRequest, target: RequestDrop) => RequestDrop | string;
  onReorder: (source: ApiRequest, target: RequestDrop) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

interface Drag {
  id: number;
  pointerId: number;
  x: number;
  y: number;
  downX: number;
  downY: number;
  active: boolean;
  target: RequestDrop | null;
}

export function useRequestReorder(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const drag = useRef<Drag | null>(null);
  const hint = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const suppressUntil = useRef(0);
  const cleanupRef = useRef<() => void>(() => {});

  useEffect(() => {
    const clearMarks = () => {
      latest.current.containerRef.current?.querySelectorAll("[data-reorder-source], [data-reorder-edge], [data-reorder-group-target]").forEach((node) => {
        node.removeAttribute("data-reorder-source");
        node.removeAttribute("data-reorder-edge");
        node.removeAttribute("data-reorder-group-target");
      });
    };
    const cleanup = () => {
      const active = drag.current?.active;
      if (active) suppressUntil.current = performance.now() + 350;
      drag.current = null;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      hint.current?.remove();
      hint.current = null;
      clearMarks();
      latest.current.containerRef.current?.removeAttribute("data-reordering");
      if (active) latest.current.onEnd?.();
    };
    cleanupRef.current = cleanup;
    const update = () => {
      frame.current = 0;
      const current = drag.current;
      const { containerRef, rows, headerHeight, resolveDrop } = latest.current;
      const container = containerRef.current;
      const source = rows.find((row) => row.id === current?.id);
      if (!current?.active || !container || !source || source.archived) { cleanup(); return; }
      const bounds = container.getBoundingClientRect();
      const inBounds = current.x >= bounds.left && current.x < bounds.right && current.y >= bounds.top + headerHeight && current.y < bounds.bottom;
      const targetElement = inBounds ? document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>("[data-row], [data-reorder-group]") : null;
      clearMarks();
      container.querySelector(`[data-row="${source.id}"]`)?.setAttribute("data-reorder-source", "true");
      current.target = null;
      let label = "";
      let suffix = "";
      if (targetElement && container.contains(targetElement)) {
        const { row, reorderGroup, reorderGroupName } = targetElement.dataset;
        const request = rows.find((candidate) => candidate.id === Number(row));
        let target: RequestDrop | undefined;
        if (request && request.id !== source.id) {
          const rect = targetElement.getBoundingClientRect();
          target = { kind: "row", row: request, edge: current.y < rect.top + rect.height / 2 ? "before" : "after" };
        } else if (reorderGroup !== undefined && reorderGroupName !== undefined) {
          target = { kind: "group", developer: reorderGroup, name: reorderGroupName };
        }
        const result = target && (resolveDrop ? resolveDrop(source, target) : target);
        if (typeof result === "string") label = result;
        else if (result?.kind === "row") {
          current.target = result;
          targetElement.dataset.reorderEdge = result.edge;
          label = `在「${result.row.name}`;
          suffix = result.edge === "before" ? "」前" : "」后";
        } else if (result) {
          current.target = result;
          targetElement.dataset.reorderGroupTarget = "true";
          label = `移至「${result.name}`;
          suffix = "」分组";
        }
      }
      const bubble = hint.current;
      if (bubble && label) {
        const text = bubble.firstElementChild!;
        const direction = bubble.lastElementChild!;
        if (text.textContent !== label) text.textContent = label;
        if (direction.textContent !== suffix) direction.textContent = suffix;
        bubble.dataset.valid = String(current.target !== null);
        bubble.hidden = false;
        const rect = bubble.getBoundingClientRect();
        bubble.style.transform = `translate3d(${Math.max(8, Math.min(innerWidth - rect.width - 8, current.x + 14))}px, ${Math.max(8, Math.min(innerHeight - rect.height - 8, current.y + 16))}px, 0)`;
      } else if (bubble) {
        bubble.hidden = true;
      }
      if (current.x >= bounds.left && current.x < bounds.right) {
        const top = bounds.top + headerHeight;
        const speed = current.y < top + 32 ? -Math.min(14, (top + 32 - current.y) / 3) : current.y > bounds.bottom - 32 ? Math.min(14, (current.y - bounds.bottom + 32) / 3) : 0;
        if (speed) {
          const before = container.scrollTop;
          container.scrollTop += speed;
          if (before !== container.scrollTop) frame.current = requestAnimationFrame(update);
        }
      }
    };
    const scheduleUpdate = () => {
      if (drag.current?.active && !frame.current) frame.current = requestAnimationFrame(update);
    };
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.active && Math.hypot(current.x - current.downX, current.y - current.downY) < 5) return;
      if (!(event.buttons & 1) || latest.current.enabled === false) { cleanup(); return; }
      event.preventDefault();
      if (!current.active) {
        if (!latest.current.rows.some((row) => row.id === current.id && !row.archived)) { cleanup(); return; }
        current.active = true;
        latest.current.onStart?.();
        window.getSelection()?.removeAllRanges();
        latest.current.containerRef.current?.setAttribute("data-reordering", "true");
        const bubble = document.createElement("div");
        bubble.className = styles.hint;
        bubble.dataset.slot = "request-reorder-hint";
        bubble.setAttribute("role", "status");
        bubble.hidden = true;
        bubble.append(document.createElement("span"), document.createElement("span"));
        document.body.append(bubble);
        hint.current = bubble;
      }
      scheduleUpdate();
    };
    const up = (event: PointerEvent) => {
      if (!drag.current || event.pointerId !== drag.current.pointerId) return;
      const current = drag.current;
      if (current.active) {
        current.x = event.clientX;
        current.y = event.clientY;
        cancelAnimationFrame(frame.current);
        update();
      }
      const source = latest.current.rows.find((row) => row.id === current.id);
      cleanup();
      if (current.active && source && !source.archived && current.target) latest.current.onReorder(source, current.target);
    };
    const cancel = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) cleanup(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
      }
    };
    const context = (event: Event) => { if (drag.current?.active) { event.preventDefault(); cleanup(); } };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("contextmenu", context);
    window.addEventListener("blur", cleanup);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", cleanup);
    return () => {
      cleanup();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("contextmenu", context);
      window.removeEventListener("blur", cleanup);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", cleanup);
    };
  }, []);

  useEffect(() => {
    if (drag.current && (!options.rows.some((row) => row.id === drag.current!.id && !row.archived) || options.enabled === false)) cleanupRef.current();
  }, [options.rows, options.enabled]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 0) suppressUntil.current = 0;
    if (latest.current.enabled === false || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const handle = (event.target as Element).closest("[data-request-select], [data-request-name]");
    const row = handle?.closest<HTMLElement>("[data-row]:not([data-archived])");
    if (!row || !latest.current.containerRef.current?.contains(row)) return;
    cleanupRef.current();
    drag.current = { id: Number(row.dataset.row), pointerId: event.pointerId, x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY, active: false, target: null };
  }, []);

  const suppressClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.detail > 0 && performance.now() < suppressUntil.current) { event.preventDefault(); event.stopPropagation(); }
  }, []);

  return { className: styles.container, onPointerDown, onClickCapture: suppressClick, onDoubleClickCapture: suppressClick };
}
