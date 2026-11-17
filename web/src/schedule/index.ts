// RSM 排期模块统一出口。字段全部 camelCase，与 Go internal/schedule 同规则；
// 校验失败抛 ScheduleError（带 code），与后端错误码一致。
//
// 后端接入：internal/requests/model.go 在写库前调用 schedule.Normalize；
// 前端表单/甘特预览可直接调用本模块，避免等待往返。

export {
  type Calendar,
  MAX_PLAN_DAYS,
  MAX_PLAN_YEARS,
  MAX_SUPPORTED_DATE,
  MIN_SUPPORTED_DATE,
  addDays,
  addWorkdays,
  countWorkdays,
  daySpan,
  defaultCalendar,
  isSupportedYear,
  isWorkday,
  nextWorkday,
  parseDate,
  prevWorkday,
  unsupportedYears,
  validDate,
  weekday,
  yearOf,
} from "./calendar";
export {
  type Gap,
  type NormalizeResult,
  type Plan,
  type Segment,
  PLACEHOLDER_DAYS,
  activeDays,
  clonePlan,
  deliveryOf,
  displayDays,
  effectiveDays,
  effectiveSegments,
  emptyPlan,
  estimated,
  gaps,
  makeSegment,
  normalize,
  overlapDays,
  overlaps,
  segmentDays,
  segmentEffectiveDays,
  totalDays,
  tryNormalize,
  unscheduled,
} from "./core";
export {
  addSegment,
  movePlan,
  moveSegment,
  removeSegment,
  resizeSegment,
  setDays,
  setDelivery,
  setOvertime,
  setVacation,
} from "./ops";
export {
  type SequenceChange,
  type SequenceRequest,
  type SequenceResult,
  sequence,
} from "./sequence";
export {
  type ScheduleErrorCode,
  ScheduleError,
  ScheduleErrorCode as ScheduleErrorCodes,
  isScheduleError,
} from "./errors";
