/**
 * **X08** 分组汇总模块的对外出口（XLS-13 / XLS-17）。
 *
 * 本目录是"透视 / 分组汇总之上的**精确运算层**"：
 *
 * | 文件 | 职责 |
 * |---|---|
 * | `schema.ts` | 请求形状与口径表（操作模式 / 校验），**不算** |
 * | `engine.ts` | 定点分组聚合（`bigint`，缺失不当零） |
 * | `recompute.ts` | 用定点结果**对账** `pivot.computePivotAggregate` 的浮点结果 |
 *
 * > **接线状态**：`src/spreadsheets/index.ts`（公共出口）**尚未**再导出本目录——那需要改公共文件，
 * > 归总协调的集成人（见 `integrationRequests`）。在此之前，消费方请从
 * > `src/spreadsheets/aggregation/index.js` 直接具名导入。
 */

export {
  AGGREGATION_OPS,
  AGGREGATION_OP_SCHEMA,
  assertAggregationSpec,
  opRequiresPrecision,
  validateAggregationSpec,
  type AggregationOp,
  type AggregationOpSchema,
  type AggregationSource,
  type AggregationSpec,
} from './schema.js';

export {
  aggregateRange,
  labelOf,
  readSourceTable,
  type AggregationGroupResult,
  type AggregationKey,
  type AggregationOutcome,
  type SourceTable,
} from './engine.js';

export {
  recomputePivotAmounts,
  type PivotValueRecompute,
  type RecomputeOptions,
} from './recompute.js';
