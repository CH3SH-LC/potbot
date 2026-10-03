/**
 * ID 与逻辑钟的**跨重启连续性**（KRN-10；R202 / R203 / R216 / R218 / R225）。
 *
 * ## 这一件修的是什么
 *
 * 三个"重启就白送"的漏洞，本模块一次堵死：
 *
 * 1. **id 重号**（R202）：`createIdSource` 若不带 `resume`，新进程从 1 重新发号 ⇒
 *    发出**已经用过的 id**，撞上既有记录。判据：**高水位只增不减**，重启后从
 *    `max(落盘高水位, 从持久记录观测到的高水位)` 续发。
 * 2. **逻辑钟回原点**（R203）：时钟若不落盘，重启后时间回到 0 ⇒ 已发生的记录
 *    落在"未来"，租约与超时全部失真。判据：重启后**新事件的时间戳严格大于
 *    重启前最后一个观测量**。
 * 3. **租约/预算复活**（R203/R225）：内存台账清零 ⇒ 重启白送额度、给在途租约续命。
 *    这里**复用** `restart.ts` 的既有语义（过期作废、未过期续接、预算只上不下），
 *    **不另造**一套。
 *
 * ## 为什么只看**观测到的时间**，而不是"跳到所有截止时刻之上"
 *
 * 若把逻辑钟推到所有 `lease_deadline` 之上，**每一张遗留租约都会立刻过期**——
 * 那是"凭空烧掉租约"，会把"未过期租约重启后仍能用"这条正例杀掉。因此时钟恢复到
 * "**已发生记录的最大时间 + step**"即可（见 `src/storage/store-core.ts`
 * `logicalTimeHighWater` 的同一纪律）；某张租约是否过期，由调度侧用**同一个**逻辑时间
 * 与它自己的 `lease_deadline` 单独判定。
 *
 * ## 诚实边界
 *
 * 本模块的"重启"是**同进程内**重开 store / 重建源（内存或同一份文件）的**模拟**。
 * **真实双进程**的并发发号 / 时钟交叉**未实测**，本模块不据此宣称跨进程结论。
 */

import { LogicalClock, type Clock } from '../clock/index.js';
import {
  asLogicalTime,
  createIdSource,
  type IdSource,
  type KernelEvent,
  type LogicalTime,
  type Store,
  type StoreSnapshot,
} from '../protocol/index.js';
import type { StagnationBudgetLedger } from './stagnation.js';
import {
  reconcileLeasesAfterRestart,
  type LeaseReconciliation,
} from './restart.js';
import {
  recoverBudgetFromCommittedFacts,
  type BudgetRestoreReport,
} from './budget-projection.js';

/**
 * 逻辑时间**高水位**：快照里出现过的最大逻辑时间戳。
 *
 * 与 `src/storage/store-core.ts` 的 `logicalTimeHighWater()` **同口径**（包含 tasks /
 * work_items / runs / inbox / receipts / actionable_inputs / kernel_events / delivery_events
 * 的时间戳字段）。这里**本地实现而不 import `src/storage`**：依赖方向是
 * `src/scheduler → src/storage（仅经 Store 接口）`，跨过接缝去拉实现的纯函数会把
 * 调度侧与存储实现绑死。防漂移的办法是**测试**：`id-clock-continuity.test.ts` 用同一份
 * 富字段快照断言两者**逐值相等**——一旦上游口径变了，这里会变红。
 */
export function observedTimeHighWater(snapshot: StoreSnapshot): LogicalTime {
  let max = 0;
  const bump = (value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value) && value > max) max = value;
  };
  for (const task of snapshot.tasks) {
    bump(task.created_at);
    bump(task.updated_at);
  }
  for (const item of snapshot.work_items) {
    bump(item.created_at);
    bump(item.updated_at);
  }
  for (const run of snapshot.runs) {
    bump(run.started_at);
    bump(run.frozen_at);
    bump(run.finished_at);
  }
  for (const entry of snapshot.inbox_entries) bump(entry.received_at);
  for (const receipt of snapshot.read_receipts) bump(receipt.read_at);
  for (const mark of snapshot.actionable_inputs) bump(mark.marked_at);
  for (const event of snapshot.kernel_events) bump(event.at);
  for (const event of snapshot.delivery_events) {
    bump(event.created_at);
    bump(event.delivered_at);
  }
  return asLogicalTime(max);
}

// ---------------------------------------------------------------------------
// id 高水位
// ---------------------------------------------------------------------------

/** 高水位表：命名空间 → 已发到的最大序号。 */
export type HighWaterMarks = Readonly<Record<string, number>>;

/**
 * **只增不减**合并两张高水位表（逐命名空间取 `max`）。
 *
 * 这是本模块最重要的一条纪律的落点：**没有任何路径能让高水位变小**。
 * 传进来的较旧 / 较低的表不会拉低结果（这正是"续发不得重号"的结构保证）。
 */
export function mergeHighWater(...marks: readonly (HighWaterMarks | undefined)[]): HighWaterMarks {
  const merged: Record<string, number> = {};
  for (const table of marks) {
    if (table === undefined) continue;
    for (const [namespace, value] of Object.entries(table)) {
      if (!Number.isFinite(value)) continue;
      const current = merged[namespace] ?? 0;
      if (value > current) merged[namespace] = value;
    }
  }
  return Object.freeze(merged);
}

/**
 * 断言高水位**只增不减**：`next` 在任何命名空间上都不低于 `prev`。
 *
 * 违反即抛出（不静默取大）——"高水位变小"意味着有人拿了旧的持久状态去续发，
 * 那正是重号的先兆，必须**大声**失败。
 */
export function assertHighWaterMonotonic(prev: HighWaterMarks, next: HighWaterMarks): void {
  for (const [namespace, previous] of Object.entries(prev)) {
    const current = next[namespace] ?? 0;
    if (current < previous) {
      throw new Error(
        `id 高水位倒退：命名空间 ${namespace} 从 ${previous} 降到 ${current}。` +
          '高水位只增不减（R202：id 可以跳号，不能重号）',
      );
    }
  }
}

/** 从 `<namespace>-<n>` 抽出序号（可带种子前缀）；不匹配返回 null。 */
export function numericSuffix(id: string): number | null {
  const match = /(\d+)$/.exec(id);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 从持久记录里**观测**各命名空间的高水位。
 *
 * 观测对象是快照里所有带序号后缀的 id：消息 / 请求 / 轮次 / 事件。这给了我们一份
 * "即使落盘的高水位表丢了，也能从记录本身复算回来"的下限——比只信任一张可能没落盘的表更稳。
 */
export function observedHighWater(snapshot: StoreSnapshot): HighWaterMarks {
  const marks: Record<string, number> = {};
  const bump = (namespace: string, id: string): void => {
    const value = numericSuffix(id);
    if (value === null) return;
    if ((marks[namespace] ?? 0) < value) marks[namespace] = value;
  };
  for (const message of snapshot.messages) bump('msg', String(message.message_id));
  for (const item of snapshot.work_items) bump('req', String(item.request_id));
  for (const run of snapshot.runs) bump('run', String(run.run_id));
  for (const event of snapshot.kernel_events) bump('evt', String(event.event_id));
  for (const event of snapshot.delivery_events) bump('evt', String(event.event_id));
  return Object.freeze(marks);
}

export interface IdContinuitySnapshot {
  /** 落盘的高水位（`IdSource.highWaterMarks()` 的那份数；未提供则空）。 */
  readonly persisted: HighWaterMarks;
  /** 从持久记录观测到的高水位。 */
  readonly observed: HighWaterMarks;
  /** 续发实际采用的高水位 = 两者逐命名空间取大。 */
  readonly effective: HighWaterMarks;
}

/** 汇总 id 连续性（纯查询）。 */
export function planIdContinuity(input: {
  readonly snapshot: StoreSnapshot;
  readonly persisted?: HighWaterMarks;
}): IdContinuitySnapshot {
  const persisted = mergeHighWater(input.persisted);
  const observed = observedHighWater(input.snapshot);
  return Object.freeze({
    persisted,
    observed,
    effective: mergeHighWater(persisted, observed),
  });
}

/** 续发结果：源 + 它采用的高水位（供本进程再次落盘）。 */
export interface ResumedIdSource {
  readonly source: IdSource;
  readonly resume_marks: HighWaterMarks;
}

/**
 * 用**持久化的高水位**重建 id 源（R202）。
 *
 * 只用 `effective` 播种，因此新进程发出的每一个 id 序号都**严格大于**重启前用过的
 * 任何序号——除非有人改了持久记录（那种情况下 `observed` 会把下限抬回来）。
 */
export function resumeIdSource(plan: IdContinuitySnapshot, options: { readonly seed?: string } = {}): ResumedIdSource {
  const resume = plan.effective;
  const source = createIdSource(options.seed === undefined ? { resume } : { seed: options.seed, resume });
  return Object.freeze({ source, resume_marks: resume });
}

// ---------------------------------------------------------------------------
// 逻辑钟
// ---------------------------------------------------------------------------

/**
 * 重启后逻辑钟的**恢复起点**：严格大于重启前观测到的最大时间。
 *
 * `step` 默认 1（"至少前进一格"）。返回的是**已推进过的**时间点，调用方应据此
 * 构造时钟初值（见 `resumeClock`）。
 */
export function resumeTimeAfter(snapshot: StoreSnapshot, step = 1): LogicalTime {
  if (!Number.isFinite(step) || step <= 0) {
    throw new RangeError(`时钟重启步长必须是有限正数，收到 ${String(step)}（逻辑时间不可原地踏步）`);
  }
  return asLogicalTime(observedTimeHighWater(snapshot) + step);
}

/** 断言逻辑钟重启**不回原点**：新时间必须**严格大于**重启前最后一个。 */
export function assertClockResumed(preRestartLast: LogicalTime, postRestartFirst: LogicalTime): void {
  if (!(postRestartFirst > preRestartLast)) {
    throw new Error(
      `逻辑钟重启后倒退或原地：重启前最后时间 ${preRestartLast}，重启后首条 ${postRestartFirst}。` +
        '时钟必须严格前进（R203：时间不得倒流）',
    );
  }
}

/** 恢复后的时钟：初值 = `resumeTimeAfter(snapshot)`，且只读视图供内核使用。 */
export function resumeClock(snapshot: StoreSnapshot, step = 1): { readonly clock: LogicalClock; readonly read_only: Clock } {
  const clock = new LogicalClock(resumeTimeAfter(snapshot, step));
  return Object.freeze({ clock, read_only: clock.readOnlyView() });
}

// ---------------------------------------------------------------------------
// 重启连续性总入口
// ---------------------------------------------------------------------------

export interface ContinuityReport {
  readonly ids: IdContinuitySnapshot;
  readonly clock: {
    /** 重启前观测到的最大时间（`observedTimeHighWater`）。 */
    readonly last_observed: LogicalTime;
    /** 重启后时钟的初值（严格大于 `last_observed`）。 */
    readonly resume_at: LogicalTime;
  };
  /** 租约协调（复用 `restart.ts`：过期作废、未过期续接）。 */
  readonly leases: LeaseReconciliation;
  /** 预算恢复（复用 `budget-projection.ts`：只上不下）。给了台账才非空。 */
  readonly budget: BudgetRestoreReport | null;
  /** 恒为 false：重启**不**把时钟归零（R203）。 */
  readonly clock_reset_to_origin: false;
  /** 恒为 false：重启**不**把预算清零（R225）。 */
  readonly budget_reset_on_restart: false;
}

/**
 * 重启连续性总入口：**id + 时钟 + 租约 + 预算**一次收口。
 *
 * 顺序有意为之：先把逻辑钟定在"严格晚于一切已发生记录"的位置，再协调租约与预算，
 * 这样两者用的是同一个、没有倒流的 now。
 */
export function continueAfterRestart(input: {
  readonly store: Store;
  readonly persistedMarks?: HighWaterMarks;
  readonly clockStep?: number;
  readonly ledger?: StagnationBudgetLedger | null;
  readonly now?: LogicalTime;
}): ContinuityReport {
  const snapshot = input.store.snapshot();
  const lastObserved = observedTimeHighWater(snapshot);
  const resumeAt = input.now ?? resumeTimeAfter(snapshot, input.clockStep ?? 1);
  assertClockResumed(lastObserved, resumeAt);

  const ids = planIdContinuity({
    snapshot,
    ...(input.persistedMarks === undefined ? {} : { persisted: input.persistedMarks }),
  });
  const leases = reconcileLeasesAfterRestart({ store: input.store, now: resumeAt });
  const budget =
    input.ledger === undefined || input.ledger === null
      ? null
      : recoverBudgetFromCommittedFacts(input.ledger, snapshot.kernel_events);

  return Object.freeze({
    ids,
    clock: Object.freeze({ last_observed: lastObserved, resume_at: resumeAt }),
    leases,
    budget,
    clock_reset_to_origin: false as const,
    budget_reset_on_restart: false as const,
  });
}

/**
 * 只读辅助：给定重启前最后一条事件的时刻，断言"重启后写入的新事件时间戳严格更大"。
 * 供恢复路径在写完首条事件后立刻自检（纯查询，不写任何东西）。
 */
export function assertNewEventIsLater(input: {
  readonly preRestartLast: LogicalTime;
  readonly newEvent: KernelEvent;
}): void {
  assertClockResumed(input.preRestartLast, input.newEvent.at);
}
