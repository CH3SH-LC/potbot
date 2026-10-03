/**
 * M-I06 · 交付面接线：确认 ViewModel **消费 M05 的地址/时段摘要**，且摘要折入
 * `addressRef` 与 `slotId`。
 *
 * 与 M06 的单元用例不同，这里的数据全部来自**真实** M05 对象：
 * `AddressBook` → `toAddressView`（ref 含版本 + 掩码联系人）、`DeliverySlotSelector` → `DeliverySlot`。
 * 桥接用的是 M06 新增的 `confirmationAddressFromDeliveryView` / `confirmationTimeSlotFromDeliverySlot`。
 */

import { describe, expect, it } from 'vitest';

import {
  PurchaseConfirmationError,
  PURCHASE_CONFIRMATION_DELIVERY_DEPENDENCIES,
  assertAddressDeliveryOperationsCovered,
  confirmationAddressFromDeliveryView,
  confirmationTimeSlotFromDeliverySlot,
  recomputeDigestForViewModel,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  ADDRESS_DELIVERY_BOUNDARY,
  ADDRESS_DELIVERY_OPERATIONS,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import {
  addressViewOf,
  buildConfirmationFromDelivery,
  createAddressBook,
  digestOf,
  quoteForAddress,
  selectSlot,
  standardDeliveryConfirmation,
} from './support.js';

describe('M-I06 确认 ViewModel 消费 M05 地址 / 时段摘要', () => {
  it('地址引用（含版本）与掩码联系人逐字来自 M05 地址视图', async () => {
    const { addressView, viewModel } = await standardDeliveryConfirmation();

    // 引用与版本逐字取自 M05（ref = <addressId>#v<version>）。
    expect(viewModel.delivery.addressRef).toBe(addressView.ref);
    expect(viewModel.delivery.addressRef).toBe('addr-home#v1');
    expect(viewModel.delivery.addressVersion).toBe(addressView.version);
    expect(viewModel.delivery.addressVersion).toBe(1);

    // 联系人只带掩码与引用，绝无明文。
    expect(viewModel.delivery.contactMasked).toBe(addressView.contactMasked);
    expect(viewModel.delivery.contactMasked).toContain('*');
    expect(viewModel.delivery.contactRef).not.toBe('');
    expect(JSON.stringify(viewModel.delivery)).not.toContain('13800008000');
  });

  it('时段 ref 逐字取自 M05 的 slotId，标签来自 M05 时段', async () => {
    const { slot, viewModel } = await standardDeliveryConfirmation();
    expect(viewModel.timeSlot.slotRef).toBe(slot.slotId);
    expect(viewModel.timeSlot.slotRef).toBe('slot-1');
    expect(viewModel.timeSlot.slotLabel).toBe(slot.label);
    expect(viewModel.timeSlot.slotLabel.length).toBeGreaterThan(0);
  });

  it('桥接在缺字段时显式失败（不产出半张确认）', () => {
    const bad = { addressId: 'a', ref: '', version: 1, contactMasked: 'm' };
    expect(() => confirmationAddressFromDeliveryView(bad as never)).toThrow(PurchaseConfirmationError);
    expect(() => confirmationTimeSlotFromDeliverySlot({ slotId: '', label: 'x' })).toThrow(
      PurchaseConfirmationError,
    );
  });
});

describe('M-I06 订单参数摘要折入 addressRef 与 slotId', () => {
  it('摘要可由 ViewModel 独立重算（recomputeDigestForViewModel 一致）', async () => {
    const { viewModel } = await standardDeliveryConfirmation();
    expect(viewModel.paramsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(recomputeDigestForViewModel(viewModel)).toBe(viewModel.paramsDigest);
    expect(digestOf(viewModel)).toBe(viewModel.paramsDigest);
  });

  it('改地址（M05 版本推进）⇒ addressRef 变 ⇒ 摘要变', async () => {
    const book = createAddressBook();
    const before = addressViewOf(book, 'addr-home');
    const { slot } = await selectSlot({ addressRef: before.ref, slotId: 'slot-1' });
    const quote = await quoteForAddress(before.ref);
    const vmBefore = buildConfirmationFromDelivery({ addressView: before, slot, quote });

    // 真实 M05 编辑：改门牌 ⇒ 版本 +1、引用刷新。
    book.update('addr-home', { detail: '示例路 9 号（合成）' });
    const after = addressViewOf(book, 'addr-home');
    const vmAfter = buildConfirmationFromDelivery({ addressView: after, slot, quote });

    expect(after.ref).toBe('addr-home#v2');
    expect(vmAfter.delivery.addressVersion).toBe(2);
    expect(vmAfter.paramsDigest).not.toBe(vmBefore.paramsDigest);
  });

  it('改配送时间（换 slotId）⇒ 摘要变', async () => {
    const book = createAddressBook();
    const addressView = addressViewOf(book, 'addr-home');
    const quote = await quoteForAddress(addressView.ref);

    const slot1 = (await selectSlot({ addressRef: addressView.ref, slotId: 'slot-1' })).slot;
    const slot2 = (await selectSlot({ addressRef: addressView.ref, slotId: 'slot-2' })).slot;

    const vm1 = buildConfirmationFromDelivery({ addressView, slot: slot1, quote });
    const vm2 = buildConfirmationFromDelivery({ addressView, slot: slot2, quote });

    expect(slot1.slotId).not.toBe(slot2.slotId);
    expect(vm1.timeSlot.slotRef).not.toBe(vm2.timeSlot.slotRef);
    expect(vm1.paramsDigest).not.toBe(vm2.paramsDigest);
  });

  it('只有时段标签变化、slotId 不变时摘要不变（钉的是 id，不是展示串）', async () => {
    const book = createAddressBook();
    const addressView = addressViewOf(book, 'addr-home');
    const quote = await quoteForAddress(addressView.ref);
    const slot = (await selectSlot({ addressRef: addressView.ref, slotId: 'slot-1' })).slot;

    const vm1 = buildConfirmationFromDelivery({ addressView, slot, quote });
    const relabeledSlot = { ...slot, label: '另一个展示名' };
    const vm2 = buildConfirmationFromDelivery({ addressView, slot: relabeledSlot, quote });

    expect(vm1.timeSlot.slotLabel).not.toBe(vm2.timeSlot.slotLabel);
    expect(vm1.paramsDigest).toBe(vm2.paramsDigest);
  });
});

describe('M-I06 消费 M05 交付操作面（跨包合同，运行期可核对）', () => {
  it('M05 声明的 ADDRESS_DELIVERY_OPERATIONS 覆盖 M06 确认依赖，且都不触碰真实平台', () => {
    expect(() => assertAddressDeliveryOperationsCovered(ADDRESS_DELIVERY_OPERATIONS)).not.toThrow();

    // 逐项确认依赖确实在 M05 的操作面里。
    const names = new Set(ADDRESS_DELIVERY_OPERATIONS.map((operation) => operation.name));
    for (const dependency of PURCHASE_CONFIRMATION_DELIVERY_DEPENDENCIES) {
      expect(names.has(dependency), `M05 操作面缺少 ${dependency}`).toBe(true);
    }
    // M05 边界：确认层不提供下单/支付。
    expect(ADDRESS_DELIVERY_BOUNDARY.canSubmit).toBe(false);
    expect(ADDRESS_DELIVERY_BOUNDARY.canPay).toBe(false);
  });

  it('缺少某个依赖操作 ⇒ 当场拒绝（不凭本地假设继续）', () => {
    const missing = ADDRESS_DELIVERY_OPERATIONS.filter(
      (operation) => operation.name !== 'selectDeliverySlot',
    );
    let caught: unknown;
    try {
      assertAddressDeliveryOperationsCovered(missing);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PurchaseConfirmationError);
    expect((caught as PurchaseConfirmationError).code).toBe('invalid_view_model_input');
    expect((caught as PurchaseConfirmationError).field).toBe('address-delivery');
  });

  it('某个依赖操作声明会触碰真实平台 ⇒ 当场拒绝', () => {
    const tainted = ADDRESS_DELIVERY_OPERATIONS.map((operation) =>
      operation.name === 'loadDeliverySlots' ? { ...operation, touchesRealPlatform: true } : operation,
    );
    expect(() => assertAddressDeliveryOperationsCovered(tainted)).toThrow(PurchaseConfirmationError);
  });
});
