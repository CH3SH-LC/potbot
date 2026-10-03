/**
 * 手机内核日志库 —— **介质抽象与两种实现**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么把介质抽出来
 *
 * 日志库只关心"字节有没有落盘"，不关心字节落在哪。把这一层抽成极小的 `Media`，就能让
 * **同一份** `KernelJournalStore` 跑在两种介质上：
 *
 * | 实现 | 落盘是什么 | 用途 |
 * | --- | --- | --- |
 * | `PersistentMedia` | 进程内"已落盘长度"模型（脏区 + durable 前缀） | 确定性崩溃注入；参考语义 |
 * | `StorageMedia` | K09 `FileSystemPort` 上的**真实文件字节** | 真磁盘 / 安卓侧接入面 |
 *
 * 两者语义必须一致：`append` 只写脏区、`sync` 落全量待写、`syncPrefix(n)` 只落 n 字节
 * （撕裂写）、`durable()` 给出**当前确已持久**的字节、`truncateTo(len)` 丢弃尾部。
 * 只要实现满足这五条，`KernelJournalStore` 的崩溃安全论证对两者**逐字成立**。
 *
 * ## StorageMedia 的诚实边界（必读）
 *
 * - `sync` 把 durable 前缀用 `FileSystemPort.writeFile`（整文件覆盖写）落成文件字节，
 *   `durable()` **从文件读回**——所以"崩溃后重启读到什么"由真实文件决定，不是内存里记的。
 * - 但 `FileSystemPort` **没有 `fsync` 原语**，故"writeFile 返回即持久"是**端口契约假设**，
 *   不是对真实块设备 / Android SQLite WAL 的实测。真实断电、`kill -9` 语义**未验证**。
 * - 每次 `sync` 整文件覆盖写是 O(日志长度)。对手机账本规模够用；真要做追加式落盘需给
 *   `FileSystemPort` 加 `appendFile` / `fsync`，那是后续集成项（见 README「下一步」）。
 */

import { KernelJournalError } from './errors.js';
import type { FileSystemPort } from '../storage/fs-port.js';

// ---------------------------------------------------------------------------
// 介质抽象
// ---------------------------------------------------------------------------

export interface Media {
  /** 把字节写入"脏"区（未必持久）。 */
  append(bytes: Uint8Array): void;
  /** 把全部脏字节落盘。 */
  sync(): void;
  /** 只把**待写区的前 `byteCount` 字节**落盘（撕裂写注入用）。 */
  syncPrefix(byteCount: number): void;
  /** 当前已落盘的字节（副本）。 */
  durable(): Uint8Array;
  /** 已写但未落盘的字节数。 */
  pendingBytes(): number;
  /** 截断到指定长度（恢复时丢弃撕裂尾部）。 */
  truncateTo(byteLength: number): void;
}

// ---------------------------------------------------------------------------
// 内存实现（进程内 durable 前缀模型）
// ---------------------------------------------------------------------------

/**
 * 进程内介质模型：脏字节 + 已落盘长度。
 *
 * "落盘" = 推进一个整数（`#durableLen`），因此崩溃注入**完全确定**、可复现；
 * 但它只是**模型**，不是真实 fsync（真实持久性由 `StorageMedia` 承担对拍）。
 */
export class PersistentMedia implements Media {
  #buf: number[] = [];
  #durableLen = 0;

  append(bytes: Uint8Array): void {
    for (const byte of bytes) this.#buf.push(byte);
  }

  sync(): void {
    this.#durableLen = this.#buf.length;
  }

  syncPrefix(byteCount: number): void {
    const pending = this.#buf.length - this.#durableLen;
    const take = Math.max(0, Math.min(byteCount, pending));
    this.#durableLen += take;
  }

  durable(): Uint8Array {
    return Uint8Array.from(this.#buf.slice(0, this.#durableLen));
  }

  pendingBytes(): number {
    return this.#buf.length - this.#durableLen;
  }

  truncateTo(byteLength: number): void {
    if (byteLength < 0 || byteLength > this.#buf.length) {
      throw new KernelJournalError(
        'invalid_media_truncation',
        `截断长度 ${byteLength} 非法（已写 ${this.#buf.length} 字节）`,
        String(byteLength),
      );
    }
    this.#buf.length = byteLength;
    this.#durableLen = Math.min(this.#durableLen, byteLength);
  }
}

// ---------------------------------------------------------------------------
// 存储实现（K09 FileSystemPort）
// ---------------------------------------------------------------------------

export interface StorageMediaOptions {
  /** 平台文件系统端口（安卓侧实现 `apps/android/.../AndroidFileSystemPort.java`）。 */
  readonly fs: FileSystemPort;
  /** 日志文件路径（**平台路径，仅在媒体内部使用，绝不进任何返回值**）。 */
  readonly path: string;
}

/**
 * 存储后端介质：字节真正落在 `FileSystemPort` 指向的文件里。
 *
 * - `open` 时**读回**既有文件字节作为起始 durable 前缀（等价于"重启后从磁盘重建"）；
 * - `sync` / `syncPrefix` 把 durable 前缀写回文件；`syncPrefix(n)` 写出的是**被截断的**
 *   前缀，于是撕裂写在真实文件上表现为"文件长度不足一条完整帧"；
 * - `durable()` **每次从文件读回**，因此恢复读到的就是磁盘现状，而不是内存里记的；
 * - `truncateTo(len)` 把恢复后的合法前缀写回文件（WAL 的 truncate-on-recovery）。
 */
export class StorageMedia implements Media {
  readonly #fs: FileSystemPort;
  readonly #path: string;
  #buf: number[] = [];
  #durableLen = 0;

  private constructor(fs: FileSystemPort, path: string) {
    this.#fs = fs;
    this.#path = path;
  }

  /** 从存储打开：文件存在则把其字节读成初始 durable 前缀，否则从空日志起步。 */
  static open(options: StorageMediaOptions): StorageMedia {
    const media = new StorageMedia(options.fs, options.path);
    if (media.#fs.exists(media.#path)) {
      const bytes = media.#fs.readFile(media.#path);
      media.#buf = Array.from(bytes);
      media.#durableLen = media.#buf.length;
    }
    return media;
  }

  append(bytes: Uint8Array): void {
    for (const byte of bytes) this.#buf.push(byte);
  }

  sync(): void {
    this.#persist(this.#buf.length);
  }

  syncPrefix(byteCount: number): void {
    const pending = this.#buf.length - this.#durableLen;
    const take = Math.max(0, Math.min(byteCount, pending));
    this.#persist(this.#durableLen + take);
  }

  durable(): Uint8Array {
    if (!this.#fs.exists(this.#path)) return new Uint8Array(0);
    return this.#fs.readFile(this.#path);
  }

  pendingBytes(): number {
    return this.#buf.length - this.#durableLen;
  }

  truncateTo(byteLength: number): void {
    if (byteLength < 0 || byteLength > this.#buf.length) {
      throw new KernelJournalError(
        'invalid_media_truncation',
        `截断长度 ${byteLength} 非法（已写 ${this.#buf.length} 字节）`,
        String(byteLength),
      );
    }
    this.#buf.length = byteLength;
    this.#durableLen = Math.min(this.#durableLen, byteLength);
    // 截断必须落到存储上：否则撕裂尾部会在下次 open 时"复活"。
    this.#persist(this.#durableLen);
  }

  /** 把 `#buf` 的前 `len` 字节覆盖写到存储文件，并推进 durable 指针。 */
  #persist(len: number): void {
    this.#fs.writeFile(this.#path, Uint8Array.from(this.#buf.slice(0, len)));
    this.#durableLen = len;
  }
}
