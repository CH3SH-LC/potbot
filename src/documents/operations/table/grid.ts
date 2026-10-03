/**
 * 表格网格几何（WF-057/058 的判据基础，WCF-D05）。
 *
 * ## 为什么要有这一层（而不是直接用 `model/table-grid.ts`）
 *
 * `model/table-grid.ts`（D01）只做**单行**的列算术：一行的第 N 个单元格从第几列开始、占几列。
 * 但"合并区域"是**二维**概念：一个 `grid_span=2` × `vMerge` 跨 3 行的单元格，占的是一个
 * 2 列 × 3 行的矩形；"与既有合并区部分重叠"这种非法组合，只有把二维占用矩阵建出来才判得准。
 *
 * 本模块把表格看成 **row_count × column_count 的占用矩阵**，每个格子指向覆盖它的单元格，
 * 并显式报出三类网格病：
 *
 * | 病 | 含义 | 触发的编辑 |
 * |---|---|---|
 * | `row_width_mismatch` | 某行占的列数与表格列数不同（参差不齐） | 列操作（WF-057/058 前置条件） |
 * | `hole` | 某行某列没有任何单元格覆盖（**空洞**） | 判据明令禁止的结果 |
 * | `overlap` | 同一格被两个单元格覆盖（**重叠**） | 判据明令禁止的结果 |
 *
 * ## 约定
 *
 * - 列/行号**从 0 起**；
 * - `Region`（区域）用 **左上角 + 行列数**表达（`{top, left, rows, columns}`），
 *   避免"右边界闭还是开"这类歧义——这是"第 R 行第 C 列到第 R' 行第 C' 列"的规范化形态；
 * - `CellSlot` 里的列区间用**左闭右开**（`start` / `end`），与 `rowCellSpans` 一致。
 */

import type { CellNode, RowNode, TableNode } from '../../model/types.js';
import { rowCellSpans, tableColumnCount } from '../../model/table-grid.js';

/** 一个单元格在网格里的落位。 */
export interface CellSlot {
  /** 行号（0 起）。 */
  readonly row: number;
  /** 该单元格在所在行 `cells` 数组里的下标。 */
  readonly cell_index: number;
  readonly cell: CellNode;
  /** 左闭。 */
  readonly start: number;
  /** 右开：占据的列号 ∈ `[start, end)`。 */
  readonly end: number;
}

/** 一个矩形区域：左上角 + 行列数（列/行号从 0 起）。 */
export interface Region {
  readonly top: number;
  readonly left: number;
  readonly rows: number;
  readonly columns: number;
}

/** 网格病（判据："网格不出现空洞或重叠"）。 */
export type GridProblem =
  | { readonly kind: 'row_width_mismatch'; readonly row: number; readonly actual: number; readonly expected: number }
  | { readonly kind: 'hole'; readonly row: number; readonly column: number }
  | {
      readonly kind: 'overlap';
      readonly row: number;
      readonly column: number;
      readonly first_cell_index: number;
      readonly second_cell_index: number;
    };

/** 网格占用矩阵与病检出结果。 */
export interface GridMap {
  readonly row_count: number;
  readonly column_count: number;
  /** 全部单元格落位，按行优先顺序。 */
  readonly slots: readonly CellSlot[];
  /** `owner[row][column]` = 覆盖该格的单元格；`null` = 空洞。 */
  readonly owner: readonly (readonly (CellSlot | null)[])[];
  readonly problems: readonly GridProblem[];
}

function emptyRow(columnCount: number): (CellSlot | null)[] {
  return new Array<CellSlot | null>(columnCount).fill(null);
}

/**
 * 建占用矩阵。
 *
 * 建矩阵时**不纠正**任何畸形态：越界的列被记为 `row_width_mismatch`，重复占位记为 `overlap`，
 * 没人占的格记为 `hole`。上层据此拒绝编辑（R136：宁拒绝，不修补出半成品）。
 */
export function buildGridMap(table: TableNode): GridMap {
  const columnCount = tableColumnCount(table);
  const width = Math.max(columnCount, ...table.rows.map((row) => rowCellSpans(row).reduce((total, span) => total + span.span, columnCount)));
  const owner: (CellSlot | null)[][] = table.rows.map(() => emptyRow(width));
  const slots: CellSlot[] = [];
  const problems: GridProblem[] = [];

  table.rows.forEach((row, rowIndex) => {
    const spans = rowCellSpans(row);
    const actual = spans.reduce((total, span) => total + span.span, 0);
    if (actual !== columnCount) {
      problems.push({ kind: 'row_width_mismatch', row: rowIndex, actual, expected: columnCount });
    }
    for (const span of spans) {
      const slot: CellSlot = {
        row: rowIndex,
        cell_index: span.cell_index,
        cell: span.cell,
        start: span.start,
        end: span.start + span.span,
      };
      slots.push(slot);
      for (let column = span.start; column < span.start + span.span; column += 1) {
        const line = owner[rowIndex];
        if (line === undefined || column >= width) {
          continue;
        }
        const occupant = line[column];
        if (occupant !== undefined && occupant !== null) {
          problems.push({
            kind: 'overlap',
            row: rowIndex,
            column,
            first_cell_index: occupant.cell_index,
            second_cell_index: span.cell_index,
          });
          continue;
        }
        // 同一个单元格的多个列位置共享**同一个** slot 对象，便于按引用比较。
        line[column] = slot;
      }
    }
  });

  for (let row = 0; row < owner.length; row += 1) {
    const line = owner[row] as (CellSlot | null)[];
    for (let column = 0; column < columnCount; column += 1) {
      if (line[column] === null) {
        problems.push({ kind: 'hole', row, column });
      }
    }
  }

  return { row_count: table.rows.length, column_count: columnCount, slots, owner, problems };
}

/** 覆盖 `(row, column)` 的单元格；行/列越界或空洞返回 `null`。 */
export function cellAt(map: GridMap, row: number, column: number): CellSlot | null {
  if (row < 0 || row >= map.row_count || column < 0 || column >= map.column_count) {
    return null;
  }
  const line = map.owner[row];
  if (line === undefined) {
    return null;
  }
  return line[column] ?? null;
}

/** 区域是否落在表格内（左上角合法且不越界）。 */
export function regionWithinTable(map: GridMap, region: Region): boolean {
  return (
    Number.isInteger(region.top) &&
    Number.isInteger(region.left) &&
    Number.isInteger(region.rows) &&
    Number.isInteger(region.columns) &&
    region.rows >= 1 &&
    region.columns >= 1 &&
    region.top >= 0 &&
    region.left >= 0 &&
    region.top + region.rows <= map.row_count &&
    region.left + region.columns <= map.column_count
  );
}

/** 区域覆盖的**互异**单元格（同一单元格只出现一次，按行优先顺序）。 */
export function regionCells(map: GridMap, region: Region): readonly CellSlot[] {
  const seen = new Set<CellSlot>();
  const result: CellSlot[] = [];
  for (let row = region.top; row < region.top + region.rows; row += 1) {
    for (let column = region.left; column < region.left + region.columns; column += 1) {
      const slot = cellAt(map, row, column);
      if (slot !== null && !seen.has(slot)) {
        seen.add(slot);
        result.push(slot);
      }
    }
  }
  return result;
}

/**
 * `(row, column)` 所在**合并区域**：把横向跨度与纵向合并链合成一个矩形。
 *
 * 纵向链的判定：从该格所在单元格向上，只要上一行**同一列区间**上的单元格是 `continue`
 * 且当前格所在单元格也是 `continue`，就继续上溯；再从链顶向下走到最后一个 `continue`。
 * 这样"跨 2 列 × 跨 3 行"的合并在模型里是"3 行、每行一个 `grid_span=2` 的单元格，
 * 第二三行 `vMerge=continue`"，本函数把它还原成一个 `2×3` 矩形。
 */
export function regionOf(map: GridMap, row: number, column: number): Region | null {
  const slot = cellAt(map, row, column);
  if (slot === null) {
    return null;
  }
  let top = row;
  let bottom = row;
  /** 上一行**同一列区间**上的单元格；不是同一个列区间（或没有）即 `null`。 */
  const aboveAt = (at: number): CellSlot | null => {
    const candidate = cellAt(map, at - 1, slot.start);
    return candidate !== null && candidate.start === slot.start && candidate.end === slot.end
      ? candidate
      : null;
  };
  const belowAt = (at: number): CellSlot | null => {
    const candidate = cellAt(map, at + 1, slot.start);
    return candidate !== null && candidate.start === slot.start && candidate.end === slot.end
      ? candidate
      : null;
  };

  // 上溯：当前格是 `continue`，且上一行同列区间的格子也在链上（`restart` 或 `continue`）。
  for (;;) {
    const current = cellAt(map, top, slot.start);
    const above = aboveAt(top);
    if (
      current !== null &&
      current.cell.vertical_merge === 'continue' &&
      above !== null &&
      above.cell.vertical_merge !== null
    ) {
      top -= 1;
      continue;
    }
    break;
  }
  // 下探：下一行同列区间的格子是 `continue`，且当前格在链上。
  for (;;) {
    const current = cellAt(map, bottom, slot.start);
    const below = belowAt(bottom);
    if (
      current !== null &&
      current.cell.vertical_merge !== null &&
      below !== null &&
      below.cell.vertical_merge === 'continue'
    ) {
      bottom += 1;
      continue;
    }
    break;
  }
  return { top, left: slot.start, rows: bottom - top + 1, columns: slot.end - slot.start };
}

/** 表格里全部**真合并**区域（覆盖 ≥2 个单元格的矩形），按行优先顺序，且去重。 */
export function mergedRegions(table: TableNode): readonly Region[] {
  const map = buildGridMap(table);
  const regions: Region[] = [];
  const seen = new Set<string>();
  for (let row = 0; row < map.row_count; row += 1) {
    for (let column = 0; column < map.column_count; column += 1) {
      if (cellAt(map, row, column) === null) {
        continue;
      }
      const region = regionOf(map, row, column);
      if (region === null || region.rows * region.columns < 2) {
        continue;
      }
      const key = `${String(region.top)}:${String(region.left)}:${String(region.rows)}:${String(region.columns)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      regions.push(region);
    }
  }
  return regions;
}

/**
 * 区域是否被既有合并区**完整**包住（即不切穿任何合并区）。
 *
 * 返回切穿者时给出它覆盖到的那个合并区，供上层写进 `detail`（R116：拒绝必须能解释）。
 */
export function regionCutByMerge(
  map: GridMap,
  region: Region,
): { readonly region: Region; readonly row: number; readonly column: number } | null {
  const right = region.left + region.columns;
  const bottom = region.top + region.rows;
  for (let row = region.top; row < bottom; row += 1) {
    for (let column = region.left; column < right; column += 1) {
      if (cellAt(map, row, column) === null) {
        continue;
      }
      // 该格所属的**合并区**（含纵向链）只要有一边伸到区域之外 ⇒ 区域切穿了它。
      const merged = regionOf(map, row, column);
      if (merged === null) {
        continue;
      }
      const outside =
        merged.top < region.top ||
        merged.top + merged.rows > bottom ||
        merged.left < region.left ||
        merged.left + merged.columns > right;
      if (outside) {
        return { region: merged, row, column };
      }
    }
  }
  return null;
}

/** 区域是否"整格对齐"：区域内每个单元格都完整落在区域内（合并操作的合法性前提）。 */
export function regionIsCellAligned(map: GridMap, region: Region): boolean {
  return regionCutByMerge(map, region) === null;
}

/** 表格各行的列数（诊断用）。 */
export function rowWidths(table: TableNode): readonly number[] {
  return table.rows.map((row: RowNode) =>
    rowCellSpans(row).reduce((total, span) => total + span.span, 0),
  );
}

/** 网格是否无病（无空洞、无重叠、行宽一致）——判据"网格不出现空洞或重叠"的判定入口。 */
export function gridIsClean(table: TableNode): boolean {
  return buildGridMap(table).problems.length === 0;
}

/** 把网格病写成人类可读的一句（拒绝信息/测试断言用）。 */
export function describeGridProblem(problem: GridProblem): string {
  switch (problem.kind) {
    case 'row_width_mismatch':
      return `第 ${String(problem.row)} 行占 ${String(problem.actual)} 列，表格声明 ${String(problem.expected)} 列`;
    case 'hole':
      return `第 ${String(problem.row)} 行第 ${String(problem.column)} 列是空洞（没有任何单元格覆盖）`;
    case 'overlap':
      return `第 ${String(problem.row)} 行第 ${String(problem.column)} 列被单元格 ${String(problem.first_cell_index)} 与 ${String(problem.second_cell_index)} 重复覆盖`;
    default: {
      const exhaustive: never = problem;
      return JSON.stringify(exhaustive);
    }
  }
}
