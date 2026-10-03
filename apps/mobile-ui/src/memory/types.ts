/**
 * F07 memory —— 记忆浏览视图模型的类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包是**记忆浏览视图模型**：把内核记忆域（`src/memory`）给出的**序列化条目 / 检索结论 /
 * 遗忘进度事件**，投影成可断言的列表状态与纯函数。内核侧的形状以 `src/memory/types.ts`
 * 与 `src/memory/repository.ts` 为准（四类记忆、四种检索结论、联动失效、失败不编造 R234–R240）；
 * 本包**只读消费**该形状，**不复制**内核的存储与检索实现。
 *
 * 本包只产出**可断言的视图状态与纯函数**：不渲染、不引框架、不发网络请求、不读文件字节、
 * 不持久化、不碰 `KernelClient`。时间沿用内核的 `LogicalTime`（有限数，逻辑时钟）——
 * 本包**不把它换算成墙钟**（那会是编造时间）。
 *
 * 核心不变量（由 `tests/mobile-ui/F07/` 机器化断言）：
 *   I1 检索结论**四值不可合并**：`found` / `not_found` / `uncertain` / `failed` 必须映射到
 *      四个**不同**的视图态。只有 `found` 允许产出列表行；`uncertain`（状态不可信）与
 *      `failed`（读取失败）**绝不**能显示成「没有记忆」，也不得用占位行填充（内核 R240）。
 *   I2 每条记忆的**来源 · 范围 · 确认态 · 版本**都要可见：缺来源详情不得留白，须显式标「未知」。
 *   I3 编辑走**乐观并发**：必须带 `expectedVersion`，与服务端版本不符 ⇒ `stale-version`（冲突），
 *      不做静默覆盖。
 *   I4 **身份字段不可改**：`kind` / `scope` / `source` / `ownerId` 不允许出现在编辑补丁里
 *      （否则等于把「本次任务条件」改写成「全局偏好」——内核 R235 明令禁止的那条）。
 *   I5 **停用 ≠ 忘记**：停用保留内容、只是不再进入注入；忘记是终态移除。两者是不同动作、不同状态。
 *   I6 **忘记只在拿到内核凭据后才算完成**：`confirmed` 必须带内核回执引用（`evidenceRef`）；
 *      没有凭据的「完成」被拒（`missing-evidence`）。失败 / 取消 **绝不**显示为已忘记，
 *      且**不**据此从列表移除任何行（`shouldRemoveRows` 恒false）——失败不假报忘记。
 *   I7 **遗忘影响提示来自内核**：影响条数 / 联动失效的派生条目**只能**来自内核产物；
 *      内核没给 ⇒ 显式「影响未知」，**绝不自造数字**。
 *   I8 遗忘进度**单调不减且不越界**：已处理数只能上升，且不超过内核给出的总数（若给出）；
 *      进入终态后不再接受事件（`job-terminal`）。
 */

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type MemoryViewModelErrorCode =
  | 'invalid-memory-id'
  | 'invalid-owner-id'
  | 'invalid-kind'
  | 'invalid-scope'
  | 'invalid-source'
  | 'invalid-confirmation'
  | 'invalid-status'
  | 'invalid-body'
  | 'invalid-version'
  | 'invalid-logical-time'
  | 'invalid-query'
  | 'missing-expected-version'
  | 'stale-version'
  | 'unsupported-patch'
  | 'empty-patch'
  | 'not-editable'
  | 'already-disabled'
  | 'invalid-forget-scope'
  | 'job-terminal'
  | 'non-monotonic-progress'
  | 'progress-overflow'
  | 'missing-evidence'
  | 'invalid-event';

/**
 * 视图模型的结构化错误：只带 code + 可读 message + 脱敏 details，
 * 不含密钥 / 请求体 / 本地绝对路径 / 记忆正文（details 里回忆正文一律截断或不放）。
 * 测试按 `code` 断言，避免只匹配文案。
 */
export class MemoryViewModelError extends Error {
  readonly code: MemoryViewModelErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: MemoryViewModelErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MemoryViewModelError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 封闭枚举（与内核 `src/memory/types.ts` 逐字对齐；本包自带一份以免把内核源码拉进 UI 构建）
// ---------------------------------------------------------------------------

/** 四类记忆（内核 R234）。 */
export const MEMORY_KINDS = [
  'session_message',
  'task_fact',
  'preference',
  'template_experience',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 记忆范围（内核 R235）。 */
export const MEMORY_SCOPE_KINDS = ['user', 'task', 'template'] as const;
export type MemoryScopeKind = (typeof MEMORY_SCOPE_KINDS)[number];

/** 确认 / 可信状态（`rejected` 是一等值：被否定的记忆留在库里可审计，但不可用）。 */
export const CONFIRMATION_STATES = ['unconfirmed', 'confirmed', 'rejected'] as const;
export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

/** 记忆来源种类（内核 R235）。 */
export const MEMORY_SOURCE_KINDS = [
  'user_statement',
  'user_confirmation',
  'document',
  'tool_result',
  'inference',
  'external',
] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** 记忆状态。`deleted` 是软删除（保留审计），`forget` 是硬忘记。 */
export const MEMORY_STATUSES = ['active', 'disabled', 'deleted'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 各类记忆**允许**的范围（内核 R235 的结构化强制；UI 侧同样拒绝不一致的输入）。 */
export const ALLOWED_SCOPE_BY_KIND: Readonly<Record<MemoryKind, MemoryScopeKind>> = Object.freeze({
  session_message: 'user',
  task_fact: 'task',
  preference: 'user',
  template_experience: 'template',
});

// ---------------------------------------------------------------------------
// 输入：内核条目的**序列化视图**（由内核 / 桥适配而来的普通数据）
// ---------------------------------------------------------------------------

export interface MemoryScopeView {
  readonly kind: MemoryScopeKind;
  readonly taskId: string | null;
  readonly templateId: string | null;
}

export interface MemorySourceView {
  readonly kind: MemorySourceKind;
  readonly detail: string;
}

/**
 * 内核记忆条目的序列化视图（四类共用一个普通对象）。
 * 具体的 kind 专属字段（会话 / 任务 / 偏好 / 模板经验）以可选字段承载；
 * `body` 是面向用户的可读正文（会话正文 / 事实值 / 偏好值 / 经验教训），由调用方给出。
 */
export interface MemoryEntryView {
  readonly memoryId: string;
  readonly ownerId: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScopeView;
  readonly source: MemorySourceView;
  readonly confirmation: ConfirmationState;
  readonly status: MemoryStatus;
  readonly version: number;
  /** 内核 `LogicalTime`（有限数）；本包不换算成墙钟。 */
  readonly createdAt: number;
  readonly updatedAt?: number;
  /** 面向用户的可读正文（非空）。 */
  readonly body: string;
  // kind 专属标识（可选；用于详情与遗忘范围预览）
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly templateId?: string;
  readonly factKey?: string;
  readonly preferenceKey?: string;
  readonly appliesToVersion?: string;
}

// ---------------------------------------------------------------------------
// 输出：列表行
// ---------------------------------------------------------------------------

/** 记忆列表行：详情所需的一切都在这里，渲染层无需再回内核（除查看原文之外）。 */
export interface MemoryRow {
  readonly memoryId: string;
  readonly ownerId: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScopeView;
  readonly source: MemorySourceView;
  readonly confirmation: ConfirmationState;
  readonly status: MemoryStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly body: string;
  /** 范围标签（用户视角）：用户 / 任务:<id> / 模板:<id>。 */
  readonly scopeLabel: string;
  readonly kindLabel: string;
  readonly sourceLabel: string;
  readonly confirmationLabel: string;
  readonly statusLabel: string;
}

// ---------------------------------------------------------------------------
// 校验工具（fail-closed：不给默认值，不猜）
// ---------------------------------------------------------------------------

const KINDS = MEMORY_KINDS;
const SCOPES = MEMORY_SCOPE_KINDS;
const CONFIRMATIONS = CONFIRMATION_STATES;
const SOURCES = MEMORY_SOURCE_KINDS;
const STATUSES = MEMORY_STATUSES;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

/** 非空且不含空白的标识串。 */
export function requireId(value: unknown, field: string, code: MemoryViewModelErrorCode): string {
  if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value)) {
    throw new MemoryViewModelError(code, `${field} 必须是非空且不含空白的字符串`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

export function requireKind(value: unknown): MemoryKind {
  if (typeof value !== 'string' || !(KINDS as readonly string[]).includes(value)) {
    throw new MemoryViewModelError('invalid-kind', `kind 必须是 ${KINDS.join(' | ')} 之一`, {
      value: describe(value),
    });
  }
  return value as MemoryKind;
}

export function requireConfirmation(value: unknown): ConfirmationState {
  if (typeof value !== 'string' || !(CONFIRMATIONS as readonly string[]).includes(value)) {
    throw new MemoryViewModelError(
      'invalid-confirmation',
      `confirmation 必须是 ${CONFIRMATIONS.join(' | ')} 之一`,
      { value: describe(value) },
    );
  }
  return value as ConfirmationState;
}

export function requireSourceKind(value: unknown): MemorySourceKind {
  if (typeof value !== 'string' || !(SOURCES as readonly string[]).includes(value)) {
    throw new MemoryViewModelError('invalid-source', `source.kind 必须是 ${SOURCES.join(' | ')} 之一`, {
      value: describe(value),
    });
  }
  return value as MemorySourceKind;
}

export function requireStatus(value: unknown): MemoryStatus {
  if (typeof value !== 'string' || !(STATUSES as readonly string[]).includes(value)) {
    throw new MemoryViewModelError('invalid-status', `status 必须是 ${STATUSES.join(' | ')} 之一`, {
      value: describe(value),
    });
  }
  return value as MemoryStatus;
}

/** 版本号：>= 1 的整数（与内核 `Revision` 语义一致，条目版本从 1 起）。 */
export function requireVersion(value: unknown, field = 'version'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new MemoryViewModelError('invalid-version', `${field} 必须是 >= 1 的整数`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

/** 逻辑时间：有限数（内核 `LogicalTime`）；不换算墙钟。 */
export function requireLogicalTime(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MemoryViewModelError('invalid-logical-time', `${field} 必须是有限数（逻辑时间）`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

export function requireBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryViewModelError('invalid-body', 'body 必须是非空字符串');
  }
  return value;
}

/**
 * 校验范围与种类的**一致性**（内核 R235：四类记忆分属不同范围）。
 * 违反即拒——这样「任务事实被当成全局偏好」在视图层也写不出来。
 */
export function requireScopeView(value: unknown, kind: MemoryKind): MemoryScopeView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryViewModelError('invalid-scope', `scope 必须是对象，收到 ${describe(value)}`);
  }
  const raw = value as { kind?: unknown; taskId?: unknown; templateId?: unknown };
  if (typeof raw.kind !== 'string' || !(SCOPES as readonly string[]).includes(raw.kind)) {
    throw new MemoryViewModelError('invalid-scope', `scope.kind 必须是 ${SCOPES.join(' | ')} 之一`, {
      value: describe(raw.kind),
    });
  }
  const scopeKind = raw.kind as MemoryScopeKind;
  const expected = ALLOWED_SCOPE_BY_KIND[kind];
  if (scopeKind !== expected) {
    throw new MemoryViewModelError(
      'invalid-scope',
      `记忆种类 ${kind} 的范围必须是 ${expected}，收到 ${scopeKind}：` +
        '四类记忆分属不同范围，任务条件不得成为全局偏好（内核 R235）',
      { kind, scopeKind, expected },
    );
  }
  const taskId = raw.taskId === null || raw.taskId === undefined ? null : String(raw.taskId);
  const templateId = raw.templateId === null || raw.templateId === undefined ? null : String(raw.templateId);
  if (scopeKind === 'task' && (taskId === null || taskId.trim() === '')) {
    throw new MemoryViewModelError('invalid-scope', '任务范围的记忆必须给出 taskId');
  }
  if (scopeKind === 'template' && (templateId === null || templateId.trim() === '')) {
    throw new MemoryViewModelError('invalid-scope', '模板范围的记忆必须给出 templateId');
  }
  if (scopeKind !== 'task' && taskId !== null) {
    throw new MemoryViewModelError('invalid-scope', `范围 ${scopeKind} 的记忆不得携带 taskId`);
  }
  if (scopeKind !== 'template' && templateId !== null) {
    throw new MemoryViewModelError('invalid-scope', `范围 ${scopeKind} 的记忆不得携带 templateId`);
  }
  return Object.freeze({ kind: scopeKind, taskId, templateId });
}

export function requireSourceView(value: unknown): MemorySourceView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryViewModelError('invalid-source', `source 必须是对象，收到 ${describe(value)}`);
  }
  const raw = value as { kind?: unknown; detail?: unknown };
  const kind = requireSourceKind(raw.kind);
  // 来源详情必须可见：空详情是「编造/留白」，直接拒（I2）。
  if (typeof raw.detail !== 'string' || raw.detail.trim() === '') {
    throw new MemoryViewModelError('invalid-source', 'source.detail 必须是非空字符串（来源不可留白，I2）');
  }
  return Object.freeze({ kind, detail: raw.detail.trim() });
}

// ---------------------------------------------------------------------------
// 标签（用户视角的中文标签；纯映射，无业务判断）
// ---------------------------------------------------------------------------

const KIND_LABELS: Readonly<Record<MemoryKind, string>> = Object.freeze({
  session_message: '会话消息',
  task_fact: '任务事实',
  preference: '用户偏好',
  template_experience: '模板经验',
});

const SOURCE_LABELS: Readonly<Record<MemorySourceKind, string>> = Object.freeze({
  user_statement: '用户陈述',
  user_confirmation: '用户确认',
  document: '文档',
  tool_result: '工具结果',
  inference: '系统推断',
  external: '外部内容',
});

const CONFIRMATION_LABELS: Readonly<Record<ConfirmationState, string>> = Object.freeze({
  unconfirmed: '未确认',
  confirmed: '已确认',
  rejected: '已否定',
});

const STATUS_LABELS: Readonly<Record<MemoryStatus, string>> = Object.freeze({
  active: '生效中',
  disabled: '已停用',
  deleted: '已删除',
});

export function kindLabel(kind: MemoryKind): string {
  return KIND_LABELS[kind];
}

export function sourceLabel(kind: MemorySourceKind): string {
  return SOURCE_LABELS[kind];
}

export function confirmationLabel(state: ConfirmationState): string {
  return CONFIRMATION_LABELS[state];
}

export function statusLabel(status: MemoryStatus): string {
  return STATUS_LABELS[status];
}

/** 范围标签：`user` → 「用户」；`task` → 「任务:<id>」；`template` → 「模板:<id>」。 */
export function scopeLabel(scope: MemoryScopeView): string {
  switch (scope.kind) {
    case 'user':
      return '用户';
    case 'task':
      return `任务:${scope.taskId ?? '?'}`;
    case 'template':
      return `模板:${scope.templateId ?? '?'}`;
  }
}
