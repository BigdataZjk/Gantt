import { ExternalLink } from "lucide-react";
import { validLink } from "../lib/validation";
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
  const href = value.trim();
  const openLabel = `在新标签页打开${label}`;
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
          {validLink(href) ? (
            <a href={href} target="_blank" rel="noopener noreferrer" aria-label={openLabel} data-tooltip={openLabel}>
              <ExternalLink aria-hidden="true" />
            </a>
          ) : (
            <button type="button" aria-label={openLabel} disabled>
              <ExternalLink aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
