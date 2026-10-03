/**
 * K-I18 ③：把**真实 K10 打出的恢复计划 / 连通性变化 / 常驻预算结论**喂给 schema。
 *
 * 覆盖三套"死法/续跑"语义：
 * - reclaim：resume-from-cursor / query-external / finalize / start / none 全部出现；
 * - force-stop：未结清任务全部 blockedBySystem、action=none（不承诺自动复活）；
 * - 语义不变量：externalPending=true ⇒ query-external；终态 ⇒ none；mayRedoCompletedSteps 恒 false。
 *
 * 负例成对出现（正例必须空、负例必须非空），恒真 schema 无法通过。
 */

import { describe, expect, it } from 'vitest';

import { TaskLedger } from '../../../apps/mobile-kernel/lifecycle/ledger.js';
import { planRecovery } from '../../../apps/mobile-kernel/lifecycle/recovery.js';

import { validateFragment } from './validator.js';
import { loadLifecycleSchema, newLedger, newCoordinator, newNetwork, manualClock } from './harness.js';

const schema = loadLifecycleSchema();
const PLAN = '#/$defs/recoveryPlan';
const TASK_PLAN = '#/$defs/taskRecoveryPlan';
const CONNECTIVITY = '#/$defs/connectivityChange';
const RESIDENCY = '#/$defs/residencyCheck';

/** 造出五种恢复动作各自对应的真实任务。 */
function scenario(): ReturnType<typeof newLedger> {
  const h = newLedger();
  // t1：跑到第 2/3 步
  h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
  h.ledger.startRun('t1');
  h.ledger.completeStep('t1', 's1');
  h.ledger.completeStep('t1', 's2');
  // t2：已发起、未结清的外部副作用
  h.ledger.registerTask({ taskId: 't2', stepIds: ['a1', 'a2'] });
  h.ledger.startRun('t2');
  h.ledger.completeStep('t2', 'a1');
  h.ledger.beginExternalIntent('t2', 'sub:t2');
  // t3：全部步骤已完成但未标完成
  h.ledger.registerTask({ taskId: 't3', stepIds: ['x1'] });
  h.ledger.startRun('t3');
  h.ledger.completeStep('t3', 'x1');
  // t4：从未启动（在 reclaim 前保持 registered，才能得到 start 动作）
  h.ledger.registerTask({ taskId: 't4', stepIds: ['y1', 'y2'] });
  // t5：已结清
  h.ledger.registerTask({ taskId: 't5', stepIds: ['z1'] });
  h.ledger.startRun('t5');
  h.ledger.completeStep('t5', 'z1');
  h.ledger.setState('t5', 'completed', 'done');
  return h;
}

describe('K-I18 ③ 真实恢复计划（reclaim：冷启动重放 → planRecovery）', () => {
  it('计划与每个任务项都通过 schema；reclaim 前 start 动作真实出现', () => {
    const h = scenario();
    const cold = TaskLedger.replay(h.ledger.snapshot(), { clock: h.clock });
    const plan = planRecovery(cold, { killMode: 'reclaim' });

    expect(validateFragment(schema, PLAN, plan)).toEqual([]);
    expect(validateFragment(schema, '#', plan)).toEqual([]);
    for (const task of plan.tasks) {
      expect(validateFragment(schema, TASK_PLAN, task)).toEqual([]);
    }

    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('t1')).toMatchObject({ action: 'resume-from-cursor', resumeFromStep: 2 });
    expect(byId.get('t4')).toMatchObject({ action: 'start', resumeFromStep: 0 });
    expect(byId.get('t5')).toMatchObject({ action: 'none' });
    expect(plan.settled).toEqual(['t5']);
  });

  it('reclaim 后：unknown-external → query-external；全步完成 → finalize', () => {
    const h = scenario();
    h.ledger.observeReclaim('reclaim');
    const cold = TaskLedger.replay(h.ledger.snapshot(), { clock: h.clock });
    const plan = planRecovery(cold, { killMode: 'reclaim' });

    expect(validateFragment(schema, PLAN, plan)).toEqual([]);
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('t2')).toMatchObject({ action: 'query-external', externalPending: true, resumeFromStep: null });
    expect(byId.get('t3')).toMatchObject({ action: 'finalize', resumeFromStep: 1 });
    expect(byId.get('t1')).toMatchObject({ action: 'resume-from-cursor' });
    // 结果未知的任务绝不出现在可续跑集合里。
    expect(plan.resume).not.toContain('t2');
    expect(plan.queryExternal).toEqual(['t2']);
  });
});

describe('K-I18 ③ 真实恢复计划（force-stop：不承诺自动复活）', () => {
  it('未结清任务一律 action=none 且进 blockedBySystem，且计划通过 schema', () => {
    const h = scenario();
    const plan = planRecovery(h.ledger, { killMode: 'force-stop' });

    expect(validateFragment(schema, PLAN, plan)).toEqual([]);
    for (const task of plan.tasks) {
      expect(validateFragment(schema, TASK_PLAN, task)).toEqual([]);
      expect(task.mayRedoCompletedSteps).toBe(false);
    }
    expect(plan.resume).toEqual([]);
    expect(plan.queryExternal).toEqual([]);
    expect(plan.blockedBySystem).toEqual(['t1', 't2', 't3', 't4']);
    expect(plan.settled).toEqual(['t5']);
    expect(plan.tasks.every((t) => t.action === 'none')).toBe(true);
  });
});

describe('K-I18 ③ 计划项语义不变量（由 schema 的 const/not 强制）', () => {
  it('正例：force-stop 下非终态 + action=none 合法；外部未结清 + action=none（连查询都不允许）也合法', () => {
    const blocked = {
      taskId: 't1',
      state: 'reclaimed',
      action: 'none',
      resumeFromStep: null,
      totalSteps: 3,
      externalPending: false,
      mayRedoCompletedSteps: false,
      detail: 'force-stop 后系统不允许自动复活',
    };
    expect(validateFragment(schema, TASK_PLAN, blocked)).toEqual([]);

    const blockedPending = {
      taskId: 't2',
      state: 'unknown-external',
      action: 'none',
      resumeFromStep: null,
      totalSteps: 2,
      externalPending: true,
      mayRedoCompletedSteps: false,
      detail: 'force-stop：系统连查询都不允许，只标记 blocked',
    };
    expect(validateFragment(schema, TASK_PLAN, blockedPending)).toEqual([]);
  });

  it('负例：mayRedoCompletedSteps=true / 终态非 none / 外部未结清却续跑/start/finalize / 未知 killMode / 多余字段 全部被拒', () => {
    const h = scenario();
    const plan = planRecovery(h.ledger, { killMode: 'reclaim' });
    const taskPlan = plan.tasks.find((t) => t.taskId === 't1');
    expect(taskPlan).toBeDefined();

    const redo: Record<string, unknown> = { ...taskPlan, mayRedoCompletedSteps: true };
    const redoErrors = validateFragment(schema, TASK_PLAN, redo);
    expect(redoErrors.some((e) => e.message.includes('const'))).toBe(true);

    const terminalResume: Record<string, unknown> = {
      taskId: 't9',
      state: 'completed',
      action: 'resume-from-cursor',
      resumeFromStep: 0,
      totalSteps: 1,
      externalPending: false,
      mayRedoCompletedSteps: false,
      detail: '终态不该续跑',
    };
    expect(validateFragment(schema, TASK_PLAN, terminalResume).some((e) => e.message.includes('not'))).toBe(true);

    const pendingResume: Record<string, unknown> = {
      taskId: 't9',
      state: 'unknown-external',
      action: 'resume-from-cursor',
      resumeFromStep: 0,
      totalSteps: 2,
      externalPending: true,
      mayRedoCompletedSteps: false,
      detail: '结果未知却想重做',
    };
    expect(validateFragment(schema, TASK_PLAN, pendingResume).some((e) => e.message.includes('not'))).toBe(true);

    // 外部未结清时，重做族动作（start / finalize）同样被拒——只有 query-external 或 none 允许。
    for (const action of ['start', 'finalize']) {
      const redoPending: Record<string, unknown> = { ...pendingResume, action };
      expect(validateFragment(schema, TASK_PLAN, redoPending).some((e) => e.message.includes('not'))).toBe(true);
    }

    const badKill: Record<string, unknown> = { ...plan, killMode: 'reboot' };
    expect(validateFragment(schema, PLAN, badKill).some((e) => e.message.includes('enum'))).toBe(true);

    const extra: Record<string, unknown> = { ...plan, note: 'x' };
    expect(validateFragment(schema, PLAN, extra).some((e) => e.message.includes('additionalProperties'))).toBe(true);
  });
});

describe('K-I18 ③ 真实连通性变化与常驻预算结论', () => {
  it('NetworkResumeController.setConnectivity 的真实返回通过 connectivityChange schema', () => {
    const { network } = newNetwork();
    const offline = network.setConnectivity('offline');
    const online = network.setConnectivity('online');
    for (const change of [offline, online]) {
      expect(validateFragment(schema, CONNECTIVITY, change)).toEqual([]);
    }
    const bad: Record<string, unknown> = { ...offline, state: 'flaky' };
    expect(validateFragment(schema, CONNECTIVITY, bad).length).toBeGreaterThan(0);
  });

  it('ForegroundTaskCoordinator.checkResidency 的真实返回（预算内 / 超预算降级）通过 residencyCheck schema', () => {
    const clock = manualClock();
    const c = newCoordinator({ budgetMs: 30_000, clock });
    c.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '长任务', expectedDurationMs: 120_000 });
    c.coordinator.promote('t1');
    c.coordinator.markRunning('t1');

    clock.advance(29_999);
    const within = c.coordinator.checkResidency('t1');
    expect(within).toMatchObject({ withinBudget: true, degraded: false });

    clock.advance(1);
    const over = c.coordinator.checkResidency('t1');
    expect(over).toMatchObject({ withinBudget: false, degraded: true });

    for (const check of [within, over]) {
      expect(validateFragment(schema, RESIDENCY, check)).toEqual([]);
    }
    const bad: Record<string, unknown> = { ...over, budgetMs: 0 };
    expect(validateFragment(schema, RESIDENCY, bad).length).toBeGreaterThan(0);
  });
});
