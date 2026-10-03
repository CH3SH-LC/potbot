/**
 * **X08**：分组汇总的**操作模式与类型**（XLS-13 / XLS-17 的"操作"侧）。
 *
 * 本文件只描述"一个分组汇总请求长什么样、哪些组合合法"——**不执行任何计算**。
 * 计算在 `engine.ts`，对账在 `recompute.ts`。把模式与执行分开，是为了让
 * "手机按模式校验请求"与"手机按请求算结果"各自可独立测试，也避免校验逻辑
 * 被埋进某个 `if` 里再也测不到。
 *
 * ## 为什么金额相关的操作必须显式声明 `scale` / `unit` / `currency`
 *
 * 一个 `sum` 若不知道精度与单位，就只能返回一个浮点数——那正是 XLS-17 禁止的
 * "把金额当成普通 double"。因此当 `op` 属于 `{sum,average,min,max,money}` 时，
 * `scale`（0…20 的整数）、`unit`（非空）、`currency`（可为 `null`）**必填**，
 * 缺一项就直接判为非法请求，而不是悄悄补个默认值。
 */

import { ValidationError } from '../../protocol/index.js';
import type { RoundingMode } from '../quantity.js';

/** 分组汇总口径。与 `PivotSummary` 同集合，保证透视与独立聚合说得是同一种话。 */
export type AggregationOp = 'sum' | 'count' | 'average' | 'min' | 'max';

/** 全部口径的稳定顺序（UI / 快照 / 校验都按它枚举）。 */
export const AGGREGATION_OPS: readonly AggregationOp[] = Object.freeze([
  'sum',
  'count',
  'average',
  'min',
  'max',
]);

/** 口径是否需要定点精度元数据（`count` 只是计数，不需要）。 */
export function opRequiresPrecision(op: AggregationOp): boolean {
  return op !== 'count';
}

/** 一个口径的模式描述。 */
export interface AggregationOpSchema {
  readonly op: AggregationOp;
  /** 是否消费度量列的**数值**（`count` 也消费，但只数个数）。 */
  readonly consumes_measure: boolean;
  /** 是否要求 `scale` / `unit` / `currency`。 */
  readonly requires_precision: boolean;
  /** 该口径下"这一组一个数值都没有"时的结果语义。 */
  readonly empty_semantics: 'absent' | 'count_zero';
}

/** 机器可读口径表。 */
export const AGGREGATION_OP_SCHEMA: Readonly<Record<AggregationOp, AggregationOpSchema>> =
  Object.freeze({
    sum: Object.freeze({
      op: 'sum',
      consumes_measure: true,
      requires_precision: true,
      empty_semantics: 'absent',
    }),
    count: Object.freeze({
      op: 'count',
      consumes_measure: true,
      requires_precision: false,
      empty_semantics: 'count_zero',
    }),
    average: Object.freeze({
      op: 'average',
      consumes_measure: true,
      requires_precision: true,
      empty_semantics: 'absent',
    }),
    min: Object.freeze({
      op: 'min',
      consumes_measure: true,
      requires_precision: true,
      empty_semantics: 'absent',
    }),
    max: Object.freeze({
      op: 'max',
      consumes_measure: true,
      requires_precision: true,
      empty_semantics: 'absent',
    }),
  });

/** 来源区域：`sheet` + A1 区域；**首行当标题**，与 `pivot.ts` 的来源约定一致。 */
export interface AggregationSource {
  readonly sheet: string;
  readonly range: string;
}

/** 一个分组汇总请求。 */
export interface AggregationSpec {
  /** 请求名（用于诊断，不参与计算）。 */
  readonly name: string;
  readonly source: AggregationSource;
  /** 分组字段名（标题行里的名字），可空表示"全体一行"。 */
  readonly group_by: readonly string[];
  /** 度量字段名（`count` 也用它决定"数什么"）。 */
  readonly measure: string;
  readonly op: AggregationOp;
  /** 定点精度（0…20）。`op !== 'count'` 时必填。 */
  readonly scale?: number;
  /** 单位。`op !== 'count'` 时必填。 */
  readonly unit?: string;
  /** 币种，`null` / 省略 = 未标注。 */
  readonly currency?: string | null;
  /** `average` 的舍入口径；缺省 `half_away_from_zero`（Excel `ROUND` 的口径）。 */
  readonly average_rounding?: RoundingMode;
}

const MAX_SCALE = 20;
const ROUNDING_MODES: readonly RoundingMode[] = Object.freeze([
  'half_away_from_zero',
  'half_even',
  'floor',
  'ceil',
  'truncate',
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 校验请求，返回**问题清单**（空数组 = 合法）。本函数**不抛**——
 * UI 与批量导入需要一次看到全部问题，而不是抛第一个就停。
 */
export function validateAggregationSpec(spec: AggregationSpec): readonly string[] {
  const issues: string[] = [];
  if (!isNonEmptyString(spec.name)) {
    issues.push('name 不能为空字符串');
  }
  if (spec.source === undefined || !isNonEmptyString(spec.source?.sheet)) {
    issues.push('source.sheet 不能为空字符串');
  }
  if (spec.source === undefined || !isNonEmptyString(spec.source?.range)) {
    issues.push('source.range 不能为空字符串');
  }
  if (!AGGREGATION_OPS.includes(spec.op)) {
    issues.push(`未知的汇总口径 ${JSON.stringify(spec.op)}；可选 ${AGGREGATION_OPS.join(' / ')}`);
    return Object.freeze(issues);
  }
  if (!isNonEmptyString(spec.measure)) {
    issues.push('measure 不能为空字符串');
  }
  if (spec.group_by.length > 0 && spec.group_by.some((field) => !isNonEmptyString(field))) {
    issues.push('group_by 里不能有空字段名');
  }
  if (new Set(spec.group_by).size !== spec.group_by.length) {
    issues.push('group_by 里有重复字段名：分组字段是分组键的身份，必须唯一');
  }
  if (spec.group_by.includes(spec.measure)) {
    // 度量列同时当分组键在语义上是自相矛盾的（"按金额分组再对金额求和"不是本增量支持的场景）
    issues.push('measure 不能同时出现在 group_by 里');
  }

  const schema = AGGREGATION_OP_SCHEMA[spec.op];
  if (schema.requires_precision) {
    if (
      typeof spec.scale !== 'number' ||
      !Number.isInteger(spec.scale) ||
      spec.scale < 0 ||
      spec.scale > MAX_SCALE
    ) {
      issues.push(`口径 ${spec.op} 要求 scale 是 0…${String(MAX_SCALE)} 的整数`);
    }
    if (!isNonEmptyString(spec.unit)) {
      issues.push(`口径 ${spec.op} 要求非空 unit（金额/数量必须有单位）`);
    }
    if (spec.currency !== undefined && spec.currency !== null && !isNonEmptyString(spec.currency)) {
      issues.push('currency 若给出必须是非空字符串或 null');
    }
  }
  if (spec.average_rounding !== undefined && !ROUNDING_MODES.includes(spec.average_rounding)) {
    issues.push(`未知的舍入口径 ${JSON.stringify(spec.average_rounding)}；可选 ${ROUNDING_MODES.join(' / ')}`);
  }
  return Object.freeze(issues);
}

/** 校验并将问题**作为异常**抛出（执行入口用）。@throws {ValidationError} */
export function assertAggregationSpec(spec: AggregationSpec): AggregationSpec {
  const issues = validateAggregationSpec(spec);
  if (issues.length > 0) {
    throw new ValidationError(`分组汇总请求不合法：${issues.join('；')}`);
  }
  return spec;
}
