/**
 * K09 手机侧存储端口 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/storage/**`（K09 独占写区，见
 * `docs/other/ds-six-lanes-2026-10-03/KERNEL.md` K09 行）。本包只**新建**手机侧模块，
 * 未改动任何既有目录，也未把 port 接进宿主——接入是后续集成人的活。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（拒因词表）→ `sha256.ts`（纯 TS 摘要）→
 * `uri.ts`（内容 URI 红线）→ `types.ts`（契约形状与端口接口）→
 * `fs-port.ts`（平台文件系统端口）→ `memory-store.ts`（内存实现与崩溃注入）→
 * `file-store.ts`（可落盘实现：真磁盘原子事务 + 崩溃恢复）。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './errors.js';
export * from './sha256.js';
export * from './uri.js';
export * from './types.js';
export * from './fs-port.js';
export * from './memory-store.js';
export * from './file-store.js';
export * from './blob-port.js';
