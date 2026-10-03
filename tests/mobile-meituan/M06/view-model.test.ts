/**
 * M06 确认 ViewModel：工作书要求「商家、SKU/规格/数量、总费用、收货地址、时段和动作范围明确」。
 * 这里逐项断言**它们真的在 ViewModel 上**，而不是「模型说它在」。
 */

import { describe, expect, it } from 'vitest';

import {
  PurchaseConfirmationError,
  assertDigestMatchesViewModel,
  buildPurchaseConfirmationViewModel,
  recomputeDigestForViewModel,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { createCartSession, standardInputs, standardQuote, standardViewModel } from './support.js';

describe('M06 确认 ViewModel：六项关键条件逐项显式', () => {
  it('商家、SKU/规格/数量、总费用、地址（含版本）、时段、动作范围都在 ViewModel 上', async () => {
    const vm = await standardViewModel();

    // ① 商家
    expect(vm.merchant.merchantId).toBe('merchant-1');
    expect(vm.merchant.merchantName).toBe('示例餐厅');

    // ② SKU / 规格 / 数量（逐条）
    expect(vm.lines).toHaveLength(2);
    const noodle = vm.lines.find((line) => line.skuId === 'sku-noodle');
    expect(noodle).toBeDefined();
    expect(noodle?.dishId).toBe('dish-noodle');
    expect(noodle?.dishName).toBe('牛肉面');
    expect(noodle?.quantity).toBe(2);
    expect(noodle?.specText).toBe('默认');
    expect(noodle?.unitAmountMinor).toBe(3_800);
    expect(noodle?.lineAmountMinor).toBe(7_600);

    // ③ 总费用（来自服务端报价，本地不重算）
    expect(vm.amounts.currency).toBe('CNY');
    expect(vm.amounts.subtotalMinor).toBe(8_400);
    expect(vm.amounts.feeMinor).toBe(400);
    expect(vm.amounts.discountMinor).toBe(0);
    expect(vm.amounts.totalMinor).toBe(8_800);
    expect(vm.amounts.formattedTotal).toBe('88.00 CNY');

    // ④ 收货地址（引用 + 版本 + 掩码联系人）
    expect(vm.delivery.addressRef).toBe('addr-home');
    expect(vm.delivery.addressVersion).toBe(3);
    expect(vm.delivery.contactMasked).toContain('*');
    expect(vm.delivery.contactRef).not.toBe('');

    // ⑤ 配送时段
    expect(vm.timeSlot.slotRef).toBe('slot-asap');
    expect(vm.timeSlot.slotLabel.length).toBeGreaterThan(0);

    // ⑥ 动作范围（合同动作类别 + 实例 id）
    expect(vm.contractAction).toBe('submit-order');
    expect(vm.actionId).toBe('act-m06');
    expect(vm.scope).toBe('submit-order');

    // 摘要与两个边界字面量
    expect(vm.paramsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(vm.displayOnly).toBe(true);
    expect(vm.requiresNativeConfirmation).toBe(true);
    expect(Object.isFrozen(vm)).toBe(true);
  });

  it('规格非空时展示串可读，且与书写顺序无关', async () => {
    const session = createCartSession();
    // 同一条目，两组规格，**故意逆序书写**。
    session.cart.addLine({
      dishId: 'dish-noodle',
      skuId: 'sku-noodle',
      quantity: 1,
      specs: [
        { groupId: 'spiciness', optionId: 'mild' },
        { groupId: 'portion', optionId: 'large' },
      ],
    });
    session.cart.setDeliveryAddress('addr-home');
    const quote = await session.requestQuote();
    const vm = buildPurchaseConfirmationViewModel(standardInputs(quote));

    // 展示串按 groupId 排序，与书写顺序无关。
    expect(vm.lines[0]?.specText).toBe('portion=large & spiciness=mild');
    expect(vm.lines[0]?.specs.map((spec) => spec.groupId)).toEqual(['portion', 'spiciness']);
  });

  it('缺商家名/时段/地址 ⇒ order_params_incomplete（带字段名）', async () => {
    const quote = await standardQuote();
    const cases: readonly [string, Record<string, unknown>][] = [
      ['merchantName', { merchantName: '' }],
      ['timeSlotRef', { timeSlot: { slotRef: '', slotLabel: 'x' } }],
      ['addressRef', { address: { addressRef: '', addressVersion: 1, addressSummary: '', contactRef: 'c', contactMasked: 'm' } }],
    ];
    for (const [field, override] of cases) {
      let caught: unknown;
      try {
        buildPurchaseConfirmationViewModel(standardInputs(quote, override as never));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PurchaseConfirmationError);
      expect((caught as PurchaseConfirmationError).code).toBe('order_params_incomplete');
      expect((caught as PurchaseConfirmationError).field).toBe(field);
    }
  });

  it('动作范围与合同不符 ⇒ scope_not_permitted（下单动作给了 payment）', async () => {
    const quote = await standardQuote();
    let caught: unknown;
    try {
      buildPurchaseConfirmationViewModel(standardInputs(quote, { scope: 'payment' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PurchaseConfirmationError);
    expect((caught as PurchaseConfirmationError).code).toBe('scope_not_permitted');
  });

  it('摘要可由参数重建：assertDigestMatchesViewModel 通过；被篡改则 view_model_binding_mismatch', async () => {
    const vm = await standardViewModel();
    expect(() => assertDigestMatchesViewModel(vm)).not.toThrow();
    expect(recomputeDigestForViewModel(vm)).toBe(vm.paramsDigest);

    const tampered = { ...vm, paramsDigest: `sha256:${'0'.repeat(64)}` } as typeof vm;
    let caught: unknown;
    try {
      assertDigestMatchesViewModel(tampered);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PurchaseConfirmationError);
    expect((caught as PurchaseConfirmationError).code).toBe('view_model_binding_mismatch');
  });
});
