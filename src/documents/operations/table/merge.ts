/**
 * 单元格合并 / 拆分（WF-058；判据："grid_span / vertical_merge 的合并网格算术正确、
 * 非法跨区组合明确拒绝、网格不出现空洞或重叠"）。
 *
 * ## 合并区域在模型里长什么样
 *
 * OOXML 没有"合并区域"这种节点，只有两种标记：
 *
 * - **横向合并**：一个 `w:tc` 带 `w:gridSpan = N` —— 一格顶 N 列；
 * - **纵向合并**：同一列区间的若干行里，首行 `w:vMerge`（无 val，即 `restart`），
 *   其余行 `w:vMerge w:val="continue"` —— N 行拼成一块。
 *
 * 两者可叠加（`gridSpan=2` 且纵向跨 3 行 = 一个 2 列 × 3 行的矩形）。`grid.ts` 的
 * `regionOf` 负责把这两种标记还原成矩形，本模块负责把矩形**变回去**。
 *
 * ## 非法组合一律拒绝（判据点名）
 *
 * | 请求 | 结果 |
 * |---|---|
 * | 区域切穿既有合并区（部分重叠） | `column_span_conflict` |
 * | 区域越界 / 行列数为 0 | `invalid_index` |
 * | 表格网格本身有病（空洞 / 重叠 / 参差） | `table_shape_invalid` |
 * | 区域只含一个单元格（没有可合并对象） | `unsupported`（**不静默无操作**） |
 * | 拆分一个本来就没合并的单元格 | `unsupported` |
 *
 * 拒绝时**模型不变**：全部计算在局部变量上完成，抛错即整条操作消失（R136）。
 *
 * ## 内容去哪了（不丢数据）
 *
 * - **合并**：区域内所有单元格的块按**行优先**顺序串接进左上角单元格，其余单元格删除。
 *   文字一条不丢——合并是"合起来"，不是"留一个"。
 * - **拆分**：左上角单元格的内容按顺序分给**顶行**的新单元格（第 i 格拿第 i 块，
 *   多出来的块并入最后一格）；下方各行的新单元格是空占位段落（`source: system`）。
 *   与 Word 一致：纵向拆分后内容留在最上面那格。
 *
 * ## id 纪律
 *
 * 合并：左上角单元格**沿用自身 id**，它的块连同块 id 一起留下；被并入单元格的块换宿主但
 * **id 不变**（新格只有"结构占位"取新号）。拆分：第 0 格沿用原单元格 id，其余取新号。
 * 全程不重新编号既有内容（R101）。
 */

import { DocumentModelError } from '../../model/errors.js';
import { insertAt } from '../../model/immutable.js';
import type { CellNode, DocumentModel, NodeId, RowNode, TableNode } from '../../model/types.js';
import { assertTableShape } from '../../model/validation.js';
import {
  allocatorFor,
  cellPath,
  emptyCellBlocks,
  materializeCellWithBlocks,
  requireCleanGrid,
  requireTable,
  withTable,
} from './edit.js';
import {
  buildGridMap,
  cellAt,
  regionCells,
  regionCutByMerge,
  regionOf,
  regionWithinTable,
  type GridMap,
  type Region,
} from './grid.js';
import { runTableEdit, type TableOutcome } from './types.js';

/** 合并请求：一张表 + 一个矩形区域。 */
export interface MergeRequest {
  readonly table_id: NodeId;
  readonly region: Region;
}

/** 合并结果。 */
export interface MergeSuccess {
  readonly model: DocumentModel;
  readonly merged_region: Region;
  /** 被并入左上角、从表中消失的单元格个数（不含左上角那个）。 */
  readonly absorbed_cells: number;
}

/** 拆分请求：定位到**区域内的任意一格**（用它的合并区域来拆）。 */
export interface SplitRequest {
  readonly table_id: NodeId;
  readonly row: number;
  readonly column: number;
}

/** 拆分结果。 */
export interface SplitSuccess {
  readonly model: DocumentModel;
  /** 被拆开的原区域。 */
  readonly region: Region;
  /** 拆出的新单元格总数。 */
  readonly created_cells: number;
}

function regionLabel(region: Region): string {
  return `第 ${String(region.top)}–${String(region.top + region.rows - 1)} 行、第 ${String(
    region.left,
  )}–${String(region.left + region.columns - 1)} 列`;
}

/**
 * 只读查询：`(row, column)` 落在多大的合并区域里（没合并 ⇒ 1×1；越界 / 空洞 ⇒ `null`）。
 *
 * 供"合并前先查一下""要不要先拆再操作"这类**决策**使用，不产生任何变更。
 */
export function cellMergeRegion(table: TableNode, row: number, column: number): Region | null {
  return regionOf(buildGridMap(table), row, column);
}

/**
 * 合并的可判定性检查：合法则返回"将要发生的事"，不合法则返回结构化拒绝。
 *
 * 与 `mergeCells` **共用同一个 `assertMergeable`**——不存在"检查说行、执行却拒绝"的两套逻辑。
 */
export function canMergeCells(model: DocumentModel, request: MergeRequest): TableOutcome<MergeSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const map = requireCleanGrid(table, '合并单元格');
    assertMergeable(map, request.region);
    const cells = regionCells(map, request.region);
    return { model, merged_region: request.region, absorbed_cells: cells.length - 1 };
  });
}

/** 合并的合法性判据（唯一一份）。不合法即抛 `DocumentModelError`。 */
function assertMergeable(map: GridMap, region: Region): void {
  if (!regionWithinTable(map, region)) {
    throw new DocumentModelError(
      'invalid_index',
      `合并区域越界：${regionLabel(region)}（表格 ${String(map.row_count)} 行 ${String(map.column_count)} 列）`,
    );
  }
  const cut = regionCutByMerge(map, region);
  if (cut !== null) {
    throw new DocumentModelError(
      'column_span_conflict',
      `合并区域 ${regionLabel(region)} 切穿了既有合并区 ${regionLabel(cut.region)}` +
        `（第 ${String(cut.row)} 行第 ${String(cut.column)} 列）——先拆分再合并`,
    );
  }
  if (region.rows * region.columns < 2) {
    throw new DocumentModelError(
      'unsupported',
      `合并区域 ${regionLabel(region)} 只有一个格子，没有可合并的对象`,
    );
  }
  // 已经是一整块合并区的区域：再合一次没有意义，且会重复搬内容 ⇒ 明确拒绝。
  const existing = regionOf(map, region.top, region.left);
  if (
    existing !== null &&
    existing.top === region.top &&
    existing.left === region.left &&
    existing.rows === region.rows &&
    existing.columns === region.columns
  ) {
    throw new DocumentModelError(
      'unsupported',
      `合并区域 ${regionLabel(region)} 已经是一个合并单元格`,
    );
  }
}

/** 把区域换成"左上角一个大格 + 下方各行延续格"。 */
function mergeTable(
  model: DocumentModel,
  table: TableNode,
  map: GridMap,
  region: Region,
): { readonly table: TableNode; readonly absorbed: number } {
  const slots = regionCells(map, region);
  const anchorSlot = cellAt(map, region.top, region.left);
  if (anchorSlot === null) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `合并区域左上角（第 ${String(region.top)} 行第 ${String(region.left)} 列）没有单元格`,
    );
  }
  const allocator = allocatorFor(model);

  /** 该行被区域覆盖的行内单元格下标（升序）。 */
  const coveredIndices = (rowIndex: number): readonly number[] => {
    const covered: number[] = [];
    for (let column = region.left; column < region.left + region.columns; column += 1) {
      const slot = cellAt(map, rowIndex, column);
      if (slot !== null && !covered.includes(slot.cell_index)) {
        covered.push(slot.cell_index);
      }
    }
    return covered.sort((left, right) => left - right);
  };

  let absorbed = 0;
  const rows = table.rows.map((row: RowNode, rowIndex: number): RowNode => {
    if (rowIndex < region.top || rowIndex >= region.top + region.rows) {
      return row;
    }
    const covered = coveredIndices(rowIndex);
    if (covered.length === 0) {
      return row;
    }
    const insertIndex = covered[0] as number;
    const kept = row.cells.filter((_cell: CellNode, index: number) => !covered.includes(index));
    absorbed += covered.length - 1;

    if (rowIndex === region.top) {
      // 左上角：沿用自身 id 与属性，内容换成整个区域的内容（块 id 全程不变）。
      const anchorCell: CellNode = {
        ...anchorSlot.cell,
        blocks: slots.flatMap((slot) => slot.cell.blocks),
        grid_span: region.columns,
        vertical_merge: region.rows > 1 ? 'restart' : null,
      };
      return { ...row, cells: insertAt(kept, insertIndex, anchorCell) };
    }
    // 纵向延续格：结构占位，内容为空（继续沿用左上角的内容）。
    const continuation = materializeCellWithBlocks({
      path: cellPath(row.id, insertIndex),
      allocator,
      source: 'system',
      properties: anchorSlot.cell.properties,
      grid_span: region.columns,
      vertical_merge: 'continue',
      blocks: emptyCellBlocks('system'),
    });
    return { ...row, cells: insertAt(kept, insertIndex, continuation) };
  });

  return { table: { ...table, rows }, absorbed };
}

/** 合并单元格（WF-058）。成功返回新模型；拒绝语义见文件头表格。 */
export function mergeCells(model: DocumentModel, request: MergeRequest): TableOutcome<MergeSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const map = requireCleanGrid(table, '合并单元格');
    assertMergeable(map, request.region);
    const merged = mergeTable(model, table, map, request.region);
    assertCleanResult(merged.table, '合并');
    return {
      model: withTable(model, request.table_id, merged.table),
      merged_region: request.region,
      absorbed_cells: merged.absorbed,
    };
  });
}

/** 拆分单元格（WF-058）。定位用"区域内任意一格"，1×1 的单元格返回 `unsupported`。 */
export function splitCell(model: DocumentModel, request: SplitRequest): TableOutcome<SplitSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const map = requireCleanGrid(table, '拆分单元格');
    const region = regionOf(map, request.row, request.column);
    if (region === null) {
      throw new DocumentModelError(
        'invalid_index',
        `第 ${String(request.row)} 行第 ${String(request.column)} 列没有单元格（越界或空洞）`,
      );
    }
    if (region.rows * region.columns < 2) {
      throw new DocumentModelError(
        'unsupported',
        `第 ${String(request.row)} 行第 ${String(request.column)} 列的单元格没有合并（1×1），无可拆分`,
      );
    }

    const allocator = allocatorFor(model);
    const anchorSlot = cellAt(map, region.top, region.left);
    if (anchorSlot === null) {
      throw new DocumentModelError('table_shape_invalid', '合并区域左上角没有单元格');
    }
    const anchorBlocks = anchorSlot.cell.blocks;
    const templateProps = structuredClone(anchorSlot.cell.properties);

    const coveredIndices = (rowIndex: number): readonly number[] => {
      const covered: number[] = [];
      for (let column = region.left; column < region.left + region.columns; column += 1) {
        const slot = cellAt(map, rowIndex, column);
        if (slot !== null && !covered.includes(slot.cell_index)) {
          covered.push(slot.cell_index);
        }
      }
      return covered.sort((left, right) => left - right);
    };

    let created = 0;
    const rows = table.rows.map((row: RowNode, rowIndex: number): RowNode => {
      if (rowIndex < region.top || rowIndex >= region.top + region.rows) {
        return row;
      }
      const covered = coveredIndices(rowIndex);
      if (covered.length === 0) {
        return row;
      }
      const insertIndex = covered[0] as number;
      const kept = row.cells.filter((_cell: CellNode, index: number) => !covered.includes(index));
      let cells: readonly CellNode[] = kept;

      for (let offset = 0; offset < region.columns; offset += 1) {
        const path = cellPath(row.id, insertIndex + offset);
        if (rowIndex !== region.top) {
          // 纵向拆出的下方各行：每列一个空占位单元格。
          cells = insertAt(
            cells,
            insertIndex + offset,
            materializeCellWithBlocks({
              path,
              allocator,
              source: 'system',
              properties: templateProps,
              grid_span: 1,
              vertical_merge: null,
              blocks: emptyCellBlocks('system'),
            }),
          );
        } else {
          const isLast = offset === region.columns - 1;
          const slice = isLast ? anchorBlocks.slice(offset) : anchorBlocks.slice(offset, offset + 1);
          const blocks = slice.length > 0 ? slice : emptyCellBlocks('system');
          const cell = materializeCellWithBlocks({
            path,
            allocator,
            source: anchorSlot.cell.source,
            properties: templateProps,
            grid_span: 1,
            vertical_merge: null,
            blocks: [...blocks],
          });
          // 第 0 格沿用原单元格 id（身份不变），其余是新单元格。
          cells = insertAt(cells, insertIndex + offset, offset === 0 ? { ...cell, id: anchorSlot.cell.id } : cell);
        }
        created += 1;
      }
      return { ...row, cells };
    });

    const next: TableNode = { ...table, rows };
    assertCleanResult(next, '拆分');
    return { model: withTable(model, request.table_id, next), region, created_cells: created };
  });
}

/** 结果自检：形状合法 + 无空洞/重叠（判据的实现级保证）。 */
function assertCleanResult(table: TableNode, what: string): void {
  assertTableShape(table, `${what}后的表格不合法`);
  const problem = buildGridMap(table).problems[0];
  if (problem !== undefined) {
    throw new DocumentModelError(
      'table_shape_invalid',
      `${what}结果为病态网格（实现缺陷，不是用户输入问题）：${problem.kind}`,
    );
  }
}

/** 合并请求的便捷构造。 */
export function mergeRequest(tableId: NodeId, region: Region): MergeRequest {
  return { table_id: tableId, region };
}

/** 拆分请求的便捷构造（"第 R 行第 C 列要拆"）。 */
export function splitRequest(tableId: NodeId, row: number, column: number): SplitRequest {
  return { table_id: tableId, row, column };
}
