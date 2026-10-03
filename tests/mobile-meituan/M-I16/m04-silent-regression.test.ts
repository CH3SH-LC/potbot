/**
 * M-I16 定向回归 —— 证明「服务端改价」在 M04 层是**静默**的，因此必须由本层捕获。
 *
 * 这是 M-R03 集成请求的收尾：不只是断言本层能发现改价，而是**把 M04 的盲区变成可回归的
 * 事实**——同一份 `paramsDigest` 下服务端改了配送费/单价，M04 的一致性核对
 * （`verifyQuoteAgainstRequest`）与可用性判定（`checkQuote`）都**照样通过**。
 * 一旦有人以为 M04 已经覆盖了改价，本用例会立刻失败。
 *
 * 只读 M04 源码（`src/mobile-plugins/meituan/cart/`），不修改它。
 */

import { describe, expect, it } from 'vitest';

import {
  QuoteIntegrityError,
  verifyQuoteAgainstRequest,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { createScenario, fillStandardCart } from './support.js';

describe('M-I16 定向回归：M04 对同指纹服务端改价是静默的', () => {
  it('配送费 300→500：M04 一致性核对通过、checkQuote 仍「可用」，本层捕获 price_changed', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.deliveryFeeMinor = 500; // 服务端改价，购物车参数未动
    const q2 = await session.requestQuote(); // requestQuote 内部已过 verifyQuoteAgainstRequest

    // (1) 显式回放 M04 的一致性核对：不抛错 ⇒ M04 认为这份报价自洽、可接受。
    const request = session.describeRequest();
    expect(() => verifyQuoteAgainstRequest(q2, request)).not.toThrow();

    // (2) M04 的可用性判定仍说「可用」——改价对 M04 不可见。
    expect(session.checkQuote(q2).usable).toBe(true);

    // (3) 但参数指纹确实一致、金额确实变了（这正是 M04 看不见的那条缝）。
    expect(q2.paramsDigest).toBe(q1.paramsDigest);
    expect(q2.amount).toBe(q1.amount + 200);

    // (4) 本层把这条缝抓出来：必须重新确认，原因是 price_changed。
    const assessment = guard.assess(q2);
    expect(assessment.needed).toBe(true);
    expect(assessment.reasons).toContain('price_changed');
    expect(assessment.amountDeltaMinor).toBe(200);
  });

  it('单价 3800→4200（数量 2）：同样对 M04 静默，本层捕获 unit_price_changed', async () => {
    const { session, guard, server } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    guard.confirm(q1, 'confirm-1');

    server.unitAmountsMinor['sku-noodle'] = 4200;
    const q2 = await session.requestQuote();

    expect(() => verifyQuoteAgainstRequest(q2, session.describeRequest())).not.toThrow();
    expect(session.checkQuote(q2).usable).toBe(true);
    expect(q2.paramsDigest).toBe(q1.paramsDigest);

    const assessment = guard.assess(q2);
    expect(assessment.needed).toBe(true);
    expect(assessment.priceDiff?.changedKinds).toContain('unit_price_changed');
    expect(assessment.amountDeltaMinor).toBe(800);
  });

  it('反向对照：真正不自洽的报价，M04 仍会报错（不是「M04 一律放行」）', async () => {
    const { session } = createScenario();
    fillStandardCart(session);
    const q1 = await session.requestQuote();
    // 篡改总价制造真正的自洽性破坏：amount 与 subtotal-折扣+费用 不符。
    const tampered = Object.freeze({ ...q1, amount: q1.amount + 1 });
    expect(() => verifyQuoteAgainstRequest(tampered, session.describeRequest())).toThrow(QuoteIntegrityError);
  });
});
