/**
 * K-I16 ②：确定性重放 —— `planDispatch → createDispatchRuntime` 走完整个波次调度，
 * 含一次**波次中途取消**，断言**波次级摘要**跨运行稳定。
 *
 * 两条场景：
 *  - `replayFull`           ：按波次把 3 个波跑完（a,b → c,d → e,f），全部成功。
 *  - `replayMidWaveCancel`  ：第 1 波部分完成后（a 成功、b 仍在跑），第 2 波的 c 单独启动、
 *                             d 尚未启动时取消——这是真正的"波次中途"。
 *
 * 稳定性有两个口径：① 同进程内两次独立运行得到同一摘要；② 钉住的字面量（跨进程/跨机稳定，
 * 因为 `structuralDigest` 是纯 FNV-1a、无墙钟、无随机，时钟经注入）。
 */

import { describe, expect, it } from 'vitest';

import {
  createDispatchRuntime,
  createManualClock,
  structuralDigest,
  type DispatchPlan,
  type DispatchRuntime,
} from '../../../apps/mobile-kernel/dispatch/index.js';

import { EXPECTED_WAVES, planOf, replaySplit } from './fixtures.js';

/** 钉住的摘要字面量（由本文件首次运行捕获后钉死；见文件头说明）。 */
const PIN_FULL_DIGEST = '2857fc45';
const PIN_CANCEL_DIGEST = '64169a54';

function waveLayoutOf(plan: DispatchPlan): string[][] {
  return plan.schedule.waves.map((wave) => [...wave.subtask_ids]);
}

function runtimeDigest(runtime: DispatchRuntime): string {
  return structuralDigest(
    JSON.stringify({ snapshot: runtime.snapshot(), late: runtime.lateResults() }),
  );
}

interface FullReplay {
  readonly plan: DispatchPlan;
  readonly runtime: DispatchRuntime;
  readonly digest: string;
  readonly launches: readonly (readonly string[])[];
  readonly trailing: readonly string[];
}

/** 按波次把整个调度跑完，全部成功。 */
function replayFull(): FullReplay {
  const plan = planOf(replaySplit());
  const runtime = createDispatchRuntime(plan, { clock: createManualClock(5_000) });
  const launches: string[][] = [];
  for (const wave of plan.schedule.waves) {
    launches.push([...runtime.launchReady()]);
    for (const id of wave.subtask_ids) {
      runtime.applyResult(id, 'succeeded');
    }
  }
  const trailing = [...runtime.launchReady()];
  return {
    plan,
    runtime,
    digest: runtimeDigest(runtime),
    launches,
    trailing,
  };
}

interface CancelReplay {
  readonly plan: DispatchPlan;
  readonly runtime: DispatchRuntime;
  readonly digest: string;
  readonly firstWave: readonly string[];
  readonly secondWave: readonly string[];
  readonly cancelledIds: readonly string[];
  readonly wasRunningIds: readonly string[];
  readonly alreadyTerminalIds: readonly string[];
  readonly afterCancelLaunches: readonly string[];
  readonly lateVerdictAfterCancel: string;
  readonly lateStateAfterCancel: string;
  readonly terminal: boolean;
  readonly released: boolean;
  readonly states: Readonly<Record<string, string>>;
}

/** 第 2 波首条单独启动后立即取消（真正的波次中途）。 */
function replayMidWaveCancel(): CancelReplay {
  const plan = planOf(replaySplit());
  const runtime = createDispatchRuntime(plan, { clock: createManualClock(5_000) });

  const firstWave = [...runtime.launchReady()]; // [a, b]
  runtime.applyResult('a', 'succeeded'); // a 成功 ⇒ 空出 1 个并发位
  const secondWave = [...runtime.launchReady()]; // 第 2 波 [c, d] 里只启动 c

  const report = runtime.cancel('replay-mid-wave'); // 波次中途取消
  const lateC = runtime.applyResult('c', 'succeeded'); // 迟到结果：不得翻回成功
  runtime.applyResult('b', 'failed');

  const afterCancelLaunches = [...runtime.launchReady()];
  const terminal = runtime.isTerminal();
  const release = runtime.releaseGroup();
  const snapshot = runtime.snapshot();

  return {
    plan,
    runtime,
    digest: runtimeDigest(runtime),
    firstWave,
    secondWave,
    cancelledIds: [...report.cancelled_ids],
    wasRunningIds: [...report.was_running_ids],
    alreadyTerminalIds: [...report.already_terminal_ids],
    afterCancelLaunches,
    lateVerdictAfterCancel: lateC.verdict,
    lateStateAfterCancel: String(lateC.state),
    terminal,
    released: release.released,
    states: Object.fromEntries(snapshot.subtasks.map((entry) => [entry.id, entry.state])),
  };
}

describe('K-I16 · 波次级摘要：整段调度确定性', () => {
  it('调度器分波钉住：[[a,b],[c,d],[e,f]]，且两次运行的波次计划摘要一致', () => {
    const planA = planOf(replaySplit());
    const planB = planOf(replaySplit());
    expect(waveLayoutOf(planA)).toEqual(EXPECTED_WAVES.map((wave) => [...wave]));
    expect(planA.schedule.digest).toBe(planB.schedule.digest);
    expect(planA.digest).toBe(planB.digest);
    expect(planA.group.members).toHaveLength(6);
  });

  it('整段跑完：所有子任务 succeeded，两次运行摘要一致', () => {
    const runA = replayFull();
    const runB = replayFull();
    expect(runA.launches).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(runA.trailing).toEqual([]);
    expect(runA.runtime.snapshot().subtasks.map((entry) => entry.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(runA.runtime.isTerminal()).toBe(true);
    expect(runA.digest).toBe(runB.digest);
    expect(runA.digest).toBe(PIN_FULL_DIGEST);
  });
});

describe('K-I16 · 波次中途取消：迟到结果门 + 状态确定性', () => {
  it('确实在波次中途取消（第 2 波只启动了 c，d 仍 pending）', () => {
    const run = replayMidWaveCancel();
    expect(run.firstWave).toEqual(['a', 'b']);
    expect(run.secondWave).toEqual(['c']); // 并发上限 2：b 在跑，仅空出 1 位
    expect(run.wasRunningIds).toEqual(['b', 'c']);
    expect(run.cancelledIds).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(run.alreadyTerminalIds).toEqual(['a']);
  });

  it('取消后迟到结果判 late_after_cancel，状态保持 cancelled，不再启动任何子任务', () => {
    const run = replayMidWaveCancel();
    expect(run.lateVerdictAfterCancel).toBe('late_after_cancel');
    expect(run.lateStateAfterCancel).toBe('cancelled');
    expect(run.states).toEqual({
      a: 'succeeded',
      b: 'cancelled',
      c: 'cancelled',
      d: 'cancelled',
      e: 'cancelled',
      f: 'cancelled',
    });
    expect(run.afterCancelLaunches).toEqual([]);
    expect(run.terminal).toBe(true);
    expect(run.released).toBe(true);
  });

  it('波次级（含取消）摘要跨运行稳定，且等于钉住字面量', () => {
    const runA = replayMidWaveCancel();
    const runB = replayMidWaveCancel();
    expect(runA.digest).toBe(runB.digest);
    expect(runA.digest).toBe(PIN_CANCEL_DIGEST);
  });

  it('负对照：任务未终态时不得释放临时群组', () => {
    const plan = planOf(replaySplit());
    const fresh = createDispatchRuntime(plan, { clock: createManualClock(5_000) });
    expect(fresh.releaseGroup().released).toBe(false);
  });
});
