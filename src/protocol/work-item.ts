/**
 * 工作项 / 工作承诺表（附录 A5 WorkItem；任务书 §7.3；合同 §四）。
 *
 * 硬语义：
 * - 六态封闭最小值（可增不可减）：待处理 / 处理中 / 等待依赖 / 已完成 / 失败 / 取消。
 * - **"已读" ≠ "已完成"**（合同 §九-5）：`triggering_message_ids` / `included_in_snapshot`
 *   记录"这条工作项由哪些消息触发、是否已被至少一轮快照读入"，与工作项结局是**两组记录**。
 * - 非终态（待处理/处理中/等待依赖）必须有明确的等待/阻塞原因（任务书:156、附录 A5）。
 * - Q4-b：失败/取消后重开 = **新建工作项**（`supersedes_request_id` 指向旧项），不回退状态。
 */

import {
  asRevision,
  type ArtifactRef,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type RunId,
  type TaskId,
} from './ids.js';
import {
  BLOCKER_KIND_LABELS,
  NON_TERMINAL_WORK_ITEM_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
  type BlockerKind,
  type WorkItemStatus,
} from './constants.js';
import { ValidationError } from './errors.js';

/** 阻塞原因（附录 A5 `blocker_reason`；Q2-c 能力缺失必须可观测）。 */
export interface BlockerReason {
  readonly kind: BlockerKind;
  readonly detail: string;
}

/** 等待/依赖引用：指向另一项工作请求、某个实例或某个产物。 */
export interface DependencyRef {
  readonly request_id?: RequestId;
  readonly instance_id?: InstanceId;
  readonly artifact_ref?: ArtifactRef;
}

export interface WorkItem {
  readonly request_id: RequestId;
  readonly task_id: TaskId;
  /** 该工作项所基于的任务版本（版本绑定，任务书:270）。 */
  readonly task_revision: Revision;
  /** 负责人（附录 A5 `owner_instance_id`）。 */
  readonly owner_instance_id: InstanceId;
  readonly description: string;
  readonly expected_output: string;
  readonly status: WorkItemStatus;
  readonly dependency_refs: readonly DependencyRef[];
  readonly result_refs: readonly ArtifactRef[];
  /**
   * 等待 / 阻塞原因。**非终态必须非空**（任务书:156）。
   * 终态**也可以带**——按合同 Q2-c，能力缺失的工作项以终态 `failed` 携带
   * `blocker_reason = { kind: 'capability_missing' }` 落库（v1.1 R9：旧注释"终态应为空"作废）。
   */
  readonly blocker_reason: BlockerReason | null;
  /** 失败原因（`status === 'failed'` 时必须有）。 */
  readonly failure_reason: string | null;
  /**
   * Q4-a：触发本工作项的 message_id 集合。
   * 这是"哪些消息读了"的记录，**不等于**"工作已完成"。
   */
  readonly triggering_message_ids: readonly MessageId[];
  /**
   * Q4-a：是否已被至少一轮输入快照读入（读入 ≠ 完成）。
   * 与 `status` 是两组记录（合同 §九-5）。
   */
  readonly included_in_snapshot: boolean;
  /** 读入过本工作项的轮次（诊断与归属断言用）。 */
  readonly snapshot_run_ids: readonly RunId[];
  /** Q4-b：本项是否用于替代某个失败/取消的旧项（重开 = 新建，保留历史结局）。 */
  readonly supersedes_request_id: RequestId | null;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

export interface WorkItemInput {
  readonly request_id: RequestId;
  readonly owner_instance_id: InstanceId;
  readonly created_at: LogicalTime;
  readonly task_id: TaskId;
  readonly task_revision?: Revision;
  readonly description?: string;
  readonly expected_output?: string;
  readonly status?: WorkItemStatus;
  readonly dependency_refs?: readonly DependencyRef[];
  readonly result_refs?: readonly ArtifactRef[];
  readonly blocker_reason?: BlockerReason | null;
  readonly failure_reason?: string | null;
  readonly triggering_message_ids?: readonly MessageId[];
  readonly included_in_snapshot?: boolean;
  readonly snapshot_run_ids?: readonly RunId[];
  readonly supersedes_request_id?: RequestId | null;
  readonly updated_at?: LogicalTime;
}

/**
 * 构造工作项。构造路径上即强制形状约束（不只是 `assertWorkItemInvariants` 的自检）：
 * - 非终态必须有 `blocker_reason`（任务书:156）；
 * - `waiting_dependency` **必须有依赖项**（v1.1 W7：等待而没有等待对象不是合法状态）；
 * - `failed` 必须有 `failure_reason`。
 */
export function createWorkItem(input: WorkItemInput): WorkItem {
  const status = input.status ?? 'pending';
  const blocker = input.blocker_reason ?? null;
  const failure = input.failure_reason ?? null;
  const dependencies = input.dependency_refs ?? [];

  if (requiresBlockerReason(status) && blocker === null) {
    throw new ValidationError(`非终态工作项必须给出 blocker_reason（status=${status}）`);
  }
  if (status === 'waiting_dependency' && dependencies.length === 0) {
    throw new ValidationError('waiting_dependency 工作项必须登记至少一个依赖项（否则无法说明在等什么）');
  }
  if (status === 'failed' && failure === null) {
    throw new ValidationError('failed 工作项必须给出 failure_reason');
  }

  return Object.freeze({
    request_id: input.request_id,
    task_id: input.task_id,
    task_revision: input.task_revision ?? asRevision(0),
    owner_instance_id: input.owner_instance_id,
    description: input.description ?? '',
    expected_output: input.expected_output ?? '',
    status,
    dependency_refs: dependencies,
    result_refs: input.result_refs ?? [],
    blocker_reason: blocker,
    failure_reason: failure,
    triggering_message_ids: input.triggering_message_ids ?? [],
    included_in_snapshot: input.included_in_snapshot ?? false,
    snapshot_run_ids: input.snapshot_run_ids ?? [],
    supersedes_request_id: input.supersedes_request_id ?? null,
    created_at: input.created_at,
    updated_at: input.updated_at ?? input.created_at,
  });
}

export function isTerminalStatus(status: WorkItemStatus): boolean {
  return TERMINAL_WORK_ITEM_STATUSES.includes(status);
}

export function isNonTerminalStatus(status: WorkItemStatus): boolean {
  return NON_TERMINAL_WORK_ITEM_STATUSES.includes(status);
}

/**
 * 该状态是否必须携带等待/阻塞原因。
 * 构造路径（`createWorkItem`）与本文件的自检共用本判据，避免两处规则分叉。
 */
export function requiresBlockerReason(status: WorkItemStatus): boolean {
  return isNonTerminalStatus(status);
}

export function blockerKindLabel(kind: BlockerKind): string {
  return BLOCKER_KIND_LABELS[kind];
}

/**
 * 形状自检：用于测试与诊断（含**外部构造**的记录，例如从存储读回的记录）；不合格即抛 `ValidationError`。
 * 与 `createWorkItem` 的构造期校验同源（同一批判据），不修改任何状态。
 */
export function assertWorkItemInvariants(item: WorkItem): void {
  if (requiresBlockerReason(item.status) && item.blocker_reason === null) {
    throw new ValidationError(`工作项 ${item.request_id} 处于非终态 ${item.status} 但缺少阻塞原因`);
  }
  if (item.status === 'failed' && item.failure_reason === null) {
    throw new ValidationError(`工作项 ${item.request_id} 失败但缺少 failure_reason`);
  }
  if (item.status === 'waiting_dependency' && item.dependency_refs.length === 0) {
    throw new ValidationError(`工作项 ${item.request_id} 等待依赖但未登记任何依赖项`);
  }
  // 注：`completed` 允许 `result_refs` 为空（首轮的文本结论没有产物引用），
  // 合同未对"已完成必须有结果引用"作强制，故此处不设该判据。
}
