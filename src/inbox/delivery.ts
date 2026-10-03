/**
 * 收件箱可靠保存 + 群内去重（合同 §九-1 第一条、Q1-d/Q3-a/Q3-b；任务书 §9.1/§9.2、附录 B）。
 *
 * 合同 §九-1 原文："消息**先可靠保存再决定入队**；收件箱写入 + 工作项变更 + 排队事件**一致提交**。"
 * 本模块负责三件事中的**前两件的一半**（收件箱写入 + 去重判定），并且**只做这两件**：
 * - 可靠保存：`putMessage` + `appendInboxEntry` + 实例收件箱索引，全部落在调用方的**同一事务**里；
 * - 去重：**先判重再写入**（D01 的 D-1 硬约束），重复送达返回 `duplicate_not_created`。
 *
 * **不在本模块**：建工作项（D04）、置排队标记与合并唤醒（D03）、写待投递调度事件（D03）。
 * 这三件事必须由 D03 在**同一个 `store.transact()`** 内与本模块的 `deliverToInbox()` 一起完成，
 * 才能满足"一致提交"；因此本模块对外提供的是**事务内句柄**（`StorageTransaction`）上的原语。
 */

import {
  createInboxEntry,
  createKernelEvent,
  nextInboxSequence,
  PersistenceError,
  PublicationError,
  ValidationError,
  type DeliveryResult,
  type EventIdSource,
  type GroupMessage,
  type InboxEntry,
  type KernelEvent,
  type LogicalTime,
  type MessageId,
  type Store,
  type StorageTransaction,
} from '../protocol/index.js';
import {
  findCrossGroupIdCollision,
  isDuplicateDelivery,
  messageScopeKeyOf,
} from './dedup.js';
import { appendUnique, patchInstance, requireInstance } from './instance-state.js';

export interface DeliverToInboxOptions {
  /** 到达时刻（逻辑时间）；省略时取 `message.created_at`（确定性：不读隐藏时钟）。 */
  readonly received_at?: LogicalTime;
  /** 收件箱条目上的唤醒标记；省略时取 `message.requires_wakeup`。 */
  readonly requires_wakeup?: boolean;
  /**
   * 提供则写入**观测事件**（`message_accepted` / `message_duplicate_rejected`）。
   * 省略时不写事件——观测事件是证据面，不影响去重与保存语义。
   */
  readonly event_ids?: EventIdSource;
}

/**
 * 事务内投递结果。
 * - `accepted`：消息**首次**可靠落库；调用方可以继续建工作项 / 置排队标记 / 写待投递事件。
 * - `duplicate_not_created`：同群同 `message_id` 已存在；**不得**重复创建业务工作。
 *
 * 非法输入（目标实例未注册、跨群 id 冲突）**抛 `ValidationError`**，由外层事务整体回滚——
 * 这一点是刻意的：R1 的投递结果三值里 `failed` 表达"未接受"，而"未接受"必须表现为
 * 事务回滚（`PersistenceError.accepted === false`），不能靠返回一个值来假装。
 */
export interface InboxDeliveryOutcome {
  readonly result: Extract<DeliveryResult, 'accepted' | 'duplicate_not_created'>;
  /** 首次接受时的收件箱条目；重复时为 null。 */
  readonly inbox_entry: InboxEntry | null;
  /** 重复送达时指向已在库的同 id 消息；否则 null。 */
  readonly duplicate_of: MessageId | null;
  /** 本次写入的观测事件（仅在提供 `event_ids` 时非空）。 */
  readonly observation_events: readonly KernelEvent[];
}

function emit(tx: StorageTransaction, events: readonly KernelEvent[]): void {
  for (const event of events) {
    tx.appendKernelEvent(event);
  }
}

/**
 * **事务内**可靠保存 + 去重的唯一入口。
 *
 * 调用顺序（不可交换）：
 * 1. 校验目标实例已注册（路由无效 → 抛错回滚）；
 * 2. 校验无跨群 id 冲突（存储键空间落差 → 抛错回滚，见 `dedup.ts`）；
 * 3. **先判重**（`isDuplicateDelivery`）——命中即返回 `duplicate_not_created`，**不写任何东西**
 *    （除可选观测事件），从而既不重复建工作、也不覆盖首次到达记录（D01 的 D-1）；
 * 4. 否则写入：消息 + 收件箱条目 + 实例收件箱索引。
 */
export function deliverToInbox(
  tx: StorageTransaction,
  message: GroupMessage,
  options: DeliverToInboxOptions = {},
): InboxDeliveryOutcome {
  const recipient = requireInstance(tx, message.recipient_instance_id);
  const receivedAt = options.received_at ?? message.created_at;

  const collision = findCrossGroupIdCollision(tx, message);
  if (collision !== undefined) {
    throw new ValidationError(
      `message_id "${message.message_id}" 已被群组 "${collision.group_id}" 占用：` +
        `去重作用域是群内唯一（Q1-d），但存储按 message_id 唯一索引，同一 id 跨群无法共存。` +
        `首版同一任务最多一个活跃群组（任务书 §5），跨群共享资源本轮排除（Q7-c），故显式报错而非静默覆盖。`,
    );
  }

  if (isDuplicateDelivery(tx, message)) {
    const observationEvents =
      options.event_ids === undefined
        ? []
        : [
            createKernelEvent(
              {
                kind: 'message_duplicate_rejected',
                at: receivedAt,
                task_id: message.task_id,
                group_id: message.group_id,
                instance_id: recipient.instance_id,
                message_id: message.message_id,
                data: {
                  delivery_result: 'duplicate_not_created',
                  scope_key: messageScopeKeyOf(message),
                },
              },
              options.event_ids,
            ),
          ];
    emit(tx, observationEvents);
    return Object.freeze({
      result: 'duplicate_not_created',
      inbox_entry: null,
      duplicate_of: message.message_id,
      observation_events: Object.freeze(observationEvents),
    });
  }

  const entry = createInboxEntry({
    message_id: message.message_id,
    instance_id: recipient.instance_id,
    group_id: message.group_id,
    task_id: message.task_id,
    sequence: nextInboxSequence(tx.getInbox(recipient.instance_id)),
    received_at: receivedAt,
    requires_wakeup: options.requires_wakeup ?? message.requires_wakeup,
  });

  tx.putMessage(message);
  tx.appendInboxEntry(entry);
  patchInstance(tx, recipient, {
    inbox_message_ids: appendUnique(recipient.inbox_message_ids, [message.message_id]),
    updated_at: receivedAt,
  });

  const observationEvents =
    options.event_ids === undefined
      ? []
      : [
          createKernelEvent(
            {
              kind: 'message_accepted',
              at: receivedAt,
              task_id: message.task_id,
              group_id: message.group_id,
              instance_id: recipient.instance_id,
              message_id: message.message_id,
              request_id: message.request_id ?? null,
              data: {
                delivery_result: 'accepted',
                sequence: entry.sequence,
                requires_wakeup: entry.requires_wakeup,
                scope_key: messageScopeKeyOf(message),
              },
            },
            options.event_ids,
          ),
        ];
  emit(tx, observationEvents);

  return Object.freeze({
    result: 'accepted',
    inbox_entry: entry,
    duplicate_of: null,
    observation_events: Object.freeze(observationEvents),
  });
}

/**
 * 投递结果的对外呈现（三值，与验收规格 0.3 的"投递入口"返回一致）。
 * `failure_reason` 仅在 `failed` 时非空。
 */
export interface DeliverMessageOutcome {
  readonly result: DeliveryResult;
  readonly inbox_entry: InboxEntry | null;
  readonly duplicate_of: MessageId | null;
  readonly failure_reason: string | null;
}

function describeFailure(error: unknown): string {
  if (error instanceof PersistenceError) {
    const cause = error.cause;
    return cause instanceof Error ? cause.message : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * **收件箱层**的单条投递便捷入口：自开一个事务，调用 `deliverToInbox()`，把结果压成三值。
 *
 * 边界（重要）：
 * - 只做"保存 + 去重"，**不**建工作项、**不**置排队标记、**不**写待投递事件；
 *   完整 `on_message` 编排（含这三件事的一致提交）归 D03，D03 应直接用 `deliverToInbox`。
 * - 未接受（事务回滚 / 校验失败）→ `failed`（合同 §九-1：不得报告已接受）。
 *   注意 `ValidationError` 与 `PersistenceError` 的 `accepted` 都是 `false`，
 *   两者都归入 `failed`；`failure_reason` 取最内层原因的文字。
 * - 已接受但事件未投递（`PublicationError`，`accepted === true`）→ **原样抛出**，
 *   保留"已接受"这一判定供调用方走重放恢复（合同 §九-1 要求两类失败可区分）。
 */
export function deliverMessage(
  store: Store,
  message: GroupMessage,
  options: DeliverToInboxOptions = {},
): DeliverMessageOutcome {
  let outcome: InboxDeliveryOutcome;
  try {
    outcome = store.transact((tx) => deliverToInbox(tx, message, options));
  } catch (error) {
    if (error instanceof PublicationError) {
      throw error;
    }
    const reason = describeFailure(error);
    return Object.freeze({
      result: 'failed' as const,
      inbox_entry: null,
      duplicate_of: null,
      failure_reason: reason,
    });
  }
  return Object.freeze({
    result: outcome.result,
    inbox_entry: outcome.inbox_entry,
    duplicate_of: outcome.duplicate_of,
    failure_reason: null,
  });
}
