/**
 * CAL-03 / CAL-04：**事件构造**（标题 / 起止 / 时区 / 全天 / 地点 / 描述）、
 * **全天与跨天/跨时区语义**，以及**提醒的设置/修改/删除与数量·方式校验**，
 * 并给出"**实际写入目标并读回**"的进出通道。
 *
 * ## 相对既有 `event.ts` / `handoff.ts` 补的是什么
 *
 * - `event.validateEvent` 只回答"这条事件自不自洽"。CAL-03 还要**从草稿构造**事件
 *   （补默认值、算全天排他端点、算跨天/跨时区投影），并保证构造即校验。
 * - `handoff.validateReminders` 只校验**一个给定数组**。CAL-04 还要**提醒的增删改**
 *   这一组状态变更语义（含数量上限），且"方式可用性"未知时如实标注。
 * - `handoff.createEventDirect` 在**未装配端口时抛异常**。CAL-04 要求"无端口 ⇒
 *   **结构化**未就绪"——{@link createEvent} 把它包成 `ready:false`，不打断调用方。
 *
 * ## 如实声明（不得编造）
 *
 * - 全天端点为**排他**是本适配器契约（见 `types.ts`）；与平台 `ALL_DAY` 列的映射
 *   边界**真机侧未验证（需真机）**。
 * - 提醒数量上限取自平台文档语义，**具体数值需真机核对**（见 {@link DEFAULT_MAX_REMINDERS}）；
 *   未在设备上实测前一律按"未验证"对待。
 *
 * ## 交付说明
 *
 * 子智能体模型身份**未确认为 DS**；本文件为在 `fa/calendar-core` 工作树内**新增**。
 */

import { civilFromDays, daysFromCivil, epochToWall, MS_PER_DAY, parseDate, type WallClock } from '../clock/civil.js';
import { zoneToInstant, type ZonePort } from '../clock/zone.js';
import { allDayLengthInDays, eventDurationMs, eventRange, validateEvent, type EventValidation } from './event.js';
import {
  createEventDirect,
  validateReminders,
  type CalendarAccess,
  type CalendarWritePort,
  type CalendarWriteResult,
  type Reminder,
  type ReminderMethod,
} from './handoff.js';
import type { Attendee, CalendarEvent, EventTime, RecurrenceRule } from './types.js';

// ---------------------------------------------------------------------------
// CAL-03：从草稿构造事件
// ---------------------------------------------------------------------------

/** 待构造的事件草稿：必填项之外皆可省，省则取"无"。 */
export interface EventDraft {
  readonly id: string;
  readonly calendarId: string;
  readonly title: string;
  readonly time: EventTime;
  readonly location?: string | null;
  readonly description?: string | null;
  readonly attendees?: readonly Attendee[];
  readonly recurrence?: RecurrenceRule | null;
  readonly revision?: number;
}

export type BuildEventResult =
  | { readonly ok: true; readonly event: CalendarEvent }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * 构造一条事件。**构造即校验**（复用 `event.validateEvent`）：
 * 不合格的草稿**不产出**事件对象，只回问题清单——不把问题事件放进产品路径。
 */
export function buildEvent(draft: EventDraft, zonePort: ZonePort): BuildEventResult {
  const event: CalendarEvent = {
    id: draft.id,
    calendarId: draft.calendarId,
    title: draft.title,
    time: draft.time,
    location: draft.location ?? null,
    description: draft.description ?? null,
    attendees: draft.attendees ?? [],
    recurrence: draft.recurrence ?? null,
    revision: draft.revision ?? 1,
  };
  const validation = validateEvent(event, zonePort);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  return { ok: true, event };
}

/**
 * 构造**全天**时间（CAL-03）。
 *
 * `dayCount` 为**自然日天数**（≥1）；排他端点 = 起始日 + dayCount 天。
 * 天数非正整数 ⇒ 返回 null（不四舍五入、不默认 1 天）。
 */
export function allDayTime(
  startDate: string,
  dayCount: number,
  zoneId: string,
): Extract<EventTime, { kind: 'allDay' }> | null {
  if (!Number.isInteger(dayCount) || dayCount < 1) return null;
  const start = parseDate(startDate);
  if (start === null) return null;
  const end = civilFromDays(daysFromCivil(start.year, start.month, start.day) + dayCount);
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const endDateExclusive = `${pad(end.year, 4)}-${pad(end.month, 2)}-${pad(end.day, 2)}`;
  return { kind: 'allDay', startDate, endDateExclusive, zoneId };
}

export interface DaySpan {
  /** 该事件在给定时区覆盖的**自然日**数（≥1）。 */
  readonly days: number;
  /** 首个自然日（含）。 */
  readonly startLocalDate: string;
  /** 末个自然日（**含**，便于展示；与排他端点不同）。 */
  readonly endLocalDateInclusive: string;
}

/** 某绝对时刻在给定时区落在第几个自然日。 */
function dayIndexOfInstant(instantMs: number, offsetMinutes: number): number {
  return Math.floor((instantMs + offsetMinutes * 60_000) / MS_PER_DAY);
}

function isoDate(dayIndex: number): string {
  const civil = civilFromDays(dayIndex);
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}`;
}

/**
 * 跨天语义（CAL-03）：事件在给定时区覆盖几个自然日。
 *
 * - **全天**：直接由排他端点推天数（`endDateExclusive − startDate`）。
 * - **定时**：用 `[startMs, endMs)` 的**最后覆盖瞬间**（`endMs − 1`）判末日——
 *   "09:00–次日 00:00" 只占 **1** 天，因为次日 00:00 是**排他**端点。
 *
 * 时区未知/日期非法 ⇒ null（**不**用 UTC 顶替）。
 */
export function daySpan(time: EventTime, zoneId: string, zonePort: ZonePort): DaySpan | null {
  if (time.kind === 'allDay') {
    const days = allDayLengthInDays(time);
    if (days === null || days < 1) return null;
    const start = parseDate(time.startDate);
    if (start === null) return null;
    // 时区未知时也**不猜**：这里用"当地 0 点"能否换算为绝对时刻来判可用性。
    const probe = zoneToInstant(zonePort, zoneId, { ...start, hour: 0, minute: 0, second: 0 });
    if (probe === null) return null;
    const startDay = daysFromCivil(start.year, start.month, start.day);
    return { days, startLocalDate: isoDate(startDay), endLocalDateInclusive: isoDate(startDay + days - 1) };
  }

  const offset = zonePort.offsetMinutesAt(zoneId, time.startMs);
  if (offset === null) return null;
  const range = eventRange(time, zonePort);
  if (range === null || range.endMs <= range.startMs) return null;
  const firstDay = dayIndexOfInstant(range.startMs, offset);
  const lastDay = dayIndexOfInstant(range.endMs - 1, offset);
  return {
    days: lastDay - firstDay + 1,
    startLocalDate: isoDate(firstDay),
    endLocalDateInclusive: isoDate(lastDay),
  };
}

export interface ZoneProjection {
  readonly zoneId: string;
  /** 起点在该时区的墙上时刻。 */
  readonly startWall: WallClock;
  /** **排他**终点在该时区的墙上时刻。 */
  readonly endWall: WallClock;
  /** 时长（毫秒）——**跨时区不改变绝对时长**。 */
  readonly durationMs: number;
}

/**
 * 把事件时间投影到**另一个时区**（CAL-03 跨时区语义）。
 *
 * 语义要点：定时事件的 `startMs/endMs` 是**绝对时刻**，换时区只改变**墙上表示**，
 * **不改变时长**；全天事件换时区会改变其**绝对区间**（因为"当地 0 点"变了）。
 * 时区未知 ⇒ null。
 */
export function projectTimeInZone(
  time: EventTime,
  zoneId: string,
  zonePort: ZonePort,
): ZoneProjection | null {
  const range = eventRange(time, zonePort);
  if (range === null) return null;
  // 定时事件不依赖 zoneId 解析；全天事件已在 eventRange 里用事件自身时区解析过。
  const probe = time.kind === 'timed' ? time.startMs : range.startMs;
  const offset = zonePort.offsetMinutesAt(zoneId, probe);
  if (offset === null) return null;
  const durationMs = range.endMs - range.startMs;
  return {
    zoneId,
    startWall: epochToWall(range.startMs, offset),
    endWall: epochToWall(range.endMs, offset),
    durationMs,
  };
}

/** 全天事件的绝对区间是否**跨时区**发生变化（用于跨时区语义的自检）。 */
export function allDayRangeDiffersAcrossZones(
  time: Extract<EventTime, { kind: 'allDay' }>,
  otherZoneId: string,
  zonePort: ZonePort,
): boolean | null {
  const base = eventRange(time, zonePort);
  const start = parseDate(time.startDate);
  if (base === null || start === null) return null;
  const otherStart = zoneToInstant(zonePort, otherZoneId, {
    year: start.year,
    month: start.month,
    day: start.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  if (otherStart === null) return null;
  return otherStart !== base.startMs;
}

// ---------------------------------------------------------------------------
// CAL-04：提醒（设置 / 修改 / 删除 / 数量·方式校验）
// ---------------------------------------------------------------------------

/**
 * 提醒数量上限默认值。
 *
 * **来源**：Android `CalendarContract.Calendars.MAX_REMINDERS` 的文档语义
 * （每个事件可挂的提醒条数受日历能力约束）。**具体数值需真机核对**——本批未在设备上
 * 读取该列，故这里的 5 是**待核对的默认**，不是实测结论。
 */
export const DEFAULT_MAX_REMINDERS = 5;

export interface ReminderOptions {
  /** 该日历支持的提醒方式；未提供 ⇒ 只做形状校验并如实标注"方式可用性未核实"。 */
  readonly availableMethods?: readonly ReminderMethod[];
  /** 数量上限；默认 {@link DEFAULT_MAX_REMINDERS}。 */
  readonly maxReminders?: number;
}

export type ReminderAction =
  | { readonly kind: 'set'; readonly reminders: readonly Reminder[] }
  | { readonly kind: 'add'; readonly reminder: Reminder }
  | { readonly kind: 'remove'; readonly index: number }
  | { readonly kind: 'update'; readonly index: number; readonly reminder: Reminder };

export interface ReminderPlan {
  readonly ok: boolean;
  /** 变更后的提醒集合（失败时为**原集合**，不被改动）。 */
  readonly reminders: readonly Reminder[];
  readonly problems: readonly string[];
  /** 方式可用性未核实时为 true（调用方必须如实展示，不得当"已验证支持"）。 */
  readonly methodAvailabilityUnverified: boolean;
  /** 是否触发了数量上限。 */
  readonly countExceeded: boolean;
}

function indexProblem(index: number, length: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    return `提醒下标越界：${String(index)}（当前共 ${String(length)} 条）`;
  }
  return null;
}

/**
 * 规划一次提醒变更（CAL-04）。
 *
 * **失败 ⇒ 返回原集合**（`ok:false` 且 `reminders` 与入参 `current` 相等），
 * 因此"删错/改错"不会静默改掉既有提醒。
 */
export function planReminders(
  current: readonly Reminder[],
  action: ReminderAction,
  options: ReminderOptions = {},
): ReminderPlan {
  const max = options.maxReminders ?? DEFAULT_MAX_REMINDERS;
  const methodAvailabilityUnverified = options.availableMethods === undefined;
  const problems: string[] = [];
  let next: Reminder[];

  switch (action.kind) {
    case 'set':
      next = [...action.reminders];
      break;
    case 'add':
      next = [...current, action.reminder];
      break;
    case 'remove': {
      const problem = indexProblem(action.index, current.length);
      if (problem !== null) {
        return {
          ok: false,
          reminders: current,
          problems: [problem],
          methodAvailabilityUnverified,
          countExceeded: false,
        };
      }
      next = current.filter((_, index) => index !== action.index);
      break;
    }
    case 'update': {
      const problem = indexProblem(action.index, current.length);
      if (problem !== null) {
        return {
          ok: false,
          reminders: current,
          problems: [problem],
          methodAvailabilityUnverified,
          countExceeded: false,
        };
      }
      next = current.map((reminder, index) => (index === action.index ? action.reminder : reminder));
      break;
    }
  }

  problems.push(...validateReminders(next, options.availableMethods));

  let countExceeded = false;
  if (next.length > max) {
    countExceeded = true;
    problems.push(
      `提醒条数 ${String(next.length)} 超过上限 ${String(max)}` +
        `（上限取自平台文档语义，**具体数值需真机核对**）`,
    );
  }

  if (problems.length > 0) {
    return { ok: false, reminders: current, problems, methodAvailabilityUnverified, countExceeded };
  }
  return { ok: true, reminders: next, problems: [], methodAvailabilityUnverified, countExceeded };
}

// ---------------------------------------------------------------------------
// CAL-04：实际写入目标并读回（端口注入；无端口 ⇒ 结构化未就绪）
// ---------------------------------------------------------------------------

export type CreateEventOutcome =
  | { readonly ready: false; readonly reason: string; readonly note: string }
  | { readonly ready: true; readonly result: CalendarWriteResult };

/**
 * 创建事件并**读回校验**（CAL-03/CAL-04 的写通道）。
 *
 * - **未装配端口** ⇒ `ready:false` 的**结构化未就绪**（不抛异常，也不冒充已创建）。
 * - 装配端口后走 `handoff.createEventDirect`：**只有读回一致**才 `confirmed`。
 *
 * 真机 provider 行为**未验证（需真机）**。
 */
export async function createEvent(
  port: CalendarWritePort | undefined,
  access: CalendarAccess,
  event: CalendarEvent,
  zonePort: ZonePort,
): Promise<CreateEventOutcome> {
  if (port === undefined) {
    return {
      ready: false,
      reason: '未装配日历直写端口（CalendarWritePort）',
      note:
        '无端口 ⇒ 结构化未就绪：不写入、不冒充已创建、也不抛异常打断调用方。' +
        '真机侧未验证（需真机）。',
    };
  }
  return { ready: true, result: await createEventDirect(port, access, event, zonePort) };
}

/** 复述事件的校验结果（供调用方在写入前自检；与 `event.validateEvent` 同一实现）。 */
export function previewValidation(event: CalendarEvent, zonePort: ZonePort): EventValidation {
  return validateEvent(event, zonePort);
}

/** 事件时长（毫秒）；无法确定返回 null（透传 `event.eventDurationMs`）。 */
export function durationOf(time: EventTime, zonePort: ZonePort): number | null {
  return eventDurationMs(time, zonePort);
}
