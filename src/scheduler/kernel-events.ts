/**
 * 调度内核的**事件发出**层（归属 D03；合同 §七 Q10-a/Q10-b、v1.1 R4）。
 *
 * 两类记录，两个用途，不要混用（见 `src/protocol/events.ts` 的说明）：
 * - `KernelEvent`：观测事件（append-only）。**D03 负责把内核事件真实发出**——计数口径的
 *   唯一权威实现是 `summarizeKernelEvents()`，D03 不得自己另算一套计数（R4）。
 * - `PendingEvent`：待投递调度事件（outbox）。与收件箱写入、工作项变更**同一事务**写入，
 *   事务提交后才发布（合同 §五 Q6-b/Q6-d、§六）。
 *
 * 字段完备性纪律（R4「禁止静默零值」）：本文件里每种事件的字段都按事件侧的**必填表**给出，
 * 缺字段会让汇总**抛错**而不是计 0（R19 之后事件侧只有 6 项计数器）：
 *
 * | 事件 | 本文件给出的必填字段 | 影响的计数器 |
 * |---|---|---|
 * | `run_started` / `run_finished` | `run_id` | `run_count`、`peak_active_runs` |
 * | `delegation_queue_enqueued` / `delegation_queue_cleared` | `instance_id` | `peak_queued_flags`（**只增不减会算不出峰值**，故清除时必须发） |
 * | `message_accepted` | `message_id` + `instance_id`（由 D02 的 `deliverToInbox` 发出） | `inbox_message_count` |
 * | `publication_rejected` | （无必填） | `rejected_publication_count` |
 * | `work_item_created` | `request_id` | 只用于"重复建工作"探测（自洽校验） |
 *
 * **关于工作项事件的多余字段（合同 R19 已裁决）**：`work_item_status_distribution` 与
 * `blocker_reasons` 已搬到**快照侧**（`summarizeSnapshotCounters(store.snapshot())`），
 * 事件侧不再要求 `data.status` / `data.blocker_reason`。本文件**继续发这两个字段**：
 * 多余字段不报错，且对审计（"哪条事件把工作项推到了哪个状态"）有用。
 * 因此**不要**再从事件侧读工作项状态分布——那是快照侧的职责。
 */

import {
  createDeliveryEvent,
  createKernelEvent,
  type DeliveryEventInput,
  type DeliveryEventKind,
  type EventIdSource,
  type GroupId,
  type InstanceId,
  type KernelEvent,
  type KernelEventInput,
  type LogicalTime,
  type MessageId,
  type PendingEvent,
  type PublicationRejectionReason,
  type RequestId,
  type RunId,
  type RunRecord,
  type StorageTransaction,
  type TaskId,
  type WorkItem,
} from '../protocol/index.js';

/** 追加一条观测事件（同时写事件日志并交给调用方取证）。 */
export function appendKernelEvent(
  tx: StorageTransaction,
  input: KernelEventInput,
  idSource: EventIdSource,
): KernelEvent {
  const event = createKernelEvent(input, idSource);
  tx.appendKernelEvent(event);
  return event;
}

/** 写入一条待投递调度事件（outbox；与本次事务的其他写入一致提交）。 */
export function enqueueDeliveryEvent(
  tx: StorageTransaction,
  input: DeliveryEventInput,
  idSource: EventIdSource,
): PendingEvent {
  const event = createDeliveryEvent(input, idSource);
  tx.enqueueDeliveryEvent(event);
  return event;
}

/**
 * 工作项事件的 `data`（审计用；R19 之后事件侧不再据此计数）。
 *
 * 仍然**一律给出**当前状态与非终态的 `blocker_reason`：一是事件流自身可读
 * （"哪条事件把哪一项推到了哪个状态、当时在等什么"），二是保留字段对未来
 * 事件侧计数恢复的可能。非终态必有 `blocker_reason`（工作项形状不变量保证），
 * 故这里的 `data` 永不缺项。
 */
export function workItemEventData(item: WorkItem): Readonly<Record<string, unknown>> {
  return item.blocker_reason === null
    ? Object.freeze({ status: item.status })
    : Object.freeze({ status: item.status, blocker_reason: item.blocker_reason.kind });
}

/** `run_started`：计数口径 `run_count` / `peak_active_runs`（R4）。 */
export function runStartedEvent(run: RunRecord): KernelEventInput {
  return {
    kind: 'run_started',
    at: run.started_at,
    task_id: run.task_id,
    group_id: run.group_id,
    instance_id: run.instance_id,
    run_id: run.run_id,
    data: {
      task_revision: run.task_revision,
      lease_deadline: run.lease_deadline,
      frozen_input_message_ids: [...run.frozen_input_message_ids],
      frozen_request_ids: [...run.frozen_request_ids],
      frozen_actionable_input_refs: [...run.frozen_actionable_input_refs],
      is_empty_snapshot:
        run.frozen_input_message_ids.length === 0 && run.frozen_actionable_input_refs.length === 0,
    },
  };
}

/** `run_finished`：与 `run_started` 配对（R4：引用未启动的 run_id 会让汇总抛错）。 */
export function runFinishedEvent(run: RunRecord, at: LogicalTime): KernelEventInput {
  return {
    kind: 'run_finished',
    at,
    task_id: run.task_id,
    group_id: run.group_id,
    instance_id: run.instance_id,
    run_id: run.run_id,
    data: { status: run.status },
  };
}

/** 排队标记置位：`peak_queued_flags` 的加法端（R4）。 */
export function queueEnqueuedEvent(
  trace: { readonly instance_id: InstanceId; readonly at: LogicalTime; readonly task_id?: TaskId | null },
  detail: Readonly<Record<string, unknown>> = {},
): KernelEventInput {
  return {
    kind: 'delegation_queue_enqueued',
    at: trace.at,
    instance_id: trace.instance_id,
    task_id: trace.task_id ?? null,
    data: { ...detail },
  };
}

/** 排队标记清除：`peak_queued_flags` 的减法端（R4；没有它峰值会恒增）。 */
export function queueClearedEvent(input: {
  readonly instance_id: InstanceId;
  readonly at: LogicalTime;
  readonly reason: string;
}): KernelEventInput {
  return {
    kind: 'delegation_queue_cleared',
    at: input.at,
    instance_id: input.instance_id,
    data: { reason: input.reason },
  };
}

/** 工作项建立（同一 `request_id` 出现两次会让汇总抛错——"重复建业务工作"探测器）。 */
export function workItemCreatedEvent(item: WorkItem): KernelEventInput {
  return {
    kind: 'work_item_created',
    at: item.created_at,
    task_id: item.task_id,
    instance_id: item.owner_instance_id,
    request_id: item.request_id,
    data: { ...workItemEventData(item), task_revision: item.task_revision },
  };
}

/** 工作项状态变更（含非终态自环：只更新元数据，读入 ≠ 完成）。 */
export function workItemStatusChangedEvent(item: WorkItem, at: LogicalTime): KernelEventInput {
  return {
    kind: 'work_item_status_changed',
    at,
    task_id: item.task_id,
    instance_id: item.owner_instance_id,
    request_id: item.request_id,
    data: { ...workItemEventData(item) },
  };
}

/**
 * 发布被拒绝（P7 证据；`rejected_publication_count` 的唯一来源）。
 * 覆盖两种情形：轮次级（`rejection_reason` ∈ protocol 的 5 个拒因）与工作项级
 * （`rejection_reason = null`，原因在 `data.ledger_reason`）。
 */
export function publicationRejectedEvent(input: {
  readonly at: LogicalTime;
  readonly task_id?: TaskId | null;
  readonly group_id?: GroupId | null;
  readonly instance_id?: InstanceId | null;
  readonly message_id?: MessageId | null;
  readonly run_id?: RunId | null;
  readonly request_id?: RequestId | null;
  readonly rejection_reason?: PublicationRejectionReason | null;
  readonly data?: Readonly<Record<string, unknown>>;
}): KernelEventInput {
  return {
    kind: 'publication_rejected',
    at: input.at,
    task_id: input.task_id ?? null,
    group_id: input.group_id ?? null,
    instance_id: input.instance_id ?? null,
    message_id: input.message_id ?? null,
    run_id: input.run_id ?? null,
    request_id: input.request_id ?? null,
    rejection_reason: input.rejection_reason ?? null,
    data: { ...(input.data ?? {}) },
  };
}

/** 任务控制状态被写入（取消 / 需求更新优先落点，B4）。 */
export function taskControlStateUpdatedEvent(input: {
  readonly at: LogicalTime;
  readonly task_id: TaskId;
  readonly message_id: MessageId;
  readonly intent: string;
  readonly cancelled: boolean;
  readonly requirement_update_pending: boolean;
  readonly control_epoch: number;
}): KernelEventInput {
  return {
    kind: 'task_control_state_updated',
    at: input.at,
    task_id: input.task_id,
    message_id: input.message_id,
    data: {
      intent: input.intent,
      cancelled: input.cancelled,
      requirement_update_pending: input.requirement_update_pending,
      control_epoch: input.control_epoch,
    },
  };
}

/** 陈旧版本消息（Q1-b：仅入库留作历史，不产生业务工作）。 */
export function staleMessageEvent(input: {
  readonly at: LogicalTime;
  readonly message_id: MessageId;
  readonly instance_id: InstanceId;
  readonly task_id: TaskId;
  readonly task_revision: number;
  readonly current_revision: number;
}): KernelEventInput {
  return {
    kind: 'message_rejected',
    at: input.at,
    task_id: input.task_id,
    instance_id: input.instance_id,
    message_id: input.message_id,
    data: {
      reason: 'stale_task_revision',
      message_revision: input.task_revision,
      current_revision: input.current_revision,
    },
  };
}

/** 待投递调度事件的 `reason` 文案（人可读，不参与判定）。 */
export type DeliveryEventReason = string;

/** 便于调用方声明"这条待投递事件的种类"；避免在别处复制字面量。 */
export type { DeliveryEventKind };
