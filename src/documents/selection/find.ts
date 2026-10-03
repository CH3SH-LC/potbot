/**
 * 文本查找（WF-085 的查找半边）。
 *
 * ## 跨 run
 *
 * 查找在**段落拼接文本**上做（`buildInlineTextMap`），因此一个词被拆在多个 run 里也能命中。
 * 命中以 `(段落 id, 码位起, 码位止)` 表达——调用方拿到的是**可直接用于格式化/替换的范围**，
 * 不需要自己回到 run 层去找位置。
 *
 * ## 大小写与整词
 *
 * - 默认**区分大小写**（`caseSensitive: true`）。这是刻意选择：执行器按用户给的原文精确匹配，
 *   不做隐式的静默等价类扩展；要模糊匹配由调用方显式开启。
 * - 大小写不敏感匹配**按码位逐位比较小写形式**，不做整体 `toLowerCase()`——整体转换会改变
 *   码点数量（如 `İ` → `i̇`），进而让偏移错位。这是"偏移必须准"的直接结果。
 * - `wholeWord` 的"词字符"取 ASCII 字母/数字/下划线；中文相邻字符**不**阻止整词匹配
 *   （中文没有空格分词，若把汉字也算词字符，则 `天气` 在 `今天天气` 里永远匹配不上）。
 */

import type { DocumentModel, InlineNode } from '../model/types.js';
import { collectParagraphs, paragraphText } from './structure.js';
import { buildInlineTextMap } from './inline-map.js';
import { fail, succeed, type CodePointRange, type Result, type TextMatch } from './types.js';

export interface FindOptions {
  /** 是否区分大小写，默认 `true`。 */
  readonly caseSensitive?: boolean;
  /** 是否整词匹配，默认 `false`。 */
  readonly wholeWord?: boolean;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /^[0-9A-Za-z_]$/.test(char);
}

function charAt(points: readonly string[], index: number): string | undefined {
  return index < 0 || index >= points.length ? undefined : points[index];
}

/** 在**字符串**上查找，返回码位区间列表。查询为空返回空数组（由上层判为 `invalid_query`）。 */
export function findMatchesInText(text: string, query: string, options: FindOptions = {}): readonly CodePointRange[] {
  if (query.length === 0) return [];
  const caseSensitive = options.caseSensitive ?? true;
  const wholeWord = options.wholeWord ?? false;
  const haystack = Array.from(text);
  const needle = Array.from(query);

  const matches: CodePointRange[] = [];
  const last = haystack.length - needle.length;
  // 左到右取**不重叠**的匹配（Word 行为）。替换要按命中倒序逐个落地，
  // 若允许重叠，靠后的替换会改变靠前命中的边界，偏移就不再成立。
  for (let start = 0; start <= last; start += 1) {
    let hit = true;
    for (let i = 0; i < needle.length; i += 1) {
      const left = haystack[start + i]!;
      const right = needle[i]!;
      const same = caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
      if (!same) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    const end = start + needle.length;
    if (wholeWord && (isWordChar(charAt(haystack, start - 1)) || isWordChar(charAt(haystack, end)))) {
      continue;
    }
    matches.push({ start, end });
    start = end - 1; // 跳过本命中，保证不重叠
  }
  return matches;
}

/** 在单个段落的行内序列上查找。 */
export function findInInlines(
  inlines: readonly InlineNode[],
  query: string,
  options: FindOptions = {},
): readonly CodePointRange[] {
  return findMatchesInText(buildInlineTextMap(inlines).text, query, options);
}

/**
 * 全文档查找。
 *
 * - 空查询 → `invalid_query`（**不算** `not_found`：没查和查不到是两回事）；
 * - 命中零项 → `not_found`（R112），反馈里带查询词与是否需要澄清；
 * - 命中一项或多处 → `ok`，多处由**调用方**决定是否要用户澄清（R113：只有"全部替换"
 *   才需要用户显式要求，单纯列出候选不算歧义）。
 */
export function findText(
  model: DocumentModel,
  query: string,
  options: FindOptions = {},
): Result<readonly TextMatch[]> {
  if (query.length === 0) {
    return fail('invalid_query', '查找内容为空，未执行查找。', { expression: query });
  }

  const matches: TextMatch[] = [];
  for (const paragraph of collectParagraphs(model.blocks)) {
    const text = paragraphText(paragraph);
    for (const range of findMatchesInText(text, query, options)) {
      matches.push({
        paragraph_id: paragraph.id,
        start: range.start,
        end: range.end,
        text: Array.from(text).slice(range.start, range.end).join(''),
      });
    }
  }

  if (matches.length === 0) {
    return fail('not_found', `未找到 "${query}"。`, {
      expression: query,
      hitCount: 0,
      needsClarification: true,
    });
  }
  return succeed(matches);
}
