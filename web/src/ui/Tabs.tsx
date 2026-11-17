import type { LucideIcon } from "lucide-react";
import styles from "./Tabs.module.css";

export interface TabItem<K extends string = string> {
  key: K;
  label: string;
  icon?: LucideIcon;
}

export interface PageTabsProps<K extends string = string> {
  items: TabItem<K>[];
  value: K;
  onChange: (value: K) => void;
  ariaLabel: string;
  className?: string;
}

export function PageTabs<K extends string = string>({ items, value, onChange, ariaLabel, className = "" }: PageTabsProps<K>) {
  return (
    <nav className={`${styles.tabs} ${className}`} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const Icon = item.icon;
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={styles.tab}
            onClick={() => onChange(item.key)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const index = items.findIndex((candidate) => candidate.key === item.key);
              const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
              const next = items[nextIndex];
              if (next) onChange(next.key);
            }}
          >
            {Icon ? <Icon aria-hidden="true" /> : null}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
