/**
 * M-I08 边界一：**支付回跳 → M09 生命周期 resumeAfterDisconnect（query-first）**。
 *
 * 本文件的要害（对应单元验收的三条）：
 * 1. 回跳 URL 里写着 `success` ⇒ 仍然 `needsStatusQuery === true`，绝不置已付款；
 * 2. 「收到支付回跳」**不得**在没有支付读回的情况下把订单标成已付款；
 * 3. query-first 只查原单，且**恰好一次**。
 */

import { describe, expect, it } from 'vitest';

import {
  PaymentError,
  resumeOrderAfterPaymentReturn,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import type {
  PaymentQueryPort,
  PaymentQueryRequest,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import type {
  OrderQueryPort,
  OrderQueryRequest,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import {
  EXTERNAL_ID,
  makeCallback,
  makeHandoff,
  makeLifecycle,
  makeOrderPort,
  makeOrderResult,
  makePaymentTracker,
  makeReadback,
} from './support.js';

describe('M-I08 回跳 → 生命周期恢复（query-first）', () => {
  it('回跳 rawOutcome=success 仍 needsStatusQuery=true，绝不置已付款，paid 阶段不 confirmed', async () => {
    const payment = makePaymentTracker();
    // 未提供 paymentPort ⇒ 只做了回跳登记，尚未读回。
    const result = await resumeOrderAfterPaymentReturn({
      payment,
      handoff: makeHandoff(),
      callback: makeCallback({ rawOutcome: 'success' }),
      orderLifecycle: makeLifecycle(),
      orderPort: makeOrderPort(),
    });

    expect(result.returnView.state).toBe('callback_pending_verification');
    expect(result.returnView.needsStatusQuery).toBe(true);
    expect(result.returnView.paidClaimable).toBe(false);
    expect(result.paymentView).toBeNull();
    // 订单侧 fixture 状态码是 W_PAID_WAIT_ACCEPT（订单侧说已支付），
    // 但支付侧未读回 ⇒ 合并后的 paid 阶段仍只能是 pending。
    expect(result.paidStage.state).toBe('pending');
    expect(result.paidStage.confirmedBy).toBe('none');
    expect(result.paidStage.lifecyclePaidState).toBe('confirmed');
    expect(result.paidStage.consistentWithLifecycle).toBe(false);
  });

  it('收到支付回跳不得把订单标成已付款（无读回时 requirePaidView 仍抛 payment_not_paid）', async () => {
    const payment = makePaymentTracker();
    const result = await resumeOrderAfterPaymentReturn({
      payment,
      handoff: makeHandoff(),
      callback: makeCallback({ rawOutcome: 'paid' }),
      orderLifecycle: makeLifecycle(),
      orderPort: makeOrderPort(),
    });

    expect(result.paidStage.state).not.toBe('confirmed');
    expect(payment.state).not.toBe('confirmed_paid');

    let caught: unknown = null;
    try {
      payment.requirePaidView();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PaymentError);
    expect((caught as PaymentError).code).toBe('payment_not_paid');
  });

  it('query-first 只查原单，且恰好一次（reason=resume_after_disconnect）', async () => {
    const payment = makePaymentTracker();
    const orderPort = makeOrderPort([makeOrderResult()]);
    const result = await resumeOrderAfterPaymentReturn({
      payment,
      handoff: makeHandoff(),
      callback: makeCallback(),
      orderLifecycle: makeLifecycle(),
      orderPort,
    });

    expect(result.orderQueryCount).toBe(1);
    expect(orderPort.calls).toHaveLength(1);
    expect(orderPort.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(orderPort.calls[0]?.reason).toBe('resume_after_disconnect');
  });

  it('顺序是 query-first：先查原单，再（可选）支付读回', async () => {
    const sequence: string[] = [];
    const orderPort: OrderQueryPort = {
      async query(request: OrderQueryRequest) {
        sequence.push('order_query');
        return makeOrderResult({ externalId: request.externalId });
      },
    };
    const paymentPort: PaymentQueryPort = {
      identity: 'seq-payment',
      async query(_request: PaymentQueryRequest) {
        sequence.push('payment_readback');
        return makeReadback({ paidState: 'unpaid' });
      },
    };

    const result = await resumeOrderAfterPaymentReturn({
      payment: makePaymentTracker(),
      handoff: makeHandoff(),
      callback: makeCallback(),
      orderLifecycle: makeLifecycle(),
      orderPort,
      paymentPort,
    });

    expect(sequence).toEqual(['order_query', 'payment_readback']);
    expect(result.paymentView?.state).toBe('awaiting_user');
    expect(result.paidStage.state).toBe('pending');
    expect(result.paidStage.confirmedBy).toBe('none');
  });
});
