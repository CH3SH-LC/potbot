/**
 * **重启恢复**：租约与预算的跨重启连续性（C2；合同 R203 / R218 / R225）。
 *
 * ## 这一件修的是什么
 *
 * 逻辑时钟不落盘时，重启会让时间回到原点；租约与预算台账又是纯内存 ⇒
 * **重启 = 白送额度 + 给在途租约续命**。R203/R225 明文禁止，本模块是那道闸门。
 *
 * ## 三条判据（与合同一一对应）
 *
 * 1. **已过期的租约，重启后仍然过期**（R203）——
 *    "进程重启、内存清空"不得让一张已到期的租约重新变成有效。
 * 2. **未过期的租约按剩余时长续接**（R203）——
 *    租约截止是**绝对逻辑时间**，时钟不倒流 ⇒ 剩余时长天然保留；
 *    所以**绝不能**因为"要保守"就把所有遗留轮次一律作废（那会把正例也杀掉）。
 * 3. **预算不得归零**（R225），且**不得以"换账本"获得新额度**（R218）——
 *    已用量从**持久化的已提交事实**折算回来（`recoverBudgetFromCommittedFacts`），
 *    而不是从一个新进程的空台账重新开始。
 *
 * ## 为什么归在 `src/scheduler/` 而不是 `src/storage/`
 *
 * `src/storage/` 是**介质**（字节进、字节出），不该懂"租约""轮次状态"这些语义；
 * 租约判定是**调度侧**的事。之前 `FileStore` 上那个"一律作废所有 running"的方法
 * 既越层、语义也过粗，已删除并由本模块取代。
 *
 * ## 时间纪律
 *
 * 全程只用**逻辑时间**（`LogicalTime`）：`now` 由调用方给出，通常取自
 * "用落盘高水位播种过的逻辑时钟"。`src/**` 禁用墙钟（R50.4），本模块一个都不碰。
 */

import {
  isLeaseExpired,
  type LogicalTime,
  type RunId,
  type RunRecord,
  type Store,
} from '../protocol/index.js';
import {
  BUDGET_KINDS,
  type BudgetKind,
} from '../clock/budget.js';
import {
  recoverBudgetFromCommittedFacts,
  type BudgetRestoreReport,
} from './budget-projection.js';
import type { StagnationBudgetLedger } from './stagnation.js';

/** 租约协调的结果。**两类必须分开报**——"作废了"与"续接着"是完全不同的结论。 */
export interface LeaseReconciliation {
  /** 已过期 ⇒ 作废（置 `aborted`），不再可被认领。 */
  readonly expired: readonly RunId[];
  /** 未过期 ⇒ **保留 `running`**，按剩余时长续接（可继续正常使用）。 */
  readonly continuing: readonly RunId[];
}

export interface RestartRecoveryReport {
  readonly leases: LeaseReconciliation;
  /** 给了台账才会恢复预算；未给则为 `null`（如实表示"本次没有预算要恢复"）。 */
  readonly budget: BudgetRestoreReport | null;
}

/**
 * 重启后协调**租约**。
 *
 * 对每一条持久化下来的 `running` 轮次：
 * - `lease_deadline <= now`（已过期）⇒ 置 `aborted` + `finished_at = now`，**并落盘**；
 * - 否则 ⇒ **原样保留**，它的剩余时长就是 `lease_deadline - now`（时钟不倒流 ⇒ 不会凭空变短）。
 *
 * 全过程在**一个事务**里：要么整体落盘，要么整体不生效（不留半截协调结果）。
 */
export function reconcileLeasesAfterRestart(input: {
  readonly store: Store;
  readonly now: LogicalTime;
}): LeaseReconciliation {
  const expired: RunId[] = [];
  const continuing: RunId[] = [];

  input.store.transact((tx) => {
    for (const run of tx.listRuns()) {
      if (run.status !== 'running') continue;
      if (isLeaseExpired(run, input.now)) {
        const aborted: RunRecord = Object.freeze({
          ...run,
          status: 'aborted' as const,
          finished_at: input.now,
        });
        tx.putRun(aborted);
        expired.push(run.run_id);
        continue;
      }
      continuing.push(run.run_id);
    }
  });

  return Object.freeze({
    expired: Object.freeze([...expired]),
    continuing: Object.freeze([...continuing]),
  });
}

/**
 * 重启恢复总入口：先协调租约，再恢复预算（给了台账时）。
 *
 * 顺序有意为之：**先把租约收干净，再恢复账目**。反过来的话，恢复期若有人读闸门，
 * 会先看到一份"还没对齐"的账目。
 */
export function recoverAfterRestart(input: {
  readonly store: Store;
  readonly now: LogicalTime;
  readonly ledger?: StagnationBudgetLedger | null;
}): RestartRecoveryReport {
  const leases = reconcileLeasesAfterRestart({ store: input.store, now: input.now });
  const budget =
    input.ledger === undefined || input.ledger === null
      ? null
      : recoverBudgetFromCommittedFacts(input.ledger, input.store.snapshot().kernel_events);
  return Object.freeze({ leases, budget });
}

/** 只读辅助：某类预算在恢复后是否仍可用（闸门的判定原料；不写任何东西）。 */
export function budgetAvailable(
  ledger: StagnationBudgetLedger,
  kind: BudgetKind,
  limit: number,
): boolean {
  return ledger.used(kind) < limit;
}

/** 全部维度的"已用 / 未耗尽"读法，便于证据输出（纯查询）。 */
export function budgetRecoverySummary(
  ledger: StagnationBudgetLedger,
  limits: Readonly<Record<BudgetKind, number>>,
): Readonly<Record<BudgetKind, { readonly used: number; readonly limit: number; readonly available: boolean }>> {
  const summary: Record<string, { used: number; limit: number; available: boolean }> = {};
  for (const kind of BUDGET_KINDS) {
    const used = ledger.used(kind);
    summary[kind] = { used, limit: limits[kind], available: used < limits[kind] };
  }
  return Object.freeze(summary);
}
