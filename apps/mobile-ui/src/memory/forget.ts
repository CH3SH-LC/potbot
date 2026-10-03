/**
 * F07 memory —— 遗忘范围、进度与影响提示（I6 / I7 / I8）。
 *
 * 遗忘（forget）是**终态移除**：一旦确认，条目不再存在（内核写墓碑，恢复不复活）。
 * 正因为不可逆，UI 侧的两件事必须绝对诚实：
 *
 * ## I6 完成需要内核凭据，失败不假报忘记
 *
 * 「已忘记」只能来自内核明确回的 `confirmed` 事件，且该事件**必须携带回执引用**
 * （`evidenceRef`）——UI 自己不能把进度走完当成完成（无凭据 ⇒ `missing-evidence`）。
 * 失败 / 取消是终态，**绝不**显示为已忘记；`shouldRemoveRows()` 只在 `confirmed` 时为真，
 * 因此**失败后列表一行都不会被移除**——这正是「失败不假报忘记」的可断言闸门。
 *
 * ## I7 影响提示来自内核
 *
 * 「会连带失效多少条派生条目 / 影响多少条记忆」这类数字**只能**来自内核产物
 * （`impact` 字段）。内核没给 ⇒ 展示为「影响未知」，**绝不**由 UI 自造数字。
 *
 * ## I8 进度单调不越界
 *
 * `processed` 只能上升且不超过内核给出的总数（若给出）；终态之后不再接受任何事件
 * （`job-terminal`）。
 *
 * 本模块不发起真实遗忘——它只承载**内核事件驱动的状态机 + 展示**。真实擦除由内核完成。
 */

import {
  MemoryViewModelError,
  requireId,
  type MemoryRow,
} from './types.js';

// ---------------------------------------------------------------------------
// 遗忘范围
// ---------------------------------------------------------------------------

/** 遗忘范围：单条 / 整个任务 / 整个模板 / 该主体全部。 */
export type ForgetScope =
  | { readonly kind: 'entry'; readonly memoryId: string }
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'template'; readonly templateId: string }
  | { readonly kind: 'owner' };

export type ForgetScopeKind = ForgetScope['kind'];

export const FORGET_SCOPE_KINDS: readonly ForgetScopeKind[] = ['entry', 'task', 'template', 'owner'];

/** 校验并冻结遗忘范围。 */
export function requireForgetScope(value: unknown): ForgetScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryViewModelError('invalid-forget-scope', '遗忘范围必须是对象');
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(FORGET_SCOPE_KINDS as readonly string[]).includes(kind)) {
    throw new MemoryViewModelError(
      'invalid-forget-scope',
      `遗忘范围 kind 必须是 ${FORGET_SCOPE_KINDS.join(' | ')} 之一`,
      { value: kind === undefined ? null : String(kind) },
    );
  }
  switch (kind as ForgetScopeKind) {
    case 'entry':
      return Object.freeze({
        kind: 'entry' as const,
        memoryId: requireId(raw.memoryId, 'forgetScope.memoryId', 'invalid-forget-scope'),
      });
    case 'task':
      return Object.freeze({
        kind: 'task' as const,
        taskId: requireId(raw.taskId, 'forgetScope.taskId', 'invalid-forget-scope'),
      });
    case 'template':
      return Object.freeze({
        kind: 'template' as const,
        templateId: requireId(raw.templateId, 'forgetScope.templateId', 'invalid-forget-scope'),
      });
    case 'owner':
      return Object.freeze({ kind: 'owner' as const });
  }
}

/** 范围是否命中某一行（依据行自带的 scope 与 id 判定）。 */
export function rowInForgetScope(row: MemoryRow, scope: ForgetScope): boolean {
  switch (scope.kind) {
    case 'entry':
      return row.memoryId === scope.memoryId;
    case 'task':
      return row.scope.kind === 'task' && row.scope.taskId === scope.taskId;
    case 'template':
      return row.scope.kind === 'template' && row.scope.templateId === scope.templateId;
    case 'owner':
      return true;
  }
}

/**
 * 遗忘范围**预览**：基于 UI 当前**已加载**的行，列出范围内的记忆 id。
 *
 * `authoritative: false` 是刻意的——UI 只持有已加载的一页，**不能**代表内核全量。
 * 真实的待遗忘集合以内核为准；这里只帮用户看清「我这一屏里会被删掉哪些」。
 */
export interface ForgetScopePreview {
  readonly scope: ForgetScope;
  readonly matchedMemoryIds: readonly string[];
  readonly matchedCount: number;
  readonly authoritative: false;
  readonly note: string;
}

export function previewForgetScope(
  rows: readonly MemoryRow[],
  scope: ForgetScope,
): ForgetScopePreview {
  const matched = rows.filter((row) => rowInForgetScope(row, scope)).map((row) => row.memoryId);
  return Object.freeze({
    scope,
    matchedMemoryIds: Object.freeze(matched),
    matchedCount: matched.length,
    authoritative: false,
    note:
      `已加载的 ${rows.length} 条中，有 ${matched.length} 条落在该遗忘范围内；` +
      '这只是当前页的预览，最终范围以内核为准',
  });
}

// ---------------------------------------------------------------------------
// 遗忘任务（内核事件驱动的状态机）
// ---------------------------------------------------------------------------

/**
 * 遗忘任务状态。
 *   pending    —— 已受理，未开始
 *   running    —— 内核处理中
 *   confirmed  —— 内核确认完成（**唯一**可显示为「已忘记」的态，须带回执）
 *   failed     —— 失败（终态；不得显示为已忘记）
 *   cancelled  —— 已取消（终态；不得显示为已忘记）
 */
export type ForgetJobState = 'pending' | 'running' | 'confirmed' | 'failed' | 'cancelled';

export const FORGET_TERMINAL_STATES: readonly ForgetJobState[] = ['confirmed', 'failed', 'cancelled'];

export function isForgetTerminal(state: ForgetJobState): boolean {
  return FORGET_TERMINAL_STATES.includes(state);
}

/** 内核产物中的「遗忘影响」——**唯一**合法的影响数字来源。 */
export interface ForgetImpact {
  readonly affectedMemoryCount: number;
  readonly invalidatedDerivedCount: number;
  readonly note?: string;
}

export interface ForgetJob {
  readonly jobId: string;
  readonly ownerId: string;
  readonly scope: ForgetScope;
  /** 内核给出的预计总数；未知为 null（UI **不得**猜）。 */
  readonly expectedTotal: number | null;
  readonly processed: number;
  readonly state: ForgetJobState;
  readonly affectedMemoryIds: readonly string[];
  readonly impactedDerivedIds: readonly string[];
  /** 内核回执引用；`confirmed` 后必非空（I6）。 */
  readonly evidenceRef: string | null;
  readonly failureReason: string | null;
  /** 内核给出的影响提示；未知为 null（I7）。 */
  readonly impact: ForgetImpact | null;
  readonly detail: string;
}

export interface ForgetRequest {
  readonly jobId: string;
  readonly ownerId: string;
  readonly scope: ForgetScope;
  readonly expectedTotal?: number | null;
}

/** 建立遗忘任务（`pending`，processed=0）。 */
export function startForget(request: ForgetRequest): ForgetJob {
  const jobId = requireId(request.jobId, 'jobId', 'invalid-forget-scope');
  const ownerId = requireId(request.ownerId, 'ownerId', 'invalid-forget-scope');
  const scope = requireForgetScope(request.scope);
  const expectedTotal =
    request.expectedTotal === undefined || request.expectedTotal === null
      ? null
      : requireNonNegativeInt(request.expectedTotal, 'expectedTotal');
  return Object.freeze({
    jobId,
    ownerId,
    scope,
    expectedTotal,
    processed: 0,
    state: 'pending' as ForgetJobState,
    affectedMemoryIds: Object.freeze([]) as readonly string[],
    impactedDerivedIds: Object.freeze([]) as readonly string[],
    evidenceRef: null,
    failureReason: null,
    impact: null,
    detail: '遗忘任务已受理，等待内核开始',
  });
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MemoryViewModelError('invalid-event', `${field} 必须是 >= 0 的整数`, {
      field,
      value: String(value),
    });
  }
  return value;
}

function requireStringIds(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]) as readonly string[];
  if (!Array.isArray(value)) {
    throw new MemoryViewModelError('invalid-event', `${field} 必须是字符串数组`);
  }
  return Object.freeze(value.map((item) => requireId(item, field, 'invalid-event')));
}

/** 内核发来的遗忘事件。 */
export type ForgetEvent =
  | { readonly type: 'progress'; readonly processed: number }
  | {
      readonly type: 'confirmed';
      readonly affectedMemoryIds?: readonly string[];
      readonly impactedDerivedIds?: readonly string[];
      /** 内核回执引用——**必需**（I6）。 */
      readonly evidenceRef: string;
      readonly impact?: ForgetImpact;
      readonly expectedTotal?: number;
    }
  | { readonly type: 'failed'; readonly reason: string }
  | { readonly type: 'cancelled'; readonly reason?: string };

function requireImpact(value: unknown): ForgetImpact | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryViewModelError('invalid-event', 'impact 必须是对象');
  }
  const raw = value as Record<string, unknown>;
  const affected = requireNonNegativeInt(raw.affectedMemoryCount, 'impact.affectedMemoryCount');
  const invalidated = requireNonNegativeInt(raw.invalidatedDerivedCount, 'impact.invalidatedDerivedCount');
  const note = typeof raw.note === 'string' ? raw.note : undefined;
  return Object.freeze({ affectedMemoryCount: affected, invalidatedDerivedCount: invalidated, note });
}

/**
 * 应用一个内核事件，返回**新的**任务状态（原任务不变）。
 *
 * @throws job-terminal 终态任务不再接受事件（I8）
 * @throws non-monotonic-progress `processed` 倒退
 * @throws progress-overflow `processed` 超过已声明的 expectedTotal
 * @throws missing-evidence `confirmed` 未带回执引用
 */
export function applyForgetEvent(job: ForgetJob, event: ForgetEvent): ForgetJob {
  if (isForgetTerminal(job.state)) {
    throw new MemoryViewModelError('job-terminal', `任务已处于终态 ${job.state}，不再接受事件`, {
      jobId: job.jobId,
      state: job.state,
    });
  }
  if (typeof event !== 'object' || event === null) {
    throw new MemoryViewModelError('invalid-event', '遗忘事件必须是对象');
  }

  switch (event.type) {
    case 'progress': {
      const processed = requireNonNegativeInt(event.processed, 'processed');
      if (processed < job.processed) {
        throw new MemoryViewModelError('non-monotonic-progress', 'processed 只能上升，不得倒退', {
          jobId: job.jobId,
          previous: job.processed,
          received: processed,
        });
      }
      if (job.expectedTotal !== null && processed > job.expectedTotal) {
        throw new MemoryViewModelError('progress-overflow', 'processed 超过内核给出的总数', {
          jobId: job.jobId,
          expectedTotal: job.expectedTotal,
          received: processed,
        });
      }
      return Object.freeze({
        ...job,
        state: 'running' as ForgetJobState,
        processed,
        detail: `内核处理中：已处理 ${processed}${job.expectedTotal !== null ? ` / ${job.expectedTotal}` : '（总数未知）'}`,
      });
    }

    case 'confirmed': {
      const evidenceRef = event.evidenceRef;
      if (typeof evidenceRef !== 'string' || evidenceRef.trim() === '') {
        throw new MemoryViewModelError(
          'missing-evidence',
          'confirmed 必须携带内核回执引用：没有凭据不得显示为已忘记（I6）',
          { jobId: job.jobId },
        );
      }
      const affected = requireStringIds(event.affectedMemoryIds, 'affectedMemoryIds');
      const derived = requireStringIds(event.impactedDerivedIds, 'impactedDerivedIds');
      const impact = requireImpact(event.impact);
      const expectedTotal =
        event.expectedTotal === undefined ? job.expectedTotal : requireNonNegativeInt(event.expectedTotal, 'expectedTotal');
      if (expectedTotal !== null && affected.length > expectedTotal) {
        throw new MemoryViewModelError('progress-overflow', '受影响条数超过内核给出的总数', {
          jobId: job.jobId,
          expectedTotal,
          affected: affected.length,
        });
      }
      const processed = Math.max(job.processed, affected.length);
      return Object.freeze({
        ...job,
        state: 'confirmed' as ForgetJobState,
        expectedTotal,
        processed,
        affectedMemoryIds: affected,
        impactedDerivedIds: derived,
        evidenceRef: evidenceRef.trim(),
        impact,
        detail: `内核已确认忘记 ${affected.length} 条记忆（回执 ${evidenceRef.trim()}）`,
      });
    }

    case 'failed': {
      const reason = event.reason;
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new MemoryViewModelError('invalid-event', 'failed 必须给出原因');
      }
      return Object.freeze({
        ...job,
        state: 'failed' as ForgetJobState,
        failureReason: reason.trim(),
        // 明确清空：失败**没有**抹掉任何条目（I6）。
        affectedMemoryIds: Object.freeze([]) as readonly string[],
        impactedDerivedIds: Object.freeze([]) as readonly string[],
        detail: `遗忘失败：${reason.trim()}——未抹除任何记忆，列表保持不变`,
      });
    }

    case 'cancelled': {
      const reason = typeof event.reason === 'string' && event.reason.trim() !== '' ? event.reason.trim() : '用户取消';
      return Object.freeze({
        ...job,
        state: 'cancelled' as ForgetJobState,
        affectedMemoryIds: Object.freeze([]) as readonly string[],
        impactedDerivedIds: Object.freeze([]) as readonly string[],
        detail: `遗忘已取消：${reason}——未抹除任何记忆`,
      });
    }

    default:
      throw new MemoryViewModelError('invalid-event', '未知的遗忘事件类型');
  }
}

// ---------------------------------------------------------------------------
// 展示（I6 / I7）
// ---------------------------------------------------------------------------

/**
 * 是否应据本任务从列表移除条目。**只有 `confirmed` 为真**——
 * 失败 / 取消 / 进行中一律不移除（失败不假报忘记的闸门）。
 */
export function shouldRemoveRows(job: ForgetJob): boolean {
  return job.state === 'confirmed';
}

/** 是否应把本任务显示为「已忘记」。与 `shouldRemoveRows` 同源，防止两处判据漂移。 */
export function isForgotten(job: ForgetJob): boolean {
  return job.state === 'confirmed';
}

/** 影响提示的**诚实**展示：内核给了就展示数字，没给就显式「未知」。 */
export interface ForgetImpactPresentation {
  readonly known: boolean;
  readonly affectedMemoryCount: number | null;
  readonly invalidatedDerivedCount: number | null;
  readonly lines: readonly string[];
}

export function describeImpact(job: ForgetJob): ForgetImpactPresentation {
  const impact = job.impact;
  if (impact === null) {
    return Object.freeze({
      known: false,
      affectedMemoryCount: null,
      invalidatedDerivedCount: null,
      lines: Object.freeze(['影响范围未知（内核未提供影响提示）']),
    });
  }
  const lines: string[] = [
    `受影响记忆 ${impact.affectedMemoryCount} 条`,
    `联动失效派生条目 ${impact.invalidatedDerivedCount} 条`,
  ];
  if (impact.note !== undefined && impact.note.trim() !== '') lines.push(impact.note.trim());
  return Object.freeze({
    known: true,
    affectedMemoryCount: impact.affectedMemoryCount,
    invalidatedDerivedCount: impact.invalidatedDerivedCount,
    lines: Object.freeze(lines),
  });
}

/** 进度展示：进度条文本 + 状态标签 + 影响提示（全部来自内核产物）。 */
export interface ForgetProgressPresentation {
  readonly state: ForgetJobState;
  readonly stateLabel: string;
  readonly done: boolean;
  readonly progressText: string;
  readonly ratio: number | null;
  readonly impact: ForgetImpactPresentation;
  readonly lines: readonly string[];
}

const STATE_LABELS: Readonly<Record<ForgetJobState, string>> = Object.freeze({
  pending: '等待开始',
  running: '处理中',
  confirmed: '已忘记',
  failed: '失败',
  cancelled: '已取消',
});

export function describeForgetProgress(job: ForgetJob): ForgetProgressPresentation {
  const ratio =
    job.expectedTotal !== null && job.expectedTotal > 0 ? job.processed / job.expectedTotal : null;
  const progressText =
    job.expectedTotal !== null
      ? `${job.processed} / ${job.expectedTotal}`
      : `${job.processed}（总数未知）`;
  const impact = describeImpact(job);
  const lines: string[] = [`范围：${describeScope(job.scope)}`, `状态：${STATE_LABELS[job.state]}`, `进度：${progressText}`, ...impact.lines];
  if (job.state === 'failed' && job.failureReason !== null) {
    lines.push(`失败原因：${job.failureReason}`);
  }
  return Object.freeze({
    state: job.state,
    stateLabel: STATE_LABELS[job.state],
    done: job.state === 'confirmed',
    progressText,
    ratio,
    impact,
    lines: Object.freeze(lines),
  });
}

/** 遗忘范围的可读描述。 */
export function describeScope(scope: ForgetScope): string {
  switch (scope.kind) {
    case 'entry':
      return `单条记忆 ${scope.memoryId}`;
    case 'task':
      return `任务 ${scope.taskId} 的全部记忆`;
    case 'template':
      return `模板 ${scope.templateId} 的全部经验`;
    case 'owner':
      return '该用户的全部记忆';
  }
}
