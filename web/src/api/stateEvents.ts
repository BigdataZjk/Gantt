import type { Presence } from "./types";

interface Options {
  clientId: string;
  revision: () => number;
  refresh: () => void;
  onPresence: (presence: Presence) => void;
}

/**
 * SSE 订阅：连接/重连后立即刷新 state；收到 change 时仅在版本前进时刷新，
 * 避免自身 mutation 返回的 State 被重复请求覆盖。
 */
export function stateEvents({ clientId, revision, refresh, onPresence }: Options): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry = 0;
  let timer = 0;

  const connect = () => {
    if (closed || source) return;
    const stream = new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}`, { withCredentials: true });
    source = stream;
    stream.onopen = () => {
      if (source !== stream) return;
      retry = 0;
      refresh();
    };
    stream.addEventListener("change", (event) => {
      if (source !== stream) return;
      const message = event as MessageEvent<string>;
      let next = 0;
      try {
        next = (JSON.parse(message.data) as { revision?: number }).revision ?? 0;
      } catch {
        next = 0;
      }
      if (next === 0 || next > revision()) refresh();
    });
    stream.addEventListener("presence", (event) => {
      if (source !== stream) return;
      try {
        const next = JSON.parse((event as MessageEvent<string>).data) as Presence;
        if (Array.isArray(next.users) && Number.isInteger(next.guests)) onPresence(next);
      } catch {
        // 保留最近一次收到的在线名单。
      }
    });
    stream.onerror = () => {
      if (source !== stream) return;
      stream.close();
      source = null;
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      timer = window.setTimeout(connect, Math.min(30_000, 500 * 2 ** retry));
    };
  };
  const disconnect = () => {
    window.clearTimeout(timer);
    source?.close();
    source = null;
  };

  connect();
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", connect);
  return () => {
    closed = true;
    disconnect();
    window.removeEventListener("pagehide", disconnect);
    window.removeEventListener("pageshow", connect);
  };
}
