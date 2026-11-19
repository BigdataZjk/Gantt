import type { ApiRequest, Calendar } from "../../../api/types";

type ScheduleFields = Pick<ApiRequest, "developer" | "days" | "start" | "delivery" | "segments" | "vacation" | "overtime" | "supportSegments">;

export interface GanttUndoStep {
  changes: { id: number; before: ScheduleFields; after: ScheduleFields }[];
  calendar: string;
}

export function scheduleSnapshot(row: ApiRequest): ScheduleFields {
  return {
    developer: row.developer,
    days: row.days,
    start: row.start,
    delivery: row.delivery,
    segments: (row.segments ?? []).map((segment) => ({ start: segment.start, end: segment.end, holdBefore: Boolean(segment.holdBefore) })),
    vacation: [...(row.vacation ?? [])].sort(),
    overtime: [...(row.overtime ?? [])].sort(),
    supportSegments: row.supportSegments?.length ? row.supportSegments.map((segment) => ({ ...segment })) : undefined,
  };
}

export function calendarSignature(calendar: Calendar): string {
  return JSON.stringify([[...calendar.restDays].sort(), [...calendar.workDays].sort()]);
}

export function makeUndoStep(before: ApiRequest[], after: ApiRequest[], calendar: Calendar): GanttUndoStep {
  return {
    calendar: calendarSignature(calendar),
    changes: before.flatMap((row) => {
      const saved = after.find((item) => item.id === row.id);
      if (!saved || JSON.stringify(scheduleSnapshot(row)) === JSON.stringify(scheduleSnapshot(saved))) return [];
      return [{ id: row.id, before: scheduleSnapshot(row), after: scheduleSnapshot(saved) }];
    }),
  };
}

export function restoreUndoStep(step: GanttUndoStep, current: ApiRequest[], calendar: Calendar): ApiRequest[] {
  if (calendarSignature(calendar) !== step.calendar) throw new Error("工作日历已更新，已跳过这一步撤回，请核对最新排期。");
  return step.changes.map((change) => {
    const latest = current.find((row) => row.id === change.id);
    if (!latest || latest.archived || JSON.stringify(scheduleSnapshot(latest)) !== JSON.stringify(change.after)) {
      throw new Error("这一步的排期已被后续操作修改、归档或删除，已跳过撤回，保留最新数据。");
    }
    const { before, after } = change;
    return {
      ...latest,
      ...before,
      segments: before.segments?.map((segment) => ({ ...segment })),
      vacation: [...(before.vacation ?? [])],
      overtime: [...(before.overtime ?? [])],
      supportSegments: before.supportSegments?.map((segment) => ({ ...segment })) ?? (after.supportSegments ? [] : undefined),
    };
  });
}

export function isTextUndoTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'));
}
