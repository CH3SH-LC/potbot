/**
 * M07 的 **fixture 实现**：脚本化执行器 + 脚本化原单查询端口（零依赖）。
 *
 * ## 这不是真实美团能力
 *
 * 美团真实平台能力尚未核实（未登录、无 token、无工具清单），本包**不接真实接口**。
 * 这里的执行器只回放显式配置的 `OrderTransportResult`，用于**独立驱动**状态机与幂等语义；
 * 任何"成功"都来自显式 fixture 配置，**不构成**真实订单、支付或平台回执。
 * 真实实现由后续包提供（实现同一个 `OrderExecutorPort` / `OrderQueryPort` 即可替换）。
 *
 * ## 两个可观测点
 *
 * - `calls`：执行器 / 查询端口**真实收到**的请求（按顺序）。幂等用例的核心断言就是
 *   "同键第二次提交后 `calls.length` 仍为 1"。
 * - `respond`：可给"同一请求的第几次调用"返回不同结果，用来模拟"超时后平台其实已受理"。
 */

import { OrderSubmitError } from './errors.js';
import type {
  OrderExecutorPort,
  OrderQueryPort,
  OrderQueryRequest,
  OrderReceipt,
  OrderSubmitRequest,
  OrderTransportResult,
} from './types.js';

/** 造一个"HTTP 2xx + 业务码成功"的传输结果。 */
export function okResponse(providerOrderRef: string | null = 'MT-ORDER-1', businessCode = 'ok'): OrderTransportResult {
  return Object.freeze({ transport: 'response', httpStatus: 200, businessCode, providerOrderRef });
}

/** 造一个"HTTP 2xx 但业务码失败"的传输结果（本包最要害的假成功场景）。 */
export function businessFailureResponse(businessCode: string, httpStatus = 200): OrderTransportResult {
  return Object.freeze({ transport: 'response', httpStatus, businessCode, providerOrderRef: null });
}

/** 造一个"HTTP 4xx"的传输结果。 */
export function httpErrorResponse(httpStatus: number, businessCode = '', retryAfterHeader: string | null = null): OrderTransportResult {
  return Object.freeze({ transport: 'response', httpStatus, businessCode, providerOrderRef: null, retryAfterHeader });
}

/** 造一个"HTTP 429 限流"的传输结果（**可重试**，不是终态拒单）。 */
export function rateLimitedResponse(retryAfterHeader: string | null = null): OrderTransportResult {
  return Object.freeze({
    transport: 'response',
    httpStatus: 429,
    businessCode: 'rate_limited',
    providerOrderRef: null,
    retryAfterHeader,
  });
}

/** 造一个超时的传输结果（**可能**已到达平台）。 */
export function timeoutResult(detail = 'fixture 超时'): OrderTransportResult {
  return Object.freeze({ transport: 'timeout', detail });
}

/** 造一个网络错误的传输结果。 */
export function networkErrorResult(detail = 'fixture 网络错误'): OrderTransportResult {
  return Object.freeze({ transport: 'network_error', detail });
}

/** 造一个"设备离线"的传输结果（**从未发出**）。 */
export function offlineResult(detail = 'fixture 设备离线'): OrderTransportResult {
  return Object.freeze({ transport: 'offline', detail });
}

/** 造一个"发出前/发出中失败"的传输结果。 */
export function notSentResult(
  phase: 'before_send' | 'during_send' = 'before_send',
  detail = 'fixture 发出前失败',
): OrderTransportResult {
  return Object.freeze({ transport: 'not_sent', phase, detail });
}

export interface FixtureOrderExecutor extends OrderExecutorPort {
  /** 执行器**真实收到**的请求（按顺序）。 */
  readonly calls: readonly OrderSubmitRequest[];
}

export interface FixtureOrderExecutorConfig {
  readonly identity?: string;
  /** 按请求与调用序号给出传输结果；也可返回 Promise 模拟异步在途。 */
  readonly respond: (
    request: OrderSubmitRequest,
    callIndex: number,
  ) => OrderTransportResult | Promise<OrderTransportResult>;
}

/** 脚本化执行器：只回放配置，不触网。 */
export function createFixtureOrderExecutor(config: FixtureOrderExecutorConfig): FixtureOrderExecutor {
  if (config === null || typeof config !== 'object' || typeof config.respond !== 'function') {
    throw new OrderSubmitError('missing_executor', 'fixture 执行器必须给出 respond 函数');
  }
  const calls: OrderSubmitRequest[] = [];
  return {
    identity: config.identity ?? 'fixture-order-executor',
    get calls(): readonly OrderSubmitRequest[] {
      return Object.freeze([...calls]);
    },
    async send(request: OrderSubmitRequest): Promise<OrderTransportResult> {
      const index = calls.length;
      calls.push(request);
      return config.respond(request, index);
    },
  };
}

export interface FixtureOrderQueryPort extends OrderQueryPort {
  readonly calls: readonly OrderQueryRequest[];
}

export interface FixtureOrderQueryPortConfig {
  readonly identity?: string;
  /** 按查询请求给出回执；返回 `null` 表示"查了但没结论"（状态保持未知）。 */
  readonly respond: (
    request: OrderQueryRequest,
    callIndex: number,
  ) => OrderReceipt | null | Promise<OrderReceipt | null>;
}

/** 脚本化原单查询端口：只回放配置，不触网。 */
export function createFixtureOrderQueryPort(config: FixtureOrderQueryPortConfig): FixtureOrderQueryPort {
  if (config === null || typeof config !== 'object' || typeof config.respond !== 'function') {
    throw new OrderSubmitError('missing_order_query_port', 'fixture 查询端口必须给出 respond 函数');
  }
  const calls: OrderQueryRequest[] = [];
  return {
    identity: config.identity ?? 'fixture-order-query',
    get calls(): readonly OrderQueryRequest[] {
      return Object.freeze([...calls]);
    },
    async query(request: OrderQueryRequest): Promise<OrderReceipt | null> {
      const index = calls.length;
      calls.push(request);
      return config.respond(request, index);
    },
  };
}
