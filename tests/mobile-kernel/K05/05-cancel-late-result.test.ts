/**
 * K05 独立验证 ⑤：**取消 / 晚到结果 / 失败传播**。
 *
 * 核心纪律：任务取消后到达的结果**不得**把子任务翻回 succeeded——一律判
 * `late_after_cancel`，如实记入 `lateResults()`，状态保持 `cancelled`。
 * 另配：重复结果幂等（`duplicate`）、未启动（`not_running`）、阻塞（`blocked`）、
 * 未知子任务（`unknown_subtask`）、失败沿依赖传播（`dependency_failed`）。
 */

import { describe, expect, it } from 'vitest';

import {
  createDispatchRuntime,
  createManualClock,
  isTerminalSubtaskState,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import { planOf, spec, split } from './fixtures.js';

function runtimeOf(input: ReturnType<typeof split>, maxParallel = 2) {
  const plan = planOf(input, { max_parallel: maxParallel });
  const clock = createManualClock(500);
  return { runtime: createDispatchRuntime(plan, { clock }), clock };
}

describe('K05 取消 · 状态迁移与 was_running', () => {
  it('取消时运行中的子任务记入 was_running，全部非终态转 cancelled', () => {
    const { runtime, clock } = runtimeOf(
      split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit'), spec('c', 'slide.edit')]),
      2,
    );
    runtime.launchReady(); // a, b running; c pending
    clock.set(900);
    const report = runtime.cancel('用户改主意了');
    expect(report.cancelled).toBe(true);
    expect(report.was_running_ids).toEqual(['a', 'b']);
    expect(report.cancelled_ids).toEqual(['a', 'b', 'c']);
    expect(report.at).toBe(900);
    const snap = runtime.snapshot();
    expect(snap.cancelled).toBe(true);
    expect(snap.cancel_reason).toBe('用户改主意了');
    expect(snap.subtasks.every((task) => task.state === 'cancelled')).toBe(true);
    expect(runtime.isTerminal()).toBe(true);
  });

  it('已成功的子任务在取消时不被降级（进 already_terminal）', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit')]), 2);
    runtime.launchReady();
    runtime.applyResult('a', 'succeeded');
    const report = runtime.cancel('停');
    expect(report.already_terminal_ids).toEqual(['a']);
    expect(report.was_running_ids).toEqual(['b']);
    expect(runtime.snapshot().subtasks.find((task) => task.id === 'a')?.state).toBe('succeeded');
  });

  it('重复取消幂等：第二次 cancelled=false 且不改状态', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    runtime.cancel('第一次');
    const second = runtime.cancel('第二次');
    expect(second.cancelled).toBe(false);
    expect(second.cancelled_ids).toEqual([]);
  });
});

describe('K05 晚到结果 · 取消后不得翻回成功（核心纪律）', () => {
  it('运行中被取消 ⇒ 迟到 succeeded 判 late_after_cancel，状态保持 cancelled', () => {
    const { runtime, clock } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    runtime.launchReady();
    runtime.cancel('取消');
    clock.set(1234);
    const decision = runtime.applyResult('a', 'succeeded');
    expect(decision.verdict).toBe('late_after_cancel');
    expect(decision.accepted).toBe(false);
    expect(decision.state).toBe('cancelled');
    expect(decision.state).not.toBe('succeeded');
    // 如实保留
    const late = runtime.lateResults();
    expect(late).toHaveLength(1);
    expect(late[0]?.subtask_id).toBe('a');
    expect(late[0]?.outcome).toBe('succeeded');
    expect(late[0]?.arrived_at).toBe(1234);
    expect(late[0]?.reason).toContain('取消');
    // 快照仍是 cancelled
    expect(runtime.snapshot().subtasks[0]?.state).toBe('cancelled');
  });

  it('取消后再 launchReady 不再启动任何东西', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit')]), 2);
    runtime.cancel('取消');
    expect(runtime.launchReady()).toEqual([]);
  });

  it('取消前已成功 ⇒ 随后的重复结果判 duplicate（不是 late）', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    runtime.launchReady();
    runtime.applyResult('a', 'succeeded');
    runtime.cancel('取消');
    const decision = runtime.applyResult('a', 'succeeded');
    expect(decision.verdict).toBe('duplicate');
    expect(runtime.lateResults()).toHaveLength(0);
  });
});

describe('K05 结果处置 · 其余分支', () => {
  it('未启动（pending）的结果 ⇒ not_running', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit'), spec('b', 'sheet.edit')]), 1);
    runtime.launchReady(); // 只启动 a
    const decision = runtime.applyResult('b', 'succeeded');
    expect(decision.verdict).toBe('not_running');
    expect(decision.state).toBe('pending');
  });

  it('已阻塞子任务的结果 ⇒ blocked，不接受', () => {
    const { runtime } = runtimeOf(split('目标', [spec('x', 'order.submit')]), 1);
    const decision = runtime.applyResult('x', 'succeeded');
    expect(decision.verdict).toBe('blocked');
    expect(decision.accepted).toBe(false);
  });

  it('未知子任务 ⇒ unknown_subtask，state 为 null', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    const decision = runtime.applyResult('ghost', 'succeeded');
    expect(decision.verdict).toBe('unknown_subtask');
    expect(decision.state).toBeNull();
  });

  it('重复成功结果 ⇒ duplicate（不重复产生副作用）', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    runtime.launchReady();
    expect(runtime.applyResult('a', 'succeeded').verdict).toBe('accepted');
    const again = runtime.applyResult('a', 'succeeded');
    expect(again.verdict).toBe('duplicate');
    expect(again.accepted).toBe(false);
  });
});

describe('K05 失败传播 · 上游失败 ⇒ 下游 dependency_failed', () => {
  it('a 失败后，依赖 a 的 b 与依赖 b 的 c 都转 blocked', () => {
    const { runtime } = runtimeOf(
      split('链', [spec('a', 'word.edit'), spec('b', 'sheet.edit', ['a']), spec('c', 'slide.edit', ['b'])]),
      3,
    );
    runtime.launchReady(); // 只 a
    runtime.applyResult('a', 'failed');
    const snap = runtime.snapshot();
    expect(snap.subtasks.find((task) => task.id === 'a')?.state).toBe('failed');
    expect(snap.subtasks.find((task) => task.id === 'b')?.state).toBe('blocked');
    expect(snap.subtasks.find((task) => task.id === 'b')?.block_reason).toBe('dependency_failed');
    expect(snap.subtasks.find((task) => task.id === 'c')?.state).toBe('blocked');
    expect(runtime.launchReady()).toEqual([]);
  });
});

describe('K05 群组释放 · 仅在终态可释放', () => {
  it('有 pending/running 时拒绝释放', () => {
    const { runtime } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    const report = runtime.releaseGroup();
    expect(report.released).toBe(false);
    expect(report.released_at).toBeNull();
  });

  it('全部终态后释放成功', () => {
    const { runtime, clock } = runtimeOf(split('目标', [spec('a', 'word.edit')]), 1);
    runtime.launchReady();
    runtime.applyResult('a', 'succeeded');
    clock.set(7777);
    const report = runtime.releaseGroup();
    expect(report.released).toBe(true);
    expect(report.released_at).toBe(7777);
    expect(isTerminalSubtaskState('succeeded')).toBe(true);
  });
});
