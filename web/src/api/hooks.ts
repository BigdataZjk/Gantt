import { useCallback } from "react";
import { replaceEqualDeep, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { State } from "./types";
import { createStateWriter, STATE_KEY } from "./stateCache";
import { useNotice } from "../ui/Notice";

export { STATE_KEY } from "./stateCache";

export function useAppState() {
  return useQuery<State>({
    queryKey: STATE_KEY,
    queryFn: ({ signal }) => api.state(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: false,
    structuralSharing: (previous, next) => {
      const before = previous as State | undefined;
      const after = next as State;
      // 资料刷新与偏好保存可能晚于业务保存返回，旧修订不能覆盖已确认的变更。
      if (before && after.revision < before.revision && after.me?.id === before.me?.id) return before;
      return replaceEqualDeep(before, after);
    },
  });
}

export function useMutationRunner() {
  const client = useQueryClient();
  const notice = useNotice();

  return useCallback(
    async (mutator: (baseRevision: number) => Promise<State>, options: { silent?: boolean } = {}): Promise<State | null> => {
      const baseRevision = client.getQueryData<State>(STATE_KEY)?.revision ?? 0;
      const writeState = createStateWriter(client);
      try {
        const next = await mutator(baseRevision);
        if (next && !await writeState(next)) return null;
        return next ?? null;
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 409) {
            notice.conflict(error.message && !error.message.includes("请求") ? error.message : undefined);
            void client.invalidateQueries({ queryKey: STATE_KEY });
          } else if (error.status === 401) {
            notice.error("登录状态已失效，请重新登录后操作。");
            void client.invalidateQueries({ queryKey: STATE_KEY });
          } else if (!options.silent) {
            notice.error(error.message);
          }
        } else if (!options.silent) {
          notice.error("网络异常，请检查服务是否运行。");
        }
        return null;
      }
    },
    [client, notice],
  );
}

export function useRefreshState() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: STATE_KEY }), [client]);
}
