/**
 * P-I08 · **表格侧同版事实**（table-side fact fingerprint）。
 *
 * ## 这一层解决什么（补 P06 留下的表侧缺口）
 *
 * P06 的 `data-edit.ts` 把**一份图表数据**同时投影成"图上引用"与"内嵌工作簿逐格"，
 * 并用 `dataVersionOf`（`dc1-*` 指纹）盖同一个版本戳——但**表格**这一侧没有对应物：
 * 一张把同批数字展示出来的**表**（含合并单元格）改了格，无法证明它和图表、工作簿
 * 是**同一版事实**（PPT-16「修改人数 / 预算后文本、图表、表格一致」）。
 *
 * 本层把**同一份数据**再投影成第三样东西——**表格字面量**（`TableFactMirror`）：
 *
 * 1. 布局与 `charts.ts` 的内嵌工作簿**同格**：第 0 行 = 角格 `类别` + 各系列名，
 *    第 1..n 行 = `A` 列类别 + 各系列值（用例与真 XLSX 字节交叉断言）；
 * 2. **合并单元格**用 `merge-matrix.ts` 的覆盖矩阵解成"这一格属于哪个源格"，
 *    每一格的**事实引用**（第几系列 / 哪个类别）随合并**迁移**到源格；
 * 3. 每一格都盖**同一个** `dc1-*` 指纹（`version`），与快照里的 `version` 逐字相同；
 * 4. `chartDataFromTableLiterals` 把表**反解**回数据（独立读数），
 *    `verifyTableFactCoherence` 复核"表字面量 == 数据、合并事实安全、来源已迁移、指纹一致"。
 *
 * ## 合并的事实安全口径
 *
 * 一个合并区**最多只能认领 1 个事实格**（系列名 / 类别 / 数值），且该事实格必须是合并区
 * 的**左上角源格**（OOXML 的字面量就写在源格，延续格为空）。否则合并会把两个事实压成
 * 一格（或把字面量挪走）——具名抛 `table_merge_conflict`，**不**静默取其一。
 * 纯装饰区（如跨列的标题横幅）不含事实格，允许合并。
 *
 * ## 边界（**未**做的事）
 *
 * - 只做**矩形**合并（与 `tables.ts` / `merge-matrix.ts` 同集合）；
 * - 表格字面量只覆盖**数据格**，装饰（标题 / 角格）不参与指纹；
 * - 不写 PPTX 字节（那是渲染层的事）；真机 PowerPoint / WPS 打开未验证。
 */

import { TableChartPartsError } from './errors.js';
import { columnLetter, type ExpectedChartData, type ExpectedSeries } from './consistency.js';
import {
  buildMergeCoverage,
  type MergeCoverage,
  type MergeRegion,
} from './merge-matrix.js';

// ---------------------------------------------------------------------------
// 数据形态校验 + 确定性指纹（P06 原在 data-edit.ts，集成时上移到此**事实核心**，
// 使"表侧投影"与"编辑引擎"共用**唯一**一份校验与指纹实现，不复制算法）
// ---------------------------------------------------------------------------

/**
 * 校验一份图表数据：类别非空、系列非空、系列名不重复、每个系列的值与类别**等长**、
 * 所有点值**有限**。任一不满足 ⇒ `invalid_chart_data`（不猜、不补、不截断）。
 */
export function validateChartData(data: ExpectedChartData): void {
  if (data.categories.length === 0) {
    throw new TableChartPartsError('invalid_chart_data', '图表数据没有任何类别');
  }
  if (data.series.length === 0) {
    throw new TableChartPartsError('invalid_chart_data', '图表数据没有任何系列');
  }
  const names = new Set<string>();
  for (const series of data.series) {
    if (names.has(series.name)) {
      throw new TableChartPartsError('invalid_chart_data', `系列名 ${series.name} 出现两次`);
    }
    names.add(series.name);
    if (series.values.length !== data.categories.length) {
      throw new TableChartPartsError(
        'invalid_chart_data',
        `系列 ${series.name} 有 ${String(series.values.length)} 个值，类别却有 ${String(data.categories.length)} 个`,
      );
    }
    series.values.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TableChartPartsError(
          'invalid_chart_data',
          `系列 ${series.name} 的第 ${String(index + 1)} 个值非法：${String(value)}`,
        );
      }
    });
  }
}

/**
 * 数据的**确定性指纹**（FNV-1a 32 位，前缀 `dc1-`）。
 *
 * 只取决于类别、系列名与点值；同值必同串、异值（几乎必然）异串。图、表、工作簿三样
 * 都盖这一枚指纹，用来判断"是不是同一版事实"，而不是靠逐项比对的次序偶然。
 */
export function dataVersionOf(data: ExpectedChartData): string {
  const canonical = JSON.stringify([
    data.categories,
    data.series.map((series) => [series.name, series.values.map((value) => String(value))]),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `dc1-${hash.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// 表格字面量的角色与描述符
// ---------------------------------------------------------------------------

/** 角格（类别列头）的固定文字，与 `charts.ts` 的 `chartDataGrid` 同口径。 */
export const TABLE_CATEGORY_HEADER = '类别';

/**
 * 表上一格的角色。`title` / `header` 是**装饰**（不参与事实指纹）；其余三样是**数据格**。
 */
export type TableLiteralRole = 'title' | 'header' | 'series_name' | 'category' | 'value';

/** 表上一格的 0 基坐标。 */
export interface TableCellAddress {
  readonly row: number;
  readonly col: number;
}

/** 表上一格的字面量描述符（含合并来源与事实引用）。 */
export interface TableLiteralCell {
  readonly row: number;
  readonly col: number;
  /** 列名（`A` / `B` …）。 */
  readonly column: string;
  /** A1 地址（如 `B2`）。 */
  readonly a1: string;
  readonly role: TableLiteralRole;
  /** 数据格的系列下标；非数值 / 类别 / 系列名格为 `null`。 */
  readonly series_index: number | null;
  /** 数据格的类别下标；非类别 / 数值格为 `null`。 */
  readonly category_index: number | null;
  /** 文本格（`title` / `header` / `series_name` / `category`）的内容；数值格与延续格为 `null`。 */
  readonly text: string | null;
  /** 数值格的点值；其余与延续格为 `null`。 */
  readonly value: number | null;
  /** 合并来源格（源格 = 自身坐标）；事实引用已迁至此。 */
  readonly source: TableCellAddress;
  /** 是否是被合并吞掉的**延续格**（`source` 不等于自身）。 */
  readonly merged_away: boolean;
  /** 该格所属事实的 `dc1-*` 指纹（表内每格**逐字相同**）。 */
  readonly version: string;
}

/** 一张把同版事实摊成表格的**表镜**（mirror）。 */
export interface TableFactMirror {
  /** 表标题（会形成一条跨列合并横幅）；无标题为 `null`。 */
  readonly title: string | null;
  readonly row_count: number;
  readonly column_count: number;
  /** 调用方登记的合并区（**不含**标题横幅——横幅由 `title` 生成）。 */
  readonly merges: readonly MergeRegion[];
  readonly cells: readonly TableLiteralCell[];
  /** 整张表的事实指纹（`dc1-*`），与图表 / 工作簿快照同一枚。 */
  readonly version: string;
}

/** 造表镜的选项。 */
export interface TableMirrorOptions {
  /** 有标题 ⇒ 第 0 行是跨列合并的标题横幅，角格/系列名/数据整体下移一行。 */
  readonly title?: string;
  /** 调用方登记的合并区（坐标相对最终网格：有标题时标题行是第 0 行）。 */
  readonly merges?: readonly MergeRegion[];
}

/** 一次**表格格编辑**（值或文本）；坐标是最终网格的 0 基行 / 列。 */
export type TableCellEdit =
  | { readonly kind: 'set_value'; readonly row: number; readonly col: number; readonly value: number }
  | { readonly kind: 'set_text'; readonly row: number; readonly col: number; readonly text: string };

// ---------------------------------------------------------------------------
// 造表镜
// ---------------------------------------------------------------------------

function isFactRole(role: TableLiteralRole): boolean {
  return role === 'series_name' || role === 'category' || role === 'value';
}

interface RawGridCell {
  readonly row: number;
  readonly col: number;
  readonly role: TableLiteralRole;
  readonly series_index: number | null;
  readonly category_index: number | null;
  readonly text: string | null;
  readonly value: number | null;
}

/** 按"与工作簿同格"的布局摊出**未合并**的网格（每个位置一格）。 */
function buildRawGrid(
  data: ExpectedChartData,
  title: string | null,
): { readonly row_count: number; readonly column_count: number; readonly grid: RawGridCell[][] } {
  const columnCount = data.series.length + 1;
  const headerRow = title === null ? 0 : 1;
  const rowCount = data.categories.length + 1 + headerRow;
  const grid: RawGridCell[][] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const rowCells: RawGridCell[] = [];
    for (let col = 0; col < columnCount; col += 1) {
      rowCells.push(fillRawCell(data, title, row, col, headerRow));
    }
    grid.push(rowCells);
  }
  return { row_count: rowCount, column_count: columnCount, grid };
}

function fillRawCell(
  data: ExpectedChartData,
  title: string | null,
  row: number,
  col: number,
  headerRow: number,
): RawGridCell {
  if (headerRow === 1 && row === 0) {
    return { row, col, role: 'title', series_index: null, category_index: null, text: title, value: null };
  }
  if (row === headerRow) {
    if (col === 0) {
      return {
        row,
        col,
        role: 'header',
        series_index: null,
        category_index: null,
        text: TABLE_CATEGORY_HEADER,
        value: null,
      };
    }
    const seriesIndex = col - 1;
    const series = data.series[seriesIndex];
    return {
      row,
      col,
      role: 'series_name',
      series_index: seriesIndex,
      category_index: null,
      text: series?.name ?? null,
      value: null,
    };
  }
  const categoryIndex = row - headerRow - 1;
  if (col === 0) {
    return {
      row,
      col,
      role: 'category',
      series_index: null,
      category_index: categoryIndex,
      text: data.categories[categoryIndex] ?? null,
      value: null,
    };
  }
  const seriesIndex = col - 1;
  const series = data.series[seriesIndex];
  return {
    row,
    col,
    role: 'value',
    series_index: seriesIndex,
    category_index: categoryIndex,
    text: null,
    value: series?.values[categoryIndex] ?? null,
  };
}

/** 最终要参与覆盖计算的合并区（标题横幅 + 调用方合并区）。 */
function effectiveMergesOf(
  title: string | null,
  columnCount: number,
  merges: readonly MergeRegion[],
): readonly MergeRegion[] {
  if (title === null) return merges;
  return [Object.freeze({ row: 0, col: 0, row_span: 1, col_span: columnCount }), ...merges];
}

function assertRegionFactSafe(region: MergeRegion, grid: readonly RawGridCell[][]): void {
  let factCount = 0;
  let factAtOrigin = false;
  for (let row = region.row; row < region.row + region.row_span; row += 1) {
    for (let col = region.col; col < region.col + region.col_span; col += 1) {
      const cell = grid[row]?.[col];
      if (cell === undefined || !isFactRole(cell.role)) continue;
      factCount += 1;
      if (row === region.row && col === region.col) factAtOrigin = true;
    }
  }
  if (factCount === 0) return; // 纯装饰区（标题横幅）允许
  if (factCount > 1) {
    throw new TableChartPartsError(
      'table_merge_conflict',
      `合并区 (${String(region.row)},${String(region.col)}) ${String(region.row_span)}×${String(region.col_span)} 覆盖了 ${String(factCount)} 个事实格，会把多个事实压成一格`,
    );
  }
  if (!factAtOrigin) {
    throw new TableChartPartsError(
      'table_merge_conflict',
      `合并区 (${String(region.row)},${String(region.col)}) 的唯一事实格不在左上角源格，字面量会被挪走`,
    );
  }
}

function assertMergesFactSafe(coverage: MergeCoverage, grid: readonly RawGridCell[][]): void {
  for (const region of coverage.regions) {
    assertRegionFactSafe(region, grid);
  }
}

/**
 * 由**一份数据**造表镜：字面量、合并覆盖、事实引用（随合并迁移到源格）、`dc1-*` 指纹
 * 全部现算自同一份数据。形态非法 ⇒ `invalid_chart_data`；合并事实不安全 ⇒ `table_merge_conflict`。
 */
export function tableMirrorFromChartData(
  data: ExpectedChartData,
  options: TableMirrorOptions = {},
): TableFactMirror {
  validateChartData(data);
  const title = options.title ?? null;
  if (title !== null && title.trim() === '') {
    throw new TableChartPartsError('invalid_chart_data', '表格标题不能是空串');
  }
  const callerMerges = options.merges ?? [];

  const { row_count, column_count, grid } = buildRawGrid(data, title);
  const coverage = buildMergeCoverage(
    row_count,
    column_count,
    effectiveMergesOf(title, column_count, callerMerges),
  );
  assertMergesFactSafe(coverage, grid);

  const version = dataVersionOf(data);
  const cells: TableLiteralCell[] = [];
  for (let row = 0; row < row_count; row += 1) {
    for (let col = 0; col < column_count; col += 1) {
      const raw = grid[row]?.[col];
      const source = coverage.sources[row]?.[col];
      if (raw === undefined || source === undefined) {
        throw new TableChartPartsError('table_fact_desync', `表网格缺格 (${String(row)},${String(col)})`);
      }
      const mergedAway = source.row !== row || source.col !== col;
      const origin = grid[source.row]?.[source.col];
      if (origin === undefined) {
        throw new TableChartPartsError('table_fact_desync', `格 (${String(row)},${String(col)}) 的源格缺失`);
      }
      const fact = mergedAway ? origin : raw;
      const colLetter = columnLetter(col);
      cells.push(
        Object.freeze({
          row,
          col,
          column: colLetter,
          a1: `${colLetter}${String(row + 1)}`,
          role: fact.role,
          series_index: fact.series_index,
          category_index: fact.category_index,
          text: mergedAway ? null : raw.text,
          value: mergedAway ? null : raw.value,
          source: Object.freeze({ row: source.row, col: source.col }),
          merged_away: mergedAway,
          version,
        }),
      );
    }
  }

  return Object.freeze({
    title,
    row_count,
    column_count,
    merges: Object.freeze(callerMerges.map((merge) => Object.freeze({ ...merge }))),
    cells: Object.freeze(cells),
    version,
  });
}

/** 取表上一格；越界 / 缺格 ⇒ `unknown_table_cell`（不静默 `undefined`）。 */
export function tableCellAt(mirror: TableFactMirror, row: number, col: number): TableLiteralCell {
  const cell = mirror.cells.find((candidate) => candidate.row === row && candidate.col === col);
  if (cell === undefined) {
    throw new TableChartPartsError(
      'unknown_table_cell',
      `表格里没有格 (${String(row)},${String(col)})（网格 ${String(mirror.row_count)}×${String(mirror.column_count)}）`,
    );
  }
  return cell;
}

/** 表镜里承担**事实**的源格（系列名 / 类别 / 数值），顺序稳定。 */
export function tableFactCells(mirror: TableFactMirror): readonly TableLiteralCell[] {
  return mirror.cells.filter((cell) => !cell.merged_away && isFactRole(cell.role));
}

// ---------------------------------------------------------------------------
// 反解：表字面量 → 数据（同版更新的独立读数）
// ---------------------------------------------------------------------------

function desync(message: string): TableChartPartsError {
  return new TableChartPartsError('table_fact_desync', message);
}

/**
 * 把表字面量**反解**回图表数据（`tableMirrorFromChartData` 的逆）。
 *
 * 只读源格（延续格为空）；数据格缺失 / 重复 / 缺下标 ⇒ `table_fact_desync`，
 * 不拼出一份看似完整的错数据。
 */
export function chartDataFromTableLiterals(mirror: TableFactMirror): ExpectedChartData {
  const seriesNameBy = new Map<number, string>();
  const categoryBy = new Map<number, string>();
  const valueBy = new Map<string, number>();

  for (const cell of mirror.cells) {
    if (cell.merged_away) continue;
    switch (cell.role) {
      case 'series_name': {
        if (cell.series_index === null || cell.text === null) {
          throw desync(`系列名格 ${cell.a1} 缺系列下标或文本`);
        }
        if (seriesNameBy.has(cell.series_index)) {
          throw desync(`系列 ${String(cell.series_index)} 的名格登记了两次`);
        }
        seriesNameBy.set(cell.series_index, cell.text);
        break;
      }
      case 'category': {
        if (cell.category_index === null || cell.text === null) {
          throw desync(`类别格 ${cell.a1} 缺类别下标或文本`);
        }
        if (categoryBy.has(cell.category_index)) {
          throw desync(`类别 ${String(cell.category_index)} 登记了两次`);
        }
        categoryBy.set(cell.category_index, cell.text);
        break;
      }
      case 'value': {
        if (cell.series_index === null || cell.category_index === null || cell.value === null) {
          throw desync(`数值格 ${cell.a1} 缺系列/类别下标或数值`);
        }
        const key = `${String(cell.series_index)}:${String(cell.category_index)}`;
        if (valueBy.has(key)) {
          throw desync(`数值格 ${cell.a1} 与另一格指向同一 (系列, 类别)`);
        }
        valueBy.set(key, cell.value);
        break;
      }
      case 'title':
      case 'header':
        break;
    }
  }

  const seriesCount = seriesNameBy.size;
  const categoryCount = categoryBy.size;
  if (seriesCount === 0) throw desync('表里没有任何系列名格');
  if (categoryCount === 0) throw desync('表里没有任何类别格');

  const categories: string[] = [];
  for (let index = 0; index < categoryCount; index += 1) {
    const text = categoryBy.get(index);
    if (text === undefined) throw desync(`类别下标 ${String(index)} 没有对应格`);
    categories.push(text);
  }

  const series: ExpectedSeries[] = [];
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    const name = seriesNameBy.get(seriesIndex);
    if (name === undefined) throw desync(`系列下标 ${String(seriesIndex)} 没有名格`);
    const values: number[] = [];
    for (let categoryIndex = 0; categoryIndex < categoryCount; categoryIndex += 1) {
      const value = valueBy.get(`${String(seriesIndex)}:${String(categoryIndex)}`);
      if (value === undefined) {
        throw desync(`系列 ${String(seriesIndex)} 的类别 ${String(categoryIndex)} 缺数值格`);
      }
      values.push(value);
    }
    series.push({ name, values });
  }

  return { categories, series };
}

/** 从表字面量**独立复算**的 `dc1-*` 指纹（不拿快照的 version 自证）。 */
export function tableFactVersionOf(mirror: TableFactMirror): string {
  return dataVersionOf(chartDataFromTableLiterals(mirror));
}

// ---------------------------------------------------------------------------
// 复核：表侧同版
// ---------------------------------------------------------------------------

/** 表侧一致性的可复核计数。 */
export interface TableFactCoherenceReport {
  readonly version: string;
  readonly series_count: number;
  readonly category_count: number;
  /** 承担事实的源格数（系列名 + 类别 + 数值）。 */
  readonly literal_cell_count: number;
  /** 被合并吞掉的延续格数。 */
  readonly merged_cell_count: number;
}

function assertTableDataMatches(actual: ExpectedChartData, expected: ExpectedChartData): void {
  if (actual.categories.length !== expected.categories.length) {
    throw desync(
      `表字面量反解出 ${String(actual.categories.length)} 个类别，数据是 ${String(expected.categories.length)} 个`,
    );
  }
  actual.categories.forEach((text, index) => {
    if (text !== expected.categories[index]) {
      throw desync(`类别 ${String(index)} 在表上是 ${text}，数据是 ${String(expected.categories[index])}`);
    }
  });
  if (actual.series.length !== expected.series.length) {
    throw desync(
      `表字面量反解出 ${String(actual.series.length)} 个系列，数据是 ${String(expected.series.length)} 个`,
    );
  }
  actual.series.forEach((series, seriesIndex) => {
    const want = expected.series[seriesIndex];
    if (want === undefined) return;
    if (series.name !== want.name) {
      throw desync(`系列 ${String(seriesIndex)} 在表上是 ${series.name}，数据是 ${want.name}`);
    }
    series.values.forEach((value, categoryIndex) => {
      if (value !== want.values[categoryIndex]) {
        throw desync(
          `系列 ${want.name} 的类别 ${String(categoryIndex)}：表上 ${String(value)}，数据 ${String(want.values[categoryIndex])}`,
        );
      }
    });
  });
}

/**
 * **表侧同版复核**：把表镜独立读回，与期望数据比对。
 *
 * 1. 表指纹 ≠ `dataVersionOf(data)` ⇒ `version_mismatch`；
 * 2. 合并区覆盖了多个事实格 / 事实格不在源格 ⇒ `table_merge_conflict`；
 * 3. 表字面量反解出的数据 ≠ 数据 ⇒ `table_fact_desync`（半更新的表）；
 * 4. 任一格的指纹戳 ≠ 表指纹 ⇒ `version_mismatch`；
 * 5. 每格的合并来源 / `merged_away` / 事实引用必须与**复算**的覆盖一致
 *    —— 合并一变，引用必须跟着**迁移**，否则 `table_fact_desync`。
 */
export function verifyTableFactCoherence(
  mirror: TableFactMirror,
  expected: ExpectedChartData,
): TableFactCoherenceReport {
  const expectedVersion = dataVersionOf(expected);
  if (mirror.version !== expectedVersion) {
    throw new TableChartPartsError(
      'version_mismatch',
      `表指纹 ${mirror.version} 与数据的指纹 ${expectedVersion} 不一致`,
    );
  }

  if (mirror.cells.length !== mirror.row_count * mirror.column_count) {
    throw desync(
      `表有 ${String(mirror.cells.length)} 格，网格是 ${String(mirror.row_count)}×${String(mirror.column_count)}`,
    );
  }

  const coverage = buildMergeCoverage(
    mirror.row_count,
    mirror.column_count,
    effectiveMergesOf(mirror.title, mirror.column_count, mirror.merges),
  );

  const cellByPos = new Map<string, TableLiteralCell>();
  for (const cell of mirror.cells) {
    cellByPos.set(`${String(cell.row)},${String(cell.col)}`, cell);
  }

  // ② 合并事实安全：一个合并区至多认领 1 个事实格，且必须是左上角源格。
  for (const region of coverage.regions) {
    let factOrigins = 0;
    let factAtOrigin = false;
    for (let row = region.row; row < region.row + region.row_span; row += 1) {
      for (let col = region.col; col < region.col + region.col_span; col += 1) {
        const cell = cellByPos.get(`${String(row)},${String(col)}`);
        if (cell === undefined || cell.merged_away || !isFactRole(cell.role)) continue;
        factOrigins += 1;
        if (row === region.row && col === region.col) factAtOrigin = true;
      }
    }
    if (factOrigins === 0) continue;
    if (factOrigins > 1 || !factAtOrigin) {
      throw new TableChartPartsError(
        'table_merge_conflict',
        `合并区 (${String(region.row)},${String(region.col)}) 认领了 ${String(factOrigins)} 个事实格且源格不符（事实 ${factAtOrigin ? '位于源格' : '不在源格'}）`,
      );
    }
  }

  // ③ 表字面量反解 == 数据。
  const decoded = chartDataFromTableLiterals(mirror);
  assertTableDataMatches(decoded, expected);

  // ④ 逐格版本戳 + ⑤ 来源 / 迁移复核。
  let mergedCount = 0;
  for (const cell of mirror.cells) {
    if (cell.version !== mirror.version) {
      throw new TableChartPartsError(
        'version_mismatch',
        `格 ${cell.a1} 的指纹 ${cell.version} 与表指纹 ${mirror.version} 不一致`,
      );
    }
    const cov = coverage.sources[cell.row]?.[cell.col];
    if (cov === undefined) throw desync(`格 ${cell.a1} 不在复算的覆盖里`);
    if (cell.source.row !== cov.row || cell.source.col !== cov.col) {
      throw desync(`格 ${cell.a1} 的来源 (${cell.source.row},${cell.source.col}) 与复算的 (${cov.row},${cov.col}) 不符`);
    }
    const isAway = cov.row !== cell.row || cov.col !== cell.col;
    if (cell.merged_away !== isAway) {
      throw desync(`格 ${cell.a1} 的 merged_away=${String(cell.merged_away)} 与复算 ${String(isAway)} 不符`);
    }
    if (isAway) {
      mergedCount += 1;
      const origin = cellByPos.get(`${String(cov.row)},${String(cov.col)}`);
      if (origin === undefined) throw desync(`格 ${cell.a1} 的源格不存在`);
      if (
        cell.role !== origin.role ||
        cell.series_index !== origin.series_index ||
        cell.category_index !== origin.category_index
      ) {
        throw desync(`格 ${cell.a1} 的事实引用未迁移到源格 ${origin.a1}`);
      }
    }
  }

  return Object.freeze({
    version: mirror.version,
    series_count: decoded.series.length,
    category_count: decoded.categories.length,
    literal_cell_count: tableFactCells(mirror).length,
    merged_cell_count: mergedCount,
  });
}
