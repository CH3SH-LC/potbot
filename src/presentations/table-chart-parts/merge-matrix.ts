/**
 * P06 · 合并单元格的**覆盖矩阵**（merge coverage）。
 *
 * ## 这一层解决什么
 *
 * 表格的合并有一张真实的结构不变式：**每一个网格位置被且仅被一个合并区（或它自己）覆盖**。
 * 两处合并区压到同一个格子、或某区域跨出网格——都必须**具名报错**，而不是画出一张
 * 自相矛盾的表。本模块把"合并区列表"摊平成 `row × col` 的覆盖矩阵，并携带三件事：
 *
 * 1. **来源**：每个格子属于哪个合并区（未合并的格子来源是它自己）；
 * 2. **重叠检测**：任一格子被**两个不同**的合并区认领 ⇒ `merge_overlap`；
 * 3. **越界 / span 非法**：区域落出网格 ⇒ `merge_out_of_bounds`；`row_span`/`col_span`
 *    非正整数 ⇒ `merge_span_invalid`。
 *
 * `coverageFromTable` 从 `model.ts` 的 `TableShape` 派生合并区（源格带 `col_span`/`row_span`
 * > 1；被覆盖的占位格 1×1 不单独登记），并顺带校验每行格数与列数相符（`grid_mismatch`）。
 * 与 `tables.ts` 的 `planTableGrid` 的一致由**用例交叉断言**：同一张表，两套实现的
 * "这一格属于哪个源格"必须逐格相等——本模块**不** import `tables.ts`。
 *
 * ## 边界（**未**做的事）
 *
 * - 只做**矩形**合并（与 `tables.ts` 的 `mergeCells` 同集合）；斜线 / 分布式单元格不做；
 * - 覆盖矩阵是**结构**判据，不涉及 `a:gridSpan` 等 XML 写法（那是 `tables.ts` 的渲染层）。
 */

import { TableChartPartsError } from './errors.js';

import type { TableShape } from '../model.js';

/** 一块矩形合并区（源格 + 跨越行/列数），与 `tables.ts` 的 `MergeRegion` 同形。 */
export interface MergeRegion {
  readonly row: number;
  readonly col: number;
  readonly row_span: number;
  readonly col_span: number;
}

/** 某格的来源（合并源格坐标；未合并格来源是其自身）。 */
export interface CoverageSource {
  readonly row: number;
  readonly col: number;
}

/** 合并覆盖矩阵。 */
export interface MergeCoverage {
  readonly row_count: number;
  readonly column_count: number;
  /** 参与覆盖的合并区（仅登记**真合并**：至少跨 2 格；顺序 = 传入顺序）。 */
  readonly regions: readonly MergeRegion[];
  /** `sources[row][col]` = 该格来源；行/列下标 0 基。 */
  readonly sources: readonly (readonly CoverageSource[])[];
}

function assertRegionShape(region: MergeRegion): void {
  if (
    !Number.isSafeInteger(region.row) ||
    !Number.isSafeInteger(region.col) ||
    !Number.isSafeInteger(region.row_span) ||
    !Number.isSafeInteger(region.col_span) ||
    region.row < 0 ||
    region.col < 0 ||
    region.row_span < 1 ||
    region.col_span < 1
  ) {
    throw new TableChartPartsError(
      'merge_span_invalid',
      `合并区 (${String(region.row)},${String(region.col)}) span=${String(region.row_span)}×${String(region.col_span)} 非法`,
    );
  }
}

/**
 * 把合并区列表摊平成覆盖矩阵。
 *
 * 每一格只能属于**一个**合并区：被第二个区认领（哪怕两区共享同一个源格）⇒ `merge_overlap`。
 */
export function buildMergeCoverage(
  rowCount: number,
  columnCount: number,
  regions: readonly MergeRegion[],
): MergeCoverage {
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || !Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new TableChartPartsError(
      'merge_span_invalid',
      `网格尺寸非法：${String(rowCount)} 行 × ${String(columnCount)} 列`,
    );
  }
  const owner: number[][] = Array.from({ length: rowCount }, () => new Array<number>(columnCount).fill(-1));

  regions.forEach((region, regionIndex) => {
    assertRegionShape(region);
    if (region.row + region.row_span > rowCount || region.col + region.col_span > columnCount) {
      throw new TableChartPartsError(
        'merge_out_of_bounds',
        `合并区 (${String(region.row)},${String(region.col)}) ${String(region.row_span)}×${String(region.col_span)} 跨出 ${String(rowCount)}×${String(columnCount)} 网格`,
      );
    }
    for (let row = region.row; row < region.row + region.row_span; row += 1) {
      for (let col = region.col; col < region.col + region.col_span; col += 1) {
        const current = owner[row]?.[col];
        if (current !== undefined && current !== -1 && current !== regionIndex) {
          throw new TableChartPartsError(
            'merge_overlap',
            `合并区 #${String(regionIndex)} 与 #${String(current)} 在第 ${String(row)} 行第 ${String(col)} 列重叠`,
          );
        }
        const rowOwners = owner[row];
        if (rowOwners !== undefined) rowOwners[col] = regionIndex;
      }
    }
  });

  const sources: (readonly CoverageSource[])[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const rowSources: CoverageSource[] = [];
    for (let col = 0; col < columnCount; col += 1) {
      const regionIndex = owner[row]?.[col] ?? -1;
      if (regionIndex === -1) {
        rowSources.push(Object.freeze({ row, col }));
      } else {
        const region = regions[regionIndex] as MergeRegion;
        rowSources.push(Object.freeze({ row: region.row, col: region.col }));
      }
    }
    sources.push(Object.freeze(rowSources));
  }

  return Object.freeze({
    row_count: rowCount,
    column_count: columnCount,
    regions: Object.freeze(regions.map((region) => Object.freeze({ ...region }))),
    sources: Object.freeze(sources.map((row) => Object.freeze(row))),
  });
}

/** 取某格来源；越界 ⇒ 抛错（不静默 `undefined`）。 */
export function sourceAt(coverage: MergeCoverage, row: number, col: number): CoverageSource {
  const source = coverage.sources[row]?.[col];
  if (source === undefined) {
    throw new TableChartPartsError(
      'merge_out_of_bounds',
      `(${String(row)},${String(col)}) 越界（网格 ${String(coverage.row_count)}×${String(coverage.column_count)}）`,
    );
  }
  return source;
}

/** 从 `TableShape` 派生合并区（仅源格：`col_span > 1` 或 `row_span > 1`）。 */
export function mergeRegionsOfTable(table: TableShape): readonly MergeRegion[] {
  const regions: MergeRegion[] = [];
  table.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, colIndex) => {
      if (cell.col_span > 1 || cell.row_span > 1) {
        regions.push(Object.freeze({ row: rowIndex, col: colIndex, row_span: cell.row_span, col_span: cell.col_span }));
      }
    });
  });
  return Object.freeze(regions);
}

/**
 * 从 `TableShape` 造覆盖矩阵。
 *
 * 先校验网格形状（每行格数 = `column_widths_emu` 长度 ⇒ 否则 `grid_mismatch`），
 * 再由源格派生合并区并摊平（重叠 / 越界由 `buildMergeCoverage` 抛错）。
 */
export function coverageFromTable(table: TableShape): MergeCoverage {
  const columnCount = table.column_widths_emu.length;
  if (columnCount < 1) {
    throw new TableChartPartsError('grid_mismatch', '表格没有列宽声明（列数为 0）');
  }
  table.rows.forEach((row, rowIndex) => {
    if (row.cells.length !== columnCount) {
      throw new TableChartPartsError(
        'grid_mismatch',
        `第 ${String(rowIndex)} 行有 ${String(row.cells.length)} 格，表格声明了 ${String(columnCount)} 列`,
      );
    }
  });
  return buildMergeCoverage(table.rows.length, columnCount, mergeRegionsOfTable(table));
}

/** 该格是否属于某个"真合并"（至少跨 2 格）。 */
export function isMergedCell(coverage: MergeCoverage, row: number, col: number): boolean {
  const source = sourceAt(coverage, row, col);
  return source.row !== row || source.col !== col;
}

/** 覆盖矩阵里"来源不等于自身"的格子数（即被别的源格吞并的**延续格**数）。 */
export function mergedCellCount(coverage: MergeCoverage): number {
  let count = 0;
  for (let row = 0; row < coverage.row_count; row += 1) {
    for (let col = 0; col < coverage.column_count; col += 1) {
      if (isMergedCell(coverage, row, col)) count += 1;
    }
  }
  return count;
}
