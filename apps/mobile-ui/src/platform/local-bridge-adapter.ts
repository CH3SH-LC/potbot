/**
 * F-I01 `platform/local-bridge-adapter` —— 把**真实**的 K01 `LocalUiBridge` 适配成
 * `KernelTransport`。
 *
 * 真桥（`apps/mobile-kernel/bootstrap/bridge.ts`）的契约是：
 *   - `submit(caller, command) -> Promise<Event>`；
 *   - `subscribe(caller, listener) -> Subscription`；
 *   - `cancel(caller, commandId) -> boolean`。
 * 每个入口先过调用方 / 本地 origin 校验（`assertCaller`）。桥**不**通报通道生死，
 * 因此本适配器补一个 `onBreak` + `emitBreak`：由宿主（Android WebView onDestroy /
 * 内核 stop）在通道断开时调用 `emitBreak`，把"断流"如实注入客户端。
 *
 * 本文件**只封装、不重写**桥 —— 不复制 origin 白名单、不重实现校验、不改桥的行为；
 * 调用方身份在构造时钉住，`KernelClient` 永远拿不到裸桥、也无法伪造另一个 caller。
 *
 * 零依赖、纯 TS，不 import node 内建。
 */

import type {
  CallerIdentity,
  Event as BridgeEvent,
  LocalUiBridge,
} from '../../../../apps/mobile-kernel/bootstrap/index.js';
import type {
  KernelEventSink,
  KernelStreamBreakReason,
  KernelSubscription,
  KernelTransport,
  KernelTransportBreakNotice,
} from './types.js';

export interface LocalBridgeAdapterOptions {
  /** 真实 K01 本地 UI 桥。 */
  readonly bridge: LocalUiBridge;
  /** 已钉住的调用方身份（UI 应为 `kind:'ui-webview'` 且 origin 在白名单内）。 */
  readonly caller: CallerIdentity;
}

/** 适配器对外面：`KernelTransport` + 宿主可调用的断流注入点。 */
export interface LocalBridgeTransport extends KernelTransport {
  /**
   * 宿主在桥通道断开时调用（WebView 卸载 / 内核停止 / USB 断开）。
   * 把断流广播给**所有** `onBreak` 监听者；监听者抛错被隔离。
   */
  emitBreak(reason: KernelStreamBreakReason, detail: string): void;
  /** 当前是否仍有断流监听者（诊断用；不作为健康判据）。 */
  hasBreakListeners(): boolean;
}

export function createLocalBridgeAdapter(options: LocalBridgeAdapterOptions): LocalBridgeTransport {
  const { bridge, caller } = options;
  const breakListeners = new Set<(notice: KernelTransportBreakNotice) => void>();

  return {
    submit(command: unknown): Promise<BridgeEvent> {
      // 桥自己会先做 caller/origin 校验；此处不重复校验、不吞错。
      return bridge.submit(caller, command);
    },

    subscribe(listener: KernelEventSink): KernelSubscription {
      const subscription = bridge.subscribe(caller, listener);
      return {
        unsubscribe: () => {
          subscription.unsubscribe();
        },
      };
    },

    cancel(commandId: string): boolean {
      return bridge.cancel(caller, commandId);
    },

    onBreak(listener: (notice: KernelTransportBreakNotice) => void): KernelSubscription {
      breakListeners.add(listener);
      return {
        unsubscribe: () => {
          breakListeners.delete(listener);
        },
      };
    },

    emitBreak(reason: KernelStreamBreakReason, detail: string): void {
      const notice: KernelTransportBreakNotice = { reason, detail };
      // 快照遍历：监听者在回调里退订也不影响本次广播（I6 同源纪律）。
      for (const listener of [...breakListeners]) {
        try {
          listener(notice);
        } catch {
          // 单个断流监听者抛错不得影响其他监听者，也不得上抛给宿主。
        }
      }
    },

    hasBreakListeners(): boolean {
      return breakListeners.size > 0;
    },
  };
}
