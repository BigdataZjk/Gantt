import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./YearSelect.module.css";

const minYear = 2000;
const maxYear = 2099;
const pageSize = 12;
const pageOf = (year: number) => minYear + Math.floor((year - minYear) / pageSize) * pageSize;

export function YearSelect({ value, coveredYears, onChange, disabled = false }: {
  value: number;
  coveredYears: number[];
  onChange: (year: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [firstYear, setFirstYear] = useState(() => pageOf(value));
  const [focusedYear, setFocusedYear] = useState(value);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const focusAfterPageChange = useRef<number | null>(null);
  const thisYear = new Date().getFullYear();
  const lastYear = Math.min(maxYear, firstYear + pageSize - 1);

  useLayoutEffect(() => {
    if (focusAfterPageChange.current === null) return;
    buttons.current.get(focusAfterPageChange.current)?.focus();
    focusAfterPageChange.current = null;
  }, [firstYear]);

  const changePage = (direction: number) => {
    const next = Math.max(minYear, Math.min(pageOf(maxYear), firstYear + direction * pageSize));
    setFirstYear(next);
    setFocusedYear(next);
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, year: number) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -pageSize, PageDown: pageSize };
    const next = event.key === "Home" ? firstYear : event.key === "End" ? lastYear : offsets[event.key] !== undefined ? year + offsets[event.key]! : null;
    if (next === null) return;
    event.preventDefault();
    const target = Math.max(minYear, Math.min(maxYear, next));
    if (pageOf(target) === firstYear) buttons.current.get(target)?.focus();
    else {
      focusAfterPageChange.current = target;
      setFirstYear(pageOf(target));
    }
    setFocusedYear(target);
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      if (next) { setFirstYear(pageOf(value)); setFocusedYear(value); }
      setOpen(next);
    }}>
      <Popover.Trigger asChild>
        <button id="calendar-year" type="button" className={styles.trigger} disabled={disabled} aria-label={`日历年份，${value} 年`}>
          <CalendarDays aria-hidden="true" />
          <span>{value}<span className={styles.suffix}>年</span></span>
          <ChevronDown className={styles.chevron} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.panel}
          align="start"
          sideOffset={7}
          collisionPadding={8}
          aria-label="选择日历年份"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            buttons.current.get(value)?.focus();
          }}
        >
          <div className={styles.header}>
            <span aria-live="polite">{firstYear} — {lastYear}</span>
            <div>
              <button type="button" aria-label="上一组年份" disabled={firstYear === minYear} onClick={() => changePage(-1)}><ChevronLeft aria-hidden="true" /></button>
              <button type="button" aria-label="下一组年份" disabled={lastYear === maxYear} onClick={() => changePage(1)}><ChevronRight aria-hidden="true" /></button>
            </div>
          </div>
          <div className={styles.grid} role="group" aria-label="年份">
            {Array.from({ length: lastYear - firstYear + 1 }, (_, index) => {
              const year = firstYear + index;
              const covered = coveredYears.includes(year);
              return (
                <button
                  key={year}
                  ref={(node) => { if (node) buttons.current.set(year, node); else buttons.current.delete(year); }}
                  type="button"
                  aria-label={`${year} 年${covered ? "，已覆盖" : ""}`}
                  aria-pressed={value === year}
                  aria-current={year === thisYear ? "date" : undefined}
                  tabIndex={year === focusedYear ? 0 : -1}
                  data-covered={covered}
                  onFocus={() => setFocusedYear(year)}
                  onKeyDown={(event) => moveFocus(event, year)}
                  onClick={() => { onChange(year); setOpen(false); }}
                >
                  {year}
                  <span className={styles.dot} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <div className={styles.footer}>
            <span><i aria-hidden="true" />已覆盖日历</span>
            <button type="button" onClick={() => { onChange(thisYear); setOpen(false); }}>今年</button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
