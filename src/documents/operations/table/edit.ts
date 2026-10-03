/**
 * 表格编辑的**共用内务**（本包私有；不从 `index.ts` 导出）。
 *
 * 三件事在这里各做一次，别处不再重复：
 *
 * 1. **定位与拒绝入口**：`requireTable` / `checkGridClean`——把"表找不到""网格有病"
 *    统一成 `DocumentModelError`（`unknown_node` / `table_shape_invalid`），
 *    由 `runTableEdit` 一次性转成失败分支；
 * 2. **新建单元格的物化**：新单元格/新段落要有**稳定 id**（R101）。id 走 `model/ids.ts`
 *    的分配器，路径由"它落在哪一行、第几列"唯一决定——同模型 + 同操作 ⇒ 同 id；
 * 3. **占位内容**：拆分/插入产生的空单元格必须有一个空段落（OOXML 里 `w:tc` 不能没有块）。
 *    这个占位段落的 `source` 是 `system`——**不是** `user_request`（R109：不能把系统补的东西
 *    冒充成用户说的）。
 */

import { DocumentModelError } from '../../model/errors.js';
import { createNodeIdAllocator, nodePathSegment, parseNodeId, withSegment } from '../../model/ids.js';
import type { NodeIdAllocator } from '../../model/ids.js';
import {
  blockKindOf,
  materializeBlockNode,
  textParagraphNode,
  type DraftBlockNode,
} from '../../model/nodes.js';
import { replaceAt } from '../../model/immutable.js';
import { withBlocks } from '../../model/immutable.js';
import {
  collectNodeIds,
  findNodeById,
  replaceCellInModel,
  replaceTableInModel,
  rewriteBlocks,
} from '../../model/walk.js';
import type { NodePath } from '../../model/ids.js';
import type {
  BlockNode,
  CellNode,
  CellProperties,
  DocumentModel,
  NodeId,
  RowNode,
  SourceKind,
  TableNode,
} from '../../model/types.js';
import { buildGridMap, describeGridProblem, type GridMap } from './grid.js';

/** 取表格；不是表格或找不到即抛。 */
export function requireTable(model: DocumentModel, tableId: NodeId): TableNode {
  const node = findNodeById(model, tableId);
  if (node === null) {
    throw new DocumentModelError('unknown_node', `找不到表格 ${JSON.stringify(tableId)}`);
  }
  if (node.kind !== 'table') {
    throw new DocumentModelError(
      'unknown_node',
      `${JSON.stringify(tableId)} 不是表格（kind=${node.kind}）`,
    );
  }
  return node;
}

/** 新建节点用的 id 分配器（以全文档既有 id 为已占集合，R101）。 */
export function allocatorFor(model: DocumentModel): NodeIdAllocator {
  return createNodeIdAllocator(collectNodeIds(model));
}

/** 既有节点的路径：从它的规范 id 反解；反解失败时退回一个合成路径（唯一性仍由分配器保证）。 */
export function pathOfExistingNode(id: NodeId, fallbackKind: string): NodePath {
  const parsed = parseNodeId(id);
  return parsed?.path ?? [nodePathSegment(fallbackKind, 0)];
}

/** 某个单元格自己的路径（父行路径 + `cell:index`）。 */
export function cellPath(rowId: NodeId, index: number): NodePath {
  return withSegment(pathOfExistingNode(rowId, 'row'), 'cell', index);
}

/**
 * 建网格并**拒绝有病网格**。
 *
 * 判据明令"网格不出现空洞或重叠"；参差不齐的行列数会让列操作的语义不确定
 * （"第 3 列"在某行可能根本不存在）——因此结构类编辑一律要求干净网格，
 * 脏网格上**先拒绝**（R136：不许"前半段成功、后半段悄悄失败"）。
 */
export function checkGridClean(map: GridMap, what: string): void {
  const first = map.problems[0];
  if (first !== undefined) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `${what}要求表格网格干净，但检出问题：${describeGridProblem(first)}`,
    );
  }
}

/** 建网格 + 拒绝有病（常用组合）。 */
export function requireCleanGrid(table: TableNode, what: string): GridMap {
  const map = buildGridMap(table);
  checkGridClean(map, what);
  return map;
}

/**
 * 空单元格的块：一个空段落（`w:tc` 不能没有块）。
 *
 * 用 `textParagraphNode({text:''})`——产出的就是一个"空 run 的段落"，与 Word 新建单元格一致。
 * `source` 默认 `system`（占位内容不是用户说的话，R109）。
 */
export function emptyCellBlocks(source: SourceKind = 'system'): readonly DraftBlockNode[] {
  return [textParagraphNode({ text: '', source })];
}

/**
 * 物化一个**混装**单元格：块序列里既有"已经物化过的既有块"（要原样搬运、**id 不变**），
 * 也有"新造的占位块"（草稿，需要取新号）。
 *
 * 为什么要这个 helper：合并/拆分要把既有单元格的块搬进新单元格。若一律走
 * `materializeCellNode`，既有块会被**重新取号**——那会破坏 R101（同一节点在往返中 id 不变），
 * 也会让批注/书签锚点漂移。因此这里对"已带 id 的块"直接原样放入，只对草稿取号。
 */
export function materializeCellWithBlocks(input: {
  readonly path: NodePath;
  readonly allocator: NodeIdAllocator;
  readonly source: SourceKind;
  readonly properties: CellProperties;
  readonly grid_span: number;
  readonly vertical_merge: CellNode['vertical_merge'];
  readonly blocks: readonly (BlockNode | DraftBlockNode)[];
  readonly opaque?: readonly unknown[];
}): CellNode {
  const cellId = input.allocator.allocate(input.path);
  const blocks: BlockNode[] = input.blocks.map((block, index) => {
    if (isMaterializedBlock(block)) {
      return block;
    }
    return materializeBlockNode(block, withSegment(input.path, blockKindOf(block), index), input.allocator);
  });
  return {
    id: cellId,
    kind: 'cell',
    source: input.source,
    opaque: [...(input.opaque ?? [])],
    properties: input.properties,
    blocks,
    grid_span: input.grid_span,
    vertical_merge: input.vertical_merge,
  };
}

function isMaterializedBlock(block: BlockNode | DraftBlockNode): block is BlockNode {
  return typeof (block as { readonly id?: unknown }).id === 'string';
}

/** 换掉一张表（表 id 不变，其余块对象引用不变）。 */
export function withTable(model: DocumentModel, tableId: NodeId, next: TableNode): DocumentModel {
  return replaceTableInModel(model, tableId, next);
}

/** 找到某一行及其所在的表（用于按**行 id**定位，R101）。 */
export function findRow(
  model: DocumentModel,
  rowId: NodeId,
): { readonly table: TableNode; readonly index: number } | null {
  for (const block of model.blocks) {
    if (block.kind !== 'table') {
      continue;
    }
    const index = block.rows.findIndex((row) => row.id === rowId);
    if (index !== -1) {
      return { table: block, index };
    }
  }
  return null;
}

/** 换掉某一行（按行 id 定位；找不到即抛 `unknown_node`）。 */
export function withRow(model: DocumentModel, rowId: NodeId, next: RowNode): DocumentModel {
  const outcome = rewriteBlocks(model.blocks, {
    table: (table) => {
      const index = table.rows.findIndex((row) => row.id === rowId);
      if (index === -1) {
        return null;
      }
      return { ...table, rows: replaceAt(table.rows, index, next) };
    },
  });
  if (outcome.hits === 0) {
    throw new DocumentModelError('unknown_node', `找不到表格行 ${JSON.stringify(rowId)}`);
  }
  return withBlocks(model, outcome.blocks);
}

/** 换掉某个单元格（按单元格 id 定位；找不到即抛 `unknown_node`）。 */
export function withCell(model: DocumentModel, cellId: NodeId, next: CellNode): DocumentModel {
  return replaceCellInModel(model, cellId, next);
}

/** 某行里第一个 `<w:tc>` 级别可复用的入口（供测试与诊断）。 */
export function firstCellOf(table: TableNode): CellNode | null {
  const row = table.rows[0];
  if (row === undefined) {
    return null;
  }
  return row.cells[0] ?? null;
}
