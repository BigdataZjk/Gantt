import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { stateEvents } from "../api/stateEvents";
import { STATE_KEY, useAppState } from "../api/hooks";
import type { State } from "../api/types";
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
  const revisionRef = useRef<number>(-1);

  useEffect(() => {
    revisionRef.current = stateQuery.data?.revision ?? -1;
  }, [stateQuery.data?.revision]);

  useEffect(() => {
    const unsubscribe = stateEvents({
      revision: () => client.getQueryData<State>(STATE_KEY)?.revision ?? -1,
      refresh: () => {
        void client.invalidateQueries({ queryKey: STATE_KEY });
      },
    });
    return unsubscribe;
  }, [client]);

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

  if (stateQuery.isError || !stateQuery.data) {
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
        <AppShell state={state} />
      </UiStateProvider>
    </PreferencesProvider>
  );
}
