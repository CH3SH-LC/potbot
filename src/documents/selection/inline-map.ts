/**
 * 段内行内序列的**拼接与再切分**（合同 R102、R104）。
 *
 * ## 偏移空间
 *
 * 一个段落的偏移空间 = 其 `inlines` 按顺序拼出的文本，单位是**码位**：
 * - `RunNode` 贡献 `text`——**可编辑**，范围边界可以落在它内部（会切 run）；
 * - `BreakNode`（软换行 `w:br`）贡献一个 `'\n'`——**不可编辑**，它不是段落边界（R104），
 *   但在偏移空间里占一位，这样"第 12 个字符"在含软换行的段落里仍然算得对；
 * - `FieldNode` 贡献其 `cached_result`（无缓存时占一个 U+FFFC 占位符）——**不可编辑**，
 *   边界**不得**落在它内部（域不能被切一半）；
 * - `DrawingNode` / `EquationNode`（内联图形 / 行内公式）各贡献**一个** U+FFFC——**不可编辑**，
 *   整体可被选区完整覆盖，而"部分覆盖"在整数偏移下不可能发生（design-05-P9）。
 *
 * ## 为什么切 run 而不是"重建整段"
 *
 * 只改一个词时，其余 run 必须**原样不动**（判据）。因此这里只切"被范围穿过"的 run：
 * 未被穿过的 run 对象**按引用原样保留**；被穿过的 run 按需切成 前缀 / 被选 / 后缀 三段，
 * 未选中的两段**属性原封不动**。这同时满足 R147/R151——**绝不把正文读出来重建成新文档**。
 *
 * ## 切分产生的 id
 *
 * 未被切开的 run **保留原 id**；被切开时**头部片段保留原 id**，其余片段用确定性的派生 id
 * （`<原 id>~m` 被选段 / `~s` 尾段 / `~r` 替换插入段）。
 * 派生规则是纯函数（同输入同输出），便于复算；**正式的 id 分配归 D01**，本处只保证不冲突、
 * 可预测、可追溯（见 interface-declaration 的"已知依赖"）。
 */

import type { BreakNode, FieldNode, InlineNode, NodeId, RunNode } from '../model/types.js';
import { codePointLength } from './codepoint.js';
import { fail, succeed, type Result } from './types.js';

/** 软换行在偏移空间里占的字符（R104：它不是段落边界）。 */
export const BREAK_TEXT = '\n';
/** 无缓存域在偏移空间里占的占位符（对象替换字符）。 */
export const FIELD_PLACEHOLDER = '￼';

export type SegmentKind = 'run' | 'break' | 'field' | 'drawing' | 'equation';

export interface InlineSegment {
  readonly inlineIndex: number;
  readonly kind: SegmentKind;
  /** 该片段在段落文本里的起偏移（码位，含）。 */
  readonly start: number;
  /** 该片段在段落文本里的止偏移（码位，开）。 */
  readonly end: number;
  /** 是否可编辑（只有 run 是 `true`）。 */
  readonly editable: boolean;
}

export interface InlineTextMap {
  /** 段落拼接后的文本（码位序列）。 */
  readonly text: string;
  readonly segments: readonly InlineSegment[];
  /** 段落总码位数。 */
  readonly total: number;
}

/** 单个行内节点在偏移空间里贡献的文本。 */
export function segmentText(node: InlineNode): string {
  switch (node.kind) {
    case 'run':
      return node.text;
    case 'break':
      return BREAK_TEXT;
    case 'field':
      return node.cached_result ?? FIELD_PLACEHOLDER;
    case 'drawing':
      // 内联图形在文本流里占**一个**对象字符位（U+FFFC，与 Word 的约定一致）：
      // 占 0 位会让"在图片后插入文字"的偏移与用户看到的对不上；占多变会破坏跨 run 切分的不变量。
      return FIELD_PLACEHOLDER;
    case 'equation':
      // 行内公式（design-05-P9）与内联图形**同类**：占且仅占一个对象字符位（U+FFFC）。
      // 这条与 `model/text.ts::inlinePlainText` 的 equation、`equations/inline-selection.ts`
      // 的 `EQUATION_PLACEHOLDER` **必须逐字同源**——三方不一致会算出两个段落长度。
      // 注意 `editable` 由下面的 `node.kind === 'run'` 决定，公式因此**不可编辑**（正确）。
      return FIELD_PLACEHOLDER;
  }
}

/** 拼出段落的偏移空间与每个行内节点的码位区间。 */
export function buildInlineTextMap(inlines: readonly InlineNode[]): InlineTextMap {
  const segments: InlineSegment[] = [];
  let text = '';
  let offset = 0;
  for (let inlineIndex = 0; inlineIndex < inlines.length; inlineIndex += 1) {
    const node = inlines[inlineIndex]!;
    const piece = segmentText(node);
    const length = codePointLength(piece);
    segments.push({
      inlineIndex,
      kind: node.kind,
      start: offset,
      end: offset + length,
      editable: node.kind === 'run',
    });
    text += piece;
    offset += length;
  }
  return { text, segments, total: offset };
}

/** 分段结果的三个槽位：范围之前 / 被选 / 范围之后。 */
export interface SplitInlines {
  readonly before: readonly InlineNode[];
  readonly selected: readonly InlineNode[];
  readonly after: readonly InlineNode[];
  /** 承载 `start` 位置的 run（供替换时"保格式"取属性）；段落内无 run 时为 `null`。 */
  readonly anchor: RunNode | null;
  /** 被选中的 run 条数（toggle 判定需要）。 */
  readonly selectedRunCount: number;
  /** 范围是否完整包含了不可编辑行内节点（软换行/域）——替换操作必须据此拒绝。 */
  readonly containedNonEditable: boolean;
}

/** 派生片段 id：纯函数，便于复算与排查。 */
export function derivePieceId(baseId: NodeId, tag: 'm' | 's' | 'r'): NodeId {
  return `${baseId}~${tag}`;
}

function isRun(node: InlineNode): node is RunNode {
  return node.kind === 'run';
}

/** 找到承载 `start` 的 run：优先"起点严格落在其内部"的那个，否则取"正好结束于 start"的前一个 run。 */
function findAnchorRun(inlines: readonly InlineNode[], segments: readonly InlineSegment[], start: number): RunNode | null {
  let endingAtStart: RunNode | null = null;
  let startingAtStart: RunNode | null = null;
  for (let i = 0; i < inlines.length; i += 1) {
    const node = inlines[i]!;
    if (!isRun(node)) continue;
    const segment = segments[i]!;
    if (segment.start <= start && start < segment.end) return node;
    if (segment.end === start) endingAtStart = node;
    if (segment.start === start && startingAtStart === null) startingAtStart = node;
  }
  return endingAtStart ?? startingAtStart;
}

/**
 * 把行内序列按码位区间 `[start, end)` 切成 之前 / 被选 / 之后 三段。
 *
 * 不变式：`before + selected + after` 拼接出的文本 === 原文本（切分不改字，R147/R151）。
 * 边界落在**不可编辑**节点内部时返回 `unsupported`（例如"把域切一半"）。
 */
export function splitInlinesAtRange(
  inlines: readonly InlineNode[],
  start: number,
  end: number,
): Result<SplitInlines> {
  const map = buildInlineTextMap(inlines);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > map.total || start > end) {
    return fail('invalid_range', `范围 [${start}, ${end}) 超出段落码位长度 ${map.total}。`, {
      extra: { start, end, total: map.total },
    });
  }

  const before: InlineNode[] = [];
  const selected: InlineNode[] = [];
  const after: InlineNode[] = [];
  let containedNonEditable = false;
  let selectedRunCount = 0;

  for (let i = 0; i < inlines.length; i += 1) {
    const node = inlines[i]!;
    const segment = map.segments[i]!;

    if (segment.end <= start) {
      before.push(node);
      continue;
    }
    if (segment.start >= end) {
      after.push(node);
      continue;
    }

    const localStart = Math.max(start, segment.start) - segment.start;
    const localEnd = Math.min(end, segment.end) - segment.start;
    const localLength = segment.end - segment.start;

    if (!isRun(node)) {
      if (localStart === 0 && localEnd === localLength) {
        // 整个不可编辑节点落在范围内：格式化时原样略过；替换时必须拒绝（会毁结构）。
        containedNonEditable = true;
        selected.push(node);
        continue;
      }
      // 边界落在域的内部（多码位缓存文本）：无法切分。
      return fail('unsupported', '范围边界落在不可切分的域内部，拒绝切分。', {
        extra: { inlineIndex: i, start, end },
      });
    }

    const points = Array.from(node.text);
    if (localStart === 0 && localEnd === points.length) {
      selected.push(node);
      selectedRunCount += 1;
      continue;
    }
    if (localStart > 0) {
      before.push({ ...node, text: points.slice(0, localStart).join('') });
    }
    if (localEnd > localStart) {
      selected.push({ ...node, id: derivePieceId(node.id, 'm'), text: points.slice(localStart, localEnd).join('') });
      selectedRunCount += 1;
    }
    if (localEnd < points.length) {
      after.push({ ...node, id: derivePieceId(node.id, 's'), text: points.slice(localEnd).join('') });
    }
  }

  return succeed({
    before,
    selected,
    after,
    anchor: findAnchorRun(inlines, map.segments, start),
    selectedRunCount,
    containedNonEditable,
  });
}

/** 把"被选"槽位里的 run 逐个替换（格式化用），非 run 的行内节点原样保留。 */
export function mapSelectedRuns(
  split: SplitInlines,
  mapper: (node: RunNode) => RunNode,
): readonly InlineNode[] {
  const mapped = split.selected.map((node) => (isRun(node) ? mapper(node) : node));
  return [...split.before, ...mapped, ...split.after];
}

/**
 * 用 `replacement` 替换码位区间 `[start, end)`（WF-085 的落点）。
 *
 * **保格式**：替换文本落在 `start` 所属的那个 run 的属性上（Word 的行为：
 * 替换结果沿用被替换内容起始处的格式）。其余未受影响的 run 属性原封不动。
 * 范围完整包含软换行或域时返回 `unsupported`——替换会删除结构，不能静默做。
 */
export function replaceRangeInInlines(
  inlines: readonly InlineNode[],
  start: number,
  end: number,
  replacement: string,
): Result<readonly InlineNode[]> {
  if (start === end && replacement === '') return succeed(inlines);

  const split = splitInlinesAtRange(inlines, start, end);
  if (!split.ok) return split;
  const parts = split.value;

  if (parts.containedNonEditable) {
    return fail('unsupported', '替换范围包含软换行或域，删除会破坏结构，已拒绝。', {
      extra: { start, end },
    });
  }

  const anchorProperties = parts.anchor?.properties ?? null;
  const fallbackRun = [...parts.before, ...parts.after].find(isRun) ?? null;
  const properties = anchorProperties ?? fallbackRun?.properties ?? null;

  const result: InlineNode[] = [...parts.before];
  if (replacement.length > 0) {
    const seedId = parts.anchor?.id ?? fallbackRun?.id;
    if (properties === null || seedId === undefined) {
      return fail('unsupported', '段落内没有任何 run，无法确定插入文本的字符格式。', {
        extra: { start, end },
      });
    }
    const inserted: RunNode = {
      kind: 'run',
      id: derivePieceId(seedId, 'r'),
      source: 'user_request',
      opaque: [],
      properties,
      text: replacement,
    };
    result.push(inserted);
  }
  result.push(...parts.after);

  return succeed(result);
}

/** 段落内行内节点拼接出的文本（含软换行的 `'\n'`）。 */
export function inlineText(inlines: readonly InlineNode[]): string {
  return buildInlineTextMap(inlines).text;
}

/** 类型护栏：BreakNode / FieldNode 的判别式（供其他模块复用，避免各写各的）。 */
export function isBreak(node: InlineNode): node is BreakNode {
  return node.kind === 'break';
}

export function isField(node: InlineNode): node is FieldNode {
  return node.kind === 'field';
}
