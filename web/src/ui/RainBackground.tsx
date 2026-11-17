import { memo, useEffect, useMemo, useRef, type CSSProperties } from "react";
import styles from "./RainBackground.module.css";

// Rain by Ali Imam: https://21st.dev/@designali-in/components/rain
function createDrops() {
  let seed = 17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: 160 }, (_, id) => {
    const duration = 1 + random() * 2;
    return {
      id,
      left: random() * 120,
      size: 1 + random(),
      duration,
      delay: -random() * duration,
      opacity: 0.2 + random() * 0.6,
      staticTop: random() * 100,
    };
  });
}

export const RainBackground = memo(function RainBackground({ className = "" }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const drops = useMemo(createDrops, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      root.dataset.motion = motion.matches ? "static" : "animated";
      root.dataset.paused = String(document.hidden);
    };
    update();
    motion.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      motion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <div ref={rootRef} data-slot="rain-background" aria-hidden="true" className={`${styles.rain} ${className}`}>
      {drops.map((drop) => (
        <span
          key={drop.id}
          data-slot="rain-drop"
          className={styles.drop}
          style={{
            left: `${drop.left}%`,
            width: drop.size,
            height: drop.size * 10,
            borderRadius: drop.size,
            opacity: drop.opacity,
            animationDuration: `${drop.duration}s`,
            animationDelay: `${drop.delay}s`,
            "--rain-static-top": `${drop.staticTop}%`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
});
