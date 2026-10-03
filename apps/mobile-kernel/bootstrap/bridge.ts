/**
 * K01 —— 受限的本地 UI 桥（信任边界）。
 *
 * 桥是 WebView 页面与手机内核之间**唯一**的入口。它只做三件事，且**每个**入口先过
 * 调用方 / 本地 origin 校验（K01 写权：`apps/mobile-kernel/bootstrap/`）：
 *
 *   1. `submit(caller, command)`  —— 提交一条 `mobile-v1` 命令；
 *   2. `subscribe(caller, listener)` —— 订阅事件流，返回可 `unsubscribe` 的订阅；
 *   3. `cancel(caller, commandId)` —— 中止在飞命令。
 *
 * 桥**不**暴露：任意文件读写、密钥原文、代码执行。载荷里的密钥/绝对路径/代码字段由
 * 运行时 `scanPayload` 拒绝（见 guard.ts）；桥只负责 origin/调用方这一道门。
 *
 * 组合关系：`bridge` 是薄封装，业务状态与事件归 `runtime` 所有；桥不复制运行时状态。
 */

import { assertCaller, DEFAULT_ALLOWED_ORIGINS } from './origin.js';
import type {
  BootstrapRuntime,
  CallerIdentity,
  CallerKind,
  EventListener,
  LocalUiBridge,
  LocalUiBridgeOptions,
  Subscription,
} from './types.js';

export function createLocalUiBridge(runtime: BootstrapRuntime, options: LocalUiBridgeOptions = {}): LocalUiBridge {
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const allowedKinds: readonly CallerKind[] | undefined = options.allowedKinds;

  const guard = (caller: unknown): CallerIdentity => assertCaller(caller, allowedOrigins, allowedKinds);

  return {
    // async：让 origin 校验失败也走 rejected promise（WebView 桥一律 promise 语义）。
    async submit(caller: CallerIdentity, command: unknown) {
      guard(caller);
      return runtime.dispatch(command);
    },
    subscribe(caller: CallerIdentity, listener: EventListener): Subscription {
      guard(caller);
      return runtime.subscribe(listener);
    },
    cancel(caller: CallerIdentity, commandId: string): boolean {
      guard(caller);
      if (typeof commandId !== 'string' || commandId.length === 0) {
        throw new TypeError('cancel 需要非空 commandId');
      }
      return runtime.cancelInFlight(commandId);
    },
  };
}
