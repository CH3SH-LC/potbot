/**
 * M-R04 传输结果分类：**429 / 5xx / 超时 / 网络错误 / 4xx**。
 *
 * 核心是"**429 不是拒单**"这条纠正。末尾用**同一批输入**并行跑 M07 的
 * `classifySubmitResponse` 与本模块的 `classifyOutcome`，把两处判据的差异显式钉住：
 * 本层判 429 为可重试限流；M07 当前把它并入 `httpStatus >= 400 ⇒ business_failure`。
 */

import { describe, expect, it } from 'vitest';

import { classifySubmitResponse } from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { classifyOutcome } from './disposition.js';
import {
  businessFailureHttpOutcome,
  httpOutcome,
  networkErrorOutcome,
  notSentOutcome,
  offlineOutcome,
  okHttpOutcome,
  rateLimitedOutcome,
  serverErrorOutcome,
} from './outcomes.js';
import { T0 } from './support.js';

const ctx = { nowMs: T0 };

describe('M-R04 离线 / 未到达：可判定未到达平台', () => {
  it('offline ⇒ offline，未到达，等网络', () => {
    const d = classifyOutcome(offlineOutcome(), ctx);
    expect(d.kind).toBe('offline');
    expect(d.retry).toBe('wait_for_network');
    expect(d.mayHaveReachedPlatform).toBe(false);
  });

  it('not_sent(before_send) ⇒ 未到达，可立即续发', () => {
    const d = classifyOutcome(notSentOutcome('before_send'), ctx);
    expect(d.kind).toBe('network_error');
    expect(d.retry).toBe('immediate');
    expect(d.mayHaveReachedPlatform).toBe(false);
  });

  it('not_sent(during_send) ⇒ 可能已到达，退避且提交侧查原单', () => {
    const d = classifyOutcome(notSentOutcome('during_send'), ctx);
    expect(d.mayHaveReachedPlatform).toBe(true);
    expect(d.retry).toBe('after_delay');
  });
});

describe('M-R04 超时 / 网络错误：可能已到达平台', () => {
  it('timeout ⇒ timeout，可能已到达，退避', () => {
    const d = classifyOutcome({ transport: 'timeout', detail: 'x' }, ctx);
    expect(d.kind).toBe('timeout');
    expect(d.mayHaveReachedPlatform).toBe(true);
    expect(d.retry).toBe('after_delay');
  });

  it('network_error(during_send) ⇒ 可能已到达', () => {
    const d = classifyOutcome(networkErrorOutcome('during_send'), ctx);
    expect(d.kind).toBe('network_error');
    expect(d.mayHaveReachedPlatform).toBe(true);
    expect(d.retry).toBe('after_delay');
  });

  it('network_error(before_send) ⇒ 未到达，可立即续发', () => {
    const d = classifyOutcome(networkErrorOutcome('before_send'), ctx);
    expect(d.mayHaveReachedPlatform).toBe(false);
    expect(d.retry).toBe('immediate');
  });
});

describe('M-R04 429：可重试限流，不是终态拒单（本层核心纠正）', () => {
  it('429 + Retry-After: 120 ⇒ rate_limited，等待 120000ms', () => {
    const d = classifyOutcome(rateLimitedOutcome('120'), ctx);
    expect(d.kind).toBe('rate_limited');
    expect(d.kind).not.toBe('business_failure');
    expect(d.retry).toBe('after_delay');
    expect(d.retryAfterMs).toBe(120_000);
    expect(d.httpStatus).toBe(429);
    expect(d.mayHaveReachedPlatform).toBe(true);
  });

  it('429 无 Retry-After ⇒ 仍是 rate_limited（retryAfterMs 为 null，按退避等待）', () => {
    const d = classifyOutcome(rateLimitedOutcome(null), ctx);
    expect(d.kind).toBe('rate_limited');
    expect(d.retryAfterMs).toBeNull();
    expect(d.retry).toBe('after_delay');
  });

  it('429 不得被当成"确定性失败/未到达"', () => {
    const d = classifyOutcome(rateLimitedOutcome('5'), ctx);
    expect(d.retry).not.toBe('no');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });
});

describe('M-R04 5xx / 408 / 409', () => {
  it('503 ⇒ server_error，可能已到达，退避', () => {
    const d = classifyOutcome(serverErrorOutcome(503), ctx);
    expect(d.kind).toBe('server_error');
    expect(d.retry).toBe('after_delay');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });

  it('500 ⇒ server_error', () => {
    expect(classifyOutcome(serverErrorOutcome(500), ctx).kind).toBe('server_error');
  });

  it('408 ⇒ timeout（可能已到达）', () => {
    const d = classifyOutcome(httpOutcome({ httpStatus: 408 }), ctx);
    expect(d.kind).toBe('timeout');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });

  it('409 ⇒ unknown（冲突可能是"已存在"），不当成功、不静默', () => {
    const d = classifyOutcome(httpOutcome({ httpStatus: 409, businessCode: 'conflict' }), ctx);
    expect(d.kind).toBe('unknown');
    expect(d.retry).toBe('after_delay');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });
});

describe('M-R04 4xx（非 429/408/409）：确定性客户端拒绝', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    it(`HTTP ${status} ⇒ client_error，不再重试且未到达`, () => {
      const d = classifyOutcome(httpOutcome({ httpStatus: status }), ctx);
      expect(d.kind).toBe('client_error');
      expect(d.retry).toBe('no');
      expect(d.mayHaveReachedPlatform).toBe(false);
    });
  }
});

describe('M-R04 2xx：业务码决定成败', () => {
  it('200 + ok ⇒ success（唯一成功组合）', () => {
    const d = classifyOutcome(okHttpOutcome('MT-1'), ctx);
    expect(d.kind).toBe('success');
    expect(d.retry).toBe('no');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });

  it('200 + sold_out ⇒ business_failure（HTTP 成功但业务失败，不报成功）', () => {
    const d = classifyOutcome(businessFailureHttpOutcome('sold_out'), ctx);
    expect(d.kind).toBe('business_failure');
    expect(d.retry).toBe('no');
    expect(d.mayHaveReachedPlatform).toBe(false);
  });

  it('200 + price_changed ⇒ business_failure', () => {
    expect(classifyOutcome(businessFailureHttpOutcome('price_changed'), ctx).kind).toBe('business_failure');
  });

  it('200 + 空业务码 ⇒ unknown（不猜成功）', () => {
    const d = classifyOutcome(businessFailureHttpOutcome(''), ctx);
    expect(d.kind).toBe('unknown');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });

  it('200 + 未登记业务码 ⇒ unknown', () => {
    expect(classifyOutcome(businessFailureHttpOutcome('some_new_code_2099'), ctx).kind).toBe('unknown');
  });

  it('200 + duplicate_order ⇒ unknown（订单可能已存在，须查原单）', () => {
    expect(classifyOutcome(businessFailureHttpOutcome('duplicate_order'), ctx).kind).toBe('unknown');
  });
});

describe('M-R04 不可解释输入一律按未知', () => {
  it('302 重定向 ⇒ unknown', () => {
    expect(classifyOutcome(httpOutcome({ httpStatus: 302 }), ctx).kind).toBe('unknown');
  });
  it('非整数状态码 ⇒ unknown', () => {
    expect(classifyOutcome(httpOutcome({ httpStatus: 200.5 }), ctx).kind).toBe('unknown');
  });
  it('null 结果 ⇒ unknown（可能已到达）', () => {
    const d = classifyOutcome(null as unknown as Parameters<typeof classifyOutcome>[0], ctx);
    expect(d.kind).toBe('unknown');
    expect(d.mayHaveReachedPlatform).toBe(true);
  });
});

describe('M-R04 与 M07 的差异（同一输入并行断言，把纠正钉住）', () => {
  it('429：本层判 rate_limited；M07 当前并入 4xx ⇒ business_failure（差异监控）', () => {
    const m07 = classifySubmitResponse({ transport: 'response', httpStatus: 429, businessCode: 'rate_limited' });
    const mine = classifyOutcome(rateLimitedOutcome('120'), ctx);

    // 本层判据不可协商：429 是可重试限流，不是终态拒单。
    expect(mine.kind).toBe('rate_limited');
    expect(mine.retry).toBe('after_delay');
    expect(mine.mayHaveReachedPlatform).toBe(true);

    if (m07.kind === 'business_failure') {
      // 差异仍在：M07 把 429 当确定性拒单（needsQuery=false，会停在 rejected）。
      expect(m07.needsQuery).toBe(false);
      expect(mine.kind).not.toBe('business_failure');
    } else {
      // 差异已收敛：M07 不再把 429 判成终态拒单（integrationRequest 已落地）。
      expect(m07.kind === 'unknown' || m07.needsQuery).toBe(true);
    }
  });

  it('超时 / 5xx：两包一致地判为未知（无差异，复用而非重造）', () => {
    expect(classifySubmitResponse({ transport: 'timeout', detail: 'x' }).kind).toBe('unknown');
    expect(classifyOutcome({ transport: 'timeout', detail: 'x' }, ctx).kind).not.toBe('success');

    expect(classifySubmitResponse({ transport: 'response', httpStatus: 503, businessCode: 'ok' }).kind).toBe('unknown');
    expect(classifyOutcome(serverErrorOutcome(503), ctx).kind).toBe('server_error');
    // 两者都"不是成功"，语义方向一致。
    expect(classifyOutcome(serverErrorOutcome(503), ctx).kind).not.toBe('success');
  });
});
