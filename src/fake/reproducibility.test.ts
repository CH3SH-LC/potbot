import { writeEvidenceArtifacts } from '../../tests/acceptance/freeze-identity.js';

import { describe, expect, it } from 'vitest';

import { LogicalClock, leaseDeadline } from '../clock/index.js';
import {
  DEFAULT_LEASE_TTL,
  asGroupId,
  asInstanceId,
  asMessageId,
  asRunId,
  createInstanceState,
  summarizeKernelEvents,
  type InstanceState,
  type KernelEvent,
  type EventCounters,
} from '../protocol/index.js';
import { canonicalJson } from './digest.js';
import {
  ActivitySnapshotSampler,
  Barrier,
  BlockPointSet,
  EventRecorder,
  ReproducibilityError,
  SchedulerAdvanceSeam,
  SeededOrder,
  assertReproducible,
  checkReproducible,
  windowDelta,
  type SnapshotSample,
  type WindowDelta,
} from './index.js';

const INSTANCE_C = asInstanceId('C');
const GROUP_G1 = asGroupId('G1');

/**
 * 端到端夹具演示：把本目录的器件串成一个 **A02 形状 + A03 形状**的确定性场景。
 *
 * 边界声明：这里的「调度器」是**假内核桩**，只表达「一次调度决策点」的形状并发出
 * **内核原生的 `KernelEvent`**（Q10-b）；它不含任何真实调度语义（那是 D03 的职责），
 * 因此本测试**不构成 A02/A03 的验收证据**。
 *
 * 计数口径（合同 v1.1 R4）：**峰值/轮次等计数一律读 D01 的 `summarizeKernelEvents`**，
 * 本文件不含任何自算 peak 的代码。
 */
interface FixtureResult {
  readonly jsonl: string;
  readonly artifact: string;
  readonly counters: EventCounters;
  readonly events: readonly KernelEvent[];
  readonly runs: number;
  readonly deliveries: number;
  readonly first_snapshot: readonly string[];
  readonly second_snapshot: readonly string[];
  readonly block_point_run_ids: Readonly<Record<string, readonly string[]>>;
  readonly seam_records: readonly number[];
  readonly samples: readonly SnapshotSample[];
  readonly window: WindowDelta;
}

async function runFixture(): Promise<FixtureResult> {
  // 固定种子 + 固定调度顺序；事件序列里不含任何墙钟时间戳。
  const clock = new LogicalClock();
  const recorder = new EventRecorder({
    scenario: 'D06-demo-A02+A03-shape',
    seed: 'fixed-order',
    schedule: [
      'B-deliver: 4 条投递同时起跑',
      'R1 显式推进 → run-1 冻结快照',
      'run-1 停在 P-block-1；期间投递 3 条',
      '放行 P-block-1 → run-1 结束',
      'R2 显式推进 → run-2 冻结快照',
      'run-2 停在 P-block-2 → 放行',
      '空推进若干次',
    ],
    revision: 'working-tree',
  });

  const seam = new SchedulerAdvanceSeam(clock);
  const barrier = new Barrier(4);
  const blocks = new BlockPointSet();
  const sampler = new ActivitySnapshotSampler();
  const order = new SeededOrder('D06-demo');
  const permutation = order.permutation(4); // 有状态：一次场景内只取一次

  const pending: string[] = [];
  const snapshots: string[][] = [];
  let runs = 0;
  // 假内核桩自持的实例状态（只用于演示「只读快照采样」的 API，不是 A02 证据）。
  let instanceState: InstanceState = createInstanceState({
    instance_id: INSTANCE_C,
    group_id: GROUP_G1,
    updated_at: clock.now(),
  });

  const frozenAt = (): readonly string[] => snapshots[snapshots.length - 1] ?? [];

  seam.bind(async () => {
    if (pending.length === 0) {
      return { startedRuns: 0, detail: '无可运行输入' };
    }
    const snapshot = [...pending].sort();
    pending.length = 0;
    snapshots.push(snapshot);
    runs += 1;
    const runId = asRunId(`run-${String(runs)}`);
    const blockName = `P-block-${String(runs)}`;
    recorder.record({
      kind: 'run_started',
      at: clock.now(),
      instance_id: INSTANCE_C,
      run_id: runId,
      data: { snapshot },
    });
    instanceState = createInstanceState({
      instance_id: INSTANCE_C,
      group_id: GROUP_G1,
      updated_at: clock.now(),
      activity: 'active',
      active_run_id: runId,
      queued_flag: false,
      // 租约时长取自 protocol 的默认值（不另立常量）。
      lease_deadline: leaseDeadline(clock.now(), DEFAULT_LEASE_TTL),
    });

    // 模拟延迟 = 推进逻辑时间（不是 sleep）；随后假 Agent 停在阻塞点等夹具放行。
    clock.advance(2, `${runId} 轮内延迟`);
    await blocks.point(blockName).wait({
      run_id: runId,
      instance_id: INSTANCE_C,
      at: clock.now(),
    });

    recorder.record({
      kind: 'run_finished',
      at: clock.now(),
      instance_id: INSTANCE_C,
      run_id: runId,
      data: { handled: snapshot.length },
    });
    instanceState = createInstanceState({
      instance_id: INSTANCE_C,
      group_id: GROUP_G1,
      updated_at: clock.now(),
      activity: 'idle',
      active_run_id: null,
      queued_flag: pending.length > 0,
    });
    return { startedRuns: 1, detail: `${String(snapshot.length)} 条输入` };
  });

  /** 一次投递：登记到接缝 + 发出 `message_accepted` 事件。 */
  const deliver = (messageId: string, index: number): void => {
    pending.push(messageId);
    seam.noteDeliveryCommit({
      message_id: asMessageId(messageId),
      recipient_instance_id: INSTANCE_C,
      sender_instance_id: asInstanceId(`S${String(index)}`),
      label: messageId,
    });
    recorder.record({
      kind: 'message_accepted',
      at: clock.now(),
      instance_id: INSTANCE_C,
      message_id: asMessageId(messageId),
      data: { sender: `S${String(index)}` },
    });
  };

  /** 排队标记置位事件（3 条后到消息只对应**一个**排队标记，但事件可以有 3 条）。 */
  const queueEnqueued = (messageId: string): void => {
    recorder.record({
      kind: 'delegation_queue_enqueued',
      at: clock.now(),
      instance_id: INSTANCE_C,
      message_id: asMessageId(messageId),
    });
  };

  // ── 阶段 1：4 条并发投递（B-deliver），全部在任何推进之前 ──
  const senders = ['S1', 'S2', 'S3', 'S4'];
  await Promise.all(
    senders.map(async (name, index) => {
      await barrier.arrive();
      deliver(`m-${String(index + 1)}`, index + 1);
      expect(name).toBe(`S${String(index + 1)}`);
    }),
  );
  seam.assertAllDeliveriesBefore(0);

  // ── 放行点 R1：唯一一轮；快照应含全部 4 条 ──
  clock.advance(1, 'R1');
  const advancing1 = seam.advanceOnce('R1');
  const arrival1 = await blocks.arrived('P-block-1');
  expect(arrival1.run_id).toBe('run-1');
  const firstSnapshot = frozenAt();

  // ── 阶段 2：轮次活动期间投递 3 条（A03 形状）──
  for (const [index, messageId] of ['m-5', 'm-6', 'm-7'].entries()) {
    deliver(messageId, index + 1);
    queueEnqueued(messageId);
  }
  // 只读快照采样（瞬时值；不是峰值——峰值口径归 protocol 的 summarizeKernelEvents）
  const duringRun = sampler.sampleStates([instanceState], clock.now());
  blocks.release('P-block-1');
  await advancing1;

  // ── 放行点 R2：后到的 3 条进入下一轮快照 ──
  clock.advance(1, 'R2');
  const advancing2 = seam.advanceOnce('R2');
  const arrival2 = await blocks.arrived('P-block-2');
  expect(arrival2.run_id).toBe('run-2');
  const secondSnapshot = frozenAt();
  blocks.release('P-block-2');
  await advancing2;

  // ── 空推进：确认无新轮次；随后做「等待窗口」的第二次采样 ──
  clock.advance(1, 'R3');
  const idleRecords = await seam.advanceUntilIdle(4, 'R3');
  const afterIdle = sampler.sampleStates([instanceState], clock.now());

  const counters = recorder.counters();
  const window = windowDelta(sampler, duringRun.index, afterIdle.index);
  const artifact = canonicalJson({
    scenario: 'D06-demo-A02+A03-shape',
    seed: 'fixed-order',
    revision: 'working-tree',
    recorder_meta: recorder.meta,
    clock: clock.state(),
    advances: clock.advances,
    seam_records: seam.records,
    deliveries: seam.deliveries,
    block_points: blocks.snapshot(),
    // 计数口径的**唯一权威实现**是 protocol 的 summarizeKernelEvents（R4）。
    counters,
    snapshot_samples: sampler.samples,
    window_delta: window,
    recorder_summary: recorder.summary(),
    permutation,
    idle_steps: idleRecords.length,
    first_snapshot: firstSnapshot,
    second_snapshot: secondSnapshot,
    notes: [
      'counters 由 src/protocol 的 summarizeKernelEvents 从事件流算出（D06 不自算峰值，合同 v1.1 R4）',
      'peak_active_runs / peak_queued_flags 为 A02-01 / A02-10 的判据来源',
      '本场景的「调度器」是假内核桩，不构成 A02/A03 的验收证据',
    ],
  });

  return {
    jsonl: recorder.toJSONL(),
    artifact,
    counters,
    events: recorder.events,
    runs,
    deliveries: seam.deliveries.length,
    first_snapshot: firstSnapshot,
    second_snapshot: secondSnapshot,
    block_point_run_ids: Object.fromEntries(
      Object.entries(blocks.snapshot()).map(([name, snapshot]) => [name, snapshot.run_ids]),
    ),
    seam_records: seam.records.map((record) => record.startedRuns),
    samples: sampler.samples,
    window,
  };
}

describe('可复现性检查：同一场景跑两次逐字节一致', () => {
  it('端到端夹具跑两次 → 事件序列与观测快照都逐字节一致，并落盘机器可读证据', async () => {
    const eventReport = await checkReproducible(async () => (await runFixture()).jsonl, 2);
    const artifactReport = await checkReproducible(async () => (await runFixture()).artifact, 2);
    const first = await runFixture();

    // R46.1（G05）：落盘目录由**证据发布器**决定——frozen ⇒ `docs/other/evidence/{freeze_id}/`，
    // 否则 `.dev-evidence/{freeze_id}/`。开发期产物**不再**覆写 `docs/other/evidence/D06/` 的历史证据。
    // JSONL 与 JSON **同一目录**（R46.2）；两份内容逐字节保持原样（本文件正是"逐字节一致"判据）。
    const outcome = writeEvidenceArtifacts(() => [
      { file_name: 'demo-events.jsonl', content: first.jsonl },
      { file_name: 'demo-observation.json', content: `${first.artifact}\n` },
    ]);
    expect(outcome.written).toHaveLength(2);

    // 原始输出（交付报告直接引用本段）。
    console.log('[D06 可复现性演示] 事件序列 JSONL（第 1 次运行，原样）：');
    console.log(first.jsonl.trimEnd());
    console.log(`[D06 可复现性演示] digest(事件,第1次)=${eventReport.digests[0]}`);
    console.log(`[D06 可复现性演示] digest(事件,第2次)=${eventReport.digests[1]}`);
    console.log(`[D06 可复现性演示] digest(观测快照)=${artifactReport.digests[0]}`);
    console.log(
      `[D06 可复现性演示] identical(事件)=${String(eventReport.identical)} identical(观测)=${String(artifactReport.identical)}`,
    );
    console.log(`[D06 可复现性演示] 事件条数=${eventReport.lineCounts.join(' / ')}`);
    console.log(`[D06 可复现性演示] counters=${JSON.stringify(first.counters)}`);
    console.log(`[D06 可复现性演示] 窗口增量=${JSON.stringify(first.window)}`);

    expect(eventReport.identical).toBe(true);
    expect(artifactReport.identical).toBe(true);
    expect(() => assertReproducible(eventReport)).not.toThrow();
    expect(() => assertReproducible(artifactReport)).not.toThrow();
  });

  it('A02 形状：全部投递早于第一次冻结 → 唯一一轮的快照含全部 4 条', async () => {
    const result = await runFixture();
    expect(result.deliveries).toBe(7);
    expect(result.first_snapshot).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(result.seam_records).toEqual([1, 1, 0]);
  });

  it('A03 形状：冻结后到达的 3 条进入**下一轮**快照，且没有第三轮', async () => {
    const result = await runFixture();
    expect(result.second_snapshot).toEqual(['m-5', 'm-6', 'm-7']);
    expect(result.runs).toBe(2);
  });

  it('计数口径来自 D01 的 summarizeKernelEvents（D06 不自算峰值）', async () => {
    const result = await runFixture();
    // 反重复实现守卫：记录器给出的计数必须**逐字等于**把同一事件流喂给 protocol 的实现。
    expect(result.counters).toEqual(summarizeKernelEvents(result.events));
    // 这个口径算出的值直接就是 A02-01 / A02-10 的判据来源（D01 已按 R4 修好静默零值）：
    expect(result.counters.run_count).toBe(2);
    expect(result.counters.peak_active_runs).toBe(1); // 峰值活动轮次 ≤ 1
    expect(result.counters.peak_queued_flags).toBe(1); // 3 条入队事件只对应一个布尔标记
    expect(result.counters.rejected_publication_count).toBe(0);
    expect(result.counters.diagnosis_count).toBe(0);
    expect(result.counters.inbox_message_count).toBe(7);
    // 事件流里确实有 2 次启动 / 2 次结束 / 3 次入队（峰值口径的输入材料）。
    const kinds = result.events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'run_started')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'run_finished')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'delegation_queue_enqueued')).toHaveLength(3);
  });

  it('阻塞点的到达带 run 身份归属（A03-07 的归属证据）', async () => {
    const result = await runFixture();
    expect(result.block_point_run_ids).toEqual({
      'P-block-1': ['run-1'],
      'P-block-2': ['run-2'],
    });
  });

  it('只读快照采样给出瞬时活动态与「窗口内不增长」判据（A05-07 / A05-08）', async () => {
    const result = await runFixture();
    expect(result.samples).toHaveLength(2);
    // run-1 活动期间：活动轮次 = 1
    expect(result.samples[0]).toMatchObject({ index: 1, active_runs: 1, queued_flags: 0 });
    expect(result.samples[0]?.per_instance['C']).toEqual({ active_runs: 1, queued_flag: false });
    // 收尾后：活动轮次 = 0
    expect(result.samples[1]).toMatchObject({ index: 2, active_runs: 0, queued_flags: 0 });
    // 窗口内没有增长（等待窗口释放执行槽）
    expect(result.window).toEqual({
      from_index: 1,
      to_index: 2,
      active_runs_delta: -1,
      queued_flags_delta: 0,
      flat: true,
    });
  });

  it('能检测出不一致：把运行序号漏进证据 → 判为不可复现并定位到行', async () => {
    const report = await checkReproducible((run) => `${JSON.stringify({ run, kind: 'leaked' })}\n`, 2);
    expect(report.identical).toBe(false);
    expect(report.divergentRun).toBe(2);
    expect(report.firstDivergentLine).toBe(1);
    expect(report.expectedLine).toBe('{"run":1,"kind":"leaked"}');
    expect(report.actualLine).toBe('{"run":2,"kind":"leaked"}');
    expect(() => assertReproducible(report)).toThrow(ReproducibilityError);
  });

  it('单次运行无法证明可复现 → 显式抛错', async () => {
    await expect(checkReproducible(() => '', 1)).rejects.toThrow(ReproducibilityError);
  });

  it('行数不同也能定位分歧', async () => {
    const report = await checkReproducible((run) => (run === 1 ? 'a\nb\n' : 'a\n'), 2);
    expect(report.identical).toBe(false);
    expect(report.lineCounts).toEqual([2, 1]);
    expect(report.firstDivergentLine).toBe(2);
    expect(report.expectedLine).toBe('b');
    expect(report.actualLine).toBeNull();
  });

  it('落盘的证据含可复现所需的观测项（R3 的最小集）', async () => {
    const result = await runFixture();
    for (const field of [
      '"seed":"fixed-order"',
      '"run_count":2',
      '"schedule"',
      '"counters"',
      '"block_points"',
      '"permutation"',
      '"revision":"working-tree"',
    ]) {
      expect(result.artifact).toContain(field);
    }
    expect(result.jsonl.length).toBeGreaterThan(0);
  });
});

/**
 * 受控缺陷注入的可证伪性演示（合同 v1.1 R7：每条关键断言至少要能真的变红一次）。
 *
 * 注入形态是**「重复启动」**（验收规格 1.7 的 I-A02-1）：同一个实例同时活动两个轮次。
 * 注入只发生在**本测试自己构造的事件流**上——不碰任何共享源码、不改内核实现。
 */
describe('受控缺陷注入：证明「峰值活动轮次 ≤ 1」这条断言真的可被击穿', () => {
  /** A02-01 的判据形态（与 D07 将要写的一致）。 */
  const peakAtMostOne = (counters: EventCounters): boolean => counters.peak_active_runs <= 1;

  function eventsFor(duplicateStart: boolean): EventRecorder {
    const clock = new LogicalClock();
    const recorder = new EventRecorder({ seed: duplicateStart ? 'inject-dup' : 'clean' });
    const first = asRunId('run-1');
    recorder.record({ kind: 'run_started', at: clock.now(), instance_id: INSTANCE_C, run_id: first });
    if (duplicateStart) {
      // 注入：本该被原子操作挡住的第二次启动，挤了进来
      recorder.record({
        kind: 'run_started',
        at: clock.now(),
        instance_id: INSTANCE_C,
        run_id: asRunId('run-2-重复启动'),
      });
    }
    clock.advance(1, '轮次结束');
    recorder.record({ kind: 'run_finished', at: clock.now(), instance_id: INSTANCE_C, run_id: first });
    if (duplicateStart) {
      recorder.record({
        kind: 'run_finished',
        at: clock.now(),
        instance_id: INSTANCE_C,
        run_id: asRunId('run-2-重复启动'),
      });
    }
    return recorder;
  }

  it('无注入时判据为真；注入后同一条判据为假（并给出峰值 = 2 的依据）', () => {
    const clean = eventsFor(false).counters();
    expect(clean.run_count).toBe(1);
    expect(peakAtMostOne(clean)).toBe(true);

    const injected = eventsFor(true).counters();
    expect(injected.run_count).toBe(2);
    // 峰值口径如实报出 2（不是靠「少算」掩盖）——这正是 A02-01 要击穿的东西
    expect(injected.peak_active_runs).toBe(2);
    expect(peakAtMostOne(injected)).toBe(false);
  });

  it('注入只活在隔离构造的事件流里，不触碰共享源码（默认可复现）', () => {
    // 同一注入场景跑两次仍然逐字节一致：注入本身也是确定性的
    return checkReproducible(() => eventsFor(true).toJSONL(), 2).then((report) => {
      expect(report.identical).toBe(true);
    });
  });
});
