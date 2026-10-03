/**
 * P06 · **数据变更时的同版更新**（chart data ↔ embedded workbook，edit coherence）。
 *
 * ## 这一层解决什么
 *
 * `consistency.ts` 校验的是**一份静态快照**：图上的点与它引用的数据点一致。
 * 但 PPT-09 真正要的是「**数据可编辑**」：用户改了某个系列的一个值，图上的柱子和
 * 内嵌工作簿（PowerPoint 里「编辑数据」打开的那张表）**必须一起变**，而且变到
 * **同一个版本**。一个改了、另一个没改 = 打开就是自相矛盾的图。
 *
 * 本模块把「同一次数据」**同时**投影成四样东西，并保证它们同源：
 *
 * 1. `ChartSeriesReference[]` —— 图上点的引用（`consistency.ts` 的判据对象）；
 * 2. `WorkbookCell[]` —— 内嵌工作簿里**逐格**要写的内容（地址 / 角色 / 值）；
 * 3. `TableFactMirror` —— **表格侧字面量**（`table-facts.ts`），含合并单元格与事实引用迁移，
 *    盖同一枚指纹（PI08：补 P06 留下的表侧缺口，PPT-16「文本 / 图表 / 表格一致」）；
 * 4. `version` —— 数据的确定性指纹（`dataVersionOf`），用于判断"是不是同版"。
 *
 * 四者都由一个 `ExpectedChartData` **派生**（`snapshotChartData`）；任何编辑
 * （`applyDataEdit`）走的是"改数据 → 重新派生全部四样"，因此**不可能**只更新一半。
 * `verifyChartDataCoherence` 再独立地把它们**交叉读回**：把 cells 反解成数据、
 * 与 references 逐点比对、把表字面量反解回数据、复算 version——半更新 ⇒ 具名报错。
 *
 * ## 布局口径（与 `charts.ts` 的 `renderEmbeddedWorkbookBytes` 一致，用例交叉断言）
 *
 * - 第 1 行：`B1`, `C1`, … = 各系列名；
 * - 第 2..n+1 行：`A` 列 = 类别，`B`, `C`, … = 各系列的值。
 *
 * ## 边界（**未**做的事）
 *
 * - 只做**单工作表**（`Sheet1`）的矩形数据区；多表 / 定义名 / 共享字符串表不做；
 * - 只改**数据**（类别文本 / 系列名 / 点值）；不改图表类型、坐标轴、样式；
 * - 只产出**描述符**，不写 ZIP 字节——真实 XLSX 由 `charts.ts` 渲染，本层用其字节
 *   做交叉断言（见 P06 用例），但本模块不在运行期 import `charts.ts`。
 */

import { TableChartPartsError } from './errors.js';
import {
  columnLetter,
  parseA1Reference,
  seriesReferenceFor,
  verifySeriesConsistency,
  type ChartSeriesReference,
  type ExpectedChartData,
  type SeriesConsistencyReport,
} from './consistency.js';
import {
  dataVersionOf,
  tableCellAt,
  tableMirrorFromChartData,
  validateChartData,
  verifyTableFactCoherence,
  type TableCellEdit,
  type TableFactMirror,
  type TableMirrorOptions,
} from './table-facts.js';

// ---------------------------------------------------------------------------
// 数据形态校验（`validateChartData` 与 `dataVersionOf` 已上移到 `table-facts.ts`
// 的**事实核心**，使表格侧投影与编辑引擎共用唯一实现；此处经 `snapshotChartData` 调用，
// 不再在本文件重新导出——公开出口 `index.ts` 由 `./table-facts.js` 提供它们。）
// ---------------------------------------------------------------------------

/** 深拷贝成可变的工作态（原快照保持不可变）。 */
function mutableChartData(data: ExpectedChartData): { categories: string[]; series: { name: string; values: number[] }[] } {
  return {
    categories: [...data.categories],
    series: data.series.map((series) => ({ name: series.name, values: [...series.values] })),
  };
}

// ---------------------------------------------------------------------------
// 内嵌工作簿的逐格描述符
// ---------------------------------------------------------------------------

/** 内嵌工作表里一格的角色。 */
export type WorkbookCellRole = 'series_name' | 'category' | 'value';

/** 内嵌工作簿里**一格**要写的内容（地址 = 真 XLSX 里的 A1 地址）。 */
export interface WorkbookCell {
  /** A1 地址（如 `B1` / `A2` / `C3`）。 */
  readonly address: string;
  /** 列名（如 `B`）。 */
  readonly column: string;
  /** 行号（1 基）。 */
  readonly row: number;
  readonly role: WorkbookCellRole;
  /** `series_name` / `value` 格的系列下标；`category` 格为 `null`。 */
  readonly series_index: number | null;
  /** `category` / `value` 格的类别下标；`series_name` 格为 `null`。 */
  readonly category_index: number | null;
  /** `series_name` / `category` 格的文本；`value` 格为 `null`。 */
  readonly text: string | null;
  /** `value` 格的数值；其余为 `null`。 */
  readonly value: number | null;
}

function freezeCell(
  address: string,
  column: string,
  row: number,
  role: WorkbookCellRole,
  series_index: number | null,
  category_index: number | null,
  text: string | null,
  value: number | null,
): WorkbookCell {
  return Object.freeze({ address, column, row, role, series_index, category_index, text, value });
}

/**
 * 把**一份图表数据**逐格摊成内嵌工作簿的写值描述符（口径同
 * `charts.ts` 的 `renderEmbeddedWorkbookBytes`）。
 *
 * 顺序稳定：先全部系列名格（第 1 行），再逐行（类别格 + 各值格）。
 */
export function workbookCellsFromChartData(data: ExpectedChartData): readonly WorkbookCell[] {
  validateChartData(data);
  const cells: WorkbookCell[] = [];

  data.series.forEach((series, index) => {
    const column = columnLetter(index + 1);
    cells.push(freezeCell(`${column}1`, column, 1, 'series_name', index, null, series.name, null));
  });

  data.categories.forEach((category, rowIndex) => {
    const row = rowIndex + 2;
    cells.push(freezeCell(`A${String(row)}`, 'A', row, 'category', null, rowIndex, category, null));
    data.series.forEach((series, index) => {
      const column = columnLetter(index + 1);
      cells.push(
        freezeCell(`${column}${String(row)}`, column, row, 'value', index, rowIndex, null, series.values[rowIndex] ?? null),
      );
    });
  });

  return Object.freeze(cells);
}

/**
 * 把逐格描述符**反解**回图表数据（`workbookCellsFromChartData` 的逆）。
 *
 * 反解是"同版更新"的独立读数：若描述符只更新了一半（缺格 / 重复格 / 地址与列行不符），
 * 这里会**具名报错**（`incomplete_workbook_cells`），而不是拼出一份看似完整的错数据。
 */
export function chartDataFromWorkbookCells(cells: readonly WorkbookCell[]): ExpectedChartData {
  const seriesNameBy = new Map<number, string>();
  const categoryBy = new Map<number, string>();
  const valueBy = new Map<string, number>();

  for (const cell of cells) {
    assertCellAddress(cell);
    switch (cell.role) {
      case 'series_name': {
        if (cell.series_index === null || cell.text === null) {
          throw new TableChartPartsError('incomplete_workbook_cells', `系列名格 ${cell.address} 缺系列下标或文本`);
        }
        if (seriesNameBy.has(cell.series_index)) {
          throw new TableChartPartsError('incomplete_workbook_cells', `系列 ${String(cell.series_index)} 的名格登记了两次`);
        }
        seriesNameBy.set(cell.series_index, cell.text);
        break;
      }
      case 'category': {
        if (cell.category_index === null || cell.text === null) {
          throw new TableChartPartsError('incomplete_workbook_cells', `类别格 ${cell.address} 缺类别下标或文本`);
        }
        if (categoryBy.has(cell.category_index)) {
          throw new TableChartPartsError('incomplete_workbook_cells', `类别 ${String(cell.category_index)} 登记了两次`);
        }
        categoryBy.set(cell.category_index, cell.text);
        break;
      }
      case 'value': {
        if (cell.series_index === null || cell.category_index === null || cell.value === null) {
          throw new TableChartPartsError('incomplete_workbook_cells', `数值格 ${cell.address} 缺系列/类别下标或数值`);
        }
        const key = `${String(cell.series_index)}:${String(cell.category_index)}`;
        if (valueBy.has(key)) {
          throw new TableChartPartsError('incomplete_workbook_cells', `数值格 ${cell.address} 与另一格指向同一 (系列, 类别)`);
        }
        valueBy.set(key, cell.value);
        break;
      }
    }
  }

  const seriesCount = seriesNameBy.size;
  const categoryCount = categoryBy.size;
  if (seriesCount === 0) throw new TableChartPartsError('incomplete_workbook_cells', '没有任何系列名格');
  if (categoryCount === 0) throw new TableChartPartsError('incomplete_workbook_cells', '没有任何类别格');

  const categories: string[] = [];
  for (let index = 0; index < categoryCount; index += 1) {
    const text = categoryBy.get(index);
    if (text === undefined) {
      throw new TableChartPartsError('incomplete_workbook_cells', `类别下标 ${String(index)} 没有对应格`);
    }
    categories.push(text);
  }

  const series: { name: string; values: number[] }[] = [];
  for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
    const name = seriesNameBy.get(seriesIndex);
    if (name === undefined) {
      throw new TableChartPartsError('incomplete_workbook_cells', `系列下标 ${String(seriesIndex)} 没有名格`);
    }
    const values: number[] = [];
    for (let categoryIndex = 0; categoryIndex < categoryCount; categoryIndex += 1) {
      const value = valueBy.get(`${String(seriesIndex)}:${String(categoryIndex)}`);
      if (value === undefined) {
        throw new TableChartPartsError(
          'incomplete_workbook_cells',
          `系列 ${String(seriesIndex)} 的类别 ${String(categoryIndex)} 缺数值格`,
        );
      }
      values.push(value);
    }
    series.push({ name, values });
  }

  return { categories, series };
}

/** 地址必须与登记的列名 / 行号一致（挡住"地址被改、列行没改"的错位格）。 */
function assertCellAddress(cell: WorkbookCell): void {
  let parsed;
  try {
    parsed = parseA1Reference(cell.address);
  } catch {
    throw new TableChartPartsError('incomplete_workbook_cells', `数值格地址 ${cell.address} 不是合法 A1`);
  }
  if (columnLetter(parsed.col_start) !== cell.column || parsed.row_start + 1 !== cell.row) {
    throw new TableChartPartsError(
      'incomplete_workbook_cells',
      `格 ${cell.address} 的列/行（${cell.column}${String(cell.row)}）与地址不符`,
    );
  }
}

// ---------------------------------------------------------------------------
// 快照：一次数据 → 四样同源投影（图引用 / 工作簿格 / 表字面量 / 指纹）
// ---------------------------------------------------------------------------

/** 造快照的选项：表侧的标题 / 合并布局（不改数据指纹）。 */
export interface ChartDataOptions {
  readonly table?: TableMirrorOptions;
}

/**
 * 一份图表数据的**同版快照**：数据 / 工作簿格 / 图上引用 / **表字面量** / 版本指纹，
 * 五者同源。
 */
export interface ChartDataSnapshot {
  readonly data: ExpectedChartData;
  readonly cells: readonly WorkbookCell[];
  readonly references: readonly ChartSeriesReference[];
  /** 表格侧投影（含合并与事实引用迁移），盖与 `version` 逐字相同的 `dc1-*` 指纹。 */
  readonly table: TableFactMirror;
  readonly version: string;
}

/**
 * 由**一份数据**派生快照：cells、references、table、version 全部现算自同一份数据。
 * 这正是"改了数据就一起变"的机制——不存在"只更新图不更新表"的代码路径。
 */
export function snapshotChartData(
  data: ExpectedChartData,
  options: ChartDataOptions = {},
): ChartDataSnapshot {
  validateChartData(data);
  const normalized: ExpectedChartData = {
    categories: [...data.categories],
    series: data.series.map((series) => ({ name: series.name, values: [...series.values] })),
  };
  const cells = workbookCellsFromChartData(normalized);
  const references = normalized.series.map((series, index) => {
    const layout = seriesReferenceFor(index, normalized.categories.length);
    return Object.freeze({
      name: series.name,
      name_ref: layout.name_ref,
      category_ref: layout.category_ref,
      value_ref: layout.value_ref,
      points: Object.freeze([...series.values]),
    }) satisfies ChartSeriesReference;
  });
  const table = tableMirrorFromChartData(normalized, options.table);
  return Object.freeze({
    data: normalized,
    cells,
    references: Object.freeze(references),
    table,
    version: dataVersionOf(normalized),
  });
}

/** 从既有快照恢复表侧布局选项，使编辑后仍按同一布局重派生（合并 / 标题不丢）。 */
function tableOptionsOf(snapshot: ChartDataSnapshot): ChartDataOptions {
  const table = snapshot.table;
  return {
    table: table.title === null ? { merges: table.merges } : { title: table.title, merges: table.merges },
  };
}

// ---------------------------------------------------------------------------
// 编辑：改数据 → 重新派生全部
// ---------------------------------------------------------------------------

/** 一次数据编辑（PPT-09「改数据」的最小语义）。 */
export type ChartDataEdit =
  | { readonly kind: 'replace'; readonly data: ExpectedChartData }
  | { readonly kind: 'set_value'; readonly series_index: number; readonly category_index: number; readonly value: number }
  | { readonly kind: 'set_category'; readonly category_index: number; readonly text: string }
  | { readonly kind: 'set_series_name'; readonly series_index: number; readonly name: string };

function requireIndex(index: number, limit: number, what: string): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= limit) {
    throw new TableChartPartsError('unknown_edit_target', `${what}下标 ${String(index)} 越界（共 ${String(limit)} 个）`);
  }
}

/**
 * 施加一次编辑，返回**新的快照**（含新的 cells / references / version）。
 *
 * 原快照**不被修改**（深拷贝后改）；越界下标 ⇒ `unknown_edit_target`；改完的数据形态
 * 非法（如空系列）⇒ `invalid_chart_data`。因为新快照总是整份重派生，cells 与 references
 * 天然同版。
 */
export function applyDataEdit(snapshot: ChartDataSnapshot, edit: ChartDataEdit): ChartDataSnapshot {
  if (edit.kind === 'replace') {
    return snapshotChartData(edit.data, tableOptionsOf(snapshot));
  }
  const next = mutableChartData(snapshot.data);
  switch (edit.kind) {
    case 'set_value': {
      const series = next.series[edit.series_index];
      if (series === undefined) {
        throw new TableChartPartsError('unknown_edit_target', `没有系列下标 ${String(edit.series_index)}`);
      }
      requireIndex(edit.category_index, next.categories.length, '类别');
      series.values[edit.category_index] = edit.value;
      break;
    }
    case 'set_category': {
      requireIndex(edit.category_index, next.categories.length, '类别');
      next.categories[edit.category_index] = edit.text;
      break;
    }
    case 'set_series_name': {
      const series = next.series[edit.series_index];
      if (series === undefined) {
        throw new TableChartPartsError('unknown_edit_target', `没有系列下标 ${String(edit.series_index)}`);
      }
      series.name = edit.name;
      break;
    }
  }
  return snapshotChartData(next, tableOptionsOf(snapshot));
}

/**
 * 把一次**表格格编辑**翻译成图表数据编辑——**表 → 图**的引用迁移。
 *
 * 编辑落在合并**延续格**上时，沿覆盖矩阵迁移到**源格**，由源格的事实引用决定改哪个
 * 系列 / 类别（OOXML 的字面量就在源格）。装饰格（标题 / 角格）不对应任何事实点，
 * 具名抛 `unknown_table_cell`；值 / 文本类型不匹配同样具名报错。
 */
export function chartEditForTableCell(mirror: TableFactMirror, edit: TableCellEdit): ChartDataEdit {
  const cell = tableCellAt(mirror, edit.row, edit.col);
  const source = tableCellAt(mirror, cell.source.row, cell.source.col);
  switch (source.role) {
    case 'value': {
      if (edit.kind !== 'set_value') {
        throw new TableChartPartsError('unknown_table_cell', `数值格 ${source.a1} 只接受 set_value 编辑`);
      }
      if (source.series_index === null || source.category_index === null) {
        throw new TableChartPartsError('unknown_table_cell', `数值格 ${source.a1} 缺系列 / 类别下标`);
      }
      return {
        kind: 'set_value',
        series_index: source.series_index,
        category_index: source.category_index,
        value: edit.value,
      };
    }
    case 'category': {
      if (edit.kind !== 'set_text') {
        throw new TableChartPartsError('unknown_table_cell', `类别格 ${source.a1} 只接受 set_text 编辑`);
      }
      if (source.category_index === null) {
        throw new TableChartPartsError('unknown_table_cell', `类别格 ${source.a1} 缺类别下标`);
      }
      return { kind: 'set_category', category_index: source.category_index, text: edit.text };
    }
    case 'series_name': {
      if (edit.kind !== 'set_text') {
        throw new TableChartPartsError('unknown_table_cell', `系列名格 ${source.a1} 只接受 set_text 编辑`);
      }
      if (source.series_index === null) {
        throw new TableChartPartsError('unknown_table_cell', `系列名格 ${source.a1} 缺系列下标`);
      }
      return { kind: 'set_series_name', series_index: source.series_index, name: edit.text };
    }
    case 'title':
    case 'header':
      throw new TableChartPartsError(
        'unknown_table_cell',
        `格 ${source.a1} 是${source.role === 'title' ? '标题' : '角格'}，不对应任何图表事实点`,
      );
    default:
      throw new TableChartPartsError('unknown_table_cell', `格 ${source.a1} 的角色无法迁移到图表事实`);
  }
}

/**
 * 施加一次**表格格编辑**：经 `chartEditForTableCell` 迁移到图表事实，再整份重派生。
 * 返回的新快照里，图引用、工作簿格、表字面量一起变，指纹只变**一次**。
 */
export function applyTableCellEdit(snapshot: ChartDataSnapshot, edit: TableCellEdit): ChartDataSnapshot {
  return applyDataEdit(snapshot, chartEditForTableCell(snapshot.table, edit));
}

/** 从工作簿格**独立复算**的 `dc1-*` 指纹（不拿快照的 version 自证）。 */
export function workbookVersionOf(cells: readonly WorkbookCell[]): string {
  return dataVersionOf(chartDataFromWorkbookCells(cells));
}

// ---------------------------------------------------------------------------
// 一致性复核：图 / 工作簿 / 表 / 指纹交叉读回
// ---------------------------------------------------------------------------

/** 一致性复核报告（供用例直接断言计数）。 */
export interface ChartDataCoherenceReport {
  readonly version: string;
  readonly series_count: number;
  readonly category_count: number;
  readonly cell_count: number;
  readonly reference_point_count: number;
}

function assertSameChartData(actual: ExpectedChartData, expected: ExpectedChartData): void {
  if (actual.categories.length !== expected.categories.length) {
    throw new TableChartPartsError(
      'chart_data_desync',
      `工作簿格反解出 ${String(actual.categories.length)} 个类别，数据是 ${String(expected.categories.length)} 个`,
    );
  }
  actual.categories.forEach((text, index) => {
    if (text !== expected.categories[index]) {
      throw new TableChartPartsError(
        'chart_data_desync',
        `类别 ${String(index)} 在格上是 ${text}，数据是 ${String(expected.categories[index])}`,
      );
    }
  });
  if (actual.series.length !== expected.series.length) {
    throw new TableChartPartsError(
      'chart_data_desync',
      `工作簿格反解出 ${String(actual.series.length)} 个系列，数据是 ${String(expected.series.length)} 个`,
    );
  }
  actual.series.forEach((series, seriesIndex) => {
    const want = expected.series[seriesIndex];
    if (want === undefined) return; // 长度已校验
    if (series.name !== want.name) {
      throw new TableChartPartsError(
        'chart_data_desync',
        `系列 ${String(seriesIndex)} 在格上是 ${series.name}，数据是 ${want.name}`,
      );
    }
    series.values.forEach((value, categoryIndex) => {
      if (value !== want.values[categoryIndex]) {
        throw new TableChartPartsError(
          'chart_data_desync',
          `系列 ${want.name} 的类别 ${String(categoryIndex)}：格上 ${String(value)}，数据 ${String(want.values[categoryIndex])}`,
        );
      }
    });
  });
}

/**
 * **同版复核**：把快照的 cells / references / table / version **独立读回**与 data 比对。
 *
 * 1. 复算 `dataVersionOf(data)` ≠ 快照版本 ⇒ `version_mismatch`；
 * 2. 把 cells 反解成数据，必须与 data 相等 ⇒ 否则 `chart_data_desync`（半更新的表）；
 * 3. references 与 data 逐点一致 ⇒ 由 `verifySeriesConsistency` 抛具体原因
 *    （`point_value_mismatch` / `series_name_mismatch` …）（半更新的图）；
 * 4. 表格侧同版复核（`verifyTableFactCoherence`）⇒ 表字面量反解 ≠ 数据 / 合并事实不安全
 *    / 引用未迁移 / 指纹不符 ⇒ `table_fact_desync` / `table_merge_conflict` / `version_mismatch`。
 *
 * 四条都过 ⇒ 图、工作簿、表、版本是**同一份数据**。
 */
export function verifyChartDataCoherence(snapshot: ChartDataSnapshot): ChartDataCoherenceReport {
  const expectedVersion = dataVersionOf(snapshot.data);
  if (snapshot.version !== expectedVersion) {
    throw new TableChartPartsError(
      'version_mismatch',
      `快照版本 ${snapshot.version} 与数据的指纹 ${expectedVersion} 不一致`,
    );
  }
  const decoded = chartDataFromWorkbookCells(snapshot.cells);
  assertSameChartData(decoded, snapshot.data);

  const consistency: SeriesConsistencyReport = verifySeriesConsistency(snapshot.references, snapshot.data);

  // 表格侧：表字面量 / 合并引用迁移 / 指纹。
  verifyTableFactCoherence(snapshot.table, snapshot.data);

  return Object.freeze({
    version: snapshot.version,
    series_count: consistency.series_count,
    category_count: consistency.category_count,
    cell_count: snapshot.cells.length,
    reference_point_count: consistency.total_points,
  });
}
