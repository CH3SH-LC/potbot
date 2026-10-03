/**
 * K03 手机密钥库 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/security/**`（K03 独占写区，见
 * `docs/other/ds-six-lanes-2026-10-03/KERNEL.md` K03 行）。本包只**新建**手机侧模块，
 * 未改动任何既有目录，也未把 port 接进宿主——接入是后续集成人的活。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（拒因词表 + 明文红线）→ `keyref.ts`（引用发行/校验）→
 * `import-source.ts`（一次性通道）→ `types.ts`（契约形状与 `KeyStorePort`）→
 * `schema.ts`（operation schema 与命令校验）→ `manager.ts`（生命周期状态机）。
 *
 * 原生实现见 `apps/android/app/src/main/java/com/potbot/kernel/security/`（本包随附源码，
 * **未编译、未上真机**，见同目录 `README.md` 的局限段）。
 */

export * from './errors.js';
export * from './keyref.js';
export * from './import-source.js';
export * from './types.js';
export * from './schema.js';
export * from './manager.js';
