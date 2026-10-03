/**
 * **结局完整性**判据（P4-03 / P4-04 / P4-09 / P4-10；任务书 §7.3、附录 A5）。
 *
 * 一条工作承诺必须有"明确结局或等待原因"，本文件把这个要求做成**可判定、可举证**的形状检查：
 * - 每项 **必须有负责人**（P4-03）；
 * - 状态必须是六态之一，不得为空/未知（P4-04）；
 * - 非终态 **必须有**等待/阻塞原因；`waiting_dependency` 还必须登记依赖项；
 * - `failed` **必须有**失败原因；
 * - `completed` **必须有**结果引用（P4-10；比 protocol 的 `assertWorkItemInvariants` 更严——
 *   后者在首轮刻意放行"已完成但空结果占位"，本层按验收规格收严）；
 * - `cancelled` **必须有**取消原因。
 *
 * ## R9（合同冻结 v1.1）：终态**可以**携带 blocker_reason
 * 合同 Q2-c 规定"无匹配能力 → 即时产生终态 `failed` 工作项，阻塞原因 = 能力缺失"，
 * 故 `failed` 项**应当**同时带 `blocker_reason`。本文件**不**对终态禁止 blocker，
 * 也不因终态带 blocker 而报违例（`src/protocol/work-item.ts` 里"终态应为空"的旧注释已作废，
 * 更正归 D01；D04 不去改 protocol）。
 *
 * ## 偏差说明（主动、含理由）
 * 协议 `WorkItem` 没有 `cancellation_reason` 字段（附录 A5 只有 `failure_reason`）。
 * 为满足 P4-09「终态项（已完成/失败/取消）必须带对应的结果引用或失败/取消原因」，
 * 本模块规定：**取消原因写入 `blocker_reason`**（`kind` 由调用方给出，默认 `other`），
 * 由 `cancellationReasonOf()` 读回。这不需要改 `src/protocol/**`，也不违反
 * `assertWorkItemInvariants`（它不禁止终态携带 blocker_reason）。
 * 若主智能体后续为 `cancelled` 增补专用字段，本模块改用该字段即可，对外函数签名不变。
 */

import {
  BLOCKER_KINDS,
  isTerminalStatus,
  type BlockerKind,
  type BlockerReason,
  type WorkItem,
} from '../protocol/index.js';
import { WorkLedgerError, type WorkLedgerRejectionReason } from './rejections.js';
import { isWorkItemStatus } from './transitions.js';

export const OUTCOME_VIOLATION_KINDS = [
  'missing_owner',
  'status_out_of_enum',
  'non_terminal_without_wait_reason',
  'waiting_without_dependency_ref',
  'failed_without_failure_reason',
  'completed_without_result_ref',
  'cancelled_without_cancellation_reason',
] as const;

export type OutcomeViolationKind = (typeof OUTCOME_VIOLATION_KINDS)[number];

export const OUTCOME_VIOLATION_LABELS: Readonly<Record<OutcomeViolationKind, string>> = {
  missing_owner: '工作项没有负责人',
  status_out_of_enum: '状态不在六态枚举内',
  non_terminal_without_wait_reason: '非终态却没有等待/阻塞原因',
  waiting_without_dependency_ref: '等待依赖却没有登记依赖项',
  failed_without_failure_reason: '失败却没有失败原因',
  completed_without_result_ref: '已完成却没有结果引用',
  cancelled_without_cancellation_reason: '取消却没有取消原因',
};

/** 违反项到策略层拒因的映射（`assertOutcomeCompleteness` 抛错时使用）。 */
const VIOLATION_TO_REJECTION: Readonly<Record<OutcomeViolationKind, WorkLedgerRejectionReason>> = {
  missing_owner: 'missing_owner',
  status_out_of_enum: 'unknown_status',
  non_terminal_without_wait_reason: 'missing_blocker_reason',
  waiting_without_dependency_ref: 'missing_dependency_ref',
  failed_without_failure_reason: 'missing_failure_reason',
  completed_without_result_ref: 'missing_result_ref',
  cancelled_without_cancellation_reason: 'missing_cancellation_reason',
};

export interface OutcomeViolation {
  readonly kind: OutcomeViolationKind;
  readonly request_id: string;
  readonly detail: string;
}

/**
 * 读回取消原因。
 *
 * 约定见文件头"偏差说明"：`cancelled` 项的取消原因存放在 `blocker_reason.detail`。
 * 非 cancelled 项一律返回 null（避免把等待原因误读成取消原因）。
 */
export function cancellationReasonOf(item: WorkItem): string | null {
  if (item.status !== 'cancelled') {
    return null;
  }
  const blocker = item.blocker_reason;
  if (blocker === null || blocker.detail.trim().length === 0) {
    return null;
  }
  return blocker.detail;
}

/** 阻塞原因的类别是否合法（防止构造出枚举外的 kind）。 */
export function isValidBlockerKind(kind: unknown): kind is BlockerKind {
  return typeof kind === 'string' && (BLOCKER_KINDS as readonly string[]).includes(kind);
}

/** 该项是否已有"明确结局"（终态且有对应结局证据）。 */
export function hasExplicitOutcome(item: WorkItem): boolean {
  if (!isTerminalStatus(item.status)) {
    return false;
  }
  if (item.status === 'completed') {
    return item.result_refs.length > 0;
  }
  if (item.status === 'failed') {
    return typeof item.failure_reason === 'string' && item.failure_reason.trim().length > 0;
  }
  return cancellationReasonOf(item) !== null;
}

/** 该项是否有"可指认的等待原因"（非终态时的 blocker_reason）。 */
export function hasWaitReason(item: WorkItem): boolean {
  const blocker = item.blocker_reason;
  return (
    !isTerminalStatus(item.status) &&
    blocker !== null &&
    isValidBlockerKind(blocker.kind) &&
    blocker.detail.trim().length > 0
  );
}

/**
 * 结局完整性判定（**纯函数、不抛错**）。返回空数组表示合格。
 * 这是 P4-09 的机器可读形式：`[]` 即"不存在既无结局也无原因的项"。
 */
export function evaluateOutcomeCompleteness(item: WorkItem): readonly OutcomeViolation[] {
  const violations: OutcomeViolation[] = [];
  const rid = item.request_id as unknown as string;

  if (typeof item.owner_instance_id !== 'string' || item.owner_instance_id.length === 0) {
    violations.push({ kind: 'missing_owner', request_id: rid, detail: 'owner_instance_id 为空' });
  }

  if (!isWorkItemStatus(item.status)) {
    violations.push({
      kind: 'status_out_of_enum',
      request_id: rid,
      detail: `status=${String(item.status)} 不在六态枚举内`,
    });
    // 状态未知时后续判定无意义，直接返回（只报告枚举外这一条）。
    return violations;
  }

  if (!isTerminalStatus(item.status)) {
    if (!hasWaitReason(item)) {
      violations.push({
        kind: 'non_terminal_without_wait_reason',
        request_id: rid,
        detail: `状态 ${item.status} 是非终态但没有可指认的等待/阻塞原因`,
      });
    }
    if (item.status === 'waiting_dependency' && item.dependency_refs.length === 0) {
      violations.push({
        kind: 'waiting_without_dependency_ref',
        request_id: rid,
        detail: '等待依赖未登记任何依赖项',
      });
    }
    return violations;
  }

  // --- 终态 ---
  if (item.status === 'completed' && item.result_refs.length === 0) {
    violations.push({
      kind: 'completed_without_result_ref',
      request_id: rid,
      detail: '已完成但没有结果引用（P4-10 / A03-10）',
    });
  }
  if (
    item.status === 'failed' &&
    (item.failure_reason === null || item.failure_reason.trim().length === 0)
  ) {
    violations.push({
      kind: 'failed_without_failure_reason',
      request_id: rid,
      detail: '失败但没有失败原因',
    });
  }
  if (item.status === 'cancelled' && cancellationReasonOf(item) === null) {
    violations.push({
      kind: 'cancelled_without_cancellation_reason',
      request_id: rid,
      detail: '取消但没有取消原因',
    });
  }
  return violations;
}

/** 断言结局完整；不合格即抛 `WorkLedgerError`（取第一条违反项的映射拒因）。 */
export function assertOutcomeCompleteness(item: WorkItem): void {
  const violations = evaluateOutcomeCompleteness(item);
  const first = violations[0];
  if (first === undefined) {
    return;
  }
  const reason = VIOLATION_TO_REJECTION[first.kind];
  throw new WorkLedgerError(
    reason,
    `工作项 ${first.request_id} 结局不完整：${OUTCOME_VIOLATION_LABELS[first.kind]}（${first.detail}）`,
  );
}

/** "结局完整性"族的拒因集合（供调用方归类，不参与判定）。 */
export const OUTCOME_REJECTION_REASONS: readonly WorkLedgerRejectionReason[] = [
  'missing_owner',
  'missing_blocker_reason',
  'missing_failure_reason',
  'missing_result_ref',
  'result_request_mismatch',
  'missing_cancellation_reason',
  'missing_dependency_ref',
  'invalid_blocker_kind',
  'unknown_status',
];

/** 该拒因是否属于"结局完整性"族。 */
export function isOutcomeRejection(reason: WorkLedgerRejectionReason): boolean {
  return OUTCOME_REJECTION_REASONS.includes(reason);
}

/** 可读的阻塞原因描述（证据 / 断言失败信息用）。 */
export function describeBlocker(blocker: BlockerReason | null): string {
  return blocker === null ? '（无等待原因）' : `${blocker.kind}: ${blocker.detail}`;
}
