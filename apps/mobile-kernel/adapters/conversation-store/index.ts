/**
 * K-I05 会话持久化适配层 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/adapters/conversation-store/**`（K-I05 独占写区）。
 * 本包只**新建**适配层，把 K04 的三个平台无关端口（`MobileConversationPersistencePort` /
 * `CurrentDocumentFactPort` / `ArtifactRegistryPort`）接到 K09 的 `StoragePort` 上；
 * 未改动 `apps/mobile-kernel/conversation/**`、`apps/mobile-kernel/storage/**` 及任何共享配置。
 * 把适配层接进手机内核宿主（K01 runtime）是后续集成人的活。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（拒因）→ `guards.ts` → `codec.ts`（快照编解码）→
 * `storage-snapshot.ts`（快照读写内核 + CAS）→ `conversation-persistence.ts` /
 * `current-document-facts.ts` / `artifact-registry.ts`（三个端口实现）。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './errors.js';
export * from './guards.js';
export * from './codec.js';
export * from './storage-snapshot.js';
export * from './conversation-persistence.js';
export * from './current-document-facts.js';
export * from './artifact-registry.js';
