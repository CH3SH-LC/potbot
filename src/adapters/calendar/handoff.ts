/**
 * 日历的**授权直写**与**打开系统编辑页**（CAL-01 / CAL-04 / CAL-06 / CAL-07 / CAL-09）。
 *
 * ## CAL-09 的核心：两条路径的七态**上限不同**
 *
 * - **授权直写**（经 provider 写入）：写完必须**读回**目标值；只有读回一致才算
 *   `confirmed`（已确认完成）。写入受理但读不回 ⇒ 只能报 `submitted`（已提交）。
 * - **打开系统编辑页**（把参数交给系统日历应用）：**我们无法知道用户是否保存**，
 *   因此最高只能报 `handed_off`（已交接）。**没有证据不得自动标创建完成**。
 *
 * 这不是注释里的约定：{@link openCalendarEditor} 的实现路径上根本不构造 `confirmed`。
 *
 * ## CAL-07：保存参与者 ≠ 已发邀请
 *
 * **平台事实（已核实，2026-10-03）**：`CalendarContract.Attendees` 文档**未声明**
 * 插入 Attendee 行会发送邀请/邮件/通知。因此本模块把"保存参与者"如实报为 `submitted`，
 * 并**固定** `invitationSent: false`——发邀请必须另走用户授权的工具能力。
 */

import {
  assertTransition,
  type ActionReceipt,
  type ActionState,
} from '../clock/action-contract.js';
import type { ZonePort } from '../clock/zone.js';
import { validateEvent } from './event.js';
import type { Attendee, CalendarEvent } from './types.js';

// ---------------------------------------------------------------------------
// CAL-01：授权面
// ---------------------------------------------------------------------------

export type CalendarPermission = 'read' | 'write';

export interface CalendarInfo {
  readonly id: string;
  readonly displayName: string;
  readonly writable: boolean;
  readonly accountId: string;
}

export interface CalendarAccess {
  readonly granted: readonly CalendarPermission[];
  readonly calendars: readonly CalendarInfo[];
}

export type AccessCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** 检查对某日历的读/写权限（CAL-01：不可写日历、无权限、授权撤回都要正确处理）。 */
export function checkCalendarAccess(
  access: CalendarAccess,
  calendarId: string,
  need: CalendarPermission,
): AccessCheck {
  if (!access.granted.includes(need)) {
    return {
      ok: false,
      reason: need === 'write' ? '未获得写入日历的授权（WRITE_CALENDAR 未授予或已被撤回）' : '未获得读取日历的授权',
    };
  }
  const calendar = access.calendars.find((candidate) => candidate.id === calendarId);
  if (calendar === undefined) {
    return { ok: false, reason: `日历不在已授权目录中：${calendarId}` };
  }
  if (need === 'write' && !calendar.writable) {
    return { ok: false, reason: `目标日历不可写（只读日历或只读账号）：${calendarId}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 写路径的端口
// ---------------------------------------------------------------------------

export type InsertOutcome =
  | { readonly ok: true; readonly eventId: string }
  | { readonly ok: false; readonly reason: string };

/** 授权直写的 provider 端口（由宿主 / A 负责人的 Android 装配实现）。 */
export interface CalendarWritePort {
  insertEvent(event: CalendarEvent): Promise<InsertOutcome>;
  /** 读回事件；不存在返回 null。 */
  readBack(eventId: string): Promise<CalendarEvent | null>;
  /** 保存参与者行。**不**代表已发邀请（CAL-07）。 */
  saveAttendees(eventId: string, attendees: readonly Attendee[]): Promise<void>;
}

/** 打开系统日历编辑页的端口（Intent 交接）。 */
export interface CalendarEditorPort {
  openEditor(event: CalendarEvent): Promise<{
    readonly delivered: boolean;
    readonly handlerLabel: string | null;
    readonly detail: string;
  }>;
}

export interface CalendarWriteResult {
  readonly state: ActionState;
  readonly receipt: ActionReceipt;
  readonly eventId: string | null;
  /** 必须向用户如实展示的说明（含"为什么不能算完成"）。 */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// CAL-09：授权直写（读回才算完成）
// ---------------------------------------------------------------------------

export async function createEventDirect(
  port: CalendarWritePort,
  access: CalendarAccess,
  event: CalendarEvent,
  zonePort: ZonePort,
): Promise<CalendarWriteResult> {
  const validation = validateEvent(event, zonePort);
  if (!validation.ok) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'rejected' });
    return {
      state: transition.to,
      receipt: { kind: 'none', source: 'calendar_provider', detail: '事件校验未通过' },
      eventId: null,
      notes: validation.problems,
    };
  }

  const accessCheck = checkCalendarAccess(access, event.calendarId, 'write');
  if (!accessCheck.ok) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'rejected' });
    return {
      state: transition.to,
      receipt: { kind: 'none', source: 'calendar_provider', detail: accessCheck.reason },
      eventId: null,
      notes: [accessCheck.reason, '权限不足时**不**写入，也不冒充已创建。'],
    };
  }

  const insert = await port.insertEvent(event);
  if (!insert.ok) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'error' });
    return {
      state: transition.to,
      receipt: { kind: 'none', source: 'calendar_provider', detail: insert.reason },
      eventId: null,
      notes: [insert.reason],
    };
  }

  // 校验"受理"这一步合法（prepared → submitted）；最终状态由下面的读回决定。
  assertTransition('prepared', 'submitted', {
    receipt: {
      kind: 'acknowledgement',
      source: 'calendar_provider',
      detail: `插入已受理，eventId=${insert.eventId}`,
    },
  });

  const readBack = await port.readBack(insert.eventId);
  if (readBack === null) {
    const unknown = assertTransition('submitted', 'unknown');
    return {
      state: unknown.to,
      receipt: {
        kind: 'none',
        source: 'calendar_provider',
        detail: `插入已受理（eventId=${insert.eventId}），但**读不回**该事件`,
      },
      eventId: insert.eventId,
      notes: ['写入已受理但无法读回：只能报"结果未知"，**不得**报"已确认完成"（CAL-09）。'],
    };
  }

  const mismatch = compareEvent(event, readBack, zonePort);
  if (mismatch.length > 0) {
    const unknown = assertTransition('submitted', 'unknown');
    return {
      state: unknown.to,
      receipt: {
        kind: 'none',
        source: 'calendar_provider',
        detail: `读回结果与意图不一致：${mismatch.join('；')}`,
      },
      eventId: insert.eventId,
      notes: ['读回值与写入意图不一致 ⇒ 结果未知，不能当作创建成功。'],
    };
  }

  const confirmed = assertTransition('submitted', 'confirmed', {
    receipt: {
      kind: 'readback',
      source: 'calendar_provider',
      detail: `已读回 eventId=${insert.eventId}`,
      observed: {
        eventId: insert.eventId,
        title: readBack.title,
        calendarId: readBack.calendarId,
        revision: String(readBack.revision),
      },
    },
  });

  return {
    state: confirmed.to,
    receipt: confirmed.receipt,
    eventId: insert.eventId,
    notes: [],
  };
}

/** 比较意图与读回值；返回差异清单（空 = 一致）。 */
export function compareEvent(intent: CalendarEvent, observed: CalendarEvent, zonePort: ZonePort): readonly string[] {
  const diffs: string[] = [];
  if (intent.title !== observed.title) diffs.push(`标题不一致：意图「${intent.title}」读回「${observed.title}」`);
  if (intent.calendarId !== observed.calendarId) {
    diffs.push(`日历不一致：意图「${intent.calendarId}」读回「${observed.calendarId}」`);
  }
  if (intent.time.kind === 'timed' && observed.time.kind === 'timed') {
    if (intent.time.startMs !== observed.time.startMs) {
      diffs.push(`开始时刻不一致：意图 ${String(intent.time.startMs)} 读回 ${String(observed.time.startMs)}`);
    }
    if (intent.time.endMs !== observed.time.endMs) {
      diffs.push(`结束时刻不一致：意图 ${String(intent.time.endMs)} 读回 ${String(observed.time.endMs)}`);
    }
  } else if (intent.time.kind === 'allDay' && observed.time.kind === 'allDay') {
    if (intent.time.startDate !== observed.time.startDate) {
      diffs.push(`全天起始不一致：意图 ${intent.time.startDate} 读回 ${observed.time.startDate}`);
    }
    if (intent.time.endDateExclusive !== observed.time.endDateExclusive) {
      diffs.push(`全天结束不一致：意图 ${intent.time.endDateExclusive} 读回 ${observed.time.endDateExclusive}`);
    }
  } else if (intent.time.kind !== observed.time.kind) {
    diffs.push('全天/定时形态不一致');
  }
  void zonePort;
  return diffs;
}

// ---------------------------------------------------------------------------
// CAL-09：打开系统编辑页（永远到不了"已确认完成"）
// ---------------------------------------------------------------------------

export async function openCalendarEditor(
  port: CalendarEditorPort,
  event: CalendarEvent,
): Promise<CalendarWriteResult> {
  const outcome = await port.openEditor(event);

  if (!outcome.delivered) {
    const transition = assertTransition('prepared', 'failed', { failureKind: 'rejected' });
    return {
      state: transition.to,
      receipt: { kind: 'none', source: 'calendar_editor', detail: outcome.detail },
      eventId: null,
      notes: ['未找到可处理该日历事件的编辑应用：动作**未**发生。'],
    };
  }

  const transition = assertTransition('prepared', 'handed_off');
  return {
    state: transition.to,
    receipt: {
      kind: 'none',
      source: outcome.handlerLabel ?? 'system_calendar_editor',
      detail: outcome.detail,
    },
    eventId: null,
    notes: [
      '已把参数交接给系统日历编辑页。**用户是否保存、保存成什么，我们无从得知**：' +
        '没有读回证据，**不得**自动标"创建完成"（CAL-09）。',
      '若用户报告已保存，只能记为"用户报告完成"，仍不等于系统确认。',
    ],
  };
}

// ---------------------------------------------------------------------------
// CAL-07：参与者
// ---------------------------------------------------------------------------

export interface AttendeeSaveDeclaration {
  readonly state: 'submitted';
  /** **恒为 false**：保存参与者不代表已发邀请（CAL-07）。 */
  readonly invitationSent: false;
  readonly note: string;
}

/**
 * 「已保存参与者」的如实声明。
 * 平台层面：`CalendarContract.Attendees` 文档**未声明**插入会发送邀请（已核实，2026-10-03），
 * 故这里**固定** `invitationSent: false`。
 */
export function declareAttendeeSave(attendeeCount: number): AttendeeSaveDeclaration {
  return {
    state: 'submitted',
    invitationSent: false,
    note:
      `已保存 ${String(attendeeCount)} 位参与者（submitted）。**未发送邀请**：` +
      '平台文档未声明插入参与者会发邀请；发邀请须另按用户授权与工具能力执行（CAL-07）。',
  };
}

// ---------------------------------------------------------------------------
// CAL-04：提醒
// ---------------------------------------------------------------------------

export type ReminderMethod = 'notification' | 'email' | 'sms' | 'default';

export interface Reminder {
  /** 提前多少分钟。 */
  readonly minutesBefore: number;
  readonly method: ReminderMethod;
}

/** 校验提醒；`availableMethods` 未知（未在设备核实）时只做形状校验并标注。 */
export function validateReminders(
  reminders: readonly Reminder[],
  availableMethods?: readonly ReminderMethod[],
): readonly string[] {
  const problems: string[] = [];
  for (const reminder of reminders) {
    if (!Number.isInteger(reminder.minutesBefore) || reminder.minutesBefore < 0) {
      problems.push(`提醒提前量必须是非负整数分钟，收到 ${String(reminder.minutesBefore)}`);
    }
    if (availableMethods !== undefined && !availableMethods.includes(reminder.method)) {
      problems.push(`目标日历不支持该提醒方式：${reminder.method}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CAL-06：修改 / 删除（失败保留原记录）
// ---------------------------------------------------------------------------

export interface MutationPlan {
  readonly ok: boolean;
  readonly next: CalendarEvent | null;
  readonly reason: string | null;
}

/**
 * 规划一次修改（改期/改标题等）。**只规划，不落库**；失败时 `next` 为 null
 * ⇒ 原记录**天然保留**（CAL-06「失败保留原记录」）。
 */
export function planEventUpdate(
  current: CalendarEvent,
  patch: Partial<Pick<CalendarEvent, 'title' | 'time' | 'location' | 'description' | 'attendees'>>,
  expectedRevision: number,
  zonePort: ZonePort,
): MutationPlan {
  if (current.revision !== expectedRevision) {
    return {
      ok: false,
      next: null,
      reason: `版本冲突：期望 ${String(expectedRevision)}，当前 ${String(current.revision)}`,
    };
  }
  const next: CalendarEvent = { ...current, ...patch, revision: current.revision + 1 };
  const validation = validateEvent(next, zonePort);
  if (!validation.ok) {
    return { ok: false, next: null, reason: validation.problems.join('；') };
  }
  return { ok: true, next, reason: null };
}

/** 规划一次删除（复制则另建新 id，不共用 eventId）。 */
export function planEventDelete(current: CalendarEvent, expectedRevision: number): MutationPlan {
  if (current.revision !== expectedRevision) {
    return {
      ok: false,
      next: null,
      reason: `版本冲突：期望 ${String(expectedRevision)}，当前 ${String(current.revision)}`,
    };
  }
  return { ok: true, next: null, reason: null };
}

/** 复制事件：**必须换新 id**，否则会与源事件相互覆盖（CAL-06）。 */
export function planEventCopy(current: CalendarEvent, newId: string): CalendarEvent {
  if (newId === current.id) {
    throw new Error('复制事件必须分配新 id：沿用同一 id 会与源事件相互覆盖');
  }
  return { ...current, id: newId, revision: 1 };
}
