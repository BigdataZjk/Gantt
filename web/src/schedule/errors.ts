// 排期错误定义：错误码与 Go internal/schedule/errors.go 保持一致，
// 便于后端校验、前端预览与共享 fixture 用同一套断言。

export const ScheduleErrorCode = {
  invalidDate: "invalid_date",
  invalidDays: "invalid_days",
  segmentInvalid: "segment_invalid",
  segmentOrder: "segment_order",
  segmentOverlap: "segment_overlap",
  segmentNoWorkdays: "segment_no_workdays",
  rangeExceeded: "range_exceeded",
  daysTooSmall: "days_too_small",
  noWorkdays: "no_workdays",
  deliveryWithoutStart: "delivery_without_start",
  deliveryBeforeStart: "delivery_before_start",
  noSegments: "no_segments",
  indexOutOfRange: "index_out_of_range",
  invalidEdge: "invalid_edge",
  markInvalid: "mark_invalid",
  invalidPlan: "invalid_plan",
} as const;

export type ScheduleErrorCode =
  (typeof ScheduleErrorCode)[keyof typeof ScheduleErrorCode];

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
  }
}

export function isScheduleError(value: unknown): value is ScheduleError {
  return value instanceof ScheduleError;
}
