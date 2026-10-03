/**
 * K09 存储端口 —— **窄字符串 blob 端口 `BlobPort`**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么在 `StoragePort` 之上再要一个更窄的口
 *
 * `StoragePort`（`types.ts`）是**完整**的存储语义：事务、版本 CAS、流式摘要、读回凭据。
 * 但跨进程账本（K10 `TaskLedger.snapshot()/replay()`、K08 记忆库）只需要一件事：
 * **按 key 存一段字符串、读回来、删掉**——`read / write / remove` 三个动词。
 *
 * 让消费者直接用 `StoragePort` 会带来两个问题：一是它要自己拼 content URI、自己处理
 * `writeStream` 的异步分片；二是 `StoragePort` **没有 `remove`**，账本的"作废旧快照"
 * 无法表达。于是这里写一个**极窄**的键值口，由它去适配下层的**内存后端**与**文件后端**。
 *
 * ## 三态读取：`null` 与「读失败」是两件事（本文件最关键的一条）
 *
 * ```
 * read(key) -> string     // 读到了内容（可能是任意字符串，交给上层解析）
 *            | null       // 这个 key **确实没写过** —— 这才是"第一次冷启动，没有快照"
 *            | throws     // BlobPortError('blob_read_failed')：介质在，但读不动 / 内容损坏
 * ```
 *
 * K10 的集成请求原话：「treat a read failure as an error, never as an empty ledger」。
 * 把 IO 错误 / 截断 / 非法 UTF-8 **归一成 `null` 或空串**，上层就会拿它当"没有快照"，
 * 于是一次真正的读失败被静默降级成"账本是空的"——未结清的外部副作用就此丢失。
 * 因此本端口把读失败**抛成显式错误**（`blob_read_failed`），绝不返回空值；
 * `null` 只保留给"协议意义上确实不存在"这一种情况。
 *
 * 消费侧（K10）应把 `blob_read_failed` 映射成自己的 `invalid_snapshot`——**不是**空账本。
 *
 * ## 两个后端（复用既有机制，不改它们）
 *
 * - **内存后端 `MemoryBlobPort`**：进程内 `Map<string,string>`，与
 *   `MemoryStoragePort` 同一角色（无 IO，故障可注入），用于驱动各条分支的确定性验证。
 * - **文件后端 `FileBlobPort`**：跑在既有 `FileSystemPort`（`fs-port.ts`，也就是
 *   `FileStoragePort` 消费的同一个平台端口）上，**写临时文件 + 原子 rename**。
 *   换一个新实例指向同一个根目录，就能重现"杀进程重开后快照仍在"。
 *   **平台路径只在本文件内部出现，绝不进返回值。**
 *
 * 真正的安卓 SAF / 应用私有目录适配器仍由 Android 集成人实现（见同目录 README 局限）。
 */

import type { FileSystemPort } from './fs-port.js';
import { utf8Encode } from './sha256.js';
import { isDesktopAbsolutePath } from './uri.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** `BlobPort` 的**全部**可机读拒因（测试逐条对照）。 */
export const BLOB_PORT_ERROR_CODES = [
  /** 读失败：介质在，但读不动 / 内容不是合法 UTF-8 / 长度截断。**绝不降级成 null 或空串**。 */
  'blob_read_failed',
  /** 写失败：落临时文件或原子 rename 失败。 */
  'blob_write_failed',
  /** 删除失败：底层 `removeFile` 报错。 */
  'blob_remove_failed',
  /** key 形状非法（电脑绝对路径 / 空 / 含 `..` / 含反斜杠 / 非法字符）。 */
  'invalid_blob_key',
  /** value 不是字符串。 */
  'invalid_blob_value',
] as const;

export type BlobPortErrorCode = (typeof BLOB_PORT_ERROR_CODES)[number];

/** 窄 blob 端口唯一的错误类型；测试按 `code` 断言。 */
export class BlobPortError extends Error {
  readonly code: BlobPortErrorCode;
  readonly subject: string | null;

  constructor(code: BlobPortErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'BlobPortError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：跨模块 `instanceof` 在打包后可能失效，故同时看 `code`。 */
export function isBlobPortError(value: unknown): value is BlobPortError {
  return (
    value instanceof BlobPortError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (BLOB_PORT_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

// ---------------------------------------------------------------------------
// key 形状（红线：不得是电脑绝对路径）
// ---------------------------------------------------------------------------

const BLOB_KEY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * 校验并归一 blob key（相对路径形式，例如 `ledger/task-ledger.v1.json`）。
 *
 * 复用 `uri.ts` 的同一条红线：**先拒电脑绝对路径**（盘符 / 前导 `/`），再拒空、
 * `..`、反斜杠与非法字符。拒因统一是 `invalid_blob_key`。
 */
export function assertBlobKey(key: unknown): string {
  if (isDesktopAbsolutePath(key)) {
    throw new BlobPortError('invalid_blob_key', 'blob key 不得是电脑绝对路径', String(key));
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new BlobPortError('invalid_blob_key', 'blob key 必须是非空字符串', String(key));
  }
  if (key.includes('\\')) {
    throw new BlobPortError('invalid_blob_key', 'blob key 不得含反斜杠', key);
  }
  const segments = key.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new BlobPortError('invalid_blob_key', 'blob key 不得为空或含 ..', key);
  }
  for (const segment of segments) {
    if (!BLOB_KEY_SEGMENT.test(segment)) {
      throw new BlobPortError('invalid_blob_key', `blob key 段含非法字符：${segment}`, key);
    }
  }
  return segments.join('/');
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/**
 * 窄字符串 blob 端口：`read / write / remove`。真实实现接到 K09 存储 / SAF / 原生目录。
 *
 * `read` 的**三态**见文件头注释——`null` = 确实不存在；抛 `blob_read_failed` = 读不动。
 */
export interface BlobPort {
  /** 读到内容返回字符串；key 未写过返回 `null`；读取失败抛 `blob_read_failed`。 */
  read(key: string): string | null;
  /** 覆盖写整段字符串；失败抛 `blob_write_failed`。 */
  write(key: string, value: string): void;
  /** 删除一个 key；不存在不算错误（幂等）；底层报错抛 `blob_remove_failed`。 */
  remove(key: string): void;
  /** key 是否存在（不触发读取；用于冷启动判断）。 */
  exists(key: string): boolean;
}

/** 跨进程账本在介质上的**约定 key**（K10 `TaskLedger` 快照；消费侧可另用其它 key）。 */
export const LEDGER_SNAPSHOT_KEY = 'ledger/task-ledger.v1.json';

// ---------------------------------------------------------------------------
// 内存后端（独立验证用）
// ---------------------------------------------------------------------------

/** 可注入故障（默认全关）。 */
export interface MemoryBlobFaults {
  /** 下一次 `read` 报读失败（抛 `blob_read_failed`）。 */
  failRead?: { readonly detail?: string } | boolean;
  /** 下一次 `write` 报写失败（抛 `blob_write_failed`）。 */
  failWrite?: { readonly detail?: string } | boolean;
  /** 读成功但内容被替换成给定字符串——用于验"存在 ≠ 内容可用"（**不算读失败**）。 */
  corruptValue?: string;
}

/** 进程内 `Map` 后端：无 IO、故障可注入，用于确定性驱动每一条分支。 */
export class MemoryBlobPort implements BlobPort {
  readonly #store = new Map<string, string>();
  #faults: MemoryBlobFaults;
  /** 诊断计数（只读；测试可断言"确实读了一次"）。 */
  readonly calls = { read: 0, write: 0, remove: 0 };

  constructor(initial?: { readonly key: string; readonly value: string }, faults: MemoryBlobFaults = {}) {
    if (initial !== undefined) {
      this.#store.set(assertBlobKey(initial.key), initial.value);
    }
    this.#faults = faults;
  }

  /** 运行中更新注入故障（每个用例可复用同一后端驱动多条分支）。 */
  setFaults(faults: MemoryBlobFaults): void {
    this.#faults = faults;
  }

  read(key: string): string | null {
    const safe = assertBlobKey(key);
    this.calls.read += 1;
    const fault = this.#faults.failRead;
    if (fault !== undefined && fault !== false) {
      throw new BlobPortError(
        'blob_read_failed',
        (typeof fault === 'object' ? fault.detail : undefined) ?? '注入的读失败（介质不可达）',
        safe,
      );
    }
    if (!this.#store.has(safe)) {
      return null;
    }
    if (this.#faults.corruptValue !== undefined) {
      return this.#faults.corruptValue;
    }
    return this.#store.get(safe)!;
  }

  write(key: string, value: string): void {
    const safe = assertBlobKey(key);
    if (typeof value !== 'string') {
      throw new BlobPortError('invalid_blob_value', 'blob 内容必须是字符串', safe);
    }
    this.calls.write += 1;
    const fault = this.#faults.failWrite;
    if (fault !== undefined && fault !== false) {
      throw new BlobPortError(
        'blob_write_failed',
        (typeof fault === 'object' ? fault.detail : undefined) ?? '注入的写失败（介质满）',
        safe,
      );
    }
    this.#store.set(safe, value);
  }

  remove(key: string): void {
    const safe = assertBlobKey(key);
    this.calls.remove += 1;
    this.#store.delete(safe);
  }

  exists(key: string): boolean {
    return this.#store.has(assertBlobKey(key));
  }

  /** 直读底层字节（测试用；**不经过故障注入**）。 */
  peek(key: string): string | undefined {
    return this.#store.get(assertBlobKey(key));
  }
}

// ---------------------------------------------------------------------------
// 文件后端（真磁盘 / 真跨进程）
// ---------------------------------------------------------------------------

export interface FileBlobPortOptions {
  /** 平台沙箱根目录（**仅在内部使用，绝不进返回值**）。 */
  readonly root: string;
  /** 平台文件系统端口（与 `FileStoragePort` 用的是同一个 `FileSystemPort`）。 */
  readonly fs: FileSystemPort;
  /** 存放 blob 的子目录名，默认 `blobs`。 */
  readonly dir?: string;
}

/**
 * 文件后端：把每个 key 落成 `<root>/<dir>/<key>` 的一个文件。
 *
 * - **写**：先写同目录的临时文件，再 `rename` 原子替换（对齐 `FileStoragePort` 的做法；
 *   `FileSystemPort.rename` 的契约是"要么完成、要么不发生"）。
 * - **读**：文件不存在 ⇒ `null`；文件在但 `readFile` 抛错、或内容不是**合法 UTF-8**
 *   （截断 / 损坏）⇒ 抛 `blob_read_failed`。**严格解码**是"读失败能被咬出来"的关键：
 *   宽松解码会把截断的字节悄悄变成 U+FFFD，掩盖损坏。
 * - **删**：`removeFile`；不存在不算错误。
 *
 * 换一个新实例指向同一 root 即可读回上一条进程写入的文件——这是"跨进程持久"的实现方式。
 */
export class FileBlobPort implements BlobPort {
  readonly #root: string;
  readonly #fs: FileSystemPort;
  readonly #dir: string;
  #counter = 0;

  constructor(options: FileBlobPortOptions) {
    this.#root = options.root.replace(/\\/g, '/').replace(/\/+$/, '');
    this.#fs = options.fs;
    this.#dir = (options.dir ?? 'blobs').replace(/^\/+|\/+$/g, '');
    this.#fs.ensureDir(this.#dirPath());
  }

  read(key: string): string | null {
    const safe = assertBlobKey(key);
    const path = this.#pathOf(safe);
    let bytes: Uint8Array;
    try {
      if (!this.#fs.exists(path)) {
        return null;
      }
      bytes = this.#fs.readFile(path);
    } catch (error) {
      throw new BlobPortError(
        'blob_read_failed',
        `读取 blob 失败：${messageOf(error)}`,
        safe,
      );
    }
    try {
      return utf8Decode(bytes);
    } catch (error) {
      throw new BlobPortError(
        'blob_read_failed',
        `blob 内容不是合法 UTF-8（介质损坏 / 截断，拒绝当作空值）：${messageOf(error)}`,
        safe,
      );
    }
  }

  write(key: string, value: string): void {
    const safe = assertBlobKey(key);
    if (typeof value !== 'string') {
      throw new BlobPortError('invalid_blob_value', 'blob 内容必须是字符串', safe);
    }
    const path = this.#pathOf(safe);
    this.#counter += 1;
    const leaf = safe.split('/').pop()!;
    const tmp = joinPath(this.#dirPath(), `.${leaf}.${String(this.#counter)}.tmp`);
    try {
      this.#fs.writeFile(tmp, utf8Encode(value));
      this.#fs.rename(tmp, path);
    } catch (error) {
      // 尽力清掉半成品的临时文件；清理自身的失败不掩盖真正的写失败。
      try {
        this.#fs.removeFile(tmp);
      } catch {
        /* ignore: tmp 清理失败不应覆盖写失败拒因 */
      }
      throw new BlobPortError('blob_write_failed', `写入 blob 失败：${messageOf(error)}`, safe);
    }
  }

  remove(key: string): void {
    const safe = assertBlobKey(key);
    try {
      this.#fs.removeFile(this.#pathOf(safe));
    } catch (error) {
      throw new BlobPortError('blob_remove_failed', `删除 blob 失败：${messageOf(error)}`, safe);
    }
  }

  exists(key: string): boolean {
    return this.#fs.exists(this.#pathOf(assertBlobKey(key)));
  }

  #dirPath(): string {
    return joinPath(this.#root, this.#dir);
  }

  #pathOf(safeKey: string): string {
    return joinPath(this.#dirPath(), safeKey);
  }
}

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

function joinPath(...parts: readonly string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .filter((part) => part.length > 0)
    .join('/');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * **严格** UTF-8 解码：任何非法序列（截断、非法续字节、过长编码、代理区码点、越界）
 * 一律抛错。刻意不用宽松解码——宽松会把损坏的字节变成 U+FFFD 而"看起来成功"，
 * 于是 `FileBlobPort.read` 就无法把介质损坏咬成 `blob_read_failed`。
 */
export function utf8Decode(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      i += 1;
      continue;
    }
    let codePoint: number;
    let extra: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      codePoint = b0 & 0x1f;
      extra = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      codePoint = b0 & 0x0f;
      extra = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      codePoint = b0 & 0x07;
      extra = 3;
    } else {
      throw new Error(`非法 UTF-8 首字节 0x${b0.toString(16)}（位置 ${i}）`);
    }
    if (i + extra >= bytes.length) {
      throw new Error(`UTF-8 序列被截断（位置 ${i}）`);
    }
    for (let k = 1; k <= extra; k += 1) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) {
        throw new Error(`非法 UTF-8 续字节 0x${b.toString(16)}（位置 ${i + k}）`);
      }
      codePoint = (codePoint << 6) | (b & 0x3f);
    }
    const minimum = extra === 1 ? 0x80 : extra === 2 ? 0x800 : 0x10000;
    if (codePoint < minimum) {
      throw new Error(`过长的 UTF-8 编码（位置 ${i}）`);
    }
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error(`越界 / 代理区的码点 U+${codePoint.toString(16)}（位置 ${i}）`);
    }
    i += extra + 1;
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      out.push(String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff)));
    } else {
      out.push(String.fromCharCode(codePoint));
    }
  }
  return out.join('');
}
