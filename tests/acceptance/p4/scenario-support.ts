/**
 * P4 验收夹具的公共接线（归属 D09；合同 §八 的 `tests/acceptance/p4/**`）。
 *
 * 冻结点标识：D11 收尾后取自**单一来源** `tests/acceptance/freeze-identity.ts`
 * （原先把 FREEZE-1 的摘要硬编码在本文件里，导致 D03 修复后的重跑证据自称 FREEZE-1、
 * 实际被测的是 FREEZE-2 源码——D10 复核发现，违反 R24）。
 *
 * 前置状态（验收规格 5.1 / 0.2 基线）：任务 T1（r1）/ 群组 G1 / 接收实例 C / 收件箱空 / 承诺表空；
 * 假 Agent 配置为**可控产出**（按脚本决定某一请求在本轮"产出结果 / 报告需要依赖 / 报告工具失败"）。
 *
 * 本文件**不实现内核**、不改 `src/**`：只做接线（D03 报告给的 `createScheduler` + D06 接缝）、
 * 只读观测，以及**初始状态的登记**（任务 / 实例 / 群成员 / 少量前置工作项）。
 *
 * ## 夹具纪律（v1.2 修复批）
 *
 * - **登记合法发送成员**（R35.5 / F07）：入口默认鉴权器要求发送者是本群 `putGroupMember`
 *   登记过的成员；成员表独立于 `InstanceState`，登记它不得改变 `instances` 的观测口径。
 * - **不代办内核步骤**（指导 F03）：投递开始后，夹具**不得**调用 `planDependencyResolution` /
 *   `tx.putWorkItem` / `wakeOnDependencyResolved` 替内核做依赖解除或唤醒。
 *   正常依赖解除由 `finish_run` 的事务内段落自动落地。
 *   本文件里唯一出现 `tx.putWorkItem` 的地方是 {@link seedWorkItem}——那是**初始状态的构造**
 *   （F01 的越权目标必须在投递之前就存在），发生在任何投递之前，**不是**代办投递后的内核步骤。
 */

import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createTaskRecord,
  createWorkItem,
  type ArtifactRef,
  type BlockerReason,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageType,
  type RequestId,
  type Revision,
  type RunRecord,
  type TaskControlState,
  type TaskId,
  type WorkItem,
  type WorkItemStatus,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { BudgetLedger, LogicalClock } from '../../../src/clock/index.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/index.js';
import {
  SchedulerAdvanceSeam,
  artifactRefFor,
  createDeliveryRequest,
  type DeliveryRequest,
} from '../../../src/fake/index.js';
import { freezePointEvidence } from '../freeze-identity.js';

/**
 * 全量（src + tests）源码树摘要——来自单一来源（D11；合同 R24 / guide:111）。
 * 旧导出名保留，只为不动本目录外（`p4.work-commitment.test.ts`）的既有引用。
 */
const FREEZE_POINT = freezePointEvidence();
export const FREEZE_1_SOURCE_DIGEST = FREEZE_POINT.source_tree_sha256;

/** 验收规格 0.2 基线：T1 / r1 / G1 / 接收实例 C / 发送者 S1…S4。 */
export const TASK_ID: TaskId = asTaskId('T1');
export const GROUP_ID: GroupId = asGroupId('G1');
export const REVISION: Revision = asRevision(1);
export const INSTANCE_C: InstanceId = asInstanceId('C');
export const SENDER_S1: InstanceId = asInstanceId('S1');
export const SENDER_S2: InstanceId = asInstanceId('S2');
export const SENDER_S3: InstanceId = asInstanceId('S3');
export const SENDER_S4: InstanceId = asInstanceId('S4');

/** 验收规格 5.2 的请求标识。 */
export const R_1: RequestId = 'r-p4-01' as RequestId;
export const R_3: RequestId = 'r-p4-03' as RequestId;
export const R_4: RequestId = 'r-p4-04' as RequestId;
/**
 * 子步骤 1 里 j1 等待的**依赖请求标识**。
 *
 * **本次重写（v1.2 修复批 / 指导 F03）**：原先它是一个"外部请求"，依赖解除由夹具
 * 自己算计划、写库、唤醒（`planDependencyResolution` + `putWorkItem` + `wakeOnDependencyResolved`）
 * ——那是代做内核步骤，使"内核自动衔接"从未被验证。现在它由**另一个工作项**（`r-p4-x`）
 * 承载：轮次 2 完成 `r-p4-x` 时，`finish_run` 自行解除对 `r-p4-01` 的等待。
 */
export const R_X: RequestId = 'r-p4-x' as RequestId;

/** F01 / F02 用的第二个任务与群（越权目标、以及"其他任务继续正常工作"的对照组）。 */
export const TASK_ID_2: TaskId = asTaskId('T2');
export const GROUP_ID_2: GroupId = asGroupId('G2');
export const INSTANCE_D: InstanceId = asInstanceId('D');
export const SENDER_S5: InstanceId = asInstanceId('S5');
/** F01 用的第二个 G1 实例（"同任务错误接收者"目标）。 */
export const INSTANCE_C2: InstanceId = asInstanceId('C2');

export interface P4Budget {
  readonly runs: number;
  readonly diagnoses: number;
  readonly time: number;
}

export interface BudgetRegistration {
  readonly limits: P4Budget;
  readonly registered_at: LogicalTime;
  readonly registered_before_any_run: boolean;
}

export interface P4Harness {
  readonly clock: LogicalClock;
  readonly store: ReturnType<typeof createMemoryStore>;
  readonly seam: SchedulerAdvanceSeam;
  readonly scheduler: Scheduler;
  readonly ledger: BudgetLedger;
  readonly registration: BudgetRegistration;
}

/** 建 P4 场景的接线（登记预算 → 存储/时钟/接缝 → 调度器 → bind 推进点）。 */
export function buildP4Harness(input: {
  readonly budget: P4Budget;
  readonly defects?: {
    readonly ignore_budget?: boolean;
    readonly holds_slot_while_waiting?: boolean;
  };
}): P4Harness {
  const clock = new LogicalClock();
  const registeredAt = clock.now();
  const limits: P4Budget = Object.freeze({
    runs: input.budget.runs,
    diagnoses: input.budget.diagnoses,
    time: input.budget.time,
  });
  const ledger = new BudgetLedger(limits, { registeredAt });
  const store = createMemoryStore({ clock: () => clock.now() });
  // F07 / R35.5：夹具必须登记**合法的发送成员**（成员表独立于 `InstanceState`）。
  registerGroupMembers(store, GROUP_ID, [SENDER_S1, SENDER_S2, SENDER_S3, SENDER_S4]);
  registerGroupMembers(store, GROUP_ID_2, [SENDER_S5]);
  const seam = new SchedulerAdvanceSeam(clock);
  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    clock: () => clock.now(),
    onDeliveryCommitted: (note) => seam.noteDeliveryCommit({ ...note, label: note.result }),
    default_task_id: TASK_ID,
    stagnation: {
      budget: limits,
      ledger,
      ...(input.defects === undefined ? {} : { defects: input.defects }),
    },
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

/** 把一批身份登记为某群的成员（R35.5 / F07 的第 4 项判据）。 */
export function registerGroupMembers(
  store: ReturnType<typeof createMemoryStore>,
  groupId: GroupId,
  members: readonly InstanceId[],
): void {
  store.transact((tx) => {
    for (const member of members) {
      tx.putGroupMember(
        createGroupMember({ group_id: groupId, instance_id: member, registered_at: asLogicalTime(0) }),
      );
    }
  });
}

export function registerTask(h: P4Harness): void {
  registerTaskRecord(h, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION });
}

/** 登记一个任务记录（F01/F02 的第二任务、旧版本目标都靠它构造）。 */
export function registerTaskRecord(
  h: P4Harness,
  input: { readonly task_id: TaskId; readonly group_id: GroupId | null; readonly revision: Revision },
): void {
  h.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: input.task_id,
        goal: `P4 验收目标：工作承诺表的明确结局与等待原因（${String(input.task_id)}）`,
        current_group_id: input.group_id,
        revision: input.revision,
        created_at: asLogicalTime(0),
        updated_at: asLogicalTime(0),
      }),
    );
  });
}

export function registerInstanceC(h: P4Harness): void {
  registerInstance(h, { instance_id: INSTANCE_C, group_id: GROUP_ID });
}

/** 登记一个空闲实例（F01 的越权目标负责人、F02 的对照组）。 */
export function registerInstance(
  h: P4Harness,
  input: { readonly instance_id: InstanceId; readonly group_id: GroupId },
): void {
  h.store.transact((tx) => {
    tx.putInstance(
      createInstanceState({
        instance_id: input.instance_id,
        group_id: input.group_id,
        updated_at: asLogicalTime(0),
      }),
    );
  });
}

/**
 * **初始状态构造**：在投递开始之前预置一个工作项（F01 的越权目标、F05 的历史项）。
 *
 * 说明（指导 F03 的边界）：这里的 `tx.putWorkItem` 是**场景初始状态的构造**，
 * 发生在任何投递之前；它**不是**"投递开始后由夹具代办内核步骤"。
 * 夹具不得用它替内核计算依赖解除、认领、唤醒或收尾。
 */
export function seedWorkItem(
  h: P4Harness,
  input: {
    readonly request_id: RequestId;
    readonly task_id: TaskId;
    readonly task_revision: Revision;
    readonly owner_instance_id: InstanceId;
    readonly status: WorkItemStatus;
    readonly dependency_refs?: readonly { readonly request_id?: RequestId }[];
    readonly blocker_reason?: BlockerReason;
    readonly result_refs?: readonly ArtifactRef[];
    readonly description?: string;
  },
): void {
  h.store.transact((tx) => {
    tx.putWorkItem(
      createWorkItem({
        request_id: input.request_id,
        owner_instance_id: input.owner_instance_id,
        created_at: asLogicalTime(0),
        task_id: input.task_id,
        task_revision: input.task_revision,
        description: input.description ?? `初始状态工作项 ${String(input.request_id)}`,
        status: input.status,
        ...(input.dependency_refs === undefined ? {} : { dependency_refs: input.dependency_refs }),
        ...(input.result_refs === undefined ? {} : { result_refs: input.result_refs }),
        blocker_reason:
          input.blocker_reason ??
          (input.status === 'pending'
            ? { kind: 'other', detail: '已受理：等待运行轮次处理' }
            : { kind: 'other', detail: `初始状态：${input.status}` }),
      }),
    );
  });
}

export interface DeliveryReceipt {
  readonly request: DeliveryRequest;
  readonly result: 'accepted' | 'duplicate_not_created' | 'failed';
  readonly queued: boolean;
  readonly work_item_created: boolean;
  readonly inbox_requires_wakeup: boolean | null;
  /** 入口返回的失败原因（`failed` 时非空；取证用）。 */
  readonly failure_reason: string | null;
}

/** 一次投递的完整可选字段（默认落在 T1 / G1 / r1 → C）。 */
export interface DeliveryOptions {
  readonly message_id: string;
  readonly type: MessageType;
  readonly sender: InstanceId;
  readonly content: string;
  readonly task_id?: TaskId;
  readonly group_id?: GroupId;
  readonly task_revision?: Revision;
  readonly recipient?: InstanceId;
  readonly request_id?: RequestId;
  readonly reply_to?: RequestId;
  readonly requires_wakeup?: boolean;
  /** 附加 payload（例如取消消息的可读原因 `{ reason }`）。 */
  readonly payload?: Readonly<Record<string, unknown>>;
}

export function deliver(h: P4Harness, input: DeliveryOptions): DeliveryReceipt {
  const request = createDeliveryRequest({
    task_id: input.task_id ?? TASK_ID,
    group_id: input.group_id ?? GROUP_ID,
    task_revision: input.task_revision ?? REVISION,
    message_id: input.message_id as never,
    sender_instance_id: input.sender,
    recipient_instance_id: input.recipient ?? INSTANCE_C,
    type: input.type,
    content: input.content,
    ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
    ...(input.reply_to === undefined ? {} : { reply_to: input.reply_to }),
    ...(input.requires_wakeup === undefined ? {} : { requires_wakeup: input.requires_wakeup }),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    at: h.clock.now(),
  });
  const outcome = h.scheduler.onMessage(request.message);
  const entry = h.scheduler
    .snapshot()
    .inbox_entries.filter((row) => String(row.message_id) === input.message_id)
    .slice(-1)[0];
  return {
    request,
    result: outcome.result,
    queued: outcome.queued,
    work_item_created: outcome.work_item_created,
    inbox_requires_wakeup: entry === undefined ? null : entry.requires_wakeup,
    failure_reason: outcome.failure_reason,
  };
}

export function deliverWorkRequest(
  h: P4Harness,
  input: { readonly message_id: string; readonly request_id: RequestId; readonly sender: InstanceId; readonly content: string },
): DeliveryReceipt {
  return deliver(h, {
    message_id: input.message_id,
    type: 'work_request',
    sender: input.sender,
    content: input.content,
    request_id: input.request_id,
    requires_wakeup: true,
  });
}

/**
 * 工作结果消息（答复 `reply_to` 指向的请求；不建工作项）。
 *
 * 注意（F03）：**结果消息本身不会让内核解除依赖**——解除发生在 `finish_run` 的事务内段落，
 * 依据是"依赖目标工作项已完成"。若要让等待方恢复，依赖目标必须是一个**工作项**
 * （见 `R_X` 的说明）。
 */
export function deliverWorkResult(
  h: P4Harness,
  input: { readonly message_id: string; readonly request_id: RequestId; readonly reply_to: RequestId; readonly sender: InstanceId; readonly content: string },
): DeliveryReceipt {
  return deliver(h, {
    message_id: input.message_id,
    type: 'work_result',
    sender: input.sender,
    content: input.content,
    request_id: input.request_id,
    reply_to: input.reply_to,
    requires_wakeup: true,
  });
}

/** 取消消息（§9.3：取消优先写任务状态；内核把它的收件箱条目标为**安静**条目）。 */
export function deliverCancel(
  h: P4Harness,
  input: { readonly message_id: string; readonly reply_to: RequestId; readonly sender: InstanceId; readonly reason: string },
): DeliveryReceipt {
  return deliver(h, {
    message_id: input.message_id,
    type: 'cancel',
    sender: input.sender,
    content: input.reason,
    reply_to: input.reply_to,
  });
}

export function activeRunOf(h: P4Harness, label: string): RunRecord {
  const running = h.scheduler.snapshot().runs.filter((run) => run.status === 'running');
  const first = running[0];
  if (running.length !== 1 || first === undefined) {
    throw new Error(`${label}：期望恰有 1 个活动轮次，实际 ${String(running.length)}`);
  }
  return first;
}

export function workItemOf(h: P4Harness, requestId: RequestId): WorkItem {
  const item = h.scheduler.snapshot().work_items.find((work) => work.request_id === requestId);
  if (item === undefined) {
    throw new Error(`工作承诺表里没有 ${requestId}`);
  }
  return item;
}

export function maybeWorkItemOf(h: P4Harness, requestId: RequestId): WorkItem | null {
  return h.scheduler.snapshot().work_items.find((work) => work.request_id === requestId) ?? null;
}

export function taskControlOf(h: P4Harness): TaskControlState | null {
  return h.scheduler.snapshot().task_control_states.find((state) => state.task_id === TASK_ID) ?? null;
}

export function taskControlById(h: P4Harness, taskId: TaskId): TaskControlState | null {
  return h.scheduler.snapshot().task_control_states.find((state) => state.task_id === taskId) ?? null;
}

/** 只读：观测事件流里某一类事件的条数。 */
export function countKernelEvents(h: P4Harness, kind: string): number {
  return h.scheduler.snapshot().kernel_events.filter((event) => event.kind === kind).length;
}

/** 只读：预算用量（已提交事件的幂等投影；R34.3 / R34.5）。 */
export function budgetUsageOf(h: P4Harness): { readonly runs: number; readonly diagnoses: number; readonly time: number } {
  return h.scheduler.budgetUsage() ?? { runs: 0, diagnoses: 0, time: 0 };
}

export { artifactRefFor, asArtifactRef };
