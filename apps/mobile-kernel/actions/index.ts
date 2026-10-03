/**
 * K07 手机侧授权与提交账本 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/actions/**`（K07 独占写区，见
 * `docs/other/ds-six-lanes-2026-10-03/KERNEL.md` 的 K07 行）。本包只**新建**手机侧模块：
 * 未改动 `apps/demo/server/**`、`src/conversation/decision-bubble.ts`、`src/workledger/**`，
 * 也未把它们接进本项目——接入是后续集成人的活。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（拒因词表）→ `clock.ts`（注入时钟）→
 * `types.ts`（八态词表与结构）→ `ledger.ts`（账本实现与判据）→
 * `wire-codec.ts`（wire/领域金额与时间戳的精确换算，只在边界用）。
 */

export * from './errors.js';
export * from './clock.js';
export * from './types.js';
export * from './ledger.js';
export * from './wire-codec.js';
