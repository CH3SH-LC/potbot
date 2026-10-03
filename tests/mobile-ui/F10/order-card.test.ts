/**
 * F10 验收：订单卡「未付 / 未知 / 取消各态准确」。
 *
 * 用**真实的 M09 视图构造**（`buildOrderLifecycleView`）与**真实的 M07 状态判据**
 * （`mayClaimOrderPlaced` 等）驱动，不是自造 mock。核心断言：
 *   - 未付 ≠ 已付：`W_CREATED` ⇒ payment=unpaid、status=awaiting_payment；
 *   - 未知 ≠ 成功：未知状态码 ⇒ 全阶段 unknown、任何阶段都不得为 confirmed；
 *   - 取消 ≠ 完成：`W_CANCELLED_*` ⇒ isCancelled、且 completed 阶段不得为 confirmed；
 *   - 「已下单」只有 M07 confirmed 可声称；生命周期卡恒不可声称。
 */

import { describe, expect, it } from 'vitest';

import {
  buildOrderCardFromLifecycle,
  buildOrderSubmitView,
} from '../../../apps/mobile-ui/src/food/index.js';
import {
  buildOrderLifecycleView,
  confirmedStages,
  type OrderQueryResult,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';

function result(rawStatusCode: string, refundStatusCode: string | null = null): OrderQueryResult {
  return {
    externalId: 'MT-ORDER-77',
    accountRef: 'acct:user-1',
    amountMinor: 5300,
    currency: 'CNY',
    rawStatusCode,
    refundStatusCode,
    refundAmountMinor: refundStatusCode === 'R_SETTLED' ? 5300 : null,
    observedAt: 301000,
    evidenceRef: 'fixture://order/MT-ORDER-77',
  };
}

function cardFor(rawStatusCode: string, refundStatusCode: string | null = null) {
  return buildOrderCardFromLifecycle(buildOrderLifecycleView(result(rawStatusCode, refundStatusCode)));
}

describe('F10 订单卡 · 未付 ≠ 已付', () => {
  it('W_CREATED：已下单未支付 ⇒ payment=unpaid、status=awaiting_payment', () => {
    const card = cardFor('W_CREATED');
    expect(card.payment).toBe('unpaid');
    expect(card.status).toBe('awaiting_payment');
    expect(card.isCancelled).toBe(false);
    expect(card.isUnknown).toBe(false);
    expect(card.amount.display).toBe('53.00');
    expect(confirmedStages(buildOrderLifecycleView(result('W_CREATED')))).toEqual(['placed']);
  });

  it('支付失败 ≠ 未付：W_PAY_FAILED ⇒ payment=failed、status=payment_failed', () => {
    const card = cardFor('W_PAY_FAILED');
    expect(card.payment).toBe('failed');
    expect(card.status).toBe('payment_failed');
    expect(card.payment).not.toBe('unpaid');
  });
});

describe('F10 订单卡 · 未知 ≠ 成功', () => {
  it('未知状态码 ⇒ 全阶段 unknown、任何阶段都不得为 confirmed', () => {
    const view = buildOrderLifecycleView(result('Z_MYSTERY_CODE'));
    const card = buildOrderCardFromLifecycle(view);

    expect(view.statusRecognized).toBe(false);
    expect(card.status).toBe('unknown');
    expect(card.isUnknown).toBe(true);
    expect(card.statusRecognized).toBe(false);
    // 七个阶段里除退款外全部 unknown；无论哪条，都不得是 confirmed。
    expect(card.stages.every((stage) => stage.state !== 'confirmed')).toBe(true);
    expect(confirmedStages(view)).toEqual([]);
    // 未知时不显示为已支付，也不显示为已完成。
    expect(card.payment).toBe('unknown');
  });
});

describe('F10 订单卡 · 取消 ≠ 完成', () => {
  it('支付前取消：isCancelled、status=cancelled、且完成阶段未确认', () => {
    const card = cardFor('W_CANCELLED_BEFORE_PAY');
    expect(card.isCancelled).toBe(true);
    expect(card.status).toBe('cancelled');
    expect(card.payment).toBe('unpaid');
    expect(card.stages.find((stage) => stage.stage === 'completed')?.state).toBe('absent');
  });

  it('已支付后取消：payment=paid 但 status=cancelled、未完成', () => {
    const card = cardFor('W_CANCELLED_AFTER_PAY');
    expect(card.payment).toBe('paid');
    expect(card.status).toBe('cancelled');
    expect(card.stages.find((stage) => stage.stage === 'completed')?.state).toBe('absent');
  });
});

describe('F10 订单卡 · 正常推进与退款', () => {
  it('W_COMPLETED ⇒ status=completed、payment=paid（仍不可声称「已下达」）', () => {
    const card = cardFor('W_COMPLETED');
    expect(card.status).toBe('completed');
    expect(card.payment).toBe('paid');
    // 生命周期查询不是可信下单回执 ⇒ 恒 false。
    expect(card.placedClaimable).toBe(false);
  });

  it('W_DELIVERING ⇒ status=delivering', () => {
    expect(cardFor('W_DELIVERING').status).toBe('delivering');
  });

  it('退款「已申请」≠「已到账」：R_APPLIED ⇒ settled=false', () => {
    const card = cardFor('W_CANCELLED_AFTER_PAY', 'R_APPLIED');
    expect(card.refund.state).toBe('applied');
    expect(card.refund.settled).toBe(false);
    expect(card.status).toBe('cancelled');
    expect(card.payment).toBe('paid');
  });

  it('退款已到账：R_SETTLED ⇒ settled=true 且带金额', () => {
    const card = cardFor('W_CANCELLED_AFTER_PAY', 'R_SETTLED');
    expect(card.refund.state).toBe('settled');
    expect(card.refund.settled).toBe(true);
    expect(card.refund.amountMinor).toBe(5300);
  });
});

describe('F10 订单卡 · M07 提交状态（只有 confirmed 可声称已下单）', () => {
  it('confirmed 可声称已下单；submitted / unknown 不可', () => {
    expect(buildOrderSubmitView('confirmed').placedClaimable).toBe(true);
    expect(buildOrderSubmitView('submitted').placedClaimable).toBe(false);
    expect(buildOrderSubmitView('unknown').placedClaimable).toBe(false);
    expect(buildOrderSubmitView('submitting').placedClaimable).toBe(false);
    expect(buildOrderSubmitView('cancelled').placedClaimable).toBe(false);
    expect(buildOrderSubmitView('rejected').placedClaimable).toBe(false);
  });

  it('unknown 需查原单；rejected/confirmed/cancelled 为终态', () => {
    expect(buildOrderSubmitView('unknown').needsQuery).toBe(true);
    expect(buildOrderSubmitView('submitted').needsQuery).toBe(false);
    expect(buildOrderSubmitView('rejected').terminal).toBe(true);
    expect(buildOrderSubmitView('confirmed').terminal).toBe(true);
    expect(buildOrderSubmitView('cancelled').terminal).toBe(true);
    expect(buildOrderSubmitView('submitting').terminal).toBe(false);
  });
});
