/**
 * FA-VERIFY-WAVE-2 · 第二轮空断言 / 恒真闸门猎捕
 *
 * 本文件把"恒真"与"可达性"分开证明：
 * - **字面量类型当实测**：用类型级断言证明 `readonly x: false` / `: true` 是**类型不变式**，
 *   任何运行期 `=== false` / `.some(x => x)` 都不可能失败。
 * - **死闸门**：证明某检测器**存在**（用手工伪造的输入能让它变红）但在**真实构造路径上不可达**
 *   （真实构造器写不出触发它的值）。
 *
 * 纪律：只报告、不修；全部输入由验证方自造。
 */

import { describe, expect, it } from 'vitest';

import type { LogicalTime, TaskId } from '../../../src/protocol/index.js';
import { createSideEffect, type ActionSideEffect } from '../../../src/workledger/action-ledger.js';
import {
  summarizeLateResultGate,
  type LateResultGateSummary,
} from '../../../src/scheduler/late-result-gate.js';
import { summarizeTaskLifecycle, type LateResultRecord, type TaskLifecycleState } from '../../../src/scheduler/task-lifecycle.js';
import type { EditablePptxArtifact } from '../../../src/presentations/export-handoff.js';

const T = (value: number): LogicalTime => value as LogicalTime;

/** 类型级判等：`Exactly<V, T>` 为 `true` ⇔ 类型 `V` 恰为字面量类型 `T`。 */
type Exactly<V, T> = [T] extends [V] ? ([V] extends [T] ? true : false) : false;

// ---------------------------------------------------------------------------
// ① 字面量类型当实测（round-1 I-2 同族，第二波补证）
// ---------------------------------------------------------------------------

// 这些常量一旦编译通过，就**证明**对应字段是字面量类型（编译期事实）。
const revertedIsLiteralFalse: Exactly<ActionSideEffect['reverted'], false> = true;
const honoredIsLiteralFalse: Exactly<LateResultRecord['honored_as_success'], false> = true;
const editableIsLiteralTrue: Exactly<EditablePptxArtifact['editable'], true> = true;

describe('空断言猎捕 · 字面量字段是类型不变式，不是实测性质', () => {
  it('三个字段在类型层就是字面量 ⇒ 任何 ===false / .some(x) 断言恒真', () => {
    expect([revertedIsLiteralFalse, honoredIsLiteralFalse, editableIsLiteralTrue]).toEqual([true, true, true]);
  });

  it('最小复现：真实构造的副作用 reverted 恒为 false（读的是类型，不是行为）', () => {
    const effect = createSideEffect({ effect_id: 'e1', description: 'd', at: T(1) });
    // 真实构造器只有这一种可能：reverted === false
    expect(effect.reverted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② late-result-gate.ts 的"越过类型契约的撤销标记"检测器：存在但真实路径不可达
//    源码：late-result-gate.ts:113-116 anyFalselyReverted / :391-395 / :435-436
// ---------------------------------------------------------------------------

function lifecycleState(patch: Partial<TaskLifecycleState>): TaskLifecycleState {
  return {
    task_id: 't' as TaskId,
    status: 'running',
    late_results: [],
    side_effects: [],
    unknown_results: [],
    pause_count: 0,
    timeout_count: 0,
    recovery_count: 0,
    ...patch,
  } as unknown as TaskLifecycleState;
}

/** 手工伪造一条"越过类型契约的撤销标记"的副作用——**只有绕过类型系统才写得出**。 */
function forgedRevertedEffect(): ActionSideEffect {
  return {
    effect_id: 'forged',
    description: 'd',
    at: T(1),
    reverted: true,
    declared_reversible: true,
    reversal_attempt: 'undone',
  } as unknown as ActionSideEffect;
}

describe('空断言猎捕 · late-result-gate 死闸门', () => {
  it('正向：真实构造的副作用 ⇒ any_side_effect_reverted_outside_type_contract 恒 false、invariant_violations 恒空', () => {
    const summary: LateResultGateSummary = summarizeLateResultGate(
      lifecycleState({ side_effects: [createSideEffect({ effect_id: 'e1', description: 'd', at: T(1) })] }),
    );
    expect(summary.any_side_effect_reverted_outside_type_contract).toBe(false);
    expect(summary.invariant_violations).toEqual([]);
    expect(summary.side_effect_count).toBe(1); // 对照：确实有 1 条副作用在册
  });

  it('反向对照：检测器**存在**——只有手工伪造（绕过类型）才触发，真实构造器不可达', () => {
    const forged = summarizeLateResultGate(lifecycleState({ side_effects: [forgedRevertedEffect()] }));
    // 证明代码路径真实存在（不是被删了）
    expect(forged.any_side_effect_reverted_outside_type_contract).toBe(true);
    expect(forged.invariant_violations.some((message) => message.includes('被声称撤销'))).toBe(true);
    // 而生产路径里 createSideEffect 永远给 reverted:false ⇒ 上面的分支永远走不到
    const real = createSideEffect({ effect_id: 'e', description: 'd', at: T(1) });
    expect(real.reverted).toBe(false);
  });

  it('反向对照：honored_as_success 同理——真实迟到记录恒 false，检测分支需伪造才可达', () => {
    const realRecord: LateResultRecord = {
      run_id: 'r1',
      result_task_revision: 1,
      outcome: 'success',
      arrived_at: T(2),
      reason: 'late',
      honored_as_success: false,
      note: '',
    } as unknown as LateResultRecord;
    const real = summarizeLateResultGate(lifecycleState({ late_results: [realRecord] }));
    expect(real.any_late_honored).toBe(false);
    const forged = summarizeLateResultGate(
      lifecycleState({ late_results: [{ ...realRecord, honored_as_success: true } as unknown as LateResultRecord] }),
    );
    expect(forged.any_late_honored).toBe(true); // 检测器存在
  });

  it('task-lifecycle 的 summarize 同样：any_late_honored 是 .some(字面量 false) ⇒ 恒 false', () => {
    const summary = summarizeTaskLifecycle(lifecycleState({ status: 'cancelled' }));
    expect(summary.any_late_honored).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ③ export-handoff.ts 的 editable 自检：editable 是字面量 true ⇒ 分支死
//    源码：export-handoff.ts:227（editable: true）/ :546-548 / :993
// ---------------------------------------------------------------------------

describe('空断言猎捕 · export-handoff editable 自检', () => {
  it('类型层已锁定 editable 恒为 true ⇒ 运行期 `!== true` 检查永不触发', () => {
    // 编译期常量再次证明（与 ① 互证）
    expect(editableIsLiteralTrue).toBe(true);
    // 任何通过类型检查的 EditablePptxArtifact，其 editable 只可能是 true
    const sample: Pick<EditablePptxArtifact, 'editable'> = { editable: true };
    expect(sample.editable).toBe(true);
  });
});
