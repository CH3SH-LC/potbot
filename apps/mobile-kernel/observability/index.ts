/**
 * K10 观测包 barrel（`apps/mobile-kernel/observability/**`，K10 独占写区）。
 *
 * 读法：`redact.ts`（脱敏判据）→ `errors.ts`（错误词表）→ `diagnostics.ts`（有界脱敏日志）。
 * 范围与局限见同目录 `README.md`。
 */

export * from './errors.js';
export * from './redact.js';
export * from './diagnostics.js';
