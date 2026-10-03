/**
 * K09 存储端口 —— **内存后端**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么先做内存后端
 *
 * StoragePort 的全部语义（原子提交 / 整体回滚、版本 CAS、流式摘要、读回凭据、
 * 崩溃后旧产物可读）都是**与介质无关**的判据。把它们钉在内存实现上，验收才能
 * 确定性复现"提交中途中断"这类只靠真实文件系统极难稳定触发的场景。
 * 真实的 SAF / 文件后端留给后续包（**本包未做，也未声称做过**）。
 *
 * ## 崩溃语义（用可注入中断点机器化验证）
 *
 * - `commit:before-apply` 抛错 ⇒ **无产物**：任何暂存写入都不可见，旧版本原样可读。
 * - `commit:applying`    抛错 ⇒ **整体回滚**：已落的写入逐条还原，不留半成品。
 * - `commit:after-apply` 抛错 ⇒ **已是完整可读**：写入早已落盘，只是调用方没拿到回执。
 *
 * ## 不得静默覆盖
 *
 * `compareAndSwap` 在期望版本与实际不符时**只读不写**：返回 `status: 'conflict'` 与
 * 当前实存版本，绝不"顺手用新值覆盖"。冲突是返回值，不是异常——但**不允许**被降级成
 * 一次普通写入。
 */

import { StorageError } from './errors.js';
import { DIGEST_PREFIX, Sha256, isSha256Digest, sha256Digest, toBytes, toHex, type BytesLike } from './sha256.js';
import {
  assertContentUri,
  isContentUri,
  relativePathToContentUri,
} from './uri.js';
import type {
  BeginTransactionResult,
  BlobDescriptor,
  CommitResult,
  CompareAndSwapRequest,
  CompareAndSwapResult,
  GetContentUriRequest,
  GetContentUriResult,
  HashResult,
  InterruptEvent,
  ReadBackRequest,
  ReadBackResult,
  ReadBlobResult,
  RollbackResult,
  StoragePort,
  WriteStreamRequest,
  WriteStreamResult,
} from './types.js';

interface BlobRecord {
  readonly uri: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly revision: number;
}

interface StagedWrite {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

interface Transaction {
  readonly id: string;
  readonly staged: Map<string, StagedWrite>;
  settled: boolean;
}

export interface MemoryStoragePortOptions {
  /** 注入时钟（毫秒）。缺省 `Date.now`——测试应注入固定值以保证 `readAt` 确定。 */
  readonly now?: () => number;
  /** 崩溃注入：在指定中断点被调用；抛错即模拟进程中断。 */
  readonly interrupt?: (event: InterruptEvent) => void;
  /** 读回破坏注入：读出后篡改字节，用于验证"摘要不符的读回必须失败"。 */
  readonly corrupt?: (uri: string, bytes: Uint8Array) => Uint8Array;
}

export class MemoryStoragePort implements StoragePort {
  #blobs = new Map<string, BlobRecord>();
  #transactions = new Map<string, Transaction>();
  #idCounter = 0;
  #credentialCounter = 0;
  readonly #now: () => number;
  readonly #interrupt: ((event: InterruptEvent) => void) | undefined;
  readonly #corrupt: ((uri: string, bytes: Uint8Array) => Uint8Array) | undefined;

  constructor(options: MemoryStoragePortOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#interrupt = options.interrupt;
    this.#corrupt = options.corrupt;
  }

  // -------------------------------------------------------------------------
  // 事务
  // -------------------------------------------------------------------------

  beginTransaction(): BeginTransactionResult {
    this.#idCounter += 1;
    const id = `txn-${this.#idCounter}`;
    this.#transactions.set(id, { id, staged: new Map(), settled: false });
    return { operation: 'beginTransaction', status: 'ok', transactionId: id };
  }

  commit(transactionId: string): CommitResult {
    const txn = this.#requireOpenTransaction(transactionId);

    // ① 提交前中断点：尚未落任何一条写入 ⇒ 无产物。
    this.#fire({ point: 'commit:before-apply', transactionId, detail: null });

    // 记录回滚快照，保证"提交或整体回滚"。
    const previous = new Map<string, BlobRecord | undefined>();
    for (const uri of txn.staged.keys()) previous.set(uri, this.#blobs.get(uri));

    let lastRevision: number | null = null;
    try {
      for (const [uri, staged] of txn.staged) {
        // ② 落每一条写入之间：可注入中断 ⇒ 触发整体回滚。
        this.#fire({ point: 'commit:applying', transactionId, detail: uri });
        const prev = this.#blobs.get(uri);
        const revision = (prev?.revision ?? 0) + 1;
        this.#blobs.set(uri, {
          uri,
          bytes: staged.bytes,
          digest: staged.digest,
          revision,
        });
        lastRevision = revision;
      }
    } catch (error) {
      for (const [uri, record] of previous) {
        if (record === undefined) this.#blobs.delete(uri);
        else this.#blobs.set(uri, record);
      }
      txn.settled = true;
      throw error;
    }

    txn.settled = true;

    // ③ 提交后中断点：产物**已完整可读**，只是调用方拿不到回执。
    this.#fire({ point: 'commit:after-apply', transactionId, detail: null });

    return {
      operation: 'commit',
      status: 'ok',
      transactionId,
      committed: true,
      revision: lastRevision,
    };
  }

  rollback(transactionId: string): RollbackResult {
    const txn = this.#requireOpenTransaction(transactionId);
    txn.settled = true;
    return { operation: 'rollback', status: 'ok', transactionId, rolledBack: true };
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  readBlob(uri: string): ReadBlobResult {
    const safeUri = assertContentUri(uri, 'readBlob.uri');
    const record = this.#blobs.get(safeUri);
    if (record === undefined) {
      return { operation: 'readBlob', status: 'not-found', uri: safeUri, bytes: null, blob: null, revision: null };
    }
    return {
      operation: 'readBlob',
      status: 'ok',
      uri: safeUri,
      bytes: record.bytes.slice(),
      blob: descriptorOf(record),
      revision: record.revision,
    };
  }

  // -------------------------------------------------------------------------
  // 写（流式）
  // -------------------------------------------------------------------------

  async writeStream(request: WriteStreamRequest): Promise<WriteStreamResult> {
    const uri = assertContentUri(request.uri, 'writeStream.uri');
    if (request.chunks === undefined || request.chunks === null) {
      throw new StorageError('missing_stream_source', 'writeStream 需要 chunks 分片来源', uri);
    }

    const streamId = request.streamId ?? this.#nextStreamId();
    const hasher = new Sha256();
    const parts: Uint8Array[] = [];
    let bytesWritten = 0;

    for await (const chunk of request.chunks) {
      const bytes = normalizeChunk(chunk, uri);
      hasher.update(bytes);
      parts.push(bytes);
      bytesWritten += bytes.length;
    }

    const bytes = concat(parts, bytesWritten);
    const digest = DIGEST_PREFIX + toHex(hasher.digest());
    // 摘要自检：分片拼接后的整块摘要必须与增量摘要一致（防"边写边算"与整块不一致）。
    if (sha256Digest(bytes) !== digest) {
      throw new StorageError('invalid_stream_chunk', '增量摘要与整块摘要不一致（流式写入实现错误）', uri);
    }

    let revision: number | null = null;
    const atomic = request.transactionId !== undefined;
    if (atomic) {
      const txn = this.#requireOpenTransaction(request.transactionId!);
      txn.staged.set(uri, { bytes, digest });
    } else {
      const prev = this.#blobs.get(uri);
      revision = (prev?.revision ?? 0) + 1;
      this.#blobs.set(uri, { uri, bytes, digest, revision });
    }

    return {
      operation: 'writeStream',
      status: 'ok',
      write: { streamId, bytesWritten, digest, atomic, uri },
      revision,
    };
  }

  // -------------------------------------------------------------------------
  // 摘要
  // -------------------------------------------------------------------------

  hash(input: BytesLike): HashResult {
    const bytes = toBytes(input);
    return { operation: 'hash', status: 'ok', digest: sha256Digest(bytes), byteLength: bytes.length };
  }

  // -------------------------------------------------------------------------
  // 版本 CAS
  // -------------------------------------------------------------------------

  compareAndSwap(request: CompareAndSwapRequest): CompareAndSwapResult {
    const uri = assertContentUri(request.uri, 'compareAndSwap.uri');
    const bytes = toBytes(request.bytes);
    const current = this.#blobs.get(uri);
    const currentRevision = current?.revision ?? 0;

    if (request.expectedRevision !== currentRevision) {
      // 冲突：**只读不写**，返回当前实存版本，绝不静默覆盖。
      return {
        operation: 'compareAndSwap',
        status: 'conflict',
        cas: { expectedRevision: request.expectedRevision, newRevision: currentRevision, result: 'conflict' },
        blob: current === undefined ? null : descriptorOf(current),
      };
    }

    const newRevision = currentRevision + 1;
    const record: BlobRecord = { uri, bytes, digest: sha256Digest(bytes), revision: newRevision };
    this.#blobs.set(uri, record);
    return {
      operation: 'compareAndSwap',
      status: 'ok',
      cas: { expectedRevision: request.expectedRevision, newRevision, result: 'ok' },
      blob: descriptorOf(record),
    };
  }

  // -------------------------------------------------------------------------
  // content URI
  // -------------------------------------------------------------------------

  getContentUri(request: GetContentUriRequest): GetContentUriResult {
    if (isContentUri(request.relativePath)) {
      throw new StorageError(
        'invalid_relative_path',
        'getContentUri 接受相对路径；已是内容 URI 时直接使用，不必再构造',
        request.relativePath,
      );
    }
    const uri = relativePathToContentUri(request.relativePath, request.scheme ?? 'content');
    return { operation: 'getContentUri', status: 'ok', uri };
  }

  // -------------------------------------------------------------------------
  // 读回凭据
  // -------------------------------------------------------------------------

  readBack(request: ReadBackRequest): ReadBackResult {
    const uri = assertContentUri(request.uri, 'readBack.uri');
    const record = this.#blobs.get(uri);
    if (record === undefined) {
      return { operation: 'readBack', status: 'not-found', readBack: null };
    }

    const expected = request.expectedDigest ?? record.digest;
    if (!isSha256Digest(expected)) {
      throw new StorageError('invalid_digest', '期望摘要必须是 sha256:<64 位小写 hex>', String(request.expectedDigest));
    }

    const raw = record.bytes.slice();
    // 读回破坏注入：模拟介质损坏 / 传输截断，用于验证摘要比对真的在咬。
    const observed = this.#corrupt === undefined ? raw : this.#corrupt(uri, raw);
    const observedDigest = sha256Digest(observed);
    const verified = observedDigest === expected;

    this.#credentialCounter += 1;
    return {
      operation: 'readBack',
      status: verified ? 'ok' : 'failed',
      readBack: {
        credential: `cred-${this.#credentialCounter}`,
        uri,
        digest: observedDigest,
        verified,
        readAt: new Date(this.#now()).toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #requireOpenTransaction(transactionId: string): Transaction {
    const txn = this.#transactions.get(transactionId);
    if (txn === undefined) {
      throw new StorageError('transaction_not_found', '事务不存在（未 begin 或已回收）', transactionId);
    }
    if (txn.settled) {
      throw new StorageError('transaction_already_settled', '事务已提交或已回滚，不得二次结算', transactionId);
    }
    return txn;
  }

  #fire(event: InterruptEvent): void {
    if (this.#interrupt !== undefined) this.#interrupt(event);
  }

  #nextStreamId(): string {
    this.#idCounter += 1;
    return `stream-${this.#idCounter}`;
  }
}

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

function descriptorOf(record: BlobRecord): BlobDescriptor {
  return { uri: record.uri, digest: record.digest, byteLength: record.bytes.length };
}

function normalizeChunk(chunk: unknown, uri: string): Uint8Array {
  if (typeof chunk === 'string') return toBytes(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new StorageError('invalid_stream_chunk', '分片必须是 Uint8Array 或 string', uri);
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
