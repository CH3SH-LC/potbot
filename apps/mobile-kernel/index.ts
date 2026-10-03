/**
 * 手机内核（lane K）—— 组装出口（lane assembly barrel）。
 *
 * 本文件把本单元（K-I04）交付的**宿主装配**与它所装配的模块一起暴露：
 *
 *   - `host`      —— K-I04 宿主装配（`createKernelHost`：引导层 + 五个真实模块适配器）；
 *   - `bootstrap` —— K01 引导层（运行时 + 受限本地 UI 桥）；
 *   - `conversation` / `memory` / `dispatch` / `templates` / `actions`
 *                   —— K04 / K08 / K05 / K06 / K07 业务模块。
 *
 * 各模块用**命名空间**导出，避免同名符号冲突（如 `createManualClock` / `Clock` 在
 * bootstrap / dispatch / templates 里各有一份，且语义不同：ISO 串时钟 vs epoch 数字时钟）。
 *
 * 已知局限（不虚构）：本 barrel **只覆盖上述六个目录**；lane K 的 `storage`（K09）/
 * `lifecycle`（K02）/ `model`（K03）/ `observability` / `security` 等包由其它单元交付，
 * 尚未纳入本 barrel（见 host/README.md 的集成待办）。
 */

export * as actions from './actions/index.js';
export * as bootstrap from './bootstrap/index.js';
export * as conversation from './conversation/index.js';
export * as dispatch from './dispatch/index.js';
export * as host from './host/index.js';
export * as memory from './memory/index.js';
export * as templates from './templates/index.js';

// 最常用入口的直接导出（名字唯一，无冲突）。
export { createKernelHost } from './host/index.js';
export type { KernelHost, KernelHostOptions } from './host/index.js';
export { createBootstrapRuntime, createLocalUiBridge } from './bootstrap/index.js';
export type {
  BootstrapModule,
  BootstrapRuntime,
  CallerIdentity,
  Clock,
  Event,
  EventListener,
  LocalUiBridge,
  Subscription,
} from './bootstrap/index.js';
