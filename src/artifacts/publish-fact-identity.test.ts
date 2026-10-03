/**
 * 发布闸门的事实身份绑定 + 「事实 → 产物」失效索引（FA-H；合同 R248 / R251；FA-Q 的 F7）。
 *
 * ## 为什么还要一份（`publish.test.ts` 已覆盖版本闸门）
 *
 * 原有的版本闸门**只比 `task_revision`**。事实可以在**同一个 `task_revision` 内**被
 * supersede（`SharedFactRecord.supersedes_fact_id`），此时任务版本没变，闸门却会让
 * **依据旧事实构建的候选**照样发布。本文件覆盖这一条**新增判据**，以及它派生的两件事：
 *
 * 1. **闸门绑事实身份**：发布判定除 `task_revision` 外还核对产物所依据的事实身份；
 *    不一致 ⇒ 拒发（沿用既有 `version_stale` 拒因，不放宽既有判据）；
 * 2. **事实 → 产物失效索引**：事实变更时**只**把受影响的产物标过期，**无关产物不动**。
 *
 * ## 三条反例（真跑）
 *
 * - 反例①：同一 `task_revision` 内改事实 ⇒ 旧候选被拒，**不得**发布旧值；
 * - 反例②：事实变更 ⇒ **只有**受影响产物过期，无关产物**逐字段不变**；
 * - 反例③（反向对照）：把新增的事实身份核对**摘掉** ⇒ 反例①变红。本文件把它拆成两层：
 *   ① 纯判据层的"非恒真"对照（`findFactInvalidatedArtifacts` 在没有取代者时必须返回空集）；
 *   ② 源码变异实验（在交付说明里给出可复算参数与原始输出）——把闸门块摘掉后反例①确实变红。
 *
 * ## 与 `publish.test.ts` 的既有夹具刻意不同
 *
 * 既有夹具**不往存储里放事实**；本文件**必须**放，因为要测的正是"事实身份 vs 当前事实"。
 */

import { describe, expect, it } from 'vitest';

import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  createTaskRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  type ArtifactRecord,
  type SharedFactRecord,
  type Store,
  type TaskId,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';
import { planArtifact } from './planner.js';
import {
  createCollectingMaterializationPort,
  materializationSuccess,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
} from './ports.js';
import {
  artifactFactIdentities,
  createArtifactPublicationProjection,
  createStagedArtifactFact,
  factValueDigest,
  findFactInvalidatedArtifacts,
  type StagedArtifactFact,
} from './publish.js';

const TASK_ID: TaskId = asTaskId('T-facts');
const INSTANCE_ID = asInstanceId('C');
const ROOT = '/root/artifacts';
const PLAN_DIGEST = 'sha256:plan';
const READBACK_DIGEST = 'sha256:readback';
const AT = asLogicalTime(10);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一条已知的数值事实（`supersedes` 给出时即"取代某条旧事实"）。 */
function numFact(
  factId: string,
  key: string,
  amount: number,
  supersedes: string | null = null,
): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(factId),
    task_id: TASK_ID,
    task_revision: asRevision(1),
    fact_key: key,
    value: { kind: 'known', value: { type: 'number', amount, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail: '用户在前台确认' },
    confirmed_by: INSTANCE_ID,
    confirmed_at: asLogicalTime(1),
    supersedes_fact_id: supersedes === null ? null : asFactRef(supersedes),
  });
}

interface Bench {
  readonly store: Store;
  readonly taskAt: (revision: number) => ReturnType<typeof createTaskRecord>;
}

function bench(): Bench {
  const store = createMemoryStore();
  const taskAt = (revision: number) =>
    createTaskRecord({
      task_id: TASK_ID,
      goal: '八人改十人（R251 场景）',
      created_at: asLogicalTime(1),
      revision: asRevision(revision),
    });
  return { store, taskAt };
}

function putTask(store: Store, task: ReturnType<typeof createTaskRecord>): void {
  store.transact((tx) => {
    tx.putTask(task);
  });
}

function putFacts(store: Store, facts: readonly SharedFactRecord[]): void {
  store.transact((tx) => {
    for (const fact of facts) tx.putSharedFact(fact);
  });
}

/** 一条候选（staged 记录 + 物化请求），绑定到某条事实的身份。 */
interface Candidate {
  readonly record: ArtifactRecord;
  readonly request: ArtifactMaterializationRequest;
}

function candidate(options: {
  readonly factId: string;
  readonly factKey: string;
  readonly amount: number;
  readonly templateKind?: 'document' | 'spreadsheet' | 'presentation';
  readonly revision?: number;
  readonly artifactVersion?: number;
}): Candidate {
  const templateKind = options.templateKind ?? 'document';
  const revision = asRevision(options.revision ?? 1);
  const plan = planArtifact({
    task_id: TASK_ID,
    task_revision: revision,
    template_kind: templateKind,
    artifact_version: options.artifactVersion ?? 1,
    root_dir: ROOT,
    expected_content_digest: PLAN_DIGEST,
  });
  const request: ArtifactMaterializationRequest = {
    artifact_id: plan.artifact_id,
    task_id: TASK_ID,
    task_revision: revision,
    template_kind: templateKind,
    fact_snapshot: [
      {
        fact_ref: asFactRef(options.factId),
        fact_key: options.factKey,
        value: { type: 'number', amount: options.amount, unit: '人', currency: null },
        source: { kind: 'user_confirmation', detail: '用户在前台确认' },
      },
    ],
    plan,
    expected_content_digest: plan.expected_content_digest,
  };
  const record = createArtifactRecord({
    artifact_id: plan.artifact_id,
    task_id: TASK_ID,
    task_revision: revision,
    artifact_version: options.artifactVersion ?? 1,
    template_kind: templateKind,
    byte_length: 0,
    content_digest: PLAN_DIGEST,
    source_fact_refs: [asFactRef(options.factId)],
    created_by_instance_id: INSTANCE_ID,
    status: 'staged',
    created_at: asLogicalTime(2),
  });
  return { record, request };
}

function asStagedFact(built: Candidate): StagedArtifactFact {
  return createStagedArtifactFact(built.record, built.request);
}

function successReceipt(request: ArtifactMaterializationRequest): ArtifactMaterializationReceipt {
  return {
    artifact_id: request.artifact_id,
    final_path: request.plan.final_path,
    readback_digest: READBACK_DIGEST,
    byte_length: 4096,
    entry_count: 5,
    verifier: 'src/artifacts/publish-fact-identity.test（夹具端口）',
    at: AT,
  };
}

function publishingProjection(store: Store): {
  readonly projection: ReturnType<typeof createArtifactPublicationProjection>;
  readonly port: ArtifactMaterializationPort & { readonly requests: readonly ArtifactMaterializationRequest[] };
} {
  const port = createCollectingMaterializationPort((request) =>
    materializationSuccess(successReceipt(request)),
  );
  const projection = createArtifactPublicationProjection({ store, port });
  return { projection, port };
}

function artifactsOf(store: Store): readonly ArtifactRecord[] {
  return snapshotArtifacts(store.snapshot());
}

// ---------------------------------------------------------------------------
// 纯判据：值摘要与事实身份
// ---------------------------------------------------------------------------

describe('事实身份的摘要基础（值摘要 / 身份清单）', () => {
  it('同一值载荷 ⇒ 同一摘要；不同值 ⇒ 不同摘要（不是恒等/恒变）', () => {
    const eight = factValueDigest({ type: 'number', amount: 8, unit: '人', currency: null });
    const eightAgain = factValueDigest({ type: 'number', amount: 8, unit: '人', currency: null });
    const ten = factValueDigest({ type: 'number', amount: 10, unit: '人', currency: null });
    expect(eight).toBe(eightAgain);
    expect(eight).not.toBe(ten);
    expect(eight).toMatch(/^[0-9a-f]{64}$/);
  });

  it('身份清单取自物化请求的已知值快照（键 + 事实 id + 值摘要）', () => {
    const built = candidate({ factId: 'F1', factKey: 'headcount', amount: 8 });
    const identities = artifactFactIdentities(built.request);
    expect(identities).toEqual([
      {
        fact_key: 'headcount',
        fact_ref: asFactRef('F1'),
        value_digest: factValueDigest({ type: 'number', amount: 8, unit: '人', currency: null }),
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 反例①：同一 task_revision 内的事实 supersession ⇒ 旧候选必须被拒
// ---------------------------------------------------------------------------

describe('反例①：同一 task_revision 内的事实 supersession ⇒ 旧候选被拒', () => {
  it('任务版本没变、但所依据的事实已被取代 ⇒ 不出版、不调端口、记录为 superseded', () => {
    const b = bench();
    putTask(b.store, b.taskAt(1));
    // 同一 r1 内：F1（8 人）被 F2（10 人）取代。
    putFacts(b.store, [numFact('F1', 'headcount', 8), numFact('F2', 'headcount', 10, 'F1')]);

    const built = candidate({ factId: 'F1', factKey: 'headcount', amount: 8 });
    const { projection, port } = publishingProjection(b.store);

    const outcome = projection.reconcileOne(asStagedFact(built), AT);

    // 前提：**旧闸门（只比 task_revision）本会放行**——任务版本确实一致。
    const task = b.store.snapshot().tasks.find((t) => t.task_id === TASK_ID);
    expect(task?.revision).toBe(asRevision(1));
    expect(built.record.task_revision).toBe(asRevision(1));

    // 新增的事实闸门必须拒发：不出版、不调端口。
    expect(outcome.kind).not.toBe('published');
    expect(outcome.failure_kind).toBe('version_stale');
    expect(outcome.record?.status).toBe('superseded');
    expect(outcome.detail).toContain('事实闸门');
    expect(port.requests).toEqual([]);
    expect(projection.snapshot().materialization_calls).toBe(0);

    // 存储里**没有** published（旧值没有被发布出去）。
    expect(artifactsOf(b.store).some(isDeliveredArtifact)).toBe(false);
    expect(artifactsOf(b.store).map((r) => r.status)).toEqual(['superseded']);
  });

  it('事实未被取代时照常发布（正例：闸门不误伤）', () => {
    const b = bench();
    putTask(b.store, b.taskAt(1));
    putFacts(b.store, [numFact('F1', 'headcount', 8)]); // 只有一条当前事实，无取代者

    const built = candidate({ factId: 'F1', factKey: 'headcount', amount: 8 });
    const { projection, port } = publishingProjection(b.store);

    const outcome = projection.reconcileOne(asStagedFact(built), AT);

    expect(outcome.kind).toBe('published');
    expect(outcome.record?.status).toBe('published');
    expect(port.requests.length).toBe(1);
  });

  it('同 id 但值摘要变了（原地改写）⇒ 同样拒发', () => {
    const b = bench();
    putTask(b.store, b.taskAt(1));
    // 请求依据的是 F1=8；存储里的 F1 却是 10（同 id 换值——摘要必须抓到这个分叉）。
    putFacts(b.store, [numFact('F1', 'headcount', 10)]);

    const built = candidate({ factId: 'F1', factKey: 'headcount', amount: 8 });
    const { projection, port } = publishingProjection(b.store);

    const outcome = projection.reconcileOne(asStagedFact(built), AT);

    expect(outcome.kind).not.toBe('published');
    expect(outcome.failure_kind).toBe('version_stale');
    expect(outcome.detail).toContain('值摘要已变');
    expect(port.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 反例③（纯判据层的非恒真对照）
// ---------------------------------------------------------------------------

describe('反例③：判据的非恒真对照（摘掉取代者 ⇒ 必须不再判失效）', () => {
  it('没有取代者时索引返回空集；出现取代者时索引命中——证明判据有判别力', () => {
    const published: ArtifactRecord = createArtifactRecord({
      ...candidate({ factId: 'F1', factKey: 'headcount', amount: 8 }).record,
      status: 'published',
      content_digest: READBACK_DIGEST,
      receipt: {
        final_path: '/root/artifacts/a.docx',
        readback_digest: READBACK_DIGEST,
        verifier: 'v',
        at: AT,
      },
      verifications: [
        { kind: 'version_match', outcome: 'pass', detail: 'x' },
        { kind: 'structural_self_check', outcome: 'pass', detail: 'y' },
      ],
    });
    expect(isDeliveredArtifact(published)).toBe(true);

    const withoutSuperseder = [numFact('F1', 'headcount', 8)];
    const withSuperseder = [numFact('F1', 'headcount', 8), numFact('F2', 'headcount', 10, 'F1')];

    // 控制组：无取代者 ⇒ 不判失效（否则判据就是恒真的空断言）。
    expect(findFactInvalidatedArtifacts([published], withoutSuperseder)).toEqual([]);
    // 实验组：有取代者 ⇒ 命中这一条。
    expect(findFactInvalidatedArtifacts([published], withSuperseder).map((r) => r.artifact_id)).toEqual([
      published.artifact_id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 反例②：事实变更 ⇒ 只有受影响产物过期，无关产物逐字段不变
// ---------------------------------------------------------------------------

describe('反例②：事实 → 产物失效索引（只动受影响产物）', () => {
  it('改 headcount ⇒ headcount 产物过期，budget 产物逐字段不变', () => {
    const b = bench();
    putTask(b.store, b.taskAt(1));
    putFacts(b.store, [numFact('F1', 'headcount', 8), numFact('G1', 'budget.total', 1000)]);

    const { projection } = publishingProjection(b.store);

    // 产 A（依据 headcount=8）与产 B（依据 budget=1000），都先正常发布。
    const a = candidate({ factId: 'F1', factKey: 'headcount', amount: 8, templateKind: 'document' });
    const c = candidate({
      factId: 'G1',
      factKey: 'budget.total',
      amount: 1000,
      templateKind: 'spreadsheet',
      artifactVersion: 1,
    });
    expect(projection.reconcileOne(asStagedFact(a), AT).kind).toBe('published');
    expect(projection.reconcileOne(asStagedFact(c), AT).kind).toBe('published');
    expect(artifactsOf(b.store).length).toBe(2);
    expect(artifactsOf(b.store).every(isDeliveredArtifact)).toBe(true);

    const beforeUnrelated = JSON.stringify(
      artifactsOf(b.store).find((r) => r.artifact_id === c.record.artifact_id),
    );

    // 事实变更：8 人 → 10 人（同 r1 内 supersession，只动 headcount 这一条）。
    putFacts(b.store, [numFact('F2', 'headcount', 10, 'F1')]);

    // 索引先"标出"受影响产物（纯读）。
    const affected = findFactInvalidatedArtifacts(artifactsOf(b.store), b.store.snapshot().shared_facts);
    expect(affected.map((r) => r.artifact_id)).toEqual([a.record.artifact_id]);

    // 失效传播：只标记受影响的那一条。
    const outcomes = projection.expireFactInvalidatedArtifacts(asLogicalTime(20));
    expect(outcomes.map((o) => o.artifact_id)).toEqual([a.record.artifact_id]);
    expect(outcomes[0]?.record?.status).toBe('expired');

    const after = artifactsOf(b.store);
    const expiredA = after.find((r) => r.artifact_id === a.record.artifact_id);
    const untouchedC = after.find((r) => r.artifact_id === c.record.artifact_id);

    // 受影响产物：过期、不再构成交付、无回执（不冒充当前结果）。
    expect(expiredA?.status).toBe('expired');
    expect(isDeliveredArtifact(expiredA!)).toBe(false);
    expect(expiredA?.receipt).toBeNull();

    // 无关产物：**逐字段不变**（JSON 全等 —— 即"字节/字节等价"的可判定形式）。
    expect(JSON.stringify(untouchedC)).toBe(beforeUnrelated);
    expect(untouchedC?.status).toBe('published');
  });

  it('幂等：再次传播不重复改写（已经是 expired 的不再变动）', () => {
    const b = bench();
    putTask(b.store, b.taskAt(1));
    putFacts(b.store, [numFact('F1', 'headcount', 8)]);
    const { projection } = publishingProjection(b.store);

    const a = candidate({ factId: 'F1', factKey: 'headcount', amount: 8 });
    expect(projection.reconcileOne(asStagedFact(a), AT).kind).toBe('published');
    putFacts(b.store, [numFact('F2', 'headcount', 10, 'F1')]);

    const first = projection.expireFactInvalidatedArtifacts(asLogicalTime(20));
    expect(first.length).toBe(1);

    const snapshotAfterFirst = JSON.stringify(artifactsOf(b.store));
    const second = projection.expireFactInvalidatedArtifacts(asLogicalTime(21));
    expect(second).toEqual([]);
    expect(JSON.stringify(artifactsOf(b.store))).toBe(snapshotAfterFirst);
  });

  it('事实未变 ⇒ 传播是空操作（无关产物一个都不动）', () => {
    const b = bench();
    putTask(b.store, b.taskAt(1));
    putFacts(b.store, [numFact('F1', 'headcount', 8)]);
    const { projection } = publishingProjection(b.store);

    const a = candidate({ factId: 'F1', factKey: 'headcount', amount: 8 });
    expect(projection.reconcileOne(asStagedFact(a), AT).kind).toBe('published');

    const before = JSON.stringify(artifactsOf(b.store));
    expect(projection.expireFactInvalidatedArtifacts(asLogicalTime(20))).toEqual([]);
    expect(JSON.stringify(artifactsOf(b.store))).toBe(before);
  });
});
