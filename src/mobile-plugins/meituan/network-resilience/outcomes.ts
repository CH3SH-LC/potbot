/**
 * M-R04 —— **原始传输结果的构造器**（纯函数、零依赖）。
 *
 * 这些构造器只造**数据**。它们的作用是让"429 / 503 / 超时 / 掉线"这些场景
 * 在测试与驱动里显式、可枚举，而不是靠字符串拼 HTTP 响应。
 *
 * 真实手机传输实现（M02 `mobile-transport/`）将来只需产出同构的
 * {@link NetworkOutcome}，即可被本层处置。
 */

import type { NetworkOutcome } from './types.js';

/** 本地网络不可用（从未发出）。 */
export function offlineOutcome(detail = '设备离线：请求未发出'): NetworkOutcome {
  return Object.freeze({ transport: 'offline', detail });
}

/** 发出前失败（DNS / 连接建立 / TLS）：可判定**未到达平台**。 */
export function notSentOutcome(
  phase: 'before_send' | 'during_send' = 'before_send',
  detail = '连接建立前失败：请求未到达平台',
): NetworkOutcome {
  return Object.freeze({ transport: 'not_sent', phase, detail });
}

/** 超时：请求可能已到达平台。 */
export function timeoutOutcome(detail = '请求超时：可能已到达平台'): NetworkOutcome {
  return Object.freeze({ transport: 'timeout', detail });
}

/** 发出途中网络错误（默认 `during_send` = 可能已到达）。 */
export function networkErrorOutcome(
  phase: 'before_send' | 'during_send' = 'during_send',
  detail = '发出途中网络错误',
): NetworkOutcome {
  return Object.freeze({ transport: 'network_error', phase, detail });
}

export interface HttpOutcomeInput {
  readonly httpStatus: number;
  readonly businessCode?: string;
  readonly retryAfterHeader?: string | null;
  readonly providerOrderRef?: string | null;
}

/** 收到 HTTP 响应。 */
export function httpOutcome(input: HttpOutcomeInput): NetworkOutcome {
  return Object.freeze({
    transport: 'response',
    httpStatus: input.httpStatus,
    businessCode: input.businessCode ?? '',
    retryAfterHeader: input.retryAfterHeader ?? null,
    providerOrderRef: input.providerOrderRef ?? null,
  });
}

/** HTTP 200 + 业务码 `ok`（唯一通向"受理"的组合）。 */
export function okHttpOutcome(providerOrderRef: string | null = null): NetworkOutcome {
  return httpOutcome({ httpStatus: 200, businessCode: 'ok', providerOrderRef });
}

/** HTTP 200 + 业务失败码。 */
export function businessFailureHttpOutcome(businessCode: string): NetworkOutcome {
  return httpOutcome({ httpStatus: 200, businessCode });
}

/** HTTP 429 Too Many Requests（可重试限流，**不是**终态拒单）。 */
export function rateLimitedOutcome(retryAfterHeader: string | null = null): NetworkOutcome {
  return httpOutcome({ httpStatus: 429, businessCode: 'rate_limited', retryAfterHeader });
}

/** HTTP 5xx 服务端异常。 */
export function serverErrorOutcome(httpStatus = 503): NetworkOutcome {
  return httpOutcome({ httpStatus, businessCode: 'system_busy' });
}
