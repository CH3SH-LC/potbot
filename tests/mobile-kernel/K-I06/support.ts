/**
 * K-I06 测试支撑：把 K09 的 `FileStoragePort` 接在**真实临时目录**上，并提供一个
 * 可注入故障的 `StoragePort` 装饰器（真实后端底下，只在端口边界制造 `failed`）。
 *
 * 说明：`node:fs` 适配器**只定义在测试里**（产品树不得依赖 node 内建，与 K09 测试同规）。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DIGEST_PREFIX,
  sha256Digest,
  type BeginTransactionResult,
  type BytesLike,
  type CommitResult,
  type CompareAndSwapRequest,
  type CompareAndSwapResult,
  type FileSystemPort,
  type GetContentUriRequest,
  type GetContentUriResult,
  type HashResult,
  type ReadBackRequest,
  type ReadBackResult,
  type ReadBlobResult,
  type RollbackResult,
  type StoragePort,
  type WriteStreamRequest,
  type WriteStreamResult,
} from '../../../apps/mobile-kernel/storage/index.js';

/** 平台文件系统端口 → 真磁盘（测试专用）。 */
export class NodeFileSystem implements FileSystemPort {
  ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  }
  exists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
  readFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
  }
  writeFile(path: string, bytes: Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  rename(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  removeFile(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  listFiles(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  listDirs(path: string): readonly string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

/** 临时沙箱根；配合 `removeTempRoot` 使用。 */
export function makeTempRoot(prefix = 'k-i06-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTempRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/**
 * `FileStoragePort` 的磁盘布局（与 K09 `file-store.ts` 一致）：
 * 内容在 `<root>/data/<rel>`，边车在 `<root>/meta/<rel>.json`。
 * 这两个路径**只在本测试内部**使用（平台路径不进产品返回值）。
 */
export function dataPathFor(root: string, rel: string): string {
  return join(root, 'data', ...rel.split('/'));
}

export function metaPathFor(root: string, rel: string): string {
  return join(root, 'meta', `${rel}.json`);
}

/**
 * 把一个**真实**的 `StoragePort` 包一层，只在端口边界注入 `readBlob` / `writeStream` 的
 * `failed` 结果——用来覆盖"后端实现了但报 failed"这一契约分支（K09 的两个后端不会
 * 自发产生，但契约允许）。底层仍是真实后端：正常的读写原样透传。
 */
export class FaultyStoragePort implements StoragePort {
  #readFault = false;
  #readThrow = false;
  #writeFault = false;
  #writeThrow = false;

  constructor(readonly inner: StoragePort) {}

  setReadFault(on: boolean): void {
    this.#readFault = on;
  }
  /** 让 `readBlob` 直接抛错（模拟端口实现层面的异常，非 status 返回）。 */
  setReadThrow(on: boolean): void {
    this.#readThrow = on;
  }
  setWriteFault(on: boolean): void {
    this.#writeFault = on;
  }
  /** 让 `writeStream` 的 Promise 拒绝（模拟落盘过程抛错）。 */
  setWriteThrow(on: boolean): void {
    this.#writeThrow = on;
  }

  beginTransaction(): BeginTransactionResult {
    return this.inner.beginTransaction();
  }
  commit(transactionId: string): CommitResult {
    return this.inner.commit(transactionId);
  }
  rollback(transactionId: string): RollbackResult {
    return this.inner.rollback(transactionId);
  }
  readBlob(uri: string): ReadBlobResult {
    if (this.#readThrow) {
      throw new Error('disk media unreachable (faulty storage: read throw)');
    }
    if (this.#readFault) {
      return { operation: 'readBlob', status: 'failed', uri, bytes: null, blob: null, revision: null };
    }
    return this.inner.readBlob(uri);
  }
  writeStream(request: WriteStreamRequest): Promise<WriteStreamResult> {
    if (this.#writeThrow) {
      return Promise.reject(new Error('disk full (faulty storage: write throw)'));
    }
    if (this.#writeFault) {
      return Promise.resolve({
        operation: 'writeStream',
        status: 'failed',
        write: {
          streamId: 'faulty',
          bytesWritten: 0,
          digest: `${DIGEST_PREFIX}${'0'.repeat(64)}`,
          atomic: false,
          uri: request.uri,
        },
        revision: null,
      });
    }
    return this.inner.writeStream(request);
  }
  hash(bytes: BytesLike): HashResult {
    return this.inner.hash(bytes);
  }
  compareAndSwap(request: CompareAndSwapRequest): CompareAndSwapResult {
    return this.inner.compareAndSwap(request);
  }
  getContentUri(request: GetContentUriRequest): GetContentUriResult {
    return this.inner.getContentUri(request);
  }
  readBack(request: ReadBackRequest): ReadBackResult {
    return this.inner.readBack(request);
  }
}

/** 把字符串写到 `<root>/data/...`，绕过端口（用于制造"介质上有损坏字节"）。 */
export function writeRawData(root: string, rel: string, text: string): void {
  const path = dataPathFor(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** 把垃圾写进 `<root>/meta/<rel>.json`（制造"边车损坏 ⇒ readBlob 抛错"的真实读失败）。 */
export function corruptMeta(root: string, rel: string, garbage = 'not json'): void {
  const path = metaPathFor(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, garbage, 'utf8');
}

/** 断言用的摘要助手：某段文本的 `sha256:<hex>`（与 K09 实现同一套）。 */
export function digestOf(text: string): string {
  return sha256Digest(text);
}
