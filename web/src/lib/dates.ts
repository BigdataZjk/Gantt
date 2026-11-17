/**
 * 纯日期工具：全部使用 UTC 12:00 构造，避免时区/DST 边界问题。
 * 日历语义与排期模块约定一致，后续可在此单一位置切换到 web/src/schedule。
 */
export interface CalendarLike {
  restDays: string[];
  workDays: string[];
  years?: number[];
  source?: string;
}

export interface DayFlags {
  vacation?: string[];
  overtime?: string[];
}

import { addDays as scheduleAddDays, isWorkday as scheduleIsWorkday } from "../schedule";

const DAY_MS = 86_400_000;
const MAX_GUARD = 3700;

export function todayISO(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

export function parseDate(value: string): Date {
  return new Date(value + "T12:00:00Z");
}

export function isValidDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDate(value).getTime()) && parseDate(value).toISOString().slice(0, 10) === value;
}

export function addDays(value: string, offset: number): string {
  return scheduleAddDays(value, offset);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}

export function minDate(a: string, b: string): string {
  return !a ? b : !b ? a : a < b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return !a ? b : !b ? a : a > b ? a : b;
}

export function enumerateDates(start: string, end: string): string[] {
  if (!isValidDate(start) || !isValidDate(end) || end < start) return [];
  const dates: string[] = [];
  for (let date = start, guard = 0; date <= end && guard < MAX_GUARD; date = addDays(date, 1), guard += 1) dates.push(date);
  return dates;
}

export function isWorkday(date: string, calendar?: CalendarLike | null): boolean {
  if (!calendar) return false;
  return scheduleIsWorkday(date, calendar as never);
}

export function shiftWorkday(date: string, offset: number, calendar?: CalendarLike | null): string {
  let result = date;
  let left = Math.abs(offset);
  const step = Math.sign(offset);
  for (let guard = 0; left > 0 && guard < 15000; guard += 1) {
    result = addDays(result, step);
    if (isWorkday(result, calendar)) left -= 1;
  }
  return result;
}

export function countDays(start: string, end: string, calendar?: CalendarLike | null, flags: DayFlags = {}): number {
  if (!isValidDate(start) || !isValidDate(end) || end < start) return 0;
  const vacation = flags.vacation?.length ? new Set(flags.vacation) : null;
  const overtime = flags.overtime?.length ? new Set(flags.overtime) : null;
  let count = 0;
  for (let date = start, guard = 0; date <= end && guard < MAX_GUARD; date = addDays(date, 1), guard += 1) {
    if (vacation?.has(date)) continue;
    if (isWorkday(date, calendar) || overtime?.has(date)) count += 1;
  }
  return count;
}

/** 从 start 起排 days 个开发日（含加班、跳过休假），返回最后一天。days<=0 时按 3 天估算占位。 */
export function finishDate(start: string, days: number, calendar?: CalendarLike | null, flags: DayFlags = {}): string {
  if (!isValidDate(start)) return "";
  const total = Math.max(1, Math.floor(Number(days)) || 3);
  const vacation = flags.vacation?.length ? new Set(flags.vacation) : null;
  const overtime = flags.overtime?.length ? new Set(flags.overtime) : null;
  let left = total;
  for (let date = start, guard = 0; guard < MAX_GUARD; date = addDays(date, 1), guard += 1) {
    if (vacation?.has(date)) continue;
    if (isWorkday(date, calendar) || overtime?.has(date)) {
      left -= 1;
      if (left === 0) return date;
    }
  }
  return "";
}

export function monthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function dateLabel(value?: string | null): string {
  return value ? value.slice(5).replace("-", "/") : "-";
}

export function timeLabel(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}