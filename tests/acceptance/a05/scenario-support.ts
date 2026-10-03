/**
 * A05 / A05-L 验收夹具的公共接线（归属 D09；合同 §八 的 `tests/acceptance/a05/**`）。
 *
 * 冻结点标识：D11 收尾后取自**单一来源** `tests/acceptance/freeze-identity.ts`
 * （原先把 FREEZE-1 的摘要硬编码在本文件里，导致 D03 修复后的重跑证据自称 FREEZE-1、
 * 实际被测的是 FREEZE-2 源码——D10 复核发现，违反 R24）。
 *
 * 本文件**不实现内核**、**不改 `src/**`**：只做四件事
 * 1. 按 D03 报告给出的接线把 `createScheduler` 与 D06 的 `SchedulerAdvanceSeam` 接起来
 *    （投递登记绝不触发推进 —— A05「投递先落收件箱、再显式放行调度」的前提）；
 * 2. 提供 A05-01 要求的「场景执行前登记预算」的记录形状（登记时刻早于任何运行）；
 * 3. 提供只读观测读取（快照 / 事件流 / 合并计数），断言一律经只读通道；
 * 4. **登记合法发送成员**（合同 v1.2 R35.5 / 修复 F07）：入口默认鉴权器要求发送者是
 *    本群 `putGroupMember` 登记过的成员，夹具不得为了保持旧接线而跳过注册。
 *
 * ## 夹具纪律（v1.2 修复批）
 *
 * - **不得代办内核步骤**（指导 F03）：投递开始后，夹具**不得**调用
 *   `planDependencyResolution` / `tx.putWorkItem` / `wakeOnDependencyResolved` 替内核
 *   完成依赖解除。正常依赖解除由 `finish_run` 的事务内段落自动落地，夹具只经
 *   「投递 → start/finish → 推进」观察。故原先的 `makeDependencyResolutionPort` /
 *   `applyTransitions` 两个代办助手已删除。
 * - **不得替内核补账**（合同 v1.2 R34.3 / 修复 F06）：预算用量是**已提交事件的幂等投影**，
 *   由 `Scheduler` 在提交点之后同步补齐。夹具只**读** `scheduler.budgetUsage()` 或注入台账的
 *   `used()`，`syncRunsFromEvents` 一类的"从事件侧补 charge"助手已删除。
 *
 * 断言纪律（合同 v1.1 / v1.2）：
 * - R4/R19：计数一律走 `scheduler.summarize()`（事件侧 6 项 + 快照侧 2 项，两组来源都取）；
 * - R17/R22：计数与分布用**等号**，且断言前先断言夹具确实产生了数据；
 * - R27.1 / R34.x：`runs` 的**权威值**是 `scheduler.budgetUsage()`（= 注入台账的投影），
 *   与 `summarizeKernelEvents().run_count` 相等（观测口径，R4）。
 */

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createTaskRecord,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type RequestId,
  type Revision,
  type RunRecord,
  type TaskId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { BudgetLedger, LogicalClock } from '../../../src/clock/index.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/index.js';
import {
  SchedulerAdvanceSeam,
  createDeliveryRequest,
  type DeliveryRequest,
} from '../../../src/fake/index.js';
import { freezePointEvidence } from '../freeze-identity.js';

/**
 * 全量（src + tests）源码树摘要——来自单一来源（D11；合同 R24 / guide:111）。
 * 旧导出名保留，只为不动本目录外（`a05.cycle-dependency.test.ts`）的既有引用。
 */
const FREEZE_POINT = freezePointEvidence();
export const FREEZE_1_SOURCE_DIGEST = FREEZE_POINT.source_tree_sha256;

/** A05 前置状态（验收规格 4.1）：任务 T1 / 版本 r1 / 群组 G1 / 两个实例 I-A、I-B。 */
export const TASK_ID: TaskId = asTaskId('T1');
export const GROUP_ID: GroupId = asGroupId('G1');
export const REVISION: Revision = asRevision(1);
export const INSTANCE_A: InstanceId = asInstanceId('I-A');
export const INSTANCE_B: InstanceId = asInstanceId('I-B');
/** 多依赖场景（A 同时依赖 B 与 C）的第三个实例。 */
export const INSTANCE_C: InstanceId = asInstanceId('I-C');
export const SENDER_S1: InstanceId = asInstanceId('S1');
export const SENDER_S2: InstanceId = asInstanceId('S2');

/** A05 的两项工作请求（验收规格 4.2）。 */
export const R_A: RequestId = 'r-a05-A' as RequestId;
export const R_B: RequestId = 'r-a05-B' as RequestId;
/** A05-L 的两项工作请求（验收规格 4.8）。 */
export const R_LA: RequestId = 'r-a05-LA' as RequestId;
export const R_LB: RequestId = 'r-a05-LB' as RequestId;
/** A05-M 的多依赖工作请求（A 同时依赖 B 与 C）。 */
export const R_MA: RequestId = 'r-a05-MA' as RequestId;
export const R_MB: RequestId = 'r-a05-MB' as RequestId;
export const R_MC: RequestId = 'r-a05-MC' as RequestId;

/** 诊断预算的三维（Q9-a 的 R_max / D_max / T_max）。 */
export interface A05Budget {
  readonly runs: number;
  readonly diagnoses: number;
  readonly time: number;
}

/** A05-01 要求「执行前已登记」的凭证：上限 + 登记时刻（登记必须早于任何运行）。 */
export interface BudgetRegistration {
  readonly limits: A05Budget;
  /** 登记时刻（逻辑时间）；必须 ≤ 首次投入运行的时刻。 */
  readonly registered_at: LogicalTime;
  /** 登记时是否尚未启动任何轮次（A05-01 的前置条件，运行前由夹具断言）。 */
  readonly registered_before_any_run: boolean;
}

export interface A05Harness {
  readonly clock: LogicalClock;
  readonly store: ReturnType<typeof createMemoryStore>;
  readonly seam: SchedulerAdvanceSeam;
  readonly scheduler: Scheduler;
  readonly ledger: BudgetLedger;
  readonly registration: BudgetRegistration;
}

/**
 * 建 A05 场景的接线（登记预算 → 建存储/时钟/接缝 → 建调度器 → bind 推进点）。
 *
 * `defects` 只在隔离场景使用（R7 / Q10-c）：它打开 D05 的受控缺陷开关，
 * 用来证明 A05 的断言**真会失败**，不进任何生产路径。
 *
 * `without_stagnation`（R37.4 / F03）：**不登记 `stagnation`** 的对照模式。
 * 正常依赖解除**不依赖是否开启停滞诊断预算**，因此本夹具必须能构造"无预算"运行；
 * 此时 `scheduler.budgetUsage()` 为 `null`（没有注入台账 ⇒ 不做投影、不做闸断）。
 */
export function buildA05Harness(input: {
  readonly budget: A05Budget;
  readonly cycle_stop_mode?: 'report_failed' | 'pause_marker';
  readonly without_stagnation?: boolean;
  readonly defects?: {
    readonly ignore_budget?: boolean;
    readonly ignore_task_revision_in_fingerprint?: boolean;
    readonly holds_slot_while_waiting?: boolean;
  };
}): A05Harness {
  const clock = new LogicalClock();
  // A05-01：预算在**场景执行前**登记——此刻还没有任何存储/轮次被创建。
  const registeredAt = clock.now();
  const limits: A05Budget = Object.freeze({
    runs: input.budget.runs,
    diagnoses: input.budget.diagnoses,
    time: input.budget.time,
  });
  const ledger = new BudgetLedger(limits, { registeredAt });

  const store = createMemoryStore({ clock: () => clock.now() });
  // F07 / R35.5：夹具必须登记**合法的发送成员**（成员表独立于 `InstanceState`，
  // 登记成员不得改变 `instances` 的观测口径）。
  registerSenderMembers(store);
  const seam = new SchedulerAdvanceSeam(clock);
  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    clock: () => clock.now(),
    // 投递登记：**绝不触发推进**（D06 的结构性保证）
    onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result }),
    default_task_id: TASK_ID,
    ...(input.without_stagnation === true
      ? {}
      : {
          stagnation: {
            budget: limits,
            ledger,
            ...(input.cycle_stop_mode === undefined ? {} : { cycle_stop_mode: input.cycle_stop_mode }),
            ...(input.defects === undefined ? {} : { defects: input.defects }),
          },
        }),
  });
  seam.bind(() => scheduler.advanceOnce());

  return {
    clock,
    store,
    seam,
    scheduler,
    ledger,
    registration: Object.freeze({
      limits,
      registered_at: registeredAt,
      registered_before_any_run: scheduler.snapshot().runs.length === 0,
    }),
  };
}

/** 登记 A05 的合法发送成员（S1 / S2，同属 G1）到**成员表**（不是实例表）。 */
export function registerSenderMembers(store: ReturnType<typeof createMemoryStore>): void {
  store.transact((tx) => {
    for (const sender of [SENDER_S1, SENDER_S2]) {
      tx.putGroupMember(
        createGroupMember({ group_id: GROUP_ID, instance_id: sender, registered_at: asLogicalTime(0) }),
      );
    }
  });
}

/** 注册任务 T1（r1，群组 G1）：`resolveTaskId` / stale 判定需要它。 */
export function registerTask(h: A05Harness): void {
  h.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: TASK_ID,
        goal: 'A05 验收目标：循环依赖的有限诊断与停止',
        current_group_id: GROUP_ID,
        revision: REVISION,
        created_at: asLogicalTime(0),
        updated_at: asLogicalTime(0),
      }),
    );
  });
}

/** 注册一个空闲实例（注册顺序决定 `advanceOnce` 的候选顺序：先注册的先被选中）。 */
export function registerInstance(h: A05Harness, instanceId: InstanceId): void {
  h.store.transact((tx) => {
    tx.putInstance(
      createInstanceState({
        instance_id: instanceId,
        group_id: GROUP_ID,
        updated_at: asLogicalTime(0),
      }),
    );
  });
}

/** 一次投递的可追踪回执（消息 + 入口三值结果 + 各条落库记录的可读摘要）。 */
export interface DeliveryReceipt {
  readonly request: DeliveryRequest;
  readonly result: 'accepted' | 'duplicate_not_created' | 'failed';
  readonly queued: boolean;
  readonly merged_wakeup: boolean;
  readonly work_item_created: boolean;
}

/** 投递一条工作请求（经 D06 的投递夹具构造消息：sender 由内核绑定，草稿里没有 sender）。 */
export function deliverWorkRequest(
  h: A05Harness,
  input: {
    readonly message_id: string;
    readonly request_id: RequestId;
    readonly recipient: InstanceId;
    readonly sender: InstanceId;
    readonly content: string;
  },
): DeliveryReceipt {
  const request = createDeliveryRequest({
    task_id: TASK_ID,
    group_id: GROUP_ID,
    task_revision: REVISION,
    message_id: input.message_id as never,
    sender_instance_id: input.sender,
    recipient_instance_id: input.recipient,
    type: 'work_request',
    request_id: input.request_id,
    requires_wakeup: true,
    content: input.content,
    at: h.clock.now(),
  });
  const outcome = h.scheduler.onMessage(request.message);
  return {
    request,
    result: outcome.result,
    queued: outcome.queued,
    merged_wakeup: outcome.merged_wakeup,
    work_item_created: outcome.work_item_created,
  };
}

/** 从只读快照取当前**活动**轮次（断言只能经只读通道；恰好一个时返回）。 */
export function runningRun(scheduler: Scheduler): RunRecord {
  const running = scheduler.snapshot().runs.filter((run) => run.status === 'running');
  const first = running[0];
  if (running.length !== 1 || first === undefined) {
    throw new Error(`期望恰有 1 个活动轮次，实际 ${String(running.length)} 个`);
  }
  return first;
}

/** 从只读快照取某一项工作（不存在即抛错：不静默跳过）。 */
export function workItemOf(scheduler: Scheduler, requestId: RequestId): WorkItem {
  const item = scheduler.snapshot().work_items.find((work) => work.request_id === requestId);
  if (item === undefined) {
    throw new Error(`工作承诺表里没有 ${requestId}`);
  }
  return item;
}

/** 实例当前活动态（从只读快照读；不窥探内核内存）。 */
export function instanceActivity(
  scheduler: Scheduler,
  instanceId: InstanceId,
): { readonly active_run_id: string | null; readonly queued_flag: boolean; readonly activity: string } {
  const state = scheduler.snapshot().instances.find((row) => row.instance_id === instanceId);
  if (state === undefined) {
    throw new Error(`未注册实例 ${instanceId}`);
  }
  return {
    active_run_id: state.active_run_id,
    queued_flag: state.queued_flag,
    activity: state.activity,
  };
}

/** 该实例已写下的读回执条数（`不新增已读记录` 类断言的只读口径，F08 / R34.1）。 */
export function readReceiptCount(scheduler: Scheduler, instanceId: InstanceId): number {
  return scheduler.snapshot().read_receipts.filter((row) => row.instance_id === instanceId).length;
}

/** 内核按已提交事件投影出的预算用量（R34.3 / R34.5）；未注入台账时为 `null`。 */
export function budgetUsageOf(scheduler: Scheduler): { readonly runs: number; readonly diagnoses: number; readonly time: number } {
  const usage = scheduler.budgetUsage();
  return usage ?? { runs: 0, diagnoses: 0, time: 0 };
}

/** 观测事件流里某一类事件的条数（只读；不另造计数实现）。 */
export function countKernelEvents(scheduler: Scheduler, kind: string): number {
  return scheduler.snapshot().kernel_events.filter((event) => event.kind === kind).length;
}

/** 待投递调度事件里某一类的条数（只读；依赖解除通知的取证口径）。 */
export function countDeliveryEvents(scheduler: Scheduler, kind: string): number {
  return scheduler.snapshot().delivery_events.filter((event) => event.kind === kind).length;
}
