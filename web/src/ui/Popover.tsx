import type { ReactElement, ReactNode } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import styles from "./Popover.module.css";

export interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  className?: string;
}

export function Popover({ trigger, children, open, onOpenChange, align = "start", side = "bottom", sideOffset = 6, className = "" }: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={`${styles.content} ${className}`} align={align} side={side} sideOffset={sideOffset} collisionPadding={8}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
