/**
 * KRN-09 补充（迟到结果闸门）的正反例测试。
 *
 * 每条判据配反向对照：
 * ① 取消后迟到结果不得成为当前成功；且**取消前**到达的结果照常发布（闸门不是"永远拦"）；
 * ② 已发生副作用如实保留（reverted 恒 false），迟到也不丢；
 * ③ 判定**不另造一套**：与 `classifyResultArrival()` 的迟到结论逐例一致；
 * ④ 取消与结果**真实并发交错**（Promise）时不变量恒成立。
 */

import { describe, expect, it } from 'vitest';
import {
  asLogicalTime,
  asMessageId,
  asRevision,
  asRunId,
  asTaskId,
  type LogicalTime,
  type Revision,
} from '../protocol/index.js';
import { createSideEffect, type ActionSideEffect } from '../workledger/index.js';
import {
  applyTaskLifecycleTransition,
  cancelTask,
  classifyResultArrival,
  createTaskLifecycle,
  type LateResultRecord,
  type TaskLifecycleState,
} from './task-lifecycle.js';
import {
  ConcurrentResultGate,
  applyOrderedLifecycleEvents,
  gateRunResult,
  isResultHonorable,
  summarizeLateResultGate,
  type RunResultEnvelope,
} from './late-result-gate.js';

const L = (n: number): LogicalTime => asLogicalTime(n);
const TASK = asTaskId('task-1');
const R1 = asRevision(1);
const R2 = asRevision(2);

function running(revision: Revision = R1): TaskLifecycleState {
  return createTaskLifecycle({ task_id: TASK, revision, at: L(0) });
}

function envelope(overrides: Partial<RunResultEnvelope> = {}): RunResultEnvelope {
  return Object.freeze({
    run_id: overrides.run_id ?? asRunId('run-1'),
    result_task_revision: overrides.result_task_revision ?? R1,
    outcome: overrides.outcome ?? 'completed',
    at: overrides.at ?? L(10),
    ...(overrides.side_effects === undefined ? {} : { side_effects: overrides.side_effects }),
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  });
}

describe('KRN-09+ 判据①：迟到结果不得成为当前成功（取消路径）', () => {
  it('取消后到达的「完成」结果：publish=false、任务仍是 cancelled', () => {
    const cancelled = cancelTask(running(), L(10), '用户取消', { cancelled_by_message_id: asMessageId('m-cancel') });
    const verdict = gateRunResult(cancelled, envelope({ at: L(11), outcome: 'completed' }));

    expect(verdict.decision).toBe('late');
    expect(verdict.late).toBe(true);
    expect(verdict.late_reason).toBe('task_cancelled');
    expect(verdict.publish).toBe(false);
    expect(verdict.state.status).toBe('cancelled');
    expect(verdict.state.completed_at).toBeNull();
    expect(verdict.state.late_results).toHaveLength(1);
    // 记录层：迟到结果的 honored_as_success 是字面量 false（design 钉死，非同名布尔字段）
    expect(verdict.state.late_results[0]?.honored_as_success).toBe(false);
    expect(isResultHonorable(cancelled, envelope({ at: L(11) }))).toBe(false);
  });

  it('反向对照：取消**之前**到达的完成结果照常发布（闸门不是"永远拦"）', () => {
    const verdict = gateRunResult(running(), envelope({ at: L(10) }));
    expect(verdict.decision).toBe('publish');
    expect(verdict.publish).toBe(true);
    expect(isResultHonorable(running(), envelope({ at: L(10) }))).toBe(true);
    expect(verdict.late).toBe(false);
    expect(verdict.state.status).toBe('running'); // 单轮发布 ≠ 任务完成（R213）
    expect(verdict.state.late_results).toHaveLength(0);
  });

  it('反向对照：同刻的完成结果必须判迟到（同刻从严，先取消后结果）', () => {
    const outcome = applyOrderedLifecycleEvents(running(), [
      { kind: 'result', envelope: envelope({ at: L(10) }) },
      { kind: 'cancel', cancel: { at: L(10), reason: '同时到达的取消' } },
    ]);
    expect(outcome.cancel_applied).toBe(true);
    expect(outcome.published_run_ids).toEqual([]);
    expect(outcome.state.status).toBe('cancelled');
    expect(outcome.result_verdicts[0]?.late_reason).toBe('task_cancelled');
  });

  it('超时 / 失败 / 暂停 之后到达的成功结果同样不可发布', () => {
    const states: readonly [TaskLifecycleState, string][] = [
      [applyTaskLifecycleTransition({ state: running(), to: 'timed_out', at: L(5), reason: '超时' }), 'task_timed_out'],
      [applyTaskLifecycleTransition({ state: running(), to: 'failed', at: L(5), reason: '失败' }), 'task_failed'],
      [applyTaskLifecycleTransition({ state: running(), to: 'paused', at: L(5), reason: '暂停' }), 'task_paused'],
    ];
    for (const [state, reason] of states) {
      const verdict = gateRunResult(state, envelope({ at: L(6) }));
      expect(verdict.publish).toBe(false);
      expect(verdict.late_reason).toBe(reason);
      expect(verdict.state.status).toBe(state.status); // 状态不变
    }
  });

  it('结果版本落后当前版本 ⇒ 迟到、不可发布（R213）', () => {
    const verdict = gateRunResult(running(R2), envelope({ result_task_revision: R1, at: L(3) }));
    expect(verdict.late).toBe(true);
    expect(verdict.late_reason).toBe('stale_task_revision');
    expect(verdict.publish).toBe(false);
    expect(verdict.state.status).toBe('running');
  });

  it('结果未知 ⇒ 不发布、只留痕（R246）', () => {
    const verdict = gateRunResult(running(), envelope({ outcome: 'unknown', at: L(3) }));
    expect(verdict.decision).toBe('unknown');
    expect(verdict.publish).toBe(false);
    expect(verdict.state.unknown_results).toHaveLength(1);
    expect(verdict.state.late_results).toHaveLength(0);
  });

  it('反向对照：任务已是终态后再次取消不改写历史（取消不可复活，也不可被二次覆盖）', () => {
    const outcome = applyOrderedLifecycleEvents(running(), [
      { kind: 'cancel', cancel: { at: L(1), reason: '第一次取消' } },
      { kind: 'cancel', cancel: { at: L(2), reason: '第二次取消' } },
    ]);
    expect(outcome.cancel_applied).toBe(true);
    expect(outcome.state.status).toBe('cancelled');
    expect(outcome.state.reason).toBe('第一次取消');
    expect(outcome.state.cancelled_at).toBe(L(1));
  });
});

describe('KRN-09+ 判据②：已发生副作用如实保留（不假称撤销）', () => {
  it('迟到结果自带的副作用照实入账，reverted 恒 false', () => {
    const cancelled = cancelTask(running(), L(10), '取消', {
      side_effects: [createSideEffect({ effect_id: 'e-cancel', description: '取消时已在途', at: L(9) })],
    });
    const verdict = gateRunResult(
      cancelled,
      envelope({
        at: L(11),
        side_effects: [
          createSideEffect({ effect_id: 'e-late', description: '取消后才落地的外部写入', at: L(11) }),
        ],
      }),
    );

    expect(verdict.publish).toBe(false);
    expect(verdict.side_effects_retained).toBe(2);
    expect(verdict.state.side_effects.map((effect) => effect.effect_id)).toEqual(['e-cancel', 'e-late']);
    expect(verdict.state.side_effects.every((effect) => effect.reverted === false)).toBe(true);
    expect(verdict.any_side_effect_reverted_outside_type_contract).toBe(false);
  });

  it('正常到达的副作用同样入账（不是只在迟到路径记账）', () => {
    const verdict = gateRunResult(
      running(),
      envelope({ at: L(4), side_effects: [createSideEffect({ effect_id: 'e-ok', description: '正常副作用', at: L(4) })] }),
    );
    expect(verdict.publish).toBe(true);
    expect(verdict.side_effects_retained).toBe(1);
    expect(verdict.state.side_effects[0]?.reverted).toBe(false);
  });

  it('观测汇总：两条判据在真实路径上恒 false（类型保证的推论，不是"检测器测到了"）', () => {
    const cancelled = cancelTask(running(), L(10), '取消');
    const verdict = gateRunResult(
      cancelled,
      envelope({ at: L(11), side_effects: [createSideEffect({ effect_id: 'e1', description: 'x', at: L(11) })] }),
    );
    const summary = summarizeLateResultGate(verdict.state);
    expect(summary.any_late_honored).toBe(false);
    expect(summary.any_side_effect_reverted_outside_type_contract).toBe(false);
    expect(summary.invariant_violations).toEqual([]);
    expect(summary.terminal).toBe(true);
    expect(summary.late_result_count).toBe(1);
    expect(summary.side_effect_count).toBe(1);
  });
});

describe('KRN-09+ 判据③：判定不另造一套（与 classifyResultArrival 逐例一致）', () => {
  it('迟到结论在状态 × 结局 × 版本 的矩阵上与 task-lifecycle 完全一致', () => {
    const states: readonly TaskLifecycleState[] = [
      running(R1),
      running(R2),
      applyTaskLifecycleTransition({ state: running(), to: 'paused', at: L(1), reason: '暂停' }),
      applyTaskLifecycleTransition({ state: running(), to: 'timed_out', at: L(1), reason: '超时' }),
      applyTaskLifecycleTransition({ state: running(), to: 'failed', at: L(1), reason: '失败' }),
      cancelTask(running(), L(1), '取消'),
    ];
    const outcomes = ['completed', 'failed', 'unknown'] as const;
    const revisions: readonly Revision[] = [R1, R2];

    for (const state of states) {
      for (const outcome of outcomes) {
        for (const revision of revisions) {
          const env = envelope({ at: L(9), outcome, result_task_revision: revision });
          const gated = gateRunResult(state, env);
          const reference = classifyResultArrival({
            state,
            run_id: env.run_id,
            result_task_revision: env.result_task_revision,
            outcome,
            at: env.at,
          });
          // 迟到结论同源（本模块不自带第二套分类器）
          expect(gated.late).toBe(reference.late);
          expect(gated.late_reason).toBe(reference.late_reason);
          // 迟到 ⇒ 绝不发布
          if (gated.late) {
            expect(gated.publish).toBe(false);
          }
        }
      }
    }
  });
});

describe('KRN-09+ 判据④：有序归约与真实并发交错', () => {
  it('归约：[结果@5, 取消@10, 结果@11] ⇒ 只有第一个结果被发布', () => {
    const outcome = applyOrderedLifecycleEvents(running(), [
      { kind: 'result', envelope: envelope({ run_id: asRunId('run-early'), at: L(5) }) },
      { kind: 'cancel', cancel: { at: L(10), reason: '用户取消' } },
      { kind: 'result', envelope: envelope({ run_id: asRunId('run-late'), at: L(11) }) },
    ]);

    expect(outcome.published_run_ids).toEqual([asRunId('run-early')]);
    expect(outcome.state.status).toBe('cancelled');
    expect(outcome.result_verdicts).toHaveLength(2);
    expect(outcome.result_verdicts[0]?.publish).toBe(true);
    expect(outcome.result_verdicts[1]?.publish).toBe(false);
    expect(outcome.state.late_results).toHaveLength(1);
  });

  it('反向对照：归约顺序按 at 升序（乱序传入不影响结论）', () => {
    const events = [
      { kind: 'cancel' as const, cancel: { at: L(10), reason: '取消' } },
      { kind: 'result' as const, envelope: envelope({ run_id: asRunId('run-early'), at: L(5) }) },
      { kind: 'result' as const, envelope: envelope({ run_id: asRunId('run-late'), at: L(11) }) },
    ];
    const forward = applyOrderedLifecycleEvents(running(), events);
    const reversed = applyOrderedLifecycleEvents(running(), [...events].reverse());
    expect(forward.published_run_ids).toEqual(reversed.published_run_ids);
    expect(forward.state.status).toBe(reversed.state.status);
    expect(forward.state.late_results).toHaveLength(reversed.state.late_results.length);
  });

  it('并发交错 20 次：取消先落地则结果必不发布；不变量恒干净', async () => {
    const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const micro = (): Promise<void> => Promise.resolve();

    let cancelFirstTrials = 0;
    let resultFirstTrials = 0;

    for (let trial = 0; trial < 20; trial += 1) {
      const gate = new ConcurrentResultGate({ task_id: TASK, revision: R1, at: L(0) });
      const verdicts: { readonly publish: boolean; readonly late: boolean; readonly cancelAlreadyApplied: boolean }[] = [];

      const canceller = (async () => {
        await (trial % 2 === 0 ? micro() : tick());
        gate.cancel({ at: L(10), reason: '并发取消', message_id: asMessageId('m-cancel') });
      })();
      const submitter = (async () => {
        await (trial % 3 === 0 ? tick() : micro());
        const cancelAlreadyApplied = gate.state.status === 'cancelled';
        const verdict = gate.submit(
          envelope({
            at: L(11),
            side_effects: [createSideEffect({ effect_id: 'e1', description: '外部写入', at: L(11) })],
          }),
        );
        verdicts.push({ publish: verdict.publish, late: verdict.late, cancelAlreadyApplied });
      })();
      await Promise.all([canceller, submitter]);

      const captured = verdicts[0];
      expect(captured).toBeDefined();
      if (captured?.cancelAlreadyApplied === true) {
        // **取消后**到达的结果：绝不发布、绝不当成功
        cancelFirstTrials += 1;
        expect(captured.publish).toBe(false);
        expect(captured.late).toBe(true);
      } else {
        // 结果先到（取消尚未落地）：它不属于"取消之后"，照常发布
        resultFirstTrials += 1;
        expect(captured?.publish).toBe(true);
        expect(captured?.late).toBe(false);
      }

      // 不论次序：终态是 cancelled；副作用如实保留（`reverted` 是字面量 false，见判据⑤的类型级钉子）
      expect(gate.state.status).toBe('cancelled');
      expect(gate.state.completed_at).toBeNull();
      expect(gate.state.late_results.every((record) => record.honored_as_success === false)).toBe(true);
      expect(gate.state.side_effects.every((effect) => effect.reverted === false)).toBe(true);
      expect(gate.invariantViolations()).toEqual([]);
      expect(summarizeLateResultGate(gate.state).any_late_honored).toBe(false);
    }

    // 两种交错次序在本轮都真实出现过（否则这条用例只覆盖了一侧）
    expect(cancelFirstTrials).toBeGreaterThan(0);
    expect(resultFirstTrials).toBeGreaterThan(0);
  });

  it('反向对照：结果严格早于取消时，并发交错下仍然发布成功', async () => {
    const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const gate = new ConcurrentResultGate({ task_id: TASK, revision: R1, at: L(0) });
    const verdicts: boolean[] = [];

    const submitter = (async () => {
      await Promise.resolve();
      const verdict = gate.submit(envelope({ at: L(5) }));
      verdicts.push(verdict.publish);
    })();
    const canceller = (async () => {
      await tick();
      gate.cancel({ at: L(10), reason: '结果之后才取消' });
    })();
    await Promise.all([submitter, canceller]);

    expect(verdicts).toEqual([true]);
    expect(gate.state.status).toBe('cancelled');
    expect(gate.state.late_results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 判据⑤（V-1）：两个"恒 false"判据的**真实性质**
//
// 修复前它们被当成"运行期检测器"来断言（`expect(x).toBe(false)` 被读作"实测证明没有
// 坏状态"）。实际上两条判据的取值由**别处的字面量类型**保证，在类型系统内不可达；
// 它们只在"绕过类型系统的输入"上可达。本区块用两条独立证据把这件事钉住：
//   1) 编译期钉子：字段类型一旦被放宽，本文件的**编译**就失败（不再假装是运行期实测）；
//   2) 旁路注入正反例：模拟"未校验的反序列化"（持久化行只校验 task_id，store-core.ts），
//      证明防御性校验分支**存在且能被触发**（不是被删掉），同时对真实构造路径仍恒 false。
// ---------------------------------------------------------------------------

/** 类型级判等：`Exactly<V, T>` 为 true ⇔ 类型 `V` 恰为字面量类型 `T`。 */
type Exactly<V, T> = [T] extends [V] ? ([V] extends [T] ? true : false) : false;

const revertedIsLiteralFalse: Exactly<ActionSideEffect['reverted'], false> = true;
const recordHonoredIsLiteralFalse: Exactly<LateResultRecord['honored_as_success'], false> = true;

describe('KRN-09+ 判据⑤（V-1）：恒 false 判据 = 类型级保证 + 防御性输入校验', () => {
  it('编译期钉子：reverted 与 honored_as_success 都是字面量 false（保证在类型层，不在运行期）', () => {
    expect([revertedIsLiteralFalse, recordHonoredIsLiteralFalse]).toEqual([true, true]);
  });

  it('真实构造路径：两条判据恒 false —— 这是类型保证的推论，不是"检测器工作"的证据', () => {
    const cancelled = cancelTask(running(), L(10), '取消');
    const verdict = gateRunResult(
      cancelled,
      envelope({ at: L(11), side_effects: [createSideEffect({ effect_id: 'e1', description: 'x', at: L(11) })] }),
    );
    expect(verdict.any_side_effect_reverted_outside_type_contract).toBe(false);
    const summary = summarizeLateResultGate(verdict.state);
    expect(summary.any_side_effect_reverted_outside_type_contract).toBe(false);
    expect(summary.any_late_honored).toBe(false);
    expect(summary.invariant_violations).toEqual([]);
  });

  it('正向对照（可达侧）：绕过类型系统的输入能被防御性校验报出来（分支没被删掉）', () => {
    // 模拟"未校验的反序列化"：`src/storage/store-core.ts` 的 `extensionCollections`
    // 只校验 `task_id` 是字符串，其余字段原样信任 —— 这正是这两条判据唯一可达的来源。
    const untrusted = JSON.parse(
      JSON.stringify({
        ...running(),
        side_effects: [
          {
            effect_id: 'forged',
            description: '伪造的"已撤销"副作用',
            at: 1,
            reverted: true,
            declared_reversible: true,
            reversal_attempt: 'undone',
          },
        ],
        late_results: [
          {
            run_id: 'run-forged',
            result_task_revision: 1,
            outcome: 'completed',
            arrived_at: 2,
            reason: 'task_cancelled',
            honored_as_success: true,
            note: '',
          },
        ],
      }),
    ) as TaskLifecycleState;

    const summary = summarizeLateResultGate(untrusted);
    expect(summary.any_side_effect_reverted_outside_type_contract).toBe(true);
    expect(summary.any_late_honored).toBe(true);
    expect(summary.invariant_violations).toHaveLength(2);
  });
});
