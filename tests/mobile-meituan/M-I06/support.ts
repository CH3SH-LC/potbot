/**
 * M-I06 集成夹具 —— 把**真实** M05 地址/配送模块接到**真实** M06 购买确认模块上。
 *
 * ## 这一层要证明什么
 *
 * M05 请求 #2 / M06 nextIncrement 要求：确认 ViewModel 必须**消费 M05 的地址/时段摘要**
 * （`ref` 含版本 + 掩码联系人 + `slotId`），且订单参数摘要折入 `addressRef` 与 `slotId`
 * ⇒ 改地址或改配送时间都会让一张**未消费的一次性确认**失配。
 *
 * 因此这里的装配全部用真实对象（不是对端口的 mock）：
 * - 地址来自真实 `AddressBook` → `toAddressView`（M05）；
 * - 时段来自真实 `DeliverySlotSelector` + fixture 时段端口（M05）；
 * - 报价来自真实 `CartSession`（M04）；
 * - 一次性授权来自真实 K07 `AuthorizationLedger`（`apps/mobile-kernel/actions`）；
 * - 桥接用 M06 `confirmationAddressFromDeliveryView` / `confirmationTimeSlotFromDeliverySlot`。
 *
 * **无网络、无真实平台、无真实手机号/地址**：联系电话与地址均为合成占位（与 M05 测试同一约定）。
 */

import {
  ADDRESS_DELIVERY_BOUNDARY,
  ADDRESS_DELIVERY_OPERATIONS,
  AddressBook,
  DeliverySlotSelector,
  buildSlots,
  createFixtureSlotPort,
  toAddressView,
  type AddressRecord,
  type AddressView,
  type DeliverySlot,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import {
  CartSession,
  FixtureClock,
  createFixtureQuotePort,
  type Quote,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  STANDARD_CEILING,
  buildPurchaseConfirmationViewModel,
  confirmationAddressFromDeliveryView,
  confirmationTimeSlotFromDeliverySlot,
  recomputeDigestForViewModel,
  type PurchaseBinding,
  type PurchaseConfirmationInputs,
  type PurchaseConfirmationViewModel,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  createAuthorizationLedger,
  createManualClock,
  type AuthorizationGrant,
  type AuthorizationLedger,
  type ConfirmAction,
} from '../../../apps/mobile-kernel/actions/index.js';

export { ADDRESS_DELIVERY_BOUNDARY, ADDRESS_DELIVERY_OPERATIONS, STANDARD_CEILING };

/** 逻辑时间原点（非零，暴露「偷偷从 0 起算」的错误）。 */
export const T0 = 1_000_000;
/** 报价有效期。 */
export const QUOTE_TTL_MS = 300_000;
/** 订单确认有效期终点。 */
export const CONFIRM_EXPIRES = T0 + QUOTE_TTL_MS;
/** 账号 / 收款方引用（是引用，不是凭据）。 */
export const ACCOUNT_REF = 'acct:meituan:7788';
/** 任务版本。 */
export const TASK_REVISION = 7;
/** 任务身份（K07（K-R06）账本以 (taskId, actionId) 为键，登记确认请求时必须给出）。 */
export const TASK_ID = 'task:mi06';

/** 合成联系电话（与 M05 测试同一约定，非真实号码）。 */
const SYNTHETIC_PHONE = '13800008000';

/** 单价（整数最小单位：分）。 */
export const UNIT_AMOUNTS: Readonly<Record<string, number>> = Object.freeze({
  'sku-noodle': 3_800,
  'sku-tea': 800,
});

/** 菜品展示名。 */
export const DISH_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'dish-noodle': '牛肉面',
  'dish-tea': '柠檬茶',
});

/** 造一个含默认「家」地址（v1）的真实 M05 地址簿。 */
export function createAddressBook(): AddressBook {
  const book = new AddressBook();
  book.add({
    addressId: 'addr-home',
    label: '家',
    contactName: '示例联系人',
    phone: SYNTHETIC_PHONE,
    region: '示例省示例市示例区',
    detail: '示例路 0 号（合成）',
  });
  book.setDefault('addr-home');
  return book;
}

/** 取地址记录的脱敏视图（M05 出口）。 */
export function addressViewOf(book: AddressBook, addressId: string): AddressView {
  const record: AddressRecord = book.require(addressId);
  return toAddressView(record, { isDefault: book.defaultAddressId === addressId });
}

/** 按给定地址引用请求一份真实 M04 服务端报价（2×面 + 1×茶 → 合计 8800 分）。 */
export async function quoteForAddress(addressRef: string): Promise<Quote> {
  const port = createFixtureQuotePort({
    unitAmountsMinor: UNIT_AMOUNTS,
    fees: [{ code: 'packaging', label: '打包费', amountMinor: 100 }],
    deliveryFeeMinor: 300,
    ttlMs: QUOTE_TTL_MS,
  });
  const session = new CartSession({
    merchantId: 'merchant-1',
    currency: 'CNY',
    port,
    clock: new FixtureClock(T0),
  });
  session.cart.addLine({ dishId: 'dish-noodle', skuId: 'sku-noodle', quantity: 2 });
  session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
  session.cart.setDeliveryAddress(addressRef);
  return session.requestQuote();
}

/** 真实 M05 时段端口给出 3 个可选时段（从 `now + 60s` 起，每段 30 分钟）。 */
export function loadSlots(selector: DeliverySlotSelector, addressRef: string, now = T0): Promise<readonly DeliverySlot[]> {
  const slots = buildSlots(now + 60_000, 1_800_000, 3, { labelPrefix: '时段' });
  return selector.load(createFixtureSlotPort(slots), { merchantId: 'merchant-1', addressRef, now });
}

/** 加载并选中一个可用时段，返回时段对象（真实 M05 选择器）。 */
export async function selectSlot(input: {
  readonly addressRef: string;
  readonly slotId: string;
  readonly now?: number;
}): Promise<{ readonly selector: DeliverySlotSelector; readonly slot: DeliverySlot }> {
  const selector = new DeliverySlotSelector();
  await loadSlots(selector, input.addressRef, input.now ?? T0);
  const slot = selector.select(input.slotId);
  return { selector, slot };
}

/** 由 M05 地址视图 + 时段 + M04 报价构造 M06 确认 ViewModel（经 M06 的桥接函数）。 */
export function buildConfirmationFromDelivery(input: {
  readonly addressView: AddressView;
  readonly slot: DeliverySlot;
  readonly quote: Quote;
  readonly overrides?: Partial<PurchaseConfirmationInputs>;
  readonly summary?: string;
}): PurchaseConfirmationViewModel {
  const address = confirmationAddressFromDeliveryView(input.addressView, {
    summary: input.summary,
  });
  const timeSlot = confirmationTimeSlotFromDeliverySlot(input.slot);
  const inputs: PurchaseConfirmationInputs = {
    actionId: 'act-mi06',
    contractAction: 'submit-order',
    quote: input.quote,
    merchantName: '示例餐厅',
    address,
    timeSlot,
    scope: 'submit-order',
    accountRef: ACCOUNT_REF,
    taskRevision: TASK_REVISION,
    ceiling: STANDARD_CEILING,
    dishNames: DISH_NAMES,
    expiresAt: CONFIRM_EXPIRES,
    ...input.overrides,
  };
  return buildPurchaseConfirmationViewModel(inputs);
}

/** 由 ViewModel 构造期望的 K07 八项绑定 + 期限。 */
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

/** 由 ViewModel 独立重算订单参数摘要（「关键条件变化即失效」的复核口径）。 */
export function digestOf(viewModel: PurchaseConfirmationViewModel): string {
  return recomputeDigestForViewModel(viewModel);
}

export interface RealK07Fixture {
  readonly ledger: AuthorizationLedger;
  readonly grant: AuthorizationGrant;
  readonly binding: PurchaseBinding;
}

/**
 * 用**真实 K07 账本**为一份 ViewModel 发行一张未占用的一次性授权：
 * 入账 `ConfirmAction` → attest → issueGrant。
 *
 * 注意 K07（K-R06 集成）以 `(taskId, actionId)` 为键、绑定九项，故这里给出 `TASK_ID`。
 */
export function issueGrantFor(
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
  const attestation = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });
  const grant = ledger.issueGrant(attestation);
  return { ledger, grant, binding };
}

/** 标准场景：默认地址 + slot-1 + 报价 → ViewModel。 */
export async function standardDeliveryConfirmation(): Promise<{
  readonly book: AddressBook;
  readonly addressView: AddressView;
  readonly slot: DeliverySlot;
  readonly quote: Quote;
  readonly viewModel: PurchaseConfirmationViewModel;
}> {
  const book = createAddressBook();
  const addressView = addressViewOf(book, 'addr-home');
  const { slot } = await selectSlot({ addressRef: addressView.ref, slotId: 'slot-1' });
  const quote = await quoteForAddress(addressView.ref);
  const viewModel = buildConfirmationFromDelivery({ addressView, slot, quote });
  return { book, addressView, slot, quote, viewModel };
}
