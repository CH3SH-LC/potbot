/**
 * KRN-09 任务生命周期与迟到结果的正/反例测试（合同 R205 / R213 / R216 / R226）。
 *
 * 三条核心判据各自独立断言：
 * ① 取消后到达的迟到结果**不得**把任务置为成功；
 * ② 已发生副作用**如实保留**（`reverted` 恒 false，不假称撤销）；
 * ③ 暂停/继续/超时/失败恢复可取，取消**不可复活**。
 */

import { describe, expect, it } from 'vitest';
import { asLogicalTime, asMessageId, asRevision, asRunId, asTaskId, type LogicalTime } from '../protocol/index.js';
import { createSideEffect } from '../workledger/index.js';
import {
  TASK_RUNTIME_STATUSES,
  TASK_RUNTIME_STATUS_LABELS,
  applyTaskLifecycleTransition,
  cancelTask,
  classifyResultArrival,
  createTaskLifecycle,
  evaluateTaskLifecycleTransition,
  isTaskTimedOut,
  pauseTask,
  recoverTask,
  resumeTask,
  summarizeTaskLifecycle,
  type TaskLifecycleState,
} from './task-lifecycle.js';

const TASK = asTaskId('task-1');
const R1 = asRevision(1);
const R2 = asRevision(2);
const RUN = asRunId('run-1');

const L = (n: number): LogicalTime => asLogicalTime(n);

function fresh(status: Parameters<typeof createTaskLifecycle>[0]['status'] = 'running'): TaskLifecycleState {
  return createTaskLifecycle({ task_id: TASK, revision: R1, at: L(0), status });
}

describe('KRN-09 六态与转换', () => {
  it('恰好六态，各有中文名', () => {
    expect(TASK_RUNTIME_STATUSES).toHaveLength(6);
    for (const status of TASK_RUNTIME_STATUSES) {
      expect(TASK_RUNTIME_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  it('暂停 → 继续 可取，且计数上升', () => {
    let state = fresh();
    state = pauseTask(state, L(1), '用户要求暂停');
    expect(state.status).toBe('paused');
    expect(state.pause_count).toBe(1);
    state = resumeTask(state, L(2), '用户要求继续');
    expect(state.status).toBe('running');
    expect(state.pause_count).toBe(1);
  });

  it('超时后经显式恢复回到 running（不是自动，也不算成功）', () => {
    let state = fresh();
    state = applyTaskLifecycleTransition({ state, to: 'timed_out', at: L(5), reason: '超过时限' });
    expect(state.status).toBe('timed_out');
    expect(state.timeout_count).toBe(1);
    state = recoverTask(state, L(6), '用户延长时限');
    expect(state.status).toBe('running');
    expect(state.recovery_count).toBe(1);
  });

  it('失败恢复：只有 failed / timed_out 可以恢复', () => {
    const running = fresh();
    expect(() => recoverTask(running, L(1), '无端恢复')).toThrowError(/只有 failed \/ timed_out 可以恢复/);
    const failed = applyTaskLifecycleTransition({ state: running, to: 'failed', at: L(2), reason: '依赖挂了' });
    expect(recoverTask(failed, L(3), '依赖恢复').status).toBe('running');
  });

  it('取消是终态：不得复活 / 回退（R205）', () => {
    const cancelled = cancelTask(fresh(), L(4), '用户取消');
    expect(cancelled.status).toBe('cancelled');
    const verdict = evaluateTaskLifecycleTransition({ state: cancelled, to: 'running', at: L(5), reason: '想复活' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('terminal_locked');
  });

  it('除「已完成」外，转换必须给原因', () => {
    const verdict = evaluateTaskLifecycleTransition({ state: fresh(), to: 'paused', at: L(1) });
    expect(verdict.reason).toBe('missing_reason');
  });

  it('已完成是终态；非法转换被拒', () => {
    const done = applyTaskLifecycleTransition({ state: fresh(), to: 'completed', at: L(9) });
    expect(done.status).toBe('completed');
    expect(evaluateTaskLifecycleTransition({ state: done, to: 'running', at: L(10), reason: 'x' }).reason).toBe(
      'terminal_locked',
    );
    expect(evaluateTaskLifecycleTransition({ state: fresh(), to: 'paused', at: L(1), reason: 'x' }).ok).toBe(true);
    const paused = pauseTask(fresh(), L(1), 'x');
    expect(
      evaluateTaskLifecycleTransition({ state: paused, to: 'completed', at: L(2) }).reason,
    ).toBe('illegal_task_transition');
  });

  it('逻辑时间超时判定：now >= deadline', () => {
    expect(isTaskTimedOut(L(10), L(9))).toBe(false);
    expect(isTaskTimedOut(L(10), L(10))).toBe(true);
    expect(isTaskTimedOut(L(10), L(11))).toBe(true);
  });
});

describe('KRN-09 反例③：取消后到达的迟到结果不得变成当前成功', () => {
  it('任务已取消 ⇒ 迟到的「完成」结果不改变状态，且 honored_as_success 恒 false', () => {
    const cancelled = cancelTask(fresh(), L(10), '用户取消');
    const verdict = classifyResultArrival({
      state: cancelled,
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'completed',
      at: L(11),
      side_effects: [
        createSideEffect({ effect_id: 'e1', description: '已向外部系统提交', at: L(9) }),
      ],
    });

    expect(verdict.late).toBe(true);
    expect(verdict.late_reason).toBe('task_cancelled');
    expect(verdict.applied).toBe(false);
    // 状态**没有**变成 completed
    expect(verdict.next.status).toBe('cancelled');
    expect(verdict.next.completed_at).toBeNull();
    // 留痕：绝不当成功
    expect(verdict.next.late_results).toHaveLength(1);
    expect(verdict.next.late_results[0]?.honored_as_success).toBe(false);
    expect(verdict.next.late_results[0]?.reason).toBe('task_cancelled');
  });

  it('已发生副作用照实保留：取消不会让副作用"消失"或"被撤销"', () => {
    const cancelled = cancelTask(fresh(), L(10), '用户取消');
    const verdict = classifyResultArrival({
      state: cancelled,
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'completed',
      at: L(11),
      side_effects: [createSideEffect({ effect_id: 'e1', description: '外部已写入', at: L(9) })],
    });
    expect(verdict.next.side_effects).toHaveLength(1);
    // 字面量 false：不得假称撤销（R205）
    expect(verdict.next.side_effects[0]?.reverted).toBe(false);
  });

  it('取消时直接传入已发生副作用：同样如实入账', () => {
    const cancelled = cancelTask(fresh(), L(10), '用户取消', {
      cancelled_by_message_id: asMessageId('m-cancel'),
      side_effects: [createSideEffect({ effect_id: 'e9', description: '付款已发起', at: L(9) })],
    });
    expect(cancelled.cancelled_by_message_id).toBe(asMessageId('m-cancel'));
    expect(cancelled.side_effects).toHaveLength(1);
    expect(cancelled.side_effects[0]?.reverted).toBe(false);
  });

  it('超时 / 失败 / 暂停 之后到达的成功结果同样被判迟到', () => {
    const cases: readonly {
      readonly state: TaskLifecycleState;
      readonly reason: string;
    }[] = [
      {
        state: applyTaskLifecycleTransition({ state: fresh(), to: 'timed_out', at: L(5), reason: '超时' }),
        reason: 'task_timed_out',
      },
      {
        state: applyTaskLifecycleTransition({ state: fresh(), to: 'failed', at: L(5), reason: '失败' }),
        reason: 'task_failed',
      },
      { state: pauseTask(fresh(), L(5), '暂停'), reason: 'task_paused' },
    ];
    for (const { state, reason } of cases) {
      const verdict = classifyResultArrival({
        state,
        run_id: RUN,
        result_task_revision: R1,
        outcome: 'completed',
        at: L(6),
      });
      expect(verdict.late).toBe(true);
      expect(verdict.late_reason).toBe(reason);
      expect(verdict.applied).toBe(false);
      expect(verdict.next.status).toBe(state.status);
    }
  });

  it('结果版本落后当前版本 ⇒ 迟到（stale_task_revision，R213）', () => {
    const state = createTaskLifecycle({ task_id: TASK, revision: R2, at: L(0) });
    const verdict = classifyResultArrival({
      state,
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'completed',
      at: L(1),
    });
    expect(verdict.late).toBe(true);
    expect(verdict.late_reason).toBe('stale_task_revision');
    expect(verdict.next.status).toBe('running');
  });
});

describe('KRN-09 在时结果与未知结果', () => {
  it('在时的「完成」结果正常应用', () => {
    const verdict = classifyResultArrival({
      state: fresh(),
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'completed',
      at: L(3),
    });
    expect(verdict.late).toBe(false);
    expect(verdict.applied).toBe(true);
    expect(verdict.next.status).toBe('completed');
    expect(verdict.next.late_results).toHaveLength(0);
  });

  it('在时的「失败」结果把任务置失败（可恢复）', () => {
    const verdict = classifyResultArrival({
      state: fresh(),
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'failed',
      at: L(3),
    });
    expect(verdict.applied).toBe(true);
    expect(verdict.next.status).toBe('failed');
    expect(verdict.next.reason).not.toBeNull();
  });

  it('结果未知：只留痕、不改变状态、不盲目重试（R246）', () => {
    const verdict = classifyResultArrival({
      state: fresh(),
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'unknown',
      at: L(3),
    });
    expect(verdict.late).toBe(false);
    expect(verdict.applied).toBe(false);
    expect(verdict.next.status).toBe('running');
    expect(verdict.next.unknown_results).toHaveLength(1);
    expect(verdict.next.late_results).toHaveLength(0);
  });
});

describe('KRN-09 观测汇总', () => {
  it('any_late_honored 恒为 false', () => {
    const cancelled = cancelTask(fresh(), L(10), '取消');
    const after = classifyResultArrival({
      state: cancelled,
      run_id: RUN,
      result_task_revision: R1,
      outcome: 'completed',
      at: L(11),
    }).next;
    const summary = summarizeTaskLifecycle(after);
    expect(summary.any_late_honored).toBe(false);
    expect(summary.late_result_count).toBe(1);
    expect(summary.terminal).toBe(true);
    expect(summary.status_label).toBe('已取消');
    expect(summary.side_effect_count).toBe(0);
  });
});
