/**
 * 自管调度入口用例（CLK-01 / CLK-02 的**不依赖真机**部分）。
 *
 * 时区注入固定偏移表 ⇒ 全部断言可复现、与宿主 tzdata 无关。
 * 每项能力都带一条**反向对照**（正确路径之外，把"不许发生的路径"也钉成断言）。
 *
 * ⚠️ 真机侧（系统写入 / 实际触发）**未验证（需真机）**——本文件只覆盖自管纯逻辑。
 */

import { describe, expect, it } from 'vitest';

import { createAlarmStore } from './alarm-store.js';
import {
  assertOwnershipConsistent,
  assertSelfManagedCreationAllowed,
  chooseCandidate,
  commitSchedule,
  dailyRule,
  datesRule,
  describeOwnership,
  handleOfRecord,
  identityOf,
  localRecordIdOf,
  monthlyRule,
  onceRule,
  ownershipOf,
  parseWeekday,
  proposeSchedule,
  setEnabled,
  weeklyRule,
  weekdayName,
  workdaysRule,
  type OwnedHandle,
} from './alarm-schedule.js';
import type { Weekday } from './types.js';
import { wallToEpoch } from './civil.js';
import { createFixedZonePort } from './zone.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480, 'America/New_York': -300 });
/** 2026-08-01T00:00:00Z（= 上海 08:00）。 */
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 0, minute: 0, second: 0 }, 0);
const CTX = { nowMs: T, zonePort: ZONES } as const;

const makeStore = () => {
  let counter = 0;
  return createAlarmStore({
    zonePort: ZONES,
    idSource: () => {
      counter += 1;
      return `local-${String(counter)}`;
    },
  });
};

describe('CLK-01 归属与 ID（自管 / 系统交接 / 厂商）', () => {
  it('三种归属各自记录真实归属与 ID', () => {
    const self: OwnedHandle = { ownership: 'self_managed', id: 'local-1' };
    const handoff: OwnedHandle = { ownership: 'system_handoff', handoffId: 'rcpt-9', handlerLabel: '时钟' };
    const vendor: OwnedHandle = { ownership: 'vendor_readable', vendorId: 'vendor-77', vendorLabel: '某厂商时钟' };

    expect(ownershipOf(self)).toBe('self_managed');
    expect(identityOf(self)).toBe('local-1');
    expect(ownershipOf(handoff)).toBe('system_handoff');
    expect(identityOf(handoff)).toBe('rcpt-9');
    expect(ownershipOf(vendor)).toBe('vendor_readable');
    expect(identityOf(vendor)).toBe('vendor-77');

    // 展示文本必须带上真实归属，不能含糊成"闹钟"。
    expect(describeOwnership(self)).toContain('自管');
    expect(describeOwnership(handoff)).toContain('交接');
    expect(describeOwnership(vendor)).toContain('厂商');
  });

  it('**系统 / 厂商对象没有本地可写记录 ID**（不得用自管记录冒充）', () => {
    const handoff: OwnedHandle = { ownership: 'system_handoff', handoffId: null, handlerLabel: null };
    const vendor: OwnedHandle = { ownership: 'vendor_readable', vendorId: 'v1', vendorLabel: 'v' };
    expect(localRecordIdOf(handoff)).toBeNull();
    expect(localRecordIdOf(vendor)).toBeNull();
    // 反向对照：自管对象必须有本地 ID。
    expect(localRecordIdOf({ ownership: 'self_managed', id: 'local-1' })).toBe('local-1');
    // 外部未给回执 ID 时如实为 null，**不编造**。
    expect(identityOf(handoff)).toBeNull();
  });

  it('**反向对照**：不得把系统交接对象当作自管提醒创建', () => {
    const self: OwnedHandle = { ownership: 'self_managed', id: 'local-1' };
    expect(() => assertSelfManagedCreationAllowed(self)).not.toThrow();
    const handoff: OwnedHandle = { ownership: 'system_handoff', handoffId: 'r1', handlerLabel: 'x' };
    expect(() => assertSelfManagedCreationAllowed(handoff)).toThrow(/自管/);
    const vendor: OwnedHandle = { ownership: 'vendor_readable', vendorId: 'v1', vendorLabel: 'v' };
    expect(() => assertSelfManagedCreationAllowed(vendor)).toThrow();
  });

  it('归属自检拒绝空 ID；记录的句柄与记录一致', () => {
    expect(() => assertOwnershipConsistent({ ownership: 'self_managed', id: '  ' })).toThrow(/ID/);
    expect(() => assertOwnershipConsistent({ ownership: 'self_managed', id: 'local-1' })).not.toThrow();

    const store = makeStore();
    const created = store.create(
      { label: '起床', zoneId: 'UTC', firstTriggerMs: T, repeat: onceRule() },
      'k1',
    );
    if (!created.ok) throw new Error('前置失败');
    expect(handleOfRecord(created.record)).toEqual({ ownership: 'self_managed', id: created.record.id });
    expect(created.record.ownership).toBe('self_managed');
  });
});

describe('CLK-02 重复规则构造（工作日 / 指定日期 / 单次 / 重复）', () => {
  it('构造出预期的规则对象', () => {
    expect(onceRule()).toEqual({ kind: 'once' });
    expect(dailyRule(2)).toEqual({ kind: 'daily', interval: 2 });
    expect(workdaysRule()).toEqual({ kind: 'workdays' });
    expect(weeklyRule([1, 3], 2)).toEqual({ kind: 'weekly', interval: 2, weekdays: [1, 3] });
    expect(monthlyRule([1, 15])).toEqual({ kind: 'monthly', interval: 1, daysOfMonth: [1, 15] });
    expect(datesRule(['2026-08-05', '2026-09-01'])).toEqual({
      kind: 'dates',
      dates: ['2026-08-05', '2026-09-01'],
    });
  });

  it('星期名解析（中文与数字）', () => {
    expect(parseWeekday('周一')).toBe(1);
    expect(parseWeekday('星期一')).toBe(1);
    expect(parseWeekday('周日')).toBe(0);
    expect(parseWeekday('星期天')).toBe(0);
    expect(parseWeekday('六')).toBe(6);
    expect(parseWeekday('3')).toBe(3);
    expect(weekdayName(1)).toBe('周一');
    // 反向对照：看不懂的星期名如实为 null，不猜。
    expect(parseWeekday('周八')).toBeNull();
    expect(parseWeekday('昨天')).toBeNull();
    expect(parseWeekday('')).toBeNull();
  });

  it('规则对象被复制而非共享引用（构造器不暴露内部数组）', () => {
    const days: Weekday[] = [1, 3, 5];
    const rule = weeklyRule(days);
    days.push(6);
    expect(rule).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 3, 5] });
  });
});

describe('CLK-02 相对时间解析为绝对时刻供核对', () => {
  it('「10 分钟后」给出**绝对时刻**并要求核对', () => {
    const proposal = proposeSchedule(
      { label: '喝水', zoneId: 'Asia/Shanghai', repeat: onceRule(), whenText: '10分钟后' },
      CTX,
    );
    expect(proposal.kind).toBe('ready');
    expect(proposal.absoluteMs).toBe(T + 10 * 60_000);
    expect(proposal.absoluteLocal).toBe('2026-08-01 08:10');
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.sourceText).toBe('10分钟后');
  });

  it('绝对时刻输入直接可用（无需核对）', () => {
    const proposal = proposeSchedule(
      { label: '会议', zoneId: 'UTC', repeat: weeklyRule([1]), atMs: T + 3_600_000 },
      CTX,
    );
    expect(proposal.kind).toBe('ready');
    expect(proposal.absoluteMs).toBe(T + 3_600_000);
    expect(proposal.absoluteLocal).toBe('2026-08-01 01:00');
    expect(proposal.requiresConfirmation).toBe(false);
  });

  it('歧义时间**不替用户选**：给候选，绝对时刻为 null', () => {
    const proposal = proposeSchedule(
      { label: '起床', zoneId: 'Asia/Shanghai', repeat: dailyRule(), whenText: '明天7点' },
      CTX,
    );
    expect(proposal.kind).toBe('needs_choice');
    expect(proposal.absoluteMs).toBeNull();
    expect(proposal.candidates.map((candidate) => candidate.local)).toEqual([
      '2026-08-02 07:00',
      '2026-08-02 19:00',
    ]);
    // 用户选定后才落成绝对时刻，且仍需核对。
    const chosen = chooseCandidate(proposal, proposal.candidates[1]?.epochMs ?? 0);
    expect(chosen.kind).toBe('ready');
    expect(chosen.absoluteLocal).toBe('2026-08-02 19:00');
    expect(chosen.requiresConfirmation).toBe(true);
  });

  it('**反向对照**：看不懂的表达 ⇒ invalid 且 absoluteMs 为 null（不猜）', () => {
    const proposal = proposeSchedule(
      { label: '随便', zoneId: 'Asia/Shanghai', repeat: onceRule(), whenText: '什么时候都行' },
      CTX,
    );
    expect(proposal.kind).toBe('invalid');
    expect(proposal.absoluteMs).toBeNull();
    expect(proposal.reason).not.toBeNull();
  });

  it('**反向对照**：时间两缺 / 两给 / 未知时区 / 非法规则 ⇒ 全部 invalid', () => {
    const missing = proposeSchedule({ label: 'x', zoneId: 'UTC', repeat: onceRule() }, CTX);
    expect(missing.kind).toBe('invalid');

    const both = proposeSchedule(
      { label: 'x', zoneId: 'UTC', repeat: onceRule(), whenText: '10分钟后', atMs: T },
      CTX,
    );
    expect(both.kind).toBe('invalid');
    expect(both.problems.join()).toContain('只能给出');

    const badZone = proposeSchedule(
      { label: 'x', zoneId: 'Mars/Base', repeat: onceRule(), atMs: T },
      CTX,
    );
    expect(badZone.kind).toBe('invalid');
    expect(badZone.problems.join()).toContain('时区未知');

    const badRule = proposeSchedule(
      { label: 'x', zoneId: 'UTC', repeat: { kind: 'daily', interval: 0 }, atMs: T },
      CTX,
    );
    expect(badRule.kind).toBe('invalid');

    const emptyLabel = proposeSchedule(
      { label: '   ', zoneId: 'UTC', repeat: onceRule(), atMs: T },
      CTX,
    );
    expect(emptyLabel.kind).toBe('invalid');
  });

  it('**反向对照**：chooseCandidate 不得凭空构造时刻', () => {
    const proposal = proposeSchedule(
      { label: '起床', zoneId: 'Asia/Shanghai', repeat: dailyRule(), whenText: '明天7点' },
      CTX,
    );
    expect(() => chooseCandidate(proposal, 0)).toThrow(/候选/);
    const ready = proposeSchedule({ label: 'x', zoneId: 'UTC', repeat: onceRule(), atMs: T }, CTX);
    expect(() => chooseCandidate(ready, T)).toThrow(); // ready 不是 needs_choice
  });
});

describe('CLK-02 创建与会话核对（含 CLK-04 幂等）', () => {
  it('ready 提案可落地，且重复键不重复创建', () => {
    const store = makeStore();
    const proposal = proposeSchedule(
      { label: '喝水', zoneId: 'Asia/Shanghai', repeat: onceRule(), whenText: '10分钟后' },
      CTX,
    );
    const first = commitSchedule(store, proposal, 'idem-1');
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(first.record?.firstTriggerMs).toBe(T + 600_000);

    const second = commitSchedule(store, proposal, 'idem-1');
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.record?.id).toBe(first.record?.id);
    expect(store.list()).toHaveLength(1);
  });

  it('**反向对照**：非 ready 提案拒绝落地', () => {
    const store = makeStore();
    const ambiguous = proposeSchedule(
      { label: '起床', zoneId: 'Asia/Shanghai', repeat: dailyRule(), whenText: '明天7点' },
      CTX,
    );
    const result = commitSchedule(store, ambiguous, 'idem-x');
    expect(result.ok).toBe(false);
    expect(result.record).toBeNull();
    expect(store.list()).toHaveLength(0);
    expect(result.problems.join()).toContain('ready');
  });

  it('启用态可切换（CLK-02「启用状态」）', () => {
    const store = makeStore();
    const created = store.create(
      { label: '起床', zoneId: 'UTC', firstTriggerMs: T, repeat: workdaysRule() },
      'k1',
    );
    if (!created.ok) throw new Error('前置失败');
    expect(created.record.enabled).toBe(true);
    const off = setEnabled(store, created.record.id, false, created.record.revision);
    expect(off.ok).toBe(true);
    expect(off.record?.enabled).toBe(false);
    // 反向对照：陈旧版本被拒，原记录不变。
    const stale = setEnabled(store, created.record.id, true, created.record.revision);
    expect(stale.ok).toBe(false);
    expect(store.get(created.record.id)?.enabled).toBe(false);
  });
});
