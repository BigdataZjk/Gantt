import { Trash2 } from "lucide-react";
import { CopyLinkButton } from "./CopyLinkButton";
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
  const hasValue = Boolean(value.trim());
  return (
    <div className={styles.field} style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? <span className={styles.required}>*</span> : null}
      </label>
      <div className={styles.wrap}>
        <input id={id} type="url" value={value} placeholder={placeholder} readOnly={readOnly} required={required} onChange={(event) => onChange?.(event.target.value)} aria-label={label} />
        <div className={styles.actions}>
          <CopyLinkButton label={label} value={value} compact />
          {onChange && !readOnly ? (
            <button type="button" aria-label={`清空${label}`} data-tooltip={`清空${label}`} disabled={!hasValue} onClick={() => onChange("")}>
              <Trash2 aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
