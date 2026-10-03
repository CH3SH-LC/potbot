/**
 * 自管查询 / 变更用例（CLK-03 / CLK-04 的**不依赖真机**部分）。
 *
 * ⚠️ 真机侧（系统闹钟实际写入 / 读取）**未验证（需真机）**；本文件只覆盖自管纯逻辑，
 * 以及"没有系统读取接口就如实报未知"这一条**必须在无设备时也成立**的断言。
 */

import { describe, expect, it } from 'vitest';

import { createAlarmStore } from './alarm-store.js';
import {
  MANAGED_SCOPE_DISCLAIMER,
  cancelOneOccurrence,
  createManagedAlarm,
  managedAlarmById,
  queryManagedAlarms,
  querySystemAlarms,
  removeManagedAlarm,
  setManagedEnabled,
  updateManagedAlarm,
} from './alarm-query.js';
import { wallToEpoch } from './civil.js';
import type { SystemAlarmReadPort } from './handoff.js';
import { dailyRule, workdaysRule } from './alarm-schedule.js';
import { createFixedZonePort } from './zone.js';

const ZONES = createFixedZonePort({ UTC: 0, 'Asia/Shanghai': 480 });
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 0, minute: 0, second: 0 }, 0);
const DAY = 86_400_000;

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

const seed = (store: ReturnType<typeof makeStore>) => {
  const a = store.create(
    { label: '起床', zoneId: 'UTC', firstTriggerMs: T, repeat: dailyRule() },
    'seed-a',
  );
  const b = store.create(
    { label: '站会', zoneId: 'Asia/Shanghai', firstTriggerMs: T + DAY, repeat: workdaysRule() },
    'seed-b',
  );
  if (!a.ok || !b.ok) throw new Error('前置失败');
  return { a: a.record, b: b.record };
};

describe('CLK-03 查询 / 筛选自管提醒（下次触发 + 重复规则）', () => {
  it('只列自管提醒，并给出下次触发与重复规则', () => {
    const store = makeStore();
    seed(store);
    const result = queryManagedAlarms({ store, zonePort: ZONES, nowMs: T });

    expect(result.scope).toBe('self_managed_only');
    expect(result.disclaimer).toContain('不是');
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.ownership === 'self_managed')).toBe(true);
    const morning = result.rows.find((row) => row.label === '起床');
    expect(morning?.repeatText).toBe('每天');
    expect(morning?.nextTriggerText).toBe('2026-08-02 00:00');
  });

  it('按启用态 / 标签 / 时区 / 下次触发筛选', () => {
    const store = makeStore();
    const { a, b } = seed(store);
    // 关掉一条。
    const off = setManagedEnabled(store, b.id, false, b.revision);
    expect(off.ok).toBe(true);

    const enabledOnly = queryManagedAlarms(
      { store, zonePort: ZONES, nowMs: T },
      { includeDisabled: false },
    );
    expect(enabledOnly.rows.map((row) => row.label)).toEqual(['起床']);

    // 反向对照：默认**包含**已禁用项（不悄悄过滤）。
    const allDefault = queryManagedAlarms({ store, zonePort: ZONES, nowMs: T });
    expect(allDefault.rows.map((row) => row.label).sort()).toEqual(['站会', '起床']);

    expect(
      queryManagedAlarms({ store, zonePort: ZONES, nowMs: T }, { labelContains: '站' }).rows.map(
        (row) => row.label,
      ),
    ).toEqual(['站会']);
    expect(
      queryManagedAlarms({ store, zonePort: ZONES, nowMs: T }, { zoneId: 'Asia/Shanghai' }).rows.map(
        (row) => row.label,
      ),
    ).toEqual(['站会']);
    expect(
      queryManagedAlarms({ store, zonePort: ZONES, nowMs: T }, { nextBeforeMs: T + DAY + 1 }).rows.map(
        (row) => row.label,
      ),
    ).toEqual(['起床']);
    expect(managedAlarmById({ store, zonePort: ZONES, nowMs: T }, a.id)?.id).toBe(a.id);
    expect(managedAlarmById({ store, zonePort: ZONES, nowMs: T }, 'nope')).toBeNull();
  });

  it('作用域说明**明确**声明不是手机全部闹钟', () => {
    expect(MANAGED_SCOPE_DISCLAIMER).toContain('不是');
    expect(MANAGED_SCOPE_DISCLAIMER).toContain('自管');
  });
});

describe('CLK-03 系统闹钟读取：恒不可下结论（不伪造"没有闹钟"）', () => {
  const emptyPort: SystemAlarmReadPort = { list: async () => [] };
  const somePort: SystemAlarmReadPort = {
    list: async () => [{ id: 's1', label: '起床', hour: 7, minute: 30, enabled: true }],
  };

  it('没有读取接口 ⇒ unreadable，且**没有** alarms 字段', async () => {
    const listing = await querySystemAlarms(null);
    expect(listing.status).toBe('unreadable');
    expect(listing.conclusive).toBe(false);
    expect('alarms' in listing).toBe(false);
    if (listing.status === 'unreadable') {
      expect(listing.reason).toContain('没有系统闹钟读取接口');
      expect(listing.guidance.length).toBeGreaterThan(0);
    }
  });

  it('**反向对照**：接口返回空数组也**不得**冒充"没有闹钟"', async () => {
    const listing = await querySystemAlarms(emptyPort);
    expect(listing.status).toBe('unreadable');
    expect(listing.conclusive).toBe(false);
    expect('alarms' in listing).toBe(false);
    if (listing.status === 'unreadable') {
      expect(listing.reason).toContain('空结果不等于');
    }
  });

  it('厂商接口读到内容也只算"部分只读、不可下结论"', async () => {
    const listing = await querySystemAlarms(somePort, 'vendor_clock');
    expect(listing.status).toBe('partial_vendor_read');
    expect(listing.conclusive).toBe(false);
    if (listing.status === 'partial_vendor_read') {
      expect(listing.alarms).toHaveLength(1);
      expect(listing.source).toBe('vendor_clock');
      expect(listing.caveat).toContain('只读');
    }
  });

  it('三种结果合起来：任何分支都**不会**返回空数组', async () => {
    const listings = [await querySystemAlarms(null), await querySystemAlarms(emptyPort), await querySystemAlarms(somePort)];
    for (const listing of listings) {
      expect(listing.conclusive).toBe(false);
      if ('alarms' in listing) {
        expect(listing.alarms.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('CLK-04 修改 / 启停 / 删除 / 取消一次发生（幂等 + 版本绑定）', () => {
  it('修改时间 / 标签 / 重复后，查询到的**是同一个对象**且反映新值', () => {
    const store = makeStore();
    const { a } = seed(store);
    const outcome = updateManagedAlarm(
      store,
      a.id,
      { label: '早起', firstTriggerMs: T + 3_600_000, repeat: workdaysRule() },
      a.revision,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.applied).toBe(true);
    const row = managedAlarmById({ store, zonePort: ZONES, nowMs: T }, a.id);
    expect(row?.id).toBe(a.id);
    expect(row?.label).toBe('早起');
    expect(row?.repeatText).toContain('工作日');
  });

  it('**反向对照**：陈旧版本被拒、对象**未被改动**', () => {
    const store = makeStore();
    const { a } = seed(store);
    const stale = updateManagedAlarm(store, a.id, { label: '不该生效' }, a.revision + 5);
    expect(stale.ok).toBe(false);
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe('revision_conflict');
    expect(store.get(a.id)?.label).toBe('起床');
  });

  it('启用 / 禁用可切换；找不到目标时如实报 not_found', () => {
    const store = makeStore();
    const { a } = seed(store);
    const off = setManagedEnabled(store, a.id, false, a.revision);
    expect(off.applied).toBe(true);
    expect(off.record?.enabled).toBe(false);
    const missing = setManagedEnabled(store, 'nope', true, 1);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not_found');
    expect(missing.applied).toBe(false);
  });

  it('取消**一次发生**：只跳过该次，**不删除整条**', () => {
    const store = makeStore();
    const { a } = seed(store);
    const firstNext = store.nextTrigger(a.id, T);
    expect(firstNext).toBe(T + DAY);

    const cancelled = cancelOneOccurrence(store, a.id, T + DAY, a.revision);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.applied).toBe(true);
    expect(cancelled.record?.skippedDates).toContain('2026-08-02');
    // 记录**还在**（这是"取消一次"而不是"删除"）。
    expect(store.get(a.id)).not.toBeNull();
    // 下次触发往后挪了一次。
    expect(store.nextTrigger(a.id, T)).toBe(T + 2 * DAY);
  });

  it('删除整条：对象消失（与"取消一次"语义不同）', () => {
    const store = makeStore();
    const { a, b } = seed(store);
    const removed = removeManagedAlarm(store, a.id, a.revision);
    expect(removed.ok).toBe(true);
    expect(store.get(a.id)).toBeNull();
    expect(store.get(b.id)).not.toBeNull();
    expect(queryManagedAlarms({ store, zonePort: ZONES, nowMs: T }).rows).toHaveLength(1);
  });

  it('幂等：同一键重放**不重复创建**', () => {
    const store = makeStore();
    const draft = { label: '喝水', zoneId: 'UTC', firstTriggerMs: T, repeat: dailyRule() };
    const first = createManagedAlarm(store, draft, 'intent-1');
    const second = createManagedAlarm(store, draft, 'intent-1');
    expect(first.ok && second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.record?.id).toBe(first.record?.id);
    expect(queryManagedAlarms({ store, zonePort: ZONES, nowMs: T }).rows).toHaveLength(1);
    // 反向对照：不同键 ⇒ 真的新建一条。
    const third = createManagedAlarm(store, draft, 'intent-2');
    expect(third.duplicate).toBe(false);
    expect(queryManagedAlarms({ store, zonePort: ZONES, nowMs: T }).rows).toHaveLength(2);
  });

  it('**反向对照**：非法草稿被拒，不产生半成品记录', () => {
    const store = makeStore();
    const bad = createManagedAlarm(
      store,
      { label: '', zoneId: 'UTC', firstTriggerMs: T, repeat: dailyRule() },
      'intent-bad',
    );
    expect(bad.ok).toBe(false);
    expect(bad.record).toBeNull();
    expect(store.list()).toHaveLength(0);
  });
});
