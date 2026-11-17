import { Moon, Sun } from "lucide-react";
import { usePreferences } from "./preferences";
import styles from "./ThemeToggle.module.css";

const STARS = [
  [24, 22],
  [66, 16],
  [80, 42],
  [38, 58],
  [14, 72],
];

export function ThemeToggle() {
  const { theme, setTheme } = usePreferences();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className={styles.toggle}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "切换为日间模式" : "切换为夜间模式"}
      data-theme={theme}
      data-tooltip={dark ? "切换到日间模式" : "切换到夜间模式"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      <span className={styles.scene} aria-hidden="true">
        <span className={styles.night} style={{ ["--night-opacity" as string]: dark ? 1 : 0 }} />
        <span className={styles.day} style={{ ["--day-opacity" as string]: dark ? 0 : 1 }} />
        {STARS.map(([left, top], index) => (
          <span key={index} className={styles.star} style={{ left: `${left}%`, top: `${top}%`, animationDelay: `${-index * 530}ms` }} />
        ))}
        <span className={styles.body}>
          <Moon className={styles.moon} data-hidden={!dark} aria-hidden="true" />
        </span>
        <span className={styles.body}>
          <Sun className={styles.sun} data-hidden={dark} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}
