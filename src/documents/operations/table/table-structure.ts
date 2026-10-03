/**
 * 表格的增删与行列增删（WF-056 / WF-057）。
 *
 * ## WF-056 插入 / 删除表格：为什么"前后段落不损坏"要专门处理
 *
 * 模型层插一块表格不会改到别的块对象（每个块是独立不可变对象），所以"段落被改坏"本不会发生。
 * Word 里真正会出事的是**相邻表格**：`w:body` 里两张**直接相邻**的 `<w:tbl>` 会被 Word
 * **合并成一张表**——用户看到的就不是"我在中间插了一张"，而是"表格结构变了"。
 * 因此本模块在插入/删除后**主动隔开相邻表格**（插一个空段落），并把这件事如实报出来
 * （结果里的 `separator_inserted`），不悄悄做、也不假装没发生。
 *
 * 另一个边界：表格落在正文末尾时，Word 需要其后再有一个段落，才能正常在其下方编辑内容，
 * 故 `ensure_trailing_paragraph`（默认开）在表成为最后一块时补一个空段落。
 *
 * ## WF-057 增删行列：合并关系怎么保住
 *
 * 难点全在**跨行列的合并**上：
 *
 * - **插入行**：新行必须"接住"穿过插入点的纵向合并链，否则会出现
 *   `vMerge="continue"` 上方没有 `restart` 的坏链（`model/validation.ts` 判为 error）。
 *   规则：插入位置**下方**的格子若是 `continue`（链要穿过这里），新行的对应列区间取
 *   `continue`（上方本来就在链上，链延长）或 `restart`（上方没有链起点，链从这里起）。
 *   新行的**结构**（两侧 `gridSpan`）与单元格属性从模板行复制：有上方行用上方行，
 *   插在第 0 行则用下方行——这与 Word"在下方插入行 = 复制当前行"的行为一致。
 * - **删除行**：删掉链的一节可能剩下"没有 restart 的 continue"。
 *   `normalizeVerticalMergeChains` 自顶向下重扫每个列区间：在链上而上方没有起点者，
 *   就地升级为 `restart`（合并变短，但链仍自洽），修复次数如实报出。
 * - **插入列**：列插入对所有行同位置生效，纵向链的列区间整体平移，链不会断；
 *   但插到跨列合并单元格**内部**会把它切成两半 ⇒ 复用 `model/structure.ts` 的现成拒绝。
 * - **删除列**：会切断跨列合并或打断纵向链 ⇒ 同样是 `structure.ts` 的现成拒绝
 *   （`column_span_conflict`，文案要求"先拆分 / 先取消合并"）。
 *
 * 新节点的 id 由"表路径 + row:index + cell:index"经分配器取号（R101）；既有单元格与其内容
 * **原样搬运、id 不变**。
 */

import { DocumentModelError } from '../../model/errors.js';
import { withSegment } from '../../model/ids.js';
import {
  cellNode,
  paragraphNode,
  rowNode,
  type DraftCellNode,
  type DraftParagraphNode,
  type DraftTableNode,
} from '../../model/nodes.js';
import { applyStructureBatch, type StructureEdit } from '../../model/structure.js';
import { tableColumnCount } from '../../model/table-grid.js';
import type {
  CellNode,
  DocumentModel,
  Length,
  NodeId,
  RowNode,
  SourceKind,
  TableNode,
} from '../../model/types.js';
import { assertTableShape } from '../../model/validation.js';
import { buildGridMap, cellAt, type CellSlot, type GridMap } from './grid.js';
import {
  allocatorFor,
  emptyCellBlocks,
  materializeCellWithBlocks,
  pathOfExistingNode,
  requireCleanGrid,
  requireTable,
  withTable,
} from './edit.js';
import { runTableEdit, type TableOutcome } from './types.js';

// ---------------------------------------------------------------------------
// WF-056 插入 / 删除表格
// ---------------------------------------------------------------------------

/** 插入表格请求（表格以**草稿**给出，id 由分配器决定）。 */
export interface InsertTableRequest {
  /** 插到正文第几块之前（等于块数即追加到末尾）。 */
  readonly index: number;
  readonly table: DraftTableNode;
  /** 与既有表格相邻时是否插一个空段落隔开（默认 `true`，理由见文件头）。 */
  readonly separate_adjacent_tables?: boolean;
  /** 表格成为最后一块时是否补一个尾随空段落（默认 `true`）。 */
  readonly ensure_trailing_paragraph?: boolean;
}

/** 插入表格的结果。 */
export interface InsertTableSuccess {
  readonly model: DocumentModel;
  readonly table_id: NodeId;
  /** 新表格在正文里的块下标（考虑了可能插入的隔离段落）。 */
  readonly block_index: number;
  readonly separator_inserted: boolean;
  readonly trailing_paragraph_added: boolean;
}

/** 一个空段落草稿（隔离段落 / 尾随段落用；`source` 是 `system`，不是用户说的话）。 */
function separatorParagraph(): DraftParagraphNode {
  return paragraphNode({ source: 'system' });
}

/**
 * 插入表格（WF-056）。
 *
 * 结果里的 `separator_inserted` / `trailing_paragraph_added` 如实反映**额外做了什么**——
 * 这两个布尔是"表前后段落不损坏"的可检查证据，而不是注释里的承诺。
 */
export function insertTable(model: DocumentModel, request: InsertTableRequest): TableOutcome<InsertTableSuccess> {
  return runTableEdit(() => {
    const separate = request.separate_adjacent_tables ?? true;
    const trailing = request.ensure_trailing_paragraph ?? true;
    const index = request.index;
    if (!Number.isInteger(index) || index < 0 || index > model.blocks.length) {
      throw new DocumentModelError(
        'invalid_index',
        `插入表格的位置越界：${String(index)}（正文共 ${String(model.blocks.length)} 块）`,
      );
    }

    const edits: StructureEdit[] = [];
    const before = model.blocks[index - 1];
    const at = model.blocks[index];
    const separatorBefore = separate && before?.kind === 'table';
    const separatorAfter = separate && at?.kind === 'table';
    let cursor = index;

    if (separatorBefore) {
      edits.push({ kind: 'insert_block', container: { kind: 'body' }, index: cursor, block: separatorParagraph() });
      cursor += 1;
    }
    edits.push({ kind: 'insert_block', container: { kind: 'body' }, index: cursor, block: request.table });
    const tableIndex = cursor;
    cursor += 1;
    if (separatorAfter) {
      edits.push({ kind: 'insert_block', container: { kind: 'body' }, index: cursor, block: separatorParagraph() });
      cursor += 1;
    }

    // 表格是否成为最后一块？是则补一个尾随段落（Word 需要它才能继续在表下方编辑）。
    const totalBlocks = model.blocks.length + edits.length;
    const trailingAdded = trailing && tableIndex === totalBlocks - 1;
    if (trailingAdded) {
      edits.push({
        kind: 'insert_block',
        container: { kind: 'body' },
        index: cursor,
        block: separatorParagraph(),
      });
    }

    const outcome = applyStructureBatch(model, edits);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '插入表格失败');
    }
    const inserted = outcome.model.blocks[tableIndex];
    if (inserted === undefined || inserted.kind !== 'table') {
      throw new DocumentModelError('invalid_block_sequence', '插入表格后定位不到新表格（实现缺陷）');
    }
    return {
      model: outcome.model,
      table_id: inserted.id,
      block_index: tableIndex,
      separator_inserted: separatorBefore || separatorAfter,
      trailing_paragraph_added: trailingAdded,
    };
  });
}

/** 删除表格请求。 */
export interface DeleteTableRequest {
  readonly table_id: NodeId;
  /** 删除后与另一端表格变成相邻时，是否插空段落隔开（默认 `true`）。 */
  readonly separate_adjacent_tables?: boolean;
}

/** 删除表格的结果。 */
export interface DeleteTableSuccess {
  readonly model: DocumentModel;
  readonly separator_inserted: boolean;
  /** 被删表格删除前的块下标。 */
  readonly removed_index: number;
}

/** 删除整张表格（WF-056）。段落一律不动，只在会产生相邻表格时插一个隔离段落。 */
export function deleteTable(model: DocumentModel, request: DeleteTableRequest): TableOutcome<DeleteTableSuccess> {
  return runTableEdit(() => {
    const index = model.blocks.findIndex((block) => block.id === request.table_id);
    if (index === -1) {
      throw new DocumentModelError(
        'unknown_node',
        `找不到表格 ${JSON.stringify(request.table_id)}（它可能不在正文里）`,
      );
    }
    const separate = request.separate_adjacent_tables ?? true;
    const wouldBeAdjacent =
      separate && model.blocks[index - 1]?.kind === 'table' && model.blocks[index + 1]?.kind === 'table';

    const edits: StructureEdit[] = [];
    if (wouldBeAdjacent) {
      // 先插隔离段落（插在被删表之后），再删表 —— 两步在同一批次里，全成或全不成（R136）。
      edits.push({
        kind: 'insert_block',
        container: { kind: 'body' },
        index: index + 1,
        block: separatorParagraph(),
      });
    }
    edits.push({ kind: 'remove_block', block_id: request.table_id });

    const outcome = applyStructureBatch(model, edits);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '删除表格失败');
    }
    return { model: outcome.model, separator_inserted: wouldBeAdjacent, removed_index: index };
  });
}

// ---------------------------------------------------------------------------
// WF-057 插入 / 删除行
// ---------------------------------------------------------------------------

/** 插入行请求。`cells` 省略（或 `null`）时按"接住合并链"的规则自动生成。 */
export interface InsertRowRequest {
  readonly table_id: NodeId;
  readonly index: number;
  readonly cells?: readonly DraftCellNode[] | null;
  /** 自动生成新行时内容的来源标记（默认 `system`——占位不是用户说的话，R109）。 */
  readonly source?: SourceKind;
}

/** 插入行的结果。 */
export interface InsertRowSuccess {
  readonly model: DocumentModel;
  readonly row_id: NodeId;
  /** 自动生成时：新行里被接续（或起头）的纵向合并格数。 */
  readonly continued_merges: number;
}

/** 模板行的列区间（左上角 + 跨度 + 原单元格）。 */
interface TemplateRange {
  readonly start: number;
  readonly end: number;
  readonly cell: CellNode;
}

function templateRanges(row: RowNode): readonly TemplateRange[] {
  const ranges: TemplateRange[] = [];
  let start = 0;
  row.cells.forEach((cell) => {
    const span = Number.isInteger(cell.grid_span) && cell.grid_span >= 1 ? cell.grid_span : 1;
    ranges.push({ start, end: start + span, cell });
    start += span;
  });
  return ranges;
}

/**
 * 自动为新行生成格子：结构照抄模板行，纵向合并"接住链"。
 *
 * 规则（与文件头一致）：
 * 1. 模板行 = 插入位置**上方的行**；插在第 0 行时用**下方**的行；
 * 2. 模板行每个格子的列区间复制成新行的一个格子（`grid_span` 相同、属性深拷贝）；
 * 3. 若插入位置下方同列区间的格子是 `continue`（链要穿过这里）：
 *    - 上方同列区间在链上 ⇒ 新格子 `continue`（链延长）；
 *    - 上方不在链上 ⇒ 新格子 `restart`（链必须有起点）；
 * 4. 其余情况新格子 `vertical_merge = null`。
 */
export function deriveRowCells(
  table: TableNode,
  map: GridMap,
  index: number,
  source: SourceKind,
): { readonly cells: readonly DraftCellNode[]; readonly continued: number } {
  const templateRow = index > 0 ? table.rows[index - 1] : table.rows[index];
  if (templateRow === undefined) {
    throw new DocumentModelError('table_shape_invalid', '表格没有可作模板的行');
  }
  let continued = 0;
  const cells = templateRanges(templateRow).map((range) => {
    const below: CellSlot | null = index < table.rows.length ? cellAt(map, index, range.start) : null;
    const above: CellSlot | null = index > 0 ? cellAt(map, index - 1, range.start) : null;
    const sameRange = (slot: CellSlot | null): boolean =>
      slot !== null && slot.start === range.start && slot.end === range.end;
    const chainThrough = sameRange(below) && (below as CellSlot).cell.vertical_merge === 'continue';

    let verticalMerge: CellNode['vertical_merge'] = null;
    if (chainThrough) {
      verticalMerge =
        sameRange(above) && (above as CellSlot).cell.vertical_merge !== null ? 'continue' : 'restart';
      continued += 1;
    }
    return cellNode({
      source,
      blocks: emptyCellBlocks(source),
      properties: structuredClone(range.cell.properties),
      grid_span: range.end - range.start,
      vertical_merge: verticalMerge,
    });
  });
  return { cells, continued };
}

/** 给定草稿单元格里覆盖 `column` 的那一个（越界 ⇒ `null`）。 */
function draftCellAt(cells: readonly DraftCellNode[], column: number): DraftCellNode | null {
  let cursor = 0;
  for (const cell of cells) {
    const span = cell.grid_span ?? 1;
    if (column >= cursor && column < cursor + span) {
      return cell;
    }
    cursor += span;
  }
  return null;
}

/**
 * 插入行（WF-057）。
 *
 * - 不传 `cells`：自动生成（结构照抄模板行、纵向链自动接续）；
 * - 传了 `cells`：列数匹配由 `model/structure.ts` 校验；此外**本函数**校验
 *   "插入点若切开纵向链，提供的格子必须接住链"——否则会写出没有起点的 `continue`。
 */
export function insertRow(model: DocumentModel, request: InsertRowRequest): TableOutcome<InsertRowSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const map = requireCleanGrid(table, '插入行');
    const index = request.index;
    if (!Number.isInteger(index) || index < 0 || index > table.rows.length) {
      throw new DocumentModelError(
        'invalid_index',
        `插入行的位置越界：${String(index)}（表格共 ${String(table.rows.length)} 行）`,
      );
    }
    const source: SourceKind = request.source ?? 'system';
    const columnCount = tableColumnCount(table);

    if (request.cells !== null && request.cells !== undefined) {
      const width = request.cells.reduce((total, cell) => total + (cell.grid_span ?? 1), 0);
      if (width !== columnCount) {
        throw new DocumentModelError(
          'table_shape_invalid',
          `新行占 ${String(width)} 列，与表格的 ${String(columnCount)} 列不一致`,
        );
      }
      for (let column = 0; column < columnCount; column += 1) {
        const below = index < table.rows.length ? cellAt(map, index, column) : null;
        if (below === null || below.cell.vertical_merge !== 'continue') {
          continue;
        }
        const provided = draftCellAt(request.cells, column);
        if (provided === null || (provided.vertical_merge ?? null) === null) {
          throw new DocumentModelError(
            'column_span_conflict',
            `第 ${String(column)} 列的纵向合并链穿过插入点（下方是 vMerge=continue），` +
              '但给定的新行在这一列没接住合并（vertical_merge 为空）——先取消合并，或把该格设为 continue',
          );
        }
      }
      const outcome = applyStructureBatch(model, [
        { kind: 'insert_row', table_id: request.table_id, index, row: rowNode({ source, cells: request.cells }) },
      ]);
      if (!outcome.ok) {
        throw new DocumentModelError(outcome.code, outcome.detail || '插入行失败');
      }
      const insertedRow = requireTable(outcome.model, request.table_id).rows[index];
      if (insertedRow === undefined) {
        throw new DocumentModelError('table_shape_invalid', '插入行后定位不到新行（实现缺陷）');
      }
      return { model: outcome.model, row_id: insertedRow.id, continued_merges: 0 };
    }

    const derived = deriveRowCells(table, map, index, source);
    const allocator = allocatorFor(model);
    const tablePath = pathOfExistingNode(table.id, 'table');
    const rowPath = withSegment(tablePath, 'row', index);
    const rowId = allocator.allocate(rowPath);
    const cells = derived.cells.map((draft, cellIndex) =>
      materializeCellWithBlocks({
        path: withSegment(rowPath, 'cell', cellIndex),
        allocator,
        source,
        properties: draft.properties,
        grid_span: draft.grid_span,
        vertical_merge: draft.vertical_merge,
        blocks: draft.blocks,
      }),
    );
    const row: RowNode = {
      id: rowId,
      kind: 'row',
      source,
      opaque: [],
      height: { state: 'unspecified' },
      header: false,
      cells,
    };
    const next: TableNode = { ...table, rows: [...table.rows.slice(0, index), row, ...table.rows.slice(index)] };
    assertTableShape(next, '插入行后的表格不合法');
    return {
      model: withTable(model, request.table_id, next),
      row_id: rowId,
      continued_merges: derived.continued,
    };
  });
}

/** 删除行请求。 */
export interface RemoveRowRequest {
  readonly table_id: NodeId;
  readonly index: number;
}

/** 删除行的结果。 */
export interface RemoveRowSuccess {
  readonly model: DocumentModel;
  /** 修复纵向合并链时被就地"提升为 restart"的格子数。 */
  readonly repaired_continues: number;
}

/**
 * 删除行（WF-057），删完**修复纵向链**。
 *
 * 删除可能让某个 `continue` 失去上方的 `restart`，这时就地把它升级为 `restart`
 * （合并区变短但不破碎）；修复动作的数量如实报出。
 */
export function removeRow(model: DocumentModel, request: RemoveRowRequest): TableOutcome<RemoveRowSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    if (table.rows.length <= 1) {
      throw new DocumentModelError(
        'table_shape_invalid',
        '表格至少要保留一行；要删掉整张表请用 deleteTable',
      );
    }
    if (!Number.isInteger(request.index) || request.index < 0 || request.index >= table.rows.length) {
      throw new DocumentModelError(
        'invalid_index',
        `删除行的位置越界：${String(request.index)}（表格共 ${String(table.rows.length)} 行）`,
      );
    }
    const stripped: TableNode = { ...table, rows: table.rows.filter((_row, index) => index !== request.index) };
    const repaired = normalizeVerticalMergeChains(stripped);
    assertTableShape(repaired.table, '删除行后的表格不合法');
    return {
      model: withTable(model, request.table_id, repaired.table),
      repaired_continues: repaired.repaired,
    };
  });
}

/**
 * 纵向合并链自愈：自顶向下逐列区间扫描，遇到"在链上但上方没有起点"的 `continue`
 * 就地升级为 `restart`，返回修复次数。
 *
 * 以 `start:end` **列区间**为键，因此 `gridSpan > 1` 的格子（跨列 + 纵向的矩形合并）
 * 也按同一规则处理。
 */
export function normalizeVerticalMergeChains(table: TableNode): {
  readonly table: TableNode;
  readonly repaired: number;
} {
  const open = new Set<string>();
  let repaired = 0;
  const rows = table.rows.map((row) => {
    let changed = false;
    let start = 0;
    const cells = row.cells.map((cell) => {
      const key = `${String(start)}:${String(start + cell.grid_span)}`;
      start += cell.grid_span;
      if (cell.vertical_merge === 'restart') {
        open.add(key);
        return cell;
      }
      if (cell.vertical_merge === 'continue') {
        if (open.has(key)) {
          return cell;
        }
        changed = true;
        repaired += 1;
        open.add(key);
        return { ...cell, vertical_merge: 'restart' as const };
      }
      open.delete(key);
      return cell;
    });
    return changed ? { ...row, cells } : row;
  });
  return { table: { ...table, rows }, repaired };
}

// ---------------------------------------------------------------------------
// WF-057 插入 / 删除列（复用 D01 的列算术与拒绝判据）
// ---------------------------------------------------------------------------

/** 插入列请求。`cells` 省略时按"每行一个空格"生成。 */
export interface InsertColumnRequest {
  readonly table_id: NodeId;
  readonly index: number;
  /** 新列宽；表格有网格定义时**必须**有值（`structure.ts` 拒绝"悄悄借邻居宽度"）。 */
  readonly width?: Length | null;
  readonly cells?: readonly DraftCellNode[] | null;
  readonly source?: SourceKind;
}

/** 插入列的结果。 */
export interface InsertColumnSuccess {
  readonly model: DocumentModel;
  /** 插入后的列宽（实际写进网格的那个值）。 */
  readonly width: Length | null;
}

/** 默认新列宽：左邻列宽；插在第 0 列时用右邻；都没有则 `null`。 */
export function neighboringColumnWidth(table: TableNode, index: number): Length | null {
  if (table.grid.length === 0) {
    return null;
  }
  const left = index > 0 ? table.grid[index - 1] : undefined;
  const right = table.grid[index];
  return (left ?? right ?? null) as Length | null;
}

/** 插入列（WF-057）：所有行同位置插入，纵向链的列区间整体平移，不会断链。 */
export function insertColumn(model: DocumentModel, request: InsertColumnRequest): TableOutcome<InsertColumnSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    requireCleanGrid(table, '插入列');
    const source: SourceKind = request.source ?? 'system';
    const cells =
      request.cells ??
      table.rows.map(() =>
        cellNode({ source, blocks: emptyCellBlocks(source), grid_span: 1, vertical_merge: null }),
      );
    const width = request.width ?? neighboringColumnWidth(table, request.index);
    const outcome = applyStructureBatch(model, [
      { kind: 'insert_column', table_id: request.table_id, index: request.index, cells, width },
    ]);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '插入列失败');
    }
    return { model: outcome.model, width: table.grid.length > 0 ? width : null };
  });
}

/** 删除列请求。 */
export interface RemoveColumnRequest {
  readonly table_id: NodeId;
  readonly index: number;
}

/** 删除列的结果。 */
export interface RemoveColumnSuccess {
  readonly model: DocumentModel;
}

/**
 * 删除列（WF-057）。
 *
 * 该列落在跨列合并区内部、或参与纵向合并时**明确拒绝**（`column_span_conflict`）——
 * 删列会切断合并，正确做法是先拆分 / 先取消合并（拒绝文案里给出这条指引）。
 */
export function removeColumn(model: DocumentModel, request: RemoveColumnRequest): TableOutcome<RemoveColumnSuccess> {
  return runTableEdit(() => {
    requireTable(model, request.table_id);
    const outcome = applyStructureBatch(model, [
      { kind: 'remove_column', table_id: request.table_id, index: request.index },
    ]);
    if (!outcome.ok) {
      throw new DocumentModelError(outcome.code, outcome.detail || '删除列失败');
    }
    return { model: outcome.model };
  });
}

/** 供测试与上层诊断：网格是否干净（无空洞、无重叠、行宽一致）。 */
export function tableGridIsClean(table: TableNode): boolean {
  return buildGridMap(table).problems.length === 0;
}
