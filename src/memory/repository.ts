/**
 * 记忆仓库：四类存储**分开**、跨用户隔离、忘记不复活、失败不编造
 * （design-06 P4 / MEM-01 / MEM-02 / MEM-04 / MEM-05；合同 R234 / R235 / R237 / R238 / R240）。
 *
 * ## 四类存储是真的分开（R234）
 *
 * 仓库内部有**四个独立的 Map**，按种类分开存；检索、列举、忘记都按种类走各自的口。
 * 这不是"一张表加过滤器"——会话消息与偏好之间**没有**共同的检索路径，
 * 因此"把会话消息当偏好注入"在结构上就没有入口。
 *
 * ## 隔离是每一条检索的**前置条件**（R237）
 *
 * 每次 `recall()` 都**必须**给出 `owner_id`；实现**只**返回该 owner 的条目，
 * 且任务范围过滤同样严格。跨用户 / 跨任务检索**取不到**对方的记忆——
 * 这是负例测试直接断言的性质，而不是"调用方自己记得加过滤"。
 *
 * ## R240：查不到 / 不确定 / 存储失败 ⇒ **不编造**
 *
 * - 写：`remember()` 的返回是**判别联合**。存储失败（注入的 `beforeWrite` 抛错）
 *   返回 `{ ok: false, reason: 'store_failed' }`，并且**不落任何条目**——
 *   调用方**拿不到**"已记住"这个结论。
 * - 读：`recall()` 的返回带 `status ∈ {found, not_found, uncertain, failed}`。
 *   查不到是 `not_found`、状态不可信是 `uncertain`、读失败是 `failed`；
 *   三种都**返回空 entries**并给出原因，**绝不**用编造的条目填充。
 *
 * ## 忘记不复活（R238）
 *
 * 删除 / 忘记都会写入 **tombstone**（不可逆的"这个 id 已被抹掉"记录）。
 * tombstone **只增不减**，且 `restoreSnapshot()` 合并时**先看 tombstone**：
 * 离线快照恢复**不会**让已删除 / 已忘记的条目复活；复用同一个 id 重新 `remember()`
 * 也会被拒为 `forgotten_id`。
 *
 * 纯内存 + 注入故障接缝：零 IO，时间由调用方经 `LogicalTime` 传入。
 */

import type { LogicalTime, Revision, TaskId, TemplateId } from '../protocol/index.js';
import {
  assertMemoryEntryInvariants,
  createMemoryEntry,
  requireMemoryQueryLimits,
  DEFAULT_MEMORY_LIMITS,
  type ConfirmationState,
  type DerivedId,
  type DerivedRecord,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryQueryLimits,
  type OwnerId,
  type PreferenceMemory,
  type SessionMessageMemory,
  type TaskFactMemory,
  type TemplateExperienceMemory,
} from './types.js';

// ---------------------------------------------------------------------------
// 故障接缝与结果类型
// ---------------------------------------------------------------------------

/** 可注入的故障 / 完整性接缝（默认全部关闭）。 */
export interface MemoryRepositoryFaults {
  /** 写入前钩子：抛错 = 存储失败（R240 的负例来源）。 */
  beforeWrite?: (entry: MemoryEntry) => void;
  /** 读取前钩子：抛错 = 读取失败（`status: 'failed'`）。 */
  beforeRead?: (query: MemoryQuery) => void;
  /** 完整性探针：返回 `uncertain` ⇒ 本次检索结论不可信（`status: 'uncertain'`）。 */
  readIntegrity?: () => 'ok' | 'uncertain';
}

export const MEMORY_WRITE_FAILURES = [
  'store_failed', // 存储失败（未落库）
  'duplicate_id', // 同 id 已存在
  'forgotten_id', // 该 id 已被忘记，不得复活
  'owner_mismatch', // 条目不属该 owner / 操作者不匹配
  'not_found', // 目标不存在
  'unsupported_patch', // 修改字段与该记忆种类不匹配
] as const;
export type MemoryWriteFailure = (typeof MEMORY_WRITE_FAILURES)[number];

export type MemoryWriteResult =
  | { readonly ok: true; readonly entry: MemoryEntry }
  | { readonly ok: false; readonly reason: MemoryWriteFailure; readonly detail: string };

/** 检索结论四值（R240：**查不到 / 不确定 / 失败**都不编造）。 */
export const MEMORY_RECALL_STATUSES = ['found', 'not_found', 'uncertain', 'failed'] as const;
export type MemoryRecallStatus = (typeof MEMORY_RECALL_STATUSES)[number];

export interface MemoryQuery {
  /** **隔离键（必填）**：只返回该 owner 的条目。 */
  readonly owner_id: OwnerId;
  /** 限定种类（省略 = 四类全查，但**仍按各自的口**）。 */
  readonly kinds?: readonly MemoryKind[];
  readonly task_id?: TaskId;
  readonly template_id?: TemplateId;
  /** 子串匹配（对条目的人类可读文本字段）。 */
  readonly text?: string;
  readonly include_disabled?: boolean;
  readonly include_rejected?: boolean;
}

export interface MemoryRecallResult {
  readonly status: MemoryRecallStatus;
  readonly entries: readonly MemoryEntry[];
  /** 命中的总条数（**未截断前**）；`not_found` / 失败时为 0。 */
  readonly total_matched: number;
  readonly truncated: boolean;
  readonly limits: MemoryQueryLimits;
  /** 非 `found` 时的原因（`found` 且被截断时也给说明）。 */
  readonly detail: string | null;
}

/** 忘记 / 删除的结果：抹掉了哪些、联动了哪些派生条目（R238）。 */
export interface ForgetResult {
  readonly forgotten: readonly MemoryId[];
  readonly invalidated_derived: readonly DerivedId[];
}

/** 持久快照（可序列化；跨重启保留）。 */
export interface MemorySnapshot {
  readonly session_messages: readonly SessionMessageMemory[];
  readonly task_facts: readonly TaskFactMemory[];
  readonly preferences: readonly PreferenceMemory[];
  readonly template_experiences: readonly TemplateExperienceMemory[];
  /** 已抹除的 id（**只增不减**；恢复时据此拒绝复活）。 */
  readonly tombstones: readonly MemoryId[];
  readonly derived: readonly DerivedRecord[];
}

/** 按 kind 取该种类允许的修改字段。 */
export interface MemoryEntryPatch {
  readonly text?: string;
  readonly value_text?: string;
  readonly lesson?: string;
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------

interface MemoryState {
  readonly sessionMessages: Map<MemoryId, SessionMessageMemory>;
  readonly taskFacts: Map<MemoryId, TaskFactMemory>;
  readonly preferences: Map<MemoryId, PreferenceMemory>;
  readonly templateExperiences: Map<MemoryId, TemplateExperienceMemory>;
  readonly tombstones: Set<MemoryId>;
  readonly derived: Map<DerivedId, DerivedRecord>;
}

function emptyState(): MemoryState {
  return {
    sessionMessages: new Map(),
    taskFacts: new Map(),
    preferences: new Map(),
    templateExperiences: new Map(),
    tombstones: new Set(),
    derived: new Map(),
  };
}

/** 四类存储中与 kind 对应的那一张表。 */
function storeOf(state: MemoryState, kind: MemoryKind): Map<MemoryId, MemoryEntry> {
  switch (kind) {
    case 'session_message':
      return state.sessionMessages as Map<MemoryId, MemoryEntry>;
    case 'task_fact':
      return state.taskFacts as Map<MemoryId, MemoryEntry>;
    case 'preference':
      return state.preferences as Map<MemoryId, MemoryEntry>;
    case 'template_experience':
      return state.templateExperiences as Map<MemoryId, MemoryEntry>;
  }
}

/** 条目的人类可读文本（用于子串检索与注入摘要）。 */
export function entryText(entry: MemoryEntry): string {
  switch (entry.kind) {
    case 'session_message':
      return entry.text;
    case 'task_fact':
      return `${entry.fact_key}=${entry.value_text}`;
    case 'preference':
      return `${entry.preference_key}=${entry.value_text}`;
    case 'template_experience':
      return entry.lesson;
  }
}

/** 稳定排序：`updated_at` 降序，同刻按 id 升序（确定性）。 */
function byRecency(left: MemoryEntry, right: MemoryEntry): number {
  if (left.updated_at !== right.updated_at) {
    return right.updated_at - left.updated_at;
  }
  return left.memory_id < right.memory_id ? -1 : left.memory_id > right.memory_id ? 1 : 0;
}

export class MemoryRepository {
  private state: MemoryState = emptyState();
  private readonly faults: MemoryRepositoryFaults;

  constructor(options: { readonly faults?: MemoryRepositoryFaults } = {}) {
    this.faults = options.faults ?? {};
  }

  // --- 写 ---

  /**
   * 记住一条记忆（已构造的条目）。
   *
   * 存储失败（`beforeWrite` 抛错）⇒ `{ ok: false, reason: 'store_failed' }`，
   * **不落库**，调用方**不得**据此报告"已记住"（R240）。
   */
  remember(entry: MemoryEntry): MemoryWriteResult {
    assertMemoryEntryInvariants(entry);
    if (this.state.tombstones.has(entry.memory_id)) {
      return {
        ok: false,
        reason: 'forgotten_id',
        detail: `记忆 ${entry.memory_id} 已被忘记：不得用同一 id 复活已抹除的条目（R238）`,
      };
    }
    if (this.find(entry.memory_id) !== undefined) {
      return { ok: false, reason: 'duplicate_id', detail: `记忆 ${entry.memory_id} 已存在` };
    }
    try {
      this.faults.beforeWrite?.(entry);
    } catch (error) {
      return {
        ok: false,
        reason: 'store_failed',
        detail: `存储失败，未写入任何内容：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    storeOf(this.state, entry.kind).set(entry.memory_id, Object.freeze(entry));
    return { ok: true, entry };
  }

  /** 修改内容：**保留来源**、递增版本、`updated_at` 前移；内容变更后确认状态回落为未确认。 */
  modify(memoryId: MemoryId, ownerId: OwnerId, patch: MemoryEntryPatch, at: LogicalTime): MemoryWriteResult {
    const found = this.findAndAuthorize(memoryId, ownerId);
    if (!found.ok) return found;
    const entry = found.entry;

    let updated: MemoryEntry;
    try {
      updated = createMemoryEntry({
        ...entry,
        ...applyPatch(entry, patch),
        confirmation: 'unconfirmed' as ConfirmationState,
        updated_at: at,
        version: (entry.version + 1) as Revision,
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'unsupported_patch',
        detail: `修改字段与记忆种类 ${entry.kind} 不匹配：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      this.faults.beforeWrite?.(updated);
    } catch (error) {
      return {
        ok: false,
        reason: 'store_failed',
        detail: `存储失败，未写入任何内容：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    storeOf(this.state, updated.kind).set(memoryId, Object.freeze(updated));
    return { ok: true, entry: updated };
  }

  /** 用户确认一条记忆（可信度提升，不改内容、不递增版本）。 */
  confirm(memoryId: MemoryId, ownerId: OwnerId, at: LogicalTime): MemoryWriteResult {
    return this.setConfirmation(memoryId, ownerId, 'confirmed', at);
  }

  /** 停用一条记忆（不再进入检索注入，但保留）。 */
  disable(memoryId: MemoryId, ownerId: OwnerId, at: LogicalTime): MemoryWriteResult {
    return this.setStatus(memoryId, ownerId, 'disabled', at);
  }

  /** 重新启用。 */
  enable(memoryId: MemoryId, ownerId: OwnerId, at: LogicalTime): MemoryWriteResult {
    return this.setStatus(memoryId, ownerId, 'active', at);
  }

  /** 软删除：标记 `deleted` 并写 tombstone（保留审计，检索不再返回，恢复不复活）。 */
  delete(memoryId: MemoryId, ownerId: OwnerId, at: LogicalTime): ForgetResult {
    const found = this.findAndAuthorize(memoryId, ownerId);
    if (!found.ok) {
      return { forgotten: Object.freeze([]), invalidated_derived: Object.freeze([]) };
    }
    this.state.tombstones.add(memoryId);
    storeOf(this.state, found.entry.kind).set(
      memoryId,
      Object.freeze(createMemoryEntry({ ...found.entry, status: 'deleted', updated_at: at })),
    );
    return { forgotten: Object.freeze([memoryId]), invalidated_derived: this.invalidateDerived([memoryId]) };
  }

  /**
   * **硬忘记**（用户要求忘记）：条目从存储中移除，id 记入 tombstone。
   * 索引 / 摘要 / 缓存 / 派生经验联动失效（R238）。
   */
  forget(memoryId: MemoryId, ownerId: OwnerId): ForgetResult {
    const found = this.findAndAuthorize(memoryId, ownerId);
    if (!found.ok) {
      return { forgotten: Object.freeze([]), invalidated_derived: Object.freeze([]) };
    }
    storeOf(this.state, found.entry.kind).delete(memoryId);
    this.state.tombstones.add(memoryId);
    return { forgotten: Object.freeze([memoryId]), invalidated_derived: this.invalidateDerived([memoryId]) };
  }

  /** 忘记某个主体的全部记忆（"要求忘记"的整体入口）。 */
  forgetOwner(ownerId: OwnerId): ForgetResult {
    const ids: MemoryId[] = [];
    for (const kind of MEMORY_ALL_KINDS) {
      for (const entry of [...storeOf(this.state, kind).values()]) {
        if (entry.owner_id !== ownerId) continue;
        storeOf(this.state, kind).delete(entry.memory_id);
        this.state.tombstones.add(entry.memory_id);
        ids.push(entry.memory_id);
      }
    }
    return {
      forgotten: Object.freeze(ids),
      invalidated_derived: this.invalidateDerived(ids),
    };
  }

  // --- 读 ---

  /** 按 id 取条目（含已删除，供审计；**不做隔离**——内部用，外部请走 `recall`）。 */
  get(memoryId: MemoryId): MemoryEntry | undefined {
    return this.find(memoryId);
  }

  /** 某个种类的全部条目（**分开的口**，证明四类存储互不相通）。 */
  listByKind(kind: MemoryKind): readonly MemoryEntry[] {
    return Object.freeze([...storeOf(this.state, kind).values()]);
  }

  /**
   * 检索（**隔离 + 上限 + 不编造**）。
   *
   * 只返回 `owner_id` 匹配的条目；默认只含 `active` 且未被否定的条目。
   * 命中按 `updated_at` 降序排序，再按 `max_items` / `max_chars` **截断**（`truncated` 如实上报）。
   */
  recall(query: MemoryQuery, limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS): MemoryRecallResult {
    const safeLimits = requireMemoryQueryLimits(limits, 'recall limits');

    try {
      this.faults.beforeRead?.(query);
    } catch (error) {
      return this.failure('failed', safeLimits, `读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.faults.readIntegrity?.() === 'uncertain') {
      return this.failure(
        'uncertain',
        safeLimits,
        '记忆状态不可信（完整性未知）：本次不返回任何条目，也不得据此宣称"已经记住"（R240）',
      );
    }

    const kinds = query.kinds ?? MEMORY_ALL_KINDS;
    const matched: MemoryEntry[] = [];
    for (const kind of kinds) {
      for (const entry of storeOf(this.state, kind).values()) {
        if (entry.owner_id !== query.owner_id) continue; // 跨用户隔离
        if (!query.include_disabled && entry.status !== 'active') continue;
        if (entry.status === 'deleted') continue;
        if (!query.include_rejected && entry.confirmation === 'rejected') continue;
        if (query.task_id !== undefined && entry.scope.task_id !== query.task_id) continue;
        if (query.template_id !== undefined && entry.scope.template_id !== query.template_id) continue;
        if (query.text !== undefined && !entryText(entry).includes(query.text)) continue;
        matched.push(entry);
      }
    }

    matched.sort(byRecency);

    const entries: MemoryEntry[] = [];
    let usedChars = 0;
    let truncated = false;
    for (const entry of matched) {
      if (entries.length >= safeLimits.max_items) {
        truncated = true;
        break;
      }
      const length = entryText(entry).length;
      if (usedChars + length > safeLimits.max_chars) {
        truncated = true;
        break;
      }
      entries.push(entry);
      usedChars += length;
    }

    if (matched.length === 0) {
      return Object.freeze({
        status: 'not_found',
        entries: Object.freeze([]),
        total_matched: 0,
        truncated: false,
        limits: safeLimits,
        detail: '没有匹配的记忆条目（查不到就是查不到，不得编造"已经记住"，R240）',
      });
    }

    return Object.freeze({
      status: 'found',
      entries: Object.freeze(entries),
      total_matched: matched.length,
      truncated,
      limits: safeLimits,
      detail: truncated
        ? `命中共 ${String(matched.length)} 条，受上限（最多 ${String(safeLimits.max_items)} 条 / ` +
          `${String(safeLimits.max_chars)} 字符）截断，实际注入 ${String(entries.length)} 条`
        : null,
    });
  }

  // --- 派生条目（联动失效，R238）---

  registerDerived(record: DerivedRecord): DerivedRecord {
    const frozen = Object.freeze({ ...record, derived_from: Object.freeze([...record.derived_from]) });
    this.state.derived.set(frozen.derived_id, frozen);
    return frozen;
  }

  listDerived(ownerId?: OwnerId): readonly DerivedRecord[] {
    const all = [...this.state.derived.values()].filter(
      (record) => ownerId === undefined || record.owner_id === ownerId,
    );
    all.sort((left, right) =>
      left.derived_id < right.derived_id ? -1 : left.derived_id > right.derived_id ? 1 : 0,
    );
    return Object.freeze(all);
  }

  private invalidateDerived(sourceIds: readonly MemoryId[]): readonly DerivedId[] {
    if (sourceIds.length === 0) return Object.freeze([]);
    const victims = new Set<string>(sourceIds);
    const invalidated: DerivedId[] = [];
    for (const [id, record] of this.state.derived) {
      if (record.invalidated) continue;
      if (record.derived_from.some((source) => victims.has(source))) {
        this.state.derived.set(id, Object.freeze({ ...record, invalidated: true }));
        invalidated.push(id);
      }
    }
    return Object.freeze(invalidated);
  }

  // --- 持久状态 ---

  snapshot(): MemorySnapshot {
    return Object.freeze({
      session_messages: Object.freeze([...this.state.sessionMessages.values()]),
      task_facts: Object.freeze([...this.state.taskFacts.values()]),
      preferences: Object.freeze([...this.state.preferences.values()]),
      template_experiences: Object.freeze([...this.state.templateExperiences.values()]),
      tombstones: Object.freeze([...this.state.tombstones]),
      derived: this.listDerived(),
    });
  }

  /**
   * 从离线快照合并恢复。
   *
   * **先看 tombstone**：任一侧 tombstone 里的 id 都**不会**被恢复（R238：删除后离线恢复不复活）。
   * 其余条目按 id 合并，保留版本更高的一条。
   */
  restoreSnapshot(snapshot: MemorySnapshot): void {
    for (const id of snapshot.tombstones) {
      this.state.tombstones.add(id);
    }
    // 注意：tombstone 只用于**拒绝恢复**（下面跳过 incoming 条目），
    // **不**去抹掉本地已有的记录——软删除留下的审计记录（`status: 'deleted'`）
    // 属于当前侧的真实状态，恢复一份更早的快照不得把它清掉。

    const incoming: readonly MemoryEntry[] = [
      ...snapshot.session_messages,
      ...snapshot.task_facts,
      ...snapshot.preferences,
      ...snapshot.template_experiences,
    ];
    for (const entry of incoming) {
      if (this.state.tombstones.has(entry.memory_id)) continue; // 不复活
      const existing = this.find(entry.memory_id);
      if (existing === undefined || entry.version > existing.version) {
        storeOf(this.state, entry.kind).set(entry.memory_id, Object.freeze(createMemoryEntry(entry)));
      }
    }

    for (const record of snapshot.derived) {
      const current = this.state.derived.get(record.derived_id);
      if (current === undefined) {
        this.state.derived.set(record.derived_id, Object.freeze({ ...record }));
        continue;
      }
      if (record.invalidated && !current.invalidated) {
        this.state.derived.set(record.derived_id, Object.freeze({ ...current, invalidated: true }));
      }
    }
  }

  // --- 内部 ---

  private failure(status: MemoryRecallStatus, limits: MemoryQueryLimits, detail: string): MemoryRecallResult {
    return Object.freeze({
      status,
      entries: Object.freeze([]),
      total_matched: 0,
      truncated: false,
      limits,
      detail,
    });
  }

  private find(memoryId: MemoryId): MemoryEntry | undefined {
    for (const kind of MEMORY_ALL_KINDS) {
      const found = storeOf(this.state, kind).get(memoryId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private findAndAuthorize(
    memoryId: MemoryId,
    ownerId: OwnerId,
  ): { readonly ok: true; readonly entry: MemoryEntry } | { readonly ok: false; readonly reason: MemoryWriteFailure; readonly detail: string } {
    const entry = this.find(memoryId);
    if (entry === undefined) {
      return { ok: false, reason: 'not_found', detail: `记忆 ${memoryId} 不存在` };
    }
    if (entry.owner_id !== ownerId) {
      return {
        ok: false,
        reason: 'owner_mismatch',
        detail: `记忆 ${memoryId} 不属于 ${ownerId}：跨用户操作被拒（R237 隔离）`,
      };
    }
    return { ok: true, entry };
  }

  private setConfirmation(
    memoryId: MemoryId,
    ownerId: OwnerId,
    confirmation: ConfirmationState,
    at: LogicalTime,
  ): MemoryWriteResult {
    const found = this.findAndAuthorize(memoryId, ownerId);
    if (!found.ok) return found;
    const updated = Object.freeze(createMemoryEntry({ ...found.entry, confirmation, updated_at: at }));
    storeOf(this.state, updated.kind).set(memoryId, updated);
    return { ok: true, entry: updated };
  }

  private setStatus(
    memoryId: MemoryId,
    ownerId: OwnerId,
    status: 'active' | 'disabled',
    at: LogicalTime,
  ): MemoryWriteResult {
    const found = this.findAndAuthorize(memoryId, ownerId);
    if (!found.ok) return found;
    if (found.entry.status === 'deleted') {
      return {
        ok: false,
        reason: 'forgotten_id',
        detail: `记忆 ${memoryId} 已被删除：不得复活已抹除的条目（R238）`,
      };
    }
    const updated = Object.freeze(createMemoryEntry({ ...found.entry, status, updated_at: at }));
    storeOf(this.state, updated.kind).set(memoryId, updated);
    return { ok: true, entry: updated };
  }
}

const MEMORY_ALL_KINDS: readonly MemoryKind[] = Object.freeze([
  'session_message',
  'task_fact',
  'preference',
  'template_experience',
]);

/** 按种类把补丁落到正确的文本字段上（不匹配 ⇒ 由 `createMemoryEntry` 抛错）。 */
function applyPatch(entry: MemoryEntry, patch: MemoryEntryPatch): Record<string, unknown> {
  switch (entry.kind) {
    case 'session_message':
      return patch.text === undefined ? {} : { text: patch.text };
    case 'task_fact':
    case 'preference':
      return patch.value_text === undefined ? {} : { value_text: patch.value_text };
    case 'template_experience':
      return patch.lesson === undefined ? {} : { lesson: patch.lesson };
  }
}

/** 构造记忆仓库。 */
export function createMemoryRepository(options: { readonly faults?: MemoryRepositoryFaults } = {}): MemoryRepository {
  return new MemoryRepository(options);
}
