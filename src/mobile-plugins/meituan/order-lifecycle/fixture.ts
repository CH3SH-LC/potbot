/**
 * M09 的 **fixture 实现**：确定性订单查询端口。
 *
 * ## 这不是真实平台能力
 *
 * 美团真实平台能力尚未核实（未登录、无 token、无工具清单）。本包**不接真实接口**。
 * 这里的 `FixtureOrderQueryPort` 只按本地配置表**回放**查询结果，用于**独立驱动
 * 与验证**模型本身；任何「成功」都来自显式 fixture 配置，**不构成**真实订单、
 * 支付或退款回执。真实实现由 M01/M02 核验后提供（实现同一个 `OrderQueryPort` 即可替换）。
 *
 * ## 观测量
 *
 * 端口会记下**每一次**请求（含 `externalId` 与 `reason`），
 * 供「断线后查的是不是原单」这类断言使用。
 */

import { OrderValidationError } from './errors.js';
import type { OrderQueryPort, OrderQueryRequest, OrderQueryResult } from './types.js';

/** fixture 端口配置。 */
export interface FixtureOrderQueryPortConfig {
  /** 按调用序号依次回放的结果。 */
  readonly results?: readonly OrderQueryResult[];
  /**
   * 自定义应答器：按调用序号决定结果；返回 `null` 表示端口**拒答**
   * （模拟网络中断 / 查询失败）——本地必须把它当成「结果未知」，
   * 不得据此推断订单状态。
   */
  readonly responder?: (request: OrderQueryRequest, index: number) => OrderQueryResult | null;
  /**
   * **故障注入（仅供负向对照）**：对即将返回的结果做篡改，
   * 用来验证「平台回执与本地意图不符时本地必须报不匹配，而不是替它圆场」。
   */
  readonly tamper?: (result: OrderQueryResult, request: OrderQueryRequest) => OrderQueryResult;
}

/** fixture 端口额外暴露的观测量。 */
export interface FixtureOrderQueryPort extends OrderQueryPort {
  /** 已收到的请求（按顺序），用于断言端口确实被调用、调用了几次、查的是哪个 externalId。 */
  readonly calls: readonly OrderQueryRequest[];
}

/** 端口拒答（网络中断 / 查询失败）。 */
export class OrderQueryUnavailableError extends OrderValidationError {
  constructor(index: number) {
    super(`fixture 端口拒答第 ${index} 次查询：结果未知，不得据此推断订单状态`);
    this.name = 'OrderQueryUnavailableError';
  }
}

/**
 * 确定性订单查询端口 fixture。
 *
 * 回放顺序：`responder` 优先；否则按 `results[index]`；
 * 两者都取不到 ⇒ 抛 {@link OrderQueryUnavailableError}（不静默返回假结果）。
 */
export function createFixtureOrderQueryPort(config: FixtureOrderQueryPortConfig = {}): FixtureOrderQueryPort {
  const calls: OrderQueryRequest[] = [];
  const results = config.results ?? [];

  return {
    get calls(): readonly OrderQueryRequest[] {
      return Object.freeze([...calls]);
    },
    async query(request: OrderQueryRequest): Promise<OrderQueryResult> {
      const index = calls.length;
      calls.push(Object.freeze({ ...request }));
      const produced =
        config.responder !== undefined ? config.responder(request, index) : (results[index] ?? null);
      if (produced === null) {
        throw new OrderQueryUnavailableError(index);
      }
      const result = config.tamper !== undefined ? config.tamper(produced, request) : produced;
      return Object.freeze({ ...result });
    },
  };
}
