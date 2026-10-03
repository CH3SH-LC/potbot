/**
 * K-I18 ④：**校验器与 schema 的"反永远通过"纪律**，以及与已注册 wire 契约的投影交叉。
 *
 * 三件事：
 * 1. 校验器 fail-closed：未知（或拼错）关键字 / 跨文档 $ref / 无法解析的指针一律抛错，
 *    绝不静默忽略——否则 schema 写歪会"假装通过"。
 * 2. 恒真对照：同一负例在 schema=`true` 时"通过"，在本单元 schema 下被拒——证明负例断言
 *    真的在起作用，而不是摆设。
 * 3. 与 contracts/mobile-v1/schemas/lifecycle-plan.schema.json 的交叉：wire 计划分支接受
 *    真实运行期 RecoveryPlan（形状对齐）；wire 事件分支**不接受**运行期 journal 条目
 *    （那是 wire 投影差距，属协调者登记范围，本单元只做证据）。
 */

import { describe, expect, it } from 'vitest';

import { planRecovery } from '../../../apps/mobile-kernel/lifecycle/recovery.js';

import { UnsupportedSchemaError, validateFragment, validateInstance, type JsonSchema, type JsonSchemaObject } from './validator.js';
import { loadLifecycleSchema, loadContractSchema, newLedger } from './harness.js';

const schema = loadLifecycleSchema();
const contract = loadContractSchema();
const JOURNAL = '#/$defs/journalEntry';

/** 造一条真实 journal 条目（task-registered），并返回同一账本供负例复用。 */
function realRegisteredEntry() {
  const h = newLedger();
  h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2'] });
  const entry = h.ledger.journal()[0];
  if (entry === undefined) throw new Error('账本没有日志条目');
  return { h, entry };
}

describe('K-I18 ④ 校验器 fail-closed', () => {
  it('未知关键字（含拼错的 enm）直接抛，不静默忽略', () => {
    const typo = { $schema: 'https://json-schema.org/draft/2020-12/schema', enm: ['a', 'b'] };
    expect(() => validateInstance('a', typo as JsonSchema, typo as JsonSchema)).toThrow(UnsupportedSchemaError);
  });

  it('跨文档 $ref 抛错（只允许同文档 #/... 指针）', () => {
    const crossDoc = { $ref: 'other.schema.json#/$defs/x' };
    expect(() => validateInstance({}, crossDoc as JsonSchema, crossDoc as JsonSchema)).toThrow(UnsupportedSchemaError);
  });

  it('无法解析的同文档指针抛错，而不是当作"无约束"放行', () => {
    expect(() => validateFragment(schema, '#/$defs/doesNotExist', {})).toThrow(UnsupportedSchemaError);
  });

  it('schema 根与所校验的 $defs 都是非平凡对象（不是恒真 true）', () => {
    expect(typeof schema).toBe('object');
    const defs = (schema as JsonSchemaObject)['$defs'];
    expect(defs !== null && typeof defs === 'object').toBe(true);
    const keys = Object.keys(defs as JsonSchemaObject);
    for (const name of [
      'fgsState',
      'taskState',
      'recoveryAction',
      'killMode',
      'journalEntry',
      'diagnosticEvent',
      'taskRecord',
      'fgsTaskView',
      'taskRecoveryPlan',
      'recoveryPlan',
    ]) {
      expect(keys).toContain(name);
      // 可解析：指向不存在/非 schema 节点会抛 UnsupportedSchemaError。
      expect(Array.isArray(validateFragment(schema, `#/$defs/${name}`, null))).toBe(true);
    }
  });
});

describe('K-I18 ④ 恒真对照：负例断言确有效力', () => {
  it('同一负例：schema=true 时"通过"，本单元 schema 下被拒', () => {
    const { entry } = realRegisteredEntry();
    const mutated: Record<string, unknown> = { ...entry, kind: 'bogus' };

    // 恒真 schema 会放行——证明"通过"是 schema 松，不是例子对。
    expect(validateInstance(mutated, true, schema)).toEqual([]);
    // 本单元 schema 不放行。
    expect(validateFragment(schema, JOURNAL, mutated).length).toBeGreaterThan(0);
  });

  it('每条 const/enum/required/additionalProperties/not 负例都失败（不是被判为空就放过）', () => {
    const { entry } = realRegisteredEntry();
    const cases: ReadonlyArray<unknown> = [
      { ...entry, kind: 'bogus' },
      { ...entry, data: { totalSteps: 2 } },
      { ...entry, extra: 1 },
      {},
    ];
    for (const instance of cases) {
      expect(validateFragment(schema, JOURNAL, instance).length).toBeGreaterThan(0);
    }
  });
});

describe('K-I18 ④ 与已注册 wire 契约的交叉（contracts/mobile-v1/schemas/lifecycle-plan.schema.json）', () => {
  it('真实运行期 RecoveryPlan 通过 wire 契约的 recoveryPlan 分支（计划形状对齐）', () => {
    const h = newLedger();
    h.ledger.registerTask({ taskId: 't1', stepIds: ['s1', 's2'] });
    h.ledger.startRun('t1');
    h.ledger.completeStep('t1', 's1');
    const plan = planRecovery(h.ledger, { killMode: 'reclaim' });

    expect(validateFragment(contract, '#', plan)).toEqual([]);
  });

  it('wire 形状的 lifecycleEvent（eventId + ISO-8601 at + taskState）通过契约事件分支', () => {
    const wireEvent = { eventId: 'evt-1', taskId: 't1', at: '2026-10-03T00:00:00Z', taskState: 'reclaimed' };
    expect(validateFragment(contract, '#/$defs/lifecycleEvent', wireEvent)).toEqual([]);
  });

  it('已知投影差距：运行期 journal 条目（seq/kind/data + 整数 at）不被 wire 事件分支接受', () => {
    const { entry } = realRegisteredEntry();
    const errors = validateFragment(contract, '#/$defs/lifecycleEvent', entry);
    expect(errors.length).toBeGreaterThan(0);
    // 差距来自 wire 事件需要 eventId 且 at 是 ISO 字符串；运行期条目是 seq/kind/data + 整数 at。
    expect(errors.some((e) => e.message.includes('required') || e.message.includes('additionalProperties'))).toBe(true);
  });

  it('已知语义差距（给协调者的证据）：真实 force-stop 计划不被 wire 契约的恢复计划分支接受', () => {
    const h = newLedger();
    h.ledger.registerTask({ taskId: 't2', stepIds: ['a1', 'a2'] });
    h.ledger.startRun('t2');
    h.ledger.completeStep('t2', 'a1');
    h.ledger.beginExternalIntent('t2', 'sub:t2');
    const plan = planRecovery(h.ledger, { killMode: 'force-stop' });

    // 运行期真实产物：t2 externalPending=true、action=none（系统连查询都不允许）；本单元 schema 接受。
    expect(validateFragment(schema, '#/$defs/recoveryPlan', plan)).toEqual([]);
    // 但已注册 wire 契约的不变量 (a) 更严（externalPending ⇒ action 必须 query-external），拒绝该真实计划。
    // 二者需要协调者裁决：force-stop 下 externalPending 项的 action 究竟允许哪些。
    const contractErrors = validateFragment(contract, '#', plan);
    expect(contractErrors.length).toBeGreaterThan(0);
  });
});
