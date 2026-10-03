/**
 * F07 memory —— 检索结论 → **诚实的**视图态（I1；内核 R240）。
 *
 * 内核 `recall()` 的结论是**四值**：`found` / `not_found` / `uncertain` / `failed`。
 * 其中「查不到」「状态不可信」「读取失败」三种都返回空 entries，但含义**完全不同**：
 *
 *   - `not_found`  —— 真的没有匹配的记忆：空态（可以显示「暂无相关记忆」）。
 *   - `uncertain`  —— 完整性探针说状态不可信：**不能**显示成「没有记忆」，
 *                     必须显式提示「记忆状态待确认」。
 *   - `failed`     —— 读取失败：必须显式提示失败，不得留白。
 *
 * 把 `uncertain` / `failed` 折叠成空态，就是「把查不到当成没有」——正是内核 R240 禁止的编造。
 * 本模块把四值映射成四个互不相同的视图态，且**只有 `found` 产出列表行**。
 */

import {
  MemoryViewModelError,
  type MemoryEntryView,
  type MemoryRow,
} from './types.js';
import { toMemoryRows } from './rows.js';

/** 内核检索结论（与 `src/memory/repository.ts` 的 `MemoryRecallStatus` 逐字对齐）。 */
export const MEMORY_RECALL_STATUSES = ['found', 'not_found', 'uncertain', 'failed'] as const;
export type MemoryRecallStatus = (typeof MEMORY_RECALL_STATUSES)[number];

/** 检索结论的序列化视图（由桥 / 内核适配而来）。 */
export interface MemoryRecallView {
  readonly status: MemoryRecallStatus;
  readonly entries: readonly MemoryEntryView[];
  /** 命中总条数（未截断前）。 */
  readonly totalMatched?: number;
  readonly truncated?: boolean;
  /** 内核给出的原因说明（非 `found` 或截断时）。 */
  readonly detail?: string | null;
}

/**
 * 视图态：与内核四值**一一对应**，绝不合并。
 *   - `results`  —— 有结果（`found` 且非空）
 *   - `empty`    —— 真的为空（`found` 且 0 条，或 `not_found`）
 *   - `unknown`  —— 状态待确认（`uncertain`）
 *   - `failed`   —— 读取失败（`failed`）
 */
export type MemoryRecallViewState = 'results' | 'empty' | 'unknown' | 'failed';

export interface MemoryRecallPresentation {
  readonly state: MemoryRecallViewState;
  /** 仅 `results` 非空；其余恒为空数组。 */
  readonly rows: readonly MemoryRow[];
  readonly totalMatched: number;
  readonly truncated: boolean;
  /** 面向用户的诚实提示（**永不为空**）。 */
  readonly notice: string;
  /** 内核给的原始原因（若有）。 */
  readonly detail: string | null;
}

function requireRecallStatus(value: unknown): MemoryRecallStatus {
  if (
    typeof value !== 'string' ||
    !(MEMORY_RECALL_STATUSES as readonly string[]).includes(value)
  ) {
    throw new MemoryViewModelError(
      'invalid-query',
      `检索结论必须是 ${MEMORY_RECALL_STATUSES.join(' | ')} 之一`,
      { value: value === undefined ? null : String(value) },
    );
  }
  return value as MemoryRecallStatus;
}

/**
 * 把内核检索结论投影成视图态。
 *
 * fail-closed 规则：
 * - `uncertain` / `failed` **抛/忽略**任何随附 entries（即使有也不显示）——结论不可信时，
 *   条目一并不可信，绝不拿它当「部分结果」填充。
 * - `not_found` / `uncertain` / `failed` 的 `totalMatched` 一律按 0 处理（内核语义）。
 */
export function describeRecall(recall: MemoryRecallView): MemoryRecallPresentation {
  if (typeof recall !== 'object' || recall === null) {
    throw new MemoryViewModelError('invalid-query', '检索结果必须是对象');
  }
  const status = requireRecallStatus(recall.status);
  const detail = recall.detail ?? null;

  if (status === 'failed') {
    return Object.freeze({
      state: 'failed',
      rows: Object.freeze([]) as readonly MemoryRow[],
      totalMatched: 0,
      truncated: false,
      notice: `记忆读取失败${detail ? `：${detail}` : ''}——这不代表「没有记忆」，请重试`,
      detail,
    });
  }

  if (status === 'uncertain') {
    return Object.freeze({
      state: 'unknown',
      rows: Object.freeze([]) as readonly MemoryRow[],
      totalMatched: 0,
      truncated: false,
      notice: `记忆状态待确认${detail ? `：${detail}` : ''}——不可当作「没有记忆」`,
      detail,
    });
  }

  if (status === 'not_found') {
    return Object.freeze({
      state: 'empty',
      rows: Object.freeze([]) as readonly MemoryRow[],
      totalMatched: 0,
      truncated: false,
      notice: `没有匹配的记忆${detail ? `（${detail}）` : ''}`,
      detail,
    });
  }

  // status === 'found'
  if (!Array.isArray(recall.entries)) {
    throw new MemoryViewModelError('invalid-query', 'found 结论必须带 entries 数组');
  }
  const rows = toMemoryRows(recall.entries);
  const totalMatched = recall.totalMatched ?? rows.length;
  const truncated = recall.truncated ?? false;

  if (rows.length === 0) {
    return Object.freeze({
      state: 'empty',
      rows: Object.freeze([]) as readonly MemoryRow[],
      totalMatched: 0,
      truncated: false,
      notice: `没有匹配的记忆${detail ? `（${detail}）` : ''}`,
      detail,
    });
  }

  const notice = truncated
    ? `显示前 ${rows.length} 条（共 ${totalMatched} 条，已截断${detail ? `；${detail}` : ''}）`
    : `共 ${rows.length} 条相关记忆`;

  return Object.freeze({
    state: 'results',
    rows,
    totalMatched,
    truncated,
    notice,
    detail,
  });
}

/**
 * 是否允许把当前视图态解读为「确实没有记忆」。**只有 `empty` 为真**——
 * `unknown` / `failed` 都不算。这条断言是「失败不假报」的直接闸门。
 */
export function isEmptyIsTrustworthy(presentation: MemoryRecallPresentation): boolean {
  return presentation.state === 'empty';
}
