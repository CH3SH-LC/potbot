/**
 * 共享事实更新的**依赖失效**（FA-CHAT-FACTS / CHAT-06；合同 **R213 / R248 / R251**，
 * 能力目录 CHAT-06，design-06 §2）。
 *
 * ## 这一层解决什么
 *
 * 用户一句话（如「人数改成十人」）会改动**共享事实**。事实的单一来源一变，
 * 引用它的一切产物就不再是"反映了当前事实"的产物。R213 把处置口径钉成四步：
 *
 * > 共享事实更新 → **依赖失效** → **只更新受影响产物** → **旧气泡过期**；**保留历史版本**。
 *
 * 本文件把这四步做成**纯函数**：输入是绑定、事实更新、候选产物与气泡，输出一张可核对的
 * **失效计划**（`ArtifactInvalidationPlan`）。它不写盘、不碰存储、不推进时间。
 *
 * ## 四步各自的机器判据
 *
 * 1. **版本绑定**（`FactChangeBinding`）：一句话绑到 `(task_id, task_revision)`。
 *    若指令绑定的版本已不是当前版本（`current_task_revision` 更高），本层**拒绝**执行
 *    （`DependencyError`：迟到指令不得改错版本，R210）——而不是"就近套用"。
 * 2. **依赖失效**：直接命中 = 产物引用的**被改事实**（`source_fact_refs` ∩ 被取代的
 *    `previous_fact_id`）；传递命中 = 产物依赖（`dependency_artifact_refs`）到某个已失效产物。
 *    闭包用**带访问集的有界 BFS** 计算：每个产物最多入队一次、最多出队一次
 *    ⇒ 环 / 自环下也**必然终止**（`closure_visits` 每项恒为 1，是可核对的终止证据）。
 * 3. **只更新受影响产物**：只有闭包内的产物进入 `affected`（各自 `artifact_version + 1`、
 *    派生新 id）。其余**可写**产物进 `untouched_artifact_ids`——这正是"无关信息不重写"的
 *    机器清单；历史产物（`superseded` / `expired` / `failed`）进 `preserved_artifact_ids`，
 *    **不得被重写**（保留历史版本）。
 * 4. **旧气泡过期**：逐个气泡按**动作台账的同一判据**判定（复用
 *    `evaluateBubbleExecution`）——版本已推进 ⇒ `stale_bubble`；参数已变 ⇒
 *    `bubble_action_mismatch`；动作记录缺失 ⇒ `unknown_action`。判定为过期的气泡 id 进
 *    `expired_bubble_ids`，**不得再被执行**。
 *
 * ## 反向对照（本层自带的"抓错器"）
 *
 * `checkInvalidationPlan()` 拿"计划的应然"对"实现的实然"：
 * `unaffected_artifact_rewritten`（改了人数却把无关段落也重写）、
 * `affected_artifact_not_rewritten`（该改的没改）、`expired_bubble_executed`（旧气泡仍被执行）、
 * `history_not_preserved`（旧版本被覆盖）、`duplicate_rewrite`（同一产物被写两次）。
 * 因此"只更新受影响产物"不是一句口号，而是可被断言的两侧清单。
 *
 * ## 与既有模块的关系（**只读复用**，不改它们）
 *
 * - `src/protocol`：`ArtifactRecord` / `DecisionBubble` 的载体形状与品牌类型；
 * - `src/workledger/action-ledger`：**气泡可执行性的唯一判据**（本层不另造一套）；
 * - `src/dependency`：`compareStrings` / `uniqueSorted`（确定性排序）、`canonicalDigest`
 *   （计划摘要）、`DependencyError`（"算不出 / 不允许"）；
 * - `src/artifacts/planner`：新版本产物 id 的**唯一派生实现**（本层不另写一套 id 规则）。
 *
 * ## 纪律
 *
 * 纯函数、零 IO、无墙钟、无随机数：时间一律由调用方以 `LogicalTime` 传入（Q8-a / Q8-c）。
 */

import {
  type ActionRef,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactStatus,
  type FactRef,
  type LogicalTime,
  type Revision,
  type TaskId,
  type TemplateKind,
  ValidationError,
} from '../protocol/index.js';
import { compareStrings, uniqueSorted } from '../dependency/graph.js';
import { canonicalDigest } from '../dependency/digest.js';
import { DependencyError } from '../dependency/errors.js';
import {
  type ActionLedgerRejectionReason,
  type ActionRecord,
  type DecisionBubble,
  evaluateBubbleExecution,
} from '../workledger/action-ledger.js';
import { deriveArtifactId } from '../artifacts/planner.js';

// ---------------------------------------------------------------------------
// 版本绑定
// ---------------------------------------------------------------------------

/**
 * 一句话 → 共享事实新版本的**版本绑定**。
 *
 * `utterance` 只作可读证据（"用户原话是什么"），**不参与**任何判定——
 * 机器判定只看 `task_id` / `task_revision`，绝不用文本相似度猜要改哪个任务（R210）。
 */
export interface FactChangeBinding {
  /** 指令 id（幂等去重的身份；同一指令重放必须得到同一计划摘要）。 */
  readonly instruction_id: string;
  /** 用户原话（可读证据，不参与判定）。 */
  readonly utterance: string;
  readonly task_id: TaskId;
  /** 指令**绑定**的任务版本：新事实与受影响产物的新版本都落在这个版本上。 */
  readonly task_revision: Revision;
  /**
   * **当前**任务版本（给出时用于过期判定）。与 `task_revision` 不一致 ⇒ 指令过期，
   * 本层**拒绝**（必须重新确认），而不是改到别的版本上。
   */
  readonly current_task_revision?: Revision;
  readonly at: LogicalTime;
}

/** 指令是否已过期（绑定的版本不再是当前版本）。未给 `current_task_revision` ⇒ 不判过期。 */
export function isInstructionStale(binding: FactChangeBinding): boolean {
  return (
    binding.current_task_revision !== undefined &&
    binding.current_task_revision !== binding.task_revision
  );
}

// ---------------------------------------------------------------------------
// 事实更新
// ---------------------------------------------------------------------------

/**
 * 一次**共享事实更新**：某个稳定事实键从旧事实换成新事实。
 *
 * `previous_fact_id` 是**产物当前引用**的那条事实（失效匹配就靠它）；
 * 首次登记（无前身）时为 `null`——此时它不会让任何产物"直接命中"，这是如实语义，
 * 而不是"没有前身就当 0"。
 */
export interface SharedFactUpdate {
  readonly fact_key: string;
  readonly previous_fact_id: FactRef | null;
  readonly new_fact_id: FactRef;
}

// ---------------------------------------------------------------------------
// 受影响产物
// ---------------------------------------------------------------------------

/** 产物被判失效的原因（封闭枚举）。 */
export const FACT_CHANGE_AFFECT_REASONS = [
  'source_fact_changed', // 直接命中：产物引用了被改的共享事实
  'dependency_artifact_changed', // 传递命中：产物依赖到某个已失效产物
] as const;
export type FactChangeAffectReason = (typeof FACT_CHANGE_AFFECT_REASONS)[number];

/** 一个将被重写的产物（旧记录保留为历史，新版本派生新 id）。 */
export interface AffectedArtifact {
  /** 现有产物 id（旧版本；重写后改判 `superseded`，**保留为历史**）。 */
  readonly artifact_id: ArtifactRef;
  readonly template_kind: TemplateKind;
  /** 现有产物版本。 */
  readonly from_version: number;
  /** 新版本号（`from_version + 1`）。 */
  readonly to_version: number;
  /** 派生出的新版本产物 id（`deriveArtifactId`，确定性、必定与旧 id 不同）。 */
  readonly new_artifact_id: ArtifactRef;
  readonly reason: FactChangeAffectReason;
  /** 直接命中时：命中的事实键（升序去重）；传递命中时为空。 */
  readonly via_fact_keys: readonly string[];
  /** 传递命中时：经由的上游产物 id（本层取最短路径上的直接父）；直接命中时为空。 */
  readonly via_artifact_ids: readonly ArtifactRef[];
  /** 闭包深度：0 = 直接命中，≥1 = 传递命中。 */
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// 气泡失效
// ---------------------------------------------------------------------------

/** 一个气泡在本次变更后的可执行性判定。 */
export interface BubbleInvalidation {
  readonly bubble_id: string;
  readonly action_id: ActionRef;
  /** **过期 ⇒ 不可再执行**。 */
  readonly expired: boolean;
  /** 过期原因；`expired === false` 时为 `null`。词表复用动作台账的拒因。 */
  readonly reason: ActionLedgerRejectionReason | null;
  /** 可读说明（判据给出，本层不另造文本）。 */
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 请求与计划
// ---------------------------------------------------------------------------

export interface InvalidationRequest {
  readonly binding: FactChangeBinding;
  readonly updates: readonly SharedFactUpdate[];
  /** 候选产物（可跨任务；只有 `binding.task_id` 的产物进入判定）。 */
  readonly artifacts: readonly ArtifactRecord[];
  /** 前台展示过的决策气泡（可选）。 */
  readonly bubbles?: readonly DecisionBubble[];
  /**
   * 动作台账读数（`bubbles` 非空时**必须**给出）。
   * 缺失 ⇒ 抛 `DependencyError`：没有真实动作对象就无法判"气泡是否过期"，
   * 本层**拒绝猜**（与 R212"气泡引用真实动作对象"一致）。
   */
  readonly actions?: readonly ActionRecord[];
}

/** 失效计划：四步的可核对产物。 */
export interface ArtifactInvalidationPlan {
  readonly binding: FactChangeBinding;
  /** 去重、按 `fact_key` 升序的更新（与输入顺序无关 ⇒ 重放得到同一摘要）。 */
  readonly updates: readonly SharedFactUpdate[];
  /** 将被重写的产物（按 `artifact_id` 升序）。 */
  readonly affected: readonly AffectedArtifact[];
  /** 明确**不动**的可写产物 id（升序）——"无关信息不重写"的机器清单。 */
  readonly untouched_artifact_ids: readonly ArtifactRef[];
  /** 历史产物 id（`superseded` / `expired` / `failed`，落库保留、**不得重写**）（升序）。 */
  readonly preserved_artifact_ids: readonly ArtifactRef[];
  readonly bubbles: readonly BubbleInvalidation[];
  /** 已过期、**不得再执行**的气泡 id（升序）。 */
  readonly expired_bubble_ids: readonly string[];
  /** 闭包终止证据：每个产物被出队的次数（健全实现下**每项恒为 1**）。 */
  readonly closure_visits: Readonly<Record<string, number>>;
  /** 计划摘要（确定性；含指令 id、绑定版本、受影响集合与过期气泡集合）。 */
  readonly digest: string;
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

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间）`);
  }
  return value as LogicalTime;
}

function validateBinding(binding: FactChangeBinding): void {
  requireNonEmptyString(binding.instruction_id, 'FactChangeBinding.instruction_id');
  requireNonEmptyString(binding.utterance, 'FactChangeBinding.utterance');
  requireNonEmptyString(binding.task_id, 'FactChangeBinding.task_id');
  requireLogicalTime(binding.at, 'FactChangeBinding.at');
  if (!Number.isInteger(binding.task_revision) || binding.task_revision < 0) {
    throw new ValidationError('FactChangeBinding.task_revision 必须是 ≥ 0 的整数');
  }
  if (binding.current_task_revision !== undefined) {
    if (!Number.isInteger(binding.current_task_revision) || binding.current_task_revision < 0) {
      throw new ValidationError('FactChangeBinding.current_task_revision 必须是 ≥ 0 的整数');
    }
    if (isInstructionStale(binding)) {
      throw new DependencyError(
        `指令 ${binding.instruction_id} 绑定任务版本 ${Number(binding.task_revision)}，` +
          `但当前版本已是 ${Number(binding.current_task_revision)}：` +
          '迟到指令不得改错版本，必须绑定到正确版本后重新确认（R210）',
      );
    }
  }
}

function normalizeUpdates(updates: readonly SharedFactUpdate[]): readonly SharedFactUpdate[] {
  const seen = new Map<string, SharedFactUpdate>();
  for (const update of updates) {
    const key = requireNonEmptyString(update.fact_key, 'SharedFactUpdate.fact_key');
    const newFactId = requireNonEmptyString(update.new_fact_id, 'SharedFactUpdate.new_fact_id') as FactRef;
    let previous: FactRef | null = null;
    if (update.previous_fact_id !== null && update.previous_fact_id !== undefined) {
      previous = requireNonEmptyString(
        update.previous_fact_id,
        'SharedFactUpdate.previous_fact_id',
      ) as FactRef;
      if (previous === newFactId) {
        throw new ValidationError(
          `事实键 ${key} 的更新 previous_fact_id === new_fact_id：事实不能取代自己`,
        );
      }
    }
    if (seen.has(key)) {
      throw new ValidationError(
        `一次指令里事实键 ${key} 出现了两次：同一键的最终值不确定，必须显式失败而非任取一条`,
      );
    }
    seen.set(key, Object.freeze({ fact_key: key, previous_fact_id: previous, new_fact_id: newFactId }));
  }
  return Object.freeze([...seen.values()].sort((left, right) => compareStrings(left.fact_key, right.fact_key)));
}

// ---------------------------------------------------------------------------
// 闭包（有界 BFS）
// ---------------------------------------------------------------------------

/** 可被"同版更新"重写的产物状态：只有活的产物进入候选。 */
const REWRITABLE_ARTIFACT_STATUSES: readonly ArtifactStatus[] = Object.freeze(['published', 'staged']);

interface ClosureNode {
  readonly id: ArtifactRef;
  readonly reason: FactChangeAffectReason;
  readonly viaFactorKeys: readonly string[];
  readonly viaArtifactIds: readonly ArtifactRef[];
  readonly depth: number;
}

interface ClosureResult {
  readonly affected: readonly AffectedArtifact[];
  readonly untouched_artifact_ids: readonly ArtifactRef[];
  readonly preserved_artifact_ids: readonly ArtifactRef[];
  readonly closure_visits: Readonly<Record<string, number>>;
}

/**
 * 计算失效闭包（有界 BFS）。
 *
 * **终止性**：`queued` 集合保证每个产物最多入队一次、`visited` 保证最多出队一次
 * ⇒ 即便产物依赖图存在环或自环也不会无限循环。`closure_visits` 记录出队次数，健全实现下恒为 1。
 */
function computeClosure(
  binding: FactChangeBinding,
  updates: readonly SharedFactUpdate[],
  artifacts: readonly ArtifactRecord[],
): ClosureResult {
  // 1. 只判本任务的产物；历史产物原样保留、不进候选。
  const scoped = artifacts.filter((artifact) => artifact.task_id === binding.task_id);
  const candidates: ArtifactRecord[] = [];
  const preserved: ArtifactRef[] = [];
  for (const artifact of scoped) {
    if (REWRITABLE_ARTIFACT_STATUSES.includes(artifact.status)) {
      candidates.push(artifact);
    } else {
      preserved.push(artifact.artifact_id);
    }
  }

  const byId = new Map<string, ArtifactRecord>();
  for (const candidate of candidates) {
    byId.set(candidate.artifact_id, candidate);
  }

  // 2. 被改事实 id → 事实键（直接命中的匹配表）。
  const previousFactKeys = new Map<string, string[]>();
  for (const update of updates) {
    if (update.previous_fact_id === null) {
      continue;
    }
    const bucket = previousFactKeys.get(update.previous_fact_id);
    if (bucket === undefined) {
      previousFactKeys.set(update.previous_fact_id, [update.fact_key]);
    } else {
      bucket.push(update.fact_key);
    }
  }

  // 3. 产物依赖的反向邻接表：被依赖产物 id → 依赖它的候选产物。
  const dependents = new Map<string, string[]>();
  for (const candidate of candidates) {
    for (const dependency of candidate.dependency_artifact_refs) {
      if (!byId.has(dependency)) {
        continue; // 依赖指向非候选（历史 / 外部）：不构成图内边，与 D05 依赖图同一纪律
      }
      const bucket = dependents.get(dependency);
      if (bucket === undefined) {
        dependents.set(dependency, [candidate.artifact_id]);
      } else {
        bucket.push(candidate.artifact_id);
      }
    }
  }

  // 4. BFS：直接命中为深度 0 的种子；沿反向邻接表传播。
  const queue: ClosureNode[] = [];
  const queued = new Set<string>();
  const visited = new Map<string, AffectedArtifact>();
  const visits: Record<string, number> = {};

  const seeds: { readonly artifact: ArtifactRecord; readonly keys: string[] }[] = [];
  for (const candidate of candidates) {
    const keys: string[] = [];
    for (const ref of candidate.source_fact_refs) {
      const matched = previousFactKeys.get(ref);
      if (matched !== undefined) {
        keys.push(...matched);
      }
    }
    if (keys.length > 0) {
      seeds.push({ artifact: candidate, keys: uniqueSorted(keys) });
    }
  }
  seeds.sort((left, right) => compareStrings(left.artifact.artifact_id, right.artifact.artifact_id));
  for (const seed of seeds) {
    if (queued.has(seed.artifact.artifact_id)) {
      continue;
    }
    queued.add(seed.artifact.artifact_id);
    queue.push({
      id: seed.artifact.artifact_id,
      reason: 'source_fact_changed',
      viaFactorKeys: Object.freeze(seed.keys),
      viaArtifactIds: Object.freeze([]),
      depth: 0,
    });
  }

  let head = 0;
  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    if (node === undefined) {
      break;
    }
    const id = String(node.id);
    visits[id] = (visits[id] ?? 0) + 1;
    if (visited.has(id)) {
      continue;
    }
    const record = byId.get(id);
    if (record === undefined) {
      continue;
    }
    visited.set(
      id,
      Object.freeze({
        artifact_id: record.artifact_id,
        template_kind: record.template_kind,
        from_version: record.artifact_version,
        to_version: record.artifact_version + 1,
        new_artifact_id: deriveArtifactId({
          task_id: binding.task_id,
          task_revision: binding.task_revision,
          template_kind: record.template_kind,
          artifact_version: record.artifact_version + 1,
        }),
        reason: node.reason,
        via_fact_keys: node.viaFactorKeys,
        via_artifact_ids: node.viaArtifactIds,
        depth: node.depth,
      }),
    );

    const downstream = dependents.get(id);
    if (downstream === undefined) {
      continue;
    }
    const sorted = [...downstream].sort(compareStrings);
    for (const next of sorted) {
      if (visited.has(next) || queued.has(next)) {
        continue; // 已访问 / 已入队 ⇒ 不重复入队（既保证终止，也保证"不重复重写"）
      }
      queued.add(next);
      queue.push({
        id: next as ArtifactRef,
        reason: 'dependency_artifact_changed',
        viaFactorKeys: Object.freeze([]),
        viaArtifactIds: Object.freeze([record.artifact_id]),
        depth: node.depth + 1,
      });
    }
  }

  const affected = [...visited.values()].sort((left, right) =>
    compareStrings(left.artifact_id, right.artifact_id),
  );
  const untouched = candidates
    .filter((candidate) => !visited.has(String(candidate.artifact_id)))
    .map((candidate) => candidate.artifact_id);

  return {
    affected: Object.freeze(affected),
    untouched_artifact_ids: Object.freeze(
      uniqueSorted(untouched.map(String)) as ArtifactRef[],
    ),
    preserved_artifact_ids: Object.freeze(uniqueSorted(preserved.map(String)) as ArtifactRef[]),
    closure_visits: Object.freeze(visits),
  };
}

// ---------------------------------------------------------------------------
// 气泡判定
// ---------------------------------------------------------------------------

function evaluateBubbles(
  binding: FactChangeBinding,
  bubbles: readonly DecisionBubble[],
  actions: readonly ActionRecord[] | undefined,
): readonly BubbleInvalidation[] {
  if (bubbles.length > 0 && actions === undefined) {
    throw new DependencyError(
      'bubbles 非空但未给出 actions：没有真实动作对象就无法判气泡是否过期，' +
        '本层拒绝猜测（R212：气泡引用真实动作对象）',
    );
  }
  const byActionId = new Map<ActionRef, ActionRecord>();
  for (const action of actions ?? []) {
    byActionId.set(action.action_id, action);
  }

  const results = bubbles.map((bubble): BubbleInvalidation => {
    const record = byActionId.get(bubble.action_id);
    if (record === undefined) {
      return Object.freeze({
        bubble_id: bubble.bubble_id,
        action_id: bubble.action_id,
        expired: true,
        reason: 'unknown_action' as ActionLedgerRejectionReason,
        detail: `气泡 ${bubble.bubble_id} 指向动作 ${bubble.action_id}，但台账中查不到该动作：不可执行`,
      });
    }
    const verdict = evaluateBubbleExecution(bubble, record, {
      current_task_revision: binding.task_revision,
    });
    return Object.freeze({
      bubble_id: bubble.bubble_id,
      action_id: bubble.action_id,
      expired: !verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      detail: verdict.ok ? '' : verdict.message,
    });
  });

  results.sort((left, right) => compareStrings(left.bubble_id, right.bubble_id));
  return Object.freeze(results);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 计算"共享事实更新 → 依赖失效 → 只更新受影响产物 → 旧气泡过期"的失效计划（纯函数）。
 *
 * @throws {ValidationError} 形状非法（空 id / 非有限时间 / 同一键改两次 / 事实取代自己）。
 * @throws {DependencyError} 语义拒绝（指令版本过期；`bubbles` 非空却未给 `actions`）。
 */
export function planInvalidation(request: InvalidationRequest): ArtifactInvalidationPlan {
  validateBinding(request.binding);
  const updates = normalizeUpdates(request.updates ?? []);
  const closure = computeClosure(request.binding, updates, request.artifacts ?? []);
  const bubbles = evaluateBubbles(
    request.binding,
    request.bubbles ?? [],
    request.actions,
  );
  const expiredBubbleIds = bubbles.filter((bubble) => bubble.expired).map((bubble) => bubble.bubble_id);

  const digest = canonicalDigest(
    JSON.stringify([
      request.binding.instruction_id,
      String(request.binding.task_id),
      Number(request.binding.task_revision),
      updates.map((update) => [
        update.fact_key,
        update.previous_fact_id === null ? null : String(update.previous_fact_id),
        String(update.new_fact_id),
      ]),
      closure.affected.map((entry) => [
        String(entry.artifact_id),
        String(entry.new_artifact_id),
        entry.to_version,
        entry.reason,
      ]),
      closure.untouched_artifact_ids.map(String),
      closure.preserved_artifact_ids.map(String),
      expiredBubbleIds,
    ]),
  );

  return Object.freeze({
    binding: Object.freeze({ ...request.binding }),
    updates,
    affected: closure.affected,
    untouched_artifact_ids: closure.untouched_artifact_ids,
    preserved_artifact_ids: closure.preserved_artifact_ids,
    bubbles,
    expired_bubble_ids: Object.freeze([...expiredBubbleIds].sort(compareStrings)),
    closure_visits: closure.closure_visits,
    digest,
  });
}

// ---------------------------------------------------------------------------
// 反向对照：计划 vs 实然
// ---------------------------------------------------------------------------

export const INVALIDATION_VIOLATION_CODES = [
  'unaffected_artifact_rewritten', // 无关产物被重写（"改了人数却把无关段落也重写"）
  'affected_artifact_not_rewritten', // 该重写的产物没被重写
  'duplicate_rewrite', // 同一产物被写两次
  'expired_bubble_executed', // 过期气泡仍被判定为可执行 / 被执行
  'history_not_preserved', // 旧版本未保留为历史
] as const;
export type InvalidationViolationCode = (typeof INVALIDATION_VIOLATION_CODES)[number];

export interface InvalidationViolation {
  readonly code: InvalidationViolationCode;
  readonly subject_id: string;
  readonly detail: string;
}

/** "实然"观测：实现实际重写了哪些产物、执行了哪些气泡、保留了哪些历史。 */
export interface InvalidationObservation {
  /** 实际被重写的**源产物 id**（即 `affected[].artifact_id` 那一侧的身份）。 */
  readonly rewritten_artifact_ids: readonly ArtifactRef[];
  /** 实际被执行的气泡 id（可选）。 */
  readonly executed_bubble_ids?: readonly string[];
  /** 实际保留为历史的产物 id（可选；给出时才判"历史是否保留"）。 */
  readonly preserved_artifact_ids?: readonly ArtifactRef[];
}

function violation(
  code: InvalidationViolationCode,
  subjectId: string,
  detail: string,
): InvalidationViolation {
  return Object.freeze({ code, subject_id: subjectId, detail });
}

/**
 * 用"计划的应然"核验"实现的实然"，返回全部违规（不抛错、一次收齐）。
 * 空数组 ⟺ 实现与计划一致。
 */
export function checkInvalidationPlan(
  plan: ArtifactInvalidationPlan,
  observation: InvalidationObservation,
): readonly InvalidationViolation[] {
  const violations: InvalidationViolation[] = [];
  const affected = new Set(plan.affected.map((entry) => String(entry.artifact_id)));
  const untouched = new Set(plan.untouched_artifact_ids.map(String));
  const expired = new Set(plan.expired_bubble_ids);

  const rewrittenSeen = new Set<string>();
  for (const raw of observation.rewritten_artifact_ids) {
    const id = String(raw);
    if (rewrittenSeen.has(id)) {
      violations.push(
        violation('duplicate_rewrite', id, `产物 ${id} 被重写了不止一次：同一次变更里同一产物只能产出新版本一次`),
      );
      continue;
    }
    rewrittenSeen.add(id);
    if (untouched.has(id)) {
      violations.push(
        violation(
          'unaffected_artifact_rewritten',
          id,
          `产物 ${id} 不在受影响集合内，却被重写：无关信息不得重写（R251）`,
        ),
      );
    }
  }

  for (const id of [...affected].sort(compareStrings)) {
    if (!rewrittenSeen.has(id)) {
      violations.push(
        violation(
          'affected_artifact_not_rewritten',
          id,
          `产物 ${id} 在受影响集合内，却没有被重写：受影响产物必须同版更新（R213）`,
        ),
      );
    }
  }

  for (const bubbleId of [...(observation.executed_bubble_ids ?? [])].sort(compareStrings)) {
    if (expired.has(bubbleId)) {
      violations.push(
        violation(
          'expired_bubble_executed',
          bubbleId,
          `气泡 ${bubbleId} 已被判定过期，却仍被执行：旧 revision 的气泡不得再执行（R213）`,
        ),
      );
    }
  }

  if (observation.preserved_artifact_ids !== undefined) {
    const preserved = new Set(observation.preserved_artifact_ids.map(String));
    for (const id of [...affected].sort(compareStrings)) {
      if (!preserved.has(id)) {
        violations.push(
          violation(
            'history_not_preserved',
            id,
            `产物 ${id} 的旧版本没有被保留为历史：旧版本结果不得被覆盖（R213 / P2）`,
          ),
        );
      }
    }
  }

  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------
// 可读输出（证据 / 断言失败信息用）
// ---------------------------------------------------------------------------

export function describeAffectedArtifact(entry: AffectedArtifact): string {
  const via =
    entry.reason === 'source_fact_changed'
      ? `直接命中事实 [${entry.via_fact_keys.join(', ')}]`
      : `经由产物 [${entry.via_artifact_ids.join(', ')}]`;
  return (
    `${entry.template_kind} ${String(entry.artifact_id)} v${entry.from_version}→v${entry.to_version}` +
    `（新 id ${String(entry.new_artifact_id)}，深度 ${entry.depth}，${via}）`
  );
}

/** 单行摘要：改了哪些、哪些没动、哪些气泡过期。 */
export function describeInvalidationPlan(plan: ArtifactInvalidationPlan): string {
  return (
    `指令 ${plan.binding.instruction_id}（${plan.binding.utterance}）@${Number(plan.binding.task_revision)}：` +
    `事实更新 ${plan.updates.length} 项；受影响产物 ${plan.affected.length} 个` +
    `${plan.affected.length === 0 ? '' : `（${plan.affected.map(describeAffectedArtifact).join('；')}）`}；` +
    `未受影响 ${plan.untouched_artifact_ids.length} 个；历史保留 ${plan.preserved_artifact_ids.length} 个；` +
    `过期气泡 ${plan.expired_bubble_ids.length} 个`
  );
}
