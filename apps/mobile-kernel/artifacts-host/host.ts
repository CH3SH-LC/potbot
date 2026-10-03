/**
 * K09 `artifacts-host/` —— **产物仓宿主**：把 `catalog.ts` 的纯逻辑编排到 K09 `StoragePort` 上。
 *
 * ## 一次发布发生了什么（版本只追加 + 幂等）
 *
 * ```
 *  校验(ids/fileName/mime) → 收齐分片、算摘要(纯 TS SHA-256)
 *   → 读目录(CAS 基线; 坏快照 fail-closed)
 *   → 若当前版本摘要 == 新摘要 ⇒ 幂等命中，不写任何字节，返回既有版本
 *   → 写内容到【该版本专属的新 URI】(从不覆盖上一版) + 与存储回执交叉核对
 *   → 以读到的版本号 CAS 目录；冲突则重读重试；超限抛 write_conflict（绝不盲写）
 * ```
 *
 * **为什么内容先写、目录后 CAS**：目录是"哪些版本存在"的索引。先落内容再登记，最坏情况是
 * 一个**无人引用**的孤儿 blob（可回收）；反过来先登记后写内容，则会留下**指向不存在字节**的
 * 悬空版本——那是"声称有产物但读不回来"，比孤儿危险得多。
 *
 * ## 坏目录快照 fail-closed
 *
 * 目录存在但**读回摘要不符 / 非法 JSON / 形状不符**时抛错（`catalog_integrity_failed` /
 * `catalog_malformed` / `catalog_shape_invalid`），**绝不**当成"空目录"——否则一次真实读失败
 * 会被静默降级成"什么产物都没有"，已交付的文件就此从账上消失（对照 K09 `blob-port.ts` 的三态读取）。
 */

import {
  DIGEST_PREFIX,
  Sha256,
  isSha256Digest,
  relativePathToContentUri,
  sha256Digest,
  toBytes,
  utf8Decode,
  type BytesLike,
  type ReadBackCredential,
  type StoragePort,
} from '../storage/index.js';

import {
  artifactBlobUri,
  assertArtifactId,
  assertCatalogNoPlaintext,
  assertConversationId,
  assertFileName,
  assertMime,
  assertTaskId,
  emptyCatalog,
  extensionFor,
  filterArtifacts,
  findArtifact,
  findShareById,
  findShareByToken,
  groupArtifactsBy,
  latestVersion,
  parseCatalog,
  serializeCatalog,
  toShareView,
  versionOf,
  type ArtifactCatalog,
} from './catalog.js';
import { ArtifactsHostError } from './errors.js';
import {
  DEFAULT_CATALOG_RELATIVE_PATH,
  type ArtifactFilter,
  type ArtifactGroup,
  type ArtifactRecord,
  type ArtifactVersion,
  type ArtifactsHost,
  type ArtifactsHostOptions,
  type IssueShareRequest,
  type PublishArtifactRequest,
  type PublishArtifactResult,
  type ReadArtifactRequest,
  type ReadArtifactResult,
  type RevokeShareResult,
  type ShareCredential,
  type ShareVerification,
} from './types.js';

interface CatalogRead {
  readonly present: boolean;
  /** 当前实存版本（present=false 时为 0 = CAS 的"期望不存在"基线）。 */
  readonly revision: number;
  readonly catalog: ArtifactCatalog;
}

interface NamedCatalog {
  readonly catalog: ArtifactCatalog;
  readonly displayName: string;
}

export function createArtifactsHost(options: ArtifactsHostOptions): ArtifactsHost {
  const storage = options.storage;
  const now = options.now ?? (() => Date.now());
  const catalogUri = relativePathToContentUri(options.catalogRelativePath ?? DEFAULT_CATALOG_RELATIVE_PATH);
  const maxAttempts = options.maxWriteAttempts ?? 8;

  function iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** 读目录；不存在 ⇒ 空目录（干净起点）。存在但不可信 ⇒ 抛，**绝不**当空目录。 */
  function readCatalog(): CatalogRead {
    const read = storage.readBlob(catalogUri);
    if (read.status !== 'ok' || read.bytes === null || read.blob === null) {
      return { present: false, revision: 0, catalog: emptyCatalog() };
    }
    const verify = storage.readBack({ uri: catalogUri, expectedDigest: read.blob.digest });
    if (verify.status !== 'ok' || verify.readBack === null || !verify.readBack.verified) {
      throw new ArtifactsHostError(
        'catalog_integrity_failed',
        '目录快照读回摘要与写入时记录的不符（介质损坏或被篡改）',
        catalogUri,
      );
    }
    let text: string;
    try {
      text = utf8Decode(read.bytes);
    } catch (error) {
      throw new ArtifactsHostError('catalog_malformed', `目录快照字节不是合法 UTF-8：${messageOf(error)}`, catalogUri);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ArtifactsHostError('catalog_malformed', `目录快照不是合法 JSON：${messageOf(error)}`, catalogUri);
    }
    return { present: true, revision: read.revision ?? 0, catalog: parseCatalog(parsed, catalogUri) };
  }

  /** 以 CAS 写目录：读-改-写带重试；冲突重读重试，超限抛 `write_conflict`（绝不盲写）。 */
  function writeCatalog(mutate: (current: ArtifactCatalog) => NamedCatalog): ArtifactCatalog {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = readCatalog();
      const { catalog: next, displayName } = mutate(current.catalog);
      assertCatalogNoPlaintext(next);
      const result = storage.compareAndSwap({
        uri: catalogUri,
        expectedRevision: current.revision,
        bytes: serializeCatalog(next),
      });
      if (result.status === 'ok') return next;
      if (result.status === 'conflict') continue;
      throw new ArtifactsHostError('write_failed', `存储端口返回 ${result.status}，目录写入未生效`, displayName);
    }
    throw new ArtifactsHostError('write_conflict', `连续 ${String(maxAttempts)} 次版本冲突，放弃写入`, catalogUri);
  }

  async function publish(request: PublishArtifactRequest): Promise<PublishArtifactResult> {
    const conversationId = assertConversationId(request.conversationId);
    const taskId = assertTaskId(request.taskId);
    const fileName = assertFileName(request.fileName);
    const mime = assertMime(request.mime);
    const explicitId = request.artifactId === undefined ? null : assertArtifactId(request.artifactId);

    const bytes = await collectBytes(request.chunks);
    const digest = sha256Digest(bytes);
    const extension = extensionFor(fileName);

    // 外层重试：CAS 冲突时**从全新目录重算版本号与 blob URI**，避免版本号错位。
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = readCatalog();
      const artifactId = explicitId ?? `art-${String(current.catalog.artifactSeq + 1)}`;
      const existing = findArtifact(current.catalog, artifactId);

      // 幂等：内容与当前版本一致 ⇒ 不新增版本，不写字节。
      if (existing !== undefined) {
        const last = latestVersion(existing);
        if (last !== undefined && last.digest === digest) {
          return { status: 'ok', artifact: existing, version: last, created: false, idempotent: true };
        }
      }

      const artifactVersion = (existing?.versions.length ?? 0) + 1;
      const blobUri = artifactBlobUri(artifactId, artifactVersion, extension);
      const written = await storage.writeStream({ uri: blobUri, chunks: [bytes] });
      if (written.status !== 'ok' || written.write.digest !== digest || written.write.bytesWritten !== bytes.length) {
        throw new ArtifactsHostError(
          'content_digest_mismatch',
          `存储端口写回摘要/字节数与自算不符（写入不可信）：store=${written.write.digest}/${String(written.write.bytesWritten)} self=${digest}/${String(bytes.length)}`,
          blobUri,
        );
      }

      const timestamp = iso(now());
      const version: ArtifactVersion = {
        artifactVersion,
        digest,
        byteLength: bytes.length,
        mime,
        blobUri,
        createdAt: timestamp,
      };
      const record: ArtifactRecord = {
        artifactId,
        conversationId,
        taskId: existing?.taskId ?? taskId,
        fileName: existing?.fileName ?? fileName,
        mime: existing?.mime ?? mime,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        versions: Object.freeze([...(existing?.versions ?? []), Object.freeze(version)]),
      };
      const nextCatalog: ArtifactCatalog = {
        schemaVersion: current.catalog.schemaVersion,
        artifactSeq: explicitId === null && existing === undefined ? current.catalog.artifactSeq + 1 : current.catalog.artifactSeq,
        shareSeq: current.catalog.shareSeq,
        artifacts: Object.freeze(upsertArtifact(current.catalog.artifacts, record)),
        shares: current.catalog.shares,
      };

      assertCatalogNoPlaintext(nextCatalog);
      const cas = storage.compareAndSwap({
        uri: catalogUri,
        expectedRevision: current.revision,
        bytes: serializeCatalog(nextCatalog),
      });
      if (cas.status === 'ok') {
        return { status: 'ok', artifact: record, version, created: existing === undefined, idempotent: false };
      }
      if (cas.status === 'conflict') continue; // 期间有别的写者推进：重读重试（孤儿内容可回收）。
      throw new ArtifactsHostError('write_failed', `存储端口返回 ${cas.status}，发布未生效`, artifactId);
    }
    throw new ArtifactsHostError('write_conflict', `连续 ${String(maxAttempts)} 次版本冲突，放弃发布`, fileName);
  }

  function listVersions(artifactId: string): readonly ArtifactVersion[] {
    const id = assertArtifactId(artifactId);
    const artifact = findArtifact(readCatalog().catalog, id);
    if (artifact === undefined) return Object.freeze([]);
    // 版本列表倒序（最新在前），与"版本列表"的直觉一致；副本并冻结。
    return Object.freeze([...artifact.versions].reverse().map((version) => Object.freeze({ ...version })));
  }

  function getArtifact(artifactId: string): ArtifactRecord | null {
    const id = assertArtifactId(artifactId);
    return findArtifact(readCatalog().catalog, id) ?? null;
  }

  function readArtifact(request: ReadArtifactRequest): ReadArtifactResult {
    const id = assertArtifactId(request.artifactId);
    const artifact = findArtifact(readCatalog().catalog, id);
    if (artifact === undefined) {
      return { status: 'not-found', artifactId: id, artifactVersion: null, bytes: null, readBack: null };
    }
    const version = request.artifactVersion === undefined ? latestVersion(artifact) : versionOf(artifact, request.artifactVersion);
    if (version === undefined) {
      return { status: 'not-found', artifactId: id, artifactVersion: null, bytes: null, readBack: null };
    }
    const read = storage.readBlob(version.blobUri);
    if (read.status !== 'ok' || read.bytes === null) {
      return { status: 'not-found', artifactId: id, artifactVersion: version.artifactVersion, bytes: null, readBack: null };
    }
    const expectedDigest = request.expectedDigest ?? version.digest;
    if (!isSha256Digest(expectedDigest)) {
      // 传给存储端口前先自校期望摘要形状，避免把形状错误当成"读回失败"。
      throw new ArtifactsHostError('invalid_expected_digest', 'expectedDigest 必须是 sha256:<64 hex>', String(request.expectedDigest));
    }
    const readBack = storage.readBack({ uri: version.blobUri, expectedDigest });
    const credential: ReadBackCredential | null = readBack.readBack;
    const verified = readBack.status === 'ok' && credential !== null && credential.verified;
    return {
      status: verified ? 'ok' : 'failed',
      artifactId: id,
      artifactVersion: version.artifactVersion,
      bytes: read.bytes,
      readBack: credential,
    };
  }

  function listArtifacts(filter?: ArtifactFilter): readonly ArtifactRecord[] {
    return filterArtifacts(readCatalog().catalog.artifacts, filter);
  }

  function groupByConversation(): readonly ArtifactGroup[] {
    return groupArtifactsBy(readCatalog().catalog.artifacts, (record) => record.conversationId);
  }

  function groupByTask(): readonly ArtifactGroup[] {
    return groupArtifactsBy(readCatalog().catalog.artifacts, (record) => record.taskId);
  }

  function issueShare(request: IssueShareRequest): ShareCredential {
    const artifactId = assertArtifactId(request.artifactId);
    if (request.ttlMs !== undefined && (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0)) {
      throw new ArtifactsHostError('invalid_share_ttl', 'ttlMs 必须是正数', String(request.ttlMs));
    }
    const artifact = findArtifact(readCatalog().catalog, artifactId);
    if (artifact === undefined) {
      throw new ArtifactsHostError('artifact_not_found', '签发分享的对象不存在', artifactId);
    }
    const version = request.artifactVersion === undefined ? latestVersion(artifact) : versionOf(artifact, request.artifactVersion);
    if (version === undefined) {
      throw new ArtifactsHostError('version_not_found', '签发分享的目标版本不存在', artifactId);
    }
    const issuedAtMs = now();
    const issuedAt = iso(issuedAtMs);
    const expiresAt = request.ttlMs === undefined ? null : iso(issuedAtMs + request.ttlMs);

    // CAS：把新分享记录进目录。credentialId / token 在重试时随当前 shareSeq 重算。
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = readCatalog();
      const credentialId = `share-${String(current.catalog.shareSeq + 1)}`;
      const token = shareToken(credentialId, artifactId, version.artifactVersion, version.digest, issuedAt);
      const record = {
        credentialId,
        token,
        artifactId,
        artifactVersion: version.artifactVersion,
        digest: version.digest,
        blobUri: version.blobUri,
        mime: version.mime,
        fileName: artifact.fileName,
        permission: 'read' as const,
        issuedAt,
        expiresAt,
        revokedAt: null,
      };
      const nextCatalog: ArtifactCatalog = {
        schemaVersion: current.catalog.schemaVersion,
        artifactSeq: current.catalog.artifactSeq,
        shareSeq: current.catalog.shareSeq + 1,
        artifacts: current.catalog.artifacts,
        shares: Object.freeze([...current.catalog.shares, Object.freeze(record)]),
      };
      assertCatalogNoPlaintext(nextCatalog);
      const cas = storage.compareAndSwap({
        uri: catalogUri,
        expectedRevision: current.revision,
        bytes: serializeCatalog(nextCatalog),
      });
      if (cas.status === 'ok') return toShareView(record);
      if (cas.status === 'conflict') continue;
      throw new ArtifactsHostError('write_failed', `存储端口返回 ${cas.status}，分享签发未生效`, credentialId);
    }
    throw new ArtifactsHostError('write_conflict', `连续 ${String(maxAttempts)} 次版本冲突，放弃签发分享`, artifactId);
  }

  function verifyShare(token: string): ShareVerification {
    if (typeof token !== 'string' || token.length === 0) {
      return { status: 'unknown', share: null };
    }
    const record = findShareByToken(readCatalog().catalog, token);
    if (record === undefined) return { status: 'unknown', share: null };
    const view = toShareView(record);
    if (record.revokedAt !== null) return { status: 'revoked', share: view };
    if (record.expiresAt !== null && now() >= Date.parse(record.expiresAt)) return { status: 'expired', share: view };
    return { status: 'ok', share: view };
  }

  function revokeShare(credentialId: string): RevokeShareResult {
    if (typeof credentialId !== 'string' || credentialId.length === 0) {
      throw new ArtifactsHostError('share_not_found', 'credentialId 不能为空', String(credentialId));
    }
    let changed = false;
    writeCatalog((current) => {
      const existing = findShareById(current, credentialId);
      if (existing === undefined) {
        throw new ArtifactsHostError('share_not_found', '要撤销的分享凭据不存在', credentialId);
      }
      if (existing.revokedAt !== null) return { catalog: current, displayName: credentialId }; // 幂等
      changed = true;
      const revokedAt = iso(now());
      const shares = current.shares.map((share) =>
        share.credentialId === credentialId ? Object.freeze({ ...share, revokedAt }) : share,
      );
      return { catalog: { ...current, shares: Object.freeze(shares) }, displayName: credentialId };
    });
    return { credentialId, revoked: true, changed };
  }

  function listShares(artifactId?: string): readonly ShareCredential[] {
    const id = artifactId === undefined ? null : assertArtifactId(artifactId);
    const shares = readCatalog().catalog.shares;
    return Object.freeze(
      shares
        .filter((share) => id === null || share.artifactId === id)
        .map((share) => toShareView(share)),
    );
  }

  return Object.freeze({
    publish,
    listVersions,
    getArtifact,
    readArtifact,
    listArtifacts,
    groupByConversation,
    groupByTask,
    issueShare,
    verifyShare,
    revokeShare,
    listShares,
    catalogUri: () => catalogUri,
  });
}

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

function upsertArtifact(records: readonly ArtifactRecord[], record: ArtifactRecord): readonly ArtifactRecord[] {
  const kept = records.filter((existing) => existing.artifactId !== record.artifactId);
  return [...kept, record];
}

/**
 * 不透明分享令牌：`share_<64 hex>`，由凭据身份字段的 SHA-256 派生。
 *
 * 它**不含**内容明文、不含平台路径、不随内容变化泄漏任何可读信息。注意：本派生是**确定性**的
 * （同输入同令牌），便于 fixture 校验结构；真实实现若要防猜测，应混入平台随机源。此局限
 * 已登记在 README，未声称具备密码学不可预测性。
 */
function shareToken(credentialId: string, artifactId: string, artifactVersion: number, digest: string, issuedAt: string): string {
  const material = [credentialId, artifactId, String(artifactVersion), digest, issuedAt].join('|');
  return `share_${sha256Digest(material).slice(DIGEST_PREFIX.length)}`;
}

async function collectBytes(chunks: Iterable<BytesLike> | AsyncIterable<BytesLike>): Promise<Uint8Array> {
  if (chunks === undefined || chunks === null) {
    throw new ArtifactsHostError('missing_content_source', 'publish 需要 chunks 分片来源', null);
  }
  const hasher = new Sha256();
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    let bytes: Uint8Array;
    if (typeof chunk === 'string') bytes = toBytes(chunk);
    else if (chunk instanceof Uint8Array) bytes = chunk;
    else throw new ArtifactsHostError('invalid_content_chunk', '分片必须是 Uint8Array 或 string', null);
    hasher.update(bytes);
    parts.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  // 自检：增量摘要必须与整块摘要一致（防"边收边算"与最终拼接不一致）。
  if (DIGEST_PREFIX + toHexOf(hasher.digest()) !== sha256Digest(out)) {
    throw new ArtifactsHostError('content_digest_mismatch', '增量摘要与整块摘要不一致（发布实现错误）', null);
  }
  return out;
}

function toHexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
