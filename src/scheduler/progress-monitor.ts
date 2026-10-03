/**
 * **无进展检测、依赖循环与有限分身诊断**（KRN-11；R25.1–R25.4、R44.1、§九-7、Q9-b）。
 *
 * ## 这一件修的是什么
 *
 * 三个"看起来在干活、其实什么都没发生"的失效模式：
 * 1. **无进展空转**——每一轮都在跑，但阻塞指纹一字不变；
 * 2. **依赖循环**——A 等 B、B 等 A，两边都"还在处理中"；
 * 3. **分身失控**——"再开一个智能体试试"没有上限，越试越多。
 *
 * 以及两个"过度反应"的失效模式（KRN-11 要求同阻塞无新证据时**不要**做）：
 * 4. **无限唤醒**——同一个阻塞，反复定时唤醒、反复重新规划；
 * 5. **占着执行槽等**——明明在等用户 / 等外部条件，却不让出执行槽。
 *
 * ## 判定归 D05，本模块只做"编排与纪律"
 *
 * 循环、等待类别、指纹、有限恢复的判定实现全在 `src/dependency/`：
 * - `diagnoseStagnation()` —— 判定阶梯（预算超限 / 环 / 不可满足 / 可推进 / 正常等待）；
 * - `BlockingFingerprint` —— Q9-b 的 (版本, 阻塞项集, 原因类别集, 依赖集) 四元组；
 * - `RecoveryLedger` —— "同版同阻塞指纹在同一新证据周期内最多一次自动恢复"。
 *
 * 本模块**不重写任何一条判定**：`observe()` 返回的就是 D05 的 `StagnationDiagnosis`，
 * 唤醒 / 重规划的许可直接委托 `RecoveryLedger`。
 *
 * ## 两条纪律的落点
 *
 * - **有实际等待就让出资源**：`disposition !== 'continue'` ⇒ `release_resources === true`，
 *   并把 D05 给出的 `releasable_instance_ids` 原样带出（等待期间不得占用执行槽）。
 * - **同阻塞无新证据不无限唤醒 / 不无限重新规划**：许可来自 `RecoveryLedger`。
 *   唤醒与重规划**都是"自动恢复动作"**，因此在同一指纹、同一计费周期里**共用同一个额度**
 *   （§九-7 的原文是"最多进行**一次**自动恢复"——一次，不是每类一次）。
 *   旧额度的唯一解药是**新证据**（`noteNewEvidence` 的非空且与上次不同的引用），
 *   它开一个新的计费周期；没有新证据，唤醒与重规划都会在第一次之后被拒。
 *   另外，同一动作（同指纹 + 同证据）在任何情况下都不得重复（A05-10 的动作去重）。
 *
 * ## 分身（fork）
 *
 * 分身**计数**在本对象的会话内维护：`spawnFork()` 有硬上限与"同一目的不得重复分身"两条判据。
 * **诚实边界**：分身计数**不跨进程 / 不跨重启**——重启后计数归零。这一条**未实现**，
 * 因此也不宣称。若需要跨重启的硬上限，须把计数落到持久介质（本模块未做）。
 */

import {
  RecoveryLedger,
  diagnoseStagnation,
  type BlockingFingerprint,
  type DependencyCycle,
  type DiagnosisBudget,
  type DiagnosisDefectOptions,
  type StagnationDiagnosis,
  type StagnationVerdict,
  type StopDisposition,
} from '../dependency/index.js';
import type {
  InstanceId,
  LogicalTime,
  RequestId,
  Revision,
  TaskId,
  WorkItem,
} from '../protocol/index.js';
import type { StagnationBudgetLedger } from './stagnation.js';

/** 默认的有限分身上限（"再开一个试试"最多到这个数）。 */
export const DEFAULT_MAX_FORKS = 4;

/**
 * 两种自动恢复动作：唤醒 / 重规划。
 *
 * 它们是**两个不同的动作**（动作去重按动作摘要分别计算），但**共用**同一指纹、
 * 同一计费周期里的**一个**额度（§九-7「最多进行一次自动恢复」）。
 */
export const PROGRESS_ACTIONS = ['wake', 'replan'] as const;
export type ProgressAction = (typeof PROGRESS_ACTIONS)[number];

// ---------------------------------------------------------------------------
// 观测
// ---------------------------------------------------------------------------

export interface ProgressObservationInput {
  readonly items: readonly WorkItem[];
  readonly now: LogicalTime;
  /** 任务作用域（R37.2：只诊断当前任务 / 当前版本的项）。 */
  readonly task_id?: TaskId | null;
  readonly task_revision?: Revision | null;
  /** 调用方判定的"当前有可运行输入的实例"。 */
  readonly runnable_instance_ids?: readonly InstanceId[];
  /**
   * **新证据**引用（非空且与上次不同才算新证据）。
   * 它是"允许再自动恢复一次"的唯一凭据（§九-7）。
   */
  readonly evidence_ref?: string | null;
  /** 受控缺陷注入（默认关闭，仅在隔离测试里打开）。 */
  readonly defects?: DiagnosisDefectOptions;
}

export interface ProgressReport {
  /** 相对**上一次观测**是否有进展（阻塞指纹变化、可推进、或出现新证据）。 */
  readonly progressed: boolean;
  readonly verdict: StagnationVerdict;
  readonly disposition: StopDisposition;
  /** `disposition !== 'continue'` ⇒ 有实际等待，必须让出执行槽。 */
  readonly release_resources: boolean;
  /** 让出执行槽的实例（D05 原样给出，不另算一套）。 */
  readonly releasable_instance_ids: readonly InstanceId[];
  readonly blocked_request_ids: readonly RequestId[];
  readonly cycles: readonly DependencyCycle[];
  readonly cycle_descriptions: readonly string[];
  readonly fingerprint_key: string | null;
  readonly fingerprint_digest: string | null;
  /** 同一阻塞指纹重复出现且**本次没有新证据**（无进展空转的形状）。 */
  readonly repeated_block_without_evidence: boolean;
  /** 本次是否登记了新证据（`noteNewEvidence` 返回 true）。 */
  readonly new_evidence: boolean;
  /** 有实际等待 ⇒ 不建议唤醒（也不建议重新规划）。 */
  readonly should_wake: boolean;
  /** D05 的完整诊断（判定权在 D05，本报告只是它的投影 + 编排字段）。 */
  readonly diagnosis: StagnationDiagnosis;
}

// ---------------------------------------------------------------------------
// 唤醒 / 重规划的许可
// ---------------------------------------------------------------------------

export const WAKE_REFUSAL_REASONS = [
  /** 当前没有阻塞指纹（没有阻塞就没有"同阻塞"可谈）。 */
  'no_blocking',
  /** 有实际等待：应当让出资源，而不是唤醒（KRN-11）。 */
  'real_wait',
  /** 同指纹在本计费周期内已自动恢复过（且本次没有新证据）。 */
  'already_recovered',
  /** 同一动作在该指纹下已执行过（换了动作摘要才行）。 */
  'duplicate_action',
] as const;
export type WakeRefusalReason = (typeof WAKE_REFUSAL_REASONS)[number];

export interface WakeDecision {
  readonly allowed: boolean;
  readonly action: ProgressAction;
  readonly reason: 'allowed' | WakeRefusalReason;
  readonly detail: string;
  readonly recovery_count: number;
  readonly max_allowed: number;
  readonly fingerprint_key: string | null;
}

// ---------------------------------------------------------------------------
// 分身
// ---------------------------------------------------------------------------

export interface ForkRecord {
  readonly fork_id: string;
  readonly purpose: string;
  readonly parent_instance_id: InstanceId | null;
  readonly at: LogicalTime;
}

export const FORK_REFUSAL_REASONS = [
  /** 达到有限分身上限（KRN-11：分身必须有硬上限）。 */
  'fork_cap_reached',
  /** 同一目的已经有活着的分身（不得重复分身去撞同一件事）。 */
  'duplicate_purpose',
  /** 目的为空：没有说清"这个分身去干什么"，不得开。 */
  'purpose_required',
] as const;
export type ForkRefusalReason = (typeof FORK_REFUSAL_REASONS)[number];

export interface ForkDecision {
  readonly allowed: boolean;
  readonly reason: 'spawned' | ForkRefusalReason;
  readonly active_forks: number;
  readonly max_forks: number;
  readonly fork: ForkRecord | null;
}

// ---------------------------------------------------------------------------
// 监控器
// ---------------------------------------------------------------------------

export interface ProgressMonitorOptions {
  /** **执行前登记**的预算上限（省略 ⇒ `observe()` 抛 `DiagnosisBudgetError`，不静默取默认）。 */
  readonly budget: DiagnosisBudget;
  /** 预算台账（D06 的 `BudgetLedger` 结构兼容）。不给 ⇒ 用量按 0 计。 */
  readonly ledger?: StagnationBudgetLedger | null;
  /** 有限分身上限（默认 `DEFAULT_MAX_FORKS`）。 */
  readonly max_forks?: number;
  /** 有限恢复账本（省略则自建一个，上限取 protocol 常量）。 */
  readonly recovery_ledger?: RecoveryLedger;
}

export interface ProgressMonitorSnapshot {
  readonly last_fingerprint_key: string | null;
  readonly last_evidence_ref: string | null;
  readonly observations: number;
  readonly active_forks: readonly ForkRecord[];
  readonly max_forks: number;
}

export class ProgressMonitor {
  readonly #options: ProgressMonitorOptions;
  readonly #recovery: RecoveryLedger;
  readonly #maxForks: number;
  readonly #forks = new Map<string, ForkRecord>();
  #lastFingerprintKey: string | null = null;
  #lastEvidenceRef: string | null = null;
  #observations = 0;
  #forkSeq = 0;

  constructor(options: ProgressMonitorOptions) {
    this.#options = options;
    this.#recovery = options.recovery_ledger ?? new RecoveryLedger();
    this.#maxForks = options.max_forks ?? DEFAULT_MAX_FORKS;
    if (!Number.isInteger(this.#maxForks) || this.#maxForks < 0) {
      throw new RangeError(`有限分身上限必须是非负整数，收到 ${String(this.#maxForks)}（KRN-11）`);
    }
  }

  get recoveryLedger(): RecoveryLedger {
    return this.#recovery;
  }

  get maxForks(): number {
    return this.#maxForks;
  }

  /**
   * 观测一次：跑 D05 的停滞诊断，并给出编排层的三个判断
   * （有无进展 / 是否让出资源 / 是否该唤醒）。
   */
  observe(input: ProgressObservationInput): ProgressReport {
    const ledger = this.#options.ledger ?? null;
    const usage = {
      runs: ledger === null ? 0 : ledger.used('runs'),
      diagnoses: ledger === null ? 0 : ledger.used('diagnoses'),
      time: ledger === null ? 0 : ledger.used('time'),
    };

    const diagnosis = diagnoseStagnation({
      items: input.items,
      budget: this.#options.budget,
      usage,
      now: input.now,
      scope: { task_id: input.task_id ?? null, task_revision: input.task_revision ?? null },
      ...(input.runnable_instance_ids === undefined
        ? {}
        : { runnable_instance_ids: input.runnable_instance_ids }),
      ...(input.defects === undefined ? {} : { defects: input.defects }),
    });

    const fingerprint = diagnosis.fingerprint;
    const key = fingerprint === null ? null : fingerprint.key;

    // 新证据：只认"非空且与上次不同"的引用（空引用视为无新证据，与 RecoveryLedger 同一纪律）。
    const evidenceRef = input.evidence_ref ?? null;
    const newEvidence =
      evidenceRef !== null &&
      evidenceRef.trim().length > 0 &&
      evidenceRef !== this.#lastEvidenceRef;
    if (newEvidence && fingerprint !== null) {
      this.#recovery.noteNewEvidence(fingerprint, evidenceRef);
      this.#lastEvidenceRef = evidenceRef;
    }

    const repeatedBlock =
      key !== null && this.#lastFingerprintKey !== null && key === this.#lastFingerprintKey && !newEvidence;
    const progressed =
      key === null || this.#lastFingerprintKey === null
        ? diagnosis.disposition === 'continue' || key === null
        : key !== this.#lastFingerprintKey || newEvidence || diagnosis.disposition === 'continue';

    this.#lastFingerprintKey = key;
    this.#observations += 1;

    const releaseResources = diagnosis.disposition !== 'continue';
    return Object.freeze({
      progressed,
      verdict: diagnosis.verdict,
      disposition: diagnosis.disposition,
      release_resources: releaseResources,
      releasable_instance_ids: diagnosis.releasable_instance_ids,
      blocked_request_ids: diagnosis.blocked_request_ids,
      cycles: diagnosis.cycles,
      cycle_descriptions: diagnosis.cycle_descriptions,
      fingerprint_key: key,
      fingerprint_digest: fingerprint === null ? null : fingerprint.digest,
      repeated_block_without_evidence: repeatedBlock,
      new_evidence: newEvidence,
      // 有实际等待 ⇒ 不唤醒（有活干的时候才谈唤醒）。
      should_wake: !releaseResources,
      diagnosis,
    });
  }

  /**
   * 请求唤醒（"再跑一轮"）。许可来自 `RecoveryLedger`：
   * 同版同阻塞指纹在**同一新证据周期内最多一次**；同一次的证据不会让第二次唤醒通过
   * （动作摘要含证据引用 ⇒ 新证据是新动作）。
   */
  requestWake(fingerprint: BlockingFingerprint | null, input: {
    readonly at: LogicalTime;
    readonly has_real_wait?: boolean;
  }): WakeDecision {
    return this.#decide('wake', fingerprint, input.at, input.has_real_wait === true);
  }

  /**
   * 请求重新规划。与唤醒**共用**同一指纹、同一计费周期的额度
   * （§九-7：最多进行一次自动恢复——一次，不是每类一次）。
   * 额度用尽后唯一的解药是**新证据**。
   */
  requestReplan(fingerprint: BlockingFingerprint | null, input: {
    readonly at: LogicalTime;
    readonly has_real_wait?: boolean;
  }): WakeDecision {
    return this.#decide('replan', fingerprint, input.at, input.has_real_wait === true);
  }

  /** 开一个有限分身（有上限、同目的不重复、目的必填）。 */
  spawnFork(input: {
    readonly purpose: string;
    readonly at: LogicalTime;
    readonly parent_instance_id?: InstanceId | null;
  }): ForkDecision {
    const purpose = input.purpose.trim();
    if (purpose.length === 0) {
      return this.#forkRefused('purpose_required');
    }
    if ([...this.#forks.values()].some((fork) => fork.purpose === purpose)) {
      return this.#forkRefused('duplicate_purpose');
    }
    if (this.#forks.size >= this.#maxForks) {
      return this.#forkRefused('fork_cap_reached');
    }
    this.#forkSeq += 1;
    const fork: ForkRecord = Object.freeze({
      fork_id: `fork-${String(this.#forkSeq)}`,
      purpose,
      parent_instance_id: input.parent_instance_id ?? null,
      at: input.at,
    });
    this.#forks.set(fork.fork_id, fork);
    return Object.freeze({
      allowed: true,
      reason: 'spawned' as const,
      active_forks: this.#forks.size,
      max_forks: this.#maxForks,
      fork,
    });
  }

  /** 分身结束（释放名额；不结束的话名额不会自己回来）。 */
  releaseFork(forkId: string): boolean {
    return this.#forks.delete(forkId);
  }

  /** 当前活着的分身（升序）。 */
  activeForks(): readonly ForkRecord[] {
    return Object.freeze(
      [...this.#forks.values()].sort((a, b) => (a.fork_id < b.fork_id ? -1 : 1)),
    );
  }

  snapshot(): ProgressMonitorSnapshot {
    return Object.freeze({
      last_fingerprint_key: this.#lastFingerprintKey,
      last_evidence_ref: this.#lastEvidenceRef,
      observations: this.#observations,
      active_forks: this.activeForks(),
      max_forks: this.#maxForks,
    });
  }

  #decide(
    action: ProgressAction,
    fingerprint: BlockingFingerprint | null,
    at: LogicalTime,
    hasRealWait: boolean,
  ): WakeDecision {
    if (fingerprint === null) {
      return this.#wakeRefused(action, 'no_blocking', '当前没有阻塞指纹，无从谈"同阻塞"', fingerprint);
    }
    if (hasRealWait) {
      return this.#wakeRefused(
        action,
        'real_wait',
        '存在实际等待（等用户 / 等外部条件）：应当让出资源，而不是唤醒或重新规划（KRN-11）',
        fingerprint,
      );
    }
    // 动作摘要含证据引用：**新证据 ⇒ 新动作**，因此新证据下的再一次自动恢复是允许的。
    const actionKey = `${action}:${this.#lastEvidenceRef ?? 'no-evidence'}`;
    const decision = this.#recovery.canAutoRecover(fingerprint, actionKey);
    if (!decision.allowed) {
      const reason: WakeRefusalReason =
        decision.reason === 'duplicate_action'
          ? 'duplicate_action'
          : decision.reason === 'no_fingerprint'
            ? 'no_blocking'
            : 'already_recovered';
      return Object.freeze({
        allowed: false,
        action,
        reason,
        detail: decision.detail,
        recovery_count: decision.recovery_count,
        max_allowed: decision.max_allowed,
        fingerprint_key: fingerprint.key,
      });
    }
    this.#recovery.recordAutoRecovery(fingerprint, actionKey, {
      at,
      evidence_ref: this.#lastEvidenceRef,
    });
    return Object.freeze({
      allowed: true,
      action,
      reason: 'allowed' as const,
      detail: `允许${action === 'wake' ? '唤醒' : '重新规划'}（本指纹已用 ${String(decision.recovery_count)}/${String(decision.max_allowed)}）`,
      recovery_count: decision.recovery_count + 1,
      max_allowed: decision.max_allowed,
      fingerprint_key: fingerprint.key,
    });
  }

  #wakeRefused(
    action: ProgressAction,
    reason: WakeRefusalReason,
    detail: string,
    fingerprint: BlockingFingerprint | null,
  ): WakeDecision {
    const decision = this.#recovery.canAutoRecover(fingerprint, `${action}:probe`);
    return Object.freeze({
      allowed: false,
      action,
      reason,
      detail,
      recovery_count: decision.recovery_count,
      max_allowed: decision.max_allowed,
      fingerprint_key: fingerprint === null ? null : fingerprint.key,
    });
  }

  #forkRefused(reason: ForkRefusalReason): ForkDecision {
    return Object.freeze({
      allowed: false,
      reason,
      active_forks: this.#forks.size,
      max_forks: this.#maxForks,
      fork: null,
    });
  }
}

/** 便捷构造。 */
export function createProgressMonitor(options: ProgressMonitorOptions): ProgressMonitor {
  return new ProgressMonitor(options);
}

/** 证据可读性：把一次观测压成一行。 */
export function describeProgress(report: ProgressReport): string {
  return (
    `${report.verdict}/${report.disposition}` +
    `，有进展=${String(report.progressed)}` +
    `，让出资源=${String(report.release_resources)}` +
    `，环=${String(report.cycles.length)}` +
    `，指纹=${report.fingerprint_digest === null ? '无' : report.fingerprint_digest.slice(0, 12)}`
  );
}
