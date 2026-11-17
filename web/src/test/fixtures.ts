import { defaultCalendar, type Calendar } from "../schedule";
import type { ApiRequest } from "../api/types";

export const calendar: Calendar = defaultCalendar();

export function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    id: 1,
    revision: 1,
    name: "订单指标口径统一",
    priority: "P1",
    status: "待开发",
    prd: "https://example.com/prd",
    requester: "产品-小林",
    requestedAt: "2026-11-13",
    domain: "流量域",
    requestType: "常规需求",
    wangyue: "",
    developer: "u1",
    days: 3,
    start: "2026-11-16",
    delivery: "2026-11-18",
    project: "增长数据",
    brd: "",
    review: "",
    expected: "",
    notes: "",
    segments: [],
    vacation: [],
    overtime: [],
    archived: false,
    ...overrides,
  };
}

export const users = [
  { id: "u1", username: "张金科", role: "superadmin" as const, disabled: false, deleted: false, avatar: "" },
  { id: "u2", username: "李明", role: "collaborator" as const, disabled: false, deleted: false, avatar: "" },
];

export const domains = [
  { id: "d1", name: "流量域", color: "#3b82f6" },
  { id: "d2", name: "广告域", color: "#f97316" },
];
