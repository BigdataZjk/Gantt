import type { ApiRequest, Calendar, Segment, User } from "../../../api/types";
import { addDays, countDays, diffDays, finishDate, isWorkday, isValidDate, todayISO } from "../../../lib/dates";
import { movePlan, type Plan as SchedulePlan } from "../../../schedule";

export interface GanttSegment extends Segment {
  index: number;
}

export interface DayInfo {
  phaseIndex: number;
  active: boolean;
  overtime: boolean;
  hold: boolean;
  dayType: "" | "leave" | "overtime";
  mark: "" | "leave" | "overtime" | "hold" | "estimated";
  visible: boolean;
  inSegment: boolean;
}

export interface HoldGap {
  afterIndex: number;
  start: string;
  end: string;
}

export interface Plan {
  segments: GanttSegment[];
  delivery: string;
  days: number;
}

export function planOf(request: ApiRequest, calendar: Calendar): Plan {
  const raw = (request.segments ?? [])
    .filter((segment) => isValidDate(segment.start) && isValidDate(segment.end) && segment.end >= segment.start)
    .map((segment, index) => ({ start: segment.start, end: segment.end, holdBefore: Boolean(segment.holdBefore), index }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  if (raw.length) {
    return { segments: raw, delivery: raw[raw.length - 1]!.end, days: Math.max(0, Number(request.days) || 0) };
  }
  if (!isValidDate(request.start)) return { segments: [], delivery: "", days: Math.max(0, Number(request.days) || 0) };
  const end = request.delivery && isValidDate(request.delivery) && request.delivery >= request.start
    ? request.delivery
    : finishDate(request.start, Number(request.days) || 3, calendar, { vacation: request.vacation, overtime: request.overtime });
  if (!end) return { segments: [], delivery: "", days: Math.max(0, Number(request.days) || 0) };
  return { segments: [{ start: request.start, end, holdBefore: false, index: 0 }], delivery: end, days: Math.max(0, Number(request.days) || 0) };
}

export function activeDaysInSegment(request: ApiRequest, segment: Segment, calendar: Calendar): number {
  return countDays(segment.start, segment.end, calendar, { vacation: request.vacation, overtime: request.overtime });
}

export function requestActiveDays(request: ApiRequest, calendar: Calendar): number {
  return planOf(request, calendar).segments.reduce((total, segment) => total + activeDaysInSegment(request, segment, calendar), 0);
}

export function segmentFillBounds(request: ApiRequest, calendar: Calendar): ({ start: string; end: string } | null)[] {
  const vacation = new Set(request.vacation ?? []);
  const overtime = new Set(request.overtime ?? []);
  const active = (date: string) => !vacation.has(date) && (isWorkday(date, calendar) || overtime.has(date));
  return planOf(request, calendar).segments.map((segment) => {
    let start = segment.start;
    let end = segment.end;
    while (start <= end && !active(start)) start = addDays(start, 1);
    if (start > end) return null;
    while (end > start && !active(end)) end = addDays(end, -1);
    return { start, end };
  });
}

export function workingHoldGaps(request: ApiRequest, calendar: Calendar): HoldGap[] {
  const { segments } = planOf(request, calendar);
  const gaps: HoldGap[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1]!;
    const next = segments[index]!;
    const start = addDays(previous.end, 1);
    const end = addDays(next.start, -1);
    if (next.holdBefore && start <= end && countDays(start, end, calendar) > 0) gaps.push({ afterIndex: index, start, end });
  }
  return gaps;
}

export function hasWorkingHold(request: ApiRequest, index: number, calendar: Calendar): boolean {
  return workingHoldGaps(request, calendar).some((gap) => gap.afterIndex === index);
}

export function dayResolver(request: ApiRequest, calendar: Calendar): (date: string) => DayInfo {
  const plan = planOf(request, calendar);
  const vacation = new Set(request.vacation ?? []);
  const overtime = new Set(request.overtime ?? []);
  const gaps = workingHoldGaps(request, calendar);
  const estimated = (Number(request.days) || 0) === 0;
  return (date: string): DayInfo => {
    const phaseIndex = plan.segments.findIndex((segment) => date >= segment.start && date <= segment.end);
    const inSegment = phaseIndex >= 0;
    const working = isWorkday(date, calendar);
    const leave = vacation.has(date);
    const overtimeMarked = !working && overtime.has(date);
    const dayType: DayInfo["dayType"] = leave ? "leave" : overtimeMarked ? "overtime" : "";
    const active = inSegment && !leave && (working || overtime.has(date));
    const hold = !active && working && gaps.some((item) => date >= item.start && date <= item.end);
    let mark: DayInfo["mark"] = "";
    if (leave) mark = "leave";
    else if (overtimeMarked) mark = "overtime";
    else if (hold) mark = "hold";
    else if (active && estimated) mark = "estimated";
    return { phaseIndex, inSegment, active, overtime: overtimeMarked, hold, dayType, mark, visible: active || hold || leave || overtimeMarked };
  };
}

export function dayInfo(request: ApiRequest, date: string, calendar: Calendar): DayInfo {
  return dayResolver(request, calendar)(date);
}


export function deliveryLabel(request: ApiRequest, calendar: Calendar): string {
  return planOf(request, calendar).delivery || request.delivery || "";
}

export interface GanttGroup {
  developer: string;
  name: string;
  deleted: boolean;
  rows: ApiRequest[];
}

export function groupRequests(rows: ApiRequest[], users: User[], calendar: Calendar, rowOrder: Record<string, number[]>): GanttGroup[] {
  const starts = new Map(rows.map((row) => [row.id, planOf(row, calendar).segments[0]?.start ?? ""]));
  const sorted = (list: ApiRequest[], developer: string) => {
    const rank = new Map((rowOrder[developer] ?? []).map((id, index) => [id, index]));
    return list.sort((a, b) => {
      const startA = starts.get(a.id)!;
      const startB = starts.get(b.id)!;
      if (Boolean(startA) !== Boolean(startB)) return startA ? -1 : 1;
      return (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || startA.localeCompare(startB) || a.id - b.id;
    });
  };
  const people = new Map<string, { id: string; name: string; deleted: boolean; order: number }>();
  users.forEach((user, index) => {
    if (user.deleted) return;
    people.set(user.id, { id: user.id, name: user.username, deleted: false, order: index });
  });
  for (const row of rows) {
    if (!row.developer || people.has(row.developer)) continue;
    const deletedUser = users.find((user) => user.id === row.developer);
    people.set(row.developer, { id: row.developer, name: deletedUser?.username || "已删除账号", deleted: true, order: users.length });
  }
  const groups: GanttGroup[] = [...people.values()]
    .sort((a, b) => a.order - b.order)
    .map((person) => {
      const list = sorted(rows.filter((row) => row.developer === person.id), person.id);
      return { developer: person.id, name: person.name, deleted: person.deleted, rows: list };
    });
  const unassigned = sorted(rows.filter((row) => !row.developer), "");
  if (unassigned.length) groups.push({ developer: "", name: "-", deleted: false, rows: unassigned });
  return groups;
}

export interface OverlapBadge {
  fromId: number;
  toId: number;
  start: string;
  end: string;
  anchorDate: string;
  offset: number;
}

export function overlapBadges(group: ApiRequest[], dates: string[], calendar: Calendar): Map<string, OverlapBadge> {
  const badges = new Map<string, OverlapBadge>();
  if (group.length < 2) return badges;
  const active = group.map((row) => {
    const resolve = dayResolver(row, calendar);
    return dates.map((date) => resolve(date).active);
  });
  for (let index = 0; index < group.length - 1; index += 1) {
    const upper = group[index]!;
    const lower = group[index + 1]!;
    let first = -1;
    for (let cursor = 0; cursor <= dates.length; cursor += 1) {
      const shared = cursor < dates.length && active[index]![cursor] && active[index + 1]![cursor];
      if (shared && first < 0) first = cursor;
      if (!shared && first >= 0) {
        const last = cursor - 1;
        const center = (first + last) / 2;
        const anchor = Math.floor(center);
        const anchorDate = dates[anchor]!;
        badges.set(`${upper.id}|${anchorDate}`, { fromId: upper.id, toId: lower.id, start: dates[first]!, end: dates[last]!, anchorDate, offset: (center - anchor) * 24 });
        first = -1;
      }
    }
  }
  return badges;
}

export interface HoldCell {
  centerOffset: number | null;
}

export function holdLayout(request: ApiRequest, dates: string[], calendar: Calendar): Map<string, HoldCell> {
  const cells = new Map<string, HoldCell>();
  for (const gap of workingHoldGaps(request, calendar)) {
    const center = diffDays(gap.start, gap.end) / 2;
    const anchor = addDays(gap.start, Math.floor(center));
    for (const date of dates) {
      if (date >= gap.start && date <= gap.end) {
        cells.set(date, { centerOffset: date === anchor ? center - Math.floor(center) : null });
      }
    }
  }
  return cells;
}

export function estimateCenters(request: ApiRequest, dates: string[], calendar: Calendar): Set<string> {
  const centers = new Set<string>();
  if ((Number(request.days) || 0) !== 0) return centers;
  for (const segment of planOf(request, calendar).segments) {
    const days = dates.filter((date) => date >= segment.start && date <= segment.end && dayInfo(request, date, calendar).active);
    if (days.length) centers.add(days[Math.floor((days.length - 1) / 2)]!);
  }
  return centers;
}

export function currentLivePhase(request: ApiRequest, today: string, calendar: Calendar): number {
  if (!request.developer || !["待开发", "开发中"].includes(request.status) || request.archived) return -1;
  const info = dayInfo(request, today, calendar);
  return info.active ? info.phaseIndex : -1;
}

export function motionTitle(request: ApiRequest, today: string, calendar: Calendar, reduced: boolean): string {
  if (!request.developer) return "未播放粒子：未分配开发人";
  if (!["待开发", "开发中"].includes(request.status) || request.archived) return `未播放粒子：当前状态为${request.archived ? "已归档" : request.status}`;
  const info = dayInfo(request, today, calendar);
  if (info.dayType === "leave") return "未播放粒子：今天已标记休假";
  if (!info.active) return isWorkday(today, calendar) ? "未播放粒子：今天不在有效开发段内" : "未播放粒子：今天是休息日，未安排加班";
  if (reduced) return "当前开发段：已开启减少动效，粒子保持静态";
  return "当前开发段：浮动粒子动效";
}

export function monthGroups(dates: string[]): { key: string; count: number; first: string; last: string }[] {
  const groups: { key: string; count: number; first: string; last: string }[] = [];
  for (const date of dates) {
    const key = date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.last = date;
    } else {
      groups.push({ key, count: 1, first: date, last: date });
    }
  }
  return groups;
}

export function dateScale(width: number): "day" | "week" | "fortnight" | "month" {
  if (width >= 20) return "day";
  if (width >= 8) return "week";
  if (width >= 4) return "fortnight";
  return "month";
}

export function dateHeaders(dates: string[], width: number, today: string, calendar: Calendar): { date: string; tick: boolean; rest: boolean; current: boolean; monthStart: boolean; monthEnd: boolean }[] {
  const spacing = Math.max(1, Math.ceil(20 / width));
  let last = -spacing;
  return dates.map((date, index) => {
    const day = Number(date.slice(-2));
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    const candidate = width >= 20 || (index === 0 && width >= 4) || day === 1 || (width >= 8 && weekday === 1) || (width >= 4 && width < 8 && day === 15);
    const tick = candidate && index - last >= spacing;
    if (tick) last = index;
    return {
      date,
      tick,
      rest: !isWorkday(date, calendar),
      current: date === today,
      monthStart: date.endsWith("-01"),
      monthEnd: index === dates.length - 1 && addDays(date, 1).endsWith("-01"),
    };
  });
}

export function nextWorkingDate(date: string, calendar: Calendar): string {
  let value = date;
  let guard = 0;
  while (value && !isWorkday(value, calendar) && guard < 370) {
    value = addDays(value, 1);
    guard += 1;
  }
  return value;
}

export function shiftSchedule(request: ApiRequest, start: string, calendar: Calendar): ApiRequest {
  const plan = planOf(request, calendar);
  const input: SchedulePlan = {
    segments: plan.segments.map((segment) => ({ start: segment.start, end: segment.end, holdBefore: segment.holdBefore })),
    days: Math.max(0, Number(request.days) || 0),
    start: request.start,
    delivery: request.delivery,
    vacation: [...(request.vacation ?? [])],
    overtime: [...(request.overtime ?? [])],
  };
  try {
    const moved = movePlan(input, calendar, start);
    return {
      ...request,
      segments: moved.segments.map((segment) => ({ start: segment.start, end: segment.end, holdBefore: Boolean(segment.holdBefore) })),
      days: moved.days,
      start: moved.start,
      delivery: moved.delivery,
      vacation: [...moved.vacation],
      overtime: [...moved.overtime],
    };
  } catch {
    return request;
  }
}


export interface SequenceChange {
  before: ApiRequest;
  after: ApiRequest;
  selected: boolean;
}

export interface SequencePlan {
  ids: number[];
  selectedCount: number;
  changes: SequenceChange[];
  warnings: string[];
}

export function buildSequencePlan(requests: ApiRequest[], selectedIds: number[], calendar: Calendar): SequencePlan {
  const selected = new Set(selectedIds);
  const changes: SequenceChange[] = [];
  const warnings: string[] = [];
  const eligible = (row: ApiRequest) => !row.archived && Boolean(row.developer) && planOf(row, calendar).segments.length > 0;
  const people = [...new Set(requests.filter((row) => selected.has(row.id) && eligible(row)).map((row) => row.developer))];
  for (const person of people) {
    const rows = requests.filter((row) => row.developer === person && eligible(row)).sort((a, b) => planOf(a, calendar).segments[0]!.start.localeCompare(planOf(b, calendar).segments[0]!.start) || a.id - b.id);
    const blocks: ApiRequest[][] = [];
    rows.forEach((row, index) => {
      if (index === 0 || (selected.has(rows[index - 1]!.id) && selected.has(row.id))) blocks.push([]);
      blocks[blocks.length - 1]!.push(row);
    });
    for (const block of blocks) {
      const chosen = block.filter((row) => selected.has(row.id));
      const locked = block.filter((row) => !selected.has(row.id));
      if (chosen.length > 1 && locked.length && block.some((row, index) => index > 0 && overlaps(block[index - 1]!, row, calendar))) {
        warnings.push(`${personName(person, requests)}：“${locked.map((row) => row.name).join("、")}”未选中，需保持其与前后需求的衔接和交叠关系；“${chosen.map((row) => row.name).join("、")}”不能分开顺排。`);
      }
    }
    const placed: ApiRequest[] = [];
    for (const block of blocks) {
      const latest = placed.reduce((end, row) => {
        const delivery = planOf(row, calendar).delivery;
        return delivery > end ? delivery : end;
      }, "");
      const earliest = latest ? nextWorkingDate(addDays(latest, 1), calendar) : planOf(block[0]!, calendar).segments[0]!.start;
      const blockStart = planOf(block[0]!, calendar).segments[0]!.start;
      const start = blockStart > earliest ? blockStart : earliest;
      let moved = block.map((row) => ({ ...row }));
      if (start !== blockStart) {
        try {
          moved = block.map((row, index) => {
            if (index === 0) return shiftSchedule(row, start, calendar);
            const previousOriginal = block[index - 1]!;
            const previousMoved = moved[index - 1] ?? block[index - 1]!;
            const gap = workingGap(previousOriginal, row, calendar);
            const target = addDays(planOf(previousMoved, calendar).delivery, gap + 1);
            const next = shiftSchedule(row, nextWorkingDate(target, calendar), calendar);
            return next;
          });
        } catch {
          warnings.push(`${personName(person, requests)}：无法同时保持未选需求的原有关系和交叠天数，请一并勾选相邻需求`);
          moved = block.map((row) => ({ ...row }));
        }
      }
      block.forEach((row, index) => {
        const after = moved[index]!;
        if (JSON.stringify(row) !== JSON.stringify(after)) changes.push({ before: row, after, selected: selected.has(row.id) });
      });
      placed.push(...moved);
    }
  }
  return { ids: [...selected], selectedCount: requests.filter((row) => selected.has(row.id) && eligible(row)).length, changes, warnings: [...new Set(warnings)] };
}

function workingGap(previous: ApiRequest, next: ApiRequest, calendar: Calendar): number {
  const end = planOf(previous, calendar).delivery;
  const start = planOf(next, calendar).segments[0]?.start ?? "";
  if (!end || !start) return 0;
  return Math.max(0, countDays(addDays(end, 1), addDays(start, -1), calendar));
}

function overlaps(a: ApiRequest, b: ApiRequest, calendar: Calendar): boolean {
  const planA = planOf(a, calendar);
  const planB = planOf(b, calendar);
  if (!planA.segments.length || !planB.segments.length) return false;
  const start = planA.segments[0]!.start > planB.segments[0]!.start ? planA.segments[0]!.start : planB.segments[0]!.start;
  const end = planA.delivery < planB.delivery ? planA.delivery : planB.delivery;
  for (let date = start, guard = 0; date <= end && guard < 3700; date = addDays(date, 1), guard += 1) {
    if (dayInfo(a, date, calendar).active && dayInfo(b, date, calendar).active) return true;
  }
  return false;
}

function personName(person: string, requests: ApiRequest[]): string {
  if (!person) return "-";
  return requests.find((row) => row.developer === person)?.developer ? person : person;
}

export function admissionSortOrder(requests: ApiRequest[], selectedIds: number[], developer: string, calendar: Calendar): number[] | null {
  const selected = new Set(selectedIds);
  const rows = groupRequests(requests, [], calendar, {}).find((group) => group.developer === developer)?.rows ?? [];
  if (rows.length < 2) return null;
  const chosen = rows.filter((row) => selected.has(row.id));
  if (chosen.length < 2) return null;
  const sorted = [...chosen].sort((a, b) => (planOf(a, calendar).segments[0]?.start ?? "9999").localeCompare(planOf(b, calendar).segments[0]?.start ?? "9999") || a.id - b.id);
  let index = 0;
  const next = rows.map((row) => (selected.has(row.id) ? sorted[index++]!.id : row.id));
  if (next.every((id, position) => id === rows[position]?.id)) return null;
  return next;
}

export function todayDate(): string {
  return todayISO();
}
export interface SupplementResult {
  request: ApiRequest;
  added: number;
}

function mergeSegments(request: ApiRequest, calendar: Calendar, extraDates: string[]): Segment[] {
  const plan = planOf(request, calendar);
  const added = new Set(extraDates.filter((date) => isValidDate(date)));
  const pieces = [
    ...plan.segments.map((segment) => ({ start: segment.start, end: segment.end, touched: false })),
    ...[...added].map((date) => ({ start: date, end: date, touched: true })),
  ].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged: { start: string; end: string; touched: boolean }[] = [];
  const blocked = (start: string, end: string) => {
    for (let date = start, guard = 0; date <= end && guard < 740; date = addDays(date, 1), guard += 1) {
      if (isWorkday(date, calendar) && !(request.vacation ?? []).includes(date) && !added.has(date)) return true;
    }
    return false;
  };
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    const joins = previous && (piece.start <= previous.end || ((previous.touched || piece.touched) && !blocked(addDays(previous.end, 1), addDays(piece.start, -1))));
    if (joins) {
      previous.end = previous.end > piece.end ? previous.end : piece.end;
      previous.touched = previous.touched || piece.touched;
    } else {
      merged.push({ ...piece });
    }
  }
  const holds = plan.segments
    .map((segment, index) => (index && segment.holdBefore ? { start: addDays(plan.segments[index - 1]!.end, 1), end: addDays(segment.start, -1) } : null))
    .filter((gap): gap is { start: string; end: string } => Boolean(gap));
  return merged.map(({ start, end }, index) => {
    if (index === 0) return { start, end, holdBefore: false };
    const previousEnd = merged[index - 1]!.end;
    const holdBefore = holds.some((gap) => {
      const gapStart = gap.start > addDays(previousEnd, 1) ? gap.start : addDays(previousEnd, 1);
      const gapEnd = gap.end < addDays(start, -1) ? gap.end : addDays(start, -1);
      return gapStart <= gapEnd && countDays(gapStart, gapEnd, calendar) > 0;
    });
    return { start, end, holdBefore };
  });
}

export function supplementRequest(request: ApiRequest, dates: string[], calendar: Calendar): SupplementResult {
  const eligible = dates.filter((date) => isWorkday(date, calendar) && !(request.vacation ?? []).includes(date) && !dayInfo(request, date, calendar).inSegment);
  if (!eligible.length) return { request, added: 0 };
  const segments = mergeSegments(request, calendar, eligible);
  const total = segments.reduce((sum, segment) => sum + countDays(segment.start, segment.end, calendar, { vacation: request.vacation, overtime: request.overtime }), 0);
  return {
    request: {
      ...request,
      segments,
      start: segments[0]?.start ?? request.start,
      delivery: segments[segments.length - 1]?.end ?? request.delivery,
      days: (Number(request.days) || 0) === 0 ? 0 : total,
    },
    added: eligible.length,
  };
}

export function extendLastSegment(request: ApiRequest, targetEnd: string, calendar: Calendar): ApiRequest {
  const plan = planOf(request, calendar);
  const last = plan.segments[plan.segments.length - 1];
  if (!last || targetEnd <= last.end) return request;
  const segments = plan.segments.map((segment, index) => ({ start: segment.start, end: index === plan.segments.length - 1 ? targetEnd : segment.end, holdBefore: segment.holdBefore }));
  const total = segments.reduce((sum, segment) => sum + countDays(segment.start, segment.end, calendar, { vacation: request.vacation, overtime: request.overtime }), 0);
  return {
    ...request,
    segments,
    start: segments[0]!.start,
    delivery: segments[segments.length - 1]!.end,
    days: (Number(request.days) || 0) === 0 ? 0 : total,
  };
}

export function removeSegment(request: ApiRequest, phaseIndex: number, calendar: Calendar): ApiRequest {
  const plan = planOf(request, calendar);
  const removed = plan.segments[phaseIndex];
  if (!removed) return request;
  const segments = plan.segments.filter((_, index) => index !== phaseIndex).map((segment, index) => ({ start: segment.start, end: segment.end, holdBefore: index === 0 ? false : segment.holdBefore }));
  const vacation = (request.vacation ?? []).filter((date) => date < removed.start || date > removed.end);
  const overtime = (request.overtime ?? []).filter((date) => date < removed.start || date > removed.end);
  if (!segments.length) return { ...request, segments: [], start: "", delivery: "", vacation, overtime, days: Number(request.days) || 0 };
  const total = segments.reduce((sum, segment) => sum + countDays(segment.start, segment.end, calendar, { vacation, overtime }), 0);
  return {
    ...request,
    segments,
    start: segments[0]!.start,
    delivery: segments[segments.length - 1]!.end,
    days: (Number(request.days) || 0) === 0 ? 0 : total,
    vacation,
    overtime,
  };
}

export function admissionSortOrderForRows(rows: ApiRequest[], selectedIds: number[], calendar: Calendar): number[] | null {
  const selected = new Set(selectedIds);
  const chosen = rows.filter((row) => selected.has(row.id));
  if (chosen.length < 2) return null;
  const sorted = [...chosen].sort((a, b) => (planOf(a, calendar).segments[0]?.start ?? "9999").localeCompare(planOf(b, calendar).segments[0]?.start ?? "9999") || a.id - b.id);
  let index = 0;
  const next = rows.map((row) => (selected.has(row.id) ? sorted[index++]!.id : row.id));
  if (next.every((id, position) => id === rows[position]?.id)) return null;
  return next;
}

export function moveSegmentDates(request: ApiRequest, phaseIndex: number, start: string, calendar: Calendar): ApiRequest | null {
  const plan = planOf(request, calendar);
  const segment = plan.segments[phaseIndex];
  if (!segment) return null;
  const delta = Math.round((new Date(start + "T12:00:00Z").getTime() - new Date(segment.start + "T12:00:00Z").getTime()) / 86400000);
  if (!delta) return request;
  const inside = (date: string) => date >= segment.start && date <= segment.end;
  const shift = (date: string) => addDays(date, delta);
  const vacation = [...(request.vacation ?? []).filter((date) => !inside(date)), ...(request.vacation ?? []).filter(inside).map(shift)].sort();
  const overtime = [...(request.overtime ?? []).filter((date) => !inside(date)), ...(request.overtime ?? []).filter(inside).map(shift).filter((date) => !isWorkday(date, calendar))].sort();
  if (!isWorkday(start, calendar) && !overtime.includes(start)) overtime.push(start);
  const active = countDays(segment.start, segment.end, calendar, { vacation: request.vacation, overtime: request.overtime });
  const end = finishDate(start, Math.max(1, active), calendar, { vacation, overtime });
  if (!end) return null;
  const others = plan.segments.filter((_, index) => index !== phaseIndex);
  if (others.some((other) => start <= other.end && end >= other.start)) return null;
  const segments = [...plan.segments.map((item, index) => (index === phaseIndex ? { start, end, holdBefore: item.holdBefore } : { start: item.start, end: item.end, holdBefore: item.holdBefore }))].sort((a, b) => a.start.localeCompare(b.start));
  segments[0]!.holdBefore = false;
  const total = segments.reduce((sum, item) => sum + countDays(item.start, item.end, calendar, { vacation, overtime }), 0);
  return {
    ...request,
    segments,
    start: segments[0]!.start,
    delivery: segments[segments.length - 1]!.end,
    vacation,
    overtime,
    days: (Number(request.days) || 0) === 0 ? 0 : total,
  };
}

export function resizeSegmentDates(request: ApiRequest, phaseIndex: number, edge: "start" | "end", target: string, calendar: Calendar): ApiRequest | null {
  const plan = planOf(request, calendar);
  const segment = plan.segments[phaseIndex];
  if (!segment) return null;
  let start = segment.start;
  let end = segment.end;
  if (edge === "start") {
    start = target < segment.end ? target : segment.end;
    if (start < segment.start) {
      const previous = plan.segments[phaseIndex - 1];
      const limit = previous ? addDays(previous.end, 1) : "";
      if (limit && start < limit) start = limit;
    }
    let guard = 0;
    while (start <= end && !isWorkday(start, calendar) && !(request.overtime ?? []).includes(start) && guard < 370) {
      start = addDays(start, 1);
      guard += 1;
    }
  } else {
    end = target > segment.start ? target : segment.start;
    if (end > segment.end) {
      const next = plan.segments[phaseIndex + 1];
      const limit = next ? addDays(next.start, -1) : "";
      if (limit && end > limit) end = limit;
    }
    let guard = 0;
    while (end >= start && !isWorkday(end, calendar) && !(request.overtime ?? []).includes(end) && guard < 370) {
      end = addDays(end, -1);
      guard += 1;
    }
  }
  if (start > end) return null;
  const days = countDays(start, end, calendar, { vacation: request.vacation, overtime: request.overtime });
  if (days < 1) return null;
  const segments = plan.segments.map((item, index) => (index === phaseIndex ? { start, end, holdBefore: item.holdBefore } : { start: item.start, end: item.end, holdBefore: item.holdBefore }));
  const total = segments.reduce((sum, item) => sum + countDays(item.start, item.end, calendar, { vacation: request.vacation, overtime: request.overtime }), 0);
  return {
    ...request,
    segments,
    start: segments[0]!.start,
    delivery: segments[segments.length - 1]!.end,
    days: (Number(request.days) || 0) === 0 ? 0 : total,
  };
}
