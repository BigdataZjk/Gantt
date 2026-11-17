export interface ChangeEvent {
  revision: number;
}

export function subscribeEvents(handlers: {
  onChange: (event: ChangeEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let retryTimer = 0;

  const connect = () => {
    if (closed) return;
    source = new EventSource("/api/events", { withCredentials: true });
    source.onopen = () => {
      handlers.onOpen?.();
    };
    source.addEventListener("change", (event) => {
      const message = event as MessageEvent<string>;
      try {
        const data = JSON.parse(message.data) as ChangeEvent;
        if (typeof data.revision === "number") handlers.onChange(data);
        else handlers.onChange({ revision: 0 });
      } catch {
        handlers.onChange({ revision: 0 });
      }
    });
    source.onerror = () => {
      handlers.onError?.();
      source?.close();
      source = null;
      if (!closed) {
        retryTimer = window.setTimeout(connect, 3000);
      }
    };
  };

  connect();

  return () => {
    closed = true;
    window.clearTimeout(retryTimer);
    source?.close();
    source = null;
  };
}
