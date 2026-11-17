import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { STATE_KEY, useMutationRunner } from "../../../api/hooks";
import type { ApiRequest, State } from "../../../api/types";
import { useNotice } from "../../../ui/Notice";
import { makeUndoStep, restoreUndoStep, type GanttUndoStep } from "./ganttUndo";

export interface GanttUndo {
  save: (changes: { before: ApiRequest; after: ApiRequest }[], message: string) => Promise<boolean>;
  undo: () => boolean;
}

export function useGanttUndo(userId: string | undefined): GanttUndo {
  const client = useQueryClient();
  const runner = useMutationRunner();
  const notice = useNotice();
  const history = useRef<GanttUndoStep[]>([]);
  const busy = useRef<"saving" | "reverting" | null>(null);
  const queued = useRef(false);
  const current = useCallback(() => {
    const state = client.getQueryData<State>(STATE_KEY);
    return state && state.me && state.me.id === userId && (state.me.role === "superadmin" || state.me.role === "admin") ? state : null;
  }, [client, userId]);

  const revert = useCallback(async () => {
    const state = current();
    const step = history.current.at(-1);
    if (!state || !step || busy.current) return;
    let requests: ApiRequest[];
    try { requests = restoreUndoStep(step, state.requests, state.calendar); }
    catch (error) {
      history.current.pop();
      notice.error(error instanceof Error ? error.message : "无法撤回，请核对最新排期。");
      return;
    }
    busy.current = "reverting";
    try {
      const result = await runner((base) => requests.length === 1 ? api.updateRequest(base, requests[0]!) : api.batchRequests(base, requests));
      if (result) {
        history.current.pop();
        notice.notify(`已撤回上一步甘特操作${requests.length > 1 ? `（${requests.length} 条需求）` : ""}`);
      }
    } finally { busy.current = null; }
  }, [current, runner, notice]);

  const undo = useCallback(() => {
    if (!current()) { history.current = []; return false; }
    if (busy.current) {
      if (busy.current === "saving") queued.current = true;
      return true;
    }
    if (!history.current.length) return false;
    void revert();
    return true;
  }, [current, revert]);

  const save = useCallback(async (changes: { before: ApiRequest; after: ApiRequest }[], message: string) => {
    const state = current();
    if (!state || !changes.length) return false;
    if (busy.current) { notice.notify("正在保存上一步操作，请稍候"); return false; }
    busy.current = "saving";
    let saved = false;
    try {
      const after = changes.map((change) => change.after);
      const result = await runner((base) => after.length === 1 ? api.updateRequest(base, after[0]!) : api.batchRequests(base, after));
      if (result) {
        const step = makeUndoStep(changes.map((change) => change.before), result.requests, result.calendar);
        if (step.changes.length && current()) history.current = [...history.current.slice(-49), step];
        notice.notify(message);
        saved = true;
      }
    } finally { busy.current = null; }
    if (queued.current) {
      queued.current = false;
      if (saved) await revert();
    }
    return saved;
  }, [current, runner, notice, revert]);

  return useMemo(() => ({ save, undo }), [save, undo]);
}
