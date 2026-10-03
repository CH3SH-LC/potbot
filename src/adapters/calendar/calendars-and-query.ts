/**
 * CAL-01 / CAL-02：**获准日历目录**、目标日历与账号选择，以及**查询 / 忙闲 / 冲突**。
 *
 * ## 本模块相对既有 `handoff.ts` / `conflict.ts` 补的是什么
 *
 * - `handoff.checkCalendarAccess` 只回答"某日历的一次读/写**是否**被允许"。CAL-01 还要
 *   **把获准目录读出来**（在哪个账号下、哪些可写、账号有哪些），并能**从授权面派生**
 *   查询白名单——而不是由调用方随手传一个 `authorizedCalendarIds`。
 * - `conflict.queryEvents` 要求调用方**显式**给白名单。本模块的
 *   {@link queryWithinAccess} 把白名单**从 `CalendarAccess` 派生**，因此"顺带读未授权账号"
 *   在**接口形状上**就做不到（调用方没有那个入参）。
 *
 * ## 如实声明（不得编造）
 *
 * - **真实读取日历目录**需要 `READ_CALENDAR` 运行时权限与真机 provider。
 *   未装配 {@link CalendarDirectoryPort} 时返回**结构化未就绪**（不抛、不返空目录冒充
 *   "没有日历"）。**真机侧未验证（需真机）**。
 * - 授权撤回后的**实际 provider 行为**只能在设备上核实；本模块只实现"拿到新的授权面后
 *   按新授权面判定"的**判定逻辑**。
 *
 * ## 交付说明
 *
 * 子智能体模型身份**未确认为 DS**；本文件为在 `fa/calendar-core` 工作树内**新增**。
 */

import { civilFromDays, daysFromCivil, formatDate, parseDate } from '../clock/civil.js';
import { zoneToInstant, type ZonePort } from '../clock/zone.js';
import {
  computeBusy,
  findConflicts,
  queryEvents,
  type BusyResult,
  type ConflictReport,
  type QueryOptions,
  type QueryResult,
} from './conflict.js';
import type { InstantRange } from './event.js';
import {
  checkCalendarAccess,
  type CalendarAccess,
  type CalendarInfo,
  type CalendarPermission,
} from './handoff.js';
import type { CalendarEvent } from './types.js';

/** 日历一天的毫秒数（`dayWindow` 用；与 `civil.MS_PER_DAY` 同值，不重复导出）。 */
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// CAL-01：获准目录（账号 / 可写性 / 读取授权）
// ---------------------------------------------------------------------------

export interface CalendarListingFilter {
  /** 只看可写日历（选写入目标用）。 */
  readonly writableOnly?: boolean;
  /** 只看某账号下的日历。 */
  readonly accountId?: string;
}

/**
 * 列出**获准**日历。
 *
 * **无读授权 ⇒ 返回空列表**：授权被撤回后目录自然为空，而不是"照旧列出"。
 * 调用方若要区分"没授权"与"确实没有日历"，用 {@link directoryView} 的 `readGranted`。
 */
export function listCalendars(
  access: CalendarAccess,
  filter: CalendarListingFilter = {},
): readonly CalendarInfo[] {
  if (!access.granted.includes('read')) return [];
  let list: readonly CalendarInfo[] = access.calendars;
  if (filter.accountId !== undefined) {
    list = list.filter((calendar) => calendar.accountId === filter.accountId);
  }
  if (filter.writableOnly === true) {
    list = list.filter((calendar) => calendar.writable);
  }
  return list;
}

/** 授权目录里的账号（去重、稳定排序）；无读授权时为空。 */
export function listAccounts(access: CalendarAccess): readonly string[] {
  if (!access.granted.includes('read')) return [];
  const accounts = new Set<string>();
  for (const calendar of access.calendars) accounts.add(calendar.accountId);
  return [...accounts].sort();
}

export interface CalendarDirectoryView {
  readonly readGranted: boolean;
  readonly calendars: readonly CalendarInfo[];
  readonly accounts: readonly string[];
}

/** 目录视图：把"是否有读授权"与"有哪些日历"分开如实给出。 */
export function directoryView(access: CalendarAccess): CalendarDirectoryView {
  return {
    readGranted: access.granted.includes('read'),
    calendars: listCalendars(access),
    accounts: listAccounts(access),
  };
}

export type TargetSelection =
  | { readonly ok: true; readonly calendar: CalendarInfo }
  | { readonly ok: false; readonly reason: string };

/**
 * 选定目标日历（CAL-01：不可写日历 / 无权限 / 不在授权目录都要给出**可展示的原因**）。
 *
 * 复用 `handoff.checkCalendarAccess` 的判定，再补上"命中的日历对象"（含所属账号）。
 */
export function selectTargetCalendar(
  access: CalendarAccess,
  calendarId: string,
  need: CalendarPermission,
): TargetSelection {
  const check = checkCalendarAccess(access, calendarId, need);
  if (!check.ok) return { ok: false, reason: check.reason };
  const calendar = access.calendars.find((candidate) => candidate.id === calendarId);
  if (calendar === undefined) {
    return { ok: false, reason: `日历不在已授权目录中：${calendarId}` };
  }
  return { ok: true, calendar };
}

// ---------------------------------------------------------------------------
// CAL-01：目录端口（真机读取；无端口 ⇒ 结构化未就绪）
// ---------------------------------------------------------------------------

/** 读取平台日历目录与**当前**授权面的端口（由宿主 / Android 侧装配）。 */
export interface CalendarDirectoryPort {
  listCalendars(): Promise<readonly CalendarInfo[]>;
  /** **当前**授权（每次读取都问一次，以覆盖"授权被撤回"）。 */
  currentGrants(): Promise<readonly CalendarPermission[]>;
}

export type DirectoryReadResult =
  | { readonly ready: true; readonly access: CalendarAccess }
  | { readonly ready: false; readonly reason: string; readonly note: string };

/**
 * 读取授权面 + 目录。
 *
 * **未装配端口 ⇒ 结构化未就绪**（返回 `ready:false`，不抛、不返 `{granted:[]}` 冒充
 * "用户没给任何日历"）。真实 provider 行为**真机侧未验证（需真机）**。
 */
export async function readCalendarDirectory(
  port: CalendarDirectoryPort | undefined,
): Promise<DirectoryReadResult> {
  if (port === undefined) {
    return {
      ready: false,
      reason: '未装配日历目录端口（CalendarDirectoryPort）',
      note:
        '真实读取日历目录需要 READ_CALENDAR 运行时权限与真机 provider；' +
        '无端口时**不假读**、也不返回空目录冒充"没有日历"。真机侧未验证（需真机）。',
    };
  }
  const [calendars, granted] = await Promise.all([port.listCalendars(), port.currentGrants()]);
  return { ready: true, access: { granted, calendars } };
}

// ---------------------------------------------------------------------------
// CAL-02：显式区间 + 授权面派生白名单
// ---------------------------------------------------------------------------

/**
 * 从授权面派生可查询的日历 id 集合（CAL-02「**不假读未授权账号**」的落点）。
 *
 * `need='read'` ⇒ 全部获准日历；`need='write'` ⇒ 仅可写日历。
 * 无对应授权 ⇒ 空集（查询随即退化为"零结果 + 全部计为越权排除"）。
 */
export function authorizedCalendarIds(
  access: CalendarAccess,
  need: CalendarPermission = 'read',
): readonly string[] {
  if (!access.granted.includes(need)) return [];
  return access.calendars
    .filter((calendar) => need === 'read' || calendar.writable)
    .map((calendar) => calendar.id);
}

/** `YYYY-MM-DD` 在 `zoneId` 下的**当地自然日**区间 `[00:00, 次日 00:00)`；非法/未知时区 ⇒ null。 */
export function dayWindow(date: string, zoneId: string, zonePort: ZonePort): InstantRange | null {
  const parsed = parseDate(date);
  if (parsed === null) return null;
  const next = civilFromDays(daysFromCivil(parsed.year, parsed.month, parsed.day) + 1);
  const startMs = zoneToInstant(zonePort, zoneId, { ...parsed, hour: 0, minute: 0, second: 0 });
  const endMs = zoneToInstant(zonePort, zoneId, {
    year: next.year,
    month: next.month,
    day: next.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

export interface AccessQueryOptions {
  /** 查询区间（**必须显式**，CAL-02「时间范围明确」）。 */
  readonly fromMs: number;
  readonly toMs: number;
  readonly keyword?: string;
}

export type AccessQueryResult =
  | { readonly ok: true; readonly result: QueryResult }
  | { readonly ok: false; readonly reason: string };

/**
 * 在**授权面内**查询。
 *
 * 白名单由 `access` 派生——调用方**没有**传白名单的入参，因此不可能"顺带查出未授权账号"。
 * 无读授权 ⇒ 结构化拒绝（不是"查到 0 条"）。区间非法 ⇒ 由 `queryEvents` 抛出
 * （CAL-02：范围必须明确，不猜测）。
 */
export function queryWithinAccess(
  access: CalendarAccess,
  events: readonly CalendarEvent[],
  zonePort: ZonePort,
  options: AccessQueryOptions,
): AccessQueryResult {
  if (!access.granted.includes('read')) {
    return { ok: false, reason: '未获得读取日历的授权：拒绝查询（不假读未授权账号，CAL-02）' };
  }
  const queryOptions: QueryOptions = {
    fromMs: options.fromMs,
    toMs: options.toMs,
    authorizedCalendarIds: authorizedCalendarIds(access, 'read'),
    ...(options.keyword === undefined ? {} : { keyword: options.keyword }),
  };
  return { ok: true, result: queryEvents(events, zonePort, queryOptions) };
}

export interface DayQueryOptions {
  readonly date: string;
  readonly zoneId: string;
  readonly keyword?: string;
}

/** 按**当地自然日**查询（把日期换成显式区间后再走 {@link queryWithinAccess}）。 */
export function queryDayWithinAccess(
  access: CalendarAccess,
  events: readonly CalendarEvent[],
  zonePort: ZonePort,
  options: DayQueryOptions,
): AccessQueryResult {
  const window = dayWindow(options.date, options.zoneId, zonePort);
  if (window === null) {
    return { ok: false, reason: `日期非法或时区未知，无法确定当天区间：${options.date} @ ${options.zoneId}` };
  }
  return queryWithinAccess(access, events, zonePort, {
    fromMs: window.startMs,
    toMs: window.endMs,
    ...(options.keyword === undefined ? {} : { keyword: options.keyword }),
  });
}

export type AccessBusyResult =
  | { readonly ok: true; readonly busy: BusyResult }
  | { readonly ok: false; readonly reason: string };

/** 授权面内的忙闲。 */
export function busyWithinAccess(
  access: CalendarAccess,
  events: readonly CalendarEvent[],
  zonePort: ZonePort,
): AccessBusyResult {
  if (!access.granted.includes('read')) {
    return { ok: false, reason: '未获得读取日历的授权：无法计算忙闲' };
  }
  const allowed = new Set(authorizedCalendarIds(access, 'read'));
  return { ok: true, busy: computeBusy(events.filter((event) => allowed.has(event.calendarId)), zonePort) };
}

export type AccessConflictResult =
  | { readonly ok: true; readonly report: ConflictReport }
  | { readonly ok: false; readonly reason: string };

/** 授权面内的冲突检测（只拿获准日历做对照，避免用越权数据判断"没冲突"）。 */
export function conflictsWithinAccess(
  access: CalendarAccess,
  target: CalendarEvent,
  existing: readonly CalendarEvent[],
  zonePort: ZonePort,
): AccessConflictResult {
  if (!access.granted.includes('read')) {
    return { ok: false, reason: '未获得读取日历的授权：无法判定冲突' };
  }
  return {
    ok: true,
    report: findConflicts(target, existing, zonePort, authorizedCalendarIds(access, 'read')),
  };
}

/** 两个绝对区间是否重叠（半开区间）；供调用方自检，语义与 `conflict.overlaps` 一致。 */
export function windowsOverlap(a: InstantRange, b: InstantRange): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** 供展示：绝对时刻 → 某偏移下的 `YYYY-MM-DD`（不本地化，纪律禁用 toLocaleString）。 */
export function localDateOf(instantMs: number, offsetMinutes: number): string {
  const days = Math.floor((instantMs + offsetMinutes * 60_000) / MS_PER_DAY);
  return formatDate(civilFromDays(days));
}
