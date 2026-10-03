/**
 * K10 独立验证 ①：前台服务与**有界常驻**。
 *
 * 断言的重点不是"能提升"这种顺路径，而是三条**负例**：
 * 长任务不许伪装成后台延迟工作；无通知权限不许偷偷常驻；超预算必须降级而不是继续假装在跑。
 */

import { describe, expect, it } from 'vitest';

import { newCoordinator, errorCodeOf } from './fixtures.js';

describe('K10 ① 前台服务：可见长任务必须有通知', () => {
  it('前台可见任务提升后恰好一条 ongoing 通知，finish 后通知被撤', () => {
    const h = newCoordinator();
    h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '生成季度报表', expectedDurationMs: 120_000 });

    const promotion = h.coordinator.promote('t1');
    expect(promotion.notificationId).toBe('fgs:t1');
    expect(h.notifications.activeCount()).toBe(1);
    expect(h.notifications.history()).toHaveLength(1);
    expect(h.notifications.history()[0]).toMatchObject({
      notificationId: 'fgs:t1',
      title: '生成季度报表',
      ongoing: true,
    });

    expect(h.coordinator.markRunning('t1').state).toBe('running');
    expect(h.coordinator.finish('t1').state).toBe('finished');
    expect(h.notifications.activeCount()).toBe(0);
    expect(h.coordinator.activeForegroundCount()).toBe(0);
  });

  it('声明为后台延迟、但预期时长超过门槛的长任务被拒（不得伪装成延迟工作）', () => {
    const h = newCoordinator({ thresholdMs: 10_000 });
    expect(
      errorCodeOf(() =>
        h.coordinator.register({ taskId: 'long', visibility: 'background-deferred', title: '长任务', expectedDurationMs: 60_000 }),
      ),
    ).toBe('long_task_requires_foreground');
    // 短延迟工作仍可登记。
    expect(
      h.coordinator.register({ taskId: 'short', visibility: 'background-deferred', title: '短任务', expectedDurationMs: 5_000 }).state,
    ).toBe('registered');
  });

  it('通知权限被拒 ⇒ 提升失败且状态不变、零通知（fail-closed，不许无通知常驻）', () => {
    const h = newCoordinator({ permission: 'denied' });
    h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '任务', expectedDurationMs: 5_000 });

    expect(errorCodeOf(() => h.coordinator.promote('t1'))).toBe('notification_permission_denied');
    expect(h.coordinator.get('t1')?.state).toBe('registered');
    expect(h.notifications.activeCount()).toBe(0);
    // 权限未恢复前，即使想跑也跑不起来（必须先 promote 成功）。
    expect(errorCodeOf(() => h.coordinator.markRunning('t1'))).toBe('task_not_foreground');
  });

  it('未经提升就运行 ⇒ task_not_foreground', () => {
    const h = newCoordinator();
    h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '任务', expectedDurationMs: 5_000 });
    expect(errorCodeOf(() => h.coordinator.markRunning('t1'))).toBe('task_not_foreground');
  });

  it('重复登记同一任务 ⇒ duplicate_task', () => {
    const h = newCoordinator();
    h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '任务', expectedDurationMs: 5_000 });
    expect(
      errorCodeOf(() => h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '任务', expectedDurationMs: 5_000 })),
    ).toBe('duplicate_task');
  });

  it('标题命中明文密钥 ⇒ 拒登记，任务不入表（诊断/通知链路不成为泄漏点）', () => {
    const h = newCoordinator();
    const code = errorCodeOf(() =>
      h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: 'Bearer abcdefghijklmnopqrstuvwxyz0123', expectedDurationMs: 5_000 }),
    );
    expect(code).toBe('notification_secret_detected');
    expect(h.coordinator.get('t1')).toBeUndefined();
  });
});

describe('K10 ① 有界常驻：不承诺无限', () => {
  it('residencyModel 是机器可判定的 bounded', () => {
    const h = newCoordinator();
    expect(h.coordinator.residencyModel).toBe('bounded');
  });

  it('预算内继续；推过预算即降级：任务置 failed、通知被撤、如实报 resident_budget_exhausted', () => {
    const h = newCoordinator({ budgetMs: 30_000 });
    h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '任务', expectedDurationMs: 120_000 });
    h.coordinator.promote('t1');
    h.coordinator.markRunning('t1');

    h.clock.advance(29_999);
    const within = h.coordinator.checkResidency('t1');
    expect(within.withinBudget).toBe(true);
    expect(within.degraded).toBe(false);
    expect(h.coordinator.get('t1')?.state).toBe('running');

    h.clock.advance(1);
    const over = h.coordinator.checkResidency('t1');
    expect(over.withinBudget).toBe(false);
    expect(over.degraded).toBe(true);
    expect(over.elapsedMs).toBe(30_000);
    expect(h.coordinator.get('t1')?.state).toBe('failed');
    expect(h.coordinator.get('t1')?.failureReason).toBe('resident_budget_exhausted');
    expect(h.notifications.activeCount()).toBe(0);
  });

  it('从未提升的任务不因 checkResidency 被误降级', () => {
    const h = newCoordinator();
    h.coordinator.register({ taskId: 't1', visibility: 'background-deferred', title: '任务', expectedDurationMs: 1_000 });
    const check = h.coordinator.checkResidency('t1');
    expect(check.withinBudget).toBe(false);
    expect(check.degraded).toBe(false);
    expect(h.coordinator.get('t1')?.state).toBe('registered');
  });
});

describe('K10 ① 进度通知与诊断', () => {
  it('reportProgress 更新通知正文；生命周期事件落入脱敏诊断日志', () => {
    const h = newCoordinator();
    h.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '任务', expectedDurationMs: 5_000 });
    h.coordinator.promote('t1');
    h.coordinator.reportProgress('t1', '第 3 / 7 步');
    const last = h.notifications.history().at(-1);
    expect(last?.text).toBe('第 3 / 7 步');

    const codes = h.diagnostics.events().map((e) => e.code);
    expect(codes).toContain('task-registered');
    expect(codes).toContain('foreground-promoted');
    // 诊断事件只带白名单字段
    for (const event of h.diagnostics.events()) {
      expect(Object.keys(event).sort()).toEqual(['at', 'code', 'detail', 'kind', 'seq', 'severity', 'taskId']);
    }
  });
});
