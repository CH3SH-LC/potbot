/**
 * K-I06 记忆持久化适配器 —— 把 K08 的 `MemoryPersistencePort` **真正**接到 K09 的
 * `StoragePort` 上（集成请求 #2：「Provide a real MemoryPersistencePort implementation
 * wired to K09 StoragePort / SAF / native directory, read/write/remove of a string blob at
 * DEFAULT_MEMORY_KEY; read() must preserve the three-valued ok | not_found | failed outcome」）。
 *
 * ## 这一层到底做了什么
 *
 * K08 的记忆库（`apps/mobile-kernel/memory/store.ts`）只认识一个窄端口：
 * 按 key 读一段**字符串** / 写一段字符串 / 删一个 key，且 `read()` 是**三值**的
 * （`ok | not_found | failed`）。K09 的 `StoragePort` 是通用字节层：`getContentUri` +
 * `readBlob` + `writeStream`，返回值里**没有**"这个 key 从没写过"之外的失败区分。
 * 本适配器把前者落到后者上，并把两边的语义**一一对齐**，尤其是：
 *
 * ```
 * StoragePort.readBlob(uri)        K08 MemoryPersistencePort.read(key)
 * ─────────────────────────────    ──────────────────────────────────
 * status 'not-found'            →  { kind: 'not_found' }        ← 唯一的"空库"
 * status 'ok' + 合法 UTF-8 字节  →  { kind: 'ok', bytes }         ← 真读到了
 * status 'ok' + 非 UTF-8 字节    →  { kind: 'failed', reason:'corrupt' }
 * status 'failed' / 'conflict'  →  { kind: 'failed', reason:'read_failed' }
 * 抛 StorageError（含键形状违规） →  { kind: 'failed', reason:'read_failed' }
 * ```
 *
 * **关键红线（K08 明令禁止）**：上面除 `not-found` 之外的**任何**一条，都**不得**被折叠成
 * `{ kind: 'not_found' }`。把"读不动 / 读到了但坏了"当成"没有记忆"，就是"读失败当空库"。
 * 因此本文件里 `not_found` 只在 `status === 'not-found'` **这一个分支**里产生，
 * 其余分支一律 `failed`。
 *
 * ## key 与 content URI
 *
 * `key` 是**相对路径**（`DEFAULT_MEMORY_KEY = 'memory/phone-store.v1.json'`），
 * 经 `StoragePort.getContentUri({ relativePath })` 归成 `content://potbot/…`。
 * 传电脑绝对路径（`C:\…` / `/…`）或非法段会被 K09 拒绝（`desktop_path_rejected` /
 * `invalid_relative_path`）——本适配器把它**如实**转成 `failed`，绝不当空库。
 *
 * ## remove：诚实的能力边界
 *
 * `StoragePort` 的九种 operation 里**没有删除**。因此删除必须由一个注入的
 * `removeBlob(uri)` 钩子提供（真实安卓后端用 SAF 删除 / 应用私有目录 `unlink`）。
 * 没注入钩子时 `remove()` 返回 `{ kind: 'failed' }`，**拒绝**用"写入空串"来冒充删除——
 * 那样 `read()` 会返回 `ok` 而不是 `not_found`，是伪造"已遗忘"。注入了钩子时，
 * `remove()` 会在调用后**回读校验**：只有 `readBlob` 真的变成 `not-found` 才算删成功。
 *
 * 纯 TS，零 node 内建。
 */

import {
  isStorageError,
  type ReadBlobResult,
  type StoragePort,
  type WriteStreamRequest,
} from '../../storage/index.js';
import type {
  MemoryLoadFailure,
  MemoryPersistencePort,
  PersistenceReadOutcome,
  PersistenceWriteOutcome,
} from '../../memory/index.js';

/** 诊断计数（只读；测试据此断言"确实经过了一次端口"）。 */
export interface StorageMemoryPersistenceCalls {
  read: number;
  write: number;
  remove: number;
}

export interface StorageMemoryPersistenceOptions {
  /**
   * 底层删除钩子。`StoragePort` 没有删除 operation，故真实后端（SAF / 应用私有目录）
   * 必须在此注入一个"删掉该 uri 对应介质"的动作，`remove()` 才能真的成立。
   */
  readonly removeBlob?: (uri: string) => void | Promise<void>;
}

/** 把任意异常渲染成可读 detail（保留 K09 的可机读拒因）。 */
function describeFailure(scope: string, error: unknown): string {
  if (isStorageError(error)) {
    return `${scope}：存储端口拒绝 [${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return `${scope}：${error.name}: ${error.message}`;
  }
  return `${scope}：${String(error)}`;
}

/**
 * 纯 TS UTF-8 解码（覆盖 BMP 外码点，代理对按 code point 合并）。
 *
 * **非法序列抛错**（不静默替换成 U+FFFD）：读出字节但解不成字符串 = 内容损坏，
 * 必须落 `failed(corrupt)`，这样它就不会被上层误当成"没有记忆"。
 * 与 `storage/sha256.ts` 的 `utf8Encode` 互为逆运算（不拖入 `node:Buffer`/`TextDecoder`）。
 */
export function utf8Decode(bytes: Uint8Array): string {
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

/** 记忆持久化适配器：`StoragePort` 字节层 → `MemoryPersistencePort` 三值字符串层。 */
export class StorageMemoryPersistence implements MemoryPersistencePort {
  readonly #port: StoragePort;
  readonly #removeBlob: ((uri: string) => void | Promise<void>) | undefined;
  readonly calls: StorageMemoryPersistenceCalls = { read: 0, write: 0, remove: 0 };

  constructor(port: StoragePort, options: StorageMemoryPersistenceOptions = {}) {
    this.#port = port;
    this.#removeBlob = options.removeBlob;
  }

  /** 相对路径 key → 内容 URI（形状违规会抛 `StorageError`，由各方法捕获转 `failed`）。 */
  #uriFor(key: string): string {
    return this.#port.getContentUri({ relativePath: key }).uri;
  }

  /**
   * 三值读取。**只有 `status === 'not-found'` 才是 `not_found`**；其余一切（读失败、
   * status 非法、bytes 缺失、字节非 UTF-8）都是 `failed`，绝不退化成空库。
   */
  async read(key: string): Promise<PersistenceReadOutcome> {
    this.calls.read += 1;

    let uri: string;
    try {
      uri = this.#uriFor(key);
    } catch (error) {
      return {
        kind: 'failed',
        reason: 'read_failed',
        detail: describeFailure(`read(${JSON.stringify(key)}) 解析内容 URI 失败`, error),
      };
    }

    let result: ReadBlobResult;
    try {
      result = this.#port.readBlob(uri);
    } catch (error) {
      // 存储端口抛错（介质不可达 / 边车损坏 / 形状违规）—— 是"读不动"，不是"没有记忆"。
      return {
        kind: 'failed',
        reason: 'read_failed',
        detail: describeFailure(`read(${uri}) 存储端口抛错`, error),
      };
    }

    if (result.status === 'not-found') {
      // 唯一的空库来源：介质上确实没有这个 key。
      return { kind: 'not_found' };
    }
    if (result.status !== 'ok') {
      return {
        kind: 'failed',
        reason: 'read_failed',
        detail: `read(${uri}) 存储读状态为 ${result.status}（不是 not-found，不得当空库）`,
      };
    }
    if (result.bytes === null) {
      return {
        kind: 'failed',
        reason: 'read_failed',
        detail: `read(${uri}) 存储返回 status=ok 但 bytes 为空（不是 not-found，不得当空库）`,
      };
    }

    try {
      return { kind: 'ok', bytes: utf8Decode(result.bytes) };
    } catch (error) {
      // 读到了字节但解不成字符串 —— 内容损坏，不是空库。
      return {
        kind: 'failed',
        reason: 'corrupt',
        detail: describeFailure(`read(${uri}) 字节不是合法 UTF-8`, error),
      };
    }
  }

  /** 写入字符串。任何非 ok 的写结果 / 抛错都转 `failed`（**不宣称已保存**）。 */
  async write(key: string, bytes: string): Promise<PersistenceWriteOutcome> {
    this.calls.write += 1;

    let uri: string;
    try {
      uri = this.#uriFor(key);
    } catch (error) {
      return { kind: 'failed', detail: describeFailure(`write(${JSON.stringify(key)}) 解析内容 URI 失败`, error) };
    }

    const request: WriteStreamRequest = { uri, chunks: [bytes] };
    try {
      const result = await this.#port.writeStream(request);
      if (result.status === 'ok') {
        return { kind: 'ok' };
      }
      return { kind: 'failed', detail: `write(${uri}) 存储写状态为 ${result.status}（未确认落盘，不得宣称已保存）` };
    } catch (error) {
      return { kind: 'failed', detail: describeFailure(`write(${uri}) 存储端口抛错`, error) };
    }
  }

  /**
   * 删除一个 key。`StoragePort` 没有删除 operation，故需要注入 `removeBlob`：
   * 未注入 ⇒ `failed`（拒绝用"写空串"冒充删除）；已注入 ⇒ 调用后**回读校验**，
   * 只有 `readBlob` 真的变成 `not-found` 才算成功。
   */
  async remove(key: string): Promise<PersistenceWriteOutcome> {
    this.calls.remove += 1;

    let uri: string;
    try {
      uri = this.#uriFor(key);
    } catch (error) {
      return { kind: 'failed', detail: describeFailure(`remove(${JSON.stringify(key)}) 解析内容 URI 失败`, error) };
    }

    if (this.#removeBlob === undefined) {
      return {
        kind: 'failed',
        detail:
          'StoragePort 无删除 operation 且未注入 removeBlob 钩子：拒绝用"写空串"冒充删除' +
          '（那会让 read 返回 ok 而非 not_found）。真实后端须注入删除动作。',
      };
    }

    try {
      await this.#removeBlob(uri);
    } catch (error) {
      return { kind: 'failed', detail: describeFailure(`remove(${uri}) 删除钩子抛错`, error) };
    }

    let after: ReadBlobResult;
    try {
      after = this.#port.readBlob(uri);
    } catch (error) {
      return { kind: 'failed', detail: describeFailure(`remove(${uri}) 删除后回读抛错`, error) };
    }
    if (after.status === 'not-found') {
      return { kind: 'ok' };
    }
    return {
      kind: 'failed',
      detail: `remove(${uri}) 调用了删除钩子但 readBlob 仍返回 ${after.status}：未确认删除`,
    };
  }
}

/**
 * 工厂：`StoragePort` → `StorageMemoryPersistence`（实现 `MemoryPersistencePort`，
 * 可直接塞进 `openPhoneMemory({ port })`）。返回**具体类**而非接口，方便调用方读取
 * `calls` 诊断计数（接口上只保证三值语义）。
 */
export function createStorageMemoryPersistence(
  port: StoragePort,
  options: StorageMemoryPersistenceOptions = {},
): StorageMemoryPersistence {
  return new StorageMemoryPersistence(port, options);
}

/**
 * 便捷断言：把任意 `MemoryLoadFailure` 收窄到适配器**实际会产出**的那几个值
 * （`read_failed` / `corrupt`）。`bad_schema` / `integrity_unknown` 是上层 store 的判定，
 * 适配器只负责"字节层能不能读"。仅用于类型自检，运行时原样返回。
 */
export function isAdapterLoadFailure(reason: MemoryLoadFailure): boolean {
  return reason === 'read_failed' || reason === 'corrupt';
}
