/**
 * 经验并发、回滚、失效与**实例固定经验快照**（design-06 P4 / MEM-07；合同 R230 / R239）。
 *
 * ## 并发追加与合并是**确定性**的
 *
 * 同一模板可能同时有多个成员提经验候选。`mergeExperienceCandidates()` 把一批候选按**稳定排序键**
 * 处理，并在处理过程中把已接受的条目并入"既有有效经验"，于是：
 * - **重复候选**在同批里就会去重成 `no_change`（不是写两条同义经验）；
 * - 合并结果**与输入顺序无关**：同一组候选换一个到达顺序，接受的 lesson 集合与版本分配一致。
 *
 * ## 回滚 / 失效 / 重新评估
 *
 * - `invalidateExperience()`：把一条经验置为失效（`disabled`）。失效后它不再算"既有有效经验"，
 *   于是**重新评估**同一 lesson 的候选会得到 `add`（R239 的去重只针对**有效**经验）。
 * - `rollbackExperience()`：把一条经验回滚——本条失效，并**重新启用**同模板里版本恰在它之下、
 *   当前已失效的前一条（撤销一次"取代"）。
 * - `commitExperienceDecision()`：**取代**在库里落地——写入新版本后把被取代的旧条处置为失效
 *   （值原样保留，可审计）。**历史不删**。
 *
 * ## 实例固定经验快照（R230 的"新经验不在执行中途改规则"）
 *
 * `pinExperienceSnapshot()` 在实例开跑时对当前**有效**经验取一份**冻结副本**。
 * 之后到达的新经验**不会**进入这份快照——正在执行的实例规则不因中途到达的新经验而改变；
 * 想吃到新经验必须**重新签发**一份快照（下个实例 / 下一次执行）。
 *
 * 纯函数 + 注入仓库：零 IO、不含墙钟与随机数。
 */

import type { LogicalTime, TemplateId } from '../protocol/index.js';
import {
  evaluateExperienceCandidate,
  type ExperienceCandidate,
  type ExperienceContext,
  type ExperienceDecision,
} from './experience.js';
import type { MemoryRepository, MemoryWriteResult } from './repository.js';
import type { MemoryId, OwnerId, TemplateExperienceMemory } from './types.js';

// ---------------------------------------------------------------------------
// 并发追加与合并
// ---------------------------------------------------------------------------

/** 一个候选与它的评估结论（成对返回，便于审计）。 */
export interface MergedDecision {
  readonly candidate: ExperienceCandidate;
  readonly decision: ExperienceDecision;
}

export interface ExperienceMergeResult {
  readonly decisions: readonly MergedDecision[];
  /** 被接受、待写入的条目（按确定性顺序）。 */
  readonly accepted: readonly TemplateExperienceMemory[];
  readonly rejected_count: number;
  readonly no_change_count: number;
  /** 合并采用的**确定性顺序**（稳定排序键）——与输入顺序无关。 */
  readonly order: readonly string[];
}

/** 稳定排序键：同模板下按 lesson / 证据 / 证据种类 / 取代目标定序。 */
function candidateKey(candidate: ExperienceCandidate): string {
  return [
    candidate.template_id,
    candidate.lesson,
    [...candidate.evidence_refs].join('\u0001'),
    candidate.evidence_kind,
    candidate.supersedes_lesson ?? '',
  ].join('\u0000');
}

/**
 * 合并一批（可能并发的）经验候选。
 *
 * 处理顺序 = 稳定排序键升序；每接受一条，就把它并入"既有有效经验"再评估下一条。
 * 因此本函数对**输入顺序免疫**：重复候选去重为 `no_change`，不同候选各得版本号。
 */
export function mergeExperienceCandidates(
  candidates: readonly ExperienceCandidate[],
  context: ExperienceContext,
  at: LogicalTime,
): ExperienceMergeResult {
  const sorted = [...candidates].sort((left, right) => {
    const a = candidateKey(left);
    const b = candidateKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const working: TemplateExperienceMemory[] = [...context.existing];
  const decisions: MergedDecision[] = [];
  const accepted: TemplateExperienceMemory[] = [];
  let rejected = 0;
  let noChange = 0;

  for (const candidate of sorted) {
    const decision = evaluateExperienceCandidate(candidate, { ...context, existing: working }, at);
    decisions.push(Object.freeze({ candidate, decision }));
    if (decision.decision === 'add' && decision.entry !== null) {
      accepted.push(decision.entry);
      working.push(decision.entry);
    } else if (decision.decision === 'no_change') {
      noChange += 1;
    } else {
      rejected += 1;
    }
  }

  return Object.freeze({
    decisions: Object.freeze(decisions),
    accepted: Object.freeze(accepted),
    rejected_count: rejected,
    no_change_count: noChange,
    order: Object.freeze(sorted.map(candidateKey)),
  });
}

// ---------------------------------------------------------------------------
// 落库：写入 + 取代（历史不删）
// ---------------------------------------------------------------------------

export interface CommitExperienceInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly decision: ExperienceDecision;
  /** 候选声明的"取代既有某条同文本经验"；`null` 表示纯新增。 */
  readonly supersedes_lesson: string | null;
  readonly at: LogicalTime;
}

export type CommitExperienceResult =
  | {
      readonly kind: 'written';
      readonly entry: TemplateExperienceMemory;
      /** 被本次取代而失效的旧条 id（无取代时为 `null`）。 */
      readonly superseded_invalidated: MemoryId | null;
    }
  | { readonly kind: 'skipped'; readonly decision: 'reject' | 'no_change'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: 'store_failed' | 'disable_failed'; readonly detail: string };

/** 同 owner + 同模板的有效经验。 */
function activeExperiences(
  repository: MemoryRepository,
  ownerId: OwnerId,
  templateId: TemplateId,
): readonly TemplateExperienceMemory[] {
  return repository
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
    .filter((entry) => entry.owner_id === ownerId && entry.template_id === templateId && entry.status === 'active');
}

/**
 * 把一次经验评估结论落库：
 * - `add` ⇒ 写入新版本；若声明取代某条 lesson，则把那条**置为失效**（值原样保留，历史不删）；
 * - `reject` / `no_change` ⇒ 不写库（`no_change` 是一等结局，R239）。
 */
export function commitExperienceDecision(input: CommitExperienceInput): CommitExperienceResult {
  const { decision } = input;
  const candidateEntry = decision.entry;
  if (decision.decision !== 'add' || candidateEntry === null) {
    return {
      kind: 'skipped',
      decision: decision.decision === 'add' ? 'no_change' : decision.decision,
      reason: decision.reasons.join('；'),
    };
  }

  const written: MemoryWriteResult = input.repository.remember(candidateEntry);
  if (!written.ok) {
    return { kind: 'failed', reason: 'store_failed', detail: `存储失败，未写入经验：${written.detail}` };
  }

  let superseded: MemoryId | null = null;
  if (input.supersedes_lesson !== null) {
    const targets = activeExperiences(input.repository, input.owner_id, candidateEntry.template_id).filter(
      (entry) => entry.lesson === input.supersedes_lesson && entry.memory_id !== candidateEntry.memory_id,
    );
    for (const target of targets) {
      const disabled = input.repository.disable(target.memory_id, input.owner_id, input.at);
      if (!disabled.ok) {
        return {
          kind: 'failed',
          reason: 'disable_failed',
          detail: `新经验已写入，但被取代的旧经验 ${target.memory_id} 未能失效：${disabled.detail}`,
        };
      }
      superseded = superseded ?? target.memory_id;
    }
  }

  return { kind: 'written', entry: candidateEntry, superseded_invalidated: superseded };
}

// ---------------------------------------------------------------------------
// 失效与重新评估
// ---------------------------------------------------------------------------

export interface InvalidateExperienceInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId;
  readonly at: LogicalTime;
  readonly reason: string;
}

export type InvalidateExperienceResult =
  | { readonly kind: 'invalidated'; readonly entry: TemplateExperienceMemory; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: 'not_found' | 'owner_mismatch' | 'not_experience' | 'store_failed'; readonly detail: string };

/** 失效一条经验（`disabled`）。失效后它不再算既有有效经验，同 lesson 的候选可被**重新评估**新增。 */
export function invalidateExperience(input: InvalidateExperienceInput): InvalidateExperienceResult {
  const found = input.repository.get(input.memory_id);
  if (found === undefined) {
    return { kind: 'failed', reason: 'not_found', detail: `经验 ${input.memory_id} 不存在` };
  }
  if (found.kind !== 'template_experience') {
    return { kind: 'failed', reason: 'not_experience', detail: `条目 ${input.memory_id} 不是模板经验` };
  }
  if (found.owner_id !== input.owner_id) {
    return { kind: 'failed', reason: 'owner_mismatch', detail: `经验 ${input.memory_id} 不属于 ${input.owner_id}` };
  }
  const disabled = input.repository.disable(input.memory_id, input.owner_id, input.at);
  if (!disabled.ok) {
    return { kind: 'failed', reason: 'store_failed', detail: disabled.detail };
  }
  return { kind: 'invalidated', entry: found, reason: input.reason };
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------

export interface RollbackExperienceInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId;
  readonly at: LogicalTime;
  readonly reason: string;
}

export type RollbackExperienceResult =
  | {
      readonly kind: 'rolled_back';
      readonly rolled_back: MemoryId;
      /** 被重新启用的前一条经验（若版本链中有已失效的前驱）；否则为 `null`。 */
      readonly restored: MemoryId | null;
      readonly notes: string;
    }
  | { readonly kind: 'failed'; readonly reason: 'not_found' | 'owner_mismatch' | 'not_experience' | 'store_failed'; readonly detail: string };

/**
 * 回滚一条经验：本条失效，并**重新启用**同模板里版本恰在它之下、当前已失效的前驱（撤销一次取代）。
 * 回滚**不删除**任何条目——历史全部保留。
 */
export function rollbackExperience(input: RollbackExperienceInput): RollbackExperienceResult {
  const found = input.repository.get(input.memory_id);
  if (found === undefined) {
    return { kind: 'failed', reason: 'not_found', detail: `经验 ${input.memory_id} 不存在` };
  }
  if (found.kind !== 'template_experience') {
    return { kind: 'failed', reason: 'not_experience', detail: `条目 ${input.memory_id} 不是模板经验` };
  }
  if (found.owner_id !== input.owner_id) {
    return { kind: 'failed', reason: 'owner_mismatch', detail: `经验 ${input.memory_id} 不属于 ${input.owner_id}` };
  }

  const predecessors = input.repository
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
    .filter(
      (entry) =>
        entry.owner_id === input.owner_id &&
        entry.template_id === found.template_id &&
        entry.memory_id !== found.memory_id &&
        entry.version < found.version,
    )
    .sort((left, right) => right.version - left.version);
  const predecessor = predecessors[0];

  const disabled = input.repository.disable(input.memory_id, input.owner_id, input.at);
  if (!disabled.ok) {
    return { kind: 'failed', reason: 'store_failed', detail: disabled.detail };
  }

  if (predecessor === undefined) {
    return {
      kind: 'rolled_back',
      rolled_back: input.memory_id,
      restored: null,
      notes: `${input.reason}：本条已失效；同模板无更早版本可恢复`,
    };
  }

  const enabled = input.repository.enable(predecessor.memory_id, input.owner_id, input.at);
  if (!enabled.ok) {
    return { kind: 'failed', reason: 'store_failed', detail: `回滚时无法恢复前驱：${enabled.detail}` };
  }
  return {
    kind: 'rolled_back',
    rolled_back: input.memory_id,
    restored: predecessor.memory_id,
    notes: `${input.reason}：本条失效，版本 r${String(predecessor.version)} 的前驱已恢复；历史条目均保留可审计`,
  };
}

// ---------------------------------------------------------------------------
// 实例固定经验快照
// ---------------------------------------------------------------------------

export interface PinExperienceSnapshotInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly template_id: TemplateId;
  readonly at: LogicalTime;
}

/** 实例开跑时固定的经验快照（**冻结副本**；之后到达的新经验不进入）。 */
export interface PinnedExperienceSnapshot {
  readonly template_id: TemplateId;
  readonly owner_id: OwnerId;
  readonly pinned_at: LogicalTime;
  /** 快照时刻的**有效**经验（按版本升序；**冻结副本**，不随后续写入变化）。 */
  readonly entries: readonly TemplateExperienceMemory[];
  /** 快照的 lesson 列表（实例规则的可读形式）。 */
  readonly lessons: readonly string[];
  readonly experience_ids: readonly MemoryId[];
}

/**
 * 为实例固定一份经验快照（R230：新经验**不在执行中途**改变规则）。
 *
 * 快照取的是**当前有效**经验的冻结副本；调用方之后可用 `lessons` 作为本实例的规则。
 * 想吃到新经验，必须**重新签发**快照。
 */
export function pinExperienceSnapshot(input: PinExperienceSnapshotInput): PinnedExperienceSnapshot {
  const entries = [...activeExperiences(input.repository, input.owner_id, input.template_id)].sort(
    (left, right) => left.version - right.version,
  );
  return Object.freeze({
    template_id: input.template_id,
    owner_id: input.owner_id,
    pinned_at: input.at,
    entries: Object.freeze([...entries]),
    lessons: Object.freeze(entries.map((entry) => entry.lesson)),
    experience_ids: Object.freeze(entries.map((entry) => entry.memory_id)),
  });
}
