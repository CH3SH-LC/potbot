/**
 * 运行轮次的记录载体（P7；合同 §五 Q7-a、§九-3/§九-9）。
 *
 * 本文件只提供**记录与纯判定**，不含轮次编排（编排归 D03）：
 * - `RunRecord` 承载 run_id + **有限租约** + 冻结快照的引用（Q5-a：与 start_run 同事务冻结）。
 * - `RunLease` 是租约载体（Q7-a：逻辑时间度量、默认 1000、场景可配、**不自动续租**）。
 * - `isLeaseExpired()` / `evaluateRunOwnership()` 是共享的纯判定，D03 在 finish_run 时调用：
 *   失去所有权或任务版本已变的轮次**必须拒绝发布**。
 */

import {
  asRunId,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type RunId,
  type TaskId,
} from './ids.js';
import { DEFAULT_LEASE_TTL, type PublicationRejectionReason, type RunStatus } from './constants.js';
import { ValidationError } from './errors.js';
import type { InstanceState } from './instance.js';

/** 租约载体：run_id + 发行时刻 + 截止（逻辑时间）。 */
export interface RunLease {
  readonly run_id: RunId;
  readonly instance_id: InstanceId;
  readonly issued_at: LogicalTime;
  /** 截止时刻（逻辑时间）。到期在**轮次结束或显式检查**时判定（Q7-a）。 */
  readonly lease_deadline: LogicalTime;
  /** 恒定 false：首轮不自动续租（Q7-a）。 */
  readonly renewable: false;
}

/** 创建租约。`ttl` 默认 1000 逻辑时间单位，场景可配（Q7-a）。 */
export function createRunLease(
  runId: RunId,
  instanceId: InstanceId,
  issuedAt: LogicalTime,
  ttl: number = DEFAULT_LEASE_TTL,
): RunLease {
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new ValidationError(`租约时长必须是正有限数，收到 ${String(ttl)}`);
  }
  return Object.freeze({
    run_id: runId,
    instance_id: instanceId,
    issued_at: issuedAt,
    lease_deadline: (issuedAt + ttl) as LogicalTime,
    renewable: false,
  });
}

/**
 * 租约是否已过期：有效区间是 `[issued_at, lease_deadline)`。
 * 即 `now >= lease_deadline` 视为过期（到期点在轮次结束或显式检查时判定，Q7-a）。
 */
export function isLeaseExpired(lease: Pick<RunLease, 'lease_deadline'>, now: LogicalTime): boolean {
  return now >= lease.lease_deadline;
}

/**
 * 一次运行轮次的完整记录。
 * 快照字段表达"本轮读入了哪些输入"——**读入 ≠ 完成**（合同 §九-5）。
 */
export interface RunRecord {
  readonly run_id: RunId;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  /** 启动轮次时冻结的任务版本；发布时用于 stale 判定（§九-9）。 */
  readonly task_revision: Revision;
  readonly started_at: LogicalTime;
  readonly lease_deadline: LogicalTime;
  readonly status: RunStatus;
  readonly finished_at: LogicalTime | null;
  /** 快照冻结时刻（Q5-a：与抢占、run_id 分配、租约在同一事务内完成）。 */
  readonly frozen_at: LogicalTime;
  /** 本轮输入快照：消息 id 集合。 */
  readonly frozen_input_message_ids: readonly MessageId[];
  /** 本轮输入快照：工作请求 id 集合。 */
  readonly frozen_request_ids: readonly RequestId[];
  /** 本轮输入快照中，由"依赖解除"产生的可运行输入引用（Q5-c）。 */
  readonly frozen_actionable_input_refs: readonly string[];
}

export interface RunRecordInput {
  readonly run_id: RunId;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly task_revision: Revision;
  readonly started_at: LogicalTime;
  readonly lease_deadline: LogicalTime;
  readonly frozen_at?: LogicalTime;
  readonly status?: RunStatus;
  readonly finished_at?: LogicalTime | null;
  readonly frozen_input_message_ids?: readonly MessageId[];
  readonly frozen_request_ids?: readonly RequestId[];
  readonly frozen_actionable_input_refs?: readonly string[];
}

export function createRunRecord(input: RunRecordInput): RunRecord {
  return Object.freeze({
    run_id: asRunId(input.run_id),
    task_id: input.task_id,
    group_id: input.group_id,
    instance_id: input.instance_id,
    task_revision: input.task_revision,
    started_at: input.started_at,
    lease_deadline: input.lease_deadline,
    status: input.status ?? 'running',
    finished_at: input.finished_at ?? null,
    frozen_at: input.frozen_at ?? input.started_at,
    frozen_input_message_ids: input.frozen_input_message_ids ?? [],
    frozen_request_ids: input.frozen_request_ids ?? [],
    frozen_actionable_input_refs: input.frozen_actionable_input_refs ?? [],
  });
}

/** 发布合法性判定的输入。 */
export interface RunOwnershipQuery {
  readonly run: RunRecord | undefined;
  readonly instance: InstanceState | undefined;
  readonly now: LogicalTime;
  /** 当前任务版本（用于 stale 判定）。 */
  readonly current_task_revision: Revision;
}

export interface RunValidity {
  readonly valid: boolean;
  /** 不合法时的拒绝原因（写入观测事件，P7 证据）。 */
  readonly reason: PublicationRejectionReason | null;
}

/**
 * 结束轮次时的所有权与版本校验（合同 §九-3/§九-9）。
 * 判定顺序：未知轮次 → 轮次非活动 → 非所有权者 → 租约过期 → 任务版本已变。
 */
export function evaluateRunOwnership(query: RunOwnershipQuery): RunValidity {
  const { run, instance, now, current_task_revision } = query;
  if (run === undefined) {
    return { valid: false, reason: 'unknown_run' };
  }
  if (run.status !== 'running') {
    return { valid: false, reason: 'run_not_active' };
  }
  if (instance === undefined || instance.active_run_id !== run.run_id || instance.instance_id !== run.instance_id) {
    return { valid: false, reason: 'not_run_owner' };
  }
  if (isLeaseExpired(run, now)) {
    return { valid: false, reason: 'lease_expired' };
  }
  if (run.task_revision !== current_task_revision) {
    return { valid: false, reason: 'stale_task_revision' };
  }
  return { valid: true, reason: null };
}

/** 便捷判定：本轮的发布是否必须被拒绝。 */
export function mustRejectPublication(query: RunOwnershipQuery): boolean {
  return !evaluateRunOwnership(query).valid;
}
