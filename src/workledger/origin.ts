/**
 * 转换发起方的**身份与所有权判定**（P4 第 6 条；合同 §四 Q4-c、§九-3 / §九-9）。
 *
 * 硬要求：**终态不可被旧轮次或失去所有权的轮次回退**。
 * 本文件**不重写所有权逻辑**：轮次级判定直接复用 `src/protocol/run.ts` 的
 * `evaluateRunOwnership()`（D01 已落地、已由 run.test 覆盖其**全部 5 个**拒因，即
 * `src/protocol/constants.ts` 的 `PUBLICATION_REJECTION_REASONS`：
 * `unknown_run` / `not_run_owner` / `lease_expired` / `run_not_active` / `stale_task_revision`），
 * 只在其上补**任务范围核对**（R42.1/R42.2）与**工作项级**的负责人核对，并把 protocol 的拒因原样透出给调用方。
 *
 * 任务范围核对是本批（G01）新增的第 3 步：轮次只能发布**自己任务、自己冻结版本**的工作项。
 * 它不替代、也不依赖 `frozen_request_ids`——正常依赖解除轮次可以只带可运行输入（R42.3）。
 *
 * 两种发起方：
 * - `kernel`：内核自身的入口事务 / 取消命令 / 依赖解除写入。不是轮次发布，不做轮次所有权核对
 *   （但终态锁定等规则仍然适用，见 `ledger.ts`）。
 * - `run`：某一次运行轮次在结束时写入结果。**必须**通过所有权 + 租约 + 任务版本三道核对。
 */

import {
  evaluateRunOwnership,
  type InstanceState,
  type LogicalTime,
  type PublicationRejectionReason,
  type Revision,
  type RunRecord,
  type WorkItem,
} from '../protocol/index.js';

/** 内核自身发起的写入（消息入口事务、取消命令、依赖解除的可运行输入）。 */
export interface KernelOrigin {
  readonly kind: 'kernel';
  /** 仅用于诊断/证据的可读说明，不参与判定。 */
  readonly note?: string;
}

/** 由一次运行轮次发起的写入（轮次结束发布结果）。 */
export interface RunOrigin {
  readonly kind: 'run';
  /**
   * 发起写入的轮次记录。
   * `undefined` 表示"找不到该 run_id 的记录"——迟到的旧轮次可能已不在存储里，
   * 此时按 `unknown_run` 拒绝（与 protocol 的 `evaluateRunOwnership` 同一语义）。
   */
  readonly run: RunRecord | undefined;
  /** 该轮次所属实例的当前状态（`undefined` 表示实例已不存在）。 */
  readonly instance: InstanceState | undefined;
  /** 当前任务版本（stale 判定用）。 */
  readonly current_task_revision: Revision;
  /** 逻辑时钟读数（租约到期判定用；内核不自行推进时间，Q8-a）。 */
  readonly now: LogicalTime;
}

export type TransitionOrigin = KernelOrigin | RunOrigin;

/** 工作项级的归属拒因（与轮次级拒因区分）。 */
export const ORIGIN_REJECTION_REASONS = [
  'ownership_rejected',
  'stale_task_revision',
  'owner_mismatch',
  /**
   * 轮次与工作项**不属于同一任务**（R42.2，本批新增）。
   * 与 `stale_task_revision` 分开：跨任务是"范围不符"，不是"版本过时"。
   */
  'task_scope_mismatch',
] as const;

export type OriginRejectionReason = (typeof ORIGIN_REJECTION_REASONS)[number];

export interface OriginVerdict {
  readonly allowed: boolean;
  /** 不允许时的本层拒因；允许时为 null。 */
  readonly reason: OriginRejectionReason | null;
  /** 轮次级判定透出的 protocol 拒因（`unknown_run` / `not_run_owner` / `lease_expired` / …）。 */
  readonly ownership_reason: PublicationRejectionReason | null;
  readonly detail: string;
}

const ALLOWED: OriginVerdict = Object.freeze({
  allowed: true,
  reason: null,
  ownership_reason: null,
  detail: '允许写入',
});

/**
 * 判定发起方是否有权对 `item` 写入。
 *
 * 判定顺序（题面要求"终态不可被旧轮次或失去所有权的轮次回退"，本函数只负责"谁有权"）：
 * 1. `kernel` → 允许；
 * 2. `run`：`evaluateRunOwnership()` 六因判定（未知轮次 → 非活动 → 非所有者 → 租约过期 → 版本已变）；
 * 3. `run`：**范围核对**（R42.1/R42.2，本批新增）——轮次与工作项必须同任务同版本，
 *    先查 `task_id`（不符 → `task_scope_mismatch`），再查 `task_revision`（不符 → `stale_task_revision`）。
 *    先 `task_id` 后 `task_revision`：跨任务时**不得**报成 stale；
 * 4. `run`：轮次所属实例必须是该工作项的负责人（工作项级所有权，`owner_mismatch`）。
 *
 * 第 3 步只回答"这条工作项是否落在本轮的发布范围内"，与调用方的逐条发布粒度正交：
 * 一条被拒不影响同一请求内其它合法发布（`finishRun` 已按条 try/catch）。
 */
export function evaluateOrigin(
  origin: TransitionOrigin | undefined,
  item: WorkItem,
): OriginVerdict {
  const resolved: TransitionOrigin = origin ?? { kind: 'kernel' };

  if (resolved.kind === 'kernel') {
    return ALLOWED;
  }

  const run = resolved.run;
  if (run === undefined) {
    return {
      allowed: false,
      reason: 'ownership_rejected',
      ownership_reason: 'unknown_run',
      detail: `找不到发起写入的轮次记录，拒绝写入工作项 ${item.request_id}`,
    };
  }

  const validity = evaluateRunOwnership({
    run,
    instance: resolved.instance,
    now: resolved.now,
    current_task_revision: resolved.current_task_revision,
  });

  if (!validity.valid) {
    const reason: OriginRejectionReason =
      validity.reason === 'stale_task_revision' ? 'stale_task_revision' : 'ownership_rejected';
    return {
      allowed: false,
      reason,
      ownership_reason: validity.reason,
      detail: `轮次 ${run.run_id} 无权写入工作项 ${item.request_id}：${validity.reason}`,
    };
  }

  // --- 第 3 步：范围核对（R42.1/R42.2）---
  // 逐条发布粒度由调用方保证；这里只判定"这一条是否落在本轮任务范围内"。
  // 顺序硬性要求：先 task_id 再 task_revision——跨任务必须报 task_scope_mismatch，不得报成 stale。
  if (run.task_id !== item.task_id) {
    return {
      allowed: false,
      reason: 'task_scope_mismatch',
      ownership_reason: null,
      detail:
        `轮次 ${run.run_id} 属于任务 ${run.task_id}（冻结版本 ${run.task_revision}），` +
        `但工作项 ${item.request_id} 属于任务 ${item.task_id}（版本 ${item.task_revision}）：` +
        `任务范围不一致（R42.1 第 3 步/R42.2）`,
    };
  }

  if (run.task_revision !== item.task_revision) {
    return {
      allowed: false,
      reason: 'stale_task_revision',
      ownership_reason: null,
      detail:
        `轮次 ${run.run_id} 冻结的任务是 ${run.task_id}（版本 ${run.task_revision}），` +
        `但工作项 ${item.request_id} 的任务 ${item.task_id} 停在版本 ${item.task_revision}：` +
        `任务一致、版本不符，工作项版本已过时（R42.2）`,
    };
  }

  if (run.instance_id !== item.owner_instance_id) {
    return {
      allowed: false,
      reason: 'owner_mismatch',
      ownership_reason: null,
      detail:
        `轮次 ${run.run_id} 属于实例 ${run.instance_id}，` +
        `但工作项 ${item.request_id} 的负责人是 ${item.owner_instance_id}`,
    };
  }

  return ALLOWED;
}

/**
 * 发起方是否失去所有权（即"失去所有权的轮次"）。
 *
 * 归类（新拒因必须落在这里，避免与新判据矛盾）：
 * - 失去所有权：`ownership_rejected`（unknown_run / not_run_owner / run_not_active / lease_expired）、
 *   `owner_mismatch`、**`task_scope_mismatch`**（跨任务 = 这个发起方根本不在该任务的范围内）；
 * - 不属于失去所有权：`stale_task_revision`（任务**版本**已变，是"过时"而不是"越权"）。
 */
export function isOwnershipLost(origin: TransitionOrigin | undefined, item: WorkItem): boolean {
  const verdict = evaluateOrigin(origin, item);
  return !verdict.allowed && verdict.reason !== 'stale_task_revision';
}

/** 该发起方是否已 stale（任务版本已变）。 */
export function isStaleOrigin(origin: TransitionOrigin | undefined, item: WorkItem): boolean {
  return evaluateOrigin(origin, item).reason === 'stale_task_revision';
}
