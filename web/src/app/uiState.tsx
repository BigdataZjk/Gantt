import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiRequest } from "../api/types";
import { isValidDate } from "../lib/dates";
import { readStorage, writeStorage } from "../lib/storage";
import { ARCHIVE_COLUMN_KEYS, COLUMN_KEYS, DEFAULT_ARCHIVE_COLUMN_KEYS, DEFAULT_COLUMN_KEYS } from "../lib/format";
import { normalizeTableSort, type TableSort } from "../features/requests/table/sorting";

export type RequirementTab = "gantt" | "pool" | "archive";
export type MainView = "requirements" | "settings";
export type SettingsTab = "roles" | "fields" | "personal" | "logs" | "versions" | "calendar";

export interface UiFilters {
  domain: string[];
  requestType: string[];
  status: string[];
  developer: string[];
  priority: string[];
  start: string;
  end: string;
  query: string;
}

export interface UiState {
  mainView: MainView;
  sidebarPinned: boolean;
  requirementTab: RequirementTab;
  settingsTab: SettingsTab;
  filters: UiFilters;
  columnOrder: string[];
  visibleColumns: string[];
  archiveVisibleColumns: string[];
  ganttRange: { start: string; end: string };
  ganttZoom: number;
  ganttNameColumnWidth: number | null;
  poolNameColumnWidth: number | null;
  poolRowOrder: number[];
  poolSorting: TableSort[];
  archiveSorting: TableSort[];
  collapsedPeople: string[];
  logPagination: { page: number; pageSize: number };
  newDraft: ApiRequest | null;
}

const REQUIREMENT_TABS: RequirementTab[] = ["gantt", "pool", "archive"];
const SETTINGS_TABS: SettingsTab[] = ["roles", "fields", "personal", "logs", "versions", "calendar"];

export const EMPTY_FILTERS: UiFilters = { domain: [], requestType: [], status: [], developer: [], priority: [], start: "", end: "", query: "" };

function asStringArray(value: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && (!allowed || allowed.includes(item))))];
}

function normalize(value: unknown): UiState {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<UiState>;
  const order = Array.isArray(raw.columnOrder) ? raw.columnOrder.filter((key): key is string => typeof key === "string" && COLUMN_KEYS.includes(key)) : [];
  const needsRankColumn = !order.includes("requesterRank");
  if (needsRankColumn) order.unshift("requesterRank");
  const columnOrder = [...new Set([...order, ...COLUMN_KEYS])];
  const visibleColumns = asStringArray(raw.visibleColumns, COLUMN_KEYS);
  if (needsRankColumn && visibleColumns.length && !visibleColumns.includes("requesterRank")) visibleColumns.unshift("requesterRank");
  const archiveVisibleColumns = asStringArray(raw.archiveVisibleColumns, ARCHIVE_COLUMN_KEYS);
  const range = raw.ganttRange && typeof raw.ganttRange === "object" ? raw.ganttRange : { start: "", end: "" };
  const rawFilters = (raw.filters && typeof raw.filters === "object" ? raw.filters : {}) as Partial<UiFilters>;
  const pageSize = Number(raw.logPagination?.pageSize);
  const page = Number(raw.logPagination?.page);
  return {
    mainView: raw.mainView === "settings" ? "settings" : "requirements",
    sidebarPinned: raw.sidebarPinned === true,
    requirementTab: REQUIREMENT_TABS.includes(raw.requirementTab as RequirementTab) ? (raw.requirementTab as RequirementTab) : "gantt",
    settingsTab: SETTINGS_TABS.includes(raw.settingsTab as SettingsTab) ? (raw.settingsTab as SettingsTab) : "roles",
    filters: {
      domain: asStringArray(rawFilters.domain),
      requestType: asStringArray(rawFilters.requestType),
      status: asStringArray(rawFilters.status),
      developer: asStringArray(rawFilters.developer),
      priority: asStringArray(rawFilters.priority, ["P0", "P1", "P2"]),
      start: isValidDate(rawFilters.start) ? rawFilters.start : "",
      end: isValidDate(rawFilters.end) ? rawFilters.end : "",
      query: typeof rawFilters.query === "string" ? rawFilters.query : "",
    },
    columnOrder,
    visibleColumns: visibleColumns.length ? visibleColumns : [...DEFAULT_COLUMN_KEYS],
    archiveVisibleColumns: archiveVisibleColumns.length ? archiveVisibleColumns : [...DEFAULT_ARCHIVE_COLUMN_KEYS],
    ganttRange: {
      start: isValidDate(range.start) ? range.start : "",
      end: isValidDate(range.end) && (!range.start || range.end >= range.start) ? range.end : "",
    },
    ganttZoom: typeof raw.ganttZoom === "number" && Number.isFinite(raw.ganttZoom) ? Math.min(1, Math.max(0.001, raw.ganttZoom)) : 1,
    ganttNameColumnWidth: columnWidth(raw.ganttNameColumnWidth),
    poolNameColumnWidth: columnWidth(raw.poolNameColumnWidth),
    poolRowOrder: Array.isArray(raw.poolRowOrder) ? [...new Set(raw.poolRowOrder.filter((id) => Number.isSafeInteger(id) && id > 0))] : [],
    poolSorting: normalizeTableSort(raw.poolSorting),
    archiveSorting: normalizeTableSort(raw.archiveSorting).filter((sort) => ARCHIVE_COLUMN_KEYS.includes(sort.key)),
    collapsedPeople: asStringArray(raw.collapsedPeople),
    logPagination: {
      page: Number.isInteger(page) && page > 0 ? page : 1,
      pageSize: Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 200 ? pageSize : 20,
    },
    newDraft: isStoredDraft(raw.newDraft) ? raw.newDraft : null,
  };
}

function columnWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isStoredDraft(value: unknown): value is ApiRequest {
  if (!value || typeof value !== "object") return false;
  const draft = value as ApiRequest;
  return typeof draft.name === "string" && typeof draft.prd === "string" && Array.isArray(draft.segments) && Array.isArray(draft.vacation) && Array.isArray(draft.overtime);
}

interface UiApi {
  ui: UiState;
  patch: (patch: Partial<UiState>) => void;
  patchFilters: (patch: Partial<UiFilters>) => void;
  setDraft: (draft: ApiRequest | null) => void;
}

const UiContext = createContext<UiApi | null>(null);

export function UiStateProvider({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const key = `rsm.ui.v2:${storageKey}`;
  const [ui, setUi] = useState<UiState>(() => normalize(readStorage(key, {})));
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const timer = useRef(0);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => writeStorage(key, uiRef.current), 250);
    return () => window.clearTimeout(timer.current);
  }, [ui, key]);

  useEffect(() => {
    const onUnload = () => writeStorage(key, uiRef.current);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [key]);

  const patch = useCallback((next: Partial<UiState>) => {
    setUi((current) => ({ ...current, ...next }));
  }, []);

  const patchFilters = useCallback((next: Partial<UiFilters>) => {
    setUi((current) => ({ ...current, filters: { ...current.filters, ...next } }));
  }, []);

  const setDraft = useCallback((draft: ApiRequest | null) => {
    setUi((current) => ({ ...current, newDraft: draft }));
  }, []);

  const value = useMemo<UiApi>(() => ({ ui, patch, patchFilters, setDraft }), [ui, patch, patchFilters, setDraft]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUiState(): UiApi {
  const value = useContext(UiContext);
  if (!value) throw new Error("useUiState must be used inside UiStateProvider");
  return value;
}

export function hasActiveFilters(filters: UiFilters): boolean {
  return Boolean(
    filters.domain.length ||
      filters.requestType.length ||
      filters.status.length ||
      filters.developer.length ||
      (filters.priority.length > 0 && filters.priority.length < 3) ||
      filters.start ||
      filters.end ||
      filters.query.trim(),
  );
}
