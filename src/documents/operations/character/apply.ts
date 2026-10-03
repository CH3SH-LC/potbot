/**
 * 把字符格式操作施加到范围上（WF-001–016 的执行层；R132–R136）。
 *
 * ## 原子性（R136）
 *
 * 复合调用（一个选区跨多段、格式刷覆盖多 run）**全成功或全不修改**：
 * 先在内存里把每一段的新结果算出来，任一失败就整批放弃，**返回原模型**。
 * 因此这里没有任何"边算边写"的路径。
 *
 * ## revision 不动
 *
 * 本模块**只改块内容，不递增 `revision`**。递增 revision 属于"一次用户事务"的收口
 * （R138/R141），由会话/执行器统一做；若这里顺手 +1，会让同一事务内的第二个操作全部失配。
 * 调用方拿到新模型后自行推进版本并重新签发选区。
 */

import type { DocumentModel, InlineNode, ParagraphNode, RunNode, RunProperties } from '../../model/types.js';
import { splitInlinesAtRange } from '../../selection/inline-map.js';
import { deepEqual } from '../../selection/equals.js';
import { collectParagraphs, paragraphFullRange, requireParagraph, replaceParagraph } from '../../selection/structure.js';
import { requireCurrentSelection } from '../../selection/selection.js';
import { fail, succeed, type CodePointRange, type DocumentRange, type Result, type Selection } from '../../selection/types.js';
import { applyCharacterOperation, type OperationContext } from './properties.js';
import type { CharacterFormatOperation } from './types.js';

/** 一次格式施加的结果。`changed` 为 `false` 表示操作合法但**没有任何属性改变**（幂等重试会走到这）。 */
export interface FormatApplication {
  readonly inlines: readonly InlineNode[];
  readonly changed: boolean;
  /** 被范围覆盖、且真正参与改写的 run 条数。 */
  readonly selectedRunCount: number;
  /** `toggle` 时统一采用的目标态（便于上层回执写"已加粗/已取消加粗"）。 */
  readonly toggleTarget: 'on' | 'off' | null;
}

function isRun(node: InlineNode): node is RunNode {
  return node.kind === 'run';
}

/**
 * 对**单个段落的行内序列**施加字符格式操作。
 *
 * `context.selectedProperties` 缺省时，toggle 的判定只覆盖本段落的被选 run；
 * 跨段选区应在上层先汇总全部被选 run 再传入（见 `applyCharacterFormatToRanges`），
 * 这样整个选区只取一个目标态，不会出现"前半段变粗、后半段变细"。
 */
export function applyCharacterFormatToInlines(
  inlines: readonly InlineNode[],
  range: CodePointRange,
  operation: CharacterFormatOperation,
  context: OperationContext = {},
): Result<FormatApplication> {
  const split = splitInlinesAtRange(inlines, range.start, range.end);
  if (!split.ok) return split;
  const parts = split.value;

  const selectedRuns = parts.selected.filter(isRun);
  if (selectedRuns.length === 0) {
    return succeed({ inlines, changed: false, selectedRunCount: 0, toggleTarget: null });
  }

  const selectionProperties = context.selectedProperties ?? selectedRuns.map((node) => node.properties);
  const effectiveContext: OperationContext = { ...context, selectedProperties: selectionProperties };

  // R121：**整个选区一个目标态**——全部已开 ⇒ 关；否则 ⇒ 开。在循环外算一次，
  // 保证同一批被选 run 不会出现"有的变粗、有的变细"。
  let toggleTarget: 'on' | 'off' | null = null;
  if (operation.kind === 'toggle') {
    toggleTarget = selectionProperties.every((item) => item[operation.property].state === 'on') ? 'off' : 'on';
  }

  const rewritten: InlineNode[] = [];
  let changed = false;

  for (const node of parts.selected) {
    if (!isRun(node)) {
      rewritten.push(node); // 软换行/域不承载字符格式，原样带过
      continue;
    }
    const updated = applyCharacterOperation(node.properties, operation, effectiveContext);
    if (!updated.ok) return updated; // 原子性：一个 run 失败 ⇒ 整批不落地
    const nextProps: RunProperties = updated.value;
    if (!deepEqual(nextProps, node.properties)) changed = true;
    rewritten.push({ ...node, properties: nextProps });
  }

  return succeed({
    inlines: [...parts.before, ...rewritten, ...parts.after],
    changed,
    selectedRunCount: selectedRuns.length,
    toggleTarget,
  });
}

/** 对单个段落施加（范围必须是段内码位区间）。 */
export function applyCharacterFormatToParagraph(
  paragraph: ParagraphNode,
  range: CodePointRange,
  operation: CharacterFormatOperation,
  context: OperationContext = {},
): Result<ParagraphNode> {
  const applied = applyCharacterFormatToInlines(paragraph.inlines, range, operation, context);
  if (!applied.ok) return applied;
  if (!applied.value.changed) return succeed(paragraph);
  return succeed({ ...paragraph, inlines: applied.value.inlines });
}

/** 收集若干范围内**全部被选 run 的属性**（toggle 的跨段统一判定用）。 */
function collectSelectedProperties(
  model: DocumentModel,
  ranges: readonly DocumentRange[],
): Result<readonly RunProperties[]> {
  const out: RunProperties[] = [];
  for (const range of ranges) {
    const paragraph = requireParagraph(model, range.node_id);
    if (!paragraph.ok) return paragraph;
    const split = splitInlinesAtRange(paragraph.value.inlines, range.start, range.end);
    if (!split.ok) return split;
    for (const node of split.value.selected) {
      if (isRun(node)) out.push(node.properties);
    }
  }
  return succeed(out);
}

/**
 * 对一组范围施加同一操作，**整批原子**。
 *
 * 返回值里的模型是**新对象**（未受影响的分支沿用原引用，见 `structure.ts`）。
 */
export function applyCharacterFormatToRanges(
  model: DocumentModel,
  ranges: readonly DocumentRange[],
  operation: CharacterFormatOperation,
): Result<DocumentModel> {
  if (ranges.length === 0) {
    return fail('empty_range', '没有可施加格式的范围。', { expression: '' });
  }

  // 先定 toggle 目标：跨整个范围集合统计，一次判定，全批一致（R121）。
  const context: OperationContext = {};
  if (operation.kind === 'toggle') {
    const collected = collectSelectedProperties(model, ranges);
    if (!collected.ok) return collected;
    if (collected.value.length === 0) {
      return fail('precondition', '选区内没有可改格式的文本 run。', { extra: { ranges: ranges.length } });
    }
    (context as { selectedProperties?: readonly RunProperties[] }).selectedProperties = collected.value;
  }

  // 先在内存里把每一段算完，再统一写回——任一失败则整批放弃（R136）。
  //
  // **同一段可以出现在多个范围里**（Ctrl 多选产生的不连续选区）：这些范围必须在**演进中的
  // `inlines`** 上依次施加。若每个范围都从**原始** `inlines` 重算、再整段替换，后一个范围会把
  // 前一个范围刚做的改动整段盖回（"甲乙"先被加粗、随后被未加粗的原文覆盖）——这正是本包
  // 早期版本静默丢编辑的成因。切分不改文本，故码位偏移在累加过程中始终有效。
  const grouped = new Map<string, CodePointRange[]>();
  const paragraphOrder: string[] = [];
  for (const range of ranges) {
    const existing = grouped.get(range.node_id);
    if (existing === undefined) {
      grouped.set(range.node_id, [{ start: range.start, end: range.end }]);
      paragraphOrder.push(range.node_id);
    } else {
      existing.push({ start: range.start, end: range.end });
    }
  }

  const planned: { id: string; next: ParagraphNode }[] = [];
  for (const id of paragraphOrder) {
    const paragraph = requireParagraph(model, id);
    if (!paragraph.ok) return paragraph;
    let inlines: readonly InlineNode[] = paragraph.value.inlines;
    let changed = false;
    for (const range of grouped.get(id)!) {
      const applied = applyCharacterFormatToInlines(inlines, range, operation, context);
      if (!applied.ok) return applied; // 原子性：任一段失败 ⇒ 整批不落地
      if (!applied.value.changed) continue;
      changed = true;
      inlines = applied.value.inlines;
    }
    if (!changed) continue;
    planned.push({ id, next: { ...paragraph.value, inlines } });
  }

  let next = model;
  for (const item of planned) {
    const replaced = replaceParagraph(next, item.id, item.next);
    if (!replaced.ok) return replaced;
    next = replaced.value;
  }
  return succeed(next);
}

/** 对单段范围施加（模型级）。 */
export function applyCharacterFormatToDocumentRange(
  model: DocumentModel,
  range: DocumentRange,
  operation: CharacterFormatOperation,
): Result<DocumentModel> {
  return applyCharacterFormatToRanges(model, [range], operation);
}

/**
 * 对选区施加（WF-001–016 的常规入口）。
 * 先过 R114：选区 `base_revision` 不是当前版本就拒绝，**不把旧偏移套到新文本上**。
 */
export function applyCharacterFormatToSelection(
  model: DocumentModel,
  selection: Selection,
  operation: CharacterFormatOperation,
): Result<DocumentModel> {
  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  return applyCharacterFormatToRanges(model, selection.ranges, operation);
}

/** 便捷：对"全文"施加（R121 的 toggle 在全文上同样一次判定）。 */
export function applyCharacterFormatToWholeDocument(
  model: DocumentModel,
  operation: CharacterFormatOperation,
): Result<DocumentModel> {
  const ranges = collectParagraphs(model.blocks).map(paragraphFullRange);
  if (ranges.length === 0) {
    return fail('not_found', '文档没有任何段落。', { hitCount: 0, needsClarification: false });
  }
  return applyCharacterFormatToRanges(model, ranges, operation);
}
