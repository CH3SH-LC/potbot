/**
 * M08 边界六：**结构性边界与非合并口径**。
 *
 * 断言本包导出的边界常量、状态词表与视图里**没有**任何把支付简化成单一成功的说法。
 */

import { describe, expect, it } from 'vitest';

import {
  PAYMENT_BOUNDARY,
  PAYMENT_STATES,
  PAYMENT_TERMINAL_STATES,
  PaymentTracker,
  checkPaymentTransition,
  describePaymentState,
  isTerminalPaymentState,
  mayClaimPaid,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import { createClock, fixturePolicy, makeIntent } from './support.js';

describe('M08 结构性边界', () => {
  it('边界常量声明：不收集凭据 / 不提交支付 / 不在无读回时确认 / 不把回跳当已付款', () => {
    expect(PAYMENT_BOUNDARY.collectsPaymentCredentials).toBe(false);
    expect(PAYMENT_BOUNDARY.submitsPayment).toBe(false);
    expect(PAYMENT_BOUNDARY.confirmsPaymentWithoutReadback).toBe(false);
    expect(PAYMENT_BOUNDARY.treatsCallbackAsPaid).toBe(false);
    expect(PAYMENT_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(PAYMENT_BOUNDARY.connectsRealPlatform).toBe(false);
  });

  it('状态词表没有合并的 ok / success / paid', () => {
    const states = PAYMENT_STATES as readonly string[];
    expect(states).not.toContain('ok');
    expect(states).not.toContain('success');
    expect(states).not.toContain('paid');
    expect(states).toContain('confirmed_paid');
    expect(states).toContain('callback_pending_verification');
  });

  it('mayClaimPaid 只在 confirmed_paid 为真', () => {
    for (const state of PAYMENT_STATES) {
      expect(mayClaimPaid(state)).toBe(state === 'confirmed_paid');
    }
  });

  it('唯一终态是 confirmed_paid（取消/失败/失效可重试）', () => {
    expect(PAYMENT_TERMINAL_STATES).toEqual(['confirmed_paid']);
    expect(isTerminalPaymentState('confirmed_paid')).toBe(true);
    expect(isTerminalPaymentState('user_cancelled')).toBe(false);
    expect(isTerminalPaymentState('expired')).toBe(false);
  });

  it('视图里没有 ok / success / status 合并字段', () => {
    const t = new PaymentTracker({ intent: makeIntent(), clock: createClock(), linkPolicy: fixturePolicy() });
    const keys = Object.keys(t.view);
    expect(keys).not.toContain('ok');
    expect(keys).not.toContain('success');
    expect(keys).not.toContain('status');
    expect(keys).toContain('state');
    expect(keys).toContain('paidClaimable');
  });

  it('转换表：confirmed_paid 之后不得再变；未知态名判非法', () => {
    expect(checkPaymentTransition('confirmed_paid', 'awaiting_user').legal).toBe(false);
    expect(checkPaymentTransition('confirmed_paid', 'awaiting_user').kind).toBe('terminal');
    expect(checkPaymentTransition('not_started', 'callback_pending_verification').legal).toBe(false);
    expect(checkPaymentTransition('nope' as never, 'awaiting_user').legal).toBe(false);
    expect(checkPaymentTransition('awaiting_user', 'awaiting_user').kind).toBe('no_op');
  });

  it('回跳态与已付款态的说明文字互不含糊', () => {
    expect(describePaymentState('callback_pending_verification')).toContain('尚未确认已付款');
    expect(describePaymentState('confirmed_paid')).toContain('读回确认已付款');
    expect(describePaymentState('unknown')).toContain('不得计为已付款');
  });
});
