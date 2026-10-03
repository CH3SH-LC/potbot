/**
 * CAL-01 / CAL-02 用例：**获准日历目录**、目标日历与账号选择，以及
 * **查询 / 忙闲 / 冲突**（时间范围明确、不假读未授权账号）。
 *
 * 时区为固定偏移表 ⇒ 全部断言可复现；**不涉及真机**（真实目录读取标未验证）。
 */

import { describe, expect, it } from 'vitest';

import { wallToEpoch } from '../clock/civil.js';
import { createFixedZonePort } from '../clock/zone.js';
import {
  authorizedCalendarIds,
  busyWithinAccess,
  conflictsWithinAccess,
  dayWindow,
  directoryView,
  listAccounts,
  listCalendars,
  localDateOf,
  queryDayWithinAccess,
  queryWithinAccess,
  readCalendarDirectory,
  selectTargetCalendar,
  windowsOverlap,
  type CalendarDirectoryPort,
} from './calendars-and-query.js';
import type { CalendarAccess, CalendarInfo } from './handoff.js';
import type { CalendarEvent } from './types.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);

const CALENDARS: readonly CalendarInfo[] = [
  { id: 'primary', displayName: '主日历', writable: true, accountId: 'acc-1' },
  { id: 'holidays', displayName: '节假日', writable: false, accountId: 'acc-2' },
  { id: 'work', displayName: '工作', writable: true, accountId: 'acc-1' },
];

const ACCESS: CalendarAccess = { granted: ['read', 'write'], calendars: CALENDARS };

function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    calendarId: 'primary',
    title: '站会',
    time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'UTC' },
    location: null,
    description: null,
    attendees: [],
    recurrence: null,
    revision: 1,
    ...overrides,
  };
}

describe('CAL-01：获准日历目录与目标选择', () => {
  it('只列出获准目录，可按可写性与账号筛选', () => {
    expect(listCalendars(ACCESS).map((calendar) => calendar.id)).toEqual(['primary', 'holidays', 'work']);
    expect(listCalendars(ACCESS, { writableOnly: true }).map((calendar) => calendar.id)).toEqual([
      'primary',
      'work',
    ]);
    expect(listCalendars(ACCESS, { accountId: 'acc-1' }).map((calendar) => calendar.id)).toEqual([
      'primary',
      'work',
    ]);
  });

  it('账号去重且稳定排序', () => {
    expect(listAccounts(ACCESS)).toEqual(['acc-1', 'acc-2']);
  });

  it('【反向对照】读授权被撤回 ⇒ 目录为空，而不是"照旧列出"', () => {
    const revoked: CalendarAccess = { granted: [], calendars: CALENDARS };
    expect(listCalendars(revoked)).toEqual([]);
    expect(listAccounts(revoked)).toEqual([]);
    expect(directoryView(revoked).readGranted).toBe(false);
    // 对照：授权仍在时确实列得出来（证明上一条不是"永远为空"的假象）。
    expect(directoryView(ACCESS).readGranted).toBe(true);
    expect(listCalendars(ACCESS).length).toBe(3);
  });

  it('目标选择区分：可写 / 只读 / 不在目录 / 无写权限', () => {
    expect(selectTargetCalendar(ACCESS, 'primary', 'write').ok).toBe(true);
    expect(selectTargetCalendar(ACCESS, 'holidays', 'write').ok).toBe(false);
    expect(selectTargetCalendar(ACCESS, 'missing', 'read').ok).toBe(false);
    expect(selectTargetCalendar({ granted: ['read'], calendars: CALENDARS }, 'primary', 'write').ok).toBe(false);
    const wrongAccount = selectTargetCalendar({ granted: ['read'], calendars: CALENDARS }, 'holidays', 'read');
    expect(wrongAccount.ok).toBe(true);
    if (wrongAccount.ok) expect(wrongAccount.calendar.accountId).toBe('acc-2');
  });

  it('【正向】装配端口后可读出目录与**当前**授权面', async () => {
    const port: CalendarDirectoryPort = {
      listCalendars: () => Promise.resolve(CALENDARS),
      currentGrants: () => Promise.resolve(['read', 'write']),
    };
    const result = await readCalendarDirectory(port);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.access.calendars.length).toBe(3);
      expect(result.access.granted).toEqual(['read', 'write']);
    }
  });

  it('【反向对照】未装配端口 ⇒ 结构化未就绪（不抛、不返空目录冒充"没有日历"）', async () => {
    const result = await readCalendarDirectory(undefined);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.reason).toMatch(/未装配/);
      expect(result.note).toMatch(/真机|未验证/);
    }
  });

  it('【反向对照】端口报告写权限被撤回 ⇒ 写目标不再可选', async () => {
    const port: CalendarDirectoryPort = {
      listCalendars: () => Promise.resolve(CALENDARS),
      currentGrants: () => Promise.resolve(['read']),
    };
    const result = await readCalendarDirectory(port);
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(selectTargetCalendar(result.access, 'primary', 'write').ok).toBe(false);
      expect(selectTargetCalendar(result.access, 'primary', 'read').ok).toBe(true);
    }
  });
});

describe('CAL-02：显式区间、忙闲、冲突', () => {
  const events: readonly CalendarEvent[] = [
    timedEvent({ id: 'a', calendarId: 'primary' }),
    timedEvent({
      id: 'b',
      calendarId: 'work',
      time: { kind: 'timed', startMs: T + 30 * 60_000, endMs: T + 90 * 60_000, zoneId: 'UTC' },
    }),
    timedEvent({
      id: 'secret',
      calendarId: 'other-unauthorized',
      time: { kind: 'timed', startMs: T + 30 * 60_000, endMs: T + 90 * 60_000, zoneId: 'UTC' },
    }),
  ];

  it('授权面派生的白名单不含未授权日历', () => {
    expect(authorizedCalendarIds(ACCESS)).toEqual(['primary', 'holidays', 'work']);
    // 写白名单只含可写日历；无写授权 ⇒ 空集（而不是"给出可写日历却其实写不了"）。
    expect(authorizedCalendarIds(ACCESS, 'write')).toEqual(['primary', 'work']);
    expect(authorizedCalendarIds({ granted: ['read'], calendars: CALENDARS }, 'write')).toEqual([]);
  });

  it('【反向对照】**不假读未授权账号**：白名单外的事件被排除并计数', () => {
    const result = queryWithinAccess(ACCESS, events, ZONES, {
      fromMs: T - HOUR,
      toMs: T + 3 * HOUR,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.events.map((event) => event.id)).toEqual(['a', 'b']);
      expect(result.result.excludedUnauthorized).toBe(1);
      // 对照：未授权事件确实存在（证明它是"被过滤"而不是"本来就没有"）。
      expect(events.some((event) => event.id === 'secret')).toBe(true);
    }
  });

  it('关键词按标题/地点/描述匹配（大小写不敏感）', () => {
    const pool = [timedEvent({ id: 'x', title: 'Dentist', description: 'scale teeth' })];
    const result = queryWithinAccess(ACCESS, pool, ZONES, {
      fromMs: T - HOUR,
      toMs: T + 3 * HOUR,
      keyword: 'dentist',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.events.map((event) => event.id)).toEqual(['x']);
  });

  it('【反向对照】无读授权 ⇒ 结构化拒绝（不是"查到 0 条"）', () => {
    const revoked: CalendarAccess = { granted: ['write'], calendars: CALENDARS };
    const result = queryWithinAccess(revoked, events, ZONES, { fromMs: T - HOUR, toMs: T + HOUR });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/不假读|未获得读取/);
  });

  it('【反向对照】区间不明确（toMs ≤ fromMs）⇒ 抛错，不猜一个默认区间', () => {
    expect(() => queryWithinAccess(ACCESS, events, ZONES, { fromMs: T, toMs: T })).toThrow(/toMs > fromMs/);
  });

  it('当地自然日窗口：UTC 与 Asia/Shanghai 起点不同', () => {
    const utc = dayWindow('2026-08-01', 'UTC', ZONES);
    const shanghai = dayWindow('2026-08-01', 'Asia/Shanghai', ZONES);
    expect(utc).toEqual({
      startMs: wallToEpoch({ year: 2026, month: 8, day: 1, hour: 0, minute: 0, second: 0 }, 0),
      endMs: wallToEpoch({ year: 2026, month: 8, day: 2, hour: 0, minute: 0, second: 0 }, 0),
    });
    // 上海 8/1 00:00 = 7/31 16:00Z；次日同刻 = 8/1 16:00Z。
    expect(shanghai?.startMs).toBe(wallToEpoch({ year: 2026, month: 7, day: 31, hour: 16, minute: 0, second: 0 }, 0));
    expect(shanghai?.endMs).toBe((shanghai?.startMs ?? 0) + DAY);
    expect(utc?.startMs).not.toBe(shanghai?.startMs);
  });

  it('【反向对照】时区未知 ⇒ 当天窗口为 null（不用 UTC 顶替）', () => {
    expect(dayWindow('2026-08-01', 'Mars/Base', ZONES)).toBeNull();
    expect(dayWindow('not-a-date', 'UTC', ZONES)).toBeNull();
  });

  it('按当地日查询：跨时区的边界事件被正确归属', () => {
    // 2026-07-31 20:00Z = 上海 2026-08-01 04:00 ⇒ 属"上海 8/1"，不属"UTC 8/1"。
    const boundary = timedEvent({
      id: 'boundary',
      time: {
        kind: 'timed',
        startMs: wallToEpoch({ year: 2026, month: 7, day: 31, hour: 20, minute: 0, second: 0 }, 0),
        endMs: wallToEpoch({ year: 2026, month: 7, day: 31, hour: 21, minute: 0, second: 0 }, 0),
        zoneId: 'UTC',
      },
    });
    const inShanghai = queryDayWithinAccess(ACCESS, [boundary], ZONES, {
      date: '2026-08-01',
      zoneId: 'Asia/Shanghai',
    });
    const inUtc = queryDayWithinAccess(ACCESS, [boundary], ZONES, { date: '2026-08-01', zoneId: 'UTC' });
    expect(inShanghai.ok && inShanghai.result.events.map((event) => event.id)).toEqual(['boundary']);
    expect(inUtc.ok && inUtc.result.events).toEqual([]);
  });

  it('【反向对照】查询日非法 ⇒ 结构化拒绝', () => {
    const result = queryDayWithinAccess(ACCESS, events, ZONES, { date: '2026-13-40', zoneId: 'UTC' });
    expect(result.ok).toBe(false);
  });

  it('忙闲：合并重叠区间且**排除**未授权日历的事件', () => {
    const busy = busyWithinAccess(ACCESS, events, ZONES);
    expect(busy.ok).toBe(true);
    if (busy.ok) {
      expect(busy.busy.blocks.map((block) => block.eventId)).toEqual(['a', 'b']);
      expect(busy.busy.merged).toHaveLength(1);
      expect(busy.busy.merged[0]).toEqual({ startMs: T, endMs: T + 90 * 60_000 });
    }
  });

  it('【反向对照】无读授权 ⇒ 忙闲结构化拒绝', () => {
    const revoked: CalendarAccess = { granted: ['write'], calendars: CALENDARS };
    expect(busyWithinAccess(revoked, events, ZONES).ok).toBe(false);
  });

  it('冲突检测：只拿获准日历做对照（越权事件不参与判定）', () => {
    const target = timedEvent({ id: 'a' });
    const report = conflictsWithinAccess(ACCESS, target, events, ZONES);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.report.undetermined).toBe(false);
      expect(report.report.conflicts.map((entry) => entry.eventId)).toEqual(['b']);
    }
    // 反向对照：把授权面缩到只剩 primary ⇒ 与 work 的冲突不再可见（但也不谎报"没冲突"以外的东西）。
    const narrow: CalendarAccess = { granted: ['read'], calendars: [CALENDARS[0] as CalendarInfo] };
    const narrowed = conflictsWithinAccess(narrow, target, events, ZONES);
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) expect(narrowed.report.conflicts).toEqual([]);
  });

  it('区间重叠为半开区间（首尾相接不算重叠）', () => {
    expect(windowsOverlap({ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 })).toBe(false);
    expect(windowsOverlap({ startMs: 0, endMs: 11 }, { startMs: 10, endMs: 20 })).toBe(true);
  });

  it('展示用本地日期换算（不本地化、可复算）', () => {
    expect(localDateOf(T, 0)).toBe('2026-08-01');
    expect(localDateOf(T, 480)).toBe('2026-08-01');
    // T = 08-01 09:00Z ⇒ 上海 17:00 同日；再推 15 小时到 08-02 00:00Z ⇒ 上海 08-02 08:00。
    expect(localDateOf(T + 15 * HOUR, 480)).toBe('2026-08-02');
  });
});
