/**
 * 经验**回滚 / 失效 / 重新评估**与**实例固定经验快照的隔离**
 * （design-06 P4 / MEM-07；合同 R230 / R239 / R240）。
 *
 * ## 这一层补的是什么
 *
 * `experience.ts` 给出了候选的三值评估（含"不新增"）；`experience-merge.ts` 给出了落库、
 * 回滚、失效、快照取用；`experience-concurrency.ts` 给出了顺序无关的并发合并与实例绑定。
 * 但 MEM-07 里最有分量、也最容易做成"看起来很干净其实漏了"的四件事，此前只到"能跑通"：
 *
 * 1. **回滚是针对**一次具体写入（版本）**的**——不是"把最新那条关掉"。
 *    回滚必须**保留历史**（既有版本一条不删），且回滚后**检索 / 注入不再命中被回滚的版本**。
 *    对**从未写入**的版本回滚必须**失败**（否则"回滚"会变成一个可以凭空宣称的动作）。
 * 2. **失效带原因与依据，且是版本化的**——`invalidateExperience()` 只收一个自由文本 `reason`，
 *    没有"依据"概念，也没有"对哪个版本失效"的记录。本层把失效做成
 *    `ExperienceInvalidationRecord`：**原因 + 依据 + 证据引用（非空）+ 被失效的版本号**。
 *    无依据 ⇒ 失效**失败**（R240：不得凭空气宣称一个状态变更）。
 * 3. **失效可被重新评估**——结论只有两个：`reactivated`（恢复）或 `stays_invalid`（维持失效），
 *    **两者都要求证据**（证据引用 + 理由文本，缺一即失败）。重新评估是**追加**在失效记录上的，
 *    原失效记录（含原始依据）**不删**——整条历史可审计。
 * 4. **实例固定经验快照的隔离**——执行中的实例绑定的是**开跑那一刻**的经验规则；
 *    **回滚 / 失效都只影响新实例**，不得改写在跑实例的规则。本层用 `instanceRuleDiff()`
 *    把"旧实例仍持有已被回滚的规则"变成**可直接断言**的证据（`removed_since_binding` 非空，
 *    而 `frozen_rules` 不变），而不是"快照数组没变"的间接说辞。
 *
 * ## 并发 + 回滚：确定性且**不留半个状态**
 *
 * - `rollbackExperienceBatch()` 把一批（可能来自多个写入者）的回滚做成一次**原子操作**：
 *   先对**全部**目标做校验，任一不合规 ⇒ **整批不执行**（`mutated: false`，不留半状态）；
 *   通过后再按 `memory_id` 升序**确定性地**逐个停用（禁用是可逆的状态翻转，故任一步意外失败都能
 *   **补偿**回滚已执行的部分，并如实上报 `compensated`）。
 * - `concurrentAppendThenRollback()` 把"并发追加"与"批次回滚"编排成一条链：追加阶段若
 *   **部分失败**（R240 的负例），则把**已写入成功**的那些条目回滚掉，使最终有效集合**回到追加前**
 *   ——半批次写入不得留在库里冒充"完成"。
 *
 * ## 边界（如实标注）
 *
 * - 本层是**单进程内**的顺序执行 + 补偿式回滚，**未做真实跨进程 / 多线程并发**；"确定性"指的是
 *   **与输入顺序无关**（同一组操作换到达顺序结果一致），不是对真实并行执行的线性化证明。
 * - 停用 / 启用走的是注入仓库的 `disable` / `enable`（无 `beforeWrite` 故障接缝，除
 *   `not_found` / `owner_mismatch` / `deleted` 外不会失败）；因此补偿路径在本层是**防御性**的，
 *   测试通过"批次校验失败"这一**可达**路径证明"无半状态"。
 *
 * 纯函数 + 注入仓库：零 IO、不含墙钟与随机数。
 */

import type { LogicalTime, Revision, TemplateId } from '../protocol/index.js';
import type { MemoryRepository } from './repository.js';
import { rollbackExperience } from './experience-merge.js';
import {
  appendExperiencesConcurrently,
  type ConcurrentAppendInput,
  type ConcurrentAppendResult,
  type InstanceExperienceBinding,
} from './experience-concurrency.js';
import type { MemoryId, OwnerId, TemplateExperienceMemory } from './types.js';

// ---------------------------------------------------------------------------
// 小工具（全部只读，复用仓库的口）
// ---------------------------------------------------------------------------

/** 同 owner + 同模板的**有效**经验（按版本升序，确定性）。 */
function activeExperiences(
  repository: MemoryRepository,
  ownerId: OwnerId,
  templateId: TemplateId,
): readonly TemplateExperienceMemory[] {
  return Object.freeze(
    repository
      .listByKind('template_experience')
      .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
      .filter(
        (entry) => entry.owner_id === ownerId && entry.template_id === templateId && entry.status === 'active',
      )
      .sort((left, right) => left.version - right.version),
  );
}

function asExperience(entry: unknown): TemplateExperienceMemory | undefined {
  if (entry === null || entry === undefined || typeof entry !== 'object') return undefined;
  return (entry as { kind?: unknown }).kind === 'template_experience'
    ? (entry as TemplateExperienceMemory)
    : undefined;
}

/** 某 owner **当前有效**的模板经验 lesson（跨全部模板；升序、去重）。 */
function activeOwnerLessons(repository: MemoryRepository, ownerId: OwnerId): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        repository
          .listByKind('template_experience')
          .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
          .filter((entry) => entry.owner_id === ownerId && entry.status === 'active')
          .map((entry) => entry.lesson),
      ),
    ].sort(),
  );
}

function sameLessons(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((lesson, index) => lesson === right[index]);
}

/**
 * 走**真实检索路径**（`repository.recall`，默认排除非 active）能拿到哪些经验 lesson。
 * 这是"回滚 / 失效后**检索 / 注入不再命中**"的判据，而不是绕过 recall 直接看内存。
 */
export function injectableExperienceLessons(
  repository: MemoryRepository,
  ownerId: OwnerId,
  templateId: TemplateId,
): readonly string[] {
  const hit = repository.recall({ owner_id: ownerId, kinds: ['template_experience'], template_id: templateId });
  return Object.freeze(
    hit.entries
      .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
      .map((entry) => entry.lesson)
      .sort(),
  );
}

/** 某条经验**此刻**是否还能被检索 / 注入命中（走 `recall`）。 */
export function isExperienceInjectable(
  repository: MemoryRepository,
  ownerId: OwnerId,
  memoryId: MemoryId,
): boolean {
  const hit = repository.recall({ owner_id: ownerId, kinds: ['template_experience'] });
  return hit.entries.some((entry) => entry.memory_id === memoryId);
}

// ---------------------------------------------------------------------------
// 回滚：针对**一次具体写入（版本）**，保留历史
// ---------------------------------------------------------------------------

export interface RollbackExperienceWriteInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId;
  /** 调用方声明要回滚**哪一个版本**（写死来源版本，杜绝"回滚最新那条"的模糊语义）。 */
  readonly expected_version: Revision;
  readonly at: LogicalTime;
  readonly reason: string;
}

/** 回滚成功时的记录。`history_preserved` 与 `injectable_after` 是**字面量**断言（不可编造）。 */
export interface RollbackExperienceWriteRecord {
  readonly memory_id: MemoryId;
  readonly template_id: TemplateId;
  readonly rolled_back_version: Revision;
  /** 回滚**不删除**任何既有版本（R239）。 */
  readonly history_preserved: true;
  /** 回滚后该版本**不再**被检索 / 注入命中。 */
  readonly injectable_after: false;
  /** 被恢复的前一条经验（版本链中已失效的前驱）；无则为 `null`。 */
  readonly restored: MemoryId | null;
  readonly reason: string;
  readonly at: LogicalTime;
}

export type RollbackExperienceWriteFailure =
  | 'not_written' // 目标版本**从未写入**（不存在）——回滚一个没写过的版本必须失败
  | 'version_mismatch' // 目标存在，但不是 `expected_version` 这一版
  | 'owner_mismatch'
  | 'not_experience'
  | 'missing_reason' // 回滚必须说明原因（不得凭空宣称回滚）
  | 'store_failed';

export type RollbackExperienceWriteResult =
  | { readonly kind: 'rolled_back'; readonly record: RollbackExperienceWriteRecord }
  | { readonly kind: 'failed'; readonly reason: RollbackExperienceWriteFailure; readonly detail: string };

/**
 * 回滚**一次具体的经验写入**。
 *
 * 校验顺序（任一不过 ⇒ `failed`，库**不被改动**）：
 * 1. `reason` 非空；2. 条目存在（否则 `not_written`）；3. 是模板经验；4. 属于该 owner；
 * 5. 版本**恰为** `expected_version`（否则 `version_mismatch`）。
 *
 * 通过后：本条停用（`disabled`，值原样保留——历史不删），并复用 `rollbackExperience` 的
 * 版本链语义**恢复**同模板里版本恰在它之下、当前已失效的前驱。
 */
export function rollbackExperienceWrite(
  input: RollbackExperienceWriteInput,
): RollbackExperienceWriteResult {
  if (typeof input.reason !== 'string' || input.reason.length === 0) {
    return fail('missing_reason', '回滚必须给出原因：不得凭空宣称一次回滚（R240）');
  }

  const raw = input.repository.get(input.memory_id);
  const found = asExperience(raw);
  if (raw === undefined) {
    return fail(
      'not_written',
      `经验版本 ${input.memory_id}（声明版本 r${String(input.expected_version)}）**从未写入**：` +
        '回滚一个没写过的版本必须失败',
    );
  }
  if (found === undefined) {
    return fail('not_experience', `条目 ${input.memory_id} 不是模板经验`);
  }
  if (found.owner_id !== input.owner_id) {
    return fail('owner_mismatch', `经验 ${input.memory_id} 不属于 ${input.owner_id}：跨用户回滚被拒（R237）`);
  }
  if (found.version !== input.expected_version) {
    return fail(
      'version_mismatch',
      `经验 ${input.memory_id} 当前版本为 r${String(found.version)}，` +
        `不是声明的 r${String(input.expected_version)}：回滚只针对**一次具体写入**`,
    );
  }

  const rolled = rollbackExperience({
    repository: input.repository,
    owner_id: input.owner_id,
    memory_id: input.memory_id,
    at: input.at,
    reason: input.reason,
  });
  if (rolled.kind === 'failed') {
    return fail('store_failed', rolled.detail);
  }

  return Object.freeze({
    kind: 'rolled_back' as const,
    record: Object.freeze({
      memory_id: input.memory_id,
      template_id: found.template_id,
      rolled_back_version: found.version,
      history_preserved: true as const,
      injectable_after: false as const,
      restored: rolled.restored,
      reason: input.reason,
      at: input.at,
    }),
  });
}

function fail(reason: RollbackExperienceWriteFailure, detail: string): RollbackExperienceWriteResult {
  return Object.freeze({ kind: 'failed' as const, reason, detail });
}

// ---------------------------------------------------------------------------
// 失效：带**原因与依据**，版本化
// ---------------------------------------------------------------------------

export const INVALIDATION_STATES = ['invalid', 'reactivated'] as const;
export type InvalidationState = (typeof INVALIDATION_STATES)[number];

export const REEVALUATION_OUTCOMES = ['reactivated', 'stays_invalid'] as const;
export type ReevaluationOutcome = (typeof REEVALUATION_OUTCOMES)[number];

/** 一次重新评估（**追加**在失效记录上；原失效记录不删）。 */
export interface ExperienceReevaluationRecord {
  /** 本记录在链上的序号（从 1 起）。 */
  readonly seq: number;
  readonly outcome: ReevaluationOutcome;
  readonly rationale: string;
  /** 重新评估所依据的证据引用（**非空**——两种结论都要求证据）。 */
  readonly evidence_refs: readonly string[];
  readonly at: LogicalTime;
}

/** 版本化的失效记录：对**哪个版本**、凭**什么原因与依据**失效，全部写死。 */
export interface ExperienceInvalidationRecord {
  readonly memory_id: MemoryId;
  readonly owner_id: OwnerId;
  readonly template_id: TemplateId;
  /** 被失效条目当时的版本——失效是**版本化**的。 */
  readonly invalidated_version: Revision;
  /** 原因（为什么失效）。 */
  readonly reason: string;
  /** 依据（据何判定）——人类可读。 */
  readonly basis: string;
  /** 依据的证据引用（**非空**——无依据的失效是空口断言）。 */
  readonly evidence_refs: readonly string[];
  readonly at: LogicalTime;
  readonly state: InvalidationState;
  /** 该失效之后的所有重新评估（append-only）。 */
  readonly reevaluations: readonly ExperienceReevaluationRecord[];
}

export interface InvalidateExperienceVersionInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly memory_id: MemoryId;
  readonly at: LogicalTime;
  readonly reason: string;
  readonly basis: string;
  readonly evidence_refs: readonly string[];
}

export type InvalidateExperienceVersionFailure =
  | 'missing_basis' // 原因 / 依据 / 证据引用任一为空——失效必须带依据
  | 'not_found'
  | 'not_experience'
  | 'owner_mismatch'
  | 'already_invalid' // 已失效的条目不得重复失效（确定性）
  | 'store_failed';

export type InvalidateExperienceVersionResult =
  | { readonly kind: 'invalidated'; readonly entry: TemplateExperienceMemory; readonly record: ExperienceInvalidationRecord }
  | { readonly kind: 'failed'; readonly reason: InvalidateExperienceVersionFailure; readonly detail: string };

/**
 * 把一条经验标为**失效**（带原因与依据）。
 *
 * 未提供依据（`reason` / `basis` 为空，或 `evidence_refs` 为空数组）⇒ **失败**，条目**保持有效**。
 * 失效记录里写死 `invalidated_version`，供后续重新评估与回滚对照。
 */
export function invalidateExperienceVersion(
  input: InvalidateExperienceVersionInput,
): InvalidateExperienceVersionResult {
  if (
    typeof input.reason !== 'string' ||
    input.reason.length === 0 ||
    typeof input.basis !== 'string' ||
    input.basis.length === 0 ||
    !Array.isArray(input.evidence_refs) ||
    input.evidence_refs.length === 0
  ) {
    return invFail(
      'missing_basis',
      '失效必须给出原因、依据与证据引用（三者皆非空）：没有依据的失效是空口断言（R240）',
    );
  }

  const found = asExperience(input.repository.get(input.memory_id));
  if (found === undefined) {
    return input.repository.get(input.memory_id) === undefined
      ? invFail('not_found', `经验 ${input.memory_id} 不存在`)
      : invFail('not_experience', `条目 ${input.memory_id} 不是模板经验`);
  }
  if (found.owner_id !== input.owner_id) {
    return invFail('owner_mismatch', `经验 ${input.memory_id} 不属于 ${input.owner_id}（R237）`);
  }
  if (found.status !== 'active') {
    return invFail(
      'already_invalid',
      `经验 ${input.memory_id} 当前状态为 ${found.status}，不是有效经验：不得重复失效`,
    );
  }

  const disabled = input.repository.disable(input.memory_id, input.owner_id, input.at);
  if (!disabled.ok) {
    return invFail('store_failed', disabled.detail);
  }

  return Object.freeze({
    kind: 'invalidated' as const,
    entry: found,
    record: Object.freeze({
      memory_id: input.memory_id,
      owner_id: input.owner_id,
      template_id: found.template_id,
      invalidated_version: found.version,
      reason: input.reason,
      basis: input.basis,
      evidence_refs: Object.freeze([...input.evidence_refs]),
      at: input.at,
      state: 'invalid' as InvalidationState,
      reevaluations: Object.freeze([]),
    }),
  });
}

function invFail(reason: InvalidateExperienceVersionFailure, detail: string): InvalidateExperienceVersionResult {
  return Object.freeze({ kind: 'failed' as const, reason, detail });
}

// ---------------------------------------------------------------------------
// 重新评估：reactivated / stays_invalid，两者都要求证据
// ---------------------------------------------------------------------------

export interface ReevaluateExperienceInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  /** 待重新评估的失效记录。 */
  readonly record: ExperienceInvalidationRecord;
  /** 期望结论：恢复，或维持失效。 */
  readonly verdict: 'reactivate' | 'keep_invalid';
  /** 重新评估的理由（**非空**）。 */
  readonly rationale: string;
  /** 重新评估的证据引用（**非空**）。 */
  readonly evidence_refs: readonly string[];
  readonly at: LogicalTime;
}

export type ReevaluateExperienceFailure =
  | 'missing_evidence' // 理由或证据引用缺失——两种结论都要求证据
  | 'not_invalid' // 该失效记录已被重新评估过（state 不是 invalid）
  | 'owner_mismatch'
  | 'not_found'
  | 'store_failed';

export type ReevaluateExperienceResult =
  | {
      readonly kind: 'reactivated';
      readonly entry: TemplateExperienceMemory;
      readonly record: ExperienceInvalidationRecord;
      readonly reevaluation: ExperienceReevaluationRecord;
    }
  | {
      readonly kind: 'stays_invalid';
      readonly record: ExperienceInvalidationRecord;
      readonly reevaluation: ExperienceReevaluationRecord;
    }
  | { readonly kind: 'failed'; readonly reason: ReevaluateExperienceFailure; readonly detail: string };

/**
 * 重新评估一条已失效的经验。
 *
 * `reactivate` ⇒ 条目**重新启用**（回到检索 / 注入）；`keep_invalid` ⇒ 条目**维持停用**。
 * **两种结论都必须带证据**（`rationale` 非空 且 `evidence_refs` 非空），否则失败。
 * 无论哪种结论，都往 `record.reevaluations` **追加**一条记录（原失效记录连同原始依据不删）。
 */
export function reevaluateExperience(input: ReevaluateExperienceInput): ReevaluateExperienceResult {
  if (
    typeof input.rationale !== 'string' ||
    input.rationale.length === 0 ||
    !Array.isArray(input.evidence_refs) ||
    input.evidence_refs.length === 0
  ) {
    return reFail(
      'missing_evidence',
      `重新评估（${input.verdict}）必须给出理由与证据引用：reactivated 与 stays_invalid 都要求证据（R240）`,
    );
  }
  if (input.record.state !== 'invalid') {
    return reFail(
      'not_invalid',
      `失效记录 ${input.record.memory_id} 当前状态为 ${input.record.state}：不得对已恢复的记录再次重新评估`,
    );
  }
  if (input.record.owner_id !== input.owner_id) {
    return reFail('owner_mismatch', `失效记录 ${input.record.memory_id} 不属于 ${input.owner_id}（R237）`);
  }

  const found = asExperience(input.repository.get(input.record.memory_id));
  if (found === undefined) {
    return reFail('not_found', `经验 ${input.record.memory_id} 已不存在（可能已被忘记）：不得据失效记录编造其状态`);
  }
  if (found.owner_id !== input.owner_id) {
    return reFail('owner_mismatch', `经验 ${input.record.memory_id} 不属于 ${input.owner_id}（R237）`);
  }

  const outcome: ReevaluationOutcome = input.verdict === 'reactivate' ? 'reactivated' : 'stays_invalid';
  const reevaluation: ExperienceReevaluationRecord = Object.freeze({
    seq: input.record.reevaluations.length + 1,
    outcome,
    rationale: input.rationale,
    evidence_refs: Object.freeze([...input.evidence_refs]),
    at: input.at,
  });

  if (input.verdict === 'reactivate') {
    const enabled = input.repository.enable(input.record.memory_id, input.owner_id, input.at);
    if (!enabled.ok) {
      return reFail('store_failed', enabled.detail);
    }
    return Object.freeze({
      kind: 'reactivated' as const,
      entry: found,
      record: Object.freeze({
        ...input.record,
        state: 'reactivated' as InvalidationState,
        reevaluations: Object.freeze([...input.record.reevaluations, reevaluation]),
      }),
      reevaluation,
    });
  }

  return Object.freeze({
    kind: 'stays_invalid' as const,
    record: Object.freeze({
      ...input.record, // state 维持 'invalid'
      reevaluations: Object.freeze([...input.record.reevaluations, reevaluation]),
    }),
    reevaluation,
  });
}

function reFail(reason: ReevaluateExperienceFailure, detail: string): ReevaluateExperienceResult {
  return Object.freeze({ kind: 'failed' as const, reason, detail });
}

// ---------------------------------------------------------------------------
// 批次回滚：原子（无半状态）+ 与输入顺序无关
// ---------------------------------------------------------------------------

export interface BatchRollbackTarget {
  readonly memory_id: MemoryId;
  readonly expected_version: Revision;
}

export interface RollbackExperienceBatchInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  /** 一批（可能来自多个写入者的）回滚目标；**顺序无关**。 */
  readonly targets: readonly BatchRollbackTarget[];
  readonly at: LogicalTime;
  readonly reason: string;
}

export type RollbackExperienceBatchFailure =
  | 'missing_reason'
  | 'not_written'
  | 'version_mismatch'
  | 'owner_mismatch'
  | 'not_experience'
  | 'already_invalid'
  | 'store_failed';

export type RollbackExperienceBatchResult =
  | {
      readonly kind: 'rolled_back';
      /** 被回滚的 id（按 `memory_id` 升序——与输入顺序无关）。 */
      readonly rolled_back: readonly MemoryId[];
      readonly at: LogicalTime;
      readonly mutated: true;
      readonly reason: string;
    }
  | {
      readonly kind: 'failed';
      /** 失败发生在**校验**阶段（整批未执行）还是**执行**阶段（已补偿）。 */
      readonly stage: 'validate' | 'apply';
      readonly reason: RollbackExperienceBatchFailure;
      readonly detail: string;
      /** **字面量 false**：失败时不得留下半个状态。 */
      readonly mutated: false;
      /** 执行阶段失败时，已执行的部分是否被成功补偿回来。 */
      readonly compensated: boolean;
    };

/**
 * 原子地回滚**一批**具体写入（版本）。
 *
 * 1. **校验阶段**：对**全部**目标逐一校验（存在 / 是模板经验 / 属该 owner / 版本匹配 / 当前有效）。
 *    任一不过 ⇒ **整批不执行**（`mutated: false`），库里**一个字节都没改**。
 * 2. **执行阶段**：按 `memory_id` 升序逐个停用（确定性）。若某步意外失败，则把**已停用的**
 *    按逆序重新启用（补偿），并如实上报 `compensated`——绝不宣称"部分成功"。
 *
 * 结果与 `targets` 的**到达顺序无关**。
 */
export function rollbackExperienceBatch(
  input: RollbackExperienceBatchInput,
): RollbackExperienceBatchResult {
  if (typeof input.reason !== 'string' || input.reason.length === 0) {
    return {
      kind: 'failed',
      stage: 'validate',
      reason: 'missing_reason',
      detail: '批次回滚必须给出原因（R240）',
      mutated: false,
      compensated: false,
    };
  }

  // --- 校验阶段：全部通过才动手 ---
  for (const target of input.targets) {
    const raw = input.repository.get(target.memory_id);
    if (raw === undefined) {
      return batchFail('validate', 'not_written', `目标 ${target.memory_id} 从未写入：整批不执行`);
    }
    const found = asExperience(raw);
    if (found === undefined) {
      return batchFail('validate', 'not_experience', `目标 ${target.memory_id} 不是模板经验：整批不执行`);
    }
    if (found.owner_id !== input.owner_id) {
      return batchFail('validate', 'owner_mismatch', `目标 ${target.memory_id} 不属于 ${input.owner_id}：整批不执行`);
    }
    if (found.version !== target.expected_version) {
      return batchFail(
        'validate',
        'version_mismatch',
        `目标 ${target.memory_id} 当前版本 r${String(found.version)} ≠ 声明的 r${String(target.expected_version)}：整批不执行`,
      );
    }
    if (found.status !== 'active') {
      return batchFail(
        'validate',
        'already_invalid',
        `目标 ${target.memory_id} 已是 ${found.status}，不是有效经验：整批不执行（避免半个状态）`,
      );
    }
  }

  // --- 执行阶段：确定性顺序 + 补偿 ---
  const ordered = [...input.targets].sort((left, right) =>
    left.memory_id < right.memory_id ? -1 : left.memory_id > right.memory_id ? 1 : 0,
  );
  const applied: MemoryId[] = [];
  for (const target of ordered) {
    const disabled = input.repository.disable(target.memory_id, input.owner_id, input.at);
    if (!disabled.ok) {
      let compensated = true;
      for (const id of [...applied].reverse()) {
        const back = input.repository.enable(id, input.owner_id, input.at);
        if (!back.ok) compensated = false;
      }
      return {
        kind: 'failed',
        stage: 'apply',
        reason: 'store_failed',
        detail:
          `停用 ${target.memory_id} 失败：${disabled.detail}；` +
          (compensated ? '已执行的停用已全部补偿回滚（无半状态）' : '补偿未能全部完成（已如实上报）'),
        mutated: false,
        compensated,
      };
    }
    applied.push(target.memory_id);
  }

  return Object.freeze({
    kind: 'rolled_back' as const,
    rolled_back: Object.freeze(ordered.map((target) => target.memory_id)),
    at: input.at,
    mutated: true as const,
    reason: input.reason,
  });
}

function batchFail(
  stage: 'validate' | 'apply',
  reason: RollbackExperienceBatchFailure,
  detail: string,
): RollbackExperienceBatchResult {
  return Object.freeze({ kind: 'failed' as const, stage, reason, detail, mutated: false as const, compensated: false });
}

// ---------------------------------------------------------------------------
// 并发追加 + 回滚：确定性；半批次写入不得留在库里
// ---------------------------------------------------------------------------

export interface ConcurrentAppendRollbackInput {
  readonly repository: MemoryRepository;
  readonly owner_id: OwnerId;
  readonly candidates: ConcurrentAppendInput['candidates'];
  readonly at: LogicalTime;
  readonly isSensitive: ConcurrentAppendInput['isSensitive'];
  readonly detectConflict: ConcurrentAppendInput['detectConflict'];
  readonly source: ConcurrentAppendInput['source'];
  readonly newMemoryId: ConcurrentAppendInput['newMemoryId'];
  /** 回滚原因（本函数总是把本批追加的条目回滚掉，回到追加前的有效集合）。 */
  readonly reason: string;
}

export type ConcurrentAppendRollbackOutcome =
  | 'completed' // 追加全部成功，且全部被回滚
  | 'partial_compensated' // 追加部分失败，已写入的部分被回滚掉（回到追加前）
  | 'failed'; // 追加失败且补偿失败（如实上报，不宣称干净）

export interface ConcurrentAppendRollbackResult {
  readonly outcome: ConcurrentAppendRollbackOutcome;
  readonly append: ConcurrentAppendResult;
  readonly rollback: RollbackExperienceBatchResult | null;
  /** 追加**前**该 owner 的有效 lesson（用于断言"回到追加前"）。 */
  readonly active_before: readonly string[];
  /** 收尾后该 owner 的有效 lesson。 */
  readonly active_after: readonly string[];
  /** **字面量**：是否真的无半状态残留（有效集合回到追加前）。 */
  readonly no_half_state: boolean;
  readonly detail: string;
}

/**
 * 并发追加一批经验候选，然后把本批**写入成功的**条目全部回滚——
 * 目的：无论追加是**全成功**还是**部分成功**，最终库里都不会留下"半批"的有效经验。
 *
 * 追加阶段的确定性由 `mergeExperienceCandidates` 保证（与输入顺序无关）；回滚阶段由
 * `rollbackExperienceBatch` 保证原子与顺序无关。因此本函数对候选的**到达顺序免疫**。
 */
export function concurrentAppendThenRollback(
  input: ConcurrentAppendRollbackInput,
): ConcurrentAppendRollbackResult {
  const before = activeOwnerLessons(input.repository, input.owner_id);

  const append = appendExperiencesConcurrently({
    repository: input.repository,
    owner_id: input.owner_id,
    candidates: input.candidates,
    at: input.at,
    isSensitive: input.isSensitive,
    detectConflict: input.detectConflict,
    source: input.source,
    newMemoryId: input.newMemoryId,
  });

  // 收集**写入成功**的条目（含部分成功的那部分）——这些正是要回滚掉的"半个状态"。
  const written = append.committed
    .filter(
      (result): result is Extract<typeof result, { kind: 'written' }> => result.kind === 'written',
    )
    .map((result) => result.entry);

  if (written.length === 0) {
    const afterEmpty = activeOwnerLessons(input.repository, input.owner_id);
    return Object.freeze({
      outcome: (append.all_committed ? 'completed' : 'failed') as ConcurrentAppendRollbackOutcome,
      append,
      rollback: null,
      active_before: before,
      active_after: afterEmpty,
      no_half_state: sameLessons(before, afterEmpty),
      detail: `本批无写入成功条目，无需回滚（all_committed=${String(append.all_committed)}）`,
    });
  }

  const rollback = rollbackExperienceBatch({
    repository: input.repository,
    owner_id: input.owner_id,
    targets: written.map((entry) => ({ memory_id: entry.memory_id, expected_version: entry.version })),
    at: input.at,
    reason: input.reason,
  });

  const after = activeOwnerLessons(input.repository, input.owner_id);
  const noHalfState = rollback.kind === 'rolled_back' && sameLessons(before, after);

  const outcome: ConcurrentAppendRollbackOutcome =
    rollback.kind !== 'rolled_back'
      ? 'failed'
      : append.all_committed
        ? 'completed'
        : 'partial_compensated';

  return Object.freeze({
    outcome,
    append,
    rollback,
    active_before: before,
    active_after: after,
    no_half_state: noHalfState,
    detail:
      `并发追加 ${String(input.candidates.length)} 条（落库成功 ${String(written.length)}）；` +
      `回滚 ${String(rollback.kind === 'rolled_back' ? rollback.rolled_back.length : 0)} 条；` +
      `有效集合 ${noHalfState ? '已回到追加前' : '未回到追加前（如实上报）'}`,
  });
}

// ---------------------------------------------------------------------------
// 实例固定经验快照的隔离
// ---------------------------------------------------------------------------

/** 实例绑定与"当前库"之间的差（用于断言"旧实例规则不变、新实例拿新规则"）。 */
export interface InstanceRuleDiff {
  readonly instance_id: string;
  /** 实例绑定时刻冻结的规则（**不随库变化**）。 */
  readonly frozen_rules: readonly string[];
  /** 库中此刻有效的 lesson。 */
  readonly current_active_lessons: readonly string[];
  /** 冻结规则里**仍然有效**的。 */
  readonly still_active: readonly string[];
  /** 冻结规则里**已被回滚 / 失效**的——旧实例**依然持有**（这正是隔离的证据）。 */
  readonly removed_since_binding: readonly string[];
  /** 绑定之后**新增**的有效 lesson（本实例尚未吃到）。 */
  readonly added_since_binding: readonly string[];
  readonly stale: boolean;
}

/**
 * 计算实例绑定与库当前状态之间的差。
 *
 * 关键断言：`frozen_rules` 恒定（旧实例规则不被改写），而 `removed_since_binding` 会**包含**
 * 绑定后被回滚 / 失效的 lesson——旧实例仍在用它们，新实例（重新绑定）才看得到变化。
 */
export function instanceRuleDiff(
  binding: InstanceExperienceBinding,
  repository: MemoryRepository,
): InstanceRuleDiff {
  const current = activeExperiences(repository, binding.owner_id, binding.template_id).map((entry) => entry.lesson);
  const currentSet = new Set(current);
  const frozen = [...binding.rules];
  const frozenSet = new Set(frozen);
  return Object.freeze({
    instance_id: binding.instance_id,
    frozen_rules: Object.freeze(frozen),
    current_active_lessons: Object.freeze([...current].sort()),
    still_active: Object.freeze(frozen.filter((lesson) => currentSet.has(lesson)).sort()),
    removed_since_binding: Object.freeze(frozen.filter((lesson) => !currentSet.has(lesson)).sort()),
    added_since_binding: Object.freeze(current.filter((lesson) => !frozenSet.has(lesson)).sort()),
    stale: current.some((lesson) => !frozenSet.has(lesson)) || frozen.some((lesson) => !currentSet.has(lesson)),
  });
}
