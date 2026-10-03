/**
 * M06 一次性原生确认 —— **用真实 K07 账本**验证「模型不能伪造用户确认」。
 *
 * ## 方法
 *
 * 不用假账本：直接装配 `apps/mobile-kernel/actions` 的真实 `AuthorizationLedger`，
 * 走完「入账 → attest → issueGrant」，再让 M06 去 `consume`。因此这里的
 * 「消费 K07」是**真实消费**，不是对端口的 mock。
 *
 * 每条负例都断言**具体拒因码**：M06 自有的拒因（过期/绑定不符/伪造回执）用
 * `PurchaseConfirmationError`；账本权威判据（`grant_not_found` / `grant_already_consumed`）
 * 用 K07 的 `AuthorizationError`——两者都机读。
 */

import { describe, expect, it } from 'vitest';

import {
  PurchaseConfirmationError,
  assertTrustedNativeConfirmation,
  authorizePurchase,
  consumeNativePurchaseConfirmation,
  isTrustedNativeConfirmation,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { STANDARD_CEILING } from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { isAuthorizationError } from '../../../apps/mobile-kernel/actions/index.js';
import {
  CONFIRM_EXPIRES,
  T0,
  TASK_ID,
  expectedBindingFor,
  setupRealK07,
  standardViewModel,
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

function expectK07Code(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isAuthorizationError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

describe('M06 消费 K07 一次性确认：正例', () => {
  it('真实 K07 账本入账 → 发行 → M06 原子占用，产出可信回执并放行购买', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);

    // 占用前账本状态：prepared / 授权未被占用。
    expect(fixture.grant.consumed).toBe(false);

    const receipt = consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });

    expect(isTrustedNativeConfirmation(receipt)).toBe(true);
    expect(receipt.consumed).toBe(true);
    expect(receipt.actionId).toBe('act-m06');
    expect(receipt.paramsDigest).toBe(vm.paramsDigest);
    expect(receipt.amountMinor).toBe(8800);
    expect(receipt.currency).toBe('CNY');
    expect(receipt.surface).toBe('native.confirm');

    // K07 侧确实被占用：一条授权、一条提交记录。
    const counts = fixture.ledger.counts();
    expect(counts.grants).toBe(1);
    expect(counts.submissions).toBe(1);
    expect(fixture.ledger.observedStateOf(TASK_ID, 'act-m06')).toBe('submitting');

    // 出口放行。
    const authorized = authorizePurchase({ receipt, ceiling: STANDARD_CEILING, viewModel: vm, now: T0 });
    expect(authorized.amountMinor).toBe(8800);
    expect(authorized.ceilingMinor).toBe(10_000);
    expect(authorized.grantId).toBe(receipt.grantId);
    expect(authorized.requiresNativeConfirmation).toBe(true);
    expect(Object.isFrozen(authorized)).toBe(true);
  });
});

describe('M06 模型/JS 不能伪造用户确认', () => {
  it('缺省的确认回执 ⇒ missing_native_confirmation（缺省即拒）', async () => {
    const vm = await standardViewModel();
    expectPurchaseCode(
      () => authorizePurchase({ receipt: undefined as never, ceiling: STANDARD_CEILING, viewModel: vm, now: T0 }),
      'missing_native_confirmation',
    );
    expectPurchaseCode(
      () => assertTrustedNativeConfirmation(null),
      'missing_native_confirmation',
    );
  });

  it('自造的同形回执 ⇒ untrusted_native_confirmation', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const real = consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });
    const forged = { ...real, consumed: true as const };
    expect(isTrustedNativeConfirmation(forged)).toBe(false);
    expectPurchaseCode(
      () => authorizePurchase({ receipt: forged, ceiling: STANDARD_CEILING, viewModel: vm, now: T0 }),
      'untrusted_native_confirmation',
    );
  });

  it('真回执的**拷贝**也不可信（拿一份拷贝当新确认走不通）', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const real = consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });
    expect(isTrustedNativeConfirmation({ ...real })).toBe(false);
  });

  it('自造的 grantId 在 K07 账本里不存在 ⇒ K07 grant_not_found（伪造授权不可表达）', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const forgedGrant = { ...fixture.grant, grantId: 'grant:does-not-exist' };
    expectK07Code(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledgerView,
          grant: forgedGrant,
          expected: fixture.binding,
          surface: 'native.confirm',
          now: T0,
        }),
      'grant_not_found',
    );
  });
});

describe('M06 由 K07 账本保证的那几条一次性纪律', () => {
  it('同一张授权第二次占用 ⇒ K07 grant_already_consumed', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });
    // 第二次用**原始**授权对象（其快照仍为 consumed=false）再占用。
    expectK07Code(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledgerView,
          grant: fixture.grant,
          expected: fixture.binding,
          surface: 'native.confirm',
          now: T0,
        }),
      'grant_already_consumed',
    );
  });

  it('已占用的授权（consumed 快照）⇒ M06 native_confirmation_already_consumed', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const consumedView = { ...fixture.grant, consumed: true, consumedAt: T0 };
    expectPurchaseCode(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledgerView,
          grant: consumedView,
          expected: fixture.binding,
          surface: 'native.confirm',
          now: T0,
        }),
      'native_confirmation_already_consumed',
    );
  });

  it('到点即失效：now === expiresAt ⇒ native_confirmation_expired', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    expectPurchaseCode(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledgerView,
          grant: fixture.grant,
          expected: fixture.binding,
          surface: 'native.confirm',
          now: CONFIRM_EXPIRES,
        }),
      'native_confirmation_expired',
      'expiresAt',
    );
  });

  it('未装配账本 ⇒ missing_native_confirmation（缺账本不放行）', async () => {
    const vm = await standardViewModel();
    expectPurchaseCode(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: null,
          grant: null,
          expected: expectedBindingFor(vm),
          surface: 'native.confirm',
          now: T0,
        }),
      'missing_native_confirmation',
    );
  });
});

describe('M06 关键条件变化即失效（绑定逐项）', () => {
  it('预期绑定与授权不符（改金额）⇒ native_confirmation_binding_mismatch（field=amount）', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    expectPurchaseCode(
      () =>
        consumeNativePurchaseConfirmation({
          ledger: fixture.ledgerView,
          grant: fixture.grant,
          expected: expectedBindingFor(vm, { amount: 1 }),
          surface: 'native.confirm',
          now: T0,
        }),
      'native_confirmation_binding_mismatch',
      'amount',
    );
  });

  it('展示与授权不符（换了地址版本的另一份 ViewModel）⇒ view_model_binding_mismatch', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const receipt = consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });

    const otherVm = await standardViewModel({
      address: {
        addressRef: 'addr-home',
        addressVersion: 99,
        addressSummary: 'x',
        contactRef: 'contact:masked-1',
        contactMasked: 'm',
      },
    });
    expectPurchaseCode(
      () => authorizePurchase({ receipt, ceiling: STANDARD_CEILING, viewModel: otherVm, now: T0 }),
      'view_model_binding_mismatch',
      'paramsDigest',
    );
  });

  it('出口处再核金额上限：确认后被调低上限 ⇒ amount_exceeds_ceiling', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const receipt = consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });
    expectPurchaseCode(
      () =>
        authorizePurchase({
          receipt,
          ceiling: { ceilingMinor: 100, currency: 'CNY', setBy: 'user' },
          viewModel: vm,
          now: T0,
        }),
      'amount_exceeds_ceiling',
    );
  });

  it('回执过期后出口拒绝 ⇒ native_confirmation_expired', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const receipt = consumeNativePurchaseConfirmation({
      ledger: fixture.ledgerView,
      grant: fixture.grant,
      expected: fixture.binding,
      surface: 'native.confirm',
      now: T0,
    });
    expectPurchaseCode(
      () => authorizePurchase({ receipt, ceiling: STANDARD_CEILING, viewModel: vm, now: CONFIRM_EXPIRES }),
      'native_confirmation_expired',
      'expiresAt',
    );
  });
});
