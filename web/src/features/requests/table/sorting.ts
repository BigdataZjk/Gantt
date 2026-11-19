import type { ApiRequest, User } from "../../../api/types";
import { COLUMN_KEYS } from "../../../lib/format";
import { deliveryOf } from "../filtering";

export interface TableSort {
  key: string;
  direction: "asc" | "desc";
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const statuses = ["待评审", "待开发", "开发中", "HOLD", "已完成"];

export function normalizeTableSort(value: unknown): TableSort[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.filter((item): item is TableSort => {
    if (!item || typeof item.key !== "string" || !COLUMN_KEYS.includes(item.key) || used.has(item.key) || (item.direction !== "asc" && item.direction !== "desc")) return false;
    used.add(item.key);
    return true;
  }).map(({ key, direction }) => ({ key, direction }));
}

export function toggleTableSort(sorting: TableSort[], key: string): TableSort[] {
  return sorting.some((sort) => sort.key === key)
    ? sorting.map((sort) => sort.key === key ? { key, direction: sort.direction === "asc" ? "desc" : "asc" } : sort)
    : [...sorting, { key, direction: "asc" }];
}

export function newestRequests(rows: ApiRequest[], archive: boolean): ApiRequest[] {
  const key = archive ? "archivedAt" : "poolEnteredAt";
  return [...rows].sort((a, b) => {
    const timeA = Date.parse(a[key] || "") || 0;
    const timeB = Date.parse(b[key] || "") || 0;
    const fractionA = timeA ? (a[key]?.match(/\.(\d+)Z$/)?.[1] || "").padEnd(9, "0") : "";
    const fractionB = timeB ? (b[key]?.match(/\.(\d+)Z$/)?.[1] || "").padEnd(9, "0") : "";
    return timeB - timeA || fractionB.localeCompare(fractionA) || b.id - a.id;
  });
}

export function sortRequests(rows: ApiRequest[], sorting: TableSort[], users: User[], ranksAtEditStart?: ReadonlyMap<number, number> | null): ApiRequest[] {
  if (!sorting.length) return rows;
  const names = new Map(users.map((user) => [user.id, user.username]));
  const valueOf = (row: ApiRequest, key: string): string | number => {
    if (key === "developer") return names.get(row.developer) || "";
    if (key === "delivery") return deliveryOf(row);
    if (key === "days") return Number(row.days) || 0;
    if (key === "requesterRank") return (ranksAtEditStart?.get(row.id) ?? row.requesterRank) || Number.POSITIVE_INFINITY;
    if (key === "status") return statuses.indexOf(row.status);
    return String(row[key as keyof ApiRequest] ?? "").trim();
  };
  return [...rows].sort((a, b) => {
    for (const { key, direction } of sorting) {
      const x = valueOf(a, key);
      const y = valueOf(b, key);
      if (x === y) continue;
      if (x === "" || y === "") return x === "" ? 1 : -1;
      const diff = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
      if (diff) return direction === "asc" ? diff : -diff;
    }
    return 0;
  });
}
