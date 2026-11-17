import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import styles from "./ContextMenu.module.css";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separatorBefore?: boolean;
}

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  header?: { title: string; caption?: string };
  items: ContextMenuItem[];
  ariaLabel?: string;
  scrollContainer?: HTMLElement | null;
}

export function isContextMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

export function contextMenuPoint(event: MouseEvent<HTMLElement>): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: rect.left, y: rect.bottom };
}

const OPEN_EVENT = "rsm:context-menu-open";

export function ContextMenu({ open, x, y, onClose, header, items, ariaLabel = "操作菜单", scrollContainer }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) return;
    const width = ref.current?.offsetWidth ?? 0;
    const height = ref.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    setPosition((current) => current.left === left && current.top === top ? current : { left, top });
  }, [open, x, y, header?.title, header?.caption, items]);

  useEffect(() => {
    if (!open) return;
    const origin = document.activeElement as HTMLElement | null;
    const close = () => closeRef.current();
    const pointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        close();
        origin?.focus({ preventScroll: true });
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus({ preventScroll: true });
    };
    const opened = (event: Event) => { if ((event as CustomEvent).detail !== ref.current) close(); };
    const scroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && (
        ref.current?.contains(target) ||
        (scrollContainer && !target.contains(scrollContainer))
      )) return;
      close();
    };
    window.addEventListener(OPEN_EVENT, opened);
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: ref.current }));
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", scroll, true);
    const first = window.setTimeout(() => {
      ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    }, 0);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener(OPEN_EVENT, opened);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, scrollContainer]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className={styles.menu} style={{ left: position.left, top: position.top }} role="menu" aria-label={ariaLabel} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      {header ? (
        <div className={styles.header} role="presentation">
          <strong>{header.title}</strong>
          {header.caption ? <span>{header.caption}</span> : null}
        </div>
      ) : null}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.key}>
            {item.separatorBefore ? <div className={styles.separator} role="separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${item.danger ? styles.danger : ""}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                onClose();
              }}
            >
              {Icon ? <Icon aria-hidden="true" /> : null}
              <span className={styles.itemLabel}>{item.label}</span>
              {item.checked ? <Check className={styles.check} aria-hidden="true" /> : null}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
