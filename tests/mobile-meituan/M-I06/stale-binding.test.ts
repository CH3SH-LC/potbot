/**
 * M-I06 · 改地址 / 改时间 ⇒ 旧确认失配。
 *
 * 「改动配送地址或配送时间后，上一张一次性确认必须失效」不能只写在注释里。这里用**真实
 * K07 账本**发行一张绑定到旧 `paramsDigest` 的一次性授权，再用编辑后的订单参数去消费——
 * `consumeNativePurchaseConfirmation` 必须**在触达 K07 账本之前**以
 * `native_confirmation_binding_mismatch`（`field='paramsDigest'`）拒绝，且授权**未被占用**。
 *
 * 非空性（防止「怎么改都报错」的假通过）：
 * - 用 `findPurchaseBindingMismatch` 证明「未改动的绑定与授权逐项一致（null）」，而改动后
 *   首个不一致字段正是 `paramsDigest`——拒绝确由摘要变化引起；
 * - 断言 K07 账本里那张授权确实存在且 `consumed === false`（拒绝发生在触达账本之前）。
 *
 * 注：K07（K-R06 集成）以 `(taskId, actionId)` 为键、绑定九项；M06 的消费面仍是 8 项订单参数
 * （`taskId` 是 K07 侧的安全绑定，见 `residuals`），因此本文件不断言「未改动时 consume 也必成功」，
 * 只断言与摘要相关的失配语义——这正是本单元要钉住的那条。
 */

import { describe, expect, it } from 'vitest';

import {
  PurchaseConfirmationError,
  consumeNativePurchaseConfirmation,
  findPurchaseBindingMismatch,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  T0,
  addressViewOf,
  buildConfirmationFromDelivery,
  createAddressBook,
  expectedBindingFor,
  issueGrantFor,
  quoteForAddress,
  selectSlot,
  standardDeliveryConfirmation,
} from './support.js';

function expectPurchaseCode(fn: () => unknown, code: string, field?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PurchaseConfirmationError);
  expect((caught as PurchaseConfirmationError).code).toBe(code);
  if (field !== undefined) {
    expect((caught as PurchaseConfirmationError).field).toBe(field);
  }
}

describe('M-I06 一次性确认在关键条件变化后失配', () => {
  it('基线：授权是真实 K07 发行、未占用，未改动参数与授权逐项一致', async () => {
    const { viewModel } = await standardDeliveryConfirmation();
    const fixture = issueGrantFor(viewModel);

    expect(fixture.ledger.getGrant(fixture.grant.grantId)).toBeDefined();
    expect(fixture.grant.consumed).toBe(false);
    expect(fixture.grant.paramsDigest).toBe(viewModel.paramsDigest);
    // 未改动 ⇒ 无任何不一致字段。
    expect(findPurchaseBindingMismatch(expectedBindingFor(viewModel), fixture.binding)).toBeNull();
  });

  it('改地址后：消费以 binding_mismatch/paramsDigest 被拒，且授权未被占用', async () => {
    const book = createAddressBook();
    const before = addressViewOf(book, 'addr-home');
    const { slot } = await selectSlot({ addressRef: before.ref, slotId: 'slot-1' });
    const quote = await quoteForAddress(before.ref);
    const vmBefore = buildConfirmationFromDelivery({ addressView: before, slot, quote });
    const fixture = issueGrantFor(vmBefore); // 绑定「改地址前」的摘要。

    // 用户改了地址（版本推进），订单一侧随之重建确认。
    book.update('addr-home', { detail: '示例路 9 号（合成）' });
    const after = addressViewOf(book, 'addr-home');
    const vmAfter = buildConfirmationFromDelivery({ addressView: after, slot, quote });

    expect(after.ref).toBe('addr-home#v2');
    expect(vmAfter.paramsDigest).not.toBe(vmBefore.paramsDigest);

    // 非空性：旧绑定自洽；新绑定的首个不一致字段就是摘要。
    expect(findPurchaseBindingMismatch(expectedBindingFor(vmBefore), fixture.binding)).toBeNull();
    expect(findPurchaseBindingMismatch(expectedBindingFor(vmAfter), fixture.binding)).toBe('paramsDigest');

    // 用**新**订单参数消费**旧**授权 ⇒ 触达 K07 之前即被拒。
    expectPurchaseCode(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledger,
          grant: fixture.grant,
          expected: expectedBindingFor(vmAfter),
          surface: 'native.confirm',
          now: T0,
        }),
      'native_confirmation_binding_mismatch',
      'paramsDigest',
    );

    // 授权未被占用（拒绝发生在触达账本之前，账本状态不变）。
    expect(fixture.ledger.getGrant(fixture.grant.grantId)?.consumed).toBe(false);
  });

  it('改配送时间后：消费以 binding_mismatch/paramsDigest 被拒', async () => {
    const book = createAddressBook();
    const addressView = addressViewOf(book, 'addr-home');
    const quote = await quoteForAddress(addressView.ref);

    const slot1 = (await selectSlot({ addressRef: addressView.ref, slotId: 'slot-1' })).slot;
    const slot2 = (await selectSlot({ addressRef: addressView.ref, slotId: 'slot-2' })).slot;

    const vm1 = buildConfirmationFromDelivery({ addressView, slot: slot1, quote });
    const vm2 = buildConfirmationFromDelivery({ addressView, slot: slot2, quote });
    expect(vm1.paramsDigest).not.toBe(vm2.paramsDigest);

    const fixture = issueGrantFor(vm1);
    expect(findPurchaseBindingMismatch(expectedBindingFor(vm1), fixture.binding)).toBeNull();
    expect(findPurchaseBindingMismatch(expectedBindingFor(vm2), fixture.binding)).toBe('paramsDigest');

    expectPurchaseCode(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledger,
          grant: fixture.grant,
          expected: expectedBindingFor(vm2),
          surface: 'native.confirm',
          now: T0,
        }),
      'native_confirmation_binding_mismatch',
      'paramsDigest',
    );
    expect(fixture.ledger.getGrant(fixture.grant.grantId)?.consumed).toBe(false);
  });
});
