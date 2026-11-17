import type { ApiRequest, Preferences, User } from "../api/types";
import { todayISO } from "../lib/dates";

export function emptyRequestDraft(preferences: Pick<Preferences, "defaultPriority" | "defaultRequestType">, me: User | null): ApiRequest {
  const isAdmin = me?.role === "superadmin" || me?.role === "admin";
  return {
    id: 0,
    revision: 0,
    name: "",
    priority: (preferences.defaultPriority === "P0" || preferences.defaultPriority === "P2" ? preferences.defaultPriority : "P1") as ApiRequest["priority"],
    status: "待评审",
    prd: "",
    requester: isAdmin ? "" : me?.username ?? "",
    requestedAt: todayISO(),
    domain: "",
    requestType: (preferences.defaultRequestType === "数据需求" ? "数据需求" : "常规需求") as ApiRequest["requestType"],
    wangyue: "",
    developer: "",
    days: 3,
    start: "",
    delivery: "",
    project: "",
    brd: "",
    review: "",
    expected: "",
    notes: "",
    segments: [],
    vacation: [],
    overtime: [],
    archived: false,
  };
}

export function isDraftMeaningful(draft: ApiRequest | null): boolean {
  if (!draft) return false;
  return Boolean(
    draft.name ||
      draft.prd ||
      draft.wangyue ||
      draft.brd ||
      draft.domain ||
      draft.start ||
      draft.expected ||
      draft.review ||
      draft.notes ||
      draft.project ||
      draft.requester ||
      draft.developer ||
      (draft.segments && draft.segments.length) ||
      draft.days !== 3 ||
      draft.priority !== "P1" ||
      draft.status !== "待评审" ||
      draft.requestType !== "常规需求",
  );
}
