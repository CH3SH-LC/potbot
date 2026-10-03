/**
 * 表格存储桥接层 —— **安卓宿主必须实现的字节 / 存储端口形状**（零依赖，纯类型 + 纯函数）。
 *
 * ## 这个文件回答什么
 *
 * 表格的手机会话（`src/mobile-plugins/spreadsheets/session/**`）已经把会话落成**纯 JSON 字符串**
 * （`durable.ts` 的 `serializeSession`）。真正把它落到手机存储上的，是宿主内核的 K09 `StoragePort`
 * （`apps/mobile-kernel/storage/**`；通用九 operation 字节层）。本层是这条链的**窄接口**：
 * 表格侧只需要两件事，把 K09 的通用面**收窄成可被安卓原生逐条实现的两个端口面**：
 *
 * | 面 | 方法 | 用途 |
 * |---|---|---|
 * | 字节 blob | `readBlob` / `writeBlob` / `removeBlob` | 交付产物（导出的 `xlsx` 字节）按逻辑 key 存取 |
 * | 持久记录 | `readRecord` / `writeRecord` / `listRecordRevisions` | 会话的**日志记录**与**快照记录**按 (会话, 种类, 版本) 存取 |
 *
 * 记录面是刻意的：进程被杀后，宿主必须能说清"上一笔事务到底提交没提交"。因此日志（journal）
 * 与快照（snapshot）是**两条独立记录**，各自带版本号，可分别列出、分别读回。
 *
 * ## 红线（与 K09 同口径）
 *
 * 一切接受或产出 key 的入口都先跑 {@link assertLogicalKey}：**电脑绝对路径**
 * （`^[A-Za-z]:` 或前导 `/`）一律拒（`desktop_path_rejected`），空 key 拒（`empty_key`）。
 * 逻辑 key 用正斜杠相对形态，**绝不**是电脑盘符路径，也不是普通文件系统路径。
 *
 * ## 纪律
 *
 * 本模块是**纯类型 + 纯函数**：零 IO、零墙钟、零随机数、零 Node 内置依赖
 * （要能跑在 WebView / 安卓内核里）；真正的读写由安卓宿主实现端口完成。
 */

import { SpreadsheetBridgeError } from './errors.js';

// ---------------------------------------------------------------------------
// 三值读取（字节版）
// ---------------------------------------------------------------------------

/**
 * 读操作的三值结果。
 *
 * `not_found` 与 `failed` **必须可区分**：前者是"确实没写过"（干净起点），后者是
 * "读不动 / 读坏了"（**不是空**）。上层不允许把 `failed` 顺手折成空库。
 */
export type ByteReadOutcome =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failed'; readonly detail: string };

// ---------------------------------------------------------------------------
// key 形状
// ---------------------------------------------------------------------------

/** 逻辑 key 的统一前缀（正斜杠相对形态，绝不是电脑路径）。 */
export const LOGICAL_KEY_PREFIX = 'potbot/spreadsheets';

/**
 * 电脑绝对路径判据（与 K09 `isDesktopAbsolutePath` 同口径）。
 *
 * 命中即拒：`C:\…` / `C:/…` 这类盘符路径，或 `/…` 这类 POSIX 绝对路径。
 */
export function isDesktopAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith('/');
}

/**
 * 校验一个逻辑 key（blob key / 记录 key）。非法即抛 {@link SpreadsheetBridgeError}。
 *
 * @throws {SpreadsheetBridgeError} `empty_key` 或 `desktop_path_rejected`
 */
export function assertLogicalKey(key: string): string {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new SpreadsheetBridgeError('empty_key', '逻辑 key 必须是非空字符串', String(key));
  }
  if (isDesktopAbsolutePath(key)) {
    throw new SpreadsheetBridgeError(
      'desktop_path_rejected',
      '逻辑 key 不得是电脑绝对路径（盘符或前导斜杠）；本层接受正斜杠相对 key',
      key,
    );
  }
  return key;
}

/** 产物字节的 blob key：`potbot/spreadsheets/blobs/<相对路径>`。 */
export function artifactBlobKey(relativePath: string): string {
  const safe = assertLogicalKey(relativePath);
  return `${LOGICAL_KEY_PREFIX}/blobs/${safe}`;
}

// ---------------------------------------------------------------------------
// 持久记录（日志 / 快照）
// ---------------------------------------------------------------------------

/** 持久记录的种类：**日志**（逐笔事务）或**快照**（可重建载荷）。 */
export const DURABLE_RECORD_KINDS = ['journal', 'snapshot'] as const;
export type DurableRecordKind = (typeof DURABLE_RECORD_KINDS)[number];

/** 记录的作用域（会话 + 种类），不含版本。 */
export interface DurableRecordScope {
  readonly session_id: string;
  readonly kind: DurableRecordKind;
}

/** 记录引用（会话 + 种类 + 版本）。版本是**会话的逻辑版本号**（非墙钟）。 */
export interface DurableRecordRef extends DurableRecordScope {
  readonly revision: number;
}

/** 校验记录引用形状。非法即抛。 */
export function assertRecordRef(ref: DurableRecordRef): DurableRecordRef {
  if (typeof ref.session_id !== 'string' || ref.session_id.trim().length === 0) {
    throw new SpreadsheetBridgeError('invalid_record_ref', '记录引用的 session_id 必须是非空字符串', '');
  }
  if (!DURABLE_RECORD_KINDS.includes(ref.kind)) {
    throw new SpreadsheetBridgeError(
      'invalid_record_ref',
      `记录引用的 kind 只能是 journal / snapshot（收到 ${JSON.stringify(ref.kind)}）`,
      ref.session_id,
    );
  }
  if (!Number.isInteger(ref.revision) || ref.revision < 0) {
    throw new SpreadsheetBridgeError(
      'invalid_record_ref',
      `记录引用的 revision 必须是非负整数（收到 ${JSON.stringify(ref.revision)}）`,
      ref.session_id,
    );
  }
  return ref;
}

/**
 * 记录的稳定可读 key（供宿主落盘时当目录 / 文件名用）。
 *
 * 形态：`potbot/spreadsheets/sessions/<会话>/<种类>/<12 位左补零版本>`。
 * 版本**左补零**，因此字典序 == 数值序——宿主按 key 排序取"最新一条"时不必解析数字。
 */
export function recordKey(ref: DurableRecordRef): string {
  assertRecordRef(ref);
  return `${LOGICAL_KEY_PREFIX}/sessions/${ref.session_id}/${ref.kind}/${String(ref.revision).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// 端口形状
// ---------------------------------------------------------------------------

/** 一次写入的回执（逻辑版本，非墙钟）。 */
export interface BlobWriteReceipt {
  readonly key: string;
  readonly byteLength: number;
  /** 该 key 在本次会话内的**逻辑写入次数**（首次为 1，同 key 再写递增）；确定性，非墙钟。 */
  readonly revision: number;
}

/**
 * 安卓宿主必须实现的**字节 / 存储端口**。
 *
 * 两个面都返回/接受**字节副本**：实现不得把内部缓冲区直接交出去（调用方改动不得影响存储）。
 * 所有方法异步：真实 SAF / 应用私有目录 IO 是异步的，契约从一开始就按异步定，避免上层回调改造。
 */
export interface SpreadsheetHostStoragePort {
  // ---- 字节 blob 面 --------------------------------------------------------
  /** 按逻辑 key 读一段字节。缺省 / 失败见 {@link ByteReadOutcome}。 */
  readBlob(key: string): Promise<ByteReadOutcome>;
  /** 按逻辑 key 写一段字节（覆盖式）。返回写入回执。 */
  writeBlob(key: string, bytes: Uint8Array): Promise<BlobWriteReceipt>;
  /** 删除一个逻辑 key（不存在不报错）。 */
  removeBlob(key: string): Promise<void>;

  // ---- 持久记录面（日志 / 快照） -------------------------------------------
  /** 读一条持久记录（按会话 + 种类 + 版本）。 */
  readRecord(ref: DurableRecordRef): Promise<ByteReadOutcome>;
  /** 写一条持久记录（覆盖同引用）。 */
  writeRecord(ref: DurableRecordRef, bytes: Uint8Array): Promise<BlobWriteReceipt>;
  /** 列出某会话某类的**全部版本号**（升序）。 */
  listRecordRevisions(scope: DurableRecordScope): Promise<readonly number[]>;
}
