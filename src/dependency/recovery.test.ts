/**
 * 自动恢复账本单测（D05；合同 §九-7 / Q9-b；任务书 §10；A05-09 / A05-10）。
 *
 * 锁定三件事：
 * 1. **同版同阻塞指纹、无新证据时最多一次**自动恢复（上限取 protocol 的 `MAX_AUTO_RECOVERY_PER_FINGERPRINT`）；
 * 2. **同一恢复动作不得重复**（即使有新证据）；
 * 3. **新证据**（非空且与上次不同的引用）才重置次数——"无新证据"是拒绝理由，不是定时重试的理由。
 *
 * 末段是受控缺陷注入：把上限调到极大（等价于 I-A05-3「反复恢复」），
 * 证明"A05-09 自动恢复次数 ≤ 1"这条断言**依赖本账本的上限**，而不是恒真。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_AUTO_RECOVERY_PER_FINGERPRINT,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  type WorkItem,
} from '../protocol/index.js';
import {
  computeBlockingFingerprint,
  fingerprintOfBlockedItems,
  RecoveryLedger,
  RecoveryRefusedError,
  RECOVERY_REFUSAL_REASONS,
  type BlockingFingerprint,
} from './index.js';
import { DependencyError } from './errors.js';

const AT = asLogicalTime(0);

/** 造一个"等待依赖"的工作项（指纹成员判据：非终态 + 有阻塞原因）。 */
function wiForFingerprint(id: string, deps: readonly string[]): WorkItem {
  return createWorkItem({
    request_id: asRequestId(id),
    task_id: asTaskId('T1'),
    task_revision: asRevision(1),
    owner_instance_id: asInstanceId('I-A'),
    status: 'waiting_dependency',
    blocker_reason: { kind: 'waiting_dependency', detail: `等待 ${deps.join(',')}` },
    dependency_refs: deps.map((dep) => ({ request_id: asRequestId(dep) })),
    created_at: AT,
    updated_at: AT,
  });
}

const fingerprint = (revision = 1): BlockingFingerprint =>
  computeBlockingFingerprint({
    task_revision: asRevision(revision),
    blocked_request_ids: [asRequestId('A'), asRequestId('B')],
    blocker_kinds: ['waiting_dependency'],
    dependency_ids: ['req:A', 'req:B'],
  });

describe('上限与默认值', () => {
  it('默认上限取 protocol 的 MAX_AUTO_RECOVERY_PER_FINGERPRINT（=1）', () => {
    expect(MAX_AUTO_RECOVERY_PER_FINGERPRINT).toBe(1);
    expect(new RecoveryLedger().maxAllowed).toBe(MAX_AUTO_RECOVERY_PER_FINGERPRINT);
  });

  it('上限非法 ⇒ 抛 DependencyError', () => {
    expect(() => new RecoveryLedger(-1)).toThrow(DependencyError);
    expect(() => new RecoveryLedger(1.5)).toThrow(DependencyError);
  });

  it('拒因集合是封闭的三项', () => {
    expect([...RECOVERY_REFUSAL_REASONS]).toEqual([
      'no_fingerprint',
      'duplicate_action',
      'already_recovered',
    ]);
  });
});

describe('同版同指纹最多一次（A05-09）', () => {
  it('第一次允许，第二次（不同动作）因已达上限被拒', () => {
    const ledger = new RecoveryLedger();
    const fp = fingerprint();

    expect(ledger.canAutoRecover(fp, 'requeue-missing-request').allowed).toBe(true);
    ledger.recordAutoRecovery(fp, 'requeue-missing-request', { at: AT });
    expect(ledger.recoveryCount(fp)).toBe(1);

    const second = ledger.canAutoRecover(fp, 'ask-user-for-input');
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('already_recovered');
    expect(second.recovery_count).toBe(1);
    expect(second.max_allowed).toBe(1);

    expect(() => ledger.recordAutoRecovery(fp, 'ask-user-for-input', { at: AT })).toThrow(
      RecoveryRefusedError,
    );
  });

  it('同一动作重复 ⇒ duplicate_action（即使还没到上限）', () => {
    const ledger = new RecoveryLedger(3);
    const fp = fingerprint(2);
    ledger.recordAutoRecovery(fp, 'requeue-missing-request', { at: AT });
    const again = ledger.canAutoRecover(fp, 'requeue-missing-request');
    expect(again.allowed).toBe(false);
    expect(again.reason).toBe('duplicate_action');
    // 换一个动作则仍可（上限 3 未达）
    expect(ledger.canAutoRecover(fp, 'ask-user-for-input').allowed).toBe(true);
  });

  it('不同指纹互不干扰（版本推进 ⇒ 新的计费周期）', () => {
    const ledger = new RecoveryLedger();
    const r1 = fingerprint(1);
    const r2 = fingerprint(2);
    ledger.recordAutoRecovery(r1, 'requeue-missing-request', { at: AT });
    expect(ledger.canAutoRecover(r1, 'other-action').allowed).toBe(false);
    expect(ledger.canAutoRecover(r2, 'requeue-missing-request').allowed).toBe(true);
  });

  it('没有指纹 ⇒ no_fingerprint（不得凭空恢复）', () => {
    const ledger = new RecoveryLedger();
    const decision = ledger.canAutoRecover(null, 'anything');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('no_fingerprint');
    expect(ledger.recoveryCount(null)).toBe(0);
  });

  it('指纹为 null 时 recordAutoRecovery 抛 RecoveryRefusedError', () => {
    const ledger = new RecoveryLedger();
    expect(() => ledger.recordAutoRecovery(null, 'anything', { at: AT })).toThrow(RecoveryRefusedError);
  });
});

describe('新证据才重置次数（§九-7「无新证据」）', () => {
  it('新引用 ⇒ 重置；同引用 ⇒ 不重置；空引用 ⇒ 抛错', () => {
    const ledger = new RecoveryLedger();
    const fp = fingerprint();
    ledger.recordAutoRecovery(fp, 'requeue-missing-request', { at: AT });
    expect(ledger.canAutoRecover(fp, 'second-action').allowed).toBe(false);

    // 同一个证据引用重复登记：不算新证据
    expect(ledger.noteNewEvidence(fp, 'evidence-1')).toBe(true);
    expect(ledger.noteNewEvidence(fp, 'evidence-1')).toBe(false);
    expect(ledger.recoveryCount(fp)).toBe(0);
    expect(ledger.canAutoRecover(fp, 'second-action').allowed).toBe(true);

    // 空引用不是新证据
    expect(() => ledger.noteNewEvidence(fp, '   ')).toThrow(DependencyError);
  });

  it('重置后**同一动作**仍不得重复（A05-10）', () => {
    const ledger = new RecoveryLedger();
    const fp = fingerprint();
    ledger.recordAutoRecovery(fp, 'requeue-missing-request', { at: AT });
    ledger.noteNewEvidence(fp, 'evidence-1');
    const decision = ledger.canAutoRecover(fp, 'requeue-missing-request');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('duplicate_action');
    // 但全新动作可以
    ledger.recordAutoRecovery(fp, 'contact-owner', { at: AT });
    expect(ledger.recoveryCount(fp)).toBe(1);
  });

  it('跨重置的累计次数与当前计费周期次数分别可读', () => {
    const ledger = new RecoveryLedger();
    const fp = fingerprint();
    ledger.recordAutoRecovery(fp, 'action-1', { at: AT });
    ledger.noteNewEvidence(fp, 'evidence-1');
    ledger.recordAutoRecovery(fp, 'action-2', { at: AT });
    expect(ledger.recoveryCount(fp)).toBe(1);
    expect(ledger.totalRecoveryCount(fp)).toBe(2);
    expect(ledger.actionDigestsOf(fp)).toHaveLength(2);
  });
});

describe('账本快照（证据；确定性）', () => {
  it('两次快照内容一致，重复调用不产生漂移', () => {
    const ledger = new RecoveryLedger();
    const fp = fingerprint();
    ledger.recordAutoRecovery(fp, 'action-1', { at: AT });
    ledger.noteNewEvidence(fp, 'evidence-1');
    const first = JSON.stringify(ledger.snapshot());
    const second = JSON.stringify(ledger.snapshot());
    expect(first).toBe(second);
    const snapshot = ledger.snapshot();
    expect(snapshot.max_allowed).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.active_recovery_count).toBe(0);
    expect(snapshot.entries[0]?.total_recovery_count).toBe(1);
    expect(snapshot.entries[0]?.last_evidence_ref).toBe('evidence-1');
  });

  it('指纹由工作项集合算出时（A05 主场景）账本照常工作', () => {
    const fp = fingerprintOfBlockedItems([
      wiForFingerprint('req-a05-A', ['req-a05-B']),
      wiForFingerprint('req-a05-B', ['req-a05-A']),
    ]);
    const ledger = new RecoveryLedger();
    expect(fp).not.toBeNull();
    ledger.recordAutoRecovery(fp, 'action-1', { at: AT });
    expect(ledger.canAutoRecover(fp, 'action-2').reason).toBe('already_recovered');
  });
});

describe('受控缺陷注入（R7）：I-A05-3「反复恢复」', () => {
  it('正确实现下第二次被拒；把上限放开（缺陷）后同一断言真会失败', () => {
    const fp = fingerprint();

    const honest = new RecoveryLedger();
    honest.recordAutoRecovery(fp, 'action-1', { at: AT });
    const honestSecond = honest.canAutoRecover(fp, 'action-2');
    expect(honestSecond.allowed).toBe(false);

    // 缺陷实现：上限极大 ⇒ "自动恢复次数 ≤ 1" 的断言会被击穿
    const defective = new RecoveryLedger(Number.MAX_SAFE_INTEGER);
    defective.recordAutoRecovery(fp, 'action-1', { at: AT });
    let allowedTwice = 0;
    for (let i = 0; i < 5; i += 1) {
      if (defective.canAutoRecover(fp, `action-${i + 2}`).allowed) {
        defective.recordAutoRecovery(fp, `action-${i + 2}`, { at: AT });
        allowedTwice += 1;
      }
    }
    expect(allowedTwice).toBe(5);
    expect(defective.recoveryCount(fp)).toBe(6);
    expect(honest.recoveryCount(fp)).toBe(1);
  });
});
