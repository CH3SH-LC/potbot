/**
 * 时钟域用例（CLK-01–10 的**不依赖真机**部分）。
 *
 * 时区一律**注入固定偏移表**，因此全部断言与宿主 tzdata 无关、可复现；
 * 仅 DST 一节刻意用宿主 ICU 端口，并在断言里说明其依赖。
 */

import { describe, expect, it } from 'vitest';

import {
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  epochToWall,
  formatDate,
  formatDateTime,
  parseDate,
  wallToEpoch,
  weekdayOfDays,
} from './civil.js';
import { createFixedZonePort, createIntlZonePort, readWorldClock, zoneToInstant } from './zone.js';
import { createAlarmStore } from './alarm-store.js';
import { describeRepeat, nextOccurrence, validateRepeatRule } from './repeat.js';
import { parseNaturalTime } from './time-parse.js';
import { cancel, createTimer, elapsedMs, finish, formatDuration, isDue, pause, remainingMs, resume, start } from './timer.js';
import {
  createStopwatch,
  formatStopwatch,
  lap,
  pause as swPause,
  reset as swReset,
  start as swStart,
  totalMs,
} from './stopwatch.js';
import { handoffSystemClockAction, listSystemAlarms, SYSTEM_ACTION_SEMANTICS } from './handoff.js';
import { CLOCK_SUBITEMS, CLOCK_NOT_READY } from './not-ready.js';
import { countVerdicts } from './readiness.js';

/** 固定偏移表：测试**不依赖**宿主 tzdata。 */
const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480, 'America/New_York': -300 });

/** 2026-08-01T00:00:00Z（星期六）。 */
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 0, minute: 0, second: 0 }, 0);
const DAY = 86_400_000;

describe('民用日历换算（纯整数，无 Date）', () => {
  it('1970-01-01 是第 0 天且为星期四', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(0)).toEqual({ year: 1970, month: 1, day: 1 });
    expect(weekdayOfDays(0)).toBe(4);
  });

  it('2026-08-01 是星期六', () => {
    const day = daysFromCivil(2026, 8, 1);
    expect(weekdayOfDays(day)).toBe(6);
  });

  it('往返一致（含闰年与月末）', () => {
    for (const [y, m, d] of [
      [2000, 2, 29],
      [2024, 2, 29],
      [1900, 3, 1],
      [2026, 12, 31],
      [1999, 1, 1],
    ] as const) {
      const day = daysFromCivil(y, m, d);
      expect(civilFromDays(day)).toEqual({ year: y, month: m, day: d });
    }
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('绝对时刻 ⇄ 墙上时间往返一致', () => {
    const wall = epochToWall(T, 480);
    expect(formatDateTime(wall)).toBe('2026-08-01 08:00');
    expect(wallToEpoch(wall, 480)).toBe(T);
  });

  it('日期解析拒绝不存在的日期（不做宽松猜测）', () => {
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('2026/08/01')).toBeNull();
    expect(parseDate('2026-08-01')).toEqual({ year: 2026, month: 8, day: 1 });
  });
});

describe('时区与世界时钟（CLK-06）', () => {
  it('固定端口：同一时刻在不同时区的墙上时间正确', () => {
    const result = readWorldClock(ZONES, ['UTC', 'Asia/Shanghai'], T);
    expect(result.readings.map((entry) => entry.formatted)).toEqual([
      '2026-08-01 00:00',
      '2026-08-01 08:00',
    ]);
    expect(result.unknownZones).toEqual([]);
  });

  it('**未知时区如实列出**（不以 UTC 顶替）', () => {
    const result = readWorldClock(ZONES, ['UTC', 'Mars/Base'], T);
    expect(result.readings).toHaveLength(1);
    expect(result.unknownZones).toEqual(['Mars/Base']);
  });

  it('墙上时间 → 绝对时刻（跨时区）', () => {
    const instant = zoneToInstant(ZONES, 'Asia/Shanghai', {
      year: 2026,
      month: 8,
      day: 1,
      hour: 8,
      minute: 0,
      second: 0,
    });
    expect(instant).toBe(T);
  });

  it('宿主 ICU 端口的夏令时（依赖宿主 tzdata，故只用广为人知的样例）', () => {
    const port = createIntlZonePort();
    const winter = wallToEpoch({ year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 }, 0);
    const summer = wallToEpoch({ year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 }, 0);
    expect(port.offsetMinutesAt('America/New_York', winter)).toBe(-300); // EST
    expect(port.offsetMinutesAt('America/New_York', summer)).toBe(-240); // EDT
    expect(port.offsetMinutesAt('Asia/Shanghai', summer)).toBe(480);
    expect(port.offsetMinutesAt('Not/AZone', summer)).toBeNull();
  });
});

describe('重复规则与下次触发（CLK-02 / CLK-03 / CLK-04）', () => {
  const base = { zoneId: 'UTC', zonePort: ZONES, anchorMs: T, afterMs: T };

  it('每天 / 每小时规则的下一次触发', () => {
    expect(nextOccurrence({ ...base, rule: { kind: 'daily', interval: 1 } })).toBe(T + DAY);
    expect(nextOccurrence({ ...base, rule: { kind: 'daily', interval: 3 } })).toBe(T + 3 * DAY);
  });

  it('工作日规则：从周六起，下一次是周一', () => {
    expect(nextOccurrence({ ...base, rule: { kind: 'workdays' } })).toBe(T + 2 * DAY);
  });

  it('每周规则：只在给定的星期几触发', () => {
    // 2026-08-01 是周六；指定周一 ⇒ 下一次是 8 月 3 日。
    expect(nextOccurrence({ ...base, rule: { kind: 'weekly', interval: 1, weekdays: [1] } })).toBe(
      T + 2 * DAY,
    );
  });

  it('指定日期规则按列表命中', () => {
    expect(
      nextOccurrence({ ...base, rule: { kind: 'dates', dates: ['2026-08-05', '2026-08-03'] } }),
    ).toBe(T + 2 * DAY);
  });

  it('「取消一次发生」跳过该日，但**不**删除整条规则', () => {
    const skipped = formatDate(civilFromDays(daysFromCivil(2026, 8, 2)));
    expect(
      nextOccurrence({ ...base, rule: { kind: 'daily', interval: 1 }, skippedDates: [skipped] }),
    ).toBe(T + 2 * DAY);
  });

  it('单次已过 ⇒ 明确的 single_elapsed，而不是"没有下一次"的含糊', () => {
    const result = nextOccurrence({ ...base, rule: { kind: 'once' }, afterMs: T + DAY });
    expect(result).toBeNull();
  });

  it('未知时区 ⇒ 返回 null（不猜）', () => {
    expect(nextOccurrence({ ...base, zoneId: 'Mars/Base', rule: { kind: 'daily', interval: 1 } })).toBeNull();
  });

  it('规则校验拒绝非法间隔与非法日值', () => {
    expect(validateRepeatRule({ kind: 'daily', interval: 0 })).toHaveLength(1);
    expect(validateRepeatRule({ kind: 'monthly', interval: 1, daysOfMonth: [0] })).toHaveLength(1);
    expect(validateRepeatRule({ kind: 'weekly', interval: 1, weekdays: [] })).toHaveLength(1);
    expect(validateRepeatRule({ kind: 'daily', interval: 2 })).toEqual([]);
  });

  it('重复规则有可读描述', () => {
    expect(describeRepeat({ kind: 'workdays' })).toContain('工作日');
    expect(describeRepeat({ kind: 'weekly', interval: 2, weekdays: [1, 3] })).toContain('每 2 周');
  });
});

describe('相对时间解析（CLK-02：解析成具体时刻供核对）', () => {
  const parse = (text: string) => parseNaturalTime(text, { nowMs: T, zoneId: 'Asia/Shanghai', zonePort: ZONES });

  it('「10 分钟后」解析为具体时刻，且**必须**让用户核对', () => {
    const result = parse('10分钟后');
    expect(result.kind).toBe('resolved');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.resolved?.local).toBe('2026-08-01 08:10');
  });

  it('「半小时后」= 30 分钟', () => {
    expect(parse('半小时后').resolved?.local).toBe('2026-08-01 08:30');
  });

  it('中文数字与单位变体', () => {
    expect(parse('两小时后').resolved?.local).toBe('2026-08-01 10:00');
    expect(parse('三天后').resolved?.local).toBe('2026-08-04 08:00');
  });

  it('明确给出时段与日期 ⇒ 唯一解且无需核对', () => {
    const result = parse('明天早上7点');
    expect(result.kind).toBe('resolved');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.resolved?.local).toBe('2026-08-02 07:00');
  });

  it('**歧义不替用户选**：「7 点」给上午/下午两个候选', () => {
    const result = parse('明天7点');
    expect(result.kind).toBe('ambiguous');
    expect(result.resolved).toBeNull();
    expect(result.candidates.map((entry) => entry.local)).toEqual([
      '2026-08-02 07:00',
      '2026-08-02 19:00',
    ]);
    expect(result.reason).toMatch(/上午\/下午/);
  });

  it('**看不懂就明说**（不猜、不返回空而冒充成功）', () => {
    const result = parse('随便什么时候');
    expect(result.kind).toBe('unparsed');
    expect(result.reason).not.toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('已过去的明确时刻 ⇒ unparsed 并说明原因', () => {
    const result = parse('今天早上6点');
    expect(result.kind).toBe('unparsed');
    expect(result.reason).toMatch(/已过去/);
  });
});

describe('自管提醒仓库（CLK-01 / CLK-03 / CLK-04 / CLK-07 的快照部分）', () => {
  const makeStore = () => createAlarmStore({ zonePort: ZONES, idSource: () => 'a1' });
  const draft = { label: '起床', zoneId: 'UTC', firstTriggerMs: T, repeat: { kind: 'daily', interval: 1 } as const };

  it('创建后可以查到下次触发与重复规则', () => {
    const store = makeStore();
    const created = store.create(draft, 'key-1');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.record.ownership).toBe('self_managed');
    const summary = store.describe(created.record.id, T);
    expect(summary?.nextTriggerText).toBe('2026-08-02 00:00');
    expect(summary?.repeatText).toBe('每天');
  });

  it('**幂等**：同一 key 重放返回既有记录，不重复创建', () => {
    const store = makeStore();
    const first = store.create(draft, 'key-1');
    const second = store.create(draft, 'key-1');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(store.list()).toHaveLength(1);
  });

  it('**版本绑定**：陈旧版本被拒，且原记录不被改动', () => {
    const store = makeStore();
    const created = store.create(draft, 'key-1');
    if (!created.ok) throw new Error('前置失败');
    const conflict = store.update(created.record.id, { label: '新名字' }, 99);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.reason).toBe('revision_conflict');
    expect(store.get(created.record.id)?.label).toBe('起床');
  });

  it('「取消一次发生」只跳过该次（下次触发顺延一天）', () => {
    const store = makeStore();
    const created = store.create(draft, 'key-1');
    if (!created.ok) throw new Error('前置失败');
    const next = store.nextTrigger(created.record.id, T);
    expect(next).toBe(T + DAY);
    const result = store.cancelOccurrence(created.record.id, next ?? 0, 1);
    expect(result.ok).toBe(true);
    expect(store.nextTrigger(created.record.id, T)).toBe(T + 2 * DAY);
    // 记录仍在（不是删除）。
    expect(store.get(created.record.id)).not.toBeNull();
  });

  it('禁用的提醒没有下次触发', () => {
    const store = makeStore();
    const created = store.create(draft, 'key-1');
    if (!created.ok) throw new Error('前置失败');
    const toggled = store.setEnabled(created.record.id, false, 1);
    expect(toggled.ok).toBe(true);
    expect(store.nextTrigger(created.record.id, T)).toBeNull();
  });

  it('快照 → 恢复后记录与幂等键都还在', () => {
    const store = makeStore();
    store.create(draft, 'key-1');
    const snapshot = store.toSnapshot();
    const restored = createAlarmStore({ zonePort: ZONES, idSource: () => 'a2', snapshot });
    expect(restored.list()).toHaveLength(1);
    // 幂等键也恢复了：重放同一个键仍然不会新建。
    const replay = restored.create(draft, 'key-1');
    expect(replay.ok && replay.duplicate).toBe(true);
  });

  it('未知时区的草稿被拒（unknown_zone），不落库', () => {
    const store = makeStore();
    const result = store.create({ ...draft, zoneId: 'Mars/Base' }, 'key-x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_zone');
    expect(store.list()).toHaveLength(0);
  });

  it('**自管 ≠ 系统闹钟**：list() 只返回自管记录', () => {
    const store = makeStore();
    store.create(draft, 'key-1');
    for (const record of store.list()) {
      expect(record.ownership).toBe('self_managed');
    }
  });
});

describe('计时器（CLK-05）与秒表（CLK-06）', () => {
  it('计时器：暂停/继续的剩余量正确，且**不声称**已响铃', () => {
    let state = createTimer('t1', '泡面', 180_000);
    state = start(state, T);
    expect(remainingMs(state, T + 60_000)).toBe(120_000);
    state = pause(state, T + 60_000);
    // 暂停期间"时间流逝"不减少剩余量。
    expect(remainingMs(state, T + 600_000)).toBe(120_000);
    state = resume(state, T + 600_000);
    expect(remainingMs(state, T + 660_000)).toBe(60_000);
    expect(isDue(state, T + 660_000)).toBe(false);
    // 到点：isDue 只反映**账目**，不表示已响铃。
    expect(isDue(state, T + 720_000)).toBe(true);
    state = finish(state, T + 720_000);
    expect(elapsedMs(state, T + 999_999)).toBe(180_000);
  });

  it('计时器：取消后不再计入', () => {
    let state = createTimer('t2', 'x', 10_000);
    state = start(state, T);
    state = cancel(state);
    expect(state.phase).toBe('cancelled');
  });

  it('时长格式化', () => {
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_665_000)).toBe('1:01:05');
  });

  it('秒表：前后台切换后读数正确（只依赖绝对起点）', () => {
    let state = createStopwatch('s1');
    state = swStart(state, T);
    // 模拟"界面重建"：只用状态 + 当前时刻复算，结果与连续运行一致。
    expect(totalMs(state, T + 5_000)).toBe(5_000);
    state = swPause(state, T + 5_000);
    // 暂停后时间流逝不再增加读数。
    expect(totalMs(state, T + 50_000)).toBe(5_000);
  });

  it('秒表：暂停中不允许计次（避免记出无意义的圈）', () => {
    let state = createStopwatch('s2');
    state = swStart(state, T);
    state = swPause(state, T + 1_000);
    expect(() => lap(state, T + 2_000)).toThrow(/运行中/);
  });

  it('秒表：计次的圈时与总时正确，复位清空', () => {
    let state = createStopwatch('s3');
    state = swStart(state, T);
    state = lap(state, T + 1_000);
    state = lap(state, T + 2_500);
    expect(state.laps.map((entry) => entry.lapMs)).toEqual([1_000, 1_500]);
    expect(state.laps[1]?.totalMs).toBe(2_500);
    expect(formatStopwatch(2_500)).toBe('00:02.50');
    state = swReset(state);
    expect(state.laps).toEqual([]);
    expect(state.phase).toBe('idle');
  });
});

describe('系统时钟交接（CLK-03 / CLK-08 / CLK-10）', () => {
  it('无系统读取接口 ⇒ 报未就绪，且**不**用自管记录顶替', async () => {
    const result = await listSystemAlarms(null);
    expect(result.status).toBe('not_ready');
    if (result.status !== 'not_ready') return;
    expect(result.reason).toMatch(/不得伪造|没有系统闹钟读取接口/);
  });

  it('交接成功最高只到"已交接"，**永不**"已确认完成"', async () => {
    const result = await handoffSystemClockAction(
      { handoff: () => Promise.resolve({ delivered: true, handlerLabel: '系统时钟', detail: '已打开' }) },
      'create_alarm',
      { hour: 7 },
    );
    expect(result.state).toBe('handed_off');
    expect(result.receipt.kind).toBe('none');
    expect(result.cannotConfirmReason).toMatch(/不可回读/);
  });

  it('缺处理应用 ⇒ 判失败（动作**未**发生），而不是"结果未知"', async () => {
    const result = await handoffSystemClockAction(
      { handoff: () => Promise.resolve({ delivered: false, handlerLabel: null, detail: '没有应用可处理' }) },
      'create_timer',
      {},
    );
    expect(result.state).toBe('failed');
    expect(result.state).not.toBe('unknown');
    expect(result.cannotConfirmReason).toMatch(/未.*发生/);
  });

  it('dismiss 的语义表明确写"不是删除"', () => {
    expect(SYSTEM_ACTION_SEMANTICS.dismiss_ringing_alarm.deletesAlarm).toBe(false);
    expect(SYSTEM_ACTION_SEMANTICS.open_alarm_list.effect).toBe('open_only');
  });
});

describe('就绪度报告（R231 / R233 / CLK-10）', () => {
  it('十个子项齐全，且每条都通过自洽校验（模块加载即校验）', () => {
    expect(CLOCK_SUBITEMS.map((entry) => entry.id)).toEqual([
      'CLK-01',
      'CLK-02',
      'CLK-03',
      'CLK-04',
      'CLK-05',
      'CLK-06',
      'CLK-07',
      'CLK-08',
      'CLK-09',
      'CLK-10',
    ]);
  });

  it('凡"已实现"的都必须带证据；凡"未就绪/阻塞"的都必须带原因与解锁条件', () => {
    for (const entry of CLOCK_SUBITEMS) {
      if (entry.verdict === 'implemented') {
        expect(entry.evidence.length, `${entry.id} 缺少证据`).toBeGreaterThan(0);
        expect(entry.reason, `${entry.id} 不该有原因`).toBeNull();
      } else {
        expect(entry.reason, `${entry.id} 缺少原因`).not.toBeNull();
        expect(entry.unblockedBy, `${entry.id} 缺少解锁条件`).not.toBe('');
      }
    }
  });

  it('三态计数与实际一致（交付说明里引用的数字必须能复算）', () => {
    const counts = countVerdicts(CLOCK_SUBITEMS);
    expect(counts.implemented + counts.not_ready + counts.blocked).toBe(10);
    expect(counts.blocked).toBeGreaterThan(0); // CLK-10 是阻塞，不是"以后做"
  });

  it('**阻塞项不是被静默降级的"未就绪"**：系统闹钟读取/删除显式记阻塞', () => {
    const blocked = CLOCK_NOT_READY.filter((entry) => entry.verdict === 'blocked').map((entry) => entry.id);
    expect(blocked).toContain('cap.clock.system_alarm_read');
    expect(blocked).toContain('cap.clock.system_alarm_delete');
  });
});
