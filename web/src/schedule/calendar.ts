// 中国工作日日历与日期工具，行为与 Go internal/schedule/calendar.go 完全一致。
// 日期一律使用 "YYYY-MM-DD" 字符串，内部按 UTC 计算，不依赖本地时区或夏令时。

import { ScheduleError, ScheduleErrorCode } from "./errors";

export interface Calendar {
  restDays: string[];
  workDays: string[];
  years: number[];
  source: string;
}

export const DATE_LAYOUT = "YYYY-MM-DD";
export const MAX_PLAN_YEARS = 5;
export const MAX_PLAN_DAYS = 1305;
const MAX_SCAN_DAYS = 4000;
export const MIN_SUPPORTED_DATE = "1970-01-01";
export const MAX_SUPPORTED_DATE = "2099-12-31";

const DEFAULT_SOURCE =
  "本地维护：国务院办公厅关于2025年部分节假日安排的通知（国办发明电〔2024〕12号）、关于2026年部分节假日安排的通知（国办发明电〔2025〕7号）、关于2027年部分节假日安排的通知；未覆盖年份按周末规则计算";

const REST_RANGES: ReadonlyArray<readonly [string, string]> = [
  // 2025
  ["2025-01-01", "2025-01-01"],
  ["2025-01-28", "2025-02-04"],
  ["2025-04-04", "2025-04-06"],
  ["2025-05-01", "2025-05-05"],
  ["2025-05-31", "2025-06-02"],
  ["2025-10-01", "2025-10-08"],
  // 2026
  ["2026-01-01", "2026-01-03"],
  ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"],
  ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"],
  ["2026-10-01", "2026-10-07"],
  // 2027
  ["2027-01-01", "2027-01-03"],
  ["2027-02-05", "2027-02-13"],
  ["2027-04-03", "2027-04-05"],
  ["2027-05-01", "2027-05-05"],
  ["2027-06-09", "2027-06-09"],
  ["2027-09-15", "2027-09-15"],
  ["2027-10-01", "2027-10-07"],
];

const WORK_DAYS: readonly string[] = [
  // 2025 调休上班
  "2025-01-26",
  "2025-02-08",
  "2025-04-27",
  "2025-09-28",
  "2025-10-11",
  // 2026 调休上班
  "2026-01-04",
  "2026-02-14",
  "2026-02-28",
  "2026-05-09",
  "2026-09-20",
  "2026-10-10",
  // 2027 调休上班
  "2027-01-31",
  "2027-02-14",
  "2027-05-08",
  "2027-09-26",
  "2027-10-09",
];

/** 返回 2025—2027 年已公布的中国法定假日与调休安排（每次返回新数组）。 */
export function defaultCalendar(): Calendar {
  const restDays: string[] = [];
  for (const [from, to] of REST_RANGES) {
    for (let day = from; day <= to; day = addDays(day, 1)) {
      restDays.push(day);
    }
  }
  return {
    restDays,
    workDays: [...WORK_DAYS],
    years: [2025, 2026, 2027],
    source: DEFAULT_SOURCE,
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 解析为 UTC 毫秒时间戳；非法日期返回 NaN。 */
export function parseDate(date: string): number {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) {
    return Number.NaN;
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const stamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(stamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return Number.NaN;
  }
  return stamp;
}

/** 判断字符串是否为有效 ISO 日期。 */
export function validDate(date: string): boolean {
  return !Number.isNaN(parseDate(date));
}

/**
 * 返回偏移 n 天后的日期。非法输入返回空字符串，与 Go AddDays 一致，
 * 便于渲染层处理不完整草稿而不抛异常。
 */
export function addDays(date: string, n: number): string {
  const stamp = parseDate(date);
  if (Number.isNaN(stamp)) {
    return "";
  }
  return new Date(stamp + n * 86400000).toISOString().slice(0, 10);
}

/** 返回 ISO 日期的星期（0 为周日）；非法日期返回 NaN。 */
export function weekday(date: string): number {
  const stamp = parseDate(date);
  if (Number.isNaN(stamp)) {
    return Number.NaN;
  }
  return new Date(stamp).getUTCDay();
}

/** 返回日期所在年份；非法日期返回 0。 */
export function yearOf(date: string): number {
  const stamp = parseDate(date);
  return Number.isNaN(stamp) ? 0 : new Date(stamp).getUTCFullYear();
}

interface CalendarIndex {
  rest: Set<string>;
  work: Set<string>;
}

// Calendar 被视为不可变对象：同一对象只构建一次索引，逐格渲染 O(1) 查询，
// 不会每格扫描整年或重复解析日历数组。
const calendarIndexes = new WeakMap<Calendar, CalendarIndex>();

function calendarIndex(calendar: Calendar): CalendarIndex {
  const cached = calendarIndexes.get(calendar);
  if (cached) {
    return cached;
  }
  const rest = new Set<string>();
  for (const day of calendar.restDays) {
    if (validDate(day)) {
      rest.add(day);
    }
  }
  const work = new Set<string>();
  for (const day of calendar.workDays) {
    if (validDate(day)) {
      work.add(day);
    }
  }
  const index: CalendarIndex = { rest, work };
  calendarIndexes.set(calendar, index);
  return index;
}

function isWorkdayIn(index: CalendarIndex, date: string): boolean {
  const stamp = parseDate(date);
  if (Number.isNaN(stamp)) {
    return false;
  }
  if (index.work.has(date)) {
    return true;
  }
  if (index.rest.has(date)) {
    return false;
  }
  const day = new Date(stamp).getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * 判断某天是否为中国法定工作日：调休上班日为工作日；放假日期与周末为休息日；
 * 未在 calendar 中列出的年份按周末规则计算。非法日期返回 false。
 */
export function isWorkday(date: string, calendar: Calendar): boolean {
  return isWorkdayIn(calendarIndex(calendar), date);
}

/** 判断日历是否声明可靠覆盖该年份；未覆盖年份仍按周末规则参与计算。 */
export function isSupportedYear(year: number, calendar: Calendar): boolean {
  return calendar.years.includes(year);
}

function workdaysIn(index: CalendarIndex, start: string, end: string): number {
  if (!validDate(start) || !validDate(end) || end < start) {
    return 0;
  }
  let count = 0;
  let day = start;
  for (let guard = 0; day <= end && guard < MAX_SCAN_DAYS; guard += 1) {
    if (isWorkdayIn(index, day)) {
      count += 1;
    }
    day = addDays(day, 1);
  }
  return count;
}

/** 返回闭区间 [start,end] 内的工作日数量。 */
export function countWorkdays(
  start: string,
  end: string,
  calendar: Calendar,
): number {
  return workdaysIn(calendarIndex(calendar), start, end);
}

function nextWorkdayIn(index: CalendarIndex, date: string): string {
  let day = date;
  for (let guard = 0; day !== "" && guard < MAX_SCAN_DAYS; guard += 1) {
    if (isWorkdayIn(index, day)) {
      return day;
    }
    day = addDays(day, 1);
  }
  return "";
}

/** 返回不早于 date 的第一个工作日；超出范围返回空字符串。 */
export function nextWorkday(date: string, calendar: Calendar): string {
  return nextWorkdayIn(calendarIndex(calendar), date);
}

function prevWorkdayIn(index: CalendarIndex, date: string): string {
  let day = date;
  for (let guard = 0; day !== "" && guard < MAX_SCAN_DAYS; guard += 1) {
    if (isWorkdayIn(index, day)) {
      return day;
    }
    day = addDays(day, -1);
  }
  return "";
}

/** 返回不晚于 date 的最后一个工作日；超出范围返回空字符串。 */
export function prevWorkday(date: string, calendar: Calendar): string {
  return prevWorkdayIn(calendarIndex(calendar), date);
}

/** 返回从 start（含）开始第 days 个工作日的日期；days 必须 >= 1。 */
function finishIn(index: CalendarIndex, start: string, days: number): string {
  if (days < 1 || !validDate(start)) {
    return "";
  }
  let left = days;
  let day = start;
  for (let guard = 0; guard < MAX_SCAN_DAYS; guard += 1) {
    if (isWorkdayIn(index, day)) {
      left -= 1;
      if (left === 0) {
        return day;
      }
    }
    day = addDays(day, 1);
  }
  return "";
}

/** 返回从 start（含）开始第 n 个工作日的日期；超出范围抛 range_exceeded。 */
export function addWorkdays(
  start: string,
  n: number,
  calendar: Calendar,
): string {
  if (n < 1) {
    throw new ScheduleError(
      ScheduleErrorCode.invalidDays,
      "工作日天数必须大于 0",
    );
  }
  const result = finishIn(calendarIndex(calendar), start, n);
  if (result === "") {
    throw new ScheduleError(
      ScheduleErrorCode.rangeExceeded,
      "排期日期超出支持范围",
    );
  }
  return result;
}

/** 按工作日步进：n>0 向后移动 n 个工作日，n<0 向前；起点本身不计入步进。 */
function shiftWorkdaysIn(
  index: CalendarIndex,
  date: string,
  n: number,
): string {
  if (!validDate(date) || n === 0) {
    return date;
  }
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  let day = date;
  for (let guard = 0; left > 0 && guard < MAX_SCAN_DAYS; guard += 1) {
    day = addDays(day, step);
    if (isWorkdayIn(index, day)) {
      left -= 1;
    }
  }
  return left > 0 ? "" : day;
}

/** 某天是否计为有效开发日：休假日不计，工作日或已标记加班的休息日计入。 */
function isEffectiveIn(
  index: CalendarIndex,
  date: string,
  vacation: Set<string>,
  overtime: Set<string>,
): boolean {
  if (vacation.has(date)) {
    return false;
  }
  return isWorkdayIn(index, date) || overtime.has(date);
}

/** 闭区间内计入人天的有效开发日数量。 */
function effectiveCountIn(
  index: CalendarIndex,
  start: string,
  end: string,
  vacation: Set<string>,
  overtime: Set<string>,
): number {
  if (!validDate(start) || !validDate(end) || end < start) {
    return 0;
  }
  let count = 0;
  let day = start;
  for (let guard = 0; day <= end && guard < MAX_SCAN_DAYS; guard += 1) {
    if (day !== "" && isEffectiveIn(index, day, vacation, overtime)) {
      count += 1;
    }
    day = addDays(day, 1);
  }
  return count;
}

/** 从 start（含）开始第 days 个有效开发日的日期；找不到返回空字符串。 */
function finishEffectiveIn(
  index: CalendarIndex,
  start: string,
  days: number,
  vacation: Set<string>,
  overtime: Set<string>,
): string {
  if (days < 1 || !validDate(start)) {
    return "";
  }
  let left = days;
  let day = start;
  for (let guard = 0; guard < MAX_SCAN_DAYS; guard += 1) {
    if (day !== "" && isEffectiveIn(index, day, vacation, overtime)) {
      left -= 1;
      if (left === 0) {
        return day;
      }
    }
    day = addDays(day, 1);
  }
  return "";
}

function workingOffsetIn(
  index: CalendarIndex,
  a: string,
  b: string,
): number {
  if (!validDate(a) || !validDate(b)) {
    return 0;
  }
  if (b >= a) {
    return workdaysIn(index, addDays(a, 1), b);
  }
  return -workdaysIn(index, addDays(b, 1), a);
}

/** 两个 ISO 日期相差的自然日数量。 */
export function daySpan(a: string, b: string): number {
  const left = parseDate(a);
  const right = parseDate(b);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return 0;
  }
  return Math.round((right - left) / 86400000);
}

/** 返回 dates 中不在日历覆盖范围内的年份（去重升序），供前端提示。 */
export function unsupportedYears(
  calendar: Calendar,
  dates: string[],
): number[] {
  const seen = new Set<number>();
  const years: number[] = [];
  for (const date of dates) {
    const year = yearOf(date);
    if (year === 0 || isSupportedYear(year, calendar) || seen.has(year)) {
      continue;
    }
    seen.add(year);
    years.push(year);
  }
  return years.sort((a, b) => a - b);
}

/** 是否处于日期硬边界内。 */
function isInRange(date: string): boolean {
  return date >= MIN_SUPPORTED_DATE && date <= MAX_SUPPORTED_DATE;
}

function normalizeDateList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "") {
      continue;
    }
    if (!validDate(value)) {
      throw new ScheduleError(
        ScheduleErrorCode.invalidDate,
        "日期必须是有效的 YYYY-MM-DD",
      );
    }
    if (!isInRange(value)) {
      throw new ScheduleError(
        ScheduleErrorCode.rangeExceeded,
        "标记日期超出支持范围",
      );
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out.sort();
}

/** 生成最大 5 年的跨度上限日期。 */
function planLimit(first: string): string {
  const stamp = parseDate(first);
  const limit = new Date(stamp);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_PLAN_YEARS);
  return limit.toISOString().slice(0, 10);
}

// 供 core.ts / ops.ts / sequence.ts 使用的内部工具。
export const internal = {
  calendarIndex,
  isWorkdayIn,
  workdaysIn,
  nextWorkdayIn,
  prevWorkdayIn,
  finishIn,
  finishEffectiveIn,
  effectiveCountIn,
  isEffectiveIn,
  shiftWorkdaysIn,
  workingOffsetIn,
  daySpan,
  isInRange,
  normalizeDateList,
  planLimit,
};

export { MAX_SCAN_DAYS };
