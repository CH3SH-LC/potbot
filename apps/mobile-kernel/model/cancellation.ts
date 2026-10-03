/**
 * K02 取消与期限 —— **可订阅的取消句柄**（零依赖）。
 *
 * ## 为什么需要一个句柄，而不是只读契约里的 `cancelled: boolean`
 *
 * 契约 `$defs.cancellation` 是**值对象**：`{token, cancelled?, deadlineMs?}`。
 * 值对象表达不了"流正在等上游、此刻用户按了取消"——等流的下一次循环再读 `cancelled`，
 * 会先卡在上游那次 `await` 上，取消要等到上游自己吐一条事件才生效。
 *
 * 所以本模块把契约值对象**扩展**成句柄：
 * - 保留 `token` / `cancelled` / `deadlineMs` 三个契约字段（`snapshot()` 可还原成纯契约对象）；
 * - 增加 `isCancelled()` 与 `onCancel(listener)`：等待中的竞速（`raceWait`）据此**被唤醒**。
 *
 * 纯契约对象依然被接受（`toCancellationHandle` 会把它包成静态句柄）——它只能表达
 * "发出前就已经取消了"这一种情形；**流中途取消必须用 `createCancellationController()`**。
 */

import type { Cancellation } from './types.js';

/** 取消订阅函数。 */
export type Unsubscribe = () => void;

/** 端口内部使用的取消句柄；同时满足契约 `Cancellation` 的形状。 */
export interface CancellationHandle extends Cancellation {
  /** 此刻是否已被取消。 */
  isCancelled(): boolean;
  /** 订阅取消事件；若订阅时**已经**取消，监听器**立即**被调用一次。返回退订函数。 */
  onCancel(listener: () => void): Unsubscribe;
  /** 还原成纯契约对象（可安全序列化/落账）。 */
  snapshot(): Cancellation;
}

/** 端口可接受的取消来源：契约值对象，或可订阅句柄。 */
export type CancellationSource = Cancellation | CancellationHandle;

function looksLikeHandle(value: CancellationSource): value is CancellationHandle {
  return typeof (value as CancellationHandle).isCancelled === 'function';
}

/**
 * 把任意取消来源归一成句柄。
 *
 * - `undefined` ⇒ 一个永不取消的句柄（token 取 `cancel:none`）。
 * - 纯契约对象 ⇒ 静态句柄：`isCancelled()` 读 `cancelled === true`；
 *   `onCancel()` 是空订阅（值对象不会变化），因此只能"发出前取消"。
 * - 句柄 ⇒ 原样返回。
 */
export function toCancellationHandle(source?: CancellationSource): CancellationHandle {
  if (source === undefined) {
    return createCancellationController('cancel:none').handle;
  }
  if (looksLikeHandle(source)) {
    return source;
  }
  const controller = createCancellationController(source.token, {
    ...(source.deadlineMs === undefined ? {} : { deadlineMs: source.deadlineMs }),
  });
  if (source.cancelled === true) {
    controller.cancel();
  }
  return controller.handle;
}

export interface CancellationController {
  /** 交给端口的句柄。 */
  readonly handle: CancellationHandle;
  /** 现在取消（幂等：重复调用不会再触发监听器）。 */
  cancel(reason?: string): void;
  readonly cancelled: boolean;
  /** 取消原因（未取消为 null）。 */
  readonly reason: string | null;
}

/**
 * 造一个可订阅的取消控制器。
 *
 * 监听器在 `cancel()` 时**同步**触发——竞速中的 `await` 因此会在同一个微任务里被唤醒，
 * 不需要轮询、不需要 sleep。
 */
export function createCancellationController(
  token: string,
  options: { readonly deadlineMs?: number } = {},
): CancellationController {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('取消令牌必须是非空字符串');
  }
  let cancelled = false;
  let reason: string | null = null;
  const listeners = new Set<() => void>();

  const handle: CancellationHandle = {
    token,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    get cancelled(): boolean {
      return cancelled;
    },
    isCancelled: () => cancelled,
    onCancel(listener: () => void): Unsubscribe {
      if (cancelled) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot(): Cancellation {
      return Object.freeze({
        token,
        cancelled,
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      });
    },
  };

  return {
    handle,
    get cancelled(): boolean {
      return cancelled;
    },
    get reason(): string | null {
      return reason;
    },
    cancel(detail?: string): void {
      if (cancelled) {
        return;
      }
      cancelled = true;
      reason = detail ?? null;
      // 复制一份再遍历：监听器可能在自己的回调里退订。
      for (const listener of Array.from(listeners)) {
        listener();
      }
      listeners.clear();
    },
  };
}
