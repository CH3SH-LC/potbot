/**
 * 待投递事件（outbox）与观测事件（合同 §五 Q6-b/Q6-d、§七 Q10-a/Q10-b；v1.1 R3/R4）。
 *
 * 两类记录、两个用途，**不要混用**：
 * - `PendingEvent`：**待投递的调度事件**。与"收件箱写入 + 工作项变更"在**同一事务**内写入
 *   （outbox 式，Q6-d）；事务提交后才发布，发布成功才标记已投递；恢复时重放未投递事件（Q6-b）。
 *   重放**不得重复建业务工作**——幂等由投递标记 + D02/D03 的业务键保证。
 * - `KernelEvent`：**观测事件**（append-only 日志）。内核原生发出结构化事件、测试侧订阅采集；
 *   假 Agent 不得直接改内核状态（Q10-b）。
 *
 * 计数（`EventCounters` / `SnapshotCounters` / `SchedulingCounters`）**不在本文件**：
 * 唯一权威实现已按来源拆分到 `counters.ts`（v1.1 R19），本文件只管事件记录本身。
 */

import type {
  EventId,
  GroupId,
  InstanceId,
  LogicalTime,
  MessageId,
  RequestId,
  RunId,
  TaskId,
} from './ids.js';
import {
  DELIVERY_EVENT_KINDS,
  KERNEL_EVENT_KINDS,
  type DeliveryEventKind,
  type KernelEventKind,
  type PublicationRejectionReason,
} from './constants.js';
import { ValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// outbox：待投递调度事件
// ---------------------------------------------------------------------------

export interface PendingEvent {
  readonly event_id: EventId;
  readonly kind: DeliveryEventKind;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  /** 事件的目标实例（唤醒 / 入队都是实例级动作）。 */
  readonly instance_id: InstanceId;
  readonly created_at: LogicalTime;
  /** 人可读的原因说明（证据可读性；不参与判定）。 */
  readonly reason: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** 是否已投递。**只由发布路径置位**；恢复时以本字段判定是否需要重放。 */
  readonly delivered: boolean;
  readonly delivered_at: LogicalTime | null;
}

export interface DeliveryEventInput {
  readonly kind: DeliveryEventKind;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly created_at: LogicalTime;
  readonly reason: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** 允许注入固定 event_id（确定性场景，Q8-c）。 */
  readonly event_id?: EventId;
}

export interface EventIdSource {
  newEventId(): EventId;
}

/** 构造待投递事件（默认未投递）。 */
export function createDeliveryEvent(input: DeliveryEventInput, idSource: EventIdSource): PendingEvent {
  if (!DELIVERY_EVENT_KINDS.includes(input.kind)) {
    throw new ValidationError(`未知的待投递事件种类：${String(input.kind)}`);
  }
  return Object.freeze({
    event_id: input.event_id ?? idSource.newEventId(),
    kind: input.kind,
    task_id: input.task_id,
    group_id: input.group_id,
    instance_id: input.instance_id,
    created_at: input.created_at,
    reason: input.reason,
    payload: input.payload ?? {},
    delivered: false,
    delivered_at: null,
  });
}

/** 标记为已投递（不可变更新；幂等由存储层保证）。 */
export function markEventDelivered(event: PendingEvent, at: LogicalTime): PendingEvent {
  if (event.delivered) {
    return event;
  }
  return Object.freeze({ ...event, delivered: true, delivered_at: at });
}

/** 从未投递集合中滤出仍待投递者（存储层 `pendingDeliveryEvents()` 的唯一实现）。 */
export function undelivered(events: readonly PendingEvent[]): readonly PendingEvent[] {
  return events.filter((event) => !event.delivered);
}

// ---------------------------------------------------------------------------
// 观测事件日志
// ---------------------------------------------------------------------------

export interface KernelEvent {
  readonly event_id: EventId;
  readonly kind: KernelEventKind;
  readonly at: LogicalTime;
  readonly task_id: TaskId | null;
  readonly group_id: GroupId | null;
  readonly instance_id: InstanceId | null;
  readonly message_id: MessageId | null;
  readonly run_id: RunId | null;
  readonly request_id: RequestId | null;
  /** 发布被拒绝时的原因（P7 证据）。 */
  readonly rejection_reason: PublicationRejectionReason | null;
  /**
   * 事件附加数据。`summarizeKernelEvents()` 需要：
   * - `work_item_created` / `work_item_status_changed`：`status`（必填，∈ `WORK_ITEM_STATUSES`）、
   *   `blocker_reason`（该状态为非终态时必填，∈ `BLOCKER_KINDS`）。
   */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface KernelEventInput {
  readonly kind: KernelEventKind;
  readonly at: LogicalTime;
  readonly event_id?: EventId;
  readonly task_id?: TaskId | null;
  readonly group_id?: GroupId | null;
  readonly instance_id?: InstanceId | null;
  readonly message_id?: MessageId | null;
  readonly run_id?: RunId | null;
  readonly request_id?: RequestId | null;
  readonly rejection_reason?: PublicationRejectionReason | null;
  readonly data?: Readonly<Record<string, unknown>>;
}

export function createKernelEvent(input: KernelEventInput, idSource: EventIdSource): KernelEvent {
  if (!KERNEL_EVENT_KINDS.includes(input.kind)) {
    throw new ValidationError(`未知的观测事件种类：${String(input.kind)}`);
  }
  return Object.freeze({
    event_id: input.event_id ?? idSource.newEventId(),
    kind: input.kind,
    at: input.at,
    task_id: input.task_id ?? null,
    group_id: input.group_id ?? null,
    instance_id: input.instance_id ?? null,
    message_id: input.message_id ?? null,
    run_id: input.run_id ?? null,
    request_id: input.request_id ?? null,
    rejection_reason: input.rejection_reason ?? null,
    data: input.data ?? {},
  });
}
