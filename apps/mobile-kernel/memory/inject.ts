/**
 * K08 手机记忆线 —— **检索注入 + 会话 / 作用域隔离审计**。
 *
 * ## 在 `src/memory` 现有注入之上补的那一格：**会话窗口**
 *
 * `src/memory/recall-limits.ts` 的 `buildInstanceRecallInjection()` 已经做到
 * 「有上限 + 主体隔离 + 任务/模板范围隔离 + 审计」。本文件补的是 K08 明令的
 * **跨会话隔离**：短期记忆（`session_message`）必须锁在**本次会话**里，
 * 别的会话的消息**不得**被注入到当前上下文。
 *
 * | 记忆种类 | 会话过滤 | 说明 |
 * | --- | --- | --- |
 * | `session_message` | **按 `conversation_id` 过滤** | 短期；只有本会话的消息能进注入 |
 * | `task_fact` | 不走会话过滤，走任务范围 | 短期；由 `task_id` 收窄 |
 * | `preference` / `template_experience` | 不理会话 | 长期；跨会话保留 |
 *
 * 未给 `session_id` 时**不做会话过滤**，但审计里 `session_scoped: false` 如实标注——
 * 不假装已经隔离。
 *
 * ## R240：非 `found` 摘要为空，审计照给
 *
 * 查不到 / 失败时 `digest` 为空串，**绝不**用占位文本填充；隔离审计仍如实给出。
 *
 * 纯函数 + 注入仓库：零 IO、不含墙钟、不含随机数。
 */

import { ValidationError, type TaskId, type TemplateId } from '../../../src/protocol/index.js';
import {
  DEFAULT_MEMORY_LIMITS,
  entryText,
  INJECTION_CEILINGS,
  MEMORY_KINDS,
  resolveInstanceLimits,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryQueryLimits,
  type MemoryRecallStatus,
  type MemoryRepository,
  type OwnerId,
} from '../../../src/memory/index.js';

/** 会话窗口检索请求。 */
export interface SessionRecallRequest {
  /** **隔离键（必填）**：只可能取到该主体的记忆（R237）。 */
  readonly owner_id: OwnerId;
  /** 实例身份（仅用于审计与追溯，不改变隔离）。 */
  readonly instance_id: string;
  /** 本次会话 id：给定时，短期 `session_message` 按它过滤（跨会话隔离）。 */
  readonly session_id?: string;
  readonly task_id?: TaskId;
  readonly template_id?: TemplateId;
  readonly kinds?: readonly MemoryKind[];
  readonly text?: string;
  readonly requested_limits?: MemoryQueryLimits;
  readonly include_rejected?: boolean;
}

/** 会话 / 作用域隔离审计（把"排除了什么"变成可读数字）。 */
export interface SessionIsolationAudit {
  readonly owner_id: OwnerId;
  /** 库中属于**其他主体**、且命中同一条件的条目数（被排除，不得注入）。 */
  readonly foreign_excluded: number;
  /** 库中属于本主体、是会话消息、但**属于别的会话**的条目数（被排除）——跨会话隔离的证据。 */
  readonly other_session_excluded: number;
  /** 库中属于本主体、但**不在本次任务 / 模板范围**内的条目数（被排除）。 */
  readonly out_of_scope_excluded: number;
  /** 本主体在本次条件下**可见**的条目总数（未截断前）。 */
  readonly owner_visible_total: number;
  /** 实际注入的条数。 */
  readonly injected: number;
  /** 本次是否启用了会话过滤（`session_id` 给了才为 `true`）。 */
  readonly session_scoped: boolean;
}

/** 会话窗口注入的产出。 */
export interface SessionInjection {
  readonly instance_id: string;
  readonly status: MemoryRecallStatus;
  /** 注入文本；非 `found` 时为**空串**（不编造，R240）。 */
  readonly digest: string;
  readonly included_ids: readonly MemoryId[];
  readonly truncated: boolean;
  readonly limits: MemoryQueryLimits;
  readonly ceiling: MemoryQueryLimits;
  readonly audit: SessionIsolationAudit;
  readonly detail: string | null;
}

function matchesKind(entry: MemoryEntry, kinds: readonly MemoryKind[] | undefined): boolean {
  return kinds === undefined || kinds.includes(entry.kind);
}

function matchesText(entry: MemoryEntry, text: string | undefined): boolean {
  return text === undefined || entryText(entry).includes(text);
}

/** 该条目是否被本次会话窗口挡下（仅对 `session_message` 生效）。 */
function excludedBySession(entry: MemoryEntry, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false;
  if (entry.kind !== 'session_message') return false;
  return entry.conversation_id !== sessionId;
}

function excludedByScope(
  entry: MemoryEntry,
  taskId: TaskId | undefined,
  templateId: TemplateId | undefined,
): boolean {
  if (taskId !== undefined && entry.scope.task_id !== taskId) return true;
  if (templateId !== undefined && entry.scope.template_id !== templateId) return true;
  return false;
}

/** 排序：`updated_at` 降序，同刻按 id 升序（确定性，与仓库一致）。 */
function byRecency(left: MemoryEntry, right: MemoryEntry): number {
  if (left.updated_at !== right.updated_at) return right.updated_at - left.updated_at;
  return left.memory_id < right.memory_id ? -1 : left.memory_id > right.memory_id ? 1 : 0;
}

/** 只读扫描：统计被主体 / 会话 / 范围三道闸挡下的条目（**不改库**）。 */
export function auditSessionIsolation(
  repository: MemoryRepository,
  request: SessionRecallRequest,
): Omit<SessionIsolationAudit, 'injected'> {
  let foreign = 0;
  let otherSession = 0;
  let outOfScope = 0;
  let visible = 0;

  for (const kind of MEMORY_KINDS) {
    for (const entry of repository.listByKind(kind)) {
      if (!matchesKind(entry, request.kinds) || !matchesText(entry, request.text)) continue;
      if (entry.owner_id !== request.owner_id) {
        foreign += 1;
        continue;
      }
      if (excludedBySession(entry, request.session_id)) {
        otherSession += 1;
        continue;
      }
      if (excludedByScope(entry, request.task_id, request.template_id)) {
        outOfScope += 1;
        continue;
      }
      if (entry.status !== 'active') continue;
      if (!request.include_rejected && entry.confirmation === 'rejected') continue;
      visible += 1;
    }
  }

  return {
    owner_id: request.owner_id,
    foreign_excluded: foreign,
    other_session_excluded: otherSession,
    out_of_scope_excluded: outOfScope,
    owner_visible_total: visible,
    session_scoped: request.session_id !== undefined,
  };
}

/**
 * 构造一次会话窗口注入（**有上限 + 主体/会话/范围三重隔离 + 审计**）。
 *
 * @throws {ValidationError} 申请的上限非法或越过天花板（`resolveInstanceLimits`）；
 *   或注入条数**越过本次声明的上限**（上限未生效 ⇒ 抛，不静默返回）。
 */
export function buildSessionInjection(
  repository: MemoryRepository,
  request: SessionRecallRequest,
): SessionInjection {
  const limits = resolveInstanceLimits(request.requested_limits ?? DEFAULT_MEMORY_LIMITS);
  const auditBase = auditSessionIsolation(repository, request);

  // 候选池：用天花板上限取足够宽的池，再在内存里做会话过滤（仓库的 recall 不认会话维度）。
  const pool = repository.recall(
    {
      owner_id: request.owner_id,
      kinds: request.kinds,
      task_id: request.task_id,
      template_id: request.template_id,
      text: request.text,
      include_rejected: request.include_rejected,
    },
    INJECTION_CEILINGS,
  );

  const scoped = pool.entries
    .filter((entry) => !excludedBySession(entry, request.session_id))
    .slice()
    .sort(byRecency);

  const included: MemoryEntry[] = [];
  let usedChars = 0;
  let truncated = false;
  for (const entry of scoped) {
    if (included.length >= limits.max_items) {
      truncated = true;
      break;
    }
    const length = entryText(entry).length;
    if (usedChars + length > limits.max_chars) {
      truncated = true;
      break;
    }
    included.push(entry);
    usedChars += length;
  }

  if (included.length > limits.max_items) {
    throw new ValidationError(
      `会话注入越过本次声明的上限（注入 ${String(included.length)} 条 > 上限 ${String(
        limits.max_items,
      )} 条）：上限未生效，疑似整份历史复制，违反 R237`,
    );
  }

  const audit: SessionIsolationAudit = Object.freeze({
    ...auditBase,
    injected: included.length,
  });

  if (scoped.length === 0) {
    return Object.freeze({
      instance_id: request.instance_id,
      status: 'not_found',
      digest: '',
      included_ids: Object.freeze([]),
      truncated: false,
      limits,
      ceiling: INJECTION_CEILINGS,
      audit,
      detail: '本会话内没有匹配的记忆条目（查不到就是查不到，不得编造"已经记住"，R240）',
    });
  }

  const digest = included.map((entry) => `- [${entry.kind}] ${entryText(entry)}`).join('\n');
  return Object.freeze({
    instance_id: request.instance_id,
    status: 'found',
    digest,
    included_ids: Object.freeze(included.map((entry) => entry.memory_id)),
    truncated,
    limits,
    ceiling: INJECTION_CEILINGS,
    audit,
    detail: truncated
      ? `本会话命中共 ${String(scoped.length)} 条，受上限（最多 ${String(limits.max_items)} 条 / ` +
        `${String(limits.max_chars)} 字符）截断，实际注入 ${String(included.length)} 条`
      : null,
  });
}

/** 一行预算/隔离说明（供日志与决策气泡引用）。 */
export function describeSessionInjection(injection: SessionInjection): string {
  const audit = injection.audit;
  return (
    `实例 ${injection.instance_id} 注入 ${String(audit.injected)} / 可见 ${String(
      audit.owner_visible_total,
    )} 条（会话隔离 ${audit.session_scoped ? '开' : '关'}）；` +
    `排除他主体 ${String(audit.foreign_excluded)} 条、他会话 ${String(
      audit.other_session_excluded,
    )} 条、越范围 ${String(audit.out_of_scope_excluded)} 条`
  );
}
