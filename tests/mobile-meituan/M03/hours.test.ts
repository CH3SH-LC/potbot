/**
 * M03 营业时段：注入时钟换算 + 营业判定（含跨午夜）。
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateOperatingHours,
  isWithinWindow,
  known,
  makeWeekTime,
  unknown,
  weekTimeFromEpoch,
  type OperatingWindow,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';

const DAY_MS = 86_400_000;

describe('M03 时间换算：纯算术、不依赖宿主时区', () => {
  it('epoch=0 是星期四（星期一=0 ⇒ 星期四=3），分钟为 0', () => {
    expect(weekTimeFromEpoch(0)).toEqual({ dayOfWeek: 3, minuteOfDay: 0 });
  });

  it('+1 天 = 星期五', () => {
    expect(weekTimeFromEpoch(DAY_MS).dayOfWeek).toBe(4);
  });

  it('+10 小时 = 星期四 600 分', () => {
    expect(weekTimeFromEpoch(600 * 60_000)).toEqual({ dayOfWeek: 3, minuteOfDay: 600 });
  });

  it('时区偏移按分钟平移', () => {
    expect(weekTimeFromEpoch(0, 480)).toEqual({ dayOfWeek: 3, minuteOfDay: 480 });
  });

  it('非法入参显式抛错', () => {
    expect(() => weekTimeFromEpoch(Number.NaN)).toThrow();
    expect(() => weekTimeFromEpoch(0, 1.5)).toThrow();
    expect(() => makeWeekTime(7, 0)).toThrow();
    expect(() => makeWeekTime(0, 1440)).toThrow();
  });
});

describe('M03 营业判定：普通时段', () => {
  const hours = known<readonly OperatingWindow[]>(
    [{ dayOfWeek: 0, openMinute: 600, closeMinute: 1320 }],
    'src',
  );

  it('开始时刻营业中；结束时刻已闭店（区间左闭右开）', () => {
    expect(evaluateOperatingHours(hours, makeWeekTime(0, 600)).state).toBe('open');
    expect(evaluateOperatingHours(hours, makeWeekTime(0, 599)).state).toBe('closed');
    expect(evaluateOperatingHours(hours, makeWeekTime(0, 1320)).state).toBe('closed');
  });

  it('命中时给出具体时段', () => {
    const status = evaluateOperatingHours(hours, makeWeekTime(0, 700));
    expect(status.state).toBe('open');
    expect(status.matchedWindow).toEqual({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320 });
  });
});

describe('M03 营业判定：跨午夜', () => {
  const overnight = known<readonly OperatingWindow[]>(
    [{ dayOfWeek: 5, openMinute: 1320, closeMinute: 120 }],
    'src',
  );

  it('周五 22:00 营业中', () => {
    expect(evaluateOperatingHours(overnight, makeWeekTime(5, 1320)).state).toBe('open');
  });

  it('周六 02:00（次日）仍在营业', () => {
    expect(evaluateOperatingHours(overnight, makeWeekTime(6, 60)).state).toBe('open');
    expect(evaluateOperatingHours(overnight, makeWeekTime(6, 119)).state).toBe('open');
  });

  it('周六 02:00 之后闭店；周五 21:59 未开门', () => {
    expect(evaluateOperatingHours(overnight, makeWeekTime(6, 120)).state).toBe('closed');
    expect(evaluateOperatingHours(overnight, makeWeekTime(5, 1319)).state).toBe('closed');
  });

  it('isWithinWindow 直接判定跨午夜窗口', () => {
    const window: OperatingWindow = { dayOfWeek: 5, openMinute: 1320, closeMinute: 120 };
    expect(isWithinWindow(window, makeWeekTime(5, 1320))).toBe(true);
    expect(isWithinWindow(window, makeWeekTime(6, 30))).toBe(true);
    expect(isWithinWindow(window, makeWeekTime(6, 120))).toBe(false);
  });
});

describe('M03 营业判定：未知与闭店要分开', () => {
  it('营业时间未知 ⇒ unknown（不默认营业中）', () => {
    const status = evaluateOperatingHours(unknown('接口未返回营业时间'), makeWeekTime(0, 700));
    expect(status.state).toBe('unknown');
  });

  it('已知但无时段 ⇒ closed（已知闭店，不是未知）', () => {
    const status = evaluateOperatingHours(known<readonly OperatingWindow[]>([], 'src'), makeWeekTime(0, 700));
    expect(status.state).toBe('closed');
    expect(status.detail.includes('已知')).toBe(true);
  });

  it('开始与结束相同的歧义时段被拒绝（不默认 24 小时）', () => {
    const bad = known<readonly OperatingWindow[]>([{ dayOfWeek: 0, openMinute: 600, closeMinute: 600 }], 'src');
    expect(() => evaluateOperatingHours(bad, makeWeekTime(0, 700))).toThrow();
  });

  it('越界分钟被拒绝', () => {
    const bad = known<readonly OperatingWindow[]>([{ dayOfWeek: 0, openMinute: -1, closeMinute: 1320 }], 'src');
    expect(() => evaluateOperatingHours(bad, makeWeekTime(0, 700))).toThrow();
  });
});
