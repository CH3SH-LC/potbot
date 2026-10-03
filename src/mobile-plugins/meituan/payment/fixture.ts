/**
 * M08 的 **fixture 实现**：合成可信域名策略 + 脚本化支付读回端口（零依赖）。
 *
 * ## 这不是真实美团能力
 *
 * 美团真实支付域名、真实读回码表均**未核实**（未登录、无 token，见 M01）。
 * 这里的域名是 RFC 2606 保留的 `.test` 合成域名，**不是**官方域名；
 * 读回端口只回放显式配置的 `PaymentReadback`，用于**独立驱动**状态机与判据。
 * 任何「已付款」都来自显式 fixture 配置（且只能配 `real` 模式），
 * **不构成**真实支付、真实平台回执或任何已接通的外部能力。
 */

import { PaymentError } from './errors.js';
import { createTrustedLinkPolicy } from './links.js';
import type { PaymentQueryPort, PaymentQueryRequest, PaymentReadback, TrustedLinkPolicy } from './types.js';

/**
 * fixture 合成域名（**RFC 2606 保留的 `.test` TLD，非官方域名**）。
 * 真实官方域名须由 M01 核验后另行建策略并替换本常量。
 */
export const FIXTURE_PAYMENT_HOST = 'pay.meituan.test';

/** 造一份**fixture 专用**的可信域名策略（域名是合成值，不代表任何官方站）。 */
export function createFixtureLinkPolicy(extraHosts: readonly string[] = []): TrustedLinkPolicy {
  return createTrustedLinkPolicy({
    hosts: [FIXTURE_PAYMENT_HOST, ...extraHosts],
    requireHttps: true,
    label: 'fixture-meituan-payment-hosts（合成域名，未经平台核验）',
  });
}

export interface FixturePaymentQueryPort extends PaymentQueryPort {
  /** 端口**真实收到**的读回请求（按顺序）。 */
  readonly calls: readonly PaymentQueryRequest[];
}

export interface FixturePaymentQueryPortConfig {
  readonly identity?: string;
  /** 按请求与调用序号给出读回；返回 `null` 表示「读了但没结论」（状态保持未知）。 */
  readonly respond: (
    request: PaymentQueryRequest,
    callIndex: number,
  ) => PaymentReadback | null | Promise<PaymentReadback | null>;
}

/** 脚本化读回端口：只回放配置，不触网。 */
export function createFixturePaymentQueryPort(config: FixturePaymentQueryPortConfig): FixturePaymentQueryPort {
  if (config === null || typeof config !== 'object' || typeof config.respond !== 'function') {
    throw new PaymentError('missing_payment_query_port', 'fixture 支付端口必须给出 respond 函数');
  }
  const calls: PaymentQueryRequest[] = [];
  return {
    identity: config.identity ?? 'fixture-payment-query',
    get calls(): readonly PaymentQueryRequest[] {
      return Object.freeze([...calls]);
    },
    async query(request: PaymentQueryRequest): Promise<PaymentReadback | null> {
      const index = calls.length;
      calls.push(request);
      return config.respond(request, index);
    },
  };
}
