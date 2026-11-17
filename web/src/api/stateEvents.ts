interface Options {
  revision: () => number;
  refresh: () => void;
}

/**
 * SSE 订阅：连接/重连后立即刷新 state；收到 change 时仅在版本前进时刷新，
 * 避免自身 mutation 返回的 State 被重复请求覆盖。
 */
export function stateEvents({ revision, refresh }: Options): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    source = new EventSource("/api/events", { withCredentials: true });
    source.onopen = () => {
      retry = 0;
      refresh();
    };
    source.addEventListener("change", (event) => {
      const message = event as MessageEvent<string>;
      let next = 0;
      try {
        next = (JSON.parse(message.data) as { revision?: number }).revision ?? 0;
      } catch {
        next = 0;
      }
      if (next === 0 || next > revision()) refresh();
    });
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry));
    };
  };

  connect();
  return () => {
    closed = true;
    source?.close();
    source = null;
  };
}
