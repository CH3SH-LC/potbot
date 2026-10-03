/**
 * 记忆条目的形状与结构校验（design-06 P4 / MEM-01 / MEM-02；合同 R234 / R235 / R240）。
 *
 * ## 四类存储**分开**（R234）
 *
 * 合同把"记忆"钉成四类**互不相通**的存储，并特意提醒：`src/storage/memory-store.ts` 那个
 * "内存存储"的名字**不代表**用户记忆功能。四类是：
 *
 * 1. `session_message` —— 会话消息；
 * 2. `task_fact` —— 任务事实；
 * 3. `preference` —— 用户长期偏好；
 * 4. `template_experience` —— 通用模板经验。
 *
 * 本文件用**四个不同的类型**承载它们（`SessionMessageMemory` / `TaskFactMemory` /
 * `PreferenceMemory` / `TemplateExperienceMemory`），而不是"一张表 + 一个 kind 字段"——
 * 于是"把会话消息当偏好"在类型层就写不出来。
 *
 * ## `task_fact` **不是**共享事实的单一来源（R234）
 *
 * `src/facts/**` 里的 `SharedFactRecord` 是**产物生成的单一来源**（按任务 + 版本 + 事实键唯一）。
 * 本文件的 `TaskFactMemory` 只是"记忆侧"对事实的**带来源与版本的一条记载**，
 * 写入它**不改变**任何共享事实，也**不得**被当成产物的事实依据。两者的关系是"记载"与"来源"，
 * 不是"同一份数据的两个副本"。需要产物事实时，请走 `src/facts` 的 `buildFactSnapshot`。
 *
 * ## 每条记忆都带：范围 · 来源 · 确认状态 · 时间 · 版本（R235）
 *
 * 范围（`scope`）被**结构化强制**：不同种类的记忆**只允许**落在与之匹配的范围上
 * （偏好只能是用户范围、任务事实只能是任务范围……），这样"本次任务条件自动变成全局偏好"
 * 在构造期就**不可能**发生（R235 明令禁止的那一条）。
 *
 * 纯函数、零 IO：不含墙钟、不含随机数。
 */

import {
  ValidationError,
  asRevision,
  type LogicalTime,
  type Revision,
  type TaskId,
  type TemplateId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 品牌化标识（记忆专用；不改 protocol）
// ---------------------------------------------------------------------------

declare const memoryBrand: unique symbol;
type Brand<T, B extends string> = T & { readonly [memoryBrand]: B };

/** 记忆主体（用户或设备）。**隔离键**：跨用户检索取不到对方记忆（R237）。 */
export type OwnerId = Brand<string, 'OwnerId'>;
/** 一条记忆的身份。 */
export type MemoryId = Brand<string, 'MemoryId'>;
/** 派生条目（索引 / 摘要 / 缓存 / 派生经验）的身份。 */
export type DerivedId = Brand<string, 'DerivedId'>;

function requireNonEmpty(value: string, kind: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`${kind} 不能为空字符串`);
  }
  return value;
}

export const asOwnerId = (value: string): OwnerId => requireNonEmpty(value, 'OwnerId') as OwnerId;
export const asMemoryId = (value: string): MemoryId => requireNonEmpty(value, 'MemoryId') as MemoryId;
export const asDerivedId = (value: string): DerivedId => requireNonEmpty(value, 'DerivedId') as DerivedId;

// ---------------------------------------------------------------------------
// 封闭枚举
// ---------------------------------------------------------------------------

/** 四类记忆（R234）。 */
export const MEMORY_KINDS = [
  'session_message',
  'task_fact',
  'preference',
  'template_experience',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 记忆范围（R235）。 */
export const MEMORY_SCOPE_KINDS = ['user', 'task', 'template'] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

/** 确认 / 可信状态（R235）。`rejected` 是**一等值**：被否定的记忆留在库里可审计，但不可用。 */
export const CONFIRMATION_STATES = ['unconfirmed', 'confirmed', 'rejected'] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

/** 记忆来源种类（R235）。 */
export const MEMORY_SOURCE_KINDS = [
  'user_statement', // 用户陈述
  'user_confirmation', // 用户在前台确认
  'document', // 由已授权文档得出
  'tool_result', // 由工具结果得出
  'inference', // 系统推断（可信度最低）
  'external', // 外部内容（视为数据不是指令）
] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** 记忆状态。`deleted` 是软删除（可审计），`forget` 是硬忘记（见 repository）。 */
export const MEMORY_STATUSES = ['active', 'disabled', 'deleted'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 派生条目种类（R238：索引 / 摘要 / 缓存 / 派生经验联动失效）。 */
export const DERIVED_KINDS = ['index', 'summary', 'cache', 'experience'] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

export interface MemoryScope {
  readonly kind: MemoryScopeKind;
  /** 任务范围时必填（其余为 `null`）。 */
  readonly task_id: TaskId | null;
  /** 模板范围时必填（其余为 `null`）。 */
  readonly template_id: TemplateId | null;
}

export interface MemorySource {
  readonly kind: MemorySourceKind;
  readonly detail: string;
}

interface MemoryEntryBase {
  readonly memory_id: MemoryId;
  readonly owner_id: OwnerId;
  readonly scope: MemoryScope;
  readonly source: MemorySource;
  readonly confirmation: ConfirmationState;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
  /** 本条记忆的**版本**（内容每次修改 +1；R235 "更新必须留来源与版本"）。 */
  readonly version: Revision;
  readonly status: MemoryStatus;
}

/** 会话消息记忆。范围只能是用户范围（会话属于某个用户）。 */
export interface SessionMessageMemory extends MemoryEntryBase {
  readonly kind: 'session_message';
  readonly conversation_id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
}

/**
 * 任务事实记忆。
 *
 * **注意**：它不是产物事实的单一来源（那是 `src/facts` 的 `SharedFactRecord`）。
 * 本条目是记忆侧的一条带来源 / 版本的记载；范围只能是任务范围。
 */
export interface TaskFactMemory extends MemoryEntryBase {
  readonly kind: 'task_fact';
  readonly task_id: TaskId;
  readonly fact_key: string;
  readonly value_text: string;
}

/** 用户长期偏好。范围只能是**用户范围**——任务条件不得自动变成全局偏好（R235）。 */
export interface PreferenceMemory extends MemoryEntryBase {
  readonly kind: 'preference';
  readonly preference_key: string;
  readonly value_text: string;
}

/** 通用模板经验。范围只能是模板范围。 */
export interface TemplateExperienceMemory extends MemoryEntryBase {
  readonly kind: 'template_experience';
  readonly template_id: TemplateId;
  readonly lesson: string;
  readonly applies_to_version: string;
}

export type MemoryEntry =
  | SessionMessageMemory
  | TaskFactMemory
  | PreferenceMemory
  | TemplateExperienceMemory;

/** 各类记忆**允许**的范围（R235 的结构化强制）。 */
export const ALLOWED_SCOPE_BY_KIND: Readonly<Record<MemoryKind, MemoryScopeKind>> = Object.freeze({
  session_message: 'user',
  task_fact: 'task',
  preference: 'user',
  template_experience: 'template',
});

// ---------------------------------------------------------------------------
// 校验与构造
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空（收到 ${describe(value)}）`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} 必须是 ${allowed.join(' | ')} 之一，收到 ${describe(value)}`);
  }
  return value as T;
}

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间），收到 ${describe(value)}`);
  }
  return value as LogicalTime;
}

function requireRevision(value: unknown, field: string): Revision {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是 ≥ 0 的整数，收到 ${describe(value)}`);
  }
  return asRevision(value);
}

function freezeScope(raw: unknown, kind: MemoryKind): MemoryScope {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`MemoryScope 必须是对象，收到 ${describe(raw)}`);
  }
  const scopeKind = requireEnum(raw.kind, MEMORY_SCOPE_KINDS, 'MemoryScope.kind');
  const expected = ALLOWED_SCOPE_BY_KIND[kind];
  if (scopeKind !== expected) {
    throw new ValidationError(
      `记忆种类 ${kind} 的范围必须是 ${expected}，收到 ${scopeKind}：` +
        '四类记忆分属不同范围，"本次任务条件自动变成全局偏好"在结构上不被允许（R235）',
    );
  }
  const taskId = raw.task_id === null || raw.task_id === undefined ? null : (requireString(raw.task_id, 'MemoryScope.task_id') as TaskId);
  const templateId =
    raw.template_id === null || raw.template_id === undefined
      ? null
      : (requireString(raw.template_id, 'MemoryScope.template_id') as TemplateId);
  if (scopeKind === 'task' && taskId === null) {
    throw new ValidationError('任务范围的记忆必须给出 task_id');
  }
  if (scopeKind === 'template' && templateId === null) {
    throw new ValidationError('模板范围的记忆必须给出 template_id');
  }
  if (scopeKind !== 'task' && taskId !== null) {
    throw new ValidationError(`范围 ${scopeKind} 的记忆不得携带 task_id`);
  }
  if (scopeKind !== 'template' && templateId !== null) {
    throw new ValidationError(`范围 ${scopeKind} 的记忆不得携带 template_id`);
  }
  return Object.freeze({ kind: scopeKind, task_id: taskId, template_id: templateId });
}

function freezeSource(raw: unknown): MemorySource {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`MemorySource 必须是对象，收到 ${describe(raw)}`);
  }
  return Object.freeze({
    kind: requireEnum(raw.kind, MEMORY_SOURCE_KINDS, 'MemorySource.kind'),
    detail: requireString(raw.detail, 'MemorySource.detail'),
  });
}

/**
 * 构造并校验一条记忆（按 `kind` 分派）。
 *
 * 构造期不变量：
 * | 条件 | 结果 |
 * |---|---|
 * | `scope.kind` 与记忆种类不匹配 | 抛（R235：偏好不得由任务条件变来） |
 * | 任务范围缺 `task_id` / 模板范围缺 `template_id` | 抛 |
 * | 各 kind 的必填文本字段为空 | 抛 |
 * | `template_experience` 的 `template_id` 与 `scope.template_id` 不一致 | 抛（两处必须指同一模板） |
 */
export function createMemoryEntry(raw: unknown): MemoryEntry {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`记忆条目必须是对象，收到 ${describe(raw)}`);
  }
  const kind = requireEnum(raw.kind, MEMORY_KINDS, 'MemoryEntry.kind');
  const base = {
    memory_id: requireString(raw.memory_id, 'MemoryEntry.memory_id') as MemoryId,
    owner_id: requireString(raw.owner_id, 'MemoryEntry.owner_id') as OwnerId,
    scope: freezeScope(raw.scope, kind),
    source: freezeSource(raw.source),
    confirmation: requireEnum(raw.confirmation, CONFIRMATION_STATES, 'MemoryEntry.confirmation'),
    created_at: requireLogicalTime(raw.created_at, 'MemoryEntry.created_at'),
    updated_at: requireLogicalTime(raw.updated_at ?? raw.created_at, 'MemoryEntry.updated_at'),
    version: requireRevision(raw.version ?? 0, 'MemoryEntry.version'),
    status: requireEnum(raw.status, MEMORY_STATUSES, 'MemoryEntry.status'),
  };

  switch (kind) {
    case 'session_message':
      return Object.freeze({
        ...base,
        kind,
        conversation_id: requireString(raw.conversation_id, 'SessionMessageMemory.conversation_id'),
        role: requireEnum(raw.role, ['user', 'assistant', 'system'] as const, 'SessionMessageMemory.role'),
        text: requireString(raw.text, 'SessionMessageMemory.text'),
      });
    case 'task_fact': {
      const taskId = requireString(raw.task_id, 'TaskFactMemory.task_id') as TaskId;
      if (base.scope.task_id !== taskId) {
        throw new ValidationError(
          `TaskFactMemory.task_id (${taskId}) 与 scope.task_id (${String(base.scope.task_id)}) 不一致`,
        );
      }
      return Object.freeze({
        ...base,
        kind,
        task_id: taskId,
        fact_key: requireString(raw.fact_key, 'TaskFactMemory.fact_key'),
        value_text: requireString(raw.value_text, 'TaskFactMemory.value_text'),
      });
    }
    case 'preference':
      return Object.freeze({
        ...base,
        kind,
        preference_key: requireString(raw.preference_key, 'PreferenceMemory.preference_key'),
        value_text: requireString(raw.value_text, 'PreferenceMemory.value_text'),
      });
    case 'template_experience': {
      const templateId = requireString(raw.template_id, 'TemplateExperienceMemory.template_id') as TemplateId;
      if (base.scope.template_id !== templateId) {
        throw new ValidationError(
          `TemplateExperienceMemory.template_id (${templateId}) 与 scope.template_id ` +
            `(${String(base.scope.template_id)}) 不一致：两处必须指同一模板`,
        );
      }
      return Object.freeze({
        ...base,
        kind,
        template_id: templateId,
        lesson: requireString(raw.lesson, 'TemplateExperienceMemory.lesson'),
        applies_to_version: requireString(raw.applies_to_version, 'TemplateExperienceMemory.applies_to_version'),
      });
    }
  }
}

/** 形状自检（供从快照反序列化的条目复核）。 */
export function assertMemoryEntryInvariants(entry: MemoryEntry): void {
  createMemoryEntry(entry);
}

// ---------------------------------------------------------------------------
// 派生条目与检索上限
// ---------------------------------------------------------------------------

/** 派生条目：索引 / 摘要 / 缓存 / 派生经验。任一来源被删除 / 忘记时**必须联动失效**（R238）。 */
export interface DerivedRecord {
  readonly derived_id: DerivedId;
  readonly owner_id: OwnerId;
  readonly kind: DerivedKind;
  /** 本派生条目由哪些记忆条目派生而来（联动失效的判据）。 */
  readonly derived_from: readonly MemoryId[];
  readonly invalidated: boolean;
}

/** 检索上限（R237：检索注入**有长度与数量上限**）。 */
export interface MemoryQueryLimits {
  readonly max_items: number;
  readonly max_chars: number;
}

export const DEFAULT_MEMORY_LIMITS: MemoryQueryLimits = Object.freeze({
  max_items: 20,
  max_chars: 4000,
});

/** 校验检索上限（非正整数一律拒——"没有上限"不是本层的选项）。 */
export function requireMemoryQueryLimits(raw: unknown, field = 'MemoryQueryLimits'): MemoryQueryLimits {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`${field} 必须是对象，收到 ${describe(raw)}`);
  }
  const maxItems = raw.max_items;
  const maxChars = raw.max_chars;
  if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems <= 0) {
    throw new ValidationError(`${field}.max_items 必须是正整数（检索必须有数量上限，R237）`);
  }
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars <= 0) {
    throw new ValidationError(`${field}.max_chars 必须是正整数（检索必须有长度上限，R237）`);
  }
  return Object.freeze({ max_items: maxItems, max_chars: maxChars });
}
