/**
 * M06 测试夹具（不是被收集的用例文件）。
 *
 * 两种装配：
 * - **本地场景**：M04 购物车 + fixture 计价端口 → 一份确定性报价 → 标准确认输入；
 * - **真实 K07 装配**：直接用 `apps/mobile-kernel/actions` 的 **真实**
 *   `AuthorizationLedger` 走完「入账 → 确认 → 发行」，用来证明本包**真的在消费 K07**，
 *   而不是对端口的 mock。任何时候都不发生真实网络 / 真实下单。
 */

import {
  CartSession,
  FixtureClock,
  createFixtureQuotePort,
  type Quote,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  STANDARD_ADDRESS,
  STANDARD_CEILING,
  STANDARD_TIME_SLOT,
  buildPurchaseConfirmationViewModel,
  type K07ConsumeInput,
  type K07ConsumeOutcome,
  type K07LedgerView,
  type PurchaseBinding,
  type PurchaseConfirmationInputs,
  type PurchaseConfirmationViewModel,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  createAuthorizationLedger,
  createManualClock,
  type ActionBinding,
  type AuthorizationGrant,
  type AuthorizationLedger,
  type ConfirmAction,
  type ManualClock,
} from '../../../apps/mobile-kernel/actions/index.js';

/** 逻辑时间原点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 1_000_000;

/** 报价有效期。 */
export const QUOTE_TTL_MS = 300_000;

/** 订单确认有效期终点。 */
export const CONFIRM_EXPIRES = T0 + QUOTE_TTL_MS;

/** 默认账号引用（是引用，不是凭据）。 */
export const ACCOUNT_REF = 'acct:meituan:7788';

/** 默认任务版本。 */
export const TASK_REVISION = 7;

/**
 * K07 任务身份（K-R06 B1/B2 之后 `ActionBinding`/`ConfirmAction` 的**必填**一员）。
 *
 * 账本自 2026-10-03 集成起以 `(taskId, actionId)` 为键，因此：
 * - `recordConfirmAction` 的 `ConfirmAction` 必须带 `taskId`；
 * - `attest` / `observedStateOf` 都要显式传 `taskId`；
 * - `consume()` 的 `actual` 必须含 `taskId`，否则 K07 逐项复核报
 *   `grant_binding_mismatch(field='taskId')`。
 *
 * M06 的 `PurchaseBinding` 是**八项订单参数投影**（不含任务身份），任务身份在这一层
 * 由 {@link setupRealK07} 的适配层补上（见 `ledgerView`），与真机适配层的约定一致。
 */
export const TASK_ID = 'task-m06';

/** 默认单价（整数最小单位：分）。 */
export const UNIT_AMOUNTS: Readonly<Record<string, number>> = Object.freeze({
  'sku-noodle': 3_800,
  'sku-tea': 800,
});

/** 默认菜品展示名。 */
export const DISH_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'dish-noodle': '牛肉面',
  'dish-tea': '柠檬茶',
});

/** 造一个确定性购物车会话。 */
export function createCartSession(): CartSession {
  const port = createFixtureQuotePort({
    unitAmountsMinor: UNIT_AMOUNTS,
    fees: [{ code: 'packaging', label: '打包费', amountMinor: 100 }],
    deliveryFeeMinor: 300,
    ttlMs: QUOTE_TTL_MS,
  });
  return new CartSession({
    merchantId: 'merchant-1',
    currency: 'CNY',
    port,
    clock: new FixtureClock(T0),
  });
}

/**
 * 标准购物车（面条 ×2 + 茶 ×1）+ 地址 → 请求报价。
 * 期望：subtotal 8400 + 打包 100 + 配送 300 = 8800 分。
 */
export async function standardQuote(): Promise<Quote> {
  const session = createCartSession();
  session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
  session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
  session.cart.setDeliveryAddress(STANDARD_ADDRESS.addressRef);
  return session.requestQuote();
}

/** 标准确认输入（商家名/地址/时段/范围/账号/版本/上限都可覆盖）。 */
export function standardInputs(
  quote: Quote,
  overrides: Partial<PurchaseConfirmationInputs> = {},
): PurchaseConfirmationInputs {
  return {
    actionId: 'act-m06',
    contractAction: 'submit-order',
    quote,
    merchantName: '示例餐厅',
    address: STANDARD_ADDRESS,
    timeSlot: STANDARD_TIME_SLOT,
    scope: 'submit-order',
    accountRef: ACCOUNT_REF,
    taskRevision: TASK_REVISION,
    ceiling: STANDARD_CEILING,
    dishNames: DISH_NAMES,
    expiresAt: CONFIRM_EXPIRES,
    ...overrides,
  };
}

/** 标准确认 ViewModel。 */
export async function standardViewModel(
  overrides: Partial<PurchaseConfirmationInputs> = {},
): Promise<PurchaseConfirmationViewModel> {
  const quote = await standardQuote();
  return buildPurchaseConfirmationViewModel(standardInputs(quote, overrides));
}

/** 由 ViewModel 构造期望的 K07 绑定（供 `consume` 与账本入账共用同一份参数）。 */
export function expectedBindingFor(
  viewModel: PurchaseConfirmationViewModel,
  overrides: Partial<PurchaseBinding> = {},
): PurchaseBinding {
  return {
    actionId: viewModel.actionId,
    accountRef: ACCOUNT_REF,
    taskRevision: TASK_REVISION,
    paramsDigest: viewModel.paramsDigest,
    quoteRef: viewModel.quoteRef,
    amount: viewModel.amounts.totalMinor,
    currency: viewModel.amounts.currency,
    scope: viewModel.scope,
    expiresAt: viewModel.expiresAt,
    ...overrides,
  };
}

export interface RealK07Fixture {
  readonly ledger: AuthorizationLedger;
  /**
   * 真实账本的**结构投影（真机适配层）**：`consumeNativePurchaseConfirmation` 从这里
   * 消费。M06 的 `PurchaseBinding` 只带八项订单参数，任务身份 `taskId` 由本层补进
   * K07 `consume()` 的 `actual`——账本仍是真实 K07 账本，占用/一次性/拒因码一律不变。
   */
  readonly ledgerView: K07LedgerView;
  readonly clock: ManualClock;
  readonly confirm: ConfirmAction;
  /** 未占用的授权（照账本签发后的原样）。 */
  readonly grant: AuthorizationGrant;
  /** 与账本入账一致的绑定（八项订单参数，不含任务身份）。 */
  readonly binding: PurchaseBinding;
}

/**
 * 用**真实 K07 账本**装配：把 ViewModel 对应的绑定登记为 `ConfirmAction`（含必填 `taskId`），
 * 经 `attest(taskId, actionId)` → `issueGrant` 得到一张未占用的一次性授权，
 * 并把账本投影成 M06 消费用的 {@link RealK07Fixture.ledgerView}。
 */
export function setupRealK07(
  viewModel: PurchaseConfirmationViewModel,
  bindingOverrides: Partial<PurchaseBinding> = {},
): RealK07Fixture {
  const clock = createManualClock(T0);
  const ledger = createAuthorizationLedger({ clock });
  const binding = expectedBindingFor(viewModel, bindingOverrides);
  const confirm: ConfirmAction = {
    taskId: TASK_ID,
    actionId: binding.actionId,
    accountRef: binding.accountRef,
    taskRevision: binding.taskRevision,
    paramsDigest: binding.paramsDigest,
    quoteRef: binding.quoteRef,
    amount: binding.amount,
    currency: binding.currency,
    scope: binding.scope,
    expiresAt: binding.expiresAt,
  };
  ledger.recordConfirmAction(confirm);
  const attestation = ledger.attest(TASK_ID, confirm.actionId, { surface: 'native.confirm' });
  const grant = ledger.issueGrant(attestation);

  // 真机适配层：M06 → K07。把任务身份补进 consume 的 actual（九项绑定），
  // 其余字段原样透传，不放宽任何判据——占用仍由真实 K07 `consume()` 原子裁定。
  const ledgerView: K07LedgerView = Object.freeze({
    consume(input: K07ConsumeInput): K07ConsumeOutcome {
      return ledger.consume({
        grantId: input.grantId,
        actual: { taskId: TASK_ID, ...input.actual } as unknown as ActionBinding,
      });
    },
  });

  return { ledger, ledgerView, clock, confirm, grant, binding };
}
