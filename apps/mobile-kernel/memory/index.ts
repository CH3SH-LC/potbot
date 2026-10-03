/**
 * K08 手机记忆线 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/memory/**`（K08 独占写区，见
 * `docs/other/ds-six-lanes-2026-10-03/KERNEL.md` K08 行）。本包只**新建**手机侧模块，
 * 复用 `src/memory/**`、`src/facts/**` 的既有纯函数层，未改动任何既有目录，
 * 也未把记忆库接进宿主——接入是后续集成人的活。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（拒因词表）→ `types.ts`（操作封套 + 长短期分类）
 * → `persistence.ts`（三值读取端口）→ `inject.ts`（会话隔离注入）→ `store.ts`（门面）。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './errors.js';
export * from './types.js';
export * from './persistence.js';
export * from './inject.js';
export * from './store.js';
