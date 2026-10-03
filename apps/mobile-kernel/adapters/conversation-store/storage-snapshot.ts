/**
 * K-I05 会话持久化适配层 —— **快照读写内核**（零依赖）。
 *
 * ## 三种快照，一套读写
 *
 * K04 的三块关注点各落成**一个** JSON 数组快照（见 `docs/other/ds-six-lanes-2026-10-03/KERNEL.md`）：
 *
 * | 快照 | content URI | 顶层 | 合并键 |
 * |---|---|---|---|
 * | 会话记录（消息 / 事件流） | `content://potbot/conversation/records.json` | `MobileConversationRecord[]` | `conversationId` |
 * | 当前文档持久事实 | `content://potbot/conversation/current-document.json` | `CurrentDocumentFact[]` | `conversationId` |
 * | 产物登记处 | `content://potbot/conversation/artifacts.json` | `ResumableArtifact[]` | `artifactId` |
 *
 * ## 为什么是"整份数组 + CAS"而不是"每条一个 blob"
 *
 * 1. **fail-closed 的单位就是"整份快照"**：K04 的判据是"坏快照拒绝**整个 store**"。
 *    一条会话一个 blob 时，坏一条只拒一条，语义就散了；整份数组天然对应"整份拒绝"。
 * 2. `StoragePort` **没有列目录能力**，无法枚举"都有哪些会话 blob"；单快照省掉一个索引。
 * 3. 写入走 `compareAndSwap`（**同步**），正好匹配 K04 端口**同步的** `save(record): void`；
 *    版本不符返回 `conflict` 而**不是**静默覆盖——这是"不得静默覆盖"的实现基础。
 *
 * ## 写入的 fail-closed 姿态（**比内存测试替身更严**，如实登记）
 *
 * `createMemoryConversationPersistence` 是测试替身，坏快照在场时仍可 `save`（追加）。
 * 本适配层**拒绝**在不可信快照上写入：读回摘要不符（`snapshot_integrity_failed`）、
 * 字节不是合法 JSON（`snapshot_malformed`）、顶层不是数组（`snapshot_shape_invalid`）
 * 时，`save` 抛错**且不落任何字节**。理由：在无法确认当前内容的前提下覆盖，等于把
 * "读不回来"升级成"永久销毁"，那是 fail-closed 的反面。数组内**个别**条目的形状问题
 * 不阻断写入（按 key 合并时会原样保留其它条目，不销毁），K04 读回时仍会整份拒绝。
 */

import { relativePathToContentUri, type StoragePort } from '../../storage/index.js';
import { decodeSnapshot, encodeSnapshot } from './codec.js';
import { ConversationAdapterError } from './errors.js';
import { isPlainObject } from './guards.js';

/** 会话记录快照的相对路径（最终 URI 见 {@link conversationRecordsUri}）。 */
export const CONVERSATION_RECORDS_RELATIVE_PATH = 'conversation/records.json';
/** 当前文档事实快照的相对路径。 */
export const CURRENT_DOCUMENT_FACTS_RELATIVE_PATH = 'conversation/current-document.json';
/** 产物登记处快照的相对路径。 */
export const ARTIFACT_REGISTRY_RELATIVE_PATH = 'conversation/artifacts.json';

export function conversationRecordsUri(): string {
  return relativePathToContentUri(CONVERSATION_RECORDS_RELATIVE_PATH);
}

export function currentDocumentFactsUri(): string {
  return relativePathToContentUri(CURRENT_DOCUMENT_FACTS_RELATIVE_PATH);
}

export function artifactRegistryUri(): string {
  return relativePathToContentUri(ARTIFACT_REGISTRY_RELATIVE_PATH);
}

/** 一次快照读取：`present=false` 表示**确实没有**这条快照（首次运行的干净起点）。 */
export interface SnapshotRead {
  readonly present: boolean;
  /** 当前实存版本（`present=false` 时为 0 = "期望目标不存在"的 CAS 基线）。 */
  readonly revision: number;
  /** 解析出的 JSON 值（`present=false` 时为 null）。形状核对在调用方 / K04 侧做。 */
  readonly value: unknown;
}

/**
 * 读一条快照。
 *
 * - 不存在 ⇒ `{present:false}`（干净起点，**不是**"读不回来"）。
 * - 存在但**读回摘要不符** ⇒ 抛 `snapshot_integrity_failed`（介质损坏 / 被篡改）。
 * - 存在但**字节不可解码 / 非法 JSON** ⇒ 抛 `snapshot_malformed`。
 *
 * 关键：**绝不在失败时返回 `present:false`**——那会让 K04 把坏快照当首次运行。
 */
export function readSnapshot(storage: StoragePort, uri: string): SnapshotRead {
  const read = storage.readBlob(uri);
  if (read.status !== 'ok' || read.bytes === null || read.blob === null) {
    return { present: false, revision: 0, value: null };
  }
  // 摘要校验：用 readBack 重算**实际读回字节**的摘要再比对，而不是抄写时记录的值。
  const verify = storage.readBack({ uri, expectedDigest: read.blob.digest });
  if (verify.status !== 'ok' || verify.readBack === null || !verify.readBack.verified) {
    throw new ConversationAdapterError(
      'snapshot_integrity_failed',
      '快照读回摘要与写入时记录的不符（介质损坏或被篡改）',
      uri,
    );
  }
  return { present: true, revision: read.revision ?? 0, value: decodeSnapshot(read.bytes) };
}

/** 要求快照顶层是数组；否则抛 `snapshot_shape_invalid`（不猜、不覆盖）。 */
export function asSnapshotArray(value: unknown, uri: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ConversationAdapterError('snapshot_shape_invalid', '快照顶层不是数组，拒绝在其上合并写入', uri);
  }
  return value;
}

/**
 * 按 `key` 合并：替换同键条目，其余条目**原样保留**（含形状可疑的条目，交由 K04 拒绝）。
 * 不做"顺手清理"——清理会销毁可能还能被下游解读的数据。
 */
export function upsertByKey(
  entries: readonly unknown[],
  key: string,
  keyValue: string,
  value: unknown,
): readonly unknown[] {
  const kept = entries.filter((entry) => !(isPlainObject(entry) && entry[key] === keyValue));
  return [...kept, value];
}

/**
 * 读-改-写一条快照，带 CAS 版本重试。
 *
 * 每次尝试都**重新读**当前快照（含摘要校验），合并后以读到的版本做 CAS。版本冲突就重读重试，
 * 直到成功或超过上限（`write_conflict`）。**绝不**把冲突降级成一次盲写。
 *
 * @returns 写入成功后的新版本号。
 */
export function writeSnapshotCas(
  storage: StoragePort,
  uri: string,
  mutate: (current: readonly unknown[]) => readonly unknown[],
  maxAttempts = 8,
): number {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = readSnapshot(storage, uri);
    const base = snapshot.present ? asSnapshotArray(snapshot.value, uri) : [];
    const next = mutate(base);
    const result = storage.compareAndSwap({
      uri,
      expectedRevision: snapshot.revision,
      bytes: encodeSnapshot(next),
    });
    if (result.status === 'ok') {
      return result.cas.newRevision;
    }
    if (result.status === 'conflict') {
      continue; // 期间有别的写者推进了版本：重读并重试。
    }
    throw new ConversationAdapterError('write_failed', `存储端口返回 ${result.status}，写入未生效`, uri);
  }
  throw new ConversationAdapterError('write_conflict', `连续 ${String(maxAttempts)} 次版本冲突，放弃写入`, uri);
}
