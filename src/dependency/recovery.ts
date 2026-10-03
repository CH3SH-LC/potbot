/**
 * **自动恢复的"最多一次"账本**（合同 §九-7 / Q9-b；任务书 §10）。
 *
 * 冻结语义：**同任务版本、同阻塞指纹、无新证据时，最多一次自动恢复**。
 * 本文件把这句话做成可判定的账本：
 *
 * - 键 = 阻塞指纹的规范化串（`BlockingFingerprint.key`，已含任务版本）；
 * - 记满 `MAX_AUTO_RECOVERY_PER_FINGERPRINT`（=1，protocol 常量）次后，`canAutoRecover()` 转为拒绝；
 * - **同一恢复动作不得重复**（A05-10）：动作摘要一旦出现即永久记录，即使有新证据也不清除；
 * - **新证据**（带非空证据引用、且与上次不同）才重置计数——"无新证据"是拒绝的条件，
 *   不是"定时重试"的理由（A05-11 反作弊：不得靠定时互相唤醒维持活跃）。
 *
 * 本文件是纯内存账本：无 I/O、无时钟（时刻由调用方传入）、无真实 sleep。
 */

import { MAX_AUTO_RECOVERY_PER_FINGERPRINT, type LogicalTime } from '../protocol/index.js';
import { canonicalDigest } from './digest.js';
import { DependencyError } from './errors.js';
import type { BlockingFingerprint } from './fingerprint.js';

/** 拒绝自动恢复的原因。 */
export const RECOVERY_REFUSAL_REASONS = [
  'no_fingerprint', // 没有阻塞指纹（无阻塞项）⇒ 无从判定"同版同阻塞"
  'duplicate_action', // 同一恢复动作已经做过（A05-10）
  'already_recovered', // 同指纹的自动恢复已达上限（§九-7 / A05-09）
] as const;

export type RecoveryRefusalReason = (typeof RECOVERY_REFUSAL_REASONS)[number];

export const RECOVERY_REFUSAL_LABELS: Readonly<Record<RecoveryRefusalReason, string>> = {
  no_fingerprint: '没有阻塞指纹，无从判定自动恢复',
  duplicate_action: '同一恢复动作已执行过，不得重复',
  already_recovered: '同版同阻塞指纹的自动恢复已达上限',
};

export class RecoveryRefusedError extends DependencyError {
  readonly reason: RecoveryRefusalReason;

  constructor(reason: RecoveryRefusalReason, message: string) {
    super(message);
    this.name = 'RecoveryRefusedError';
    this.reason = reason;
  }
}

/** 一次已执行的自动恢复（证据）。 */
export interface AutoRecoveryRecord {
  readonly fingerprint_key: string;
  readonly fingerprint_digest: string;
  readonly action_digest: string;
  readonly action: string;
  readonly at: LogicalTime;
  readonly evidence_ref: string | null;
}

/** 判定结果（**纯判定，不抛错**）。 */
export interface AutoRecoveryDecision {
  readonly allowed: boolean;
  readonly reason: RecoveryRefusalReason | null;
  readonly detail: string;
  /** 该指纹**当前计费周期内**已发生的自动恢复次数。 */
  readonly recovery_count: number;
  /** 上限（protocol 常量 `MAX_AUTO_RECOVERY_PER_FINGERPRINT`）。 */
  readonly max_allowed: number;
  /** 本次尝试的恢复动作摘要。 */
  readonly action_digest: string;
}

export interface AutoRecoveryLedgerEntry {
  readonly fingerprint_key: string;
  readonly fingerprint_digest: string;
  readonly active_recovery_count: number;
  readonly total_recovery_count: number;
  readonly action_digests: readonly string[];
  readonly last_evidence_ref: string | null;
}

export interface RecoveryLedgerSnapshot {
  readonly max_allowed: number;
  readonly entries: readonly AutoRecoveryLedgerEntry[];
  readonly records: readonly AutoRecoveryRecord[];
}

export interface RecordAutoRecoveryOptions {
  readonly at: LogicalTime;
  /** 触发本次恢复的**新证据**引用（无新证据时省略）。 */
  readonly evidence_ref?: string | null;
}

/**
 * 自动恢复账本。
 *
 * 用法（D09 的 A05 夹具）：
 * ```ts
 * const ledger = new RecoveryLedger();
 * const decision = ledger.canAutoRecover(fingerprint, 'requeue-missing-request');
 * if (decision.allowed) ledger.recordAutoRecovery(fingerprint, 'requeue-missing-request', { at });
 * ```
 */
export class RecoveryLedger {
  readonly #maxAllowed: number;
  readonly #records: AutoRecoveryRecord[] = [];
  readonly #actionDigests = new Map<string, Set<string>>();
  readonly #activeCount = new Map<string, number>();
  readonly #lastEvidence = new Map<string, string>();

  constructor(maxAllowed: number = MAX_AUTO_RECOVERY_PER_FINGERPRINT) {
    if (!Number.isInteger(maxAllowed) || maxAllowed < 0) {
      throw new DependencyError(
        `自动恢复上限必须是非负整数，收到 ${String(maxAllowed)}（默认取 protocol 的 MAX_AUTO_RECOVERY_PER_FINGERPRINT）`,
      );
    }
    this.#maxAllowed = maxAllowed;
  }

  /** 上限（同版同阻塞指纹；默认 1）。 */
  get maxAllowed(): number {
    return this.#maxAllowed;
  }

  /** 该指纹在当前计费周期内已自动恢复的次数。 */
  recoveryCount(fingerprint: BlockingFingerprint | null | undefined): number {
    if (fingerprint === null || fingerprint === undefined) {
      return 0;
    }
    return this.#activeCount.get(fingerprint.key) ?? 0;
  }

  /** 该指纹总共自动恢复过多少次（跨"新证据"重置，累计）。 */
  totalRecoveryCount(fingerprint: BlockingFingerprint | null | undefined): number {
    if (fingerprint === null || fingerprint === undefined) {
      return 0;
    }
    return this.#records.filter((record) => record.fingerprint_key === fingerprint.key).length;
  }

  /** 判定能否再做一次自动恢复（**不修改状态、不抛错**）。 */
  canAutoRecover(
    fingerprint: BlockingFingerprint | null | undefined,
    action: string,
  ): AutoRecoveryDecision {
    const actionDigest = canonicalDigest(action);
    if (fingerprint === null || fingerprint === undefined) {
      return {
        allowed: false,
        reason: 'no_fingerprint',
        detail: '没有阻塞指纹（当前无阻塞项），无从判定"同版同阻塞指纹"',
        recovery_count: 0,
        max_allowed: this.#maxAllowed,
        action_digest: actionDigest,
      };
    }

    const count = this.#activeCount.get(fingerprint.key) ?? 0;
    const seen = this.#actionDigests.get(fingerprint.key);

    if (seen !== undefined && seen.has(actionDigest)) {
      return {
        allowed: false,
        reason: 'duplicate_action',
        detail: `恢复动作「${action}」已在指纹 ${fingerprint.key} 上执行过，不得重复（A05-10）`,
        recovery_count: count,
        max_allowed: this.#maxAllowed,
        action_digest: actionDigest,
      };
    }

    if (count >= this.#maxAllowed) {
      return {
        allowed: false,
        reason: 'already_recovered',
        detail:
          `指纹 ${fingerprint.key} 已自动恢复 ${count} 次（上限 ${this.#maxAllowed}），` +
          `无新证据时不得再次自动恢复（§九-7 / A05-09）`,
        recovery_count: count,
        max_allowed: this.#maxAllowed,
        action_digest: actionDigest,
      };
    }

    return {
      allowed: true,
      reason: null,
      detail: `允许自动恢复「${action}」（本指纹已用 ${count}/${this.#maxAllowed}）`,
      recovery_count: count,
      max_allowed: this.#maxAllowed,
      action_digest: actionDigest,
    };
  }

  /**
   * 记录一次自动恢复。**不允许时抛 `RecoveryRefusedError`**（`evaluate / apply` 两分法，
   * 与 D04 的 `evaluateWorkItemTransition` / `applyWorkItemTransition` 同构）。
   */
  recordAutoRecovery(
    fingerprint: BlockingFingerprint | null | undefined,
    action: string,
    options: RecordAutoRecoveryOptions,
  ): AutoRecoveryRecord {
    const decision = this.canAutoRecover(fingerprint, action);
    if (!decision.allowed || fingerprint === null || fingerprint === undefined) {
      throw new RecoveryRefusedError(
        decision.reason ?? 'no_fingerprint',
        `自动恢复被拒绝：${decision.detail}`,
      );
    }

    const evidenceRef = options.evidence_ref ?? null;
    const record: AutoRecoveryRecord = Object.freeze({
      fingerprint_key: fingerprint.key,
      fingerprint_digest: fingerprint.digest,
      action_digest: decision.action_digest,
      action,
      at: options.at,
      evidence_ref: evidenceRef,
    });
    this.#records.push(record);

    const seen = this.#actionDigests.get(fingerprint.key) ?? new Set<string>();
    seen.add(decision.action_digest);
    this.#actionDigests.set(fingerprint.key, seen);
    this.#activeCount.set(fingerprint.key, (this.#activeCount.get(fingerprint.key) ?? 0) + 1);

    return record;
  }

  /**
   * 登记**新证据**。只有"非空且与上次不同"的证据引用才算新证据（返回 `true`），
   * 此时该指纹的计费周期重置（可再做至多一次自动恢复）。
   *
   * **动作去重不重置**：同一恢复动作在任何情况下都不得重复（A05-10）。
   */
  noteNewEvidence(fingerprint: BlockingFingerprint | string, evidenceRef: string): boolean {
    const key = typeof fingerprint === 'string' ? fingerprint : fingerprint.key;
    const ref = evidenceRef.trim();
    if (ref.length === 0) {
      throw new DependencyError(
        '新证据必须带非空引用：空引用视为"无新证据"，不得据此重置自动恢复上限（§九-7）',
      );
    }
    if (this.#lastEvidence.get(key) === ref) {
      return false;
    }
    this.#lastEvidence.set(key, ref);
    this.#activeCount.set(key, 0);
    return true;
  }

  /** 该指纹记录过的恢复动作摘要（升序）。 */
  actionDigestsOf(fingerprint: BlockingFingerprint | null | undefined): readonly string[] {
    if (fingerprint === null || fingerprint === undefined) {
      return Object.freeze([]);
    }
    return Object.freeze([...(this.#actionDigests.get(fingerprint.key) ?? [])].sort());
  }

  /** 账本快照（证据输出；确定性，无时间戳）。 */
  snapshot(): RecoveryLedgerSnapshot {
    const keys = [...new Set([...this.#activeCount.keys(), ...this.#actionDigests.keys()])].sort();
    const entries: AutoRecoveryLedgerEntry[] = keys.map((key) => {
      const records = this.#records.filter((record) => record.fingerprint_key === key);
      return {
        fingerprint_key: key,
        fingerprint_digest: canonicalDigest(key),
        active_recovery_count: this.#activeCount.get(key) ?? 0,
        total_recovery_count: records.length,
        action_digests: [...(this.#actionDigests.get(key) ?? [])].sort(),
        last_evidence_ref: this.#lastEvidence.get(key) ?? null,
      };
    });
    return {
      max_allowed: this.#maxAllowed,
      entries,
      records: [...this.#records],
    };
  }
}
