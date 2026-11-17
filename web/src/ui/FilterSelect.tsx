import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "./Checkbox";
import { Popover } from "./Popover";
import styles from "./FilterSelect.module.css";

export interface FilterOption {
  value: string;
  label: string;
  node?: ReactNode;
}

export interface FilterSelectProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  renderTag?: (value: string) => ReactNode;
  ariaLabel?: string;
}

export function FilterSelect({ label, options, selected, onChange, renderTag, ariaLabel }: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set(selected));
  const allSelected = options.length > 0 && options.every((option) => selection.has(option.value));
  const summary = selected.length === 0 ? "全部" : selected.length === 1 ? options.find((option) => option.value === selected[0])?.label ?? selected[0] : `${selected.length} 项`;
  const applySelection = (next: Set<string>) => {
    const values = options.filter((option) => next.has(option.value)).map((option) => option.value);
    setSelection(new Set(values));
    onChange(values.length === options.length ? [] : values);
  };
  const toggle = (value: string) => {
    const next = new Set(selection);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    applySelection(next);
  };
  return (
    <span className={styles.control} data-active={selected.length > 0}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setSelection(new Set(selected));
          setOpen(next);
        }}
        trigger={
          <button type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open} aria-label={`${ariaLabel ?? label}：${summary}`}>
            <span className={styles.label}>{label}</span>
            <span className={styles.value}>
              {selected.length === 1 && renderTag && options.find((option) => option.value === selected[0]) ? renderTag(selected[0]) : null}
              {selected.length !== 1 || !renderTag ? <span>{summary}</span> : null}
            </span>
            <ChevronDown aria-hidden="true" />
          </button>
        }
        className={styles.options}
      >
        <div className={styles.scroll}>
          <Checkbox
            className={`${styles.option} ${styles.optionAll}`}
            checked={allSelected}
            onCheckedChange={() => applySelection(allSelected ? new Set() : new Set(options.map((option) => option.value)))}
            label="全部"
            ariaLabel="全部"
          />
          {options.map((option) => (
            <Checkbox
              key={option.value}
              className={styles.option}
              checked={selection.has(option.value)}
              onCheckedChange={() => toggle(option.value)}
              label={option.node ?? option.label}
              ariaLabel={option.label}
            />
          ))}
        </div>
      </Popover>
    </span>
  );
}
