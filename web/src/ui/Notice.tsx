import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import styles from "./Notice.module.css";

type Tone = "info" | "error" | "success";
interface NoticeItem {
  id: number;
  message: string;
  tone: Tone;
}
interface NoticeApi {
  notify: (message: string, tone?: Tone) => void;
  error: (message: string) => void;
  conflict: (message?: string) => void;
}

const NoticeContext = createContext<NoticeApi | null>(null);

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NoticeItem[]>([]);
  const idRef = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const notify = useCallback(
    (message: string, tone: Tone = "info") => {
      if (!message) return;
      idRef.current += 1;
      const id = idRef.current;
      setItems((current) => [...current.slice(-2), { id, message, tone }]);
      const timer = window.setTimeout(() => dismiss(id), tone === "error" ? 7000 : 3600);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const value = useMemo<NoticeApi>(
    () => ({
      notify,
      error: (message: string) => notify(message, "error"),
      conflict: (message = "数据已被其他人更新，已刷新为最新状态，请核对后再保存。") => notify(message, "error"),
    }),
    [notify],
  );

  const icons = { info: Info, error: AlertTriangle, success: CheckCircle2 };

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <div className={styles.stack} aria-live="polite" aria-atomic="false">
        {items.map((item) => {
          const Icon = icons[item.tone];
          return (
            <div key={item.id} className={`${styles.toast} ${styles[item.tone]}`} role={item.tone === "error" ? "alert" : "status"} onClick={() => dismiss(item.id)}>
              <Icon aria-hidden="true" />
              <span>{item.message}</span>
            </div>
          );
        })}
      </div>
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeApi {
  const value = useContext(NoticeContext);
  if (!value) throw new Error("useNotice must be used inside NoticeProvider");
  return value;
}
