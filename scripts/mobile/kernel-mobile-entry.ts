/**
 * scripts/mobile/kernel-mobile-entry.ts
 *
 * Bundler entry for the **in-APK** kernel bundle (`assets/kernel/bootstrap.mjs`).
 *
 * 为什么单独开一个入口，而不直接用 `apps/mobile-kernel/index.ts`：
 *   - 根 barrel 会把 `host/` 拉进来，而 host 依赖 `adapters/**`（文件/内存适配器里
 *     有面向 Node 的端口实现），不适合打进手机 WebView 的单文件包。
 *   - 本入口只覆盖**平台无关**的纯 TS 模块：引导层 + 六个业务模块 + 观测层
 *     （storage / memory / model / lifecycle）。这些模块零 `node:*` import、
 *     零 Node 全局（`process` / `Buffer` / `fs`），可在 Android WebView 里直接跑。
 *
 * 每个模块用**命名空间**导出，避免同名符号冲突（如 `createManualClock` / `Clock`
 * 在 bootstrap / dispatch / templates 里各有一份且语义不同）。
 *
 * 该文件由 `scripts/mobile/bundle-kernel.mjs --entry <此文件>` 消费；不在
 * `apps/mobile-kernel/**` 之下，以免改动内核源码树（只读约束）。
 */

export * as bootstrap from '../../apps/mobile-kernel/bootstrap/index';
export * as actions from '../../apps/mobile-kernel/actions/index';
export * as conversation from '../../apps/mobile-kernel/conversation/index';
export * as dispatch from '../../apps/mobile-kernel/dispatch/index';
// NOTE: `apps/mobile-kernel/memory` 被**有意排除**。它递归引用旧脑 `src/memory/**`
// 与 `src/facts/**`，而 `src/memory/typed-scope.ts` 当前有 31 条既有 TS 类型错误
// （与本包无关，本包不得改动内核/旧脑源码）。修好那批错误后再把它加回本入口。
// export * as memory from '../../apps/mobile-kernel/memory/index';
export * as model from '../../apps/mobile-kernel/model/index';
export * as observability from '../../apps/mobile-kernel/observability/index';
export * as storage from '../../apps/mobile-kernel/storage/index';
export * as templates from '../../apps/mobile-kernel/templates/index';
export * as lifecycle from '../../apps/mobile-kernel/lifecycle/index';

// 最常用入口的直接导出，方便宿主 `import('<bundle>')` 后按名字取用。
export { createBootstrapRuntime, createLocalUiBridge } from '../../apps/mobile-kernel/bootstrap/index';
