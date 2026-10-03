/**
 * 结构操作：增 / 删 / 移动段落与表格行列（R101/R132/R136）。
 *
 * ## 原子性是怎么保证的（R136）
 *
 * 失败变体 `{ ok: false }` **没有 `model` 字段**——"改了一半的模型"在类型上无法表达，
 * 调用方也就不可能拿到半成品。实现上每一批编辑都在**局部变量**里累积；
 * 任一步抛 `DocumentModelError`，整个批次就地放弃，调用方手上的原模型**一个字节都没动**
 * （本文件只做纯函数更新，没有任何原地写入）。
 *
 * 复合指令（T01 那种一句多操作）走 `applyStructureBatch`：要么整批成功，
 * 要么 `edit_index` 指向**第一条**失败的编辑、其余全不生效——绝不出现
 * "前半段成功、后半段悄悄失败"。
 *
 * ## id 纪律（R101）
 *
 * - **新增**节点：路径由结构决定、经分配器取号，同模型 + 同操作 ⇒ 同 id；
 * - **移动**（段落/行/列）：原对象连同其 id **原样搬运**，绝无重新编号；
 * - **替换**块：保留被替换节点的顶层 id（身份不变，批注锚点仍成立），
 *   新节点内部元素取新号。
 */

import { DocumentModelError, type DocumentModelProblemCode } from './errors.js';
import {
  assertElementIndex,
  assertInsertIndex,
  insertAt,
  moveWithin,
  removeAt,
  replaceAt,
  withBlocks,
} from './immutable.js';
import { createNodeIdAllocator, nodePathSegment, parseNodeId, withSegment, type NodePath } from './ids.js';
import {
  blockKindOf,
  bodyPath,
  materializeBlockNode,
  materializeCellNode,
  materializeRowNode,
  type DraftBlockNode,
  type DraftCellNode,
  type DraftRowNode,
} from './nodes.js';
import {
  rowCellSpans,
  rowMatchesColumnCount,
  spanAtColumn,
  straddlingSpan,
  tableColumnCount,
} from './table-grid.js';
import { assertBlockShape, assertTableShape } from './validation.js';
import {
  collectNodeIds,
  findBlockLocation,
  findNodeById,
  replaceCellBlocksInModel,
  replaceTableInModel,
  type BlockContainer,
} from './walk.js';
import type { BlockNode, CellNode, DocumentModel, Length, NodeId, RowNode, TableNode } from './types.js';

// ---------------------------------------------------------------------------
// 编辑描述
// ---------------------------------------------------------------------------

/**
 * 一条结构编辑。
 *
 * - 位置参数一律用**下标**（`index` / `from_index` / `to_index`）——结构操作天生就是按位置说的；
 * - 目标参数一律用**节点 id**（`block_id` / `table_id`）——身份不随位置漂移（R101）；
 * - `to_index` 是**移动完成后**的最终下标（与 `moveWithin` 同约定）。
 */
export type StructureEdit =
  | {
      readonly kind: 'insert_block';
      readonly container: BlockContainer;
      readonly index: number;
      readonly block: DraftBlockNode;
    }
  | { readonly kind: 'remove_block'; readonly block_id: NodeId }
  | { readonly kind: 'move_block'; readonly block_id: NodeId; readonly to_index: number }
  | { readonly kind: 'replace_block'; readonly block_id: NodeId; readonly block: DraftBlockNode }
  | {
      readonly kind: 'insert_row';
      readonly table_id: NodeId;
      readonly index: number;
      readonly row: DraftRowNode;
    }
  | { readonly kind: 'remove_row'; readonly table_id: NodeId; readonly index: number }
  | {
      readonly kind: 'move_row';
      readonly table_id: NodeId;
      readonly from_index: number;
      readonly to_index: number;
    }
  | {
      readonly kind: 'insert_column';
      readonly table_id: NodeId;
      readonly index: number;
      readonly cells: readonly DraftCellNode[];
      /** 新列宽；表格有网格定义时**必须**给出（不允许悄悄借邻居的宽度）。 */
      readonly width: Length | null;
    }
  | { readonly kind: 'remove_column'; readonly table_id: NodeId; readonly index: number }
  | {
      readonly kind: 'move_column';
      readonly table_id: NodeId;
      readonly from_index: number;
      readonly to_index: number;
    };

/**
 * 结构编辑的结果。**失败分支里没有 `model`**——这是 R136 的实现形态：
 * 部分应用的模型不可表示，调用方只能继续用自己手上的那一份。
 */
export type StructureEditOutcome =
  | { readonly ok: true; readonly model: DocumentModel }
  | {
      readonly ok: false;
      readonly code: DocumentModelProblemCode;
      readonly detail: string;
      /** 批次里第一条失败的编辑下标（单条编辑时恒为 0）。 */
      readonly edit_index: number;
    };

// ---------------------------------------------------------------------------
// 容器解析
// ---------------------------------------------------------------------------

interface ResolvedContainer {
  readonly blocks: readonly BlockNode[];
  readonly path: NodePath;
  readonly withBlocks: (blocks: readonly BlockNode[]) => DocumentModel;
}

function requireNode(model: DocumentModel, id: NodeId, kind: string): NonNullable<ReturnType<typeof findNodeById>> {
  const node = findNodeById(model, id);
  if (node === null) {
    throw new DocumentModelError('unknown_node', `找不到${kind} ${JSON.stringify(id)}`);
  }
  return node;
}

function requireCell(model: DocumentModel, cellId: NodeId): CellNode {
  const node = requireNode(model, cellId, '单元格');
  if (node.kind !== 'cell') {
    throw new DocumentModelError('unknown_node', `${JSON.stringify(cellId)} 不是单元格（kind=${node.kind}）`);
  }
  return node;
}

function requireTable(model: DocumentModel, tableId: NodeId): TableNode {
  const node = requireNode(model, tableId, '表格');
  if (node.kind !== 'table') {
    throw new DocumentModelError('unknown_node', `${JSON.stringify(tableId)} 不是表格（kind=${node.kind}）`);
  }
  return node;
}

/**
 * 既有节点的路径：直接从其规范 id 反解。
 *
 * 之所以可行：所有 id 都由 `ids.ts` 的分配器产出，路径段就是身份的出处。
 * 反解失败（非规范 id）时退回一个合成路径——**新节点的唯一性仍由分配器保证**
 * （它以全文档既有 id 为已占集合），受影响的只是新 id 的"可读性"。
 */
function pathOfExistingNode(id: NodeId, fallbackKind: string): NodePath {
  const parsed = parseNodeId(id);
  return parsed?.path ?? [nodePathSegment(fallbackKind, 0)];
}

function resolveContainer(model: DocumentModel, container: BlockContainer): ResolvedContainer {
  if (container.kind === 'body') {
    return {
      blocks: model.blocks,
      path: bodyPath(),
      withBlocks: (blocks) => withBlocks(model, blocks),
    };
  }
  const cell = requireCell(model, container.cell_id);
  return {
    blocks: cell.blocks,
    path: pathOfExistingNode(cell.id, 'cell'),
    withBlocks: (blocks) => replaceCellBlocksInModel(model, cell.id, blocks),
  };
}

function allocatorFor(model: DocumentModel) {
  return createNodeIdAllocator(collectNodeIds(model));
}

// ---------------------------------------------------------------------------
// 块操作
// ---------------------------------------------------------------------------

function insertBlock(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'insert_block' }>,
): DocumentModel {
  const container = resolveContainer(model, edit.container);
  assertInsertIndex(edit.index, container.blocks.length, '插入块的位置');
  const node = materializeBlockNode(
    edit.block,
    withSegment(container.path, blockKindOf(edit.block), edit.index),
    allocatorFor(model),
  );
  assertBlockShape(node, '新块不合法');
  return container.withBlocks(insertAt(container.blocks, edit.index, node));
}

function removeBlock(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'remove_block' }>,
): DocumentModel {
  const location = findBlockLocation(model, edit.block_id);
  if (location === null) {
    throw new DocumentModelError('unknown_node', `找不到块 ${JSON.stringify(edit.block_id)}`);
  }
  const container = resolveContainer(model, location.container);
  return container.withBlocks(removeAt(container.blocks, location.index));
}

function moveBlock(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'move_block' }>,
): DocumentModel {
  const location = findBlockLocation(model, edit.block_id);
  if (location === null) {
    throw new DocumentModelError('unknown_node', `找不到块 ${JSON.stringify(edit.block_id)}`);
  }
  const container = resolveContainer(model, location.container);
  assertElementIndex(edit.to_index, container.blocks.length, '移动块的终点');
  // 原对象（连同 id）原样搬运，不重新物化（R101）。
  return container.withBlocks(moveWithin(container.blocks, location.index, edit.to_index));
}

function replaceBlock(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'replace_block' }>,
): DocumentModel {
  const location = findBlockLocation(model, edit.block_id);
  if (location === null) {
    throw new DocumentModelError('unknown_node', `找不到块 ${JSON.stringify(edit.block_id)}`);
  }
  const container = resolveContainer(model, location.container);
  const materialized = materializeBlockNode(
    edit.block,
    withSegment(container.path, blockKindOf(edit.block), location.index),
    allocatorFor(model),
  );
  // 顶层 id 沿用被替换节点：身份不变，批注锚点不至于因"改了一段内容"而漂移（R101/R114）。
  const node: BlockNode = { ...materialized, id: location.block.id };
  assertBlockShape(node, '替换块不合法');
  return container.withBlocks(replaceAt(container.blocks, location.index, node));
}

// ---------------------------------------------------------------------------
// 行操作
// ---------------------------------------------------------------------------

function insertRow(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'insert_row' }>,
): DocumentModel {
  const table = requireTable(model, edit.table_id);
  assertInsertIndex(edit.index, table.rows.length, '插入行的位置');
  const columnCount = tableColumnCount(table);
  const row = materializeRowNode(
    edit.row,
    withSegment(pathOfExistingNode(table.id, 'table'), 'row', edit.index),
    allocatorFor(model),
  );
  if (columnCount > 0 && !rowMatchesColumnCount(row, columnCount)) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `新行占 ${String(rowCellSpans(row).reduce((total, span) => total + span.span, 0))} 列，` +
        `与表格的 ${String(columnCount)} 列不一致`,
    );
  }
  const next: TableNode = { ...table, rows: insertAt(table.rows, edit.index, row) };
  assertTableShape(next, '插入行后的表格不合法');
  return replaceTableInModel(model, table.id, next);
}

function removeRow(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'remove_row' }>,
): DocumentModel {
  const table = requireTable(model, edit.table_id);
  assertElementIndex(edit.index, table.rows.length, '删除行的位置');
  if (table.rows.length <= 1) {
    throw new DocumentModelError(
      'table_shape_invalid',
      '表格至少要保留一行；要删掉整张表请用 remove_block',
    );
  }
  const next: TableNode = { ...table, rows: removeAt(table.rows, edit.index) };
  assertTableShape(next, '删除行后的表格不合法');
  return replaceTableInModel(model, table.id, next);
}

function moveRow(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'move_row' }>,
): DocumentModel {
  const table = requireTable(model, edit.table_id);
  assertElementIndex(edit.from_index, table.rows.length, '移动行的起点');
  assertElementIndex(edit.to_index, table.rows.length, '移动行的终点');
  const next: TableNode = { ...table, rows: moveWithin(table.rows, edit.from_index, edit.to_index) };
  assertTableShape(next, '移动行后的表格不合法');
  return replaceTableInModel(model, table.id, next);
}

// ---------------------------------------------------------------------------
// 列操作
// ---------------------------------------------------------------------------

function assertUniformColumns(table: TableNode, columnCount: number): void {
  if (columnCount === 0) {
    throw new DocumentModelError('table_shape_invalid', '表格没有可操作的列（列数为 0）');
  }
  if (!table.rows.every((row) => rowMatchesColumnCount(row, columnCount))) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `表格的行列数不一致（表格声明 ${String(columnCount)} 列）——列操作拒绝在参差不齐的表上执行（WF-058）`,
    );
  }
}

/** 在干净（无跨列覆盖）的前提下，`column` 在行内应插到第几个单元格。 */
function cellInsertIndex(row: RowNode, column: number): number {
  return rowCellSpans(row).filter((span) => span.start < column).length;
}

function insertColumnWithCells(
  table: TableNode,
  index: number,
  cells: readonly CellNode[],
  width: Length | null,
): TableNode {
  const columnCount = tableColumnCount(table);
  assertUniformColumns(table, columnCount);
  assertInsertIndex(index, columnCount, '插入列的位置');
  if (cells.length !== table.rows.length) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `插入列需要 ${String(table.rows.length)} 个单元格（每行一个），收到 ${String(cells.length)} 个`,
    );
  }
  if (table.grid.length > 0 && width === null) {
    throw new DocumentModelError(
      'table_shape_invalid',
      '表格有网格定义（列宽），插入列必须显式给出新列宽——不允许悄悄借邻居的宽度',
    );
  }
  for (const row of table.rows) {
    const straddle = straddlingSpan(row, index);
    if (straddle !== null) {
      throw new DocumentModelError(
        'column_span_conflict',
        `行 ${row.id} 的第 ${String(straddle.start)}–${String(
          straddle.start + straddle.span - 1,
        )} 列被一个跨列单元格占着，无法在第 ${String(index)} 列插入（WF-058）`,
      );
    }
  }
  const rows = table.rows.map((row, rowIndex) => {
    const cell = cells[rowIndex] as CellNode;
    return { ...row, cells: insertAt(row.cells, cellInsertIndex(row, index), cell) };
  });
  const grid =
    width !== null && table.grid.length > 0 ? insertAt(table.grid, index, width) : table.grid;
  return { ...table, rows, grid };
}

interface RemovedColumn {
  readonly table: TableNode;
  readonly cells: readonly CellNode[];
  readonly width: Length | null;
}

function removeColumnFromTable(table: TableNode, index: number): RemovedColumn {
  const columnCount = tableColumnCount(table);
  assertUniformColumns(table, columnCount);
  assertElementIndex(index, columnCount, '删除列的位置');
  const cells: CellNode[] = [];
  for (const row of table.rows) {
    const span = spanAtColumn(row, index);
    if (span === null) {
      throw new DocumentModelError(
        'table_shape_invalid',
        `行 ${row.id} 没有第 ${String(index)} 列（行列数不一致）`,
      );
    }
    if (span.span > 1) {
      throw new DocumentModelError(
        'column_span_conflict',
        `行 ${row.id} 的第 ${String(index)} 列属于一个跨 ${String(span.span)} 列的合并单元格——` +
          '删列会切断合并，先拆分再删（WF-058）',
      );
    }
    if (span.cell.vertical_merge !== null) {
      throw new DocumentModelError(
        'column_span_conflict',
        `行 ${row.id} 的第 ${String(index)} 列参与纵向合并（${span.cell.vertical_merge}）——` +
          '删列会切断合并链，先取消合并（WF-058）',
      );
    }
    cells.push(span.cell);
  }
  const rows = table.rows.map((row) => {
    const span = spanAtColumn(row, index);
    return { ...row, cells: removeAt(row.cells, span === null ? 0 : span.cell_index) };
  });
  const width = table.grid.length > index ? (table.grid[index] as Length) : null;
  const grid = table.grid.length > 0 ? removeAt(table.grid, index) : table.grid;
  return { table: { ...table, rows, grid }, cells, width };
}

function insertColumn(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'insert_column' }>,
): DocumentModel {
  const table = requireTable(model, edit.table_id);
  const columnCount = tableColumnCount(table);
  assertUniformColumns(table, columnCount);
  assertInsertIndex(edit.index, columnCount, '插入列的位置');
  if (edit.cells.length !== table.rows.length) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `插入列需要 ${String(table.rows.length)} 个单元格（每行一个），收到 ${String(edit.cells.length)} 个`,
    );
  }
  const allocator = allocatorFor(model);
  // 新单元格的列宽由插入位置唯一决定（网格项），不在这里另设 width。
  const cells = table.rows.map((row, rowIndex) => {
    const draft = edit.cells[rowIndex] as DraftCellNode;
    const rowPath = pathOfExistingNode(row.id, 'row');
    return materializeCellNode(draft, withSegment(rowPath, 'cell', cellInsertIndex(row, edit.index)), allocator);
  });
  const next = insertColumnWithCells(table, edit.index, cells, edit.width);
  assertTableShape(next, '插入列后的表格不合法');
  return replaceTableInModel(model, table.id, next);
}

function removeColumn(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'remove_column' }>,
): DocumentModel {
  const table = requireTable(model, edit.table_id);
  const removed = removeColumnFromTable(table, edit.index);
  assertTableShape(removed.table, '删除列后的表格不合法');
  return replaceTableInModel(model, table.id, removed.table);
}

function moveColumn(
  model: DocumentModel,
  edit: Extract<StructureEdit, { kind: 'move_column' }>,
): DocumentModel {
  const table = requireTable(model, edit.table_id);
  const columnCount = tableColumnCount(table);
  assertUniformColumns(table, columnCount);
  assertElementIndex(edit.from_index, columnCount, '移动列的起点');
  assertElementIndex(edit.to_index, columnCount, '移动列的终点');
  if (edit.from_index === edit.to_index) {
    return model;
  }
  // 先删后插，两步都在局部变量上做；任何一步失败整条编辑失败（R136）。
  const removed = removeColumnFromTable(table, edit.from_index);
  const next = insertColumnWithCells(removed.table, edit.to_index, removed.cells, removed.width);
  assertTableShape(next, '移动列后的表格不合法');
  return replaceTableInModel(model, table.id, next);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function applyOne(model: DocumentModel, edit: StructureEdit): DocumentModel {
  switch (edit.kind) {
    case 'insert_block':
      return insertBlock(model, edit);
    case 'remove_block':
      return removeBlock(model, edit);
    case 'move_block':
      return moveBlock(model, edit);
    case 'replace_block':
      return replaceBlock(model, edit);
    case 'insert_row':
      return insertRow(model, edit);
    case 'remove_row':
      return removeRow(model, edit);
    case 'move_row':
      return moveRow(model, edit);
    case 'insert_column':
      return insertColumn(model, edit);
    case 'remove_column':
      return removeColumn(model, edit);
    case 'move_column':
      return moveColumn(model, edit);
    default: {
      const unreachable: never = edit;
      throw new DocumentModelError(
        'unsupported',
        `未知结构编辑：${JSON.stringify((unreachable as { kind?: unknown }).kind)}`,
      );
    }
  }
}

function runEdits(model: DocumentModel, edits: readonly StructureEdit[]): StructureEditOutcome {
  let current = model;
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index] as StructureEdit;
    try {
      current = applyOne(current, edit);
    } catch (error) {
      if (error instanceof DocumentModelError) {
        return { ok: false, code: error.code, detail: error.detail, edit_index: index };
      }
      throw error;
    }
  }
  return { ok: true, model: current };
}

/** 应用单条结构编辑。失败返回 `{ ok: false }`，**输入模型不变**。 */
export function applyStructureEdit(model: DocumentModel, edit: StructureEdit): StructureEditOutcome {
  return runEdits(model, [edit]);
}

/**
 * 应用一批结构编辑：**全成功或全不修改**（R136）。
 *
 * 失败时 `edit_index` 是第一条失败的编辑，且**回到起点**重来也不会得到不同结果
 * （每条编辑都是纯函数，确定性）。
 */
export function applyStructureBatch(
  model: DocumentModel,
  edits: readonly StructureEdit[],
): StructureEditOutcome {
  return runEdits(model, edits);
}
