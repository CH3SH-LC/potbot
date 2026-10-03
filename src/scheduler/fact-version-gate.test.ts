/**
 * KRN-06：**共享事实 / 依赖图绑版本、迟到结果不覆盖新产物、资源锁 + 比较版本
 * 覆盖多个群组与后端工作进程**。
 *
 * ## 这个文件要钉死的判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 版本绑定：当前事实被绑成 `fact_key → fact_id`；顺序不同 ⇒ 同一 digest | 正例 |
 * | 2 | 已取代的旧事实**不是当前**（绑定取当前指向，不取历史） | **反例** |
 * | 3 | 正常提交：base == current ⇒ `v → v+1` | 正例 |
 * | 4 | **迟到结果**：旧轮次 base < current ⇒ 拒 `stale_artifact_version`，当前版本**不变** | **反例** |
 * | 5 | 反向对照：`evaluateCommit` 在 base == current 时判合法（证明拒绝来自版本比较） | **对照** |
 * | 6 | 轮次绑定落后任务版本 ⇒ 拒 `stale_task_revision` | **反例** |
 * | 7 | 事实已改 ⇒ 拒 `stale_fact_binding`；换新绑定的同一提交 ⇒ 放行 | **反例 + 对照** |
 * | 8 | 依赖图摘要已变 ⇒ 拒 `stale_dependency_graph` | **反例** |
 * | 9 | **两个群组、两个 gate 实例共享同一台账与锁**：A 持锁时 B 拿不到；A 完成后 B 才拿到，且 B 的迟到提交被拒 | 正例（跨群组 + 跨"工作进程"共享权威状态） |
 * | 10 | 栅栏失效（锁被释放 / 被重新获取）⇒ 旧持锁者提交被拒 `lock_not_held` | **反例** |
 * | 11 | 未知任务 ⇒ 拒 `unknown_task`；base > current ⇒ 拒 `artifact_version_gap` | **反例** |
 * | 12 | 诚实标注：内存锁端口与内存台账 `shared_across_processes === false`，说明明示"未验证" | **对照** |
 *
 * ## 诚实边界（与实现文件同一句）
 *
 * 第 9 / 10 条是**同进程模拟**（两个 `FactVersionGate` 实例共享**同一个内存锁端口与内存台账**），
 * **不是**两个真实进程并发互斥 / 共享状态的实测。真实多进程锁与跨进程台账**未实现、未验证**，
 * 本文件不据此宣称。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asRunId,
  asTaskId,
  createSharedFactRecord,
  type SharedFactRecord,
} from '../protocol/index.js';
import {
  FactVersionGate,
  artifactVersionKeyOf,
  captureFactVersion,
  createFactVersionGate,
  createMemoryFactVersionLedger,
  createMemoryLockPort,
  describeLockMedium,
  evaluateCommit,
  mustRejectCommit,
  type CommitObservation,
  type FactVersionCaptureInput,
  type FactVersionLedger,
  type LockFence,
  type ResourceLockPort,
  type ResultCommitRequest,
} from './fact-version-gate.js';

const TASK = asTaskId('T1');
const R1 = asRevision(1);
const R2 = asRevision(2);
const G1 = asGroupId('G1');
const G2 = asGroupId('G2');
const W1 = asInstanceId('W1');
const W2 = asInstanceId('W2');
const SLOT = Object.freeze({ task_id: TASK, artifact_key: 'document' });

function fact(key: string, id: string, at: number, supersedes: string | null = null): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(id),
    task_id: TASK,
    task_revision: R1,
    fact_key: key,
    value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmed_by: asInstanceId('U1'),
    confirmed_at: asLogicalTime(at),
    supersedes_fact_id: supersedes === null ? null : asFactRef(supersedes),
  });
}

const HEADCOUNT_1 = fact('headcount', 'fact-1', 0);
const HEADCOUNT_2 = fact('headcount', 'fact-2', 1, 'fact-1');
const BUDGET_1 = fact('budget.total', 'fact-b1', 0);

function bindingOf(facts: readonly SharedFactRecord[], dependencyDigest = 'dep-v1') {
  return captureFactVersion({
    task_id: TASK,
    task_revision: R1,
    facts,
    dependency_digest: dependencyDigest,
  });
}

const REGISTRATION: FactVersionCaptureInput = {
  task_id: TASK,
  task_revision: R1,
  facts: [HEADCOUNT_1],
  dependency_digest: 'dep-v1',
};

interface CommitOptions {
  readonly base?: number;
  readonly revision?: number;
  readonly group?: string;
  readonly instance?: string;
  readonly run?: string;
  readonly binding?: ReturnType<typeof bindingOf>;
  readonly artifact_ref?: string;
}

function request(fence: LockFence, options: CommitOptions = {}): ResultCommitRequest {
  return {
    key: SLOT,
    produced_by_group: asGroupId(options.group ?? 'G1'),
    produced_by_instance: asInstanceId(options.instance ?? 'W1'),
    round: { run_id: asRunId(options.run ?? 'run-1'), task_revision: asRevision(options.revision ?? 1) },
    base_artifact_version: options.base ?? 0,
    binding: options.binding ?? bindingOf([HEADCOUNT_1]),
    artifact_ref: asArtifactRef(options.artifact_ref ?? 'art-1'),
    fence,
    at: asLogicalTime(0),
  };
}

interface Fixture {
  readonly gate: FactVersionGate;
  readonly locks: ResourceLockPort;
  readonly ledger: FactVersionLedger;
}

function fixture(): Fixture {
  const locks = createMemoryLockPort();
  const ledger = createMemoryFactVersionLedger();
  const gate = createFactVersionGate(locks, ledger);
  gate.registerTask(REGISTRATION);
  return { gate, locks, ledger };
}

function acquire(gate: FactVersionGate, group: string, instance: string, at = 0): LockFence {
  const fence = gate.acquire(SLOT, { group_id: asGroupId(group), instance_id: asInstanceId(instance) }, asLogicalTime(at));
  if (fence === null) {
    throw new Error('测试夹具：未能获取资源锁');
  }
  return fence;
}

describe('KRN-06：共享事实与依赖图绑版本', () => {
  it('绑定取当前事实指向，且与输入顺序无关（同一 digest）', () => {
    const a = bindingOf([HEADCOUNT_1, BUDGET_1]);
    const b = bindingOf([BUDGET_1, HEADCOUNT_1]);
    expect(a.facts.map((entry) => entry.fact_key)).toEqual(['budget.total', 'headcount']);
    expect(a.digest).toBe(b.digest);
  });

  it('反向对照：已取代的旧事实不是当前（绑定不复用历史指向）', () => {
    const view = bindingOf([HEADCOUNT_1, HEADCOUNT_2]);
    expect(view.facts).toEqual([{ fact_key: 'headcount', fact_id: asFactRef('fact-2') }]);
    expect(view.facts.some((entry) => entry.fact_id === asFactRef('fact-1'))).toBe(false);
  });
});

describe('KRN-06：比较版本闸门（迟到结果不覆盖新产物）', () => {
  it('正常提交：base == current ⇒ v → v+1', () => {
    const { gate } = fixture();
    const fence = acquire(gate, 'G1', 'W1');
    const decision = gate.commit(request(fence));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.artifact_version).toBe(1);
    }
    expect(gate.currentArtifactVersion(SLOT)).toBe(1);
  });

  it('迟到结果：旧轮次 base < current ⇒ 拒绝，且当前版本**不变**', () => {
    const { gate } = fixture();
    const fenceA = acquire(gate, 'G1', 'W1');
    const first = gate.commit(request(fenceA));
    expect(first.ok).toBe(true);
    gate.release(fenceA);

    // 迟到的旧轮次：读到的是 base 0，但当前已经到 1。
    const fenceLate = acquire(gate, 'G1', 'W1', 1);
    const late = gate.commit(request(fenceLate, { base: 0, artifact_ref: 'art-STALE' }));
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.reason).toBe('stale_artifact_version');
    }
    // 关键的"不覆盖"：当前版本仍是第一次提交的 1，没有被旧结果盖掉。
    expect(gate.currentArtifactVersion(SLOT)).toBe(1);
  });

  it('反向对照：同一提交在 base == current 时判合法（拒绝由版本比较驱动）', () => {
    const { gate } = fixture();
    const fence = acquire(gate, 'G1', 'W1');
    const fresh = request(fence, { base: 1 });
    const observation: CommitObservation = {
      current_task_revision: R1,
      current_fact_ids: new Map([['headcount', asFactRef('fact-1')]]),
      current_dependency_digest: 'dep-v1',
      current_artifact_version: 1,
      lock_held: true,
    };
    expect(mustRejectCommit(fresh, observation)).toBe(false);
    const lowered: CommitObservation = { ...observation, current_artifact_version: 2 };
    expect(evaluateCommit(fresh, lowered).reason).toBe('stale_artifact_version');
  });

  it('轮次绑定落后任务版本 ⇒ 拒 stale_task_revision', () => {
    const { gate } = fixture();
    gate.bumpRevision(TASK, R2);
    const fence = acquire(gate, 'G1', 'W1');
    const decision = gate.commit(request(fence, { revision: 1 }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('stale_task_revision');
    }
  });

  it('事实已改 ⇒ 拒 stale_fact_binding；换新绑定 ⇒ 放行', () => {
    const { gate } = fixture();
    const oldBinding = bindingOf([HEADCOUNT_1]);
    gate.setCurrentFact(TASK, 'headcount', asFactRef('fact-2'));

    const fence = acquire(gate, 'G1', 'W1');
    const stale = gate.commit(request(fence, { binding: oldBinding }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('stale_fact_binding');
    }
    expect(gate.currentArtifactVersion(SLOT)).toBe(0);

    const freshBinding = bindingOf([HEADCOUNT_1, HEADCOUNT_2]);
    const fresh = gate.commit(request(fence, { binding: freshBinding }));
    expect(fresh.ok).toBe(true);
    expect(gate.currentArtifactVersion(SLOT)).toBe(1);
  });

  it('依赖图摘要变化 ⇒ 拒 stale_dependency_graph', () => {
    const { gate } = fixture();
    const fence = acquire(gate, 'G1', 'W1');
    const binding = bindingOf([HEADCOUNT_1], 'dep-v1');
    gate.setDependencyDigest(TASK, 'dep-v2');
    const decision = gate.commit(request(fence, { binding }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('stale_dependency_graph');
    }
  });

  it('未知任务 / 版本断层 ⇒ 拒 unknown_task / artifact_version_gap', () => {
    const unknownGate = createFactVersionGate();
    const fence = acquire(unknownGate, 'G1', 'W1');
    const unknown = unknownGate.commit(request(fence));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toBe('unknown_task');
    }

    const { gate } = fixture();
    const fence2 = acquire(gate, 'G1', 'W1');
    const gap = gate.commit(request(fence2, { base: 5 }));
    expect(gap.ok).toBe(false);
    if (!gap.ok) {
      expect(gap.reason).toBe('artifact_version_gap');
    }
  });
});

describe('KRN-06：资源锁跨群组 / 跨后端工作进程（同进程模拟，如实标注）', () => {
  it('两个群组、两个 gate 实例共享同一台账与锁：A 持锁时 B 拿不到，B 的迟到提交被拒', () => {
    const locks = createMemoryLockPort();
    const ledger = createMemoryFactVersionLedger();
    const workerA = createFactVersionGate(locks, ledger);
    const workerB = createFactVersionGate(locks, ledger);
    workerA.registerTask(REGISTRATION);

    const fenceA = workerA.acquire(SLOT, { group_id: G1, instance_id: W1 }, asLogicalTime(0));
    expect(fenceA).not.toBeNull();
    expect(locks.holderOf(artifactVersionKeyOf(SLOT))).toEqual({ group_id: G1, instance_id: W1 });

    // 另一个群组的工作进程拿不到同一资源的锁（跨群组串行化）。
    const blocked = workerB.acquire(SLOT, { group_id: G2, instance_id: W2 }, asLogicalTime(0));
    expect(blocked).toBeNull();

    const commitA = workerA.commit(request(fenceA as LockFence, { group: 'G1', instance: 'W1' }));
    expect(commitA.ok).toBe(true);
    workerA.release(fenceA as LockFence);

    // A 释放后 B 才能拿到；B 带着**旧基数**提交必须被拒（迟到不覆盖）。
    const fenceB = workerB.acquire(SLOT, { group_id: G2, instance_id: W2 }, asLogicalTime(1));
    expect(fenceB).not.toBeNull();
    const late = workerB.commit(request(fenceB as LockFence, { base: 0, group: 'G2', instance: 'W2' }));
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.reason).toBe('stale_artifact_version');
    }
    // **共享台账**：B 看得到 A 提交后的版本仍是 1，没有被旧结果盖掉。
    expect(workerB.currentArtifactVersion(SLOT)).toBe(1);
  });

  it('栅栏失效：锁被释放 / 被重新获取后，旧持锁者提交被拒 lock_not_held', () => {
    const { gate } = fixture();
    const fenceA = acquire(gate, 'G1', 'W1');

    // A 的锁被释放，B 重新获取 ⇒ A 的旧凭据失效。
    gate.release(fenceA);
    const fenceB = acquire(gate, 'G2', 'W2', 1);
    expect(fenceB.token).not.toBe(fenceA.token);

    const staleHolder = gate.commit(request(fenceA));
    expect(staleHolder.ok).toBe(false);
    if (!staleHolder.ok) {
      expect(staleHolder.reason).toBe('lock_not_held');
    }
    // 未持锁的提交零状态变更。
    expect(gate.currentArtifactVersion(SLOT)).toBe(0);
  });

  it('诚实标注：内存锁 / 内存台账 shared_across_processes === false，说明明示"未验证"', () => {
    const locks = createMemoryLockPort();
    const ledger = createMemoryFactVersionLedger();
    expect(locks.shared_across_processes).toBe(false);
    expect(ledger.shared_across_processes).toBe(false);
    expect(describeLockMedium(locks)).toContain('未验证');
    const gate = createFactVersionGate(locks, ledger);
    expect(gate.lockPort.shared_across_processes).toBe(false);
    expect(gate.versionLedger.shared_across_processes).toBe(false);
  });
});
