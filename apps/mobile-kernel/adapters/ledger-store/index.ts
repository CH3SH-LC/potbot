/**
 * K-I08 手机内核账本持久化适配层 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/adapters/ledger-store/**`（K-I08 独占写区）。
 *
 * ## 这一层解决什么
 *
 * K10 的 `TaskLedger` 与 K07 的 `AuthorizationLedger` 都是**单进程内存结构**：
 * 进程一死，"崩溃后能恢复"的断言就悬空。本层把两者接到 K09 的 `StoragePort` 上，
 * 让"只追加日志 → 冷启动重放"这条恢复路径**真的落盘**。
 *
 * 读法：`errors.ts`（拒因词表）→ `snapshot-envelope.ts`（信封）→ `blob-port.ts`
 * （窄 byte 端口 + K09 桥接）→ `task-ledger-store.ts`（K10）→
 * `authorization-ledger-store.ts`（K07，写前日志 + 重放）。
 *
 * 范围与已知边界见同目录 `README.md`。
 */

export * from './errors.js';
export * from './snapshot-envelope.js';
export * from './blob-port.js';
export * from './task-ledger-store.js';
export * from './authorization-ledger-store.js';
