import { useEffect, useRef, useState } from "react";
import styles from "./TooltipHost.module.css";

interface Position {
  left: number;
  top: number;
}

/** 产品内所有 [data-tooltip] 元素共用一个跟随鼠标的浮层，保持原型体验。 */
export function TooltipHost() {
  const [text, setText] = useState("");
  const [position, setPosition] = useState<Position>({ left: 0, top: 0 });
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const point = useRef({ x: 0, y: 0 });
  const active = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      setOpen(false);
      active.current = null;
    };
    const place = () => {
      if (!active.current) return;
      const rect = active.current.getBoundingClientRect();
      const x = point.current.x || rect.left + rect.width / 2;
      const y = point.current.y || rect.bottom;
      const width = 260;
      const left = Math.max(8, Math.min(x + 14, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(y + 18, window.innerHeight - 60));
      setPosition({ left, top });
    };
    const show = (node: HTMLElement, event?: PointerEvent | FocusEvent) => {
      const next = node.dataset.tooltip || "";
      if (!next) return;
      if (active.current === node && open) return;
      window.clearTimeout(timer.current);
      hide();
      active.current = node;
      if (event && "clientX" in event) point.current = { x: event.clientX, y: event.clientY };
      else point.current = { x: 0, y: 0 };
      timer.current = window.setTimeout(() => {
        setText(next);
        place();
        setOpen(true);
      }, 110);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.buttons) { hide(); return; }
      const node = (event.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (node) show(node, event);
      else hide();
    };
    const out = (event: PointerEvent) => {
      const node = (event.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (node && !node.contains(event.relatedTarget as Node | null)) hide();
    };
    const focusIn = (event: FocusEvent) => {
      const node = (event.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (node) show(node, event);
    };
    const move = (event: PointerEvent) => {
      if (event.buttons) { hide(); return; }
      if (!active.current || !open) return;
      point.current = { x: event.clientX, y: event.clientY };
      place();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointermove", move);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className={styles.bubble} style={{ left: position.left, top: position.top }} role="tooltip">
      {text}
    </div>
  );
}
