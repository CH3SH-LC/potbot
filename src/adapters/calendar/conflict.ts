/**
 * 日程查询、忙闲与冲突检测（CAL-02 / CAL-05 的**纯逻辑**部分）。
 *
 * ## 边界（如实声明）
 *
 * 本模块在**调用方给出的**事件集合上做查询/忙闲/冲突计算。它**不**去读平台日历——
 * 真实读取需要 `READ_CALENDAR` 权限与真机（见 `not-ready.ts` 的 CAL-01/CAL-02/CAL-10）。
 *
 * CAL-02 明令「**不假读未授权账号**」：因此查询**必须**给出 `authorizedCalendarIds`，
 * 集合中不在该白名单内的事件**一律排除**，不可能被顺带读出。
 */

import { formatDate, epochToWall } from '../clock/civil.js';
import type { ZonePort } from '../clock/zone.js';
import { eventRange, type InstantRange } from './event.js';
import type { CalendarEvent } from './types.js';

/** 两个绝对区间是否重叠（半开区间 `[start, end)`）。 */
export function overlaps(a: InstantRange, b: InstantRange): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export interface BusyBlock {
  readonly eventId: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  /** 是否为全天事件（全天在忙闲里占位整天）。 */
  readonly allDay: boolean;
}

export interface BusyResult {
  readonly blocks: readonly BusyBlock[];
  /** 合并后的忙碌区间（相邻/重叠已合并）。 */
  readonly merged: readonly { readonly startMs: number; readonly endMs: number }[];
  /** 区间无法确定的事件（时区未知/日期非法）——**如实列出**，不静默丢弃。 */
  readonly undetermined: readonly string[];
}

export interface QueryOptions {
  /** 查询区间（**必须显式**，CAL-02「时间范围明确」）。 */
  readonly fromMs: number;
  readonly toMs: number;
  /** 允许读取的日历白名单；未列出的事件一律不返回（CAL-02）。 */
  readonly authorizedCalendarIds: readonly string[];
  /** 关键词（标题/地点/描述，大小写不敏感）。 */
  readonly keyword?: string;
}

export interface QueryResult {
  readonly events: readonly CalendarEvent[];
  readonly busy: BusyResult;
  /** 因不在授权白名单而被排除的条数（可见地报告过滤量）。 */
  readonly excludedUnauthorized: number;
}

/** 时间区间内的事件查询（含忙闲）。 */
export function queryEvents(
  events: readonly CalendarEvent[],
  zonePort: ZonePort,
  options: QueryOptions,
): QueryResult {
  if (options.toMs <= options.fromMs) {
    throw new Error('查询区间必须满足 toMs > fromMs（CAL-02：时间范围必须明确）');
  }
  const window: InstantRange = { startMs: options.fromMs, endMs: options.toMs };
  const authorized = new Set(options.authorizedCalendarIds);
  const keyword = options.keyword?.trim().toLowerCase() ?? '';

  let excludedUnauthorized = 0;
  const matched: CalendarEvent[] = [];

  for (const event of events) {
    if (!authorized.has(event.calendarId)) {
      excludedUnauthorized += 1;
      continue;
    }
    if (keyword !== '' && !matchesKeyword(event, keyword)) continue;
    const range = eventRange(event.time, zonePort);
    if (range === null) {
      // 区间无法确定：关键词命中也**不**返回（不能假装查到了），但计入 undetermined。
      continue;
    }
    if (overlaps(range, window)) matched.push(event);
  }

  return { events: matched, busy: computeBusy(matched, zonePort), excludedUnauthorized };
}

function matchesKeyword(event: CalendarEvent, keyword: string): boolean {
  const haystack = [event.title, event.location ?? '', event.description ?? '']
    .join('\n')
    .toLowerCase();
  return haystack.includes(keyword);
}

/** 忙闲计算：把所有事件转成忙碌块，并合并重叠区间。 */
export function computeBusy(events: readonly CalendarEvent[], zonePort: ZonePort): BusyResult {
  const blocks: BusyBlock[] = [];
  const undetermined: string[] = [];

  for (const event of events) {
    const range = eventRange(event.time, zonePort);
    if (range === null) {
      undetermined.push(event.id);
      continue;
    }
    blocks.push({
      eventId: event.id,
      title: event.title,
      startMs: range.startMs,
      endMs: range.endMs,
      allDay: event.time.kind === 'allDay',
    });
  }

  blocks.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last !== undefined && block.startMs <= last.endMs) {
      if (block.endMs > last.endMs) merged[merged.length - 1] = { startMs: last.startMs, endMs: block.endMs };
      continue;
    }
    merged.push({ startMs: block.startMs, endMs: block.endMs });
  }

  return { blocks, merged, undetermined };
}

export interface ConflictReport {
  /** 与目标冲突的既有事件。 */
  readonly conflicts: readonly BusyBlock[];
  /** 目标区间本身无法确定时为 true（此时不给出"无冲突"的结论）。 */
  readonly undetermined: boolean;
  readonly reason: string | null;
}

/**
 * 检测目标事件与既有事件的冲突。
 *
 * **不把"算不出来"当成"没有冲突"**：目标区间无法确定时返回 `undetermined: true`
 * 且 `conflicts` 为空——调用方必须如实展示"无法判断"，而不是"无冲突"。
 */
export function findConflicts(
  target: CalendarEvent,
  existing: readonly CalendarEvent[],
  zonePort: ZonePort,
  authorizedCalendarIds?: readonly string[],
): ConflictReport {
  const targetRange = eventRange(target.time, zonePort);
  if (targetRange === null) {
    return {
      conflicts: [],
      undetermined: true,
      reason: `目标事件时间无法确定（时区未知或日期非法）：${target.time.zoneId}`,
    };
  }
  const authorized =
    authorizedCalendarIds === undefined ? null : new Set(authorizedCalendarIds);

  const conflicts: BusyBlock[] = [];
  for (const event of existing) {
    if (event.id === target.id) continue;
    if (authorized !== null && !authorized.has(event.calendarId)) continue;
    const range = eventRange(event.time, zonePort);
    if (range === null) continue;
    if (overlaps(targetRange, range)) {
      conflicts.push({
        eventId: event.id,
        title: event.title,
        startMs: range.startMs,
        endMs: range.endMs,
        allDay: event.time.kind === 'allDay',
      });
    }
  }
  conflicts.sort((a, b) => a.startMs - b.startMs);
  return { conflicts, undetermined: false, reason: null };
}

/** 展示用：`YYYY-MM-DD HH:MM–HH:MM`（不本地化，纪律禁用 toLocaleString）。 */
export function formatRange(range: InstantRange, zoneId: string, zonePort: ZonePort): string {
  const offset = zonePort.offsetMinutesAt(zoneId, range.startMs);
  if (offset === null) return `${String(range.startMs)}–${String(range.endMs)}（时区未知）`;
  const start = epochToWall(range.startMs, offset);
  const end = epochToWall(range.endMs, offset);
  return (
    `${formatDate(start)} ${pad(start.hour)}:${pad(start.minute)}` +
    `–${formatDate(end)} ${pad(end.hour)}:${pad(end.minute)}`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
