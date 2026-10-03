/**
 * M04 **反向对照（本包核心）**：任何影响计价的参数变化，都必须让既有报价失效。
 *
 * 每个用例都先断言「变化之前报价可用」——否则失效规则可能只是恒假的空壳
 * （永远报失效的测试也能"通过"，那没有意义）。
 */

import { describe, expect, it } from 'vitest';

import {
  QuoteStaleError,
  type Quote,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { createScenario, fillStandardCart, type Scenario } from './support.js';

/**
 * 先取一份可用报价，执行 `mutate`，再断言旧报价被判失效。
 * 三步都在一个用例里，任何一步偷懒都会露馅。
 */
async function expectInvalidated(
  mutate: (scenario: Scenario, quote: Quote) => void,
  expectedReason: 'params_changed' | 'not_current' | 'invalidated',
): Promise<void> {
  const scenario = createScenario();
  fillStandardCart(scenario.session);
  const quote = await scenario.session.requestQuote();

  const before = scenario.session.checkQuote(quote);
  expect(before.usable).toBe(true);
  expect(before.reasons).toEqual([]);

  mutate(scenario, quote);

  const after = scenario.session.checkQuote(quote);
  expect(after.usable).toBe(false);
  expect(after.reasons).toContain(expectedReason);
  expect(after.detail.length).toBeGreaterThan(0);

  expect(() => scenario.session.requireUsableQuote(quote)).toThrow(QuoteStaleError);
}

describe('M04 失效规则：条目变化', () => {
  it('改数量 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      const line = scenario.session.cart.lines[0];
      scenario.session.cart.setLineQuantity(line?.lineId ?? '', 5);
    }, 'params_changed');
  });

  it('改规格 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      const line = scenario.session.cart.lines[0];
      scenario.session.cart.setLineSpecs(line?.lineId ?? '', [{ groupId: 'spice', optionId: 'hot' }]);
    }, 'params_changed');
  });

  it('加条目 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.cart.addLine({ dishId: 'dish-congee', skuId: 'sku-congee', quantity: 1 });
    }, 'params_changed');
  });

  it('删条目 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      const line = scenario.session.cart.lines[0];
      scenario.session.cart.removeLine(line?.lineId ?? '');
    }, 'params_changed');
  });

  it('清空条目 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.cart.clearLines();
    }, 'params_changed');
  });
});

describe('M04 失效规则：地址与费用优惠变化', () => {
  it('换配送地址 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.cart.setDeliveryAddress('addr-office');
    }, 'params_changed');
  });

  it('清除配送地址 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.cart.setDeliveryAddress(null);
    }, 'params_changed');
  });

  it('勾选优惠码 ⇒ 旧报价失效（费用/优惠变化）', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.cart.setPricingInputs({ couponCodes: ['COUPON-5'] });
    }, 'params_changed');
  });

  it('加附加服务 ⇒ 旧报价失效（费用变化）', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.cart.setPricingInputs({ serviceOptions: ['cutlery'] });
    }, 'params_changed');
  });

  it('端口报告服务端费用变更时显式作废 ⇒ 旧报价失效', async () => {
    await expectInvalidated((scenario) => {
      scenario.session.invalidateCurrentQuote('服务端配送费已调整');
    }, 'invalidated');
  });
});

describe('M04 失效规则：被取代与显式关卡', () => {
  it('取到更新的报价后，旧报价不再是当前报价', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const stale = await scenario.session.requestQuote();
    const fresh = await scenario.session.requestQuote();

    expect(scenario.session.currentQuoteRef).toBe(fresh.quoteRef);
    const check = scenario.session.checkQuote(stale);
    expect(check.usable).toBe(false);
    expect(check.reasons).toContain('not_current');
  });

  it('未被变化的报价仍然可用（防止「永远报失效」的空壳实现）', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    expect(scenario.session.checkQuote(quote).usable).toBe(true);
    await expect(scenario.session.requestQuote()).resolves.toBeTruthy();
  });

  it('参数指纹确实随参数变化（失效判定不是空转）', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.session.cart.setLineQuantity(scenario.session.cart.lines[0]?.lineId ?? '', 9);
    expect(scenario.session.describeRequest().paramsDigest).not.toBe(quote.paramsDigest);
  });

  it('显式作废必须给出非空原因', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    await scenario.session.requestQuote();

    expect(() => scenario.session.invalidateCurrentQuote('   ')).toThrow();
  });

  it('没有当前报价时无法作废', () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    expect(() => scenario.session.invalidateCurrentQuote('无缘无故')).toThrow();
  });
});

describe('M04 确认失效：基于旧报价的确认草稿也随之失效', () => {
  it('报价可用时能生成草稿，且草稿不是用户确认', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    const draft = scenario.session.createConfirmationDraft(quote);

    expect(draft.kind).toBe('local_draft_only');
    expect(draft.authoritative).toBe(false);
    expect(draft.quoteRef).toBe(quote.quoteRef);
    expect(draft.amount).toBe(quote.amount);
    expect(scenario.session.checkConfirmationDraft(draft).usable).toBe(true);
  });

  it('报价因参数变化失效后，草稿同步失效', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();
    const draft = scenario.session.createConfirmationDraft(quote);

    scenario.session.cart.setDeliveryAddress('addr-office');

    const check = scenario.session.checkConfirmationDraft(draft);
    expect(check.usable).toBe(false);
    expect(check.reasons).toContain('params_changed');
  });

  it('报价已失效时不允许生成草稿（关卡前移）', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    scenario.session.cart.setPricingInputs({ couponCodes: ['COUPON-5'] });

    expect(() => scenario.session.createConfirmationDraft(quote)).toThrow(QuoteStaleError);
  });
});
