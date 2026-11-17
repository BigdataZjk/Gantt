import { isValidDate, todayISO } from "./dates";
import type { ApiRequest, Domain, User } from "../api/types";
import { PRIORITIES, REQUEST_TYPES, STATUSES } from "./format";

export const CHINESE_PUNCTUATION = /[【】、，；：。！？“”‘’（）《》〈〉「」『』〔〕…—～]/u;
const URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const USERNAME_PATTERN = /^[\p{L}\p{N}_·.-]+$/u;

export interface ValidationIssue {
  error: string;
  field: string;
  tab: "required" | "schedule" | "extra";
}

export function validLink(value: string | undefined | null): boolean {
  return !!value && URL_PATTERN.test(value);
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export function isValidPassword(value: string): boolean {
  return value.length > 0;
}

export function validateRequest(
  draft: ApiRequest,
  options: { users: User[]; domains: Domain[]; existingDeveloper?: string },
): ValidationIssue | null {
  const fail = (error: string, field: string, tab: ValidationIssue["tab"] = "required"): ValidationIssue => ({ error, field, tab });
  const name = (draft.name || "").trim();
  if (!name) return fail("请填写需求名称", "name");
  if (CHINESE_PUNCTUATION.test(name)) return fail("需求名称不能含中文标点，请使用英文符号，如 [] - .", "name");
  if (!validLink(draft.prd)) return fail("请填写 PRD 链接", "prd");
  if (!PRIORITIES.includes(draft.priority)) return fail("请选择优先级", "priority");
  if (!STATUSES.includes(draft.status)) return fail("请选择状态", "status");
  if (!(draft.requester || "").trim()) return fail("请填写提需人", "requester");
  if (!isValidDate(draft.requestedAt)) return fail("请填写提需日期", "requestedAt");
  if (draft.domain && !options.domains.some((domain) => domain.name === draft.domain)) return fail("请选择业务域", "domain", "schedule");
  if (!REQUEST_TYPES.includes(draft.requestType)) return fail("请选择需求类型", "requestType", "schedule");
  const activeIds = new Set(options.users.filter((user) => !user.disabled && !user.deleted).map((user) => user.id));
  if (draft.developer && !activeIds.has(draft.developer) && draft.developer !== options.existingDeveloper) {
    return fail("开发人必须选择已启用的现有账号", "developer", "schedule");
  }
  const days = Number(draft.days);
  if (!Number.isInteger(days) || days < 0) return fail("开发人天请填写 0 或正整数", "days", "schedule");
  if (draft.wangyue && !validLink(draft.wangyue)) return fail("请填写有效的望岳工单链接", "wangyue", "schedule");
  if (draft.brd && !validLink(draft.brd)) return fail("请填写有效的 BRD 链接", "brd", "extra");
  const segments = draft.segments ?? [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!isValidDate(segment.start) || !isValidDate(segment.end) || segment.end < segment.start) {
      return fail("请检查分段日期，开始日期不能晚于结束日期", "start", "schedule");
    }
    if (index > 0 && segment.start <= segments[index - 1]!.end) {
      return fail("请检查分段日期，后段开始日期必须晚于前段结束日期", "start", "schedule");
    }
  }
  return null;
}

export const DEFAULT_REQUESTED_AT = todayISO();
