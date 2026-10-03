/**
 * **A02 验收场景**：多成员请求空闲实例（`design-01-P1`；附带 `P3` / `P6`）。
 *
 * 对应任务书 §19 A02、§9.2「A、B 同时唤醒空闲 C：原子更新状态，不能并发启动两个 C」，
 * 与 `docs/other/prep/D07-D09-prep-验收场景规格.md` 第 1 节的 A02 / A02-L。
 *
 * ## 断言纪律（合同 R15 / R17 / R19 / R22 / R7；违反即返工）
 *
 * 1. **计数类一律用等号**（R17）：`run_count === 1 && peak_active_runs === 1`，
 *    并且同时断言**事件流非空且含预期种类**（`run_started` 出现次数 === `run_count`），
 *    使"忘了喂事件"无法伪装成通过。
 * 2. **观测含事件侧 + 快照侧两组**（R19），证据里标明两组来源。
 * 3. **断言前先证明夹具确实产生了数据**（R22）：`Σstatus_distribution === 4`。
 * 4. 主判据用 `===>` 标出（区分「合并唤醒正确」与「丢了消息」的那几条）。
 */

import { describe, expect, it } from 'vitest';

import {
  Barrier,
  artifactRefFor,
  findItemsWithoutOutcome,
  findItemsWithoutTriggeringMessage,
  findUnmappedMessages,
  messageToRequestIds,
} from '../../../src/fake/index.js';
import {
  SENDERS,
  ScenarioHarness,
  allProduceResultScript,
  asMessageIds,
  assertAllDeliveriesAccepted,
  assertInboxExactly,
  publicationsFromScript,
  sumDistribution,
  writeEvidence,
} from './harness.js';

const REQ_MESSAGES = ['m-a02-01', 'm-a02-02', 'm-a02-03', 'm-a02-04'] as const;
const REQ_REQUESTS = ['r-a02-01', 'r-a02-02', 'r-a02-03', 'r-a02-04'] as const;
const LATE_MESSAGES = ['m-a02-l1', 'm-a02-l2', 'm-a02-l3'] as const;
const LATE_REQUESTS = ['r-a02-l1', 'r-a02-l2', 'r-a02-l3'] as const;

type DeliveryMode = 'sequential' | 'concurrent';

/** A02 的投递阶段：变体甲顺序、变体乙在同一屏障后同时起跑（B-deliver）。 */
async function deliverPhase(h: ScenarioHarness, mode: DeliveryMode): Promise<void> {
  const specs = SENDERS.map((sender, i) => ({
    message_id: REQ_MESSAGES[i] as string,
    request_id: REQ_REQUESTS[i] as string,
    sender,
    content: `独立工作 j${i + 1}，期望产物 p${i + 1}`,
  }));
  if (mode === 'sequential') {
    for (const spec of specs) h.deliver(spec, 'variant-A sequential');
    return;
  }
  const barrier = new Barrier(specs.length);
  await Promise.all(
    specs.map(async (spec) => {
      await barrier.arrive();
      h.deliver(spec, 'variant-B concurrent');
    }),
  );
}

/** 跑完整个 A02 场景（无断言，只执行明确事件序列；断言全在用例里）。 */
async function executeA02(mode: DeliveryMode) {
  const h = new ScenarioHarness();
  h.mark('t0-投递前');
  await deliverPhase(h, mode);
  h.mark('B-alldone-全部投递返回');

  // 归属前提：四条投递的提交**全部**早于任何一次冻结（R10 的 assertAllDeliveriesBefore）。
  h.seam.assertAllDeliveriesBefore(0);
  const queuedBeforeAdvance = h.observe().merged.peak_queued_flags;
  const queuedFlagBeforeAdvance = h.instance().queued_flag;

  h.mark('R1-放行点');
  const first = await h.advance('R1');
  const run1 = h.activeRun();
  if (run1 === null) throw new Error('放行点 R1 应启动唯一一个轮次');
  const queuedFlagDuringRun = h.instance().queued_flag;

  // 该轮的假 Agent 对 4 项请求各产生一个确定输出；轮内不设阻塞点，轮次自然结束。
  h.mark('R1-轮末');
  const finish = h.finishActiveRun(
    publicationsFromScript(allProduceResultScript(REQ_REQUESTS), run1.frozen_request_ids),
    'R1 轮末：4 项各产出结果',
  );

  // 放行点 R2…R6：证明不会因残留输入再起新轮次（空推进）。
  h.mark('R2..R6-空推进');
  const empties = await h.advanceTimes(5, 'R2..R6');

  return { h, first, run1, finish, empties, queuedBeforeAdvance, queuedFlagBeforeAdvance, queuedFlagDuringRun };
}

describe('A02 多成员请求空闲实例（design-01-P1）', () => {
  it('变体乙（并发投递）：全部投递在第一次冻结前到达 → 1 轮 / 4 项工作 / 不丢请求', async () => {
    const { h, first, run1, finish, empties, queuedBeforeAdvance, queuedFlagBeforeAdvance, queuedFlagDuringRun } =
      await executeA02('concurrent');

    // ── 前置：四条投递全部被接受，无一被"已有活动轮次/排队标记"丢弃（A02-09） ──
    const log = h.log.snapshot();
    assertAllDeliveriesAccepted(log);
    expect(log.total).toBe(4);
    expect(log.accepted).toBe(4);
    expect(log.failed).toBe(0);
    expect(h.delivery_steps.map((s) => s.result)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
    expect(h.delivery_steps.map((s) => s.advance_seq)).toEqual([0, 0, 0, 0]);

    // ── R26.1 勘误后的期望：**首次推进前**排队标记**已经**是 1（第 1 条就满足附录 B 的条件） ──
    // > 这是主判据之一：若实现把它错写成 0，P2-03/P2-06 的"入队事件 ≤1"就没有载体。
    expect(queuedBeforeAdvance).toBe(1);
    expect(queuedFlagBeforeAdvance).toBe(true);
    expect(h.countEvents('delegation_queue_enqueued')).toBe(1);

    // ── 放行点 R1：唯一一轮 ──
    expect(first.startedRuns).toBe(1);
    expect(first.seq).toBe(1);
    expect(queuedFlagDuringRun).toBe(false); // 抢占排队项
    expect(run1.run_id).toBe('run-1');

    // ── A02-07 归属：唯一一轮的冻结快照**包含全部 4 条**（证明"同轮处理"，不是"少跑了几个"） ──
    expect([...run1.frozen_input_message_ids].sort()).toEqual([...REQ_MESSAGES].sort());
    expect([...run1.frozen_request_ids].sort()).toEqual([...REQ_REQUESTS].sort());

    // ── 轮末：接受发布、且无残留输入 → 不产生第二次运行机会 ──
    expect(finish.accepted).toBe(true);
    expect(finish.rejected_publications).toEqual([]);
    expect([...finish.applied_request_ids].sort()).toEqual([...REQ_REQUESTS].sort());
    expect(finish.queued_next_run).toBe(false);

    // ── 放行点 R2…R6：全部是空推进（没有残留输入再起轮次） ──
    expect(empties.map((record) => record.startedRuns)).toEqual([0, 0, 0, 0, 0]);
    expect(empties.map((record) => record.seq)).toEqual([2, 3, 4, 5, 6]);

    // ── R19：两组来源，缺任一组即观测不完整 ──
    const obs = h.observe();
    expect(obs.event_source).toContain('summarizeKernelEvents');
    expect(obs.snapshot_source).toContain('summarizeSnapshotCounters');

    // ── R17 主判据：等号 + 事件流非空且含预期种类 ──
    expect(obs.merged.run_count).toBe(1); // ===> 主判据（计数）
    expect(obs.merged.peak_active_runs).toBe(1); // ===> 主判据（并发）
    expect(h.countEvents('run_started')).toBe(obs.merged.run_count);
    expect(h.countEvents('run_finished')).toBe(obs.merged.run_count);
    expect(h.kernelEvents().length).toBeGreaterThan(0);
    // 事件流非空**且含预期事件种类**（等号写死，使"忘了喂事件/事件种类没接上"无法伪装成通过）
    expect(h.countEvents('message_accepted')).toBe(4);
    expect(h.countEvents('inbox_message_consumed')).toBe(4);
    expect(h.countEvents('delegation_queue_enqueued')).toBe(1);
    expect(h.countEvents('delegation_queue_cleared')).toBe(1);
    expect(h.countEvents('run_started')).toBe(1); // 没有第二次「轮次开始」
    expect(h.runs().length).toBe(1); // A02-03：实际出现过的 run_id 恰好 1 个
    expect(h.runs()[0]?.status).toBe('finished');

    // ── R22：先证明夹具确实产生了工作项（六态分布求和 = 预期工作项总数） ──
    expect(sumDistribution(obs.snapshot.work_item_status_distribution)).toBe(4);

    // ── A02-04 守恒（===> **主判据：这条才区分「合并唤醒正确」与「丢了消息」**） ──
    assertInboxExactly(h.inboxEntries(), asMessageIds(REQ_MESSAGES));
    expect(h.uniqueInboxMessageIds().length).toBe(4);
    // ── A02-05 守恒 ──
    expect(h.workItems().map((item) => String(item.request_id)).sort()).toEqual([...REQ_REQUESTS].sort());

    // ── A02-06 一对一：无孤儿消息、无重复承载 ──
    expect(findUnmappedMessages(h.snapshot())).toEqual([]);
    expect(findItemsWithoutTriggeringMessage(h.workItems())).toEqual([]);
    const mapping = messageToRequestIds(h.snapshot());
    for (const id of asMessageIds(REQ_MESSAGES)) {
      expect(mapping.get(id)?.length).toBe(1);
    }

    // ── A02-08 每项都有明确结局（不得"既非终态又无等待原因"） ──
    expect(findItemsWithoutOutcome(h.workItems())).toEqual([]);
    expect(obs.snapshot.work_item_status_distribution.completed).toBe(4);

    // ── A02-12 反作弊：不是靠"一条都不处理"换来轮次数 1 ──
    for (const item of h.workItems()) {
      expect(item.result_refs).toEqual([artifactRefFor(item.request_id)]);
    }

    // ── A02-10 排队标记峰值（R26.1 勘误：**1**，不是 0） ──
    expect(obs.merged.peak_queued_flags).toBe(1);
    // 结束时：无活动轮次、排队标记归零
    expect(h.instance().active_run_id).toBeNull();
    expect(h.instance().queued_flag).toBe(false);

    writeEvidence('a02-concurrent.json', {
      scenario: 'A02',
      variant: 'concurrent (B-deliver barrier)',
      design_points: ['design-01-P1', 'design-01-P3', 'design-01-P6'],
      ...h.evidence(),
      first_advance: { seq: first.seq, started_runs: first.startedRuns },
      empty_advances: empties.map((record) => record.startedRuns),
      queued_flags_before_first_advance: queuedBeforeAdvance,
    });
  });

  it('变体甲（顺序投递）：断言与变体乙一致（A02-11）', async () => {
    const sequential = await executeA02('sequential');
    const concurrent = await executeA02('concurrent');

    const summarise = (result: Awaited<ReturnType<typeof executeA02>>) => {
      const obs = result.h.observe();
      return {
        inbox: result.h.uniqueInboxMessageIds().length,
        work_items: result.h.workItems().length,
        run_count: obs.merged.run_count,
        peak_active_runs: obs.merged.peak_active_runs,
        peak_queued_flags: obs.merged.peak_queued_flags,
        status_total: sumDistribution(obs.snapshot.work_item_status_distribution),
      };
    };

    const a = summarise(sequential);
    const b = summarise(concurrent);
    expect(a).toEqual({ inbox: 4, work_items: 4, run_count: 1, peak_active_runs: 1, peak_queued_flags: 1, status_total: 4 });
    expect(b).toEqual(a); // A02-11：两个变体结果完全一致

    // 顺序变体同样满足归属前提：四条投递全在第一次冻结之前
    sequential.h.seam.assertAllDeliveriesBefore(0);
    expect(sequential.h.seam.deliveriesBeforeAdvance().length).toBe(4);

    writeEvidence('a02-sequential-and-variant-agreement.json', {
      scenario: 'A02',
      variant: 'sequential vs concurrent agreement (A02-11)',
      sequential: { ...sequential.h.evidence(), summary: a },
      concurrent_summary: b,
      agreement: a,
    });
  });

  it('对照 A02-L：快照冻结之后到达的输入必须被保留，并允许合法的后续轮次', async () => {
    const h = new ScenarioHarness();
    h.mark('t0-投递前');
    await deliverPhase(h, 'sequential');
    h.mark('B-alldone-全部投递返回');

    // 首轮
    h.mark('R1-放行点');
    const first = await h.advance('R1');
    expect(first.startedRuns).toBe(1);
    const run1 = h.activeRun();
    if (run1 === null) throw new Error('R1 应启动首轮');

    // ── A02-L-01：首轮冻结快照**不包含**后到 3 条（否则本对照无效，属夹具失效） ──
    expect([...run1.frozen_input_message_ids].sort()).toEqual([...REQ_MESSAGES].sort());

    // 首轮**活动期间**顺序投递 3 条（逐条确认 accepted）
    h.mark('R1-活动期间投递后到 3 条');
    const lateSenders = ['S1', 'S2', 'S3'] as const;
    const enqueuedBeforeLate = h.countEvents('delegation_queue_enqueued');
    const late = LATE_MESSAGES.map((message_id, i) =>
      h.deliver(
        {
          message_id,
          request_id: LATE_REQUESTS[i] as string,
          sender: lateSenders[i] as string,
          content: `独立工作 j${i + 5}，期望产物 p${i + 5}`,
        },
        'late during run-1',
      ),
    );
    // ── A02-L-03：首轮进行期间「入队」事件数（三条后到只产生至多一次后续机会，此刻为 0） ──
    const enqueuedDuringFirstRun = h.countEvents('delegation_queue_enqueued') - enqueuedBeforeLate;
    expect(late.map((receipt) => receipt.result)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(enqueuedDuringFirstRun).toBe(0);
    // 归属（R20 口径）：这三条提交发生在**第 1 次冻结之后**（advanceSeq >= 1）
    expect(h.seam.deliveriesArrivingAfter(1).map((note) => String(note.message_id)).sort()).toEqual([
      ...LATE_MESSAGES,
    ].sort());
    expect(h.seam.deliveriesBeforeAdvance().map((note) => String(note.message_id)).sort()).toEqual([
      ...REQ_MESSAGES,
    ].sort());
    // 活动轮次占着运行机会 → 排队标记此刻仍为 false
    expect(h.instance().queued_flag).toBe(false);

    // 放行首轮：结束后因"仍有可运行输入"入队**至多一次**
    h.mark('R1-轮末');
    const finish1 = h.finishActiveRun(
      publicationsFromScript(allProduceResultScript(REQ_REQUESTS), run1.frozen_request_ids),
      'R1 轮末',
    );
    expect(finish1.queued_next_run).toBe(true);
    expect(h.countEvents('delegation_queue_enqueued') - enqueuedBeforeLate).toBe(1); // 三条只换一次机会

    // 放行点 R2：合法的后续轮次
    h.mark('R2-放行点');
    const second = await h.advance('R2');
    expect(second.startedRuns).toBe(1);
    const run2 = h.activeRun();
    if (run2 === null) throw new Error('R2 应启动后续轮次');
    // ── A02-L-05 归属：后到 3 条在**后续轮次**的快照里被读入 ──
    expect([...run2.frozen_input_message_ids].sort()).toEqual([...LATE_MESSAGES].sort());

    h.mark('R2-轮末');
    h.finishActiveRun(
      publicationsFromScript(allProduceResultScript(LATE_REQUESTS), run2.frozen_request_ids),
      'R2 轮末',
    );
    h.mark('R3..R6-空推进');
    const empties = await h.advanceTimes(4, 'R3..R6');
    expect(empties.map((record) => record.startedRuns)).toEqual([0, 0, 0, 0]);

    // ── 断言 ──
    const obs = h.observe();
    expect(h.countEvents('run_started')).toBe(obs.merged.run_count);
    expect(h.countEvents('run_finished')).toBe(obs.merged.run_count);
    expect(obs.merged.run_count).toBe(2); // ===> 主判据：不得为 1（吞掉后到消息换来的"轮次=1"不合格）
    expect(obs.merged.peak_active_runs).toBe(1);
    expect(obs.merged.peak_queued_flags).toBe(1);

    // A02-L-02：收件箱 7 条，后到 3 条一条不少
    expect(sumDistribution(obs.snapshot.work_item_status_distribution)).toBe(7);
    assertInboxExactly(h.inboxEntries(), asMessageIds([...REQ_MESSAGES, ...LATE_MESSAGES]));
    // A02-L-06：7 项各有结局
    expect(findItemsWithoutOutcome(h.workItems())).toEqual([]);
    expect(obs.snapshot.work_item_status_distribution.completed).toBe(7);
    expect(h.workItems().map((item) => String(item.request_id)).sort()).toEqual(
      [...REQ_REQUESTS, ...LATE_REQUESTS].sort(),
    );
    expect(h.instance().active_run_id).toBeNull();
    expect(h.instance().queued_flag).toBe(false);

    writeEvidence('a02-l-late-arrival.json', {
      scenario: 'A02-L',
      design_points: ['design-01-P1', 'design-01-P3', 'design-01-P6'],
      first_run_frozen: run1.frozen_input_message_ids.map(String),
      second_run_frozen: run2.frozen_input_message_ids.map(String),
      enqueued_during_first_run: enqueuedDuringFirstRun,
      enqueued_total_after_finish_minus_before: 1,
      ...h.evidence(),
    });
  });
});
