/**
 * K-I04 宿主装配 —— `createKernelHost`。
 *
 * 装配顺序（全部经注入端口，不读墙钟、不 import `node:*`）：
 *
 *   1. 建 K04 `MobileConversationStore`（会话持久端口可注入）；
 *   2. `openPhoneMemoryOrThrow` 打开 K08 记忆库——**读失败 / 损坏 / 完整性未知即抛**，
 *      绝不以空库继续（K08 红线）；
 *   3. 建 K06 `TemplateLifecycle` 与 K07 `AuthorizationLedger`（均需 `now(): number`，由注入
 *      时钟换算）；
 *   4. `createBootstrapRuntime` 建引导层，逐个 `registerModule` 五个适配器
 *      （conversation / memory / dispatch / templates / actions，operation 互不重叠）；
 *   5. `createLocalUiBridge` 建受限桥。
 *
 * 宿主**不自动启动**：调用方显式 `start()`（重复启动、未启动 dispatch 由引导层拒绝）。
 * 记忆库打开是异步的，因此本函数**异步**。
 */

import { createBootstrapRuntime, createLocalUiBridge } from '../bootstrap/index.js';
import type { BootstrapModule } from '../bootstrap/index.js';
import { MobileConversationStore } from '../conversation/index.js';
import { openPhoneMemoryOrThrow } from '../memory/index.js';
import { createTemplateLifecycle } from '../templates/index.js';
import { createAuthorizationLedger } from '../actions/index.js';
import { createActionsModule } from './actions-module.js';
import { createConversationModule } from './conversation-module.js';
import { createDispatchModule } from './dispatch-module.js';
import { createMemoryModule } from './memory-module.js';
import { createTemplatesModule } from './templates-module.js';
import { hostError } from './errors.js';
import type { KernelHost, KernelHostOptions } from './types.js';

const DEFAULT_MAX_PARALLEL = 4;

export async function createKernelHost(options: KernelHostOptions): Promise<KernelHost> {
  const clock = options.clock;

  // 模板 / 派发 / 账本都需要 `now(): number`；用注入时钟换算，模块本身不读墙钟。
  const firstTick = Date.parse(clock.now());
  if (Number.isNaN(firstTick)) {
    throw hostError('HOST_CLOCK_INVALID', `注入时钟返回的时间无法解析为 epoch 毫秒：${JSON.stringify(clock.now())}`);
  }
  const numericClock = { now: () => Date.parse(clock.now()) };

  const conversation = new MobileConversationStore({
    persistence: options.conversationPersistence ?? null,
    now: () => clock.now(),
  });

  // K08：读失败 / 损坏 / 完整性未知 ⇒ 抛，不给"默默当空库"的机会。
  const memory = await openPhoneMemoryOrThrow({
    port: options.memoryPort,
    ...(options.memoryKey === undefined ? {} : { key: options.memoryKey }),
  });

  const templates = createTemplateLifecycle({
    clock: numericClock,
    host: options.hostPlatform,
    probe: options.templateProbe,
  });

  const actions = createAuthorizationLedger({
    clock: numericClock,
    executor: options.executor ?? null,
    orderQuery: options.orderQuery ?? null,
  });

  const runtime = createBootstrapRuntime({
    clock,
    ...(options.verificationMode === undefined ? {} : { verificationMode: options.verificationMode }),
  });

  const modules: readonly BootstrapModule[] = [
    createConversationModule({ store: conversation }),
    createMemoryModule({ store: memory.store }),
    createDispatchModule({
      clock: numericClock,
      discovery: options.capabilityDiscovery,
      defaultMaxParallel: options.defaultMaxParallel ?? DEFAULT_MAX_PARALLEL,
    }),
    createTemplatesModule({ lifecycle: templates }),
    createActionsModule({ ledger: actions }),
  ];
  for (const module of modules) {
    runtime.registerModule(module);
  }

  const bridge = createLocalUiBridge(runtime, {
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.allowedKinds === undefined ? {} : { allowedKinds: options.allowedKinds }),
  });

  return {
    runtime,
    bridge,
    modules,
    clock,
    conversation,
    memory: memory.store,
    templates,
    actions,
    start(): void {
      runtime.start();
    },
    stop(): void {
      runtime.stop();
    },
    submit(caller, command) {
      return bridge.submit(caller, command);
    },
    subscribe(caller, listener) {
      return bridge.subscribe(caller, listener);
    },
    cancel(caller, commandId) {
      return bridge.cancel(caller, commandId);
    },
  };
}
