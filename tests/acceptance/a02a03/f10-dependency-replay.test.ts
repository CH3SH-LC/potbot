/**
 * **F10 行为回归**：对已经消费的依赖解除通知保持幂等（合同 v1.2 R37.3；`design-01-P3 / P5`）。
 *
 * ## 修的是哪一条
 *
 * 修复前 `wakeOnDependencyResolvedInTransaction` 只查**尚未消费**的标记，却无条件重写同 `ref_id`；
 * `markDependencyResolutionInput` 又无条件覆盖（把 `consumed_in_run_id` 重置为 `null`）。
 * 于是同一解除通知在每轮结束后重放都会被当成新输入：实测 3 轮 / 3 个解除事件，
 * 而实际只有一个标记被反复覆盖。
 *
 * 修复后：按**完整输入身份**（`resolutionInputRefId({task_id, task_revision, request_id,
 * resolved_dependency_ids})`，见 `src/dependency/resolution.ts`）判重，**含已消费状态**：
 * - 从未登记 ⇒ 真正的新输入：登记标记 + 写 `dependency_resolved` + 置运行机会；
 * - 已登记未消费 ⇒ 同一输入待处理：不重复写事实事件；
 * - **已登记且已消费 ⇒ 旧通知重试**：不写事件、不重新置运行机会、**不复位消费状态**。
 *
 * ## 本文件只经公开入口
 *
 * 消息入口（`scheduler.onMessage`）+ 依赖解除端口（`scheduler.wakeOnDependencyResolved`）
 * + 推进接缝 + `finishActiveRun`。夹具不代做任何内核步骤，重放**使用同一身份**。
 */

import { describe, expect, it } from 'vitest';

import { resolutionInputRefId } from '../../../src/dependency/index.js';
import { messageId, requestId } from '../../../src/fake/index.js';
import {
  ScenarioHarness,
  allProduceResultScript,
  publicationsFromScript,
} from './harness.js';

const M_WORK = 'm-f10-work';
const R_WORK = 'r-f10-work';

/** 解除通知的**完整身份**（D05 的唯一编码处；重放必须逐字复用）。 */
function resolutionRef(h: ScenarioHarness, target: string): string {
  return resolutionInputRefId({
    task_id: h.task_id,
    task_revision: h.revision,
    request_id: requestId('r-f10-waiter'),
    resolved_dependency_ids: [target],
  });
}

/** `dependency_resolved` 待投递事件的历史条数（含已投递——快照保留全量）。 */
function resolvedEventCount(h: ScenarioHarness): number {
  return h.snapshot().delivery_events.filter((event) => event.kind === 'dependency_resolved').length;
}

describe('F10 已消费的依赖解除通知重放幂等（design-01-P3 / R37.3）', () => {
  it('同一解除通知在"消费前 / 运行中 / 结束后"重放：不产生额外轮次、不重置消费状态；新解除输入仍能启动', async () => {
    const h = new ScenarioHarness();
    const ref = resolutionRef(h, 'req:dep-a');

    // ── 阶段一「消费前」：实例空闲，登记解除通知 ──
    const w1 = h.scheduler.wakeOnDependencyResolved({
      task_id: h.task_id,
      instance_id: h.instance_id,
      ref_id: ref,
      task_revision: h.revision,
      reason: '依赖 req:dep-a 已解除',
    });
    expect(w1.marked_actionable_input?.ref_id).toBe(ref);
    expect(w1.queued).toBe(true); // 空闲实例：置一次运行机会
    expect(resolvedEventCount(h)).toBe(1);
    expect(h.snapshot().actionable_inputs.length).toBe(1);

    // 消费前重放：不重复写事实事件、不重复登记。
    const w1b = h.scheduler.wakeOnDependencyResolved({
      task_id: h.task_id,
      instance_id: h.instance_id,
      ref_id: ref,
      task_revision: h.revision,
    });
    expect(resolvedEventCount(h)).toBe(1);
    expect(h.snapshot().actionable_inputs.length).toBe(1);
    expect(w1b.queued).toBe(false); // 已有排队标记 → 合并

    // 推进：首轮启动并**消费**该解除输入。
    const step1 = await h.advance('R1-消费解除输入');
    expect(step1.startedRuns).toBe(1);
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动首轮（解除输入是可运行输入）');
    expect([...run1.frozen_actionable_input_refs]).toEqual([ref]);
    expect(run1.frozen_request_ids.length).toBe(0);
    h.finishActiveRun([], 'R1 轮末：无发布');
    const consumedRunId = h.snapshot().actionable_inputs.find((mark) => mark.ref_id === ref)?.consumed_in_run_id;
    expect(consumedRunId).toBe(run1.run_id);

    // ── 阶段二「结束后」：已消费，重放不得复活 ──
    const w2 = h.scheduler.wakeOnDependencyResolved({
      task_id: h.task_id,
      instance_id: h.instance_id,
      ref_id: ref,
      task_revision: h.revision,
    });
    expect(w2.queued).toBe(false);
    expect(w2.merged).toBe(true);
    expect(resolvedEventCount(h)).toBe(1);
    expect(h.snapshot().actionable_inputs.find((mark) => mark.ref_id === ref)?.consumed_in_run_id).toBe(
      run1.run_id,
    );

    // 重放之后多次推进：不得产生额外业务轮次。
    const afterReplay = await h.advanceTimes(3, 'R2..R4-重放后空推进');
    expect(afterReplay.map((record) => record.startedRuns)).toEqual([0, 0, 0]);
    expect(h.runs().length).toBe(1);

    // ── 阶段三「运行中」：另起一轮，轮内重放同一身份 ──
    const work = h.buildDelivery({
      message_id: M_WORK,
      request_id: R_WORK,
      sender: 'S1',
      content: '独立工作：运行中重放解除通知的对照',
    });
    expect(h.scheduler.onMessage(work.message).result).toBe('accepted');
    const step2 = await h.advance('R5-合法工作请求');
    expect(step2.startedRuns).toBe(1);
    const run2 = h.activeRun();
    if (run2 === null) throw new Error('R5 应启动第二轮');

    const w3 = h.scheduler.wakeOnDependencyResolved({
      task_id: h.task_id,
      instance_id: h.instance_id,
      ref_id: ref,
      task_revision: h.revision,
    });
    expect(w3.queued).toBe(false); // 运行中：合并，不额外排队
    expect(resolvedEventCount(h)).toBe(1);
    expect(h.snapshot().actionable_inputs.find((mark) => mark.ref_id === ref)?.consumed_in_run_id).toBe(
      run1.run_id,
    );

    const finish2 = h.finishActiveRun(
      publicationsFromScript(allProduceResultScript([R_WORK]), run2.frozen_request_ids),
      'R5 轮末：产出结果',
    );
    expect(finish2.accepted).toBe(true);
    expect(finish2.queued_next_run).toBe(false); // 运行中的重放没有换来下一次运行机会

    const afterRun2 = await h.advanceTimes(2, 'R6..R7-空推进');
    expect(afterRun2.map((record) => record.startedRuns)).toEqual([0, 0]);
    expect(h.runs().length).toBe(2); // 累计恰好 2 轮，重放未增加

    // ── 阶段四：**真正的新**解除输入（解除对象不同）仍能启动 ──
    const ref2 = resolutionRef(h, 'req:dep-b');
    expect(ref2).not.toBe(ref);
    const w4 = h.scheduler.wakeOnDependencyResolved({
      task_id: h.task_id,
      instance_id: h.instance_id,
      ref_id: ref2,
      task_revision: h.revision,
      reason: '依赖 req:dep-b 已解除（新的解除对象）',
    });
    expect(w4.queued).toBe(true);
    expect(resolvedEventCount(h)).toBe(2);

    const step3 = await h.advance('R8-新的解除输入');
    expect(step3.startedRuns).toBe(1);
    expect(h.runs().length).toBe(3);
    const run3 = h.activeRun();
    if (run3 === null) throw new Error('R8 应由新的解除输入启动');
    expect([...run3.frozen_actionable_input_refs]).toEqual([ref2]);

    // 消息侧的守恒未受影响（只有那一条工作请求建了工作项）。
    expect(h.workItems().map((item) => String(item.request_id))).toEqual([R_WORK]);
    expect(h.inboxEntries().map((entry) => String(entry.message_id))).toContain(messageId(M_WORK));
  });
});
