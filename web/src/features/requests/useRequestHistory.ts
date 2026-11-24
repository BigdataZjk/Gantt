import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, requestOperationId } from "../../api/client";
import { STATE_KEY, useMutationRunner } from "../../api/hooks";
import type { State } from "../../api/types";
import { useNotice } from "../../ui/Notice";

type Direction = "undo" | "redo";
interface HistorySession {
  undo: string[];
  redo: string[];
  busy: "saving" | "replaying" | null;
  queued: Direction[];
}

export interface RequestHistory {
  save: (mutator: (baseRevision: number) => Promise<State>) => Promise<State | null>;
  replay: (direction: Direction) => boolean;
}

export function useRequestHistory(userId: string | undefined): RequestHistory {
  const client = useQueryClient();
  const runner = useMutationRunner();
  const notice = useNotice();
  const session = useMemo<HistorySession>(() => ({ undo: [], redo: [], busy: null, queued: [] }), [userId]);
  const canEdit = useCallback(() => {
    const user = client.getQueryData<State>(STATE_KEY)?.me;
    return !!user && user.id === userId && user.role !== "readonly";
  }, [client, userId]);

  const reverse = useCallback(async (direction: Direction) => {
    session.busy = "replaying";
    try {
      let next: Direction | undefined = direction;
      while (next && canEdit()) {
        const redo = next === "redo";
        const stack = session[next];
        const id = stack.at(-1);
        if (id) {
          const result = await runner((base) => api.reverseRequestOperation(base, id, redo));
          if (!result) return;
          stack.pop();
          const nextId = requestOperationId(result);
          if (nextId) session[redo ? "undo" : "redo"].push(nextId);
          notice.notify(redo ? "已重做需求操作" : "已撤回上一步需求操作");
        }
        next = session.queued.shift();
      }
    } finally {
      session.busy = null;
      session.queued.length = 0;
    }
  }, [canEdit, notice, runner, session]);

  const replay = useCallback((direction: Direction) => {
    if (!canEdit()) return false;
    if (session.busy) {
      if (session.queued.length < 50) session.queued.push(direction);
      return true;
    }
    if (!session[direction].length) return false;
    void reverse(direction);
    return true;
  }, [canEdit, reverse, session]);

  const save = useCallback(async (mutator: (base: number) => Promise<State>) => {
    if (!canEdit()) return null;
    if (session.busy) {
      notice.notify("正在保存上一步操作，请稍候");
      return null;
    }
    session.busy = "saving";
    let result: State | null = null;
    try {
      result = await runner(mutator);
      const id = result && requestOperationId(result);
      if (id && canEdit()) {
        session.undo = [...session.undo.slice(-49), id];
        session.redo = [];
      }
      return result;
    } finally {
      session.busy = null;
      const queued = session.queued.shift();
      if (queued && result && requestOperationId(result)) await reverse(queued);
      else session.queued.length = 0;
    }
  }, [canEdit, notice, reverse, runner, session]);

  return useMemo(() => ({ save, replay }), [save, replay]);
}

export function requestHistoryShortcut(event: KeyboardEvent, cancelingGesture = false): Direction | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey ||
      !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return null;
  const target = event.target;
  if (!cancelingGesture && target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]')) return null;
  if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return null;
  return event.shiftKey ? "redo" : "undo";
}
