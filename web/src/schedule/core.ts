// 排期核心：Plan 归一化、人天/交付联动、HOLD 间隔与并行判断。
// 行为与 Go internal/schedule/plan.go 一致，共享 testdata/schedule/cases.json 校验。

import {
  type Calendar,
  MAX_PLAN_DAYS,
  addDays,
  internal,
  validDate,
} from "./calendar";
import {
  ScheduleError,
  type ScheduleErrorCode,
  ScheduleErrorCode as Code,
} from "./errors";

export interface Segment {
  start: string;
  end: string;
  /**
   * 本段之前、与上一段之间的间隔是否被用户显式标记为 HOLD（默认 false）。
   * 只有该标记为真且间隔内存在工作日时，gaps().hold 才为真；
   * 纯周末/法定假日空档即使勾选也不是真 HOLD。
   */
  holdBefore?: boolean;
}

/**
 * 一个需求的排期。
 *
 * segments 为多段排期；start 取第一段开始，delivery 取最后一段结束。
 * days 是所有排期段内的工作日总数，不计段间空档；days === 0 表示待估，
 * 图上按 PLACEHOLDER_DAYS 占位但保留 0 语义。
 * vacation / overtime 是按需求按天的休假与休息日加班标记。
 * 标记本身不改变既有日期和人天；后续拉伸、补排期、人天/交付联动会按
 * “有效开发日”（工作日或加班，且未休假）重新计算人天（与原型一致）。
 */
export interface Plan {
  segments: Segment[];
  days: number;
  start: string;
  delivery: string;
  vacation: string[];
  overtime: string[];
}

/** 待估（days === 0）但已有日期时图上占位的开发天数。 */
export const PLACEHOLDER_DAYS = 3;

export function emptyPlan(): Plan {
  return {
    segments: [],
    days: 0,
    start: "",
    delivery: "",
    vacation: [],
    overtime: [],
  };
}

/** 构造排期段时只在 holdBefore 为真时带上可选字段，保持 JSON 结构稳定。 */
export function makeSegment(
  start: string,
  end: string,
  holdBefore = false,
): Segment {
  return holdBefore ? { start, end, holdBefore: true } : { start, end };
}

export function clonePlan(plan: Plan): Plan {
  return {
    segments: plan.segments.map((segment) =>
      makeSegment(segment.start, segment.end, Boolean(segment.holdBefore)),
    ),
    days: plan.days,
    start: plan.start,
    delivery: plan.delivery,
    vacation: [...plan.vacation],
    overtime: [...plan.overtime],
  };
}

/** 图上展示的开发天数：待估按 3 天占位。 */
export function displayDays(plan: Plan): number {
  return plan.days <= 0 ? PLACEHOLDER_DAYS : plan.days;
}

interface MarkSets {
  vacation: Set<string>;
  overtime: Set<string>;
}

function markSets(plan: Plan): MarkSets {
  return {
    vacation: new Set(plan.vacation),
    overtime: new Set(plan.overtime),
  };
}

function hasMarks(plan: Plan): boolean {
  return plan.vacation.length > 0 || plan.overtime.length > 0;
}

/**
 * 返回渲染用排期段：有多段时原样返回；单段模式（只有 start/delivery）合成一段。
 */
export function effectiveSegments(plan: Plan): Segment[] {
  if (plan.segments.length > 0) {
    return plan.segments.map((segment) =>
      makeSegment(segment.start, segment.end, Boolean(segment.holdBefore)),
    );
  }
  if (plan.start === "" || plan.delivery === "") {
    return [];
  }
  return [makeSegment(plan.start, plan.delivery)];
}

/** 一个排期段内的工作日数量（不含加班、不扣休假）。 */
export function segmentDays(segment: Segment, calendar: Calendar): number {
  return internal.workdaysIn(
    internal.calendarIndex(calendar),
    segment.start,
    segment.end,
  );
}

/** 所有排期段的工作日总数（不含加班、不扣休假），不计段间空档。 */
export function totalDays(plan: Plan, calendar: Calendar): number {
  const index = internal.calendarIndex(calendar);
  let total = 0;
  for (const segment of plan.segments) {
    total += internal.workdaysIn(index, segment.start, segment.end);
  }
  return total;
}

/** 一个排期段内的有效开发日数量（工作日且未休假，或休息日已标记加班）。 */
export function segmentEffectiveDays(
  plan: Plan,
  segment: Segment,
  calendar: Calendar,
): number {
  const index = internal.calendarIndex(calendar);
  const marks = markSets(plan);
  return internal.effectiveCountIn(
    index,
    segment.start,
    segment.end,
    marks.vacation,
    marks.overtime,
  );
}

/** 所有排期段的有效开发日总数（含加班、扣休假），不计段间空档。 */
export function effectiveDays(plan: Plan, calendar: Calendar): number {
  const index = internal.calendarIndex(calendar);
  const marks = markSets(plan);
  let total = 0;
  for (const segment of plan.segments) {
    total += internal.effectiveCountIn(
      index,
      segment.start,
      segment.end,
      marks.vacation,
      marks.overtime,
    );
  }
  return total;
}

/** 交付日期：最后一段结束；否则用已存交付或按有效开发日推算。 */
export function deliveryOf(plan: Plan, calendar: Calendar): string {
  if (plan.segments.length > 0) {
    return plan.segments[plan.segments.length - 1].end;
  }
  if (plan.delivery !== "" && validDate(plan.delivery)) {
    return plan.delivery;
  }
  if (plan.start === "") {
    return "";
  }
  const index = internal.calendarIndex(calendar);
  const marks = markSets(plan);
  const days = plan.days < 1 ? PLACEHOLDER_DAYS : Math.trunc(plan.days);
  return internal.finishEffectiveIn(
    index,
    plan.start,
    days,
    marks.vacation,
    marks.overtime,
  );
}

export interface Gap {
  afterIndex: number;
  start: string;
  end: string;
  workdays: number;
  /**
   * 下一段的 holdBefore 为真且间隔内存在工作日才是真 HOLD。
   * 纯周末/法定假日空档即使勾选 holdBefore 也不是 HOLD。
   */
  hold: boolean;
}

/** 返回分段之间的间隔信息。 */
export function gaps(plan: Plan, calendar: Calendar): Gap[] {
  const index = internal.calendarIndex(calendar);
  const out: Gap[] = [];
  for (let i = 1; i < plan.segments.length; i += 1) {
    const start = addDays(plan.segments[i - 1].end, 1);
    const end = addDays(plan.segments[i].start, -1);
    if (start === "" || end === "" || start > end) {
      continue;
    }
    const workdays = internal.workdaysIn(index, start, end);
    out.push({
      afterIndex: i - 1,
      start,
      end,
      workdays,
      hold: Boolean(plan.segments[i].holdBefore) && workdays > 0,
    });
  }
  return out;
}

/** 排期段覆盖的实际开发日集合：工作日且未休假，或已标记加班。 */
export function activeDays(plan: Plan, calendar: Calendar): Set<string> {
  const index = internal.calendarIndex(calendar);
  const marks = markSets(plan);
  const days = new Set<string>();
  for (const segment of plan.segments) {
    let day = segment.start;
    for (let guard = 0; day <= segment.end && guard < 4000; guard += 1) {
      if (day === "") {
        break;
      }
      if (internal.isEffectiveIn(index, day, marks.vacation, marks.overtime)) {
        days.add(day);
      }
      day = addDays(day, 1);
    }
  }
  return days;
}

/** 两个需求在同一开发日并行开发的天数。 */
export function overlapDays(a: Plan, b: Plan, calendar: Calendar): number {
  let start = a.start;
  let end = deliveryOf(a, calendar);
  const otherStart = b.start;
  const otherEnd = deliveryOf(b, calendar);
  if (start === "" || end === "" || otherStart === "" || otherEnd === "") {
    return 0;
  }
  if (otherStart > start) {
    start = otherStart;
  }
  if (otherEnd < end) {
    end = otherEnd;
  }
  if (start > end) {
    return 0;
  }
  const activeA = activeDays(a, calendar);
  const activeB = activeDays(b, calendar);
  let count = 0;
  let day = start;
  for (let guard = 0; day <= end && guard < 4000; guard += 1) {
    if (day === "") {
      break;
    }
    if (activeA.has(day) && activeB.has(day)) {
      count += 1;
    }
    day = addDays(day, 1);
  }
  return count;
}

export function overlaps(a: Plan, b: Plan, calendar: Calendar): boolean {
  return overlapDays(a, b, calendar) > 0;
}

/** 排期是否没有任何日期（仍可能有预估人天）。 */
export function unscheduled(plan: Plan): boolean {
  return (
    plan.segments.length === 0 && plan.start === "" && plan.delivery === ""
  );
}

/** 是否处于待估人天状态（days === 0）。 */
export function estimated(plan: Plan): boolean {
  return plan.days === 0;
}

function invalidDateError(): ScheduleError {
  return new ScheduleError(Code.invalidDate, "日期必须是有效的 YYYY-MM-DD");
}

function invalidDaysError(): ScheduleError {
  return new ScheduleError(
    Code.invalidDays,
    "开发人天必须是不小于 0 的整数，且不超过 1305",
  );
}

function rangeExceededError(): ScheduleError {
  return new ScheduleError(
    Code.rangeExceeded,
    "排期日期超出支持范围或跨度超过 5 年",
  );
}

function validatePlanRange(plan: Plan): void {
  const dates: string[] = [plan.start, plan.delivery];
  for (const segment of plan.segments) {
    dates.push(segment.start, segment.end);
  }
  for (const day of dates) {
    if (day === "") {
      continue;
    }
    if (!internal.isInRange(day)) {
      throw rangeExceededError();
    }
  }
  let first = plan.start;
  let last = plan.delivery;
  if (plan.segments.length > 0) {
    first = plan.segments[0].start;
    last = plan.segments[plan.segments.length - 1].end;
  }
  if (first === "" || last === "") {
    return;
  }
  if (last < first) {
    throw new ScheduleError(
      Code.segmentInvalid,
      "排期段必须包含开始和结束日期，且开始不能晚于结束",
    );
  }
  if (last > internal.planLimit(first)) {
    throw rangeExceededError();
  }
}

interface DraftPlan {
  segments?: Segment[];
  days?: number;
  start?: string;
  delivery?: string;
  vacation?: string[];
  overtime?: string[];
}

function normalizeWithoutSegments(out: Plan, calendar: Calendar): Plan {
  const index = internal.calendarIndex(calendar);
  let start = out.start;
  let delivery = out.delivery;
  if (start !== "") {
    if (!validDate(start)) {
      throw invalidDateError();
    }
    if (!internal.isInRange(start)) {
      throw rangeExceededError();
    }
  }
  if (delivery !== "") {
    if (!validDate(delivery)) {
      throw invalidDateError();
    }
    if (!internal.isInRange(delivery)) {
      throw rangeExceededError();
    }
    if (start === "") {
      throw new ScheduleError(
        Code.deliveryWithoutStart,
        "设置交付日期前需要先有开始日期",
      );
    }
    if (delivery < start) {
      throw new ScheduleError(
        Code.deliveryBeforeStart,
        "交付日期不能早于准入日期或最后一段的开始日期",
      );
    }
  }
  const marked = out.vacation.length > 0 || out.overtime.length > 0;
  const vacation = new Set(out.vacation);
  const overtime = new Set(out.overtime);
  if (out.days === 0) {
    // 待估：保留 0 语义；仅开始日期时生成 3 个有效开发日占位交付日期用于展示。
    if (start !== "" && delivery === "") {
      delivery = internal.finishEffectiveIn(
        index,
        start,
        PLACEHOLDER_DAYS,
        vacation,
        overtime,
      );
      if (delivery === "") {
        throw rangeExceededError();
      }
    }
    const result: Plan = {
      segments: [],
      days: 0,
      start,
      delivery,
      vacation: out.vacation,
      overtime: out.overtime,
    };
    validatePlanRange(result);
    return result;
  }
  if (start === "") {
    // 空排期只保留预估人天，不生成日期。
    return {
      segments: [],
      days: out.days,
      start: "",
      delivery: "",
      vacation: out.vacation,
      overtime: out.overtime,
    };
  }
  if (delivery === "") {
    delivery = internal.finishEffectiveIn(
      index,
      start,
      Math.trunc(out.days),
      vacation,
      overtime,
    );
    if (delivery === "") {
      throw rangeExceededError();
    }
  }
  let days = out.days;
  if (!marked) {
    // 无休假/加班标记时以日期反算人天（与服务端保存口径一致）。
    const computed = internal.workdaysIn(index, start, delivery);
    if (computed < 1) {
      throw new ScheduleError(Code.noWorkdays, "该范围内没有可用的工作日");
    }
    if (computed > MAX_PLAN_DAYS) {
      throw invalidDaysError();
    }
    days = computed;
  }
  const result: Plan = {
    segments: [],
    days,
    start,
    delivery,
    vacation: out.vacation,
    overtime: out.overtime,
  };
  validatePlanRange(result);
  return result;
}

/**
 * 校验并归一化排期，规则与 Go Normalize 完全一致：
 *
 * - 日期必须是有效 ISO 日期，在 1970-01-01 至 2099-12-31 之间，排期跨度不超过 5 年；
 * - 分段按开始日期严格升序、互不重叠；每段至少 1 个工作日或有效开发日（加班日）；
 * - 第一段不能带 holdBefore，其余分段的 holdBefore 原样保留；
 * - 有分段时 start 取第一段开始、delivery 取最后一段结束；
 * - 没有休假/加班标记时，days > 0 与分段严格联动：人天不足延长最后一段、超出缩短最后一段，
 *   前面各段已占人天 + 最后一段至少 1 人天仍不够时抛 days_too_small；
 * - 存在休假/加班标记时，标记本身不改变人天，接受已存储的 days（不按日期反推），
 *   避免标记/取消标记把既有日期和人天改掉；
 * - 无分段时保留预估人天；days === 0 表示待估，保留 0 语义，仅有开始日期时按
 *   PLACEHOLDER_DAYS 生成占位交付日期用于展示；
 * - vacation、overtime 只做日期校验、去重与排序，不影响日期和已存储人天。
 *
 * 校验失败抛 {@link ScheduleError}，code 与 Go 错误码一致。
 */
export function normalize(plan: DraftPlan, calendar: Calendar): Plan {
  const days = plan.days ?? 0;
  if (
    !Number.isFinite(days) ||
    days < 0 ||
    days > MAX_PLAN_DAYS ||
    days !== Math.trunc(days)
  ) {
    throw invalidDaysError();
  }
  const index = internal.calendarIndex(calendar);
  const vacation = internal.normalizeDateList(plan.vacation ?? []);
  const overtime = internal.normalizeDateList(plan.overtime ?? []);
  const out: Plan = {
    segments: [],
    days,
    start: plan.start ?? "",
    delivery: plan.delivery ?? "",
    vacation,
    overtime,
  };
  const segments: Segment[] = [];
  for (const raw of plan.segments ?? []) {
    if (raw.start === "" || raw.end === "") {
      throw new ScheduleError(
        Code.segmentInvalid,
        "排期段必须包含开始和结束日期，且开始不能晚于结束",
      );
    }
    if (!validDate(raw.start) || !validDate(raw.end)) {
      throw invalidDateError();
    }
    if (raw.start > raw.end) {
      throw new ScheduleError(
        Code.segmentInvalid,
        "排期段必须包含开始和结束日期，且开始不能晚于结束",
      );
    }
    if (!internal.isInRange(raw.start) || !internal.isInRange(raw.end)) {
      throw rangeExceededError();
    }
    segments.push(makeSegment(raw.start, raw.end, Boolean(raw.holdBefore)));
  }
  if (segments.length === 0) {
    return normalizeWithoutSegments(out, calendar);
  }
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].start <= segments[i - 1].start) {
      throw new ScheduleError(Code.segmentOrder, "排期段必须按开始日期升序排列");
    }
    if (segments[i].start <= segments[i - 1].end) {
      throw new ScheduleError(Code.segmentOverlap, "排期段之间不能重叠");
    }
  }
  // 第一段之前没有间隔，不允许残留 holdBefore。
  segments[0] = makeSegment(segments[0].start, segments[0].end);
  const marks = markSets(out);
  const last = segments.length - 1;
  let total = 0;
  let lastBase = 0;
  segments.forEach((segment, i) => {
    const base = internal.workdaysIn(index, segment.start, segment.end);
    const effective = internal.effectiveCountIn(
      index,
      segment.start,
      segment.end,
      marks.vacation,
      marks.overtime,
    );
    if (base < 1 && effective < 1) {
      throw new ScheduleError(
        Code.segmentNoWorkdays,
        "每个排期段至少需要 1 个工作日",
      );
    }
    total += base;
    if (i === last) {
      lastBase = base;
    }
  });
  if (out.days > 0 && !hasMarks(out) && total !== Math.trunc(out.days)) {
    // 无标记时人天与分段严格联动：以人天为准调整最后一段。
    const others = total - lastBase;
    if (Math.trunc(out.days) < others + 1) {
      throw new ScheduleError(
        Code.daysTooSmall,
        `前面的排期段已占 ${others} 人天，最后一段至少保留 1 人天`,
      );
    }
    const target = Math.trunc(out.days) - others;
    const newEnd = internal.finishIn(index, segments[last].start, target);
    if (newEnd === "") {
      throw rangeExceededError();
    }
    segments[last] = makeSegment(
      segments[last].start,
      newEnd,
      Boolean(segments[last].holdBefore),
    );
  }
  const result: Plan = {
    segments,
    days: out.days,
    start: segments[0].start,
    delivery: segments[last].end,
    vacation,
    overtime,
  };
  validatePlanRange(result);
  return result;
}

export type NormalizeResult =
  | { ok: true; plan: Plan }
  | { ok: false; code: ScheduleErrorCode; message: string };

/** 不抛异常的 normalize，便于表单即时校验展示错误码。 */
export function tryNormalize(
  plan: DraftPlan,
  calendar: Calendar,
): NormalizeResult {
  try {
    return { ok: true, plan: normalize(plan, calendar) };
  } catch (error) {
    if (error instanceof ScheduleError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
