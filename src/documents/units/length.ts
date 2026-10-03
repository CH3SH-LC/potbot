/**
 * 长度换算——`Length` ↔ twips / pt（R127/R128）。
 *
 * 这是**唯一**允许出现的 `Length` → twips 换算。其他模块（操作层、样式层、将来的 docx 写码器）
 * 必须调用这里，不得自行乘 20 或乘 567。
 */

import type { Length, LengthUnit } from '../model/types.js';
import {
  TWIPS_PER_CM,
  TWIPS_PER_INCH,
  TWIPS_PER_MM_DENOMINATOR,
  TWIPS_PER_MM_NUMERATOR,
  TWIPS_PER_POINT,
} from './constants.js';

/** 每个长度单位换算到 twips 的有理数比例（分子 / 分母）。 */
const TWIPS_RATIO: Readonly<Record<LengthUnit, { readonly num: number; readonly den: number }>> = {
  pt: { num: TWIPS_PER_POINT, den: 1 },
  inch: { num: TWIPS_PER_INCH, den: 1 },
  cm: { num: TWIPS_PER_CM, den: 1 },
  mm: { num: TWIPS_PER_MM_NUMERATOR, den: TWIPS_PER_MM_DENOMINATOR },
  twips: { num: 1, den: 1 },
};

const LENGTH_UNITS: readonly LengthUnit[] = ['pt', 'mm', 'cm', 'inch', 'twips'];

/** 运行时单位守卫（跨 JSON 边界进来的字符串需要它）。 */
export function isLengthUnit(value: string): value is LengthUnit {
  return (LENGTH_UNITS as readonly string[]).includes(value);
}

/**
 * `Length` → twips（四舍五入到整数）。
 *
 * 采用有理数运算（分子/分母）而非浮点比例，避免 `0.1 + 0.2` 那类误差在长文档里累积。
 * mm 走 567/10：10 mm → 567 twips 恰好整数。
 */
export function lengthToTwips(length: Length): number {
  const ratio = TWIPS_RATIO[length.unit];
  return Math.round((length.value * ratio.num) / ratio.den);
}

/** `Length` → pt（可能非整数，如 2 cm → 56.7 pt）。 */
export function lengthToPoints(length: Length): number {
  return lengthToTwips(length) / TWIPS_PER_POINT;
}

/** twips → 指定单位的 `Length`。 */
export function twipsToLength(twips: number, unit: LengthUnit): Length {
  const ratio = TWIPS_RATIO[unit];
  return { unit, value: (twips * ratio.den) / ratio.num };
}

/**
 * 便捷构造：pt → twips。段前/段后、制表位、固定行距都走这条。
 *
 * 与 `lengthToTwips({unit:'pt', value})` 等价；提供此函数是为了让调用点读起来明确
 * "这里是 pt 转 twips"，而不是随手写 `* 20`。
 */
export function pointsToTwips(points: number): number {
  return Math.round(points * TWIPS_PER_POINT);
}

/** 便捷构造：twips → pt。 */
export function twipsToPoints(twips: number): number {
  return twips / TWIPS_PER_POINT;
}
