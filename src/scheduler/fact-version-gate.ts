/**
 * **共享事实 / 依赖图绑版本、迟到结果不覆盖新产物的比较版本闸门**（KRN-06；
 * 合同 R210 / R213 / R230；设计 design-06 §2）。
 *
 * ## 这一件修的是什么
 *
 * 任务里有多个群组、多个后端工作进程并行产出。最经典的失效是**丢更新（lost update）**：
 * 一个**旧轮次**的产物在更晚的时刻才回来，写进同一个产物槽位，把**更新的版本**盖掉——
 * 而且悄无声息。快照里只剩"最新写者"，看不出中间发生过一次回退。
 *
 * 本层把"谁能写"变成**两道独立的闸门**，缺一不可：
 *
 * 1. **版本绑定（compare-and-set）**：每一个产物槽位有一个单调递增的 `artifact_version`。
 *    产出者在读到版本 `v` 时开始工作，提交时必须声明 `base_artifact_version = v`；
 *    只有**当前版本仍等于 `v`** 才允许提交（`v → v+1`），且推进走台账的**原子 CAS**
 *    （`compareAndSetArtifactVersion`）——两个写者同时拿着 `v`，只有一个能成功。
 *    - `base < current` ⇒ **迟到结果**（`stale_artifact_version`），拒绝：**旧的不能盖新的**；
 *    - `base > current` ⇒ **版本断层**（`artifact_version_gap`），拒绝：写者读到了不存在的版本。
 * 2. **资源锁（注入端口）**：提交必须持有该资源槽位的**栅栏凭据（fence）**。
 *    锁按**资源**（不是按群组）命名，因此**跨群组**串行化；
 *    持锁后被别人抢走 / 已释放 ⇒ 凭据失效（`lock_not_held`），**旧持锁者不得再写**。
 *
 * 版本绑定不只看产物版本：**共享事实与依赖图也绑定版本**。产出者提交时必须携带
 * 它据以计算的 `FactVersionView`（`fact_key → fact_id` 的当前指向 + 依赖图摘要）。
 * 任何一个事实键的当前指向变了、或依赖图摘要变了，提交都被拒
 * （`stale_fact_binding` / `stale_dependency_graph`）——"事实单一来源变了，产物必须重算"。
 *
 * ## 两个可注入端口（这才是"覆盖多群组 / 多后端工作进程"的落点）
 *
 * - `ResourceLockPort` —— 互斥（谁此刻能写）；
 * - `FactVersionLedger` —— **权威版本台账**（当前任务版本 / 事实指向 / 依赖图摘要 / 槽位版本）。
 *
 * 两者都可注入，因此"多个群组、多个后端工作进程"能不能共享同一份权威状态，取决于
 * 注入方给的是**共享介质**还是各自内存。多个 `FactVersionGate` 实例可以**共享同一个台账**，
 * 于是比较版本真的跨实例生效（单测里正是这么模拟两个工作进程的）。
 *
 * ## 与既有模块的关系（只读复用，不改它）
 *
 * - `src/protocol/facts`：`currentFactByKey()` 是"同一任务 + 版本 + 键下的当前事实"的**唯一**判据，
 *   `captureFactVersion()` 直接用它，**不另写一套"哪条是当前"的规则**；
 * - `src/protocol`：`TaskId` / `Revision` / `RunId` / `GroupId` / `InstanceId` / `FactRef` 等品牌类型；
 * - `src/dependency`：`canonicalDigest`（摘要）与 `compareStrings`（确定性排序）；
 * - `src/scheduler/errors`：`SchedulerError`（参数错误即大声失败，不静默降级）。
 *
 * ## 诚实边界（务必连着读）
 *
 * `createMemoryLockPort()` / `createMemoryFactVersionLedger()` 都是**同进程介质**
 * （`shared_across_processes === false`）。单测用**两个 gate 实例共享同一个端口 / 台账**来
 * 模拟"两个后端工作进程"——这是**同进程模拟**，**不是**真实多进程互斥或共享状态的实测。
 * **真实跨进程锁与跨进程版本台账（文件锁 / 数据库行锁 / 分布式 CAS）未实现、未验证**，
 * 本模块不据此宣称。`describeLockMedium()` 把这句话变成可读、可断言的诚实标注。
 */

import { SchedulerError } from './errors.js';
import { canonicalDigest, compareStrings } from '../dependency/index.js';
import {
  currentFactByKey,
  type ArtifactRef,
  type FactRef,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type RunId,
  type SharedFactRecord,
  type TaskId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 版本绑定：共享事实 + 依赖图
// ---------------------------------------------------------------------------

/** 一条事实键在绑定时刻的**当前**指向。 */
export interface BoundFact {
  readonly fact_key: string;
  readonly fact_id: FactRef;
}

/**
 * 产出者据以计算的**版本绑定**：任务版本 + 每条事实键的当前事实 + 依赖图摘要。
 *
 * `digest` 是绑定整体的确定性摘要，用于去重与证据比对（同输入必得同摘要）。
 */
export interface FactVersionView {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  /** 按 `fact_key` 升序（与输入顺序无关）。 */
  readonly facts: readonly BoundFact[];
  readonly dependency_digest: string;
  readonly digest: string;
}

export interface FactVersionCaptureInput {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly facts: readonly SharedFactRecord[];
  readonly dependency_digest: string;
}

/**
 * 捕获一份版本绑定。
 *
 * 只用 `currentFactByKey()` 取"当前事实"——它会在**同一键出现两个当前值**时抛错
 * （单一来源被破坏），本层**原样透出**该失败，绝不"任取一条"继续。
 */
export function captureFactVersion(input: FactVersionCaptureInput): FactVersionView {
  const keys = new Set<string>();
  for (const fact of input.facts) {
    if (fact.task_id === input.task_id && fact.task_revision === input.task_revision) {
      keys.add(fact.fact_key);
    }
  }
  const bound: BoundFact[] = [];
  for (const key of [...keys].sort(compareStrings)) {
    const current = currentFactByKey(input.facts, {
      task_id: input.task_id,
      task_revision: input.task_revision,
      fact_key: key,
    });
    if (current !== undefined) {
      bound.push(Object.freeze({ fact_key: key, fact_id: current.fact_id }));
    }
  }
  const frozenFacts = Object.freeze(bound);
  const digest = canonicalDigest(
    JSON.stringify({
      task_id: input.task_id,
      task_revision: input.task_revision,
      facts: frozenFacts.map((entry) => `${entry.fact_key}=${entry.fact_id}`),
      dependency_digest: input.dependency_digest,
    }),
  );
  return Object.freeze({
    task_id: input.task_id,
    task_revision: input.task_revision,
    facts: frozenFacts,
    dependency_digest: input.dependency_digest,
    digest,
  });
}

// ---------------------------------------------------------------------------
// 产物槽位（资源身份）
// ---------------------------------------------------------------------------

/**
 * 一个**产物槽位**的稳定身份：`(task_id, artifact_key)`。
 *
 * `artifact_key` 是"同一件产物"的机器可判身份（如同一模板种类下的一份交付物），
 * 与具体的 `ArtifactRef`（每一版各不相同）分开——槽位是单调版本号的家。
 */
export interface ArtifactVersionRef {
  readonly task_id: TaskId;
  readonly artifact_key: string;
}

/** 槽位的字符串键（经 `artifactVersionKeyOf()` 派生，唯一来源）。 */
export function artifactVersionKeyOf(ref: ArtifactVersionRef): string {
  return `${ref.task_id}::${ref.artifact_key}`;
}

// ---------------------------------------------------------------------------
// 权威版本台账（可注入：注入方可用跨进程介质实现）
// ---------------------------------------------------------------------------

/**
 * **权威版本台账**端口：任务当前版本、事实键当前指向、依赖图摘要、槽位产物版本。
 *
 * 注入方若给的是**共享介质**（文件 / 数据库 / 分布式 KV），则多个后端工作进程共享同一份
 * 权威状态；若给的是本模块的 `createMemoryFactVersionLedger()`，则只覆盖同进程。
 * `shared_across_processes` 是**诚实标注位**——本层绝不把同进程介质说成跨进程台账。
 */
export interface FactVersionLedger {
  readonly shared_across_processes: boolean;
  currentRevision(taskId: TaskId): Revision | undefined;
  currentFactIds(taskId: TaskId): ReadonlyMap<string, FactRef>;
  currentDependencyDigest(taskId: TaskId): string | undefined;
  currentArtifactVersion(ref: ArtifactVersionRef): number;
  /** 登记 / 覆盖任务权威版本，返回捕获的绑定。 */
  registerTask(input: FactVersionCaptureInput): FactVersionView;
  /** 推进任务版本（必须单调递增）。 */
  bumpRevision(taskId: TaskId, revision: Revision): void;
  /** 更新某事实键的当前指向。 */
  setCurrentFact(taskId: TaskId, factKey: string, factId: FactRef): void;
  /** 更新依赖图摘要。 */
  setDependencyDigest(taskId: TaskId, digest: string): void;
  /** **原子 CAS**：当前槽位版本等于 `expected` 时置为 `next`，返回是否成功。 */
  compareAndSetArtifactVersion(ref: ArtifactVersionRef, expected: number, next: number): boolean;
}

interface TaskState {
  revision: Revision;
  dependency_digest: string;
  fact_ids: Map<string, FactRef>;
}

/** 同进程内存台账（**不是**跨进程共享，`shared_across_processes: false`）。 */
export function createMemoryFactVersionLedger(): FactVersionLedger {
  const tasks = new Map<TaskId, TaskState>();
  const artifactVersions = new Map<string, number>();
  const requireTask = (taskId: TaskId): TaskState => {
    const state = tasks.get(taskId);
    if (state === undefined) {
      throw new SchedulerError(`任务 ${taskId} 未登记，不能读写权威版本`);
    }
    return state;
  };
  return {
    shared_across_processes: false,
    currentRevision: (taskId) => tasks.get(taskId)?.revision,
    currentFactIds: (taskId) => new Map(tasks.get(taskId)?.fact_ids ?? []),
    currentDependencyDigest: (taskId) => tasks.get(taskId)?.dependency_digest,
    currentArtifactVersion: (ref) => artifactVersions.get(artifactVersionKeyOf(ref)) ?? 0,
    registerTask(input) {
      const binding = captureFactVersion(input);
      const factIds = new Map<string, FactRef>();
      for (const entry of binding.facts) {
        factIds.set(entry.fact_key, entry.fact_id);
      }
      tasks.set(input.task_id, {
        revision: input.task_revision,
        dependency_digest: input.dependency_digest,
        fact_ids: factIds,
      });
      return binding;
    },
    bumpRevision(taskId, revision) {
      const state = requireTask(taskId);
      if (revision <= state.revision) {
        throw new SchedulerError(
          `任务 ${taskId} 的版本必须单调递增：当前 r${String(state.revision)}，收到 r${String(revision)}`,
        );
      }
      state.revision = revision;
    },
    setCurrentFact(taskId, factKey, factId) {
      requireTask(taskId).fact_ids.set(factKey, factId);
    },
    setDependencyDigest(taskId, digest) {
      requireTask(taskId).dependency_digest = digest;
    },
    compareAndSetArtifactVersion(ref, expected, next) {
      const key = artifactVersionKeyOf(ref);
      const current = artifactVersions.get(key) ?? 0;
      if (current !== expected) {
        return false;
      }
      artifactVersions.set(key, next);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 资源锁端口（可注入；同进程介质如实标注）
// ---------------------------------------------------------------------------

/** 持锁者 = (群组, 实例)。跨群组可见，故锁按资源命名而不是按群组命名。 */
export interface LockOwner {
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
}

/** 栅栏凭据：证明"我此刻持有这个资源"。 */
export interface LockFence {
  readonly resource: string;
  readonly owner: LockOwner;
  readonly token: string;
  readonly acquired_at: LogicalTime;
}

/**
 * 资源锁端口。
 *
 * `shared_across_processes` 是**诚实标注位**：本层绝不把同进程介质说成跨进程锁。
 */
export interface ResourceLockPort {
  readonly shared_across_processes: boolean;
  /** 尝试获取；成功返回凭据，已被别人持有返回 `null`（不排队、不阻塞）。 */
  tryAcquire(resource: string, owner: LockOwner, at: LogicalTime): LockFence | null;
  /** 当前持锁者（无人持锁返回 `null`）。 */
  holderOf(resource: string): LockOwner | null;
  /** 释放：仅**持锁者本人**能释放（凭据不匹配返回 `false`）。 */
  release(fence: LockFence): boolean;
  /** **栅栏校验**：该凭据此刻是否仍然有效（锁没被释放、也没被别人重新获取）。 */
  isValid(fence: LockFence): boolean;
}

/** 同进程内存锁（**不是**跨进程锁，`shared_across_processes: false`）。 */
export function createMemoryLockPort(): ResourceLockPort {
  const held = new Map<string, LockFence>();
  let counter = 0;
  return {
    shared_across_processes: false,
    tryAcquire(resource: string, owner: LockOwner, at: LogicalTime): LockFence | null {
      if (held.has(resource)) {
        return null;
      }
      counter += 1;
      const fence: LockFence = Object.freeze({
        resource,
        owner: Object.freeze({ ...owner }),
        token: `${resource}#${String(counter)}`,
        acquired_at: at,
      });
      held.set(resource, fence);
      return fence;
    },
    holderOf(resource: string): LockOwner | null {
      return held.get(resource)?.owner ?? null;
    },
    release(fence: LockFence): boolean {
      const current = held.get(fence.resource);
      if (current === undefined || current.token !== fence.token) {
        return false;
      }
      held.delete(fence.resource);
      return true;
    },
    isValid(fence: LockFence): boolean {
      return held.get(fence.resource)?.token === fence.token;
    },
  };
}

/** 可读的诚实标注（把"这是同进程模拟"从注释变成可断言的字符串）。 */
export function describeLockMedium(port: ResourceLockPort): string {
  return port.shared_across_processes
    ? '资源锁介质声明为**跨进程共享**（由注入方保证；本模块未验证其实现）'
    : '资源锁介质为**同进程内存**（本模块的默认实现）：多进程互斥**未实现、未验证**，不得据此宣称';
}

// ---------------------------------------------------------------------------
// 提交请求与判定
// ---------------------------------------------------------------------------

/** 一次产物提交。 */
export interface ResultCommitRequest {
  readonly key: ArtifactVersionRef;
  readonly produced_by_group: GroupId;
  readonly produced_by_instance: InstanceId;
  /** 产出它的**轮次**（绑定 run_id 与本轮任务版本）。 */
  readonly round: { readonly run_id: RunId; readonly task_revision: Revision };
  /** 产出者在开始工作时读到的产物版本；提交要求当前版本仍等于它（CAS）。 */
  readonly base_artifact_version: number;
  /** 产出者据以计算的事实 / 依赖图绑定。 */
  readonly binding: FactVersionView;
  readonly artifact_ref: ArtifactRef;
  /** 持有的资源锁栅栏。 */
  readonly fence: LockFence;
  readonly at: LogicalTime;
}

export const COMMIT_REJECTION_REASONS = [
  'unknown_task', // 台账里没有这个任务的权威版本
  'lock_not_held', // 栅栏凭据失效（未持锁 / 被抢走）
  'stale_task_revision', // 轮次绑定的任务版本落后于当前（迟到轮次）
  'stale_fact_binding', // 依据的共享事实已不是当前指向
  'stale_dependency_graph', // 依据的依赖图已变
  'stale_artifact_version', // **迟到结果**：base < current，旧的不能盖新的
  'artifact_version_gap', // base > current：写者读到了不存在的版本
] as const;
export type CommitRejectionReason = (typeof COMMIT_REJECTION_REASONS)[number];

export const COMMIT_REJECTION_LABELS: Readonly<Record<CommitRejectionReason, string>> = Object.freeze({
  unknown_task: '台账里没有该任务的权威版本',
  lock_not_held: '未持有资源锁或栅栏凭据已失效',
  stale_task_revision: '轮次绑定的任务版本落后于当前（迟到轮次不得写入）',
  stale_fact_binding: '依据的共享事实已不是当前指向（必须按新事实重算）',
  stale_dependency_graph: '依据的依赖图已变更（必须重算）',
  stale_artifact_version: '迟到结果：基数版本落后于当前产物版本（旧的不覆盖新的）',
  artifact_version_gap: '基数版本超前于当前产物版本（读到了不存在的版本）',
});

/** 判定的**观测**：台账此刻的权威状态（可由 `FactVersionGate.observe()` 得到）。 */
export interface CommitObservation {
  readonly current_task_revision: Revision | undefined;
  /** `fact_key → 当前 fact_id`（权威）。 */
  readonly current_fact_ids: ReadonlyMap<string, FactRef>;
  readonly current_dependency_digest: string | undefined;
  readonly current_artifact_version: number;
  readonly lock_held: boolean;
}

export interface CommitValidity {
  readonly valid: boolean;
  readonly reason: CommitRejectionReason | null;
  readonly detail: string | null;
}

function reject(reason: CommitRejectionReason, detail: string): CommitValidity {
  return Object.freeze({ valid: false, reason, detail });
}

/**
 * 提交合法性判定（**纯函数**；闸门与单测共用同一批判据，避免两处规则分叉）。
 *
 * 判定顺序（先拦最根本的，再拦具体版本差异）：
 * 任务存在 → 栅栏有效 → 轮次版本 → 事实绑定 → 依赖图 → 产物版本 CAS。
 */
export function evaluateCommit(
  request: ResultCommitRequest,
  observation: CommitObservation,
): CommitValidity {
  const { current_task_revision } = observation;
  if (current_task_revision === undefined) {
    return reject('unknown_task', `台账里没有任务 ${request.key.task_id} 的权威版本`);
  }
  if (!observation.lock_held) {
    return reject('lock_not_held', `资源 ${request.fence.resource} 的栅栏凭据此刻无效`);
  }
  if (request.round.task_revision !== current_task_revision) {
    return reject(
      'stale_task_revision',
      `轮次绑定 r${String(request.round.task_revision)}，当前 r${String(current_task_revision)}：` +
        '迟到轮次不得发布',
    );
  }
  if (request.binding.task_revision !== current_task_revision) {
    return reject(
      'stale_task_revision',
      `绑定 r${String(request.binding.task_revision)}，当前 r${String(current_task_revision)}`,
    );
  }
  for (const entry of request.binding.facts) {
    const current = observation.current_fact_ids.get(entry.fact_key);
    if (current !== entry.fact_id) {
      return reject(
        'stale_fact_binding',
        `事实 ${entry.fact_key} 已从 ${entry.fact_id} 变为 ${current ?? '（不存在）'}：必须按新事实重算`,
      );
    }
  }
  if (request.binding.dependency_digest !== observation.current_dependency_digest) {
    return reject(
      'stale_dependency_graph',
      `依赖图摘要已从 ${request.binding.dependency_digest} 变为 ${observation.current_dependency_digest ?? '（不存在）'}`,
    );
  }
  if (request.base_artifact_version < observation.current_artifact_version) {
    return reject(
      'stale_artifact_version',
      `基数版本 ${String(request.base_artifact_version)} < 当前 ${String(observation.current_artifact_version)}：` +
        '迟到结果不得覆盖更新的产物',
    );
  }
  if (request.base_artifact_version > observation.current_artifact_version) {
    return reject(
      'artifact_version_gap',
      `基数版本 ${String(request.base_artifact_version)} > 当前 ${String(observation.current_artifact_version)}：` +
        '写者读到了不存在的版本',
    );
  }
  return Object.freeze({ valid: true, reason: null, detail: null });
}

/** 便捷判定：本次提交是否**必须**被拒。 */
export function mustRejectCommit(request: ResultCommitRequest, observation: CommitObservation): boolean {
  return !evaluateCommit(request, observation).valid;
}

// ---------------------------------------------------------------------------
// 提交结论
// ---------------------------------------------------------------------------

export type CommitDecision =
  | {
      readonly ok: true;
      readonly artifact_version: number;
      readonly artifact_ref: ArtifactRef;
      readonly digest: string;
    }
  | { readonly ok: false; readonly reason: CommitRejectionReason; readonly detail: string };

// ---------------------------------------------------------------------------
// 闸门
// ---------------------------------------------------------------------------

export interface FactVersionGateOptions {
  readonly locks: ResourceLockPort;
  readonly ledger: FactVersionLedger;
}

/**
 * 事实 / 依赖图版本闸门。
 *
 * 它**自己不持有**权威状态——权威状态在注入的 `FactVersionLedger` 里，互斥在注入的
 * `ResourceLockPort` 里。因此"多个群组、多个后端工作进程"是否共享权威状态，由注入决定；
 * 多个 `FactVersionGate` 实例共享同一份台账时，比较版本真的跨实例生效。
 */
export class FactVersionGate {
  private readonly locks: ResourceLockPort;
  private readonly ledger: FactVersionLedger;

  constructor(options: FactVersionGateOptions) {
    this.locks = options.locks;
    this.ledger = options.ledger;
  }

  /** 资源锁端口（只读访问，便于宿主与测试核对介质诚实标注）。 */
  get lockPort(): ResourceLockPort {
    return this.locks;
  }

  /** 权威版本台账（只读访问）。 */
  get versionLedger(): FactVersionLedger {
    return this.ledger;
  }

  registerTask(input: FactVersionCaptureInput): FactVersionView {
    return this.ledger.registerTask(input);
  }

  bumpRevision(taskId: TaskId, revision: Revision): void {
    this.ledger.bumpRevision(taskId, revision);
  }

  setDependencyDigest(taskId: TaskId, digest: string): void {
    this.ledger.setDependencyDigest(taskId, digest);
  }

  setCurrentFact(taskId: TaskId, factKey: string, factId: FactRef): void {
    this.ledger.setCurrentFact(taskId, factKey, factId);
  }

  currentRevision(taskId: TaskId): Revision | undefined {
    return this.ledger.currentRevision(taskId);
  }

  currentArtifactVersion(ref: ArtifactVersionRef): number {
    return this.ledger.currentArtifactVersion(ref);
  }

  /** 获取资源槽位的锁（跨群组）。 */
  acquire(ref: ArtifactVersionRef, owner: LockOwner, at: LogicalTime): LockFence | null {
    return this.locks.tryAcquire(artifactVersionKeyOf(ref), owner, at);
  }

  release(fence: LockFence): boolean {
    return this.locks.release(fence);
  }

  /** 构造当前观测（供 `evaluateCommit()` 使用，也可供外部核对）。 */
  observe(ref: ArtifactVersionRef, fence: LockFence | null): CommitObservation {
    return Object.freeze({
      current_task_revision: this.ledger.currentRevision(ref.task_id),
      current_fact_ids: this.ledger.currentFactIds(ref.task_id),
      current_dependency_digest: this.ledger.currentDependencyDigest(ref.task_id),
      current_artifact_version: this.ledger.currentArtifactVersion(ref),
      lock_held: fence !== null && this.locks.isValid(fence),
    });
  }

  /**
   * 提交一次结果。
   *
   * 判据走 `evaluateCommit()`（纯函数）；通过后**以原子 CAS** 把槽位版本从 `base` 推进到
   * `base + 1`。若观测与 CAS 之间被另一个写者抢先（CAS 失败）⇒ 同样按 `stale_artifact_version`
   * 拒绝——这是"比较版本"在高并发下的最后一道保证，不靠观测时刻的运气。
   * 被拒时**零状态变更**（不推进版本、不记任何东西）——拒绝就是拒绝。
   */
  commit(request: ResultCommitRequest): CommitDecision {
    const observation = this.observe(request.key, request.fence);
    const validity = evaluateCommit(request, observation);
    if (!validity.valid) {
      return Object.freeze({
        ok: false as const,
        reason: validity.reason as CommitRejectionReason,
        detail: validity.detail ?? '',
      });
    }
    const advanced = this.ledger.compareAndSetArtifactVersion(
      request.key,
      request.base_artifact_version,
      request.base_artifact_version + 1,
    );
    if (!advanced) {
      return Object.freeze({
        ok: false as const,
        reason: 'stale_artifact_version' as const,
        detail:
          `原子 CAS 失败：槽位 ${artifactVersionKeyOf(request.key)} 已被另一个写者抢先推进` +
          '（观测与写入之间发生了并发提交）',
      });
    }
    const next = request.base_artifact_version + 1;
    const digest = canonicalDigest(
      JSON.stringify({
        key: artifactVersionKeyOf(request.key),
        artifact_version: next,
        artifact_ref: request.artifact_ref,
        group: request.produced_by_group,
        instance: request.produced_by_instance,
        run: request.round.run_id,
        binding: request.binding.digest,
      }),
    );
    return Object.freeze({
      ok: true as const,
      artifact_version: next,
      artifact_ref: request.artifact_ref,
      digest,
    });
  }
}

/** 便捷构造：同进程介质（锁 + 台账共享给同一批 gate 实例）。 */
export function createFactVersionGate(
  locks: ResourceLockPort = createMemoryLockPort(),
  ledger: FactVersionLedger = createMemoryFactVersionLedger(),
): FactVersionGate {
  return new FactVersionGate({ locks, ledger });
}
