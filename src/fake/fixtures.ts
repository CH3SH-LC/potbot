/**
 * 场景基线与前置状态 fixture（归属 D06，`src/fake/`）。
 *
 * 对应验收规格 0.2「夹具基线」与各场景的「前置状态」：
 * 任务 T1 / 版本 r1 / 群组 G1 / 接收实例 C / 发送者 S1…Sn / 实例空闲无排队标记；
 * 以及 A03、A05 需要的「收件箱中先放一条触发消息、工作承诺表中先有 1 项工作」。
 *
 * 边界：本模块只**构造** D01 的协议记录（`InstanceState` / `WorkItem`），
 * 不写存储、不改内核状态——落库由 D02/D03 经 `src/storage` 完成。
 */

import {
  LOGICAL_TIME_ORIGIN,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  createInstanceState,
  createWorkItem,
  assertInstanceStateInvariants,
  assertWorkItemInvariants,
  type BlockerReason,
  type DependencyRef,
  type GroupId,
  type InstanceId,
  type InstanceState,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type TaskId,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';

/** 规格 0.2 基线：任务 T1 / 版本 r1 / 群组 G1。 */
export const BASELINE_TASK_ID = asTaskId('T1');
export const BASELINE_GROUP_ID = asGroupId('G1');
export const BASELINE_TASK_REVISION = asRevision(1);

/** 规格 0.2 基线：接收者实例 C。 */
export const BASELINE_INSTANCE_C = asInstanceId('C');

/** 规格 0.2 基线：发送者 S1…S4（A02 用 4 个）。 */
export const BASELINE_SENDER_IDS: readonly InstanceId[] = [
  asInstanceId('S1'),
  asInstanceId('S2'),
  asInstanceId('S3'),
  asInstanceId('S4'),
];

/** 场景基线。 */
export interface ScenarioBaseline {
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly task_revision: Revision;
  /** 接收者实例 C（首版同模板单实例）。 */
  readonly instance_c: InstanceState;
  readonly sender_ids: readonly InstanceId[];
}

export interface ScenarioBaselineInput {
  readonly task_id?: TaskId;
  readonly group_id?: GroupId;
  readonly task_revision?: Revision;
  readonly instance_c_id?: InstanceId;
  readonly sender_ids?: readonly InstanceId[];
  /** 基线建立时刻（逻辑时间）。 */
  readonly at?: LogicalTime;
}

/**
 * 造一个场景基线：C 空闲、无活动轮次、无排队标记、收件箱空、无未完成请求。
 * 建好后立即做 D01 的形状自检（不合格当场抛错，不留给断言阶段才发现）。
 */
export function createScenarioBaseline(input: ScenarioBaselineInput = {}): ScenarioBaseline {
  const taskId = input.task_id ?? BASELINE_TASK_ID;
  const groupId = input.group_id ?? BASELINE_GROUP_ID;
  const revision = input.task_revision ?? BASELINE_TASK_REVISION;
  const at = input.at ?? asLogicalTime(LOGICAL_TIME_ORIGIN);

  const instanceC = createInstanceState({
    instance_id: input.instance_c_id ?? BASELINE_INSTANCE_C,
    group_id: groupId,
    updated_at: at,
  });
  assertInstanceStateInvariants(instanceC);

  return {
    task_id: taskId,
    group_id: groupId,
    task_revision: revision,
    instance_c: instanceC,
    sender_ids: input.sender_ids ?? BASELINE_SENDER_IDS,
  };
}

/** 前置工作项的构造输入（A03/A05 的「工作承诺表中先有 1 项工作」）。 */
export interface WorkItemSeedInput {
  readonly request_id: RequestId;
  readonly owner_instance_id: InstanceId;
  readonly task_id: TaskId;
  readonly at: LogicalTime;
  readonly task_revision?: Revision;
  readonly description?: string;
  readonly expected_output?: string;
  readonly status?: WorkItemStatus;
  readonly dependency_refs?: readonly DependencyRef[];
  readonly blocker_reason?: BlockerReason | null;
  readonly failure_reason?: string | null;
  readonly triggering_message_ids?: readonly MessageId[];
  readonly included_in_snapshot?: boolean;
}

/**
 * 造一项前置工作项。
 *
 * 非终态必须给出阻塞原因、`failed` 必须给出失败原因——这两条由 D01 的 `createWorkItem`
 * 与 `assertWorkItemInvariants` 强制；本包装器只是把默认值补齐并统一自检，
 * 让夹具不会「悄悄造出一个不合格的工作项」。
 */
export function buildWorkItemSeed(input: WorkItemSeedInput): WorkItem {
  const status = input.status ?? 'pending';
  const blocker =
    input.blocker_reason !== undefined
      ? input.blocker_reason
      : status === 'pending' || status === 'processing' || status === 'waiting_dependency'
        ? { kind: 'waiting_external' as const, detail: '场景前置：尚未轮到本项' }
        : null;

  const item = createWorkItem({
    request_id: input.request_id,
    owner_instance_id: input.owner_instance_id,
    created_at: input.at,
    task_id: input.task_id,
    ...(input.task_revision === undefined ? {} : { task_revision: input.task_revision }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.expected_output === undefined ? {} : { expected_output: input.expected_output }),
    status,
    ...(input.dependency_refs === undefined ? {} : { dependency_refs: input.dependency_refs }),
    blocker_reason: blocker,
    ...(input.failure_reason === undefined ? {} : { failure_reason: input.failure_reason }),
    ...(input.triggering_message_ids === undefined
      ? {}
      : { triggering_message_ids: input.triggering_message_ids }),
    ...(input.included_in_snapshot === undefined
      ? {}
      : { included_in_snapshot: input.included_in_snapshot }),
  });
  assertWorkItemInvariants(item);
  return item;
}

/** 便捷：把字符串折成 `RequestId`（夹具脚本可读性）。 */
export function requestId(value: string): RequestId {
  return asRequestId(value);
}

/** 便捷：把字符串折成 `InstanceId`。 */
export function instanceId(value: string): InstanceId {
  return asInstanceId(value);
}

/** 便捷：把字符串折成 `MessageId`。 */
export function messageId(value: string): MessageId {
  return asMessageId(value);
}
