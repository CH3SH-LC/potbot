/**
 * **X08**：分组汇总的**精确执行引擎**（XLS-13 / XLS-17）。
 *
 * ## 与 `pivot.computePivotAggregate` 的关系：这是**独立算法**
 *
 * `pivot.ts` 的汇总走 `number`（IEEE-754 双精度）。那是透视表"渲染用"的口径，
 * 对钱不安全：十个 `0.1` 相加，浮点给 `0.9999999999999999`。本引擎走
 * **`bigint` 定点**（`quantity.ts`），从**原始单元格文本**重新解析十进制，
 * 全程不经浮点。因此两条路可以互相复算——`recompute.ts` 就是拿本引擎的结果
 * 去咬 `pivot.computePivotAggregate` 的浮点结果，差异必须**被判出来**而不是被容忍。
 *
 * ## 缺失不当零（R248）
 *
 * 一个分组里度量列**一个数值都没有**时，`sum` / `average` / `min` / `max` 的结果是
 * `{ kind: 'absent' }`——**不是 0**。空白格、文本格、错误格、公式格都不贡献数值，
 * 也都不被当成 0。唯一的例外是 `count`：它的定义就是"有几个非空数值"，0 是真结果。
 *
 * ## 未验证
 *
 * - 公式格的求值：本引擎**不**对 `formula` 单元格求值，只跳过（不计入数值）。
 *   要汇总公式结果需先经 `recalc` / `evaluate` 物化成数值格，那不在本包范围。
 */

import { ValidationError } from '../../protocol/index.js';
import { formatCellAddress, parseRange } from '../reference.js';
import { getSheet } from '../workbook.js';
import type { WorkbookState } from '../workbook.js';
import { blank, isNumericCell, type CellValue } from '../value.js';
import {
  averageQuantities,
  maxQuantities,
  minQuantities,
  parseQuantity,
  sumQuantities,
  type Quantity,
  type QuantitySum,
  type RoundingMode,
} from '../quantity.js';
import {
  assertAggregationSpec,
  validateAggregationSpec,
  type AggregationOp,
  type AggregationSource,
  type AggregationSpec,
} from './schema.js';

/** 一组的分组键（空数组 = 全体一行）。 */
export type AggregationKey = readonly string[];

/** 一组的汇总结果。 */
export type AggregationOutcome =
  | { readonly kind: 'quantity'; readonly quantity: Quantity }
  | { readonly kind: 'count'; readonly count: number }
  /** 该组度量列**没有任何数值**：`sum`/`average`/`min`/`max` 的真实缺席态（不是 0）。 */
  | { readonly kind: 'absent'; readonly reason: 'no_numeric_values' };

/** 一个分组的完整结果。 */
export interface AggregationGroupResult {
  readonly key: AggregationKey;
  /** 落进这一组的记录行数（含度量列空白的行）。 */
  readonly row_count: number;
  /** 度量列里真正是数值的格数。 */
  readonly numeric_count: number;
  readonly outcome: AggregationOutcome;
}

/** 单元格 → 分组键 / 标题用它时的显示文本（与 `pivot.ts` 的 `cellText` 同口径）。 */
export function labelOf(value: CellValue): string {
  switch (value.kind) {
    case 'text':
      return value.value;
    case 'number':
      return String(value.value);
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE';
    case 'date':
      return String(value.epoch_ms);
    case 'error':
      return value.code;
    case 'formula':
      return value.text;
    case 'blank':
      return '';
    default: {
      const never: never = value;
      throw new ValidationError(`未覆盖的取值：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 度量格 → 定点数量；非数值 / 空白 → `null`（**绝不返回 0**）。
 * `op === 'count'` 时不解析数量（计数不需要精度元数据）。
 */
function quantityOfCell(value: CellValue, spec: AggregationSpec): Quantity | null {
  if (!isNumericCell(value) || spec.op === 'count') {
    return null;
  }
  const scale = spec.scale ?? 0;
  const currency = spec.currency === undefined ? null : spec.currency;
  // 数值格经 String() 得到最短可往返十进制文本，再按定点解析。
  // String(0.1) === '0.1'，因此"写进去的十进制"与"读回来的十进制"一致；
  // 若某格底层已是浮点累加产物（如 0.30000000000000004），parseQuantity 会**显式拒绝**。
  return parseQuantity(value.value, scale, spec.unit ?? '', currency);
}

/** 来源区域读出的表：首行标题 + 其余记录。 */
export interface SourceTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

/** 从工作簿读来源区域：首行标题、其余记录。校验与 `pivot.parseSourceTable` 同强度。 */
export function readSourceTable(workbook: WorkbookState, source: AggregationSource): SourceTable {
  const sheet = getSheet(workbook, source.sheet);
  if (sheet === undefined) {
    throw new ValidationError(
      `aggregation.source 引用了工作簿里不存在的工作表 ${JSON.stringify(source.sheet)}`,
    );
  }
  const range = parseRange(source.range);
  if (range.end.row > sheet.row_count || range.end.column > sheet.column_count) {
    throw new ValidationError(
      `aggregation.source 的区域 ${JSON.stringify(source.range)} 超出工作表 ${JSON.stringify(source.sheet)} 的声明范围`,
    );
  }
  if (range.start.row === range.end.row) {
    throw new ValidationError('aggregation.source 的区域只有标题行、没有数据行');
  }
  const cellAt = (column: number, row: number): CellValue =>
    sheet.cells.get(formatCellAddress({ column, row })) ?? blank;

  const headers: string[] = [];
  for (let column = range.start.column; column <= range.end.column; column += 1) {
    const text = labelOf(cellAt(column, range.start.row));
    headers.push(text.length === 0 ? `列${String(column - range.start.column + 1)}` : text);
  }
  if (new Set(headers).size !== headers.length) {
    throw new ValidationError('aggregation.source 的标题行有重复字段名：字段名是分组与度量的身份，必须唯一');
  }

  const rows: CellValue[][] = [];
  for (let row = range.start.row + 1; row <= range.end.row; row += 1) {
    const values: CellValue[] = [];
    for (let column = range.start.column; column <= range.end.column; column += 1) {
      values.push(cellAt(column, row));
    }
    rows.push(values);
  }
  return Object.freeze({
    headers: Object.freeze(headers),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

function indexOfField(headers: readonly string[], field: string, where: string): number {
  const index = headers.indexOf(field);
  if (index < 0) {
    throw new ValidationError(
      `${where} 的字段 ${JSON.stringify(field)} 不在标题行里；可用字段：${headers.map((h) => JSON.stringify(h)).join(', ')}`,
    );
  }
  return index;
}

/** 把求和类结果折成结果口径。`unit_mismatch` 是请求错误，不当缺席。 */
function outcomeOfSum(sum: QuantitySum): AggregationOutcome {
  if (sum.ok) {
    return Object.freeze({ kind: 'quantity', quantity: sum.quantity });
  }
  if (sum.reason === 'unit_mismatch') {
    throw new ValidationError('分组汇总内部出现单位 / 币种不一致：同一度量列的取值必须同类');
  }
  return Object.freeze({ kind: 'absent', reason: 'no_numeric_values' });
}

/**
 * 执行一个分组汇总请求：按 `group_by` 分组，对 `measure` 列求 `op`。
 *
 * 分组顺序 = 首次出现顺序（确定、可复算）；空 `group_by` ⇒ 全体归为一组（键为 `[]`）。
 *
 * @throws {ValidationError} 请求不合法、工作表 / 区域 / 字段不存在
 */
export function aggregateRange(
  workbook: WorkbookState,
  spec: AggregationSpec,
): readonly AggregationGroupResult[] {
  assertAggregationSpec(spec);
  const table = readSourceTable(workbook, spec.source);
  const groupIndexes = spec.group_by.map((field) =>
    indexOfField(table.headers, field, 'aggregation.group_by'),
  );
  const measureIndex = indexOfField(table.headers, spec.measure, 'aggregation.measure');
  const op: AggregationOp = spec.op;
  const rounding: RoundingMode = spec.average_rounding ?? 'half_away_from_zero';
  const scale = spec.scale ?? 0;

  const order: string[] = [];
  const groups = new Map<
    string,
    { key: AggregationKey; quantities: Quantity[]; rowCount: number; numericCount: number }
  >();

  for (const row of table.rows) {
    const key = groupIndexes.map((index) => labelOf(row[index] ?? blank));
    const groupKey = JSON.stringify(key);
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { key, quantities: [], rowCount: 0, numericCount: 0 };
      groups.set(groupKey, group);
      order.push(groupKey);
    }
    group.rowCount += 1;
    const cell = row[measureIndex] ?? blank;
    if (!isNumericCell(cell)) {
      continue; // 空白/文本/错误/公式：不贡献数值，也不当 0
    }
    group.numericCount += 1;
    const quantity = quantityOfCell(cell, spec);
    if (quantity !== null) {
      group.quantities.push(quantity);
    }
  }

  return Object.freeze(
    order.map((groupKey) => {
      const group = groups.get(groupKey) as {
        key: AggregationKey;
        quantities: Quantity[];
        rowCount: number;
        numericCount: number;
      };
      let outcome: AggregationOutcome;
      switch (op) {
        case 'count':
          outcome = Object.freeze({ kind: 'count', count: group.numericCount });
          break;
        case 'sum':
          outcome = outcomeOfSum(sumQuantities(group.quantities));
          break;
        case 'min':
          outcome = outcomeOfSum(minQuantities(group.quantities));
          break;
        case 'max':
          outcome = outcomeOfSum(maxQuantities(group.quantities));
          break;
        case 'average':
          outcome = outcomeOfSum(averageQuantities(group.quantities, scale, rounding));
          break;
        default: {
          const never: never = op;
          throw new ValidationError(`未覆盖的汇总口径：${String(never)}`);
        }
      }
      return Object.freeze({
        key: Object.freeze([...group.key]),
        row_count: group.rowCount,
        numeric_count: group.numericCount,
        outcome,
      });
    }),
  );
}

export { validateAggregationSpec };
export type { AggregationSpec };
