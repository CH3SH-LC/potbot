/**
 * F-R06 system-actions —— 日历事件（T06 日程详情）专属表单。
 *
 * design-07 行 54 T06：目标日历、事件、冲突、提醒、重复范围、参与者与邀请状态；
 * 行 133：必须展示明确日期/时间/时区/目标账号/重复规则/影响范围；行 189：改期时
 * 「本次 / 本次及以后 / 整个系列」分开确认并保留失败原记录。
 *
 * 本模块把原始输入校验成一个**可渲染、可断言**的 `CalendarFormView`：
 * 时间摘要只来自绝对时间（I-A）；重复编辑范围显式（I-B）；账号是引用（I-C）；
 * 冲突不被静默丢弃（作为可见 warning 与 `conflicts` 列表保留）。
 */

import { returnTargetFor, type ConversationReturnTarget } from './return.js';
import {
  compareInstant,
  requireResolvedTime,
  requireTimezone,
  summarizeTime,
  type ResolvedTime,
  type TimeSpec,
} from './time.js';
import {
  SystemActionError,
  makeWarning,
  normalizeRefList,
  requireNonEmptyString,
  requireOccurrenceScope,
  requireRecurrence,
  requireTitle,
  type FormWarning,
  type Recurrence,
  type RecurrenceScope,
} from './types.js';

export type InviteState = 'none' | 'pending' | 'accepted' | 'declined';
export const INVITE_STATES: readonly InviteState[] = ['none', 'pending', 'accepted', 'declined'];

const ACCOUNT_REF = /^(?:acct|cal|ref):/;

/** 目标账号/应用必须是引用（I-C），不接受明文账号/手机号。 */
export function requireAccountRef(value: unknown): string {
  const ref = requireNonEmptyString(value, 'accountRef', 'missing-account-ref', 'accountRef 不能为空');
  if (!ACCOUNT_REF.test(ref)) {
    throw new SystemActionError(
      'invalid-account-ref',
      'accountRef 必须是 acct: / cal: / ref: 形式的引用，不接受明文账号',
      { field: 'accountRef' },
    );
  }
  return ref;
}

export function requireInviteState(value: unknown): InviteState {
  if (value === undefined || value === null) return 'none';
  if (typeof value !== 'string' || !INVITE_STATES.includes(value as InviteState)) {
    throw new SystemActionError('invalid-invite-state', `inviteState 非法：${String(value)}`, {
      field: 'inviteState',
    });
  }
  return value as InviteState;
}

export interface CalendarEventInput {
  /** 有值 = 修改已存在事件；无值 = 新建。 */
  readonly eventId?: string;
  readonly conversationId: string;
  readonly anchorMessageId?: string | null;
  readonly title: string;
  /** 开始时间（相对表达会被 I-A 拒绝）。 */
  readonly time: TimeSpec;
  readonly endTime?: TimeSpec;
  /** 目标日历账号时区（跨时区创建时允许与 `time.timezone` 不同）。 */
  readonly timezone: string;
  readonly accountRef: string;
  readonly recurrence?: Recurrence | null;
  readonly occurrenceScope?: RecurrenceScope;
  readonly conflictRefs?: readonly string[];
  readonly inviteRefs?: readonly string[];
  readonly inviteState?: InviteState;
  /** 修改时必填（I-H）。 */
  readonly expectedRevision?: number;
}

export interface CalendarFormView {
  readonly kind: 'calendar-event';
  readonly conversationId: string;
  readonly eventId: string | null;
  readonly title: string;
  /** 绝对执行摘要（I-A）；形如 `2026-10-04T01:00:00Z@Asia/Shanghai`。 */
  readonly timeSummary: string;
  readonly endSummary: string | null;
  readonly timezone: string;
  readonly accountRef: string;
  readonly recurrenceRule: string | null;
  readonly recurrenceCount: number | null;
  readonly occurrenceScope: RecurrenceScope | null;
  /** 冲突引用；**原样保留**，不被静默丢弃。 */
  readonly conflicts: readonly string[];
  readonly inviteRefs: readonly string[];
  readonly inviteState: InviteState;
  readonly warnings: readonly FormWarning[];
  readonly returnTarget: ConversationReturnTarget;
  readonly expectedRevision: number | null;
}

/** 校验并构造日历事件详情表单。任何不变量违反都会抛 `SystemActionError`。 */
export function buildCalendarForm(input: CalendarEventInput): CalendarFormView {
  const title = requireTitle(input.title);
  const timezone = requireTimezone(input.timezone);
  const accountRef = requireAccountRef(input.accountRef);
  const returnTarget = returnTargetFor(input.conversationId, input.anchorMessageId);

  const start: ResolvedTime = requireResolvedTime(input.time, 'time');
  let end: ResolvedTime | null = null;
  if (input.endTime !== undefined && input.endTime !== null) {
    end = requireResolvedTime(input.endTime, 'endTime');
    if (compareInstant(end, start) < 0) {
      throw new SystemActionError('end-before-start', 'endTime 不能早于 time', {
        field: 'endTime',
      });
    }
  }

  const recurrence = requireRecurrence(input.recurrence);
  const editing = typeof input.eventId === 'string' && input.eventId.trim() !== '';
  const occurrenceScope = requireOccurrenceScope({
    recurring: recurrence !== null,
    editing,
    provided: input.occurrenceScope,
  });

  const conflicts = normalizeRefList(input.conflictRefs, 'conflictRefs');
  const inviteRefs = normalizeRefList(input.inviteRefs, 'inviteRefs');
  const inviteState = requireInviteState(input.inviteState);

  const warnings: FormWarning[] = [];
  if (conflicts.length > 0) {
    warnings.push(
      makeWarning('schedule-conflict', `检测到 ${conflicts.length} 个日程冲突，需用户确认后再保存`, 'warn'),
    );
  }
  if (recurrence !== null && editing) {
    warnings.push(makeWarning('recurrence-scope', `本次修改仅作用于：${occurrenceScope}`, 'info'));
  }
  if (end === null && !start.allDay) {
    warnings.push(makeWarning('no-end-time', '未给出结束时间，将按单点事件处理', 'info'));
  }

  return Object.freeze({
    kind: 'calendar-event' as const,
    conversationId: returnTarget.conversationId,
    eventId: editing ? (input.eventId as string).trim() : null,
    title,
    timeSummary: summarizeTime(start, 'time'),
    endSummary: end === null ? null : summarizeTime(end, 'endTime'),
    timezone,
    accountRef,
    recurrenceRule: recurrence === null ? null : recurrence.rule,
    recurrenceCount: recurrence === null || recurrence.count === undefined ? null : recurrence.count,
    occurrenceScope,
    conflicts,
    inviteRefs,
    inviteState,
    warnings: Object.freeze(warnings),
    returnTarget,
    expectedRevision:
      input.expectedRevision === undefined ? null : requireExpectedRevision(input.expectedRevision),
  });
}

function requireExpectedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SystemActionError('invalid-revision', 'expectedRevision 必须是非负整数', {
      field: 'expectedRevision',
    });
  }
  return value;
}
