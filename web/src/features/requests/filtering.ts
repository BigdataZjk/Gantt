import type { ApiRequest, Domain, User } from "../../api/types";
import type { UiFilters } from "../../app/uiState";
import { countDays } from "../../lib/dates";

export const UNASSIGNED = "unassigned";

export function scopeRequests(requests: ApiRequest[], tab: "gantt" | "pool" | "archive"): ApiRequest[] {
  return requests.filter((request) => (tab === "archive" ? request.archived === true : request.archived !== true));
}

export function deliveryOf(request: ApiRequest): string {
  const segments = (request.segments ?? []).filter((segment) => segment.start && segment.end);
  if (segments.length) {
    return segments.reduce((latest, segment) => (segment.end > latest ? segment.end : latest), "");
  }
  return request.delivery || "";
}

export function startOf(request: ApiRequest): string {
  const segments = (request.segments ?? []).filter((segment) => segment.start);
  if (segments.length) return segments[0]!.start;
  return request.start || "";
}

export function currentDays(request: ApiRequest): number {
  return Math.max(0, Number(request.days) || 0);
}

export function filterRequests(rows: ApiRequest[], filters: UiFilters, options: { applyDates: boolean }): ApiRequest[] {
  const query = filters.query.trim().toLowerCase();
  const priorities = filters.priority.length && filters.priority.length < 3 ? new Set(filters.priority) : null;
  return rows.filter((row) => {
    if (filters.domain.length && !filters.domain.includes(row.domain)) return false;
    if (filters.developer.length && !filters.developer.includes(normalizeDeveloper(row.developer))) return false;
    if (filters.requestType.length && !filters.requestType.includes(row.requestType)) return false;
    if (filters.status.length && !filters.status.includes(row.status)) return false;
    if (priorities && !priorities.has(row.priority)) return false;
    if (options.applyDates) {
      const start = startOf(row);
      const end = deliveryOf(row);
      if (filters.start && (!start || start < filters.start)) return false;
      if (filters.end && (!end || end > filters.end)) return false;
    }
    if (query) {
      const haystack = `${row.name} ${row.requester} ${row.notes}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function normalizeDeveloper(value: string): string {
  return value || UNASSIGNED;
}

export function developerName(users: User[], id: string): string {
  if (!id || id === UNASSIGNED) return "-";
  const user = users.find((candidate) => candidate.id === id);
  return user?.username ?? "-";
}

export function domainOptions(domains: Domain[]): { value: string; label: string }[] {
  return domains.map((domain) => ({ value: domain.name, label: domain.name }));
}

export function developerOptions(users: User[]): { value: string; label: string }[] {
  const active = users.filter((user) => !user.deleted).map((user) => ({ value: user.id, label: user.username }));
  return [...active, { value: UNASSIGNED, label: "-" }];
}

export function sortedAdmission(rows: ApiRequest[]): ApiRequest[] {
  return [...rows].sort((a, b) => startOf(a).localeCompare(startOf(b)) || a.id - b.id);
}

export function workingDaysBetween(start: string, end: string, calendar: { restDays: string[]; workDays: string[]; years: number[]; source: string }): number {
  return countDays(start, end, calendar);
}
