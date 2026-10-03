/**
 * M-I08 边界二：**confirmed_paid → M09 生命周期 paid 阶段报告**。
 *
 * 要害：`paid` 阶段的 `confirmed` **只**能由支付侧受控读回（`confirmed_paid`）驱动；
 * 订单状态码自己说「已支付」也不足以让合并报告变成 confirmed（见 query-first 文件）。
 * 两侧不一致时如实标注 `consistentWithLifecycle === false`，不替任何一侧圆场。
 */

import { describe, expect, it } from 'vitest';

import {
  PAYMENT_STATES,
  PAYMENT_STATE_TO_LIFECYCLE_PAID_STAGE,
  buildPaidStageReport,
  resumeOrderAfterPaymentReturn,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import type {
  PaymentQueryPort,
  PaymentState,
  PaymentView,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import { buildOrderLifecycleView } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import {
  ACCOUNT_REF,
  AMOUNT_MINOR,
  CURRENCY,
  EXTERNAL_ID,
  PROVIDER,
  T0,
  makeCallback,
  makeHandoff,
  makeLifecycle,
  makeOrderPort,
  makeOrderResult,
  makePaymentTracker,
  makeReadback,
} from './support.js';

/** 由状态直接造一张支付视图（纯数据，用于逐态核对映射表）。 */
function viewWithState(state: PaymentState): PaymentView {
  return Object.freeze({
    paymentIntentRef: 'pi-1',
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    provider: PROVIDER,
    state,
    paidClaimable: state === 'confirmed_paid',
    needsStatusQuery: state === 'awaiting_user' || state === 'callback_pending_verification',
    handoffRef: null,
    lastCallbackRef: null,
    lastReadback: null,
    note: '',
    observedAt: T0,
  });
}

function orderViewWith(rawStatusCode: string) {
  return buildOrderLifecycleView(makeOrderResult({ rawStatusCode }));
}

describe('M-I08 confirmed_paid → paid 阶段报告', () => {
  it('只有 confirmed_paid 映射到 paid=confirmed（逐态核对）', () => {
    const orderView = orderViewWith('W_PAID_WAIT_ACCEPT');
    for (const state of PAYMENT_STATES) {
      expect(PAYMENT_STATE_TO_LIFECYCLE_PAID_STAGE[state] === 'confirmed').toBe(state === 'confirmed_paid');
      const report = buildPaidStageReport(viewWithState(state), orderView);
      expect(report.stage).toBe('paid');
      expect(report.state === 'confirmed').toBe(state === 'confirmed_paid');
      expect(report.confirmedBy).toBe(state === 'confirmed_paid' ? 'payment_readback' : 'none');
    }
  });

  it('可信读回 paid ⇒ 支付 confirmed_paid，paid 阶段 confirmed（端到端）', async () => {
    const paymentPort: PaymentQueryPort = {
      identity: 'e2e-payment',
      async query() {
        return makeReadback({ paidState: 'paid' });
      },
    };
    const result = await resumeOrderAfterPaymentReturn({
      payment: makePaymentTracker(),
      handoff: makeHandoff(),
      callback: makeCallback({ rawOutcome: 'success' }),
      orderLifecycle: makeLifecycle(),
      orderPort: makeOrderPort([makeOrderResult({ rawStatusCode: 'W_PAID_WAIT_ACCEPT' })]),
      paymentPort,
    });

    expect(result.paymentView?.state).toBe('confirmed_paid');
    expect(result.paidStage.state).toBe('confirmed');
    expect(result.paidStage.confirmedBy).toBe('payment_readback');
    expect(result.paidStage.lifecyclePaidState).toBe('confirmed');
    expect(result.paidStage.consistentWithLifecycle).toBe(true);
  });

  it('读回 unpaid ⇒ paid 阶段 pending，confirmedBy=none', async () => {
    const result = await resumeOrderAfterPaymentReturn({
      payment: makePaymentTracker(),
      handoff: makeHandoff(),
      callback: makeCallback(),
      orderLifecycle: makeLifecycle(),
      orderPort: makeOrderPort([makeOrderResult({ rawStatusCode: 'W_PAID_WAIT_ACCEPT' })]),
      paymentPort: { identity: 'p', async query() { return makeReadback({ paidState: 'unpaid' }); } },
    });

    expect(result.paymentView?.state).toBe('awaiting_user');
    expect(result.paidStage.state).toBe('pending');
    expect(result.paidStage.confirmedBy).toBe('none');
  });

  it('读回 failed ⇒ paid 阶段 failed', async () => {
    const result = await resumeOrderAfterPaymentReturn({
      payment: makePaymentTracker(),
      handoff: makeHandoff(),
      callback: makeCallback(),
      orderLifecycle: makeLifecycle(),
      orderPort: makeOrderPort([makeOrderResult({ rawStatusCode: 'W_PAY_FAILED' })]),
      paymentPort: { identity: 'p', async query() { return makeReadback({ paidState: 'failed' }); } },
    });

    expect(result.paymentView?.state).toBe('failed');
    expect(result.paidStage.state).toBe('failed');
    expect(result.paidStage.confirmedBy).toBe('none');
  });

  it('支付已确认但订单侧 paid 阶段不一致 ⇒ confirmed 且如实标不一致（不圆场）', () => {
    // 订单状态码 W_CREATED：订单侧 paid=absent；支付侧读回说 paid。
    const orderView = orderViewWith('W_CREATED');
    const report = buildPaidStageReport(viewWithState('confirmed_paid'), orderView);

    expect(report.state).toBe('confirmed');
    expect(report.confirmedBy).toBe('payment_readback');
    expect(report.lifecyclePaidState).toBe('absent');
    expect(report.consistentWithLifecycle).toBe(false);
    expect(report.note).toContain('不一致');
  });

  it('订单侧说已支付但支付侧未读回 ⇒ 不 confirmed（订单状态不能替代支付读回）', () => {
    const orderView = orderViewWith('W_PAID_WAIT_ACCEPT');
    const report = buildPaidStageReport(viewWithState('callback_pending_verification'), orderView);

    expect(report.lifecyclePaidState).toBe('confirmed');
    expect(report.state).toBe('pending');
    expect(report.confirmedBy).toBe('none');
    expect(report.consistentWithLifecycle).toBe(false);
    expect(report.note).toContain('不得声称已付款');
  });

  it('用户取消 / 失效 ⇒ paid 阶段 absent（不是失败，也不是已付款）', () => {
    const orderView = orderViewWith('W_CREATED');
    expect(buildPaidStageReport(viewWithState('user_cancelled'), orderView).state).toBe('absent');
    expect(buildPaidStageReport(viewWithState('expired'), orderView).state).toBe('absent');
    expect(buildPaidStageReport(viewWithState('unknown'), orderView).state).toBe('unknown');
  });
});
