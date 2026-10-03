/**
 * 颜色：解析、合成、亮度。纯函数，无依赖。
 *
 * 颜色一律用 `RRGGBB` 十六进制字符串表示（与 `src/presentations/model.ts` 的 `color` 字段同口径）。
 * 非法颜色**抛错**，不猜、不静默变黑。
 */

/** 8 位每通道的 RGB。 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 颜色解析错误。 */
export class ColorError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`颜色 ${value} 不是 RRGGBB（或 #RRGGBB）`);
    this.name = 'ColorError';
    this.value = value;
  }
}

/** `RRGGBB` / `#RRGGBB` → RGB。非法即抛。 */
export function parseColor(value: string): Rgb {
  const hex = value.startsWith('#') ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new ColorError(value);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

/** 常用颜色常量。 */
export const WHITE: Rgb = Object.freeze({ r: 255, g: 255, b: 255 });
export const BLACK: Rgb = Object.freeze({ r: 0, g: 0, b: 0 });
export const LIGHT_GRAY: Rgb = Object.freeze({ r: 217, g: 217, b: 217 });
export const MID_GRAY: Rgb = Object.freeze({ r: 128, g: 128, b: 128 });
export const DARK_GRAY: Rgb = Object.freeze({ r: 64, g: 64, b: 64 });

/** 两个颜色是否逐通道相等。 */
export function rgbEquals(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** 颜色 → `RRGGBB` 大写十六进制。 */
export function rgbToHex(color: Rgb): string {
  const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `${part(color.r)}${part(color.g)}${part(color.b)}`.toUpperCase();
}

function clamp8(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n;
}

/**
 * source-over 合成：把 `src` 以 `alpha`（0..1）盖到不透明的 `dst` 上。
 * 结果恒为不透明（本画布无 alpha 通道，幻灯片背景是不透明的）。
 */
export function blendOver(dst: Rgb, src: Rgb, alpha: number): Rgb {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  if (a === 1) return src;
  if (a === 0) return dst;
  return {
    r: clamp8(Math.round(dst.r + (src.r - dst.r) * a)),
    g: clamp8(Math.round(dst.g + (src.g - dst.g) * a)),
    b: clamp8(Math.round(dst.b + (src.b - dst.b) * a)),
  };
}

/** WCAG 相对亮度（0..1）。 */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 两色 WCAG 对比度（1..21）。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
