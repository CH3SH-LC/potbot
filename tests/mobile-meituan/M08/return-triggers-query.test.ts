/**
 * M08 边界二：**回跳只触发状态查询**。
 *
 * 反向对照（本文件的要害）：`handleReturn` 之后状态**必须**停在
 * `callback_pending_verification`，且 `paidClaimable === false`、
 * `needsStatusQuery === true`。即便回跳 URL 里写着 `result=success`，也不得确认已付款。
 * 任何给 `handleReturn` 加上「confirmed_paid」分支的改动都会让本文件变红。
 */

import { describe, expect, it } from 'vitest';

import {
  PaymentError,
  PaymentTracker,
  mayClaimPaid,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import {
  createClock,
  fixturePolicy,
  makeCallback,
  makeHandoff,
  makeIntent,
  makeReadback,
} from './support.js';

function tracker(overrides: Parameters<typeof makeIntent>[0] = {}): PaymentTracker {
  return new PaymentTracker({ intent: makeIntent(overrides), clock: createClock(), linkPolicy: fixturePolicy() });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PaymentError ? error.code : 'not-a-payment-error';
  }
}

describe('M08 回跳只触发查询，不是付款证据', () => {
  it('handleReturn 只推进到 callback_pending_verification，绝不置已付款', () => {
    const t = tracker();
    t.begin(makeHandoff());
    const view = t.handleReturn(makeCallback({ rawOutcome: 'success' }));
    expect(view.state).toBe('callback_pending_verification');
    expect(view.paidClaimable).toBe(false);
    expect(view.needsStatusQuery).toBe(true);
    expect(mayClaimPaid(view.state)).toBe(false);
  });

  it('rawOutcome=success 不改变结论：requirePaidView 仍抛 payment_not_paid', () => {
    const t = tracker();
    t.begin(makeHandoff());
    t.handleReturn(makeCallback({ rawOutcome: 'success' }));
    expect(codeOf(() => t.requirePaidView())).toBe('payment_not_paid');
  });

  it('回跳后必须 refresh 才可能确认：读回 paid 才进入 confirmed_paid', async () => {
    const t = tracker();
    t.begin(makeHandoff());
    t.handleReturn(makeCallback());
    const view = await t.refresh({ identity: 'fixture', query: async () => makeReadback() });
    expect(view.state).toBe('confirmed_paid');
    expect(view.paidClaimable).toBe(true);
    expect(view.needsStatusQuery).toBe(false);
  });

  it('回跳后读回 unpaid ⇒ 退回 awaiting_user，不得声称已付款', async () => {
    const t = tracker();
    t.begin(makeHandoff());
    t.handleReturn(makeCallback());
    const view = await t.refresh({ identity: 'fixture', query: async () => makeReadback({ paidState: 'unpaid' }) });
    expect(view.state).toBe('awaiting_user');
    expect(view.paidClaimable).toBe(false);
    expect(view.note).toContain('不得声称已付款');
  });

  it('未 begin 直接 handleReturn 非法（回跳不能凭空推进状态机）', () => {
    const t = tracker();
    expect(codeOf(() => t.handleReturn(makeCallback()))).toBe('illegal_payment_transition');
  });

  it('自造（拷贝）的回跳被拒：untrusted_payment_callback', () => {
    const t = tracker();
    t.begin(makeHandoff());
    const genuine = makeCallback();
    const forged = { ...genuine };
    expect(codeOf(() => t.handleReturn(forged as unknown as typeof genuine))).toBe('untrusted_payment_callback');
  });

  it('回跳指向别的支付意图被拒：payment_intent_mismatch', () => {
    const t = tracker();
    t.begin(makeHandoff());
    const other = makeCallback({ paymentIntentRef: 'pi-other' });
    expect(codeOf(() => t.handleReturn(other))).toBe('payment_intent_mismatch');
  });
});
