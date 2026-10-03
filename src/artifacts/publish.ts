/**
 * 产物发布：`staged → published` 的**幂等投影**（design-02 P1 / P2；合同 v1.4 R49 / R50 / R53.1）。
 *
 * ## 三段式里的位置
 *
 * 合同 R49.1 把落地钉成三段，**不得合并**：
 *
 * | 段 | 谁做 | 做什么 |
 * |---|---|---|
 * | 1 事务内 | 主协调者（`src/scheduler/**`） | 写 `ArtifactRecord(status='staged')` + 工作项 `result_refs` + 观测事件 |
 * | **2 提交后** | **本文件** | 版本闸门 → 调物化端口（外部副作用只在这里）→ 拿到回执 |
 * | **3 新事务内** | **本文件** | 写回执 + `status='published'`（或 `failed`）+ 观测 |
 *
 * ## 为什么是"投影"而不是"函数"
 *
 * 镜像 `CommittedBudgetProjection`（`src/scheduler/budget-projection.ts`）：**权威来源是已提交事实**
 * ——这里就是 tx1 提交的 `staged` 记录本身。投影在提交点之后被**同步**调用，按
 * **`artifact_id` 幂等**补齐：同一条已提交事实被重放多次，只会物化/发布一次。
 * 幂等键是 `artifact_id`（不是计数器、不是随机数，符合 Q8-c）。
 *
 * ## info-006：外部副作用**必须在提交之后**（本文件的第一纪律）
 *
 * `MemoryStore.transact()` 在事务体返回后还要过 `beforeCommit` / `afterCommitBeforePublish` 接缝：
 * 把外部动作写在事务体最后一行看似"成功了才做"，实际**早于提交**——接缝抛错时存储回滚、
 * 外部动作已发生，留下孤儿。
 *
 * 因此本文件的形状是**结构性**的保证，而不是"记得别写错"：
 * - 段3 的事务体里**只有** `tx.putArtifact(...)` 与一个**事务内钩子**（只允许写 `tx`）；
 * - 物化端口（唯一的外部副作用）在**任何事务之外**调用，且只在版本闸门通过之后；
 * - 观测只在 `transact` **返回之后**才落进投影内部日志。
 *
 * ## 提交前失败 ⇒ 零新增（可测）
 *
 * 段1 未提交 ⇒ 调用方拿不到已提交事实 ⇒ 不会调用本投影 ⇒ 端口零调用、存储零新增。
 * 段3 未提交 ⇒ 本投影如实返回 `unrecorded`（**绝不**声称已发布）。
 * 段3 已提交但抛错（`afterCommitBeforePublish`）⇒ 以**存储里的已提交记录**为准补齐一次。
 *
 * ## 恢复（R49.4）
 *
 * `staged` 记录可被重跑（重放不重复物化：先看存储、再看 `applied` 集合）。
 * 一旦记为 `failed`，**不得**退回 `published`（`refused_after_failure`）。
 *
 * ## 本文件**不做**的事
 *
 * - 不 import 任何 `src/scheduler/**` 类型（纪律同 `ports.ts` / `dependency/ports.ts`）；
 * - **不新增 `KERNEL_EVENT_KINDS`**：观测以本文件自有的 `ArtifactObservation` 表达，
 *   由注入的 `ArtifactPublicationHooks.writeObservationInTransaction` 在**段3 事务体内**
 *   交宿主写成内核事件（种类归主协调者裁决）；
 * - 不做文件 IO（`final_path` 是否存在、回读摘要都由端口负责）——因此
 *   I-2（"已提交 published 记录 + 最终路径不存在"不成立）的证据是**端口的回读**，不是本文件。
 */

import {
  asLogicalTime,
  createArtifactRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  snapshotSharedFacts,
  ValidationError,
  type ArtifactFailureKind,
  type ArtifactRecord,
  type ArtifactRef,
  type ArtifactStatus,
  type ArtifactVerification,
  type ArtifactVerificationKind,
  type FactRef,
  type KnownFactValue,
  type LogicalTime,
  type Revision,
  type SharedFactRecord,
  type StorageTransaction,
  type StoreSnapshot,
  type TaskId,
} from '../protocol/index.js';
import { digestBytes } from './digest.js';
import {
  assertRequestPlanConsistency,
  materializationFailure,
  type ArtifactMaterializationFailure,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
} from './ports.js';

// ---------------------------------------------------------------------------
// 观测（自有类型；**不是** KernelEventKind —— 共享常量归主协调者，本文件不碰）
// ---------------------------------------------------------------------------

/**
 * 产物发布的观测种类。
 *
 * **注意**：这三个名字**不是** `KERNEL_EVENT_KINDS` 的成员（后者在 `protocol/constants.ts`，
 * 本批次无权改动）。它们是"该被记下来的事实"，如何落成内核事件由宿主裁决。
 */
export const ARTIFACT_OBSERVATION_KINDS = [
  'artifact_published',
  'artifact_publish_failed',
  'artifact_publish_skipped',
] as const;
export type ArtifactObservationKind = (typeof ARTIFACT_OBSERVATION_KINDS)[number];

/** 一条发布观测（含 `status` / `failure_kind` / 逻辑时刻；`detail` 不得为空）。 */
export interface ArtifactObservation {
  readonly kind: ArtifactObservationKind;
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  /** 被观测对象的落库状态；`null` = **未落库**（段3 未提交）。 */
  readonly status: ArtifactStatus | null;
  readonly failure_kind: ArtifactFailureKind | null;
  readonly detail: string;
  readonly at: LogicalTime;
}

/**
 * 段3 事务体内的观测写入口（可选）。
 *
 * **契约**：实现**必须只在事务体内写 `tx`**（如 `tx.appendKernelEvent(...)`），
 * 不得调用任何外部系统——否则就把 info-006 的坑原样搬了进来。
 * 默认不提供 ⇒ 观测只进投影内部日志（`snapshot().observations`），不写内核事件。
 */
export interface ArtifactPublicationHooks {
  readonly writeObservationInTransaction?: (
    tx: StorageTransaction,
    observation: ArtifactObservation,
  ) => void;
}

// ---------------------------------------------------------------------------
// 输入：已提交的 staged 事实 + 注入面
// ---------------------------------------------------------------------------

/** 投影读存储 / 段3 写存储所需的最小结构面（`Store` 天然满足，夹具可自行实现）。 */
export interface ArtifactPublicationStore {
  /** 只读快照：版本闸门与"存储里已定局的记录"的唯一读口。 */
  snapshot(): StoreSnapshot;
  /** 原子事务：段3 的载体。 */
  transact<T>(work: (tx: StorageTransaction) => T): T;
}

/**
 * 一条**已提交的** `staged` 事实 = tx1 的产物记录 + 当次物化请求。
 *
 * 两者必须成对：`staged` 记录**不携带事实快照**（事实快照只活在请求里），
 * 所以重放必须由调用方把 tx1 的那一份请求一并交回——这也是"重放同一事实得到同一结果"
 * 的前提（`planner` 的计划本身就是确定性的）。
 */
export interface StagedArtifactFact {
  readonly record: ArtifactRecord;
  readonly request: ArtifactMaterializationRequest;
}

/**
 * 构造并**校验**一条 staged 事实（编程错误就地失败，不让不一致的事实进投影；
 * 运行期失败走结构化返回值，见 R50.2）。
 *
 * @throws {ValidationError}
 */
export function createStagedArtifactFact(
  record: ArtifactRecord,
  request: ArtifactMaterializationRequest,
): StagedArtifactFact {
  if (record.status !== 'staged') {
    throw new ValidationError(
      `段1 交回的产物记录必须是 staged（I-4：staged 才是可恢复的中间态），` +
        `实际为 ${record.status}（产物 ${record.artifact_id}）`,
    );
  }
  assertRequestPlanConsistency(request);
  const mismatches: string[] = [];
  if (record.artifact_id !== request.artifact_id) mismatches.push('artifact_id');
  if (record.task_id !== request.task_id) mismatches.push('task_id');
  if (record.task_revision !== request.task_revision) mismatches.push('task_revision');
  if (record.template_kind !== request.template_kind) mismatches.push('template_kind');
  if (mismatches.length > 0) {
    throw new ValidationError(
      `staged 记录与物化请求不一致（${mismatches.join(' / ')}）：不能让"回执里的身份"与` +
        '"记录里的身份"分叉',
    );
  }
  return Object.freeze({ record, request });
}

export interface ArtifactPublicationDeps {
  readonly store: ArtifactPublicationStore;
  /** 物化端口：**唯一的外部副作用发生地**。 */
  readonly port: ArtifactMaterializationPort;
  readonly hooks?: ArtifactPublicationHooks;
}

// ---------------------------------------------------------------------------
// 输出：结构化结局
// ---------------------------------------------------------------------------

export const ARTIFACT_PUBLICATION_OUTCOME_KINDS = [
  /** 段3 已提交：回执 + `status='published'`。 */
  'published',
  /** 段3 已提交：`status='failed'`（含版本闸门判定的 `version_stale`）。 */
  'failed',
  /** 存储里已有 `published` 记录（幂等键 = `artifact_id`），本次不重复物化。 */
  'skipped_already_published',
  /** 存储里已有 `failed` 记录：**不得退回 published**（R49.4）。 */
  'refused_after_failure',
  /** 段3 **未提交**：物化结果与回执未落库——如实上报，**不**声称已发布。 */
  'unrecorded',
] as const;
export type ArtifactPublicationOutcomeKind = (typeof ARTIFACT_PUBLICATION_OUTCOME_KINDS)[number];

export interface ArtifactPublicationOutcome {
  readonly kind: ArtifactPublicationOutcomeKind;
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
  /** 存储中的权威记录；`unrecorded` 时为 `null`（**这就是"没落库"的结构化表达**）。 */
  readonly record: ArtifactRecord | null;
  readonly failure_kind: ArtifactFailureKind | null;
  readonly detail: string;
}

/** 投影的只读旁证（证据 / 自检用）。 */
export interface ArtifactPublicationSnapshot {
  readonly applied_artifact_ids: readonly string[];
  readonly published_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
  readonly unrecorded_count: number;
  /** 真正落到端口上的物化调用次数（幂等断言用：重复投影不得增加）。 */
  readonly materialization_calls: number;
  readonly observations: readonly ArtifactObservation[];
}

// ---------------------------------------------------------------------------
// 记录改写（staged → published / failed）
// ---------------------------------------------------------------------------

/** 合并检查结果：**每种检查最多一条**（同种以后来的为准），顺序沿用首次出现位置。 */
function mergeVerifications(
  existing: readonly ArtifactVerification[],
  additions: readonly ArtifactVerification[],
): readonly ArtifactVerification[] {
  const byKind = new Map<ArtifactVerificationKind, ArtifactVerification>();
  for (const verification of existing) byKind.set(verification.kind, verification);
  for (const verification of additions) byKind.set(verification.kind, verification);
  return [...byKind.values()];
}

function publishedRecordOf(
  fact: StagedArtifactFact,
  receipt: ArtifactMaterializationReceipt,
  at: LogicalTime,
): ArtifactRecord {
  const revision = fact.record.task_revision;
  return createArtifactRecord({
    ...fact.record,
    // 记录随**真实字节**更新：回读摘要才是内容摘要（I-1 / R47.2）。
    byte_length: receipt.byte_length,
    content_digest: receipt.readback_digest,
    status: 'published',
    verifications: mergeVerifications(fact.record.verifications, [
      {
        kind: 'version_match',
        outcome: 'pass',
        detail:
          `发布前核对：当前任务版本 r${String(revision)} 与记录 task_revision r${String(revision)} 一致` +
          '（任务书 §13"核对当前版本后再发布"）',
      },
      {
        kind: 'structural_self_check',
        outcome: 'pass',
        detail:
          '物化端口在原子改名之前完成第 1 层结构自检并通过（边界见 src/artifacts/verify.ts 的 ' +
          'SELF_CHECK_SCOPE_STATEMENT：只证构建器内部自洽，不证目标软件能打开）',
      },
    ]),
    failure_kind: null,
    receipt: {
      final_path: receipt.final_path,
      readback_digest: receipt.readback_digest,
      verifier: receipt.verifier,
      at: receipt.at,
      // 容器条目数必须跟着回执一起落库（W-FIX8 发现：本处是**逐字段重建**而非嵌入端口回执，
      // 不显式搬运就会丢）。它是独立读回与自检的**交叉核对维度**——丢了就只剩"曾经扫过一遍"。
      entry_count: receipt.entry_count,
    },
    updated_at: at,
  });
}

function failedRecordOf(
  fact: StagedArtifactFact,
  failure: ArtifactMaterializationFailure,
  at: LogicalTime,
): ArtifactRecord {
  const additions: ArtifactVerification[] = [];
  if (failure.kind === 'version_stale') {
    additions.push({ kind: 'version_match', outcome: 'fail', detail: failure.detail });
  }
  if (failure.kind === 'self_check_failed') {
    additions.push({ kind: 'structural_self_check', outcome: 'fail', detail: failure.detail });
  }
  // **版本闸门不是"失败"，是"过期"**（合同 v1.4 R49.1 / 任务书 §13）：
  // 产物本身没错，只是它绑定的任务版本已经被超越——旧产物**保留为历史**、不冒充当前结果。
  // 记成 `failed` 会把"过期"说成"坏了"，误导下游与读者。`failure_kind` 仍保留原因，便于追溯。
  const superseded = failure.kind === 'version_stale';
  return createArtifactRecord({
    ...fact.record,
    status: superseded ? 'superseded' : 'failed',
    verifications: mergeVerifications(fact.record.verifications, additions),
    failure_kind: failure.kind,
    receipt: null,
    updated_at: at,
  });
}

/** 观测的身份部分（记录或身份对都能给；`unrecorded` 时用身份对）。 */
interface ArtifactIdentity {
  readonly artifact_id: ArtifactRef;
  readonly task_id: TaskId;
}

function observationOf(
  kind: ArtifactObservationKind,
  identity: ArtifactIdentity,
  taskRevision: Revision,
  status: ArtifactStatus | null,
  failureKind: ArtifactFailureKind | null,
  detail: string,
  at: LogicalTime,
): ArtifactObservation {
  return Object.freeze({
    kind,
    artifact_id: identity.artifact_id,
    task_id: identity.task_id,
    task_revision: taskRevision,
    status,
    failure_kind: failureKind,
    detail,
    at: asLogicalTime(at),
  });
}

function observationOfRecord(
  kind: ArtifactObservationKind,
  record: ArtifactRecord,
  detail: string,
  at: LogicalTime,
): ArtifactObservation {
  return observationOf(
    kind,
    record,
    record.task_revision,
    record.status,
    record.failure_kind,
    detail,
    at,
  );
}

// ---------------------------------------------------------------------------
// 事实身份闸门与「事实 → 产物」失效索引（合同 R248 / R251；FA-Q 的 F7）
// ---------------------------------------------------------------------------
//
// ## 问题（FA-Q 报出，`publish.ts:436` 一带）
//
// 原来的版本闸门**只比 `task_revision`**。但事实可以在**同一个 `task_revision` 内**被
// supersede（`SharedFactRecord.supersedes_fact_id` 指向旧事实）——此时任务版本没变，
// 闸门却会让**依据旧事实构建的候选**照样发布。且没有任何「事实改了 ⇒ 哪些产物失效」的反查。
//
// ## 本段的形状
//
// - 产物的**事实身份** = 它所依据的那组事实的（键 + 事实 id + **值摘要**）。值摘要让
//   “核对摘要/版本”这句话落到机器判据上：同一事实 id 若值变了，摘要即不同。
// - **失效判据只承认仓库里看得见的事实**：只有当某条事实被**另一条事实**取代、或同一 id 的值
//   摘要变了，才判失效；**看不到**该事实 id 时**不判失效**——不凭空扩大既有判据。
// - 闸门（发布前的候选）与失效传播（已发布的存量）**共用同一批判据**：
//   `staleFactRefReason` / `staleFactIdentityReason`。

/** 一条产物所依据的事实身份：稳定键 + 事实 id + 值摘要。 */
export interface ArtifactFactIdentity {
  readonly fact_key: string;
  readonly fact_ref: FactRef;
  /** 值载荷的规范摘要（sha256 裸小写 hex）。同一事实同一值 ⇒ 同一摘要。 */
  readonly value_digest: string;
}

/**
 * 值载荷的**规范摘要**：把判别联合规范化成固定字段顺序的 JSON，再取 sha256。
 *
 * 规范化只做一件事——**固定字段顺序**，因此同一值载荷必然得到同一摘要（跨进程、跨平台）。
 * 它不引入墙钟、不引入随机数（纯函数）。
 */
export function factValueDigest(value: KnownFactValue): string {
  const canonical =
    value.type === 'number'
      ? JSON.stringify(['number', value.amount, value.unit, value.currency])
      : value.type === 'date'
        ? JSON.stringify(['date', value.iso_date, value.time_zone])
        : JSON.stringify(['text', value.text, value.source]);
  return digestBytes(new TextEncoder().encode(canonical));
}

/** 物化请求所依据的事实身份清单（顺序 = 请求里已知值快照的顺序）。 */
export function artifactFactIdentities(
  request: ArtifactMaterializationRequest,
): readonly ArtifactFactIdentity[] {
  return Object.freeze(
    request.fact_snapshot.map((entry) =>
      Object.freeze({
        fact_key: entry.fact_key,
        fact_ref: entry.fact_ref,
        value_digest: factValueDigest(entry.value),
      }),
    ),
  );
}

/** 取**取代** `ref` 的那条事实（`supersedes_fact_id === ref`）；没有则 `undefined`。 */
function supersederOf(facts: readonly SharedFactRecord[], ref: FactRef): SharedFactRecord | undefined {
  return facts.find((fact) => fact.supersedes_fact_id === ref);
}

/**
 * 一条事实身份的失效原因；`null` = 仍然有效。
 *
 * - 被另一条事实取代 ⇒ 失效（**同一 `task_revision` 内的 supersession** 正是此案）；
 * - 同一事实 id 仍在、但**值摘要**变了 ⇒ 失效（防"同 id 换值"的原地改写）；
 * - 仓库里查不到这条事实 ⇒ **不判失效**（无证据不扩大既有判据）。
 */
function staleFactIdentityReason(
  identity: ArtifactFactIdentity,
  facts: readonly SharedFactRecord[],
): string | null {
  const superseder = supersederOf(facts, identity.fact_ref);
  if (superseder !== undefined) {
    return (
      `产物依据的事实 ${identity.fact_ref}（键 ${identity.fact_key}）已被 ${superseder.fact_id} 取代`
    );
  }
  const same = facts.find((fact) => fact.fact_id === identity.fact_ref);
  if (same !== undefined && same.value.kind === 'known') {
    const actual = factValueDigest(same.value.value);
    if (actual !== identity.value_digest) {
      return (
        `产物依据的事实 ${identity.fact_ref}（键 ${identity.fact_key}）的值摘要已变：` +
        `产物 ${identity.value_digest.slice(0, 12)}… ≠ 当前 ${actual.slice(0, 12)}…`
      );
    }
  }
  return null;
}

/** 一组事实身份里第一条失效的原因（`null` = 全部仍有效）。 */
function staleFactIdentityReasons(
  identities: readonly ArtifactFactIdentity[],
  facts: readonly SharedFactRecord[],
): string | null {
  for (const identity of identities) {
    const reason = staleFactIdentityReason(identity, facts);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * 记录级失效原因：遍历产物的 `source_fact_refs`，返回第一条失效原因（`null` = 仍有效）。
 *
 * 已发布记录**没存值摘要**，故这里只能判「被取代」与「当前不再是已知值」两种；
 * 值摘要比对属于请求级（物化请求里带着快照值）。
 */
function staleFactRefReason(refs: readonly FactRef[], facts: readonly SharedFactRecord[]): string | null {
  for (const ref of refs) {
    const superseder = supersederOf(facts, ref);
    if (superseder !== undefined) {
      return `产物依据的事实 ${ref} 已被 ${superseder.fact_id} 取代`;
    }
    const same = facts.find((fact) => fact.fact_id === ref);
    if (same === undefined) continue; // 查不到 ⇒ 无从判定，不判失效
    if (same.value.kind !== 'known') {
      return `产物依据的事实 ${ref} 当前为 ${same.value.kind}（不再是已知值）`;
    }
  }
  return null;
}

/**
 * **事实 → 产物失效索引**（合同 R248 / R251）。
 *
 * 从当前共享事实出发，找出**引用了已被取代/失效事实**的、**已发布**的产物。
 * 反查靠 `ArtifactRecord.source_fact_refs`（暂存时逐键写入，见 `staging.ts`）——
 * 这就是"事实变更时能标出受影响产物"的那个索引。
 *
 * **纯读**：不改任何记录。无关产物（没有引用失效事实的）**不会出现在结果里**。
 */
export function findFactInvalidatedArtifacts(
  artifacts: readonly ArtifactRecord[],
  facts: readonly SharedFactRecord[],
): readonly ArtifactRecord[] {
  return Object.freeze(
    artifacts.filter(
      (record) =>
        isDeliveredArtifact(record) && staleFactRefReason(record.source_fact_refs, facts) !== null,
    ),
  );
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

/**
 * 把已提交的 `staged` 事实**幂等**推进到 `published` / `failed`。
 *
 * 调用时机（R49.1 与 R34.3 的同一条纪律）：**在段1 的提交点之后、同步调用**，且必须在返回前
 * 完成——否则会出现"产物已提交 staged 而尚未发布"的窗口被下一次调度读到。
 * `reconcile()` 是同步方法（返回数组而非 Promise），"必须先于返回"因此是结构性的。
 */
export class ArtifactPublicationProjection {
  readonly #store: ArtifactPublicationStore;
  readonly #port: ArtifactMaterializationPort;
  readonly #hooks: ArtifactPublicationHooks;
  readonly #applied = new Set<string>();
  readonly #observations: ArtifactObservation[] = [];
  #published = 0;
  #failed = 0;
  #skipped = 0;
  #unrecorded = 0;
  #materializations = 0;

  constructor(deps: ArtifactPublicationDeps) {
    this.#store = deps.store;
    this.#port = deps.port;
    this.#hooks = deps.hooks ?? {};
  }

  /** 按顺序投影若干已提交事实；返回每条的结局（幂等：重复投影只补一次）。 */
  reconcile(
    facts: readonly StagedArtifactFact[],
    at: LogicalTime,
  ): readonly ArtifactPublicationOutcome[] {
    const outcomes: ArtifactPublicationOutcome[] = [];
    for (const fact of facts) outcomes.push(this.reconcileOne(fact, at));
    return Object.freeze(outcomes);
  }

  /** 投影一条已提交事实（单条入口）。 */
  reconcileOne(fact: StagedArtifactFact, at: LogicalTime): ArtifactPublicationOutcome {
    const record = fact.record;
    const artifactId = record.artifact_id;

    // ① 幂等闸门：先看**存储**（权威、跨重启用），再看 `applied` 集合（镜像预算投影）。
    const committed = this.#committedRecordOf(artifactId);
    if (committed !== undefined && isDeliveredArtifact(committed)) {
      return this.#settleSkipped(
        'skipped_already_published',
        committed,
        '存储中已有 published 记录（幂等键 = artifact_id）：不重复物化、不重复发布',
        at,
      );
    }
    if (committed !== undefined && committed.status === 'failed') {
      // R49.4：已记 failed 的产物**不得**退回 published（**先于** applied 集合判定：
      // 存储是权威，跨重启也成立；applied 只是本次运行内的快路径）。
      return this.#settleSkipped(
        'refused_after_failure',
        committed,
        `产物已记为 failed（${String(committed.failure_kind)}），不得退回 published（R49.4）`,
        at,
      );
    }
    if (this.#applied.has(artifactId)) {
      const detail = '本次运行内已投影过（applied 集合）：重放不重复物化、不重复发布';
      return committed === undefined
        ? this.#settleSkippedWithoutRecord('skipped_already_published', record, detail)
        : this.#settleSkipped('skipped_already_published', committed, detail, at);
    }

    // ② 段2：版本闸门（§13"核对当前版本后再发布"）——不通过则**不调端口**，直接放弃物化。
    assertRequestPlanConsistency(fact.request);
    const currentRevision = this.#currentRevisionOf(record.task_id);
    let result: ArtifactMaterializationResult;
    if (currentRevision === null) {
      result = materializationFailure(
        fact.request,
        'version_stale',
        `任务 ${record.task_id} 不在存储中：无法核对当前版本，按"不得在无法确认时发布"放弃物化`,
        at,
      );
    } else if (currentRevision !== record.task_revision) {
      result = materializationFailure(
        fact.request,
        'version_stale',
        `版本闸门：当前任务版本 r${String(currentRevision)} ≠ 产物记录的 task_revision ` +
          `r${String(record.task_revision)}——放弃物化，旧版本不得覆盖最新文件（P2 / 任务书 §13）`,
        at,
      );
    } else {
      // ②' 事实闸门（FA-Q 的 F7；合同 R248 / R251）：版本相同还不够——还要核对产物所依据的
      //     **事实身份**与当前是否一致。同一 `task_revision` 内的事实 supersession 会让旧候选
      //     的 `fact_snapshot` 指向**已被取代**的事实 ⇒ 必须拒发。沿用既有 `version_stale`
      //     拒因与既有结构化失败路径（**不放宽**既有判据：闸门仍在端口之前、仍不调端口）。
      const factReason = staleFactIdentityReasons(
        artifactFactIdentities(fact.request),
        snapshotSharedFacts(this.#store.snapshot()),
      );
      if (factReason !== null) {
        result = materializationFailure(
          fact.request,
          'version_stale',
          `事实闸门：${factReason}——产物依据的事实身份与当前不一致，放弃物化` +
            '（R248 / R251：事实已变，旧值不得作为当前结果发布）',
          at,
        );
      } else {
        // ③ 外部副作用：**只在两道闸门都通过后、任何事务之外**调用（info-006）。
        result = materializeOrFail(this.#port, fact.request, at);
        this.#materializations += 1;
      }
    }

    const nextRecord = result.ok
      ? publishedRecordOf(fact, result.receipt, at)
      : failedRecordOf(fact, result.failure, at);
    const observation = observationOfRecord(
      result.ok ? 'artifact_published' : 'artifact_publish_failed',
      nextRecord,
      result.ok
        ? `产物已发布：${result.receipt.final_path}（回读摘要 ${result.receipt.readback_digest}，` +
            `验证者 ${result.receipt.verifier}）`
        : `产物物化失败（${result.failure.kind}）：${result.failure.detail}`,
      at,
    );

    // ④ 段3：新事务内写记录（+ 事务内观测钩子）。
    let written: ArtifactRecord;
    let fresh: boolean;
    try {
      const outcome = this.#store.transact((tx) => {
        const existing = tx.getArtifact(artifactId);
        if (existing !== undefined && (existing.status === 'published' || existing.status === 'failed')) {
          return { record: existing, fresh: false };
        }
        tx.putArtifact(nextRecord);
        this.#hooks.writeObservationInTransaction?.(tx, observation);
        return { record: nextRecord, fresh: true };
      });
      written = outcome.record;
      fresh = outcome.fresh;
    } catch (error) {
      return this.#settleAfterTransactionError(fact, result, error, at);
    }

    this.#applied.add(artifactId);

    if (!fresh) {
      // 段3 读到存储里已定局（并发窗口 / 上一轮已提交）：采用既有事实，不重复计数。
      const kind: ArtifactPublicationOutcomeKind = isDeliveredArtifact(written)
        ? 'skipped_already_published'
        : result.ok
          ? 'refused_after_failure'
          : 'failed';
      const detail =
        kind === 'skipped_already_published'
          ? '段3 发现存储中已有 published 记录：不重复发布（幂等键 = artifact_id）'
          : kind === 'refused_after_failure'
            ? '段3 发现存储中已有 failed 记录：不得退回 published（R49.4）'
            : `段3 发现存储中已有 failed 记录（${String(written.failure_kind)}）`;
      if (kind === 'failed') {
        return this.#settleFailed(written, written.failure_kind, detail, at);
      }
      return this.#settleSkipped(kind, written, detail, at);
    }

    this.#recordObservation(observation);
    if (result.ok) {
      this.#published += 1;
      return makeOutcome(
        'published',
        record,
        written,
        null,
        `已发布：${String(written.receipt?.final_path ?? '')}（回读摘要 ${written.content_digest}）`,
      );
    }
    this.#failed += 1;
    return makeOutcome(
      'failed',
      record,
      written,
      result.failure.kind,
      `物化失败（${result.failure.kind}）：${result.failure.detail}`,
    );
  }

  /** 投影的只读旁证（不写任何东西）。 */
  snapshot(): ArtifactPublicationSnapshot {
    return Object.freeze({
      applied_artifact_ids: Object.freeze([...this.#applied]),
      published_count: this.#published,
      failed_count: this.#failed,
      skipped_count: this.#skipped,
      unrecorded_count: this.#unrecorded,
      materialization_calls: this.#materializations,
      observations: Object.freeze([...this.#observations]),
    });
  }

  /** 投影内部日志里的观测（只读副本）。 */
  observations(): readonly ArtifactObservation[] {
    return Object.freeze([...this.#observations]);
  }

  /**
   * **事实变更后的失效传播**（合同 R248 / R251；FA-Q 的 F7）。
   *
   * 把引用了**已失效事实**的**已发布**产物标为 `expired`（保留为历史、不冒充当前结果），
   * **未受影响的产物一律不写**——同一条事实的变更只更新受影响产物，无关产物字节不变。
   *
   * 与 `reconcileOne` 的闸门共用同一批判据（`findFactInvalidatedArtifacts`）：
   * 闸门管"还没发布的候选"，本方法管"**已经发布、但所依据的事实随后变了**"的存量产物。
   *
   * 幂等：已经是 `expired`（或任何非 `published`）的记录不会被二次改写。
   */
  expireFactInvalidatedArtifacts(at: LogicalTime): readonly ArtifactPublicationOutcome[] {
    const snapshot = this.#store.snapshot();
    const facts = snapshotSharedFacts(snapshot);
    const affected = findFactInvalidatedArtifacts(snapshotArtifacts(snapshot), facts);
    if (affected.length === 0) return Object.freeze([]);
    const outcomes: ArtifactPublicationOutcome[] = [];
    for (const record of affected) outcomes.push(this.#expireOne(record, facts, at));
    return Object.freeze(outcomes);
  }

  /**
   * 段3 抛错时的收口：**以存储事实为准**。
   * - 已提交（`afterCommitBeforePublish` 型）⇒ 采纳已提交记录，补齐观测与 `applied`；
   * - 未提交 ⇒ 如实返回 `unrecorded`，**不**计入 `applied`（留给重跑），绝不声称已发布。
   */
  #settleAfterTransactionError(
    fact: StagedArtifactFact,
    result: ArtifactMaterializationResult,
    error: unknown,
    at: LogicalTime,
  ): ArtifactPublicationOutcome {
    const record = fact.record;
    const settled = this.#committedRecordOf(record.artifact_id);
    if (settled !== undefined && (settled.status === 'published' || settled.status === 'failed')) {
      this.#applied.add(record.artifact_id);
      const published = isDeliveredArtifact(settled);
      this.#recordObservation(
        observationOfRecord(
          published ? 'artifact_published' : 'artifact_publish_failed',
          settled,
          `段3 事务已提交但抛错（${describeError(error)}）：按已提交记录补齐一次（info-006 的 catch 路径）`,
          at,
        ),
      );
      if (published) {
        this.#published += 1;
        return makeOutcome(
          'published',
          record,
          settled,
          null,
          `段3 已提交（抛错路径）：${describeError(error)}`,
        );
      }
      this.#failed += 1;
      return makeOutcome(
        'failed',
        record,
        settled,
        settled.failure_kind,
        `段3 已提交（抛错路径）：${describeError(error)}`,
      );
    }
    this.#unrecorded += 1;
    const detail =
      `段3 事务未提交（${describeError(error)}）：物化结果与回执**未落库**，` +
      '产物既不是 published 也不是 failed——请按 staged 重跑（不得据此声称已交付）';
    this.#recordObservation(
      observationOf(
        'artifact_publish_skipped',
        record,
        record.task_revision,
        null,
        result.ok ? null : result.failure.kind,
        detail,
        at,
      ),
    );
    return makeOutcome(
      'unrecorded',
      record,
      null,
      result.ok ? null : result.failure.kind,
      detail,
    );
  }

  /**
   * 把一条已发布产物标为 `expired`（**只改这一条**）。
   *
   * 段3 事务内**只** `putArtifact` + 事务内观测钩子（info-006：外部副作用不在这里）；
   * 并发 / 重放若发现它已不再是 `published`，则**不重复改写**（返回 skipped）。
   */
  #expireOne(
    record: ArtifactRecord,
    facts: readonly SharedFactRecord[],
    at: LogicalTime,
  ): ArtifactPublicationOutcome {
    const reason = staleFactRefReason(record.source_fact_refs, facts) ?? '所依据的事实已失效';
    const detail = `事实变更使产物过期：${reason}（旧产物保留为历史、不冒充当前结果，R248 / R251）`;
    const expired = createArtifactRecord({
      ...record,
      status: 'expired',
      receipt: null,
      failure_kind: 'version_stale',
      verifications: mergeVerifications(record.verifications, [
        { kind: 'version_match', outcome: 'fail', detail },
      ]),
      updated_at: at,
    });
    const observation = observationOfRecord('artifact_publish_failed', expired, detail, at);
    try {
      const outcome = this.#store.transact((tx) => {
        const existing = tx.getArtifact(record.artifact_id);
        if (existing === undefined || !isDeliveredArtifact(existing)) {
          return { record: existing, fresh: false };
        }
        tx.putArtifact(expired);
        this.#hooks.writeObservationInTransaction?.(tx, observation);
        return { record: expired, fresh: true };
      });
      if (!outcome.fresh) {
        return this.#settleSkippedWithoutRecord(
          'skipped_already_published',
          record,
          `产物 ${record.artifact_id} 已非已发布态（并发 / 重放）：不重复标记过期`,
        );
      }
    } catch (error) {
      this.#unrecorded += 1;
      const errorDetail =
        `段3 事务未提交（${describeError(error)}）：过期标记未落库——不得据此声称该产物已被标记过期`;
      this.#recordObservation(
        observationOf(
          'artifact_publish_failed',
          record,
          record.task_revision,
          record.status,
          'version_stale',
          errorDetail,
          at,
        ),
      );
      return makeOutcome('unrecorded', record, null, 'version_stale', errorDetail);
    }
    this.#recordObservation(observation);
    this.#failed += 1;
    return makeOutcome('failed', record, expired, 'version_stale', detail);
  }

  /** 观测**只在事务之外**落进内部日志（info-006：事务体内不产生外部副作用）。 */
  #recordObservation(observation: ArtifactObservation): void {
    this.#observations.push(observation);
  }

  #committedRecordOf(artifactId: ArtifactRef): ArtifactRecord | undefined {
    return snapshotArtifacts(this.#store.snapshot()).find(
      (candidate) => candidate.artifact_id === artifactId,
    );
  }

  /** 当前任务版本；任务不存在时返回 `null`（**不得**当成 0 或默认版本）。 */
  #currentRevisionOf(taskId: TaskId): Revision | null {
    const task = this.#store.snapshot().tasks.find((candidate) => candidate.task_id === taskId);
    return task === undefined ? null : task.revision;
  }

  #settleSkipped(
    kind: 'skipped_already_published' | 'refused_after_failure',
    record: ArtifactRecord,
    detail: string,
    at: LogicalTime,
  ): ArtifactPublicationOutcome {
    this.#applied.add(record.artifact_id);
    this.#skipped += 1;
    this.#recordObservation(observationOfRecord('artifact_publish_skipped', record, detail, at));
    return makeOutcome(kind, record, record, record.failure_kind, detail);
  }

  /** 存储里连记录都没有（例如被 reset）时的跳过：仍不重复外部副作用。 */
  #settleSkippedWithoutRecord(
    kind: 'skipped_already_published',
    identity: ArtifactRecord,
    detail: string,
  ): ArtifactPublicationOutcome {
    this.#skipped += 1;
    return makeOutcome(kind, identity, null, null, detail);
  }

  #settleFailed(
    record: ArtifactRecord,
    failureKind: ArtifactFailureKind | null,
    detail: string,
    at: LogicalTime,
  ): ArtifactPublicationOutcome {
    this.#failed += 1;
    this.#recordObservation(observationOfRecord('artifact_publish_failed', record, detail, at));
    return makeOutcome('failed', record, record, failureKind, detail);
  }
}

/** 便捷构造（与 `createBudgetProjection` 同形）。 */
export function createArtifactPublicationProjection(
  deps: ArtifactPublicationDeps,
): ArtifactPublicationProjection {
  return new ArtifactPublicationProjection(deps);
}

function makeOutcome(
  kind: ArtifactPublicationOutcomeKind,
  identity: ArtifactIdentity,
  record: ArtifactRecord | null,
  failureKind: ArtifactFailureKind | null,
  detail: string,
): ArtifactPublicationOutcome {
  return Object.freeze({
    kind,
    artifact_id: identity.artifact_id,
    task_id: identity.task_id,
    record,
    failure_kind: failureKind,
    detail,
  });
}

/**
 * 调端口并把"端口抛错"转成结构化失败（R50.2：抛错只保留给宿主实现自身崩了，
 * 且必须被投影循环捕获后转成结构化失败记录）。
 *
 * `kind` 取 `builder_failed`：崩溃的**阶段不可归因**（构建 / 写盘 / 自检 / 改名皆可能），
 * 按最笼统的"构建器失败"记录并在 `detail` 保留原始异常文本——**不猜**更具体的原因。
 */
function materializeOrFail(
  port: ArtifactMaterializationPort,
  request: ArtifactMaterializationRequest,
  at: LogicalTime,
): ArtifactMaterializationResult {
  try {
    return port.materialize(request);
  } catch (error) {
    return materializationFailure(
      request,
      'builder_failed',
      `物化端口抛出异常（宿主实现自身崩溃，阶段不可归因）：${describeError(error)}`,
      at,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
