/**
 * 字数与统计（WF-094）。
 *
 * ## 口径**写死在这里**，且必须能复算
 *
 * "中文字数"在不同工具里能差出一倍，原因是口径不同（含不含标点、emoji 算几个）。
 * 因此本文件把每一条口径写成可读的规则，并让分类器成为**唯一的**判定处：
 *
 * | 类别 | 判定 |
 * |---|---|
 * | 码位 | `Array.from(text)`——代理对算 **1** 个（与选区包的 R102 同一套口径） |
 * | 中文字 | CJK 表意文字：U+3400–U+4DBF / U+4E00–U+9FFF / U+F900–U+FAFF / U+20000–U+2FA1F |
 * | 西文词 | 由 ASCII 字母/数字构成的极大串；串内允许 `'` `’` `-` **夹在**字母数字之间 |
 * | 西文字母 | ASCII `A–Z a–z` 的**码位**数（与"词数"不是一个量） |
 * | 数字 | ASCII `0–9` 的**码位**数 |
 * | emoji | 图形码位：U+1F300–U+1FAFF / U+2600–U+27BF / U+1F1E6–U+1F1FF（含肤色修饰符与区域指示符） |
 * | 空白 | ASCII 空白 + U+00A0 + U+1680 + U+2000–U+200A + U+2028/2029 + U+202F + U+205F + U+3000 + U+FEFF |
 * | 标点 | ASCII 标点 + U+2010–U+2027 + U+2030–U+205E + U+3001–U+303F + 全角标点段 |
 * | 其它 | 以上都不是（西里尔字母、ZWJ U+200D、变体选择符 U+FE0F 等） |
 *
 * **明说的两个后果**（不是 bug，是口径）：
 * - ZWJ 家庭 emoji `👨‍👩‍👧` = **3 个 emoji 码位 + 2 个 other**（两个 ZWJ），
 *   **不**聚合成 1 个"字素簇"——聚合是码位之上再加一层，本合同不覆盖；
 * - 区域指示符国旗 `🇨🇳` = **2 个 emoji 码位**。
 *
 * ## 页数：**没有排版引擎就标"未验证"**（R158）
 *
 * 页数需要真实排版或消费端更新证据。写入域指令、按字数估个"大约 3 页"都属于编造。
 * 因此本文件的页数类型**只有两条出路**：`unverified`（带原因）或 `verified`
 * （必须带引擎名与证据）。没有"我猜 3 页"这种第三态——**结构上就写不出来**。
 */

import type { DocumentModel } from '../model/types.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import { requireCurrentSelection } from '../selection/selection.js';
import { succeed, type Result, type Selection } from '../selection/types.js';
import { fail } from '../selection/types.js';
import { codePointsToText, readCodePoints } from './symbols.js';

/** 计数结果（各字段互不重叠地划分全部码位，除 `latin_words` 外）。 */
export interface TextCounts {
  /** 全部码点数（代理对算 1）。 */
  readonly code_points: number;
  /** 中日韩表意文字码位数。 */
  readonly cjk_chars: number;
  /** 西文词数（极大 ASCII 字母数字串；`'`/`’`/`-` 夹在中间算同一个词）。 */
  readonly latin_words: number;
  /** ASCII 字母码位数（与 `latin_words` 不是一个量）。 */
  readonly latin_letters: number;
  /** ASCII 数字码位数。 */
  readonly digits: number;
  /** 图形码位数（emoji 族；见文件头口径）。 */
  readonly emoji: number;
  /** 标点码位数。 */
  readonly punctuation: number;
  /** 空白码位数。 */
  readonly whitespace: number;
  /** 以上皆非的码位数（ZWJ、变体选择符、其他文种字母等）。 */
  readonly other: number;
}

const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2fa1f],
];

const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x1f300, 0x1faff],
  [0x2600, 0x27bf],
  [0x1f1e6, 0x1f1ff],
];

const PUNCTUATION_RANGES: readonly (readonly [number, number])[] = [
  [0x0021, 0x002f],
  [0x003a, 0x0040],
  [0x005b, 0x0060],
  [0x007b, 0x007e],
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x3001, 0x303f],
  [0xff01, 0xff0f],
  [0xff1a, 0xff20],
  [0xff3b, 0xff40],
  [0xff5b, 0xff65],
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** 是否为空白（口径见文件头）。 */
export function isWhitespaceCodePoint(codePoint: number): boolean {
  if (codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0b || codePoint === 0x0c || codePoint === 0x0d) {
    return true;
  }
  if (codePoint === 0x00a0 || codePoint === 0x1680 || codePoint === 0x2028 || codePoint === 0x2029) return true;
  if (codePoint >= 0x2000 && codePoint <= 0x200a) return true;
  if (codePoint === 0x202f || codePoint === 0x205f || codePoint === 0x3000 || codePoint === 0xfeff) return true;
  return false;
}

/** 是否为 CJK 表意文字。 */
export function isCjkCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, CJK_RANGES);
}

/** 是否为 emoji 图形码位。 */
export function isEmojiCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, EMOJI_RANGES);
}

/** 是否为标点。 */
export function isPunctuationCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, PUNCTUATION_RANGES);
}

const isAsciiLetter = (codePoint: number): boolean =>
  (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a);
const isAsciiDigit = (codePoint: number): boolean => codePoint >= 0x30 && codePoint <= 0x39;
const isAsciiAlnum = (codePoint: number): boolean => isAsciiLetter(codePoint) || isAsciiDigit(codePoint);
/** 词内连接符：`'` `’` `-`（**只在字母数字之间**才并进同一个词）。 */
const isWordConnector = (codePoint: number): boolean => codePoint === 0x27 || codePoint === 0x2019 || codePoint === 0x2d;

/** 单码位的分类（`latin_words` 需要看上下文，故不在本函数里）。 */
export type CodePointClass = 'cjk' | 'emoji' | 'whitespace' | 'latin_letter' | 'digit' | 'punctuation' | 'other';

export function classifyCodePoint(codePoint: number): CodePointClass {
  if (isWhitespaceCodePoint(codePoint)) return 'whitespace';
  if (isCjkCodePoint(codePoint)) return 'cjk';
  if (isEmojiCodePoint(codePoint)) return 'emoji';
  if (isAsciiLetter(codePoint)) return 'latin_letter';
  if (isAsciiDigit(codePoint)) return 'digit';
  if (isPunctuationCodePoint(codePoint)) return 'punctuation';
  return 'other';
}

/** 西文词数：扫描极大 ASCII 字母数字串，允许连接符夹在中间。 */
export function countLatinWords(points: readonly number[]): number {
  let words = 0;
  let index = 0;
  while (index < points.length) {
    if (!isAsciiAlnum(points[index]!)) {
      index += 1;
      continue;
    }
    words += 1;
    index += 1;
    while (index < points.length) {
      const current = points[index]!;
      if (isAsciiAlnum(current)) {
        index += 1;
        continue;
      }
      // 连接符只在"后面还跟着字母数字"时并进本词（于是 "a - b" 是 3 个词，"ab-c" 是 1 个）
      if (isWordConnector(current) && index + 1 < points.length && isAsciiAlnum(points[index + 1]!)) {
        index += 1;
        continue;
      }
      break;
    }
  }
  return words;
}

/** 计数（**唯一口径实现**）。 */
export function countText(text: string): TextCounts {
  const points = readCodePoints(text);
  let cjk = 0;
  let letters = 0;
  let digits = 0;
  let emoji = 0;
  let punctuation = 0;
  let whitespace = 0;
  let other = 0;

  for (const codePoint of points) {
    switch (classifyCodePoint(codePoint)) {
      case 'cjk':
        cjk += 1;
        break;
      case 'emoji':
        emoji += 1;
        break;
      case 'whitespace':
        whitespace += 1;
        break;
      case 'latin_letter':
        letters += 1;
        break;
      case 'digit':
        digits += 1;
        break;
      case 'punctuation':
        punctuation += 1;
        break;
      case 'other':
        other += 1;
        break;
    }
  }

  return {
    code_points: points.length,
    cjk_chars: cjk,
    latin_words: countLatinWords(points),
    latin_letters: letters,
    digits,
    emoji,
    punctuation,
    whitespace,
    other,
  };
}

/** 把一份计数逐字段相加（选区多范围求和的唯一实现）。 */
export function addCounts(parts: readonly TextCounts[]): TextCounts {
  const total: TextCounts = {
    code_points: 0,
    cjk_chars: 0,
    latin_words: 0,
    latin_letters: 0,
    digits: 0,
    emoji: 0,
    punctuation: 0,
    whitespace: 0,
    other: 0,
  };
  const mutable = { ...total } as Record<keyof TextCounts, number>;
  for (const part of parts) {
    for (const key of Object.keys(mutable) as (keyof TextCounts)[]) {
      mutable[key] += part[key];
    }
  }
  return mutable;
}

// ---------------------------------------------------------------------------
// 页数（R158）
// ---------------------------------------------------------------------------

/** 无排版引擎时的原因（**不是**"估不出来"，而是"不许估"）。 */
export const PAGE_COUNT_UNVERIFIED_REASON =
  '本机无排版引擎（无 LibreOffice、无 WPS；Microsoft Word 仅在取证时 COM 可用）：' +
  '页数必须来自真实排版或消费端更新证据（R158），在拿到这类证据之前一律标"未验证"，不得编造。';

export type PageCountResult =
  | { readonly status: 'unverified'; readonly reason: string }
  | { readonly status: 'verified'; readonly pages: number; readonly engine: string; readonly evidence: string };

/** 未验证的页数（**唯一**在无引擎时能产出的形态）。 */
export function pageCountUnverified(reason: string = PAGE_COUNT_UNVERIFIED_REASON): PageCountResult {
  return { status: 'unverified', reason };
}

/**
 * 把**引擎给出的**页数读数变成 `verified`。
 *
 * 缺引擎名或证据一律拒绝：只有"确实排过版"的读数才能进这一支，
 * 于是调用方无法"顺手"造一个 `{status:'verified', pages: 3}`。
 */
export function pageCountFromEngine(reading: {
  readonly engine: string;
  readonly pages: number;
  readonly evidence: string;
}): Result<PageCountResult> {
  if (typeof reading.engine !== 'string' || reading.engine.length === 0) {
    return fail('precondition', '页数读数必须标明排版引擎（如 "Microsoft Word 16.0.20430"）。');
  }
  if (typeof reading.evidence !== 'string' || reading.evidence.length === 0) {
    return fail('precondition', '页数读数必须带证据（文件路径 / hash / 截图标识等），否则无法复核。');
  }
  if (!Number.isInteger(reading.pages) || reading.pages < 1) {
    return fail('precondition', `页数必须是 ≥1 的整数，收到 ${String(reading.pages)}`);
  }
  return succeed({
    status: 'verified',
    pages: reading.pages,
    engine: reading.engine,
    evidence: reading.evidence,
  });
}

// ---------------------------------------------------------------------------
// 文档与选区级统计
// ---------------------------------------------------------------------------

export interface SelectionStatistics {
  /** 每个范围一份计数（顺序与 `selection.ranges` 一致）。 */
  readonly per_range: readonly TextCounts[];
  /** 全部范围的合计（**直接累加**，不做跨范围的词合并——见 `addCounts` 注释）。 */
  readonly total: TextCounts;
}

/** 选区统计（WF-094 的"选区字数"）。选区过期即拒绝（R114）。 */
export function countSelection(model: DocumentModel, selection: Selection): Result<SelectionStatistics> {
  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;

  const perRange: TextCounts[] = [];
  for (const range of selection.ranges) {
    const paragraph = collectParagraphs(model.blocks).find((item) => item.id === range.node_id);
    if (paragraph === undefined) {
      return fail('unknown_node', `文档中不存在 id 为 "${range.node_id}" 的段落。`, { extra: { node_id: range.node_id } });
    }
    const points = readCodePoints(paragraphText(paragraph));
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end > points.length
    ) {
      return fail(
        'invalid_range',
        `范围 [${String(range.start)}, ${String(range.end)}) 超出段落 "${range.node_id}" 的码位长度 ${String(points.length)}。`,
        { extra: { node_id: range.node_id, start: range.start, end: range.end, total: points.length } },
      );
    }
    perRange.push(countText(codePointsToText(points.slice(range.start, range.end))));
  }

  return succeed({ per_range: perRange, total: addCounts(perRange) });
}

export interface DocumentStatistics {
  /** 正文（含表格单元格内段落）的全部码位文本计数。 */
  readonly text: TextCounts;
  /** 段落数（含表格内段落——与"第 N 段"的范围语法同一套文档顺序）。 */
  readonly paragraphs: number;
  readonly tables: number;
  /** 页数：**无引擎时只能是 `unverified`**（R158）。 */
  readonly page_count: PageCountResult;
}

/**
 * 整篇统计。
 *
 * 页数**不接受**任何"估算"参数：本函数没有排版引擎，因此永远返回 `unverified`。
 * 要拿到 `verified`，请用 `pageCountFromEngine` 并附上引擎与证据。
 */
export function countDocument(model: DocumentModel): DocumentStatistics {
  const paragraphs = collectParagraphs(model.blocks);
  const text = countText(paragraphs.map((paragraph) => paragraphText(paragraph)).join('\n'));
  const tables = model.blocks.filter((block) => block.kind === 'table').length;
  return {
    text,
    paragraphs: paragraphs.length,
    tables,
    page_count: pageCountUnverified(),
  };
}
