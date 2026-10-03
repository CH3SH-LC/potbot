/**
 * 分型范围存储：四类记忆**分别存储**、每条记忆带范围 · 来源 · 确认状态 · 时间 · 版本，
 * 且**任务内约束不得自动外溢为长期偏好**（design-06 P4 / MEM-01 / MEM-02；合同 R234 / R235）。
 *
 * ## 四类不混装，且**没有**跨类的取数路径（R234）
 *
 * `TypedScopeStore` 内部有**四个独立的 Map**，各自只在对应的 `record()` 口写入。
 * 取数只有**分型的四个访问器**（`sessionMessages()` / `taskFacts()` / `preferences()` /
 * `templateExperiences()`）与**按 id 的精确取**——**不提供**"一把子文本检索"这种跨类入口。
 * 于是"把会话消息当偏好注入"在本层同样没有入口。
 *
 * 本层不重复 `repository.ts` 的隔离 / 上限 / 忘记职责，只负责**分型落位**与**升格守卫**；
 * 二者可以叠用（本层管"这条属于哪一类"，仓库管"谁能读到它"）。
 *
 * ## 每条记忆都带齐全的五元信息（R235 / MEM-02）
 *
 * `provenanceOf()` 把任意一类条目归一成 `MemoryProvenance`：范围（用户 / 任务 / 模板）、
 * 来源、确认状态、创建 / 更新时间、版本。下游（决策气泡 / 审计）只认这一个形状。
 *
 * ## 任务内约束**不自动**变成全局个人偏好（R235）——本文件的核心守卫
 *
 * 结构上：`createMemoryEntry` 已禁止"任务范围的偏好"，因此**写不出**这样的条目。
 * 操作上：`evaluateScopePromotion()` 给"把任务内约束记成长期偏好"这件事加了**显式闸门**——
 * 只有用户在**明确确认**（`explicit_user_confirmation` 且来源是 `user_confirmation`）时才放行；
 * 默认路径一律 `denied`，并给出结构化拒因。于是"这次任务里说用 A4，就被记成我永远用 A4"
 * 在**默认路径上不可能发生**。
 *
 * 纯函数 + 内存结构：零 IO、不含墙钟与随机数，时间由调用方经 `LogicalTime` 传入。
 */

import type { LogicalTime, Revision } from '../protocol/index.js';
import {
  ALLOWED_SCOPE_BY_KIND,
  createMemoryEntry,
  type ConfirmationState,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryScope,
  type MemorySource,
  type MemorySourceKind,
  type MemoryStatus,
  type OwnerId,
  type PreferenceMemory,
  type SessionMessageMemory,
  type TaskFactMemory,
  type TemplateExperienceMemory,
} from './types.js';

// ---------------------------------------------------------------------------
// 归一化的五元信息
// ---------------------------------------------------------------------------

/** 任意一类记忆条目归一后的"范围 · 来源 · 确认状态 · 时间 · 版本"（MEM-02）。 */
export interface MemoryProvenance {
  readonly memory_id: MemoryId;
  readonly owner_id: OwnerId;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly source: MemorySource;
  readonly confirmation: ConfirmationState;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
  readonly version: Revision;
  readonly status: MemoryStatus;
}

/** 抽出一条记忆的五元信息（不改变条目）。 */
export function provenanceOf(entry: MemoryEntry): MemoryProvenance {
  return Object.freeze({
    memory_id: entry.memory_id,
    owner_id: entry.owner_id,
    kind: entry.kind,
    scope: entry.scope,
    source: entry.source,
    confirmation: entry.confirmation,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    version: entry.version,
    status: entry.status,
  });
}

// ---------------------------------------------------------------------------
// 分型落位
// ---------------------------------------------------------------------------

/** 落位失败原因（封闭枚举）。 */
export const TYPED_SCOPE_WRITE_FAILURES = [
  'not_an_entry', // 传入的不是一条成形的记忆条目
  'scope_kind_mismatch', // 记忆种类与范围种类不匹配（R235 的结构化强制）
  'binding_mismatch', // task_id / template_id 与 scope 两处不一致
  'duplicate_id', // 同 id 已在该类存储中
] as const;
export type TypedScopeWriteFailure = (typeof TYPED_SCOPE_WRITE_FAILURES)[number];

export type TypedScopeWriteResult =
  | { readonly ok: true; readonly entry: MemoryEntry; readonly lane: MemoryKind }
  | { readonly ok: false; readonly reason: TypedScopeWriteFailure; readonly detail: string };

/** 各类型存储的条数（证明"四类分开"的可读证据）。 */
export type LaneCounts = Readonly<Record<MemoryKind, number>>;

/**
 * 分型范围存储：四类记忆分别落在四个独立存储中，写入只走分型口。
 *
 * 本类**不提供**跨类型检索——需要"谁读到什么"时请配合 `repository.ts` 的 `recall`。
 */
export class TypedScopeStore {
  private readonly sessionMessageLane = new Map<MemoryId, SessionMessageMemory>();
  private readonly taskFactLane = new Map<MemoryId, TaskFactMemory>();
  private readonly preferenceLane = new Map<MemoryId, PreferenceMemory>();
  private readonly templateExperienceLane = new Map<MemoryId, TemplateExperienceMemory>();

  /**
   * 把一条记忆落到它**唯一**对应的分型存储里。
   *
   * 落位前复核两道绑定：① 记忆种类 ↔ 范围种类必须匹配（R235）；② `task_fact.task_id` /
   * `template_experience.template_id` 必须与 `scope` 两处一致。任一不符 ⇒ 拒绝，**不落任何存储**。
   * 本方法**只会写入一条**到**一个**存储，绝不存在"同时进两类"或"跨类提升"的路径。
   */
  record(entry: MemoryEntry): TypedScopeWriteResult {
    if (entry === null || typeof entry !== 'object' || typeof entry.kind !== 'string') {
      return fail('not_an_entry', '传入的不是一条记忆条目');
    }
    const expectedScope = ALLOWED_SCOPE_BY_KIND[entry.kind];
    if (expectedScope === undefined) {
      return fail('not_an_entry', `未知的记忆种类 ${String(entry.kind)}`);
    }
    if (entry.scope === undefined || entry.scope.kind !== expectedScope) {
      return fail(
        'scope_kind_mismatch',
        `记忆种类 ${entry.kind} 的范围必须是 ${expectedScope}，收到 ${String(
          entry.scope?.kind,
        )}：四类记忆分属不同范围（R235）`,
      );
    }

    let canonical: MemoryEntry;
    try {
      canonical = createMemoryEntry(entry);
    } catch (error) {
      return fail('binding_mismatch', error instanceof Error ? error.message : String(error));
    }

    const existing = this.find(canonical.memory_id);
    if (existing !== undefined) {
      return fail(
        'duplicate_id',
        `记忆 ${canonical.memory_id} 已存在于 ${existing.kind} 存储：不得跨类或同 id 重写`,
      );
    }

    switch (canonical.kind) {
      case 'session_message':
        this.sessionMessageLane.set(canonical.memory_id, canonical);
        return Object.freeze({ ok: true, entry: canonical, lane: 'session_message' });
      case 'task_fact':
        this.taskFactLane.set(canonical.memory_id, canonical);
        return Object.freeze({ ok: true, entry: canonical, lane: 'task_fact' });
      case 'preference':
        this.preferenceLane.set(canonical.memory_id, canonical);
        return Object.freeze({ ok: true, entry: canonical, lane: 'preference' });
      case 'template_experience':
        this.templateExperienceLane.set(canonical.memory_id, canonical);
        return Object.freeze({ ok: true, entry: canonical, lane: 'template_experience' });
    }
  }

  // --- 分型取数（无跨类检索口）---

  sessionMessages(): readonly SessionMessageMemory[] {
    return Object.freeze([...this.sessionMessageLane.values()]);
  }

  taskFacts(): readonly TaskFactMemory[] {
    return Object.freeze([...this.taskFactLane.values()]);
  }

  preferences(): readonly PreferenceMemory[] {
    return Object.freeze([...this.preferenceLane.values()]);
  }

  templateExperiences(): readonly TemplateExperienceMemory[] {
    return Object.freeze([...this.templateExperienceLane.values()]);
  }

  /** 按 id 精确取（**跨四类扫描**，仅供审计 / 去重；不构成文本检索口）。 */
  get(memoryId: MemoryId): MemoryEntry | undefined {
    return this.find(memoryId);
  }

  /** 各类型存储的条数——"四类分开"的可读证据。 */
  lanes(): LaneCounts {
    return Object.freeze({
      session_message: this.sessionMessageLane.size,
      task_fact: this.taskFactLane.size,
      preference: this.preferenceLane.size,
      template_experience: this.templateExperienceLane.size,
    });
  }

  private find(memoryId: MemoryId): MemoryEntry | undefined {
    return (
      this.sessionMessageLane.get(memoryId) ??
      this.taskFactLane.get(memoryId) ??
      this.preferenceLane.get(memoryId) ??
      this.templateExperienceLane.get(memoryId)
    );
  }
}

/** 构造分型范围存储。 */
export function createTypedScopeStore(): TypedScopeStore {
  return new TypedScopeStore();
}

function fail(reason: TypedScopeWriteFailure, detail: string): TypedScopeWriteResult {
  return Object.freeze({ ok: false, reason, detail });
}

// ---------------------------------------------------------------------------
// 升格守卫：任务内约束 **不自动** 变成全局个人偏好（R235）
// ---------------------------------------------------------------------------

export const SCOPE_PROMOTION_DENIALS = [
  'source_not_task_constraint', // 升格只针对"任务内约束"这一情形，别的来源一律不走此口
  'requires_explicit_user_confirmation', // **默认拒绝**：没有用户显式确认就不升格
  'source_not_user_originated', // 来源必须是用户确认（推断 / 外部内容不算）
] as const;
export type ScopePromotionDenial = (typeof SCOPE_PROMOTION_DENIALS)[number];

export interface ScopePromotionRequest {
  /** 想升格为长期偏好的**来源条目**（必须是任务范围内的条目）。 */
  readonly source: MemoryEntry;
  readonly preference_key: string;
  readonly value_text: string;
  /**
   * 用户是否**显式**确认"把这条记成我的长期偏好"。
   * 默认路径恒为 `false`——这正是"任务条件不自动变偏好"的机器化落点。
   */
  readonly explicit_user_confirmation: boolean;
  /** 升格的来源（必须由**用户确认**而来；推断 / 外部内容不得作为升格依据）。 */
  readonly origin: MemorySource;
  readonly at: LogicalTime;
  readonly newMemoryId: () => MemoryId;
}

export type ScopePromotionDecision =
  | { readonly allowed: true; readonly entry: PreferenceMemory; readonly note: string }
  | { readonly allowed: false; readonly reason: ScopePromotionDenial; readonly detail: string };

/** 该来源种类是否"由用户而来"（可用于升格）。 */
function isUserOriginated(kind: MemorySourceKind): boolean {
  return kind === 'user_statement' || kind === 'user_confirmation';
}

/**
 * 评估"把一条任务内约束升格为用户长期偏好"的请求。
 *
 * 检查顺序（**默认拒绝**贯穿始终）：
 * 1. 来源必须是**任务范围**的条目 ⇒ 否则 `source_not_task_constraint`；
 * 2. 必须有**用户显式确认** ⇒ 否则 `requires_explicit_user_confirmation`（自动外溢被挡在这里）；
 * 3. 升格依据必须由**用户确认**而来 ⇒ 否则 `source_not_user_originated`；
 * 4. 全部通过 ⇒ 放行，产出**用户范围**的偏好（`confirmed`），并在说明里标注来源与时间。
 */
export function evaluateScopePromotion(request: ScopePromotionRequest): ScopePromotionDecision {
  if (request.source.scope.kind !== 'task') {
    return Object.freeze({
      allowed: false,
      reason: 'source_not_task_constraint',
      detail:
        '升格口只用于"把**任务内约束**记成长期偏好"这一情形；来源不是任务范围的条目不走此口（R235）',
    });
  }
  if (request.explicit_user_confirmation !== true) {
    return Object.freeze({
      allowed: false,
      reason: 'requires_explicit_user_confirmation',
      detail:
        '本次任务条件**不得自动**变成全局个人偏好：没有用户显式确认，任务内约束只在本任务内生效（R235）',
    });
  }
  if (!isUserOriginated(request.origin.kind)) {
    return Object.freeze({
      allowed: false,
      reason: 'source_not_user_originated',
      detail:
        `升格依据必须是用户陈述 / 用户确认，收到 ${request.origin.kind}：推断或外部内容不得把约束写进长期偏好（R235）`,
    });
  }

  const entry = createMemoryEntry({
    kind: 'preference',
    memory_id: request.newMemoryId(),
    owner_id: request.source.owner_id,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_confirmation', detail: request.origin.detail },
    confirmation: 'confirmed',
    created_at: request.at,
    updated_at: request.at,
    version: 0,
    status: 'active',
    preference_key: request.preference_key,
    value_text: request.value_text,
  }) as PreferenceMemory;

  return Object.freeze({
    allowed: true,
    entry,
    note:
      `用户显式确认把任务内约束 "${request.preference_key}=${request.value_text}" 记为长期偏好` +
      `（来源 ${request.origin.kind}:${request.origin.detail}，时间 ${String(request.at)}）：` +
      '这是**经确认**的升格，不是自动外溢（R235）',
  });
}

/** 升格落库的结果（放行 ⇒ 写入用户偏好；拒绝 ⇒ 不落任何存储）。 */
export type ScopePromotionResult =
  | { readonly ok: true; readonly entry: PreferenceMemory; readonly note: string }
  | {
      readonly ok: false;
      readonly reason: ScopePromotionDenial | 'store_failed';
      readonly detail: string;
    };

/**
 * 在分型存储上落地一次升格评估：放行则写入**用户偏好**存储，拒绝则**什么都不写**。
 *
 * 无论哪种结果，来源任务条目的存储都**不受影响**——升格不迁移、不删除、不改写原条目。
 */
export function applyScopePromotion(
  store: TypedScopeStore,
  decision: ScopePromotionDecision,
): ScopePromotionResult {
  if (!decision.allowed) {
    return Object.freeze({ ok: false, reason: decision.reason, detail: decision.detail });
  }
  const written = store.record(decision.entry);
  if (!written.ok) {
    return Object.freeze({
      ok: false,
      reason: 'store_failed',
      detail: `升格条目未能落入偏好存储：${written.detail}`,
    });
  }
  return Object.freeze({ ok: true, entry: decision.entry, note: decision.note });
}
