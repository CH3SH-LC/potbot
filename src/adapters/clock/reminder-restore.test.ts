/**
 * 自管提醒重启恢复 / 时区变化 / 精确提醒状态用例（CLK-07 的**不依赖真机**部分）。
 *
 * ⚠️ **真实触发 / 通知状态 / 精确提醒权限**在真机上观察才算验证——本文件**未验证**这些，
 * 只覆盖：快照恢复、时区变化的重算与如实报告、以及"调度依据必须是绝对时刻"的断言。
 */

import { describe, expect, it } from 'vitest';

import { createAlarmStore } from './alarm-store.js';
import { wallToEpoch } from './civil.js';
import { dailyRule } from './alarm-schedule.js';
import {
  RESTORE_SNAPSHOT_VERSION,
  assertAbsoluteScheduling,
  captureSnapshot,
  describeSchedulingDiscipline,
  inspectPreciseReminderStatus,
  planNextTrigger,
  rebaseOnZoneOrTimeChange,
  restoreStore,
  type PreciseReminderInput,
  type RestoreSnapshot,
  type SchedulePlan,
} from './reminder-restore.js';
import { createFixedZonePort, type ZonePort } from './zone.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 0, minute: 0, second: 0 }, 0);
const DAY = 86_400_000;

const counterId = () => {
  let n = 0;
  return () => {
    n += 1;
    return `restored-${String(n)}`;
  };
};

const makeStore = () => {
  let n = 0;
  return createAlarmStore({
    zonePort: ZONES,
    idSource: () => {
      n += 1;
      return `local-${String(n)}`;
    },
  });
};

const draft = { label: '起床', zoneId: 'UTC', firstTriggerMs: T, repeat: dailyRule() };

describe('CLK-07 重启恢复（快照 → 重建）', () => {
  it('恢复后 ID、字段与下次触发与重启前一致', () => {
    const store = makeStore();
    const created = store.create(draft, 'k1');
    if (!created.ok) throw new Error('前置失败');
    const before = store.nextTrigger(created.record.id, T);
    expect(before).toBe(T + DAY);

    const snapshot = captureSnapshot(store, T + 1_000);
    expect(snapshot.version).toBe(RESTORE_SNAPSHOT_VERSION);

    const report = restoreStore({ zonePort: ZONES, idSource: counterId() }, snapshot);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.restoredIds).toEqual([created.record.id]);
    expect(report.store.get(created.record.id)?.label).toBe('起床');
    expect(report.store.nextTrigger(created.record.id, T)).toBe(before);

    // 幂等键也被恢复：重放同一个键仍然不重复创建。
    const replay = report.store.create(draft, 'k1');
    expect(replay.ok && replay.duplicate).toBe(true);
    expect(report.store.list()).toHaveLength(1);
  });

  it('**反向对照**：个别记录读不懂 ⇒ 报问题并跳过，其余照常恢复', () => {
    const store = makeStore();
    const good = store.create(draft, 'k1');
    if (!good.ok) throw new Error('前置失败');
    const snapshot = captureSnapshot(store, T);
    const parsed = JSON.parse(snapshot.storeJson) as { records: unknown[]; idempotency: unknown };
    parsed.records.push({ id: 'broken', ownership: 'self_managed', label: 42 });
    const dirty: RestoreSnapshot = { ...snapshot, storeJson: JSON.stringify(parsed) };

    const report = restoreStore({ zonePort: ZONES, idSource: counterId() }, dirty);
    expect(report.restoredIds).toEqual([good.record.id]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.kind).toBe('record_unreadable');
    expect(report.problems[0]?.id).toBe('broken');
    expect(report.ok).toBe(false);
  });

  it('**反向对照**：版本不符 / JSON 损坏 ⇒ 一条都不恢复，且如实报因', () => {
    const store = makeStore();
    store.create(draft, 'k1');
    const snapshot = captureSnapshot(store, T);

    const wrongVersion = restoreStore(
      { zonePort: ZONES, idSource: counterId() },
      { ...snapshot, version: 99 },
    );
    expect(wrongVersion.restoredIds).toEqual([]);
    expect(wrongVersion.problems[0]?.kind).toBe('version_mismatch');

    const broken = restoreStore(
      { zonePort: ZONES, idSource: counterId() },
      { ...snapshot, storeJson: '{not json' },
    );
    expect(broken.restoredIds).toEqual([]);
    expect(broken.problems[0]?.kind).toBe('unparsable_snapshot');
  });
});

describe('CLK-07 时区 / 系统时间变化（不自动改，只如实报告）', () => {
  it('同一绝对时刻、本地显示变化 ⇒ 报差异并要求用户确认', () => {
    const store = makeStore();
    const created = store.create(draft, 'k1');
    if (!created.ok) throw new Error('前置失败');

    // 时区侧偏移从 0 变成 +480（同一 zoneId）：绝对触发点不变，本地显示从 00:00 变成 08:00。
    const shifted = createFixedZonePort({ UTC: 480, 'Asia/Shanghai': 480 });
    const report = rebaseOnZoneOrTimeChange(created.record, ZONES, shifted, T);
    expect(report.absoluteChanged).toBe(false);
    expect(report.localDisplayChanged).toBe(true);
    expect(report.nextTriggerLocalBefore).toBe('2026-08-02 00:00');
    expect(report.nextTriggerLocalAfter).toBe('2026-08-02 08:00');
    expect(report.requiresUserConfirmation).toBe(true);
    expect(report.note).toContain('不');
  });

  it('**反向对照**：没有任何变化 ⇒ 不需要确认', () => {
    const store = makeStore();
    const created = store.create(draft, 'k1');
    if (!created.ok) throw new Error('前置失败');
    const report = rebaseOnZoneOrTimeChange(created.record, ZONES, ZONES, T);
    expect(report.absoluteChanged).toBe(false);
    expect(report.localDisplayChanged).toBe(false);
    expect(report.requiresUserConfirmation).toBe(false);
  });

  it('**反向对照**：变化后算不出触发点（时区未知）⇒ 如实为 null 并要确认', () => {
    const store = makeStore();
    const created = store.create(draft, 'k1');
    if (!created.ok) throw new Error('前置失败');
    const blind: ZonePort = { offsetMinutesAt: () => null };
    const report = rebaseOnZoneOrTimeChange(created.record, ZONES, blind, T);
    expect(report.nextTriggerMs).toBeNull();
    expect(report.nextTriggerLocalAfter).toBeNull();
    expect(report.absoluteChanged).toBe(true);
    expect(report.requiresUserConfirmation).toBe(true);
  });
});

describe('CLK-07 精确提醒权限与通知状态', () => {
  it('**无设备**：全 unknown、不承诺准点，并标注未验证（需真机）', () => {
    const status = inspectPreciseReminderStatus(null);
    expect(status.exactAlarmPermission).toBe('unknown');
    expect(status.notificationsEnabled).toBe('unknown');
    expect(status.canGuaranteeOnTime).toBe(false);
    expect(status.verdict).toBe('unknown');
    expect(status.reason).toContain('未验证（需真机）');
  });

  it('四项齐全且通道已装配 ⇒ ready', () => {
    const input: PreciseReminderInput = {
      exactAlarmPermission: 'granted',
      notificationsPermission: 'granted',
      notificationsEnabled: 'granted',
      batteryOptimizationIgnored: 'granted',
      schedulerChannelInstalled: true,
    };
    const status = inspectPreciseReminderStatus(input);
    expect(status.canGuaranteeOnTime).toBe(true);
    expect(status.verdict).toBe('ready');
  });

  it('**反向对照**：任一被拒 / 通道未装配 ⇒ not_ready，不得承诺准点', () => {
    const denied: PreciseReminderInput = {
      exactAlarmPermission: 'denied',
      notificationsPermission: 'granted',
      notificationsEnabled: 'granted',
      batteryOptimizationIgnored: 'granted',
      schedulerChannelInstalled: true,
    };
    const status = inspectPreciseReminderStatus(denied);
    expect(status.canGuaranteeOnTime).toBe(false);
    expect(status.verdict).toBe('not_ready');

    const noChannel = inspectPreciseReminderStatus({
      exactAlarmPermission: 'granted',
      notificationsPermission: 'granted',
      notificationsEnabled: 'granted',
      batteryOptimizationIgnored: 'granted',
      schedulerChannelInstalled: false,
    });
    expect(noChannel.canGuaranteeOnTime).toBe(false);
    expect(noChannel.verdict).toBe('not_ready');
  });
});

describe('CLK-07 调度依据：绝对时刻，**不是**轮询', () => {
  it('计划是绝对时刻，且 pollIntervalMs 恒为 null', () => {
    const store = makeStore();
    const created = store.create(draft, 'k1');
    if (!created.ok) throw new Error('前置失败');
    const plan = planNextTrigger(created.record, ZONES, T);
    expect(plan).not.toBeNull();
    if (plan === null || plan.basis !== 'absolute_instant') throw new Error('应为绝对时刻计划');
    expect(plan.basis).toBe('absolute_instant');
    expect(plan.triggerMs).toBe(T + DAY);
    expect(plan.pollIntervalMs).toBeNull();
    expect(assertAbsoluteScheduling(plan as SchedulePlan)).toEqual({
      alarmId: created.record.id,
      triggerMs: T + DAY,
    });
    expect(describeSchedulingDiscipline()).toContain('绝对时刻');
  });

  it('**反向对照**：轮询计划被**拒绝**（CLK-07 禁止用轮询保证准点）', () => {
    const polling: SchedulePlan = {
      basis: 'poll_interval',
      alarmId: 'a1',
      intervalMs: 1_000,
      triggerMs: null,
    };
    expect(() => assertAbsoluteScheduling(polling)).toThrow(/轮询/);
  });

  it('**反向对照**：禁用 / 无下一次 ⇒ 没有计划（不硬造一个）', () => {
    const store = makeStore();
    const created = store.create(draft, 'k1');
    if (!created.ok) throw new Error('前置失败');
    const off = store.setEnabled(created.record.id, false, created.record.revision);
    if (!off.ok) throw new Error('前置失败');
    expect(planNextTrigger(off.record, ZONES, T)).toBeNull();

    const once = store.create(
      { label: '一次性', zoneId: 'UTC', firstTriggerMs: T, repeat: { kind: 'once' } },
      'k2',
    );
    if (!once.ok) throw new Error('前置失败');
    // 单次已过（现在是 T 之后）⇒ 无下一次。
    expect(planNextTrigger(once.record, ZONES, T + 1)).toBeNull();
  });
});
