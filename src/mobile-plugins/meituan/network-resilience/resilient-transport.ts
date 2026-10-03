/**
 * M-R04 韧性发送器 —— **只读可重试；提交"未到达才续发"**（零依赖、端口全注入）。
 *
 * ## 两条路径，纪律不同
 *
 * - {@link ResilientSender.sendRead}：只读查询，按 {@link RetryPolicy} 有界退避重试；
 *   离线时**不调用传输端口**（`transportCalls` 保持 0）。
 * - {@link ResilientSender.sendSubmit}：有副作用的提交。**只有当请求可判定未到达平台、
 *   或服务端幂等已核验时**才自动续发同一请求；其它"可能已到达"的结果一律**停下**并返回
 *   `finalAction: 'query_first'`，交由 {@link ../recovery.js planSubmitRecovery} 判下一步。
 *   离线时同样**不调用端口**，返回 `not_sent`。
 *
 * ## 为什么不用 `setTimeout`
 *
 * 等待由注入的 {@link Sleeper} 提供；测试用记录式 sleeper 即时推进并留下 `waits` 证据，
 * 生产实现用真实定时器。本模块因此保持纯逻辑、可重现、不读墙钟。
 *
 * ## 边界
 *
 * 本模块**不发真实网络请求**、不持有 token、不产生订单。真实手机 HTTPS 由注入的
 * {@link RawTransportPort} 提供（M02 `mobile-transport/`）。
 */

import { classifyOutcome } from './disposition.js';
import { planRetry } from './retry-policy.js';
import { isOnlineKind } from './network-state.js';
import type { NetworkMonitor } from './network-state.js';
import type {
  NetworkOutcome,
  RawTransportPort,
  ResilienceClock,
  RetryPlan,
  RetryPolicy,
  Sleeper,
  TransportDisposition,
} from './types.js';

/** 只读发送结果。 */
export interface ReadSendResult {
  readonly outcome: NetworkOutcome | null;
  readonly disposition: TransportDisposition | null;
  /** 实际执行的传输尝试次数（离线时为 0）。 */
  readonly attempts: number;
  /** 传输端口**真实收到**的调用次数（离线时为 0）。 */
  readonly transportCalls: number;
  readonly retried: boolean;
  readonly plan: readonly RetryPlan[];
}

/** 提交发送的终局动作。**`accepted` 只是"受理"，不是"已下单"。** */
export const SUBMIT_FINAL_ACTIONS = ['accepted', 'rejected', 'query_first', 'not_sent', 'exhausted'] as const;

export type SubmitFinalAction = (typeof SUBMIT_FINAL_ACTIONS)[number];

export interface SubmitSendResult {
  readonly outcome: NetworkOutcome | null;
  readonly disposition: TransportDisposition | null;
  readonly attempts: number;
  readonly transportCalls: number;
  readonly finalAction: SubmitFinalAction;
  /** 是否允许上层自动续发（本模块已把不安全的都挡下：`true` 仅出现于未到达/幂等已核验）。 */
  readonly mayAutoResend: boolean;
  readonly plan: readonly RetryPlan[];
}

export interface ResilientSenderOptions {
  readonly clock: ResilienceClock;
  readonly monitor: NetworkMonitor;
  /** 原始传输端口（真实手机 HTTPS 由注入方提供）。 */
  readonly transport: RawTransportPort;
  readonly sleeper: Sleeper;
  readonly readPolicy: RetryPolicy;
  readonly submitPolicy: RetryPolicy;
  readonly jitterFn?: (() => number) | null;
}

export interface SubmitSendOptions {
  /** 服务端幂等是否**已核验**（为 true 才允许对"可能已到达"的结果续发）。 */
  readonly serverIdempotencyVerified?: boolean;
}

export class ResilientSender {
  readonly #clock: ResilienceClock;
  readonly #monitor: NetworkMonitor;
  readonly #transport: RawTransportPort;
  readonly #sleeper: Sleeper;
  readonly #readPolicy: RetryPolicy;
  readonly #submitPolicy: RetryPolicy;
  readonly #jitterFn: (() => number) | null;

  constructor(options: ResilientSenderOptions) {
    if (options === null || typeof options !== 'object' || options.transport === undefined) {
      throw new Error('ResilientSender 必须注入 transport');
    }
    if (options.sleeper === undefined || options.monitor === undefined || options.clock === undefined) {
      throw new Error('ResilientSender 必须注入 clock / monitor / sleeper');
    }
    this.#clock = options.clock;
    this.#monitor = options.monitor;
    this.#transport = options.transport;
    this.#sleeper = options.sleeper;
    this.#readPolicy = options.readPolicy;
    this.#submitPolicy = options.submitPolicy;
    this.#jitterFn = options.jitterFn ?? null;
  }

  // -------------------------------------------------------------------------
  // 只读
  // -------------------------------------------------------------------------

  /** 只读查询：有界重试；离线不调用端口。 */
  async sendRead(ref: string): Promise<ReadSendResult> {
    const plan: RetryPlan[] = [];
    if (!isOnlineKind(this.#monitor.kind)) {
      const outcome: NetworkOutcome = Object.freeze({
        transport: 'offline',
        detail: `设备离线（${this.#monitor.kind}）：只读请求未发出`,
      });
      return Object.freeze({
        outcome,
        disposition: classifyOutcome(outcome, { nowMs: this.#clock.now() }),
        attempts: 0,
        transportCalls: this.#transport.calls.length,
        retried: false,
        plan: Object.freeze([]),
      });
    }

    let attempts = 0;
    for (;;) {
      const outcome = await this.#transport.send(ref);
      attempts += 1;
      const disposition = classifyOutcome(outcome, { nowMs: this.#clock.now() });
      const step = planRetry({
        disposition,
        attemptsMade: attempts,
        policy: this.#readPolicy,
        jitterFn: this.#jitterFn,
      });
      plan.push(step);

      if (step.action !== 'retry_immediate' && step.action !== 'retry_after_delay') {
        return Object.freeze({
          outcome,
          disposition,
          attempts,
          transportCalls: this.#transport.calls.length,
          retried: attempts > 1,
          plan: Object.freeze([...plan]),
        });
      }

      if (step.delayMs > 0) {
        await this.#sleeper.sleep(step.delayMs);
      }
      // 等待期间可能掉线：掉线时不再发出。
      if (!isOnlineKind(this.#monitor.kind)) {
        const offline: NetworkOutcome = Object.freeze({
          transport: 'offline',
          detail: '重试等待期间网络断开：请求未发出',
        });
        const offlineDisposition = classifyOutcome(offline, { nowMs: this.#clock.now() });
        plan.push(
          planRetry({ disposition: offlineDisposition, attemptsMade: attempts, policy: this.#readPolicy }),
        );
        return Object.freeze({
          outcome: offline,
          disposition: offlineDisposition,
          attempts,
          transportCalls: this.#transport.calls.length,
          retried: attempts > 1,
          plan: Object.freeze([...plan]),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 提交
  // -------------------------------------------------------------------------

  /**
   * 提交：**只在可判定未到达（或服务端幂等已核验）时续发**。
   * "可能已到达"的结果直接停下并报 `query_first`，绝不触发第二次发送。
   */
  async sendSubmit(ref: string, options: SubmitSendOptions = {}): Promise<SubmitSendResult> {
    const serverIdempotencyVerified = options.serverIdempotencyVerified === true;
    const plan: RetryPlan[] = [];

    if (!isOnlineKind(this.#monitor.kind)) {
      const outcome: NetworkOutcome = Object.freeze({
        transport: 'offline',
        detail: `设备离线（${this.#monitor.kind}）：提交未发出`,
      });
      return Object.freeze({
        outcome,
        disposition: classifyOutcome(outcome, { nowMs: this.#clock.now() }),
        attempts: 0,
        transportCalls: this.#transport.calls.length,
        finalAction: 'not_sent' as SubmitFinalAction,
        mayAutoResend: false,
        plan: Object.freeze([]),
      });
    }

    let attempts = 0;
    for (;;) {
      const outcome = await this.#transport.send(ref);
      attempts += 1;
      const disposition = classifyOutcome(outcome, { nowMs: this.#clock.now() });

      // 已受理（业务码 ok）：终局 accepted，仍需上层查原单确认。
      if (disposition.kind === 'success') {
        plan.push(planRetry({ disposition, attemptsMade: attempts, policy: this.#submitPolicy }));
        return Object.freeze({
          outcome,
          disposition,
          attempts,
          transportCalls: this.#transport.calls.length,
          finalAction: 'accepted' as SubmitFinalAction,
          mayAutoResend: false,
          plan: Object.freeze([...plan]),
        });
      }

      // 确定性拒单 / 客户端拒绝：终局 rejected，不重试。
      if (disposition.kind === 'business_failure' || disposition.kind === 'client_error') {
        plan.push(planRetry({ disposition, attemptsMade: attempts, policy: this.#submitPolicy }));
        return Object.freeze({
          outcome,
          disposition,
          attempts,
          transportCalls: this.#transport.calls.length,
          finalAction: 'rejected' as SubmitFinalAction,
          mayAutoResend: false,
          plan: Object.freeze([...plan]),
        });
      }

      // 可能已到达且无核验幂等：**不得重放**，停下报 query_first。
      if (disposition.mayHaveReachedPlatform && !serverIdempotencyVerified) {
        plan.push(
          planRetry({ disposition, attemptsMade: attempts, policy: this.#submitPolicy }),
        );
        return Object.freeze({
          outcome,
          disposition,
          attempts,
          transportCalls: this.#transport.calls.length,
          finalAction: 'query_first' as SubmitFinalAction,
          mayAutoResend: false,
          plan: Object.freeze([...plan]),
        });
      }

      // 走到这里：可判定未到达，或幂等已核验 ⇒ 允许续发（受上限约束）。
      const step = planRetry({
        disposition,
        attemptsMade: attempts,
        policy: this.#submitPolicy,
        jitterFn: this.#jitterFn,
      });
      plan.push(step);
      if (step.action === 'give_up') {
        return Object.freeze({
          outcome,
          disposition,
          attempts,
          transportCalls: this.#transport.calls.length,
          finalAction: 'exhausted' as SubmitFinalAction,
          mayAutoResend: false,
          plan: Object.freeze([...plan]),
        });
      }
      if (step.delayMs > 0) {
        await this.#sleeper.sleep(step.delayMs);
      }
      if (!isOnlineKind(this.#monitor.kind)) {
        const offline: NetworkOutcome = Object.freeze({
          transport: 'offline',
          detail: '重试等待期间网络断开：提交未续发',
        });
        return Object.freeze({
          outcome: offline,
          disposition: classifyOutcome(offline, { nowMs: this.#clock.now() }),
          attempts,
          transportCalls: this.#transport.calls.length,
          finalAction: 'not_sent' as SubmitFinalAction,
          mayAutoResend: false,
          plan: Object.freeze([...plan]),
        });
      }
    }
  }
}

export function createResilientSender(options: ResilientSenderOptions): ResilientSender {
  return new ResilientSender(options);
}
