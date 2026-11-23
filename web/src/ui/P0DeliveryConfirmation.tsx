import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { P0DeliveryConfirmation } from "../api/types";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { PriorityTag } from "./Tag";
import styles from "./P0DeliveryConfirmation.module.css";

type Pending = {
  confirmation: P0DeliveryConfirmation;
  resolve: (approved: boolean) => void;
};

const ConfirmationContext = createContext<((confirmation: P0DeliveryConfirmation) => Promise<boolean>) | null>(null);

export function useP0DeliveryConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("P0DeliveryConfirmationProvider is required");
  return confirm;
}

export function P0DeliveryConfirmationProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const ask = useCallback((confirmation: P0DeliveryConfirmation) => new Promise<boolean>((resolve) => {
    setQueue((current) => [...current, { confirmation, resolve }]);
  }), []);
  const pending = queue[0];
  const finish = (approved: boolean) => {
    if (!pending) return;
    setQueue((current) => current.filter((entry) => entry !== pending));
    pending.resolve(approved);
  };

  return (
    <ConfirmationContext.Provider value={ask}>
      {children}
      {pending ? <P0DeliveryDialog key={pending.confirmation.token} confirmation={pending.confirmation} onDecision={finish} /> : null}
    </ConfirmationContext.Provider>
  );
}

function P0DeliveryDialog({ confirmation, onDecision }: { confirmation: P0DeliveryConfirmation; onDecision: (approved: boolean) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onDecision(false); }}
      onOpenAutoFocus={(event) => { event.preventDefault(); cancel.current?.focus(); }}
      title="确认 P0 交付日期变更"
      caption={`本次操作将影响 ${confirmation.changes.length} 条 P0 需求的交付日期。`}
      width={500}
      overlayClassName={styles.overlay}
      className={styles.dialog}
      footer={(
        <>
          <Button ref={cancel} onClick={() => onDecision(false)}>取消</Button>
          <Button variant="primary" onClick={() => onDecision(true)}>确认并执行</Button>
        </>
      )}
    >
      <ul className={styles.list} aria-label="受影响的需求">
        {confirmation.changes.map((change) => (
          <li className={styles.item} key={change.requestId}>
            <div className={styles.heading}>
              <PriorityTag value="P0" />
              <strong>{change.name}</strong>
            </div>
            <div className={styles.dates}>
              <dl className={styles.date}>
                <dt>原交付日期</dt>
                <dd>{change.before ? <time dateTime={change.before}>{change.before}</time> : "未排期"}</dd>
              </dl>
              <ArrowRight aria-hidden="true" />
              <dl className={`${styles.date} ${styles.nextDate}`}>
                <dt>新交付日期</dt>
                <dd>{change.after ? <time dateTime={change.after}>{change.after}</time> : "未排期"}</dd>
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
