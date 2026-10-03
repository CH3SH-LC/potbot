/**
 * **一句话改多个关联产物**的事务视图（FA-CHAT-FACTS / CHAT-06；合同 **R213 / R251**，
 * 能力目录 CHAT-06，design-06 §2）。
 *
 * ## 这一层解决什么
 *
 * `dependency-invalidation.ts` 算出"哪些产物受影响"；本文件把同一件事编排成**一次可核对的
 * 事务视图**：事实更新（8 → 10）→ 受影响产物集合 → 各自新版本 → 未受影响的产物 → 过期气泡，
 * 全部装进一个 `MultiArtifactTransactionView`，供前台"改了哪些、哪些没动、凭据是什么"
 * （design-02 A07 的验收话术）直接取用。
 *
 * ## 与失效计划的分工（**不在本层重复实现**）
 *
 * - 依赖闭包、只更新受影响产物、旧气泡过期 —— 全部由
 *   `planInvalidation()` 计算，本层**只读它的输出**；
 * - 本层额外做的是**呈现与核对**：把事实键的旧值 / 新值摊开成可读视图、
 *   把每条受影响产物展开成"旧 id → 新 id / 旧版本 → 新版本 / 依据"的一行、
 *   汇总计数、给出确定性的复核摘要（`review_digest`）。
 *
 * ## "无关信息不重写"是可断言的
 *
 * `untouched_artifact_ids` 是**明确不动**的清单，与 `artifact_entries` **不相交**。
 * `checkTransactionView()` 同时核验两侧：
 * - 内部一致性：`duplicate_artifact_entry` / `untouched_overlaps_updated` / `totals_mismatch`；
 * - 对实然的反向对照：`unrelated_artifact_rewritten`（无关产物被重写）、
 *   `affected_artifact_missing`（该更新的没更新）、`expired_bubble_executed`（旧气泡被执行）。
 *
 * ## 事实值缺失的纪律
 *
 * `fact_changes[].previous_value` / `new_value` 在**未提供对应事实记录**时为 `null`
 * —— 那表示"未登记"，**不表示 0 / 空**（R248：缺失不当零）。本层绝不补默认值。
 *
 * 纯函数、零 IO、无墙钟、无随机数：`at` 由调用方以 `LogicalTime` 传入。
 */

import {
  type ArtifactRecord,
  type ArtifactRef,
  type FactRef,
  type LogicalTime,
  type Revision,
  type SharedFactRecord,
  type SharedFactValue,
  type TaskId,
  type TemplateKind,
  ValidationError,
} from '../protocol/index.js';
import { type ActionLedgerRejectionReason, type ActionRecord, type DecisionBubble } from '../workledger/action-ledger.js';
import { compareStrings } from '../dependency/graph.js';
import { canonicalDigest } from '../dependency/digest.js';
import {
  type AffectedArtifact,
  type BubbleInvalidation,
  type FactChangeAffectReason,
  type FactChangeBinding,
  type SharedFactUpdate,
  checkInvalidationPlan,
  planInvalidation,
} from './dependency-invalidation.js';

// ---------------------------------------------------------------------------
// 指令
// ---------------------------------------------------------------------------

/**
 * 一条"改多个关联产物"的指令。`from_revision` → `to_revision` 即**版本绑定**：
 * 事实与产物的新版本都落在 `to_revision` 上。`current_task_revision` 给出时用于过期判定
 * （不一致 ⇒ 指令过期，拒绝执行，见 `planInvalidation`）。
 */
export interface MultiArtifactInstruction {
  readonly instruction_id: string;
  readonly utterance: string;
  readonly task_id: TaskId;
  readonly from_revision: Revision;
  readonly to_revision: Revision;
  readonly at: LogicalTime;
  readonly current_task_revision?: Revision;
}

export interface MultiArtifactUpdateRequest {
  readonly instruction: MultiArtifactInstruction;
  readonly updates: readonly SharedFactUpdate[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly bubbles?: readonly DecisionBubble[];
  readonly actions?: readonly ActionRecord[];
  /**
   * 已知的共享事实记录（供呈现旧值 / 新值）。省略 ⇒ 视图里的事实值如实标 `null`（未登记），
   * **不猜、不补零**。
   */
  readonly facts?: readonly SharedFactRecord[];
}

// ---------------------------------------------------------------------------
// 事务视图
// ---------------------------------------------------------------------------

/** 一条事实变更的可读视图（旧值 → 新值）。 */
export interface FactChangeView {
  readonly fact_key: string;
  readonly previous_fact_id: FactRef | null;
  readonly new_fact_id: FactRef;
  /** 旧值；未提供事实记录时为 `null`（未登记，**不表示零**）。 */
  readonly previous_value: SharedFactValue | null;
  /** 新值；未提供事实记录时为 `null`（未登记，**不表示零**）。 */
  readonly new_value: SharedFactValue | null;
}

/** 一条受影响产物在事务里的展开。 */
export interface ArtifactTransactionEntry {
  /** 现有产物 id（重写后改判 `superseded`，保留为历史）。 */
  readonly artifact_id: ArtifactRef;
  /** 派生出的新版本产物 id。 */
  readonly new_artifact_id: ArtifactRef;
  readonly template_kind: TemplateKind;
  readonly from_version: number;
  readonly to_version: number;
  /** 新版本所绑定的任务版本。 */
  readonly task_revision: Revision;
  readonly reason: FactChangeAffectReason;
  readonly via_fact_keys: readonly string[];
  readonly via_artifact_ids: readonly ArtifactRef[];
}

/** 汇总计数（供前台"改了哪些、哪些没动"直接展示）。 */
export interface MultiArtifactTotals {
  readonly facts_changed: number;
  readonly artifacts_updated: number;
  readonly artifacts_untouched: number;
  readonly artifacts_preserved: number;
  readonly bubbles_total: number;
  readonly bubbles_expired: number;
}

/** 一次多产物更新的事务视图（可核对、可复现）。 */
export interface MultiArtifactTransactionView {
  readonly instruction_id: string;
  readonly utterance: string;
  readonly task_id: TaskId;
  readonly from_revision: Revision;
  readonly to_revision: Revision;
  readonly at: LogicalTime;
  readonly fact_changes: readonly FactChangeView[];
  readonly artifact_entries: readonly ArtifactTransactionEntry[];
  /** 明确不动、**不重写**的产物 id（升序）；与 `artifact_entries` 不相交。 */
  readonly untouched_artifact_ids: readonly ArtifactRef[];
  /** 历史产物 id（保留、不重写）（升序）。 */
  readonly preserved_artifact_ids: readonly ArtifactRef[];
  readonly bubble_entries: readonly BubbleInvalidation[];
  readonly totals: MultiArtifactTotals;
  /** 复核摘要（确定性；含所有上游失效计划要素）。 */
  readonly review_digest: string;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串（收到 ${JSON.stringify(value ?? null)}）`);
  }
  return value;
}

function requireRevision(value: unknown, field: string): Revision {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是 ≥ 0 的整数`);
  }
  return value as Revision;
}

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间）`);
  }
  return value as LogicalTime;
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

function valueOf(
  byFactId: ReadonlyMap<string, SharedFactRecord>,
  factRef: FactRef | null,
): SharedFactValue | null {
  if (factRef === null) {
    return null;
  }
  const record = byFactId.get(String(factRef));
  return record === undefined ? null : record.value;
}

function buildFactChanges(
  updates: readonly SharedFactUpdate[],
  facts: readonly SharedFactRecord[] | undefined,
): readonly FactChangeView[] {
  const byFactId = new Map<string, SharedFactRecord>();
  for (const fact of facts ?? []) {
    byFactId.set(String(fact.fact_id), fact);
  }
  return Object.freeze(
    updates.map((update): FactChangeView =>
      Object.freeze({
        fact_key: update.fact_key,
        previous_fact_id: update.previous_fact_id,
        new_fact_id: update.new_fact_id,
        previous_value: valueOf(byFactId, update.previous_fact_id),
        new_value: valueOf(byFactId, update.new_fact_id),
      }),
    ),
  );
}

function toEntry(affected: AffectedArtifact, taskRevision: Revision): ArtifactTransactionEntry {
  return Object.freeze({
    artifact_id: affected.artifact_id,
    new_artifact_id: affected.new_artifact_id,
    template_kind: affected.template_kind,
    from_version: affected.from_version,
    to_version: affected.to_version,
    task_revision: taskRevision,
    reason: affected.reason,
    via_fact_keys: affected.via_fact_keys,
    via_artifact_ids: affected.via_artifact_ids,
  });
}

function bindingOf(instruction: MultiArtifactInstruction): FactChangeBinding {
  requireNonEmptyString(instruction.instruction_id, 'MultiArtifactInstruction.instruction_id');
  requireNonEmptyString(instruction.utterance, 'MultiArtifactInstruction.utterance');
  requireNonEmptyString(instruction.task_id, 'MultiArtifactInstruction.task_id');
  const fromRevision = requireRevision(instruction.from_revision, 'MultiArtifactInstruction.from_revision');
  const toRevision = requireRevision(instruction.to_revision, 'MultiArtifactInstruction.to_revision');
  requireLogicalTime(instruction.at, 'MultiArtifactInstruction.at');
  if (toRevision < fromRevision) {
    throw new ValidationError(
      `to_revision（${Number(toRevision)}）不得小于 from_revision（${Number(fromRevision)}）：任务版本只增不减`,
    );
  }
  return {
    instruction_id: instruction.instruction_id,
    utterance: instruction.utterance,
    task_id: instruction.task_id,
    task_revision: toRevision,
    ...(instruction.current_task_revision === undefined
      ? {}
      : { current_task_revision: instruction.current_task_revision }),
    at: instruction.at,
  };
}

/**
 * 构造一次多产物更新的事务视图（纯函数）。
 *
 * @throws {ValidationError} 指令 / 事实更新形状非法，或 `to_revision < from_revision`。
 * @throws {DependencyError} 语义拒绝（指令版本过期；`bubbles` 非空却未给 `actions`）。
 */
export function buildMultiArtifactTransaction(
  request: MultiArtifactUpdateRequest,
): MultiArtifactTransactionView {
  const binding = bindingOf(request.instruction);
  const plan = planInvalidation({
    binding,
    updates: request.updates ?? [],
    artifacts: request.artifacts ?? [],
    ...(request.bubbles === undefined ? {} : { bubbles: request.bubbles }),
    ...(request.actions === undefined ? {} : { actions: request.actions }),
  });

  const factChanges = buildFactChanges(plan.updates, request.facts);
  const entries = Object.freeze(
    plan.affected.map((affected) => toEntry(affected, binding.task_revision)),
  );
  const bubblesExpired = plan.expired_bubble_ids.length;

  const totals: MultiArtifactTotals = Object.freeze({
    facts_changed: factChanges.length,
    artifacts_updated: entries.length,
    artifacts_untouched: plan.untouched_artifact_ids.length,
    artifacts_preserved: plan.preserved_artifact_ids.length,
    bubbles_total: plan.bubbles.length,
    bubbles_expired: bubblesExpired,
  });

  const reviewDigest = canonicalDigest(
    JSON.stringify([
      plan.digest,
      factChanges.map((change) => [
        change.fact_key,
        change.previous_fact_id === null ? null : String(change.previous_fact_id),
        String(change.new_fact_id),
      ]),
      entries.map((entry) => [
        String(entry.artifact_id),
        String(entry.new_artifact_id),
        entry.from_version,
        entry.to_version,
        entry.reason,
      ]),
      plan.untouched_artifact_ids.map(String),
      plan.preserved_artifact_ids.map(String),
      plan.expired_bubble_ids,
    ]),
  );

  return Object.freeze({
    instruction_id: binding.instruction_id,
    utterance: binding.utterance,
    task_id: binding.task_id,
    from_revision: request.instruction.from_revision,
    to_revision: binding.task_revision,
    at: binding.at,
    fact_changes: factChanges,
    artifact_entries: entries,
    untouched_artifact_ids: plan.untouched_artifact_ids,
    preserved_artifact_ids: plan.preserved_artifact_ids,
    bubble_entries: plan.bubbles,
    totals,
    review_digest: reviewDigest,
  });
}

// ---------------------------------------------------------------------------
// 核对：内部一致性 + 反向对照
// ---------------------------------------------------------------------------

export const TRANSACTION_VIOLATION_CODES = [
  'duplicate_artifact_entry', // 同一源产物在视图里出现两次
  'untouched_overlaps_updated', // "不动清单"与"条目清单"相交（自相矛盾）
  'totals_mismatch', // 汇总计数与明细不符
  'unrelated_artifact_rewritten', // 反向对照①：无关产物被重写
  'affected_artifact_missing', // 反向对照②：受影响产物未被更新
  'expired_bubble_executed', // 反向对照③：过期气泡被执行
] as const;
export type TransactionViolationCode = (typeof TRANSACTION_VIOLATION_CODES)[number];

export interface TransactionViolation {
  readonly code: TransactionViolationCode;
  readonly subject_id: string;
  readonly detail: string;
}

/** "实然"观测：实现实际更新了哪些产物（按源产物 id）、执行了哪些气泡。 */
export interface TransactionObservation {
  readonly updated_artifact_ids: readonly ArtifactRef[];
  readonly executed_bubble_ids?: readonly string[];
}

function txViolation(
  code: TransactionViolationCode,
  subjectId: string,
  detail: string,
): TransactionViolation {
  return Object.freeze({ code, subject_id: subjectId, detail });
}

/**
 * 核验事务视图：先查内部一致性（`duplicate_artifact_entry` / `untouched_overlaps_updated` /
 * `totals_mismatch`），给出 `observation` 时再做反向对照。返回全部违规（不抛错）。
 * 空数组 ⟺ 视图自洽且与实然一致。
 */
export function checkTransactionView(
  view: MultiArtifactTransactionView,
  observation?: TransactionObservation,
): readonly TransactionViolation[] {
  const violations: TransactionViolation[] = [];

  const updated = new Set<string>();
  for (const entry of view.artifact_entries) {
    const id = String(entry.artifact_id);
    if (updated.has(id)) {
      violations.push(
        txViolation('duplicate_artifact_entry', id, `源产物 ${id} 在事务视图里出现了两次`),
      );
      continue;
    }
    updated.add(id);
  }

  for (const raw of view.untouched_artifact_ids) {
    const id = String(raw);
    if (updated.has(id)) {
      violations.push(
        txViolation(
          'untouched_overlaps_updated',
          id,
          `产物 ${id} 同时出现在"已更新"与"不动清单"里：视图自相矛盾，无法据此判断是否重写`,
        ),
      );
    }
  }

  const totals = view.totals;
  if (totals.artifacts_updated !== view.artifact_entries.length) {
    violations.push(
      txViolation(
        'totals_mismatch',
        'artifacts_updated',
        `汇总计数 ${totals.artifacts_updated} 与条目数 ${view.artifact_entries.length} 不符`,
      ),
    );
  }
  if (totals.artifacts_untouched !== view.untouched_artifact_ids.length) {
    violations.push(
      txViolation(
        'totals_mismatch',
        'artifacts_untouched',
        `汇总计数 ${totals.artifacts_untouched} 与不动清单长度 ${view.untouched_artifact_ids.length} 不符`,
      ),
    );
  }
  if (totals.facts_changed !== view.fact_changes.length) {
    violations.push(
      txViolation(
        'totals_mismatch',
        'facts_changed',
        `汇总计数 ${totals.facts_changed} 与事实变更数 ${view.fact_changes.length} 不符`,
      ),
    );
  }
  const expiredCount = view.bubble_entries.filter((bubble) => bubble.expired).length;
  if (totals.bubbles_expired !== expiredCount) {
    violations.push(
      txViolation(
        'totals_mismatch',
        'bubbles_expired',
        `汇总计数 ${totals.bubbles_expired} 与过期气泡数 ${expiredCount} 不符`,
      ),
    );
  }

  if (observation === undefined) {
    return Object.freeze(violations);
  }

  const untouched = new Set(view.untouched_artifact_ids.map(String));
  const observed = new Set<string>();
  for (const raw of observation.updated_artifact_ids) {
    const id = String(raw);
    observed.add(id);
    if (untouched.has(id)) {
      violations.push(
        txViolation(
          'unrelated_artifact_rewritten',
          id,
          `产物 ${id} 在"不动清单"里，实现却重写了它：无关信息不得重写（R251）`,
        ),
      );
    }
  }
  for (const id of [...updated].sort(compareStrings)) {
    if (!observed.has(id)) {
      violations.push(
        txViolation(
          'affected_artifact_missing',
          id,
          `产物 ${id} 在受影响集合内，实现却没有更新它：受影响产物必须同版更新（R213）`,
        ),
      );
    }
  }
  const expired = new Set(view.bubble_entries.filter((bubble) => bubble.expired).map((b) => b.bubble_id));
  for (const bubbleId of [...(observation.executed_bubble_ids ?? [])].sort(compareStrings)) {
    if (expired.has(bubbleId)) {
      violations.push(
        txViolation(
          'expired_bubble_executed',
          bubbleId,
          `过期气泡 ${bubbleId} 被执行：旧 revision 的气泡不得再执行（R213）`,
        ),
      );
    }
  }

  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------
// 可读输出（证据用）
// ---------------------------------------------------------------------------

function describeValue(value: SharedFactValue | null): string {
  if (value === null) {
    return '（未登记，≠ 0）';
  }
  switch (value.kind) {
    case 'known': {
      const payload = value.value;
      switch (payload.type) {
        case 'number':
          return `${payload.amount} ${payload.unit}${payload.currency === null ? '' : ` ${payload.currency}`}`;
        case 'date':
          return `${payload.iso_date}（${payload.time_zone}）`;
        case 'text':
          return payload.text;
      }
    }
    // eslint 风格上不可达，但判别联合需要穷尽分支
    case 'unknown':
      return `未知（${value.reason}）`;
    case 'not_applicable':
      return `不适用（${value.reason}）`;
  }
}

/** 单行摘要：改了哪几项事实、更新了哪些产物、哪些没动、哪些气泡过期。 */
export function describeTransactionView(view: MultiArtifactTransactionView): string {
  const facts = view.fact_changes
    .map((change) => `${change.fact_key}: ${describeValue(change.previous_value)} → ${describeValue(change.new_value)}`)
    .join('；');
  const updated = view.artifact_entries
    .map((entry) => `${String(entry.artifact_id)}→${String(entry.new_artifact_id)}(v${entry.from_version}→v${entry.to_version})`)
    .join('、');
  return (
    `指令 ${view.instruction_id}（${view.utterance}）r${Number(view.from_revision)}→r${Number(view.to_revision)}：` +
    `事实 ${facts || '（无）'}；已更新 ${view.totals.artifacts_updated} 个 [${updated}]；` +
    `未动 ${view.totals.artifacts_untouched} 个；历史保留 ${view.totals.artifacts_preserved} 个；` +
    `过期气泡 ${view.totals.bubbles_expired}/${view.totals.bubbles_total}`
  );
}
