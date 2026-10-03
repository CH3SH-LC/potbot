/**
 * K-I04 —— 手机内核宿主装配对外出口。
 *
 * 交付内容：把 K01 引导层与五个真实业务模块适配器（K04 对话 / K08 记忆 / K05 派发 /
 * K06 模板 / K07 账本）装成一个 `KernelHost`（启动/关闭 + 桥的三个入口），并导出各适配器
 * 工厂，供集成方按需重组。
 *
 * 用法：
 * ```ts
 * import { createKernelHost } from './host/index.js';
 * const host = await createKernelHost({ clock, memoryPort, capabilityDiscovery, templateProbe, hostPlatform });
 * host.start();
 * const sub = host.subscribe(caller, (event) => ui.apply(event));
 * await host.submit(caller, command);
 * host.stop();
 * ```
 *
 * 已知局限（不虚构）见 `README.md`：事件无结构化 metadata 槽（仅 `resultRef`）；
 * operation→模块的固定路由使部分模块函数暂不可经命令总线上达。
 */

export {
  HOST_ERROR_CODES,
  HostError,
  hostError,
  isHostError,
  type HostErrorCode,
} from './errors.js';

export {
  hostOp,
  hostSlot,
  isRecord,
  optionalArray,
  optionalInteger,
  optionalRecord,
  optionalString,
  payloadId,
  payloadOf,
  requireArray,
  requireInteger,
  requireRecord,
  requireString,
  type JsonRecord,
} from './payload.js';

export { failed, succeeded, toFailed } from './outcome.js';

export {
  ACTIONS_OPERATIONS,
  createActionsModule,
} from './actions-module.js';
export {
  CONVERSATION_OPERATIONS,
  createConversationModule,
} from './conversation-module.js';
export {
  createDispatchModule,
  DISPATCH_OPERATIONS,
  type DispatchModuleDeps,
} from './dispatch-module.js';
export {
  createMemoryModule,
  MEMORY_OPERATIONS,
} from './memory-module.js';
export {
  createTemplatesModule,
  TEMPLATES_OPERATIONS,
} from './templates-module.js';

export { createKernelHost } from './host.js';
export type { KernelHost, KernelHostOptions } from './types.js';
