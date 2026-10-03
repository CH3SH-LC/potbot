/**
 * 选区生命周期（合同 R103、R114、R143）与选区取文（WF-088 的复制半边）。
 *
 * ## 为什么选区必须带 baseRevision
 *
 * 偏移是**对某个版本的具体文本**才有意义的数。文本一变（插入/删除一段），旧偏移指到的就是
 * 别的字。R114 要求这时选区**失效并明确反馈**，**不得**把旧偏移硬套到新文本上——
 * 那正是"明明选了 A 却改了 B"的成因。这里把这条规矩做在类型与返回值上：
 * 任何消费选区的入口都先过 `requireCurrentSelection`。
 */

import type { DocumentId, DocumentModel, Revision } from '../model/types.js';
import { buildInlineTextMap } from './inline-map.js';
import { requireParagraph } from './structure.js';
import { fail, succeed, type DocumentRange, type Result, type Selection } from './types.js';

export function createSelection(
  documentId: DocumentId,
  baseRevision: Revision,
  ranges: readonly DocumentRange[],
): Selection {
  return { document_id: documentId, base_revision: baseRevision, ranges };
}

/** 选区是否仍然对得上当前文档版本（R114）。 */
export function isSelectionCurrent(selection: Selection, model: DocumentModel): boolean {
  return selection.document_id === model.document_id && selection.base_revision === model.revision;
}

/**
 * 校验选区可用于提交：documentId 必须一致，`base_revision` 必须是当前 revision。
 * 失败码分别是 `mismatched_document` 与 `stale_revision`（R143 要求带上当前 revision）。
 */
export function requireCurrentSelection(selection: Selection, model: DocumentModel): Result<Selection> {
  if (selection.document_id !== model.document_id) {
    return fail(
      'mismatched_document',
      `选区属于文档 "${selection.document_id}"，当前文档是 "${model.document_id}"。`,
      { extra: { selectionDocument: selection.document_id, modelDocument: model.document_id } },
    );
  }
  if (selection.base_revision !== model.revision) {
    return fail(
      'stale_revision',
      `选区基于 revision ${selection.base_revision}，当前已是 ${model.revision}；选区已失效，请重新选择。`,
      { currentRevision: model.revision, requestedRevision: selection.base_revision },
    );
  }
  return succeed(selection);
}

/** 逐个校验范围：段落存在、且起止落在段落码位长度内。 */
export function validateRanges(model: DocumentModel, ranges: readonly DocumentRange[]): Result<readonly DocumentRange[]> {
  for (const range of ranges) {
    const paragraph = requireParagraph(model, range.node_id);
    if (!paragraph.ok) return paragraph;
    const total = buildInlineTextMap(paragraph.value.inlines).total;
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end > total
    ) {
      return fail(
        'invalid_range',
        `范围 [${range.start}, ${range.end}) 超出段落 "${range.node_id}" 的码位长度 ${total}。`,
        { extra: { node_id: range.node_id, start: range.start, end: range.end, total } },
      );
    }
  }
  return succeed(ranges);
}

/**
 * 选区纯文本（WF-088 的"复制"）。
 * 多个范围之间用 `'\n'` 连接——与 Word 跨段复制一致；**不**做任何空白折叠（R104）。
 */
export function extractSelectionText(model: DocumentModel, selection: Selection): Result<string> {
  const current = requireCurrentSelection(selection, model);
  if (!current.ok) return current;
  const ranges = validateRanges(model, selection.ranges);
  if (!ranges.ok) return ranges;

  const parts: string[] = [];
  for (const range of selection.ranges) {
    const paragraph = requireParagraph(model, range.node_id);
    if (!paragraph.ok) return paragraph;
    const points = Array.from(buildInlineTextMap(paragraph.value.inlines).text);
    parts.push(points.slice(range.start, range.end).join(''));
  }
  return succeed(parts.join('\n'));
}
