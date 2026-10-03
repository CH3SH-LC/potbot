/**
 * M-I02 —— 原始网络结果（{@link NetworkOutcome}）的构造与映射。
 *
 * ## 为什么需要这一层
 *
 * M-R04（网络韧性 / 提交结果未知恢复）消费的是一份**只描述网络事实**的结果：
 * `offline` / `not_sent` / `timeout` / `network_error` / `response`，并带
 * `before_send` / `during_send` 阶段 + `Retry-After` 原文。没有阶段信息时，
 * 一次 DNS / 连接建立失败会被保守当作 `during_send`（`mayHaveReached=true`），
 * 于是"其实一个字节都没发出去"的提交也会被迫走"先查原单"。
 *
 * 本模块把原生端口抛出的 {@link RawTransportFault} 的 `kind` + `phase` 映射成
 * 正确的 {@link NetworkOutcome}：
 *
 * - `offline` ⇒ `offline`（从未发出）；
 * - `network_error` + `before_send` ⇒ **`not_sent`**（可判定未到达平台）；
 * - `network_error` + `during_send` ⇒ `network_error`（可能已到达）；
 * - `timeout` ⇒ `timeout`（可能已到达）。
 *
 * 本模块**零依赖、零网络、零时钟**；只造数据。`Retry-After` 只做**原文透传**，
 * 解析（秒数 / HTTP-date）交给 M-R04 的 `parseRetryAfter`，不在本层猜。
 */

import type {
  NetworkErrorPhase,
  NetworkOutcome,
  RawTransportFaultKind,
  RawTransportFault,
  TransportOutcome,
} from './types.js';

/** `Retry-After` 头名（比较时大小写不敏感）。 */
const RETRY_AFTER_HEADER_NAME = 'retry-after';

/**
 * 大小写不敏感地取出响应头里的 `Retry-After` **原文**。
 *
 * 返回原文（例如 `"3"` 或 `"Wed, 21 Oct 2015 07:28:00 GMT"`），**不解析、不折算**；
 * 取不到 / 空串返回 `null`。绝不在本层把无法解释的值猜成毫秒。
 */
export function readRetryAfter(headers: Readonly<Record<string, string>> | undefined | null): string | null {
  if (headers === null || headers === undefined || typeof headers !== 'object') {
    return null;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && name.trim().toLowerCase() === RETRY_AFTER_HEADER_NAME) {
      return value;
    }
  }
  return null;
}

/** 构造"发出前失败"结果（`not_sent`）。 */
export function makeNotSentOutcome(detail: string, phase: NetworkErrorPhase = 'before_send'): NetworkOutcome {
  return Object.freeze({ transport: 'not_sent' as const, phase, detail });
}

/** 构造"设备离线"结果（从未发出）。 */
export function makeOfflineOutcome(detail: string): NetworkOutcome {
  return Object.freeze({ transport: 'offline' as const, detail });
}

/** 构造"超时"结果（可能已到达平台）。 */
export function makeTimeoutOutcome(detail: string): NetworkOutcome {
  return Object.freeze({ transport: 'timeout' as const, detail });
}

/** 构造"发出途中网络错误"结果（可能已到达平台）。 */
export function makeNetworkErrorOutcome(detail: string, phase: NetworkErrorPhase = 'during_send'): NetworkOutcome {
  return Object.freeze({ transport: 'network_error' as const, phase, detail });
}

/** `response` 结果的入参。 */
export interface NetworkResponseInput {
  readonly httpStatus: number;
  readonly businessCode?: string;
  readonly retryAfterHeader?: string | null;
  readonly providerOrderRef?: string | null;
}

/** 构造"收到 HTTP 响应"结果。`providerOrderRef` 未从任何未核实字段提取，缺省 `null`。 */
export function makeResponseOutcome(input: NetworkResponseInput): NetworkOutcome {
  return Object.freeze({
    transport: 'response' as const,
    httpStatus: input.httpStatus,
    businessCode: input.businessCode ?? '',
    retryAfterHeader: input.retryAfterHeader ?? null,
    providerOrderRef: input.providerOrderRef ?? null,
  });
}

/**
 * 由 {@link RawTransportFault} 的 `kind` + `phase` 得出 {@link NetworkOutcome}。
 *
 * **要害**：`network_error` 且 `phase === 'before_send'` 一律映射为 `not_sent`——
 * 这是"DNS / 连接建立失败 = definitely-not-sent"的机器化表达。
 */
export function faultToNetworkOutcome(fault: Pick<RawTransportFault, 'kind' | 'phase'>, detail: string): NetworkOutcome {
  const kind: RawTransportFaultKind = fault.kind;
  switch (kind) {
    case 'offline':
      return makeOfflineOutcome(detail);
    case 'timeout':
      return makeTimeoutOutcome(detail);
    case 'network_error':
      return fault.phase === 'before_send'
        ? makeNotSentOutcome(detail, 'before_send')
        : makeNetworkErrorOutcome(detail, 'during_send');
    default:
      // 未知 kind（防御性）：保守当作"发出途中网络错误"（可能已到达）。
      return makeNetworkErrorOutcome(detail, 'during_send');
  }
}

/**
 * 从完整 {@link TransportOutcome} 里取出 {@link NetworkOutcome}。
 * 供 M-R04 的 `RawTransportPort` 适配器一行接线：`projectNetworkOutcome(await client.invoke(...))`。
 */
export function projectNetworkOutcome(outcome: TransportOutcome): NetworkOutcome {
  return outcome.network;
}
