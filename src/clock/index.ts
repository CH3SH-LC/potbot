/**
 * `src/clock/` 公开出口（归属 D06）。
 *
 * 本目录只做时间与预算：可控逻辑时钟、租约时长算术、预算台账。
 * 时间值一律是 `src/protocol` 的 `LogicalTime`（唯一时间类型）。
 *
 * 注意：包入口 `src/index.ts` 由主智能体独占，本目录的 re-export 需由主智能体登记后再挂到包入口。
 */
export { LogicalClock, LogicalClockError } from './logical-clock.js';
export type { Clock, ClockAdvance, ClockState } from './logical-clock.js';

export { leaseDeadline, leaseRemaining } from './lease.js';

export { BudgetLedger, BudgetExceededError, BUDGET_KINDS, DEFAULT_SCENARIO_BUDGET } from './budget.js';
export type { BudgetCharge, BudgetKind, BudgetSnapshot, ScenarioBudget } from './budget.js';
