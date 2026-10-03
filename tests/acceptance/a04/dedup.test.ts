/**
 * D08 验收场景 **A04 — 重复消息送达（去重）**（`design-01-P2`）。
 *
 * 规格：`docs/other/prep/D07-D09-prep-验收场景规格.md` §3（变体甲/乙/丙 + 对照 A04-C）。
 * 断言权重：合同 v1.1 **R15**（A04-02 是弱证据，主判据是 A04-01 / A04-06 与对照）。
 * 断言强度：**R17**（计数用等号）、**R22**（先证明夹具产生了数据）、**R19**（事件侧 + 快照侧两组来源）。
 * 受控缺陷：**R7**（至少一次「去掉去重判定」，证明 A04-01 真会失败）。
 * 冻结点标识：取自**单一来源** `tests/acceptance/freeze-identity.ts`，值在
 * `docs/other/evidence/D11/freeze-identity.json`（R24 / R32.1）。本文件不改 `src/**`。
 *
 * 隔离说明（规格 0.2 / 0.3）：三个变体与对照 A04-C **各自独占存储与调度器**；
 * 对照 A04-C 用独立实例承载（规格原文把它排在变体甲之后，同一实例继续投递；
 * 独立承载在语义上等价——「内容逐字相同、id 不同 → 各自独立保留」——
 * 且避免对照阶段污染变体甲的守恒观测）。该偏差在证据里登记。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  statusDistribution,
  type MessageId,
  type RequestId,
} from '../../../src/protocol/index.js';
import {
  A04Harness,
  FREEZE_1_SOURCE_TREE_SHA256,
  RETRY_PAYLOAD_KEY,
  type DeliveryAttemptRecord,
} from './harness.js';
import {
  writeEvidenceArtifacts,
  type EvidenceArtifact,
  type EvidenceIdentityStamp,
} from '../freeze-identity.js';

// ---------------------------------------------------------------------------
// 场景参数（规格 0.7：执行前登记；本批用固定顺序集，无随机化）
// ---------------------------------------------------------------------------

const CONTENT = '独立工作 jD，期望产物 pD';
const MID = 'm-a04-01';
const RID = 'r-a04-01';
/** 对照 A04-C：内容与 jD **逐字相同**，`message_id` / `request_id` 均不同。 */
const MID_CTRL = 'm-a04-02';
const RID_CTRL = 'r-a04-02';

const ADVANCE_MAX_STEPS = 8;

type VariantKind = 'sequential' | 'concurrent' | 'mixed';

interface VariantObservation {
  readonly kind: VariantKind;
  readonly harness: A04Harness;
  /** 去重阶段的运行轮次数（在**任何**后续阶段之前采样，用于 A04-07 的跨变体比较）。 */
  readonly dedup_phase_run_count: number;
  readonly attempts: readonly DeliveryAttemptRecord[];
  /** 5 次投递各自携带的 payload 标记（A04-06 的「重试那份与首次那份可区分」自证）。 */
  readonly retry_markers: readonly unknown[];
}

const observations: VariantObservation[] = [];
const stages: string[] = [];
/** 需要落到 JSONL 原始事件序列的场景（规格 0.7：原始事件序列 + 汇总记录）。 */
const eventSources: { readonly name: string; readonly harness: A04Harness }[] = [];

// ---------------------------------------------------------------------------
// 变体脚本（规格 0.5：屏障 + 可控时钟 + 明确事件序列，零墙钟）
// ---------------------------------------------------------------------------

function attemptRequest(h: A04Harness, index: number, at: () => number) {
  return h.makeRequest({
    message_id: MID,
    request_id: RID,
    content: CONTENT,
    at: asLogicalTime(at()),
    extra_payload: { [RETRY_PAYLOAD_KEY]: index },
  });
}

async function runVariant(kind: VariantKind): Promise<VariantObservation> {
  const h = new A04Harness({ idSeed: `a04-${kind}` });
  const built: ReturnType<typeof attemptRequest>[] = [];
  const build = (index: number): ReturnType<typeof attemptRequest> => {
    const request = attemptRequest(h, index, () => h.clock.time);
    built.push(request);
    return request;
  };

  if (kind === 'sequential') {
    // 变体甲（顺序重试）：逐条投递，每条等到返回再投下一条；各自处在不同逻辑步。
    for (let i = 1; i <= 5; i += 1) {
      h.clock.advance(1, `甲#${i}`);
      h.deliver(build(i));
    }
  } else if (kind === 'concurrent') {
    // 变体乙（并发重试）：5 次在**同一屏障 B-deliver** 后同时起跑，共享同一逻辑步。
    h.clock.advance(1, '乙-起跑');
    await h.deliverConcurrent([1, 2, 3, 4, 5].map((i) => build(i)));
  } else {
    // 变体丙（混合）：前 2 次并发、随后 3 次顺序重试。
    h.clock.advance(1, '丙-并发段起跑');
    await h.deliverConcurrent([1, 2].map((i) => build(i)));
    for (let i = 3; i <= 5; i += 1) {
      h.clock.advance(1, `丙-顺序#${i}`);
      h.deliver(build(i));
    }
  }

  // 放行点 R1：全部投递返回后才允许冻结快照并启动唯一一项工作。
  const step = await h.advanceOnce(`R1-${kind}`);
  if (step.run === null) throw new Error(`变体 ${kind}：R1 未启动轮次（夹具/内核接线错误）`);
  h.finishCompleted(step.run.run_id, RID as RequestId);
  await h.advanceUntilIdle(ADVANCE_MAX_STEPS, `R2-${kind}`);

  return {
    kind,
    harness: h,
    dedup_phase_run_count: h.counters().event.run_count,
    attempts: [...h.attempts],
    retry_markers: built.map(
      (request) => (request.message.payload as Record<string, unknown>)[RETRY_PAYLOAD_KEY],
    ),
  };
}

// ---------------------------------------------------------------------------
// 对照 A04-C（独立实例承载）
// ---------------------------------------------------------------------------

interface ControlObservation {
  readonly harness: A04Harness;
  readonly accept_result: string;
  readonly first_fingerprint: string;
  readonly second_fingerprint: string;
  readonly run_count: number;
}

let control: ControlObservation | null = null;

async function runControl(): Promise<ControlObservation> {
  const h = new A04Harness({ idSeed: 'a04-control' });

  // 先建立一条与 jD 同内容的既有消息，再投递「内容逐字相同、id 不同」的第二条。
  const first = h.makeRequest({ message_id: MID, request_id: RID, content: CONTENT, at: h.clock.time });
  h.deliver(first);
  const firstStep = await h.advanceOnce('对照-R1');
  if (firstStep.run === null) throw new Error('对照 A04-C：R1 未启动轮次');
  h.finishCompleted(firstStep.run.run_id, RID as RequestId);
  await h.advanceUntilIdle(ADVANCE_MAX_STEPS, '对照-R2');

  h.clock.advance(1, '对照-投递 m-a04-02');
  const second = h.makeRequest({
    message_id: MID_CTRL,
    request_id: RID_CTRL,
    content: CONTENT,
    at: h.clock.time,
  });
  const outcome = h.deliver(second);

  const snap = h.snapshot();
  const uniqueMessageIds = new Set(snap.inbox_entries.map((entry) => entry.message_id));

  expect(
    second.content_fingerprint,
    'A04-C 夹具自证：m-a04-02 与 m-a04-01 的内容指纹**逐字相同**',
  ).toBe(first.content_fingerprint);
  expect(outcome.result, 'A04-C-04（★主判据★，反作弊）：内容相同但 id 不同的消息必须返回 accepted').toBe('accepted');
  expect(uniqueMessageIds.size, 'A04-C-01（★主判据★，守恒）：收件箱唯一 message_id 数 = 2').toBe(2);
  expect(
    snap.work_items.filter((item) => item.request_id === (RID_CTRL as RequestId)).length,
    'A04-C-02（★主判据★，守恒）：r-a04-02 有自己独立的 1 项工作',
  ).toBe(1);
  expect(snap.work_items.length, 'A04-C-02：工作承诺表唯一 request_id 数 = 2').toBe(2);

  const itemFirst = snap.work_items.find((item) => item.request_id === (RID as RequestId));
  const itemSecond = snap.work_items.find((item) => item.request_id === (RID_CTRL as RequestId));
  expect(
    (itemFirst?.triggering_message_ids ?? []).join(','),
    'A04-C-03（反作弊）：两项工作未合并，r-a04-01 只被 m-a04-01 触发',
  ).toBe(MID);
  expect(
    (itemSecond?.triggering_message_ids ?? []).join(','),
    'A04-C-03（反作弊）：两项工作未合并，r-a04-02 只被 m-a04-02 触发',
  ).toBe(MID_CTRL);

  // 让第二项工作也产出独立结局。
  const secondStep = await h.advanceOnce('对照-R3');
  if (secondStep.run === null) throw new Error('对照 A04-C：R3 未启动轮次（r-a04-02 未被处理）');
  h.finishCompleted(secondStep.run.run_id, RID_CTRL as RequestId);
  await h.advanceUntilIdle(ADVANCE_MAX_STEPS, '对照-R4');

  return {
    harness: h,
    accept_result: outcome.result,
    first_fingerprint: first.content_fingerprint,
    second_fingerprint: second.content_fingerprint,
    run_count: h.counters().event.run_count,
  };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

beforeAll(async () => {
  stages.push('1/4 变体甲（顺序重试 5 次）');
  observations.push(await runVariant('sequential'));

  stages.push('2/4 变体乙（并发重试 5 次，屏障 B-deliver）');
  observations.push(await runVariant('concurrent'));

  stages.push('3/4 变体丙（前 2 并发 + 后 3 顺序）');
  observations.push(await runVariant('mixed'));

  for (const observation of observations) {
    eventSources.push({ name: `变体-${observation.kind}`, harness: observation.harness });
  }

  stages.push('4/4 对照 A04-C（内容逐字相同、id/request_id 不同）');
  control = await runControl();
  eventSources.push({ name: '对照-A04-C', harness: control.harness });
}, 30_000);

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

describe('A04 主场景：同一 message_id 投递 5 次', () => {
  it('★主判据★ A04-01 / A04-06：三个变体各自收件箱恰好 1 条，且首次到达记录未被覆盖', () => {
    expect(observations.length, '三个变体都已执行').toBe(3);

    for (const observation of observations) {
      const { harness: h, kind, attempts } = observation;
      const label = `变体${kind}`;
      const snap = h.snapshot();

      // ---- R22 前置：先证明夹具确实产生了数据（禁止在「空」上做判断）----
      expect(attempts.length, `${label}．R22 前置：5 次投递调用都发生了`).toBe(5);
      expect(
        snap.messages.filter((m) => m.message_id === (MID as MessageId)).length,
        `${label}．R22 前置：消息表里确实有 m-a04-01`,
      ).toBe(1);

      // ---- A04-01（★主判据★）：收件箱恰好 1 条 -------------------------
      // 收件箱是 **append 数组**；去掉去重就会翻倍 → 唯一能击穿「去重缺失」的断言。
      expect(h.inboxEntryCount(MID), `${label}．A04-01（★主判据★）：收件箱中 m-a04-01 恰好 1 条`).toBe(1);
      expect(h.inboxOfC().length, `${label}．A04-01b（★主判据★）：C 的收件箱总条数恰好 1 条`).toBe(1);
      expect(
        h.snapshot().inbox_entries.filter((e) => e.message_id === (MID as MessageId)).length,
        `${label}．A04-06b：不存在两条收件箱记录共享同一 message_id`,
      ).toBe(1);

      // ---- A04-06（★主判据★）：同 id 重复送达不覆盖首次到达记录 ----------
      // 重试那份带不同的 created_at 与 payload.attempt；库里必须仍是**首次那份**。
      const stored = snap.messages.find((m) => m.message_id === (MID as MessageId));
      const payload = stored?.payload as Record<string, unknown> | undefined;
      const firstStep = attempts[0]?.step ?? -1;
      expect(
        observation.retry_markers,
        `${label}．A04-06 夹具自证：5 份投递各自携带可区分的 payload 标记（重试那份确实与首次不同）`,
      ).toEqual([1, 2, 3, 4, 5]);
      expect(
        payload?.[RETRY_PAYLOAD_KEY],
        `${label}．A04-06（★主判据★）：落库 payload 仍是首次那份（未被最后一次重试改写）`,
      ).toBe(1);
      expect(
        stored?.created_at,
        `${label}．A04-06（★主判据★）：落库 created_at 仍是首次到达时刻`,
      ).toBe(asLogicalTime(firstStep));
    }
  });

  it('A04-02（★弱判据★，R15）/ A04-03 / A04-04 / A04-05：弱判据与支撑判据', () => {
    for (const observation of observations) {
      const { harness: h, kind, attempts } = observation;
      const label = `变体${kind}`;
      const snap = h.snapshot();

      // A04-02：R15 明示为**弱证据**（存储按 request_id 为键 + last-write-wins ⇒ 恒真）。
      expect(h.workItemCount(RID), `${label}．A04-02（弱判据，R15）：r-a04-01 的工作项恰好 1 项`).toBe(1);

      // A04-03：归属类——只被读入过一次。
      expect(h.runsReading(RID).length, `${label}．A04-03：r-a04-01 出现在轮次冻结快照中的次数 = 1`).toBe(1);

      // A04-04：三值分布（反作弊：幂等去重，不是报错拒绝）。
      expect(attempts.filter((a) => a.result === 'accepted').length, `${label}．A04-04：返回 accepted 的投递恰好 1 次`).toBe(1);
      expect(
        attempts.filter((a) => a.result === 'duplicate_not_created').length,
        `${label}．A04-04：返回 duplicate_not_created 的投递恰好 4 次`,
      ).toBe(4);
      expect(attempts.filter((a) => a.result === 'failed').length, `${label}．A04-04（反作弊）：无一返回 failed`).toBe(0);

      // A04-05：结局明确。
      const item = snap.work_items.find((w) => w.request_id === (RID as RequestId));
      expect(item?.status, `${label}．A04-05：r-a04-01 结局为终态 completed`).toBe('completed');
      expect(item?.result_refs.length, `${label}．A04-05：completed 必须带结果引用（P4-10）`).toBe(1);

      // R22：快照分布守恒（等号，先证明数据流进来了）。
      const distribution = statusDistribution(snap.work_items);
      const total = Object.values(distribution).reduce((sum, n) => sum + n, 0);
      expect(total, `${label}．R22：Σ分布 === 快照里的工作项总数`).toBe(snap.work_items.length);
      expect(snap.work_items.length, `${label}．R22：工作项总数 = 1`).toBe(1);
      expect(distribution.completed, `${label}．R22：distribution.completed === 1`).toBe(1);
      expect(distribution.failed, `${label}．R22：distribution.failed === 0`).toBe(0);
      expect(distribution.cancelled, `${label}．R22：distribution.cancelled === 0`).toBe(0);

      // R19：事件侧 6 项 + 快照侧 2 项**两组来源**分别取值，再合并。
      const counters = h.counters();
      expect(counters.event.run_count, `${label}．R19（事件侧 summarizeKernelEvents）：run_count === 1`).toBe(1);
      expect(counters.event.peak_active_runs, `${label}．R19（事件侧）：peak_active_runs === 1`).toBe(1);
      expect(counters.event.peak_queued_flags, `${label}．R19（事件侧）：peak_queued_flags === 1`).toBe(1);
      expect(counters.event.inbox_message_count, `${label}．R19（事件侧）：inbox_message_count === 1`).toBe(1);
      expect(counters.event.diagnosis_count, `${label}．R19（事件侧）：diagnosis_count === 0`).toBe(0);
      expect(counters.event.rejected_publication_count, `${label}．R19（事件侧）：rejected_publication_count === 0`).toBe(0);
      expect(
        counters.snapshot.work_item_status_distribution.completed,
        `${label}．R19（快照侧 summarizeSnapshotCounters）：completed === 1`,
      ).toBe(1);
      expect(counters.snapshot.blocker_reasons, `${label}．R19（快照侧）：终态工作项无阻塞原因`).toEqual([]);
      expect(counters.merged.run_count, `${label}．R19：合并后事件侧一致`).toBe(1);
      expect(counters.merged.work_item_status_distribution.completed, `${label}．R19：合并后快照侧一致`).toBe(1);

      // 收尾：无残留轮次、无排队标记。
      const instance = snap.instances.find((i) => i.instance_id === 'C');
      expect(instance?.queued_flag, `${label}：场景结束时无排队标记`).toBe(false);
      expect(instance?.active_run_id, `${label}：场景结束时无活动轮次`).toBe(null);
    }
  });

  it('A04-07：重复投递不增加运行轮次数——三个变体去重阶段轮次数相同（等号，R17）', () => {
    const counts = observations.map((o) => o.dedup_phase_run_count);
    expect(counts.length, '三个变体均已执行').toBe(3);
    expect(counts[0], 'A04-07：变体甲去重阶段 run_count === 1').toBe(1);
    expect(counts[1], 'A04-07：变体乙去重阶段 run_count === 1').toBe(1);
    expect(counts[2], 'A04-07：变体丙去重阶段 run_count === 1').toBe(1);
    expect(counts.every((c) => c === counts[0]), 'A04-07：变体甲/乙/丙的轮次数完全相同').toBe(true);

    // 收尾后总轮次数（等号，不用上界）。
    for (const observation of observations) {
      const total = observation.harness.counters().event.run_count;
      expect(total, `A04-07：变体${observation.kind} 收尾后总轮次数 === 去重阶段轮次数`).toBe(
        observation.dedup_phase_run_count,
      );
    }
  });

  it('变体乙（并发）自证：5 次投递共享同一逻辑步，且全部早于任何一次冻结；变体甲各自不同步', () => {
    const concurrent = observations.find((o) => o.kind === 'concurrent');
    const sequential = observations.find((o) => o.kind === 'sequential');
    expect(concurrent === undefined, '变体乙已执行').toBe(false);
    expect(sequential === undefined, '变体甲已执行').toBe(false);

    expect(new Set(concurrent?.attempts.map((a) => a.step)).size, '变体乙：5 次投递在同一逻辑步起跑（屏障 B-deliver）').toBe(1);
    expect(
      concurrent?.attempts.every((a) => a.advance_seq === 0),
      '变体乙：全部投递提交早于任何一次快照冻结（advanceSeq === 0）',
    ).toBe(true);
    concurrent?.harness.seam.assertAllDeliveriesBefore(0);
    expect(new Set(sequential?.attempts.map((a) => a.step)).size, '变体甲自证：5 次投递各处在不同逻辑步').toBe(5);
  });
});

describe('对照 A04-C：内容逐字相同、id 与 request_id 不同', () => {
  it('★主判据★ A04-C-01/02/04：两条消息各自独立保留，第二条未被当作重复丢弃', () => {
    expect(control === null, '对照阶段已执行').toBe(false);
    expect(control!.accept_result, 'A04-C-04（★主判据★）：m-a04-02 返回 accepted').toBe('accepted');
    expect(control!.first_fingerprint, 'A04-C 夹具自证：两条消息内容指纹逐字相同').toBe(control!.second_fingerprint);
  });

  it('A04-C-03/05：两项工作未合并，各有独立结局与不交叉的结果引用', () => {
    const snap = control!.harness.snapshot();
    expect(control!.run_count, 'A04-C：两项工作各占一轮（总轮次数 = 2，等号）').toBe(2);

    const first = snap.work_items.find((w) => w.request_id === (RID as RequestId));
    const second = snap.work_items.find((w) => w.request_id === (RID_CTRL as RequestId));
    expect(first?.status, 'A04-C-05：r-a04-01 已完成').toBe('completed');
    expect(second?.status, 'A04-C-05：r-a04-02 已完成').toBe('completed');

    const firstRefs = (first?.result_refs ?? []).map(String);
    const secondRefs = (second?.result_refs ?? []).map(String);
    expect(firstRefs.length, 'A04-C-05：r-a04-01 的结果引用数 = 1').toBe(1);
    expect(secondRefs.length, 'A04-C-05：r-a04-02 的结果引用数 = 1').toBe(1);
    expect(firstRefs.every((ref) => ref.includes(RID)), 'A04-C-05（反作弊）：r-a04-01 的结果引用指向自己的 request_id').toBe(true);
    expect(secondRefs.every((ref) => ref.includes(RID_CTRL)), 'A04-C-05（反作弊）：r-a04-02 的结果引用指向自己的 request_id').toBe(true);
    expect(firstRefs.some((ref) => secondRefs.includes(ref)), 'A04-C-05：两份结果引用不交叉').toBe(false);
  });
});

describe('受控缺陷注入（R7）：证明 A04 的主判据真会失败', () => {
  it('I-A04-1「去掉去重判定」→ A04-01 变红（而弱判据 A04-02 仍为真，实证 R15）', () => {
    const h = new A04Harness({ defect: 'no_dedup', idSeed: 'a04-defect-no-dedup' });
    for (let i = 1; i <= 5; i += 1) {
      h.clock.advance(1, `注入-甲#${i}`);
      h.deliver(attemptRequest(h, i, () => h.clock.time));
    }
    eventSources.push({ name: '注入-I-A04-1-no_dedup', harness: h });

    const inboxCount = h.inboxEntryCount(MID);
    const workItemCount = h.workItemCount(RID);
    const stored = h.snapshot().messages.find((m) => m.message_id === (MID as MessageId));
    const payload = stored?.payload as Record<string, unknown> | undefined;

    expect(h.defect, '注入配置为 no_dedup（注入确实生效，用例非空操作）').toBe('no_dedup');
    expect(inboxCount, '★注入证明★：去掉去重后收件箱出现 5 条（A04-01 的判据「=== 1」因此不成立）').toBe(5);
    expect(inboxCount === 1, '★注入证明★：A04-01 在注入下**确实变红**（否则该断言不可证伪）').toBe(false);
    expect(
      payload?.[RETRY_PAYLOAD_KEY],
      '★注入证明★：A04-06 在注入下变红（落库 payload 被最后一次重试覆盖）',
    ).toBe(5);
    expect(
      workItemCount,
      'R15 实证：即使完全不去重，工作项也只剩 1 项 ⇒ A04-02 恒真，不得作为通过判据',
    ).toBe(1);
  });

  it('I-A04-2「按内容去重」→ 对照 A04-C 变红（证明对照组有真实约束力）', () => {
    const h = new A04Harness({ defect: 'content_dedup', idSeed: 'a04-defect-content-dedup' });
    h.deliver(h.makeRequest({ message_id: MID, request_id: RID, content: CONTENT, at: h.clock.time }));

    h.clock.advance(1, '注入-对照投递');
    const outcome = h.deliver(
      h.makeRequest({ message_id: MID_CTRL, request_id: RID_CTRL, content: CONTENT, at: h.clock.time }),
    );
    const snap = h.snapshot();
    eventSources.push({ name: '注入-I-A04-2-content_dedup', harness: h });

    expect(h.defect, '注入配置为 content_dedup（注入确实生效）').toBe('content_dedup');
    expect(outcome.result, '★注入证明★：按内容去重时 m-a04-02 被误判为重复 → A04-C-04 变红').toBe('duplicate_not_created');
    expect(
      new Set(snap.inbox_entries.map((e) => e.message_id)).size,
      '★注入证明★：按内容去重时收件箱唯一 id 数仍为 1 → A04-C-01 变红',
    ).toBe(1);
    expect(snap.work_items.length, '★注入证明★：按内容去重时工作项只有 1 项 → A04-C-02 / A04-C-03 变红').toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 证据落盘（规格 0.7：JSON，非仅终端最后一句 PASS）
// ---------------------------------------------------------------------------

interface AssertionRecord {
  readonly id: string;
  readonly role: 'main' | 'weak' | 'support';
  readonly statement: string;
  readonly observed: unknown;
}

function buildAssertionList(): AssertionRecord[] {
  const records: AssertionRecord[] = [];
  for (const observation of observations) {
    const { harness: h, kind, attempts } = observation;
    const label = `变体${kind}`;
    const snap = h.snapshot();
    const item = snap.work_items.find((w) => w.request_id === (RID as RequestId));
    const stored = snap.messages.find((m) => m.message_id === (MID as MessageId));
    const payload = stored?.payload as Record<string, unknown> | undefined;
    const counters = h.counters();
    records.push(
      { id: `${label}.A04-01`, role: 'main', statement: '收件箱中 m-a04-01 恰好 1 条', observed: h.inboxEntryCount(MID) },
      { id: `${label}.A04-01b`, role: 'main', statement: 'C 的收件箱总条数恰好 1 条', observed: h.inboxOfC().length },
      { id: `${label}.A04-02`, role: 'weak', statement: 'r-a04-01 的工作项恰好 1 项（R15 弱证据）', observed: h.workItemCount(RID) },
      { id: `${label}.A04-03`, role: 'support', statement: 'r-a04-01 被读入的轮次数 = 1', observed: h.runsReading(RID).length },
      { id: `${label}.A04-04`, role: 'support', statement: '投递三值分布', observed: {
          accepted: attempts.filter((a) => a.result === 'accepted').length,
          duplicate_not_created: attempts.filter((a) => a.result === 'duplicate_not_created').length,
          failed: attempts.filter((a) => a.result === 'failed').length,
        } },
      { id: `${label}.A04-05`, role: 'support', statement: 'r-a04-01 终态 completed 且带结果引用', observed: { status: item?.status, result_refs: item?.result_refs.length } },
      { id: `${label}.A04-06`, role: 'main', statement: '落库 payload.attempt / created_at 仍是首次那份', observed: { payload_attempt: payload?.[RETRY_PAYLOAD_KEY], created_at: stored?.created_at, first_step: attempts[0]?.step } },
      { id: `${label}.A04-07`, role: 'support', statement: '去重阶段 run_count', observed: observation.dedup_phase_run_count },
      { id: `${label}.R19.event`, role: 'support', statement: '事件侧 6 项（summarizeKernelEvents）', observed: counters.event },
      { id: `${label}.R19.snapshot`, role: 'support', statement: '快照侧 2 项（summarizeSnapshotCounters）', observed: counters.snapshot },
    );
  }
  if (control !== null) {
    const snap = control.harness.snapshot();
    records.push(
      { id: 'A04-C-01', role: 'main', statement: '收件箱唯一 message_id 数 = 2', observed: new Set(snap.inbox_entries.map((e) => e.message_id)).size },
      { id: 'A04-C-02', role: 'main', statement: '工作承诺表唯一 request_id 数 = 2', observed: snap.work_items.length },
      { id: 'A04-C-04', role: 'main', statement: 'm-a04-02 返回 accepted', observed: control.accept_result },
      { id: 'A04-C-03/05', role: 'support', statement: '两项工作未合并、各有独立结局与不交叉的结果引用', observed: snap.work_items.map((w) => ({ request_id: w.request_id, status: w.status, result_refs: w.result_refs, triggering_message_ids: w.triggering_message_ids })) },
      { id: 'A04-C.run_count', role: 'support', statement: '对照场景总轮次数 = 2', observed: control.run_count },
    );
  }
  return records;
}

/**
 * 构造 A04 的两份产物（JSON 汇总 + JSONL 事件流）——**不决定目录**（G05 / R46.1）。
 *
 * 身份由发布器在同一次计算里给出并入戳，落盘位置由该身份决定，因此"产物里的身份"与
 * "产物落在哪个目录"不可能不一致（R46.1）；JSON 与 JSONL 必然同目录（R46.2）。
 */
function buildA04Artifacts(identity: EvidenceIdentityStamp): readonly EvidenceArtifact[] {
  const evidence = {
    task: 'D08',
    scenario: 'A04',
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
    is_isolated_per_scenario: true,
    deviation: '对照 A04-C 用独立实例承载（规格原文排在变体甲之后、同一实例继续投递）；语义等价且避免污染变体甲的守恒观测。',
    variants: observations.map((o) => ({
      kind: o.kind,
      dedup_phase_run_count: o.dedup_phase_run_count,
      attempts: o.attempts,
      retry_markers: o.retry_markers,
      counters: o.harness.counters(),
      inbox_entries: o.harness.snapshot().inbox_entries,
      work_items: o.harness.snapshot().work_items.map((w) => ({
        request_id: w.request_id,
        status: w.status,
        result_refs: w.result_refs,
        triggering_message_ids: w.triggering_message_ids,
      })),
      runs: o.harness.snapshot().runs.map((r) => ({
        run_id: r.run_id,
        frozen_input_message_ids: r.frozen_input_message_ids,
        frozen_request_ids: r.frozen_request_ids,
      })),
    })),
    control_a04_c: control === null ? null : {
      accept_result: control.accept_result,
      content_fingerprints: { first: control.first_fingerprint, second: control.second_fingerprint },
      run_count: control.run_count,
      inbox_message_ids: [...new Set(control.harness.snapshot().inbox_entries.map((e) => e.message_id))],
      work_items: control.harness.snapshot().work_items.map((w) => ({
        request_id: w.request_id,
        status: w.status,
        result_refs: w.result_refs,
        triggering_message_ids: w.triggering_message_ids,
      })),
    },
    assertions: buildAssertionList(),
    main_judgments: [
      'A04-01 / A04-01b（收件箱恰好 1 条）：唯一能击穿「去重缺失」的断言',
      'A04-06（同 id 重复送达不覆盖首次到达记录：payload / created_at 仍是首次那份）',
      'A04-C-01 / A04-C-02 / A04-C-04：对照组的独立性',
    ],
    weak_judgments: ['A04-02（工作项恰好 1 项）：R15 明示为弱证据，去重缺失时仍为真'],
    defect_injections: [
      { id: 'I-A04-1', name: 'no_dedup', breaks: ['A04-01', 'A04-01b', 'A04-06'] },
      { id: 'I-A04-2', name: 'content_dedup', breaks: ['A04-C-01', 'A04-C-02', 'A04-C-03', 'A04-C-04'] },
    ],
  };

  // 规格 0.7：原始事件序列（JSONL）与汇总记录两个文件。事件流本身不含墙钟，逐字节确定。
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
    { file_name: 'a04-evidence.json', content: `${JSON.stringify(evidence, null, 2)}\n` },
    { file_name: 'a04-events.jsonl', content: `${lines.join('\n')}\n` },
  ];
}

afterAll(() => {
  // G05 / R46.1–R46.4：落盘位置由**身份**决定（不再写死 `docs/other/evidence/D08/`）。
  // 复算与登记冻结点（含配置摘要）匹配 ⇒ 正式目录；不匹配 ⇒ `.dev-evidence/{登记冻结点}/`，
  // `docs/other/evidence/**` 一个字节也不碰（R46.3 / R46.4）。
  writeEvidenceArtifacts(buildA04Artifacts);
});
