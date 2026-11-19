import type { ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./Button";
import styles from "./Dialog.module.css";

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  bodyClassName?: string;
  closeLabel?: string;
}

export function Dialog({ open, onOpenChange, title, caption, children, footer, width, className = "", bodyClassName = "", closeLabel = "关闭窗口" }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.scrim} />
        <RadixDialog.Content className={`${styles.content} ${className}`} style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined} aria-describedby={undefined}>
          {title || caption ? (
            <header className={styles.header}>
              <div className={styles.headerText}>
                {title ? <RadixDialog.Title asChild><h3>{title}</h3></RadixDialog.Title> : <RadixDialog.Title className="rsm-sr-only">对话框</RadixDialog.Title>}
                {caption ? <span className={styles.caption}>{caption}</span> : null}
              </div>
              <RadixDialog.Close asChild>
                <Button variant="quiet" iconOnly aria-label={closeLabel} className={styles.close}>
                  <X aria-hidden="true" />
                </Button>
              </RadixDialog.Close>
            </header>
          ) : null}
          <div className={`${styles.body} ${bodyClassName}`}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
