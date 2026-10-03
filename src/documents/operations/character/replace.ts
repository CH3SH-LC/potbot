/**
 * 查找替换（WF-085）。
 *
 * ## 三条不可协商的规矩
 *
 * - **R112 命中零项**：返回 `not_found`，**不是**"静默无操作"；反馈里带查找词与命中数。
 * - **R113 命中多项**：只改**调用方指名的那一处**（`first` / `nth` / `range`）。
 *   要走"全部替换"必须同时给 `scope={kind:'all'}` **和** `confirmAll:true`——
 *   两个都齐了才动，防的是"上游顺手把默认值设成 all"这类事故。
 * - **保格式**：替换文本沿用被替换内容**起始处 run**的属性（Word 行为），
 *   其余 run 属性原封不动；跨 run 的命中在**段落拼接文本**上定位，命中边界可以落在 run 内部。
 *
 * ## 大小写（WF-014、WF-085）
 *
 * - **匹配**：区分大小写由 `FindOptions.caseSensitive` 决定（默认 `true`）。大小写不敏感时
 *   匹配本身按码位逐位比较小写形式（见 `selection/find.ts`），命中区间与原文都对得上。
 * - **替换**：`caseMode` 决定替换文本的形态，默认 `none`（**原样落地**，与既有行为逐字一致）：
 *   - `lower` / `upper` / `title`：把替换文本整体转成对应形态；
 *   - `preserve`：**按每一处命中的原文**推断形态再套到替换文本上（`FOO`→大写、`Foo`→首字母大写、
 *     `foo`→小写）；命中里没有任何字母时（如纯数字）替换文本原样落地——这正对应 WF-014
 *     "不改变中文、数字和未选区"。
 *
 * ## 原子性（R136）
 * 所有命中先在内存里算完，任一落地失败就整批放弃，返回**原模型**。
 *
 * ## 无命中不得假报成功（WF-088）
 * 命中零项一律返回 `not_found`（`code='not_found'`、`detail.hitCount=0`），**绝不**返回
 * "ok + replaced=0"这种看起来成功的形态——"改了 0 处"和"没找到"是两回事。
 */

import type { DocumentModel, InlineNode } from '../../model/types.js';
import { findText, type FindOptions } from '../../selection/find.js';
import { replaceRangeInInlines } from '../../selection/inline-map.js';
import { requireParagraph, replaceParagraph } from '../../selection/structure.js';
import { requireCurrentSelection } from '../../selection/selection.js';
import {
  fail,
  succeed,
  type DocumentRange,
  type Result,
  type Selection,
  type TextMatch,
} from '../../selection/types.js';

/** 替换范围。**没有默认值**——"改哪一处"必须由调用方明说。 */
export type ReplaceScope =
  | { readonly kind: 'first' }
  | { readonly kind: 'nth'; readonly index: number }
  | { readonly kind: 'range'; readonly range: DocumentRange }
  | { readonly kind: 'all' };

/**
 * 替换文本的大小写模式（WF-014）。
 *
 * - `none`（默认）：替换文本原样落地；
 * - `lower` / `upper` / `title`：把替换文本整体转成对应形态；
 * - `preserve`：按**每一处命中的原文**推断形态，再套到替换文本上。
 */
export type ReplaceCaseMode = 'none' | 'lower' | 'upper' | 'title' | 'preserve';

export interface ReplaceOptions {
  readonly find?: FindOptions;
  /** 全部替换的显式确认（R113）。`scope.kind === 'all'` 且命中多于一处时必须为 `true`。 */
  readonly confirmAll?: boolean;
  /** 替换文本的大小写模式（WF-014）。默认 `none`。 */
  readonly caseMode?: ReplaceCaseMode;
}

export interface ReplaceReport {
  readonly query: string;
  readonly replacement: string;
  /** 本次实际采用的大小写模式（默认 `none`），供上层回执与排查。 */
  readonly caseMode: ReplaceCaseMode;
  readonly replaced: number;
  readonly totalMatches: number;
  readonly appliedRanges: readonly DocumentRange[];
}

export interface ReplaceOutcome {
  readonly model: DocumentModel;
  readonly report: ReplaceReport;
}

/** 便捷常量（调用方不手写字面量）。 */
export const REPLACE_FIRST: ReplaceScope = Object.freeze({ kind: 'first' });
export const REPLACE_ALL: ReplaceScope = Object.freeze({ kind: 'all' });

function toDocumentRange(match: TextMatch): DocumentRange {
  return { node_id: match.paragraph_id, start: match.start, end: match.end };
}

function withinRange(match: TextMatch, range: DocumentRange): boolean {
  return (
    match.paragraph_id === range.node_id && match.start >= range.start && match.end <= range.end
  );
}

// ---------------------------------------------------------------------------
// 大小写（WF-014）
// ---------------------------------------------------------------------------

/** 是否"有大小写"的字母（`A`、`ß` 是；`中`、`3`、空格不是）。 */
function isCasedLetter(char: string): boolean {
  return char.toUpperCase() !== char.toLowerCase();
}

/** 单个码位转指定形态；无大小写的码位原样返回（数字/中文/标点不受影响）。 */
function shiftPoint(char: string, toUpper: boolean): string {
  if (!isCasedLetter(char)) return char;
  return toUpper ? char.toUpperCase() : char.toLowerCase();
}

/**
 * 标题式：每个"词"的首字母大写、其余字母小写；非字母码位原样保留。
 * 词的边界取"前一个码位不是字母或数字"（`hello world` → `Hello World`）。
 */
function toTitleCase(text: string): string {
  const points = Array.from(text);
  let prevIsWord = false;
  const mapped = points.map((char) => {
    const isWord = /[0-9A-Za-z]/.test(char) || isCasedLetter(char);
    const shifted = isWord && !prevIsWord ? shiftPoint(char, true) : shiftPoint(char, false);
    prevIsWord = isWord;
    return shifted;
  });
  return mapped.join('');
}

/** 把替换文本整体转成 `lower` / `upper` / `title` 形态。 */
function convertCase(text: string, mode: 'lower' | 'upper' | 'title'): string {
  switch (mode) {
    case 'lower':
      return text.toLowerCase();
    case 'upper':
      return text.toUpperCase();
    case 'title':
      return toTitleCase(text);
  }
}

/**
 * 从**命中原文**推断形态：全大写的字母 ⇒ `upper`；首个字母大写 ⇒ `title`；否则 `lower`。
 * 命中里没有任何字母 ⇒ `null`（无从推断，替换文本原样落地）。
 */
function inferCaseFromSource(source: string): 'lower' | 'upper' | 'title' | null {
  const letters = Array.from(source).filter(isCasedLetter);
  if (letters.length === 0) return null;
  if (letters.every((char) => char === char.toUpperCase())) return 'upper';
  const first = letters[0]!;
  if (first === first.toUpperCase()) return 'title';
  return 'lower';
}

/** 把"每一处命中该用什么替换文本"编成一个纯函数；`preserve` 会读 `match.text`。 */
function resolveReplacementFor(
  replacement: string,
  mode: ReplaceCaseMode,
): (match: TextMatch) => string {
  switch (mode) {
    case 'none':
      return () => replacement;
    case 'lower':
    case 'upper':
    case 'title': {
      const converted = convertCase(replacement, mode);
      return () => converted;
    }
    case 'preserve':
      return (match) => {
        const inferred = inferCaseFromSource(match.text);
        return inferred === null ? replacement : convertCase(replacement, inferred);
      };
  }
}

/** 按段落分组、段内**倒序**落地，保证替换不改变尚未处理的靠前命中的偏移。 */
function applyReplacements(
  model: DocumentModel,
  targets: readonly TextMatch[],
  replacementFor: (match: TextMatch) => string,
): Result<DocumentModel> {
  const byParagraph = new Map<string, TextMatch[]>();
  for (const match of targets) {
    const list = byParagraph.get(match.paragraph_id);
    if (list === undefined) byParagraph.set(match.paragraph_id, [match]);
    else list.push(match);
  }

  const plan: { readonly id: string; readonly inlines: readonly InlineNode[] }[] = [];
  for (const [paragraphId, matches] of byParagraph) {
    const paragraph = requireParagraph(model, paragraphId);
    if (!paragraph.ok) return paragraph;
    const descending = [...matches].sort((a, b) => b.start - a.start);
    let inlines: readonly InlineNode[] = paragraph.value.inlines;
    for (const match of descending) {
      const replaced = replaceRangeInInlines(inlines, match.start, match.end, replacementFor(match));
      if (!replaced.ok) return replaced;
      inlines = replaced.value;
    }
    plan.push({ id: paragraphId, inlines });
  }

  let next = model;
  for (const item of plan) {
    const paragraph = requireParagraph(next, item.id);
    if (!paragraph.ok) return paragraph;
    const replaced = replaceParagraph(next, item.id, { ...paragraph.value, inlines: item.inlines });
    if (!replaced.ok) return replaced;
    next = replaced.value;
  }
  return succeed(next);
}

/** 通用入口：命中集合由 `scope` 决定；`selection` 只用于把命中限制在选区范围内。 */
function replaceWithScope(
  model: DocumentModel,
  query: string,
  replacement: string,
  scope: ReplaceScope,
  options: ReplaceOptions,
  restrictTo?: DocumentRange,
): Result<ReplaceOutcome> {
  const found = findText(model, query, options.find);
  if (!found.ok) return found;

  // 先把命中收窄到"允许改动的范围"里：外层传入的 `restrictTo`（来自选区）与
  // `scope.kind === 'range'` 指定的范围**都**要生效——绝不能越过它们去改别处。
  const limit = scope.kind === 'range' ? scope.range : undefined;
  const allMatches = found.value.filter(
    (match) =>
      (restrictTo === undefined || withinRange(match, restrictTo)) &&
      (limit === undefined || withinRange(match, limit)),
  );

  if (allMatches.length === 0) {
    const scoped = restrictTo !== undefined || limit !== undefined;
    return fail('not_found', `未找到 "${query}"${scoped ? '（限定范围内）' : ''}。`, {
      expression: query,
      hitCount: 0,
      needsClarification: true,
    });
  }

  let targets: readonly TextMatch[];
  switch (scope.kind) {
    case 'first':
      targets = [allMatches[0]!];
      break;
    case 'nth': {
      if (!Number.isInteger(scope.index) || scope.index < 1) {
        return fail('invalid_query', `nth 的序号 ${scope.index} 不是正整数。`, { expression: query });
      }
      const target = allMatches[scope.index - 1];
      if (target === undefined) {
        return fail('not_found', `"${query}" 只有 ${allMatches.length} 处，取不到第 ${scope.index} 处。`, {
          expression: query,
          hitCount: allMatches.length,
          needsClarification: true,
          candidates: allMatches.map(toDocumentRange),
        });
      }
      targets = [target];
      break;
    }
    case 'range':
      // range 作用域 = 该范围内**第一处**命中（要全改请用 scope=all 并显式确认）。
      targets = [allMatches[0]!];
      break;
    case 'all': {
      if (allMatches.length > 1 && options.confirmAll !== true) {
        return fail(
          'ambiguous',
          `"${query}" 命中 ${allMatches.length} 处；"全部替换"必须由调用方显式要求（scope=all 且 confirmAll=true，R113）。`,
          {
            expression: query,
            hitCount: allMatches.length,
            needsClarification: true,
            candidates: allMatches.map(toDocumentRange),
          },
        );
      }
      targets = allMatches;
      break;
    }
  }

  const caseMode = options.caseMode ?? 'none';
  const applied = applyReplacements(model, targets, resolveReplacementFor(replacement, caseMode));
  if (!applied.ok) return applied;

  return succeed({
    model: applied.value,
    report: {
      query,
      replacement,
      caseMode,
      replaced: targets.length,
      totalMatches: allMatches.length,
      appliedRanges: targets.map(toDocumentRange),
    },
  });
}

/** 全文档查找替换（WF-085 主入口）。 */
export function replaceText(
  model: DocumentModel,
  query: string,
  replacement: string,
  scope: ReplaceScope,
  options: ReplaceOptions = {},
): Result<ReplaceOutcome> {
  return replaceWithScope(model, query, replacement, scope, options);
}

/**
 * 选区范围内的查找替换。先过 R114（选区随 revision 失效），
 * 再把命中限制在选区覆盖的范围内。
 */
export function replaceTextInSelection(
  model: DocumentModel,
  selection: Selection,
  query: string,
  replacement: string,
  scope: ReplaceScope,
  options: ReplaceOptions = {},
): Result<ReplaceOutcome> {
  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  if (selection.ranges.length !== 1) {
    return fail(
      'unsupported',
      `选区内替换当前只支持单一连续范围，收到 ${selection.ranges.length} 段。`,
      { extra: { ranges: selection.ranges.length } },
    );
  }
  return replaceWithScope(model, query, replacement, scope, options, selection.ranges[0]);
}
