/**
 * **V3 独立验收（D02A-V3）**：从**外部证伪** P1 的四条不变量（I-1…I-4）与
 * "外部副作用只在提交之后"（info-006）。
 *
 * ## 本文件与 `src/artifacts/publish.test.ts` 的关系（为什么还要一份）
 *
 * 那份用例由**实现者**（W-E）编写，证据链是"实现 → 自己的断言"。本文件的任务不是复述它，
 * 而是**自造反例**去证伪同一批主张：
 * - 端口夹具、计时器与事务边界记录器**全部在本文件内自建**（不复用 `ports.ts` 的收集型端口，
 *   因为 `ports.ts` 本身就是被测对象之一）；
 * - 负例的"结构化失败"字面量**就地构造**，不调用 `materializationFailure()` 助手——
 *   否则"端口返回失败"这条负例的成立会依赖被测模块自己；
 * - 成功/失败回执的期望值取自**本文件自己造的数**（与计划里的期望摘要**故意不同**），
 *   用来检验记录里的内容摘要确实来自端口回读、而不是拿计划值冒充。
 *
 * ## 覆盖的判据（逐条对应 V3 任务书）
 *
 * | # | 判据 | 用例 |
 * |---|---|---|
 * | 1 | I-1：`published` ⟹ 有回执且 `content_digest === receipt.readback_digest`；**无反例**：成功但缺回读摘要 ⇒ 不得成 `published` | §I-1 |
 * | 2 | I-4：`staged` 不满足交付判据、无回执、构造期拒绝"staged + 回执" | §I-4 |
 * | 3 | 幂等：同一 `artifact_id` 投影两次 ⇒ 只写一次、端口只调一次、不重复发发布观测 | §幂等 |
 * | 4 | 版本闸门：物化前版本被超越 ⇒ 端口零调用、无回执、记录不是 `published`（合同 R49.1：记 `superseded`） | §版本闸门 |
 * | 5 | 外部副作用只在提交之后：端口回调不在事务内、段1 提交索引 < 端口调用索引、提交前失败零副作用、`afterCommitBeforePublish` 抛错仍恰好补齐一次 | §时序 |
 * | 6 | 失败不得倒退：结构化失败 ⇒ 失败态、`detail` 非空、不得退回 `published` | §失败 |
 * | 7 | `verify.ts` 真的会报错（自造反例）：改一字节 / 删 `[Content_Types].xml` / 加 BOM | §自检 |
 * | 8 | 不得自造回执：行为 + 源码两路断言 | §回执 |
 *
 * ## 边界（本文件**证不到**的）
 *
 * - I-2 的磁盘侧（"最终路径此刻是否真的存在"）由第 2/3 层承担；本文件至多证到端口回读；
 * - "端口确实逐字节读了盘"只能靠端口契约 + 第 2 层，本文件**不声称**；
 * - 本文件不调用 `openWithOffice`，不跑别处的测试。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_FAILURE_KINDS,
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createTaskRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  ValidationError,
  type ArtifactFailureKind,
  type ArtifactRecord,
  type ArtifactStatus,
  type StorageTransaction,
  type Store,
  type TaskId,
  type TaskRecord,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import {
  assembleOpcPackage,
  CONTENT_TYPES_PART_PATH,
  RELATIONSHIPS_CONTENT_TYPE,
  writeZip,
  XML_DECLARATION,
  type ZipEntry,
} from '../../../src/artifacts/ooxml/index.js';
import { planArtifact } from '../../../src/artifacts/planner.js';
import type {
  ArtifactMaterializationPort,
  ArtifactMaterializationReceipt,
  ArtifactMaterializationRequest,
  ArtifactMaterializationResult,
} from '../../../src/artifacts/ports.js';
import {
  createArtifactPublicationProjection,
  createStagedArtifactFact,
  type ArtifactPublicationOutcome,
  type ArtifactPublicationStore,
  type StagedArtifactFact,
} from '../../../src/artifacts/publish.js';
import { selfCheckArtifactBytes } from '../../../src/artifacts/verify.js';

// ---------------------------------------------------------------------------
// 夹具（全部本地自建）
// ---------------------------------------------------------------------------

const TASK_ID: TaskId = asTaskId('T-v3');
const INSTANCE_ID = asInstanceId('C-v3');
const FACT_REF = asFactRef('F-v3');
const ROOT = '/root/v3-artifacts';
/** 计划里的"期望摘要"——**故意**与端口回读摘要不同（见 §I-1 的正向用例）。 */
const PLAN_DIGEST = 'sha256:plan-expectation-v3';
/** 端口回读摘要：本文件自造的数，代表"对最终路径实际回读"的结果。 */
const READBACK_DIGEST = 'sha256:readback-v3';
const AT = asLogicalTime(101);

interface Bench {
  readonly store: Store;
  readonly request: ArtifactMaterializationRequest;
  readonly staged: ArtifactRecord;
  readonly task: (revision: number) => TaskRecord;
}

/** 一条 tx1 的已提交事实（staged 记录 + 当次物化请求）。 */
function bench(revision = 3, artifactVersion = 1): Bench {
  const store = createMemoryStore();
  const taskRevision = asRevision(revision);
  const plan = planArtifact({
    task_id: TASK_ID,
    task_revision: taskRevision,
    template_kind: 'document',
    artifact_version: artifactVersion,
    root_dir: ROOT,
    expected_content_digest: PLAN_DIGEST,
  });
  const request: ArtifactMaterializationRequest = {
    artifact_id: plan.artifact_id,
    task_id: TASK_ID,
    task_revision: taskRevision,
    template_kind: 'document',
    fact_snapshot: [
      {
        fact_ref: FACT_REF,
        fact_key: 'headcount',
        value: { type: 'number', amount: 8, unit: '人', currency: null },
        source: { kind: 'user_confirmation', detail: '用户确认（V3 夹具）' },
      },
    ],
    plan,
    expected_content_digest: plan.expected_content_digest,
  };
  const staged = createArtifactRecord({
    artifact_id: plan.artifact_id,
    task_id: TASK_ID,
    task_revision: taskRevision,
    artifact_version: artifactVersion,
    template_kind: 'document',
    byte_length: 0,
    content_digest: PLAN_DIGEST,
    source_fact_refs: [FACT_REF],
    created_by_instance_id: INSTANCE_ID,
    status: 'staged',
    created_at: asLogicalTime(11),
  });
  const task = (current: number): TaskRecord =>
    createTaskRecord({
      task_id: TASK_ID,
      goal: 'V3 独立验收夹具',
      created_at: asLogicalTime(1),
      revision: asRevision(current),
    });
  return { store, request, staged, task };
}

function factOf(value: Bench): StagedArtifactFact {
  return createStagedArtifactFact(value.staged, value.request);
}

function putTask(store: Store, task: TaskRecord): void {
  store.transact((tx) => {
    tx.putTask(task);
  });
}

function artifactsOf(store: Store): readonly ArtifactRecord[] {
  return snapshotArtifacts(store.snapshot());
}

/** 本文件自造的成功回执（`readback_digest` 由调用方给，默认与本文件自造值一致）。 */
function receiptFor(
  request: ArtifactMaterializationRequest,
  readbackDigest: string = READBACK_DIGEST,
): ArtifactMaterializationReceipt {
  return {
    artifact_id: request.artifact_id,
    final_path: request.plan.final_path,
    readback_digest: readbackDigest,
    byte_length: 2048,
    entry_count: 4,
    verifier: 'tests/acceptance/office/v3-publish-independent（V3 独立验收端口）',
    at: AT,
  };
}

function okResult(
  request: ArtifactMaterializationRequest,
  readbackDigest: string = READBACK_DIGEST,
): ArtifactMaterializationResult {
  return { ok: true, receipt: receiptFor(request, readbackDigest) };
}

/** **就地构造**结构化失败（不调用被测模块的 `materializationFailure` 助手）。 */
function failResult(
  request: ArtifactMaterializationRequest,
  kind: ArtifactFailureKind,
  detail: string,
): ArtifactMaterializationResult {
  return {
    ok: false,
    failure: { artifact_id: request.artifact_id, kind, detail, at: AT },
  };
}

/** 记录调用的端口（自建；`onCall` 在**进入 materialize 之后、返回之前**触发）。 */
class RecordingPort implements ArtifactMaterializationPort {
  readonly calls: ArtifactMaterializationRequest[] = [];
  readonly #respond: (request: ArtifactMaterializationRequest) => ArtifactMaterializationResult;
  readonly #onCall: (() => void) | undefined;

  constructor(
    respond: (request: ArtifactMaterializationRequest) => ArtifactMaterializationResult,
    onCall?: () => void,
  ) {
    this.#respond = respond;
    this.#onCall = onCall;
  }

  materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
    this.calls.push(request);
    this.#onCall?.();
    return this.#respond(request);
  }
}

/**
 * 记录**事务边界**的存储包装：统计事务次数、事务嵌套深度、`putArtifact` 次数，
 * 并把进入/提交/回滚写进共享日志（与端口日志拼成统一时序）。
 *
 * 深度 `openTransactions` 是"端口回调期间不在任何事务内"的直接判据。
 */
class InstrumentedStore implements ArtifactPublicationStore {
  readonly artifactWrites: ArtifactRecord[] = [];
  transactions = 0;
  openTransactions = 0;
  maxOpenTransactions = 0;

  constructor(
    readonly inner: Store,
    readonly log: string[] = [],
  ) {}

  snapshot(): ReturnType<Store['snapshot']> {
    return this.inner.snapshot();
  }

  transact<T>(work: (tx: StorageTransaction) => T): T {
    this.transactions += 1;
    this.openTransactions += 1;
    this.maxOpenTransactions = Math.max(this.maxOpenTransactions, this.openTransactions);
    this.log.push('tx:begin');
    try {
      const result = this.inner.transact((tx) => work(this.#thruCountingView(tx)));
      this.log.push('tx:commit');
      return result;
    } catch (error) {
      this.log.push('tx:rollback');
      throw error;
    } finally {
      this.openTransactions -= 1;
    }
  }

  /** 透传事务视图，但把 `putArtifact` 计一次数（用于"第二次没有新增任何记录"）。 */
  #thruCountingView(tx: StorageTransaction): StorageTransaction {
    return new Proxy(tx as object, {
      get: (target, property) => {
        if (property === 'putArtifact') {
          return (record: ArtifactRecord): void => {
            this.artifactWrites.push(record);
            (target as StorageTransaction).putArtifact(record);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as StorageTransaction;
  }
}

// ---------------------------------------------------------------------------
// §I-1  published ⟹ 有回执，且内容摘要 = 端口回读摘要
// ---------------------------------------------------------------------------

describe('I-1：published 的证据是端口回执，且 content_digest === receipt.readback_digest', () => {
  it('正向：内容摘要取端口回读值，而不是计划里的期望摘要', () => {
    const built = bench();
    putTask(built.store, built.task(3));
    const port = new RecordingPort((request) => okResult(request, READBACK_DIGEST));
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(outcome.kind).toBe('published');
    const record = outcome.record;
    expect(record).not.toBeNull();
    expect(record?.status).toBe('published');
    expect(isDeliveredArtifact(record!)).toBe(true);
    // 判据本体：
    expect(record?.content_digest).toBe(READBACK_DIGEST);
    expect(record?.receipt?.readback_digest).toBe(record?.content_digest);
    // 反冒充：内容摘要**不得**等于计划里的期望摘要
    expect(record?.content_digest).not.toBe(built.request.plan.expected_content_digest);
    expect(built.request.plan.expected_content_digest).toBe(PLAN_DIGEST);
  });

  it('自造反例：端口报成功但回执缺/空回读摘要（或空最终路径）⇒ 记录不得成为 published', () => {
    const variants: readonly { readonly what: string; readonly receipt: ArtifactMaterializationReceipt }[] =
      (() => {
        const base = bench();
        return [
          {
            what: 'readback_digest 缺失',
            receipt: {
              ...receiptFor(base.request),
              readback_digest: undefined as unknown as string,
            },
          },
          {
            what: 'readback_digest 为空串',
            receipt: { ...receiptFor(base.request), readback_digest: '' },
          },
          {
            what: 'final_path 为空串',
            receipt: { ...receiptFor(base.request), final_path: '' },
          },
        ];
      })();

    for (const variant of variants) {
      const built = bench();
      putTask(built.store, built.task(3));
      const port = new RecordingPort((request) => ({ ok: true, receipt: variant.receipt }));
      const projection = createArtifactPublicationProjection({ store: built.store, port });

      let thrown: unknown;
      let outcome: ArtifactPublicationOutcome | undefined;
      try {
        outcome = projection.reconcileOne(factOf(built), AT);
      } catch (error) {
        thrown = error;
      }

      const stored = artifactsOf(built.store);
      // 判据：无论如何，**不得**出现一条 published（含"已被交付判据认可"）的记录
      expect(
        stored.some((record) => record.status === 'published'),
        `${variant.what}：出现了 published 记录（I-1 被击穿）`,
      ).toBe(false);
      expect(stored.every((record) => !isDeliveredArtifact(record))).toBe(true);

      // 如实记录实现形态：构造期即拒（抛 ValidationError），而不是结构化失败记录
      if (thrown !== undefined) {
        expect(thrown, variant.what).toBeInstanceOf(ValidationError);
        expect(String((thrown as Error).message)).toMatch(/content_digest|readback_digest|final_path/);
      } else {
        expect(outcome?.kind, variant.what).not.toBe('published');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §I-4  staged 不满足任何交付判据
// ---------------------------------------------------------------------------

describe('I-4：staged 不满足任何"已交付"判据，且没有回执', () => {
  it('staged 记录：交付判据为 false、receipt 为 null', () => {
    const built = bench();
    expect(built.staged.status).toBe('staged');
    expect(isDeliveredArtifact(built.staged)).toBe(false);
    expect(built.staged.receipt).toBeNull();
    expect(built.staged.failure_kind).toBeNull();
  });

  it('构造期即拒：staged 携带回执（I-4 的可判定形式）', () => {
    const built = bench();
    expect(() =>
      createArtifactRecord({ ...built.staged, receipt: receiptFor(built.request) }),
    ).toThrow(ValidationError);
  });

  it('投影之后：旧 staged 对象仍不构成交付；存储里那条才是 published', () => {
    const built = bench();
    putTask(built.store, built.task(3));
    const port = new RecordingPort((request) => okResult(request));
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    expect(projection.reconcileOne(factOf(built), AT).kind).toBe('published');

    expect(isDeliveredArtifact(built.staged)).toBe(false);
    expect(built.staged.receipt).toBeNull();
    const stored = artifactsOf(built.store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('published');
    expect(isDeliveredArtifact(stored[0]!)).toBe(true);
  });

  it('staged 是"可恢复的中间态"：它本身不落回执，也不需要回执就能存在于存储', () => {
    const built = bench();
    putTask(built.store, built.task(3));
    built.store.transact((tx) => {
      tx.putArtifact(built.staged);
    });
    const stored = artifactsOf(built.store);
    expect(stored.map((record) => record.status)).toEqual(['staged']);
    expect(stored[0]?.receipt).toBeNull();
    expect(isDeliveredArtifact(stored[0]!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §幂等  同一 artifact_id 投影两次
// ---------------------------------------------------------------------------

describe('幂等（R49.1 段3）：同一 artifact_id 投影两次只写一次、端口只调一次', () => {
  it('第二次投影：零事务、零记录写入、零端口调用、不重复发发布观测', () => {
    const built = bench();
    putTask(built.store, built.task(3));
    const store = new InstrumentedStore(built.store);
    const port = new RecordingPort((request) => okResult(request));
    let hookCalls = 0;
    const projection = createArtifactPublicationProjection({
      store,
      port,
      hooks: {
        writeObservationInTransaction: (tx, observation) => {
          hookCalls += 1;
          // 钩子必须在事务体内，且能看到刚刚写入的记录
          expect(tx.getArtifact(observation.artifact_id)).toBeDefined();
        },
      },
    });
    const fact = factOf(built);

    const first = projection.reconcileOne(fact, AT);
    const transactionsAfterFirst = store.transactions;
    const writesAfterFirst = store.artifactWrites.length;

    const second = projection.reconcileOne(fact, asLogicalTime(AT + 1));

    expect(first.kind).toBe('published');
    expect(second.kind).toBe('skipped_already_published');
    expect(store.artifactWrites.length).toBe(writesAfterFirst);
    expect(store.transactions).toBe(transactionsAfterFirst);
    expect(port.calls).toHaveLength(1);
    expect(hookCalls).toBe(1);
    expect(artifactsOf(built.store)).toHaveLength(1);
    expect(projection.snapshot().materialization_calls).toBe(1);
    expect(projection.snapshot().published_count).toBe(1);
    expect(projection.observations().filter((o) => o.kind === 'artifact_published')).toHaveLength(1);
    // 如实记录：第二次会在**投影内部日志**里追加一条 artifact_publish_skipped
    //（不开事务、不写内核事件、不重复发布观测）——见报告"非阻断观察"。
    expect(projection.observations().map((o) => o.kind)).toEqual([
      'artifact_published',
      'artifact_publish_skipped',
    ]);
  });

  it('已在存储里的 published 记录（跨投影实例）同样只跳过、不重物化', () => {
    const built = bench();
    putTask(built.store, built.task(3));
    const portA = new RecordingPort((request) => okResult(request));
    const projectionA = createArtifactPublicationProjection({ store: built.store, port: portA });
    expect(projectionA.reconcileOne(factOf(built), AT).kind).toBe('published');

    // 新的投影实例（模拟重启后的重放）：权威来源是存储，不是内存里的 applied 集合
    const portB = new RecordingPort((request) => okResult(request));
    const projectionB = createArtifactPublicationProjection({ store: built.store, port: portB });
    const replay = projectionB.reconcileOne(factOf(built), asLogicalTime(AT + 50));

    expect(replay.kind).toBe('skipped_already_published');
    expect(portB.calls).toHaveLength(0);
    expect(projectionB.snapshot().materialization_calls).toBe(0);
    expect(artifactsOf(built.store)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §版本闸门  任务书 §13 / R49.1 段2
// ---------------------------------------------------------------------------

describe('版本闸门（任务书 §13）：版本被超越 ⇒ 端口零调用、记录不是 published', () => {
  it('记录绑 r1、任务已到 r2 ⇒ 放弃物化，端口零调用', () => {
    const built = bench(1);
    putTask(built.store, built.task(2));
    const store = new InstrumentedStore(built.store);
    const port = new RecordingPort(() => {
      throw new Error('版本闸门未通过时端口不得被调用（V3 探针）');
    });
    const projection = createArtifactPublicationProjection({ store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(port.calls).toEqual([]);
    expect(projection.snapshot().materialization_calls).toBe(0);
    expect(outcome.kind).not.toBe('published');
    expect(outcome.record).not.toBeNull();
    expect(isDeliveredArtifact(outcome.record!)).toBe(false);
    const stored = artifactsOf(built.store);
    expect(stored).toHaveLength(1);
    expect(isDeliveredArtifact(stored[0]!)).toBe(false);
    // 终态且非交付（不把实现选的终态名钉成期望，见下一条"偏离记录"）
    expect(['failed', 'superseded', 'expired'] satisfies readonly ArtifactStatus[]).toContain(
      stored[0]!.status,
    );
    expect(store.openTransactions).toBe(0);
  });

  it('合同的终态是 superseded（不是 failed）：版本被超越时记录保留为历史、不得冒充当前结果', () => {
    const built = bench(1);
    putTask(built.store, built.task(2));
    const port = new RecordingPort(() => {
      throw new Error('不该被调用');
    });
    const projection = createArtifactPublicationProjection({ store: built.store, port });
    projection.reconcileOne(factOf(built), AT);

    const stored = artifactsOf(built.store)[0]!;
    // 合同 R49.1 段2："放弃物化并记 superseded"。
    // 留痕：2026-10-02 首轮 V3 跑（publish.ts:fe060b7a 之前的一版）此处是 `failed`，
    // 与合同偏离；并发改动把 version_stale 映射到 `superseded` 后本合同判据成立。
    expect(stored.status).toBe('superseded');
    expect(stored.failure_kind).toBe('version_stale'); // 原因仍保留，便于追溯
    expect(stored.receipt).toBeNull();
    expect(isDeliveredArtifact(stored)).toBe(false);
  });

  it('构造场景（非阻断观察）：superseded 没有"不得退回 published"的守卫（单调版本下不可达）', () => {
    const built = bench(1);
    putTask(built.store, built.task(2)); // 当前 r2 ≠ 记录 r1 ⇒ 过期
    const projection = createArtifactPublicationProjection({
      store: built.store,
      port: new RecordingPort(() => {
        throw new Error('第一轮不该被调用');
      }),
    });
    expect(projection.reconcileOne(factOf(built), AT).record?.status).toBe('superseded');

    // 把任务版本改回 r1（**非单调**的构造场景；真实系统里 revision 只增不减，
    // 因此这条路径在真实运行中不可达——这里只用来暴露状态机的硬化缺口）。
    putTask(built.store, built.task(1));

    // 新的投影实例（模拟重启后的重放；applied 集合为空，存储是唯一权威）
    const reopenedPort = new RecordingPort((request) => okResult(request));
    const reopened = createArtifactPublicationProjection({ store: built.store, port: reopenedPort });
    const outcome = reopened.reconcileOne(factOf(built), asLogicalTime(AT + 9));

    // 实测（2026-10-02，publish.ts fe060b7a）：superseded 记录被**重新物化**并翻成 published。
    // 对比：`failed` 有 refused_after_failure 守卫（见 §失败），`superseded` **没有**。
    // 真实系统 revision 只增不减 ⇒ 这条路径不可达；本断言因此是**硬化缺口留痕**，
    // 一旦实现补上"superseded 也不得退回"的守卫，本用例应变红并被改成守卫断言。
    const stored = artifactsOf(built.store)[0]!;
    expect(outcome.kind).toBe('published');
    expect(reopenedPort.calls).toHaveLength(1);
    expect(stored.status).toBe('published');
    expect(isDeliveredArtifact(stored)).toBe(true);
  });

  it('任务根本不在存储中（无法核对版本）⇒ 同样放弃物化，端口零调用', () => {
    const built = bench(1); // 故意不写入任务
    const port = new RecordingPort(() => {
      throw new Error('无法核对版本时端口不得被调用（V3 探针）');
    });
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(port.calls).toEqual([]);
    expect(outcome.kind).not.toBe('published');
    const stored = artifactsOf(built.store);
    expect(stored).toHaveLength(1);
    expect(isDeliveredArtifact(stored[0]!)).toBe(false);
    expect(stored[0]!.failure_kind).toBe('version_stale');
  });
});

// ---------------------------------------------------------------------------
// §时序  外部副作用只在提交之后（info-006）
// ---------------------------------------------------------------------------

describe('外部副作用只在提交之后（info-006）', () => {
  it('端口回调期间不在任何事务内，且段1 的提交索引 < 端口调用索引 < 段3 事务起始', () => {
    const built = bench(1);
    putTask(built.store, built.task(1));
    const log: string[] = [];
    const store = new InstrumentedStore(built.store, log);
    let openTransactionsDuringPortCall = -1;
    let portCallIndexInLog = -1;
    const port = new RecordingPort(
      (request) => okResult(request),
      () => {
        openTransactionsDuringPortCall = store.openTransactions;
        portCallIndexInLog = log.length;
        log.push('port:materialize');
      },
    );
    const projection = createArtifactPublicationProjection({ store, port });

    // 段1（宿主）：事务内写 staged 并提交
    built.store.transact((tx) => {
      tx.putArtifact(built.staged);
    });
    log.push('seg1:committed');

    const outcomes = projection.reconcile([factOf(built)], AT);

    expect(outcomes[0]?.kind).toBe('published');
    expect(openTransactionsDuringPortCall).toBe(0); // 端口回调时事务深度为 0
    expect(store.maxOpenTransactions).toBe(1); // 包装器观测能力自证（否则上面的 0 无意义）
    const commitIndexOfSeg1 = log.indexOf('seg1:committed');
    expect(commitIndexOfSeg1).toBeGreaterThan(-1);
    expect(portCallIndexInLog).toBeGreaterThan(-1);
    expect(portCallIndexInLog).toBeGreaterThan(commitIndexOfSeg1);
    const transactionBegins = log
      .map((entry, index) => (entry === 'tx:begin' ? index : -1))
      .filter((index) => index >= 0);
    expect(transactionBegins.length).toBeGreaterThan(0);
    // 端口调用发生在段3 事务开始**之前**
    expect(portCallIndexInLog).toBeLessThan(Math.max(...transactionBegins));
  });

  it('提交前失败 ⇒ 存储零新增、端口零调用（段1 未提交 ⇒ 无已提交事实 ⇒ 投影不被触发）', () => {
    const built = bench(1);
    putTask(built.store, built.task(1));
    const port = new RecordingPort(() => {
      throw new Error('提交前失败时端口不得被调用（V3 探针）');
    });
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    built.store.faults.beforeCommit = (): void => {
      throw new Error('提交前失败（V3 注入）');
    };

    expect(() =>
      built.store.transact((tx) => {
        tx.putArtifact(built.staged);
      }),
    ).toThrow();

    expect(artifactsOf(built.store)).toEqual([]);
    expect(port.calls).toEqual([]);
    expect(projection.snapshot().materialization_calls).toBe(0);
    expect(projection.snapshot().applied_artifact_ids).toEqual([]);
    expect(projection.snapshot().unrecorded_count).toBe(0);
  });

  it('段3 已提交但抛错（afterCommitBeforePublish）⇒ 已提交事实仍被恰好一次补齐、端口恰好一次', () => {
    const built = bench(1);
    putTask(built.store, built.task(1));
    const store = new InstrumentedStore(built.store);
    const port = new RecordingPort((request) => okResult(request));
    const projection = createArtifactPublicationProjection({ store, port });
    const fact = factOf(built);

    // 段1 已提交之后才注入故障 —— 正好命中 info-006 描述的那个窗口
    built.store.faults.afterCommitBeforePublish = (): void => {
      throw new Error('提交后投递前失败（V3 注入）');
    };

    const first = projection.reconcileOne(fact, AT);

    // catch 路径必须按**存储里的已提交记录**补齐一次（不得说"未提交"）
    expect(first.kind).toBe('published');
    expect(first.record?.status).toBe('published');
    expect(isDeliveredArtifact(first.record!)).toBe(true);
    expect(port.calls).toHaveLength(1);
    expect(projection.snapshot().published_count).toBe(1);
    expect(artifactsOf(built.store)).toHaveLength(1);

    const second = projection.reconcileOne(fact, asLogicalTime(AT + 5));
    expect(second.kind).toBe('skipped_already_published');
    expect(port.calls).toHaveLength(1); // 恰好一次
    expect(projection.snapshot().published_count).toBe(1); // 只计一次
    expect(artifactsOf(built.store)).toHaveLength(1);
  });

  it('段3 未提交 ⇒ 如实 unrecorded（不声称已发布），且留给重跑', () => {
    const built = bench(1);
    putTask(built.store, built.task(1));
    const port = new RecordingPort((request) => okResult(request));
    const brokenStore: ArtifactPublicationStore = {
      snapshot: () => built.store.snapshot(),
      transact: () => {
        throw new Error('段3 存储写入失败（V3 夹具）');
      },
    };
    const projection = createArtifactPublicationProjection({ store: brokenStore, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(outcome.kind).toBe('unrecorded');
    expect(outcome.record).toBeNull();
    expect(outcome.detail.length).toBeGreaterThan(0);
    expect(artifactsOf(built.store)).toEqual([]);
    expect(projection.snapshot().applied_artifact_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §失败  失败不得倒退 + detail 非空
// ---------------------------------------------------------------------------

describe('失败不得倒退（R49.4 / R50.2）：结构化失败 ⇒ 失败态、detail 非空、永不退回 published', () => {
  it('五种失败种类逐一：记录为终态、无回执、不可交付、detail 非空；重跑不再调端口、不退回 published', () => {
    for (const kind of ARTIFACT_FAILURE_KINDS) {
      const built = bench();
      putTask(built.store, built.task(3));
      const detail = `V3 注入的结构化失败：${kind}`;
      const port = new RecordingPort((request) => failResult(request, kind, detail));
      const projection = createArtifactPublicationProjection({ store: built.store, port });
      const fact = factOf(built);

      // 合同 R49.1 段2：版本闸门判定的 version_stale 记 `superseded`（保留为历史）；
      // 其余种类记 `failed`。
      const terminal: ArtifactStatus = kind === 'version_stale' ? 'superseded' : 'failed';

      const first = projection.reconcileOne(fact, AT);

      expect(first.kind, kind).toBe('failed'); // outcome 词汇：非 published 的段3 落库
      expect(first.failure_kind, kind).toBe(kind);
      expect(first.detail.length, kind).toBeGreaterThan(0);
      expect(first.detail, kind).toContain(detail);

      const stored = artifactsOf(built.store);
      expect(stored, kind).toHaveLength(1);
      expect(stored[0]?.status, kind).toBe(terminal);
      expect(stored[0]?.failure_kind, kind).toBe(kind);
      expect(stored[0]?.receipt, kind).toBeNull();
      expect(isDeliveredArtifact(stored[0]!), kind).toBe(false);
      expect(projection.snapshot().published_count, kind).toBe(0);

      // 重跑：端口即使"这次会成功"，也不得退回 published；端口不再被调用
      const second = projection.reconcileOne(fact, asLogicalTime(AT + 3));
      expect(second.kind, kind).toBe(
        kind === 'version_stale' ? 'skipped_already_published' : 'refused_after_failure',
      );
      expect(port.calls, kind).toHaveLength(1);
      expect(artifactsOf(built.store)[0]?.status, kind).toBe(terminal);
      expect(isDeliveredArtifact(artifactsOf(built.store)[0]!), kind).toBe(false);
    }
  });

  it('端口抛错（宿主实现崩了）⇒ 转结构化失败，不把异常抛穿投影循环', () => {
    const built = bench();
    putTask(built.store, built.task(3));
    const port = new RecordingPort(() => {
      throw new Error('宿主实现崩了（V3 探针）');
    });
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(outcome.kind).toBe('failed');
    expect(outcome.failure_kind).toBe('builder_failed');
    expect(outcome.detail).toContain('宿主实现崩了');
    const stored = artifactsOf(built.store);
    expect(stored[0]?.receipt).toBeNull();
    expect(isDeliveredArtifact(stored[0]!)).toBe(false);
  });

  it('结构化失败的失败原因文本：version_stale / self_check_failed 落进检查项；其余种类只活在 outcome 里', () => {
    // self_check_failed：记录里应能看到失败原因（verification.detail）
    const selfCheck = bench();
    putTask(selfCheck.store, selfCheck.task(3));
    const selfCheckDetail = 'V3：结构自检发现 CRC 不符';
    const selfCheckProjection = createArtifactPublicationProjection({
      store: selfCheck.store,
      port: new RecordingPort((request) => failResult(request, 'self_check_failed', selfCheckDetail)),
    });
    selfCheckProjection.reconcileOne(factOf(selfCheck), AT);
    const selfCheckRecord = artifactsOf(selfCheck.store)[0]!;
    expect(selfCheckRecord.verifications.map((v) => v.detail).join('|')).toContain(selfCheckDetail);

    // builder_failed：记录里没有承载失败原因的地方（只有 failure_kind）——
    // 这是**缺口留痕**（非阻断）：重启后只看记录无法还原原因。
    const builder = bench();
    putTask(builder.store, builder.task(3));
    const builderDetail = 'V3：构建器抛错的原因文本（不应出现在记录里）';
    const builderProjection = createArtifactPublicationProjection({
      store: builder.store,
      port: new RecordingPort((request) => failResult(request, 'builder_failed', builderDetail)),
    });
    const builderOutcome = builderProjection.reconcileOne(factOf(builder), AT);
    expect(builderOutcome.detail).toContain(builderDetail); // outcome 里有
    const builderRecord = artifactsOf(builder.store)[0]!;
    expect(JSON.stringify(builderRecord)).not.toContain(builderDetail); // 记录里没有
  });
});

// ---------------------------------------------------------------------------
// §回执  不得自造回执
// ---------------------------------------------------------------------------

describe('不得自造回执（I-1 的构造期与源码双重判据）', () => {
  it('构造期：published 缺回执 ⇒ 抛；failed 带回执 ⇒ 抛；staged 带回执 ⇒ 抛', () => {
    const built = bench();
    expect(() =>
      createArtifactRecord({
        ...built.staged,
        status: 'published',
        receipt: null,
        verifications: [{ kind: 'version_match', outcome: 'pass', detail: 'V3' }],
      }),
    ).toThrow(ValidationError);

    expect(() =>
      createArtifactRecord({
        ...built.staged,
        status: 'failed',
        failure_kind: 'write_failed',
        receipt: receiptFor(built.request),
      }),
    ).toThrow(ValidationError);

    expect(() =>
      createArtifactRecord({ ...built.staged, receipt: receiptFor(built.request) }),
    ).toThrow(ValidationError);
  });

  it('行为：端口未成功时，存储里任何记录都不得带回执（覆盖全部失败种类 + 抛错）', () => {
    const responders: readonly {
      readonly what: string;
      readonly respond: (request: ArtifactMaterializationRequest) => ArtifactMaterializationResult;
    }[] = [
      ...ARTIFACT_FAILURE_KINDS.map((kind) => ({
        what: `结构化失败 ${kind}`,
        respond: (request: ArtifactMaterializationRequest) => failResult(request, kind, `V3 ${kind}`),
      })),
      {
        what: '端口抛错',
        respond: () => {
          throw new Error('宿主崩溃（V3）');
        },
      },
    ];

    for (const responder of responders) {
      const built = bench();
      putTask(built.store, built.task(3));
      const projection = createArtifactPublicationProjection({
        store: built.store,
        port: new RecordingPort(responder.respond),
      });
      projection.reconcileOne(factOf(built), AT);

      const stored = artifactsOf(built.store);
      expect(stored.length, responder.what).toBeGreaterThan(0);
      for (const record of stored) {
        expect(record.receipt, `${responder.what}：端口没成功却出现了回执`).toBeNull();
        expect(isDeliveredArtifact(record), responder.what).toBe(false);
      }
    }
  });

  it('源码级：publish.ts 里的 readback_digest 只来自端口回执，没有硬编码摘要', () => {
    const source = readFileSync(
      new URL('../../../src/artifacts/publish.ts', import.meta.url),
      'utf8',
    );
    const assignments = source.match(/readback_digest\s*:\s*[^\n,]*/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      expect(assignment.replace(/\s+/g, ' ').trim()).toContain('receipt.readback_digest');
    }
    expect(source).not.toMatch(/readback_digest\s*:\s*['"]/);
  });
});

// ---------------------------------------------------------------------------
// §自检  verify.ts 真的会报错（自造反例）
// ---------------------------------------------------------------------------

/** V3 自造的最小 OPC 包（与模板构建器无关，避免"用实现者的用例测实现者"）。 */
const V3_MARKER = 'V3INDEPENDENTMARKER';
const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const DOCUMENT_PART_PATH = 'word/document.xml';

function documentXml(marker: string = V3_MARKER): string {
  return (
    `${XML_DECLARATION}\n` +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r>' +
    `<w:t>${marker}</w:t>` +
    '</w:r></w:p></w:body></w:document>'
  );
}

function opcEntries(documentData?: Uint8Array): readonly ZipEntry[] {
  const assembled = assembleOpcPackage({
    parts: [
      {
        path: DOCUMENT_PART_PATH,
        content_type:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        data: documentData ?? documentXml(),
      },
    ],
    content_type_defaults: [
      { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
    ],
    relationships: [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: DOCUMENT_PART_PATH }],
      },
    ],
  });
  return assembled.entries;
}

function v3PackageBytes(documentData?: Uint8Array): Buffer {
  return writeZip(opcEntries(documentData));
}

describe('verify.ts 真的会报错（V3 自造反例，不使用它自己的用例）', () => {
  it('基线自证：V3 自造的最小 OPC 包通过第 1 层自检（否则下面的反例无效）', () => {
    const result = selfCheckArtifactBytes(v3PackageBytes());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.layer).toBe(1);
    expect(result.entry_count).toBe(3);
  });

  it('改一个字节 ⇒ CRC 不符被报出', () => {
    const bytes = v3PackageBytes();
    const mutated = Buffer.from(bytes);
    const at = mutated.indexOf(V3_MARKER, 0, 'utf8');
    expect(at).toBeGreaterThan(-1);
    mutated[at] = (mutated[at]! ^ 0x01) & 0xff;

    const result = selfCheckArtifactBytes(mutated);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toContain('crc_mismatch');
  });

  it('删掉 [Content_Types].xml ⇒ 被报出', () => {
    const entries = opcEntries().filter((entry) => entry.path !== CONTENT_TYPES_PART_PATH);
    expect(entries.some((entry) => entry.path === CONTENT_TYPES_PART_PATH)).toBe(false);

    const result = selfCheckArtifactBytes(writeZip(entries));
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toContain('missing_content_types');
  });

  it('加 BOM ⇒ 被报出', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(documentXml(), 'utf8'),
    ]);
    const entries = opcEntries(withBom).map((entry) =>
      entry.path === DOCUMENT_PART_PATH ? { path: entry.path, data: withBom } : entry,
    );

    const result = selfCheckArtifactBytes(writeZip(entries));
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toContain('xml_has_bom');
  });
});

// ---------------------------------------------------------------------------
// §附  判据函数的独立性自检（防止"判据本身被写坏"）
// ---------------------------------------------------------------------------

describe('交付判据函数本身（读侧唯一判据）', () => {
  it('只有 published 且带回执才算交付；staged / failed / superseded 都不算', () => {
    const built = bench();
    const base = { ...built.staged, verifications: [{ kind: 'version_match' as const, outcome: 'pass' as const, detail: 'V3' }] };
    const receipt = receiptFor(built.request);

    expect(isDeliveredArtifact(createArtifactRecord({ ...base, status: 'published', receipt }))).toBe(true);
    expect(isDeliveredArtifact(createArtifactRecord({ ...base, status: 'staged' }))).toBe(false);
    expect(
      isDeliveredArtifact(
        createArtifactRecord({ ...base, status: 'failed', failure_kind: 'write_failed' }),
      ),
    ).toBe(false);
    expect(isDeliveredArtifact(createArtifactRecord({ ...base, status: 'superseded' }))).toBe(false);
    expect(isDeliveredArtifact(createArtifactRecord({ ...base, status: 'expired' }))).toBe(false);
    expect(asArtifactRef(built.staged.artifact_id)).toBe(built.request.artifact_id);
  });
});
