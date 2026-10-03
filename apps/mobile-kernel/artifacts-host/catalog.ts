/**
 * K09 `artifacts-host/` —— **目录快照的纯逻辑**（零依赖，纯函数，不碰 IO）。
 *
 * 本文件把所有"可脱离存储单独验证"的判断抽出来：标识 / 文件名 / mime 形状、**无明文红线
 * 扫描**、目录快照的序列化与解析、版本与分享的查找、归集。宿主 `host.ts` 只负责把这些纯函数
 * 编排到 `StoragePort` 的 CAS 读写上。这样红线扫描器可以用**反向对照**单独钉死
 * （喂一个含 `sk-…` 或含盘符路径的目录，必须抛），不必先造一整个存储。
 *
 * ## 目录快照内部形状
 *
 * ```
 * { schemaVersion: 1, artifactSeq, shareSeq, artifacts: ArtifactRecord[], shares: ShareRecord[] }
 * ```
 *
 * `artifactSeq` / `shareSeq` 是**持久化**的序号（跨进程重开不回绕），用于生成默认 artifactId
 * 与 credentialId。`shares` 与 `artifacts` 同处一份快照，使"发分享"与"撤销分享"的写入
 * 与产物写入共享同一次 CAS，不产生两份互相不一致的日志。
 */

import { isDesktopAbsolutePath, relativePathToContentUri } from '../storage/index.js';

import { ArtifactsHostError } from './errors.js';
import {
  CATALOG_SCHEMA_VERSION,
  type ArtifactFilter,
  type ArtifactGroup,
  type ArtifactRecord,
  type ArtifactVersion,
  type ShareCredential,
} from './types.js';

// ---------------------------------------------------------------------------
// 内部形状（对外不承诺稳定；README 明确标注）
// ---------------------------------------------------------------------------

/** 内部分享记录：`expiresAt` 存 ISO 串，比较用 `Date.parse`。 */
export interface ShareRecord {
  readonly credentialId: string;
  readonly token: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly digest: string;
  readonly blobUri: string;
  readonly mime: string;
  readonly fileName: string;
  readonly permission: 'read';
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/** 目录快照（persisted）。 */
export interface ArtifactCatalog {
  readonly schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  readonly artifactSeq: number;
  readonly shareSeq: number;
  readonly artifacts: readonly ArtifactRecord[];
  readonly shares: readonly ShareRecord[];
}

export function emptyCatalog(): ArtifactCatalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    artifactSeq: 0,
    shareSeq: 0,
    artifacts: [],
    shares: [],
  };
}

// ---------------------------------------------------------------------------
// 形状校验
// ---------------------------------------------------------------------------

/** 内容 URI 路径段允许的字符集（与 K09 `uri.ts` 的段规则一致）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** conversationId / taskId 允许 `:` 与 `-`（它们不进内容 URI，只进目录元数据）。 */
const SAFE_META_ID = /^[A-Za-z0-9._:-]+$/;
const MIME_PATTERN = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/;

function assertNonEmptyString(value: unknown, code: 'invalid_artifact_id' | 'invalid_conversation_id' | 'invalid_task_id' | 'invalid_file_name', what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArtifactsHostError(code, `${what} 必须是非空字符串`, typeof value === 'string' ? value : String(value));
  }
  return value;
}

/** 校验 artifactId：可安全作为内容 URI 路径段的单个段。 */
export function assertArtifactId(value: unknown): string {
  const id = assertNonEmptyString(value, 'invalid_artifact_id', 'artifactId');
  if (isDesktopAbsolutePath(id) || !SAFE_SEGMENT.test(id) || id === '.' || id === '..') {
    throw new ArtifactsHostError('invalid_artifact_id', 'artifactId 必须是可安全放进内容 URI 的段（[A-Za-z0-9._-]）', id);
  }
  return id;
}

export function assertConversationId(value: unknown): string {
  const id = assertNonEmptyString(value, 'invalid_conversation_id', 'conversationId');
  if (isDesktopAbsolutePath(id) || !SAFE_META_ID.test(id)) {
    throw new ArtifactsHostError('invalid_conversation_id', 'conversationId 形状非法', id);
  }
  return id;
}

export function assertTaskId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = assertNonEmptyString(value, 'invalid_task_id', 'taskId');
  if (isDesktopAbsolutePath(id) || !SAFE_META_ID.test(id)) {
    throw new ArtifactsHostError('invalid_task_id', 'taskId 形状非法', id);
  }
  return id;
}

export function assertMime(value: unknown): string {
  if (value === undefined || value === null) return 'application/octet-stream';
  if (typeof value !== 'string' || !MIME_PATTERN.test(value)) {
    throw new ArtifactsHostError('invalid_mime', 'mime 必须是 type/subtype 形状', typeof value === 'string' ? value : String(value));
  }
  return value;
}

// ---------------------------------------------------------------------------
// 无明文红线：自由文本扫描（单字段 + 整份目录）
// ---------------------------------------------------------------------------

/**
 * 明文密钥形状（与 K02 `model/redact.ts` 同源判据）。`sk-` 的**左边界**是必需的：
 * 没有它，`task-registered` 里藏着的 `sk-` 子串会被误报。
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * 目录里**任何位置**出现的电脑盘符路径（`C:\` / `C:/`）。
 *
 * 用左边界 `(?<![A-Za-z0-9])` 区分"真盘符"与 `content://`：后者的 `t:/` 前面是字母 `n`，
 * 不匹配；而 `"C:/Users"` 里的 `C` 前面是引号（非字母数字），匹配。这样每一条合法的
 * `content://potbot/…` 都不会被误当成盘符路径。
 */
export const EMBEDDED_DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/;

/** 扫描一段自由文本里的红线；命中即抛，**绝不返回**。 */
export function assertTextFreeOfSecretsAndPaths(text: string, what: string): void {
  if (isDesktopAbsolutePath(text) || EMBEDDED_DRIVE_PATH.test(text)) {
    throw new ArtifactsHostError('desktop_path_rejected', `${what} 不得含电脑绝对路径`, text);
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new ArtifactsHostError('plaintext_secret_in_catalog', `${what} 含明文密钥形状，拒绝落盘`, text);
    }
  }
}

/** 校验 fileName：非空、无路径分隔符、无 `..`，并通过红线扫描。 */
export function assertFileName(value: unknown): string {
  const name = assertNonEmptyString(value, 'invalid_file_name', 'fileName');
  // 先跑红线：绝对路径（含 `C:\…`）与明文密钥要拿到**可区分**的拒因，而不是被
  // "含路径分隔符"这种形状拒因盖掉——否则验收分不清"它识别了盘符"还是"它只是没认出来"。
  assertTextFreeOfSecretsAndPaths(name, 'fileName');
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new ArtifactsHostError('invalid_file_name', 'fileName 不得含路径分隔符或为 . / ..', name);
  }
  return name;
}

function walkStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (value instanceof Uint8Array) void 0;
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) walkStrings(item, out);
}

/**
 * 对**整份目录**（含所有 artifact 版本字段、分享记录字段）跑红线扫描。
 * 这是写目录前的最后一道闸：即便某个字段此前漏验，这里也会把它咬出来，**不落盘**。
 */
export function assertCatalogNoPlaintext(catalog: ArtifactCatalog): void {
  const strings: string[] = [];
  walkStrings(catalog, strings);
  for (const text of strings) {
    assertTextFreeOfSecretsAndPaths(text, '目录快照字段');
  }
}

// ---------------------------------------------------------------------------
// file 名 → 扩展名 → 版本 blob URI
// ---------------------------------------------------------------------------

/** 从 fileName 取一个**安全**的扩展名（只保留 `[A-Za-z0-9]{1,8}`）；取不到用 `bin`。 */
export function extensionFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return 'bin';
  const candidate = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : 'bin';
}

/** 某一版本的内容 URI —— 每版**独立**，从不覆盖上一版。 */
export function artifactBlobUri(artifactId: string, artifactVersion: number, extension: string): string {
  return relativePathToContentUri(`artifacts/${artifactId}/v${String(artifactVersion)}.${extension}`);
}

// ---------------------------------------------------------------------------
// 查找 / 归集
// ---------------------------------------------------------------------------

export function findArtifact(catalog: ArtifactCatalog, artifactId: string): ArtifactRecord | undefined {
  return catalog.artifacts.find((record) => record.artifactId === artifactId);
}

export function latestVersion(record: ArtifactRecord): ArtifactVersion | undefined {
  return record.versions.length === 0 ? undefined : record.versions[record.versions.length - 1];
}

export function versionOf(record: ArtifactRecord, artifactVersion: number): ArtifactVersion | undefined {
  return record.versions.find((version) => version.artifactVersion === artifactVersion);
}

export function findShareByToken(catalog: ArtifactCatalog, token: string): ShareRecord | undefined {
  return catalog.shares.find((share) => share.token === token);
}

export function findShareById(catalog: ArtifactCatalog, credentialId: string): ShareRecord | undefined {
  return catalog.shares.find((share) => share.credentialId === credentialId);
}

export function toShareView(record: ShareRecord): ShareCredential {
  return Object.freeze({
    credentialId: record.credentialId,
    token: record.token,
    artifactId: record.artifactId,
    artifactVersion: record.artifactVersion,
    digest: record.digest,
    blobUri: record.blobUri,
    mime: record.mime,
    fileName: record.fileName,
    permission: record.permission,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  });
}

/**
 * 按 `keyOf` 归集。key 为 null 的桶**排最后**（未归属任务不抢占有序 bucket 的位置）。
 * 桶内 artifact 按 artifactId 升序，保证结果确定。
 */
export function groupArtifactsBy(
  records: readonly ArtifactRecord[],
  keyOf: (record: ArtifactRecord) => string | null,
): readonly ArtifactGroup[] {
  const buckets = new Map<string | null, ArtifactRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [record]);
    else bucket.push(record);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(
    keys.map((key) =>
      Object.freeze({
        key,
        artifacts: Object.freeze([...buckets.get(key)!].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0))),
      }),
    ),
  );
}

export function filterArtifacts(records: readonly ArtifactRecord[], filter: ArtifactFilter | undefined): readonly ArtifactRecord[] {
  if (filter === undefined) return Object.freeze([...records]);
  return Object.freeze(
    records.filter((record) => {
      if (filter.conversationId !== undefined && record.conversationId !== filter.conversationId) return false;
      if (filter.taskId !== undefined && record.taskId !== filter.taskId) return false;
      if (filter.hasTask !== undefined && (record.taskId !== null) !== filter.hasTask) return false;
      return true;
    }),
  );
}

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

export function serializeCatalog(catalog: ArtifactCatalog): string {
  return JSON.stringify(catalog);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is ArtifactVersion {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['artifactVersion'] === 'number' &&
    typeof value['digest'] === 'string' &&
    typeof value['byteLength'] === 'number' &&
    typeof value['mime'] === 'string' &&
    typeof value['blobUri'] === 'string' &&
    typeof value['createdAt'] === 'string'
  );
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!isPlainObject(value)) return false;
  const taskId = value['taskId'];
  return (
    typeof value['artifactId'] === 'string' &&
    typeof value['conversationId'] === 'string' &&
    (taskId === null || typeof taskId === 'string') &&
    typeof value['fileName'] === 'string' &&
    typeof value['mime'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string' &&
    Array.isArray(value['versions']) &&
    value['versions'].every(isVersion)
  );
}

function isShareRecord(value: unknown): value is ShareRecord {
  if (!isPlainObject(value)) return false;
  const expiresAt = value['expiresAt'];
  const revokedAt = value['revokedAt'];
  return (
    typeof value['credentialId'] === 'string' &&
    typeof value['token'] === 'string' &&
    typeof value['artifactId'] === 'string' &&
    typeof value['artifactVersion'] === 'number' &&
    typeof value['digest'] === 'string' &&
    typeof value['blobUri'] === 'string' &&
    typeof value['mime'] === 'string' &&
    typeof value['fileName'] === 'string' &&
    value['permission'] === 'read' &&
    typeof value['issuedAt'] === 'string' &&
    (expiresAt === null || typeof expiresAt === 'string') &&
    (revokedAt === null || typeof revokedAt === 'string')
  );
}

/** 解析目录快照 JSON 值；形状不符抛 `catalog_shape_invalid`——**不猜、不修复**。 */
export function parseCatalog(value: unknown, uri: string): ArtifactCatalog {
  if (!isPlainObject(value) || value['schemaVersion'] !== CATALOG_SCHEMA_VERSION) {
    throw new ArtifactsHostError('catalog_shape_invalid', '目录快照缺少 schemaVersion 或版本不匹配', uri);
  }
  if (!Array.isArray(value['artifacts']) || !value['artifacts'].every(isArtifactRecord)) {
    throw new ArtifactsHostError('catalog_shape_invalid', '目录快照 artifacts 不是合法记录数组', uri);
  }
  if (!Array.isArray(value['shares']) || !value['shares'].every(isShareRecord)) {
    throw new ArtifactsHostError('catalog_shape_invalid', '目录快照 shares 不是合法记录数组', uri);
  }
  const artifactSeq = value['artifactSeq'];
  const shareSeq = value['shareSeq'];
  if (typeof artifactSeq !== 'number' || typeof shareSeq !== 'number') {
    throw new ArtifactsHostError('catalog_shape_invalid', '目录快照缺少序号字段', uri);
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    artifactSeq,
    shareSeq,
    artifacts: value['artifacts'] as readonly ArtifactRecord[],
    shares: value['shares'] as readonly ShareRecord[],
  };
}
