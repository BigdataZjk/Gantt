import type { ReactNode } from "react";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import styles from "./Checkbox.module.css";

export interface CheckboxProps {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onCheckedChange, label, ariaLabel, disabled = false, className = "" }: CheckboxProps) {
  const control = (
    <RadixCheckbox.Root
      className={styles.root}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <RadixCheckbox.Indicator>{checked === "indeterminate" ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}</RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
  if (!label) return <span className={className}>{control}</span>;
  return (
    <label className={`${styles.label} ${className}`}>
      {control}
      <span className={styles.labelText}>{label}</span>
    </label>
  );
}
