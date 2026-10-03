/**
 * **V4 独立验收（task-id D02A-V4）**：从**外部证伪** design-02 A 批的**调度侧产物链路**
 * ——即 `onMessage → startRun → finishRun` 这条**公开入口**（`src/scheduler/**`，主协调者新写）
 * 究竟有没有把"Agent 的产物意图"接成"已提交的 staged 记录 + 工作项 result_refs + 提交后物化"。
 *
 * ## 本文件与别的测试的关系（为什么还要一份）
 *
 * - `src/artifacts/publish.test.ts`（W-E）与 `tests/acceptance/office/v3-publish-independent.test.ts`（V3）
 *   证的是**发布投影**本身（手工造 `StagedArtifactFact` 再喂投影）——它们**绕过**调度接线。
 * - `src/scheduler/office-publication.test.ts`（W-F5）覆盖同一接线，但那是**实现者一侧**写的用例；
 *   本文件的任务不是复述它，而是**自造反例**去证伪同一批主张。
 *
 * ## 本文件的独立性声明
 *
 * - 夹具、事务边界探针、临时目录管理**全部在本文件内自建**（不 import W-F5 的 `RecordingPort`
 *   或它的断言；`TransactionDepthProbe` 的"包一层 Store 数嵌套深度"做法也**不复用**——本文件
 *   改用**在端口回调里尝试开一个嵌套事务**的方式判定"回调时是否处于事务内"，见
 *   {@link PortCallbackTransactionProbe}）；
 * - 落盘端口复用 W-F1 的 `FsArtifactMaterializationPort`——它是**宿主实现/仪器**（R50.4 允许
 *   `node:fs` 的唯一位置），不是被测对象；**不调用** `openWithOffice`；
 * - 断言值取自本文件自己造的数（事实、标题），不读取实现者的常量清单。
 *
 * ## 八条判据（每条都能失败；对应任务书）
 *
 * | # | 判据 |
 * |---|---|
 * | 1 | 不带 `artifact` 意图 ⇒ 工作项可完成，但**零产物记录、零写盘**；带意图 ⇒ 记录出现且 `result_refs` **等于**内核产物 id（两次对照不同） |
 * | 2 | `beforeCommit` 注入抛错 ⇒ 回滚时产物记录与 `result_refs` **一起消失**；提交时两者**都在**（双向） |
 * | 3 | 未注入 `artifact_root_dir` ⇒ `artifact_root_dir_unset`，零记录零写盘，同请求的其它合法发布不受影响（逐条粒度） |
 * | 4 | 缺事实 ⇒ `missing_fact`（未登记键 + 显式 `unknown` 两种），零记录零写盘、工作项**不是**已完成 |
 * | 5 | 同任务同种类连续两次 ⇒ 版本 1/2、不同 id 与路径、**旧文件字节未被覆盖**（两个文件各自 sha256 == 各自 `content_digest`） |
 * | 6 | 提交后投影（R56.2）：`finishRun` 返回时已是 `published` 且 `receipt.readback_digest === content_digest`；端口回调期**不在任何事务内** |
 * | 7 | 未注入端口 ⇒ 停 `staged`（`isDeliveredArtifact === false` / `receipt === null`），盘上无文件（I-4） |
 * | 8 | `afterCommitBeforePublish` 抛错路径：**如实报告**实测行为（当前修订：照样投影为 `published`，且 `finishRun` 仍抛错）+ 探查是否存在公开恢复入口 |
 *
 * ## 被测修订（本轮评审期间被测对象曾并发更新，特此锁定）
 *
 * 初次实测时 `src/scheduler/scheduler.ts` 把该路径**留在 staged**；评审中途
 * （实现 mtime 2026-10-02 14:08:33、合同 v1.4 新增 R56.2a/R56.2b，合同 mtime 14:09:37）
 * 二者同时更新为"catch 里也必须投影"。本文件的断言按**当前修订**给出。
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
  PublicationError,
  snapshotArtifacts,
  type ArtifactRecord,
  type RequestId,
  type Store,
  type TaskId,
} from '../../../src/protocol/index.js';
import {
  planArtifact,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
  type ArtifactPublicationIntent,
} from '../../../src/artifacts/index.js';
import type { RunPublication } from '../../../src/scheduler/runs.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/scheduler.js';
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
} from '../../../src/scheduler/test-support.js';
import {
  createFsArtifactMaterializationPort,
  FS_ARTIFACT_PORT_VERIFIER,
  type FsArtifactMaterializationPort,
} from './fs-artifact-port.js';

// ---------------------------------------------------------------------------
// 夹具常量（Agent **只能**给意图 + 事实键，没有数字参数位）
// ---------------------------------------------------------------------------

/** 已确认事实：人数（数值 + 单位）。 */
const HEADCOUNT = asFactRef('V4-F-headcount');
/** 已确认事实：预算合计。 */
const BUDGET_TOTAL = asFactRef('V4-F-budget');
/** 显式登记为 `unknown` 的事实（判据 4 的第二种）。 */
const CONTINGENCY = asFactRef('V4-F-contingency');
/** Agent **自称**的结果引用——内核必须用产物 id 覆盖它。 */
const AGENT_CLAIM = asArtifactRef('V4-agent-self-claimed');
/** 基准任务版本（与 `registerTask` 默认值一致，显式写出便于阅读）。 */
const REVISION_1 = asRevision(1);

// ---------------------------------------------------------------------------
// 事务边界探针（**与 W-F5 不同**：不包 Store 数深度，而是在端口回调里尝试开嵌套事务）
// ---------------------------------------------------------------------------

/**
 * 端口回调的事务边界探针。
 *
 * 判据来源：`MemoryStore.transact()` 在已有事务打开时抛 `PersistenceError('不支持嵌套事务…')`。
 * 因此"在端口回调里尝试 `store.transact(空)`"是一次**直接的**探测：
 * - 成功 ⇒ 回调时**不在**任何事务内（`nested_error === null`，`inside === false`）；
 * - 抛"不支持嵌套事务" ⇒ 回调时**正处于**事务内（`inside === true`）。
 *
 * 这比"包一层 Store 记深度"更贴近判据本身：它问的是"此刻能不能再开一个事务"，
 * 而不是"外面套了几层"。
 */
class PortCallbackTransactionProbe implements ArtifactMaterializationPort {
  readonly calls: {
    readonly artifact_id: string;
    readonly inside_transaction: boolean;
    readonly nested_error: string | null;
  }[] = [];

  readonly #store: Store;
  readonly #inner: ArtifactMaterializationPort;

  constructor(store: Store, inner: ArtifactMaterializationPort) {
    this.#store = store;
    this.#inner = inner;
  }

  materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
    let inside = false;
    let nestedError: string | null = null;
    try {
      // 空事务：成功即证明"此刻没有别的事务开着"。
      this.#store.transact((): void => {});
    } catch (error) {
      nestedError = error instanceof Error ? error.message : String(error);
      inside = /不支持嵌套事务/.test(nestedError);
    }
    this.calls.push({
      artifact_id: request.artifact_id,
      inside_transaction: inside,
      nested_error: nestedError,
    });
    return this.#inner.materialize(request);
  }
}

// ---------------------------------------------------------------------------
// 临时目录（清理带重试：Windows 上刚写完的文件可能仍被占用 ⇒ rmSync 抛 EBUSY）
// ---------------------------------------------------------------------------

const CREATED_ROOTS: string[] = [];

function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `potbot-v4-${label}-`));
  CREATED_ROOTS.push(dir);
  // 计划路径用 `/` 拼（planner 的纪律：分隔符固定 `/`，不随平台变化）。
  return dir.split('\\').join('/');
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 递归删除；重试用尽则**打印警告并保留目录**（不掩盖、也不判红）。 */
function removeWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        console.warn(`[V4] 清理临时目录失败（保留现场）：${dir} — ${String(error)}`);
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
  if (!existsSync(dir)) return [];
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
// 事实 / 意图夹具
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
        source: { kind: 'user_confirmation', detail: 'V4 夹具：用户确认' },
        confirmed_by: INSTANCE_C,
        confirmed_at: asLogicalTime(0),
      }),
    );
    tx.putSharedFact(
      createSharedFactRecord({
        fact_id: BUDGET_TOTAL,
        task_id: TASK_ID,
        task_revision: REVISION_1,
        fact_key: 'budget.total',
        value: { kind: 'known', value: { type: 'number', amount: 600, unit: '元', currency: null } },
        source: { kind: 'user_confirmation', detail: 'V4 夹具：用户确认' },
        confirmed_by: INSTANCE_C,
        confirmed_at: asLogicalTime(0),
      }),
    );
    tx.putSharedFact(
      createSharedFactRecord({
        fact_id: CONTINGENCY,
        task_id: TASK_ID,
        task_revision: REVISION_1,
        fact_key: 'contingency',
        // 未知必须带原因，且**结构上装不进数值**（P3）。
        value: { kind: 'unknown', reason: 'V4 夹具：用户尚未确认' },
        source: { kind: 'user_confirmation', detail: 'V4 夹具：用户确认' },
        confirmed_by: INSTANCE_C,
        confirmed_at: asLogicalTime(0),
      }),
    );
  });
}

/** 文档意图：标题**不含数字**（否则会被"数字必须可指认"判据拒绝）。 */
function docIntent(
  title: string,
  factKeys: readonly string[] = ['headcount'],
): ArtifactPublicationIntent {
  return {
    intent: {
      template_kind: 'document',
      requirement: { title, description: '独立验收：按已确认共享事实生成的文档' },
      references: [],
    },
    fact_keys: factKeys,
  };
}

/** 一条"带产物意图"的完成发布。 */
function completedWithArtifact(
  intent: ArtifactPublicationIntent,
  request: RequestId = requestId('r-1'),
): RunPublication {
  return { kind: 'completed', request_id: request, result_refs: [AGENT_CLAIM], artifact: intent };
}

/** 一条**普通**完成发布（无产物意图）。 */
function completedPlain(request: RequestId): RunPublication {
  return { kind: 'completed', request_id: request, result_refs: [resultRef(request)] };
}

// ---------------------------------------------------------------------------
// 基准夹具
// ---------------------------------------------------------------------------

interface Bench {
  readonly store: Store;
  readonly scheduler: Scheduler;
  /** 临时根目录（即便 `with_root: false` 也建一个"见证目录"，用于断言"零写盘"）。 */
  readonly root: string;
  readonly fs_port: FsArtifactMaterializationPort;
  /** 端口回调探针（仅在 `probe: true` 时非空）。 */
  readonly probe: PortCallbackTransactionProbe | null;
}

function makeBench(options: {
  readonly label: string;
  readonly with_root?: boolean;
  readonly with_port?: boolean;
  readonly probe?: boolean;
}): Bench {
  const store = buildStore();
  registerInstance(store, INSTANCE_C);
  registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION_1 });
  putFacts(store);

  const root = makeRoot(options.label);
  const fsPort = createFsArtifactMaterializationPort({
    // 版本闸门的唯一读口：**当前**任务版本（读不到任务 ⇒ null，不猜默认版本）。
    read_revision: (taskId: TaskId) =>
      store.snapshot().tasks.find((task) => task.task_id === taskId)?.revision ?? null,
    now: () => asLogicalTime(0),
  });
  const probe =
    options.probe === true ? new PortCallbackTransactionProbe(store, fsPort) : null;
  const port: ArtifactMaterializationPort = probe ?? fsPort;

  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    default_task_id: TASK_ID,
    ...(options.with_root === false ? {} : { artifact_root_dir: root }),
    ...(options.with_port === false ? {} : { artifacts: { port } }),
  });

  return { store, scheduler, root, fs_port: fsPort, probe };
}

/** 只读：某工作项的 `status` / `result_refs`（断言只经快照读）。 */
function workItemOf(
  store: Store,
  request: RequestId,
): { readonly status: string; readonly result_refs: readonly string[] } | undefined {
  const item = store.snapshot().work_items.find((candidate) => candidate.request_id === request);
  return item === undefined ? undefined : { status: item.status, result_refs: item.result_refs };
}

/** 快照里唯一的产物记录（夹具自检：必须有且只有一条）。 */
function onlyArtifact(store: Store): ArtifactRecord {
  const records = snapshotArtifacts(store.snapshot());
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    throw new Error('V4 夹具错误：产物记录缺失');
  }
  return record;
}

/** 存储里是否出现过某种原因的 `publication_rejected` 观测（R56 的取证面）。 */
function hasRejectionReason(store: Store, reason: string): boolean {
  return store
    .snapshot()
    .kernel_events.some(
      (event) => event.kind === 'publication_rejected' && event.data['reason'] === reason,
    );
}

/** 完成一次"投递 → 启动 → 收尾"，返回 run_id 与收尾结果。 */
function runOnce(
  bench: Bench,
  n: number,
  publications: readonly RunPublication[],
): { readonly run_id: string; readonly finish: ReturnType<Scheduler['finishRun']> } {
  const delivered = bench.scheduler.onMessage(workRequest(n));
  expect(delivered.result).toBe('accepted');
  const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
  expect(started.started).toBe(true);
  const runId = started.run?.run_id;
  if (runId === undefined) {
    throw new Error('V4 夹具错误：轮次未启动');
  }
  const finish = bench.scheduler.finishRun({ run_id: runId, publications });
  return { run_id: runId, finish };
}

// ---------------------------------------------------------------------------
// 判据 1 —— Agent 不能自称产出（两次对照必须不同）
// ---------------------------------------------------------------------------

describe('判据 1：Agent 不能自称产出——无意图零产物、有意图由内核给 id，两次对照不同', () => {
  it('无 artifact 意图：工作项可完成，但 artifacts 集合零记录、盘上零文件', () => {
    const bench = makeBench({ label: 'c1-plain', with_port: false });
    const { finish } = runOnce(bench, 1, [completedPlain(requestId('r-1'))]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);
    expect(finish.artifact_facts).toEqual([]);

    // 工作项照常完成，`result_refs` 就是 Agent 自报的那个（这是 Agent 的自由）。
    const item = workItemOf(bench.store, requestId('r-1'));
    expect(item?.status).toBe('completed');
    expect(item?.result_refs).toEqual([resultRef(requestId('r-1'))]);

    // 但**没有任何产物记录**、**没有任何文件**。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(collectFiles(bench.root)).toEqual([]);
    expect(bench.fs_port.calls).toBe(0);
  });

  it('带 artifact 意图：记录出现，且工作项 result_refs 等于内核产物 id（与自报值不同）', () => {
    const bench = makeBench({ label: 'c1-intent', with_port: false });
    const { finish } = runOnce(bench, 1, [completedWithArtifact(docIntent('第一份报告'))]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);
    expect(finish.rejected_publications).toEqual([]);
    expect(finish.artifact_facts).toHaveLength(1);

    // 夹具自检：记录确实产生，否则下面的覆盖断言会"空集通过"。
    const record = onlyArtifact(bench.store);
    expect(record.artifact_id).not.toBe(AGENT_CLAIM);
    expect(record.source_fact_refs).toEqual([HEADCOUNT]);

    const item = workItemOf(bench.store, requestId('r-1'));
    expect(item?.status).toBe('completed');
    expect(item?.result_refs).toEqual([record.artifact_id]);
    expect(item?.result_refs).not.toContain(AGENT_CLAIM);
  });

  it('两次对照的结论必须不同（无意图 ⇒ 0 条记录；有意图 ⇒ 1 条记录）', () => {
    const plain = makeBench({ label: 'c1-diff-plain', with_port: false });
    runOnce(plain, 1, [completedPlain(requestId('r-1'))]);
    const intent = makeBench({ label: 'c1-diff-intent', with_port: false });
    runOnce(intent, 1, [completedWithArtifact(docIntent('对照报告'))]);

    const plainCount = snapshotArtifacts(plain.store.snapshot()).length;
    const intentCount = snapshotArtifacts(intent.store.snapshot()).length;
    expect(plainCount).toBe(0);
    expect(intentCount).toBe(1);
    expect(plainCount).not.toBe(intentCount);
  });
});

// ---------------------------------------------------------------------------
// 判据 2 —— 同事务（双向）
// ---------------------------------------------------------------------------

describe('判据 2：产物记录与工作项 result_refs 同生共死（回滚都不在 / 提交都在）', () => {
  it('同一 run 两次收尾：注入抛错 ⇒ 两者都消失；解除故障 ⇒ 两者都在', () => {
    const bench = makeBench({ label: 'c2', with_port: false });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    const runId = started.run?.run_id;
    if (runId === undefined) {
      throw new Error('V4 夹具错误：轮次未启动');
    }
    // 夹具自检：启动已提交，此刻还没有任何产物记录。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');

    // 方向一：提交前抛错 ⇒ 整个收尾事务回滚。
    let armed = true;
    bench.store.faults.beforeCommit = (): void => {
      if (armed) throw new Error('V4 故障注入：提交前抛错（本次收尾不应提交）');
    };
    expect(() =>
      bench.scheduler.finishRun({
        run_id: runId,
        publications: [completedWithArtifact(docIntent('回滚报告'))],
      }),
    ).toThrow();

    // 两者**都不在**：既没有产物记录，工作项 result_refs 也仍为空。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
    expect(bench.store.snapshot().runs.find((run) => run.run_id === runId)?.status).toBe('running');
    expect(bench.fs_port.calls).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);

    // 方向二：解除故障，**同一 run** 再收尾 ⇒ 提交。
    armed = false;
    const finish = bench.scheduler.finishRun({
      run_id: runId,
      publications: [completedWithArtifact(docIntent('回滚报告'))],
    });
    expect(finish.accepted).toBe(true);

    // 两者**都在**：产物记录存在，工作项 result_refs 等于产物 id。
    const record = onlyArtifact(bench.store);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('completed');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([record.artifact_id]);
    expect(bench.store.snapshot().runs.find((run) => run.run_id === runId)?.status).toBe('finished');
  });
});

// ---------------------------------------------------------------------------
// 判据 3 —— artifact_root_dir 未注入 ⇒ 结构化拒绝（逐条粒度）
// ---------------------------------------------------------------------------

describe('判据 3：未注入 artifact_root_dir ⇒ artifact_root_dir_unset，零记录零写盘，其余发布不受影响', () => {
  it('带意图的那条被拒，同一次 finishRun 里的普通发布照常完成', () => {
    const bench = makeBench({ label: 'c3', with_root: false, with_port: true });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    expect(bench.scheduler.onMessage(workRequest(2)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    // 夹具自检：两项都被本轮认领，否则"逐条粒度"无从谈起。
    expect(started.claimed_request_ids).toEqual([requestId('r-1'), requestId('r-2')]);
    const runId = started.run?.run_id;
    if (runId === undefined) {
      throw new Error('V4 夹具错误：轮次未启动');
    }

    const finish = bench.scheduler.finishRun({
      run_id: runId,
      publications: [
        completedWithArtifact(docIntent('没有落点的报告'), requestId('r-1')),
        completedPlain(requestId('r-2')),
      ],
    });

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-2')]);
    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.request_id).toBe(requestId('r-1'));
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('artifact_root_dir_unset');
    expect(finish.artifact_facts).toEqual([]);

    // 零产物记录、零端口调用、零写盘。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(bench.fs_port.calls).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);

    // 内核确实写了一条带原因的可核验观测（不是只靠调用方的说法）。
    expect(hasRejectionReason(bench.store, 'artifact_root_dir_unset')).toBe(true);

    // r-2 不受影响：照常完成，用自己声明的结果引用。
    expect(workItemOf(bench.store, requestId('r-2'))?.status).toBe('completed');
    expect(workItemOf(bench.store, requestId('r-2'))?.result_refs).toEqual([
      resultRef(requestId('r-2')),
    ]);
    // r-1 没有被置成已完成（发布被拒 ⇒ 转换根本没发生，停在启动时认领的 processing）。
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 4 —— 缺事实 ⇒ missing_fact（未登记键 + 显式 unknown）
// ---------------------------------------------------------------------------

describe('判据 4：缺事实 ⇒ missing_fact，零记录零写盘，工作项不是已完成', () => {
  it('引用了**未登记**的事实键 ⇒ 拒绝', () => {
    const bench = makeBench({ label: 'c4-missing' });
    // 夹具自检：确实登记了 headcount，却没登记 budget.missing。
    readTx(bench.store, (tx) => {
      expect(tx.listSharedFacts().map((fact) => fact.fact_key)).toEqual([
        'headcount',
        'budget.total',
        'contingency',
      ]);
    });

    const { finish } = runOnce(bench, 1, [
      completedWithArtifact(docIntent('季度报告', ['headcount', 'budget.missing'])),
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([]);
    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('missing_fact');
    expect(finish.artifact_facts).toEqual([]);

    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(bench.fs_port.calls).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);
    expect(hasRejectionReason(bench.store, 'missing_fact')).toBe(true);

    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([]);
  });

  it('事实**显式登记为 unknown** ⇒ 同样拒绝（不得把未知当零）', () => {
    const bench = makeBench({ label: 'c4-unknown' });
    const { finish } = runOnce(bench, 1, [
      completedWithArtifact(docIntent('季度报告', ['contingency'])),
    ]);

    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('missing_fact');
    expect(finish.artifact_facts).toEqual([]);
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(bench.fs_port.calls).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('processing');
  });
});

// ---------------------------------------------------------------------------
// 判据 5 —— 版本闸门 + 递增：两个版本、旧文件字节未被覆盖
// ---------------------------------------------------------------------------

describe('判据 5：同任务同种类连续两次 ⇒ 版本 1/2、id 与路径不同、旧文件字节未被覆盖', () => {
  it('两次公开入口发布各自物化到不同路径，第一次的文件 sha256 保持不变', () => {
    const bench = makeBench({ label: 'c5' });

    const first = runOnce(bench, 1, [completedWithArtifact(docIntent('第一版报告'))]);
    expect(first.finish.applied_request_ids).toEqual([requestId('r-1')]);
    const v1 = onlyArtifact(bench.store);
    expect(v1.artifact_version).toBe(1);
    expect(v1.status).toBe('published');
    const path1 = resolve(v1.receipt?.final_path ?? '');
    expect(existsSync(path1)).toBe(true);
    const sha1AtPublish = sha256OfFile(path1);
    expect(sha1AtPublish).toBe(v1.content_digest);
    expect(sha1AtPublish).toBe(v1.receipt?.readback_digest);

    const second = runOnce(bench, 2, [completedWithArtifact(docIntent('第二版报告'), requestId('r-2'))]);
    expect(second.finish.applied_request_ids).toEqual([requestId('r-2')]);

    // 夹具自检：两条记录都在、都是 published。
    const records = snapshotArtifacts(bench.store.snapshot());
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === 'published')).toBe(true);
    const v2 = records.find((record) => record.artifact_version === 2);
    if (v2 === undefined) {
      throw new Error('V4 夹具错误：第二版产物记录缺失');
    }
    const v1Again = records.find((record) => record.artifact_version === 1);
    if (v1Again === undefined) {
      throw new Error('V4 夹具错误：第一版产物记录缺失');
    }

    // 两个版本、两个不同 id、两条不同最终路径。
    expect(v1Again.artifact_version).toBe(1);
    expect(v2.artifact_version).toBe(2);
    expect(v1Again.artifact_id).not.toBe(v2.artifact_id);
    expect(v1Again.receipt?.final_path).not.toBe(v2.receipt?.final_path);

    // **旧文件字节未被覆盖**：第一次写入后与第二次发布后，sha256 相同。
    const path2 = resolve(v2.receipt?.final_path ?? '');
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);
    expect(sha256OfFile(path1)).toBe(sha1AtPublish);
    expect(sha256OfFile(path1)).toBe(v1Again.content_digest);
    expect(sha256OfFile(path2)).toBe(v2.content_digest);
    // 两次意图的标题不同 ⇒ 字节不同 ⇒ "摘要一致"确实排除了"被第二次写花"。
    expect(v1Again.content_digest).not.toBe(v2.content_digest);
    // 盘上恰好两个产物文件（没有额外的残留）。
    expect(collectFiles(bench.root)).toHaveLength(2);
    expect(bench.fs_port.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 判据 6 —— 提交后投影（R56.2）+ 端口回调不在事务内
// ---------------------------------------------------------------------------

describe('判据 6：提交后投影——finishRun 返回时已是 published，端口回调不在任何事务内', () => {
  it('记录 published、回读摘要等于内容摘要，且回调期尝试开嵌套事务会成功', () => {
    const bench = makeBench({ label: 'c6', probe: true });
    const { finish } = runOnce(bench, 1, [completedWithArtifact(docIntent('投影报告'))]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);
    // `artifact_facts` 携带的是**暂存时刻**的记录（tx1 的 staged 快照）。
    expect(finish.artifact_facts).toHaveLength(1);
    expect(finish.artifact_facts[0]?.record.status).toBe('staged');

    // finishRun **返回时**存储里已是 published（投影先于返回）。
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('published');
    expect(isDeliveredArtifact(record)).toBe(true);
    expect(record.receipt).not.toBeNull();
    expect(record.content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.receipt?.readback_digest).toBe(record.content_digest);
    expect(record.receipt?.verifier).toBe(FS_ARTIFACT_PORT_VERIFIER);

    // 独立复算：自己读回最终路径再算一次摘要（不信端口自述）。
    const finalPath = resolve(record.receipt?.final_path ?? '');
    expect(existsSync(finalPath)).toBe(true);
    expect(sha256OfFile(finalPath)).toBe(record.content_digest);

    // 端口回调期**不在任何事务内**：探针成功地开了一个嵌套事务。
    const probe = bench.probe;
    if (probe === null) {
      throw new Error('V4 夹具错误：事务边界探针未装配');
    }
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.artifact_id).toBe(record.artifact_id);
    expect(probe.calls[0]?.nested_error).toBeNull();
    expect(probe.calls[0]?.inside_transaction).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 判据 7 —— 未注入端口 ⇒ 停 staged（I-4）
// ---------------------------------------------------------------------------

describe('判据 7：未注入端口 ⇒ 产物停在 staged，不满足任何交付判据，盘上无文件', () => {
  it('staged 记录无回执、isDeliveredArtifact 为 false，最终路径不存在', () => {
    const bench = makeBench({ label: 'c7', with_port: false });
    const { finish } = runOnce(bench, 1, [completedWithArtifact(docIntent('待发布报告'))]);

    expect(finish.accepted).toBe(true);
    expect(finish.artifact_facts).toHaveLength(1);

    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('staged');
    expect(isDeliveredArtifact(record)).toBe(false);
    expect(record.receipt).toBeNull();
    expect(record.failure_kind).toBeNull();

    // 计划可复算：由记录派生出的最终路径此刻不存在（没有"被误标通过"的文件）。
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
    expect(bench.fs_port.calls).toBe(0);

    // 工作项的 result_refs 指向该产物 id，但它**不是**交付证据（R47.3：查不到 published 记录 ⇒ 未交付）。
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('completed');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([record.artifact_id]);
  });
});

// ---------------------------------------------------------------------------
// 判据 8 —— afterCommitBeforePublish（W-F5 提出的疑点）：如实报告实测行为 + 恢复入口探查
//
// 说明：本判据初次实测时，被测实现把这条路径**留在 staged**（不投影）；随后被测实现
// （`src/scheduler/scheduler.ts`，mtime 2026-10-02 14:08:33）与合同（v1.4，新增 R56.2a/R56.2b，
// mtime 14:09:37）在本轮评审期间同时更新为"必须投影"。本用例按**当前修订**断言实测行为，
// 并保留"恢复入口"探查作为 R56.2b 的独立证据。
// ---------------------------------------------------------------------------

describe('判据 8：afterCommitBeforePublish 抛错路径——实测行为 + 恢复入口探查', () => {
  it('实测：提交已发生 ⇒ 产物照样被投影为 published（与预算同一处置），而 finishRun 仍如实抛错', () => {
    const bench = makeBench({ label: 'c8' });
    expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    const runId = started.run?.run_id;
    if (runId === undefined) {
      throw new Error('V4 夹具错误：轮次未启动');
    }

    let armed = true;
    bench.store.faults.afterCommitBeforePublish = (): void => {
      if (armed) throw new Error('V4 故障注入：提交后、发布前抛错');
    };
    let thrown: unknown = null;
    try {
      bench.scheduler.finishRun({
        run_id: runId,
        publications: [completedWithArtifact(docIntent('已提交但未发布'))],
      });
    } catch (error) {
      thrown = error;
    }
    armed = false;

    // finishRun **仍如实抛错**（accepted === true 的 PublicationError）：调用方据此走
    // `publishPendingEvents()` 重放投递事件。
    expect(thrown).toBeInstanceOf(PublicationError);

    // 实测行为：事务 1 已提交 ⇒ 产物**照样被投影**，不停在 staged（R56.2a）。
    const records = snapshotArtifacts(bench.store.snapshot());
    expect(records).toHaveLength(1);
    expect(records.every((candidate) => candidate.status !== 'staged')).toBe(true);
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('published');
    expect(isDeliveredArtifact(record)).toBe(true);
    expect(record.receipt).not.toBeNull();

    // I-1：回执来自对最终路径的**实际回读**（不信端口自述，自己复算一次）。
    expect(record.content_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.receipt?.readback_digest).toBe(record.content_digest);
    const finalPath = resolve(record.receipt?.final_path ?? '');
    expect(existsSync(finalPath)).toBe(true);
    expect(sha256OfFile(finalPath)).toBe(record.content_digest);
    expect(bench.fs_port.calls).toBe(1);
    expect(collectFiles(bench.root)).toHaveLength(1);

    // 工作项拿到内核产物 id；轮次已收尾。
    expect(workItemOf(bench.store, requestId('r-1'))?.status).toBe('completed');
    expect(workItemOf(bench.store, requestId('r-1'))?.result_refs).toEqual([record.artifact_id]);
    expect(bench.store.snapshot().runs.find((run) => run.run_id === runId)?.status).toBe('finished');
  });

  it('恢复入口探查：存储里遗留的 staged 记录，调度门面没有公开入口把它重新装配并发布', () => {
    // 构造一条**遗留的 staged 记录**（不注入端口 ⇒ 停在 staged，等价于"已提交未投影"的形态）。
    const bench = makeBench({ label: 'c8-recover', with_port: false });
    const { finish } = runOnce(bench, 1, [completedWithArtifact(docIntent('遗留的暂存产物'))]);
    expect(finish.accepted).toBe(true);
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('staged');
    expect(isDeliveredArtifact(record)).toBe(false);

    const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(bench.scheduler));
    // ① 门面没有任何"产物"相关方法，也没有"重发布 / 恢复"入口。
    expect(publicMethods.filter((name) => /artifact/i.test(name))).toEqual([]);
    expect(publicMethods.some((name) => /recover|republish|resume|publish[^P]/i.test(name))).toBe(false);
    // ② 记录本身不携带重建 `ArtifactMaterializationRequest` 所需的要素（意图 / 事实键 / payload / 根目录）。
    expect(
      Object.keys(record).some((key) => /intent|payload|fact_keys|root_dir|title|sheet/i.test(key)),
    ).toBe(false);
  });
});
