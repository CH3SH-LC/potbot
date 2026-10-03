/**
 * 表格存储桥接层 —— **会话 ⇄ 宿主端口的存取桥**（零依赖，纯逻辑）。
 *
 * ## 把三样东西接成一条链
 *
 * ```
 * SpreadsheetSession ──toDurableState──▶ DurableState ──codec──▶ bytes
 *                                                                 │
 *                              recordKey(session, snapshot, rev) ◀─┘ writeRecord
 *                              recordKey(session, journal,  rev) ◀──── writeRecord
 * ```
 *
 * 一次 {@link SpreadsheetSessionStore.save} 落**两条记录**：
 *
 * | 记录 | 内容 | 回答的问题 |
 * |---|---|---|
 * | `snapshot` | 整份 `DurableState` 的字节 | 进程被杀后**怎么逐字节重建**会话 |
 * | `journal` | 账本数组 `TransactionRecord[]` 的字节 | 哪几笔事务**提交过 / 回滚过**（独立审计轨） |
 *
 * 读取时**只信快照记录**（它是可重建载荷，且其内部 `revision` / `sourceDigest()` 会被
 * `sessionFromDurableState` 再核一遍）。日志记录是审计轨，单独读回原样 JSON。
 *
 * ## 诚实边界（与"结果不得编造"一致）
 *
 * - 端口读返回 `failed` ⇒ **抛** `read_failed`，绝不折成空会话（介质坏 ≠ 首次运行）。
 * - 有日志、无快照 ⇒ `incomplete`（保存中途断），**不**用日志拼一个会话糊过去。
 * - 快照记录在"列出"与"读取"之间消失（并发删除）⇒ `incomplete`，不当成功。
 * - 字节坏了（非 JSON / schema 不符 / 摘要不符）⇒ 由 `bytesToDurableState` /
 *   `sessionFromDurableState` 抛错，**绝不返回半可信会话**。
 *
 * ## 纪律
 *
 * 零 IO、零墙钟、零随机数、零 Node 内置依赖：本类只把**注入的端口**当地址，不自己碰介质。
 */

import { SpreadsheetBridgeError } from './errors.js';
import { bytesToDurableState, bytesToJournalRaw, durableStateToBytes, journalToBytes } from './codec.js';
import { sessionFromDurableState, toDurableState } from '../session/index.js';
import type { DurableState, SpreadsheetSession } from '../session/index.js';
import type {
  BlobWriteReceipt,
  ByteReadOutcome,
  DurableRecordRef,
  SpreadsheetHostStoragePort,
} from './types.js';

/** 一次保存的机器回执（两条记录各自的写入凭据 + 源身份）。 */
export interface SessionSaveReceipt {
  readonly session_id: string;
  readonly revision: number;
  readonly digest: string;
  readonly snapshot: BlobWriteReceipt;
  readonly journal: BlobWriteReceipt;
}

/** 读取结果（三值：载入 / 干净起点 / 记录不全）。 */
export type SessionLoadOutcome =
  | {
      readonly outcome: 'loaded';
      readonly session: SpreadsheetSession;
      readonly durable: DurableState;
      readonly revision: number;
      readonly source: 'snapshot-record';
    }
  | { readonly outcome: 'clean-start' }
  | { readonly outcome: 'incomplete'; readonly reason: string };

/** 会话存储桥：把一个注入的宿主端口收成"保存 / 载入会话"两件事。 */
export class SpreadsheetSessionStore {
  readonly #port: SpreadsheetHostStoragePort;

  constructor(port: SpreadsheetHostStoragePort) {
    this.#port = port;
  }

  /** 端口直通（诊断 / 组合用）。 */
  get port(): SpreadsheetHostStoragePort {
    return this.#port;
  }

  /** 保存会话：写快照记录 + 日志记录（同一逻辑版本）。 */
  async save(session: SpreadsheetSession): Promise<SessionSaveReceipt> {
    const durable = toDurableState(session);
    const snapshotRef: DurableRecordRef = {
      session_id: durable.session_id,
      kind: 'snapshot',
      revision: durable.revision,
    };
    const journalRef: DurableRecordRef = {
      session_id: durable.session_id,
      kind: 'journal',
      revision: durable.revision,
    };
    const snapshot = await this.#port.writeRecord(snapshotRef, durableStateToBytes(durable));
    const journal = await this.#port.writeRecord(journalRef, journalToBytes(durable.journal));
    return {
      session_id: durable.session_id,
      revision: durable.revision,
      digest: durable.digest,
      snapshot,
      journal,
    };
  }

  /** 某会话已知的全部快照版本（升序）。 */
  async snapshotRevisions(sessionId: string): Promise<readonly number[]> {
    return this.#port.listRecordRevisions({ session_id: sessionId, kind: 'snapshot' });
  }

  /** 最新快照版本；无任何记录返回 `null`。 */
  async latestRevision(sessionId: string): Promise<number | null> {
    const revisions = await this.snapshotRevisions(sessionId);
    if (revisions.length === 0) return null;
    return revisions[revisions.length - 1] ?? null;
  }

  /** 载入最新快照对应的会话。 */
  async load(sessionId: string): Promise<SessionLoadOutcome> {
    const revisions = await this.snapshotRevisions(sessionId);
    if (revisions.length === 0) {
      const journals = await this.#port.listRecordRevisions({ session_id: sessionId, kind: 'journal' });
      if (journals.length === 0) {
        return { outcome: 'clean-start' };
      }
      return {
        outcome: 'incomplete',
        reason: `有日志记录 ${String(journals.length)} 条但没有快照记录：保存中途断，拒绝用日志拼会话`,
      };
    }
    const latest = revisions[revisions.length - 1];
    if (latest === undefined) {
      return { outcome: 'incomplete', reason: '快照版本列表非空但取不到最新版本（端口实现违约）' };
    }
    return this.loadRevision(sessionId, latest);
  }

  /** 载入指定版本的快照对应的会话。 */
  async loadRevision(sessionId: string, revision: number): Promise<SessionLoadOutcome> {
    const ref: DurableRecordRef = { session_id: sessionId, kind: 'snapshot', revision };
    const read = await this.#port.readRecord(ref);
    return this.#revive(sessionId, revision, read);
  }

  /** 读日志记录的原始 JSON 值（审计轨；不做快照级字段核对）。 */
  async readJournal(sessionId: string, revision?: number): Promise<unknown> {
    let target = revision;
    if (target === undefined) {
      const revisions = await this.#port.listRecordRevisions({ session_id: sessionId, kind: 'journal' });
      target = revisions[revisions.length - 1];
      if (target === undefined) return null;
    }
    const read = await this.#port.readRecord({ session_id: sessionId, kind: 'journal', revision: target });
    if (read.kind === 'not_found') return null;
    if (read.kind === 'failed') {
      throw new SpreadsheetBridgeError('read_failed', `日志记录读取失败：${read.detail}`, sessionId);
    }
    return bytesToJournalRaw(read.bytes);
  }

  /** 断言式载入：必须拿到会话，否则抛错（供调用方在"必须有"的场景使用）。 */
  async loadOrThrow(sessionId: string): Promise<SpreadsheetSession> {
    const outcome = await this.load(sessionId);
    if (outcome.outcome === 'loaded') return outcome.session;
    const detail = outcome.outcome === 'clean-start' ? '该会话没有任何持久记录（干净起点）' : outcome.reason;
    throw new SpreadsheetBridgeError('incomplete_persistence', `拒绝返回会话：${detail}`, sessionId);
  }

  // ---- 内部 ----------------------------------------------------------------

  #revive(sessionId: string, revision: number, read: ByteReadOutcome): SessionLoadOutcome {
    if (read.kind === 'not_found') {
      return {
        outcome: 'incomplete',
        reason: `快照记录 ${sessionId}/snapshot/${String(revision)} 在列出后读不到（可能被并发删除）`,
      };
    }
    if (read.kind === 'failed') {
      throw new SpreadsheetBridgeError('read_failed', `快照记录读取失败：${read.detail}`, sessionId);
    }
    const durable = bytesToDurableState(read.bytes);
    const session = sessionFromDurableState(durable);
    return { outcome: 'loaded', session, durable, revision: durable.revision, source: 'snapshot-record' };
  }
}

/** 工厂 / 便捷：把端口包成会话存储桥。 */
export function createSpreadsheetSessionStore(port: SpreadsheetHostStoragePort): SpreadsheetSessionStore {
  return new SpreadsheetSessionStore(port);
}

/** 便捷：保存会话（等价于 `new SpreadsheetSessionStore(port).save(session)`）。 */
export function saveSession(
  port: SpreadsheetHostStoragePort,
  session: SpreadsheetSession,
): Promise<SessionSaveReceipt> {
  return new SpreadsheetSessionStore(port).save(session);
}

/** 便捷：载入会话。 */
export function loadSession(port: SpreadsheetHostStoragePort, sessionId: string): Promise<SessionLoadOutcome> {
  return new SpreadsheetSessionStore(port).load(sessionId);
}
