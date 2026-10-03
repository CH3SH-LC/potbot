/**
 * M-I21 跨包消费者旅程一致性（正例）。
 *
 * 用**各包真实随包发布的 fixture 端口**，把美团线串成一条完整消费旅程并逐阶段断言其
 * 「阶段报告」：
 *
 *   M03 目录快照 → M04 购物车报价 → M05 地址/时段(配送方案) → M06 用户确认
 *   → M07 下单提交 → M08 支付读回 → M09 订单生命周期（+ M08×M09 桥）
 *
 * 断言的重点不是「跑通了」，而是**每一阶段是否如实报告自己走到哪一步**：
 * 报价是不是订单总额（不是）、提交是不是已下单（只有 `confirmed` 才是）、
 * 回跳是不是付款（不是）、平台没给的阶段是不是 `unknown`（不是成功）。
 *
 * 全部为本地确定性 fixture，零网络、不读系统时间、不接任何真实平台。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { makeWeekTime, type DeliveryPoint } from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { describeOrderOutcome } from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { runConsumerJourney, type ConsumerJourney, EXPECTED_QUOTE_AMOUNT_MINOR } from './support.js';

let journey: ConsumerJourney;

beforeAll(async () => {
  journey = await runConsumerJourney();
});

describe('M-I21 阶段一：M03 目录快照 —— 来源齐备、分页完整、未知不补造', () => {
  it('翻完整个菜单：completeness=complete，条目带 sourceRef', () => {
    const { snapshot } = journey.catalog;
    expect(snapshot.merchantId).toBe('merchant-1');
    expect(snapshot.completeness).toBe('complete');
    expect(snapshot.stopReason).toMatch(/nextCursor/);
    expect(snapshot.items.map((item) => item.itemId).sort()).toEqual(['dish-noodle', 'dish-tea']);
    for (const item of snapshot.items) {
      expect(item.sourceRef.provider).toBe('fixture');
      expect(item.sourceRef.retrievedAt).toBe(snapshot.fetchedAt);
    }
  });

  it('营业/配送/起送判定来自显式已知值：营业中、范围内、达到起送', () => {
    const { merchant, service } = journey.catalog;
    // 周一 12:00 落在 [600,1380) 营业窗口内。
    expect(service.operatingStatusOf(merchant, makeWeekTime(1, 720)).state).toBe('open');
    const point: DeliveryPoint = { lat: 31.19, lng: 121.43 };
    expect(service.deliveryRangeOf(merchant, point).state).toBe('within');
    expect(service.minOrderOf(merchant, EXPECTED_QUOTE_AMOUNT_MINOR).state).toBe('meets');
  });
});

describe('M-I21 阶段二：M04 购物车报价 —— 报价不是订单总额、参数指纹回显', () => {
  it('取到的报价金额、币种、指纹一致，且 isOrderTotal 恒为 false', () => {
    const { quote } = journey.cart;
    expect(quote.amount).toBe(EXPECTED_QUOTE_AMOUNT_MINOR);
    expect(quote.currency).toBe('CNY');
    expect(quote.isOrderTotal).toBe(false);
    expect(quote.subtotalMinor).toBe(3800 * 2 + 800);
    expect(quote.paramsDigest).toBe(journey.cart.session.describeRequest().paramsDigest);
  });

  it('报价可用性报告：参数未变、未过期 ⇒ usable', () => {
    const { session, quote } = journey.cart;
    expect(session.checkQuote(quote).usable).toBe(true);
    // 本地确认草稿仍是非权威的——它不是用户确认。
    expect(session.createConfirmationDraft(quote).authoritative).toBe(false);
  });
});

describe('M-I21 阶段三：M05 地址/时段 —— 单一配送方案绑定地址版本与时段', () => {
  it('配送方案 planRef 同时钉住地址引用与时段；当前状态可用', () => {
    const { plan, planCheck, record, slot } = journey.delivery;
    expect(plan.addressRef).toBe(record.ref);
    expect(plan.slotId).toBe(slot.slotId);
    expect(plan.planRef.startsWith('dp1-')).toBe(true);
    expect(planCheck.usable).toBe(true);
    expect(planCheck.reasons).toEqual([]);
  });

  it('地址视图已脱敏：不含手机号明文（只带掩码）', () => {
    const { addressView } = journey.delivery;
    expect(addressView.contactMasked).toBe('张*');
    expect(addressView.phoneMasked).toMatch(/\*/);
    expect(JSON.stringify(addressView)).not.toContain('13800008000');
  });
});

describe('M-I21 阶段四：M06 用户确认 —— ViewModel 只作展示、授权经真实 K07 消费', () => {
  it('确认 ViewModel 是展示态：displayOnly / requiresNativeConfirmation 恒为 true', () => {
    const { viewModel } = journey.confirmation;
    expect(viewModel.displayOnly).toBe(true);
    expect(viewModel.requiresNativeConfirmation).toBe(true);
    expect(viewModel.amounts.totalMinor).toBe(EXPECTED_QUOTE_AMOUNT_MINOR);
    expect(viewModel.merchant.merchantId).toBe('merchant-1');
    expect(viewModel.delivery.addressRef).toBe(journey.delivery.record.ref);
    expect(viewModel.timeSlot.slotRef).toBe(journey.delivery.slot.slotId);
    expect(viewModel.lines).toHaveLength(2);
  });

  it('真实 K07 账本原子占用后产出可信回执并放行购买（requiresNativeConfirmation 恒为 true）', () => {
    const { receipt, authorized, k07 } = journey.confirmation;
    expect(receipt.consumed).toBe(true);
    expect(receipt.paramsDigest).toBe(journey.confirmation.viewModel.paramsDigest);
    expect(receipt.amountMinor).toBe(EXPECTED_QUOTE_AMOUNT_MINOR);
    expect(authorized.amountMinor).toBe(EXPECTED_QUOTE_AMOUNT_MINOR);
    expect(authorized.requiresNativeConfirmation).toBe(true);
    // 真实 K07 侧确实被占用：一条授权、一条提交。
    const counts = k07.ledger.counts();
    expect(counts.grants).toBe(1);
    expect(counts.submissions).toBe(1);
  });
});

describe('M-I21 阶段五：M07 下单提交 —— 受理 ≠ 已下单，回执才收口', () => {
  it('首次提交：业务码 ok ⇒ submitted（受理，尚不可声称已下单）', () => {
    const { first } = journey.submission;
    expect(first.state).toBe('submitted');
    // 「受理」快照的如实描述：placedClaimable 为 false（只有 confirmed 才为 true）。
    expect(describeOrderOutcome(first).placedClaimable).toBe(false);
    expect(first.sendIntentAt).not.toBeNull();
  });

  it('幂等：同键二次提交去重，执行器只被调用一次', () => {
    const { first, second, executorCallCount } = journey.submission;
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.state).toBe('submitted');
    expect(executorCallCount()).toBe(1);
  });

  it('查原单取回可信回执 ⇒ confirmed（唯一可声称已下单的态）', () => {
    const { confirmed, submitter, idempotencyKey } = journey.submission;
    expect(confirmed.state).toBe('confirmed');
    expect(submitter.describeExternalOutcome(idempotencyKey).placedClaimable).toBe(true);
    expect(() => submitter.assertOrderPlacedClaimable(idempotencyKey)).not.toThrow();
  });
});

describe('M-I21 阶段六：M08 支付 —— 回跳不是付款，读回才确认', () => {
  it('展示入口 ⇒ awaiting_user；回跳 ⇒ callback_pending_verification（paidClaimable=false）', () => {
    const { began, returned } = journey.payment;
    expect(began.state).toBe('awaiting_user');
    expect(returned.state).toBe('callback_pending_verification');
    expect(returned.paidClaimable).toBe(false);
    expect(returned.needsStatusQuery).toBe(true);
  });

  it('平台受控读回 paid ⇒ confirmed_paid（唯一可声称已付款的态）', () => {
    const { paid, tracker } = journey.payment;
    expect(paid.state).toBe('confirmed_paid');
    expect(paid.paidClaimable).toBe(true);
    expect(() => tracker.requirePaidView()).not.toThrow();
    expect(paid.amountMinor).toBe(EXPECTED_QUOTE_AMOUNT_MINOR);
  });
});

describe('M-I21 阶段七：M09 订单生命周期 —— 七阶段分别报告，未知码全 unknown', () => {
  it('断线后先查原单：placed / paid 阶段 confirmed', () => {
    const { paidView } = journey.lifecycle;
    expect(paidView.externalId).toBe(journey.submission.providerOrderRef);
    expect(paidView.statusRecognized).toBe(true);
    expect(paidView.stages).toHaveLength(7);
    expect(stageState(paidView, 'placed')).toBe('confirmed');
    expect(stageState(paidView, 'paid')).toBe('confirmed');
    expect(stageState(paidView, 'completed')).toBe('absent');
    // 没有合并的 ok：视图没有单一成功字段。
    expect(paidView).not.toHaveProperty('ok');
    expect(paidView).not.toHaveProperty('success');
  });

  it('轮询推进到已完成：completed 阶段 confirmed', () => {
    const { completedView } = journey.lifecycle;
    expect(stageState(completedView, 'completed')).toBe('confirmed');
    expect(stageState(completedView, 'cancelled')).toBe('absent');
  });

  it('本地不认识的平台码 ⇒ statusRecognized=false 且七阶段全 unknown（不得计为成功）', () => {
    const { unknownView } = journey.lifecycle;
    expect(unknownView.statusRecognized).toBe(false);
    expect(unknownView.stages.every((report) => report.state === 'unknown')).toBe(true);
  });
});

describe('M-I21 阶段八：M08×M09 桥 —— 回跳只触发 query-first，paid 阶段由读回驱动', () => {
  it('回跳 + 读回 ⇒ paid 阶段 confirmed，来源只可能是 payment_readback，原单查询恰好一次', () => {
    const { withReadback } = journey.bridge;
    expect(withReadback.returnView.state).toBe('callback_pending_verification');
    expect(withReadback.orderQueryCount).toBe(1);
    expect(withReadback.paidStage.stage).toBe('paid');
    expect(withReadback.paidStage.state).toBe('confirmed');
    expect(withReadback.paidStage.confirmedBy).toBe('payment_readback');
  });

  it('只登记回跳、不读回 ⇒ paid 阶段仍是 pending（回跳不是付款证据）', () => {
    const { returnOnly } = journey.bridge;
    expect(returnOnly.orderQueryCount).toBe(1);
    expect(returnOnly.paidStage.state).toBe('pending');
    expect(returnOnly.paidStage.confirmedBy).toBe('none');
  });
});

/** 从 M09 视图里取某阶段的报告状态（辅助，避免索引越界）。 */
function stageState(
  view: ConsumerJourney['lifecycle']['paidView'],
  stage: string,
): string {
  const report = view.stages.find((candidate) => candidate.stage === stage);
  if (report === undefined) throw new Error(`视图缺少阶段 ${stage}`);
  return report.state;
}
