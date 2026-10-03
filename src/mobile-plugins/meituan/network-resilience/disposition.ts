/**
 * M-R04 传输结果处置 —— **429 / 5xx / 超时 / 网络切换的判定**（零依赖、纯函数）。
 *
 * ## 复用，而不是重造
 *
 * M07 `order-submit/codes.ts` 已实现"传输 + 业务两段判定"，其中：
 * - 超时 / `network_error` ⇒ `unknown`（须查原单）；
 * - `httpStatus >= 500` ⇒ `unknown`；
 * - `2xx` 且业务码登记为 ok ⇒ 成功，否则按表或 `unknown`。
 *
 * 本模块**直接复用** {@link classifyBusinessCode} / {@link lookupBusinessCode} 与
 * `ORDER_BUSINESS_CODE_TABLE`，保证两包对"业务码"的口径一致（不各写一份表）。
 *
 * ## 本模块**纠正**的那一条（M-R04 的核心）
 *
 * M07 的 `classifySubmitResponse` 把 **`httpStatus >= 400` 一律判 `business_failure`**。
 * `429 Too Many Requests` 因此被当成**终态拒单**。这是错的：429 是**可重试的限流**，
 * 请求通常**未被处理**；判成拒单会让一次本可重试的提交永久停在"失败"。
 *
 * 本模块把 4xx 拆开：
 * - `429` ⇒ `rate_limited`，`after_delay`（采纳 `Retry-After`），**不是** `business_failure`；
 * - `408` ⇒ `timeout`（请求超时，可能已到达）；
 * - `409` ⇒ `unknown`（冲突可能是"这一单已存在"，须查原单，不猜）；
 * - 其余 4xx ⇒ `client_error`（确定性客户端拒绝）。
 *
 * 该纠正以 integrationRequest 提给 M07（本包不改其源码）；两处判据的差异由
 * `http-classification.test.ts` 用**同一批输入**并行断言，差异被显式钉住。
 *
 * ## 本模块产出的是**事实 + 传输层可重试建议**，不是"能不能重放"
 *
 * `retry` 字段回答"这次结果值不值得在传输层再发一次"（对只读直接可用）；
 * "提交能不能重放"由 {@link ../recovery.js planSubmitRecovery} 依据
 * `mayHaveReachedPlatform` 与服务端幂等**另外**回答。
 */

import {
  classifyBusinessCode,
  lookupBusinessCode,
} from '../order-submit/index.js';
import { parseRetryAfter } from './retry-policy.js';
import type {
  DispositionKind,
  NetworkOutcome,
  RetryAdvice,
  TransportDisposition,
} from './types.js';

/** `classifyOutcome` 的上下文（时间只用于把 HTTP 日期形式的 `Retry-After` 差值化）。 */
export interface ClassifyContext {
  readonly nowMs: number;
}

/** 构造一条处置结论（冻结）。 */
function disposition(input: {
  readonly kind: DispositionKind;
  readonly retry: RetryAdvice;
  readonly mayHaveReachedPlatform: boolean;
  readonly reason: string;
  readonly retryAfterMs?: number | null;
  readonly httpStatus?: number | null;
  readonly businessCode?: string | null;
}): TransportDisposition {
  return Object.freeze({
    kind: input.kind,
    retry: input.retry,
    retryAfterMs: input.retryAfterMs ?? null,
    httpStatus: input.httpStatus ?? null,
    businessCode: input.businessCode ?? null,
    mayHaveReachedPlatform: input.mayHaveReachedPlatform,
    reason: input.reason,
  });
}

/**
 * 把原始传输结果翻成处置结论。
 *
 * 规则（顺序即优先级）：
 * 1. `offline` ⇒ 未到达（`wait_for_network`）；
 * 2. `not_sent` ⇒ 按 `phase`：`before_send` 未到达（`immediate`），
 *    `during_send` 可能已到达（`after_delay`）；
 * 3. `timeout` ⇒ `timeout`，可能已到达（`after_delay`）；
 * 4. `network_error` ⇒ 按 `phase`（同第 2 条）；
 * 5. `response`：
 *    - `429` ⇒ `rate_limited`，`after_delay` + `Retry-After`，可能已到达；
 *    - `408` ⇒ `timeout`，`after_delay`；
 *    - `>= 500` ⇒ `server_error`，`after_delay`；
 *    - `409` ⇒ `unknown`，`after_delay`；
 *    - 其它 `>= 400` ⇒ `client_error`，`no`（确定性拒绝，未到达）；
 *    - `2xx` ⇒ 业务码决定：ok 成功、登记失败 `business_failure`、未登记/空 ⇒ `unknown`（`after_delay`）；
 *    - 其它（1xx/3xx/非整数）⇒ `unknown`，`after_delay`。
 */
export function classifyOutcome(outcome: NetworkOutcome, context: ClassifyContext): TransportDisposition {
  if (outcome === null || typeof outcome !== 'object') {
    return disposition({
      kind: 'unknown',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      reason: '执行器未返回可解释的结果对象：按未知处理，须查原单',
    });
  }

  if (outcome.transport === 'offline') {
    return disposition({
      kind: 'offline',
      retry: 'wait_for_network',
      mayHaveReachedPlatform: false,
      reason: `本地网络不可用（${outcome.detail}）：请求未发出，等网络恢复（不是重发）`,
    });
  }

  if (outcome.transport === 'not_sent') {
    const reached = outcome.phase === 'during_send';
    return disposition({
      kind: 'network_error',
      retry: reached ? 'after_delay' : 'immediate',
      mayHaveReachedPlatform: reached,
      reason: `发送前失败（${outcome.phase}，${outcome.detail}）：${
        reached ? '可能已到达平台，提交侧须查原单' : '可判定未到达平台，可续发'
      }`,
    });
  }

  if (outcome.transport === 'timeout') {
    return disposition({
      kind: 'timeout',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      reason: `请求超时（${outcome.detail}）：可能已到达平台，提交侧须查原单`,
    });
  }

  if (outcome.transport === 'network_error') {
    const reached = outcome.phase === 'during_send';
    return disposition({
      kind: 'network_error',
      retry: reached ? 'after_delay' : 'immediate',
      mayHaveReachedPlatform: reached,
      reason: `网络错误（${outcome.phase}，${outcome.detail}）：${
        reached ? '请求已在途，可能已到达平台，提交侧须查原单' : '发出前失败，可判定未到达平台，可续发'
      }`,
    });
  }

  // ---- response ----
  const httpStatus = outcome.httpStatus;
  const businessCode = typeof outcome.businessCode === 'string' ? outcome.businessCode : '';

  if (!Number.isInteger(httpStatus)) {
    return disposition({
      kind: 'unknown',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      reason: `HTTP 状态码非整数：${String(httpStatus)}，按未知处理`,
    });
  }

  if (httpStatus === 429) {
    const retryAfterMs = parseRetryAfter(outcome.retryAfterHeader ?? null, context.nowMs);
    return disposition({
      kind: 'rate_limited',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      retryAfterMs,
      httpStatus,
      businessCode,
      reason:
        `HTTP 429（限流）：可重试；${retryAfterMs === null ? '无有效 Retry-After，按退避等待' : `Retry-After 指示等待 ${retryAfterMs}ms`}` +
        '。**不是**确定性拒单；请求可能已到达，提交侧是否重放见 recovery.ts',
    });
  }

  if (httpStatus === 408) {
    return disposition({
      kind: 'timeout',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      httpStatus,
      businessCode,
      reason: 'HTTP 408（请求超时）：可能已到达平台，提交侧须查原单',
    });
  }

  if (httpStatus >= 500) {
    return disposition({
      kind: 'server_error',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      httpStatus,
      businessCode,
      reason: `HTTP ${httpStatus}（服务端异常）：结果不可知，提交侧须查原单`,
    });
  }

  if (httpStatus === 409) {
    return disposition({
      kind: 'unknown',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      httpStatus,
      businessCode,
      reason: 'HTTP 409（冲突）：可能是"这一单已存在"，须查原单证实，不猜',
    });
  }

  if (httpStatus >= 400) {
    return disposition({
      kind: 'client_error',
      retry: 'no',
      mayHaveReachedPlatform: false,
      httpStatus,
      businessCode,
      reason: `HTTP ${httpStatus}：请求被明确拒绝，不构成下单，无需重试`,
    });
  }

  if (httpStatus >= 200 && httpStatus < 300) {
    const kind = classifyBusinessCode(businessCode);
    if (kind === 'success') {
      return disposition({
        kind: 'success',
        retry: 'no',
        mayHaveReachedPlatform: true,
        httpStatus,
        businessCode,
        reason: `HTTP ${httpStatus} 且业务码 ${businessCode} 登记为成功（受理，仍需查原单确认）`,
      });
    }
    if (kind === 'business_failure') {
      const message = lookupBusinessCode(businessCode)?.message ?? '';
      return disposition({
        kind: 'business_failure',
        retry: 'no',
        mayHaveReachedPlatform: false,
        httpStatus,
        businessCode,
        reason: `HTTP ${httpStatus} 但业务码 ${businessCode} 判为失败（${message}）：确定性拒单，不重试`,
      });
    }
    return disposition({
      kind: 'unknown',
      retry: 'after_delay',
      mayHaveReachedPlatform: true,
      httpStatus,
      businessCode,
      reason: `HTTP ${httpStatus} 但业务码 ${businessCode === '' ? '(空)' : businessCode} 未登记：不得当成功，须查原单`,
    });
  }

  return disposition({
    kind: 'unknown',
    retry: 'after_delay',
    mayHaveReachedPlatform: true,
    httpStatus,
    businessCode,
    reason: `HTTP ${httpStatus} 不属于可解释范围：须查原单`,
  });
}

/** 便捷谓词：该处置对**提交**是否禁止盲目重放（结果可能已到达平台）。 */
export function isBlindReplayUnsafe(disposition: TransportDisposition): boolean {
  return disposition.mayHaveReachedPlatform;
}
