export interface ColorInfo {
  hex: string;
  ink: string;
  hue: number;
}

export function isValidHex(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function oklchToLinear(lightness: number, chroma: number, hue: number): number[] {
  const h = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH -> HEX，越界时压缩 chroma（与原型一致）。 */
export function oklchColor(lightness: number, chroma: number, hue: number): ColorInfo {
  const inGamut = (rgb: number[]) => rgb.every((value) => value >= 0 && value <= 1);
  let linear = oklchToLinear(lightness, chroma, hue);
  if (!inGamut(linear)) {
    let low = 0;
    let high = chroma;
    for (let index = 0; index < 22; index += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear(lightness, mid, hue))) low = mid;
      else high = mid;
    }
    linear = oklchToLinear(lightness, low, hue);
  }
  const rgb = linear.map((value) => Math.round(Math.max(0, Math.min(1, linearToSrgb(value))) * 255));
  const hex = "#" + rgb.map((value) => value.toString(16).padStart(2, "0")).join("");
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return { hex, ink: luminance > 0.179 ? "#101828" : "#ffffff", hue };
}

export function colorFromHex(hex: string): ColorInfo {
  if (!isValidHex(hex)) return { hex: "#8994a7", ink: "#ffffff", hue: 0 };
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map(srgbToLinear);
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const ink = 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.059 ? "#ffffff" : "#101828";
  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { hex: hex.toLowerCase(), ink, hue };
}

export function hueFromHex(hex: string): number {
  return colorFromHex(hex).hue;
}

const HUES = [255, 165, 300, 60, 345];

/** 新增业务域时的建议颜色：优先使用内置色相，其次选取现有色相最大空档的中间值。 */
export function suggestDomainColor(existing: string[]): string {
  const hues = existing.filter(isValidHex).map((hex) => hueFromHex(hex));
  for (const candidate of HUES) {
    if (!hues.some((used) => Math.abs(used - candidate) < 1)) return oklchColor(0.625, 0.205, candidate).hex;
  }
  const sorted = [...hues].sort((a, b) => a - b);
  let widest = -1;
  let hue = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const end = index === sorted.length - 1 ? sorted[0] + 360 : sorted[index + 1];
    const gap = end - sorted[index];
    if (gap > widest) {
      widest = gap;
      hue = (sorted[index] + gap / 2) % 360;
    }
  }
  return oklchColor(0.625, 0.205, hue).hex;
}

export const COLOR_PRESETS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e"];

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const value = isValidHex(hex) ? hex : "#3b82f6";
  const number = parseInt(value.slice(1), 16);
  const r = ((number >> 16) & 255) / 255;
  const g = ((number >> 8) & 255) / 255;
  const b = (number & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? delta / max : 0, v: max };
}

export function hsvToHex(hsv: { h: number; s: number; v: number }): string {
  const h = hsv.h / 60;
  const c = hsv.v * hsv.s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = hsv.v - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((value) => Math.round((value + m) * 255).toString(16).padStart(2, "0")).join("");
}
