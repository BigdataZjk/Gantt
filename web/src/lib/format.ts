import type { Priority, RequestType, Status } from "../api/types";
import { todayISO, addDays } from "./dates";

export const PRIORITIES: Priority[] = ["P0", "P1", "P2"];
export const STATUSES: Status[] = ["待评审", "待开发", "开发中", "已完成", "HOLD"];
export const REQUEST_TYPES: RequestType[] = ["常规需求", "数据需求"];

export const roleNames: Record<string, string> = {
  superadmin: "超级管理员",
  admin: "管理员",
  collaborator: "协作者",
  readonly: "只读",
  guest: "游客",
};

export function roleName(role?: string | null): string {
  return (role && roleNames[role]) || "只读";
}

export const ROLE_LABELS: { value: string; label: string }[] = [
  { value: "superadmin", label: "超级管理员" },
  { value: "admin", label: "管理员" },
  { value: "collaborator", label: "协作者" },
  { value: "readonly", label: "只读" },
];

export const PRIORITY_OPTIONS = [
  { value: "P0", label: "P0" },
  { value: "P1", label: "P1" },
  { value: "P2", label: "P2" },
];

export interface FieldCatalogEntry {
  key: string;
  label: string;
}

export const COLUMN_CATALOG: FieldCatalogEntry[] = [
  { key: "requesterRank", label: "优先级" },
  { key: "name", label: "需求名称" },
  { key: "domain", label: "业务域" },
  { key: "requestType", label: "需求类型" },
  { key: "developer", label: "开发人" },
  { key: "status", label: "状态" },
  { key: "start", label: "准入日期" },
  { key: "delivery", label: "交付日期" },
  { key: "days", label: "开发人天" },
  { key: "requester", label: "提需人" },
  { key: "requestedAt", label: "提需日期" },
  { key: "project", label: "项目" },
  { key: "prd", label: "PRD 链接" },
  { key: "wangyue", label: "望岳链接" },
  { key: "brd", label: "BRD 链接" },
  { key: "expected", label: "预期交付" },
  { key: "review", label: "评审时间" },
  { key: "notes", label: "备注" },
];

export const COLUMN_KEYS = COLUMN_CATALOG.map((entry) => entry.key);
export const ARCHIVE_COLUMN_KEYS = COLUMN_KEYS.filter((key) => key !== "status" && key !== "requesterRank");
export const DEFAULT_COLUMN_KEYS = COLUMN_KEYS.slice(0, 13);
export const DEFAULT_ARCHIVE_COLUMN_KEYS = DEFAULT_COLUMN_KEYS.filter((key) => ARCHIVE_COLUMN_KEYS.includes(key) && key !== "days");

export function formatDays(days: number): string {
  return days === 0 ? "0 · 待估人天" : String(days);
}

export function dateShortcutLabels(): { offset: number; label: string }[] {
  return [
    { offset: -1, label: "昨天" },
    { offset: 0, label: "今天" },
    { offset: 1, label: "明天" },
  ];
}

export function shortcutDate(offset: number): string {
  return addDays(todayISO(), offset);
}

export function initials(name: string): string {
  return Array.from((name || "").trim()).at(-1) ?? "?";
}

export function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN");
}
