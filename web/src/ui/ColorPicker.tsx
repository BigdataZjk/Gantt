import { useEffect, useRef, useState } from "react";
import { Shuffle } from "lucide-react";
import { COLOR_PRESETS, hsvToHex, hexToHsv, isValidHex } from "../lib/color";
import styles from "./ColorPicker.module.css";

export interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  ariaLabel?: string;
}

export function ColorPicker({ value, onChange, ariaLabel = "颜色选择器" }: ColorPickerProps) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hexText, setHexText] = useState(value.toUpperCase());
  const pointer = useRef<number | null>(null);
  const areaRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isValidHex(value)) return;
    if (hsvToHex(hsv) === value.toLowerCase()) return;
    setHsv(hexToHsv(value));
    setHexText(value.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const apply = (next: { h: number; s: number; v: number }, notify = true) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexText(hex.toUpperCase());
    if (notify) onChange(hex);
  };

  const positionAt = (event: PointerEvent | React.PointerEvent) => {
    const area = areaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const v = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height));
    apply({ ...hsv, s, v });
  };

  const hue = hsv.h;
  const hex = hsvToHex(hsv);
  return (
    <div className={styles.host} aria-label={ariaLabel} role="group">
      <div className={styles.presets} role="group" aria-label="预设颜色">
        {COLOR_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={styles.preset}
            aria-label={`选择颜色 ${preset}`}
            aria-pressed={hex === preset.toLowerCase()}
            onClick={() => {
              const next = hexToHsv(preset);
              apply(next);
            }}
          >
            <span style={{ background: preset }} />
          </button>
        ))}
      </div>
      <button
        ref={areaRef}
        type="button"
        className={styles.area}
        style={{ ["--cp-hue-color" as string]: `hsl(${hue} 100% 50%)` }}
        aria-label={`饱和度 ${Math.round(hsv.s * 100)}%，明度 ${Math.round(hsv.v * 100)}%，方向键调整`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          pointer.current = event.pointerId;
          areaRef.current?.setPointerCapture(event.pointerId);
          positionAt(event);
        }}
        onPointerMove={(event) => {
          if (pointer.current === event.pointerId) positionAt(event);
        }}
        onPointerUp={(event) => {
          if (pointer.current === event.pointerId) {
            positionAt(event);
            pointer.current = null;
            areaRef.current?.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => { pointer.current = null; }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.01;
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          let { s, v } = hsv;
          if (event.key === "ArrowLeft") s = Math.max(0, s - step);
          if (event.key === "ArrowRight") s = Math.min(1, s + step);
          if (event.key === "ArrowUp") v = Math.min(1, v + step);
          if (event.key === "ArrowDown") v = Math.max(0, v - step);
          if (event.key === "Home") s = 0;
          if (event.key === "End") s = 1;
          apply({ ...hsv, s, v });
        }}
      >
        <span className={styles.thumb} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} aria-hidden="true" />
      </button>
      <div className={styles.hueRow}>
        <input
          className={styles.hue}
          type="range"
          min={0}
          max={359.9}
          step={0.1}
          value={hue}
          aria-label="色相"
          onChange={(event) => apply({ ...hsv, h: Number(event.target.value) })}
        />
        <button
          type="button"
          className={styles.shuffle}
          aria-label="随机选择颜色"
          data-tooltip="随机颜色"
          onClick={() => apply({ h: Math.random() * 360, s: 0.5 + Math.random() * 0.45, v: 0.65 + Math.random() * 0.3 })}
        >
          <Shuffle aria-hidden="true" />
        </button>
      </div>
      <div className={styles.hexGroup}>
        <span className={styles.swatch} style={{ background: hex }} aria-hidden="true" />
        <input
          className={styles.hex}
          type="text"
          value={hexText}
          spellCheck={false}
          maxLength={7}
          aria-label="HEX 颜色值"
          aria-invalid={!isValidHex(hexText)}
          onChange={(event) => {
            const text = event.target.value;
            setHexText(text);
            if (isValidHex(text)) {
              setHsv(hexToHsv(text));
              onChange(text.toLowerCase());
            }
          }}
        />
        <span className={styles.format}>HEX</span>
      </div>
    </div>
  );
}
