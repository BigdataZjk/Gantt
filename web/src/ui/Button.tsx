import { forwardRef, type ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type Variant = "default" | "primary" | "quiet" | "danger" | "dangerText" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm";
  iconOnly?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", iconOnly = false, block = false, className = "", type = "button", children, ...rest },
  ref,
) {
  const classes = [
    styles.button,
    variant !== "default" ? styles[variant] : "",
    size === "sm" ? styles.small : "",
    iconOnly ? styles.icon : "",
    block ? styles.block : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {children}
    </button>
  );
});
