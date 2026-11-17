import { shortcutDate, dateShortcutLabels } from "../lib/format";
import styles from "./DateShortcuts.module.css";

export function DateShortcuts({ value, onChange, label }: { value: string; onChange: (value: string) => void; label?: string }) {
  return (
    <div className={styles.row}>
      {dateShortcutLabels().map((item) => {
        const date = shortcutDate(item.offset);
        return (
          <button
            key={item.offset}
            type="button"
            className={styles.button}
            aria-pressed={value === date}
            aria-label={`${label ? `将${label}设为` : "设为"}${item.label}`}
            onClick={() => onChange(date)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
