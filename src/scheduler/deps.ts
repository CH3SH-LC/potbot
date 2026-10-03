/**
 * 调度内核的内部依赖（归属 D03）。
 *
 * 只承载"外部注入的运行参数"，不含任何策略：id 源（确定性，Q8-c）、
 * 逻辑时间读取口（Q8-a：内核只读 `now()`，不自行推进）、租约时长（Q7-a）、
 * 兜底任务身份（见 `runs.ts` 的 `resolveTaskId()` 说明）。
 */

import type { IdSource, LogicalTime, TaskId } from '../protocol/index.js';
import type { StagnationOptions } from './stagnation.js';
import type { TaskActionStorePort } from './task-action-store.js';

export interface SchedulerDeps {
  readonly idSource: IdSource;
  /** 逻辑时间读取口。默认恒为逻辑时间原点（确定性）。 */
  readonly now: () => LogicalTime;
  /** 有限租约时长（默认 `DEFAULT_LEASE_TTL`；不自动续租，Q7-a）。 */
  readonly lease_ttl: number;
  /** 无法从实例/快照推断任务身份时的兜底（可为 null）。 */
  readonly default_task_id: TaskId | null;
  /**
   * 停滞检查点配置（R25.3）。**省略 = 不做有界停止判定**：
   * D05 的 `diagnoseStagnation` 在预算未登记时抛错（A05-01），因此只有调用方
   * 显式给出预算时才运行检查点——绝不静默套用默认预算。
   */
  readonly stagnation?: StagnationOptions | undefined;
  /**
   * 产物根目录（design-02 A 批；合同 v1.4 R51.5）。
   *
   * 只有在完成发布里携带**产物意图**时才需要。省略时携带意图的发布会**被结构化拒绝**
   * （`artifact_root_dir_unset`）——而不是悄悄换一个默认目录：产物落到哪里是**注入决定**的，
   * 内核不猜（同 `stagnation` 未登记即拒绝的纪律）。
   */
  readonly artifact_root_dir?: string | undefined;
  /**
   * **动作台账 / 任务生命周期**的持久端口（FA-S；KRN-07 + KRN-09 接线）。
   *
   * 三级解析（见 `task-action-store.ts` 的 `resolveTaskActionPort()`）：
   * 1. 事务介质自己实现了六个接缝方法 ⇒ 用**它**（`'store'`，持久、跨重启）；
   * 2. 否则用这里显式注入的端口（`'injected'`）——**测试或尚未落存储时的临时介质**；
   * 3. 都没有 ⇒ `'unwired'`：本次事务**不接线**，并在返回值上如实回报。
   *
   * **不提供"静默用进程内存兜底"**：那正是 R220 禁止的"把 Map 当完整恢复"。
   */
  readonly taskActions?: TaskActionStorePort | undefined;
}
