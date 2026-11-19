import type { ApiRequest, Calendar, Domain, GanttOrderInput, LogCleanupPreview, LogCleanupResponse, LogManagement, LogPolicy, Preferences, State, UserPatch } from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let payload: { error?: string; code?: string } | null = null;
    try {
      payload = (await response.json()) as { error?: string; code?: string };
    } catch {
      payload = null;
    }
    throw new ApiError(payload?.error || "请求失败，请稍后重试", response.status, payload?.code || String(response.status));
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function send<T>(path: string, method: string, body?: unknown, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    ...options,
    headers: {
      ...(body !== undefined ? JSON_HEADERS : {}),
      ...(options.headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : options.body,
  });
  return parse<T>(response);
}

export const api = {
  state: (signal?: AbortSignal): Promise<State> => send<State>("/api/state", "GET", undefined, { signal }),
  setup: (password: string): Promise<State> => send<State>("/api/setup", "POST", { password }),
  login: (username: string, password: string, remember = true): Promise<State> => send<State>("/api/login", "POST", { username, password, remember }),
  logout: (): Promise<State> => send<State>("/api/logout", "POST", {}),
  changePassword: (currentPassword: string, password: string): Promise<State> => send<State>("/api/auth/password", "POST", { currentPassword, password }),
  revealPassword: (userId: string): Promise<{ password: string }> => send<{ password: string }>(`/api/auth/password/${encodeURIComponent(userId)}`, "GET"),

  createUser: (input: { username: string; password: string; role: string }): Promise<State> => send<State>("/api/users", "POST", input),
  updateUser: (id: string, patch: UserPatch): Promise<State> => send<State>(`/api/users/${encodeURIComponent(id)}`, "PATCH", patch),
  savePreferences: (preferences: Preferences): Promise<State> => send<State>("/api/preferences", "PUT", preferences),
  uploadAvatar: async (file: File): Promise<State> => {
    const response = await fetch("/api/avatar", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    return parse<State>(response);
  },

  refreshCalendar: (baseRevision: number, year: number): Promise<State> => send<State>("/api/calendar/refresh", "POST", { baseRevision, year }),
  importCalendar: (baseRevision: number, year: number, calendar: Record<string, unknown>): Promise<State> => send<State>("/api/calendar/import", "POST", { baseRevision, year, calendar }),

  createRequest: (baseRevision: number, request: ApiRequest): Promise<State> => send<State>("/api/requests", "POST", { baseRevision, request }),
  updateRequest: (baseRevision: number, request: ApiRequest): Promise<State> => send<State>(`/api/requests/${encodeURIComponent(String(request.id))}`, "PUT", { baseRevision, request }),
  deleteRequest: (baseRevision: number, id: number): Promise<State> => send<State>(`/api/requests/${id}`, "DELETE", { baseRevision }),
  batchRequests: (baseRevision: number, requests: ApiRequest[]): Promise<State> => send<State>("/api/requests/batch", "POST", { baseRevision, requests }),
  orderGantt: (baseRevision: number, orders: GanttOrderInput["orders"], move?: GanttOrderInput["move"]): Promise<State> => send<State>("/api/requests/gantt-order", "PUT", { baseRevision, orders, move }),
  rankRequests: (baseRevision: number, requestId?: number): Promise<State> => send<State>("/api/requests/priority", "POST", { baseRevision, action: requestId === undefined ? "clear" : "toggle", requestId }),
  archiveRequest: (baseRevision: number, id: number, archived: boolean): Promise<State> => send<State>(`/api/requests/${id}/archive`, "POST", { baseRevision, archived }),

  createDomain: (baseRevision: number, name: string, color: string): Promise<State> => send<State>("/api/domains", "POST", { baseRevision, name, color }),
  updateDomain: (baseRevision: number, id: string, name: string, color: string): Promise<State> => send<State>(`/api/domains/${encodeURIComponent(id)}`, "PUT", { baseRevision, name, color }),
  deleteDomain: (baseRevision: number, id: string): Promise<State> => send<State>(`/api/domains/${encodeURIComponent(id)}`, "DELETE", { baseRevision }),
  mergeField: (baseRevision: number, field: string, values: string[], target: string): Promise<State> => send<State>("/api/fields/merge", "POST", { baseRevision, field, values, target }),

  saveVersion: (baseRevision: number, label: string): Promise<State> => send<State>("/api/versions", "POST", { baseRevision, label }),
  deleteVersion: (baseRevision: number, id: string): Promise<State> => send<State>(`/api/versions/${encodeURIComponent(id)}`, "DELETE", { baseRevision }),
  restoreVersion: (baseRevision: number, id: string): Promise<State> => send<State>(`/api/versions/${encodeURIComponent(id)}/restore`, "POST", { baseRevision }),
  undoLog: (baseRevision: number, id: number | string): Promise<State> => send<State>(`/api/history/${encodeURIComponent(String(id))}/undo`, "POST", { baseRevision }),
  logManagement: (): Promise<LogManagement> => send<LogManagement>("/api/logs/management", "GET"),
  saveLogPolicy: (baseRevision: number, policy: LogPolicy): Promise<State> => send<State>("/api/logs/policy", "PUT", { baseRevision, ...policy }),
  previewLogCleanup: (scope: LogCleanupPreview["scope"], days: number): Promise<LogCleanupPreview> => send<LogCleanupPreview>("/api/logs/cleanup/preview", "POST", { scope, days }),
  cleanupLogs: (baseRevision: number, preview: LogCleanupPreview): Promise<LogCleanupResponse> => send<LogCleanupResponse>("/api/logs/cleanup", "POST", { baseRevision, scope: preview.scope, days: preview.days, before: preview.before, token: preview.token }),

};

export type { ApiRequest, Calendar, Domain, Preferences, State };
