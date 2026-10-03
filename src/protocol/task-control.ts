/**
 * 任务控制状态（合同 v1.1 B4 的载体；依据任务书:209、合同 Q4-c / Q6-c、v1 §六）。
 *
 * 合同要求：**取消与需求更新优先写入任务状态，不能只作为普通群消息排队**。
 * `TaskRecord` 本身按 v1.1 R9 不含 `status` 字段，因此"任务控制状态"由本文件承载为
 * **独立记录**（`TaskControlState`）——它不是 `TaskRecord.status`，也不与 R9 冲突：
 * - 记录身份是 `task_id`，与任务版本 `revision` 绑定；
 * - 只表达"任务是否已被取消 / 是否有待处理的需求更新"这类**控制意图的落点**；
 * - 取消与需求更新的写入必须与对应消息**同一事务**（Q6-c），由 `Store.transact()` 保证。
 *
 * 单调性（本合同冻结的语义）：
 * - `cancelled` **一旦为真不再被撤销**：后续需求更新不得"复活"已取消任务
 *   （Q4-b 的重开是**新建工作项**，不是回退取消）；
 * - 旧任务版本的控制意图**不得**改写控制状态（Q1-b：旧版本仅入库留作历史），
 *   版本低于当前控制状态版本时抛 `ValidationError`。
 */

import {
  asRevision,
  type LogicalTime,
  type MessageId,
  type Revision,
  type TaskId,
  INITIAL_REVISION,
} from './ids.js';
import { ValidationError } from './errors.js';

/** 控制意图种类（任务书 §9.3：取消、需求更新）。 */
export const TASK_CONTROL_INTENTS = ['cancel', 'requirement_update'] as const;
export type TaskControlIntent = (typeof TASK_CONTROL_INTENTS)[number];

export interface TaskControlState {
  readonly task_id: TaskId;
  /** 该控制状态所对应的任务版本（由控制意图携带的版本单调推进）。 */
  readonly revision: Revision;
  /** 任务是否已被取消（取消优先，且不可被后续需求更新撤销）。 */
  readonly cancelled: boolean;
  readonly cancel_reason: string | null;
  /** 置取消的那个 message_id（可追踪，任务书:442 的可追踪要求）。 */
  readonly cancelled_by_message_id: MessageId | null;
  /** 是否有已受理但尚未落地的需求更新。 */
  readonly requirement_update_pending: boolean;
  /** 最近一次控制意图的消息 id。 */
  readonly last_control_message_id: MessageId | null;
  /** 控制意图被应用的次数（单调递增；用于观测与"同版同阻塞最多一次恢复"类判定）。 */
  readonly control_epoch: number;
  readonly updated_at: LogicalTime;
}

export interface TaskControlStateInput {
  readonly task_id: TaskId;
  readonly updated_at: LogicalTime;
  readonly revision?: Revision;
  readonly cancelled?: boolean;
  readonly cancel_reason?: string | null;
  readonly cancelled_by_message_id?: MessageId | null;
  readonly requirement_update_pending?: boolean;
  readonly last_control_message_id?: MessageId | null;
  readonly control_epoch?: number;
}

/** 构造控制状态；默认"未取消、无待处理需求更新"。 */
export function createTaskControlState(input: TaskControlStateInput): TaskControlState {
  return Object.freeze({
    task_id: input.task_id,
    revision: input.revision ?? INITIAL_REVISION,
    cancelled: input.cancelled ?? false,
    cancel_reason: input.cancel_reason ?? null,
    cancelled_by_message_id: input.cancelled_by_message_id ?? null,
    requirement_update_pending: input.requirement_update_pending ?? false,
    last_control_message_id: input.last_control_message_id ?? null,
    control_epoch: input.control_epoch ?? 0,
    updated_at: input.updated_at,
  });
}

/**
 * 一条**已受理**的控制意图：内核已在同一事务内可靠保存了对应消息，
 * 现在把控制状态一并落库（Q6-c："取消与需求更新同事务写任务控制状态"）。
 */
export interface AppliedControlIntent {
  readonly kind: TaskControlIntent;
  readonly message_id: MessageId;
  /** 该控制消息绑定的任务版本。 */
  readonly task_revision: Revision;
  readonly at: LogicalTime;
  /** 取消原因（`kind === 'cancel'` 时建议填写）。 */
  readonly reason?: string;
}

/**
 * 应用控制意图，产出新的控制状态（纯函数）。
 *
 * @throws {ValidationError} 意图的 `task_revision` 低于当前控制状态版本（旧版本不得改写控制状态）。
 */
export function applyTaskControlIntent(
  state: TaskControlState,
  intent: AppliedControlIntent,
): TaskControlState {
  if (intent.task_revision < state.revision) {
    throw new ValidationError(
      `控制意图基于旧任务版本 ${String(intent.task_revision)}（当前 ${String(state.revision)}）：` +
        '旧版本消息仅入库留作历史，不得改写任务控制状态（Q1-b）',
    );
  }
  const revision = asRevision(intent.task_revision);

  if (intent.kind === 'cancel') {
    return Object.freeze({
      ...state,
      revision,
      cancelled: true,
      cancel_reason: intent.reason ?? state.cancel_reason,
      cancelled_by_message_id: intent.message_id,
      last_control_message_id: intent.message_id,
      control_epoch: state.control_epoch + 1,
      updated_at: intent.at,
    });
  }

  // requirement_update：不撤销已取消状态（取消优先）。
  return Object.freeze({
    ...state,
    revision,
    requirement_update_pending: true,
    last_control_message_id: intent.message_id,
    control_epoch: state.control_epoch + 1,
    updated_at: intent.at,
  });
}

/** 便捷判定：任务是否已被取消（控制意图写入后立即为真）。 */
export function isTaskCancelled(state: TaskControlState | undefined): boolean {
  return state !== undefined && state.cancelled;
}
