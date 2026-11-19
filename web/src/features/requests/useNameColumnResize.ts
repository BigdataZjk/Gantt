import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import type { ApiRequest } from "../../api/types";

const MAX_CONTENT_SCALE = 1.2;
const MIN_NAME_WIDTH = 120;
const MIN_OTHER_WIDTH = 80;

interface Options {
  rows: ApiRequest[];
  viewportWidth: number;
  defaultWidth: number;
  savedWidth: number | null;
  measureRef: RefObject<HTMLDivElement | null>;
  onSave: (width: number) => void;
}

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  nextWidth: number;
  frame: number;
}

export function useNameColumnResize({ rows, viewportWidth, defaultWidth, savedWidth, measureRef, onSave }: Options) {
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [draggedWidth, setDraggedWidth] = useState<number | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const contentLimit = contentWidth === null ? defaultWidth : Math.floor(contentWidth * MAX_CONTENT_SCALE);
  const max = Math.max(1, Math.min(contentLimit, viewportWidth - MIN_OTHER_WIDTH));
  const min = Math.min(MIN_NAME_WIDTH, Math.max(1, Math.floor(max / MAX_CONTENT_SCALE)));
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));
  const width = clamp(draggedWidth ?? savedWidth ?? defaultWidth);

  useLayoutEffect(() => {
    const measure = measureRef.current;
    const label = measure?.querySelector("[data-name-measure-label]");
    if (!rows.length || !measure || !label?.parentElement) {
      setContentWidth(null);
      return;
    }
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const style = getComputedStyle(label);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const holdSize = parseFloat(style.getPropertyValue("--request-hold-icon-size")) || 0;
    const holdWidth = holdSize ? holdSize + parseFloat(getComputedStyle(label.parentElement).columnGap) : 0;
    let widest = 0;
    for (const row of rows) {
      const name = row.name.replace(/[ \t\n\r\f]+/g, " ").trim();
      const textWidth = context.measureText(name).width;
      widest = Math.max(widest, textWidth + (row.status === "HOLD" ? holdWidth : 0));
    }
    setContentWidth(widest + measure.getBoundingClientRect().width);
  }, [rows, defaultWidth, measureRef]);

  useLayoutEffect(() => () => {
    if (dragRef.current) cancelAnimationFrame(dragRef.current.frame);
  }, []);

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || dragRef.current || min === max) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, nextWidth: width, frame: 0 };
    setDraggedWidth(width);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.nextWidth = clamp(drag.startWidth + event.clientX - drag.startX);
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      setDraggedWidth(drag.nextWidth);
    });
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    cancelAnimationFrame(drag.frame);
    dragRef.current = null;
    setDraggedWidth(null);
    if (event.type === "pointerup") {
      const next = clamp(drag.startWidth + event.clientX - drag.startX);
      if (next !== drag.startWidth) onSave(next);
    }
  };

  const fitWidth = () => onSave(clamp(Math.ceil(contentWidth ?? defaultWidth)));
  const handleProps = {
    onClick: (event: MouseEvent<HTMLSpanElement>) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent<HTMLSpanElement>) => {
      event.stopPropagation();
      fitWidth();
    },
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (dragRef.current) return;
    let next = width;
    switch (event.key) {
      case "ArrowLeft": next -= 8; break;
      case "ArrowRight": next += 8; break;
      case "Home": next = min; break;
      case "End": next = max; break;
      case "Enter":
        event.preventDefault();
        fitWidth();
        return;
      default: return;
    }
    event.preventDefault();
    onSave(clamp(next));
  };

  return {
    width,
    dragging: draggedWidth !== null,
    begin,
    pointerHandlers: { onPointerMove, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish },
    handleProps,
    separatorProps: {
      ...handleProps,
      role: "separator",
      "aria-label": "调整需求列宽",
      "aria-description": "拖动调整列宽，双击或按 Enter 自动适应需求名称",
      "data-tooltip": "双击适应需求名称",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": width,
      tabIndex: min < max ? 0 : -1,
      onKeyDown,
    },
  };
}
