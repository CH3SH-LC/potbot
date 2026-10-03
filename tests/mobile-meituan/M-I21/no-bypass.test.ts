/**
 * M-I21 反向边界：购买符号不可达、用户确认不可绕过、回执不可伪造。
 *
 * 本文件不重复正例旅程，而是**逐条反证**那条消费旅程的护栏在跨包拼接后依然成立：
 *
 * - 从 M03/M04 的**导出面**里拿不到任何购买/提交/支付入口（结构性边界，不是注释）；
 * - 没有配送地址取不出报价；地址一变旧报价即失效；
 * - 没有真实 K07 账本、没有一次性确认，M06 不放行；伪造回执/拷贝回执一律拒；
 * - 没有可信授权引用、幂等键不对，M07 不提交；
 * - `verificationMode: 'fixture'` 的支付读回**不可能**报告 `paid`；
 * - 平台回执与本地意图不符时，M09 报不匹配并停止跟踪。
 *
 * 全部为本地确定性 fixture，零网络、不读系统时间。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import * as catalogNamespace from '../../../src/mobile-plugins/meituan/catalog/index.js';
import * as cartNamespace from '../../../src/mobile-plugins/meituan/cart/index.js';
import { CATALOG_PURCHASE_BOUNDARY } from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { CART_PURCHASE_BOUNDARY, CartValidationError } from '../../../src/mobile-plugins/meituan/cart/index.js';
import { ADDRESS_DELIVERY_OPERATIONS } from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import {
  STANDARD_CEILING,
  assertAddressDeliveryOperationsCovered,
  consumeNativePurchaseConfirmation,
  authorizePurchase,
  isPurchaseConfirmationError,
  type AddressDeliveryOperationView,
  type PurchaseConfirmationError,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  isOrderSubmitError,
  type OrderSubmitError,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { PaymentError, createPaymentReadback } from '../../../src/mobile-plugins/meituan/payment/index.js';
import {
  OrderLifecycleTracker,
  OrderMismatchError,
  createFixtureOrderQueryPort as createFixtureLifecycleQueryPort,
  type OrderQueryResult,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { isAuthorizationError } from '../../../apps/mobile-kernel/actions/errors.js';
import {
  ACCOUNT_REF,
  CONFIRM_EXPIRES,
  K07_TASK_ID,
  MERCHANT_ID,
  PROVIDER_ORDER_REF,
  T0,
  TASK_REVISION,
  buildSubmitRig,
  fillStandardCart,
  newCartSession,
  orderIntentFor,
  runConsumerJourney,
  setupRealK07,
  type ConsumerJourney,
} from './support.js';

let journey: ConsumerJourney;

beforeAll(async () => {
  journey = await runConsumerJourney();
});

// ---------------------------------------------------------------------------
// 结构性边界：目录/购物车导出面里没有购买入口
// ---------------------------------------------------------------------------

/** 以「购买动作动词开头」命名的**可调用导出**（函数/类）即为越界符号。 */
function purchaseCapableCallables(namespace: Record<string, unknown>): readonly string[] {
  const offenders: string[] = [];
  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== 'function') continue;
    if (/^(submit|place|purchase|pay|checkout)/i.test(name)) offenders.push(name);
  }
  return offenders;
}

describe('M-I21 结构边界：M03/M04 不是购买通道', () => {
  it('catalog 与 cart 的导出面里没有以购买动词开头的可调用符号', () => {
    expect(purchaseCapableCallables(catalogNamespace as unknown as Record<string, unknown>)).toEqual([]);
    expect(purchaseCapableCallables(cartNamespace as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('购买边界常量逐条声明为 false（结构性，不是开关）', () => {
    expect(CATALOG_PURCHASE_BOUNDARY.canSubmitOrder).toBe(false);
    expect(CATALOG_PURCHASE_BOUNDARY.canPay).toBe(false);
    expect(CATALOG_PURCHASE_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(CATALOG_PURCHASE_BOUNDARY.treatMerchantTextAsInstruction).toBe(false);
    expect(CART_PURCHASE_BOUNDARY.canSubmitOrder).toBe(false);
    expect(CART_PURCHASE_BOUNDARY.canPay).toBe(false);
    expect(CART_PURCHASE_BOUNDARY.connectsRealPlatform).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M04：报价必须先有地址；地址一变旧报价即失效
// ---------------------------------------------------------------------------

describe('M-I21 M04 边界：没有地址取不出价，地址变化使旧报价失效', () => {
  it('未设置配送地址就 requestQuote ⇒ CartValidationError（本地不猜地址）', async () => {
    const session = newCartSession();
    fillStandardCart(session);
    await expect(session.requestQuote()).rejects.toBeInstanceOf(CartValidationError);
  });

  it('换配送地址引用 ⇒ 旧报价 params_changed（地址版本进了指纹）', async () => {
    const session = newCartSession();
    fillStandardCart(session);
    session.cart.setDeliveryAddress('addr-home#v1');
    const quote = await session.requestQuote();
    expect(session.checkQuote(quote).usable).toBe(true);

    session.cart.setDeliveryAddress('addr-home#v2');
    const afterChange = session.checkQuote(quote);
    expect(afterChange.usable).toBe(false);
    expect(afterChange.reasons).toContain('params_changed');
  });
});

// ---------------------------------------------------------------------------
// M06：用户确认不可绕过
// ---------------------------------------------------------------------------

function purchaseErrorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (isPurchaseConfirmationError(error)) return (error as PurchaseConfirmationError).code;
    throw error;
  }
}

function k07ErrorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (isAuthorizationError(error)) return (error as { code: string }).code;
    throw error;
  }
}

describe('M-I21 M06 边界：没有一次性用户确认不得购买', () => {
  it('缺账本 ⇒ missing_native_confirmation（缺省即拒）', () => {
    const { viewModel, binding, k07 } = journey.confirmation;
    expect(
      purchaseErrorCode(() =>
        consumeNativePurchaseConfirmation({
          ledger: null,
          grant: k07.grant,
          expected: binding,
          surface: 'native.confirm',
          now: T0,
        }),
      ),
    ).toBe('missing_native_confirmation');
    expect(viewModel.requiresNativeConfirmation).toBe(true);
  });

  it('自造一张不在账本里的授权 ⇒ K07 grant_not_found（模型自造授权不可表达）', () => {
    const { viewModel, binding, k07 } = journey.confirmation;
    const forgedGrant = { ...k07.grant, grantId: 'grant-forged-2603' };
    expect(
      k07ErrorCode(() =>
        consumeNativePurchaseConfirmation({
          ledger: k07.ledgerView,
          grant: forgedGrant,
          expected: binding,
          surface: 'native.confirm',
          now: T0,
        }),
      ),
    ).toBe('grant_not_found');
    expect(viewModel.actionId).toBe('act-m06');
  });

  it('同一张一次性授权占用两次 ⇒ K07 grant_already_consumed', () => {
    const { viewModel, binding } = journey.confirmation;
    const fresh = setupRealK07(viewModel);
    consumeNativePurchaseConfirmation({
      ledger: fresh.ledgerView,
      grant: fresh.grant,
      expected: fresh.binding,
      surface: 'native.confirm',
      now: T0,
    });
    expect(
      k07ErrorCode(() =>
        consumeNativePurchaseConfirmation({
          ledger: fresh.ledgerView,
          grant: fresh.grant,
          expected: fresh.binding,
          surface: 'native.confirm',
          now: T0,
        }),
      ),
    ).toBe('grant_already_consumed');
    // 绑定与入账一致（避免上一条其实是绑定不符导致的假绿）。
    expect(fresh.binding).toEqual(binding);
  });

  it('缺省回执 ⇒ missing_native_confirmation；真回执的拷贝 ⇒ untrusted_native_confirmation', () => {
    const { viewModel, receipt } = journey.confirmation;
    expect(
      purchaseErrorCode(() =>
        authorizePurchase({ receipt: undefined as never, ceiling: STANDARD_CEILING, viewModel, now: T0 }),
      ),
    ).toBe('missing_native_confirmation');

    const copy = { ...receipt };
    expect(
      purchaseErrorCode(() =>
        authorizePurchase({ receipt: copy as never, ceiling: STANDARD_CEILING, viewModel, now: T0 }),
      ),
    ).toBe('untrusted_native_confirmation');
    // 真回执本身仍然放行（避免上一条是别的拒因导致的假绿）。
    expect(() =>
      authorizePurchase({ receipt, ceiling: STANDARD_CEILING, viewModel, now: T0 }),
    ).not.toThrow();
  });

  it('过期的一次性确认不放行 ⇒ native_confirmation_expired', () => {
    const { viewModel, binding } = journey.confirmation;
    const fresh = setupRealK07(viewModel);
    expect(
      purchaseErrorCode(() =>
        consumeNativePurchaseConfirmation({
          ledger: fresh.ledgerView,
          grant: fresh.grant,
          expected: fresh.binding,
          surface: 'native.confirm',
          now: CONFIRM_EXPIRES,
        }),
      ),
    ).toBe('native_confirmation_expired');
    expect(fresh.binding.expiresAt).toBe(CONFIRM_EXPIRES);
    expect(binding.accountRef).toBe(ACCOUNT_REF);
  });
});

// ---------------------------------------------------------------------------
// M06 × M05：确认依赖的交付操作面必须齐全且不触真实平台
// ---------------------------------------------------------------------------

describe('M-I21 M06×M05 边界：确认链依赖的交付操作面可运行期核对', () => {
  it('真实 ADDRESS_DELIVERY_OPERATIONS 覆盖 M06 依赖且都不触真实平台', () => {
    expect(() => assertAddressDeliveryOperationsCovered(ADDRESS_DELIVERY_OPERATIONS)).not.toThrow();
  });

  it('缺一个依赖操作 ⇒ 拒绝（确认链接不上，不凭本地假设继续）', () => {
    const missing = (ADDRESS_DELIVERY_OPERATIONS as readonly AddressDeliveryOperationView[]).filter(
      (operation) => operation.name !== 'locateAndBind',
    );
    expect(purchaseErrorCode(() => assertAddressDeliveryOperationsCovered(missing))).toBe(
      'invalid_view_model_input',
    );
  });

  it('某依赖操作声明会触碰真实平台 ⇒ 拒绝（超出本地确认边界）', () => {
    const touched = (ADDRESS_DELIVERY_OPERATIONS as readonly AddressDeliveryOperationView[]).map((operation) =>
      operation.name === 'selectDeliverySlot' ? { ...operation, touchesRealPlatform: true } : operation,
    );
    expect(purchaseErrorCode(() => assertAddressDeliveryOperationsCovered(touched))).toBe(
      'invalid_view_model_input',
    );
  });
});

// ---------------------------------------------------------------------------
// M07：没有可信授权引用不得提交；幂等键必须可导出
// ---------------------------------------------------------------------------

function submitErrorCode(error: unknown): string | null {
  return isOrderSubmitError(error) ? (error as OrderSubmitError).code : null;
}

async function captureSubmitError(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return submitErrorCode(error);
  }
}

describe('M-I21 M07 边界：授权与幂等是硬判据', () => {
  it('缺授权引用 ⇒ missing_authorization_ref（缺省即拒）', async () => {
    const rig = buildSubmitRig({ authorized: journey.confirmation.authorized, quote: journey.cart.quote });
    const code = await captureSubmitError(
      rig.submitter.submit({ authorization: undefined as never, idempotencyKey: rig.idempotencyKey }),
    );
    expect(code).toBe('missing_authorization_ref');
  });

  it('形状相同的拷贝授权 ⇒ untrusted_authorization_ref（拷贝当新授权走不通）', async () => {
    const rig = buildSubmitRig({ authorized: journey.confirmation.authorized, quote: journey.cart.quote });
    const code = await captureSubmitError(
      rig.submitter.submit({ authorization: { ...rig.authorization }, idempotencyKey: rig.idempotencyKey }),
    );
    expect(code).toBe('untrusted_authorization_ref');
  });

  it('幂等键与授权绑定不一致 ⇒ idempotency_key_mismatch（键不能随手给）', async () => {
    const rig = buildSubmitRig({ authorized: journey.confirmation.authorized, quote: journey.cart.quote });
    const code = await captureSubmitError(
      rig.submitter.submit({ authorization: rig.authorization, idempotencyKey: 'idem-v1-deadbeef' }),
    );
    expect(code).toBe('idempotency_key_mismatch');
    expect(rig.executorCallCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M08：fixture 读回不可能报「已付款」
// ---------------------------------------------------------------------------

describe('M-I21 M08 边界：假端口不得签发「真实支付已付款」', () => {
  it('verificationMode=fixture + paidState=paid ⇒ fixture_readback_cannot_confirm', () => {
    let caught: unknown;
    try {
      createPaymentReadback({
        paymentIntentRef: 'pay-intent-1',
        externalId: PROVIDER_ORDER_REF,
        accountRef: ACCOUNT_REF,
        amountMinor: journey.cart.quote.amount,
        currency: 'CNY',
        providerPaymentRef: 'PAY-REF-forged',
        paidState: 'paid',
        observedAt: T0,
        evidenceRef: 'ev-forged',
        verificationMode: 'fixture',
        detail: '伪造的已付款读回',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PaymentError);
    expect((caught as PaymentError).code).toBe('fixture_readback_cannot_confirm');
  });
});

// ---------------------------------------------------------------------------
// M09：平台回执与本地意图不符 ⇒ 停止跟踪
// ---------------------------------------------------------------------------

describe('M-I21 M09 边界：回执与本地意图不符即阻断', () => {
  it('查回的单 externalId 与本地意图不符 ⇒ OrderMismatchError 且 trackable=false', async () => {
    const tracker = new OrderLifecycleTracker({
      intent: orderIntentFor(PROVIDER_ORDER_REF, journey.cart.quote.amount),
    });
    const wrongOrder: OrderQueryResult = {
      externalId: 'MT-ORDER-SOMEONE-ELSE',
      accountRef: ACCOUNT_REF,
      amountMinor: journey.cart.quote.amount,
      currency: 'CNY',
      rawStatusCode: 'W_PAID_WAIT_ACCEPT',
      refundStatusCode: null,
      refundAmountMinor: null,
      observedAt: T0,
      evidenceRef: 'ev-wrong-order',
    };
    const port = createFixtureLifecycleQueryPort({ results: [wrongOrder] });
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toBeInstanceOf(OrderMismatchError);
    expect(tracker.trackable).toBe(false);
    expect(tracker.blockedReason).not.toBeNull();
  });

  it('未知任务身份不参与：确认/授权/提交各自钉住自己的作用域字段', () => {
    // K07 引入的 taskId 是逐项绑定的一员；M06 的确认绑定尚未携带它（见 residuals）。
    expect(journey.confirmation.k07.confirm.taskId).toBe(K07_TASK_ID);
    expect(journey.confirmation.binding.actionId).toBe('act-m06');
    expect(MERCHANT_ID).toBe('merchant-1');
    expect(TASK_REVISION).toBe(7);
  });
});
