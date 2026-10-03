/**
 * 手机内核日志库 —— **日志结构内核库**：恢复、崩溃注入装配（零依赖）。
 *
 * ## 三层分离（这是"能注入崩溃"的关键）
 *
 * | 层 | 是什么 | 崩溃时发生什么 |
 * | --- | --- | --- |
 * | `Media`（见 `media.ts`） | 介质抽象：`append` 写脏、`sync` 落盘、`syncPrefix` 落一半（撕裂） | 只有已 sync 的字节存活 |
 * | `recoverJournal(bytes)` | 纯函数：字节 → 派生状态 + 恢复报告 | 撕裂尾部整段丢弃 |
 * | `KernelJournalStore` | 进程内的库句柄 | instance 被丢弃即为"进程死了" |
 *
 * "杀进程"= 让 `KernelJournalStore` 在一次写入的某个注入点抛错，然后**扔掉这个实例**；
 * "重启"= 用同一块 `Media` 构造新实例。因为所有持久状态都在 `Media` 里，实例丢弃
 * 与真实进程被杀在**可观测语义上等价**——这正是本 harness 能用（内存或存储）介质做真实
 * 断言的原因。
 *
 * ## 提交路径没有隐藏状态
 *
 * 写入一条帧的全部副作用都在 `#commit` 里，注入点前后只有 `media.append` 与
 * `media.sync/syncPrefix` 两步。复核者只需读这一个方法，即可确认"没有在注入点之外悄悄改
 * 持久状态"。副作用落地后 `applyFrameToState(frame)` 才改内存派生状态——但崩溃时该实例被
 * 丢弃，内存状态无所谓；重启后一律从 `Media` 字节重建。
 */

import { KernelJournalError } from './errors.js';
import { decodeFrames, encodeFrame } from './framing.js';
import type { Media } from './media.js';
import { applyFrameToState, buildChain, createInitialState } from './migration.js';
import {
  LATEST_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type Frame,
  type GetResult,
  type LedgerState,
  type MigrateResult,
  type MigrateStepDescriptor,
  type PutResult,
  type DeleteResult,
  type Recovery,
} from './schemas.js';

// ---------------------------------------------------------------------------
// 恢复（纯函数）
// ---------------------------------------------------------------------------

export interface RecoveredJournal {
  readonly recovery: Recovery;
  readonly state: LedgerState;
}

/**
 * 从持久字节重建派生状态。遇到第一条不完整 / 损坏的帧即止，其后**整段丢弃**。
 * 若日志里出现比本书面更新的 schema 版本或缺失的迁移步骤，**抛错**（不得静默丢数据）。
 */
export function recoverJournal(bytes: Uint8Array): RecoveredJournal {
  const decoded = decodeFrames(bytes);
  const state = createInitialState();
  let lastSeq = 0;
  for (const frame of decoded.frames) {
    applyFrameToState(state, frame);
    if (frame.seq > lastSeq) lastSeq = frame.seq;
  }
  const recovery: Recovery = {
    schemaVersion: state.schemaVersion,
    framesApplied: decoded.frames.length,
    durableBytes: bytes.length,
    validBytes: decoded.validBytes,
    discardedBytes: decoded.discardedBytes,
    discardedReason: decoded.discardedReason,
    lastSeq,
    entryCount: state.entries.size,
  };
  return { recovery, state };
}

// ---------------------------------------------------------------------------
// 崩溃注入钩子
// ---------------------------------------------------------------------------

/** 崩溃注入钩子。任一处抛错即视为"进程在此刻被杀"。 */
export interface KillHooks {
  readonly beforeAppend?: (frame: Frame, encoded: Uint8Array) => void;
  readonly afterAppend?: (frame: Frame, encoded: Uint8Array) => void;
  readonly beforeSync?: (frame: Frame, encoded: Uint8Array) => void;
  /** 返回一个字节数 ⇒ 只落这么多（撕裂写）；返回 undefined ⇒ 正常整帧落盘。 */
  readonly partialSync?: (frame: Frame, encoded: Uint8Array) => number | undefined;
  readonly afterSync?: (frame: Frame, encoded: Uint8Array) => void;
}

export interface OpenOptions {
  readonly media: Media;
  readonly kill?: KillHooks;
}

// ---------------------------------------------------------------------------
// 库句柄
// ---------------------------------------------------------------------------

export class KernelJournalStore {
  readonly #media: Media;
  readonly #kill: KillHooks | undefined;
  readonly #recovery: Recovery;
  #state: LedgerState;
  #lastSeq: number;

  private constructor(options: OpenOptions, recovered: RecoveredJournal) {
    this.#media = options.media;
    this.#kill = options.kill;
    this.#recovery = recovered.recovery;
    this.#state = recovered.state;
    this.#lastSeq = recovered.recovery.lastSeq;
    // 丢弃撕裂尾部：让后续追加从最后一条合法帧的末尾继续，而不是接在垃圾后面。
    this.#media.truncateTo(recovered.recovery.validBytes);
  }

  /** 打开（或重启后重开）库。内部先恢复，再对齐介质长度。 */
  static open(options: OpenOptions): KernelJournalStore {
    const recovered = recoverJournal(options.media.durable());
    return new KernelJournalStore(options, recovered);
  }

  /** 本次打开时的恢复报告（重启证据）。 */
  get recovery(): Recovery {
    return this.#recovery;
  }

  get schemaVersion(): number {
    return this.#state.schemaVersion;
  }

  get revision(): number {
    return this.#lastSeq;
  }

  entries(): ReadonlyMap<string, { key: string; value: string; updatedAt?: number; tags?: string[] }> {
    return this.#state.entries;
  }

  get(key: string): GetResult {
    const entry = this.#state.entries.get(key);
    if (entry === undefined) {
      return { operation: 'get', status: 'not-found', entry: null };
    }
    return { operation: 'get', status: 'ok', entry: { ...entry } };
  }

  put(key: string, value: string, extra: { updatedAt?: number; tags?: readonly string[] } = {}): PutResult {
    if (typeof key !== 'string' || key.length === 0) {
      throw new KernelJournalError('invalid_put_payload', 'put 的 key 必须是非空字符串', String(key));
    }
    if (typeof value !== 'string') {
      throw new KernelJournalError('invalid_put_payload', 'put 的 value 必须是字符串', key);
    }
    const seq = this.#nextSeq();
    const payload = {
      key,
      value,
      ...(extra.updatedAt === undefined ? {} : { updatedAt: extra.updatedAt }),
      ...(extra.tags === undefined ? {} : { tags: [...extra.tags] }),
    };
    const frame: Frame = { kind: 'put', seq, payload };
    this.#commit(frame);
    return { operation: 'put', status: 'ok', key, seq };
  }

  delete(key: string): DeleteResult {
    if (!this.#state.entries.has(key)) {
      // 删不存在的键 = 领域无操作，不写日志（写一条空 delete 只会白占日志）。
      return { operation: 'delete', status: 'not-found', key, seq: this.#lastSeq };
    }
    const seq = this.#nextSeq();
    const frame: Frame = { kind: 'delete', seq, payload: { key } };
    this.#commit(frame);
    return { operation: 'delete', status: 'ok', key, seq };
  }

  /** 把介质上所有脏字节落盘（正常写入已同步，此方法主要供显式控制）。 */
  sync(): void {
    this.#media.sync();
  }

  /**
   * 沿迁移链升级到 `target`（缺省最新）。每步写一条 `migration` 帧并同步。
   * 崩溃能落在任意一步之间：重启后停在该步之前或之后，重试即续上。
   */
  migrate(target: number = LATEST_SCHEMA_VERSION): MigrateResult {
    const from = this.#state.schemaVersion;
    if (target === from) {
      return { operation: 'migrate', status: 'ok', from, to: target, appliedSteps: [], alreadyAtVersion: true };
    }
    if (target < from) {
      throw new KernelJournalError('downgrade_forbidden', `不支持降级：当前 ${from}，请求 ${target}`, `${from}->${target}`);
    }
    if (target > LATEST_SCHEMA_VERSION) {
      throw new KernelJournalError('schema_too_new', `目标版本 ${target} 高于本书面支持的最新版本 ${LATEST_SCHEMA_VERSION}`, String(target));
    }
    if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(target)) {
      throw new KernelJournalError('target_version_unsupported', `目标版本 ${target} 不在支持列表内`, String(target));
    }
    const chain = buildChain(from, target);
    if (chain === null) {
      throw new KernelJournalError('migration_step_missing', `没有从 ${from} 到 ${target} 的完整迁移链`, `${from}->${target}`);
    }
    const applied: MigrateStepDescriptor[] = [];
    for (const step of chain) {
      const seq = this.#nextSeq();
      const frame: Frame = { kind: 'migration', seq, payload: { from: step.from, to: step.to } };
      this.#commit(frame);
      applied.push({ from: step.from, to: step.to });
    }
    return { operation: 'migrate', status: 'ok', from, to: target, appliedSteps: applied, alreadyAtVersion: false };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #nextSeq(): number {
    this.#lastSeq += 1;
    return this.#lastSeq;
  }

  /** 唯一的提交路径：注入点包围 append + sync，之后才改内存派生状态。 */
  #commit(frame: Frame): void {
    const encoded = encodeFrame(frame);
    this.#kill?.beforeAppend?.(frame, encoded);
    this.#media.append(encoded);
    this.#kill?.afterAppend?.(frame, encoded);
    this.#kill?.beforeSync?.(frame, encoded);
    const partial = this.#kill?.partialSync?.(frame, encoded);
    if (partial === undefined) {
      this.#media.sync();
    } else {
      this.#media.syncPrefix(partial);
    }
    this.#kill?.afterSync?.(frame, encoded);
    applyFrameToState(this.#state, frame);
  }
}
