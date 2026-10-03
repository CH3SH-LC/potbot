/**
 * **产物观测 → 内核事件**（design-02 A 批；合同 v1.4 R49.1 段 3 / R59；W-FIX5）。
 *
 * ## 这个文件为什么存在
 *
 * V4 独立复核发现一个"声明了但没接线"的缺口：`KERNEL_EVENT_KINDS` 声明了
 * `artifact_published` / `artifact_publish_failed`（R59），但**没有任何生产代码把它们写进内核
 * 事件流**——调度侧构造发布投影时没有注入 `ArtifactPublicationHooks.writeObservationInTransaction`，
 * 于是"产物已发布"只活在投影进程内的 `#observations` 里，**不落库、重启即丢**；
 * 真正落库的只有 `artifact_staged`。"已交付"因此**没有可持久化的内核证据**。
 *
 * 本文件的被测对象就是那条接线：`finishRun` → 提交后投影 → **段 3 事务内**写记录 + 写事件。
 *
 * ## 判据（每条都能失败）
 *
 * | # | 判据 |
 * |---|---|
 * | 1 | 成功发布 ⇒ `kernel_events` 里**恰好一条** `artifact_published`，载荷与记录/回执逐字段一致（I-1） |
 * | 2 | 端口故障 ⇒ **恰好一条** `artifact_publish_failed`，`detail` 非空、`delivered: false`、**不是**交付 |
 * | 3 | 缺事实 ⇒ 是 `publication_rejected`，**不冒出** `artifact_publish_failed`（失败不得被凭空断言） |
 * | 4 | **事务内**：段 3 提交前，事件已在**同一事务的草稿**里可见，而**尚未**出现在已提交快照中 |
 * | 5 | **不注入 hook** ⇒ 一条事件都不写（既有语义不变；观测只落投影内部日志） |
 *
 * ## 夹具
 *
 * - 真实 `createMemoryStore` + 真实 `createScheduler`（公开入口 `onMessage → startRun → finishRun`）；
 * - 真实落盘端口 `FsArtifactMaterializationPort`（写系统临时目录）⇒ 成功路径的回执来自
 *   **对最终路径的实际回读**（不伪造回执，I-1）；
 * - 失败路径用端口自带故障注入 `fail_at: 'write'`（结构化失败，短路在写盘之前）。
 *
 * 纪律：断言用等号（`toBe` / `toEqual`）；每个用例先做夹具自检（"确实产生了数据"）。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  asFactRef,
  asLogicalTime,
  asRevision,
  createArtifactRecord,
  createIdSource,
  createSharedFactRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  type ArtifactReceipt,
  type ArtifactRecord,
  type KernelEvent,
  type LogicalTime,
  type Store,
} from '../protocol/index.js';
import {
  createArtifactPublicationProjection,
  createCollectingMaterializationPort,
  createStagedArtifactFact,
  materializationSuccess,
  planArtifact,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactPublicationIntent,
  type StagedArtifactFact,
} from '../artifacts/index.js';
import {
  createFsArtifactMaterializationPort,
  FS_ARTIFACT_PORT_VERIFIER,
  type FsArtifactPortFailAt,
} from '../../tests/acceptance/office/fs-artifact-port.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import {
  GROUP_ID,
  INSTANCE_C,
  TASK_ID,
  buildStore,
  registerInstance,
  registerTask,
  requestId,
  resultRef,
  workRequest,
} from './test-support.js';

// ---------------------------------------------------------------------------
// 常量与夹具
// ---------------------------------------------------------------------------

/** 已确认事实：人数（数值 + 单位）。 */
const HEADCOUNT = asFactRef('F-headcount');
/** 事务基准版本（`registerTask` 的默认值即 1，这里显式写出以便阅读）。 */
const REVISION_1 = asRevision(1);
const AT_ZERO: LogicalTime = asLogicalTime(0);

const CREATED_ROOTS: string[] = [];

function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `potbot-artifactobs-${label}-`));
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
          `[artifact-observation] 清理临时目录失败（保留现场）：${dir} — ${String(error)}`,
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

/**
 * **独立复算**容器条目数：只读 EOCD（End Of Central Directory，签名 `PK\x05\x06`）。
 *
 * 为什么这么写：这是**对产物字节的独立读取**——不经被测端口、不经内核的任何解析器、
 * 也不引用被测对象自报的任何数。被测对象自报的 `entry_count` 因此有一个**外部参照**，
 * 这正是"交叉核对"的意义。
 *
 * 从末尾向前扫第一处**自洽**的 EOCD（签名 + 注释长度与文件尾一致），取偏移 10 的
 * uint16 条目总数。本批产物远小于 65535 个条目，不需要读 ZIP64 的 EOCD 记录。
 */
function countZipEntries(filePath: string): number {
  const bytes = readFileSync(filePath);
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) {
      continue;
    }
    // 自洽性检查：注释长度（偏移 20）必须正好等于 EOCD 之后剩余的字节数。
    if (bytes.readUInt16LE(i + 20) !== bytes.length - i - 22) {
      continue;
    }
    return bytes.readUInt16LE(i + 10);
  }
  throw new Error(`独立复算失败：${filePath} 不是合法 ZIP（找不到自洽的 EOCD 记录）`);
}

/** 登记事实（**真实** `SharedFactRecord`，不经任何捷径）。 */
function putFacts(store: Store): void {
  store.transact((tx) => {
    tx.putSharedFact(
      createSharedFactRecord({
        fact_id: HEADCOUNT,
        task_id: TASK_ID,
        task_revision: REVISION_1,
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: { kind: 'user_confirmation', detail: '用户确认（W-FIX5 夹具）' },
        confirmed_by: INSTANCE_C,
        confirmed_at: AT_ZERO,
      }),
    );
  });
}

/** 文档意图：标题里**没有数字**（否则会被 P6 的"数字必须可指认"判据拒绝）。 */
function documentIntent(
  factKeys: readonly string[] = ['headcount'],
): ArtifactPublicationIntent {
  return {
    intent: {
      template_kind: 'document',
      requirement: { title: '季度报告', description: '按已确认事实生成的文档' },
      references: [],
    },
    fact_keys: factKeys,
  };
}

interface Bench {
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly root: string;
}

function makeBench(options: { readonly fail_at?: FsArtifactPortFailAt; readonly label: string }): Bench {
  const store = buildStore();
  registerInstance(store, INSTANCE_C);
  registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION_1 });
  putFacts(store);

  const root = makeRoot(options.label);
  const port = createFsArtifactMaterializationPort({
    // 版本闸门的唯一读口：**当前**任务版本（读不到任务 ⇒ null，不猜默认版本）。
    read_revision: (taskId) =>
      store.snapshot().tasks.find((task) => task.task_id === taskId)?.revision ?? null,
    now: () => AT_ZERO,
    ...(options.fail_at === undefined ? {} : { fail_at: options.fail_at }),
  });

  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    default_task_id: TASK_ID,
    artifact_root_dir: root,
    artifacts: { port },
  });

  return { store, scheduler, root };
}

/** 跑一轮：投递工作请求 → 启动轮次 → 以给定发布收尾。返回收尾结果。 */
function runOnce(
  bench: Bench,
  publications: Parameters<Scheduler['finishRun']>[0]['publications'],
): ReturnType<Scheduler['finishRun']> {
  expect(bench.scheduler.onMessage(workRequest(1)).result).toBe('accepted');
  const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
  expect(started.started).toBe(true);
  const runId = started.run?.run_id;
  if (runId === undefined) {
    throw new Error('夹具错误：轮次未启动');
  }
  return bench.scheduler.finishRun({ run_id: runId, publications });
}

/** 内核事件流里某一类事件的条数。 */
function countKind(bench: Bench, kind: string): number {
  return bench.scheduler.kernelEvents().filter((event) => event.kind === kind).length;
}

/** 内核事件流里**唯一**一条某类事件（夹具自检：必须有且只有一条）。 */
function onlyEvent(bench: Bench, kind: string): KernelEvent {
  const events = bench.scheduler.kernelEvents().filter((event) => event.kind === kind);
  expect(events).toHaveLength(1);
  const event = events[0];
  if (event === undefined) {
    throw new Error(`夹具错误：内核事件流里没有 ${kind}`);
  }
  return event;
}

/** 从存储里取出**唯一**一条产物记录（夹具自检：必须有且只有一条）。 */
function onlyArtifact(store: Store): ArtifactRecord {
  const records = snapshotArtifacts(store.snapshot());
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) {
    throw new Error('夹具错误：产物记录缺失');
  }
  return record;
}

function receiptOf(record: ArtifactRecord): ArtifactReceipt {
  const receipt = record.receipt;
  if (receipt === null) {
    throw new Error('夹具错误：published 记录缺回执');
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// 判据 1 —— 成功发布 ⇒ 恰好一条 artifact_published，载荷逐字段一致（I-1）
// ---------------------------------------------------------------------------

describe('判据 1：成功发布 ⇒ 恰好一条 artifact_published，回读摘要与记录一致', () => {
  it('事件载荷的 artifact_id / 版本 / 模板 / 摘要 / 路径 / 字节长度与记录和回执一致', () => {
    const bench = makeBench({ label: 'c1' });

    const finish = runOnce(bench, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent(),
      },
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);

    // 夹具自检：记录确实产生且已交付（否则下面的比较会与 undefined 比较而"空集通过"）。
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('published');
    expect(isDeliveredArtifact(record)).toBe(true);
    const receipt = receiptOf(record);

    // 恰好一条 published 事件（不多不少）；staged 事件同样只有一条（R59 的两个端点都在）。
    expect(countKind(bench, 'artifact_staged')).toBe(1);
    expect(countKind(bench, 'artifact_published')).toBe(1);
    expect(countKind(bench, 'artifact_publish_failed')).toBe(0);

    const event = onlyEvent(bench, 'artifact_published');
    const data = event.data;
    expect(event.task_id).toBe(record.task_id);
    expect(event.instance_id).toBe(record.created_by_instance_id);
    expect(data['artifact_id']).toBe(record.artifact_id);
    expect(data['task_revision']).toBe(record.task_revision);
    expect(data['artifact_version']).toBe(record.artifact_version);
    expect(data['template_kind']).toBe(record.template_kind);
    expect(data['byte_length']).toBe(record.byte_length);
    expect(data['final_path']).toBe(receipt.final_path);
    expect(data['status']).toBe('published');
    // I-1：事件里的回读摘要 == 记录回执里的回读摘要 == 记录的内容摘要。
    expect(data['readback_digest']).toBe(receipt.readback_digest);
    expect(data['readback_digest']).toBe(record.content_digest);
    expect(receipt.verifier).toBe(FS_ARTIFACT_PORT_VERIFIER);
    expect(data['verifier']).toBe(receipt.verifier);

    // 这两类事件**不参与** 6 个计数器（R59）：run_count 仍等于真实启动的轮次数。
    expect(bench.scheduler.eventCounters().run_count).toBe(1);
    expect(bench.scheduler.eventCounters().rejected_publication_count).toBe(0);
    expect(collectFiles(bench.root)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 判据 2 —— 端口故障 ⇒ 恰好一条 artifact_publish_failed，detail 非空且明确未交付
// ---------------------------------------------------------------------------

describe('判据 2：物化失败 ⇒ 恰好一条 artifact_publish_failed，detail 非空且明确"未交付"', () => {
  it('端口注入写盘故障（fail_at=write）⇒ 结构化失败落成事件，无任何"已交付"外观', () => {
    const bench = makeBench({ label: 'c2', fail_at: 'write' });

    const finish = runOnce(bench, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent(),
      },
    ]);

    expect(finish.accepted).toBe(true);

    // 夹具自检：记录确实产生，且**不是**已交付（失败与交付互斥）。
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('failed');
    expect(record.failure_kind).toBe('write_failed');
    expect(isDeliveredArtifact(record)).toBe(false);
    expect(record.receipt).toBeNull();

    expect(countKind(bench, 'artifact_published')).toBe(0);
    expect(countKind(bench, 'artifact_publish_failed')).toBe(1);

    const event = onlyEvent(bench, 'artifact_publish_failed');
    const data = event.data;
    expect(data['artifact_id']).toBe(record.artifact_id);
    expect(data['task_revision']).toBe(record.task_revision);
    expect(data['failure_kind']).toBe('write_failed');
    expect(data['status']).toBe('failed');
    // detail 非空（失败必须可追溯，R50.2），且明确写"未交付"。
    const detail = data['detail'];
    expect(typeof detail).toBe('string');
    expect((detail as string).length).toBeGreaterThan(0);
    expect(data['delivered']).toBe(false);
    expect(data['note']).toBe('未交付：结构化失败已如实记录（detail 非空），不得据此声称产物已交付');
    // 注入故障短路在写盘之前：盘上一个文件都没有（不存在"文件已生成但记录说失败"）。
    expect(collectFiles(bench.root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 3 —— 缺事实 ⇒ publication_rejected（不是 publish_failed）
// ---------------------------------------------------------------------------

describe('判据 3：缺事实 ⇒ publication_rejected，不冒出 artifact_publish_failed', () => {
  it('请求了没登记的键 ⇒ 结构化拒绝，产物零记录；失败类事件零条', () => {
    const bench = makeBench({ label: 'c3' });

    const finish = runOnce(bench, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent(['headcount', 'budget.missing']),
      },
    ]);

    expect(finish.accepted).toBe(true);
    expect(finish.rejected_publications).toHaveLength(1);
    expect(finish.rejected_publications[0]?.ledger_reason).toBe('missing_fact');
    expect(finish.artifact_facts).toEqual([]);

    // 夹具自检：拒绝确实落成了内核事件（否则下面的"零条"断言会空集通过）。
    const rejections = bench.scheduler
      .kernelEvents()
      .filter((event) => event.kind === 'publication_rejected' && event.data['reason'] === 'missing_fact');
    expect(rejections).toHaveLength(1);

    // 被拒的发布**没有**进入物化：不产记录、不产交付、也不产"失败"（失败不得凭空断言）。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    expect(countKind(bench, 'artifact_published')).toBe(0);
    expect(countKind(bench, 'artifact_publish_failed')).toBe(0);
    expect(collectFiles(bench.root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 4 —— 事务内：事件与记录在同一事务（提交前已在草稿里，尚未在已提交快照里）
// ---------------------------------------------------------------------------

interface CommitSample {
  readonly draft_published: number;
  readonly committed_published: number;
  readonly draft_published_record_status: string | null;
}

describe('判据 4：事件在段 3 事务内写入（提交前只在该事务的草稿里可见）', () => {
  it('beforeCommit 探针：段 3 提交前，事件已在同一事务的草稿中，而快照里还没有', () => {
    const bench = makeBench({ label: 'c4' });
    expect(bench.scheduler.kernelEvents()).toEqual([]);

    const samples: CommitSample[] = [];
    bench.store.faults.beforeCommit = (_summary, tx): void => {
      samples.push({
        draft_published: tx
          .listKernelEvents()
          .filter((event) => event.kind === 'artifact_published').length,
        committed_published: bench.store
          .snapshot()
          .kernel_events.filter((event) => event.kind === 'artifact_published').length,
        draft_published_record_status:
          tx.listArtifacts().find((record) => record.status === 'published')?.status ?? null,
      });
    };
    try {
      const finish = runOnce(bench, [
        {
          kind: 'completed',
          request_id: requestId('r-1'),
          result_refs: [resultRef(requestId('r-1'))],
          artifact: documentIntent(),
        },
      ]);
      expect(finish.accepted).toBe(true);
    } finally {
      bench.store.faults.beforeCommit = undefined;
    }

    // 夹具自检：确实观察到了若干次提交接缝。
    expect(samples.length).toBeGreaterThan(0);

    // 恰好一次提交里，草稿已经带上这条事件（= 段 3 那次提交）。
    const atSegment3 = samples.filter((sample) => sample.draft_published === 1);
    expect(atSegment3).toHaveLength(1);
    const sample = atSegment3[0];
    if (sample === undefined) {
      throw new Error('夹具错误：没有观察到"草稿里已有一条 artifact_published"的提交');
    }
    // 同一时刻：已提交快照里**还没有**它 —— 证明事件是**在这一个事务内**写进去的，
    // 而不是"在别处先提交、这里只是恰好读到"（info-006：事件不得早于/晚于事务）。
    expect(sample.committed_published).toBe(0);
    // 事件与"published 记录"在**同一个草稿**里 ⇒ 同一事务（I-3 在段 3 的对应形态）。
    expect(sample.draft_published_record_status).toBe('published');

    // 提交之后：事件确实落库了（这就是"重启后仍可核验"的那一条）。
    expect(countKind(bench, 'artifact_published')).toBe(1);
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('published');
    expect(receiptOf(record).readback_digest).toBe(record.content_digest);
  });
});

// ---------------------------------------------------------------------------
// 判据 5 —— 不注入 hook ⇒ 一条事件都不写（可选注入，既有语义不变）
// ---------------------------------------------------------------------------

describe('判据 5：不注入 hook ⇒ 零内核事件，观测只落投影内部日志', () => {
  it('手工构造的投影（无 hooks）发布成功，但 kernel_events 里没有这两个种类', () => {
    const store = buildStore();
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION_1 });

    const plan = planArtifact({
      task_id: TASK_ID,
      task_revision: REVISION_1,
      template_kind: 'document',
      artifact_version: 1,
      root_dir: '/root/artifacts',
      expected_content_digest: 'sha256:expected',
    });
    const request: ArtifactMaterializationRequest = {
      artifact_id: plan.artifact_id,
      task_id: TASK_ID,
      task_revision: REVISION_1,
      template_kind: 'document',
      fact_snapshot: [
        {
          fact_ref: HEADCOUNT,
          fact_key: 'headcount',
          value: { type: 'number', amount: 8, unit: '人', currency: null },
          source: { kind: 'user_confirmation', detail: '用户确认（W-FIX5 夹具）' },
        },
      ],
      plan,
      expected_content_digest: plan.expected_content_digest,
    };
    const staged = createArtifactRecord({
      artifact_id: plan.artifact_id,
      task_id: TASK_ID,
      task_revision: REVISION_1,
      artifact_version: 1,
      template_kind: 'document',
      byte_length: 0,
      content_digest: plan.expected_content_digest,
      source_fact_refs: [HEADCOUNT],
      created_by_instance_id: INSTANCE_C,
      status: 'staged',
      created_at: AT_ZERO,
    });
    const fact: StagedArtifactFact = createStagedArtifactFact(staged, request);

    const port = createCollectingMaterializationPort((materializationRequest) => {
      const receipt: ArtifactMaterializationReceipt = {
        artifact_id: materializationRequest.artifact_id,
        final_path: materializationRequest.plan.final_path,
        readback_digest: materializationRequest.expected_content_digest,
        byte_length: 128,
        entry_count: 3,
        verifier: 'test/no-hooks',
        at: asLogicalTime(5),
      };
      return materializationSuccess(receipt);
    });

    // **刻意不注入 hooks**（修复前调度侧的形状）。
    const projection = createArtifactPublicationProjection({ store, port });
    const outcomes = projection.reconcile([fact], asLogicalTime(9));

    // 夹具自检：这条路径确实发布成功了（否则"零条事件"是平凡成立）。
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe('published');
    const records = snapshotArtifacts(store.snapshot());
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('published');
    expect(isDeliveredArtifact(records[0] as ArtifactRecord)).toBe(true);
    // 观测落在**投影内部日志**里（这正是"不落库"的那个地方）。
    expect(projection.observations().map((observation) => observation.kind)).toEqual([
      'artifact_published',
    ]);

    // 但内核事件流里**一条都没有**：可选注入不改变既有语义。
    expect(
      store
        .snapshot()
        .kernel_events.filter(
          (event) => event.kind === 'artifact_published' || event.kind === 'artifact_publish_failed',
        ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 判据 6 —— `entry_count`：落库证据里的"容器条目数"必须与**独立复算**一致（W-FIX8）
// ---------------------------------------------------------------------------

describe('判据 6：artifact_published 的 data.entry_count 等于独立复算出的条目数', () => {
  it('发布成功后，事件里的条目数与直接解产物 ZIP 中央目录数出来的条目数**相等**', () => {
    const bench = makeBench({ label: 'c6' });

    const finish = runOnce(bench, [
      {
        kind: 'completed',
        request_id: requestId('r-1'),
        result_refs: [resultRef(requestId('r-1'))],
        artifact: documentIntent(),
      },
    ]);
    expect(finish.accepted).toBe(true);

    // 夹具自检：确实产出了**一个真实文件**（否则下面的"独立复算"无从谈起）。
    const files = collectFiles(bench.root);
    expect(files).toHaveLength(1);
    const produced = files[0];
    if (produced === undefined) {
      throw new Error('夹具错误：产物文件缺失');
    }

    // **独立复算**：直接解析产物字节的 EOCD（不经被测端口、不经内核任何解析器、
    // 也不引用被测对象自报的任何数）——被测对象之外的一条冷参照。
    const independent = countZipEntries(produced);
    expect(independent).toBeGreaterThan(0);

    // 夹具自检：记录确实已交付、事件确实有且只有一条。
    const record = onlyArtifact(bench.store);
    expect(record.status).toBe('published');
    expect(countKind(bench, 'artifact_published')).toBe(1);
    const event = onlyEvent(bench, 'artifact_published');

    // 判据本体：事件载荷里的条目数 == 独立复算的条目数。
    // 先钉住"它是个数、不是 null"——否则一旦回落成 `null`，等号断言会以"缺字段"的形式
    // **假装通过**（W-FIX8 修复前 `data.entry_count` 正是 `null`，这条前置断言当场把它戳破）。
    const reported = event.data['entry_count'];
    expect(typeof reported).toBe('number');
    expect(reported).toBe(independent);
    // 交叉面：记录回执上登记的条目数必须等于同一个独立值（落库证据与事件同源、同值）。
    expect(receiptOf(record).entry_count).toBe(independent);
  });
});

// ---------------------------------------------------------------------------
// 判据 7（对照）—— 不注入产物端口 ⇒ 产物停在 `staged`，不得冒出 artifact_published
// ---------------------------------------------------------------------------

describe('判据 7：不注入产物端口 ⇒ 产物停在 staged，不冒出 artifact_published', () => {
  it('只有 artifact_root_dir（无 port）⇒ 有 artifact_staged，但零 artifact_published', () => {
    const store = buildStore();
    registerInstance(store, INSTANCE_C);
    registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION_1 });
    putFacts(store);

    const root = makeRoot('c7');
    // **刻意不注入 `artifacts`**：本进程不发布产物（`#artifactProjection === null`）。
    const scheduler = createScheduler(store, {
      idSource: createIdSource(),
      default_task_id: TASK_ID,
      artifact_root_dir: root,
    });

    expect(scheduler.onMessage(workRequest(1)).result).toBe('accepted');
    const started = scheduler.startRun({ instance_id: INSTANCE_C });
    expect(started.started).toBe(true);
    const runId = started.run?.run_id;
    if (runId === undefined) {
      throw new Error('夹具错误：轮次未启动');
    }
    const finish = scheduler.finishRun({
      run_id: runId,
      publications: [
        {
          kind: 'completed',
          request_id: requestId('r-1'),
          result_refs: [resultRef(requestId('r-1'))],
          artifact: documentIntent(),
        },
      ],
    });
    expect(finish.accepted).toBe(true);

    // 夹具自检：暂存**确实发生了**（否则下面的"没有 published"是平凡成立）。
    const records = snapshotArtifacts(store.snapshot());
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('staged');
    const stagedEvents = scheduler
      .kernelEvents()
      .filter((event) => event.kind === 'artifact_staged');
    expect(stagedEvents).toHaveLength(1);

    // 判据本体：没有发布投影 ⇒ 没有回读证据 ⇒ 一条 `artifact_published` 都不得出现
    //（I-1：无回读不得称交付），失败类同样不得被凭空断言。
    const published = scheduler
      .kernelEvents()
      .filter((event) => event.kind === 'artifact_published');
    expect(published).toEqual([]);
    const failed = scheduler
      .kernelEvents()
      .filter((event) => event.kind === 'artifact_publish_failed');
    expect(failed).toEqual([]);
    // 没有端口 ⇒ 一个字节都不该落盘。
    expect(collectFiles(root)).toEqual([]);
  });
});
