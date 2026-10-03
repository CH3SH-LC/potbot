/**
 * M07 业务结果码映射 —— **本包最要害的一段判据**。
 *
 * ## 洞：只看 HTTP 状态码判成功
 *
 * 平台常见形态是「HTTP 200 + 响应体里 `code != 0`」：传输层全绿、业务层拒单。
 * 若判据写成 `if (response.ok) return '成功'`，就会把**拒单报成下单成功**——
 * 这是把失败判据当成通过判据的典型（与 R245 同类）。
 *
 * ## 对策：传输与业务**两段**判定，且未登记的码一律不得当成功
 *
 * {@link classifySubmitResponse} 的规则（顺序即优先级）：
 * 1. `timeout` / `network_error` ⇒ `unknown`（**可能**已到平台，须查原单）；
 * 2. `offline` / `not_sent(before_send)` ⇒ `not_sent`（**可判定从未发出**，可安全续发；
 *    绝不是"已发出未知"）；`not_sent(during_send)` ⇒ `unknown`（可能已到达）；
 * 3. `429` ⇒ `rate_limited`（**可重试限流**，采纳 `Retry-After`；**不是**终态拒单）；
 * 4. `408` ⇒ `unknown`（请求超时，可能已到达）；`409` ⇒ `unknown`（冲突可能是"已存在"）；
 * 5. `httpStatus >= 500` ⇒ `unknown`（服务端异常，结果不可知）；
 * 6. 其余 `httpStatus >= 400` ⇒ `business_failure`（明确的客户端/拒单语义，不必查）；
 * 7. `2xx` ⇒ **必须**再看业务码：查 {@link ORDER_BUSINESS_CODE_TABLE}，
 *    - 未登记 / 空串 ⇒ `unknown`（**不猜**，尤其不猜成功）；
 *    - `duplicate_order` ⇒ `unknown`（订单**可能已存在**，只能查原单证实）；
 *    - 其余按表。
 * 8. 其余状态码（1xx / 3xx 等异常）⇒ `unknown`。
 *
 * 结果是：**没有任何分支仅凭 `httpStatus === 200` 返回 success**；
 * success 只可能来自"传输 2xx **且**业务码登记为 ok 成功"。
 *
 * ## 修过的 DEFECT（M-R04 integrationRequest #1）
 *
 * 曾把 `httpStatus >= 400` **一律**判 `business_failure`，于是 `429` 被报成终态拒单，
 * 一次本可 `Retry-After` 后重试的提交被永久钉死。现按上表把 4xx 拆开。
 */

import type { OrderOutcomeKind, OrderTransportResult, SubmitClassification } from './types.js';

/** 业务结果码的登记项。未登记的码在映射时按 `unknown` 处理（不放行成成功）。 */
export interface OrderBusinessCodeSpec {
  readonly code: string;
  readonly kind: OrderOutcomeKind;
  readonly message: string;
}

/**
 * 平台业务码登记表（fixture 口径）。
 *
 * 真实美团码表尚未核实（未登录、无文档），此处只提供**可被替代**的本地登记：
 * 接线时替换本表即可，映射逻辑（`classifySubmitResponse`）不变。
 */
export const ORDER_BUSINESS_CODE_TABLE: readonly OrderBusinessCodeSpec[] = Object.freeze([
  Object.freeze({ code: 'ok', kind: 'success', message: '下单受理' }),
  Object.freeze({ code: 'sold_out', kind: 'business_failure', message: '菜品售罄' }),
  Object.freeze({ code: 'price_changed', kind: 'business_failure', message: '价格已变化，须重新报价确认' }),
  Object.freeze({ code: 'invalid_address', kind: 'business_failure', message: '配送地址不可达' }),
  Object.freeze({ code: 'risk_rejected', kind: 'business_failure', message: '风控拒绝' }),
  // `duplicate_order` = 平台认为**这一单已经存在**：这是"结果未知"的强信号（可能上次已成功），
  // 必须查原单证实，绝不能在本地直接判成功（我们拿不到平台的订单详情）。
  Object.freeze({ code: 'duplicate_order', kind: 'unknown', message: '平台报重复下单：须查原单证实' }),
  Object.freeze({ code: 'system_busy', kind: 'unknown', message: '平台繁忙，结果未知' }),
] as const);

const TABLE_BY_CODE: ReadonlyMap<string, OrderBusinessCodeSpec> = new Map(
  ORDER_BUSINESS_CODE_TABLE.map((entry) => [entry.code, entry]),
);

/** 按码查登记项；未登记返回 `undefined`（调用方**不得**把它当成功）。 */
export function lookupBusinessCode(code: string): OrderBusinessCodeSpec | undefined {
  return TABLE_BY_CODE.get(code);
}

/** 业务码 → 分类。**未登记 / 空串一律 `unknown`**。 */
export function classifyBusinessCode(code: string): OrderOutcomeKind {
  const spec = lookupBusinessCode(code);
  if (spec === undefined) {
    return 'unknown';
  }
  return spec.kind;
}

/**
 * 解析 `Retry-After`（**纯函数**，不读墙钟）。接受：
 * - 非负整数字符串（秒）⇒ 秒 × 1000；
 * - HTTP 日期 ⇒ 与 `nowMs` 之差（负数夹到 0）；**未注入 `nowMs` 时返回 `null`**（无法差值化，不猜）；
 * - 其它（空 / 负 / 不可解析）⇒ `null`（不猜，退回普通退避）。
 */
export function parseRetryAfterHeader(value: unknown, nowMs?: number | null): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) {
      return null;
    }
    return seconds * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(0, parsed - nowMs);
}

/** 分类结论的构造上下文（时间只用于把 HTTP 日期形式的 `Retry-After` 差值化）。 */
export interface ClassifySubmitContext {
  /** 注入时钟（毫秒）。省略时不做 HTTP 日期差值化（退回 `retryAfterMs: null`）。 */
  readonly nowMs?: number;
}

/** 构造一条冻结的分类结论（补齐四个布尔/数值字段，避免遗漏）。 */
function classification(input: {
  readonly kind: OrderOutcomeKind;
  readonly needsQuery: boolean;
  readonly retryable: boolean;
  readonly notSent: boolean;
  readonly reason: string;
  readonly retryAfterMs?: number | null;
}): SubmitClassification {
  return Object.freeze({
    kind: input.kind,
    needsQuery: input.needsQuery,
    retryable: input.retryable,
    retryAfterMs: input.retryAfterMs ?? null,
    notSent: input.notSent,
    reason: input.reason,
  });
}

/**
 * 传输结果 → 业务分类（见文件头规则）。**纯函数**，不读时钟、不读网络
 * （`Retry-After` 的 HTTP 日期差值化只用**注入**的 `context.nowMs`）。
 */
export function classifySubmitResponse(
  result: OrderTransportResult,
  context: ClassifySubmitContext = {},
): SubmitClassification {
  if (result === null || typeof result !== 'object') {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: '执行器未返回可解释的结果对象',
    });
  }
  if (result.transport === 'timeout') {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `提交超时（${result.detail}）：可能已到达平台，须查原单`,
    });
  }
  if (result.transport === 'network_error') {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `网络错误（${result.detail}）：无法判断是否已到达平台，须查原单`,
    });
  }
  if (result.transport === 'offline') {
    return classification({
      kind: 'not_sent',
      needsQuery: false,
      retryable: true,
      notSent: true,
      reason: `本地网络不可用（${result.detail}）：请求**未发出**，可续发同一条；不得记成"已发出未知"`,
    });
  }
  if (result.transport === 'not_sent') {
    if (result.phase === 'before_send') {
      return classification({
        kind: 'not_sent',
        needsQuery: false,
        retryable: true,
        notSent: true,
        reason: `发出前失败（${result.detail}）：可判定**未到达平台**，可续发同一条`,
      });
    }
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `发出途中失败（${result.detail}）：可能已到达平台，须查原单`,
    });
  }

  const httpStatus = result.httpStatus;
  const businessCode = typeof result.businessCode === 'string' ? result.businessCode : '';

  if (!Number.isInteger(httpStatus)) {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `HTTP 状态码非整数：${String(httpStatus)}`,
    });
  }

  // ---- 4xx 拆分（M-R04 integrationRequest #1 的核心修复）----
  if (httpStatus === 429) {
    const retryAfterMs = parseRetryAfterHeader(result.retryAfterHeader ?? null, context.nowMs ?? null);
    return classification({
      kind: 'rate_limited',
      needsQuery: true,
      retryable: true,
      notSent: false,
      retryAfterMs,
      reason:
        `HTTP 429（限流）：**可重试**，不是确定性拒单；` +
        (retryAfterMs === null ? '无有效 Retry-After，按退避等待' : `Retry-After 指示等待 ${retryAfterMs}ms`) +
        '。请求可能已到达，提交侧是否重放仍须查原单',
    });
  }
  if (httpStatus === 408) {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `HTTP 408（请求超时）：可能已到达平台，须查原单`,
    });
  }
  if (httpStatus === 409) {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `HTTP 409（冲突）：可能是"这一单已存在"，须查原单证实，不猜`,
    });
  }
  if (httpStatus >= 500) {
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `HTTP ${httpStatus}（服务端异常）：结果不可知，须查原单`,
    });
  }
  if (httpStatus >= 400) {
    return classification({
      kind: 'business_failure',
      needsQuery: false,
      retryable: false,
      notSent: false,
      reason: `HTTP ${httpStatus}：请求被明确拒绝，不构成下单`,
    });
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    const kind = classifyBusinessCode(businessCode);
    if (kind === 'success') {
      return classification({
        kind,
        needsQuery: false,
        retryable: false,
        notSent: false,
        reason: `HTTP ${httpStatus} 且业务码 ${businessCode} 登记为成功`,
      });
    }
    if (kind === 'business_failure') {
      // **本判据的核心**：HTTP 成功但业务失败 ⇒ 绝不报成功。
      const message = lookupBusinessCode(businessCode)?.message ?? '';
      return classification({
        kind,
        needsQuery: false,
        retryable: false,
        notSent: false,
        reason: `HTTP ${httpStatus} 但业务码 ${businessCode} 判为失败（${message}）：不得报成功`,
      });
    }
    return classification({
      kind: 'unknown',
      needsQuery: true,
      retryable: true,
      notSent: false,
      reason: `HTTP ${httpStatus} 但业务码 ${businessCode === '' ? '(空)' : businessCode} 未登记：不得当成功，须查原单`,
    });
  }
  return classification({
    kind: 'unknown',
    needsQuery: true,
    retryable: true,
    notSent: false,
    reason: `HTTP ${httpStatus} 不属于可解释范围：须查原单`,
  });
}

/**
 * 分类结论 → 目标状态。
 * - `success` ⇒ `submitted`；`business_failure` ⇒ `rejected`；
 * - `not_sent` ⇒ `submitting`（未发出，可续发）；
 * - `unknown` / `rate_limited` ⇒ `unknown`（非终态；**rate_limited 绝不是 rejected**）。
 */
export function stateForOutcome(kind: OrderOutcomeKind): 'submitted' | 'rejected' | 'unknown' | 'submitting' {
  if (kind === 'success') return 'submitted';
  if (kind === 'business_failure') return 'rejected';
  if (kind === 'not_sent') return 'submitting';
  return 'unknown';
}
