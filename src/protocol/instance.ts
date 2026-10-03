/**
 * 实例状态（附录 A3 InstanceState；合同 §一、§七）。
 *
 * 硬语义：
 * - **显式实例标识**：`instance_id` 是身份；`template_id` 只作溯源（Q1-c）。
 * - **实例状态与工作状态分开**（任务书:217）：本文件的 `activity` 只管"是否在跑/是否排队"，
 *   工作结局一律在 `WorkItem`。
 * - **收件箱可靠保存**：`inbox_message_ids` 是已可靠落库入箱的消息。
 * - **"已读"与"已完成请求"是两组不同记录**（合同 §九-5）：
 *   `consumed_message_ids`（已读）与 `pending_request_ids`（未完成工作）分别记录。
 * - **最多一个排队标记**（§9.1）：`queued_flag` 是布尔（运行机会标记，不是工作请求）。
 * - **有限租约**（Q7-a）：`lease_deadline` 与活动轮次配套，不自动续租。
 */

import {
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type PrivateContextRef,
  type RequestId,
  type RunId,
  type TemplateId,
} from './ids.js';
import type { InstanceActivityState } from './constants.js';

export interface InstanceState {
  readonly instance_id: InstanceId;
  readonly group_id: GroupId;
  /** 模板身份与固定版本（首轮不做模板安装，仅溯源）。 */
  readonly template_id: TemplateId | null;
  readonly pinned_template_version: string | null;
  readonly private_context_ref: PrivateContextRef | null;
  /** 活动态：`idle` / `active`。与工作项状态无关。 */
  readonly activity: InstanceActivityState;
  /** 当前活动轮次的 run_id；无活动轮次时为 null。 */
  readonly active_run_id: RunId | null;
  /**
   * 排队标记：**最多一个**、只表示"有可运行输入但当前不能启动"的运行机会。
   * 合并的是运行机会，不是工作请求（合同 §九-4）。
   */
  readonly queued_flag: boolean;
  /** 排队标记置位时刻（观测"排队延迟"用，Q10-d）。 */
  readonly queued_since: LogicalTime | null;
  /** 当前活动轮次的租约截止（逻辑时间；与 `RunRecord.lease_deadline` 镜像）。 */
  readonly lease_deadline: LogicalTime | null;
  /** 已可靠保存到本实例收件箱的消息（插入顺序）。 */
  readonly inbox_message_ids: readonly MessageId[];
  /** **已读**记录（≠ 已完成）。 */
  readonly consumed_message_ids: readonly MessageId[];
  /** **未完成工作请求**记录（与"已读"是两组）。 */
  readonly pending_request_ids: readonly RequestId[];
  readonly updated_at: LogicalTime;
}

export interface InstanceStateInput {
  readonly instance_id: InstanceId;
  readonly group_id: GroupId;
  readonly updated_at: LogicalTime;
  readonly template_id?: TemplateId | null;
  readonly pinned_template_version?: string | null;
  readonly private_context_ref?: PrivateContextRef | null;
  readonly activity?: InstanceActivityState;
  readonly active_run_id?: RunId | null;
  readonly queued_flag?: boolean;
  readonly queued_since?: LogicalTime | null;
  readonly lease_deadline?: LogicalTime | null;
  readonly inbox_message_ids?: readonly MessageId[];
  readonly consumed_message_ids?: readonly MessageId[];
  readonly pending_request_ids?: readonly RequestId[];
}

/** 构造实例状态；默认"空闲、无活动轮次、无排队标记"。 */
export function createInstanceState(input: InstanceStateInput): InstanceState {
  return Object.freeze({
    instance_id: input.instance_id,
    group_id: input.group_id,
    template_id: input.template_id ?? null,
    pinned_template_version: input.pinned_template_version ?? null,
    private_context_ref: input.private_context_ref ?? null,
    activity: input.activity ?? 'idle',
    active_run_id: input.active_run_id ?? null,
    queued_flag: input.queued_flag ?? false,
    queued_since: input.queued_since ?? null,
    lease_deadline: input.lease_deadline ?? null,
    inbox_message_ids: input.inbox_message_ids ?? [],
    consumed_message_ids: input.consumed_message_ids ?? [],
    pending_request_ids: input.pending_request_ids ?? [],
    updated_at: input.updated_at,
  });
}

/**
 * 形状自检：`active` 必须配活动轮次与租约；不得同时"活动"与"排队"存在冲突语义。
 * （`active` + `queued_flag` 同真是合法的——"跑到一半又来了新请求"正是 A03 场景。）
 */
export function assertInstanceStateInvariants(state: InstanceState): void {
  if (state.activity === 'active' && state.active_run_id === null) {
    throw new Error(`实例 ${state.instance_id} 标记为 active 但没有 active_run_id`);
  }
  if (state.activity === 'active' && state.lease_deadline === null) {
    throw new Error(`实例 ${state.instance_id} 处于 active 但没有租约截止时间`);
  }
  if (state.queued_flag && state.queued_since === null) {
    throw new Error(`实例 ${state.instance_id} 有排队标记但没有 queued_since`);
  }
}
