/**
 * K-I06 记忆持久化适配器 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/adapters/memory-store/**`（K-I06 独占写区）。
 * 本包只**新建**适配层，未改动 K08（`apps/mobile-kernel/memory/**`）或
 * K09（`apps/mobile-kernel/storage/**`）的任何文件——接入以"组合既有端口"完成。
 *
 * 读法：`adapter.ts`（三值读取映射 / UTF-8 解码 / remove 的诚实边界）。
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './adapter.js';
