/**
 * CAL-05 用例：重复规则、截止、例外，以及「**本次 / 后续 / 整个系列**」的
 * 编辑与删除语义——**强断言**：三者的受影响实例集合必须两两不同，绝不误改整组。
 */

import { describe, expect, it } from 'vitest';

import { wallToEpoch } from '../clock/civil.js';
import { createFixedZonePort } from '../clock/zone.js';
import { validateEvent } from './event.js';
import {
  checkScopeIsolation,
  expandSeries,
  localDateAt,
  planScopedDelete,
  planScopedEdit,
  validateRule,
  type ScopedChangePlan,
} from './recurrence.js';
import type { CalendarEvent, RecurrenceRule } from './types.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);
/** 每周一 09:00Z 的系列：08-03 / 08-10 / 08-17 / 08-24 / 08-31（共 5 次）。 */
const THIRD = wallToEpoch({ year: 2026, month: 8, day: 17, hour: 9, minute: 0, second: 0 }, 0);
const WINDOW = { fromMs: T - DAY, toMs: T + 30 * DAY };

function weekly(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'series-1',
    calendarId: 'primary',
    title: '周会',
    time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'UTC' },
    location: null,
    description: null,
    attendees: [],
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1] },
    revision: 1,
    ...overrides,
  };
}

const ALL_DATES = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];

describe('CAL-05：重复规则与展开', () => {
  it('规则形状校验：间隔 / 例外日期合法', () => {
    expect(validateRule({ freq: 'weekly', interval: 1 })).toEqual([]);
    expect(validateRule({ freq: 'daily', interval: 0 })).toHaveLength(1);
    expect(validateRule({ freq: 'daily', interval: 1, exdates: ['nope'] }).join()).toMatch(/例外日期非法/);
  });

  it('【反向对照】count 与 untilDate 互斥（整事件校验层面）', () => {
    const both = weekly({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], count: 3, untilDate: '2026-08-31' } });
    expect(validateEvent(both, ZONES).problems.join()).toMatch(/互斥/);
    // 对照：只给其一时合法。
    const ok = weekly({ recurrence: { freq: 'weekly', interval: 1, byWeekday: [1], untilDate: '2026-08-31' } });
    expect(validateEvent(ok, ZONES).ok).toBe(true);
  });

  it('展开系列：5 个周一', () => {
    const expansion = expandSeries(weekly(), ZONES, WINDOW.fromMs, WINDOW.toMs);
    expect(expansion.reason).toBeNull();
    expect(expansion.occurrences.map((occurrence) => occurrence.localDate)).toEqual(ALL_DATES);
  });

  it('EXDATE 排除实例但不改变系列计数口径', () => {
    const rule: RecurrenceRule = { freq: 'weekly', interval: 1, byWeekday: [1], exdates: ['2026-08-10'] };
    const expansion = expandSeries(weekly({ recurrence: rule }), ZONES, WINDOW.fromMs, WINDOW.toMs);
    expect(expansion.occurrences.map((occurrence) => occurrence.localDate)).toEqual([
      '2026-08-03',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
  });

  it('【反向对照】不重复事件：窗口内给出唯一一次，窗口外为空', () => {
    const single = weekly({ recurrence: null });
    expect(expandSeries(single, ZONES, WINDOW.fromMs, WINDOW.toMs).occurrences.map((o) => o.localDate)).toEqual([
      '2026-08-01',
    ]);
    const far = { fromMs: T + 10 * DAY, toMs: T + 20 * DAY };
    expect(expandSeries(single, ZONES, far.fromMs, far.toMs).occurrences).toEqual([]);
  });

  it('【反向对照】未知时区 ⇒ 展开给出原因而非静默空结果', () => {
    const bad = weekly({ time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'Mars/Base' } });
    const expansion = expandSeries(bad, ZONES, WINDOW.fromMs, WINDOW.toMs);
    expect(expansion.reason).not.toBeNull();
    expect(expansion.occurrences).toEqual([]);
    expect(localDateAt(ZONES, 'Mars/Base', T)).toBeNull();
  });
});

describe('CAL-05：本次 / 后续 / 整个系列（强断言）', () => {
  const plans = (): readonly ScopedChangePlan[] => {
    const event = weekly();
    const single = planScopedEdit(event, 'this', THIRD, ZONES, WINDOW);
    const following = planScopedEdit(event, 'following', THIRD, ZONES, WINDOW);
    const all = planScopedEdit(event, 'all', THIRD, ZONES, WINDOW);
    expect(single).not.toBeNull();
    expect(following).not.toBeNull();
    expect(all).not.toBeNull();
    return [single as ScopedChangePlan, following as ScopedChangePlan, all as ScopedChangePlan];
  };

  it('「本次」只影响 1 次，其余全部不受影响', () => {
    const single = plans()[0] as ScopedChangePlan;
    expect(single.affectedLocalDates).toEqual(['2026-08-17']);
    expect(single.untouchedLocalDates).toEqual(['2026-08-03', '2026-08-10', '2026-08-24', '2026-08-31']);
    expect(single.wholeSeries).toBe(false);
    expect(single.plan.kind).toBe('single_exception');
  });

  it('「后续」影响分叉点起的后缀，前缀不受影响', () => {
    const following = plans()[1] as ScopedChangePlan;
    expect(following.affectedLocalDates).toEqual(['2026-08-17', '2026-08-24', '2026-08-31']);
    expect(following.untouchedLocalDates).toEqual(['2026-08-03', '2026-08-10']);
    expect(following.wholeSeries).toBe(false);
    expect(following.plan.kind).toBe('split_series');
  });

  it('「整个系列」影响全部，且**没有**不受影响的实例', () => {
    const all = plans()[2] as ScopedChangePlan;
    expect(all.affectedLocalDates).toEqual(ALL_DATES);
    expect(all.untouchedLocalDates).toEqual([]);
    expect(all.wholeSeries).toBe(true);
    expect(all.plan.kind).toBe('whole_series');
  });

  it('【强断言】三者的受影响集合**两两不同**，且签名互异 —— 不误改整组', () => {
    const [single, following, all] = plans() as [ScopedChangePlan, ScopedChangePlan, ScopedChangePlan];
    const sets = [single, following, all].map((plan) => plan.affectedLocalDates.join(','));
    expect(new Set(sets).size).toBe(3);
    expect(new Set([single.signature, following.signature, all.signature]).size).toBe(3);

    // 「本次」的影响集合既**不等于**「整个系列」，也**不是**其超集——把 this 当 all 执行会当场暴露。
    expect(single.affectedLocalDates).not.toEqual(all.affectedLocalDates);
    expect(single.affectedLocalDates.length).toBeLessThan(all.affectedLocalDates.length);
    // 「后续」是「整个系列」的**真子集**（前缀被排除）。
    expect(following.affectedLocalDates.length).toBeLessThan(all.affectedLocalDates.length);
    expect(all.affectedLocalDates).toEqual(expect.arrayContaining([...following.affectedLocalDates]));

    // 运行期兜底自检也应通过。
    expect(checkScopeIsolation([single, following, all])).toEqual([]);
  });

  it('【反向对照】若"本次"影响了多于一次，自检必须报错', () => {
    const single = plans()[0] as ScopedChangePlan;
    const tampered: ScopedChangePlan = { ...single, affectedLocalDates: ['2026-08-03', '2026-08-10'] };
    expect(checkScopeIsolation([tampered]).join()).toMatch(/影响的实例数应为 1/);
  });

  it('【反向对照】未知时区 / 非法窗口 ⇒ 不给计划（不猜）', () => {
    const bad = weekly({ time: { kind: 'timed', startMs: T, endMs: T + HOUR, zoneId: 'Mars/Base' } });
    expect(planScopedEdit(bad, 'all', THIRD, ZONES, WINDOW)).toBeNull();
    expect(() => planScopedEdit(weekly(), 'all', THIRD, ZONES, { fromMs: T, toMs: T })).toThrow(/toMs > fromMs/);
  });
});

describe('CAL-05：按范围删除', () => {
  it('三种范围的删除策略**各不相同**', () => {
    const event = weekly();
    const single = planScopedDelete(event, 'this', THIRD, ZONES, WINDOW);
    const following = planScopedDelete(event, 'following', THIRD, ZONES, WINDOW);
    const all = planScopedDelete(event, 'all', THIRD, ZONES, WINDOW);
    expect(single?.deleteStrategy).toMatch(/EXDATE/);
    expect(following?.deleteStrategy).toMatch(/UNTIL/);
    expect(all?.deleteStrategy).toMatch(/删除父系列行/);
    // 受影响集合仍然遵循同一套（this 1 条 / all 全部）。
    expect(single?.affectedLocalDates).toEqual(['2026-08-17']);
    expect(all?.affectedLocalDates).toEqual(ALL_DATES);
  });

  it('【反向对照】非重复事件的"某一次/后续"退化为同一次并标记 degenerate', () => {
    const single = weekly({ recurrence: null });
    const plan = planScopedEdit(single, 'this', T, ZONES, WINDOW);
    expect(plan?.degenerate).toBe(true);
    expect(plan?.affectedLocalDates).toEqual(['2026-08-01']);
  });
});
