/**
 * K10 生命周期包 barrel（`apps/mobile-kernel/lifecycle/**`，K10 独占写区）。
 *
 * 读法：`errors.ts`（拒因词表）→ `types.ts`（三套词表 + 端口接口）→
 * `notifications.ts`（通知夹具）→ `foreground-service.ts`（前台服务 + 有界常驻）→
 * `network.ts`（断网等待/退避/恢复）→ `ledger.ts`（只追加日志 + 快照重放）→
 * `recovery.ts`（回收后的恢复计划）。
 *
 * 范围与已知局限见同目录 `README.md`。本包**未接入**任何 Android 原生进程、
 * 未改 `apps/demo/**`、未改 Android Gradle/Manifest —— 原生 `com/potbot/kernel/lifecycle/`
 * 属集成人的写区，已在集成请求里登记。
 */

export * from './errors.js';
export * from './types.js';
export * from './notifications.js';
export * from './foreground-service.js';
export * from './network.js';
export * from './ledger.js';
export * from './recovery.js';
