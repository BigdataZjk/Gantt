import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { createStateWriter } from "../api/stateCache";
import type { Density, Domain, Preferences } from "../api/types";
import { isValidHex } from "../lib/color";
import { readStorage, writeStorage } from "../lib/storage";
import { useNotice } from "../ui/Notice";

export type ResolvedTheme = "light" | "dark";

export interface PreferencesApi {
  prefs: Preferences;
  theme: ResolvedTheme;
  density: Density;
  update: (patch: Partial<Preferences>) => void;
  setTheme: (theme: ResolvedTheme) => void;
  domainColor: (name: string, domains: Domain[]) => string;
}

const PreferencesContext = createContext<PreferencesApi | null>(null);

function normalizePreferences(value?: Preferences | null): Preferences {
  const domainColors =
    value?.domainColors && typeof value.domainColors === "object" && !Array.isArray(value.domainColors)
      ? Object.fromEntries(Object.entries(value.domainColors).filter(([, color]) => isValidHex(color)))
      : {};
  return {
    theme: value?.theme === "light" || value?.theme === "dark" ? value.theme : "system",
    density: value?.density === "comfortable" ? "comfortable" : "compact",
    defaultPriority: value?.defaultPriority === "P0" || value?.defaultPriority === "P2" ? value.defaultPriority : "P1",
    defaultRequestType: value?.defaultRequestType === "数据需求" ? "数据需求" : "常规需求",
    domainColors,
    ui: value?.ui && typeof value.ui === "object" && !Array.isArray(value.ui) ? value.ui : {},
  };
}

const THEME_CACHE = "rsm.theme";
const GUEST_PREFERENCES_CACHE = "rsm.preferences:guest";

function cachedTheme(): Preferences["theme"] | null {
  try {
    const value = window.localStorage.getItem(THEME_CACHE);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // ignore
  }
  return null;
}

export function PreferencesProvider({ serverPreferences, authenticated, children }: { serverPreferences: Preferences; authenticated: boolean; children: ReactNode }) {
  const client = useQueryClient();
  const notice = useNotice();
  const [prefs, setPrefs] = useState<Preferences>(() => {
    const initial = normalizePreferences(serverPreferences);
    return authenticated
      ? initial
      : normalizePreferences(readStorage<Preferences>(GUEST_PREFERENCES_CACHE, { ...initial, theme: cachedTheme() ?? initial.theme }));
  });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const saving = useRef(false);
  const pending = useRef<Preferences | null>(null);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const next = normalizePreferences(serverPreferences);
    if (JSON.stringify(next) === JSON.stringify(prefsRef.current)) return;
    setPrefs(next);
    prefsRef.current = next;
    // 服务端偏好变化（例如另一标签页修改）时同步到本地视图。
  }, [authenticated, serverPreferences]);

  const flush = useCallback(async () => {
    if (!authenticated || saving.current) return;
    saving.current = true;
    try {
      while (pending.current) {
        const target = pending.current;
        pending.current = null;
        const writeState = createStateWriter(client);
        try {
          const state = await api.savePreferences(target);
          if (!await writeState(state)) {
            pending.current = null;
            return;
          }
        } catch (error) {
          notice.error(error instanceof Error ? error.message : "个人偏好保存失败");
        }
      }
    } finally {
      saving.current = false;
    }
  }, [authenticated, client, notice]);

  const update = useCallback(
    (patch: Partial<Preferences>) => {
      const next = normalizePreferences({ ...prefsRef.current, ...patch });
      setPrefs(next);
      prefsRef.current = next;
      if (!authenticated) {
        writeStorage(GUEST_PREFERENCES_CACHE, next);
        return;
      }
      pending.current = next;
      void flush();
    },
    [authenticated, flush],
  );

  const theme: ResolvedTheme = prefs.theme === "system" ? (systemDark ? "dark" : "light") : prefs.theme;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = prefs.density;
    root.style.colorScheme = theme;
  }, [theme, prefs.density]);

  const value = useMemo<PreferencesApi>(
    () => ({
      prefs,
      theme,
      density: prefs.density,
      update,
      setTheme: (next: ResolvedTheme) => update({ theme: next }),
      domainColor: (name: string, domains: Domain[]) => {
        const personal = prefs.domainColors[name];
        if (isValidHex(personal)) return personal;
        const domain = domains.find((item) => item.name === name);
        return isValidHex(domain?.color) ? domain.color : "#8994a7";
      },
    }),
    [prefs, theme, update],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesApi {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
