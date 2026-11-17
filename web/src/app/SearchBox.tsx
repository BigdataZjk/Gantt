import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import styles from "./SearchBox.module.css";

export function SearchBox({ value, onChange, visible, placeholder = "搜索需求名称、提需人、备注" }: { value: string; onChange: (value: string) => void; visible: boolean; placeholder?: string }) {
  const [expanded, setExpanded] = useState(() => Boolean(value.trim()));
  const input = useRef<HTMLInputElement>(null);
  const slot = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (value.trim()) setExpanded(true);
  }, [value]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!slot.current?.contains(event.target as Node) && !value.trim()) setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [value]);

  if (!visible) return null;
  return (
    <span
      ref={slot}
      className={styles.slot}
      data-expanded={expanded}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !value.trim()) setExpanded(false);
      }}
    >
      <span className={styles.capsule}>
        <Search className={styles.leading} aria-hidden="true" />
        <input
          ref={input}
          className={styles.input}
          type="search"
          value={value}
          placeholder={placeholder}
          aria-label="搜索需求"
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              if (value) onChange("");
              else {
                setExpanded(false);
                input.current?.blur();
              }
            }
          }}
        />
        <button
          type="button"
          className={styles.toggle}
          data-has-query={Boolean(value.trim())}
          aria-label={expanded ? "收起搜索" : "展开搜索"}
          aria-expanded={expanded}
          onClick={() => {
            if (expanded && !value.trim()) {
              setExpanded(false);
              input.current?.blur();
            } else {
              setExpanded(true);
              input.current?.focus();
            }
          }}
        >
          <Search aria-hidden="true" />
        </button>
      </span>
    </span>
  );
}
