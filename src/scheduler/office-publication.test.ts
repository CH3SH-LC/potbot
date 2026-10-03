/**
 * **经公开入口交付产物**的调度侧集成单测（design-02 A 批 / 合同 v1.4 R49.1 / R50）。
 *
 * ## 这个文件为什么存在
 *
 * `src/artifacts/publish.test.ts`（W-E）与 `tests/acceptance/office/v3-publish-independent.test.ts`（V3）
 * 证明的是**发布投影**本身（它们手工造 `StagedArtifactFact` 再喂投影）。
 * 本文件的被测对象是**另一条链**：`onMessage` → `startRun` → `finishRun` 这条**公开入口**
 * 究竟有没有把"Agent 的产物意图"接成"已提交的 staged 记录 + 工作项 result_refs + 提交后物化"。
 * 因此这里**不手工造 staged 事实**（那会绕过被测接线），只经公开入口驱动。
 *
 * ## 夹具的形状（与 `repair-batch.test.ts` 同风格）
 *
 * - **真实 store**：`buildStore()`（`createMemoryStore`，含 `faults` 接缝）；
 * - **真实 scheduler**：`createScheduler`（与 `buildScheduler` 同装配，只是多套了一层事务探针）；
 * - **真实落盘端口**：复用 W-F1 的 `FsArtifactMaterializationPort`（写系统临时目录），
 *   外面再包一层**记录调用时序的假端口**——它记下每次回调时的事务嵌套深度与"回调时已提交的产物记录数"。
 * - 事实用 `tx.putSharedFact(...)` 登记（真实 `SharedFactRecord`，不经任何捷径）。
 *
 * ## 七条判据（每条都能失败）
 *
 * | # | 判据 |
 * |---|---|
 * | 1 | 暂存与工作项**同事务**；Agent 自报的 `result_refs` 被内核产物 id 覆盖（另有"提交前失败 ⇒ 两者都不在"的原子性反证） |
 * | 2 | 未注入 `artifact_root_dir` ⇒ 结构化拒绝 `artifact_root_dir_unset`，零产物记录、零写盘，其余发布不受影响 |
 * | 3 | 事实缺失 / 未知 ⇒ 拒绝 `missing_fact`，无产物文件，工作项结局不是"已完成" |
 * | 4 | 提交后投影：`published` + 回执 `readback_digest === content_digest`（I-1），且端口回调在**任何事务之外** |
 * | 5 | 不注入端口 ⇒ 停在 `staged`（`isDeliveredArtifact === false` / `receipt === null`，I-4），盘上无文件 |
 * | 6 | 同一任务同一种类发布两次 ⇒ 版本 1 与 2、id 不同、**旧文件仍在**（未被覆盖） |
 * | 7 | 一次 `finishRun` 内两条产物 ⇒ 两条都发布，`source_fact_refs` 各指各的事实 |
 *
 * 纪律：断言用等号（`toBe` / `toEqual`）；每个用例先断言夹具确实产生了数据。
 * 本文件**不代办内核步骤**（不 `putArtifact`、不绕过 `finishRun`），**不调用** `openWithOffice`。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asLogicalTime,
  asRevision,
  createIdSource,
  createSharedFactRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  type ArtifactRecord,
  type DeliveryHandler,
  type EventId,
  type LogicalTime,
  type MutableStoreFaultHooks,
  type PendingEvent,
  type RequestId,
  type StorageTransaction,
  type Store,
  type StoreSnapshot,
  type TaskId,
} from '../protocol/index.js';
import {
  createFsArtifactMaterializationPort,
  FS_ARTIFACT_PORT_VERIFIER,
  type FsArtifactMaterializationPort,
} from '../../tests/acceptance/office/fs-artifact-port.js';
import {
  planArtifact,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
  type ArtifactPublicationIntent,
} from '../artifacts/index.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import {
  GROUP_ID,
  INSTANCE_C,
  TASK_ID,
  buildStore,
  readTx,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';

// ---------------------------------------------------------------------------
// 夹具常量
// ---------------------------------------------------------------------------

/** 已确认事实：人数（数值 + 单位）。 */
const HEADCOUNT = asFactRef('F-headcount');
/** 已确认事实：预算合计（数值 + 单位）。 */
const BUDGET = asFactRef('F-budget');
/** Agent **自报**的结果引用——内核必须用产物 id 覆盖它。 */
const AGENT_SELF_REPORTED = asArtifactRef('agent-self-reported-placeholder');
/** 事务基准版本（`registerTask` 的默认值即 1，这里显式写出以便阅读）。 */
const REVISION_1 = asRevision(1);

// ---------------------------------------------------------------------------
// 事务深度探针（"端口回调发生在任何事务之外"的直接判据）
// ---------------------------------------------------------------------------

/**
 * 记录事务嵌套深度的存储包装：`transact` 进入 +1、退出 -1，并记下最大深度。
 *
 * 它同时是**被注入调度器的那个存储**，因此调度器的每一次 `transact`（含发布投影的段 3）
 * 都会经过这里——端口在此期间回调时读到的 `depth` 就是"当时开着几个事务"的真值。
 */
class TransactionDepthProbe implements Store {
  depth = 0;
  max_depth = 0;
  transactions = 0;

  readonly #inner: Store;

  constructor(inner: Store) {
    this.#inner = inner;
  }

  get faults(): MutableStoreFaultHooks {
    return this.#inner.faults;
  }

  transact<T>(work: (tx: StorageTransaction) => T): T {
    this.transactions += 1;
    this.depth += 1;
    this.max_depth = Math.max(this.max_depth, this.depth);
    try {
      return this.#inner.transact(work);
    } finally {
      this.depth -= 1;
    }
  }

  snapshot(): StoreSnapshot {
    return this.#inner.snapshot();
  }

  pendingDeliveryEvents(): readonly PendingEvent[] {
    return this.#inner.pendingDeliveryEvents();
  }

  markDelivered(eventIds: readonly EventId[], at?: LogicalTime): number {
    return at === undefined ? this.#inner.markDelivered(eventIds) : this.#inner.markDelivered(eventIds, at);
  }

  publishPending(handler: DeliveryHandler): readonly PendingEvent[] {
    return this.#inner.publishPending(handler);
  }

  replayUndelivered(handler: DeliveryHandler): readonly PendingEvent[] {
    return this.#inner.replayUndelivered(handler);
  }

  reset(): void {
    this.#inner.reset();
  }
}

/**
 * 记录调用时序的假端口：包住真实落盘端口，记下**每次回调时**的事务深度、
 * 以及"回调发生时存储里已提交的产物记录数"（后者证明段 1 已提交、回调不在事务体内）。
 */
class RecordingPort implements ArtifactMaterializationPort {
  readonly depths: number[] = [];
  readonly artifact_ids: string[] = [];
  readonly committed_records_at_call: number[] = [];

  readonly #probe: TransactionDepthProbe;
  readonly #inner: ArtifactMaterializationPort;
  readonly #committedCount: () => number;

  constructor(
    probe: TransactionDepthProbe,
    inner: ArtifactMaterializationPort,
    committedCount: () => number,
  ) {
    this.#probe = probe;
    this.#inner = inner;
    this.#committedCount = committedCount;
  }

  get calls(): number {
    return this.depths.length;
  }

  materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
    this.depths.push(this.#probe.depth);
    this.artifact_ids.push(request.artifact_id);
    this.committed_records_at_call.push(this.#committedCount());
    return this.#inner.materialize(request);
  }
}

// ---------------------------------------------------------------------------
// 临时目录（带重试清理：Windows 上刚写完的文件可能仍被占用 ⇒ rmSync 抛 EBUSY）
// ---------------------------------------------------------------------------

const CREATED_ROOTS: string[] = [];

function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `potbot-officepub-${label}-`));
  CREATED_ROOTS.push(dir);
  // 计划路径用 `/` 拼（planner 的纪律：路径分隔符固定 `/`，不随平台变化）。
  return dir.split('\\').join('/');
}

/** 同步小睡（测试侧的清理重试；不进入 `src/**`）。 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 递归删除（重试用尽则**打印警告并保留目录**，不掩盖、不判红）。 */
function removeWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        console.warn(
          `[office-publication] 清理临时目录失败（保留现场）：${dir} — ${String(error)}`,
        );
        return;
      }
      sleep(50);
    }
  }
}

afterEach(() => {
  for (const dir of CREATED_ROOTS.splice(0)) {
    removeWithRetry(dir);
  }
});

/** 递归列出目录下的**文件**（不存在 ⇒ 空数组）。 */
function collectFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(full));
    } else {
      found.push(full);
    }
  }
  return found;
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------
// 事实与意图夹具（Agent 只能给"意图 + 事实键"，**没有数字参数位**）
// ---------------------------------------------------------------------------

function putFacts(store: Store): void {
  readTx(store, (tx) => {
    tx.putSharedFact(
      createSharedFactRecord({
        fact_id: HEADCOUNT,
        task_id: TASK_ID,
        task_revision: REVISION_1,
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: { kind: 'user_confirmation', detail: '用户确认（W-F5 夹具）' },
        confirmed_by: INSTANCE_C,
        confirmed_at: asLogicalTime(0),
      }),
    );
    tx.putSharedFact(
      createSharedFactRecord({
        fact_id: BUDGET,
        task_id: TASK_ID,
        task_revision: REVISION_1,
        fact_key: 'budget.total',
        value: { kind: 'known', value: { type: 'number', amount: 600, unit: '元', currency: null } },
        source: { kind: 'user_confirmation', detail: '用户确认（W-F5 夹具）' },
        confirmed_by: INSTANCE_C,
        confirmed_at: asLogicalTime(0),
      }),
    );
  });
}

/** 文档意图：标题里**没有数字**（否则会被 P6 的"数字必须可指认"判据拒绝）。 */
function documentIntent(title = '季度报告', factKeys: readonly string[] = ['headcount']): ArtifactPublicationIntent {
  return {
    intent: {
      template_kind: 'document',
      requirement: { title, description: '按已确认事实生成的文档' },
      references: [],
    },
    fact_keys: factKeys,
  };
}

/** 表格意图：`lines` 只写事实键，合计由构建器在代码里算（没有"合计值"参数位）。 */
function spreadsheetIntent(factKeys: readonly string[] = ['budget.total']): ArtifactPublicationIntent {
  return {
    intent: {
      template_kind: 'spreadsheet',
      sheet: {
        sheet_name: '预算',
        label_header: '项目',
        value_header: '金额',
        unit: '元',
        lines: [{ label: '合计项', fact_key: 'budget.total' }],
        total_label: '合计',
        scale: 2,
      },
    },
    fact_keys: factKeys,
  };
}

// ---------------------------------------------------------------------------
// 基准夹具
// ---------------------------------------------------------------------------

interface Bench {
  readonly store: Store;
  readonly probe: TransactionDepthProbe;
  readonly scheduler: Scheduler;
  readonly root: string;
  readonly port: RecordingPort;
  readonly fs_port: FsArtifactMaterializationPort;
}

function makeBench(options: { with_port?: boolean; with_root?: boolean; label?: string } = {}): Bench {
  const store = buildStore();
  registerInstance(store, INSTANCE_C);
  registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION_1 });
  putFacts(store);

  const root = makeRoot(options.label ?? 'bench');
  const probe = new TransactionDepthProbe(store);
  const fsPort = createFsArtifactMaterializationPort({
    // 版本闸门的唯一读口：**当前**任务版本（读不到任务 ⇒ null，不猜默认版本）。
    read_revision: (taskId: TaskId) =>
      store.snapshot().tasks.find((task) => task.task_id === taskId)?.revision ?? null,
    now: () => asLogicalTime(0),
  });
  const port = new RecordingPort(probe, fsPort, () => snapshotArtifacts(store.snapshot()).length);

  const scheduler = createScheduler(probe, {
    // 与 `buildScheduler` 同装配：确定性 id 源 + 任务身份兜底。
    idSource: createIdSource(),
    default_task_id: TASK_ID,
    ...(options.with_root === false ? {} : { artifact_root_dir: root }),
    ...(options.with_port === false ? {} : { artifacts: { port } }),
  });

  return { store, probe, scheduler, root, port, fs_port: fsPort };
}

/** 只读：某工作项的 `status` / `result_refs`（断言只经快照读）。 */
function workItemOf(
  store: Store,
  request: RequestId,
): { readonly status: string; readonly result_refs: readonly string[] } | undefined {
  const item = store.snapshot().work_items.find((candidate) => candidate.request_id === request);
  return item === undefined ? undefined : { status: item.status, result_refs: item.result_refs };
}

/** 从"某条发布被应用"的结局里取出唯一产物记录（夹具自检：必须有且只有一条）。 */
function onlyArtifact(store: Store): ArtifactRecord {
  const records = snapshotArtifacts(store.snapshot());
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    throw new Error('夹具错误：产物记录缺失');
  }
  return record;
}

/** 跑一轮：投递一条工作请求 → 启动轮次 → 以给定发布收尾。返回 run_id 与结束结果。 */
function runOnce(
  bench: Bench,
  n: number,
  publications: Parameters<Scheduler['finishRun']>[0]['publications'],
): { readonly run_id: string; readonly finish: ReturnType<Scheduler['finishRun']> } {
  const delivered = bench.scheduler.onMessage(workRequest(n));
  expect(delivered.result).toBe('accepted');
  const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
  expect(started.started).toBe(true);
  const runId = started.run?.run_id;
  if (runId === undefined) {
    throw new Error('夹具错误：轮次未启动');
  }
  const finish = bench.scheduler.finishRun({ run_id: runId, publications });
  return { run_id: runId, finish };
}

// ---------------------------------------------------------------------------
// 判据 1 —— 暂存与工作项**同事务**，Agent 自报的 result_refs 被内核产物 id 覆盖
// ---------------------------------------------------------------------------

describe('判据 1：产物暂存与工作项 result_refs 同事务提交，且 result_refs 由内核产物 id 决定', () => {
  it('Agent 乱报 result_refs ⇒ 最终写进工作项的是内核产物 id', () => {
    const bench = makeBench({ with_port: false, label: 'c1' });
    // 夹具自检：事实确实登记了（否则 missing_fact 会让本用例失败在别处）。
    readTx(bench.store, (tx) => {
      expect(tx.listSharedFacts().map((fact) => fact.fact_key)).toEqual(['headcount', 'budget.total']);
    });

    const { finish } = runOnce(bench, 1, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        // **乱报**：Agent 自称产出了这个引用。它不得出现在最终结果里。
        result_refs: [AGENT_SELF_REPORTED],
        artifact: documentIntent(),
      },
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);
    expect(finish.rejected_publications).toEqual([]);
    expect(finish.artifact_facts).toHaveLength(1);

    // 夹具自检：存储里确实产生了产物记录（否则下面的覆盖断言会"空集通过"）。
    const record = onlyArtifact(bench.store);
    expect(record.artifact_id).toBe(finish.artifact_facts[0]?.record.artifact_id);

    const item = workItemOf(bench.store, requestId('r-1'));
    expect(item?.status).toBe('completed');
    // **覆盖**：最终 result_refs 是内核给的产物 id，不是 Agent 自报的那个。
    expect(item?.result_refs).toEqual([record.artifact_id]);
    expect(item?.result_refs).not.toContain(AGENT_SELF_REPORTED);
    expect(item?.result_refs.includes(AGENT_SELF_REPORTED)).toBe(false);
  });

  it('原子性反证：提交前失败 ⇒ 产物记录与工作项 result_refs 一起不存在（同事务的硬证据）', () => {
    const bench = makeBench({ with_port: false, label: 'c1-atomic' });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    const runId = started.run?.run_id ?? ('' as never);
    // 启动已经提交：工作项此刻是 processing，且**还没有**任何产物记录。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');

    let injected = false;
    bench.store.faults.beforeCommit = (): void => {
      if (injected) {
        throw new Error('提交前故障注入（本次收尾事务未提交）');
      }
    };
    injected = true;
    expect(() =>
      bench.scheduler.finishRun({
        run_id: runId,
        publications: [
          {
            kind: 'completed',
            request_id: requestId('r-1'),
            result_refs: [AGENT_SELF_REPORTED],
            artifact: documentIntent(),
          },
        ],
      }),
    ).toThrow();
    injected = false;

    // 事务整体回滚：产物记录**一条都没有**（不是"有 staged 但没接上工作项"），
    // 工作项的 result_refs 也仍然为空——两者同生共死。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
    expect(bench.store.snapshot().runs.find((run) => run.run_id === runId)?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// 判据 2 —— 未注入产物根目录 ⇒ 结构化拒绝（逐条粒度）
// ---------------------------------------------------------------------------

describe('判据 2：没有 artifact_root_dir ⇒ artifact_root_dir_unset，零记录零写盘，其余发布不受影响', () => {
  it('携带 artifact 意图的那条被拒，同一次 finishRun 里的普通发布照常完成', () => {
    const bench = makeBench({ with_root: false, label: 'c2' });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(bench.scheduler.onMessage(workRequest(2)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    // 夹具自检：两项都被本轮认领（否则"逐条粒度"无从谈起）。
    expect(started.claimed_request_ids).toEqual([requestId('r-1'), requestId('r-2')]);
    const runId = started.run?.run_id ?? ('' as never);

    const finish = bench.scheduler.finishRun({
      run_id: runId,
      publications: [
        {
          kind: 'completed',
          request_id: requestId('r-1'),
          result_refs: [resultRef(requestId('r-1'))],
          artifact: documentIntent(),
        },
        {
          kind: 'completed',
          request_id: requestId('r-2'),
          result_refs: [resultRef(requestId('r-2'))],
        },
      ],
    });

    expect(finish.accepted).toBe(true);
    // 逐条粒度：只有 r-2 被应用，r-1 被结构化拒绝。
    expect(finish.applied_request_ids).toEqual([requestId('r-2')]);
    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.request_id).toBe(requestId('r-1'));
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('artifact_root_dir_unset');
    expect(finish.artifact_facts).toEqual([]);

    // 零产物记录、零端口调用、零写盘。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(bench.port.calls).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);

    // r-2 不受影响：它照常完成，且用的是它自己声明的结果引用。
    expect(workItemOf(bench.store, requestId('r-2'))?.status).toBe('completed');
    expect(workItemOf(bench.store, requestId('r-2'))?.result_refs).toEqual([resultRef(requestId('r-2'))]);
    // r-1 没被置成完成（发布被拒 ⇒ 转换根本没发生，它停在启动时认领的 processing）。
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 3 —— 缺事实 ⇒ 拒绝，不产零值产物
// ---------------------------------------------------------------------------

describe('判据 3：事实缺失 / 未知 ⇒ missing_fact，拒绝该发布且不产任何产物', () => {
  it('只登记部分事实（请求了一个没登记的键）⇒ 拒绝，无产物文件，工作项不是已完成', () => {
    const bench = makeBench({ label: 'c3' });
    const { finish } = runOnce(bench, 1, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent('季度报告', ['headcount', 'budget.missing']),
      },
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([]);
    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('missing_fact');
    expect(finish.artifact_facts).toEqual([]);

    // 不产产物记录、不调端口、不写盘 —— 也**不产零值产物**（盘上一个文件都没有）。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(bench.port.calls).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);
    // 工作项结局不是"已完成"。
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([]);
  });

  it('事实显式登记为 unknown ⇒ 同样拒绝（不得把未知当零）', () => {
    const bench = makeBench({ label: 'c3-unknown' });
    readTx(bench.store, (tx) => {
      tx.putSharedFact(
        createSharedFactRecord({
          fact_id: asFactRef('F-contingency'),
          task_id: TASK_ID,
          task_revision: REVISION_1,
          fact_key: 'contingency',
          // 未知必须带原因，且**结构上装不进数值**（P3）。
          value: { kind: 'unknown', reason: '用户尚未确认（W-F5 夹具）' },
          source: { kind: 'user_confirmation', detail: '用户确认（W-F5 夹具）' },
          confirmed_by: INSTANCE_C,
          confirmed_at: asLogicalTime(0),
        }),
      );
    });

    const { finish } = runOnce(bench, 1, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent('季度报告', ['contingency']),
      },
    ]);

    expect(finish.rejected_publications[0]?.ledger_reason).toBe('missing_fact');
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(collectFiles(bench.root)).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
  });
});

// ---------------------------------------------------------------------------
// 判据 4 —— 提交后投影：published + I-1 回读摘要 + 端口回调在事务之外
// ---------------------------------------------------------------------------

describe('判据 4：注入端口后提交后投影为 published，回执摘要 = 记录内容摘要，回调在事务外', () => {
  it('published 记录与磁盘字节一致；端口回调时事务深度为 0 且段 1 已提交', () => {
    const bench = makeBench({ label: 'c4' });
    const { finish } = runOnce(bench, 1, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [AGENT_SELF_REPORTED],
        artifact: documentIntent(),
      },
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);

    // 夹具自检：记录确实产生了，且已从 staged 推进到 published。
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('published');
    expect(isDeliveredArtifact(record)).toBe(true);
    expect(record.receipt).not.toBeNull();

    // I-1：回执摘要来自对最终路径的**实际回读**，且等于记录里的内容摘要。
    const receipt = record.receipt;
    if (receipt === null) {
      throw new Error('夹具错误：published 记录缺回执');
    }
    expect(record.content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.readback_digest).toBe(record.content_digest);
    expect(receipt.verifier).toBe(FS_ARTIFACT_PORT_VERIFIER);

    // 独立复算：自己读回最终路径再算一次摘要（不信端口自述）。
    const finalPath = resolve(receipt.final_path);
    expect(existsSync(finalPath)).toBe(true);
    expect(sha256OfFile(finalPath)).toBe(record.content_digest);

    // 端口回调的时序：只在事务之外发生过，且回调时段 1 的 staged 记录**已提交**。
    expect(bench.port.calls).toBe(1);
    expect(bench.port.artifact_ids).toEqual([record.artifact_id]);
    expect(bench.port.depths).toEqual([0]);
    expect(bench.port.committed_records_at_call).toEqual([1]);
    // 全局：整个用例里从未出现嵌套事务。
    expect(bench.probe.max_depth).toBe(1);
    expect(bench.probe.depth).toBe(0);
  });
});

/**
 * **补充证据（合同 R49.4 的"已提交但抛错"路径）**：这条路径**不在**任务的 7 条判据里，
 * 但它正是"产物记录会不会在异常路径上丢失 / 会不会假交付"的关键面，所以一并取证。
 *
 * 观察到的事实（如实记录，不代为修改实现）：
 * - 事务 1 已提交 ⇒ `staged` 记录与工作项 `result_refs` **都在**存储里；
 * - `finishRun` 以 `PublicationError` 抛出，**端口零调用、盘上零文件** ⇒ 不存在"声称交付、盘上没有"；
 * - 事务**已提交**：`staged` 记录与工作项 `result_refs` 都在（两者同事务）；
 * - 因此按合同 **R56.2a**，它**必须**照样被投影成 `published`——与预算投影同一处置。
 *   若在这里停住，`staged` 既没交付、也不在恢复路径上（重放所需的物化请求不落库，随异常丢失），
 *   等于永久搁置。这条曾被本文件按当时的观察写成"不会自动投影"，**契约补正后已改为"必须投影"**，
 *   断言同时**加强**（不只断言状态，还核对回执来自真实回读）。
 */
describe('补充：afterCommitBeforePublish（已提交但抛错）⇒ 照样投影，不得搁置 staged', () => {
  it('记录被投影为 published 且回执来自真实回读；result_refs 取内核产物 id', () => {
    const bench = makeBench({ label: 'c4-throw' });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    const runId = started.run?.run_id ?? ('' as never);

    let injected = false;
    bench.store.faults.afterCommitBeforePublish = (): void => {
      if (injected) {
        throw new Error('提交后发布前故障注入（本次事务已提交）');
      }
    };
    injected = true;
    expect(() =>
      bench.scheduler.finishRun({
        run_id: runId,
        publications: [
          {
            kind: 'completed',
            request_id: requestId('r-1'),
            result_refs: [AGENT_SELF_REPORTED],
            artifact: documentIntent(),
          },
        ],
      }),
    ).toThrow();
    injected = false;

    // 事务 1 确实提交了：产物记录与工作项 result_refs 都在（两者同事务）。
    const record = onlyArtifact(bench.store);
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([record.artifact_id]);
    expect(bench.store.snapshot().runs.find((run) => run.run_id === runId)?.status).toBe('finished');

    // R56.2a：提交了就必须投影——不得停在 staged（那等于永久搁置）。
    expect(record.status).toBe('published');
    expect(isDeliveredArtifact(record)).toBe(true);
    expect(record.receipt).not.toBeNull();
    // 回执必须来自**真实回读**，不是自造的期望值（I-1）。
    expect(record.receipt?.readback_digest).toBe(record.content_digest);
    // 外部副作用恰好发生一次，且真的写出了文件。
    expect(bench.port.calls).toBe(1);
    expect(collectFiles(bench.root)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 判据 5 —— 不注入端口 ⇒ 停在 staged（I-4）
// ---------------------------------------------------------------------------

describe('判据 5：不注入端口 ⇒ 产物停在 staged，不满足任何交付判据，盘上无文件', () => {
  it('staged 记录无回执、isDeliveredArtifact 为 false，工作项只拿到"占位引用"', () => {
    const bench = makeBench({ with_port: false, label: 'c5' });
    const { finish } = runOnce(bench, 1, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [AGENT_SELF_REPORTED],
        artifact: documentIntent(),
      },
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.artifact_facts).toHaveLength(1);

    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('staged');
    expect(isDeliveredArtifact(record)).toBe(false);
    expect(record.receipt).toBeNull();
    expect(record.failure_kind).toBeNull();

    // 计划可复算：由记录派生出的最终路径此刻**不存在**（没有任何"被误标通过"的文件）。
    const plan = planArtifact({
      task_id: record.task_id,
      task_revision: record.task_revision,
      template_kind: record.template_kind,
      artifact_version: record.artifact_version,
      root_dir: bench.root,
      expected_content_digest: record.content_digest,
    });
    expect(plan.artifact_id).toBe(record.artifact_id);
    expect(existsSync(resolve(plan.final_path))).toBe(false);
    expect(collectFiles(bench.root)).toEqual([]);
    expect(bench.port.calls).toBe(0);

    // 工作项的 result_refs 已写入该产物 id，但它**不是**交付证据（I-4 的中间态被如实上报）。
    const item = workItemOf(bench.store, requestId('r-1'));
    expect(item?.status).toBe('completed');
    expect(item?.result_refs).toEqual([record.artifact_id]);
  });
});

// ---------------------------------------------------------------------------
// 判据 6 —— 产物版本递增，旧文件仍在
// ---------------------------------------------------------------------------

describe('判据 6：同一任务同一种类发布两次 ⇒ 版本 1 与 2，id 不同，旧文件未被覆盖', () => {
  it('两次公开入口发布各自物化到不同路径，且第一次的文件保持原字节', () => {
    const bench = makeBench({ label: 'c6' });

    const first = runOnce(bench, 1, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent('季度报告'),
      },
    ]);
    expect(first.finish.applied_request_ids).toEqual([requestId('r-1')]);

    // 第二次：另一个工作项（第一个已 completed，终态不得再发布）。
    const second = runOnce(bench, 2, [
      {
        kind: 'completed',
        request_id: requestId('r-2'),
        result_refs: [resultRef(requestId('r-2'))],
        artifact: documentIntent('第二轮报告'),
      },
    ]);
    expect(second.finish.applied_request_ids).toEqual([requestId('r-2')]);

    // 夹具自检：两条产物记录都在，且都是 published。
    const records = snapshotArtifacts(bench.store.snapshot());
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === 'published')).toBe(true);
    const v1 = records[0];
    const v2 = records[1];
    if (v1 === undefined || v2 === undefined) {
      throw new Error('夹具错误：产物记录不足两条');
    }

    expect(v1.artifact_version).toBe(1);
    expect(v2.artifact_version).toBe(2);
    expect(v1.artifact_id).not.toBe(v2.artifact_id);
    expect(v1.receipt?.final_path).not.toBe(v2.receipt?.final_path);

    // 旧文件仍在，且**内容没有被覆盖**：回读摘要仍等于第一次记录的内容摘要。
    // （两次意图的标题不同 ⇒ 字节不同 ⇒ "摘要一致"确实排除了"被第二次写花"。）
    const path1 = resolve(v1.receipt?.final_path ?? '');
    const path2 = resolve(v2.receipt?.final_path ?? '');
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);
    expect(v1.content_digest).not.toBe(v2.content_digest);
    expect(sha256OfFile(path1)).toBe(v1.content_digest);
    expect(sha256OfFile(path2)).toBe(v2.content_digest);
    expect(bench.port.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 判据 7 —— 同一发布内多条产物
// ---------------------------------------------------------------------------

describe('判据 7：一次 finishRun 内的两条产物都被发布，source_fact_refs 各指各的事实', () => {
  it('文档 + 表格在同一轮收尾里各自暂存、物化、发布', () => {
    const bench = makeBench({ label: 'c7' });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(bench.scheduler.onMessage(workRequest(2)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    expect(started.claimed_request_ids).toEqual([requestId('r-1'), requestId('r-2')]);
    const runId = started.run?.run_id ?? ('' as never);

    const finish = bench.scheduler.finishRun({
      run_id: runId,
      publications: [
        {
          kind: 'completed',
          request_id: requestId('r-1'),
          result_refs: [resultRef(requestId('r-1'))],
          artifact: documentIntent('季度报告', ['headcount']),
        },
        {
          kind: 'completed',
          request_id: requestId('r-2'),
          result_refs: [resultRef(requestId('r-2'))],
          artifact: spreadsheetIntent(['budget.total']),
        },
      ],
    });

    expect(finish.accepted).toBe(true);
    expect(finish.rejected_publications).toEqual([]);
    expect(finish.applied_request_ids).toEqual([requestId('r-1'), requestId('r-2')]);
    expect(finish.artifact_facts).toHaveLength(2);

    const records = snapshotArtifacts(bench.store.snapshot());
    expect(records).toHaveLength(2);
    const doc = records.find((record) => record.template_kind === 'document');
    const sheet = records.find((record) => record.template_kind === 'spreadsheet');
    if (doc === undefined || sheet === undefined) {
      throw new Error('夹具错误：两条不同种类的产物记录未同时产生');
    }

    expect(doc.status).toBe('published');
    expect(sheet.status).toBe('published');
    // 单一来源：各自的 source_fact_refs 只能指到自己声明的事实键。
    expect(doc.source_fact_refs).toEqual([HEADCOUNT]);
    expect(sheet.source_fact_refs).toEqual([BUDGET]);
    // I-1 对两条都成立。
    expect(doc.receipt?.readback_digest).toBe(doc.content_digest);
    expect(sheet.receipt?.readback_digest).toBe(sheet.content_digest);

    // 工作项各拿自己的产物 id。
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([doc.artifact_id]);
    expect(workItemOf(bench.store, requestId('r-2'))?.result_refs).toEqual([sheet.artifact_id]);

    // 两次物化都发生在事务之外。
    expect(bench.port.calls).toBe(2);
    expect(bench.port.depths).toEqual([0, 0]);
    expect(bench.probe.depth).toBe(0);
  });
});
