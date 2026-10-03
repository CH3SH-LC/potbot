/**
 * 排队标记的**唯一置位/清除处**（归属 D03；合同 §六、§九-4；任务书 §9.1/§9.2、附录 B）。
 *
 * 语义（原样照录附录 B）：
 * ```text
 * if message should wake recipient:
 *     mark_actionable_input(recipient, message)
 *     if recipient has neither active run nor queued item:
 *         set queued flag and persist scheduling event
 * ```
 *
 * 三条被冻结的判据：
 * 1. **最多一个**（§9.1）：`queued_flag` 是布尔，重复置位不产生第二次入队事件
 *    —— 这正是"合并的是**运行机会**，不是工作请求"（§9.1）。
 * 2. **有活动轮次或已有排队项时不置位**：此时运行机会已被占用/已登记，
 *    新到达的请求**只保留在工作承诺表与收件箱**里（§9.2「A、B 唤醒运行中的 C：
 *    分别保存请求，C 完成后统一进入下一轮」）。
 * 3. **置位与待投递事件同事务**（§六 + 附录 B 结尾）：不允许出现"排队标记已置、
 *    事件永久丢失"的窗口。
 *
 * 本文件不含调度策略以外的判定（何时该调用它由 on_message / finish_run / 唤醒端口决定）。
 */

import {
  type DeliveryEventKind,
  type EventIdSource,
  type GroupId,
  type InstanceState,
  type KernelEvent,
  type LogicalTime,
  type PendingEvent,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import { patchInstance } from '../inbox/index.js';
import { appendKernelEvent, enqueueDeliveryEvent, queueClearedEvent, queueEnqueuedEvent } from './kernel-events.js';

/** 置位排队标记的输入。 */
export interface QueueFlagRequest {
  /** 触发置位的实例**当前**状态（必须是本事务内读到的最新值）。 */
  readonly instance: InstanceState;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly at: LogicalTime;
  /** 待投递事件的种类：`wakeup_queued`（消息入口）/ `run_requested`（轮次结束）/ `dependency_resolved`（依赖解除）。 */
  readonly delivery_kind: DeliveryEventKind;
  /** 人可读原因（证据可读性；不参与判定）。 */
  readonly reason: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly event_ids: EventIdSource;
}

/** 置位结果。`merged` 为真表示"运行机会已被占用或已登记"，本次**未**重复入队。 */
export interface QueueFlagResult {
  readonly queued: boolean;
  readonly merged: boolean;
  /** 置位后的实例状态（未置位时为传入的原状态）。 */
  readonly instance: InstanceState;
  readonly pending_event: PendingEvent | null;
  readonly kernel_events: readonly KernelEvent[];
}

/**
 * 按附录 B 的条件置位排队标记；已有活动轮次或已有排队标记时**合并**（不重复入队）。
 *
 * 注意：调用方需自行保证"确有可运行输入"（`hasRunnableInput()`）。
 * 本函数只负责"最多一个排队标记"的机制，不问输入从哪来。
 */
export function markQueueFlagged(tx: StorageTransaction, request: QueueFlagRequest): QueueFlagResult {
  const { instance, at } = request;
  if (instance.active_run_id !== null || instance.queued_flag) {
    return {
      queued: false,
      merged: true,
      instance,
      pending_event: null,
      kernel_events: [],
    };
  }

  const pendingEvent = enqueueDeliveryEvent(
    tx,
    {
      kind: request.delivery_kind,
      task_id: request.task_id,
      group_id: request.group_id,
      instance_id: instance.instance_id,
      created_at: at,
      reason: request.reason,
      payload: { ...(request.payload ?? {}), queued_since: at },
    },
    request.event_ids,
  );
  const enqueuedEvent = appendKernelEvent(
    tx,
    queueEnqueuedEvent(
      { instance_id: instance.instance_id, at, task_id: request.task_id },
      { delivery_kind: request.delivery_kind, reason: request.reason, pending_event_id: pendingEvent.event_id },
    ),
    request.event_ids,
  );
  // 实例状态与事件在同一事务内落定：提交即两者同时可见（§九-1）。
  const next = patchInstance(tx, instance, {
    queued_flag: true,
    queued_since: at,
    updated_at: at,
  });

  return {
    queued: true,
    merged: false,
    instance: next,
    pending_event: pendingEvent,
    kernel_events: [enqueuedEvent],
  };
}

/**
 * 清除排队标记（抢占排队项 / 无剩余可运行输入）。
 *
 * `queued_flag=false` 时**不写事件**：`delegation_queue_cleared` 是峰值计算里的减法端，
 * 只有真的发生过置位才需要配对（否则事件流里会充斥无意义的清除）。
 */
export function clearQueueFlag(
  tx: StorageTransaction,
  instance: InstanceState,
  input: { readonly at: LogicalTime; readonly reason: string; readonly event_ids: EventIdSource },
): { readonly cleared: boolean; readonly instance: InstanceState; readonly kernel_events: readonly KernelEvent[] } {
  if (!instance.queued_flag) {
    return { cleared: false, instance, kernel_events: [] };
  }
  const clearedEvent = appendKernelEvent(
    tx,
    queueClearedEvent({ instance_id: instance.instance_id, at: input.at, reason: input.reason }),
    input.event_ids,
  );
  const next = patchInstance(tx, instance, {
    queued_flag: false,
    queued_since: null,
    updated_at: input.at,
  });
  return { cleared: true, instance: next, kernel_events: [clearedEvent] };
}
