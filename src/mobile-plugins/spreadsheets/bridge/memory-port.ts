/**
 * 表格存储桥接层 —— **内存参考实现**（零依赖，不 import 任何 Node 内置）。
 *
 * ## 为什么先做内存实现
 *
 * 安卓宿主（SAF / 应用私有目录）在真机外不可复现，而本层要证明的是**与介质无关**的判据：
 * 三值读取可区分、写入回执确定、日志与快照两类记录按版本存取、坏字节必须能被上层识别。
 * 把这些钉在内存实现上，才能**确定性**地驱动"介质读失败""字节损坏"这类分支；
 * 生命周期与真机一致的实现留给安卓原生端口（**本层未做，也未声称做过**）。
 *
 * ## 崩溃注入
 *
 * 与 K09 `MemoryStoragePort` 同思路：注入**抛错的写 / 删除**或**读失败**，把
 * "介质不可达"折进确定的 `failed` 分支；注入的**读字节损坏**让"成功读取却是坏内容"
 * 可被上层的严格解码拒绝，从而证明"损坏 ≠ 空库"。
 *
 * ## 确定性
 *
 * 本类**不读墙钟、不用随机数**：逻辑版本是自增计数。同一串操作必得同一串回执与字节。
 */

import { SpreadsheetBridgeError } from './errors.js';
import { assertLogicalKey, assertRecordRef } from './types.js';
import type {
  BlobWriteReceipt,
  ByteReadOutcome,
  DurableRecordKind,
  DurableRecordRef,
  DurableRecordScope,
  SpreadsheetHostStoragePort,
} from './types.js';

/** 内存后端的可注入故障。 */
export interface InMemoryHostStorageFaults {
  /** 下一次（及之后）`readBlob` / `readRecord` 报读失败（`kind:'failed'`）。 */
  readonly failRead?: boolean | { readonly detail?: string };
  /** 下一次（及之后）`writeBlob` / `writeRecord` 抛写失败。 */
  readonly failWrite?: boolean | { readonly detail?: string };
  /** 下一次（及之后）`removeBlob` 抛删除失败。 */
  readonly failRemove?: boolean;
  /**
   * 读字节损坏注入：读出后把字节替换成 `fn` 的返回，用于验证上层"严格解码 + 摘要核对"
   * 真的在咬（成功读取 ≠ 内容完好）。
   */
  readonly corrupt?: (key: string, bytes: Uint8Array) => Uint8Array;
}

interface RecordBucket {
  readonly byRevision: Map<number, Uint8Array>;
}

/** 记录桶的 map key：会话 + 种类。用嵌套 Map 避免分隔符歧义。 */
type RecordTree = Map<string, Map<DurableRecordKind, RecordBucket>>;

function detailOf(fault: boolean | { readonly detail?: string } | undefined, fallback: string): string {
  if (fault === undefined || fault === false) return fallback;
  if (fault === true) return fallback;
  return fault.detail ?? fallback;
}

/** 内存参考实现：字节 blob 面 + 日志 / 快照记录面。 */
export class InMemorySpreadsheetHostStorage implements SpreadsheetHostStoragePort {
  readonly #blobs = new Map<string, Uint8Array>();
  readonly #blobWriteCount = new Map<string, number>();
  readonly #records: RecordTree = new Map();
  #writeCounter = 0;
  #faults: InMemoryHostStorageFaults;

  /** 诊断计数（只读）。 */
  readonly calls = { readBlob: 0, writeBlob: 0, removeBlob: 0, readRecord: 0, writeRecord: 0, list: 0 };

  constructor(faults: InMemoryHostStorageFaults = {}) {
    this.#faults = faults;
  }

  /** 运行中替换注入故障（同一后端可驱动多条分支）。 */
  setFaults(faults: InMemoryHostStorageFaults): void {
    this.#faults = faults;
  }

  // ---- 字节 blob 面 --------------------------------------------------------

  async readBlob(key: string): Promise<ByteReadOutcome> {
    const safe = assertLogicalKey(key);
    this.calls.readBlob += 1;
    if (this.#faults.failRead !== undefined && this.#faults.failRead !== false) {
      return { kind: 'failed', detail: detailOf(this.#faults.failRead, '注入的读失败（介质不可达）') };
    }
    const found = this.#blobs.get(safe);
    if (found === undefined) {
      return { kind: 'not_found' };
    }
    return { kind: 'ok', bytes: this.#observe(safe, found) };
  }

  async writeBlob(key: string, bytes: Uint8Array): Promise<BlobWriteReceipt> {
    const safe = assertLogicalKey(key);
    this.calls.writeBlob += 1;
    if (this.#faults.failWrite !== undefined && this.#faults.failWrite !== false) {
      throw new SpreadsheetBridgeError(
        'write_failed',
        detailOf(this.#faults.failWrite, '注入的写失败（介质满 / 权限）'),
        safe,
      );
    }
    const copy = copyBytes(bytes);
    this.#blobs.set(safe, copy);
    const revision = (this.#blobWriteCount.get(safe) ?? 0) + 1;
    this.#blobWriteCount.set(safe, revision);
    return { key: safe, byteLength: copy.length, revision };
  }

  async removeBlob(key: string): Promise<void> {
    const safe = assertLogicalKey(key);
    this.calls.removeBlob += 1;
    if (this.#faults.failRemove === true) {
      throw new SpreadsheetBridgeError('remove_failed', '注入的删除失败', safe);
    }
    this.#blobs.delete(safe);
    this.#blobWriteCount.delete(safe);
  }

  // ---- 持久记录面 ----------------------------------------------------------

  async readRecord(ref: DurableRecordRef): Promise<ByteReadOutcome> {
    assertRecordRef(ref);
    this.calls.readRecord += 1;
    if (this.#faults.failRead !== undefined && this.#faults.failRead !== false) {
      return { kind: 'failed', detail: detailOf(this.#faults.failRead, '注入的读失败（介质不可达）') };
    }
    const bucket = this.#records.get(ref.session_id)?.get(ref.kind);
    const found = bucket?.byRevision.get(ref.revision);
    if (found === undefined) {
      return { kind: 'not_found' };
    }
    return { kind: 'ok', bytes: this.#observe(recordLogKey(ref), found) };
  }

  async writeRecord(ref: DurableRecordRef, bytes: Uint8Array): Promise<BlobWriteReceipt> {
    assertRecordRef(ref);
    this.calls.writeRecord += 1;
    if (this.#faults.failWrite !== undefined && this.#faults.failWrite !== false) {
      throw new SpreadsheetBridgeError(
        'write_failed',
        detailOf(this.#faults.failWrite, '注入的写失败（介质满 / 权限）'),
        ref.session_id,
      );
    }
    let byKind = this.#records.get(ref.session_id);
    if (byKind === undefined) {
      byKind = new Map();
      this.#records.set(ref.session_id, byKind);
    }
    let bucket = byKind.get(ref.kind);
    if (bucket === undefined) {
      bucket = { byRevision: new Map() };
      byKind.set(ref.kind, bucket);
    }
    const copy = copyBytes(bytes);
    bucket.byRevision.set(ref.revision, copy);
    this.#writeCounter += 1;
    return { key: recordLogKey(ref), byteLength: copy.length, revision: this.#writeCounter };
  }

  async listRecordRevisions(scope: DurableRecordScope): Promise<readonly number[]> {
    assertRecordRef({ session_id: scope.session_id, kind: scope.kind, revision: 0 });
    this.calls.list += 1;
    const bucket = this.#records.get(scope.session_id)?.get(scope.kind);
    if (bucket === undefined) return Object.freeze([]);
    return Object.freeze([...bucket.byRevision.keys()].sort((a, b) => a - b));
  }

  // ---- 测试辅助（只读，不经过故障注入） ------------------------------------

  /** 直读当前 blob 字节（测试用）。 */
  peekBlob(key: string): Uint8Array | undefined {
    const found = this.#blobs.get(key);
    return found === undefined ? undefined : found.slice();
  }

  /** 直读当前记录字节（测试用）。 */
  peekRecord(ref: DurableRecordRef): Uint8Array | undefined {
    const found = this.#records.get(ref.session_id)?.get(ref.kind)?.byRevision.get(ref.revision);
    return found === undefined ? undefined : found.slice();
  }

  /** 已知的会话 id（测试用，升序）。 */
  sessionIds(): readonly string[] {
    return Object.freeze([...this.#records.keys()].sort());
  }

  // ---- 内部 ----------------------------------------------------------------

  #observe(key: string, stored: Uint8Array): Uint8Array {
    const raw = stored.slice();
    const corrupt = this.#faults.corrupt;
    return corrupt === undefined ? raw : corrupt(key, raw);
  }
}

function recordLogKey(ref: DurableRecordRef): string {
  return `${ref.session_id}/${ref.kind}/${String(ref.revision)}`;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/** 工厂：内存参考实现。 */
export function createInMemoryHostStorage(faults?: InMemoryHostStorageFaults): InMemorySpreadsheetHostStorage {
  return new InMemorySpreadsheetHostStorage(faults);
}
