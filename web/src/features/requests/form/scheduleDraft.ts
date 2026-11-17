import type { ApiRequest } from "../../../api/types";
import {
  addDays,
  addSegment as scheduleAddSegment,
  addWorkdays,
  movePlan,
  nextWorkday,
  normalize,
  removeSegment as scheduleRemoveSegment,
  resizeSegment as scheduleResizeSegment,
  setDays as scheduleSetDays,
  setDelivery as scheduleSetDelivery,
  tryNormalize,
  type Calendar,
  type Plan,
  type Segment,
} from "../../../schedule";
import { isValidDate } from "../../../lib/dates";

/** 从需求表单读取排期；不改写任何字段，保证打开/普通编辑不漂移。 */
export function planOfDraft(draft: ApiRequest): Plan {
  return {
    segments: (draft.segments ?? []).map((segment) => ({ start: segment.start, end: segment.end })),
    days: Math.max(0, Number(draft.days) || 0),
    start: draft.start,
    delivery: draft.delivery,
    vacation: [...(draft.vacation ?? [])],
    overtime: [...(draft.overtime ?? [])],
  };
}

export function holdFlagsOf(draft: ApiRequest): boolean[] {
  return (draft.segments ?? []).map((segment) => Boolean(segment.holdBefore));
}

/** 把 schedule 结果写回表单；未变化的字段原样保留。 */
export function applyPlanToDraft(draft: ApiRequest, plan: Plan, flags?: boolean[]): ApiRequest {
  const segments = plan.segments.map((segment, index) => ({ start: segment.start, end: segment.end, holdBefore: Boolean(flags?.[index]) }));
  return {
    ...draft,
    segments,
    days: plan.days,
    start: plan.start,
    delivery: plan.delivery,
    vacation: [...plan.vacation],
    overtime: [...plan.overtime],
  };
}

export function deliveryDisplay(draft: ApiRequest): string {
  const segments = draft.segments ?? [];
  if (segments.length > 1) return segments[segments.length - 1]!.end;
  return draft.delivery;
}

export function startDisplay(draft: ApiRequest): string {
  const segments = draft.segments ?? [];
  if (segments.length > 1) return segments[0]!.start;
  return draft.start;
}

interface ChangeResult {
  draft: ApiRequest;
  error: string;
}

function fail(draft: ApiRequest, error: unknown): ChangeResult {
  return { draft, error: error instanceof Error ? error.message : "排期数据不合法" };
}

export function changeDays(draft: ApiRequest, calendar: Calendar, days: number): ChangeResult {
  try {
    return { draft: applyPlanToDraft(draft, scheduleSetDays(planOfDraft(draft), calendar, days), holdFlagsOf(draft)), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function changeStart(draft: ApiRequest, calendar: Calendar, start: string): ChangeResult {
  try {
    return { draft: applyPlanToDraft(draft, movePlan(planOfDraft(draft), calendar, start), holdFlagsOf(draft)), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function changeDelivery(draft: ApiRequest, calendar: Calendar, delivery: string): ChangeResult {
  try {
    return { draft: applyPlanToDraft(draft, scheduleSetDelivery(planOfDraft(draft), calendar, delivery), holdFlagsOf(draft)), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function changeSegmentEdge(draft: ApiRequest, calendar: Calendar, index: number, edge: "start" | "end", value: string): ChangeResult {
  try {
    return { draft: applyPlanToDraft(draft, scheduleResizeSegment(planOfDraft(draft), calendar, index, edge, value), holdFlagsOf(draft)), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function removeSegmentAt(draft: ApiRequest, calendar: Calendar, index: number): ChangeResult {
  try {
    const flags = holdFlagsOf(draft).filter((_, position) => position !== index);
    if (flags.length) flags[0] = false;
    const next = scheduleRemoveSegment(planOfDraft(draft), calendar, index);
    return { draft: applyPlanToDraft(draft, next, flags), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function addSegment(draft: ApiRequest, calendar: Calendar): ChangeResult {
  try {
    const plan = planOfDraft(draft);
    const segments = plan.segments.length ? plan.segments : plan.start && plan.delivery ? [{ start: plan.start, end: plan.delivery }] : [];
    const last = segments[segments.length - 1];
    if (!last) return { draft: { ...draft, segments: [...(draft.segments ?? []), { start: "", end: "", holdBefore: false }] }, error: "" };
    const afterLast = nextWorkday(addDays(last.end, 1), calendar);
    const start = addWorkdays(afterLast, 2, calendar);
    const end = addWorkdays(start, 1, calendar);
    const next = scheduleAddSegment(plan, calendar, start, end);
    return { draft: applyPlanToDraft(draft, next, [...holdFlagsOf(draft), false]), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function splitInitial(draft: ApiRequest, calendar: Calendar): ChangeResult {
  try {
    const plan = planOfDraft(draft);
    if (!plan.start) {
      return { draft: { ...draft, segments: [{ start: "", end: "", holdBefore: false }, { start: "", end: "", holdBefore: false }] }, error: "" };
    }
    const total = Math.max(1, plan.days || 3);
    const firstEnd = addWorkdays(plan.start, 1, calendar);
    const secondStart = nextWorkday(addDays(firstEnd, 2), calendar);
    const secondEnd = addWorkdays(secondStart, Math.max(1, total - 1), calendar);
    const normalized = normalize({ segments: [{ start: plan.start, end: firstEnd }, { start: secondStart, end: secondEnd }], days: total, start: plan.start, delivery: secondEnd, vacation: plan.vacation, overtime: plan.overtime }, calendar);
    return { draft: applyPlanToDraft(draft, normalized, [false, false]), error: "" };
  } catch (error) {
    return fail(draft, error);
  }
}

export function toggleHold(draft: ApiRequest, index: number, value: boolean): ApiRequest {
  return { ...draft, segments: (draft.segments ?? []).map((segment, position) => (position === index ? { ...segment, holdBefore: value } : segment)) };
}

export function normalizeForSubmit(draft: ApiRequest, calendar: Calendar): { draft: ApiRequest; error: string } {
  const result = tryNormalize(planOfDraft(draft), calendar);
  if (!result.ok) return { draft, error: result.message || "排期数据不合法" };
  return { draft: applyPlanToDraft(draft, result.plan, holdFlagsOf(draft)), error: "" };
}

export function segmentDelivery(segment: Segment | undefined): string {
  return segment && isValidDate(segment.end) ? segment.end : "";
}
export interface ScheduleGeometry {
  days: number;
  start: string;
  delivery: string;
  segments: { start: string; end: string }[];
}

export function geometryOf(request: Pick<ApiRequest, "days" | "start" | "delivery" | "segments">): ScheduleGeometry {
  return {
    days: Math.max(0, Number(request.days) || 0),
    start: request.start,
    delivery: request.delivery,
    segments: (request.segments ?? []).map((segment) => ({ start: segment.start, end: segment.end })),
  };
}

/** 仅比较排期几何：人天、准入、交付、各段起止；HOLD/休假/加班标记不参与。 */
export function sameScheduleGeometry(
  left: Pick<ApiRequest, "days" | "start" | "delivery" | "segments">,
  right: Pick<ApiRequest, "days" | "start" | "delivery" | "segments">,
): boolean {
  const a = geometryOf(left);
  const b = geometryOf(right);
  if (a.days !== b.days || a.start !== b.start || a.delivery !== b.delivery || a.segments.length !== b.segments.length) return false;
  return a.segments.every((segment, index) => segment.start === b.segments[index]!.start && segment.end === b.segments[index]!.end);
}

/** 编辑已存排期且几何未变时只做结构校验，不重算任何日期/人天。 */
export function validateScheduleStructure(draft: ApiRequest, calendar: Calendar): { error: string } {
  const result = tryNormalize(planOfDraft(draft), calendar);
  return result.ok ? { error: "" } : { error: result.message || "排期结构不合法" };
}
