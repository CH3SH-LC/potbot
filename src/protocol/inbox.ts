/**
 * 收件箱条目、**已读**记录、可运行输入标记（附录 A3；合同 §五 Q5-b/Q5-c、§九-5）。
 *
 * 合同 §九-5 的核心："已读"与"已完成"是**两组记录**：
 * - 本文件的 `ReadReceipt`（已读，读取即标记）与 `WorkItem.status`（完成，显式结局写入）
 *   分别存放，永不相互推导。
 * - `InboxEntry` 是"消息已可靠保存到该实例收件箱"的记录（先可靠保存，再决定入队）。
 * - `ActionableInputMark` 表达"依赖解除产生的新可运行输入"（Q5-c：**不作为新消息入箱**，
 *   而是标记为下一轮快照可见的可运行输入）。
 */

import {
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RunId,
  type TaskId,
} from './ids.js';
import { ACTIONABLE_INPUT_SOURCES, type ActionableInputSource } from './constants.js';

/** 收件箱条目：消息可靠保存的落地记录（合同 §九-1 第一部分）。 */
export interface InboxEntry {
  readonly message_id: MessageId;
  readonly instance_id: InstanceId;
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  /** 收件箱内的到达序号（插入序，用于确定性断言）。 */
  readonly sequence: number;
  readonly received_at: LogicalTime;
  /** 是否需要唤醒接收者（Q2-a：与路由同属入口事务）。 */
  readonly requires_wakeup: boolean;
}

export interface InboxEntryInput {
  readonly message_id: MessageId;
  readonly instance_id: InstanceId;
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  readonly sequence: number;
  readonly received_at: LogicalTime;
  readonly requires_wakeup: boolean;
}

export function createInboxEntry(input: InboxEntryInput): InboxEntry {
  return Object.freeze({ ...input });
}

/** 收件箱内下一个到达序号（确定性插入序；D02 在入口事务内调用）。 */
export function nextInboxSequence(entries: readonly InboxEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    if (entry.sequence > max) {
      max = entry.sequence;
    }
  }
  return max + 1;
}

/**
 * **已读**记录：读取即标记（Q5-b 默认语义）。
 * 与 `WorkItem`（已完成）是两组不同记录；本项为真**不代表**任何工作已完成。
 */
export interface ReadReceipt {
  readonly message_id: MessageId;
  readonly instance_id: InstanceId;
  /** 在哪个轮次里被读入。 */
  readonly run_id: RunId;
  readonly read_at: LogicalTime;
}

export interface ReadReceiptInput {
  readonly message_id: MessageId;
  readonly instance_id: InstanceId;
  readonly run_id: RunId;
  readonly read_at: LogicalTime;
}

export function createReadReceipt(input: ReadReceiptInput): ReadReceipt {
  return Object.freeze({ ...input });
}

/**
 * 可运行输入标记（Q5-c）：依赖解除后产生的"新的可运行输入"。
 * 它不是群消息，因此**不进收件箱、不触发去重**；只作为下一轮快照的可见输入。
 */
export interface ActionableInputMark {
  readonly instance_id: InstanceId;
  readonly source: ActionableInputSource;
  /** 消息 id 或依赖解除事件的引用 id。 */
  readonly ref_id: string;
  readonly marked_at: LogicalTime;
  /** 已被哪一轮快照消费（未消费为 null → 可支撑"至多一次排队"判定）。 */
  readonly consumed_in_run_id: RunId | null;
}

export interface ActionableInputMarkInput {
  readonly instance_id: InstanceId;
  readonly source: ActionableInputSource;
  readonly ref_id: string;
  readonly marked_at: LogicalTime;
  readonly consumed_in_run_id?: RunId | null;
}

export function createActionableInputMark(input: ActionableInputMarkInput): ActionableInputMark {
  if (!ACTIONABLE_INPUT_SOURCES.includes(input.source)) {
    throw new RangeError(`未知的可运行输入来源：${String(input.source)}`);
  }
  return Object.freeze({
    instance_id: input.instance_id,
    source: input.source,
    ref_id: input.ref_id,
    marked_at: input.marked_at,
    consumed_in_run_id: input.consumed_in_run_id ?? null,
  });
}

/** 可运行输入标记的作用域键（同一实例同一引用只允许一条）。 */
export function toActionableInputKey(instanceId: InstanceId, refId: string): string {
  return `${instanceId} ${refId}`;
}
