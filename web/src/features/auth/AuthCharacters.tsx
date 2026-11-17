import { useEffect, useRef } from "react";
import styles from "./AuthCharacters.module.css";

export function AuthCharacters({ attention }: { attention: "idle" | "typing" | "privacy" }) {
  const scene = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const desktop = window.matchMedia("(min-width: 1024px)");
    let frame = 0;
    let clientX = 0;
    let clientY = 0;

    const draw = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const x = Math.max(-1, Math.min(1, (clientX - rect.x - rect.width / 2) / (window.innerWidth / 2)));
      const y = Math.max(-1, Math.min(1, (clientY - rect.y - rect.height / 2) / (window.innerHeight / 2)));
      element.style.setProperty("--look-x", `${(x * 5).toFixed(2)}px`);
      element.style.setProperty("--look-y", `${(y * 4).toFixed(2)}px`);
      element.style.setProperty("--lean", `${(x * -5).toFixed(2)}deg`);
      element.style.setProperty("--face-x", `${(x * 8).toFixed(2)}px`);
      element.style.setProperty("--face-y", `${(y * 5).toFixed(2)}px`);
    };
    const follow = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || motion.matches || !desktop.matches) return;
      clientX = event.clientX;
      clientY = event.clientY;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      for (const name of ["--look-x", "--look-y", "--lean", "--face-x", "--face-y"]) element.style.removeProperty(name);
    };
    window.addEventListener("pointermove", follow, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      window.removeEventListener("pointermove", follow);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const eyes = (solid = false) => (
    <div className={`${styles.eyes} ${solid ? styles.solid : ""}`}>
      <span className={styles.eye}>{solid ? null : <i />}</span>
      <span className={styles.eye}>{solid ? null : <i />}</span>
    </div>
  );

  return (
    <div ref={scene} className={styles.scene} data-attention={attention} aria-hidden="true">
      <div className={`${styles.character} ${styles.purple}`}>{eyes()}</div>
      <div className={`${styles.character} ${styles.charcoal}`}>{eyes()}</div>
      <div className={`${styles.character} ${styles.orange}`}>{eyes(true)}</div>
      <div className={`${styles.character} ${styles.yellow}`}>
        {eyes(true)}
        <span className={styles.mouth} />
      </div>
    </div>
  );
}
