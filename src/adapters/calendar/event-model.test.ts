/**
 * CAL-03 / CAL-04 用例：事件构造、**全天与跨天/跨时区语义**、提醒的增删改与数量·方式校验，
 * 以及"**实际写入并读回**"（端口注入 / 无端口结构化未就绪）。
 */

import { describe, expect, it } from 'vitest';

import { wallToEpoch } from '../clock/civil.js';
import { createFixedZonePort } from '../clock/zone.js';
import {
  DEFAULT_MAX_REMINDERS,
  allDayRangeDiffersAcrossZones,
  allDayTime,
  buildEvent,
  createEvent,
  daySpan,
  durationOf,
  planReminders,
  previewValidation,
  projectTimeInZone,
} from './event-model.js';
import type { CalendarAccess, CalendarWritePort, Reminder } from './handoff.js';
import type { CalendarEvent } from './types.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const HOUR = 3_600_000;
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);

const ACCESS: CalendarAccess = {
  granted: ['read', 'write'],
  calendars: [{ id: 'primary', displayName: '主日历', writable: true, accountId: 'acc-1' }],
};

function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
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

describe('CAL-03：事件构造与全天语义', () => {
  it('从草稿构造：省略项取"无"，合规即产出', () => {
    const result = buildEvent(
      { id: 'e1', calendarId: 'primary', title: '评审', time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'UTC' } },
      ZONES,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.location).toBeNull();
      expect(result.event.description).toBeNull();
      expect(result.event.attendees).toEqual([]);
      expect(result.event.recurrence).toBeNull();
      expect(result.event.revision).toBe(1);
    }
  });

  it('【反向对照】不合规草稿**不产出**事件，只回问题清单', () => {
    const result = buildEvent(
      { id: 'e1', calendarId: 'primary', title: '   ', time: { kind: 'timed', startMs: T, endMs: T, zoneId: 'UTC' } },
      ZONES,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContain('标题不得为空');
      expect(result.problems).toContain('结束必须晚于开始');
    }
  });

  it('全天时间：排他端点 = 起始日 + N 天，跨月/跨年正确', () => {
    expect(allDayTime('2026-08-01', 1, 'UTC')).toEqual({
      kind: 'allDay',
      startDate: '2026-08-01',
      endDateExclusive: '2026-08-02',
      zoneId: 'UTC',
    });
    expect(allDayTime('2026-08-30', 3, 'UTC')?.endDateExclusive).toBe('2026-09-02');
    expect(allDayTime('2026-12-31', 1, 'UTC')?.endDateExclusive).toBe('2027-01-01');
  });

  it('【反向对照】全天天数非正整数 / 日期非法 ⇒ null（不默认 1 天）', () => {
    expect(allDayTime('2026-08-01', 0, 'UTC')).toBeNull();
    expect(allDayTime('2026-08-01', -3, 'UTC')).toBeNull();
    expect(allDayTime('2026-08-01', 1.5, 'UTC')).toBeNull();
    expect(allDayTime('2026-02-30', 1, 'UTC')).toBeNull();
  });

  it('跨天语义：多天全天 = 多日；定时按**排他**端点判末日', () => {
    const allDay = allDayTime('2026-08-01', 3, 'UTC') as CalendarEvent['time'];
    expect(daySpan(allDay, 'UTC', ZONES)).toEqual({
      days: 3,
      startLocalDate: '2026-08-01',
      endLocalDateInclusive: '2026-08-03',
    });

    const withinDay = timedEvent({ time: { kind: 'timed', startMs: T, endMs: T + 2 * HOUR, zoneId: 'UTC' } });
    expect(daySpan(withinDay.time, 'UTC', ZONES)?.days).toBe(1);

    const overnight = timedEvent({
      time: {
        kind: 'timed',
        startMs: wallToEpoch({ year: 2026, month: 8, day: 1, hour: 23, minute: 0, second: 0 }, 0),
        endMs: wallToEpoch({ year: 2026, month: 8, day: 2, hour: 1, minute: 0, second: 0 }, 0),
        zoneId: 'UTC',
      },
    });
    expect(daySpan(overnight.time, 'UTC', ZONES)?.days).toBe(2);

    // **排他端点**：到次日 00:00 恰好结束 ⇒ 只占 1 天。
    const toMidnight = timedEvent({
      time: {
        kind: 'timed',
        startMs: wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0),
        endMs: wallToEpoch({ year: 2026, month: 8, day: 2, hour: 0, minute: 0, second: 0 }, 0),
        zoneId: 'UTC',
      },
    });
    expect(daySpan(toMidnight.time, 'UTC', ZONES)?.days).toBe(1);
  });

  it('【反向对照】跨天判定遇到未知时区 ⇒ null（不猜）', () => {
    expect(daySpan(allDayTime('2026-08-01', 1, 'Mars/Base') as CalendarEvent['time'], 'Mars/Base', ZONES)).toBeNull();
    const bad = timedEvent({ time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'Mars/Base' } });
    expect(daySpan(bad.time, 'Mars/Base', ZONES)).toBeNull();
  });

  it('跨时区：定时事件换时区**不改变绝对时长**，只改墙上表示', () => {
    const utc = projectTimeInZone(timedEvent().time, 'UTC', ZONES);
    const shanghai = projectTimeInZone(timedEvent().time, 'Asia/Shanghai', ZONES);
    expect(utc?.durationMs).toBe(HOUR);
    expect(shanghai?.durationMs).toBe(HOUR);
    expect(utc?.startWall).toEqual({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 });
    expect(shanghai?.startWall).toEqual({ year: 2026, month: 8, day: 1, hour: 17, minute: 0, second: 0 });
  });

  it('跨时区：全天事件的**绝对区间**随"当地 0 点"改变', () => {
    const allDay = allDayTime('2026-08-01', 1, 'UTC') as Extract<CalendarEvent['time'], { kind: 'allDay' }>;
    expect(allDayRangeDiffersAcrossZones(allDay, 'Asia/Shanghai', ZONES)).toBe(true);
    expect(allDayRangeDiffersAcrossZones(allDay, 'UTC', ZONES)).toBe(false);
  });

  it('【反向对照】未知时区 ⇒ 投影为 null（不用 UTC 顶替）', () => {
    expect(projectTimeInZone(timedEvent().time, 'Mars/Base', ZONES)).toBeNull();
  });
});

describe('CAL-04：提醒的设置 / 修改 / 删除与校验', () => {
  const base: readonly Reminder[] = [{ minutesBefore: 10, method: 'notification' }];

  it('设置 / 新增 / 删除 / 修改', () => {
    expect(planReminders([], { kind: 'set', reminders: base }).reminders).toEqual(base);
    const added = planReminders(base, { kind: 'add', reminder: { minutesBefore: 30, method: 'email' } });
    expect(added.ok).toBe(true);
    expect(added.reminders).toHaveLength(2);

    const removed = planReminders(added.reminders, { kind: 'remove', index: 0 });
    expect(removed.reminders).toEqual([{ minutesBefore: 30, method: 'email' }]);

    const updated = planReminders(base, {
      kind: 'update',
      index: 0,
      reminder: { minutesBefore: 5, method: 'notification' },
    });
    expect(updated.reminders).toEqual([{ minutesBefore: 5, method: 'notification' }]);
  });

  it('【反向对照】删除越界 ⇒ 失败且**返回原集合**（不改动既有提醒）', () => {
    const result = planReminders(base, { kind: 'remove', index: 5 });
    expect(result.ok).toBe(false);
    expect(result.reminders).toEqual(base);
    expect(result.problems.join()).toMatch(/越界/);
  });

  it('【反向对照】提前量为负 / 非整数 ⇒ 失败并保留原集合', () => {
    const result = planReminders(base, { kind: 'add', reminder: { minutesBefore: -1, method: 'notification' } });
    expect(result.ok).toBe(false);
    expect(result.reminders).toEqual(base);
  });

  it('【反向对照】不支持的提醒方式 ⇒ 失败（给定了可用方式表时）', () => {
    const result = planReminders(base, { kind: 'add', reminder: { minutesBefore: 5, method: 'sms' } }, {
      availableMethods: ['notification', 'email'],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/不支持/);
  });

  it('【反向对照】数量超上限 ⇒ 失败并**明示上限需真机核对**', () => {
    const many: readonly Reminder[] = Array.from({ length: DEFAULT_MAX_REMINDERS + 1 }, () => ({
      minutesBefore: 5,
      method: 'notification' as const,
    }));
    const result = planReminders([], { kind: 'set', reminders: many });
    expect(result.ok).toBe(false);
    expect(result.countExceeded).toBe(true);
    expect(result.problems.join()).toMatch(/真机核对/);
    expect(result.reminders).toEqual([]);
  });

  it('未给定可用方式表 ⇒ 只做形状校验并**如实标注"方式未核实"**', () => {
    const result = planReminders(base, { kind: 'add', reminder: { minutesBefore: 5, method: 'sms' } });
    expect(result.ok).toBe(true);
    expect(result.methodAvailabilityUnverified).toBe(true);
    const verified = planReminders(base, { kind: 'add', reminder: { minutesBefore: 5, method: 'sms' } }, {
      availableMethods: ['notification', 'email', 'sms'],
    });
    expect(verified.methodAvailabilityUnverified).toBe(false);
  });
});

describe('CAL-04：写入目标并读回', () => {
  const writer = (readback: CalendarEvent | null): CalendarWritePort => ({
    insertEvent: () => Promise.resolve({ ok: true, eventId: 'evt-1' }),
    readBack: () => Promise.resolve(readback),
    saveAttendees: () => Promise.resolve(),
  });

  it('【正向】装配端口且读回一致 ⇒ 已确认完成', async () => {
    const event = timedEvent();
    const outcome = await createEvent(writer(event), ACCESS, event, ZONES);
    expect(outcome.ready).toBe(true);
    if (outcome.ready) {
      expect(outcome.result.state).toBe('confirmed');
      expect(outcome.result.receipt.kind).toBe('readback');
    }
  });

  it('【反向对照】读回不一致 ⇒ 结果未知，**不得**报完成', async () => {
    const outcome = await createEvent(writer(timedEvent({ title: '别的会' })), ACCESS, timedEvent(), ZONES);
    expect(outcome.ready).toBe(true);
    if (outcome.ready) expect(outcome.result.state).toBe('unknown');
  });

  it('【反向对照】未装配端口 ⇒ 结构化未就绪（不抛异常，也不冒充已创建）', async () => {
    const outcome = await createEvent(undefined, ACCESS, timedEvent(), ZONES);
    expect(outcome.ready).toBe(false);
    if (!outcome.ready) {
      expect(outcome.reason).toMatch(/未装配/);
      expect(outcome.note).toMatch(/未验证|真机/);
    }
  });

  it('写入前预览校验与时长（透传既有实现）', () => {
    expect(previewValidation(timedEvent(), ZONES).ok).toBe(true);
    expect(durationOf(timedEvent().time, ZONES)).toBe(HOUR);
  });
});
