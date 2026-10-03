/**
 * **片段级编辑原语**（本包私有）：段落里插入/改写/移除一段未建模片段所在的 run。
 *
 * ## 为什么单独一层
 *
 * 图片（`image.ts`）与文本框/形状（`shape.ts`）在这件事上一模一样：
 *
 * - 插一个只带片段的 run（**新 run 取新 id，既有 run 与它们的 id 原样不动**）；
 * - 就地把 run 里某段 `raw_at_char` 的 XML 换掉（**偏移不动**，图形位置不漂）；
 * - 拿掉片段；run 变空则连 run 一起删。
 *
 * 这些动作涉及"保持 R101 的 id 稳定性"，是最容易写错的地方（用 `replace_block` 会把段落里
 * 所有行内节点重新取号）。放在一处、只写一遍，两个调用方共用。
 */

import { DocumentModelError } from '../../model/errors.js';
import { insertAt, removeAt, withBlocks } from '../../model/immutable.js';
import {
  createNodeIdAllocator,
  nodePathSegment,
  parseNodeId,
  withSegment,
  type NodePath,
} from '../../model/ids.js';
import { defaultRunProperties } from '../../model/nodes.js';
import { collectNodeIds, findBlockLocation, rewriteBlocks } from '../../model/walk.js';
import type { DocumentModel, NodeId, ParagraphNode, RunNode, SourceKind } from '../../model/types.js';

/** 既有节点的路径：从规范 id 反解（与 `model/ids.ts` 的分配规则同构）。 */
export function pathOfExistingNode(id: NodeId, fallbackKind: string): NodePath {
  const parsed = parseNodeId(id);
  return parsed?.path ?? [nodePathSegment(fallbackKind, 0)];
}

/** 取段落（不是段落或找不到即抛）。 */
export function requireParagraph(model: DocumentModel, paragraphId: NodeId): ParagraphNode {
  const location = findBlockLocation(model, paragraphId);
  if (location === null || location.block.kind !== 'paragraph') {
    throw new DocumentModelError('unknown_node', `找不到段落 ${JSON.stringify(paragraphId)}`);
  }
  return location.block;
}

/** 换掉某一段落（其余块与它们的对象引用不变）。 */
export function withParagraph(model: DocumentModel, paragraphId: NodeId, next: ParagraphNode): DocumentModel {
  const outcome = rewriteBlocks(model.blocks, {
    block: (block) => (block.id === paragraphId && block.kind === 'paragraph' ? next : null),
  });
  if (outcome.hits === 0) {
    throw new DocumentModelError('unknown_node', `找不到段落 ${JSON.stringify(paragraphId)}`);
  }
  return withBlocks(model, outcome.blocks);
}

/** 取段落里某个 run（找不到即抛）。 */
export function requireRun(paragraph: ParagraphNode, runId: NodeId): RunNode {
  const inline = paragraph.inlines.find((entry) => entry.id === runId);
  if (inline === undefined) {
    throw new DocumentModelError('unknown_node', `段落 ${paragraph.id} 里找不到 run ${runId}`);
  }
  if (inline.kind !== 'run') {
    throw new DocumentModelError('unknown_node', `节点 ${runId} 不是 run（kind=${inline.kind}）`);
  }
  return inline;
}

/**
 * 造一段只带"未建模片段"的 run 并插进段落。
 *
 * id 由"段落路径 + run:index"经分配器取号；**既有行内节点一律原样保留**（R101）。
 */
export function insertRunWithFragment(
  model: DocumentModel,
  paragraphId: NodeId,
  index: number,
  xml: string,
  source: SourceKind = 'user_request',
): { readonly model: DocumentModel; readonly run_id: NodeId; readonly paragraph: ParagraphNode } {
  const paragraph = requireParagraph(model, paragraphId);
  if (!Number.isInteger(index) || index < 0 || index > paragraph.inlines.length) {
    throw new DocumentModelError(
      'invalid_index',
      `行内插入位置越界：${String(index)}（该段共 ${String(paragraph.inlines.length)} 个行内节点）`,
    );
  }
  const runPath = withSegment(pathOfExistingNode(paragraphId, 'paragraph'), 'run', index);
  const allocator = createNodeIdAllocator(collectNodeIds(model));
  const runId = allocator.allocate(runPath);
  const run: RunNode = {
    id: runId,
    kind: 'run',
    source,
    opaque: [{ kind: 'raw_at_char', xml, offset: 0 }],
    properties: defaultRunProperties(),
    text: '',
  };
  return {
    model: withParagraph(model, paragraphId, { ...paragraph, inlines: insertAt(paragraph.inlines, index, run) }),
    run_id: runId,
    paragraph,
  };
}

/**
 * 就地替换 run 的某段 `raw_at_char` XML（**位置/偏移保持不动**）。
 *
 * `offset` 是"这段片段排在 run 文本的第几个码位之前"（D02 的 `RawAtChar` 约定）：
 * 改 XML 不能顺手把偏移改掉，否则图形会从原来的位置漂到别处。
 */
export function withRunFragment(run: RunNode, opaqueIndex: number, xml: string): RunNode {
  const item = run.opaque[opaqueIndex];
  if (typeof item !== 'object' || item === null || (item as { kind?: unknown }).kind !== 'raw_at_char') {
    throw new DocumentModelError(
      'unknown_node',
      `run ${run.id} 的下标 ${String(opaqueIndex)} 不是未建模片段`,
    );
  }
  const offset = (item as { offset?: unknown }).offset;
  const opaque = run.opaque.map((entry, index) =>
    index === opaqueIndex
      ? { kind: 'raw_at_char', xml, offset: typeof offset === 'number' ? offset : 0 }
      : entry,
  );
  return { ...run, opaque };
}

/** 拿掉 run 里的某段片段；run 若变空（无文本、无其它片段）则一并删掉。 */
export function removeFragmentFromRun(
  paragraph: ParagraphNode,
  runId: NodeId,
  opaqueIndex: number,
): { readonly paragraph: ParagraphNode; readonly run_removed: boolean } {
  const run = requireRun(paragraph, runId);
  const remaining = run.opaque.filter((_item, index) => index !== opaqueIndex);
  const runBecomesEmpty = run.text.length === 0 && remaining.length === 0;
  const index = paragraph.inlines.findIndex((inline) => inline.id === runId);
  const inlines = runBecomesEmpty
    ? removeAt(paragraph.inlines, index)
    : insertAt(removeAt(paragraph.inlines, index), index, { ...run, opaque: remaining });
  return { paragraph: { ...paragraph, inlines }, run_removed: runBecomesEmpty };
}
