import { useEffect, useRef, useState } from "react";
import { PanelsTopLeft, Pin, PinOff, Settings2 } from "lucide-react";
import { useUiState } from "./uiState";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const { ui, patch } = useUiState();
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const firstLinkRef = useRef<HTMLButtonElement>(null);
  const skipFocusOpen = useRef(false);
  const expanded = ui.sidebarPinned || open;

  useEffect(() => {
    if (!open || ui.sidebarPinned) return;
    const closeOutside = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open, ui.sidebarPinned]);

  return (
    <div className={styles.rail}>
      <nav
        ref={navRef}
        className={styles.nav}
        aria-label="主导航"
        data-expanded={expanded}
        data-pinned={ui.sidebarPinned}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") setOpen(true); }}
        onPointerLeave={(event) => { if (event.pointerType !== "touch" && !event.currentTarget.querySelector(":focus-visible")) setOpen(false); }}
        onFocus={(event) => {
          if (skipFocusOpen.current) {
            skipFocusOpen.current = false;
            return;
          }
          if (event.target.matches(":focus-visible")) setOpen(true);
        }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || ui.sidebarPinned) return;
          event.preventDefault();
          if (document.activeElement !== firstLinkRef.current) {
            skipFocusOpen.current = true;
            firstLinkRef.current?.focus();
          }
          setOpen(false);
        }}
      >
        <button
          type="button"
          className={styles.pin}
          aria-label={ui.sidebarPinned ? "取消固定侧栏" : "固定侧栏"}
          aria-pressed={ui.sidebarPinned}
          data-tooltip={ui.sidebarPinned ? "取消固定侧栏" : "固定侧栏"}
          tabIndex={expanded ? 0 : -1}
          onClick={() => {
            patch({ sidebarPinned: !ui.sidebarPinned });
            setOpen(true);
          }}
        >
          {ui.sidebarPinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        </button>
        <div className={styles.links} id="rsm-navigation-links">
          {([
            { view: "requirements", label: "需求", icon: PanelsTopLeft },
            { view: "settings", label: "设置", icon: Settings2 },
          ] as const).map(({ view, label, icon: Icon }) => (
            <button
              key={view}
              ref={view === "requirements" ? firstLinkRef : undefined}
              type="button"
              className={styles.link}
              aria-label={label}
              aria-current={ui.mainView === view ? "page" : undefined}
              onClick={() => {
                patch({ mainView: view });
                setOpen(false);
              }}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
