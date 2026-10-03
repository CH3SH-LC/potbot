/**
 * K-I18 ②：把**真实 K10 emit 的事件**喂给 schema。
 *
 * "真实"指：对象由 apps/mobile-kernel/lifecycle 与 observability 的生产代码在真实驱动下
 * 产生（registerTask / startRun / completeStep / beginExternalIntent / settleExternal /
 * setState / observeReclaim / register+promote+markRunning+finish+cancel），不是手写的样例。
 *
 * 每条正例断言"校验结果为空数组"；每条负例断言"非空"——因此若 schema 被换成恒真（`true`），
 * 负例集体变红，本文件即失败。
 */

import { describe, expect, it } from 'vitest';

import { JOURNAL_KINDS } from '../../../apps/mobile-kernel/lifecycle/types.js';

import { validateFragment } from './validator.js';
import { loadLifecycleSchema, newLedger, newCoordinator } from './harness.js';

const schema = loadLifecycleSchema();
const JOURNAL = '#/$defs/journalEntry';
const DIAGNOSTIC = '#/$defs/diagnosticEvent';
const RECORD = '#/$defs/taskRecord';
const FGS_VIEW = '#/$defs/fgsTaskView';

/** 驱动真实账本，使七种日志条目全部出现。 */
function emitLedger() {
  const h = newLedger();
  h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2', 's3'] });
  h.ledger.startRun('t1');
  h.ledger.completeStep('t1', 's1');
  h.ledger.beginExternalIntent('t1', 'sub:t1');
  h.ledger.settleExternal('t1', 'confirmed');
  h.ledger.registerTask({ taskId: 't2', stepIds: ['a1'] });
  h.ledger.setState('t2', 'completed', 'done');
  h.ledger.observeReclaim('reclaim');
  return h;
}

describe('K-I18 ② 真实日志事件（TaskLedger.journal()）', () => {
  it('七种 kind 全部出现，且每条都通过 journalEntry schema', () => {
    const h = emitLedger();
    const entries = h.ledger.journal();
    expect(entries.length).toBeGreaterThanOrEqual(8);

    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(JOURNAL_KINDS));
    for (const entry of entries) {
      expect(validateFragment(schema, JOURNAL, entry)).toEqual([]);
    }
  });

  it('每条日志事件同时通过 schema 根（oneOf 事件/计划），证明根不是摆设', () => {
    const h = emitLedger();
    for (const entry of h.ledger.journal()) {
      expect(validateFragment(schema, '#', entry)).toEqual([]);
    }
  });

  it('日志条目按 kind 定形：task-registered 缺 stepIds / 未知 kind / 多余字段 / 空对象 一律被拒', () => {
    const h = emitLedger();
    const registered = h.ledger.journal().find((e) => e.kind === 'task-registered');
    expect(registered).toBeDefined();

    const missingSteps: Record<string, unknown> = { ...registered, data: { totalSteps: 3 } };
    expect(validateFragment(schema, JOURNAL, missingSteps).length).toBeGreaterThan(0);

    const badKind: Record<string, unknown> = { ...registered, kind: 'bogus' };
    const badKindErrors = validateFragment(schema, JOURNAL, badKind);
    expect(badKindErrors.length).toBeGreaterThan(0);
    expect(badKindErrors.some((e) => e.message.includes('enum'))).toBe(true);

    const extraField: Record<string, unknown> = { ...registered, injected: 'x' };
    const extraErrors = validateFragment(schema, JOURNAL, extraField);
    expect(extraErrors.some((e) => e.message.includes('additionalProperties'))).toBe(true);

    expect(validateFragment(schema, JOURNAL, {}).length).toBeGreaterThan(0);
    expect(validateFragment(schema, JOURNAL, null).length).toBeGreaterThan(0);
  });
});

describe('K-I18 ② 真实脱敏诊断事件（observability DiagnosticsLog）', () => {
  it('账本与协调器 emit 的诊断事件都通过 diagnosticEvent schema', () => {
    const ledgerHarness = emitLedger();
    const events = ledgerHarness.diagnostics.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.code)).toContain('reclaim-observed');
    for (const event of events) {
      expect(validateFragment(schema, DIAGNOSTIC, event)).toEqual([]);
    }

    const c = newCoordinator();
    c.coordinator.register({ taskId: 't1', visibility: 'foreground-visible', title: '生成季度报表', expectedDurationMs: 120_000 });
    c.coordinator.promote('t1');
    c.coordinator.markRunning('t1');
    c.coordinator.reportProgress('t1', '第 1 / 3 步');
    c.coordinator.finish('t1');
    c.coordinator.register({ taskId: 't2', visibility: 'foreground-visible', title: '取消示例', expectedDurationMs: 5_000 });
    c.coordinator.cancel('t2', '用户取消');

    const coordEvents = c.diagnostics.events();
    expect(coordEvents.map((e) => e.code)).toContain('foreground-promoted');
    expect(coordEvents.map((e) => e.code)).toContain('task-cancelled');
    for (const event of coordEvents) {
      expect(validateFragment(schema, DIAGNOSTIC, event)).toEqual([]);
    }
  });

  it('未知严重级 / 未知事件种类 / 多余字段被拒', () => {
    const h = emitLedger();
    const event = h.diagnostics.events()[0];
    expect(event).toBeDefined();

    const badSeverity: Record<string, unknown> = { ...event, severity: 'trace' };
    expect(validateFragment(schema, DIAGNOSTIC, badSeverity).length).toBeGreaterThan(0);

    const badKind: Record<string, unknown> = { ...event, kind: 'audit' };
    expect(validateFragment(schema, DIAGNOSTIC, badKind).length).toBeGreaterThan(0);

    const extra: Record<string, unknown> = { ...event, payload: {} };
    expect(validateFragment(schema, DIAGNOSTIC, extra).length).toBeGreaterThan(0);
  });
});

describe('K-I18 ② 真实任务视图：账本 TaskRecord + 前台服务 TaskView', () => {
  it('TaskRecord 通过 taskRecord schema；改坏 state / cursor / 漏字段被拒', () => {
    const h = emitLedger();
    const records = h.ledger.tasks();
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const record of records) {
      expect(validateFragment(schema, RECORD, record)).toEqual([]);
    }

    const record = records[0];
    expect(record).toBeDefined();

    const badState: Record<string, unknown> = { ...record, state: 'zombie' };
    expect(validateFragment(schema, RECORD, badState).some((e) => e.message.includes('enum'))).toBe(true);

    const badCursor: Record<string, unknown> = { ...record, cursor: '2' };
    expect(validateFragment(schema, RECORD, badCursor).some((e) => e.message.includes('type'))).toBe(true);

    const missingField: Record<string, unknown> = { ...record };
    delete missingField['completedSteps'];
    expect(validateFragment(schema, RECORD, missingField).some((e) => e.message.includes('required'))).toBe(true);
  });

  it('FGS TaskView（registered/foreground/running/finished/cancelled）通过 fgsTaskView schema', () => {
    const c = newCoordinator();
    c.coordinator.register({ taskId: 'run', visibility: 'foreground-visible', title: '长任务', expectedDurationMs: 60_000 });
    const registered = c.coordinator.get('run');
    expect(registered?.state).toBe('registered');

    c.coordinator.promote('run');
    const foreground = c.coordinator.get('run');
    expect(foreground?.state).toBe('foreground');

    c.coordinator.markRunning('run');
    expect(c.coordinator.get('run')?.state).toBe('running');
    c.coordinator.finish('run');
    const finished = c.coordinator.get('run');

    c.coordinator.register({ taskId: 'cancel', visibility: 'foreground-visible', title: '取消任务', expectedDurationMs: 60_000 });
    c.coordinator.cancel('cancel', '用户取消');
    const cancelled = c.coordinator.get('cancel');

    for (const view of [registered, foreground, finished, cancelled]) {
      expect(view).toBeDefined();
      expect(validateFragment(schema, FGS_VIEW, view)).toEqual([]);
    }

    const badState: Record<string, unknown> = { ...finished, state: 'zombie' };
    expect(validateFragment(schema, FGS_VIEW, badState).length).toBeGreaterThan(0);
    const badVisibility: Record<string, unknown> = { ...finished, visibility: 'guaranteed-always-on' };
    expect(validateFragment(schema, FGS_VIEW, badVisibility).length).toBeGreaterThan(0);
  });
});
