/**
 * 事件模型与校验（CAL-03 的**纯逻辑**部分：标题 / 起止 / 时区 / 全天 / 地点 / 描述）。
 *
 * 全天与定时**统一**归一到 `[startMs, endMs)` 的绝对区间，供冲突检测与忙闲使用；
 * 归一需要时区，故所有函数都要求注入 {@link ZonePort}。时区未知一律返回 `null`
 * 或在校验里报错——**不以 UTC 顶替**。
 */

import { MS_PER_DAY, daysFromCivil, formatDate, parseDate } from '../clock/civil.js';
import { zoneToInstant, type ZonePort } from '../clock/zone.js';
import type { CalendarEvent, EventTime } from './types.js';

/** 事件的绝对区间 `[startMs, endMs)`；无法确定（时区未知/日期非法）返回 null。 */
export interface InstantRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** 全天日期区间 → 绝对区间（起点 = startDate 当地 0 点，终点 = endDateExclusive 当地 0 点）。 */
export function allDayRange(time: Extract<EventTime, { kind: 'allDay' }>, zonePort: ZonePort): InstantRange | null {
  const start = parseDate(time.startDate);
  const end = parseDate(time.endDateExclusive);
  if (start === null || end === null) return null;
  const startMs = zoneToInstant(zonePort, time.zoneId, { ...start, hour: 0, minute: 0, second: 0 });
  const endMs = zoneToInstant(zonePort, time.zoneId, { ...end, hour: 0, minute: 0, second: 0 });
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

/** 事件时间 → 绝对区间；无法确定返回 null。 */
export function eventRange(time: EventTime, zonePort: ZonePort): InstantRange | null {
  if (time.kind === 'timed') return { startMs: time.startMs, endMs: time.endMs };
  return allDayRange(time, zonePort);
}

/** 事件时长（毫秒）；无法确定返回 null。 */
export function eventDurationMs(time: EventTime, zonePort: ZonePort): number | null {
  const range = eventRange(time, zonePort);
  return range === null ? null : range.endMs - range.startMs;
}

export interface EventValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * 校验一条事件是否自洽。**构造即校验**：不合格的事件不应进入产品路径。
 *
 * 检查项：标题非空；定时事件 `end > start`；全天事件 `endDateExclusive > startDate`；
 * 时区可解析；`recurrence` 与时间形态相容。
 */
export function validateEvent(event: CalendarEvent, zonePort: ZonePort): EventValidation {
  const problems: string[] = [];

  if (event.title.trim() === '') problems.push('标题不得为空');
  if (event.calendarId.trim() === '') problems.push('必须指定目标日历 calendarId');
  if (!Number.isInteger(event.revision) || event.revision < 1) {
    problems.push('revision 必须是 ≥1 的整数');
  }

  if (event.time.kind === 'timed') {
    if (!Number.isFinite(event.time.startMs) || !Number.isFinite(event.time.endMs)) {
      problems.push('起止必须是有限数');
    } else if (event.time.endMs <= event.time.startMs) {
      problems.push('结束必须晚于开始');
    }
    if (zonePort.offsetMinutesAt(event.time.zoneId, event.time.startMs) === null) {
      problems.push(`事件时区未知或非法：${event.time.zoneId}`);
    }
  } else {
    const start = parseDate(event.time.startDate);
    const end = parseDate(event.time.endDateExclusive);
    if (start === null) problems.push(`全天起始日期非法（应为 YYYY-MM-DD）：${event.time.startDate}`);
    if (end === null) problems.push(`全天结束日期非法（应为 YYYY-MM-DD）：${event.time.endDateExclusive}`);
    if (start !== null && end !== null) {
      const startDay = daysFromCivil(start.year, start.month, start.day);
      const endDay = daysFromCivil(end.year, end.month, end.day);
      if (endDay <= startDay) {
        problems.push('全天事件的结束日期（排他）必须晚于起始日期：至少跨 1 天');
      }
    }
    // 全天事件在"当地 0 点"处取偏移；取不到说明时区未知。
    const probe = zoneToInstant(zonePort, event.time.zoneId, {
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    if (probe === null) problems.push(`全天事件时区未知或非法：${event.time.zoneId}`);
  }

  if (event.recurrence !== null) {
    problems.push(...validateRecurrenceShape(event.recurrence));
    if (event.recurrence.count !== undefined && event.recurrence.untilDate !== undefined) {
      problems.push('重复规则不得同时给出 count 与 untilDate（二者互斥，避免"到底按哪个"的歧义）');
    }
  }

  return { ok: problems.length === 0, problems };
}

/** 重复规则的形状校验（不含展开；展开见 `recur.ts`）。 */
export function validateRecurrenceShape(rule: NonNullable<CalendarEvent['recurrence']>): readonly string[] {
  const problems: string[] = [];
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    problems.push('重复间隔必须是 ≥1 的整数');
  }
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) {
    problems.push('重复次数必须是 ≥1 的整数');
  }
  if (rule.untilDate !== undefined && parseDate(rule.untilDate) === null) {
    problems.push(`截止日期非法（应为 YYYY-MM-DD）：${rule.untilDate}`);
  }
  for (const date of rule.exdates ?? []) {
    if (parseDate(date) === null) problems.push(`例外日期非法（应为 YYYY-MM-DD）：${date}`);
  }
  if (rule.freq === 'weekly' && (rule.byWeekday ?? []).length === 0 && rule.byWeekday !== undefined) {
    problems.push('周重复的 byWeekday 不得为空（要按周重复至少给一个星期几）');
  }
  return problems;
}

/** 展示用文本（不含本地化，纪律禁用 toLocaleString）。 */
export function describeEventTime(time: EventTime): string {
  if (time.kind === 'timed') {
    return `定时（${time.zoneId}）`;
  }
  const start = parseDate(time.startDate);
  const end = parseDate(time.endDateExclusive);
  if (start === null || end === null) return '全天（日期非法）';
  const startDay = daysFromCivil(start.year, start.month, start.day);
  const endDay = daysFromCivil(end.year, end.month, end.day);
  const days = endDay - startDay;
  return `全天（${formatDate(start)} 起 ${String(days)} 天）`;
}

/** 全天事件的"天数"（至少 1）。 */
export function allDayLengthInDays(time: Extract<EventTime, { kind: 'allDay' }>): number | null {
  const start = parseDate(time.startDate);
  const end = parseDate(time.endDateExclusive);
  if (start === null || end === null) return null;
  return daysFromCivil(end.year, end.month, end.day) - daysFromCivil(start.year, start.month, start.day);
}

/** 把定时事件平移若干天（改期用；全天事件按日期平移）。 */
export function shiftEventTime(time: EventTime, days: number): EventTime {
  if (time.kind === 'timed') {
    return { ...time, startMs: time.startMs + days * MS_PER_DAY, endMs: time.endMs + days * MS_PER_DAY };
  }
  const start = parseDate(time.startDate);
  const end = parseDate(time.endDateExclusive);
  if (start === null || end === null) return time;
  return {
    ...time,
    startDate: formatDate(fromDayNumber(daysFromCivil(start.year, start.month, start.day) + days)),
    endDateExclusive: formatDate(fromDayNumber(daysFromCivil(end.year, end.month, end.day) + days)),
  };
}

/** 天数 → 日期（复用 civil 的整数算法）。 */
function fromDayNumber(day: number): { year: number; month: number; day: number } {
  // 局部转调，避免在多个文件里重复算法。
  return civilFromDaysLocal(day);
}

import { civilFromDays as civilFromDaysLocal } from '../clock/civil.js';
