import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { stateEvents } from "../api/stateEvents";
import { STATE_KEY, useAppState } from "../api/hooks";
import { AUTH_CHANGED_KEY } from "../api/stateCache";
import type { Presence, State } from "../api/types";
import { CalendarRange } from "lucide-react";
import { PreferencesProvider } from "./preferences";
import { UiStateProvider } from "./uiState";
import { AppShell } from "./AppShell";
import { SetupScreen } from "../features/auth/AuthFlows";
import { Button } from "../ui/Button";
import styles from "./AppShell.module.css";

export function Root() {
  const stateQuery = useAppState();
  const client = useQueryClient();
  const [clientId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [presence, setPresence] = useState<Presence>({ users: [], guests: 0 });
  const ready = Boolean(stateQuery.data);
  const viewer = stateQuery.data?.me?.id;

  useEffect(() => {
    if (!ready) return;
    const refresh = () => { void client.invalidateQueries({ queryKey: STATE_KEY }); };
    const unsubscribe = stateEvents({
      clientId,
      revision: () => client.getQueryData<State>(STATE_KEY)?.revision ?? -1,
      refresh,
      onPresence: setPresence,
    });
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const onAuthChanged = (event: StorageEvent) => { if (event.key === AUTH_CHANGED_KEY) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onAuthChanged);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onAuthChanged);
    };
  }, [client, clientId, ready, viewer]);

  if (stateQuery.isPending) {
    return (
      <div className={styles.loading}>
        <div className={styles.loadingBrand}>
          <CalendarRange aria-hidden="true" />
          <span>RSM</span>
        </div>
        <span className={styles.spinner} aria-hidden="true" />
        <span>正在读取共享资料…</span>
      </div>
    );
  }

  if (!stateQuery.data) {
    return (
      <div className={styles.fatal}>
        <div className={styles.fatalCard}>
          <h2>无法连接 RSM 服务</h2>
          <p style={{ color: "var(--rsm-muted)" }}>请确认 RSM 服务已启动，或稍后重试。</p>
          <Button variant="primary" onClick={() => void stateQuery.refetch()}>重新加载</Button>
        </div>
      </div>
    );
  }

  const state = stateQuery.data;
  if (state.setupRequired && !state.me) {
    return <SetupScreen />;
  }

  const userKey = state.me?.id ?? "guest";
  return (
    <PreferencesProvider key={userKey} serverPreferences={state.preferences} authenticated={Boolean(state.me)}>
      <UiStateProvider key={userKey} storageKey={userKey}>
        <AppShell state={state} presence={presence} />
      </UiStateProvider>
    </PreferencesProvider>
  );
}
