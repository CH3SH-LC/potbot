/**
 * M-I26 / 授权面 —— **伪造 / 拷贝 / 过期 / 二次使用的 K07 授权不能换来一次购买**。
 *
 * 链路（全部**真实**生产模块，零网络）：
 *   模型的 `cap.meituan.submitOrder` 工具调用
 *     → M10 派发守卫 `assertToolCallAllowed`（越权即整调用被拒）
 *     → M06 `consumeNativePurchaseConfirmation`
 *     → **真实 K07 账本** `AuthorizationLedger.consume()`（原子占用 / 一次性）
 *     → `authorizePurchase`（一次性确认 → 授权购买）。
 *
 * "真实账本"的含义：`apps/mobile-kernel/actions` 的 `AuthorizationLedger` 就地执行，
 * 拒因是 K07 自己的 `AuthorizationError.code`（`grant_not_found` / `grant_already_consumed`
 * / `grant_expired` / `grant_binding_mismatch`），不是对端口的 mock。
 *
 * 任务身份（`taskId`）：K07 自 B1/B2 起把绑定从 8 项扩为 9 项。M06 的 `PurchaseBinding`
 * 仍是 8 项投影，真机由**适配层**（M06 设计明说"`K07LedgerView` 是结构投影、由适配层传入"）
 * 补齐 `taskId`——见 `support.ts` 的 `createK07LedgerView`。它不放松任何判据。
 */

import { describe, expect, it } from 'vitest';

import {
  PurchaseConfirmationError,
  assertTrustedNativeConfirmation,
  authorizePurchase,
  consumeNativePurchaseConfirmation,
  isTrustedNativeConfirmation,
  type NativeConfirmationReceipt,
  type PurchaseBinding,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  STANDARD_CEILING,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  ToolDispatchError,
  assertToolCallAllowed,
  type ValidatedToolCall,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { isAuthorizationError } from '../../../apps/mobile-kernel/actions/errors.js';
import type { ActionBinding } from '../../../apps/mobile-kernel/actions/types.js';
import {
  ACTION_ID,
  CONFIRM_EXPIRES,
  IDEMPOTENCY_KEY,
  SUBMIT_TOOL,
  T0,
  TASK_ID,
  createK07LedgerView,
  expectedBindingFor,
  purchaseRegistry,
  setupRealK07,
  standardViewModel,
  type RealK07Fixture,
} from './support.js';

const registry = purchaseRegistry();

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

/** 模型的提交工具调用必须过 M10 派发守卫。 */
function dispatchSubmit(authorizationRef: string): ValidatedToolCall {
  return assertToolCallAllowed(registry, {
    toolId: SUBMIT_TOOL,
    arguments: { actionId: ACTION_ID, authorizationRef, idempotencyKey: IDEMPOTENCY_KEY },
  });
}

/** 走完整派发链：M10 守门 → M06 消费真实 K07 账本。 */
function consumeThroughDispatch(input: {
  readonly fixture: RealK07Fixture;
  readonly grant: RealK07Fixture['grant'];
  readonly expected: PurchaseBinding;
  readonly now: number;
}): NativeConfirmationReceipt {
  const call = dispatchSubmit(String(input.grant.grantId));
  expect(call.arguments['authorizationRef']).toBe(input.grant.grantId);

  return consumeNativePurchaseConfirmation({
    ledger: createK07LedgerView(input.fixture.ledger, TASK_ID),
    grant: input.grant,
    expected: input.expected,
    surface: 'native.confirm',
    now: input.now,
  });
}

/** 9 项 K07 绑定（直接向账本占用时用）。 */
function nineFieldActual(fixture: RealK07Fixture): ActionBinding {
  const g = fixture.grant;
  return {
    taskId: TASK_ID,
    actionId: g.actionId,
    accountRef: g.accountRef,
    taskRevision: g.taskRevision,
    paramsDigest: g.paramsDigest,
    quoteRef: g.quoteRef,
    amount: g.amount,
    currency: g.currency,
    scope: g.scope,
  };
}

describe('正例对照：派发 → 消费 → 授权购买（负例非空真）', () => {
  it('真实 K07 账本经派发链被原子占用，产出可信回执并放行购买', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);

    const receipt = consumeThroughDispatch({
      fixture,
      grant: fixture.grant,
      expected: fixture.binding,
      now: T0,
    });

    expect(isTrustedNativeConfirmation(receipt)).toBe(true);
    expect(receipt.consumed).toBe(true);
    expect(receipt.actionId).toBe(ACTION_ID);
    expect(receipt.amountMinor).toBe(8_800);
    expect(receipt.currency).toBe('CNY');

    const counts = fixture.ledger.counts();
    expect(counts.grants).toBe(1);
    expect(counts.submissions).toBe(1);

    const authorized = authorizePurchase({ receipt, ceiling: STANDARD_CEILING, viewModel: vm, now: T0 });
    expect(authorized.amountMinor).toBe(8_800);
    expect(authorized.ceilingMinor).toBe(10_000);
    expect(authorized.requiresNativeConfirmation).toBe(true);
    expect(Object.isFrozen(authorized)).toBe(true);
  });
});

describe('伪造授权：真实 K07 账本抛 grant_not_found', () => {
  it('自造的 grantId 经派发链 ⇒ K07 grant_not_found，且账本无提交记录', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const forged = { ...fixture.grant, grantId: 'grant:forged-does-not-exist' };

    expectK07Code(
      () => consumeThroughDispatch({ fixture, grant: forged, expected: fixture.binding, now: T0 }),
      'grant_not_found',
    );
    expect(fixture.ledger.counts().submissions).toBe(0);
  });
});

describe('二次使用：真实 K07 账本抛 grant_already_consumed', () => {
  it('同一张授权第二次经派发链占用 ⇒ K07 grant_already_consumed', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);

    consumeThroughDispatch({ fixture, grant: fixture.grant, expected: fixture.binding, now: T0 });

    // 第二次仍用**原始**授权对象（其快照仍为 consumed=false）经派发链占用。
    expectK07Code(
      () => consumeThroughDispatch({ fixture, grant: fixture.grant, expected: fixture.binding, now: T0 }),
      'grant_already_consumed',
    );
    // 一次性：账本里只有一条提交记录。
    expect(fixture.ledger.counts().submissions).toBe(1);
  });
});

describe('过期授权：M06 前置拒因 + 真实 K07 拒因', () => {
  it('到点即失效：M06 抛 native_confirmation_expired；底层 K07 抛 grant_expired', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    fixture.clock.set(CONFIRM_EXPIRES);

    expectPurchaseCode(
      () => consumeThroughDispatch({ fixture, grant: fixture.grant, expected: fixture.binding, now: CONFIRM_EXPIRES }),
      'native_confirmation_expired',
      'expiresAt',
    );

    // 直接向真实 K07 账本占用，断言 K07 自己的拒因码。
    expectK07Code(
      () => fixture.ledger.consume({ grantId: fixture.grant.grantId, actual: nineFieldActual(fixture) }),
      'grant_expired',
    );
  });
});

describe('拷贝的确认回执不可信（可信根是私有 WeakSet）', () => {
  it('真回执的拷贝经出口 ⇒ untrusted_native_confirmation', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const receipt = consumeThroughDispatch({
      fixture,
      grant: fixture.grant,
      expected: fixture.binding,
      now: T0,
    });

    const forged = { ...receipt };
    expect(isTrustedNativeConfirmation(forged)).toBe(false);
    expectPurchaseCode(
      () => assertTrustedNativeConfirmation(forged),
      'untrusted_native_confirmation',
    );
    expectPurchaseCode(
      () => authorizePurchase({ receipt: forged, ceiling: STANDARD_CEILING, viewModel: vm, now: T0 }),
      'untrusted_native_confirmation',
    );
  });
});

describe('绑定被篡改的授权被 M06 拒绝（展示与授权必须逐项一致）', () => {
  it('模型改金额 ⇒ native_confirmation_binding_mismatch（field=amount）', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);
    const tampered = expectedBindingFor(vm, { amount: 1 });

    expectPurchaseCode(
      () => consumeThroughDispatch({ fixture, grant: fixture.grant, expected: tampered, now: T0 }),
      'native_confirmation_binding_mismatch',
      'amount',
    );
  });
});

describe('越权调用到不了 K07：M10 派发守卫挡在门外', () => {
  it('携带购买参数 pay 的 submitOrder 调用 ⇒ forbidden_purchase_parameter，账本零提交、授权未占用', async () => {
    const vm = await standardViewModel();
    const fixture = setupRealK07(vm);

    let caught: unknown;
    try {
      assertToolCallAllowed(registry, {
        toolId: SUBMIT_TOOL,
        arguments: {
          actionId: ACTION_ID,
          authorizationRef: String(fixture.grant.grantId),
          idempotencyKey: IDEMPOTENCY_KEY,
          pay: true,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolDispatchError);
    expect((caught as ToolDispatchError).code).toBe('forbidden_purchase_parameter');
    // 越权调用被整调用拒绝 ⇒ 没有落到 K07：无提交、授权未被占用。
    expect(fixture.ledger.counts().submissions).toBe(0);
    expect(fixture.grant.consumed).toBe(false);
  });
});
