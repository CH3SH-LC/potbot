/**
 * **脚本分类**（中文字体替代的判据基础）。
 *
 * 一个码点属于哪一脚本，决定它该走 `w:rFonts` 的哪个槽：
 * Han / Kana / Hangul → `eastAsia`；Latin 与其余 → `ascii`。这是中文文档字体回退的**核心分支**
 * ——同一个 run 里「中文用宋体、英文用 Calibri」就是靠这个分出来的。
 *
 * 与 W09 `text.ts` 的 `isCjkCodePoint` **不复用**：那条判据把 Han/Kana/Hangul 合成一个「CJK」布尔，
 * 够断行用，但**分不出**日文假名与韩文，会把假名的回退链指错。本包只做分类，不做断行。
 *
 * ## 顺序敏感
 *
 * `isKana` 必须先于 Han 判：半角片假名 `U+FF66–FF9D` 落在 Han 的全角形区间 `U+FF00–FFEF` 内，
 * 先判 Han 会把片假名误归为汉字。
 */

import type { ScriptClass } from './types.js';

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** 平假名 / 片假名 / 半角片假名 / 假名扩展。 */
const KANA_RANGES: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff], // 平假名 3041–309F + 片假名 30A0–30FF
  [0x31f0, 0x31ff], // 片假名语音扩展
  [0xff66, 0xff9d], // 半角片假名
];

/** 谚文音节与字母。 */
const HANGUL_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // 谚文字母
  [0x3130, 0x318f], // 谚文兼容字母
  [0xa960, 0xa97f], // 谚文字母扩展 A
  [0xac00, 0xd7a3], // 谚文音节
];

/** 汉字（含表意部首、CJK 标点、全角形、扩展区）。 */
const HAN_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2eff], // CJK 部首补充
  [0x2f00, 0x2fdf], // 康熙部首
  [0x3000, 0x303f], // CJK 标点（含 U+3000 全角空格）
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 统一表意
  [0xf900, 0xfaff], // 兼容表意
  [0xff00, 0xffef], // 全角形（半角片假名已在 Kana 先行截获）
  [0x20000, 0x3ffff], // 扩展 B 及以后
];

/** 拉丁 / 数字 / 常用西文标点。 */
const LATIN_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e], // 基本拉丁
  [0x00a0, 0x024f], // 拉丁-1 补充 + 扩展 A/B
  [0x2000, 0x206f], // 常用标点
  [0x1e00, 0x1eff], // 拉丁扩展附加
];

export function isKana(cp: number): boolean {
  return inRanges(cp, KANA_RANGES);
}
export function isHangul(cp: number): boolean {
  return inRanges(cp, HANGUL_RANGES);
}
export function isHan(cp: number): boolean {
  return inRanges(cp, HAN_RANGES);
}
export function isLatin(cp: number): boolean {
  return inRanges(cp, LATIN_RANGES);
}

/** 码点 → 脚本。顺序：Kana → Hangul → Han → Latin → other。 */
export function scriptOf(codePoint: number): ScriptClass {
  if (isKana(codePoint)) return 'kana';
  if (isHangul(codePoint)) return 'hangul';
  if (isHan(codePoint)) return 'han';
  if (isLatin(codePoint)) return 'latin';
  return 'other';
}

/** 脚本 → `w:rFonts` 槽。Han/Kana/Hangul 走 `eastAsia`，其余走 `ascii`。 */
export function slotOf(script: ScriptClass): 'ascii' | 'eastAsia' {
  switch (script) {
    case 'han':
    case 'kana':
    case 'hangul':
      return 'eastAsia';
    case 'latin':
    case 'other':
      return 'ascii';
  }
}
