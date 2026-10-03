/**
 * 发布投影（design-02 P1 / P2；合同 v1.4 R49 / R50 / R53.1）。
 *
 * 覆盖的机器判据：
 * 1. **版本闸门**：任务版本被超越 ⇒ `version_stale`，且**不调端口**、不产 `published`；
 * 2. **幂等**：同一 `artifact_id` 投影两次只写一次、只物化一次；
 * 3. **提交前失败 ⇒ 零新增**：段1 未提交 ⇒ 存储零记录、端口零调用；
 * 4. **已提交但抛错**（`afterCommitBeforePublish`）⇒ 已提交事实仍被补齐一次；
 * 5. **staged 不满足交付判据**（`isDeliveredArtifact` 为假）；
 * 6. **事务边界**：外部端口只在实际提交之后、且**在事务之外**被调用；
 * 7. 已 `failed` 的记录**不得退回** `published`；
 * 8. 段3 未提交 ⇒ 如实返回 `unrecorded`，绝不声称已发布。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createTaskRecord,
  isDeliveredArtifact,
  type ArtifactRecord,
  type StorageTransaction,
  type Store,
  type TaskId,
  type TaskRecord,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';
import { planArtifact } from './planner.js';
import {
  createCollectingMaterializationPort,
  materializationFailure,
  materializationSuccess,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
} from './ports.js';
import {
  ArtifactPublicationProjection,
  createArtifactPublicationProjection,
  createStagedArtifactFact,
  type ArtifactPublicationStore,
  type StagedArtifactFact,
} from './publish.js';

const TASK_ID: TaskId = asTaskId('T1');
const INSTANCE_ID = asInstanceId('C');
const FACT_REF = asFactRef('F1');
const ROOT = '/root/artifacts';
const PLAN_DIGEST = 'sha256:expected';
const READBACK_DIGEST = 'sha256:readback';
const AT = asLogicalTime(7);

interface Fixture {
  readonly store: Store;
  readonly request: ArtifactMaterializationRequest;
  readonly stagedRecord: ArtifactRecord;
  readonly taskAt: (revision: number) => TaskRecord;
}

/** tx1 的产物记录（`staged`）与对应的物化请求。 */
function fixture(revision = 1, artifactVersion = 1): Fixture {
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
        source: { kind: 'user_confirmation', detail: '用户在前台确认' },
      },
    ],
    plan,
    expected_content_digest: plan.expected_content_digest,
  };
  const stagedRecord = createArtifactRecord({
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
    created_at: asLogicalTime(3),
  });
  const taskAt = (current: number): TaskRecord =>
    createTaskRecord({ task_id: TASK_ID, goal: '十人聚餐', created_at: asLogicalTime(1), revision: asRevision(current) });
  return { store, request, stagedRecord, taskAt };
}

function successReceipt(request: ArtifactMaterializationRequest): ArtifactMaterializationReceipt {
  return {
    artifact_id: request.artifact_id,
    final_path: request.plan.final_path,
    readback_digest: READBACK_DIGEST,
    byte_length: 4096,
    entry_count: 5,
    verifier: 'tests/acceptance/office/fs-artifact-port',
    at: asLogicalTime(5),
  };
}

/** 把任务写进存储（版本闸门要读它）。 */
function putTask(store: Store, task: TaskRecord): void {
  store.transact((tx) => {
    tx.putTask(task);
  });
}

function factOf(fixtureValue: Fixture): StagedArtifactFact {
  return createStagedArtifactFact(fixtureValue.stagedRecord, fixtureValue.request);
}

function artifactsOf(store: Store): readonly ArtifactRecord[] {
  return store.snapshot().artifacts ?? [];
}

describe('版本闸门（P2 / 任务书 §13）', () => {
  it('任务版本被超越 ⇒ superseded（不是 failed），不产 published，且**不调端口**', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(2)); // 当前已是 r2，产物记录还绑在 r1
    const port = createCollectingMaterializationPort();
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    // 合同 v1.4 R49.1 / 任务书 §13：版本闸门的结果是**过期**，不是**失败**——
    // 产物本身没错，只是它绑的任务版本已被超越；旧产物保留为历史、不冒充当前结果。
    expect(outcome.kind).toBe('failed');
    expect(outcome.failure_kind).toBe('version_stale');
    expect(outcome.record?.status).toBe('superseded');
    expect(isDeliveredArtifact(outcome.record!)).toBe(false);
    // 版本闸门在**端口之前**：旧版本不得覆盖最新文件
    expect(port.requests).toEqual([]);
    expect(projection.snapshot().materialization_calls).toBe(0);
    expect(artifactsOf(built.store).map((record) => record.status)).toEqual(['superseded']);
    expect(artifactsOf(built.store)[0]?.failure_kind).toBe('version_stale');
    // 过期记录**不得**带回执（没有回读证据就不得有任何"已交付"的外观）
    expect(artifactsOf(built.store)[0]?.receipt).toBeNull();
  });

  it('版本一致 ⇒ 发布；记录随真实字节更新（内容摘要 = 回读摘要）', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(outcome.kind).toBe('published');
    const published = outcome.record;
    expect(published?.status).toBe('published');
    expect(isDeliveredArtifact(published!)).toBe(true);
    expect(published?.content_digest).toBe(READBACK_DIGEST);
    expect(published?.byte_length).toBe(4096);
    expect(published?.receipt?.final_path).toBe(built.request.plan.final_path);
    expect(published?.receipt?.readback_digest).toBe(READBACK_DIGEST);
    // 交付前检查如实登记：只有内核做得了的两项；**不**声称独立读回 / 软件打开
    expect(published?.verifications.map((verification) => verification.kind).sort()).toEqual([
      'structural_self_check',
      'version_match',
    ]);
    expect(published?.verifications.every((verification) => verification.outcome === 'pass')).toBe(true);
  });
});

describe('幂等（镜像 CommittedBudgetProjection）', () => {
  it('同一 artifact_id 投影两次 ⇒ 只物化一次、只写一条记录', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });
    const fact = factOf(built);

    const first = projection.reconcileOne(fact, AT);
    const second = projection.reconcileOne(fact, asLogicalTime(9));

    expect(first.kind).toBe('published');
    expect(second.kind).toBe('skipped_already_published');
    expect(port.requests.length).toBe(1);
    expect(projection.snapshot().materialization_calls).toBe(1);
    expect(artifactsOf(built.store).length).toBe(1);
    expect(artifactsOf(built.store)[0]?.status).toBe('published');
  });

  it('reconcile 批量入口同样幂等（重放不重复物化）', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });
    const fact = factOf(built);

    const first = projection.reconcile([fact, fact], AT);
    const second = projection.reconcile([fact], AT);

    expect(first.map((outcome) => outcome.kind)).toEqual([
      'published',
      'skipped_already_published',
    ]);
    expect(second[0]?.kind).toBe('skipped_already_published');
    expect(port.requests.length).toBe(1);
  });
});

describe('提交前失败 ⇒ 零新增（info-006）', () => {
  it('段1 事务抛错 ⇒ 存储无记录、端口零调用', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });
    built.store.faults.beforeCommit = (): void => {
      throw new Error('提交前失败（故障注入）');
    };

    // 段1：事务内写 staged —— 该事务**不会**提交
    expect(() => {
      built.store.transact((tx) => {
        tx.putArtifact(built.stagedRecord);
      });
    }).toThrow();

    expect(artifactsOf(built.store)).toEqual([]);
    expect(port.requests).toEqual([]);
    expect(projection.snapshot().materialization_calls).toBe(0);
    expect(projection.snapshot().applied_artifact_ids).toEqual([]);
  });

  it('段3 提交后被抛错（afterCommitBeforePublish）⇒ 已提交事实仍被补齐一次', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    built.store.faults.afterCommitBeforePublish = (): void => {
      throw new Error('提交后投递前失败（故障注入）');
    };

    // 段1：事务**已提交**但抛错（info-006 说的正是这个窗口）
    expect(() => {
      built.store.transact((tx) => {
        tx.putArtifact(built.stagedRecord);
      });
    }).toThrow();
    expect(artifactsOf(built.store).map((record) => record.status)).toEqual(['staged']);

    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    // 补偿（catch 路径也要补一次）
    const compensated = projection.reconcileOne(factOf(built), AT);
    expect(compensated.kind).toBe('published');
    expect(port.requests.length).toBe(1);

    // 再投影一次：不得重复物化、不得重复写
    const again = projection.reconcileOne(factOf(built), asLogicalTime(11));
    expect(again.kind).toBe('skipped_already_published');
    expect(port.requests.length).toBe(1);
    expect(artifactsOf(built.store).length).toBe(1);
    expect(artifactsOf(built.store)[0]?.status).toBe('published');
  });
});

describe('staged 的交付判据（I-4）', () => {
  it('staged 记录不满足任何"已交付"判据', () => {
    const built = fixture(1);
    expect(built.stagedRecord.status).toBe('staged');
    expect(isDeliveredArtifact(built.stagedRecord)).toBe(false);
    expect(built.stagedRecord.receipt).toBeNull();
  });

  it('一次投影之后存储里出现的才是 published（旧记录对象不会自动变成已交付）', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });
    projection.reconcileOne(factOf(built), AT);

    expect(isDeliveredArtifact(built.stagedRecord)).toBe(false);
    expect(isDeliveredArtifact(artifactsOf(built.store)[0]!)).toBe(true);
  });
});

describe('事务边界：外部副作用只在提交之后、且在事务之外', () => {
  it('端口的物化调用发生在段3 事务开始之前，且调用时不在任何事务体内', () => {
    const inner = createMemoryStore();
    const built = fixture(1);
    putTask(inner, built.taskAt(1));

    const log: string[] = [];
    let inTransaction = false;
    const store: ArtifactPublicationStore & { readonly isInTransaction: () => boolean } = {
      snapshot: () => inner.snapshot(),
      transact<T>(work: (tx: StorageTransaction) => T): T {
        log.push('tx:begin');
        inTransaction = true;
        try {
          const result = inner.transact(work);
          log.push('tx:commit');
          return result;
        } finally {
          inTransaction = false;
        }
      },
      isInTransaction: () => inTransaction,
    };

    const port: ArtifactMaterializationPort = {
      materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
        log.push('port:materialize');
        expect(inTransaction).toBe(false);
        return materializationSuccess(successReceipt(request));
      },
    };

    const projection = createArtifactPublicationProjection({ store, port });

    // 段1（宿主）：事务内写 staged 并提交
    log.push('seg1');
    inner.transact((tx) => {
      tx.putArtifact(built.stagedRecord);
      store.snapshot(); // 无副作用，仅证明事务内可读
    });
    log.push('seg1:committed');

    // 段2 + 段3：同步投影（必须在返回前完成）
    const outcomes = projection.reconcile([factOf(built)], AT);

    expect(outcomes[0]?.kind).toBe('published');
    const materializeAt = log.indexOf('port:materialize');
    const transactionBegins = log
      .map((entry, index) => (entry === 'tx:begin' ? index : -1))
      .filter((index) => index >= 0);
    expect(materializeAt).toBeGreaterThan(-1);
    expect(log.indexOf('seg1:committed')).toBeLessThan(materializeAt);
    // 端口调用发生在**最后一次事务开始之前**（即段3 之前，而不是事务体内）
    expect(materializeAt).toBeLessThan(Math.max(...transactionBegins));
  });

  it('观测只在事务之外落进内部日志（事务体内不写外部记录）', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );

    // 段3 事务体跑完、还没提交时，投影内部日志里**必须**还是空的——
    // 这正是"外部记录不早于提交"的可观测形式（info-006）。
    let observationsInsideTransaction = -1;
    let projection: ArtifactPublicationProjection | undefined;
    const store: ArtifactPublicationStore = {
      snapshot: () => built.store.snapshot(),
      transact: <T>(work: (tx: StorageTransaction) => T): T =>
        built.store.transact((tx) => {
          const result = work(tx);
          observationsInsideTransaction = projection?.observations().length ?? -1;
          return result;
        }),
    };
    projection = createArtifactPublicationProjection({
      store,
      port,
      hooks: {
        writeObservationInTransaction: (tx, observation) => {
          // 钩子在**事务体内**：只能碰 tx，不得碰外部系统
          expect(tx.getArtifact(observation.artifact_id)).toBeDefined();
        },
      },
    });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(outcome.kind).toBe('published');
    expect(observationsInsideTransaction).toBe(0);
    expect(projection.observations().length).toBe(1);
  });
});

describe('恢复与失败（R49.4 / R50.2）', () => {
  it('端口返回结构化失败 ⇒ 记 failed，且不得退回 published', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    let failing = true;
    const port = createCollectingMaterializationPort((request) =>
      failing
        ? materializationFailure(request, 'builder_failed', '构建器抛错（夹具）', AT)
        : materializationSuccess(successReceipt(request)),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });
    const fact = factOf(built);

    const failed = projection.reconcileOne(fact, AT);
    expect(failed.kind).toBe('failed');
    expect(failed.failure_kind).toBe('builder_failed');
    expect(failed.record?.status).toBe('failed');
    expect(failed.record?.receipt).toBeNull();

    // 重跑：临时文件丢失 / 最终路径不存在 ⇒ 不得退回 published
    failing = false;
    const retried = projection.reconcileOne(fact, asLogicalTime(13));
    expect(retried.kind).toBe('refused_after_failure');
    expect(artifactsOf(built.store).length).toBe(1);
    expect(artifactsOf(built.store)[0]?.status).toBe('failed');
    expect(port.requests.length).toBe(1); // 失败后不再重试物化
  });

  it('端口抛错 ⇒ 转成结构化失败（不把异常抛给投影循环）', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port: ArtifactMaterializationPort = {
      materialize(): ArtifactMaterializationResult {
        throw new Error('宿主实现崩了');
      },
    };
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);
    expect(outcome.kind).toBe('failed');
    expect(outcome.failure_kind).toBe('builder_failed');
    expect(outcome.detail).toContain('宿主实现崩了');
  });

  it('段3 未提交 ⇒ 如实返回 unrecorded（绝不声称已发布），且留给重跑', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationSuccess(successReceipt(request)),
    );
    const brokenStore: ArtifactPublicationStore = {
      snapshot: () => built.store.snapshot(),
      transact: () => {
        throw new Error('存储写入失败（夹具）');
      },
    };
    const projection = createArtifactPublicationProjection({ store: brokenStore, port });

    const outcome = projection.reconcileOne(factOf(built), AT);

    expect(outcome.kind).toBe('unrecorded');
    expect(outcome.record).toBeNull();
    expect(outcome.detail).toContain('未落库');
    expect(artifactsOf(built.store)).toEqual([]);
    expect(projection.snapshot().unrecorded_count).toBe(1);
    // 未落库 ⇒ 不计入 applied，重跑仍会尝试（恢复路径不被堵死）
    expect(projection.snapshot().applied_artifact_ids).toEqual([]);
  });

  it('staged 记录可被重跑：端口第一次失败后被超越的版本闸门不再重复物化', () => {
    const built = fixture(1);
    putTask(built.store, built.taskAt(1));
    const port = createCollectingMaterializationPort((request) =>
      materializationFailure(request, 'write_failed', '临时路径写入失败（夹具）', AT),
    );
    const projection = createArtifactPublicationProjection({ store: built.store, port });

    const outcome = projection.reconcileOne(factOf(built), AT);
    expect(outcome.kind).toBe('failed');
    expect(outcome.failure_kind).toBe('write_failed');
    expect(artifactsOf(built.store)[0]?.artifact_id).toBe(built.stagedRecord.artifact_id);
    expect(artifactsOf(built.store)[0]?.status).toBe('failed');
  });
});

describe('事实与请求的一致性（编程错误就地失败）', () => {
  it('staged 记录与请求身份不一致 ⇒ 抛 ValidationError（不让不一致的事实进投影）', () => {
    const built = fixture(1);
    const other = createArtifactRecord({
      ...built.stagedRecord,
      artifact_id: asArtifactRef('art-someone-else'),
    });
    expect(() => createStagedArtifactFact(other, built.request)).toThrow(/不一致/);
  });

  it('已 published 的记录不得当 staged 事实交回', () => {
    const built = fixture(1);
    const published = createArtifactRecord({
      ...built.stagedRecord,
      status: 'published',
      receipt: {
        final_path: built.request.plan.final_path,
        readback_digest: READBACK_DIGEST,
        verifier: 'v',
        at: AT,
      },
      verifications: [
        { kind: 'structural_self_check', outcome: 'pass', detail: 'x' },
        { kind: 'version_match', outcome: 'pass', detail: 'y' },
      ],
    });
    expect(() => createStagedArtifactFact(published, built.request)).toThrow(/staged/);
  });
});
