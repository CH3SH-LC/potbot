/**
 * **A03 验收场景**：运行中连续唤醒（合并唤醒；`design-01-P3`；附带 `P1`）。
 *
 * 对应任务书 §19 A03、§9.2「新消息在当前轮次快照冻结后到达：保留消息，当前轮结束后
 * 只增加一次排队机会」、§9.1「合并的是运行机会，不是请求与结果」，
 * 与 `docs/other/prep/D07-D09-prep-验收场景规格.md` 第 2 节。
 *
 * ## 时序（全部是屏障 / 可控时钟 / 明确事件序列，**无真实 sleep**）
 *
 * 1. 投递触发消息 `m-a03-00` → 显式推进一次 → 首轮启动、快照冻结；
 * 2. 假 Agent 在轮内阻塞点 `P-block-1` 停住（**带 run_id 的确定性等待**，不用 sleep 猜）；
 * 3. 轮次**活动期间**顺序投递 `m-a03-01…03`，确认全部 `accepted` 后才放行 `P-block-1`；
 * 4. 放行首轮 → 显式推进 → run-2 在 `P-block-2` 停住 → 确认 run-2 快照含全部 3 条 → 放行；
 * 5. 再空推进若干次，确认无新轮次、排队标记归零。
 */

import { describe, expect, it } from 'vitest';

import {
  BlockPointSet,
  findItemsWithoutOutcome,
  findUnmappedMessages,
  type BlockPoint,
  type FakeAgentScript,
} from '../../../src/fake/index.js';
import type { RunRecord } from '../../../src/protocol/index.js';
import {
  ScenarioHarness,
  allProduceResultScript,
  asMessageIds,
  assertCompletedHaveMatchingResults,
  assertInboxExactly,
  assertNoEnqueueWhileActive,
  publicationsFromScript,
  sumDistribution,
  writeEvidence,
} from './harness.js';

const TRIGGER_MESSAGE = 'm-a03-00';
const LATE_MESSAGES = ['m-a03-01', 'm-a03-02', 'm-a03-03'] as const;
const REQUEST_IDS = ['r-a03-00', 'r-a03-01', 'r-a03-02', 'r-a03-03'] as const;
const LATE_REQUEST_IDS = ['r-a03-01', 'r-a03-02', 'r-a03-03'] as const;

/** 执行一个轮次：显式推进 → 在阻塞点停住（轮次保持活动）→ 由夹具放行后收尾。 */
async function executeRound(
  h: ScenarioHarness,
  point: BlockPoint,
  script: FakeAgentScript,
  label: string,
): Promise<RunRecord> {
  const record = await h.advance(label);
  expect(record.startedRuns).toBe(1);
  const run = h.activeRun();
  if (run === null) throw new Error(`${label} 放行后应有活动轮次`);
  // 假 Agent 停在本轮阻塞点；轮次保持活动，直到夹具显式放行（P-block-1 / P-block-2）。
  await point.wait({ run_id: run.run_id, instance_id: h.instance_id, at: h.clock.now(), label });
  h.finishActiveRun(publicationsFromScript(script, run.frozen_request_ids), `${label} 轮末`);
  return run;
}

describe('A03 运行中连续唤醒 / 合并唤醒（design-01-P3）', () => {
  it('轮次活动期间送入 3 条 → 合并为至多一次后续机会，每项工作仍有结局', async () => {
    const h = new ScenarioHarness();
    const points = new BlockPointSet();
    const block1 = points.point('P-block-1');
    const block2 = points.point('P-block-2');

    // ── 前置：收件箱先放一条触发消息（否则实例无有效工作，按 §9.4 不应运行） ──
    h.mark('t0-投递触发消息');
    const trigger = h.deliver(
      { message_id: TRIGGER_MESSAGE, request_id: 'r-a03-00', sender: 'S0', content: '独立工作 j0，期望产物 p0' },
      'trigger',
    );
    expect(trigger.result).toBe('accepted');

    // ── 首轮启动并冻结快照 ──
    h.mark('R1-放行点');
    const round1 = executeRound(h, block1, allProduceResultScript(['r-a03-00']), 'R1');
    const arrival1 = await block1.arrived();
    expect(arrival1.run_id).toBe('run-1');

    const run1 = h.activeRun();
    if (run1 === null) throw new Error('首轮应处于活动状态');
    expect(run1.run_id).toBe('run-1');
    // 「快照已冻结、轮次仍活动」的确定状态
    expect(h.instance().activity).toBe('active');
    expect(h.instance().active_run_id).toBe('run-1');
    expect(h.instance().queued_flag).toBe(false);

    // ── A03-04 归属：首轮冻结快照**恰好只含** m-a03-00（证明后到 3 条确实在冻结之后到达） ──
    expect([...run1.frozen_input_message_ids]).toEqual([TRIGGER_MESSAGE]);

    // ── 轮次活动期间顺序投递 3 条（逐条确认 accepted 后才继续） ──
    h.mark('轮内阻塞点 P-block-1-投递 3 条');
    const lateSenders = ['S1', 'S2', 'S3'] as const;
    const enqueuedBaseline = h.countEvents('delegation_queue_enqueued');
    const late = LATE_MESSAGES.map((message_id, i) =>
      h.deliver(
        {
          message_id,
          request_id: LATE_REQUEST_IDS[i] as string,
          sender: lateSenders[i] as string,
          content: `独立工作 j${i + 1}，期望产物 p${i + 1}`,
        },
        'late during run-1',
      ),
    );
    const enqueuedDuringRun = h.countEvents('delegation_queue_enqueued') - enqueuedBaseline;

    // ── A03-03 主判据：首轮活动期间入队事件数**恰好 0**（三条合并且此刻运行机会已被占用） ──
    expect(late.map((receipt) => receipt.result)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(enqueuedDuringRun).toBe(0);
    assertNoEnqueueWhileActive(enqueuedDuringRun);
    // 归属（R20 口径）：三条的提交都发生在第 1 次冻结**之后**（advanceSeq >= 1，不是"伪装成冻结前"）
    expect(h.seam.deliveriesArrivingAfter(1).map((note) => String(note.message_id)).sort()).toEqual([
      ...LATE_MESSAGES,
    ].sort());
    expect(h.seam.deliveriesBeforeAdvance().map((note) => String(note.message_id))).toEqual([TRIGGER_MESSAGE]);

    // ── 放行 P-block-1 → 首轮执行完毕并结束 ──
    h.mark('P-block-1-放行');
    block1.release();
    await round1;
    expect(block1.arrivalCount).toBe(1);
    expect(block1.runIds()).toEqual(['run-1']);
    // 三条后到输入只换来**一次**后续运行机会（合并的是运行机会，不是请求）
    expect(h.finishes[0]?.queued_next_run).toBe(true);
    expect(h.countEvents('delegation_queue_enqueued') - enqueuedBaseline).toBe(1);

    // ── 放行点 R2：至多一轮的后续轮次 ──
    h.mark('R2-放行点');
    const round2 = executeRound(h, block2, allProduceResultScript(LATE_REQUEST_IDS), 'R2');
    const arrival2 = await block2.arrived();
    expect(arrival2.run_id).toBe('run-2');
    const run2 = h.activeRun();
    if (run2 === null) throw new Error('后续轮次应处于活动状态');
    // ── A03-07 归属：run-2 的冻结快照**包含全部 3 个后到 message_id** ──
    expect([...run2.frozen_input_message_ids].sort()).toEqual([...LATE_MESSAGES].sort());
    h.mark('P-block-2-放行');
    block2.release();
    await round2;
    expect(block2.runIds()).toEqual(['run-2']);

    // ── 再空推进若干次：无新轮次、实例回到空闲、排队标记归零（A03-11） ──
    h.mark('R3..R6-空推进');
    const empties = await h.advanceTimes(4, 'R3..R6');
    expect(empties.map((record) => record.startedRuns)).toEqual([0, 0, 0, 0]);

    // ── R19：事件侧 + 快照侧两组来源 ──
    const obs = h.observe();
    expect(obs.event_source).toContain('summarizeKernelEvents');
    expect(obs.snapshot_source).toContain('summarizeSnapshotCounters');

    // ── R17 主判据：等号 + 事件流非空且含预期种类 ──
    expect(obs.merged.run_count).toBe(2); // ===> 主判据
    expect(obs.merged.peak_active_runs).toBe(1); // ===> 主判据（本轮期间不得出现第二个并发轮次）
    expect(obs.merged.peak_queued_flags).toBe(1); // ===> 主判据（必须**真的出现过 1**，不是"从没超过 1"）
    expect(h.countEvents('run_started')).toBe(obs.merged.run_count);
    expect(h.countEvents('run_finished')).toBe(obs.merged.run_count);
    expect(h.kernelEvents().length).toBeGreaterThan(0);
    // 事件流非空**且含预期事件种类**（等号写死，使"忘了喂事件/事件种类没接上"无法伪装成通过）
    expect(h.countEvents('message_accepted')).toBe(4);
    expect(h.countEvents('inbox_message_consumed')).toBe(4);
    expect(h.countEvents('delegation_queue_cleared')).toBe(2);
    expect(h.runs().length).toBe(2);
    // 入队事件总数 = 触发投递 1 次 + 轮末合并 1 次（三条后到只合并出一次）
    expect(h.countEvents('delegation_queue_enqueued')).toBe(2);

    // ── R22：先证明夹具确实产生了工作项 ──
    expect(sumDistribution(obs.snapshot.work_item_status_distribution)).toBe(4);

    // ── A03-05 守恒（===> 主判据：区分「合并正确」与「丢消息」） ──
    assertInboxExactly(h.inboxEntries(), asMessageIds([TRIGGER_MESSAGE, ...LATE_MESSAGES]));
    expect(findUnmappedMessages(h.snapshot())).toEqual([]);
    // ── A03-06 / A03-09：4 项工作，三条后到**没有被合并成 1 项** ──
    expect(h.workItems().map((item) => String(item.request_id)).sort()).toEqual([...REQUEST_IDS].sort());
    expect(h.workItems().length).toBe(4);
    // ── A03-08 每项后到工作各有明确结局 ──
    expect(findItemsWithoutOutcome(h.workItems())).toEqual([]);
    expect(obs.snapshot.work_item_status_distribution.completed).toBe(4);
    // ── A03-10 反作弊：「读取完成」未被当作「工作完成」 ──
    assertCompletedHaveMatchingResults(h.workItems());

    // ── A03-11 收尾状态 ──
    expect(h.instance().active_run_id).toBeNull();
    expect(h.instance().queued_flag).toBe(false);

    writeEvidence('a03-merged-wakeup.json', {
      scenario: 'A03',
      design_points: ['design-01-P3', 'design-01-P1'],
      pre_registered_budget: { max_runs: 2, watchdog: 'scenario must converge within the 4 explicit empty advances' },
      first_run_frozen: run1.frozen_input_message_ids.map(String),
      second_run_frozen: run2.frozen_input_message_ids.map(String),
      enqueued_during_first_run: enqueuedDuringRun,
      block_points: points.snapshot(),
      empty_advances: empties.map((record) => record.startedRuns),
      ...h.evidence(),
    });
  });
});
