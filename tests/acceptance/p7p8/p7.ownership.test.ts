/**
 * D11 验收场景 **P7 — 轮次身份与有限租约：所有权核验、拒绝迟到发布**（`design-01-P7`）。
 *
 * 规格原文（`docs/design/design-01-内核骨架与假Agent验证.md`）：
 * > **P7 通过**：结束轮次时核对身份与租约所有权；构造一个"租约已过期"或"任务版本已变更"的
 * > 迟到发布，必须被拒绝且不写入任何结果。
 *
 * ## 两个子场景（都要）
 *
 * 1. **`lease_expired`**——用 D06 的可控时钟推进**越过租约截止**（`lease_ttl=10`，读数 0→10，
 *    区间 `[issued_at, deadline)` 的判定见 `src/protocol/run.ts` 的 `isLeaseExpired`）；
 * 2. **`stale_task_revision`**——任务版本**真实变更**（直改已注册的 `TaskRecord` 到 r2），
 *    非仅靠 `finishRun({ current_task_revision })` 传参覆盖。
 *
 * ## 断言清单（★ = 主判据）
 *
 * | # | 断言 | 依据 |
 * |---|---|---|
 * | ★ | 发布被拒且拒因**恰好**是 `lease_expired` / `stale_task_revision` | P7 原文 |
 * | ★ | **零结果写入**：工作项状态未变、`result_refs` 为空、快照侧 `completed === 0` | P7 原文 |
 * | ★ | `rejected_publication_count === 1` 且 `run_count === 1`（**单列、不计入** `run_count`） | R11 / R17 |
 * | ★ | 被拒的迟到发布**不结束轮次**（`run=running`、实例仍 `active`） | **D03 缺口 4 的现状** |
 * | | 事件侧与快照侧**两组来源**都取并合并 | R19 |
 * | | 断言前先证明夹具产生了数据；投递归属取自**存储侧**收件箱 | R22 / R29.2 |
 * | | 每条子场景一次受控缺陷注入，且核 `fired` | R7 / R28.1 |
 *
 * ## 受控缺陷注入（R7 / R28.1）
 *
 * `I-P7-1`「**所有权闸门被跳过**」：经公开存储接口以 `kernel` 发起方直接落一条 `completed`
 * （"内核忘了核对轮次身份 / 租约所有权就照写"会产生的观测量），证明 `assertZeroResultWrite`
 * **真会失败**。`firedCount` 必须 > 0，否则该场景无效。
 * **构造级可证伪**（同 D07 的 `injectReadEqualsDone` 口径）：真实内核的所有权核验在写入之前，
 * "跳过闸门照样写"无法经公开被测接口构造——这本身就是 P7 的结论。
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asRevision,
  type MessageId,
  type RequestId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import type { FinishRunOutcome } from '../../../src/scheduler/index.js';
import { ConservationViolationError } from '../../../src/fake/index.js';
import {
  INSTANCE_C,
  OwnershipGateBypassDefect,
  P7P8Harness,
  assertInboxHasMessage,
  assertPublicationRejected,
  assertRejectedPublicationCountedSeparately,
  assertRoundNotEndedByRejection,
  assertZeroResultWrite,
  writeEvidence,
} from './support.js';

// ---------------------------------------------------------------------------
// 场景脚本（确定性：可控时钟 + 明确事件序列，零墙钟）
// ---------------------------------------------------------------------------

const LEASE_TTL = 10;
const M_LEASE = 'm-p7-lease' as MessageId;
const R_LEASE = 'r-p7-lease' as RequestId;
const M_STALE = 'm-p7-stale' as MessageId;
const R_STALE = 'r-p7-stale' as RequestId;

interface RejectedScenario {
  readonly harness: P7P8Harness;
  readonly request_id: RequestId;
  readonly message_id: MessageId;
  readonly before: WorkItem;
  readonly finish: FinishRunOutcome;
  readonly lease_deadline: number;
  readonly task_revision_after: number;
}

/** 共同前段：注册 → 投递 → 放行一次推进（启动唯一轮次）→ 验收前状态。 */
async function startRunWithWorkItem(input: {
  readonly message_id: MessageId;
  readonly request_id: RequestId;
}): Promise<{ harness: P7P8Harness; before: WorkItem }> {
  const harness = new P7P8Harness({ lease_ttl: LEASE_TTL });
  harness.registerTask(asRevision(1));
  harness.registerInstance(INSTANCE_C);

  const { outcome } = harness.deliver({
    message_id: input.message_id,
    request_id: input.request_id,
    content: `P7 场景的工作请求 ${input.request_id}`,
  });
  expect(outcome.result).toBe('accepted');

  // R22：先证明夹具确实产生了数据（否则后面的"零"不可信）。
  expect(harness.workItems().length).toBe(1);
  expect(harness.inboxEntries().length).toBe(1);
  expect(harness.kernelEvents().length).toBeGreaterThan(0);

  // R29.2：投递归属取自存储侧（收件箱），不拿接缝登记充数。
  assertInboxHasMessage(harness.inboxEntries(), input.message_id);

  await harness.advanceOnce('R1');
  const run = harness.runningRun();
  expect(run.frozen_request_ids.length).toBe(1);

  const before = harness.requireWorkItem(input.request_id);
  // 轮次启动时认领（`pending → processing`，D03 缺口 1 的口径）；此时**不得**有结果引用。
  expect(before.status).toBe('processing');
  expect(before.result_refs.length).toBe(0);
  expect(harness.observe().snapshot.work_item_status_distribution.completed).toBe(0);

  return { harness, before };
}

/** 子场景 1：租约已过期（可控时钟推进越过截止）。 */
async function leaseExpiredScenario(): Promise<RejectedScenario> {
  const { harness, before } = await startRunWithWorkItem({
    message_id: M_LEASE,
    request_id: R_LEASE,
  });
  const deadline = harness.runningRun().lease_deadline;
  expect(deadline).toBe(LEASE_TTL);
  // 有效区间是 [issued_at, deadline)：读数推到 deadline 即视为过期（Q7-a）。
  harness.clock.advance(LEASE_TTL, '越过租约截止');
  expect(harness.clock.time).toBe(deadline);

  const finish = harness.finishRun({ publications: [harness.completedPublication(R_LEASE)] });
  return {
    harness,
    request_id: R_LEASE,
    message_id: M_LEASE,
    before,
    finish,
    lease_deadline: deadline,
    task_revision_after: 1,
  };
}

/** 子场景 2：任务版本已变更（直改已注册任务到 r2）。 */
async function staleRevisionScenario(): Promise<RejectedScenario> {
  const { harness, before } = await startRunWithWorkItem({
    message_id: M_STALE,
    request_id: R_STALE,
  });
  expect(harness.runningRun().task_revision).toBe(1);
  harness.setTaskRevision(asRevision(2));
  const stored = harness.snapshot().tasks.find((task) => task.task_id === harness.task_id);
  expect(stored?.revision).toBe(2);

  const finish = harness.finishRun({ publications: [harness.completedPublication(R_STALE)] });
  return {
    harness,
    request_id: R_STALE,
    message_id: M_STALE,
    before,
    finish,
    lease_deadline: harness.runningRun().lease_deadline,
    task_revision_after: 2,
  };
}

/** 共用的核心断言（子场景 1 / 2 都跑同一组；受控缺陷注入也复用它们证明可证伪）。 */
function assertRejectedLatePublication(
  scenario: RejectedScenario,
  expectedReason: 'lease_expired' | 'stale_task_revision',
): void {
  const { harness, finish, before } = scenario;

  // ★ 发布被拒，且拒因恰好是期望的那一个。
  assertPublicationRejected(finish, expectedReason);
  // 被拒 = 整轮拒绝：工作项级逐条发布列表必须为空（本场景只有一条声明）。
  expect(finish.applied_request_ids.length).toBe(0);
  expect(finish.rejected_publications.length).toBe(0);
  expect(finish.queued_next_run).toBe(false);

  // ★ 零结果写入。
  const after = harness.requireWorkItem(scenario.request_id);
  expect(after.result_refs.length).toBe(0);
  assertZeroResultWrite({ before, after, observation: harness.observe() });

  // ★ rejected_publication_count 单列，且不计入 run_count（R11 / R17 的等号）。
  assertRejectedPublicationCountedSeparately(harness.observe(), {
    expected_run_count: 1,
    expected_rejected: 1,
  });
  expect(harness.countEvents('publication_rejected')).toBe(1);
  expect(harness.countEvents('run_finished')).toBe(0);
  // 唯一一条状态变更事件是轮次启动时的**认领**（`pending → processing`，D03 缺口 1 的口径）。
  // 被拒的发布**不得**再添一条（否则就会出现"发布被拒但工作项还是被改了"）。
  expect(harness.countEvents('work_item_status_changed')).toBe(1);

  // ★ D03 缺口 4 的现状：被拒的迟到发布**不结束轮次**，只记 publication_rejected。
  assertRoundNotEndedByRejection({ run: harness.runningRun(), instance: harness.instance() });

  // R29.2：消息仍在**存储侧**收件箱里（被拒的是"发布"，不是"投递"）。
  assertInboxHasMessage(harness.inboxEntries(), scenario.message_id);
}

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

const scenarioEvidence: Record<string, unknown> = {};

afterAll(() => {
  writeEvidence('p7-ownership.json', {
    point: 'design-01-P7',
    requirement:
      '结束轮次时核对身份与租约所有权；构造一个「租约已过期」或「任务版本已变更」的迟到发布，必须被拒绝且不写入任何结果。',
    assertion_checklist: [
      '★ 发布被拒且拒因恰好是 lease_expired / stale_task_revision',
      '★ 零结果写入（工作项状态未变、result_refs 为空、快照侧 completed === 0）',
      '★ rejected_publication_count 单列且不计入 run_count（等号）',
      '★ 被拒的迟到发布不结束轮次（D03 缺口 4 的现状）',
      '事件侧 + 快照侧两组来源都取并合并（R19）',
      '断言前先证明夹具产生了数据；投递归属取自存储侧（R22 / R29.2）',
      '每条子场景一次受控缺陷注入并核 fired（R7 / R28.1）',
    ],
    lease_ttl: LEASE_TTL,
    lease_semantics: '有效区间 [issued_at, lease_deadline)；now >= lease_deadline 即过期（Q7-a）',
    d03_gap_4: '被拒的迟到发布不结束轮次（只记 publication_rejected）——按此现状断言，不假设它会 abort',
    scenarios: scenarioEvidence,
  });
});

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('P7 — 迟到发布的所有权核验（D11 / design-01-P7）', () => {
  it('子场景 1：租约已过期 → 拒绝发布、零结果写入、不结束轮次', async () => {
    const scenario = await leaseExpiredScenario();
    assertRejectedLatePublication(scenario, 'lease_expired');
    scenarioEvidence['lease_expired'] = {
      ...scenario.harness.evidence(),
      assertions: {
        rejection_reason: scenario.finish.rejection_reason,
        applied_request_ids: scenario.finish.applied_request_ids.length,
        rejected_publications: scenario.finish.rejected_publications.length,
        work_item_status_after: scenario.harness.requireWorkItem(scenario.request_id).status,
        work_item_result_refs_after: scenario.harness.requireWorkItem(scenario.request_id).result_refs,
        run_status_after: scenario.harness.runningRun().status,
        instance_activity_after: scenario.harness.instance().activity,
      },
    };
  });

  it('子场景 2：任务版本已变更 → 拒绝发布、零结果写入、不结束轮次', async () => {
    const scenario = await staleRevisionScenario();
    assertRejectedLatePublication(scenario, 'stale_task_revision');
    scenarioEvidence['stale_task_revision'] = {
      ...scenario.harness.evidence(),
      assertions: {
        rejection_reason: scenario.finish.rejection_reason,
        applied_request_ids: scenario.finish.applied_request_ids.length,
        rejected_publications: scenario.finish.rejected_publications.length,
        work_item_status_after: scenario.harness.requireWorkItem(scenario.request_id).status,
        work_item_result_refs_after: scenario.harness.requireWorkItem(scenario.request_id).result_refs,
        run_status_after: scenario.harness.runningRun().status,
        run_task_revision: scenario.harness.runningRun().task_revision,
        task_revision_after: scenario.task_revision_after,
      },
    };
  });

  // -------------------------------------------------------------------------
  // R7 / R28.1：受控缺陷注入——证明关键断言"真会失败"
  // -------------------------------------------------------------------------

  it('R7 注入 I-P7-1（租约子场景）：跳过所有权闸门后 assertZeroResultWrite 真会失败', async () => {
    const scenario = await leaseExpiredScenario();
    // 先确认"正确配置下断言成立"，再注入缺陷——否则证明不了是缺陷让它变红的。
    assertRejectedLatePublication(scenario, 'lease_expired');

    const defect = new OwnershipGateBypassDefect(scenario.harness.store);
    const defective = defect.publishBypassingOwnership(
      scenario.request_id,
      asLogicalTime(scenario.harness.clock.time),
    );
    // R28.1：注入必须**真的发生**（fired === 0 即判该场景无效）。
    expect(defect.firedCount).toBe(1);
    expect(defective.status).toBe('completed');
    expect(defective.result_refs.length).toBe(1);

    expect(() =>
      assertZeroResultWrite({
        before: scenario.before,
        after: defective,
        observation: scenario.harness.observe(),
      }),
    ).toThrow(ConservationViolationError);

    scenarioEvidence['defect_I-P7-1'] = {
      kind: '所有权闸门被跳过（构造级可证伪）',
      fired: defect.firedCount,
      injected_observable: { status: defective.status, result_refs: defective.result_refs },
      key_assertion: 'assertZeroResultWrite',
      assertion_threw: true,
      boundary:
        '真实 finishRun 把所有权核验放在写入之前；"跳过闸门照样写"无法经公开被测接口构造——' +
        '这本身就是 P7 的结论。本注入构造的是该缺陷会产生的观测量（同 D07 的 injectReadEqualsDone 口径）。',
    };
  });

  it('R7 注入 I-P7-1（stale 子场景）：跳过版本闸门后 assertZeroResultWrite 真会失败', async () => {
    const scenario = await staleRevisionScenario();
    assertRejectedLatePublication(scenario, 'stale_task_revision');

    const defect = new OwnershipGateBypassDefect(scenario.harness.store);
    const defective = defect.publishBypassingOwnership(
      scenario.request_id,
      asLogicalTime(scenario.harness.clock.time),
    );
    expect(defect.firedCount).toBe(1);
    expect(() =>
      assertZeroResultWrite({
        before: scenario.before,
        after: defective,
        observation: scenario.harness.observe(),
      }),
    ).toThrow(ConservationViolationError);

    scenarioEvidence['defect_I-P7-1_stale'] = {
      kind: '版本闸门被跳过（构造级可证伪）',
      fired: defect.firedCount,
      key_assertion: 'assertZeroResultWrite',
      assertion_threw: true,
    };
  });
});
