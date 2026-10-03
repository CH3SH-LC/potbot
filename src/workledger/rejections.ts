/**
 * 工作承诺表转换的**拒绝原因**（P4；合同 §四 Q4-b / Q4-c、§九-5 / §九-9）。
 *
 * 为什么单独定义一套原因而不复用 `PUBLICATION_REJECTION_REASONS`：
 * - `PUBLICATION_REJECTION_REASONS`（protocol/constants.ts）只回答"这一次轮次的**发布**是否合法"，
 *   它是**轮次级**判据；
 * - 本模块的拒因是**工作项级**判据（目标状态非法、终态锁定、缺原因、结果引用不匹配…）。
 *   两者正交：一次转换可以"轮次合法但目标状态非法"。
 *
 * 归属/版本类的拒因**不另造一套**：`ownership_reason` 字段直接携带 protocol 的
 * `PublicationRejectionReason`，由 `evaluateRunOwnership()` 判定后原样透出（P7 复用，不重写）。
 */

import type { PublicationRejectionReason } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';

export const WORK_LEDGER_REJECTION_REASONS = [
  /** 目标状态不是合法的六态取值。 */
  'unknown_status',
  /** 不在合法转换表内（含"终态 → 终态"以外的越表转换）。 */
  'illegal_transition',
  /** 当前项已是终态：终态不可被改写/回退（Q4-b、§九-9）。 */
  'terminal_locked',
  /** 发起方轮次已失去所有权（unknown_run / not_run_owner / run_not_active / lease_expired）。 */
  'ownership_rejected',
  /** 发起方轮次冻结的任务版本已不是当前版本（stale，§九-9）。 */
  'stale_task_revision',
  /** 发起方轮次所属实例不是本工作项的负责人（工作项级所有权不符）。 */
  'owner_mismatch',
  /** 发起方轮次与工作项**不属于同一任务**（范围不符，R42.2；与 stale 分开）。 */
  'task_scope_mismatch',
  /** 工作项没有负责人（P4-03）。 */
  'missing_owner',
  /** 转到非终态却没有等待/阻塞原因（任务书:156、附录 A5）。 */
  'missing_blocker_reason',
  /** 转到 failed 却没有失败原因（附录 A5）。 */
  'missing_failure_reason',
  /** 转到 completed 却没有任何结果引用（P4-10、A03-10）。 */
  'missing_result_ref',
  /** 结果引用所答复的 request_id 与本工作项不一致（P4-10：不得张冠李戴）。 */
  'result_request_mismatch',
  /** 转到 cancelled 却没有取消原因（P4-09：取消必须有可指认的取消原因）。 */
  'missing_cancellation_reason',
  /** 转到 waiting_dependency 却没有登记任何依赖项。 */
  'missing_dependency_ref',
  /** blocker_reason.kind 不在 `BLOCKER_KINDS` 内。 */
  'invalid_blocker_kind',
  /** 构造出的候选工作项未通过 `assertWorkItemInvariants()`——防止转换路径绕过形状不变量。 */
  'invariant_violation',
  /** 重开只针对 failed / cancelled 的旧项（Q4-b）。 */
  'reopen_requires_terminal',
  /** 重开必须新建工作项，request_id 不得与旧项相同（Q4-b）。 */
  'reopen_same_request_id',
] as const;

export type WorkLedgerRejectionReason = (typeof WORK_LEDGER_REJECTION_REASONS)[number];

/** 中文标签，仅用于证据 / 报告的可读输出，不参与任何判定。 */
export const WORK_LEDGER_REJECTION_LABELS: Readonly<Record<WorkLedgerRejectionReason, string>> = {
  unknown_status: '未知状态取值',
  illegal_transition: '非法的状态转换',
  terminal_locked: '终态不可改写',
  ownership_rejected: '轮次已失去所有权',
  stale_task_revision: '任务版本已变更（stale）',
  owner_mismatch: '轮次实例不是工作项负责人',
  task_scope_mismatch: '轮次与工作项不在同一任务（范围不符）',
  missing_owner: '缺少负责人',
  missing_blocker_reason: '非终态缺少等待/阻塞原因',
  missing_failure_reason: '失败缺少失败原因',
  missing_result_ref: '已完成缺少结果引用',
  result_request_mismatch: '结果引用与工作项请求不匹配',
  missing_cancellation_reason: '取消缺少取消原因',
  missing_dependency_ref: '等待依赖却没有登记依赖项',
  invalid_blocker_kind: '阻塞原因类别非法',
  invariant_violation: '候选工作项不满足形状不变量',
  reopen_requires_terminal: '重开只允许针对失败或取消的旧项',
  reopen_same_request_id: '重开必须使用新的 request_id',
};

/**
 * 工作承诺表的策略层错误。
 *
 * 继承 `ValidationError`（`accepted === false`）：拒绝即**不产生任何状态变更**，
 * 调用方不得把被拒的转换当作已生效（合同 §九-1 的"未接受"语义）。
 */
export class WorkLedgerError extends ValidationError {
  readonly reason: WorkLedgerRejectionReason;
  /** 归属/版本类拒因的底层 protocol 判定原因；其它情况为 null。 */
  readonly ownership_reason: PublicationRejectionReason | null;

  constructor(
    reason: WorkLedgerRejectionReason,
    message: string,
    ownershipReason: PublicationRejectionReason | null = null,
  ) {
    super(message);
    this.name = 'WorkLedgerError';
    this.reason = reason;
    this.ownership_reason = ownershipReason;
  }
}

export function isWorkLedgerError(error: unknown): error is WorkLedgerError {
  return error instanceof WorkLedgerError;
}

/** 拒因的中文标签（证据输出用）。 */
export function rejectionLabel(reason: WorkLedgerRejectionReason): string {
  return WORK_LEDGER_REJECTION_LABELS[reason];
}
