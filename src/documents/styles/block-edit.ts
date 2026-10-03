/**
 * 段落 / 块的移动、复制、删除（WF-043，合同 R101/R132/R136/R151）。
 *
 * ## 归属说明（为什么这个文件在 `styles/` 下）
 *
 * design-05-P3 的点名范围是"**样式、列表与组织**"，WF-043 属于其中的"组织"。
 * 本轮写权表只放开 `src/documents/numbering/**` 与 `src/documents/styles/**` 两个包
 * （`src/documents/model/**` 等既有包只读），因此"组织"操作落在这里。
 * 它**不改** `model/**` 的结构操作——移动/删除直接复用 `model/structure.ts` 的
 * `applyStructureEdit`（那才是 id 纪律与原子性的唯一实现），本文件只补它没有的**复制**，
 * 并把"邻接格式保持"做成可断言的返回值。
 *
 * ## WF-043 要的三件事，各自怎么成立
 *
 * 1. **稳定定位**：三个操作都以**节点 id** 为入口（R101），不用"第几段"——
 *    位置会随前一次编辑漂移，id 不会。
 * 2. **内部引用保持**：复制出来的段落保留 `style_ref` 与 `numbering`（指向**同一份**
 *    命名样式与**同一个** `num_id`），图形保留 `relationship_id`（指向同一份媒体）。
 *    也就是说"复制一个列表项"得到的是**同一个列表的下一个编号项**，不是一段孤立文本。
 * 3. **邻接格式保持**：移动/删除只重排序列，未受影响的块**对象引用不变**
 *    （`structure.ts` 的 `moveWithin`/`removeAt` 保证）。`neighborSnapshot` 让这条
 *    成为可直接断言的返回值，而不是"你应该相信我"。
 *
 * ## 复制为什么必须重新取号（R101）
 *
 * 复制若沿用原 id，文档里就出现**两个同 id 节点**——批注锚点、选区、操作日志的定位
 * 全部失去意义（"改第 3 段"可能改到副本上）。所以副本内部所有节点都经分配器取新号；
 * 而**跨节点引用**（样式、列表、关系）原样保留，这才是"内部引用保持"的含义。
 */

import type { DocumentModel, NodeId, BlockNode, CellNode, InlineNode, RowNode, TableNode } from '../model/types.js';
import { DocumentModelError, type DocumentModelProblemCode } from '../model/errors.js';
import {
  createNodeIdAllocator,
  nodePathSegment,
  parseNodeId,
  withSegment,
  type NodePath,
} from '../model/ids.js';
import { bodyPath } from '../model/nodes.js';
import { insertAt, withBlocks } from '../model/immutable.js';
import { assertBlockShape } from '../model/validation.js';
import {
  collectNodeIds,
  findBlockLocation,
  replaceCellBlocksInModel,
  type BlockContainer,
} from '../model/walk.js';
import { applyStructureEdit, type StructureEditOutcome } from '../model/structure.js';

/** 块操作的结果形状；失败分支**没有 `model`**（R136）。 */
export type BlockEditOutcome =
  | { readonly ok: true; readonly model: DocumentModel; readonly block_id: NodeId }
  | { readonly ok: false; readonly code: DocumentModelProblemCode; readonly detail: string };

function fromStructureOutcome(outcome: StructureEditOutcome, blockId: NodeId): BlockEditOutcome {
  return outcome.ok
    ? { ok: true, model: outcome.model, block_id: blockId }
    : { ok: false, code: outcome.code, detail: outcome.detail };
}

function unknownBlock(blockId: NodeId): BlockEditOutcome {
  return { ok: false, code: 'unknown_node', detail: `找不到块 ${JSON.stringify(blockId)}` };
}

/** 单元格内的块序列；找不到单元格返回 `null`。 */
function cellBlocksOf(model: DocumentModel, cellId: NodeId): readonly BlockNode[] | null {
  const visit = (blocks: readonly BlockNode[]): readonly BlockNode[] | null => {
    for (const block of blocks) {
      if (block.kind !== 'table') {
        continue;
      }
      for (const row of (block as TableNode).rows) {
        for (const cell of row.cells) {
          if (cell.id === cellId) {
            return cell.blocks;
          }
          const found = visit(cell.blocks);
          if (found !== null) {
            return found;
          }
        }
      }
    }
    return null;
  };
  return visit(model.blocks);
}

/** 容器路径：正文用 `body:0`，单元格从其规范 id 反解（与 `structure.ts` 同一口径）。 */
function containerPathOf(container: BlockContainer): NodePath {
  if (container.kind === 'body') {
    return bodyPath();
  }
  return parseNodeId(container.cell_id)?.path ?? [nodePathSegment('cell', 0)];
}

// ---------------------------------------------------------------------------
// 移动 / 删除（复用 model/structure.ts 的唯一实现）
// ---------------------------------------------------------------------------

/** 把某个块移到正文/单元格序列的 `to_index`（**移动完成后**的最终下标）。 */
export function moveBlock(model: DocumentModel, blockId: NodeId, toIndex: number): BlockEditOutcome {
  return fromStructureOutcome(
    applyStructureEdit(model, { kind: 'move_block', block_id: blockId, to_index: toIndex }),
    blockId,
  );
}

/** 移动到某个块的前面（更贴近"把这段拖到那段上方"的说法）。 */
export function moveBlockBefore(model: DocumentModel, blockId: NodeId, beforeId: NodeId): BlockEditOutcome {
  const target = findBlockLocation(model, beforeId);
  const source = findBlockLocation(model, blockId);
  if (target === null) {
    return unknownBlock(beforeId);
  }
  if (source === null) {
    return unknownBlock(blockId);
  }
  if (source.container.kind !== target.container.kind) {
    return {
      ok: false,
      code: 'unsupported',
      detail: '暂不支持跨容器（正文 ↔ 单元格）移动块',
    };
  }
  const sameCell =
    source.container.kind === 'cell' &&
    target.container.kind === 'cell' &&
    source.container.cell_id === target.container.cell_id;
  if (source.container.kind === 'body' || sameCell) {
    const destination = target.index > source.index ? target.index - 1 : target.index;
    return moveBlock(model, blockId, destination);
  }
  return { ok: false, code: 'unsupported', detail: '暂不支持跨单元格移动块' };
}

/**
 * 删除一个块。
 *
 * 因为只动序列，**被删块的前后邻居对象引用完全不变**——`neighborSnapshot`（删除前调用）
 * 抓到的引用，删除后依然能在新模型里按 id 原样找回来。这就是"邻接格式保持"。
 */
export function deleteBlock(model: DocumentModel, blockId: NodeId): BlockEditOutcome {
  return fromStructureOutcome(applyStructureEdit(model, { kind: 'remove_block', block_id: blockId }), blockId);
}

// ---------------------------------------------------------------------------
// 复制（本文件提供；structure.ts 没有这一条）
// ---------------------------------------------------------------------------

function cloneInline(inline: InlineNode, path: NodePath, allocate: (path: NodePath) => NodeId): InlineNode {
  // 新 id；`relationship_id` / `instruction` / `text` 等**内容与引用原样保留**。
  return { ...inline, id: allocate(path) };
}

function cloneBlock(block: BlockNode, path: NodePath, allocate: (path: NodePath) => NodeId): BlockNode {
  if (block.kind === 'paragraph') {
    return {
      ...block,
      id: allocate(path),
      // 属性深拷贝：副本与原件过后各自独立（与 WF-034 格式刷同一取向）。
      properties: structuredClone(block.properties),
      inlines: block.inlines.map((inline, index) =>
        cloneInline(inline, withSegment(path, inline.kind, index), allocate),
      ),
      // `style_ref` / `numbering` 原样保留 —— "内部引用保持"的核心。
      opaque: [...block.opaque],
    };
  }
  const table = block as TableNode;
  const rows: RowNode[] = table.rows.map((row, rowIndex) => {
    const rowPath = withSegment(path, 'row', rowIndex);
    const cells: CellNode[] = row.cells.map((cell, cellIndex) => {
      const cellPath = withSegment(rowPath, 'cell', cellIndex);
      return {
        ...cell,
        id: allocate(cellPath),
        properties: structuredClone(cell.properties),
        blocks: cell.blocks.map((inner, blockIndex) =>
          cloneBlock(inner, withSegment(cellPath, inner.kind, blockIndex), allocate),
        ),
        opaque: [...cell.opaque],
      };
    });
    return { ...row, id: allocate(rowPath), height: structuredClone(row.height), cells, opaque: [...row.opaque] };
  });
  return {
    ...table,
    id: allocate(path),
    properties: structuredClone(table.properties),
    rows,
    grid: table.grid.map((width) => ({ ...width })),
    opaque: [...table.opaque],
  };
}

/**
 * 复制一个块到 `index`（复制完成后副本所在的下标）。
 *
 * - 副本获得**全新的节点 id**（R101，见文件头注释）；
 * - 副本保留样式引用、列表引用与关系引用（"内部引用保持"）；
 * - 原件**一个字节都不动**。
 */
export function copyBlock(model: DocumentModel, blockId: NodeId, index: number): BlockEditOutcome {
  const location = findBlockLocation(model, blockId);
  if (location === null) {
    return unknownBlock(blockId);
  }
  const allocator = createNodeIdAllocator(collectNodeIds(model));
  const allocate = (target: NodePath): NodeId => allocator.allocate(target);
  const containerPath = containerPathOf(location.container);
  const cloned = cloneBlock(location.block, withSegment(containerPath, location.block.kind, index), allocate);

  try {
    assertBlockShape(cloned, '复制出的块不合法');
    if (location.container.kind === 'body') {
      return { ok: true, model: withBlocks(model, insertAt(model.blocks, index, cloned)), block_id: blockId };
    }
    const blocks = cellBlocksOf(model, location.container.cell_id);
    if (blocks === null) {
      return { ok: false, code: 'unknown_node', detail: `找不到单元格 ${JSON.stringify(location.container.cell_id)}` };
    }
    return {
      ok: true,
      model: replaceCellBlocksInModel(model, location.container.cell_id, insertAt(blocks, index, cloned)),
      block_id: blockId,
    };
  } catch (error) {
    if (error instanceof DocumentModelError) {
      return { ok: false, code: error.code, detail: error.detail };
    }
    throw error;
  }
}

/** 复制结果多一个副本 id，便于调用方接着操作副本。 */
export type DuplicateOutcome =
  | { readonly ok: true; readonly model: DocumentModel; readonly block_id: NodeId; readonly copy_id: NodeId }
  | { readonly ok: false; readonly code: DocumentModelProblemCode; readonly detail: string };

/** 复制一个块并**紧跟其后**插入（"复制这一段"的常用形态）。 */
export function duplicateBlock(model: DocumentModel, blockId: NodeId): DuplicateOutcome {
  const location = findBlockLocation(model, blockId);
  if (location === null) {
    return { ok: false, code: 'unknown_node', detail: `找不到块 ${JSON.stringify(blockId)}` };
  }
  const index = location.index + 1;
  const outcome = copyBlock(model, blockId, index);
  if (!outcome.ok) {
    return outcome;
  }
  const blocks =
    location.container.kind === 'body'
      ? outcome.model.blocks
      : cellBlocksOf(outcome.model, location.container.cell_id);
  const copy = blocks?.[index];
  if (copy === undefined) {
    return { ok: false, code: 'unknown_node', detail: '复制后找不到副本（内部一致性错误）' };
  }
  return { ok: true, model: outcome.model, block_id: blockId, copy_id: copy.id };
}

// ---------------------------------------------------------------------------
// 证据辅助
// ---------------------------------------------------------------------------

/**
 * 抓某个块的**前后邻居**（移动/删除前的快照）。
 *
 * 用于证据：操作后再按 id 找这两个块，**对象引用应当完全相同**——
 * 这就是"邻接格式未被触碰"的机械判据（比"读回格式字符串再比"更直接，
 * 也不会因为实现里"顺手重建了一遍邻居"而假装通过）。
 */
export interface NeighborSnapshot {
  readonly container: BlockContainer;
  readonly index: number;
  readonly previous: BlockNode | null;
  readonly next: BlockNode | null;
}

export function neighborSnapshot(model: DocumentModel, blockId: NodeId): NeighborSnapshot | null {
  const location = findBlockLocation(model, blockId);
  if (location === null) {
    return null;
  }
  const blocks =
    location.container.kind === 'body' ? model.blocks : cellBlocksOf(model, location.container.cell_id);
  if (blocks === null) {
    return null;
  }
  return {
    container: location.container,
    index: location.index,
    previous: location.index > 0 ? (blocks[location.index - 1] ?? null) : null,
    next: location.index + 1 < blocks.length ? (blocks[location.index + 1] ?? null) : null,
  };
}

/** 按 id 取块（正文或单元格内）；没有返回 `null`。供断言邻居引用是否原样。 */
export function blockById(model: DocumentModel, blockId: NodeId): BlockNode | null {
  return findBlockLocation(model, blockId)?.block ?? null;
}
