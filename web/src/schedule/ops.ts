// 排期段操作：移动/伸缩/删除/补排期、人天与交付联动、休假加班标记。
// 人天联动按“有效开发日”计算（工作日且未休假，或已标记加班的休息日），
// 与原型 phaseDays 一致；仅标记休假/加班本身不改变日期和人天。
// 行为与 Go internal/schedule/ops.go 一致；失败抛带 code 的 ScheduleError。

import {
  type Calendar,
  addDays,
  internal,
  isWorkday,
  validDate,
} from "./calendar";
import {
  type Plan,
  type Segment,
  PLACEHOLDER_DAYS,
  clonePlan,
  makeSegment,
  normalize,
} from "./core";
import { ScheduleError, ScheduleErrorCode as Code } from "./errors";

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

function indexOutOfRangeError(): ScheduleError {
  return new ScheduleError(Code.indexOutOfRange, "排期段不存在");
}

function noSegmentsError(): ScheduleError {
  return new ScheduleError(Code.noSegments, "当前排期没有分段");
}

function overlapError(): ScheduleError {
  return new ScheduleError(Code.segmentOverlap, "排期段之间不能重叠");
}

function noWorkdaysError(): ScheduleError {
  return new ScheduleError(Code.noWorkdays, "该范围内没有可用的工作日");
}

function deliveryWithoutStartError(): ScheduleError {
  return new ScheduleError(
    Code.deliveryWithoutStart,
    "设置交付日期前需要先有开始日期",
  );
}

function deliveryBeforeStartError(): ScheduleError {
  return new ScheduleError(
    Code.deliveryBeforeStart,
    "交付日期不能早于准入日期或最后一段的开始日期",
  );
}

function relationError(message: string): ScheduleError {
  return new ScheduleError(Code.invalidPlan, message);
}

function toSet(values: string[]): Set<string> {
  return new Set(values);
}

function effectiveTotal(
  segments: Segment[],
  vacation: Set<string>,
  overtime: Set<string>,
  calendar: Calendar,
): number {
  const index = internal.calendarIndex(calendar);
  let total = 0;
  for (const segment of segments) {
    total += internal.effectiveCountIn(
      index,
      segment.start,
      segment.end,
      vacation,
      overtime,
    );
  }
  return total;
}

function gapWorkdays(
  segments: Segment[],
  index: number,
  calendar: Calendar,
): number {
  if (index <= 0 || index >= segments.length) {
    return 0;
  }
  const start = addDays(segments[index - 1].end, 1);
  const end = addDays(segments[index].start, -1);
  if (start === "" || end === "" || start > end) {
    return 0;
  }
  return internal.workdaysIn(internal.calendarIndex(calendar), start, end);
}

function shiftMarks(
  values: string[],
  fromStart: string,
  fromEnd: string,
  delta: number,
  calendar: Calendar,
  overtime: boolean,
): string[] {
  const out: string[] = [];
  for (const day of values) {
    if (day >= fromStart && day <= fromEnd) {
      const shifted = addDays(day, delta);
      if (shifted === "") {
        continue;
      }
      if (overtime && isWorkday(shifted, calendar)) {
        continue;
      }
      out.push(shifted);
      continue;
    }
    out.push(day);
  }
  return out.sort();
}

function filterMarks(values: string[], start: string, end: string): string[] {
  return values.filter((day) => day < start || day > end);
}

function toggleDate(values: string[], day: string, on: boolean): string[] {
  const out: string[] = [];
  let exists = false;
  for (const value of values) {
    if (value === day) {
      exists = true;
      if (!on) {
        continue;
      }
    }
    out.push(value);
  }
  if (on && !exists) {
    out.push(day);
  }
  return out.sort();
}

/**
 * 把第 index 段移动到新的开始日期，保持该段有效开发日天数不变；
 * 该段内的休假/加班标记随段平移（加班落在工作日时丢弃）。段前 HOLD 标记跟随该段。
 * 与同一需求其它段重叠时抛 segment_overlap。
 */
export function moveSegment(
  plan: Plan,
  calendar: Calendar,
  index: number,
  newStart: string,
): Plan {
  if (index < 0 || index >= plan.segments.length) {
    throw indexOutOfRangeError();
  }
  if (!validDate(newStart)) {
    throw invalidDateError();
  }
  const idx = internal.calendarIndex(calendar);
  const segments = clonePlan(plan).segments;
  const segment = segments[index];
  const indexMarks = {
    vacation: toSet(plan.vacation),
    overtime: toSet(plan.overtime),
  };
  let duration = internal.effectiveCountIn(
    idx,
    segment.start,
    segment.end,
    indexMarks.vacation,
    indexMarks.overtime,
  );
  if (duration < 1) {
    // 原型 drag.duration = phaseDays(segment) || 3
    duration = PLACEHOLDER_DAYS;
  }
  const delta = internal.daySpan(segment.start, newStart);
  const vacation = shiftMarks(
    plan.vacation,
    segment.start,
    segment.end,
    delta,
    calendar,
    false,
  );
  let overtime = shiftMarks(
    plan.overtime,
    segment.start,
    segment.end,
    delta,
    calendar,
    true,
  );
  if (!internal.isWorkdayIn(idx, newStart) && !vacation.includes(newStart)) {
    overtime = [...overtime, newStart].sort();
  }
  const newEnd = internal.finishEffectiveIn(
    idx,
    newStart,
    duration,
    new Set(vacation),
    new Set(overtime),
  );
  if (newEnd === "") {
    throw rangeExceededError();
  }
  segments.forEach((other, i) => {
    if (i === index) {
      return;
    }
    if (newStart <= other.end && newEnd >= other.start) {
      throw overlapError();
    }
  });
  segments[index] = makeSegment(newStart, newEnd, Boolean(segment.holdBefore));
  segments.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  segments[0] = makeSegment(segments[0].start, segments[0].end);
  const days =
    plan.days > 0
      ? effectiveTotal(
          segments,
          new Set(vacation),
          new Set(overtime),
          calendar,
        )
      : 0;
  return normalize(
    { segments, days, vacation, overtime },
    calendar,
  );
}

/**
 * 伸缩第 index 段：edge 为 "start" 或 "end"，date 为目标边界日期。
 * 边界会避让相邻段；若相邻间隔已被标记为真 HOLD，则不能把边界伸入该间隔。
 * 边界取最近的有效开发日（工作日或加班日，且未休假）；人天按有效开发日重算。
 */
export function resizeSegment(
  plan: Plan,
  calendar: Calendar,
  index: number,
  edge: "start" | "end",
  date: string,
): Plan {
  if (index < 0 || index >= plan.segments.length) {
    throw indexOutOfRangeError();
  }
  if (edge !== "start" && edge !== "end") {
    throw new ScheduleError(Code.invalidEdge, "只支持调整 start 或 end 边界");
  }
  if (!validDate(date)) {
    throw invalidDateError();
  }
  const idx = internal.calendarIndex(calendar);
  const segments = clonePlan(plan).segments;
  const segment = segments[index];
  const vacation = toSet(plan.vacation);
  const overtime = toSet(plan.overtime);
  const eligible = (day: string) =>
    !vacation.has(day) && (internal.isWorkdayIn(idx, day) || overtime.has(day));
  let target = date;
  if (edge === "start") {
    let limit = "1970-01-01";
    if (index > 0) {
      if (
        Boolean(segments[index].holdBefore) &&
        gapWorkdays(segments, index, calendar) > 0
      ) {
        // 真 HOLD 间隔不允许被收缩，保持在原开始日期。
        limit = segment.start;
      } else {
        limit = addDays(segments[index - 1].end, 1);
      }
    }
    if (target < limit) {
      target = limit;
    }
    for (let guard = 0; target <= segment.end && !eligible(target) && guard < 4000; guard += 1) {
      target = addDays(target, 1);
    }
    if (target === "" || target > segment.end || !eligible(target)) {
      throw noWorkdaysError();
    }
    segments[index] = makeSegment(
      target,
      segment.end,
      Boolean(segment.holdBefore),
    );
  } else {
    let limit = "2099-12-31";
    if (index < segments.length - 1) {
      if (
        Boolean(segments[index + 1].holdBefore) &&
        gapWorkdays(segments, index + 1, calendar) > 0
      ) {
        // 真 HOLD 间隔不允许被扩张，保持在原结束日期。
        limit = segment.end;
      } else {
        limit = addDays(segments[index + 1].start, -1);
      }
    }
    if (target > limit) {
      target = limit;
    }
    for (let guard = 0; target >= segment.start && !eligible(target) && guard < 4000; guard += 1) {
      target = addDays(target, -1);
    }
    if (target === "" || target < segment.start || !eligible(target)) {
      throw noWorkdaysError();
    }
    segments[index] = makeSegment(
      segment.start,
      target,
      Boolean(segment.holdBefore),
    );
  }
  const days = effectiveTotal(segments, vacation, overtime, calendar);
  return normalize(
    {
      segments,
      days,
      vacation: plan.vacation,
      overtime: plan.overtime,
    },
    calendar,
  );
}

/**
 * 删除第 index 段。剩余段日期保持不变，人天合计剩余段有效开发日，
 * 准入取第一段，交付取最后一段；新第一段的 holdBefore 清空。
 * 被删除段内的休假/加班标记一并清理；全部删除后清空准入与交付日期，保留删除前预估人天。
 */
export function removeSegment(
  plan: Plan,
  calendar: Calendar,
  index: number,
): Plan {
  if (plan.segments.length === 0) {
    throw noSegmentsError();
  }
  if (index < 0 || index >= plan.segments.length) {
    throw indexOutOfRangeError();
  }
  const removed = plan.segments[index];
  const segments = plan.segments
    .filter((_, i) => i !== index)
    .map((segment) =>
      makeSegment(segment.start, segment.end, Boolean(segment.holdBefore)),
    );
  const vacation = filterMarks(plan.vacation, removed.start, removed.end);
  const overtime = filterMarks(plan.overtime, removed.start, removed.end);
  if (segments.length === 0) {
    // 删完最后一段：清空日期，保留删除前的预估人天。
    return normalize(
      { segments: [], days: plan.days, vacation, overtime },
      calendar,
    );
  }
  segments[0] = makeSegment(segments[0].start, segments[0].end);
  const days = effectiveTotal(
    segments,
    toSet(vacation),
    toSet(overtime),
    calendar,
  );
  return normalize({ segments, days, vacation, overtime }, calendar);
}

interface Piece {
  segment: Segment;
  touched: boolean;
}

interface HoldRange {
  start: string;
  end: string;
}

/**
 * 在 [start,end] 内补排期：只挑工作日、跳过休假、跳过已排期日期，
 * 邻接或中间没有空工作日的片段自动合并，否则新增独立段；可覆盖原 HOLD 间隔。
 * 被部分覆盖后仍含工作日的原 HOLD 间隔会保留在对应新段上；人天按有效开发日重算。
 */
export function addSegment(
  plan: Plan,
  calendar: Calendar,
  start: string,
  end: string,
): Plan {
  if (!validDate(start) || !validDate(end)) {
    throw invalidDateError();
  }
  if (start > end) {
    throw new ScheduleError(
      Code.segmentInvalid,
      "排期段必须包含开始和结束日期，且开始不能晚于结束",
    );
  }
  if (!internal.isInRange(start) || !internal.isInRange(end)) {
    throw rangeExceededError();
  }
  const idx = internal.calendarIndex(calendar);
  const original = clonePlan(plan).segments;
  const vacation = toSet(plan.vacation);
  const added = new Set<string>();
  const covered = (day: string) =>
    original.some((segment) => day >= segment.start && day <= segment.end);
  let day = start;
  for (let guard = 0; day <= end && guard < 4000; guard += 1) {
    if (day === "") {
      break;
    }
    if (
      internal.isWorkdayIn(idx, day) &&
      !covered(day) &&
      !vacation.has(day)
    ) {
      added.add(day);
    }
    day = addDays(day, 1);
  }
  if (added.size === 0) {
    throw noWorkdaysError();
  }

  // 记录原 HOLD 间隔，供合并后重算标记。
  const holds: HoldRange[] = [];
  for (let i = 1; i < original.length; i += 1) {
    if (!original[i].holdBefore) {
      continue;
    }
    const gapStart = addDays(original[i - 1].end, 1);
    const gapEnd = addDays(original[i].start, -1);
    if (gapStart === "" || gapEnd === "" || gapStart > gapEnd) {
      continue;
    }
    holds.push({ start: gapStart, end: gapEnd });
  }

  const pieces: Piece[] = [];
  for (const segment of original) {
    pieces.push({
      segment: makeSegment(
        segment.start,
        segment.end,
        Boolean(segment.holdBefore),
      ),
      touched: false,
    });
  }
  for (const addedDay of added) {
    pieces.push({
      segment: makeSegment(addedDay, addedDay),
      touched: true,
    });
  }
  pieces.sort((a, b) => (a.segment.start < b.segment.start ? -1 : a.segment.start > b.segment.start ? 1 : 0));
  const merged: Piece[] = [];
  for (const current of pieces) {
    if (merged.length === 0) {
      merged.push({ segment: { ...current.segment }, touched: current.touched });
      continue;
    }
    const previous = merged[merged.length - 1];
    let unfilledGap = false;
    const gapStart = addDays(previous.segment.end, 1);
    const gapEnd = addDays(current.segment.start, -1);
    if (gapStart !== "" && gapEnd !== "" && gapStart <= gapEnd) {
      let gapDay = gapStart;
      for (let guard = 0; gapDay <= gapEnd && guard < 4000; guard += 1) {
        if (gapDay === "") {
          break;
        }
        if (
          !internal.isWorkdayIn(idx, gapDay) ||
          vacation.has(gapDay) ||
          added.has(gapDay)
        ) {
          gapDay = addDays(gapDay, 1);
          continue;
        }
        unfilledGap = true;
        break;
      }
    }
    const joins =
      current.segment.start <= previous.segment.end ||
      ((previous.touched || current.touched) && !unfilledGap);
    if (joins) {
      if (current.segment.end > previous.segment.end) {
        previous.segment.end = current.segment.end;
      }
      previous.touched = previous.touched || current.touched;
      continue;
    }
    merged.push({ segment: { ...current.segment }, touched: current.touched });
  }

  const segments: Segment[] = [];
  merged.forEach((item, i) => {
    let holdBefore = false;
    if (i > 0) {
      const newGapStart = addDays(merged[i - 1].segment.end, 1);
      const newGapEnd = addDays(item.segment.start, -1);
      if (newGapStart !== "" && newGapEnd !== "" && newGapStart <= newGapEnd) {
        for (const hold of holds) {
          const intersectStart =
            newGapStart > hold.start ? newGapStart : hold.start;
          const intersectEnd =
            newGapEnd < hold.end ? newGapEnd : hold.end;
          if (
            intersectStart <= intersectEnd &&
            internal.workdaysIn(idx, intersectStart, intersectEnd) > 0
          ) {
            holdBefore = true;
            break;
          }
        }
      }
    }
    segments.push(makeSegment(item.segment.start, item.segment.end, holdBefore));
  });
  const days = effectiveTotal(
    segments,
    vacation,
    toSet(plan.overtime),
    calendar,
  );
  return normalize(
    {
      segments,
      days,
      vacation: plan.vacation,
      overtime: plan.overtime,
    },
    calendar,
  );
}

/**
 * 修改开发人天：默认延长或缩短最后一段；没有分段时按开始日期重新推算交付日期；
 * days === 0 表示待估，保留既有日期并回到 0 语义。
 */
export function setDays(
  plan: Plan,
  calendar: Calendar,
  days: number,
): Plan {
  if (
    !Number.isFinite(days) ||
    days < 0 ||
    days > 1305 ||
    days !== Math.trunc(days)
  ) {
    throw invalidDaysError();
  }
  const idx = internal.calendarIndex(calendar);
  const vacation = toSet(plan.vacation);
  const overtime = toSet(plan.overtime);
  if (days === 0) {
    return normalize(
      {
        segments: clonePlan(plan).segments,
        days: 0,
        start: plan.start,
        delivery: plan.delivery,
        vacation: plan.vacation,
        overtime: plan.overtime,
      },
      calendar,
    );
  }
  if (plan.segments.length === 0) {
    if (plan.start === "") {
      return normalize(
        { days, vacation: plan.vacation, overtime: plan.overtime },
        calendar,
      );
    }
    const end = internal.finishEffectiveIn(
      idx,
      plan.start,
      Math.trunc(days),
      vacation,
      overtime,
    );
    if (end === "") {
      throw rangeExceededError();
    }
    return normalize(
      {
        days,
        start: plan.start,
        delivery: end,
        vacation: plan.vacation,
        overtime: plan.overtime,
      },
      calendar,
    );
  }
  const segments = clonePlan(plan).segments;
  const last = segments.length - 1;
  const others = effectiveTotal(
    segments.slice(0, last),
    vacation,
    overtime,
    calendar,
  );
  if (Math.trunc(days) < others + 1) {
    throw new ScheduleError(
      Code.daysTooSmall,
      `前面的排期段已占 ${others} 人天，最后一段至少保留 1 人天`,
    );
  }
  const newEnd = internal.finishEffectiveIn(
    idx,
    segments[last].start,
    Math.trunc(days) - others,
    vacation,
    overtime,
  );
  if (newEnd === "") {
    throw rangeExceededError();
  }
  segments[last] = makeSegment(
    segments[last].start,
    newEnd,
    Boolean(segments[last].holdBefore),
  );
  return normalize(
    { segments, days: Math.trunc(days), vacation: plan.vacation, overtime: plan.overtime },
    calendar,
  );
}

/**
 * 修改交付日期并按有效开发日反算人天；不能早于准入日期或最后一段开始日期，
 * 且至少包含 1 个有效开发日。
 */
export function setDelivery(
  plan: Plan,
  calendar: Calendar,
  delivery: string,
): Plan {
  if (!validDate(delivery)) {
    throw invalidDateError();
  }
  const idx = internal.calendarIndex(calendar);
  const vacation = toSet(plan.vacation);
  const overtime = toSet(plan.overtime);
  if (plan.segments.length === 0) {
    if (plan.start === "") {
      throw deliveryWithoutStartError();
    }
    if (delivery < plan.start) {
      throw deliveryBeforeStartError();
    }
    const days = internal.effectiveCountIn(
      idx,
      plan.start,
      delivery,
      vacation,
      overtime,
    );
    if (days < 1) {
      throw noWorkdaysError();
    }
    return normalize(
      {
        days,
        start: plan.start,
        delivery,
        vacation: plan.vacation,
        overtime: plan.overtime,
      },
      calendar,
    );
  }
  const segments = clonePlan(plan).segments;
  const last = segments.length - 1;
  if (delivery < segments[0].start || delivery < segments[last].start) {
    throw deliveryBeforeStartError();
  }
  const count = internal.effectiveCountIn(
    idx,
    segments[last].start,
    delivery,
    vacation,
    overtime,
  );
  if (count < 1) {
    throw noWorkdaysError();
  }
  const others = effectiveTotal(
    segments.slice(0, last),
    vacation,
    overtime,
    calendar,
  );
  segments[last] = makeSegment(
    segments[last].start,
    delivery,
    Boolean(segments[last].holdBefore),
  );
  return normalize(
    {
      segments,
      days: others + count,
      vacation: plan.vacation,
      overtime: plan.overtime,
    },
    calendar,
  );
}

/** 标记/取消休假（只允许工作日）。仅修改标记，不改既有日期与人天。 */
export function setVacation(
  plan: Plan,
  calendar: Calendar,
  date: string,
  on: boolean,
): Plan {
  if (!validDate(date)) {
    throw invalidDateError();
  }
  if (!isWorkday(date, calendar)) {
    throw new ScheduleError(Code.markInvalid, "休息日不能标记休假");
  }
  return {
    ...clonePlan(plan),
    vacation: toggleDate(plan.vacation, date, on),
    overtime: toggleDate(plan.overtime, date, false),
  };
}

/** 标记/取消加班（只允许休息日）。仅修改标记，不改既有日期与人天。 */
export function setOvertime(
  plan: Plan,
  calendar: Calendar,
  date: string,
  on: boolean,
): Plan {
  if (!validDate(date)) {
    throw invalidDateError();
  }
  if (isWorkday(date, calendar)) {
    throw new ScheduleError(Code.markInvalid, "工作日不能标记加班");
  }
  return {
    ...clonePlan(plan),
    overtime: toggleDate(plan.overtime, date, on),
    vacation: toggleDate(plan.vacation, date, false),
  };
}

/**
 * 顺排内部使用：把整个排期（含多段）移动到新的开始日期，保留各段有效开发天数与
 * 段间工作日空档，段前 HOLD 标记与段内标记随段移动。单段模式保持单段模式。
 */
export function movePlan(
  plan: Plan,
  calendar: Calendar,
  newStart: string,
): Plan {
  if (!validDate(newStart)) {
    throw invalidDateError();
  }
  const idx = internal.calendarIndex(calendar);
  const singleMode = plan.segments.length === 0;
  let source = clonePlan(plan).segments;
  if (singleMode) {
    if (plan.start === "" || plan.delivery === "") {
      return normalize(plan, calendar);
    }
    source = [makeSegment(plan.start, plan.delivery)];
  }
  const vacation = toSet(plan.vacation);
  const overtime = toSet(plan.overtime);
  const newSegments: Segment[] = [];
  const deltas: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const segment = source[i];
    let target = newStart;
    if (i > 0) {
      const gap = internal.workdaysIn(
        idx,
        addDays(source[i - 1].end, 1),
        addDays(segment.start, -1),
      );
      target = internal.shiftWorkdaysIn(idx, newSegments[i - 1].end, gap + 1);
      if (target === "") {
        throw rangeExceededError();
      }
      if (
        !internal.isWorkdayIn(idx, target) &&
        internal.isWorkdayIn(idx, segment.start)
      ) {
        throw relationError(
          "跨过休息日后无法保持未选需求的原有关系，请一并勾选相邻需求",
        );
      }
    }
    const delta = internal.daySpan(segment.start, target);
    deltas.push(delta);
    let duration = internal.effectiveCountIn(
      idx,
      segment.start,
      segment.end,
      vacation,
      overtime,
    );
    if (duration < 1) {
      duration = PLACEHOLDER_DAYS;
    }
    const segVacation = new Set<string>();
    const segOvertime = new Set<string>();
    for (const day of plan.vacation) {
      if (day >= segment.start && day <= segment.end) {
        const shifted = addDays(day, delta);
        if (shifted !== "") {
          segVacation.add(shifted);
        }
      }
    }
    for (const day of plan.overtime) {
      if (day >= segment.start && day <= segment.end) {
        const shifted = addDays(day, delta);
        if (shifted !== "" && !internal.isWorkdayIn(idx, shifted)) {
          segOvertime.add(shifted);
        }
      }
    }
    const end = internal.finishEffectiveIn(
      idx,
      target,
      duration,
      segVacation,
      segOvertime,
    );
    if (end === "") {
      throw rangeExceededError();
    }
    newSegments.push(
      makeSegment(target, end, Boolean(segment.holdBefore)),
    );
  }
  newSegments[0] = makeSegment(newSegments[0].start, newSegments[0].end);
  const deltaFor = (day: string): number | null => {
    for (let i = 0; i < source.length; i += 1) {
      if (day >= source[i].start && day <= source[i].end) {
        return deltas[i];
      }
    }
    return null;
  };
  const vacationOut: string[] = [];
  for (const day of plan.vacation) {
    const delta = deltaFor(day);
    if (delta === null) {
      vacationOut.push(day);
      continue;
    }
    const shifted = addDays(day, delta);
    if (shifted !== "") {
      vacationOut.push(shifted);
    }
  }
  const overtimeOut: string[] = [];
  for (const day of plan.overtime) {
    const delta = deltaFor(day);
    if (delta === null) {
      overtimeOut.push(day);
      continue;
    }
    const shifted = addDays(day, delta);
    if (shifted !== "" && !internal.isWorkdayIn(idx, shifted)) {
      overtimeOut.push(shifted);
    }
  }
  if (singleMode) {
    return normalize(
      {
        segments: [],
        days: plan.days,
        start: newSegments[0].start,
        delivery: newSegments[0].end,
        vacation: vacationOut,
        overtime: overtimeOut,
      },
      calendar,
    );
  }
  return normalize(
    {
      segments: newSegments,
      days: plan.days,
      vacation: vacationOut,
      overtime: overtimeOut,
    },
    calendar,
  );
}
