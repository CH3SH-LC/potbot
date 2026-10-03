/**
 * P06 · **数值与图形一致性校验**（chart data ↔ series reference）。
 *
 * ## 这一层解决什么
 *
 * 一张"数据可编辑"的图，其**图上的点**与**它引用的数据点**必须一一对应：
 * 第 i 个系列引用 `Sheet1!$B$2:$B$4`，缓存里就必须有 3 个点，且第 k 个点等于
 * 工作簿 `B{2+k}` 的值；类别轴同理引 `Sheet1!$A$2:$A$4`。少一个点、错一位、
 * 类别引用与数值引用对不上同一批行——都要**具名报错**，而不是"大概齐地画出来"。
 *
 * 本模块把"期望序列"（类别 + 各系列值）作为**外部输入**，逐点比对描述符里**实际引用**
 * 的数据点：
 *
 * - 系列数 / 系列名 / 点数 / 点值 / 类别行区间 / 引用列号 —— 逐项校验；
 * - 引用形态用**真 A1 解析器**（`Sheet1!$B$2:$B$4`）读回来核，而不是字符串相等；
 * - 校验的是**引用与点位**，数值相等用**严格相等**（不做容差：同一份工作簿里的同一个数，
 *   差一位就是错）。
 *
 * ## 与 `charts.ts` 的口径如何对齐
 *
 * `charts.ts` 的嵌入工作簿布局是：第 1 行 = 各系列名（`B1`、`C1`…），
 * 第 2..n+1 行 `A` 列 = 类别，`B`、`C`… = 各系列值。`seriesReferenceFor` 按同一布局
 * 产出引用串，用例再拿**真实工作簿字节**里解析出的单元格地址与数值做交叉断言——本模块
 * **不** import `charts.ts`，两边一致靠用例证明，而非靠"写的时候用了同一个数组"。
 *
 * ## 边界（**未**做的事）
 *
 * - 只支持单工作表、`$` 绝对地址形态；多维 / 定义名 / 跨表引用不做；
 * - 不做浮点容差（同源同值必须严格相等）；
 * - 空点 / 空类别的 `dispBlanksAs` 语义不在本层。
 */

import { TableChartPartsError } from './errors.js';

// ---------------------------------------------------------------------------
// A1 引用解析
// ---------------------------------------------------------------------------

/** 解析后的单元格区域（行列下标均为 **0 基**）。 */
export interface CellRange {
  /** 工作表名（`Sheet1!` 之前的部分；无 `!` 则空串）。 */
  readonly sheet: string;
  readonly col_start: number;
  readonly row_start: number;
  readonly col_end: number;
  readonly row_end: number;
}

const A1_PATTERN = /^(?:(.+)!)?(\$?)([A-Za-z]+)(\$?)([0-9]+)(?::(\$?)([A-Za-z]+)(\$?)([0-9]+))?$/;

function columnIndex(letters: string): number {
  let value = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) {
      throw new TableChartPartsError('invalid_a1_reference', `列名 ${letters} 含非字母字符`);
    }
    value = value * 26 + (code - 64);
  }
  return value - 1;
}

/**
 * 解析 A1 引用，形如 `Sheet1!$A$2:$A$4`（单格 `Sheet1!$B$1` 亦可）。
 * 任何形态不符 ⇒ `invalid_a1_reference`（不猜、不部分解析）。
 */
export function parseA1Reference(reference: string): CellRange {
  if (typeof reference !== 'string') {
    throw new TableChartPartsError('invalid_a1_reference', `引用必须是字符串，收到 ${typeof reference}`);
  }
  const match = A1_PATTERN.exec(reference.trim());
  if (match === null) {
    throw new TableChartPartsError('invalid_a1_reference', `引用 ${reference} 不是合法的 A1 区域`);
  }
  const startCol = columnIndex(match[3] as string);
  const startRow = Number.parseInt(match[5] as string, 10) - 1;
  const endCol = match[7] === undefined ? startCol : columnIndex(match[7]);
  const endRow = match[9] === undefined ? startRow : Number.parseInt(match[9] as string, 10) - 1;
  if (endCol < startCol || endRow < startRow) {
    throw new TableChartPartsError('invalid_a1_reference', `引用 ${reference} 的区域是反的（终点在起点之前）`);
  }
  const sheet = match[1] ?? '';
  if (sheet.includes('!')) {
    throw new TableChartPartsError('invalid_a1_reference', `引用 ${reference} 的工作表名含 '!'`);
  }
  return Object.freeze({ sheet, col_start: startCol, row_start: startRow, col_end: endCol, row_end: endRow });
}

/** 区域覆盖的行数（含端点）。 */
export function rangeRowCount(range: CellRange): number {
  return range.row_end - range.row_start + 1;
}

/** 区域覆盖的列数（含端点）。 */
export function rangeColumnCount(range: CellRange): number {
  return range.col_end - range.col_start + 1;
}

// ---------------------------------------------------------------------------
// 系列引用描述符与期望序列
// ---------------------------------------------------------------------------

/**
 * 一个系列**实际引用**的数据点描述符。
 *
 * `name_ref` / `category_ref` / `value_ref` 是图表缓存里 `c:f` 的引用串；
 * `points` 是缓存/工作簿里**实际**的点值（按 `value_ref` 的行序）。
 */
export interface ChartSeriesReference {
  readonly name: string;
  readonly name_ref: string;
  readonly category_ref: string;
  readonly value_ref: string;
  readonly points: readonly number[];
}

/** 期望的一个系列。 */
export interface ExpectedSeries {
  readonly name: string;
  readonly values: readonly number[];
}

/** 期望的整张图数据（类别 + 各系列值）。 */
export interface ExpectedChartData {
  readonly categories: readonly string[];
  readonly series: readonly ExpectedSeries[];
}

/** 按 `charts.ts` 的嵌入工作簿布局，产出第 `seriesIndex` 个系列的三个引用串。 */
export function seriesReferenceFor(
  seriesIndex: number,
  categoryCount: number,
  sheet = 'Sheet1',
): { readonly name_ref: string; readonly category_ref: string; readonly value_ref: string } {
  if (!Number.isSafeInteger(seriesIndex) || seriesIndex < 0) {
    throw new TableChartPartsError('invalid_a1_reference', `系列下标非法：${String(seriesIndex)}`);
  }
  if (!Number.isSafeInteger(categoryCount) || categoryCount < 1) {
    throw new TableChartPartsError('invalid_a1_reference', `类别数非法：${String(categoryCount)}`);
  }
  const valueColumn = columnLetter(seriesIndex + 1);
  const lastRow = categoryCount + 1;
  const prefix = sheet === '' ? '' : `${sheet}!`;
  return Object.freeze({
    name_ref: `${prefix}$${valueColumn}$1`,
    category_ref: `${prefix}$A$2:$A$${String(lastRow)}`,
    value_ref: `${prefix}$${valueColumn}$2:$${valueColumn}$${String(lastRow)}`,
  });
}

/** 0 → A，1 → B，…（与 `charts.ts` 的 `columnLetter` 同口径，本模块独立实现）。 */
export function columnLetter(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TableChartPartsError('invalid_a1_reference', `列下标非法：${String(index)}`);
  }
  let remaining = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

// ---------------------------------------------------------------------------
// 一致性校验
// ---------------------------------------------------------------------------

/** 校验通过后的报告（供用例直接断言数量）。 */
export interface SeriesConsistencyReport {
  readonly series_count: number;
  readonly points_per_series: readonly number[];
  readonly total_points: number;
  readonly category_count: number;
  readonly sheet: string;
}

function assertFinite(label: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TableChartPartsError('point_value_mismatch', `${label} 必须是有限数，收到 ${String(value)}`);
  }
}

/**
 * 逐点校验"实际引用"与"期望序列"。
 *
 * 校验顺序（先定数量、再定形态、最后定值，保证错误原因稳定）：
 * 1. 引用里系列名不得重复 ⇒ `duplicate_series_name`；
 * 2. 系列数一致 ⇒ `series_count_mismatch`；
 * 3. 每个系列：名一致 ⇒ `series_name_mismatch`；引用形态（列号 / 行区间）⇒ `category_ref_mismatch`；
 *    点数一致 ⇒ `point_count_mismatch`；类别数 ⇒ `category_count_mismatch`；
 * 4. 逐点严格相等 ⇒ `point_value_mismatch`。
 */
export function verifySeriesConsistency(
  references: readonly ChartSeriesReference[],
  expected: ExpectedChartData,
): SeriesConsistencyReport {
  const names = new Set<string>();
  for (const reference of references) {
    if (names.has(reference.name)) {
      throw new TableChartPartsError('duplicate_series_name', `系列名 ${reference.name} 出现两次`);
    }
    names.add(reference.name);
  }
  if (references.length !== expected.series.length) {
    throw new TableChartPartsError(
      'series_count_mismatch',
      `图表有 ${String(references.length)} 个系列，期望 ${String(expected.series.length)} 个`,
    );
  }
  if (expected.categories.length === 0) {
    throw new TableChartPartsError('category_count_mismatch', '期望序列没有任何类别');
  }

  const pointsPerSeries: number[] = [];
  let sheet: string | null = null;

  references.forEach((reference, index) => {
    const want = expected.series[index];
    if (want === undefined) return; // 上面已保证长度一致

    if (reference.name !== want.name) {
      throw new TableChartPartsError(
        'series_name_mismatch',
        `第 ${String(index)} 个系列名是 ${reference.name}，期望 ${want.name}`,
      );
    }
    if (want.values.length !== expected.categories.length) {
      throw new TableChartPartsError(
        'category_count_mismatch',
        `系列 ${want.name} 有 ${String(want.values.length)} 个值，类别却有 ${String(expected.categories.length)} 个`,
      );
    }

    const valueRange = parseA1Reference(reference.value_ref);
    const categoryRange = parseA1Reference(reference.category_ref);
    const nameRange = parseA1Reference(reference.name_ref);

    if (sheet === null) sheet = valueRange.sheet;
    if (valueRange.sheet !== sheet || categoryRange.sheet !== sheet || nameRange.sheet !== sheet) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的引用跨了工作表：${valueRange.sheet} / ${categoryRange.sheet} / ${nameRange.sheet}`,
      );
    }
    if (rangeColumnCount(valueRange) !== 1) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的数值引用 ${reference.value_ref} 不是单列`,
      );
    }
    if (rangeColumnCount(categoryRange) !== 1) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的类别引用 ${reference.category_ref} 不是单列`,
      );
    }
    if (valueRange.col_start !== index + 1) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的数值引用落在第 ${String(valueRange.col_start)} 列，按布局应为第 ${String(index + 1)} 列（${columnLetter(index + 1)}）`,
      );
    }
    if (categoryRange.col_start !== 0) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的类别引用落在第 ${String(categoryRange.col_start)} 列，应为 A 列`,
      );
    }
    if (nameRange.row_start !== 0 || nameRange.col_start !== index + 1) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的系列名引用 ${reference.name_ref} 不在第 1 行 ${columnLetter(index + 1)} 列`,
      );
    }
    if (valueRange.row_start !== 1) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的数值引用从第 ${String(valueRange.row_start)} 行起，应为第 2 行`,
      );
    }
    if (rangeRowCount(valueRange) !== rangeRowCount(categoryRange)) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的数值引用 ${String(rangeRowCount(valueRange))} 行 ≠ 类别引用 ${String(rangeRowCount(categoryRange))} 行`,
      );
    }
    if (valueRange.row_end !== categoryRange.row_end) {
      throw new TableChartPartsError(
        'category_ref_mismatch',
        `系列 ${want.name} 的数值与类别引用行区间不重合（${reference.value_ref} vs ${reference.category_ref}）`,
      );
    }
    if (reference.points.length !== want.values.length) {
      throw new TableChartPartsError(
        'point_count_mismatch',
        `系列 ${want.name} 实际引用 ${String(reference.points.length)} 个点，期望 ${String(want.values.length)} 个`,
      );
    }
    if (rangeRowCount(valueRange) !== reference.points.length) {
      throw new TableChartPartsError(
        'point_count_mismatch',
        `系列 ${want.name} 的数值引用覆盖 ${String(rangeRowCount(valueRange))} 行，却带了 ${String(reference.points.length)} 个点`,
      );
    }

    reference.points.forEach((point, pointIndex) => {
      assertFinite(`系列 ${want.name} 的第 ${String(pointIndex + 1)} 个点`, point);
      const expectedValue = want.values[pointIndex];
      if (expectedValue === undefined) return; // 长度已校验
      assertFinite(`期望序列 ${want.name} 的第 ${String(pointIndex + 1)} 个值`, expectedValue);
      if (point !== expectedValue) {
        throw new TableChartPartsError(
          'point_value_mismatch',
          `系列 ${want.name} 的第 ${String(pointIndex + 1)} 个点（${reference.value_ref} 第 ${String(pointIndex)} 行）是 ${String(point)}，期望 ${String(expectedValue)}`,
        );
      }
    });
    pointsPerSeries.push(reference.points.length);
  });

  return Object.freeze({
    series_count: references.length,
    points_per_series: Object.freeze(pointsPerSeries),
    total_points: pointsPerSeries.reduce((sum, count) => sum + count, 0),
    category_count: expected.categories.length,
    sheet: sheet ?? '',
  });
}
