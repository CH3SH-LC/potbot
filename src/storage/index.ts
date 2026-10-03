/**
 * `src/storage` 公开出口（D01；落盘实现见 design-06-P5）。
 *
 * 存储合同（接口、事务边界、待投递事件）定义在 `src/protocol/storage.ts`；
 * 本目录提供**具体实现**。下游 D02–D09 通过本模块取得实现，通过 `src/protocol`
 * 取得接口与类型，二者不重复定义。
 *
 * 两个实现是**同一个 `Store` 接口的两个介质**，共享 `store-core.ts` 的事务机制：
 * - `createMemoryStore()` —— 易失，进程退出即空（单进程 / 测试用）；
 * - `createFileStore()`   —— 可落盘、跨进程、跨重启（KRN-10 / R214–R220 用）。
 *
 * 选型纪律：**不得**用内存实现冒充持久实现。需要跨重启语义的地方一律用 file-store，
 * 否则就是 R220 明令禁止的"把 Map 当完整恢复"。
 */

export { createMemoryStore } from './memory-store.js';
export {
  createFileStore,
  FileStorePersistenceError,
  __deleteStoreFiles,
  type FileStore,
  type FileStoreFailureReason,
  type FileStoreHooks,
  type FileStoreOptions,
  type LoadReport,
} from './file-store.js';
export {
  logicalTimeHighWater,
  STORE_SCHEMA,
  encodeStoreState,
  decodeStoreState,
  type DecodeResult,
  type SerializedStoreState,
  type StoreState,
} from './store-core.js';
