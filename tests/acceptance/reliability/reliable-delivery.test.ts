/**
 * D08 验收场景 **P2 — 可靠交付**（`design-01-P2` 的「可靠保存 + 事务边界」一半）。
 *
 * 规格：`docs/other/prep/D07-D09-prep-验收场景规格.md` §6。
 * 三个注入点（规格 6.2）：
 * - **W1** `scheduling.event.persist`（`afterCommitBeforePublish`）：消息与排队标记已提交，调度事件未发布；
 * - **W2** `message.persist`（`beforeCommit`）：持久化自身失败并回滚 → **不得报告已接受**；
 * - **W3** `execution.enqueue`（`beforePublishEvent`）：事务已提交、事件已入 outbox，逐条投递失败。
 *
 * 纪律：
 * - **R20.3**：D01 的 `transact()` 不自动发布；夹具走 `Scheduler.onMessage()`（提交后显式
 *   `publishPendingEvents()`），并在 W3 里以「待投递事件恰好 1 条 + 执行队列为空」**证明故障窗口真被触发**；
 * - **R17** 计数用等号；**R22** 先证明夹具产生了数据；**R19** 事件侧 + 快照侧两组来源分别留证；
 * - **R7** 注入 I-P2-1「落盘不记事件」，证明 P2-03 / P2-06 真会失败（并如实报告 P2-02 不可被它击穿）。
 *
 * 范围边界（规格 6.1）：只覆盖「保存成功 → 入队」之间的窗口；恢复 = 重建调度器 + 重读存储，
 * **不杀进程**，不覆盖 A10 完整应用重启。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asRequestId, statusDistribution, type PendingEvent } from '../../../src/protocol/index.js';
import {
  FREEZE_1_SOURCE_TREE_SHA256,
  INJECTION_POINTS,
  P2Harness,
  runIdOf,
  type P2DeliverResult,
  type CounterTriple,
  type RecoveryRun,
} from './harness.js';
import {
  writeEvidenceArtifacts,
  type EvidenceArtifact,
  type EvidenceIdentityStamp,
} from '../freeze-identity.js';

const MAX_STEPS = 8;

interface ScenarioRecord {
  readonly name: string;
  readonly deliver: P2DeliverResult;
  readonly fired: readonly { readonly index: number; readonly point: string; readonly behavior: string }[];
  readonly pending_after_interrupt: number;
  readonly exec_queue_after_interrupt: number;
  readonly inbox_after_interrupt: number;
  readonly work_items_after_interrupt: number;
  readonly recoveries: readonly RecoveryRun[];
  readonly counters_event: CounterTriple['event'];
  readonly counters_snapshot: CounterTriple['snapshot'];
  readonly work_item_status: readonly string[];
  readonly published_in_order: readonly string[];
  readonly late_publications: readonly { readonly run_id: string; readonly accepted: boolean; readonly rejection_reason: string | null }[];
  readonly runs: readonly { readonly run_id: string; readonly frozen_request_ids: readonly string[] }[];
  readonly defect: string;
}

const scenarios: ScenarioRecord[] = [];
const stages: string[] = [];
/** 需要落到 JSONL 原始事件序列的场景（规格 0.7：原始事件序列 + 汇总记录）。 */
const eventSources: { readonly name: string; readonly harness: P2Harness }[] = [];

function publishedKinds(events: readonly PendingEvent[]): readonly string[] {
  return events.map((event) => `${event.kind}:${String(event.payload['message_id'] ?? '-')}`);
}

// ---------------------------------------------------------------------------
// W1：提交后、发布前中断
// ---------------------------------------------------------------------------

async function runW1(): Promise<ScenarioRecord> {
  const name = 'W1-提交后发布前中断';
  const h = new P2Harness('P2-W1');
  h.bindAdvance();
  eventSources.push({ name, harness: h });

  h.armInterrupt(
    INJECTION_POINTS.schedulingEventPersist,
    ['message.persisted', 'work_item.created', 'queue.flag.set'],
    ['scheduling.event.persisted', 'execution.queue.delivery'],
    'W1：消息与排队标记已提交，调度事件尚未发布',
  );

  const delivery = h.deliverCatching(
    h.makeRequest({ message_id: 'm-p2-01', request_id: 'r-p2-01', content: '独立工作 j1', at: h.clock.time }),
  );

  // ---- 注入确实命中（否则本场景是空操作）----
  const fired = h.firedInjections();
  expect(h.defect, 'W1 未启用受控缺陷开关（故障注入≠缺陷注入）').toBe('none');
  expect(fired.length, 'W1：注入命中恰好 1 次').toBe(1);
  expect(fired[0]?.point, 'W1：注入点 = scheduling.event.persist（提交后、发布前）').toBe('scheduling.event.persist');

  // ---- 中断语义：已接受但事件未投递 ----
  expect(delivery.thrown === null, 'W1：入口**抛错**（不是静默返回）').toBe(false);
  expect(delivery.accepted_but_unpublished, 'W1：抛的是 PublicationError（accepted === true）').toBe(true);
  expect(delivery.outcome, 'W1：没有三值返回（已接受但未投递靠异常表达）').toBe(null);

  // ---- ★故障窗口真的被触发★（R20.3：显式发布入口被走到）----
  expect(h.pendingDeliveryEvents().length, '★W1★：待投递调度事件恰好 1 条（消息已落盘、事件还在 outbox）').toBe(1);
  expect(h.execQueue.length, '★W1★：执行队列为空（尚未投递）').toBe(0);
  expect(h.inboxEntryCount('m-p2-01'), 'W1：收件箱中 m-p2-01 恰好 1 条（消息已可靠保存）').toBe(1);
  expect(h.workItemCount('r-p2-01'), 'W1：r-p2-01 的工作项恰好 1 项').toBe(1);
  expect(h.kernelEventCount('delegation_queue_enqueued'), 'W1：入队事件（观测侧）恰好 1 条').toBe(1);

  const afterInterrupt = {
    pending: h.pendingDeliveryEvents().length,
    exec: h.execQueue.length,
    inbox: h.inboxEntryCount('m-p2-01'),
    work: h.workItemCount('r-p2-01'),
  };

  // ---- 模拟恢复：重建调度器 + 重读存储 + 连续两次恢复 ----
  h.rebuildScheduler();
  const recoveries = h.recover(2, 'replayUndelivered');

  expect(recoveries.length, 'W1：恢复执行了 2 次（重复恢复是规格 6.3 的必测项）').toBe(2);
  expect(recoveries[0]?.pending_before, 'W1：第一次恢复前待办 = 1').toBe(1);
  expect(recoveries[0]?.published, 'W1：第一次恢复补投恰好 1 条').toBe(1);
  expect(recoveries[0]?.pending_after, 'W1：第一次恢复后待办 = 0').toBe(0);
  expect(recoveries[0]?.failed, 'W1：第一次恢复未被注入打断').toBe(false);
  expect(recoveries[1]?.pending_before, 'W1：第二次恢复前待办 = 0（无待办，幂等）').toBe(0);
  expect(recoveries[1]?.published, 'W1：第二次恢复补投 0 条').toBe(0);
  expect(recoveries[1]?.pending_after, 'W1：第二次恢复后待办 = 0').toBe(0);

  // ---- P2-01 / P2-03 / P2-04：守恒 + 补投仅一次 ----
  expect(h.inboxEntryCount('m-p2-01'), 'P2-01：恢复后收件箱中 m-p2-01 恰好 1 条').toBe(1);
  expect(h.workItemCount('r-p2-01'), 'P2-04：连续两次恢复后工作项仍为 1 项（不多建业务工作）').toBe(1);
  expect(
    h.publishedFor('m-p2-01').length,
    'P2-03（★关键★）：针对 m-p2-01 的入队事件被补投且**仅一次**',
  ).toBe(1);
  expect(h.execQueue.length, 'W1：执行队列恰好多出 1 条补投事件').toBe(1);

  // ---- 恢复后正常调度并产出结局 ----
  const step = await h.advanceOnce('W1-R1');
  expect(step.startedRuns, 'W1：恢复后的推进启动恰好 1 个轮次').toBe(1);
  if (step.run === null) throw new Error('W1：R1 未启动轮次（消息在收件箱却永不执行）');
  h.finishCompleted(step.run.run_id, asRequestId('r-p2-01'));
  await h.advanceUntilIdle(MAX_STEPS, 'W1-R2');

  const snap = h.snapshot();
  const item = snap.work_items.find((w) => w.request_id === asRequestId('r-p2-01'));
  expect(item?.status, 'P2-02：恢复后 r-p2-01 被调度并处理，结局明确（completed）').toBe('completed');
  expect(h.runsReading('r-p2-01').length, 'P2-02：r-p2-01 只被一个轮次处理').toBe(1);

  // ---- P2-12：迟到的发布尝试必须被拒（所有权 / 轮次身份）----
  const late1 = h.attemptFinish(step.run.run_id, asRequestId('r-p2-01'));
  const late2 = h.attemptFinish(runIdOf('ghost-run'), asRequestId('r-p2-01'));
  expect(late1.accepted, 'P2-12（反作弊）：轮次结束后再发布同一 run_id 的结果 → 被拒').toBe(false);
  expect(late1.rejection_reason, 'P2-12：拒因 = run_not_active').toBe('run_not_active');
  expect(late2.accepted, 'P2-12（反作弊）：未知 run_id 的发布 → 被拒').toBe(false);
  expect(late2.rejection_reason, 'P2-12：拒因 = unknown_run').toBe('unknown_run');

  const counters = h.counters();
  expect(counters.event.run_count, 'R19（事件侧）：run_count === 1').toBe(1);
  expect(counters.event.peak_active_runs, 'P2-05：峰值活动轮次 === 1（恢复不产生并发重复轮次）').toBe(1);
  expect(counters.event.rejected_publication_count, 'R19（事件侧）：被拒绝的发布次数 === 2（P2-12 两次）').toBe(2);
  expect(
    counters.snapshot.work_item_status_distribution.completed,
    'R19（快照侧）：completed === 1',
  ).toBe(1);

  // ---- P2-11：不存在「收件箱有记录但工作项无结局」----
  const distribution = statusDistribution(snap.work_items);
  expect(
    Object.values(distribution).reduce((sum, n) => sum + n, 0),
    'R22：Σ分布 === 快照里的工作项总数',
  ).toBe(snap.work_items.length);
  for (const entry of snap.inbox_entries) {
    expect(
      snap.work_items.some((w) => w.triggering_message_ids.includes(entry.message_id)),
      `P2-11：收件箱消息 ${entry.message_id} 有对应工作项（不出现「有记录但无结局」）`,
    ).toBe(true);
  }

  return {
    name,
    deliver: delivery,
    fired,
    pending_after_interrupt: afterInterrupt.pending,
    exec_queue_after_interrupt: afterInterrupt.exec,
    inbox_after_interrupt: afterInterrupt.inbox,
    work_items_after_interrupt: afterInterrupt.work,
    recoveries,
    counters_event: counters.event,
    counters_snapshot: counters.snapshot,
    work_item_status: snap.work_items.map((w) => `${w.request_id}:${w.status}`),
    published_in_order: publishedKinds(h.execQueue),
    late_publications: [
      { run_id: String(step.run.run_id), ...late1 },
      { run_id: 'ghost-run', ...late2 },
    ],
    runs: snap.runs.map((r) => ({ run_id: String(r.run_id), frozen_request_ids: r.frozen_request_ids.map(String) })),
    defect: h.defect,
  };
}

// ---------------------------------------------------------------------------
// W2：持久化本身失败 → 不得报告已接受
// ---------------------------------------------------------------------------

async function runW2(): Promise<ScenarioRecord> {
  const name = 'W2-持久化失败';
  const h = new P2Harness('P2-W2');
  h.bindAdvance();
  eventSources.push({ name, harness: h });

  h.armFail(INJECTION_POINTS.messagePersist, 'W2：消息持久化本身失败并回滚');
  const delivery = h.deliverCatching(
    h.makeRequest({ message_id: 'm-p2-04', request_id: 'r-p2-04', content: '独立工作 j4', at: h.clock.time }),
  );

  const fired = h.firedInjections();
  expect(fired.length, 'W2：注入命中恰好 1 次').toBe(1);
  expect(fired[0]?.point, 'W2：注入点 = message.persist（提交前）').toBe('message.persist');

  // ---- P2-08：持久化失败时不得报告「已接受」----
  expect(delivery.thrown, 'W2：入口不抛异常，而是返回三值 failed').toBe(null);
  expect(delivery.outcome?.result, 'P2-08（★反作弊★）：投递返回 failed，**不是** accepted').toBe('failed');
  expect(delivery.outcome?.result === 'accepted', 'P2-08（★反作弊★）：返回「已接受」这一情形确实不成立').toBe(false);
  expect(delivery.outcome?.failure_reason, 'W2：失败原因非空（可区分「未接受」）').not.toBe(null);

  // ---- P2-09：失败消息不落任何痕迹 ----
  const snap = h.snapshot();
  expect(snap.inbox_entries.length, 'P2-09：收件箱条数 === 0').toBe(0);
  expect(snap.work_items.length, 'P2-09：工作项数 === 0').toBe(0);
  expect(h.pendingDeliveryEvents().length, 'P2-09：待投递调度事件数 === 0').toBe(0);
  expect(h.kernelEventCount('message_accepted'), 'P2-09：message_accepted 事件数 === 0').toBe(0);
  expect(h.kernelEventCount('delegation_queue_enqueued'), 'P2-09：入队事件数 === 0').toBe(0);
  expect(h.execQueue.length, 'P2-09：执行队列为空').toBe(0);

  // ---- P2-10：实例状态不变，不产生空轮次 ----
  const instance = snap.instances.find((i) => i.instance_id === 'C');
  expect(instance?.queued_flag, 'P2-10：无遗留排队标记').toBe(false);
  expect(instance?.activity, 'P2-10：实例仍空闲').toBe('idle');
  expect(instance?.active_run_id, 'P2-10：无活动轮次').toBe(null);
  expect(snap.runs.length, 'P2-10：轮次记录数 === 0').toBe(0);
  const emptyAdvance = await h.advanceOnce('W2-空推进');
  expect(emptyAdvance.startedRuns, 'P2-10：空推进不启动轮次（startedRuns === 0）').toBe(0);
  expect(h.kernelEventCount('run_started'), 'P2-10：从未产生 run_started').toBe(0);

  const counters = h.counters();
  expect(counters.event.run_count, 'R19（事件侧）：run_count === 0').toBe(0);
  expect(counters.event.inbox_message_count, 'R19（事件侧）：inbox_message_count === 0').toBe(0);
  expect(counters.event.peak_active_runs, 'R19（事件侧）：peak_active_runs === 0').toBe(0);
  expect(
    Object.values(counters.snapshot.work_item_status_distribution).reduce((sum, n) => sum + n, 0),
    'R22：快照侧分布守恒（Σ === 0，与「工作项数 === 0」一致）',
  ).toBe(0);

  return {
    name,
    deliver: delivery,
    fired,
    pending_after_interrupt: 0,
    exec_queue_after_interrupt: 0,
    inbox_after_interrupt: 0,
    work_items_after_interrupt: 0,
    recoveries: [],
    counters_event: counters.event,
    counters_snapshot: counters.snapshot,
    work_item_status: [],
    published_in_order: [],
    late_publications: [],
    runs: [],
    defect: h.defect,
  };
}

// ---------------------------------------------------------------------------
// W3：事务已提交、事件未发布（逐条投递失败）
// ---------------------------------------------------------------------------

async function runW3(): Promise<ScenarioRecord> {
  const name = 'W3-提交后逐条投递失败';
  const h = new P2Harness('P2-W3');
  h.bindAdvance();
  eventSources.push({ name, harness: h });

  h.armInterrupt(
    INJECTION_POINTS.executionEnqueue,
    ['message.persisted', 'scheduling.event.persisted'],
    ['execution.queue.delivery'],
    'W3：事务已提交、事件已入 outbox，逐条投递失败',
  );

  const delivery = h.deliverCatching(
    h.makeRequest({ message_id: 'm-p2-03', request_id: 'r-p2-03', content: '独立工作 j3', at: h.clock.time }),
  );

  const fired = h.firedInjections();
  expect(fired.length, 'W3：注入命中恰好 1 次').toBe(1);
  expect(fired[0]?.point, 'W3：注入点 = execution.enqueue（逐条投递前）').toBe('execution.enqueue');
  expect(delivery.accepted_but_unpublished, 'W3：抛的是 PublicationError（accepted === true）').toBe(true);

  // ---- ★故障窗口真的被触发★（R20.3 的核心：显式发布入口被走到）----
  expect(h.pendingDeliveryEvents().length, '★W3★：待投递事件恰好 1 条（已入 outbox、尚未投递）').toBe(1);
  expect(h.execQueue.length, '★W3★：执行队列为空（故障窗口确实被击中，不是假绿）').toBe(0);
  expect(h.inboxEntryCount('m-p2-03'), 'W3：收件箱中 m-p2-03 恰好 1 条').toBe(1);
  expect(h.workItemCount('r-p2-03'), 'W3：r-p2-03 的工作项恰好 1 项').toBe(1);

  const afterInterrupt = {
    pending: h.pendingDeliveryEvents().length,
    exec: h.execQueue.length,
    inbox: h.inboxEntryCount('m-p2-03'),
    work: h.workItemCount('r-p2-03'),
  };

  // 恢复走另一条路径（publishPending），与 W1 的 replayUndelivered 互证。
  h.rebuildScheduler();
  const recoveries = h.recover(1, 'publishPending');
  expect(recoveries[0]?.via, 'W3：恢复走 publishPending 路径（与 W1 的 replayUndelivered 互证）').toBe('publishPending');
  expect(recoveries[0]?.pending_before, 'W3：恢复前待办 = 1').toBe(1);
  expect(recoveries[0]?.published, 'W3：补投恰好 1 条').toBe(1);
  expect(recoveries[0]?.pending_after, 'W3：恢复后待办 = 0').toBe(0);
  expect(h.publishedFor('m-p2-03').length, 'P2-06（★关键★）：调度事件被补投且仅一次').toBe(1);

  const step = await h.advanceOnce('W3-R1');
  expect(step.startedRuns, 'W3：恢复后启动恰好 1 个轮次').toBe(1);
  if (step.run === null) throw new Error('W3：R1 未启动轮次');
  h.finishCompleted(step.run.run_id, asRequestId('r-p2-03'));
  await h.advanceUntilIdle(MAX_STEPS, 'W3-R2');

  const snap = h.snapshot();
  const item = snap.work_items.find((w) => w.request_id === asRequestId('r-p2-03'));
  expect(item?.status, 'P2-07：不出现「消息已提交但调度事件永久丢失」——r-p2-03 最终有结局').toBe('completed');

  const counters = h.counters();
  expect(counters.event.run_count, 'R19（事件侧）：run_count === 1').toBe(1);
  expect(counters.event.peak_active_runs, 'R19（事件侧）：peak_active_runs === 1').toBe(1);
  expect(
    counters.snapshot.work_item_status_distribution.completed,
    'R19（快照侧）：completed === 1',
  ).toBe(1);

  return {
    name,
    deliver: delivery,
    fired,
    pending_after_interrupt: afterInterrupt.pending,
    exec_queue_after_interrupt: afterInterrupt.exec,
    inbox_after_interrupt: afterInterrupt.inbox,
    work_items_after_interrupt: afterInterrupt.work,
    recoveries,
    counters_event: counters.event,
    counters_snapshot: counters.snapshot,
    work_item_status: snap.work_items.map((w) => `${w.request_id}:${w.status}`),
    published_in_order: publishedKinds(h.execQueue),
    late_publications: [],
    runs: snap.runs.map((r) => ({ run_id: String(r.run_id), frozen_request_ids: r.frozen_request_ids.map(String) })),
    defect: h.defect,
  };
}

// ---------------------------------------------------------------------------
// 受控缺陷注入 I-P2-1：「落盘不记事件」
// ---------------------------------------------------------------------------

interface DefectRecord {
  readonly name: string;
  readonly outcome_result: string | null;
  readonly inbox: number;
  readonly work_items: number;
  readonly pending_delivery_events: number;
  readonly published_for_message: number;
  readonly recovery_published: readonly number[];
  readonly work_item_status_after_processing: string | null;
  readonly run_count: number;
}

let defectRecord: DefectRecord | null = null;

async function runDefectDropOutbox(): Promise<DefectRecord> {
  const h = new P2Harness('P2-W1-defect', { defect: 'drop_outbox' });
  h.bindAdvance();
  eventSources.push({ name: 'I-P2-1-drop_outbox', harness: h });

  h.armOutboxDrop();
  const delivery = h.deliverCatching(
    h.makeRequest({ message_id: 'm-p2-01', request_id: 'r-p2-01', content: '独立工作 j1', at: h.clock.time }),
  );
  h.disarmOutboxDrop();

  expect(h.defect, '注入配置为 drop_outbox（注入确实生效）').toBe('drop_outbox');
  expect(delivery.thrown, '★注入证明★：I-P2-1 下入口**静默成功**（这正是该缺陷的危险之处）').toBe(null);
  expect(delivery.outcome?.result, '★注入证明★：I-P2-1 下投递仍返回 accepted').toBe('accepted');
  expect(h.pendingDeliveryEvents().length, '★注入证明★：outbox 里**没有**待投递事件').toBe(0);
  expect(h.execQueue.length, '★注入证明★：执行队列为空（永远收不到入队事件）').toBe(0);

  const recoveries = h.recover(1, 'replayUndelivered');
  const publishedFor = h.publishedFor('m-p2-01').length;

  // ★P2-03 变红★
  expect(publishedFor, '★注入证明★：P2-03 变红——针对 m-p2-01 的入队事件数为 0（期望 1）').toBe(0);
  expect(publishedFor === 1, '★注入证明★：P2-03 的判据「=== 1」确实不成立').toBe(false);
  expect(recoveries[0]?.pending_before, '★注入证明★：P2-06 同因变红——恢复前无待办可补投').toBe(0);

  // P2-02 在 I-P2-1 下**仍然通过**（如实报告：该断言不能被本注入击穿）。
  const step = await h.advanceOnce('缺陷-R1');
  let status: string | null = null;
  if (step.run !== null) {
    h.finishCompleted(step.run.run_id, asRequestId('r-p2-01'));
    await h.advanceUntilIdle(MAX_STEPS, '缺陷-R2');
    status = h.snapshot().work_items.find((w) => w.request_id === asRequestId('r-p2-01'))?.status ?? null;
  }
  expect(status, 'P2-02 的如实报告：即使丢掉入队事件，消息仍被处理（运行机会由收件箱推导）').toBe('completed');

  return {
    name: 'I-P2-1 落盘不记事件',
    outcome_result: delivery.outcome?.result ?? null,
    inbox: h.inboxEntryCount('m-p2-01'),
    work_items: h.workItemCount('r-p2-01'),
    pending_delivery_events: h.pendingDeliveryEvents().length,
    published_for_message: publishedFor,
    recovery_published: recoveries.map((r) => r.published),
    work_item_status_after_processing: status,
    run_count: h.counters().event.run_count,
  };
}

// ---------------------------------------------------------------------------
// 装配与断言
// ---------------------------------------------------------------------------

beforeAll(async () => {
  stages.push('W1：提交后、发布前中断（afterCommitBeforePublish）');
  scenarios.push(await runW1());
  stages.push('W2：持久化失败（beforeCommit）');
  scenarios.push(await runW2());
  stages.push('W3：逐条投递失败（beforePublishEvent）');
  scenarios.push(await runW3());
  stages.push('I-P2-1：落盘不记事件（受控缺陷注入）');
  defectRecord = await runDefectDropOutbox();
}, 30_000);

describe('P2 可靠交付：三个注入点', () => {
  it('三个注入点各自命中；W1/W3 的「保存后未入队」故障窗口真的被触发（R20.3）', () => {
    expect(scenarios.length, '三个注入点场景都已执行').toBe(3);
    const [w1, w2, w3] = scenarios;

    expect(w1?.fired.length, 'W1：注入命中 1 次').toBe(1);
    expect(w1?.pending_after_interrupt, '★W1★：中断后待投递事件恰好 1 条（窗口确实存在）').toBe(1);
    expect(w1?.exec_queue_after_interrupt, '★W1★：中断后执行队列为空').toBe(0);
    expect(w1?.inbox_after_interrupt, 'W1：消息已可靠保存（收件箱 1 条）').toBe(1);
    expect(w1?.work_items_after_interrupt, 'W1：工作项已建（1 项）').toBe(1);

    expect(w2?.fired[0]?.point, 'W2：命中 message.persist').toBe('message.persist');
    expect(w2?.deliver.outcome?.result, 'P2-08：W2 返回 failed（不是 accepted）').toBe('failed');

    expect(w3?.fired[0]?.point, 'W3：命中 execution.enqueue').toBe('execution.enqueue');
    expect(w3?.pending_after_interrupt, '★W3★：中断后待投递事件恰好 1 条（消息已提交、事件在 outbox）').toBe(1);
    expect(w3?.exec_queue_after_interrupt, '★W3★：中断后执行队列为空 → 故障窗口真被击中（非假绿）').toBe(0);
    expect(w3?.inbox_after_interrupt, 'W3：消息已可靠保存（收件箱 1 条）').toBe(1);
  });

  it('W1 的两次恢复幂等：第二次无待办，不多建业务工作（P2-03 / P2-04）', () => {
    const w1 = scenarios[0];
    expect(w1?.recoveries.length, 'W1：恢复 2 次').toBe(2);
    expect(w1?.recoveries[0]?.published, 'W1：第一次补投 1 条').toBe(1);
    expect(w1?.recoveries[1]?.published, 'W1：第二次补投 0 条（幂等）').toBe(0);
    expect(w1?.recoveries[1]?.pending_after, 'W1：第二次恢复后待办 0').toBe(0);
    expect(w1?.published_in_order.filter((k) => k.includes('m-p2-01')).length, 'P2-03：入队事件补投恰好 1 次').toBe(1);
    expect(w1?.work_item_status, 'P2-04：恢复后工作项仍是 1 项且已完结').toEqual(['r-p2-01:completed']);
  });

  it('W3 与 W1 是两个等价但不同的危险窗口，必须同时通过（规格 6.8 的正面对照）', () => {
    const w3 = scenarios[2];
    expect(w3?.recoveries[0]?.published, 'P2-06：W3 补投恰好 1 条').toBe(1);
    expect(w3?.published_in_order.filter((k) => k.includes('m-p2-03')).length, 'P2-06：仅一次').toBe(1);
    expect(w3?.work_item_status, 'P2-07：r-p2-03 最终有结局').toEqual(['r-p2-03:completed']);
    expect(w3?.counters_event.peak_active_runs, 'P2-05 同类：W3 恢复期间峰值活动轮次 === 1').toBe(1);
  });

  it('R19：P2 的三场景都给出了事件侧与快照侧两组来源（各自取值已合并）', () => {
    for (const scenario of scenarios) {
      expect(typeof scenario.counters_event.run_count, `R19：${scenario.name} 事件侧已取值`).toBe('number');
      expect(
        Object.keys(scenario.counters_snapshot.work_item_status_distribution).length,
        `R19：${scenario.name} 快照侧六态齐全`,
      ).toBe(6);
    }
    const w1 = scenarios[0];
    expect(w1?.counters_event.run_count, 'R19/W1：事件侧 run_count === 1').toBe(1);
    expect(w1?.counters_event.peak_active_runs, 'R19/W1：事件侧 peak_active_runs === 1').toBe(1);
    expect(w1?.counters_event.inbox_message_count, 'R19/W1：事件侧 inbox_message_count === 1').toBe(1);
    expect(w1?.counters_event.diagnosis_count, 'R19/W1：事件侧 diagnosis_count === 0').toBe(0);
    expect(w1?.counters_snapshot.work_item_status_distribution.completed, 'R19/W1：快照侧 completed === 1').toBe(1);
    expect(w1?.counters_snapshot.blocker_reasons, 'R19/W1：快照侧终态无阻塞原因').toEqual([]);
  });
});

describe('受控缺陷注入（R7）：证明 P2 的关键断言真会失败', () => {
  it('I-P2-1「落盘不记事件」→ P2-03 / P2-06 变红；并如实报告 P2-02 不可被它击穿', () => {
    expect(defectRecord === null, '缺陷场景已执行').toBe(false);
    const d = defectRecord!;
    expect(d.pending_delivery_events, '★注入证明★：outbox 里没有待投递事件（落盘不记事件）').toBe(0);
    expect(d.published_for_message, '★注入证明★：P2-03 变红（入队事件数 0，期望 1）').toBe(0);
    expect(d.recovery_published[0], '★注入证明★：P2-06 同因变红（恢复补投 0 条）').toBe(0);
    expect(d.work_item_status_after_processing, '如实报告：P2-02 在 I-P2-1 下仍通过（运行机会由收件箱推导，不由 outbox 推导）').toBe('completed');
    expect(d.run_count, '如实报告：I-P2-1 下轮次数仍为 1').toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 证据落盘
// ---------------------------------------------------------------------------

/**
 * 构造 P2 可靠交付的两份产物（JSON 汇总 + JSONL 事件流）——**不决定目录**（G05 / R46.1）。
 *
 * 身份由发布器在同一次计算里给出并入戳，落盘位置由该身份决定；JSON 与 JSONL 必然同目录（R46.2）。
 */
function buildP2Artifacts(identity: EvidenceIdentityStamp): readonly EvidenceArtifact[] {
  const evidence = {
    task: 'D08',
    scenario: 'P2-reliable-delivery',
    point: 'design-01-P2',
    // R38.4 / F11：身份戳**经复算**——复算与登记冻结点不符时写出
      // frozen:false / id:'DEV-UNFROZEN'，不再抄旧摘要冒用通过身份。
      freeze: identity,
    executed_at_utc: new Date().toISOString(),
    seed: 'fixed-order（确定性；本场景无随机化）',
    commands: [
      'pnpm typecheck',
      'pnpm vitest run tests/acceptance/a04 tests/acceptance/reliability',
      'pnpm test',
    ],
    stages,
    scope_boundary: '只覆盖「保存成功 → 入队」窗口；恢复 = 重建调度器 + 重读存储，不杀进程，不覆盖 A10。',
    r20_3_window_triggered: {
      note: 'D01 的 transact() 不自动发布；夹具走 Scheduler.onMessage()（提交后显式 publishPendingEvents()）。',
      W1: { fired_point: scenarios[0]?.fired[0]?.point ?? null, pending_after_interrupt: scenarios[0]?.pending_after_interrupt ?? null, exec_queue_after_interrupt: scenarios[0]?.exec_queue_after_interrupt ?? null },
      W3: { fired_point: scenarios[2]?.fired[0]?.point ?? null, pending_after_interrupt: scenarios[2]?.pending_after_interrupt ?? null, exec_queue_after_interrupt: scenarios[2]?.exec_queue_after_interrupt ?? null },
    },
    scenarios,
    defect_injection: {
      id: 'I-P2-1',
      name: 'drop_outbox（落盘不记事件）',
      breaks: ['P2-03', 'P2-06'],
      does_not_break: ['P2-01', 'P2-02'],
      finding:
        'P2-02「消息在收件箱却永不执行」无法被 I-P2-1 击穿：本实现的 hasRunnableInput() 由**收件箱**推导运行机会，' +
        '因此丢掉 outbox 记录不会让消息永久无法执行。该断言在本实现下结构性偏弱，已在报告中登记。',
      record: defectRecord,
    },
    counters_sources: {
      event_side: 'summarizeKernelEvents(kernel_events) —— src/protocol/counters.ts',
      snapshot_side: 'summarizeSnapshotCounters(snapshot) —— src/protocol/counters.ts',
      merged_by: 'mergeSchedulingCounters',
    },
    main_judgments: [
      'P2-01 / P2-03 / P2-04（W1：收件箱恰好 1 条、入队事件补投仅一次、重复恢复不多建业务工作）',
      'P2-06（W3：补投仅一次且 r-p2-03 被处理）',
      'P2-08（W2：持久化失败不得报告已接受）',
      '★窗口被触发★：W1/W3 中断后「待投递事件 === 1 且执行队列 === 0」（否则是假绿）',
    ],
  };

  // 规格 0.7：原始事件序列（JSONL）与汇总记录两个文件。事件流不含墙钟，逐字节确定。
  const lines: string[] = [];
  for (const source of eventSources) {
    for (const event of source.harness.snapshot().kernel_events) {
      lines.push(
        JSON.stringify({
          scenario: source.name,
          event_id: event.event_id,
          kind: event.kind,
          at: event.at,
          instance_id: event.instance_id,
          message_id: event.message_id,
          run_id: event.run_id,
          request_id: event.request_id,
          rejection_reason: event.rejection_reason,
          data: event.data,
        }),
      );
    }
  }

  // R46.2：JSON 与 JSONL **同一** location（一次调用，一个目录）。
  return [
    { file_name: 'p2-evidence.json', content: `${JSON.stringify(evidence, null, 2)}\n` },
    { file_name: 'p2-events.jsonl', content: `${lines.join('\n')}\n` },
  ];
}

afterAll(() => {
  // G05 / R46.1–R46.4：落盘位置由**身份**决定（不再写死 `docs/other/evidence/D08/`）。
  // 复算与登记冻结点（含配置摘要）匹配 ⇒ 正式目录；不匹配 ⇒ `.dev-evidence/{登记冻结点}/`，
  // `docs/other/evidence/**` 一个字节也不碰（R46.3 / R46.4）。
  writeEvidenceArtifacts(buildP2Artifacts);
});
