/**
 * M08 边界四：**用户支付 / 取消 / 失效**是三条独立的事件。
 *
 * 反向对照（本文件的要害）：
 * - `user_cancelled` 与 `expired` 都**不得**被当成已付款，也不得被当成彼此；
 * - 已付款后不得再 `cancel`（那是退款，不属本包）；
 * - 未到期时 `checkExpiry` **不得**改状态。
 */

import { describe, expect, it } from 'vitest';

import { PaymentError, PaymentTracker, mayClaimPaid } from '../../../src/mobile-plugins/meituan/payment/index.js';
import { EXPIRES_AT, T0, createClock, fixturePolicy, makeHandoff, makeIntent, makeReadback } from './support.js';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PaymentError ? error.code : 'not-a-payment-error';
  }
}

describe('M08 用户支付 / 取消 / 失效 三条独立词', () => {
  it('cancel 从 awaiting_user 进入 user_cancelled，且不声称已付款', () => {
    const t = new PaymentTracker({ intent: makeIntent(), clock: createClock(), linkPolicy: fixturePolicy() });
    t.begin(makeHandoff());
    const view = t.cancel();
    expect(view.state).toBe('user_cancelled');
    expect(view.paidClaimable).toBe(false);
    expect(codeOf(() => t.requirePaidView())).toBe('payment_not_paid');
  });

  it('user_cancelled 与 expired 是两个不同的状态', () => {
    const clock = createClock();
    const a = new PaymentTracker({ intent: makeIntent(), clock, linkPolicy: fixturePolicy() });
    a.begin(makeHandoff());
    const cancelled = a.cancel();

    const b = new PaymentTracker({ intent: makeIntent(), clock, linkPolicy: fixturePolicy() });
    b.begin(makeHandoff());
    clock.set(EXPIRES_AT);
    const expired = b.checkExpiry();

    expect(cancelled.state).not.toBe(expired.state);
    expect(mayClaimPaid(cancelled.state)).toBe(false);
    expect(mayClaimPaid(expired.state)).toBe(false);
  });

  it('期限后 checkExpiry 进入 expired；未到期不改状态', () => {
    const clock = createClock();
    const t = new PaymentTracker({ intent: makeIntent(), clock, linkPolicy: fixturePolicy() });
    t.begin(makeHandoff());
    clock.set(T0 + 1000);
    const before = t.checkExpiry();
    expect(before.state).toBe('awaiting_user');
    clock.set(EXPIRES_AT);
    const after = t.checkExpiry();
    expect(after.state).toBe('expired');
  });

  it('展示一个已过期的交接 ⇒ 直接进入 expired（不假装还能支付）', () => {
    const clock = createClock(EXPIRES_AT);
    const t = new PaymentTracker({ intent: makeIntent(), clock, linkPolicy: fixturePolicy() });
    const view = t.begin(makeHandoff());
    expect(view.state).toBe('expired');
    expect(view.paidClaimable).toBe(false);
  });

  it('已付款是终态：之后 cancel 非法', async () => {
    const t = new PaymentTracker({ intent: makeIntent(), clock: createClock(), linkPolicy: fixturePolicy() });
    t.begin(makeHandoff());
    await t.refresh({ identity: 'fixture', query: async () => makeReadback() });
    expect(t.state).toBe('confirmed_paid');
    expect(codeOf(() => t.cancel())).toBe('illegal_payment_transition');
  });

  it('已付款后 checkExpiry 不得把终态改回 expired', () => {
    const clock = createClock();
    const t = new PaymentTracker({ intent: makeIntent(), clock, linkPolicy: fixturePolicy() });
    t.begin(makeHandoff());
    // 直接以 paid 读回确认（同步驱动：先 refresh）
    return t.refresh({ identity: 'fixture', query: async () => makeReadback() }).then(() => {
      clock.set(EXPIRES_AT + 1);
      const view = t.checkExpiry();
      expect(view.state).toBe('confirmed_paid');
    });
  });

  it('unknown 不是已付款，也不是失败；可被后续读回收口', async () => {
    const t = new PaymentTracker({ intent: makeIntent(), clock: createClock(), linkPolicy: fixturePolicy() });
    t.begin(makeHandoff());
    const unknown = await t.refresh({ identity: 'fixture', query: async () => makeReadback({ paidState: 'unknown' }) });
    expect(unknown.state).toBe('unknown');
    expect(mayClaimPaid(unknown.state)).toBe(false);
    const settled = await t.refresh({ identity: 'fixture', query: async () => makeReadback() });
    expect(settled.state).toBe('confirmed_paid');
  });
});
