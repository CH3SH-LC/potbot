/**
 * 手机内核日志库 —— **操作 schema / 形状 / 错误码 / 故障点词表**（零依赖）。
 *
 * 本文件是 K-R02 的**产品化落点**：K-R02 先在 `tests/mobile-kernel/K-R02/` 里证明了一套
 * 崩溃安全的带帧日志（帧编解码 / 撕裂写恢复 / schema 迁移），K-I25 把它提升为产品源码
 * `apps/mobile-kernel/journal/`，并补一个走 K09 `FileSystemPort` 的**存储后端媒体**。
 * 产品树里**不 import 任何 node 内建**（摘要复用 K09 的纯 TS `../storage/sha256.ts`）。
 *
 * ## 为什么把"故障点"做成显式词表
 *
 * 「杀进程」在真实安卓上不可控：你没法稳定地在"帧写到一半、还没 fsync"那一纳秒处停住。
 * 因此不假装能触发真实进程杀死，而是把**崩溃可能发生的每一个时刻**做成类型化的注入点
 * （`FAULT_POINTS`），由测试侧脚手架（`tests/mobile-kernel/K-R02/simulate-crash.ts`）在这些
 * 点抛错。提交路径在这些点之间**没有别的隐藏状态**——这是"注入点覆盖了崩溃面"这一论断的
 * 前提，也是本包能被复核的关键：读一遍 `journal-store.ts` 的 `#commit` 即可确认。
 *
 * ## 层与诚实边界
 *
 * - 本文件与实现全部是**确定性模型**：判据可复现，但**不是**真机进程杀死。
 *   `verifiedLayer` 只到 `unit`；真机 / 真实 Android SQLite / 真实 `fsync` 语义**未验证**。
 * - `StorageMedia` 把"落盘"从内存模型换成 K09 `FileSystemPort` 上的**真实文件字节**
 *   （测试用 `node:fs` 适配器驱动），但 `FileSystemPort` 本身没有 `fsync` 原语，故
 *   "sync 即持久"仍是**端口契约假设**，不是对真实块设备持久性的实测。
 */

// ---------------------------------------------------------------------------
// 版本词表
// ---------------------------------------------------------------------------

/** 本书面支持的最新数据库 schema 版本。 */
export const LATEST_SCHEMA_VERSION = 3;

/** 空介质（零字节）打开时约定的起始版本。 */
export const INITIAL_SCHEMA_VERSION = 1;

/** 本书面实现的全部 schema 版本。 */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3] as const;
export type SchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

// ---------------------------------------------------------------------------
// 帧（journal frame）
// ---------------------------------------------------------------------------

/** 帧魔数（4 字节 ASCII）。磁盘上出现别的字节即视为日志尾部损坏。 */
export const JOURNAL_MAGIC = 'PBJF';

/** 帧格式版本（与数据库 schema 版本是两回事：前者是编码，后者是数据形状）。 */
export const FRAME_FORMAT_VERSION = 1;

/** 记录类型词表。 */
export const RECORD_KINDS = ['put', 'delete', 'migration'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface PutPayload {
  readonly key: string;
  readonly value: string;
  /** v2 起才有；v2 迁移对旧条目回填为 0。 */
  readonly updatedAt?: number;
  /** v3 起才有；v3 迁移对旧条目回填为 `[]`。 */
  readonly tags?: readonly string[];
}

export interface DeletePayload {
  readonly key: string;
}

export interface MigrationPayload {
  readonly from: number;
  readonly to: number;
}

/**
 * 日志帧 —— 判别联合。`seq` 单调递增，仅用于诊断与"最后一条"定位，**不用于排序**
 * （日志本身按字节顺序回放）。
 */
export type Frame =
  | { readonly kind: 'put'; readonly seq: number; readonly payload: PutPayload }
  | { readonly kind: 'delete'; readonly seq: number; readonly payload: DeletePayload }
  | { readonly kind: 'migration'; readonly seq: number; readonly payload: MigrationPayload };

// ---------------------------------------------------------------------------
// 派生状态 / 账本条目
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  key: string;
  value: string;
  updatedAt?: number;
  tags?: string[];
}

export interface LedgerState {
  schemaVersion: number;
  entries: Map<string, LedgerEntry>;
}

// ---------------------------------------------------------------------------
// 操作词表（对应契约里的 operation 字段）
// ---------------------------------------------------------------------------

export const KERNEL_DB_OPERATIONS = ['open', 'put', 'delete', 'get', 'migrate', 'sync', 'recover'] as const;
export type KernelDbOperation = (typeof KERNEL_DB_OPERATIONS)[number];

export type KernelDbStatus = 'ok' | 'not-found' | 'conflict' | 'failed';

export interface PutResult {
  readonly operation: 'put';
  readonly status: 'ok';
  readonly key: string;
  readonly seq: number;
}

export interface DeleteResult {
  readonly operation: 'delete';
  readonly status: 'ok' | 'not-found';
  readonly key: string;
  readonly seq: number;
}

export interface GetResult {
  readonly operation: 'get';
  readonly status: 'ok' | 'not-found';
  readonly entry: LedgerEntry | null;
}

export interface MigrateStepDescriptor {
  readonly from: number;
  readonly to: number;
}

export interface MigrateResult {
  readonly operation: 'migrate';
  readonly status: 'ok';
  readonly from: number;
  readonly to: number;
  readonly appliedSteps: readonly MigrateStepDescriptor[];
  readonly alreadyAtVersion: boolean;
}

// ---------------------------------------------------------------------------
// 恢复结果（重启后从持久字节重建）
// ---------------------------------------------------------------------------

/** 丢弃日志尾部的原因。`none` 表示整条日志完好。 */
export const DISCARD_REASONS = [
  'none',
  'incomplete-header',
  'bad-magic',
  'unsupported-format',
  'bad-kind',
  'incomplete-frame',
  'bad-digest',
  'bad-json',
  'bad-payload',
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

export interface Recovery {
  /** 恢复出的 schema 版本。 */
  readonly schemaVersion: number;
  /** 成功回放的帧数。 */
  readonly framesApplied: number;
  /** 输入持久字节数。 */
  readonly durableBytes: number;
  /** 组成完整合法帧的字节数（= 恢复后应截断到的长度）。 */
  readonly validBytes: number;
  /** 被丢弃的尾部字节数（撕裂写 / 损坏）。 */
  readonly discardedBytes: number;
  readonly discardedReason: DiscardReason;
  /** 回放到的最大 seq；无帧为 0。 */
  readonly lastSeq: number;
  /** 恢复后的账本条目数。 */
  readonly entryCount: number;
}

// ---------------------------------------------------------------------------
// 故障点词表
// ---------------------------------------------------------------------------

/** 崩溃注入点：追加一条帧时可能被打断的每个时刻。 */
export const FAULT_POINTS = [
  /** 帧字节尚未写入介质。崩溃 ⇒ 该操作从未发生。 */
  'append:before',
  /** 帧字节已写入介质（脏），尚未 fsync。崩溃 ⇒ 未落盘，丢失。 */
  'append:after',
  /** 即将 fsync。崩溃 ⇒ 未落盘，丢失。 */
  'sync:before',
  /** 只落了一部分待写字节（撕裂写）。崩溃 ⇒ 半条帧落盘，回放须丢弃。 */
  'sync:partial',
  /** 已 fsync 完成，但调用方还没拿到回执。崩溃 ⇒ 数据已持久，只是没人确认。 */
  'sync:after',
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

/** 只会"抛错"的注入点（撕裂写由 `sync:partial` 单独表达）。 */
export const THROW_FAULT_POINTS = ['append:before', 'append:after', 'sync:before', 'sync:after'] as const;
export type ThrowFaultPoint = (typeof THROW_FAULT_POINTS)[number];

// ---------------------------------------------------------------------------
// 错误码词表
// ---------------------------------------------------------------------------

/** 内核日志库**全部**可机读拒因。新增必须在此登记（测试逐条对照）。 */
export const KERNEL_DB_ERROR_CODES = [
  /** 介质里声明的 schema 版本高于本书面支持的最新版本：不得静默降级或丢弃数据。 */
  'schema_too_new',
  /** 有一段从 A 到 B 的迁移声明，但实现里没有对应的迁移步骤。 */
  'migration_step_missing',
  /** 日志里的迁移帧顺序与当前派生版本对不上（既不是起点也不是终点）。 */
  'migration_out_of_order',
  /** 要求迁移到一个更低版本：不支持降级。 */
  'downgrade_forbidden',
  /** 目标版本不在 `SUPPORTED_SCHEMA_VERSIONS` 内。 */
  'target_version_unsupported',
  /** 帧解析出的 payload 形状非法。 */
  'invalid_frame',
  /** `put` 的键或值不是非空字符串。 */
  'invalid_put_payload',
  /** 要求把介质截断到一个非法长度（负数或超过已写长度）。 */
  'invalid_media_truncation',
] as const;
export type KernelDbErrorCode = (typeof KERNEL_DB_ERROR_CODES)[number];
