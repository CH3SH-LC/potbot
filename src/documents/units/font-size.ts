/**
 * 字号换算——中文字号全表（R129）+ 半点值（R128）。**唯一权威实现。**
 *
 * ## 两份表为什么必须都在这里
 *
 * 1. **中文字号名 → pt**：R129 给了十六项约定表。用户说"四号"时，只有这一张表能把它落到 14pt。
 *    任何模块自己写 `if (name === '四号') return 14` 都是分叉，属于违规。
 * 2. **pt → 半点值**：OOXML 的 `w:sz` 单位是半点，12pt 写 `w:sz=24`。这一步同样只在这里做。
 *
 * 注意"小四"= 12pt = 半点 24，而"四号"= 14pt = 半点 28——字号名与 pt 是两张不同刻度的表，
 * 不要按名字猜数值。
 */

import type { ChineseFontSize, FontSize } from '../model/types.js';
import { HALF_POINTS_PER_POINT } from './constants.js';

/**
 * R129 中文字号全表（单位 pt）。**十六项，缺一不可。**
 *
 * 顺序与 `ChineseFontSize` 联合类型一致：初号→八号。
 */
export const CHINESE_FONT_SIZE_PT: Readonly<Record<ChineseFontSize, number>> = Object.freeze({
  初号: 42,
  小初: 36,
  一号: 26,
  小一: 24,
  二号: 22,
  小二: 18,
  三号: 16,
  小三: 15,
  四号: 14,
  小四: 12,
  五号: 10.5,
  小五: 9,
  六号: 7.5,
  小六: 6.5,
  七号: 5.5,
  八号: 5,
});

/** 十六个中文字号名的稳定序列（初号→八号），供枚举与断言用。 */
export const CHINESE_FONT_SIZE_NAMES: readonly ChineseFontSize[] = Object.freeze([
  '初号',
  '小初',
  '一号',
  '小一',
  '二号',
  '小二',
  '三号',
  '小三',
  '四号',
  '小四',
  '五号',
  '小五',
  '六号',
  '小六',
  '七号',
  '八号',
] as readonly ChineseFontSize[]);

/** 中文字号名 → pt（R129）。 */
export function chineseFontSizeToPt(name: ChineseFontSize): number {
  return CHINESE_FONT_SIZE_PT[name];
}

/** 任意 `FontSize`（pt 精确值或中文字号名）→ pt。 */
export function fontSizeToPt(size: FontSize): number {
  return size.kind === 'pt' ? size.value : chineseFontSizeToPt(size.name);
}

/**
 * `FontSize` → OOXML 半点值（`w:sz`）。12pt → 24；小四（12pt）→ 24；四号（14pt）→ 28。
 *
 * 半点的**取整规则**：以四舍五入到整数。10.5pt（五号）→ 21，落在整数点上；
 * 若将来出现 10.1pt 这类值，取整到 20——OOXML 不允许半个半点。
 */
export function fontSizeToHalfPoints(size: FontSize): number {
  return Math.round(fontSizeToPt(size) * HALF_POINTS_PER_POINT);
}

/**
 * 半点值 → `FontSize`。
 *
 * 若该 pt 值正好等于某个中文字号，返回中文字号形式（更接近用户的表达，读回时更友好）；
 * 否则返回 pt 形式。例：24 → `{kind:'pt'…}` 还是 `{kind:'chinese','小四'}`？
 * **本项目选择 pt 形式**——半点是精确数值，反向猜名字会引入"用户写 12pt 却读回小四"的
 * 语义漂移；中文字号只在用户显式用名字写入时才保留名字。名字反查用 `ptsToChineseFontSize`。
 */
export function halfPointsToFontSize(halfPoints: number): FontSize {
  return { kind: 'pt', value: halfPoints / HALF_POINTS_PER_POINT };
}

/**
 * 该字号**能不能被 `w:sz` 精确表达**（半点粒度：pt 必须是 0.5 的整数倍，且 ≥ 0.5pt）。
 *
 * 与 `docx/word-xml.ts` 的 `writableHalfPoints` **同一条规则**——不可表示的字号在**写出时**
 * 会被拒（那里抛错）。本函数把那条例律**前移到意图编译期**，好让"12.3pt"这种值在
 * **动文档之前**就被结构化拒绝，而不是等到导出才炸成一个 `export_failed`。
 *
 * 唯一权威仍在本包：判断用 `fontSizeToPt` × `HALF_POINTS_PER_POINT` 与
 * `fontSizeToHalfPoints` 对拍，**不另写 0.5 / 2 之类的魔数**（R128/R129）。
 */
export function isRepresentableFontSize(size: FontSize): boolean {
  const halfPoints = fontSizeToHalfPoints(size);
  const exact = fontSizeToPt(size) * HALF_POINTS_PER_POINT;
  return Math.abs(exact - halfPoints) <= 1e-9 && halfPoints >= 1;
}

/** pt → 中文字号名；无匹配返回 `null`（例：12 → 小四，但 13 → null）。 */
export function ptsToChineseFontSize(pt: number): ChineseFontSize | null {
  for (const name of CHINESE_FONT_SIZE_NAMES) {
    if (CHINESE_FONT_SIZE_PT[name] === pt) return name;
  }
  return null;
}
