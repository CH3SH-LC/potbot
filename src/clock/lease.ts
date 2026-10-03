/**
 * 租约时长的**逻辑时间算术**（合同 Q7-a：租约用逻辑时钟度量，默认 1000 个逻辑时间单位，
 * 场景可配，**不自动续租**）。
 *
 * 边界说明（避免与 D01 重复）：
 * - **默认时长常量**在 `src/protocol/constants.ts` 的 `DEFAULT_LEASE_TTL`，本模块只**引用**，
 *   不另起一套数值。
 * - **到期判定**在 `src/protocol/run.ts` 的 `isLeaseExpired(lease, now)`，本模块不重复实现。
 * - 本模块只补两件时钟侧的事：**从当前时间算出截止时间**、**算剩余时长**（可正可负）。
 */

import { DEFAULT_LEASE_TTL, asLogicalTime, type LogicalTime } from '../protocol/index.js';

/**
 * 由「当前逻辑时间 + 时长」算出租约截止时间。
 *
 * @param now 当前逻辑时间（来自 `LogicalClock.now()` / `Clock`）。
 * @param ttl 时长（逻辑时间单位）；默认取合同 Q7-a 的 `DEFAULT_LEASE_TTL`。
 * @throws {RangeError} `ttl` 非有限正数时（`asLogicalTime` 兜住非有限结果）。
 */
export function leaseDeadline(now: LogicalTime, ttl: number = DEFAULT_LEASE_TTL): LogicalTime {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new RangeError(`租约时长必须是有限正数，收到 ${String(ttl)}`);
  }
  return asLogicalTime(now + ttl);
}

/**
 * 租约剩余时长。
 * - `> 0`：仍在租约内；
 * - `≤ 0`：已到期（或恰好到期）。
 *
 * 本函数只做算术，**不改动任何状态、不续租**——续租在本轮被明确排除（Q7-a）。
 */
export function leaseRemaining(deadline: LogicalTime, now: LogicalTime): number {
  return deadline - now;
}
