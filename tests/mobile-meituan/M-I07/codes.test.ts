/**
 * M-I07 —— **4xx 拆分**（落地 M-R04 integrationRequest #1，修一条真实 DEFECT）。
 *
 * ## 被修的 DEFECT（红-前）
 *
 * `classifySubmitResponse` 曾把 `httpStatus >= 400` 一律判
 * `{ kind: 'business_failure', needsQuery: false }`。于是 **HTTP 429（限流）**被报成
 * **终态拒单**——可一次 `Retry-After` 之后重试的请求，被永久钉死在「失败」，
 * 等于把「可能还没下单」误报成「肯定没下单」。
 *
 * ## 修法（绿-后）
 *
 * 4xx 拆四类：
 *   - `429` ⇒ `rate_limited`（可重试；采纳 `Retry-After`；**不是**终态拒单）；
 *   - `408` ⇒ `unknown`（请求超时，可能已到达平台，须查原单）；
 *   - `409` ⇒ `unknown`（冲突可能是「这一单已存在」，须查原单证实，不猜）；
 *   - 其余 4xx ⇒ `business_failure`（确定性客户端/拒单语义）。
 *
 * 本文件对 429 的断言在修前**必红**（返回 business_failure）、修后**必绿**。
 */

import { describe, expect, it } from 'vitest';

import {
  classifySubmitResponse,
  stateForOutcome,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';

/** HTTP 响应结果构造（就地，不依赖 fixture 助手）。 */
function httpResult(
  httpStatus: number,
  businessCode = '',
  retryAfterHeader: string | null = null,
): Parameters<typeof classifySubmitResponse>[0] {
  return Object.freeze({
    transport: 'response' as const,
    httpStatus,
    businessCode,
    retryAfterHeader,
  });
}

describe('M-I07 4xx 拆分：429 是可重试限流，**不是**终态拒单（DEFECT 修复）', () => {
  it('429 + Retry-After: 120 ⇒ rate_limited，可重试，采纳 120000ms', () => {
    const c = classifySubmitResponse(httpResult(429, 'rate_limited', '120'));

    // —— 核心：修前这里必红（kind==='business_failure'、needsQuery===false）——
    expect(c.kind).toBe('rate_limited');
    expect(c.kind).not.toBe('business_failure');
    expect(c.needsQuery).toBe(true);
    expect(c.needsQuery).not.toBe(false);
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBe(120_000);
  });

  it('429 无 Retry-After ⇒ 仍是 rate_limited（retryAfterMs 为 null，不猜）', () => {
    const c = classifySubmitResponse(httpResult(429, 'rate_limited', null));
    expect(c.kind).toBe('rate_limited');
    expect(c.retryable).toBe(true);
    expect(c.retryAfterMs).toBeNull();
  });

  it('429 + HTTP 日期形式的 Retry-After ⇒ 按注入 nowMs 差值化', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const header = new Date(now + 45_000).toUTCString();
    const c = classifySubmitResponse(httpResult(429, 'rate_limited', header), { nowMs: now });
    expect(c.kind).toBe('rate_limited');
    expect(c.retryAfterMs).toBe(45_000);
  });

  it('429 的 Retry-After 非法 ⇒ retryAfterMs 为 null（仍可重试，不猜时长）', () => {
    const c = classifySubmitResponse(httpResult(429, 'rate_limited', 'soon'));
    expect(c.kind).toBe('rate_limited');
    expect(c.retryAfterMs).toBeNull();
  });
});

describe('M-I07 4xx 拆分：408 / 409 落到未知须查原单', () => {
  it('408 ⇒ unknown，needsQuery=true（请求超时，可能已到达）', () => {
    const c = classifySubmitResponse(httpResult(408, 'timeout'));
    expect(c.kind).toBe('unknown');
    expect(c.needsQuery).toBe(true);
    expect(c.retryable).toBe(true);
  });

  it('409 ⇒ unknown，needsQuery=true（冲突可能是"这一单已存在"，不猜）', () => {
    const c = classifySubmitResponse(httpResult(409, 'conflict'));
    expect(c.kind).toBe('unknown');
    expect(c.needsQuery).toBe(true);
  });
});

describe('M-I07 4xx 拆分：其余 4xx 仍是确定性拒单', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    it(`HTTP ${status} ⇒ business_failure，needsQuery=false（不构成下单）`, () => {
      const c = classifySubmitResponse(httpResult(status, 'bad_request'));
      expect(c.kind).toBe('business_failure');
      expect(c.needsQuery).toBe(false);
      expect(c.retryable).toBe(false);
    });
  }

  it('HTTP 400 维持既有判据（与 M07 business-codes.test.ts 一致）', () => {
    expect(classifySubmitResponse(httpResult(400, 'bad_request')).kind).toBe('business_failure');
  });
});

describe('M-I07 分类不回归：5xx / 2xx / 超时口径不变', () => {
  it('HTTP 503 即使业务码 ok ⇒ unknown，needsQuery=true', () => {
    const c = classifySubmitResponse(httpResult(503, 'ok'));
    expect(c.kind).toBe('unknown');
    expect(c.needsQuery).toBe(true);
  });

  it('HTTP 200 + ok ⇒ success（唯一成功组合）', () => {
    expect(classifySubmitResponse(httpResult(200, 'ok')).kind).toBe('success');
  });

  it('HTTP 200 + sold_out ⇒ business_failure（HTTP 成功但业务失败不得报成功）', () => {
    const c = classifySubmitResponse(httpResult(200, 'sold_out'));
    expect(c.kind).toBe('business_failure');
    expect(c.needsQuery).toBe(false);
  });
});

describe('M-I07 分类 → 状态映射', () => {
  it('success ⇒ submitted；business_failure ⇒ rejected', () => {
    expect(stateForOutcome('success')).toBe('submitted');
    expect(stateForOutcome('business_failure')).toBe('rejected');
  });

  it('429（rate_limited）⇒ unknown（**非终态**，绝不是 rejected）', () => {
    expect(stateForOutcome('rate_limited')).toBe('unknown');
    expect(stateForOutcome('rate_limited')).not.toBe('rejected');
  });

  it('not_sent ⇒ submitting（未发出，可续发）', () => {
    expect(stateForOutcome('not_sent')).toBe('submitting');
  });
});
