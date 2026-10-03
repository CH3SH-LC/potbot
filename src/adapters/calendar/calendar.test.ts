/**
 * 日历域用例（CAL-01–10 的**不依赖真机**部分）。
 *
 * 时区注入固定偏移表，全部断言可复现。
 */

import { describe, expect, it } from 'vitest';

import { wallToEpoch } from '../clock/civil.js';
import { createFixedZonePort } from '../clock/zone.js';
import { allDayLengthInDays, eventRange, shiftEventTime, validateEvent } from './event.js';
import { computeBusy, findConflicts, overlaps, queryEvents } from './conflict.js';
import { expandRecurrence, planScopeEdit, scopePlanSignature } from './recur.js';
import { createEventLinkIndex } from './links.js';
import {
  checkCalendarAccess,
  createEventDirect,
  declareAttendeeSave,
  openCalendarEditor,
  planEventCopy,
  planEventDelete,
  planEventUpdate,
  validateReminders,
  type CalendarAccess,
  type CalendarWritePort,
} from './handoff.js';
import type { CalendarEvent } from './types.js';
import { CALENDAR_SUBITEMS, CALENDAR_NOT_READY } from './not-ready.js';
import { countVerdicts } from '../clock/readiness.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

const ACCESS: CalendarAccess = {
  granted: ['read', 'write'],
  calendars: [
    { id: 'primary', displayName: '主日历', writable: true, accountId: 'acc-1' },
    { id: 'holidays', displayName: '节假日', writable: false, accountId: 'acc-2' },
  ],
};

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

describe('CAL-03：事件模型与全天语义', () => {
  it('定时事件：结束必须晚于开始', () => {
    const bad = timedEvent({ time: { kind: 'timed', startMs: T, endMs: T, zoneId: 'UTC' } });
    expect(validateEvent(bad, ZONES).problems).toContain('结束必须晚于开始');
    expect(validateEvent(timedEvent(), ZONES).ok).toBe(true);
  });

  it('全天事件：端点为**排他**，至少跨 1 天', () => {
    const ok = timedEvent({
      time: { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-02', zoneId: 'UTC' },
    });
    expect(validateEvent(ok, ZONES).ok).toBe(true);
    expect(allDayLengthInDays(ok.time as never)).toBe(1);

    const sameDay = timedEvent({
      time: { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-01', zoneId: 'UTC' },
    });
    expect(validateEvent(sameDay, ZONES).problems.some((text) => text.includes('排他'))).toBe(true);
  });

  it('未知时区一律报错（不以 UTC 顶替）', () => {
    const bad = timedEvent({ time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'Mars/Base' } });
    expect(validateEvent(bad, ZONES).problems.some((text) => text.includes('时区未知'))).toBe(true);
  });

  it('全天事件归一到当地 0 点起的区间', () => {
    const event = timedEvent({
      time: { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-03', zoneId: 'Asia/Shanghai' },
    });
    const range = eventRange(event.time, ZONES);
    // 上海 8/1 00:00 = 7/31 16:00Z
    expect(range?.startMs).toBe(wallToEpoch({ year: 2026, month: 7, day: 31, hour: 16, minute: 0, second: 0 }, 0));
    expect(range?.endMs).toBe(range === null ? 0 : range.startMs + 2 * DAY);
  });

  it('改期：全天按日期平移', () => {
    const shifted = shiftEventTime(
      { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-02', zoneId: 'UTC' },
      2,
    );
    expect(shifted).toEqual({
      kind: 'allDay',
      startDate: '2026-08-03',
      endDateExclusive: '2026-08-04',
      zoneId: 'UTC',
    });
  });
});

describe('CAL-02：查询 / 忙闲 / 冲突', () => {
  const events = [
    timedEvent({ id: 'a', calendarId: 'primary' }),
    timedEvent({
      id: 'b',
      calendarId: 'primary',
      time: { kind: 'timed', startMs: T + 30 * 60_000, endMs: T + 90 * 60_000, zoneId: 'UTC' },
    }),
    timedEvent({
      id: 'c',
      calendarId: 'other-unauthorized',
      time: { kind: 'timed', startMs: T + 30 * 60_000, endMs: T + 90 * 60_000, zoneId: 'UTC' },
    }),
  ];

  it('区间必须显式给出（CAL-02：时间范围明确）', () => {
    expect(() =>
      queryEvents(events, ZONES, { fromMs: T, toMs: T, authorizedCalendarIds: ['primary'] }),
    ).toThrow(/toMs > fromMs/);
  });

  it('**不假读未授权账号**：白名单外的事件被排除并计数', () => {
    const result = queryEvents(events, ZONES, {
      fromMs: T - HOUR,
      toMs: T + 3 * HOUR,
      authorizedCalendarIds: ['primary'],
    });
    expect(result.events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(result.excludedUnauthorized).toBe(1);
  });

  it('关键词按标题/地点/描述匹配', () => {
    const withText = [timedEvent({ id: 'x', title: '牙医', description: '洗牙' })];
    const result = queryEvents(withText, ZONES, {
      fromMs: T - HOUR,
      toMs: T + 3 * HOUR,
      authorizedCalendarIds: ['primary'],
      keyword: '洗牙',
    });
    expect(result.events.map((event) => event.id)).toEqual(['x']);
  });

  it('忙闲合并重叠区间', () => {
    const busy = computeBusy([events[0] as CalendarEvent, events[1] as CalendarEvent], ZONES);
    expect(busy.merged).toHaveLength(1);
    expect(busy.merged[0]).toEqual({ startMs: T, endMs: T + 90 * 60_000 });
  });

  it('区间无法确定的事件进 undetermined，**不静默丢弃**', () => {
    // 全天事件的区间依赖时区 ⇒ 时区未知时**无法**确定（定时事件的两个端点本身是绝对时刻，不依赖时区）。
    const broken = timedEvent({
      id: 'z',
      time: { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-02', zoneId: 'Mars/Base' },
    });
    const busy = computeBusy([broken], ZONES);
    expect(busy.undetermined).toEqual(['z']);
  });

  it('半开区间：首尾相接不算重叠', () => {
    expect(overlaps({ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 })).toBe(false);
    expect(overlaps({ startMs: 0, endMs: 11 }, { startMs: 10, endMs: 20 })).toBe(true);
  });

  it('冲突检测：目标区间算不出来 ⇒ undetermined，**不**报"无冲突"', () => {
    const target = timedEvent({
      time: { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-02', zoneId: 'Mars/Base' },
    });
    const report = findConflicts(target, events, ZONES);
    expect(report.undetermined).toBe(true);
    expect(report.conflicts).toEqual([]);
    expect(report.reason).not.toBeNull();
  });

  it('冲突检测能找出重叠事件', () => {
    const report = findConflicts(timedEvent({ id: 'a' }), [events[1] as CalendarEvent], ZONES);
    expect(report.undetermined).toBe(false);
    expect(report.conflicts.map((entry) => entry.eventId)).toEqual(['b']);
  });
});

describe('CAL-05：重复展开与「本次/后续/整个系列」', () => {
  const weekly = {
    id: 'w',
    calendarId: 'primary',
    title: '周会',
    time: { kind: 'timed' as const, startMs: T, endMs: T + HOUR, zoneId: 'UTC' },
    location: null,
    description: null,
    attendees: [],
    recurrence: { freq: 'weekly' as const, interval: 1, byWeekday: [1] as const },
    revision: 1,
  };

  it('周重复：展开出各个周一', () => {
    const result = expandRecurrence(weekly.time, weekly.recurrence, ZONES, T - DAY, T + 30 * DAY);
    expect(result.reason).toBeNull();
    expect(result.occurrences.map((entry) => entry.localDate)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
  });

  it('count 限制实例数', () => {
    const result = expandRecurrence(
      weekly.time,
      { ...weekly.recurrence, count: 2 },
      ZONES,
      T - DAY,
      T + 30 * DAY,
    );
    expect(result.occurrences).toHaveLength(2);
  });

  it('untilDate 截断', () => {
    const result = expandRecurrence(
      weekly.time,
      { ...weekly.recurrence, untilDate: '2026-08-17' },
      ZONES,
      T - DAY,
      T + 30 * DAY,
    );
    expect(result.occurrences.map((entry) => entry.localDate)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ]);
  });

  it('EXDATE 排除指定实例', () => {
    const result = expandRecurrence(
      weekly.time,
      { ...weekly.recurrence, exdates: ['2026-08-10'] },
      ZONES,
      T - DAY,
      T + 30 * DAY,
    );
    expect(result.occurrences.map((entry) => entry.localDate)).not.toContain('2026-08-10');
    expect(result.occurrences).toHaveLength(4);
  });

  it('**三种编辑范围的计划形状互不相同**（不误改整组的结构性保证）', () => {
    const first = T + 2 * DAY; // 2026-08-03
    const single = planScopeEdit(weekly.time, 'this', first, ZONES);
    const following = planScopeEdit(weekly.time, 'following', first, ZONES);
    const all = planScopeEdit(weekly.time, 'all', first, ZONES);
    expect(single?.kind).toBe('single_exception');
    expect(following?.kind).toBe('split_series');
    expect(all?.kind).toBe('whole_series');
    const signatures = [single, following, all].map((plan) => scopePlanSignature(plan as never));
    expect(new Set(signatures).size).toBe(3);
  });

  it('「后续」把原系列截断到分叉点**前一天**', () => {
    const first = T + 2 * DAY;
    const plan = planScopeEdit(weekly.time, 'following', first, ZONES);
    expect(plan?.kind).toBe('split_series');
    if (plan?.kind !== 'split_series') return;
    expect(plan.headUntilLocalDate).toBe('2026-08-02');
    expect(plan.tailStartsAtMs).toBe(first);
  });

  it('时区未知 ⇒ 不给计划（不猜）', () => {
    const bad = { ...weekly.time, zoneId: 'Mars/Base' } as never;
    expect(planScopeEdit(bad, 'all', T, ZONES)).toBeNull();
  });
});

describe('CAL-08：事实变化联动', () => {
  it('只影响**登记过关联**的日程，独立日程不被误合并', () => {
    const index = createEventLinkIndex();
    index.link({ eventId: 'e1', factRef: 'people', factRevision: 1, bubbleId: 'bub-1' });
    index.link({ eventId: 'e2', factRef: 'people', factRevision: 1, bubbleId: null });
    index.link({ eventId: 'e3', factRef: 'budget', factRevision: 1, bubbleId: 'bub-3' });

    const outcome = index.onFactChanged('people', 2, [
      { eventId: 'e1', revision: 1 },
      { eventId: 'e2', revision: 1 },
      { eventId: 'e3', revision: 1 },
    ]);

    expect(outcome.affectedEventIds).toEqual(['e1', 'e2']);
    expect(outcome.expiredBubbleIds).toEqual(['bub-1']);
    expect(outcome.untouchedEventIds).toEqual(['e3']);
  });

  it('无关事实的变化不影响任何日程', () => {
    const index = createEventLinkIndex();
    index.link({ eventId: 'e1', factRef: 'people', factRevision: 1, bubbleId: 'b1' });
    const outcome = index.onFactChanged('weather', 2, [{ eventId: 'e1', revision: 1 }]);
    expect(outcome.affectedEventIds).toEqual([]);
    expect(outcome.untouchedEventIds).toEqual(['e1']);
  });
});

describe('CAL-09：授权直写与打开编辑页的上限不同', () => {
  const writer = (readback: CalendarEvent | null): CalendarWritePort => ({
    insertEvent: () => Promise.resolve({ ok: true, eventId: 'evt-1' }),
    readBack: () => Promise.resolve(readback),
    saveAttendees: () => Promise.resolve(),
  });

  it('直写 + **读回一致** ⇒ 已确认完成（且带 readback 回执）', async () => {
    const event = timedEvent({ id: 'evt-1' });
    const result = await createEventDirect(writer(event), ACCESS, event, ZONES);
    expect(result.state).toBe('confirmed');
    expect(result.receipt.kind).toBe('readback');
    expect(result.notes).toEqual([]);
  });

  it('直写但**读不回** ⇒ 结果未知，**不得**报完成', async () => {
    const event = timedEvent({ id: 'evt-1' });
    const result = await createEventDirect(writer(null), ACCESS, event, ZONES);
    expect(result.state).toBe('unknown');
    expect(result.notes.join()).toMatch(/不得.*已确认完成|结果未知/);
  });

  it('读回值与意图不一致 ⇒ 结果未知', async () => {
    const event = timedEvent({ id: 'evt-1' });
    const mismatched = timedEvent({ id: 'evt-1', title: '别的会议' });
    const result = await createEventDirect(writer(mismatched), ACCESS, event, ZONES);
    expect(result.state).toBe('unknown');
    expect(result.notes.join()).toMatch(/不一致/);
  });

  it('目标日历不可写 ⇒ 失败（不写入，也不冒充已创建）', async () => {
    const result = await createEventDirect(writer(null), ACCESS, timedEvent({ calendarId: 'holidays' }), ZONES);
    expect(result.state).toBe('failed');
    expect(result.notes.join()).toMatch(/不可写/);
  });

  it('无写权限 ⇒ 失败', async () => {
    const readOnly: CalendarAccess = { granted: ['read'], calendars: ACCESS.calendars };
    const result = await createEventDirect(writer(null), readOnly, timedEvent(), ZONES);
    expect(result.state).toBe('failed');
  });

  it('**打开编辑页永远到不了"已确认完成"**', async () => {
    const result = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: true, handlerLabel: '系统日历', detail: '已打开' }) },
      timedEvent(),
    );
    expect(result.state).toBe('handed_off');
    expect(result.state).not.toBe('confirmed');
    expect(result.notes.join()).toMatch(/不得.*创建完成/);
  });

  it('编辑页无法打开 ⇒ 失败', async () => {
    const result = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: false, handlerLabel: null, detail: '无应用' }) },
      timedEvent(),
    );
    expect(result.state).toBe('failed');
  });

  it('权限判定区分"无权限 / 不在授权目录 / 只读日历"', () => {
    expect(checkCalendarAccess(ACCESS, 'primary', 'write').ok).toBe(true);
    expect(checkCalendarAccess(ACCESS, 'nope', 'write').ok).toBe(false);
    expect(checkCalendarAccess(ACCESS, 'holidays', 'write').ok).toBe(false);
    const check = checkCalendarAccess({ granted: [], calendars: ACCESS.calendars }, 'primary', 'read');
    expect(check.ok).toBe(false);
  });
});

describe('CAL-06 / CAL-07：修改删除与参与者', () => {
  it('版本冲突 ⇒ 失败且**原记录保留**', () => {
    const current = timedEvent();
    const result = planEventUpdate(current, { title: '改名' }, 99, ZONES);
    expect(result.ok).toBe(false);
    expect(result.next).toBeNull();
    expect(current.title).toBe('站会');
  });

  it('合法修改 ⇒ 版本 +1', () => {
    const result = planEventUpdate(timedEvent(), { title: '改名' }, 1, ZONES);
    expect(result.ok).toBe(true);
    expect(result.next?.revision).toBe(2);
    expect(result.next?.title).toBe('改名');
  });

  it('非法修改（结束早于开始）⇒ 失败，原记录保留', () => {
    const result = planEventUpdate(
      timedEvent(),
      { time: { kind: 'timed', startMs: T, endMs: T - 1, zoneId: 'UTC' } },
      1,
      ZONES,
    );
    expect(result.ok).toBe(false);
    expect(result.next).toBeNull();
  });

  it('删除也要求版本匹配；复制必须换新 id', () => {
    expect(planEventDelete(timedEvent(), 99).ok).toBe(false);
    expect(planEventDelete(timedEvent(), 1).ok).toBe(true);
    expect(planEventCopy(timedEvent(), 'e2').id).toBe('e2');
    expect(() => planEventCopy(timedEvent(), 'e1')).toThrow(/新 id/);
  });

  it('**保存参与者 ≠ 已发邀请**（恒为 false）', () => {
    const declaration = declareAttendeeSave(3);
    expect(declaration.invitationSent).toBe(false);
    expect(declaration.state).toBe('submitted');
    expect(declaration.note).toMatch(/未发送邀请/);
  });

  it('提醒校验与可用方式约束', () => {
    expect(validateReminders([{ minutesBefore: 10, method: 'notification' }])).toEqual([]);
    expect(validateReminders([{ minutesBefore: -1, method: 'notification' }])).toHaveLength(1);
    expect(validateReminders([{ minutesBefore: 10, method: 'sms' }], ['notification'])).toHaveLength(1);
  });
});

describe('CAL 就绪度（R231 / R233）', () => {
  it('十个子项齐全且自洽', () => {
    expect(CALENDAR_SUBITEMS.map((entry) => entry.id)).toEqual([
      'CAL-01',
      'CAL-02',
      'CAL-03',
      'CAL-04',
      'CAL-05',
      'CAL-06',
      'CAL-07',
      'CAL-08',
      'CAL-09',
      'CAL-10',
    ]);
    for (const entry of CALENDAR_SUBITEMS) {
      if (entry.verdict === 'implemented') expect(entry.evidence.length).toBeGreaterThan(0);
      else expect(entry.reason).not.toBeNull();
    }
  });

  it('三态计数可复算', () => {
    const counts = countVerdicts(CALENDAR_SUBITEMS);
    expect(counts.implemented + counts.not_ready + counts.blocked).toBe(10);
  });

  it('CAL-09 是"已实现"（两条路径的上限差异有本机证据）', () => {
    expect(CALENDAR_SUBITEMS.find((entry) => entry.id === 'CAL-09')?.verdict).toBe('implemented');
  });

  it('能力级未就绪项给出了原因与解锁条件', () => {
    for (const capability of CALENDAR_NOT_READY) {
      expect(capability.reason.length).toBeGreaterThan(0);
      expect(capability.unblockedBy.length).toBeGreaterThan(0);
    }
  });
});
