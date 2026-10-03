/**
 * CAL-06 / CAL-07 用例：修改 / 改期 / 复制 / 取消删除（**绑定真实 eventId 与版本**、
 * **失败保留原记录**），以及参与者资料 / 状态 / 备注。
 *
 * 全部走**注入的**变更端口（同进程假实现）；**真实 provider 行为未验证（需真机）**。
 */

import { describe, expect, it } from 'vitest';

import { wallToEpoch } from '../clock/civil.js';
import { createFixedZonePort } from '../clock/zone.js';
import { allDayTime } from './event-model.js';
import {
  applyCancel,
  applyMutation,
  applyUpdate,
  attendeeDeclaration,
  bindEvent,
  bindFromProvider,
  copyEvent,
  planAttendees,
  planCancel,
  rescheduleEvent,
  wallAt,
  type CalendarMutationPort,
} from './event-mutations.js';
import type { Attendee, CalendarEvent } from './types.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);
const THIRD = wallToEpoch({ year: 2026, month: 8, day: 17, hour: 9, minute: 0, second: 0 }, 0);
const WINDOW = { fromMs: T - DAY, toMs: T + 30 * DAY };

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

function weekly(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return timedEvent({
    id: 'series-1',
    title: '周会',
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    ...overrides,
  });
}

interface FakePortOptions {
  readonly failUpdate?: boolean;
  readonly failDelete?: boolean;
  readonly readBackNull?: boolean;
  readonly readBackTransform?: (event: CalendarEvent) => CalendarEvent;
  readonly keepAfterDelete?: boolean;
}

function fakePort(seed: readonly CalendarEvent[], options: FakePortOptions = {}) {
  const store = new Map<string, CalendarEvent>(seed.map((event) => [event.id, event]));
  const port: CalendarMutationPort = {
    readEvent(eventId) {
      const stored = store.get(eventId);
      if (stored === undefined || options.readBackNull === true) return Promise.resolve(null);
      const transform = options.readBackTransform;
      return Promise.resolve(transform === undefined ? stored : transform(stored));
    },
    updateEvent(eventId, next, expectedRevision) {
      if (options.failUpdate === true) {
        return Promise.resolve({ ok: false, reason: '端口拒绝写入', observed: store.get(eventId) ?? null });
      }
      const current = store.get(eventId);
      if (current !== undefined && current.revision !== expectedRevision) {
        return Promise.resolve({ ok: false, reason: '端口版本冲突', observed: current });
      }
      store.set(eventId, next);
      return Promise.resolve({ ok: true, revision: next.revision });
    },
    deleteEvent(eventId, expectedRevision) {
      if (options.failDelete === true) {
        return Promise.resolve({ ok: false, reason: '端口拒绝删除', observed: store.get(eventId) ?? null });
      }
      const current = store.get(eventId);
      if (current !== undefined && current.revision !== expectedRevision) {
        return Promise.resolve({ ok: false, reason: '端口版本冲突', observed: current });
      }
      if (options.keepAfterDelete !== true) store.delete(eventId);
      return Promise.resolve({ ok: true, revision: current?.revision ?? expectedRevision });
    },
  };
  return { port, store };
}

describe('CAL-06：绑定真实 eventId 与版本', () => {
  it('正常绑定给出 eventId + 版本', () => {
    const result = bindEvent(timedEvent());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.binding).toEqual({ eventId: 'evt-1', revision: 1 });
  });

  it('【反向对照】占位 id / 空 id / 非法版本一律拒绝绑定', () => {
    expect(bindEvent(timedEvent({ id: 'draft:1' })).ok).toBe(false);
    expect(bindEvent(timedEvent({ id: '  ' })).ok).toBe(false);
    expect(bindEvent(timedEvent({ revision: 0 })).ok).toBe(false);
    expect(bindEvent(timedEvent({ id: 'new:2' })).ok).toBe(false);
  });

  it('【反向对照】provider 读不回 ⇒ 不得绑定（不凭本地副本改线上）', async () => {
    const { port } = fakePort([]);
    const result = await bindFromProvider(port, 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/读不到/);
  });

  it('provider 读得回 ⇒ 绑定成功且给出读回的事件', async () => {
    const { port } = fakePort([timedEvent()]);
    const result = await bindFromProvider(port, 'evt-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.title).toBe('站会');
  });
});

describe('CAL-06：修改 —— 失败保留原记录', () => {
  it('【正向】读回一致 ⇒ 已确认完成且落库', async () => {
    const current = timedEvent();
    const { port, store } = fakePort([current]);
    const next: CalendarEvent = { ...current, title: '改名', revision: 2 };
    const result = await applyMutation(port, current, next, 1, ZONES);
    expect(result.ok).toBe(true);
    expect(result.state).toBe('confirmed');
    expect(result.next?.title).toBe('改名');
    expect(result.preserved).toBeNull();
    expect(store.get('evt-1')?.title).toBe('改名');
  });

  it('【反向对照】版本冲突 ⇒ 失败、**原记录保留**、端口未被改动', async () => {
    const current = timedEvent();
    const { port, store } = fakePort([current]);
    const result = await applyMutation(port, current, { ...current, title: '改名', revision: 2 }, 99, ZONES);
    expect(result.ok).toBe(false);
    expect(result.next).toBeNull();
    expect(result.preserved).toBe(current);
    expect(store.get('evt-1')?.title).toBe('站会');
    expect(result.state).toBe('failed');
  });

  it('【反向对照】端口拒绝写入 ⇒ 失败且原记录保留', async () => {
    const current = timedEvent();
    const { port, store } = fakePort([current], { failUpdate: true });
    const result = await applyMutation(port, current, { ...current, revision: 2 }, 1, ZONES);
    expect(result.ok).toBe(false);
    expect(result.preserved).toBe(current);
    expect(store.get('evt-1')?.revision).toBe(1);
  });

  it('【反向对照】受理后**读不回** ⇒ 结果未知（不报完成）且原记录保留', async () => {
    const current = timedEvent();
    const { port } = fakePort([current], { readBackNull: true });
    const result = await applyMutation(port, current, { ...current, revision: 2 }, 1, ZONES);
    expect(result.state).toBe('unknown');
    expect(result.ok).toBe(false);
    expect(result.preserved).toBe(current);
    expect(result.notes.join()).toMatch(/不得|结果未知/);
  });

  it('【反向对照】读回与意图不一致 ⇒ 结果未知', async () => {
    const current = timedEvent();
    const { port } = fakePort([current], { readBackTransform: (event) => ({ ...event, title: '被外部改了' }) });
    const result = await applyMutation(port, current, { ...current, title: '改名', revision: 2 }, 1, ZONES);
    expect(result.state).toBe('unknown');
    expect(result.reason).toMatch(/不一致/);
  });

  it('【反向对照】变更换 id（应属复制）⇒ 失败', async () => {
    const current = timedEvent();
    const { port } = fakePort([current]);
    const result = await applyMutation(port, current, { ...current, id: 'evt-2', revision: 2 }, 1, ZONES);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/不得换 id/);
  });

  it('applyUpdate 规划失败（结束早于开始）⇒ 原记录保留', async () => {
    const current = timedEvent();
    const { port, store } = fakePort([current]);
    const result = await applyUpdate(
      port,
      current,
      { time: { kind: 'timed', startMs: T, endMs: T - 1, zoneId: 'UTC' } },
      1,
      ZONES,
    );
    expect(result.ok).toBe(false);
    expect(result.preserved).toBe(current);
    expect(store.get('evt-1')?.time).toEqual(current.time);
  });

  it('applyUpdate 正常改标题 ⇒ 版本 +1', async () => {
    const current = timedEvent();
    const { port } = fakePort([current]);
    const result = await applyUpdate(port, current, { title: '改名' }, 1, ZONES);
    expect(result.ok).toBe(true);
    expect(result.next?.revision).toBe(2);
  });
});

describe('CAL-06：改期与复制', () => {
  it('定时改期：平移起点但**保持时长**', () => {
    const shifted = rescheduleEvent(timedEvent(), T + 3 * DAY, ZONES);
    expect(shifted).toEqual({ kind: 'timed', startMs: T + 3 * DAY, endMs: T + 3 * DAY + HOUR, zoneId: 'UTC' });
    expect(wallAt(ZONES, 'UTC', T + 3 * DAY)?.day).toBe(4);
  });

  it('全天改期：按**自然日**平移', () => {
    const allDay = timedEvent({ time: allDayTime('2026-08-01', 1, 'UTC') as CalendarEvent['time'] });
    const shifted = rescheduleEvent(allDay, wallToEpoch({ year: 2026, month: 8, day: 5, hour: 0, minute: 0, second: 0 }, 0), ZONES);
    expect(shifted).toEqual({
      kind: 'allDay',
      startDate: '2026-08-05',
      endDateExclusive: '2026-08-06',
      zoneId: 'UTC',
    });
  });

  it('【反向对照】未知时区 ⇒ 不给改期结果（不猜）', () => {
    const bad = timedEvent({ time: { kind: 'allDay', startDate: '2026-08-01', endDateExclusive: '2026-08-02', zoneId: 'Mars/Base' } });
    expect(rescheduleEvent(bad, T, ZONES)).toBeNull();
  });

  it('复制换新 id 且版本归一；【反向对照】沿用同 id 抛错', () => {
    const copy = copyEvent(timedEvent(), 'evt-2');
    expect(copy.id).toBe('evt-2');
    expect(copy.revision).toBe(1);
    expect(() => copyEvent(timedEvent(), 'evt-1')).toThrow(/新 id/);
  });
});

describe('CAL-06：按范围取消 / 删除', () => {
  it('取消"某一次"= 加入 EXDATE；"后续"= 设 UNTIL 截断；"整组"= 无下一条定义', () => {
    const event = weekly();
    const single = planCancel(event, 'this', THIRD, ZONES, WINDOW);
    const following = planCancel(event, 'following', THIRD, ZONES, WINDOW);
    const all = planCancel(event, 'all', THIRD, ZONES, WINDOW);

    expect(single.ok).toBe(true);
    expect(single.next?.recurrence?.exdates).toEqual(['2026-08-17']);
    expect(single.next?.revision).toBe(2);

    expect(following.ok).toBe(true);
    expect(following.next?.recurrence?.untilDate).toBe('2026-08-16');

    expect(all.ok).toBe(true);
    expect(all.next).toBeNull();
    expect(all.strategy).toMatch(/删除父系列行/);
  });

  it('【反向对照】非重复事件的"某一次"⇒ 失败（无平台语义，不偷偷整条删）', () => {
    const plan = planCancel(timedEvent(), 'this', T, ZONES, WINDOW);
    expect(plan.ok).toBe(false);
    expect(plan.next).toBeNull();
    expect(plan.reason).toMatch(/不重复/);
  });

  it('【反向对照】与既有 count 冲突 ⇒ 如实失败、**原规则保留**（不偷偷改写）', () => {
    const event = weekly({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 3 } });
    const plan = planCancel(event, 'following', THIRD, ZONES, WINDOW);
    expect(plan.ok).toBe(false);
    expect(plan.next).toBeNull();
    expect(plan.reason).toMatch(/互斥|不自洽/);
  });

  it('执行整组删除：删除后读不回 ⇒ 已确认完成', async () => {
    const current = weekly();
    const { port, store } = fakePort([current]);
    const result = await applyCancel(port, current, 'all', THIRD, 1, ZONES, WINDOW);
    expect(result.ok).toBe(true);
    expect(result.state).toBe('confirmed');
    expect(store.has('series-1')).toBe(false);
  });

  it('【反向对照】删除受理后仍读得回 ⇒ 结果未知，且原记录保留在本地', async () => {
    const current = weekly();
    const { port } = fakePort([current], { keepAfterDelete: true });
    const result = await applyCancel(port, current, 'all', THIRD, 1, ZONES, WINDOW);
    expect(result.ok).toBe(false);
    expect(result.state).toBe('unknown');
    expect(result.preserved).toBe(current);
  });

  it('执行"某一次"取消 ⇒ 落库的新规则含该 EXDATE', async () => {
    const current = weekly();
    const { port, store } = fakePort([current]);
    const result = await applyCancel(port, current, 'this', THIRD, 1, ZONES, WINDOW);
    expect(result.ok).toBe(true);
    expect(store.get('series-1')?.recurrence?.exdates).toEqual(['2026-08-17']);
  });
});

describe('CAL-07：参与者（保存 ≠ 已发邀请）', () => {
  const base: readonly Attendee[] = [{ email: 'a@example.com', status: 'accepted', note: null }];

  it('新增 / 删除 / 改状态 / 改备注', () => {
    const added = planAttendees(base, [{ kind: 'add', attendee: { email: 'b@example.com', status: 'pending', note: null } }]);
    expect(added.ok).toBe(true);
    expect(added.attendees).toHaveLength(2);

    const status = planAttendees(added.attendees, [{ kind: 'setStatus', email: 'b@example.com', status: 'declined' }]);
    expect(status.attendees.find((entry) => entry.email === 'b@example.com')?.status).toBe('declined');

    const note = planAttendees(status.attendees, [{ kind: 'setNote', email: 'a@example.com', note: '会迟到' }]);
    expect(note.attendees.find((entry) => entry.email === 'a@example.com')?.note).toBe('会迟到');

    const removed = planAttendees(note.attendees, [{ kind: 'remove', email: 'a@example.com' }]);
    expect(removed.attendees.map((entry) => entry.email)).toEqual(['b@example.com']);
  });

  it('【反向对照】重复添加 / 不存在的邮箱 / 非法邮箱 ⇒ 失败且返回**原集合**', () => {
    expect(planAttendees(base, [{ kind: 'add', attendee: { email: 'a@example.com', status: 'pending', note: null } }]).ok).toBe(false);
    expect(planAttendees(base, [{ kind: 'setStatus', email: 'ghost@example.com', status: 'accepted' }]).attendees).toEqual(base);
    const malformed = planAttendees(base, [{ kind: 'add', attendee: { email: 'nope', status: 'pending', note: null } }]);
    expect(malformed.ok).toBe(false);
    expect(malformed.attendees).toEqual(base);
  });

  it('【反向对照】保存参与者**恒不声称已发邀请**', () => {
    const declaration = attendeeDeclaration(2);
    expect(declaration.invitationSent).toBe(false);
    expect(declaration.state).toBe('submitted');
    expect(declaration.note).toMatch(/未发送邀请/);
  });
});
