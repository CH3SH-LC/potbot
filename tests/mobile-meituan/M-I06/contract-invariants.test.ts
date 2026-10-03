/**
 * M-I06 · 接线后 v2 合同不变量保持完好。
 *
 * 集成不能把保护接丢：
 * - 下单 / 支付 / 取消**必须**带用户确认，且 `autonomousAllowed` 恒为字面量 `false`；
 * - 总金额只来自 **M04 服务端报价**，本地绝不重算；
 * - 金额上限对**报价金额**生效（缺上限即拒、超限即拒）。
 */

import { describe, expect, it } from 'vitest';

import {
  MEITUAN_ACTION_CONTRACT,
  MUTATING_MEITUAN_ACTIONS,
  PurchaseConfirmationError,
  STANDARD_CEILING,
  assertAutonomousPurchaseForbidden,
  validateMeituanBusinessContract,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { formatMinorUnitsAsDecimalString } from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  addressViewOf,
  buildConfirmationFromDelivery,
  createAddressBook,
  quoteForAddress,
  selectSlot,
  standardDeliveryConfirmation,
} from './support.js';

describe('M-I06 v2 业务合同不变量', () => {
  it('合同自洽（静态自检无问题）', () => {
    expect(validateMeituanBusinessContract()).toEqual([]);
  });

  it('下单 / 支付 / 取消都必须确认，且永不自主执行', () => {
    for (const actionId of ['submit-order', 'pay-order', 'cancel-order'] as const) {
      const rule = MEITUAN_ACTION_CONTRACT[actionId];
      expect(rule.mutatesExternalWorld, actionId).toBe(true);
      expect(rule.requiresUserConfirmation, actionId).toBe(true);
      expect(rule.autonomousAllowed, actionId).toBe(false);
      expect(rule.requiredScope).not.toBeNull();
    }
    expect([...MUTATING_MEITUAN_ACTIONS].sort()).toEqual(['cancel-order', 'pay-order', 'submit-order']);
  });

  it('只读动作无需确认且允许自主', () => {
    for (const actionId of ['search-merchant', 'read-menu', 'read-address', 'price-quote', 'query-order'] as const) {
      const rule = MEITUAN_ACTION_CONTRACT[actionId];
      expect(rule.mutatesExternalWorld, actionId).toBe(false);
      expect(rule.requiresUserConfirmation, actionId).toBe(false);
      expect(rule.autonomousAllowed, actionId).toBe(true);
    }
  });

  it('未带用户确认的自主下单 / 支付 / 取消一律拒绝', () => {
    for (const actionId of ['submit-order', 'pay-order', 'cancel-order'] as const) {
      let caught: unknown;
      try {
        assertAutonomousPurchaseForbidden(actionId, false);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PurchaseConfirmationError);
      expect((caught as PurchaseConfirmationError).code).toBe('autonomous_purchase_forbidden');
      // 带上用户确认则不拦（保护在确认链上，不是无脑禁止）。
      expect(() => assertAutonomousPurchaseForbidden(actionId, true)).not.toThrow();
    }
  });
});

describe('M-I06 金额只来自 M04 服务端报价，绝不本地重算', () => {
  it('ViewModel 总价 === 报价 amount，展示串由报价金额导出', async () => {
    const { quote, viewModel } = await standardDeliveryConfirmation();
    expect(viewModel.amounts.totalMinor).toBe(quote.amount);
    expect(viewModel.amounts.totalMinor).toBe(8_800);
    expect(viewModel.amounts.formattedTotal).toBe(`${formatMinorUnitsAsDecimalString(quote.amount, quote.currency)} ${quote.currency}`);
    expect(viewModel.amounts.formattedTotal).toBe('88.00 CNY');
  });

  it('报价总额 ≠ 条目/费用简单相加时，ViewModel 仍以报价为准（不重算）', async () => {
    const book = createAddressBook();
    const addressView = addressViewOf(book, 'addr-home');
    const { slot } = await selectSlot({ addressRef: addressView.ref, slotId: 'slot-1' });
    const realQuote = await quoteForAddress(addressView.ref);

    // 模拟服务端总价与本地可见分项不一致（如服务端侧优惠/取整）。
    const serverQuote = { ...realQuote, amount: realQuote.amount + 1 };
    const vm = buildConfirmationFromDelivery({ addressView, slot, quote: serverQuote });

    expect(vm.amounts.totalMinor).toBe(serverQuote.amount);
    expect(vm.amounts.totalMinor).toBe(8_801);
    // 若本地重算分项，将得到 8400 + 400 - 0 = 8800；实际不是。
    expect(vm.amounts.totalMinor).not.toBe(
      vm.amounts.subtotalMinor + vm.amounts.feeMinor - vm.amounts.discountMinor,
    );
  });

  it('调高上限不改变总价；上限低于报价即拒（作用在报价金额上）', async () => {
    const book = createAddressBook();
    const addressView = addressViewOf(book, 'addr-home');
    const { slot } = await selectSlot({ addressRef: addressView.ref, slotId: 'slot-1' });
    const quote = await quoteForAddress(addressView.ref);

    const generous = buildConfirmationFromDelivery({
      addressView,
      slot,
      quote,
      overrides: { ceiling: { ceilingMinor: 200_000, currency: 'CNY', setBy: 'user' } },
    });
    expect(generous.amounts.totalMinor).toBe(quote.amount);

    let caught: unknown;
    try {
      buildConfirmationFromDelivery({
        addressView,
        slot,
        quote,
        overrides: { ceiling: { ceilingMinor: 100, currency: 'CNY', setBy: 'user' } },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PurchaseConfirmationError);
    expect((caught as PurchaseConfirmationError).code).toBe('amount_exceeds_ceiling');

    // 且标准上限本身对这笔报价是通过的。
    expect(STANDARD_CEILING.ceilingMinor).toBeGreaterThanOrEqual(quote.amount);
  });
});
