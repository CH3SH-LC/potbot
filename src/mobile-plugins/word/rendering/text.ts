/**
 * 文本切分与断行机会判定（纯函数，无外部依赖）。
 *
 * ## 断行机会口径（本包自定，明确写入 README）
 *
 * 与 Word / CSS `line-break: normal` 的**近似**规则：
 *
 * 1. **空格之后**可断（`U+0020`；也含 `U+3000` 全角空格）。行尾空格**不渲染**、不计宽
 *    ——这是 Word 的既有行为（行末空格被吞）。
 * 2. **CJK 表意文字 / CJK 标点 / 全角形之间任意处**可断（逐字可断）。
 * 3. 其余（拉丁字母、数字、连字符等）视为**不可断的词**；整词放不下时按字符**硬断**
 *    （`forced_break` 诊断），保证排版必然推进、不死循环。
 *
 * 这是**近似**：真实的 CJK 避头尾（禁则）规则、西文连字符断词、复杂文种簇边界**未实现**，
 * 见 README「已知局限」。
 */

import type { Twips } from './types.js';

/** 单个码点的实测信息（行盒的最小构成单元）。 */
export interface CharMetric {
  /** 该码点对应的字符串（可能是 2 个 UTF-16 code unit）。 */
  char: string;
  codePoint: number;
  /** 段内字符偏移（按码点计）。 */
  offset: number;
  /** 实际使用的字体族（已解析替代）。 */
  fontFamily: string;
  /** 请求的字体族。 */
  requestedFont: string;
  sizePt: number;
  sizeTwips: Twips;
  widthTwips: Twips;
  isSpace: boolean;
  isCjk: boolean;
  /** 该码点**之后**是否允许断行。 */
  breakAfter: boolean;
}

/** 一个"原子"（贪心排版的不可分单元）：词 / 单个空格 / 单个 CJK 字。 */
export interface Atom {
  chars: CharMetric[];
  widthTwips: Twips;
  isSpace: boolean;
  /** 原子内部是否可硬断（词 = true；空格 / 单 CJK 字只有 1 个码点，无内部分解）。 */
  hardBreakable: boolean;
}

/** 全角空格视同空格。 */
const IDEOGRAPHIC_SPACE = 0x3000;

/** 判定一个码点是否属于「逐字可断」的表意文字 / CJK 标点 / 全角形区段。 */
export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK 部首补充
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 / 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xff00 && cp <= 0xffef) || // 全角形
    (cp >= 0x20000 && cp <= 0x2ffff) // CJK 扩展 B+
  );
}

export function isSpaceCodePoint(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === IDEOGRAPHIC_SPACE;
}

/**
 * 按**码点**切分字符串（代理对不被劈开）。
 * 用 `for...of` 而非 `split('')`，因为后者会把代理对拆成两个孤立 unit。
 */
export function codePointsOf(text: string): Array<{ char: string; codePoint: number }> {
  const out: Array<{ char: string; codePoint: number }> = [];
  for (const char of text) {
    out.push({ char, codePoint: char.codePointAt(0) as number });
  }
  return out;
}

/**
 * 把一行字符度量序列切成原子串。
 * 词边界：连续的非空格、非 CJK 码点合成一个原子；空格与 CJK 各成单码点原子。
 */
export function atomsOf(chars: readonly CharMetric[]): Atom[] {
  const atoms: Atom[] = [];
  let word: CharMetric[] = [];
  const flushWord = (): void => {
    if (word.length === 0) return;
    atoms.push({
      chars: word,
      widthTwips: word.reduce((sum, c) => sum + c.widthTwips, 0),
      isSpace: false,
      hardBreakable: true,
    });
    word = [];
  };
  for (const c of chars) {
    if (c.isSpace || c.isCjk) {
      flushWord();
      atoms.push({
        chars: [c],
        widthTwips: c.widthTwips,
        isSpace: c.isSpace,
        // 单码点原子无需内部硬断：整块放不下时它自己就溢出，由外层按码点处理。
        hardBreakable: c.isCjk,
      });
    } else {
      word.push(c);
    }
  }
  flushWord();
  return atoms;
}

/** 裁掉行尾空格原子（Word 行为：行末空格不渲染、不计宽）。 */
export function trimTrailingSpaces(atoms: readonly Atom[]): Atom[] {
  let end = atoms.length;
  while (end > 0) {
    const last = atoms[end - 1];
    if (last === undefined || !last.isSpace) break;
    end -= 1;
  }
  return atoms.slice(0, end);
}
