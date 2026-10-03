/**
 * **X08**：透视金额的**独立复算与对账**（XLS-17「金额用独立算法复算」）。
 *
 * ## 为什么需要它
 *
 * `pivot.computePivotAggregate` 用 IEEE-754 双精度求和。浮点对钱不安全，但更危险的是
 * **它不会报错**——十个 `0.1` 相加得 `0.9999999999999999`，看起来"差不多对"。
 * 本模块拿 `aggregation/engine` 的**定点算法**从原始单元格**重新算一遍**，再和浮点结果
 * **逐格对**。两者的差异若不为零，就被判成 `mismatch` 并给出差值——**不设容差、不掩盖**。
 *
 * ## 对账的边界（如实登记）
 *
 * - 复算 `summarize_by ∈ {sum, average, min, max}` 的值字段（金额 / 数量场景）；`count` 只是
 *   计数、没有可复算的精度，被排除在本模块之外。
 * - 只对账参与复算的字段：`observed` 里的 `count` 格子不进入结果。`average` 走定点
 *   「精确求和 ÷ 个数 → 显式舍入到 `scale`」，`min` / `max` 取定点极值——三者与浮点侧
 *   独立算，浮点若落在定点网格之外（如 `1.666…` 在 `scale=0`）会被判成 `mismatch` 并给出原因。
 * - 只比对**两侧都出现的格子**；某一侧缺该键（如某组没有金额数值）时**不产生条目**——
 *   缺席不是 0，也不算差异。`exact_only` / `observed_only` 是防御性分支，正和的
 *   `sum` 路径不会触发，保留它们是为了在实现漂移时仍能说清哪一侧多、哪一侧少。
 * - 分组 / 筛选语义与 `computePivotAggregate` 对齐（首次出现顺序、页字段过滤），
 *   但**数值域完全不同**（`bigint` vs `number`），这才使对账有意义。
 */

import { ValidationError } from '../../protocol/index.js';
import {
  averageQuantities,
  compareQuantities,
  formatQuantity,
  maxQuantities,
  minQuantities,
  parseQuantity,
  subtractQuantities,
  sumQuantities,
  type Quantity,
  type QuantitySum,
  type RoundingMode,
} from '../quantity.js';
import type { PivotState, PivotSummary, PivotSummaryCell } from '../pivot.js';
import { blank, isNumericCell } from '../value.js';
import type { WorkbookState } from '../workbook.js';
import { labelOf, readSourceTable } from './engine.js';

/** 需要定点复算的汇总口径；`count` 被排除（它的定义就是"数了几个"，没有精度可言）。 */
type PrecisionOp = Exclude<PivotSummary, 'count'>;

/** 复算参数：金额的精度 / 单位 / 币种。 */
export interface RecomputeOptions {
  /** 最小单位精度（如"分" = 2）。 */
  readonly scale: number;
  readonly unit: string;
  readonly currency?: string | null;
  /** `average` 的舍入口径；缺省 `half_away_from_zero`（与 `aggregation/engine` 一致）。 */
  readonly average_rounding?: RoundingMode;
}

/** 一格的复算对账结果。 */
export interface PivotValueRecompute {
  readonly row_key: readonly string[];
  readonly column_key: readonly string[];
  readonly value_caption: string;
  /** 定点复算值（`null` = 该组没有数值）。 */
  readonly exact: Quantity | null;
  /** 浮点聚合值（`null` = `computePivotAggregate` 判为缺席）。 */
  readonly observed: number | null;
  readonly verdict: 'match' | 'mismatch' | 'both_absent' | 'exact_only' | 'observed_only';
  /** 两者都出现且不等时的定点差值文本；相等或单侧缺席时为 `null`。 */
  readonly drift: string | null;
}

const GROUP_SEP = '\u0001';
const KEY_SEP = '\u0000';
const CAPTION_SEP = '\u0002';

function groupKeyOf(rowKey: readonly string[], columnKey: readonly string[]): string {
  return `${rowKey.join(KEY_SEP)}${GROUP_SEP}${columnKey.join(KEY_SEP)}`;
}

function splitKey(part: string): readonly string[] {
  return part.length === 0 ? [] : part.split(KEY_SEP);
}

function parseMapKey(mapKey: string): {
  row_key: readonly string[];
  column_key: readonly string[];
  value_caption: string;
} {
  const [groupPart = '', caption = ''] = mapKey.split(CAPTION_SEP);
  const [rowPart = '', columnPart = ''] = groupPart.split(GROUP_SEP);
  return { row_key: splitKey(rowPart), column_key: splitKey(columnPart), value_caption: caption };
}

/**
 * 各口径的显示名前缀。**逐字复制** `pivot.pivotValueCaption` 的口径表——`observed` 是按
 * `pivotValueCaption` 建键的，两侧显示名必须一模一样才能对上；复制而非 import 是为了让本
 * 模块在运行时**不依赖** `pivot.ts`（两侧算法彼此独立）。
 */
const CAPTION_PREFIX: Readonly<Record<PrecisionOp, string>> = Object.freeze({
  sum: '求和项',
  average: '平均值项',
  min: '最小值项',
  max: '最大值项',
});

/** 值字段显示名（`caption` 优先），与 `pivot.pivotValueCaption` 同口径。 */
function precisionCaption(value: { field: string; caption?: string; op: PrecisionOp }): string {
  return value.caption ?? `${CAPTION_PREFIX[value.op]}:${value.field}`;
}

/**
 * 把一组的定点数值按口径折成一个数量。**列表非空**由调用点保证；空列表会走缺席分支、
 * 不会到这里。列表非空时唯一可能的失败是单位 / 币种不一致（请求错误），因此显式抛出。
 * @throws {ValidationError} 同一度量列出现单位 / 币种不一致
 */
function foldExact(
  op: PrecisionOp,
  list: readonly Quantity[],
  scale: number,
  rounding: RoundingMode,
): Quantity {
  let folded: QuantitySum;
  switch (op) {
    case 'sum':
      folded = sumQuantities(list);
      break;
    case 'min':
      folded = minQuantities(list);
      break;
    case 'max':
      folded = maxQuantities(list);
      break;
    case 'average':
      folded = averageQuantities(list, scale, rounding);
      break;
    default: {
      const never: never = op;
      throw new ValidationError(`未覆盖的复算口径：${String(never)}`);
    }
  }
  if (folded.ok) {
    return folded.quantity;
  }
  throw new ValidationError('recompute: 同一度量列出现单位 / 币种不一致');
}

/**
 * 对一张透视表的 `sum` / `average` / `min` / `max` 值字段做独立定点复算，并与浮点结果对账。
 *
 * @param observed `computePivotAggregate(workbook, pivot)` 的返回值（调用方传入，
 *   使本模块在运行时**不依赖** `pivot.ts`——两侧算法彼此独立）
 * @returns 每个 (行键 × 列键 × 值字段) 的对账条目
 * @throws {ValidationError} 来源 / 字段解析失败、scale 非法
 */
export function recomputePivotAmounts(
  workbook: WorkbookState,
  pivot: PivotState,
  observed: readonly PivotSummaryCell[],
  options: RecomputeOptions,
): readonly PivotValueRecompute[] {
  const currency = options.currency === undefined ? null : options.currency;
  const rounding: RoundingMode = options.average_rounding ?? 'half_away_from_zero';
  const precisionFields: { field: string; caption: string | undefined; op: PrecisionOp }[] = [];
  for (const value of pivot.values) {
    if (value.summarize_by === 'count') continue;
    precisionFields.push({ field: value.field, caption: value.caption, op: value.summarize_by });
  }
  if (precisionFields.length === 0) {
    return Object.freeze([]);
  }
  // 只对账参与复算的字段：observed 里还有 count 的格子，那不属于本模块范围，
  // 不能因为"浮点侧有、定点侧没有"就误报成 observed_only。
  const precisionCaptions = new Set(precisionFields.map((value) => precisionCaption(value)));
  const opByCaption = new Map<string, PrecisionOp>();
  for (const value of precisionFields) {
    opByCaption.set(precisionCaption(value), value.op);
  }

  const table = readSourceTable(workbook, pivot.source);
  const requireIndex = (field: string, where: string): number => {
    const index = table.headers.indexOf(field);
    if (index < 0) {
      throw new ValidationError(`recompute: ${where} 的字段 ${JSON.stringify(field)} 不在标题行`);
    }
    return index;
  };
  const rowIndexes = pivot.rows.map((field) => requireIndex(field, '行字段'));
  const columnIndexes = pivot.columns.map((field) => requireIndex(field, '列字段'));
  const filterIndexes = pivot.filters.map((filter) => ({
    index: requireIndex(filter.field, '筛选字段'),
    allowed: filter.values === undefined ? null : new Set(filter.values),
  }));
  const measureIndexes = precisionFields.map((value) => requireIndex(value.field, '值字段'));

  // 定点复算：mapKey → Quantity[]
  const exactByKey = new Map<string, Quantity[]>();
  for (const row of table.rows) {
    if (
      filterIndexes.some(
        (filter) => filter.allowed !== null && !filter.allowed.has(labelOf(row[filter.index] ?? blank)),
      )
    ) {
      continue;
    }
    const groupKey = groupKeyOf(
      rowIndexes.map((index) => labelOf(row[index] ?? blank)),
      columnIndexes.map((index) => labelOf(row[index] ?? blank)),
    );
    precisionFields.forEach((value, position) => {
      const cell = row[measureIndexes[position] as number] ?? blank;
      if (!isNumericCell(cell)) return;
      const mapKey = `${groupKey}${CAPTION_SEP}${precisionCaption(value)}`;
      const list = exactByKey.get(mapKey) ?? [];
      list.push(parseQuantity(cell.value, options.scale, options.unit, currency));
      exactByKey.set(mapKey, list);
    });
  }

  // 浮点侧：mapKey → observed number（保留浮点结果的顺序）
  const observedByKey = new Map<string, number>();
  const observedOrder: string[] = [];
  for (const cell of observed) {
    const groupKey = groupKeyOf(cell.row_key, cell.column_key);
    for (const [caption, value] of Object.entries(cell.values)) {
      if (!precisionCaptions.has(caption)) continue;
      const mapKey = `${groupKey}${CAPTION_SEP}${caption}`;
      if (!observedByKey.has(mapKey)) observedOrder.push(mapKey);
      observedByKey.set(mapKey, value);
    }
  }

  const results: PivotValueRecompute[] = [];
  const seen = new Set<string>();

  const emit = (mapKey: string): void => {
    if (seen.has(mapKey)) return;
    seen.add(mapKey);
    const { row_key, column_key, value_caption } = parseMapKey(mapKey);
    const list = exactByKey.get(mapKey);
    let exact: Quantity | null = null;
    if (list !== undefined && list.length > 0) {
      const op = opByCaption.get(value_caption);
      if (op === undefined) {
        throw new ValidationError(`recompute: 未知的值字段显示名 ${JSON.stringify(value_caption)}`);
      }
      exact = foldExact(op, list, options.scale, rounding);
    }
    const observedValue = observedByKey.has(mapKey) ? (observedByKey.get(mapKey) as number) : null;

    const base = { row_key, column_key, value_caption, exact, observed: observedValue };
    if (exact === null && observedValue === null) {
      results.push(Object.freeze({ ...base, verdict: 'both_absent', drift: null }));
      return;
    }
    if (exact === null) {
      results.push(Object.freeze({ ...base, verdict: 'observed_only', drift: null }));
      return;
    }
    if (observedValue === null) {
      results.push(Object.freeze({ ...base, verdict: 'exact_only', drift: null }));
      return;
    }
    let observedQuantity: Quantity;
    try {
      observedQuantity = parseQuantity(observedValue, options.scale, options.unit, currency);
    } catch {
      results.push(
        Object.freeze({
          ...base,
          verdict: 'mismatch',
          drift: `observed=${String(observedValue)} 在 scale=${String(options.scale)} 下不可表示（超出精度）`,
        }),
      );
      return;
    }
    const equal = compareQuantities(exact, observedQuantity) === 0;
    results.push(
      Object.freeze({
        ...base,
        verdict: equal ? 'match' : 'mismatch',
        drift: equal ? null : formatQuantity(subtractQuantities(exact, observedQuantity)),
      }),
    );
  };

  for (const mapKey of observedOrder) emit(mapKey);
  for (const mapKey of exactByKey.keys()) emit(mapKey);

  return Object.freeze(results);
}
