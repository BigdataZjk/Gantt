import type { QueryClient } from "@tanstack/react-query";
import type { State } from "./types";
import { writeStorage } from "../lib/storage";

export const STATE_KEY = ["app-state"] as const;
export const AUTH_CHANGED_KEY = "rsm.auth-changed";
const sessions = new WeakMap<QueryClient, number>();

export function createStateWriter(client: QueryClient, newSession = false) {
  const session = sessions.get(client) ?? 0;
  const userId = client.getQueryData<State>(STATE_KEY)?.me?.id;
  return async (state: State): Promise<boolean> => {
    if ((sessions.get(client) ?? 0) !== session) return false;
    const current = client.getQueryData<State>(STATE_KEY);
    if (current?.me?.id !== userId && (!newSession || current?.me?.id !== state.me?.id)) return false;
    if (newSession || current?.me?.id !== state.me?.id) {
      const nextSession = session + 1;
      sessions.set(client, nextSession);
      // 身份切换后，之前发出的资料、偏好和头像响应不能恢复旧身份。
      await client.cancelQueries({ queryKey: STATE_KEY });
      if (sessions.get(client) !== nextSession) return false;
    }
    client.setQueryData(STATE_KEY, state);
    if (newSession) writeStorage(AUTH_CHANGED_KEY, Date.now());
    return true;
  };
}
