/**
 * K09 `artifacts-host/` —— **产物仓宿主的领域形状与端口接口**（零依赖，纯类型 + 纯函数）。
 *
 * ## 这个宿主回答什么
 *
 * K09 的 `storage/` 提供的是**与业务无关的存储语义**（原子事务 / 版本 CAS / 摘要 / 读回）。
 * Office 三件套（W/X/P）各自产出可编辑文件，需要一个**共用**的产物仓来回答：
 *
 *   - 这份产物**有哪些版本**、每版的**摘要与字节数**是什么（版本列表）；
 *   - 它属于哪个 **conversation / task**（按会话 / 任务归集）；
 *   - 给一份产物签发一个可撤销、可过期的**分享凭据**（不泄漏内容）。
 *
 * ## 三条硬保证（贯穿整个包）
 *
 * 1. **摘要为准**：每个版本的 `digest` 由本宿主对**实际内容字节**用 K09 的纯 TS SHA-256
 *    算出，并在写入后与存储端口的回执交叉核对。测试另用 `node:crypto` 外部预言机对拍，
 *    不让实现自证。
 * 2. **版本只追加、旧版恒可读**：每一版写到**各自独立**的内容 URI
 *    `content://potbot/artifacts/<id>/v<版本>.<ext>`，**从不覆盖**上一版。因此新版本发布、
 *    甚至进程崩溃重开之后，旧版本字节仍在（对照 K09 验收「崩溃后旧产物可读」）。
 * 3. **目录无明文**：persisted 的目录快照只含**摘要与元数据**，绝不嵌入产物**内容字节**；
 *    任何进目录的自由文本（`fileName` 等）都先过红线扫描（电脑绝对路径 / 明文密钥），
 *    违者抛错且**不落任何字节**。
 *
 * ## 与既有 `ResumableArtifact` 的关系（有意不复用其类型）
 *
 * K04 的 `ResumableArtifact`（`apps/mobile-kernel/conversation/types.ts`）是**会话续聊**视角
 * 的"当前版本事实"，字段偏向 `delivered/receiptId`。本包是**产物仓**视角，关心的是
 * "版本列表 / 归集 / 分享"。两者字段有意对齐（`artifactId/conversationId/taskId/fileName/
 * digest/byteLength/artifactVersion`），以便上层做适配；本包不 import K04 以免与其并发写权耦合。
 */

import type { BytesLike, ReadBackCredential, StoragePort } from '../storage/index.js';

/** 产物登记处内容 URI 的默认相对路径（最终形如 `content://potbot/artifacts/_catalog.v1.json`）。 */
export const DEFAULT_CATALOG_RELATIVE_PATH = 'artifacts/_catalog.v1.json';

/** 目录快照的 schema 版本（形状演进时递增，旧版本被拒绝而非猜测）。 */
export const CATALOG_SCHEMA_VERSION = 1 as const;

/** 单个产物版本（只含元数据；内容字节在存储端口里，按 `blobUri` 定位）。 */
export interface ArtifactVersion {
  /** 从 1 起单调递增的**产物版本号**（每次发布 +1；同内容重复发布不产生新版本）。 */
  readonly artifactVersion: number;
  /** `sha256:<64 位小写 hex>`，对**实际内容字节**重算。 */
  readonly digest: string;
  readonly byteLength: number;
  readonly mime: string;
  /** 该版本字节所在的内容 URI（`content://potbot/artifacts/…`，绝不含平台路径）。 */
  readonly blobUri: string;
  /** 发布时间（ISO 8601，取自注入时钟）。 */
  readonly createdAt: string;
}

/** 一个产物（跨版本稳定）的元数据。 */
export interface ArtifactRecord {
  readonly artifactId: string;
  readonly conversationId: string;
  /** 所属任务；无任务归属时为 null（归集时进"未归属"桶）。 */
  readonly taskId: string | null;
  readonly fileName: string;
  readonly mime: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 只追加：`versions[n-1]` 恒为第 n 版，长度即当前版本数。 */
  readonly versions: readonly ArtifactVersion[];
}

export interface PublishArtifactRequest {
  readonly conversationId: string;
  readonly taskId?: string | null;
  readonly fileName: string;
  /** 缺省 `application/octet-stream`。 */
  readonly mime?: string;
  /** 缺省由内核生成（`art-<序号>`）。 */
  readonly artifactId?: string;
  readonly chunks: Iterable<BytesLike> | AsyncIterable<BytesLike>;
}

export interface PublishArtifactResult {
  readonly status: 'ok';
  readonly artifact: ArtifactRecord;
  readonly version: ArtifactVersion;
  /** 是否是**本次新建**的 artifact（false = 在既有 artifact 上追加 / 命中幂等）。 */
  readonly created: boolean;
  /** 内容摘要与当前版本相同 ⇒ 未新增版本，返回的是既有版本。 */
  readonly idempotent: boolean;
}

export interface ReadArtifactRequest {
  readonly artifactId: string;
  /** 缺省 = 最新版本。 */
  readonly artifactVersion?: number;
  /** 期望摘要；缺省用该版本记录里的摘要。 */
  readonly expectedDigest?: string;
}

export interface ReadArtifactResult {
  readonly status: 'ok' | 'failed' | 'not-found';
  readonly artifactId: string;
  /** 实际读取的版本号；not-found 时为 null。 */
  readonly artifactVersion: number | null;
  /** 字节的**副本**；未命中为 null。 */
  readonly bytes: Uint8Array | null;
  /** 存储端口返回的读回凭据（重算实际读回字节摘要）；未命中为 null。 */
  readonly readBack: ReadBackCredential | null;
}

/** 列表筛选（全部可选，AND 组合）。 */
export interface ArtifactFilter {
  readonly conversationId?: string;
  readonly taskId?: string;
  /** true = 只列有任务归属的；false = 只列未归属的；缺省 = 不筛。 */
  readonly hasTask?: boolean;
}

/** 归集结果的一个桶。会话归集的 key 恒非 null；任务归集的 key 可为 null（未归属）。 */
export interface ArtifactGroup {
  readonly key: string | null;
  readonly artifacts: readonly ArtifactRecord[];
}

export interface IssueShareRequest {
  readonly artifactId: string;
  /** 缺省 = 最新版本。 */
  readonly artifactVersion?: number;
  /** 有效期毫秒；缺省 = 不过期。必须为正数。 */
  readonly ttlMs?: number;
}

/** 已签发的分享凭据（只读视图）。 */
export interface ShareCredential {
  readonly credentialId: string;
  /** 不透明令牌，`share_<64 hex>`；**不含**任何内容明文 / 平台路径。 */
  readonly token: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  /** 签发时**钉住**的版本摘要：artifact 升级后本凭据仍指向原版本。 */
  readonly digest: string;
  readonly blobUri: string;
  readonly mime: string;
  readonly fileName: string;
  readonly permission: 'read';
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/** 校验分享令牌的结果——"没有 / 已撤销 / 已过期"是**可区分的正常分支**，不抛。 */
export type ShareVerification =
  | { readonly status: 'ok'; readonly share: ShareCredential }
  | { readonly status: 'unknown'; readonly share: null }
  | { readonly status: 'revoked'; readonly share: ShareCredential }
  | { readonly status: 'expired'; readonly share: ShareCredential };

export interface RevokeShareResult {
  readonly credentialId: string;
  readonly revoked: true;
  /** 是否**本次**才置为撤销（false = 之前已撤销，幂等命中）。 */
  readonly changed: boolean;
}

/**
 * 产物仓宿主。写方法异步（`publish` 因接受异步分片），读方法同步（与 `StoragePort` 一致）。
 */
export interface ArtifactsHost {
  publish(request: PublishArtifactRequest): Promise<PublishArtifactResult>;
  listVersions(artifactId: string): readonly ArtifactVersion[];
  getArtifact(artifactId: string): ArtifactRecord | null;
  readArtifact(request: ReadArtifactRequest): ReadArtifactResult;
  listArtifacts(filter?: ArtifactFilter): readonly ArtifactRecord[];
  groupByConversation(): readonly ArtifactGroup[];
  groupByTask(): readonly ArtifactGroup[];
  issueShare(request: IssueShareRequest): ShareCredential;
  verifyShare(token: string): ShareVerification;
  revokeShare(credentialId: string): RevokeShareResult;
  listShares(artifactId?: string): readonly ShareCredential[];
  /** 目录快照的内容 URI（供诊断 / 测试直读；绝不含平台路径）。 */
  catalogUri(): string;
}

export interface ArtifactsHostOptions {
  /** K09 存储端口（唯一外部依赖）。 */
  readonly storage: StoragePort;
  /** 注入时钟（毫秒）；缺省 `Date.now`。测试应注入固定值以保证 `createdAt` 确定。 */
  readonly now?: () => number;
  /** 目录快照相对路径；缺省 {@link DEFAULT_CATALOG_RELATIVE_PATH}。 */
  readonly catalogRelativePath?: string;
  /** CAS 写目录的最大尝试次数；缺省 8。连续冲突超限抛 `write_conflict`。 */
  readonly maxWriteAttempts?: number;
}

export type { BytesLike, ReadBackCredential, StoragePort };
