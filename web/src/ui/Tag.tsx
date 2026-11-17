import type { CSSProperties } from "react";
import type { Priority } from "../api/types";
import { colorFromHex, isValidHex } from "../lib/color";
import styles from "./Tag.module.css";

export function PriorityTag({ value }: { value: Priority | string }) {
  const key = value === "P0" ? "p0" : value === "P1" ? "p1" : "p2";
  return (
    <span className={`${styles.priority} ${styles[key]}`} data-value={value}>
      {value}
    </span>
  );
}

export function DomainTag({ name, color }: { name: string; color?: string }) {
  if (!name) return <span className={styles.muted}>-</span>;
  const hex = isValidHex(color) ? color : "#8994a7";
  const info = colorFromHex(hex);
  const style = {
    "--tag-bg": `color-mix(in srgb, ${hex} 15%, var(--rsm-panel))`,
    "--tag-ink": `color-mix(in srgb, ${hex} 62%, ${info.ink === "#ffffff" ? "var(--rsm-text)" : "#101828"})`,
  } as CSSProperties;
  return (
    <span className={`${styles.tag} ${styles.domain}`} style={style} data-dict-field="domain" data-value={name}>
      {name}
    </span>
  );
}

const statusClass: Record<string, string> = {
  待评审: "review",
  待开发: "waiting",
  开发中: "developing",
  已完成: "done",
  HOLD: "hold",
};

export function StatusTag({ value }: { value: string }) {
  if (!value) return <span className={styles.muted}>-</span>;
  return (
    <span className={`${styles.tag} ${styles.status} ${styles[statusClass[value] ?? "review"]}`} data-dict-field="status" data-value={value}>
      {value}
    </span>
  );
}

export function RequestTypeTag({ value }: { value: string }) {
  if (!value) return <span className={styles.muted}>-</span>;
  return (
    <span className={`${styles.tag} ${styles.requestType} ${value === "数据需求" ? styles.data : styles.regular}`} data-dict-field="requestType" data-value={value}>
      {value}
    </span>
  );
}

export function DictionaryTag({ field, value, domainColor }: { field: "domain" | "status" | "requestType"; value: string; domainColor?: string }) {
  if (field === "domain") return <DomainTag name={value} color={domainColor} />;
  if (field === "status") return <StatusTag value={value} />;
  return <RequestTypeTag value={value} />;
}
