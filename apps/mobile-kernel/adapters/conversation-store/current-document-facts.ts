/**
 * K-I05 会话持久化适配层 —— **`CurrentDocumentFactPort` 的存储端口实现**。
 *
 * 「本会话当前是哪份文档」的持久事实（只记 `conversationId` / `artifactId` / `taskId` /
 * `title`，**不记版本字段**——版本以产物登记处为准，见 K04 `resume.ts`）落到 K09 存储端口。
 *
 * 这一层是 P0 的承重墙：进程重启后 `ConversationResumeLedger` 构造即读事实，
 * `resolve(conversationId)` 不需要先 GET 会话。事实读不回来（坏快照）⇒ 抛错 ⇒ K04 记
 * `state_unreadable`，**绝不**静默当"没有事实"从而回落到某个默认文档。
 */

import type { CurrentDocumentFact, CurrentDocumentFactPort } from '../../conversation/index.js';

import { currentDocumentFactsUri, readSnapshot, upsertByKey, writeSnapshotCas } from './storage-snapshot.js';
import type { StoragePort } from '../../storage/index.js';

/** 造一个落在 `StoragePort` 上的「当前文档事实」端口。 */
export function createStorageCurrentDocumentFactPort(storage: StoragePort): CurrentDocumentFactPort {
  const uri = currentDocumentFactsUri();
  return Object.freeze({
    /** 覆盖写一条事实（同 `conversationId` 替换，其余保留）。 */
    save(fact: CurrentDocumentFact): void {
      writeSnapshotCas(storage, uri, (current) => upsertByKey(current, 'conversationId', fact.conversationId, fact));
    },
    /** 读回全部事实（原始 `unknown`）。`null` = 没有。 */
    loadAll(): unknown {
      const snapshot = readSnapshot(storage, uri);
      return snapshot.present ? snapshot.value : null;
    },
  });
}
