import { memo, useEffect, useRef } from "react";
import styles from "./GridBackground.module.css";

export const GridBackground = memo(function GridBackground({ className = "" }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("./grid3dEngine").then(({ createGrid3D }) => {
      if (disposed || !rootRef.current || !canvasRef.current) return;
      stop = createGrid3D(rootRef.current, canvasRef.current);
    }).catch(() => {
      if (!disposed && rootRef.current) rootRef.current.dataset.renderer = "fallback";
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  return (
    <div ref={rootRef} data-slot="grid-background" data-renderer="fallback" data-motion="static" aria-hidden="true" className={`${styles.grid} ${className}`}>
      <div className={styles.fallback} />
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
});
