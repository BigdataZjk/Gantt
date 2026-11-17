import type { ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "./Button";
import styles from "./Drawer.module.css";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  caption?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  headerExtra?: ReactNode;
  onClosed?: () => void;
}

export function Drawer({ open, onOpenChange, title, caption, children, footer, className = "", bodyClassName = "", headerExtra }: DrawerProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.scrim} />
        <RadixDialog.Content
          className={`${styles.drawer} ${className}`}
          aria-describedby={undefined}
          onPointerDownOutside={(event) => {
            // 点击遮罩关闭；点击抽屉内部不关闭
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("[data-drawer-content]")) event.preventDefault();
          }}
        >
          <header className={styles.header} data-drawer-content>
            <div className={styles.headerText}>
              <RadixDialog.Title asChild><h3>{title}</h3></RadixDialog.Title>
              {caption ? <span className={styles.caption}>{caption}</span> : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {headerExtra}
              <RadixDialog.Close asChild>
                <Button variant="quiet" iconOnly aria-label="收起面板">
                  <X aria-hidden="true" />
                </Button>
              </RadixDialog.Close>
            </div>
          </header>
          <div className={`${styles.body} ${bodyClassName}`} data-drawer-content>
            {children}
          </div>
          {footer ? <footer className={styles.footer} data-drawer-content>{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
