import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Popover } from "./Popover";
import styles from "./EnumSelect.module.css";

export interface EnumOption {
  value: string;
  label?: string;
  node?: ReactNode;
}

export interface EnumSelectProps {
  value: string;
  options: EnumOption[];
  onChange: (value: string) => void;
  renderValue?: (value: string) => ReactNode;
  renderOption?: (option: EnumOption) => ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  allowEmpty?: boolean;
  emptyLabel?: string;
  id?: string;
}

export function EnumSelect({ value, options, onChange, renderValue, renderOption, ariaLabel, disabled = false, allowEmpty = false, emptyLabel = "-", id }: EnumSelectProps) {
  const [open, setOpen] = useState(false);
  const all = allowEmpty ? [{ value: "", label: emptyLabel }, ...options] : options;
  const current = all.find((option) => option.value === value);
  const shown = current ? (renderOption ? renderOption(current) : renderValue ? renderValue(current.value) : current.label ?? current.value) : <span className={styles.empty}>-</span>;
  return (
    <div className={styles.control}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button type="button" id={id} className={styles.trigger} disabled={disabled} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}>
            <span className={styles.value}>{shown}</span>
            <ChevronDown aria-hidden="true" />
          </button>
        }
        className={styles.list}
      >
        <div role="listbox" aria-label={ariaLabel} style={{ display: "grid", gap: 1 }}>
          {all.map((option) => (
            <button
              key={option.value || "__empty"}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={styles.option}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {renderOption ? renderOption(option) : option.node ?? option.label ?? (option.value || emptyLabel)}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}
