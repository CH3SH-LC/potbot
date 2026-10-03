/**
 * 剪贴板（WF-088 后半：复制 / 剪切 / 粘贴 + 纯文本粘贴）。
 *
 * ## 与已有实现的边界
 *
 * `selection.ts::extractSelectionText` 已经能把选区取成**纯文本**（复制的降级半边）。
 * 本模块补齐缺的那一半：**富内容复制**（带 run 属性的行内片段）、**剪切**、以及
 * **带显式模式的粘贴**。选区粒度（字词 / 句 / 段 / 多段 / 全文 / 表格单元格）由
 * `expand.ts` / `resolve.ts` 提供，本模块只消费 `Selection`。
 *
 * ## 粘贴模式（WF-088"粘贴有明确模式"，与 Word 的三个粘贴选项对应）
 *
 * - `keep-source-formatting`（保留源格式）：粘贴内容沿用**源 run 的属性**原样。
 * - `merge-formatting`（合并格式）：以**目标处 run 的显式属性**覆盖源属性——目标位置**明确设置**
 *   过的字段取胜，源里有、目标处未指定的字段保留。这是"随目标格式"的模型侧表达。
 * - `plain-text`（只保留文本）：丢弃全部源格式；**非文本节点（域 / 图形 / 公式）一并丢弃**
 *   （Word"只保留文本"的行为），软换行保留为软换行。丢弃数量在回执里如实报出，不假装没丢。
 *
 * ## 从不静默
 *
 * 空选区复制 / 空剪贴板粘贴 / 目标越界 / 目标反转，一律**显式失败**（`empty_range` /
 * `invalid_range`），绝不返回"成功但什么都没做"（WF-088 验收："无匹配不假报成功"）。
 *
 * ## 原子性（R136）与范围外不变（R147/R151）
 *
 * `cut` 先复制、再把每一段算完再统一写回；任一段失败则**整批放弃**、返回原模型。
 * `paste` 只在目标段内做切分 / 拼接，目标段**之前 / 之后**的行内节点按引用原样保留，
 * 其余块对象按引用原样保留。
 *
 * ## 跨段粘贴（W-I12 增量：块级插入）
 *
 * 剪贴板含**多段**（或纯文本含**换行**）时走**块级插入**，不再返回 `unsupported`：
 * 把目标段按目标范围拆成三段（其一为范围之前的行内、其二为被替换掉的选中行内、其三为范围
 * 之后的行内）——第一段剪贴板内容并进头段、最后一段并进尾段、中间各段各成一个新段，
 * 整体替换目标段在 `blocks` 里的位置。段落数与剪贴板段数相等（N 段 ⇒ N 段）。
 *
 * - **含表格单元格内**的段落：`spliceParagraphInBlocks` 沿 `blocks → table → rows → cells → …`
 *   递归定位，命中单元格时在**该单元格的 blocks** 里就地展开（结构遍历口径与 `structure.ts` 一致）。
 * - **run 属性按粘贴模式处理**：与单段粘贴同一套 `keep-source` / `merge` / `plain-text` 语义；
 *   `plain-text` 仍丢弃域 / 图形 / 公式并把丢弃数累加到 `droppedNonText`。
 * - **段落属性**：剪贴板载荷 **v1 不外带段落属性**（`ClipboardParagraph` 只有行内），因此新增
 *   段落沿用**目标段**的 `properties` / `style_ref` / `numbering`——即"落到哪段就随哪段的段格式"，
 *   这是当前唯一可得的段落格式上下文（已知简化，见 runbook）。被拆出的尾段与中段 `opaque` 置空，
 *   避免把同一段未建模 XML 重复写进多个新段。
 *
 * **段内（单段）粘贴、纯文本单行粘贴走原路径**：本增量为纯加法，单段路径逐字节不变（有独立取证）。
 *
 * ## 撤销归属
 *
 * R138/R141 的一次用户事务收口与撤销 / 重做属 **W10**（WORD.md 分工"W10 管生命周期/事务/撤销"）。
 * 本模块**不递增 `revision`**，但把 `replacedFragment`（被替换掉的原行内片段）随回执交出，
 * 使撤销无需重新推导即可还原。
 */

import type {
  BlockNode,
  CellNode,
  DocumentId,
  DocumentModel,
  InlineNode,
  ParagraphNode,
  RowNode,
  RunNode,
  RunProperties,
} from '../model/types.js';
import { codePointLength } from './codepoint.js';
import {
  buildInlineTextMap,
  inlineText,
  replaceRangeInInlines,
  splitInlinesAtRange,
  type SplitInlines,
} from './inline-map.js';
import { requireCurrentSelection, validateRanges } from './selection.js';
import { requireParagraph, replaceParagraph } from './structure.js';
import { fail, succeed, type DocumentRange, type Result, type Selection } from './types.js';

function isRun(node: InlineNode): node is RunNode {
  return node.kind === 'run';
}

// ---------------------------------------------------------------------------
// 剪贴板载荷
// ---------------------------------------------------------------------------

/** 剪贴板里的一个段落片段：按文档顺序排列的被选行内节点。 */
export interface ClipboardParagraph {
  /** 被选中的行内节点（run 保留源属性；break/field/drawing/equation 原样保留）。 */
  readonly inlines: readonly InlineNode[];
  /** 该范围是否覆盖了整段（诊断 / 将来携带段落属性用；v1 不外带段落属性）。 */
  readonly whole_paragraph: boolean;
}

/** 复制的产物：富内容 + 纯文本投影。 */
export interface ClipboardPayload {
  /** 源文档 id（仅追溯；允许粘贴到别的文档）。 */
  readonly document_id: DocumentId;
  readonly paragraphs: readonly ClipboardParagraph[];
  /** 纯文本投影：各段 `inlineText` 用 `'\n'` 连接（与 `extractSelectionText` 口径一致）。 */
  readonly text: string;
  /** 是否含非文本行内节点（域 / 图形 / 公式）——纯文本粘贴会丢弃它们。 */
  readonly contains_non_text: boolean;
}

/** 粘贴模式。 */
export type PasteMode = 'keep-source-formatting' | 'merge-formatting' | 'plain-text';

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

/**
 * 把选区复制成剪贴板载荷（WF-088 复制）。
 *
 * 空选区（每段范围都是零宽）→ `empty_range`，**不**返回空载荷假装成功。
 */
export function copySelection(model: DocumentModel, selection: Selection): Result<ClipboardPayload> {
  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  const ranges = validateRanges(model, selection.ranges);
  if (!ranges.ok) return ranges;
  if (selection.ranges.length === 0) {
    return fail('empty_range', '选区为空，没有可复制的内容。', {});
  }

  const paragraphs: ClipboardParagraph[] = [];
  let copiedLength = 0;
  let containsNonText = false;

  for (const range of selection.ranges) {
    const paragraph = requireParagraph(model, range.node_id);
    if (!paragraph.ok) return paragraph;
    const total = buildInlineTextMap(paragraph.value.inlines).total;
    const split = splitInlinesAtRange(paragraph.value.inlines, range.start, range.end);
    if (!split.ok) return split;
    const selected = split.value.selected;
    copiedLength += codePointLength(inlineText(selected));
    if (selected.some((node) => !isRun(node))) containsNonText = true;
    paragraphs.push({
      inlines: selected,
      whole_paragraph: range.start === 0 && range.end === total,
    });
  }

  if (copiedLength === 0 && !containsNonText) {
    return fail('empty_range', '选区为空，没有可复制的内容。', {});
  }

  return succeed({
    document_id: model.document_id,
    paragraphs,
    text: paragraphs.map((item) => inlineText(item.inlines)).join('\n'),
    contains_non_text: containsNonText,
  });
}

// ---------------------------------------------------------------------------
// 剪切
// ---------------------------------------------------------------------------

export interface CutOutcome {
  readonly model: DocumentModel;
  readonly clipboard: ClipboardPayload;
  /** 实际删除的范围（文档顺序，来自原选区）。 */
  readonly appliedRanges: readonly DocumentRange[];
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

/** 合并区间（含相邻 / 重叠），保证同一段内的删除不会互相错位。 */
function mergeIntervals(intervals: readonly Interval[]): readonly Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && item.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, item.end) };
    } else {
      merged.push({ start: item.start, end: item.end });
    }
  }
  return merged;
}

/**
 * 剪切：复制 + 删除。先复制（任何失败立即返回、文档零改动），
 * 再按段分组、段内**倒序**删除。范围含不可切分结构（软换行 / 域）时 `unsupported`，整批放弃。
 */
export function cutSelection(model: DocumentModel, selection: Selection): Result<CutOutcome> {
  const copied = copySelection(model, selection);
  if (!copied.ok) return copied;

  const byParagraph = new Map<string, Interval[]>();
  for (const range of selection.ranges) {
    const list = byParagraph.get(range.node_id);
    if (list === undefined) byParagraph.set(range.node_id, [{ start: range.start, end: range.end }]);
    else list.push({ start: range.start, end: range.end });
  }

  const plan: { readonly id: string; readonly inlines: readonly InlineNode[] }[] = [];
  for (const [id, intervals] of byParagraph) {
    const paragraph = requireParagraph(model, id);
    if (!paragraph.ok) return paragraph;
    const descending = [...mergeIntervals(intervals)].sort((a, b) => b.start - a.start);
    let inlines: readonly InlineNode[] = paragraph.value.inlines;
    for (const interval of descending) {
      if (interval.start === interval.end) continue;
      const removed = replaceRangeInInlines(inlines, interval.start, interval.end, '');
      if (!removed.ok) return removed; // 含软换行 / 域 → unsupported，整批不落地
      inlines = removed.value;
    }
    plan.push({ id, inlines });
  }

  let next = model;
  for (const item of plan) {
    const paragraph = requireParagraph(next, item.id);
    if (!paragraph.ok) return paragraph;
    const replaced = replaceParagraph(next, item.id, { ...paragraph.value, inlines: item.inlines });
    if (!replaced.ok) return replaced;
    next = replaced.value;
  }

  return succeed({ model: next, clipboard: copied.value, appliedRanges: selection.ranges });
}

// ---------------------------------------------------------------------------
// 粘贴
// ---------------------------------------------------------------------------

export interface PasteOutcome {
  readonly model: DocumentModel;
  readonly mode: PasteMode;
  /** 粘贴目标（原范围）。 */
  readonly target: DocumentRange;
  /** 新插入内容在目标段中的范围（码位，半开区间）。 */
  readonly insertedRange: DocumentRange;
  /** 被替换掉的原文范围；零宽插入（光标处）时为 `null`。 */
  readonly replaced: DocumentRange | null;
  /** 被替换掉的原行内片段（撤销用，W10 消费）。 */
  readonly replacedFragment: readonly InlineNode[];
  /** 实际写入内容的纯文本投影。 */
  readonly plainText: string;
  /** `plain-text` 模式下被丢弃的非文本节点数（如实报出，不隐藏）。 */
  readonly droppedNonText: number;
  /**
   * **跨段粘贴**（W-I12）时产生的段落序列（文档顺序）：`[头段, 中段…, 尾段]`，每项是该段里
   * **承载粘贴内容**的码位范围（头段含 `beforeLength` 偏移；中/尾段自 0 起）。
   *
   * 单段粘贴时为 `undefined`（`insertedRange` 已足够表达）。新增可选字段，既有消费方不受影响。
   */
  readonly insertedParagraphs?: readonly DocumentRange[];
}

interface PastePlan {
  readonly inlines: readonly InlineNode[];
  readonly droppedNonText: number;
}

/**
 * 重排粘贴内容的 id，避免与目标段已有 id 冲突（确定性派生，便于复算）。
 *
 * `tag` 只在**跨段粘贴**时非空（取 `"<段序>-"`），使不同剪贴板段里同名节点不会派生出同一个 id；
 * 单段粘贴 `tag === ''`，派生结果与旧实现**逐字节相同**（`<原 id>~p<序>`）。
 */
function rekey(node: InlineNode, index: number, tag = ''): InlineNode {
  const id = `${node.id}~p${tag}${index}`;
  switch (node.kind) {
    case 'run':
      return { ...node, id, source: 'user_request' };
    case 'break':
      return { ...node, id, source: 'user_request' };
    case 'field':
      return { ...node, id, source: 'user_request' };
    case 'drawing':
      return { ...node, id, source: 'user_request' };
    case 'equation':
      return { ...node, id, source: 'user_request' };
  }
}

/** 目标位置的字符格式来源：优先起始锚 run，退而取范围内任一 run；都没有则 `null`。 */
function resolveDestProperties(split: SplitInlines): RunProperties | null {
  if (split.anchor !== null) return split.anchor.properties;
  const fallback = [...split.before, ...split.after].find(isRun);
  return fallback === undefined ? null : fallback.properties;
}

/** 合并格式：目标处**显式设置**过的字段覆盖源字段；其余沿用源；目标未指定的不覆盖。 */
function mergeRunProperties(source: RunProperties, dest: RunProperties): RunProperties {
  const merged: Record<string, unknown> = {};
  const sourceRecord = source as unknown as Record<string, unknown>;
  const destRecord = dest as unknown as Record<string, { readonly state: string }>;
  for (const key of Object.keys(sourceRecord)) {
    const destField = destRecord[key];
    merged[key] = destField !== undefined && destField.state !== 'unspecified' ? destField : sourceRecord[key];
  }
  return merged as unknown as RunProperties;
}

/** 保留源格式：每个节点原样带过，仅换 id / source。 */
function buildKeepSource(source: readonly InlineNode[], tag = ''): Result<PastePlan> {
  return succeed({ inlines: source.map((node, index) => rekey(node, index, tag)), droppedNonText: 0 });
}

/** 合并格式：run 的属性按"目标显式覆盖源"合并；非文本节点原样带过。 */
function buildMerged(source: readonly InlineNode[], dest: RunProperties, tag = ''): Result<PastePlan> {
  const inlines = source.map((node, index) => {
    if (isRun(node)) {
      return { ...node, id: `${node.id}~p${tag}${index}`, source: 'user_request' as const, properties: mergeRunProperties(node.properties, dest) };
    }
    return rekey(node, index, tag);
  });
  return succeed({ inlines, droppedNonText: 0 });
}

/** 只保留文本：run 取目标格式；软换行保留；域 / 图形 / 公式丢弃并计数。 */
function buildPlainText(source: readonly InlineNode[], dest: RunProperties, tag = ''): Result<PastePlan> {
  const inlines: InlineNode[] = [];
  let dropped = 0;
  let index = 0;
  for (const node of source) {
    if (node.kind === 'run') {
      inlines.push({ ...node, id: `${node.id}~p${tag}${index}`, source: 'user_request', properties: dest });
      index += 1;
    } else if (node.kind === 'break') {
      inlines.push({ ...node, id: `${node.id}~p${tag}${index}`, source: 'user_request' });
      index += 1;
    } else {
      dropped += 1; // field / drawing / equation：纯文本粘贴丢弃
    }
  }
  return succeed({ inlines, droppedNonText: dropped });
}

function pasteTransformed(
  model: DocumentModel,
  target: DocumentRange,
  mode: PasteMode,
  build: (dest: RunProperties | null) => Result<PastePlan>,
): Result<PasteOutcome> {
  const paragraph = requireParagraph(model, target.node_id);
  if (!paragraph.ok) return paragraph;
  const total = buildInlineTextMap(paragraph.value.inlines).total;
  if (
    !Number.isInteger(target.start) ||
    !Number.isInteger(target.end) ||
    target.start < 0 ||
    target.end < target.start ||
    target.end > total
  ) {
    return fail(
      'invalid_range',
      `粘贴目标 [${target.start}, ${target.end}) 超出段落 "${target.node_id}" 的码位长度 ${total}。`,
      { extra: { node_id: target.node_id, start: target.start, end: target.end, total } },
    );
  }

  const split = splitInlinesAtRange(paragraph.value.inlines, target.start, target.end);
  if (!split.ok) return split;

  const dest = resolveDestProperties(split.value);
  const built = build(dest);
  if (!built.ok) return built;
  if (built.value.inlines.length === 0) {
    return fail('empty_range', '没有可粘贴的内容（纯文本模式下非文本节点被全部丢弃）。', {
      extra: { dropped: built.value.droppedNonText },
    });
  }

  const insertedText = inlineText(built.value.inlines);
  const insertedLength = codePointLength(insertedText);
  const nextInlines = [...split.value.before, ...built.value.inlines, ...split.value.after];
  const replaced = replaceParagraph(model, target.node_id, { ...paragraph.value, inlines: nextInlines });
  if (!replaced.ok) return replaced;

  return succeed({
    model: replaced.value,
    mode,
    target,
    insertedRange: { node_id: target.node_id, start: target.start, end: target.start + insertedLength },
    replaced: target.start === target.end ? null : { node_id: target.node_id, start: target.start, end: target.end },
    replacedFragment: split.value.selected,
    plainText: insertedText,
    droppedNonText: built.value.droppedNonText,
  });
}

// ---------------------------------------------------------------------------
// 跨段粘贴（W-I12：块级插入）
// ---------------------------------------------------------------------------

/** 跨段粘贴的内容规划：每个剪贴板段（已按模式转好属性）对应一组行内节点。 */
interface BlockPlan {
  readonly sources: readonly (readonly InlineNode[])[];
  readonly droppedNonText: number;
}

/** 在单元格数组里就地展开目标段（命中返回新数组；未命中返回 `null`）。 */
function spliceInCells(
  cells: readonly CellNode[],
  id: string,
  next: readonly BlockNode[],
): readonly CellNode[] | null {
  let changed = false;
  const mapped = cells.map((cell) => {
    const spliced = spliceParagraphInBlocks(cell.blocks, id, next);
    if (spliced === null) return cell;
    changed = true;
    return { ...cell, blocks: spliced };
  });
  return changed ? mapped : null;
}

/** 在行数组里就地展开目标段（命中返回新数组；未命中返回 `null`）。 */
function spliceInRows(
  rows: readonly RowNode[],
  id: string,
  next: readonly BlockNode[],
): readonly RowNode[] | null {
  let changed = false;
  const mapped = rows.map((row) => {
    const cells = spliceInCells(row.cells, id, next);
    if (cells === null) return row;
    changed = true;
    return { ...row, cells };
  });
  return changed ? mapped : null;
}

/**
 * 用块序列 `next` 替换 id 匹配的段落（**含表格单元格内**的段落），并在该处**展开**成多块。
 * 命中返回新块数组；未命中返回 `null`（调用方据此报 `unknown_node`，不静默失败）。
 *
 * 递归口径与 `structure.ts::replaceParagraphInBlocks` 完全一致（`blocks → table → rows → cells`），
 * 区别只在命中处是"展开一组块"而不是"换成一个段"。
 */
function spliceParagraphInBlocks(
  blocks: readonly BlockNode[],
  id: string,
  next: readonly BlockNode[],
): readonly BlockNode[] | null {
  let changed = false;
  const out: BlockNode[] = [];
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      if (block.id === id) {
        changed = true;
        out.push(...next);
      } else {
        out.push(block);
      }
      continue;
    }
    const rows = spliceInRows(block.rows, id, next);
    if (rows === null) {
      out.push(block);
      continue;
    }
    changed = true;
    out.push({ ...block, rows });
  }
  return changed ? out : null;
}

/**
 * 按模式逐段转换剪贴板内容（每段用 `"<段序>-"` 作 id 后缀，避免跨段同名 id 冲突）。
 * `keep-source` 不需要目标格式；`merge` / `plain-text` 由调用方先确保 `dest !== null`。
 */
function buildBlockSources(
  sources: readonly (readonly InlineNode[])[],
  mode: PasteMode,
  dest: RunProperties | null,
): Result<BlockPlan> {
  if (mode !== 'keep-source-formatting' && dest === null) {
    return fail(
      'unsupported',
      mode === 'plain-text'
        ? '目标位置没有任何 run，无法确定纯文本粘贴的字符格式。'
        : '目标位置没有任何 run，无法确定合并格式的基准。',
      {},
    );
  }
  const built: (readonly InlineNode[])[] = [];
  let dropped = 0;
  for (let p = 0; p < sources.length; p += 1) {
    const tag = `${p}-`;
    const source = sources[p]!;
    let plan: Result<PastePlan>;
    if (mode === 'plain-text' && dest !== null) {
      plan = buildPlainText(source, dest, tag);
    } else if (mode === 'merge-formatting' && dest !== null) {
      plan = buildMerged(source, dest, tag);
    } else {
      plan = buildKeepSource(source, tag);
    }
    if (!plan.ok) return plan;
    dropped += plan.value.droppedNonText;
    built.push(plan.value.inlines);
  }
  return succeed({ sources: built, droppedNonText: dropped });
}

/**
 * 块级粘贴：把目标段拆成 头段 / 中段 / 尾段，第一段剪贴板内容并进头段、最后一段并进尾段、
 * 其余各成一新段，整体替换目标段在 `blocks` 里的位置（含表格单元格内段落）。
 *
 * 失败码与单段路径一致：目标段不存在 `unknown_node`、目标越界 `invalid_range`、
 * 无可粘贴内容 `empty_range`、范围边界落在不可切分域内或缺少目标格式基准 `unsupported`。
 * 本路径同样**不递增 revision**（事务收口归 W10），并把 `insertedParagraphs` 逐段交出。
 */
function pasteBlockLevel(
  model: DocumentModel,
  target: DocumentRange,
  mode: PasteMode,
  build: (dest: RunProperties | null) => Result<BlockPlan>,
): Result<PasteOutcome> {
  const paragraph = requireParagraph(model, target.node_id);
  if (!paragraph.ok) return paragraph;
  const total = buildInlineTextMap(paragraph.value.inlines).total;
  if (
    !Number.isInteger(target.start) ||
    !Number.isInteger(target.end) ||
    target.start < 0 ||
    target.end < target.start ||
    target.end > total
  ) {
    return fail(
      'invalid_range',
      `粘贴目标 [${target.start}, ${target.end}) 超出段落 "${target.node_id}" 的码位长度 ${total}。`,
      { extra: { node_id: target.node_id, start: target.start, end: target.end, total } },
    );
  }

  const split = splitInlinesAtRange(paragraph.value.inlines, target.start, target.end);
  if (!split.ok) return split;

  const dest = resolveDestProperties(split.value);
  const built = build(dest);
  if (!built.ok) return built;
  const sources = built.value.sources;
  if (sources.length < 2) {
    // 防御：块级路径至少要有头/尾两段，否则应走单段路径。
    return fail('unsupported', '块级粘贴至少需要两段内容。', { extra: { sources: sources.length } });
  }
  if (sources.reduce((count, item) => count + item.length, 0) === 0) {
    return fail('empty_range', '没有可粘贴的内容（纯文本模式下非文本节点被全部丢弃）。', {
      extra: { dropped: built.value.droppedNonText },
    });
  }

  const base = paragraph.value;
  const last = sources.length - 1;
  // 头段保留目标段 id 与 opaque；中段 / 尾段为新段（id 确定性派生，opaque 置空避免重复写未建模 XML）。
  const head: BlockNode = { ...base, inlines: [...split.value.before, ...sources[0]!] };
  const middlePath: BlockNode[] = [];
  for (let p = 1; p <= last - 1; p += 1) {
    middlePath.push({ ...base, id: `${base.id}~b${p}`, opaque: [], inlines: sources[p]! });
  }
  const tail: BlockNode = {
    ...base,
    id: `${base.id}~b${last}`,
    opaque: [],
    inlines: [...sources[last]!, ...split.value.after],
  };
  const replacement: readonly BlockNode[] = [head, ...middlePath, tail];

  const blocks = spliceParagraphInBlocks(model.blocks, target.node_id, replacement);
  if (blocks === null) {
    return fail('unknown_node', `文档中不存在 id 为 "${target.node_id}" 的段落。`, {
      extra: { node_id: target.node_id },
    });
  }
  const nextModel: DocumentModel = { ...model, blocks };

  const beforeLength = codePointLength(inlineText(split.value.before));
  const insertedParagraphs: DocumentRange[] = [
    {
      node_id: base.id,
      start: beforeLength,
      end: beforeLength + codePointLength(inlineText(sources[0]!)),
    },
  ];
  for (let p = 1; p <= last - 1; p += 1) {
    insertedParagraphs.push({
      node_id: `${base.id}~b${p}`,
      start: 0,
      end: codePointLength(inlineText(sources[p]!)),
    });
  }
  insertedParagraphs.push({
    node_id: `${base.id}~b${last}`,
    start: 0,
    end: codePointLength(inlineText(sources[last]!)),
  });

  return succeed({
    model: nextModel,
    mode,
    target,
    insertedRange: insertedParagraphs[0]!,
    replaced: target.start === target.end ? null : { node_id: target.node_id, start: target.start, end: target.end },
    replacedFragment: split.value.selected,
    plainText: sources.map((item) => inlineText(item)).join('\n'),
    droppedNonText: built.value.droppedNonText,
    insertedParagraphs,
  });
}

/**
 * 把剪贴板内容粘贴到 `target`（WF-088 粘贴主入口）。
 *
 * `target` 是**段落内的码位区间**：零宽 = 光标处插入；非零宽 = 替换该区间。
 * 单段走段内路径；**多段走块级插入**（W-I12，目标段拆成 头/中/尾三段并按段展开）。
 *
 * 关于 `stale_revision`：粘贴入参没有携带 revision 绑定（`ClipboardPayload` 只有
 * `document_id`），故本入口不产生 `stale_revision`——该失败码由 `copySelection` /
 * `cutSelection`（绑定 `Selection.base_revision`）把关，与既有设计一致。
 */
export function pasteClipboard(
  model: DocumentModel,
  payload: ClipboardPayload,
  target: DocumentRange,
  mode: PasteMode,
): Result<PasteOutcome> {
  if (payload.paragraphs.length === 0) {
    return fail('empty_range', '剪贴板为空，没有可粘贴的内容。', {});
  }
  if (payload.paragraphs.length > 1) {
    return pasteBlockLevel(model, target, mode, (dest) => {
      if (mode !== 'keep-source-formatting' && dest === null) {
        return fail(
          'unsupported',
          mode === 'plain-text'
            ? '目标位置没有任何 run，无法确定纯文本粘贴的字符格式。'
            : '目标位置没有任何 run，无法确定合并格式的基准。',
          {},
        );
      }
      return buildBlockSources(payload.paragraphs.map((item) => item.inlines), mode, dest);
    });
  }
  const source = payload.paragraphs[0]!.inlines;
  if (source.length === 0) {
    return fail('empty_range', '剪贴板段为空，没有可粘贴的内容。', {});
  }

  return pasteTransformed(model, target, mode, (dest) => {
    if (mode === 'plain-text') {
      if (dest === null) {
        return fail('unsupported', '目标位置没有任何 run，无法确定纯文本粘贴的字符格式。', {});
      }
      return buildPlainText(source, dest);
    }
    if (mode === 'merge-formatting') {
      if (dest === null) {
        return fail('unsupported', '目标位置没有任何 run，无法确定合并格式的基准。', {});
      }
      return buildMerged(source, dest);
    }
    return buildKeepSource(source);
  });
}

/**
 * 纯文本粘贴（剪贴板里根本没有富内容时的入口，或用户显式选"无格式文本"）。
 *
 * 不含换行 ⇒ 单段路径（原路径逐字节不变）；含换行（多行）⇒ **块级插入**（W-I12）：
 * 每行成为一段，第一行并进头段、最后一行并进尾段、中间各行为新段。空行成为**空段落**
 * （`inlines: []`），保留用户粘贴的段落分隔；全部为空则 `empty_range`（没有可粘贴的内容）。
 * 每行的 run 取目标格式（`dest`）；目标段没有任何 run 时 `unsupported`。
 */
export function pastePlainText(model: DocumentModel, text: string, target: DocumentRange): Result<PasteOutcome> {
  if (text === '') {
    return fail('empty_range', '纯文本为空，没有可粘贴的内容。', {});
  }
  const lines = text.split('\n');
  if (lines.length > 1) {
    return pasteBlockLevel(model, target, 'plain-text', (dest) => {
      if (dest === null) {
        return fail('unsupported', '目标位置没有任何 run，无法确定纯文本粘贴的字符格式。', {});
      }
      const sources: (readonly InlineNode[])[] = lines.map((line, p) => {
        if (line === '') return [];
        const inserted: RunNode = {
          kind: 'run',
          id: `plain~l${p}`,
          source: 'user_request',
          opaque: [],
          properties: dest,
          text: line,
        };
        return [inserted];
      });
      return succeed({ sources, droppedNonText: 0 });
    });
  }
  const line = lines[0]!;
  return pasteTransformed(model, target, 'plain-text', (dest) => {
    if (dest === null) {
      return fail('unsupported', '目标位置没有任何 run，无法确定纯文本粘贴的字符格式。', {});
    }
    const inserted: RunNode = {
      kind: 'run',
      id: 'plain~p0',
      source: 'user_request',
      opaque: [],
      properties: dest,
      text: line,
    };
    return succeed({ inlines: [inserted], droppedNonText: 0 });
  });
}
