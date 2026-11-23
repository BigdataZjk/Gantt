import type { components } from "./types.gen";

export type State = components["schemas"]["State"];
export type ApiRequest = components["schemas"]["Request"];
export type SupportSegment = components["schemas"]["SupportSegment"];
export type Segment = components["schemas"]["Segment"];
export type User = components["schemas"]["User"];
export type Role = User["role"];
export type Domain = components["schemas"]["Domain"];
export type Preferences = components["schemas"]["Preferences"];
export type LogEntry = components["schemas"]["Log"];
export type LogDetail = components["schemas"]["LogDetail"];
export type LogChange = components["schemas"]["LogChange"];
export type LogValue = components["schemas"]["LogValue"];
export type LogPolicy = components["schemas"]["LogPolicy"];
export type LogManagement = components["schemas"]["LogManagement"];
export type LogCleanupPreview = components["schemas"]["LogCleanupPreview"];
export type LogCleanupResponse = components["schemas"]["LogCleanupResponse"];
export type LogCleanupRun = components["schemas"]["LogCleanupRun"];
export type Version = components["schemas"]["Version"];
export type Calendar = components["schemas"]["Calendar"];
export type Presence = components["schemas"]["Presence"];
export type GanttOrderInput = components["schemas"]["GanttOrderInput"];
export type ScheduleOperation = components["schemas"]["ScheduleOperation"];
export type Priority = ApiRequest["priority"];
export type Status = ApiRequest["status"];
export type RequestType = ApiRequest["requestType"];

export type UserPatch = Partial<{
  role: string;
  disabled: boolean;
  deleted: boolean;
  password: string;
}>;

export type AppTheme = "system" | "light" | "dark";
export type Density = "compact" | "comfortable";
