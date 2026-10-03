/**
 * K10 独立验证 ③：进程回收后的**游标/账本恢复**，以及"不承诺无限常驻"的两种死法。
 *
 * 冷启动用"快照 → 重放"模拟（真机上就是新进程读持久账本）。三条硬判据：
 * 1. 恢复从游标继续，**不重跑**已完成步骤；
 * 2. 已发起、未结清的外部副作用**只能查原单**，绝不重做；
 * 3. `force-stop` 后系统不允许自动复活 —— 计划如实标 `blockedBySystem`，不假装能恢复。
 */

import { describe, expect, it } from 'vitest';

import { planRecovery } from '../../../apps/mobile-kernel/lifecycle/recovery.js';
import { newLedger, replayLedger, errorCodeOf } from './fixtures.js';

describe('K10 ③ 快照重放 = 冷启动', () => {
  it('重放后的任务视图、游标、日志长度与原地一致', () => {
    const h = newLedger();
    h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
    h.ledger.startRun('t1');
    h.ledger.completeStep('t1', 's1');
    h.ledger.completeStep('t1', 's2');

    const snapshot = h.ledger.snapshot();
    const replayed = replayLedger(snapshot, h.clock);

    expect(replayed.getTask('t1')).toEqual(h.ledger.getTask('t1'));
    expect(replayed.cursor('t1')).toBe(2);
    expect(replayed.journal()).toHaveLength(h.ledger.journal().length);
  });

  it('读失败不当空库：空串 / 非 JSON / 版本不符 / 序号乱序一律抛 invalid_snapshot', () => {
    expect(errorCodeOf(() => replayLedger(''))).toBe('invalid_snapshot');
    expect(errorCodeOf(() => replayLedger('{not json'))).toBe('invalid_snapshot');
    expect(errorCodeOf(() => replayLedger(JSON.stringify({ version: 99, entries: [] })))).toBe('invalid_snapshot');
    expect(
      errorCodeOf(() =>
        replayLedger(
          JSON.stringify({ version: 1, entries: [{ seq: 5, at: 1, kind: 'task-registered', taskId: 'x', detail: '', data: { stepIds: ['a'] } }] }),
        ),
      ),
    ).toBe('invalid_snapshot');
    // 读到坏快照**必须报错**，不得静默返回"没有任务"——那会丢掉未结清的外部副作用。
  });
});

describe('K10 ③ 恢复计划：从游标继续 / 查原单 / 补完成 / 定时启动', () => {
  it('普通回收后按状态给出各自动作，且恒不重跑已完成步骤', () => {
    const h = newLedger();
    // t1：跑到第 2/3 步
    h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
    h.ledger.startRun('t1');
    h.ledger.completeStep('t1', 's1');
    h.ledger.completeStep('t1', 's2');
    // t4：从未启动
    h.ledger.registerTask({ taskId: 't4', stepIds: ['y1', 'y2'] });
    // t5：已结清
    h.ledger.registerTask({ taskId: 't5', stepIds: ['z1'] });
    h.ledger.startRun('t5');
    h.ledger.completeStep('t5', 'z1');
    h.ledger.setState('t5', 'completed', 'done');

    const snapshot = h.ledger.snapshot();
    const cold = replayLedger(snapshot, h.clock);
    const plan = planRecovery(cold, { killMode: 'reclaim' });

    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('t1')).toMatchObject({ action: 'resume-from-cursor', resumeFromStep: 2, state: 'running' });
    expect(byId.get('t4')).toMatchObject({ action: 'start', resumeFromStep: 0, state: 'registered' });
    expect(byId.get('t5')).toMatchObject({ action: 'none', state: 'completed' });
    expect(plan.resume).toEqual(['t1', 't4']);
    expect(plan.settled).toEqual(['t5']);
    for (const task of plan.tasks) {
      expect(task.mayRedoCompletedSteps).toBe(false);
    }
    // 已完成的步骤依然被账本挡下（恢复不得重跑）。
    expect(errorCodeOf(() => cold.completeStep('t1', 's1'))).toBe('duplicate_step');
  });

  it('观测到回收后：未结清外部副作用 → unknown-external → 只能查原单；全步完成未标完成 → finalize', () => {
    const h = newLedger();
    h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
    h.ledger.startRun('t1');
    h.ledger.completeStep('t1', 's1');
    h.ledger.completeStep('t1', 's2');
    h.ledger.registerTask({ taskId: 't2', stepIds: ['a1', 'a2'] });
    h.ledger.startRun('t2');
    h.ledger.completeStep('t2', 'a1');
    h.ledger.beginExternalIntent('t2', 'sub:t2'); // 已发起外部副作用，未结清
    h.ledger.registerTask({ taskId: 't3', stepIds: ['x1'] });
    h.ledger.startRun('t3');
    h.ledger.completeStep('t3', 'x1'); // 全步完成，未标完成

    h.ledger.observeReclaim('reclaim');
    expect(h.ledger.getTask('t1')?.state).toBe('reclaimed');
    expect(h.ledger.getTask('t2')?.state).toBe('unknown-external');
    expect(h.ledger.getTask('t3')?.state).toBe('reclaimed');

    const cold = replayLedger(h.ledger.snapshot(), h.clock);
    expect(cold.lastKillMode()).toBe('reclaim');
    const plan = planRecovery(cold, { killMode: 'reclaim' });
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));

    expect(byId.get('t1')).toMatchObject({ action: 'resume-from-cursor', resumeFromStep: 2, externalPending: false });
    expect(byId.get('t2')).toMatchObject({ action: 'query-external', externalPending: true, resumeFromStep: null });
    expect(byId.get('t3')).toMatchObject({ action: 'finalize', resumeFromStep: 1 });
    expect(plan.resume).toEqual(['t1', 't3']);
    expect(plan.queryExternal).toEqual(['t2']);
    // t2 不得出现在"可续跑"里 —— 结果未知不能重做。
    expect(plan.resume).not.toContain('t2');
  });

  it('force-stop：系统不允许自动复活，未结清任务一律 blockedBySystem、不承诺恢复', () => {
    const h = newLedger();
    h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2'] });
    h.ledger.startRun('t1');
    h.ledger.completeStep('t1', 's1');
    h.ledger.registerTask({ taskId: 't2', stepIds: ['a'] });
    h.ledger.startRun('t2');
    h.ledger.beginExternalIntent('t2', 'sub:t2');
    h.ledger.observeReclaim('force-stop');

    const cold = replayLedger(h.ledger.snapshot(), h.clock);
    expect(cold.lastKillMode()).toBe('force-stop');
    const plan = planRecovery(cold, { killMode: 'force-stop' });

    expect(plan.resume).toEqual([]);
    expect(plan.queryExternal).toEqual([]);
    expect(plan.blockedBySystem).toEqual(['t1', 't2']);
    expect(plan.tasks.every((t) => t.action === 'none')).toBe(true);
  });

  it('非法 killMode 被拒', () => {
    const h = newLedger();
    expect(errorCodeOf(() => planRecovery(h.ledger, { killMode: 'reboot' as unknown as 'reclaim' }))).toBe('invalid_snapshot');
  });
});
