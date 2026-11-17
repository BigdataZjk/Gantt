import { useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import styles from "./LinkField.module.css";

export interface LinkFieldProps {
  id?: string;
  label: string;
  value: string;
  onChange?: (value: string) => void;
  required?: boolean;
  wide?: boolean;
  readOnly?: boolean;
  placeholder?: string;
}

export function LinkField({ id, label, value, onChange, required = false, wide = false, readOnly = false, placeholder = "https://…" }: LinkFieldProps) {
  const [feedback, setFeedback] = useState("");
  const hasValue = Boolean(value.trim());
  const copy = async () => {
    if (!hasValue) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        copied = document.execCommand("copy");
        textarea.remove();
      } catch {
        copied = false;
      }
    }
    setFeedback(copied ? "已复制" : "请手动选择后复制");
    window.setTimeout(() => setFeedback(""), 2400);
  };
  return (
    <div className={styles.field} style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? <span className={styles.required}>*</span> : null}
      </label>
      <div className={styles.wrap}>
        <input id={id} type="url" value={value} placeholder={placeholder} readOnly={readOnly} required={required} onChange={(event) => onChange?.(event.target.value)} aria-label={label} />
        <div className={styles.actions}>
          <button type="button" aria-label={`复制${label}`} data-tooltip={`复制${label}`} disabled={!hasValue} onClick={copy}>
            <Copy aria-hidden="true" />
          </button>
          {onChange && !readOnly ? (
            <button type="button" aria-label={`清空${label}`} data-tooltip={`清空${label}`} disabled={!hasValue} onClick={() => onChange("")}>
              <Trash2 aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      <span className={styles.feedback} role="status" aria-live="polite">{feedback}</span>
    </div>
  );
}
