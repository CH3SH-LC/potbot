/**
 * `src/facts` 公开出口（design-02 A 批，W-C）。
 *
 * 本目录是**事实层**：把共享事实记录装配成给模板构建器的只读快照（`snapshot.ts`），
 * 并校验 Agent 交上来的原始事实提案（`proposal.ts`）。本文件**只做出口**，不含实现逻辑，
 * 与 `src/protocol/index.ts` / `src/artifacts/index.ts` 同纪律。
 *
 * 纯函数、零 IO：不 import `node:fs` / `node:child_process`，不含墙钟与随机数。
 */

export * from './snapshot.js';
export * from './proposal.js';

export * from './dependency-invalidation.js';
export * from './multi-artifact-update.js';
