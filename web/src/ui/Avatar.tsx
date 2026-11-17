import { useEffect, useState } from "react";
import { initials } from "../lib/format";
import styles from "./Avatar.module.css";

export interface AvatarProps {
  name: string;
  avatar?: string | null;
  size?: "md" | "large";
  online?: boolean;
  className?: string;
  label?: string;
}

export function avatarSrc(value?: string | null): string {
  if (!value) return "";
  if (/^(https?:|data:|blob:|\/)/i.test(value)) return value;
  return `/api/avatars/${encodeURIComponent(value)}`;
}

export function Avatar({ name, avatar, size = "md", online = false, className = "", label }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const src = avatarSrc(avatar);
  useEffect(() => setBroken(false), [avatar]);
  const classes = [styles.avatar, size === "large" ? styles.large : "", className].filter(Boolean).join(" ");
  return (
    <span className={classes} aria-label={label ?? name} role="img">
      {src && !broken ? (
        <img className={styles.image} src={src} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className={styles.initial}>{initials(name)}</span>
      )}
      {online ? <span className={styles.online} aria-hidden="true" /> : null}
    </span>
  );
}
