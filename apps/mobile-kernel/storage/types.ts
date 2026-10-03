/**
 * K09 存储端口 —— **契约形状与端口接口**（零依赖，纯类型 + 纯函数）。
 *
 * 契约来源：`contracts/mobile-v1/schemas/storage-port.schema.json`（九种 operation、
 * 四种 status、`contentUri` / `digest` / `blob` / `write` / `cas` / `readBack` 六个 $defs）
 * 与 `docs/other/ds-six-lanes-2026-10-03/README.md` §5 的 StoragePort 行。
 *
 * 本文件的类型名与 schema 字段名**逐字对齐**，方便日后写 JSON-Schema 校验时零翻译。
 */

import type { BytesLike } from './sha256.js';

/** schema `$defs.status`。 */
export const STORAGE_STATUSES = ['ok', 'conflict', 'not-found', 'failed'] as const;
export type StorageStatus = (typeof STORAGE_STATUSES)[number];

/** schema `$defs.operation`。 */
export const STORAGE_OPERATIONS = [
  'beginTransaction',
  'commit',
  'rollback',
  'readBlob',
  'writeStream',
  'hash',
  'compareAndSwap',
  'getContentUri',
  'readBack',
] as const;
export type StorageOperation = (typeof STORAGE_OPERATIONS)[number];

/** schema `$defs.blob`。 */
export interface BlobDescriptor {
  readonly uri: string;
  readonly digest: string;
  readonly byteLength: number;
}

/** schema `$defs.write`。 */
export interface WriteDescriptor {
  readonly streamId: string;
  readonly bytesWritten: number;
  readonly digest: string;
  /** 是否参与调用方管理的事务（事务内为 true：提交前对外不可见）。 */
  readonly atomic: boolean;
  readonly uri: string;
}

/** schema `$defs.cas`。 */
export interface CasDescriptor {
  readonly expectedRevision: number;
  readonly newRevision: number;
  readonly result: StorageStatus;
}

/** schema `$defs.readBack`。 */
export interface ReadBackCredential {
  readonly credential: string;
  readonly uri: string;
  /** **实际读回内容**重算出的摘要（不是写时记下的那个）。 */
  readonly digest: string;
  readonly verified: boolean;
  readonly readAt: string;
}

export interface BeginTransactionResult {
  readonly operation: 'beginTransaction';
  readonly status: 'ok';
  readonly transactionId: string;
}

export interface CommitResult {
  readonly operation: 'commit';
  readonly status: StorageStatus;
  readonly transactionId: string;
  readonly committed: boolean;
  /** 事务中最后一次写入产生的版本号；空事务为 null。 */
  readonly revision: number | null;
}

export interface RollbackResult {
  readonly operation: 'rollback';
  readonly status: StorageStatus;
  readonly transactionId: string;
  readonly rolledBack: boolean;
}

export interface ReadBlobResult {
  readonly operation: 'readBlob';
  readonly status: StorageStatus;
  readonly uri: string;
  /** 字节的**副本**（调用方改动不影响存储内部状态）；未命中为 null。 */
  readonly bytes: Uint8Array | null;
  readonly blob: BlobDescriptor | null;
  readonly revision: number | null;
}

export interface WriteStreamRequest {
  readonly uri: string;
  readonly chunks: Iterable<BytesLike> | AsyncIterable<BytesLike>;
  /** 参与指定事务；缺省为立即生效的直接写入。 */
  readonly transactionId?: string;
  readonly streamId?: string;
}

export interface WriteStreamResult {
  readonly operation: 'writeStream';
  readonly status: StorageStatus;
  readonly write: WriteDescriptor;
  readonly revision: number | null;
}

export interface HashResult {
  readonly operation: 'hash';
  readonly status: 'ok';
  readonly digest: string;
  readonly byteLength: number;
}

export interface CompareAndSwapRequest {
  readonly uri: string;
  /** 期望的当前版本；0 表示"期望目标不存在"。 */
  readonly expectedRevision: number;
  readonly bytes: BytesLike;
}

export interface CompareAndSwapResult {
  readonly operation: 'compareAndSwap';
  readonly status: StorageStatus;
  readonly cas: CasDescriptor;
  /** 命中时是新版本；冲突时是**当前实存**版本（值未被改动）。 */
  readonly blob: BlobDescriptor | null;
}

export interface GetContentUriRequest {
  /** 相对路径，例如 `artifacts/report.docx`。 */
  readonly relativePath: string;
  readonly scheme?: 'content' | 'blob' | 'app';
}

export interface GetContentUriResult {
  readonly operation: 'getContentUri';
  readonly status: 'ok';
  readonly uri: string;
}

export interface ReadBackRequest {
  readonly uri: string;
  /** 期望摘要；缺省用写入时记录的摘要。 */
  readonly expectedDigest?: string;
}

export interface ReadBackResult {
  readonly operation: 'readBack';
  readonly status: StorageStatus;
  readonly readBack: ReadBackCredential | null;
}

/**
 * 存储端口（总方案 StoragePort）。所有方法同步，唯 `writeStream` 因接受异步分片而返回
 * Promise。实现不得返回值里带电脑绝对路径。
 */
export interface StoragePort {
  beginTransaction(): BeginTransactionResult;
  commit(transactionId: string): CommitResult;
  rollback(transactionId: string): RollbackResult;
  readBlob(uri: string): ReadBlobResult;
  writeStream(request: WriteStreamRequest): Promise<WriteStreamResult>;
  hash(bytes: BytesLike): HashResult;
  compareAndSwap(request: CompareAndSwapRequest): CompareAndSwapResult;
  getContentUri(request: GetContentUriRequest): GetContentUriResult;
  readBack(request: ReadBackRequest): ReadBackResult;
}

/**
 * 崩溃注入点词表。实现只在**这些点**调用注入钩子，测试据此制造"提交前崩""提交中途崩"。
 * 钩子抛错即模拟进程中断。
 */
export const INTERRUPT_POINTS = [
  /** 提交已开始、尚未落任何一条写入。 */
  'commit:before-apply',
  /** 正在落某一条写入（`detail` 为该条 uri）。 */
  'commit:applying',
  /** 全部写入已落、事务尚未标记完成。 */
  'commit:after-apply',
] as const;
export type InterruptPoint = (typeof INTERRUPT_POINTS)[number];

export interface InterruptEvent {
  readonly point: InterruptPoint;
  readonly transactionId: string;
  readonly detail: string | null;
}
