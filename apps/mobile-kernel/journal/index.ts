/**
 * 手机内核日志库 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/journal/**`（K-R02 的实现在此**产品化**，由 K-I25 落地）。
 *
 * 读法建议（按依赖顺序）：`schemas.ts`（形状 / 错误码 / 故障点）→ `errors.ts`（错误类型）→
 * `framing.ts`（帧编解码与撕裂写检测，复用 K09 纯 TS SHA-256）→ `migration.ts`（迁移步骤与链）
 * → `media.ts`（介质抽象 + 内存实现 `PersistentMedia` + 存储实现 `StorageMedia`）→
 * `journal-store.ts`（恢复 `recoverJournal` 与库句柄 `KernelJournalStore`）。
 *
 * 崩溃注入脚手架（`crashOn` / `tornSyncOn` / `mergeHooks` / `SimulatedCrash`）是**测试专用**，
 * 留在 `tests/mobile-kernel/K-R02/simulate-crash.ts`，不进产品树。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './schemas.js';
export * from './errors.js';
export * from './framing.js';
export * from './migration.js';
export * from './media.js';
export * from './journal-store.js';
