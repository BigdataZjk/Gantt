import { forwardRef, type ButtonHTMLAttributes } from "react";
import styles from "./CyberButton.module.css";

export const CyberButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function CyberButton(
  { children, className = "", disabled = false, type = "button", ...props },
  ref,
) {
  return (
    <span className={styles.frame} data-slot="cyber-button-frame" data-disabled={disabled || undefined}>
      <span aria-hidden="true" data-slot="cyber-button-halo" className={styles.halo} />
      <span aria-hidden="true" data-slot="cyber-button-edge" className={`${styles.edge} ${styles.left}`} />
      <span aria-hidden="true" data-slot="cyber-button-edge" className={`${styles.edge} ${styles.right}`} />
      <span aria-hidden="true" data-slot="cyber-button-edge" className={`${styles.edge} ${styles.top}`} />
      <span aria-hidden="true" data-slot="cyber-button-edge" className={`${styles.edge} ${styles.bottom}`} />
      <span aria-hidden="true" data-slot="cyber-button-texture" className={styles.texture} />
      <button {...props} ref={ref} type={type} disabled={disabled} data-slot="cyber-button" className={`${styles.button} ${className}`}>
        <span className={styles.label}>{children}</span>
      </button>
    </span>
  );
});
