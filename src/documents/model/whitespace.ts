/**
 * 空白与换行保真（合同 **R104**）。
 *
 * ## 合同原文要守的五件事
 *
 * 1. 导入**不得**折叠空白；
 * 2. 不得把连续空格压成一个；
 * 3. 不得把 tab 转成空格；
 * 4. 不得把软换行 `w:br` 当段落边界；
 * 5. `w:t` 的 `xml:space="preserve"` 语义必须保留。
 *
 * 第 1–3 条对模型的要求是"**别动它**"：`RunNode.text` 是**逐字符原样**的仓库，
 * 模型层不提供任何 trim / collapse / normalize 的入口。本模块提供的不是"清洗"，而是
 * **保真证据**（`textFidelity`）与**防折叠断言**（`assertTextVerbatim`）。
 *
 * 第 5 条要求"preserve 语义**能表达**"：`requiresPreserveSpace(text)` 回答
 * "这段文本在不加 `xml:space="preserve"` 的情况下会被 XML 处理器改掉吗"——
 * 导出侧（D02）据此决定写不写该属性。判据按 XML 自身的空白折叠规则：
 * **首尾空白**、**连续 2 个及以上空格**、**含 tab**、**含换行类字符**，任一命中即需要 preserve。
 *
 * 第 4 条对模型的要求是结构性的：换行必须是 `BreakNode`，不是文本里的 `\n`
 * （见 `validation.ts` 的 `text_contains_break_character`）。
 */

import { DocumentModelError } from './errors.js';

/**
 * 会被 XML 空白处理吃掉的换行类字符的**码位**：
 * `0x0A` LF / `0x0D` CR / `0x0B` 垂直制表 / `0x0C` 换页 / `U+2028` 行分隔符 / `U+2029` 段分隔符。
 *
 * 用码位而不是字面量，是为了让源码里不出现**行终止符类字符**（U+2028/U+2029 在
 * ECMAScript 语法里本身就是行终止符）。注意 `U+00A0`（不间断空格）**不在此列**——
 * 它是普通字符，不会被折叠。
 */
const BREAK_CHARACTER_CODES: readonly number[] = [0x0a, 0x0d, 0x0b, 0x0c, 0x2028, 0x2029];

const BREAK_CHARACTER_SET = new Set<string>(
  BREAK_CHARACTER_CODES.map((code) => String.fromCodePoint(code)),
);

/** 供证据文本使用的 R104 口径声明。 */
export const WHITESPACE_FIDELITY_STATEMENT =
  '模型层不折叠空白：run 文本逐字符原样保存（含 tab 与连续空格）；换行必须是 BreakNode；' +
  '需要 preserve 的文本由 requiresPreserveSpace 判定，不在模型层改写。';

/** 该字符是否属于"会被折进段落边界"的换行类字符。 */
export function isBreakCharacter(character: string): boolean {
  return BREAK_CHARACTER_SET.has(character);
}

/** 文本里换行类字符的**码位**偏移（R102 的计数单位，不用 UTF-16 码元）。 */
export function breakCharacterOffsets(text: string): readonly number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const character of text) {
    if (BREAK_CHARACTER_SET.has(character)) {
      offsets.push(offset);
    }
    offset += 1;
  }
  return offsets;
}

/** 文本保真度画像（**只读不改**，可作为证据落盘）。 */
export interface TextFidelity {
  /** 码位数（不是 UTF-16 码元数）。 */
  readonly code_point_length: number;
  readonly has_leading_whitespace: boolean;
  readonly has_trailing_whitespace: boolean;
  readonly space_count: number;
  readonly tab_count: number;
  /** 最长连续空格串的长度（0 = 没有空格）。 */
  readonly max_consecutive_spaces: number;
  readonly break_character_offsets: readonly number[];
  /** 是否需要 `xml:space="preserve"` 才能原样往返。 */
  readonly requires_preserve_space: boolean;
}

/** 计算文本保真度画像。**不修改**输入。 */
export function textFidelity(text: string): TextFidelity {
  const codePoints = [...text];
  const spaceCount = codePoints.filter((character) => character === ' ').length;
  const tabCount = codePoints.filter((character) => character === '\t').length;

  let maxConsecutiveSpaces = 0;
  let currentRun = 0;
  for (const character of codePoints) {
    if (character === ' ') {
      currentRun += 1;
      maxConsecutiveSpaces = Math.max(maxConsecutiveSpaces, currentRun);
    } else {
      currentRun = 0;
    }
  }

  const first = codePoints.at(0);
  const last = codePoints.at(-1);
  const isBlank = (character: string | undefined): boolean =>
    character === ' ' || character === '\t';
  const hasLeadingWhitespace = isBlank(first);
  const hasTrailingWhitespace = isBlank(last);
  const breakOffsets = breakCharacterOffsets(text);

  return {
    code_point_length: codePoints.length,
    has_leading_whitespace: hasLeadingWhitespace,
    has_trailing_whitespace: hasTrailingWhitespace,
    space_count: spaceCount,
    tab_count: tabCount,
    max_consecutive_spaces: maxConsecutiveSpaces,
    break_character_offsets: breakOffsets,
    requires_preserve_space:
      hasLeadingWhitespace ||
      hasTrailingWhitespace ||
      tabCount > 0 ||
      maxConsecutiveSpaces >= 2 ||
      breakOffsets.length > 0,
  };
}

/**
 * 这段 run 文本是否必须带 `xml:space="preserve"` 才能原样往返（R104 第 5 条）。
 *
 * 判据来自 XML 的空白处理规则，不是"看起来像"的经验：
 * 首尾空白会被剥掉、连续空白会被压成一个、tab 会被并进空白串。
 */
export function requiresPreserveSpace(text: string): boolean {
  return textFidelity(text).requires_preserve_space;
}

/**
 * 防折叠断言：`after` 必须与 `before` **逐字符相同**。
 *
 * 任何"读一段文本 → 做点事 → 写回去"的路径都该过这道闸；不一致即
 * `text_fidelity_violation`，**拒绝而不是默默接受被折叠的结果**（R104）。
 */
export function assertTextVerbatim(before: string, after: string, detail: string): void {
  if (before === after) {
    return;
  }
  throw new DocumentModelError(
    'text_fidelity_violation',
    `${detail}：文本被改写（R104 禁止折叠空白/丢字）。` +
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
}
