/**
 * **V8 独立验收（task-id D02A-WFIX6）**：在**公开入口**（`onMessage → startRun → finishRun`）下，
 * 把 V7 覆盖映射点名的**唯一本批可补缺口**补上——
 *
 * > 失败分支在**任务 / 工作项**层如实报告"部分完成 / 未知"（`v7-coverage-map.test.ts` 的 `GAPS` 条目）
 *
 * ## 缺口是什么（V7 的原话，压缩）
 *
 * 改造前，"缺事实 ⇒ 如实报告"只证到 **`ArtifactRecord` / `rejected_publications`** 层
 * （`detail` 非空、`ledger_reason = missing_fact`）与"工作项**停在 `processing`**"。
 * 而 design-02 需求 5 / 验收标准的原话是「系统**如实报告**"未知 / 部分完成"」——
 * **"没被误标为已完成" ≠ "如实报告了"**。本文件把这条证到公开入口上。
 *
 * ## 五条判据（每条都能失败）
 *
 * | # | 判据 |
 * |---|---|
 * | 1 | 发布被拒**且拒因可指认**：`rejected_publications` 里 `ledger_reason === 'missing_fact'`、`message` 非空且**含缺失的键名** |
 * | 2 | 内核留下**可持久化证据**：`kernel_events` 里对应 `publication_rejected`，其 `data` 能指认缺失的事实键 |
 * | 3 | **产物侧无假交付**：`artifacts()` 无该产物记录、盘上零文件、端口零调用，且**不存在任何 `published` 记录**（不许用"补一个零值产物"冒充） |
 * | 4 | **工作项层**：断言其状态与原因；**若**内核在该路径上不给工作项写可指认的原因 ⇒ **如实记为缺口**（断言现状，不改 `src/**`、不伪造状态） |
 * | 5 | **对照**：同场景、事实齐备 ⇒ 发布成功、工作项 `completed`、**没有** `publication_rejected`（证明 1–3 不是恒真） |
 *
 * ## 独立性声明
 *
 * - 夹具**全部在本文件内自建**（不 import `office-support.ts` 的 `OfficeScenario`——它的
 *   `materializeAll()` 吞掉了 `finishRun` 的返回值，而本判据 1 必须直接断言那个返回值）；
 *   只复用 `fs-artifact-port.ts` 的**宿主落盘仪器**（R50.4：`node:fs` 的唯一允许位置）。
 * - 断言一律经**公开面**：`scheduler.onMessage` / `startRun` / `finishRun` 的返回值 + `store.snapshot()`。
 * - **不调用** `openWithOffice`；**不代办**内核步骤（不 `putWorkItem`、不 `putArtifact`、不置排队标记）。
 * - 断言用等号（`toBe` / `toEqual` / `toHaveLength`）；每个用例**先断言夹具确实产生了数据**。
 *
 * ## 4 号的判定口径（为什么"断言现状"也是验收）
 *
 * 判据 4 不是"随便挑一个通过"，而是**问一个可否证的问题**：内核在这条路径上到底有没有
 * 把"缺了哪个事实"写进工作项的原因字段？两条出路都已写死在 `src/**` 的既有语义里：
 * - 若写 ⇒ 断言 `blocker_reason` / `failure_reason` 可指认到缺失的键名；
 * - 若不写 ⇒ 断言现状（停在 `processing`、原因是认领时的通用占位、`failure_reason` 为 `null`），
 *   **并同时证明该断言不空转**：同一个缺失键名在判据 2 的内核事件里**确实出现**。
 *   ⇒ "键名已被记录，但**不在工作项上**"是一个有内容的结论，而不是"没找到"。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolveHostPath } from 'node:path';

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
  type FactRef,
  type RequestId,
  type SharedFactRecord,
  type Store,
  type TaskId,
} from '../../../src/protocol/index.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/scheduler.js';
import type { RunPublication } from '../../../src/scheduler/runs.js';
import {
  GROUP_ID,
  INSTANCE_C,
  TASK_ID,
  buildStore,
  readTx,
  registerInstance,
  registerTask,
  requestId,
  workRequest,
} from '../../../src/scheduler/test-support.js';
import { createFsArtifactMaterializationPort } from './fs-artifact-port.js';

// ---------------------------------------------------------------------------
// 场景常量
// ---------------------------------------------------------------------------

const REVISION_1 = asRevision(1);
/** Agent **自称**的结果引用——内核必须用产物 id 覆盖（或整条拒绝），不得采信。 */
const AGENT_CLAIM = asArtifactRef('V8-agent-self-claimed');
const DOC_HEADCOUNT = asFactRef('V8-F-document-headcount');
const DOC_BUDGET = asFactRef('V8-F-document-budget');

/** 文档产物消费的事实键（两个数值型键——数值 / 单位形态与 `p1` / `p3` 同源）。 */
const DOC_FACT_KEYS: readonly string[] = ['headcount', 'budget.total'];
/** 本包**故意不登记**的事实键——它就是"缺的那条资料"。 */
const MISSING_FACT_KEY = 'budget.total';

// ---------------------------------------------------------------------------
// 夹具（本文件内自建；只经公开入口驱动）
// ---------------------------------------------------------------------------

interface Bench {
  readonly store: Store;
  /** 产物根（正斜杠形态；`planArtifact` 的路径纪律）。 */
  readonly root: string;
  readonly port: { readonly calls: number };
  readonly scheduler: Scheduler;
}

const CREATED_ROOTS: string[] = [];

function makeRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `potbot-v8-${label}-`));
  CREATED_ROOTS.push(dir);
  return dir.split('\\').join('/');
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** 递归删除；重试用尽则**打印警告并保留目录**（不掩盖、也不判红）。 */
function removeWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        console.warn(`[V8] 清理临时目录失败（保留现场）：${dir} — ${String(error)}`);
        return;
      }
      sleepSync(50);
    }
  }
}

afterEach(() => {
  for (const dir of CREATED_ROOTS.splice(0)) {
    removeWithRetry(dir);
  }
});

/** 递归列出目录下的**文件**（目录本身不存在 ⇒ 空数组）。 */
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

/** 一条已确认的事实（数值型；`unit` 必填——缺失单位会被 `src/facts` 拒绝）。 */
function factOf(spec: {
  readonly id: FactRef;
  readonly key: string;
  readonly amount: number;
  readonly unit: string;
}): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: spec.id,
    task_id: TASK_ID,
    task_revision: REVISION_1,
    fact_key: spec.key,
    value: { kind: 'known', value: { type: 'number', amount: spec.amount, unit: spec.unit, currency: null } },
    source: { kind: 'user_confirmation', detail: 'V8 夹具：用户确认' },
    confirmed_by: INSTANCE_C,
    confirmed_at: asLogicalTime(0),
  });
}

/**
 * 建基准夹具。
 *
 * @param compact 是否登记**全部**文档事实键。`false` ⇒ `event.date` **不登记**（缺事实臂）。
 */
function makeBench(label: string, compact: boolean): Bench {
  const store = buildStore();
  registerInstance(store, INSTANCE_C);
  registerTask(store, { task_id: TASK_ID, group_id: GROUP_ID, revision: REVISION_1 });

  readTx(store, (tx) => {
    tx.putSharedFact(factOf({ id: DOC_HEADCOUNT, key: 'headcount', amount: 8, unit: '人' }));
    if (compact) {
      tx.putSharedFact(factOf({ id: DOC_BUDGET, key: 'budget.total', amount: 600, unit: '元' }));
    }
  });

  const root = makeRoot(label);
  const port = createFsArtifactMaterializationPort({
    // 版本闸门的唯一读口：**当前**任务版本（读不到 ⇒ null，不猜默认版本）。
    read_revision: (taskId: TaskId) =>
      store.snapshot().tasks.find((task) => task.task_id === taskId)?.revision ?? null,
    now: () => asLogicalTime(0),
  });

  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    default_task_id: TASK_ID,
    artifact_root_dir: root,
    artifacts: { port },
  });

  return { store, root, port, scheduler };
}

/** 一条"带产物意图"的完成发布（Agent **只**给意图 + 事实键；标题不含数字）。 */
function completedWithDocument(request: RequestId, title: string): RunPublication {
  return {
    kind: 'completed',
    request_id: request,
    result_refs: [AGENT_CLAIM],
    artifact: {
      intent: {
        template_kind: 'document',
        requirement: { title, description: 'V8 独立验收：按已确认共享事实生成的文档' },
        references: [],
      },
      fact_keys: DOC_FACT_KEYS,
    },
  };
}

/** 只读：某项工作项的**原因字段**（断言一律经快照读）。 */
interface WorkItemView {
  readonly status: string;
  readonly result_refs: readonly string[];
  readonly failure_reason: string | null;
  readonly blocker_kind: string | null;
  readonly blocker_detail: string | null;
}

function workItemViewOf(store: Store, request: RequestId): WorkItemView | undefined {
  const item = store.snapshot().work_items.find((candidate) => candidate.request_id === request);
  if (item === undefined) return undefined;
  return {
    status: item.status,
    result_refs: item.result_refs.map(String),
    failure_reason: item.failure_reason,
    blocker_kind: item.blocker_reason === null ? null : item.blocker_reason.kind,
    blocker_detail: item.blocker_reason === null ? null : item.blocker_reason.detail,
  };
}

/** 存储里全部 `publication_rejected` 观测（判据 2 的取证面）。 */
function rejectionEvents(store: Store): readonly { readonly data: Readonly<Record<string, unknown>> }[] {
  return store
    .snapshot()
    .kernel_events.filter((event) => event.kind === 'publication_rejected')
    .map((event) => ({ data: event.data }));
}

/** 完成一次"投递 → 启动 → 收尾"，返回 run_id 与收尾结果。 */
function runOnce(
  bench: Bench,
  publications: readonly RunPublication[],
): { readonly run_id: string; readonly finish: ReturnType<Scheduler['finishRun']> } {
  const delivered = bench.scheduler.onMessage(workRequest(1));
  expect(delivered.result).toBe('accepted');
  const started = bench.scheduler.startRun({ instance_id: INSTANCE_C });
  expect(started.started).toBe(true);
  expect(started.claimed_request_ids).toEqual([requestId('r-1')]);
  const runId = started.run?.run_id;
  if (runId === undefined) {
    throw new Error('V8 夹具错误：轮次未启动');
  }
  const finish = bench.scheduler.finishRun({ run_id: runId, publications });
  return { run_id: runId, finish };
}

// ---------------------------------------------------------------------------
// 判据 1 / 2 / 3 / 4 —— 缺事实臂
// ---------------------------------------------------------------------------

describe('缺事实臂：发布被拒 + 内核留痕 + 产物侧无假交付 + 工作项层如实判定', () => {
  it('1：发布被拒且拒因可指认（ledger_reason=missing_fact，message 含缺失键名）', () => {
    const bench = makeBench('missing-1', false);

    // 夹具自检：确实只登记了 headcount，`event.date` 不在事实表里。
    readTx(bench.store, (tx) => {
      expect(tx.listSharedFacts().map((fact) => fact.fact_key)).toEqual(['headcount']);
    });

    const { finish } = runOnce(bench, [completedWithDocument(requestId('r-1'), '缺资料报告')]);

    // 收尾事务本身**被接受**（逐条粒度：拒的是那一条发布，不是整轮）。
    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([]);
    expect(finish.rejected_publications).toHaveLength(1);

    const rejection = finish.rejected_publications[0];
    expect(rejection?.request_id).toBe(requestId('r-1'));
    expect(rejection?.ledger_reason).toBe('missing_fact');
    // 拒因**可指认**：message 非空，且**含缺失的键名**（不是"出错了"这种不可指认的话）。
    expect(rejection?.message.length).toBeGreaterThan(0);
    expect(rejection?.message.includes(MISSING_FACT_KEY)).toBe(true);
    expect(finish.artifact_facts).toEqual([]);
    // design-02「验证方式」要求每次输出**失败分支的报告内容**（可重复执行、逐次可见）。
    console.log('[V8] 失败分支报告内容（rejected_publications[0].message）：', rejection?.message);
  });

  it('2：内核留下可持久化证据——publication_rejected 的 data 指认缺失的事实键', () => {
    const bench = makeBench('missing-2', false);
    runOnce(bench, [completedWithDocument(requestId('r-1'), '缺资料报告')]);

    const events = rejectionEvents(bench.store);
    // 夹具自检：内核确实写了取证事件（否则下面的断言是空集通过）。
    expect(events).toHaveLength(1);
    expect(events[0]?.data['reason']).toBe('missing_fact');
    const message = events[0]?.data['message'];
    expect(typeof message).toBe('string');
    expect(String(message).includes(MISSING_FACT_KEY)).toBe(true);
    // 事件参与持久化：它在**提交后**的存储快照里可读（这正是"如实报告"的落库形式）。
    expect(bench.store.snapshot().kernel_events.some((e) => e.kind === 'publication_rejected')).toBe(true);
    console.log('[V8] 落库的失败分支报告（publication_rejected.data）：', JSON.stringify(events[0]?.data));
  });

  it('3：产物侧无假交付——零记录、盘上零文件、端口零调用、无任何 published 记录', () => {
    const bench = makeBench('missing-3', false);
    const { finish } = runOnce(bench, [completedWithDocument(requestId('r-1'), '缺资料报告')]);
    expect(finish.rejected_publications).toHaveLength(1);

    // ① 集合为空（没有该产物的记录，也没有"补一个零值产物"的替代品）。
    expect(snapshotArtifacts(bench.store.snapshot())).toEqual([]);
    // ② 盘上零文件（产物根根本不该被创建）。
    expect(collectFiles(bench.root)).toEqual([]);
    // ③ 端口零调用（没有任何物化尝试）。
    expect(bench.port.calls).toBe(0);
    // ④ **不存在任何 published 记录**（把"已交付"的证据面单独再断言一次；
    //    与 ① 的区别是：① 管"一条都没有"，④ 管"没有任何一条被冒充成已交付"）。
    const published = snapshotArtifacts(bench.store.snapshot()).filter((record) => record.status === 'published');
    expect(published).toEqual([]);
  });

  it('4：工作项层——断言现状：停在 processing、原因不指认缺失键（如实登记缺口）', () => {
    const bench = makeBench('missing-4', false);
    const { finish } = runOnce(bench, [completedWithDocument(requestId('r-1'), '缺资料报告')]);
    expect(finish.rejected_publications).toHaveLength(1);

    const item = workItemViewOf(bench.store, requestId('r-1'));
    // 夹具自检：工作项确实存在，且被本轮认领过（否则"停在 processing"无从谈起）。
    expect(item).toBeDefined();
    expect(item?.status).toBe('processing');
    expect(item?.result_refs).toEqual([]);

    // **非空转的自证**：缺失键名在判据 2 的内核事件里**确实出现**……
    const eventTells = rejectionEvents(bench.store).some((event) =>
      String(event.data['message'] ?? '').includes(MISSING_FACT_KEY),
    );
    expect(eventTells).toBe(true);

    // ……但**工作项的原因字段里没有它**（现状）：`failure_reason` 为 null，
    // `blocker_reason` 是认领时的通用占位，不指认这条资料缺失、也不指认 `missing_fact`。
    expect(item?.failure_reason).toBeNull();
    expect(item?.blocker_kind).toBe('other');
    expect(item?.blocker_detail).not.toBeNull();
    expect(String(item?.blocker_detail).includes(MISSING_FACT_KEY)).toBe(false);
    expect(String(item?.blocker_detail).includes('missing_fact')).toBe(false);

    // ⇒ 结论（如实登记）：design-02 需求 5「如实报告未知 / 部分完成」在**工作项层**尚未成立；
    //    可指认的证据目前只活在 `rejected_publications` 与 `publication_rejected` 事件里。
    //    本包**不改 `src/**`**（派发约束），故该缺口保留在 `v7-coverage-map.test.ts` 的 `GAPS`。
  });
});

// ---------------------------------------------------------------------------
// 判据 5 —— 对照组：事实齐备 ⇒ 发布成功（证明 1–3 不是恒真）
// ---------------------------------------------------------------------------

describe('对照组（防恒假）：事实齐备 ⇒ 发布成功、工作项完成、没有 publication_rejected', () => {
  it('5：同一装置、同一意图，只把缺失的事实补上 ⇒ 结局整体翻转', () => {
    const bench = makeBench('complete-5', true);

    // 夹具自检：这次两个键都登记了。
    readTx(bench.store, (tx) => {
      expect(tx.listSharedFacts().map((fact) => fact.fact_key)).toEqual(['headcount', 'budget.total']);
    });

    const { finish } = runOnce(bench, [completedWithDocument(requestId('r-1'), '齐备资料报告')]);

    // 发布被接受、没有一条被拒。
    expect(finish.accepted).toBe(true);
    expect(finish.applied_request_ids).toEqual([requestId('r-1')]);
    expect(finish.rejected_publications).toEqual([]);
    expect(finish.artifact_facts).toHaveLength(1);

    // 产物真的产出了：恰好一条已交付记录，盘上恰好一个文件，端口恰好被调一次。
    const records = snapshotArtifacts(bench.store.snapshot());
    expect(records).toHaveLength(1);
    const record: ArtifactRecord | undefined = records[0];
    if (record === undefined) {
      throw new Error('V8 夹具错误：对照组产物记录缺失');
    }
    expect(record.status).toBe('published');
    expect(isDeliveredArtifact(record)).toBe(true);
    const finalPath = resolveHostPath(record.receipt?.final_path ?? '');
    expect(existsSync(finalPath)).toBe(true);
    expect(sha256OfFile(finalPath)).toBe(record.content_digest);
    expect(bench.port.calls).toBe(1);
    expect(collectFiles(bench.root)).toHaveLength(1);

    // 工作项完成，且结果引用是**内核产出的产物 id**（不是 Agent 自报的那个）。
    const item = workItemViewOf(bench.store, requestId('r-1'));
    expect(item?.status).toBe('completed');
    expect(item?.result_refs).toEqual([record.artifact_id]);
    expect(item?.result_refs).not.toContain(AGENT_CLAIM);

    // 与缺事实臂的**唯一差别**就是事实是否齐备：这里一条拒因都没有。
    expect(rejectionEvents(bench.store)).toEqual([]);
  });
});
