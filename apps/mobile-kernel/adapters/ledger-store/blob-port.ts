/**
 * K-I08 账本持久化适配层 —— **窄 byte 端口 + K09 `StoragePort` 桥接**（零 node 内建）。
 *
 * ## 为什么再包一层窄端口
 *
 * K09 的 `StoragePort` 是通用字节层（九种 operation、四种 status、流式分片、CAS…）。
 * 账本持久化只需要三件事：**按 key 读一段字符串 / 写一段字符串 / 删一个 key**。
 * 把这三件事收窄成一个 `BlobStorePort`，好处有二：
 *
 * 1. **三值读取在类型层钉住**（`ok | not_found | failed`）。`not_found` 是"确实没写过"
 *    = 干净起点；`failed` 是"读不动 / 读坏了" = **不是空库**。上层不可能在 `failed`
 *    分支上顺手 `?? ''` 造一个空账本。
 * 2. 单测可以用 `MemoryBlobStore` 注入"读失败""字节损坏"，不依赖真实文件系统；
 *    而生产路径用 {@link StoragePortBlobStore} 落到 K09。
 *
 * ## 解码纪律
 *
 * 读到的字节必须**严格**解成 UTF-8：非法序列**抛错**，由 {@link LedgerBlobStore} 折成
 * `invalid_snapshot(reason='read-failed')`。绝不静默替换成 U+FFFD——那会把"介质损坏"
 * 伪装成"内容只是有点怪"，进而被 JSON.parse 当成"空/坏"而放过。
 */

import type { StoragePort } from '../../storage/index.js';
import { isLedgerStoreError, invalidSnapshot, LedgerStoreError } from './errors.js';

// ---------------------------------------------------------------------------
// 三值读取
// ---------------------------------------------------------------------------

/** 读操作的三值结果（本层的核心类型，范本见 K08 `MemoryPersistencePort.read`）。 */
export type BlobReadOutcome =
  | { readonly kind: 'ok'; readonly text: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failed'; readonly detail: string };

/** 窄 blob 端口：真实实现落到 K09 / SAF / 应用私有目录。 */
export interface BlobStorePort {
  read(key: string): Promise<BlobReadOutcome>;
  write(key: string, text: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 内存后端（独立验证用，可注入故障）
// ---------------------------------------------------------------------------

export interface MemoryBlobStoreFaults {
  /** 下一次 `read` 报读失败（`kind:'failed'`）。 */
  failRead?: { readonly detail?: string } | boolean;
  /** `read` 报"确实没写过"（默认行为；用于显式钉住空库分支）。 */
  keyAbsent?: boolean;
  /**
   * `read` 报成功但内容被替换成这份字符串——用"present but corrupt"验证
   * **空库与损坏可区分**（例如截断的 JSON、半截快照）。
   */
  corruptText?: string;
  /** 下一次 `write` 抛错（模拟介质满 / 权限）。 */
  failWrite?: { readonly detail?: string } | boolean;
  /** 下一次 `remove` 抛错。 */
  failRemove?: boolean;
}

/** 内存 blob 后端：注入故障，供独立测试驱动各条分支。 */
export class MemoryBlobStore implements BlobStorePort {
  readonly #store = new Map<string, string>();
  #faults: MemoryBlobStoreFaults;
  /** 诊断计数（只读）。 */
  readonly calls: { read: number; write: number; remove: number } = { read: 0, write: 0, remove: 0 };

  constructor(initial?: { readonly key: string; readonly text: string }, faults: MemoryBlobStoreFaults = {}) {
    if (initial !== undefined) {
      this.#store.set(initial.key, initial.text);
    }
    this.#faults = faults;
  }

  /** 运行中更新注入故障（同一后端可驱动多条分支）。 */
  setFaults(faults: MemoryBlobStoreFaults): void {
    this.#faults = faults;
  }

  async read(key: string): Promise<BlobReadOutcome> {
    this.calls.read += 1;
    const fault = this.#faults.failRead;
    if (fault !== undefined && fault !== false) {
      return {
        kind: 'failed',
        detail: (typeof fault === 'object' ? fault.detail : undefined) ?? '注入的读失败（介质不可达）',
      };
    }
    if (this.#faults.corruptText !== undefined) {
      return { kind: 'ok', text: this.#faults.corruptText };
    }
    if (this.#faults.keyAbsent === true) {
      return { kind: 'not_found' };
    }
    const found = this.#store.get(key);
    if (found === undefined) {
      return { kind: 'not_found' };
    }
    return { kind: 'ok', text: found };
  }

  async write(key: string, text: string): Promise<void> {
    this.calls.write += 1;
    const fault = this.#faults.failWrite;
    if (fault !== undefined && fault !== false) {
      throw new LedgerStoreError(
        'blob_write_failed',
        (typeof fault === 'object' ? fault.detail : undefined) ?? '注入的写失败（介质满）',
        { subject: key },
      );
    }
    this.#store.set(key, text);
  }

  async remove(key: string): Promise<void> {
    this.calls.remove += 1;
    if (this.#faults.failRemove === true) {
      throw new LedgerStoreError('blob_write_failed', '注入的删除失败', { subject: key });
    }
    this.#store.delete(key);
  }

  /** 直读当前落盘文本（测试用；不经过故障注入）。 */
  peek(key: string): string | undefined {
    return this.#store.get(key);
  }
}

// ---------------------------------------------------------------------------
// K09 StoragePort 桥接
// ---------------------------------------------------------------------------

/**
 * 严格 UTF-8 解码（纯 TS，覆盖 BMP 外码点）。**非法序列抛错**、不静默替换成 U+FFFD：
 * 解不成字符串 = 内容损坏，必须落 `failed`，不能伪装成"内容只是有点怪"。
 * 与 `storage/sha256.ts` 的 `utf8Encode` 互为逆运算，不拖入任何 node 内建。
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    if (b0 < 0xc2) {
      throw new Error(`非法 UTF-8 起始字节 0x${b0.toString(16)} @${String(i)}`);
    }
    if (b0 < 0xe0) {
      const b1 = bytes[i + 1];
      if (b1 === undefined || (b1 & 0xc0) !== 0x80) {
        throw new Error(`非法 UTF-8 续字节 @${String(i)}`);
      }
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      i += 2;
      continue;
    }
    if (b0 < 0xf0) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if (b1 === undefined || b2 === undefined || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        throw new Error(`非法 UTF-8 三字节序列 @${String(i)}`);
      }
      const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      if (cp < 0x800) {
        throw new Error(`UTF-8 过度编码 @${String(i)}`);
      }
      out += String.fromCharCode(cp);
      i += 3;
      continue;
    }
    if (b0 < 0xf5) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (
        b1 === undefined ||
        b2 === undefined ||
        b3 === undefined ||
        (b1 & 0xc0) !== 0x80 ||
        (b2 & 0xc0) !== 0x80 ||
        (b3 & 0xc0) !== 0x80
      ) {
        throw new Error(`非法 UTF-8 四字节序列 @${String(i)}`);
      }
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) {
        throw new Error(`UTF-8 码点越界 @${String(i)}`);
      }
      out += String.fromCodePoint(cp);
      i += 4;
      continue;
    }
    throw new Error(`非法 UTF-8 起始字节 0x${b0.toString(16)} @${String(i)}`);
  }
  return out;
}

/**
 * 把 K09 `StoragePort` 收成 `BlobStorePort`。
 *
 * 映射（**只有 `not-found` 才是 `not_found`**）：
 * - `status === 'not-found'` ⇒ `not_found`（唯一的"确实没写过"）；
 * - `status === 'ok'` + 合法 UTF-8 ⇒ `ok`；
 * - `status === 'ok'` 但字节非法 UTF-8 ⇒ `failed('corrupt')`；
 * - 其余 status / 抛错（`desktop_path_rejected` / `invalid_content_uri` …）⇒ `failed`。
 */
export class StoragePortBlobStore implements BlobStorePort {
  readonly #port: StoragePort;

  constructor(port: StoragePort) {
    this.#port = port;
  }

  #uriFor(key: string): string {
    return this.#port.getContentUri({ relativePath: key }).uri;
  }

  async read(key: string): Promise<BlobReadOutcome> {
    let uri: string;
    try {
      uri = this.#uriFor(key);
    } catch (error) {
      return { kind: 'failed', detail: `解析内容 URI 失败：${describe(error)}` };
    }
    let result;
    try {
      result = this.#port.readBlob(uri);
    } catch (error) {
      return { kind: 'failed', detail: `readBlob(${uri}) 抛错：${describe(error)}` };
    }
    if (result.status === 'not-found') {
      // 唯一的空库来源。
      return { kind: 'not_found' };
    }
    if (result.status !== 'ok' || result.bytes === null) {
      return { kind: 'failed', detail: `readBlob(${uri}) 状态 ${result.status} 且 bytes 为空（不是 not-found，不得当空库）` };
    }
    try {
      return { kind: 'ok', text: decodeUtf8Strict(result.bytes) };
    } catch (error) {
      return { kind: 'failed', detail: `readBlob(${uri}) 字节不是合法 UTF-8：${describe(error)}` };
    }
  }

  async write(key: string, text: string): Promise<void> {
    let uri: string;
    try {
      uri = this.#uriFor(key);
    } catch (error) {
      throw new LedgerStoreError('blob_write_failed', `解析内容 URI 失败：${describe(error)}`, { subject: key });
    }
    try {
      const result = await this.#port.writeStream({ uri, chunks: [text] });
      if (result.status !== 'ok') {
        throw new LedgerStoreError('blob_write_failed', `writeStream(${uri}) 状态 ${result.status}：未确认落盘`, {
          subject: key,
        });
      }
    } catch (error) {
      if (isLedgerStoreError(error)) {
        throw error;
      }
      throw new LedgerStoreError('blob_write_failed', `writeStream(${uri}) 抛错：${describe(error)}`, { subject: key });
    }
  }

  async remove(key: string): Promise<void> {
    // K09 StoragePort 没有删除 operation：本层的 remove 只提供"端口语义"的占位，
    // 真实删除须由调用方在 StoragePort 之上注入（见 README 的诚实边界）。
    throw new LedgerStoreError(
      'blob_write_failed',
      'StoragePort 无删除 operation：拒绝用"写空串"冒充删除（那会让 read 返回 ok 而非 not_found）',
      { subject: key },
    );
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 账本 blob 门面（三值 → string | null，失败即抛）
// ---------------------------------------------------------------------------

/**
 * 账本 blob 门面：把三值读取折成"字符串或 `null`"，并把**任何非 not_found 的失败**
 * 抛成 `invalid_snapshot`（见文件头）。写入失败抛 `blob_write_failed`。
 */
export class LedgerBlobStore {
  readonly #port: BlobStorePort;
  readonly #key: string;

  constructor(port: BlobStorePort, key: string) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw invalidSnapshot('partial', '账本 blob key 必须是非空字符串', null);
    }
    this.#port = port;
    this.#key = key;
  }

  get key(): string {
    return this.#key;
  }

  /**
   * 读一段文本。**不存在 ⇒ `null`**（干净起点）；读失败 / 解不成 ⇒ 抛 `invalid_snapshot`。
   * 绝不在失败时返回 `null`——那会让上层把坏快照当首次运行。
   */
  async load(): Promise<string | null> {
    const outcome = await this.#port.read(this.#key);
    if (outcome.kind === 'ok') {
      return outcome.text;
    }
    if (outcome.kind === 'not_found') {
      return null;
    }
    throw invalidSnapshot('read-failed', `账本 blob 读取失败（拒绝当空账本）：${outcome.detail}`, this.#key);
  }

  async save(text: string): Promise<void> {
    await this.#port.write(this.#key, text);
  }

  async clear(): Promise<void> {
    await this.#port.remove(this.#key);
  }
}

/** 工厂：内存 blob 后端（独立验证用）。 */
export function createMemoryBlobStore(
  initial?: { readonly key: string; readonly text: string },
  faults?: MemoryBlobStoreFaults,
): MemoryBlobStore {
  return new MemoryBlobStore(initial, faults);
}

/** 工厂：K09 `StoragePort` → 窄 blob 端口。 */
export function createStoragePortBlobStore(port: StoragePort): StoragePortBlobStore {
  return new StoragePortBlobStore(port);
}
