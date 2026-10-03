/**
 * F07 memory —— 条目 → 列表行投影、筛选与排序（I2）。
 *
 * 列表行把「用户要看的四件事」一次带齐：**来源 · 范围 · 确认态 · 版本**（外加状态与正文）。
 * 来源详情为空直接在**构造期**被拒（`requireSourceView`）——渲染层不会遇到「来源留白」，
 * 也就不需要临时编一个来源来填空。
 *
 * 排序是**确定性**的：先按 `updatedAt` 降序，再按 `memoryId` 升序打破平局；同输入必得同序
 * （测试可逐项比较），不依赖 Map 迭代顺序或时钟。
 */

import {
  MemoryViewModelError,
  confirmationLabel,
  kindLabel,
  requireBody,
  requireConfirmation,
  requireId,
  requireKind,
  requireLogicalTime,
  requireScopeView,
  requireSourceView,
  requireStatus,
  requireVersion,
  scopeLabel,
  sourceLabel,
  statusLabel,
  type ConfirmationState,
  type MemoryEntryView,
  type MemoryKind,
  type MemoryRow,
  type MemoryScopeKind,
  type MemoryStatus,
} from './types.js';

/**
 * 把内核条目视图投影成列表行。
 *
 * 构造期校验（违反即抛，绝不「先显示后补证据」）：
 * - `kind` 与 `scope` 必须匹配（内核 R235）；
 * - `source.detail` 非空（来源不可留白，I2）；
 * - `body` 非空、`version >= 1`、`createdAt` 有限。
 */
export function toMemoryRow(entry: MemoryEntryView): MemoryRow {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new MemoryViewModelError('invalid-kind', '记忆条目必须是对象');
  }
  const kind = requireKind(entry.kind);
  const scope = requireScopeView(entry.scope, kind);
  const source = requireSourceView(entry.source);
  const confirmation = requireConfirmation(entry.confirmation);
  const status = requireStatus(entry.status);
  const version = requireVersion(entry.version);
  const createdAt = requireLogicalTime(entry.createdAt, 'createdAt');
  const updatedAt =
    entry.updatedAt === undefined ? createdAt : requireLogicalTime(entry.updatedAt, 'updatedAt');
  const memoryId = requireId(entry.memoryId, 'memoryId', 'invalid-memory-id');
  const ownerId = requireId(entry.ownerId, 'ownerId', 'invalid-owner-id');
  const body = requireBody(entry.body);

  if (updatedAt < createdAt) {
    throw new MemoryViewModelError('invalid-logical-time', 'updatedAt 不得早于 createdAt', {
      memoryId,
    });
  }

  // 范围标识与条目级标识一致时才算自洽（task_fact / template_experience 两处必须同指）。
  if (kind === 'task_fact' && entry.taskId !== undefined && entry.taskId !== scope.taskId) {
    throw new MemoryViewModelError('invalid-scope', 'task_fact 的 taskId 与 scope.taskId 不一致', {
      memoryId,
    });
  }
  if (
    kind === 'template_experience' &&
    entry.templateId !== undefined &&
    entry.templateId !== scope.templateId
  ) {
    throw new MemoryViewModelError(
      'invalid-scope',
      'template_experience 的 templateId 与 scope.templateId 不一致',
      { memoryId },
    );
  }

  return Object.freeze({
    memoryId,
    ownerId,
    kind,
    scope,
    source,
    confirmation,
    status,
    version,
    createdAt,
    updatedAt,
    body,
    scopeLabel: scopeLabel(scope),
    kindLabel: kindLabel(kind),
    sourceLabel: sourceLabel(source.kind),
    confirmationLabel: confirmationLabel(confirmation),
    statusLabel: statusLabel(status),
  });
}

export function toMemoryRows(entries: readonly MemoryEntryView[]): readonly MemoryRow[] {
  return Object.freeze(entries.map(toMemoryRow));
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

export interface MemoryListFilter {
  readonly ownerId?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly scopeKind?: MemoryScopeKind;
  readonly statuses?: readonly MemoryStatus[];
  readonly confirmation?: ConfirmationState;
  /** 对正文（及来源详情）做大小写不敏感的子串匹配。 */
  readonly text?: string;
}

/** 按筛选条件过滤（不排序）。空 `kinds`/`statuses` 数组表示「什么都不匹配」，不是「全都匹配」。 */
export function filterMemoryRows(
  rows: readonly MemoryRow[],
  filter: MemoryListFilter = {},
): readonly MemoryRow[] {
  const text = filter.text?.toLowerCase();
  return Object.freeze(
    rows.filter((row) => {
      if (filter.ownerId !== undefined && row.ownerId !== filter.ownerId) return false;
      if (filter.kinds !== undefined && !filter.kinds.includes(row.kind)) return false;
      if (filter.scopeKind !== undefined && row.scope.kind !== filter.scopeKind) return false;
      if (filter.statuses !== undefined && !filter.statuses.includes(row.status)) return false;
      if (filter.confirmation !== undefined && row.confirmation !== filter.confirmation) return false;
      if (text !== undefined && text !== '') {
        const haystack = `${row.body}\n${row.source.detail}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    }),
  );
}

/** 确定性排序：updatedAt 降序 → memoryId 升序。返回新数组。 */
export function sortMemoryRows(rows: readonly MemoryRow[]): readonly MemoryRow[] {
  return Object.freeze(
    [...rows].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
    }),
  );
}

/** 筛选 + 排序一步到位。 */
export function listMemoryRows(
  rows: readonly MemoryRow[],
  filter: MemoryListFilter = {},
): readonly MemoryRow[] {
  return sortMemoryRows(filterMemoryRows(rows, filter));
}

/**
 * 「可注入」判定：停用 / 已否定 / 已删除的记忆**不再进入检索注入**，列表仍可见（可审计）。
 * 只用于 UI 标注「这条不会进模型上下文」，不代表可删除。
 */
export function isInjectable(row: MemoryRow): boolean {
  return row.status === 'active' && row.confirmation !== 'rejected';
}
