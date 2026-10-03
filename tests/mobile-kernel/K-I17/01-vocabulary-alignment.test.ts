/**
 * K-I17 独立验证：**派发迟到结果词表与共享调度器语义对齐**。
 *
 * 背景（K05 自述的疑点）：K05 的 `ResultVerdict`
 * （`accepted` / `late_after_cancel` / `duplicate` / `blocked` / `not_running` / `unknown_subtask`）
 * 与共享侧 `src/scheduler/late-result-gate.ts` 的 `GATE_DECISIONS`（`publish`/`late`/`unknown`）
 * 及 `task-lifecycle.ts` 的 `LATE_RESULT_REASONS` 此前只是"心照不宣"。本测试把
 * `apps/mobile-kernel/dispatch/runtime.ts` 新发布的**唯一处置词表 + 显式映射表**钉死，并对
 * **真实共享源文件**做逐项对照——两侧分叉即红。
 *
 * 覆盖本单元点名要求的两个场景：
 * - **取消中波次（cancelled-mid-wave）的迟到结果** → `late_after_cancel` ↔ 共享 `late/task_cancelled`；
 * - **重复结果（duplicate）** 的两条路径 → 任务仍在跑（子任务本地，共享无原因）与 取消后
 *   （共享 `late/task_cancelled`）。
 *
 * 明确不做的事：不 import 手机运行时以外的任何 `apps/mobile-kernel/*` 兄弟包；本测试对 `src/scheduler`
 * 只**只读导入常量/纯函数**用于交叉核对，不改任何共享文件。
 */

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_RESULT_DISPOSITIONS,
  DISPOSITION_TO_SCHEDULER_DECISION,
  RESULT_VERDICT_ALIGNMENT,
  SCHEDULER_GATE_DECISIONS,
  SCHEDULER_LATE_RESULT_REASONS,
  createDispatchRuntime,
  resolveResultDisposition,
  schedulerLateReasonForDuplicate,
  type ResolvedResultDisposition,
} from '../../../apps/mobile-kernel/dispatch/runtime.js';
import {
  RESULT_VERDICTS,
  createManualClock,
  createStaticDiscovery,
  identityInstanceId,
  planDispatch,
  type DiscoveredCapability,
  type DispatchPlan,
  type DispatchRuntime,
  type SubtaskSpec,
} from '../../../apps/mobile-kernel/dispatch/index.js';

// --- 共享侧**真实实现**（只读）：把镜像词表钉在真实源文件上，而非自证 ---------------
import { GATE_DECISIONS, gateRunResult, type RunResultEnvelope } from '../../../src/scheduler/late-result-gate.js';
import {
  LATE_RESULT_REASONS,
  cancelTask,
  createTaskLifecycle,
  type TaskLifecycleState,
} from '../../../src/scheduler/task-lifecycle.js';
import { asLogicalTime, asRevision, asRunId, asTaskId } from '../../../src/protocol/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const WORD: DiscoveredCapability = Object.freeze({
  capability_id: 'word.edit',
  template_id: 'word',
  authorized: true,
  executable: true,
});
const SHEET: DiscoveredCapability = Object.freeze({
  capability_id: 'sheet.edit',
  template_id: 'excel',
  authorized: true,
  executable: true,
});
const SLIDE: DiscoveredCapability = Object.freeze({
  capability_id: 'slide.edit',
  template_id: 'ppt',
  authorized: true,
  executable: true,
});
const UNAUTHORIZED: DiscoveredCapability = Object.freeze({
  capability_id: 'order.submit',
  template_id: 'meituan',
  authorized: false,
  executable: true,
  note: '未授权 ⇒ 计划期阻塞',
});

function spec(id: string, capability_id: string, depends_on: readonly string[] = []): SubtaskSpec {
  return { id, goal: `do ${id}`, capability_id, depends_on };
}

function planOf(
  subtasks: readonly SubtaskSpec[],
  maxParallel = 2,
  capabilities: readonly DiscoveredCapability[] = [WORD, SHEET, SLIDE],
): DispatchPlan {
  return planDispatch({
    task_id: 'task-align',
    split: { goal: '对齐词表', subtasks },
    discovery: createStaticDiscovery(capabilities),
    max_parallel: maxParallel,
    clock: createManualClock(1_000),
    group_id: 'grp-align',
    instance_id_for: identityInstanceId,
  });
}

function runtimeOf(
  subtasks: readonly SubtaskSpec[],
  maxParallel = 2,
  capabilities: readonly DiscoveredCapability[] = [WORD, SHEET, SLIDE],
): DispatchRuntime {
  return createDispatchRuntime(planOf(subtasks, maxParallel, capabilities), {
    clock: createManualClock(1_000),
  });
}

const L = (n: number): ReturnType<typeof asLogicalTime> => asLogicalTime(n);
const TASK = asTaskId('task-align');
const REV = asRevision(1);

function runningSchedulerState(): TaskLifecycleState {
  return createTaskLifecycle({ task_id: TASK, revision: REV, at: L(0) });
}

function completedEnvelope(overrides: Partial<RunResultEnvelope> = {}): RunResultEnvelope {
  return Object.freeze({
    run_id: overrides.run_id ?? asRunId('run-align-1'),
    result_task_revision: overrides.result_task_revision ?? REV,
    outcome: overrides.outcome ?? 'completed',
    at: overrides.at ?? L(10),
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  });
}

/** 交叉核对：共享闸门决定是否与本侧归一化口径一致（同一"结果不得成为当前成功"的结论）。 */
function expectAgreesWithScheduler(
  resolved: ResolvedResultDisposition,
  scheduler: { readonly decision: string; readonly late_reason: string | null; readonly publish: boolean },
): void {
  expect(resolved.scheduler_decision).toBe(scheduler.decision);
  expect(resolved.scheduler_late_reason).toBe(scheduler.late_reason);
  expect(resolved.honored_as_success).toBe(scheduler.publish);
}

// ---------------------------------------------------------------------------
// ① 镜像词表 == 真实共享源文件（分叉即红）
// ---------------------------------------------------------------------------

describe('K-I17 词表镜像：与共享源文件逐项相等', () => {
  it('SCHEDULER_GATE_DECISIONS 与 src/scheduler/late-result-gate.ts 的 GATE_DECISIONS 相等', () => {
    expect([...SCHEDULER_GATE_DECISIONS]).toEqual([...GATE_DECISIONS]);
  });

  it('SCHEDULER_LATE_RESULT_REASONS 与 src/scheduler/task-lifecycle.ts 的 LATE_RESULT_REASONS 相等', () => {
    expect([...SCHEDULER_LATE_RESULT_REASONS]).toEqual([...LATE_RESULT_REASONS]);
  });
});

// ---------------------------------------------------------------------------
// ② 映射表：完备 + 自洽
// ---------------------------------------------------------------------------

describe('K-I17 映射表：完备性与自洽性', () => {
  it('恰好覆盖全部 ResultVerdict，无遗漏、无多余', () => {
    expect(Object.keys(RESULT_VERDICT_ALIGNMENT).sort()).toEqual([...RESULT_VERDICTS].sort());
    for (const verdict of RESULT_VERDICTS) {
      expect(RESULT_VERDICT_ALIGNMENT[verdict].verdict).toBe(verdict);
    }
  });

  it('每条 disposition 属于归一化词表，且 scheduler_decision 与词表级映射一致', () => {
    for (const verdict of RESULT_VERDICTS) {
      const row = RESULT_VERDICT_ALIGNMENT[verdict];
      expect(CANONICAL_RESULT_DISPOSITIONS).toContain(row.disposition);
      expect(row.scheduler_decision).toBe(DISPOSITION_TO_SCHEDULER_DECISION[row.disposition]);
      if (row.scheduler_decision === 'late' && row.scheduler_late_reason !== null) {
        expect(SCHEDULER_LATE_RESULT_REASONS).toContain(row.scheduler_late_reason);
      }
      if (row.scheduler_decision !== 'late') {
        expect(row.scheduler_late_reason).toBeNull();
      }
    }
  });

  it('仅 accepted 被当作当前成功（honored_as_success）', () => {
    for (const verdict of RESULT_VERDICTS) {
      expect(RESULT_VERDICT_ALIGNMENT[verdict].honored_as_success).toBe(verdict === 'accepted');
    }
  });

  it('归一化处置覆盖共享侧全部决定（每个决定恰好对应一个处置）', () => {
    for (const decision of SCHEDULER_GATE_DECISIONS) {
      const matches = CANONICAL_RESULT_DISPOSITIONS.filter(
        (disposition) => DISPOSITION_TO_SCHEDULER_DECISION[disposition] === decision,
      );
      expect(matches).toHaveLength(1);
    }
  });

  it('如实登记两侧独有词：共享 unknown 无本侧 verdict；本侧 rejected 无共享决定', () => {
    const used = new Set(RESULT_VERDICTS.map((verdict) => RESULT_VERDICT_ALIGNMENT[verdict].disposition));
    // 缺口诚实标注：applyResult 只接受 succeeded/failed，没有共享侧 unknown 结局的入口
    expect(used.has('unknown')).toBe(false);
    expect(DISPOSITION_TO_SCHEDULER_DECISION.unknown).toBe('unknown');
    // 手机侧独有：闸门之前即被拒
    expect(used.has('rejected')).toBe(true);
    expect(DISPOSITION_TO_SCHEDULER_DECISION.rejected).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ③ 正常到达（正对照：映射不是"永远判迟到"）
// ---------------------------------------------------------------------------

describe('K-I17 正对照：运行中结果 = published / publish', () => {
  it('运行中子任务的成功结果 → accepted，且共享闸门同样 publish', () => {
    const runtime = runtimeOf([spec('a', 'word.edit'), spec('b', 'sheet.edit')], 2);
    runtime.launchReady();
    const decision = runtime.applyResult('a', 'succeeded');
    expect(decision.verdict).toBe('accepted');

    const resolved = runtime.align(decision);
    expect(resolved.disposition).toBe('published');
    expect(resolved.scheduler_decision).toBe('publish');
    expect(resolved.scheduler_late_reason).toBeNull();
    expect(resolved.honored_as_success).toBe(true);
    expect(resolved.honored_as_success).toBe(decision.accepted);

    const scheduler = gateRunResult(runningSchedulerState(), completedEnvelope());
    expectAgreesWithScheduler(resolved, scheduler);
  });
});

// ---------------------------------------------------------------------------
// ④ 取消中波次的迟到结果：late_after_cancel ↔ late/task_cancelled
// ---------------------------------------------------------------------------

describe('K-I17 取消中波次迟到结果：late_after_cancel ↔ 共享 late/task_cancelled', () => {
  it('波次运行中被取消，随后到达的成功结果 → late_after_cancel；两侧同判 late/task_cancelled', () => {
    // 3 个子任务、并发 2：a、b 进波次运行，c 仍 pending
    const runtime = runtimeOf(
      [spec('a', 'word.edit'), spec('b', 'sheet.edit'), spec('c', 'slide.edit')],
      2,
    );
    expect([...runtime.launchReady()]).toEqual(['a', 'b']);
    const cancelReport = runtime.cancel('用户取消');
    expect(cancelReport.was_running_ids).toEqual(['a', 'b']);

    // 波次中被取消的 a 的迟到结果
    const decision = runtime.applyResult('a', 'succeeded');
    expect(decision.verdict).toBe('late_after_cancel');
    expect(decision.accepted).toBe(false);
    expect(decision.state).toBe('cancelled');

    const resolved = runtime.align(decision);
    expect(resolved.disposition).toBe('late');
    expect(resolved.scheduler_decision).toBe('late');
    expect(resolved.scheduler_late_reason).toBe('task_cancelled');
    expect(resolved.honored_as_success).toBe(false);
    expect(resolved.observed_at).toBe('task_gate');

    // 与共享侧真实实现交叉核对：任务取消后到达的 completed 结果 → late / task_cancelled / publish=false
    const cancelledState = cancelTask(runningSchedulerState(), L(5), '用户取消');
    const scheduler = gateRunResult(cancelledState, completedEnvelope());
    expect(scheduler.decision).toBe('late');
    expect(scheduler.publish).toBe(false);
    expectAgreesWithScheduler(resolved, scheduler);

    // 迟到结果如实保留（不静默丢弃），状态不翻转
    expect(runtime.lateResults()).toHaveLength(1);
    expect(runtime.snapshot().subtasks.find((task) => task.id === 'a')?.state).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 重复结果：子任务本地口径 vs 共享任务闸门（显式登记差异）
// ---------------------------------------------------------------------------

describe('K-I17 重复结果：duplicate 的两条路径', () => {
  it('任务仍在跑时的重复结果 → duplicate（子任务本地），共享闸门无对应原因', () => {
    const runtime = runtimeOf([spec('a', 'word.edit'), spec('b', 'sheet.edit')], 2);
    runtime.launchReady();
    expect(runtime.applyResult('a', 'succeeded').verdict).toBe('accepted');

    const decision = runtime.applyResult('a', 'succeeded');
    expect(decision.verdict).toBe('duplicate');
    expect(decision.accepted).toBe(false);

    const resolved = runtime.align(decision);
    expect(resolved.disposition).toBe('late');
    expect(resolved.scheduler_decision).toBe('late');
    // 任务未取消：共享任务级闸门没有"子任务重复"这个概念，故无迟到原因
    expect(resolved.scheduler_late_reason).toBeNull();
    expect(resolved.observed_at).toBe('subtask_local');
    expect(resolved.honored_as_success).toBe(false);
    expect(schedulerLateReasonForDuplicate({ cancelled: false })).toBeNull();

    // 显式登记差异方向：共享闸门（任务级、同版本）会判 publish —— 它看不到"子任务已终态"。
    // 这正是映射表把 duplicate 标注为 observed_at='subtask_local' 的原因，不是矛盾。
    const scheduler = gateRunResult(runningSchedulerState(), completedEnvelope());
    expect(scheduler.decision).toBe('publish');
    expect(scheduler.publish).toBe(true);
    // 两者对"这是不是一个新结果"的观测层级不同；本侧更细，仍确保 honored=false。
    expect(resolved.honored_as_success).toBe(false);
  });

  it('取消后（子任务先成功）的重复结果 → duplicate；两侧同判 task_cancelled、不发布', () => {
    const runtime = runtimeOf([spec('a', 'word.edit')], 1);
    runtime.launchReady();
    expect(runtime.applyResult('a', 'succeeded').verdict).toBe('accepted');
    runtime.cancel('取消');

    const decision = runtime.applyResult('a', 'succeeded');
    expect(decision.verdict).toBe('duplicate'); // 已终态且非 cancelled ⇒ 幂等重复，不重复计迟到
    expect(decision.state).toBe('succeeded');

    const resolved = runtime.align(decision);
    expect(resolved.disposition).toBe('late');
    expect(resolved.scheduler_decision).toBe('late');
    expect(resolved.scheduler_late_reason).toBe('task_cancelled'); // 由任务已取消解析而来
    expect(resolved.honored_as_success).toBe(false);
    expect(schedulerLateReasonForDuplicate({ cancelled: true })).toBe('task_cancelled');

    // 共享侧：任务取消后到达的 completed 结果 → late / task_cancelled / publish=false
    const cancelledState = cancelTask(runningSchedulerState(), L(5), '取消');
    const scheduler = gateRunResult(cancelledState, completedEnvelope());
    expectAgreesWithScheduler(resolved, scheduler);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 其余三条：闸门之前即被拒（rejected，共享无对应决定）
// ---------------------------------------------------------------------------

describe('K-I17 闸门前置拒绝：blocked / not_running / unknown_subtask', () => {
  it('三条 rejected 均不发布，scheduler_decision 为 null，honored=false', () => {
    // blocked：能力已发现但未授权 ⇒ 计划期阻塞（不进波次）
    const blockedRuntime = runtimeOf([spec('x', 'order.submit')], 1, [WORD, UNAUTHORIZED]);
    const blocked = blockedRuntime.applyResult('x', 'succeeded');
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.state).toBe('blocked');

    // not_running / unknown_subtask
    const runtime = runtimeOf([spec('a', 'word.edit'), spec('b', 'sheet.edit')], 1);
    runtime.launchReady(); // 只启动 a，b 仍 pending
    const notRunning = runtime.applyResult('b', 'succeeded');
    expect(notRunning.verdict).toBe('not_running');
    const ghost = runtime.applyResult('ghost', 'succeeded');
    expect(ghost.verdict).toBe('unknown_subtask');

    for (const decision of [blocked, notRunning, ghost]) {
      const resolved = runtime.align(decision);
      expect(resolved.disposition).toBe('rejected');
      expect(resolved.scheduler_decision).toBeNull();
      expect(resolved.scheduler_late_reason).toBeNull();
      expect(resolved.honored_as_success).toBe(false);
      expect(resolved.observed_at).toBe('subtask_local');
    }
  });
});

// ---------------------------------------------------------------------------
// ⑦ 运行期入口等价：runtime.align(decision) == resolveResultDisposition(decision, snapshot)
// ---------------------------------------------------------------------------

describe('K-I17 运行期入口等价性', () => {
  it('align() 与纯函数 resolveResultDisposition(decision, snapshot()) 逐字段一致', () => {
    const runtime = runtimeOf([spec('a', 'word.edit'), spec('b', 'sheet.edit')], 2);
    runtime.launchReady();
    runtime.applyResult('a', 'succeeded');
    const duplicate = runtime.applyResult('a', 'succeeded');

    const viaMethod = runtime.align(duplicate);
    const viaPure = resolveResultDisposition(duplicate, runtime.snapshot());
    expect(viaMethod).toEqual(viaPure);
  });
});
