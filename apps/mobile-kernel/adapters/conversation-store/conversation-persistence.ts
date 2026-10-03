/**
 * K-I05 会话持久化适配层 —— **`MobileConversationPersistencePort` 的存储端口实现**。
 *
 * 把 K04 `MobileConversationStore` 的持久端口接到 K09 的 `StoragePort` 上：整份会话记录
 * 快照存成**一个** content URI，`save` 走"读-改-写 + CAS"，`loadAll` 每次**从存储重读**
 * （不缓存）。于是"新进程 `new MobileConversationStore({persistence})` 构造即恢复、不需要
 * 先 GET"在真实存储上成立。
 *
 * 形状核对仍是 **K04 的活**：`loadAll` 只返回解析出的 `unknown`，不预校验、不修补；
 * 坏字节 / 坏形状由 K04 的 `decodeConversationRecords` 整份拒绝（fail-closed）。
 */

import type {
  MobileConversationPersistencePort,
  MobileConversationRecord,
} from '../../conversation/index.js';

import { conversationRecordsUri, readSnapshot, upsertByKey, writeSnapshotCas } from './storage-snapshot.js';
import type { StoragePort } from '../../storage/index.js';

/**
 * 造一个落在 `StoragePort` 上的会话持久端口。
 *
 * @param storage K09 存储端口（内存 `MemoryStoragePort` 或落盘 `FileStoragePort` 均可）。
 */
export function createStorageConversationPersistence(storage: StoragePort): MobileConversationPersistencePort {
  const uri = conversationRecordsUri();
  return Object.freeze({
    /** 覆盖写一条会话记录（整份快照读-改-写；同 `conversationId` 替换，其余保留）。 */
    save(record: MobileConversationRecord): void {
      writeSnapshotCas(storage, uri, (current) => upsertByKey(current, 'conversationId', record.conversationId, record));
    },
    /** 读回**全部**会话记录（原始 `unknown`，形状核对在 K04 侧）。`null` = 首次运行。 */
    loadAll(): unknown {
      const snapshot = readSnapshot(storage, uri);
      return snapshot.present ? snapshot.value : null;
    },
  });
}
