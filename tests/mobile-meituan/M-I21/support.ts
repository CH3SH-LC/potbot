/**
 * M-I21 测试夹具（**不是被收集的用例文件**）。
 *
 * ## 本单元在测什么
 *
 * 「跨包消费者旅程一致性」：把美团线**真实随包发布的 fixture 端口**串成一条完整
 * 消费旅程，逐个包地走：
 *
 *   M03 目录快照 → M04 购物车报价 → M05 地址/时段 → M06 用户确认
 *   → M07 下单提交 → M08 支付读回 → M09 订单生命周期
 *
 * 这里出现的端口**全部是各包 `fixture.ts` 里真实导出的实现**
 * （`createFixtureCatalogPort` / `createFixtureQuotePort` / `createFixtureSlotPort` /
 * `createFixtureOrderExecutor` / `createFixtureOrderQueryPort` /
 * `createFixturePaymentQueryPort`），不是本文件自造的 mock；用户确认一节还装配
 * `apps/mobile-kernel/actions` 的**真实 K07 账本**。
 *
 * ## 边界（不放松）
 *
 * - 零网络：所有端口都是本地确定性回放；不触网、不读系统时间（一切时刻由 `T0` 注入）。
 * - 不接入真实平台：M01 尚未核实任何真实美团端点/范围/协议，本文件的所有「成功」
 *   都来自显式 fixture 配置，**不构成**真实目录、报价、订单或支付。
 * - 不写任何真实手机号/地址/密钥：这里的联系人、坐标、账号引用都是合成占位值。
 */

import {
  CatalogService,
  FixtureCatalogClock,
  buildItem,
  buildMerchant,
  buildOption,
  buildSku,
  buildSpecGroup,
  createFixtureCatalogPort,
  known,
  type CatalogMerchant,
  type CatalogSnapshot,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import {
  CartSession,
  FixtureClock,
  createFixtureQuotePort,
  type Quote,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import {
  AddressBook,
  DeliverySlotSelector,
  buildSlots,
  checkDeliveryPlan,
  createDeliveryPlanFromSlot,
  createFixtureSlotPort,
  resolveDelivery,
  toAddressView,
  type AddressRecord,
  type AddressView,
  type DeliveryPlan,
  type DeliveryPlanCheck,
  type DeliverySlot,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import {
  STANDARD_CEILING,
  assertAddressDeliveryOperationsCovered,
  authorizePurchase,
  buildPurchaseConfirmationViewModel,
  confirmationAddressFromDeliveryView,
  confirmationTimeSlotFromDeliverySlot,
  consumeNativePurchaseConfirmation,
  type AuthorizedPurchase,
  type NativeConfirmationReceipt,
  type PurchaseBinding,
  type PurchaseConfirmationViewModel,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import {
  OrderSubmitter,
  computeIdempotencyKey,
  createAuthorizationRef,
  createFixtureOrderExecutor,
  createFixtureOrderQueryPort,
  createOrderReceipt,
  okResponse,
  type AuthorizationRef,
  type OrderBinding,
  type OrderSubmissionRecord,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import {
  FIXTURE_PAYMENT_HOST,
  PaymentTracker,
  createFixtureLinkPolicy,
  createFixturePaymentQueryPort,
  createPaymentCallback,
  createPaymentHandoff,
  createPaymentReadback,
  resumeOrderAfterPaymentReturn,
  type PaymentCallback,
  type PaymentQueryPort,
  type PaymentView,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import {
  FIXTURE_ORDER_STATUS_REGISTRY,
  OrderLifecycleTracker,
  stageReport,
  createFixtureOrderQueryPort as createFixtureLifecycleQueryPort,
  type OrderIntent,
  type OrderLifecycleView,
  type OrderQueryResult,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
// K07（`apps/mobile-kernel/actions`）**只读**引用。刻意**不走 barrel `index.js`**：
// 该 barrel 目前 re-export 一个在途未收口的 `wire-codec.ts`（另一条线正在改，当前
// `tsc` 不过），直接引用叶子模块 `ledger/clock/types` 可让本单元的定向类型检查不被它拖红。
// 语义上没有绕过任何判据：仍然装载**真实的** `AuthorizationLedger`。
import {
  createAuthorizationLedger,
  type AuthorizationLedger,
} from '../../../apps/mobile-kernel/actions/ledger.js';
import { createManualClock, type ManualClock } from '../../../apps/mobile-kernel/actions/clock.js';
import type { ActionBinding, AuthorizationGrant, ConfirmAction } from '../../../apps/mobile-kernel/actions/types.js';
import type { K07LedgerView } from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';

// ---------------------------------------------------------------------------
// 注入常量（全部为合成占位值，不含任何真实个人信息）
// ---------------------------------------------------------------------------

/** 逻辑时间原点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 商家 id（M03/M04 共用）。 */
export const MERCHANT_ID = 'merchant-1';

/** 账号引用（**引用，不是凭据**）。 */
export const ACCOUNT_REF = 'acct:meituan:7788';

/** 任务版本。 */
export const TASK_REVISION = 7;

/** 报价有效期（逻辑毫秒）。 */
export const QUOTE_TTL_MS = 300_000;

/** 订单确认有效期终点。 */
export const CONFIRM_EXPIRES = T0 + QUOTE_TTL_MS;

/** 一个配送时段的长度（30 分钟）。 */
export const STEP_MS = 30 * 60 * 1000;

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

/** 打包费 / 配送费（整数最小单位：分）。 */
export const PACKAGING_FEE_MINOR = 100;
export const DELIVERY_FEE_MINOR = 300;

/** 期望报价：3800×2 + 800 + 打包 100 + 配送 300 = 8800 分。 */
export const EXPECTED_QUOTE_AMOUNT_MINOR = 8_800;

/** 平台侧订单号（fixture 值，不是真实订单）。 */
export const PROVIDER_ORDER_REF = 'MT-ORDER-2603-0001';

// ---------------------------------------------------------------------------
// M03 目录快照
// ---------------------------------------------------------------------------

export interface CatalogStage {
  readonly merchant: CatalogMerchant;
  readonly snapshot: CatalogSnapshot;
  readonly service: CatalogService;
}

/**
 * 用真实 `FixtureCatalogPort` + `CatalogService` 翻一页完整菜单。
 * 商家营业时间与配送范围由显式 `known(...)` 给出（不靠 fixture 补造未知）。
 */
export async function buildCatalogStage(): Promise<CatalogStage> {
  const merchant = buildMerchant({
    merchantId: MERCHANT_ID,
    name: '示例餐厅（合成）',
    description: '仅供一致性测试的合成商家',
    operatingHours: known([{ dayOfWeek: 1, openMinute: 600, closeMinute: 1380 }], 'fixture-hours'),
    deliveryRange: known(
      { kind: 'radius' as const, centerLat: 31.19, centerLng: 121.43, radiusMeters: 5_000, minOrderMinor: 2_000 },
      'fixture-range',
    ),
    retrievedAt: T0,
  });

  const noodle = buildItem({
    itemId: 'dish-noodle',
    merchantId: MERCHANT_ID,
    name: '牛肉面',
    description: '招牌面',
    specGroups: [
      buildSpecGroup({
        groupId: 'spice',
        name: '辣度',
        required: true,
        options: [buildOption('mild', '微辣'), buildOption('hot', '特辣')],
      }),
    ],
    skus: [
      buildSku({
        skuId: 'sku-noodle',
        priceMinor: UNIT_AMOUNTS['sku-noodle'] as number,
        specSelections: [{ groupId: 'spice', optionId: 'mild' }],
      }),
    ],
    retrievedAt: T0,
  });

  const tea = buildItem({
    itemId: 'dish-tea',
    merchantId: MERCHANT_ID,
    name: '柠檬茶',
    skus: [buildSku({ skuId: 'sku-tea', priceMinor: UNIT_AMOUNTS['sku-tea'] as number })],
    retrievedAt: T0,
  });

  const port = createFixtureCatalogPort({
    merchant,
    pages: [{ items: [noodle, tea], declaredTotal: 2 }],
  });

  const service = new CatalogService({ port, clock: new FixtureCatalogClock(T0) });
  const loadedMerchant = await service.loadMerchant(MERCHANT_ID);
  const snapshot = await service.loadMenu({ merchantId: MERCHANT_ID });

  return { merchant: loadedMerchant, snapshot, service };
}

// ---------------------------------------------------------------------------
// M05 地址 / 时段（配送方案）
// ---------------------------------------------------------------------------

export interface DeliveryStage {
  readonly book: AddressBook;
  readonly record: AddressRecord;
  readonly addressView: AddressView;
  readonly slots: readonly DeliverySlot[];
  readonly slot: DeliverySlot;
  readonly selector: DeliverySlotSelector;
  readonly plan: DeliveryPlan;
  readonly planCheck: DeliveryPlanCheck;
}

/**
 * 建立地址簿 + 载入时段（真实 fixture 时段端口）+ 合成单一配送方案 `DeliveryPlan`。
 * 显式选择是唯一能绕开权限的路径（此处用显式选择）；默认地址仍然存在，供解析回退断言。
 */
export async function buildDeliveryStage(): Promise<DeliveryStage> {
  const book = new AddressBook();
  const record = book.add({
    addressId: 'addr-home',
    label: '家',
    contactName: '张三',
    phone: '13800008000',
    region: '上海市徐汇区',
    detail: '合成路 100 号',
    lat: 31.19,
    lng: 121.43,
    source: 'manual',
  });
  book.setDefault('addr-home');

  const slots = buildSlots(T0 + STEP_MS, STEP_MS, 4, { unavailableIndexes: [2] });
  const selector = new DeliverySlotSelector();
  await selector.load(createFixtureSlotPort(slots), {
    merchantId: MERCHANT_ID,
    addressRef: record.ref,
    now: T0,
  });
  const slot = selector.select('slot-1');

  const plan = createDeliveryPlanFromSlot(record, slot);
  const planCheck = checkDeliveryPlan(plan, {
    book,
    now: T0,
    currentSlotId: selector.selectedSlotId,
    slots,
  });

  return { book, record, addressView: toAddressView(record, { isDefault: true }), slots, slot, selector, plan, planCheck };
}

/** 解析配送视图：显式选择（唯一绕开权限的路径）。 */
export function resolveByExplicitSelection(book: AddressBook, addressId: string) {
  return resolveDelivery({ book, permission: 'unauthorized', explicitSelectionAddressId: addressId });
}

/** 解析配送视图：定位被拒且无显式选择 ⇒ 必须要求显式选择且**不得**回退到默认地址。 */
export function resolveWhenPermissionDenied(book: AddressBook) {
  return resolveDelivery({ book, permission: 'denied', explicitSelectionAddressId: null });
}

// ---------------------------------------------------------------------------
// M04 购物车 + 报价
// ---------------------------------------------------------------------------

export interface CartStage {
  readonly session: CartSession;
  readonly quote: Quote;
}

/** 造一个绑定真实 `FixtureQuotePort` 的空购物车会话（Merchant/币种/时钟已注入）。 */
export function newCartSession(): CartSession {
  const port = createFixtureQuotePort({
    unitAmountsMinor: UNIT_AMOUNTS,
    dishNames: DISH_NAMES,
    fees: [{ code: 'packaging', label: '打包费', amountMinor: PACKAGING_FEE_MINOR }],
    deliveryFeeMinor: DELIVERY_FEE_MINOR,
    ttlMs: QUOTE_TTL_MS,
  });
  return new CartSession({ merchantId: MERCHANT_ID, currency: 'CNY', port, clock: new FixtureClock(T0) });
}

/** 往会话里放标准条目（面条 ×2 + 茶 ×1）；**不**设置配送地址。规格组定义用 M04 自己的口径。 */
export function fillStandardCart(session: CartSession): void {
  session.cart.addLine({
    dishId: 'dish-noodle',
    skuId: 'sku-noodle',
    specs: [{ groupId: 'spice', optionId: 'mild' }],
    specGroups: [
      { groupId: 'spice', required: true, selectionMode: 'single', options: [{ optionId: 'mild' }, { optionId: 'hot' }] },
    ],
    quantity: 2,
  });
  session.cart.addLine({ dishId: 'dish-tea', skuId: 'sku-tea', quantity: 1 });
}

/** 由目录里的 SKU 建条目，绑定 M05 的地址引用，再向真实 `FixtureQuotePort` 取价。 */
export async function buildCartStage(addressRef: string): Promise<CartStage> {
  const session = newCartSession();
  fillStandardCart(session);
  session.cart.setDeliveryAddress(addressRef);
  const quote = await session.requestQuote();
  return { session, quote };
}

// ---------------------------------------------------------------------------
// M06 用户确认（真实 K07 账本）
// ---------------------------------------------------------------------------

export interface RealK07Fixture {
  readonly ledger: AuthorizationLedger;
  /** 交给 M06 `consumeNativePurchaseConfirmation` 的结构投影（补齐 K07 新引入的 `taskId`）。 */
  readonly ledgerView: K07LedgerView;
  readonly clock: ManualClock;
  readonly confirm: ConfirmAction;
  readonly grant: AuthorizationGrant;
  readonly binding: PurchaseBinding;
}

/**
 * K07 任务身份（K-R06 之后 `AuthorizationGrant`/`ConfirmAction` 逐项绑定的一员）。
 *
 * M06 的确认绑定（`PurchaseBinding`）尚未携带 `taskId`——它是在 K07 引入 `taskId` **之前**
 * 定型的。因此这里用一个**显式的适配层**把任务身份补上，而不是自造账本：授权仍由真实
 * K07 账本登记与发行，占用仍由真实 `AuthorizationLedger.consume` 原子裁定。
 * 「M06 应原生携带 taskId」作为集成请求记在 report 的 residuals 里。
 */
export const K07_TASK_ID = 'task-m21';

/** 由 ViewModel 构造期望的 K07 绑定（账本入账与 M06 消费共用同一份参数）。 */
export function purchaseBindingFor(viewModel: PurchaseConfirmationViewModel): PurchaseBinding {
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
  };
}

/**
 * 用**真实 K07 账本**装配一张未占用的一次性授权（入账 → attest → issueGrant），
 * 并给出 M06 侧的结构投影（把 `taskId` 适配地补进 `consume()` 的 actual）。
 */
export function setupRealK07(viewModel: PurchaseConfirmationViewModel): RealK07Fixture {
  const clock = createManualClock(T0);
  const ledger = createAuthorizationLedger({ clock });
  const binding = purchaseBindingFor(viewModel);
  const confirm: ConfirmAction = { taskId: K07_TASK_ID, ...binding };
  ledger.recordConfirmAction(confirm);
  const attestation = ledger.attest(K07_TASK_ID, confirm.actionId, { surface: 'native.confirm' });
  const grant = ledger.issueGrant(attestation);

  const ledgerView: K07LedgerView = {
    consume: (input) =>
      ledger.consume({
        grantId: input.grantId,
        actual: { taskId: K07_TASK_ID, ...input.actual } as unknown as ActionBinding,
      }),
  };

  return { ledger, ledgerView, clock, confirm, grant, binding };
}

export interface ConfirmationStage {
  readonly viewModel: PurchaseConfirmationViewModel;
  readonly k07: RealK07Fixture;
  readonly receipt: NativeConfirmationReceipt;
  readonly authorized: AuthorizedPurchase;
  readonly binding: PurchaseBinding;
}

/** 构造确认 ViewModel（消费 M04 报价 + M05 地址/时段），再经真实 K07 消费得到授权购买。 */
export function buildConfirmationStage(input: {
  readonly quote: Quote;
  readonly addressView: AddressView;
  readonly slot: DeliverySlot;
}): ConfirmationStage {
  const viewModel = buildPurchaseConfirmationViewModel({
    actionId: 'act-m06',
    contractAction: 'submit-order',
    quote: input.quote,
    merchantName: '示例餐厅（合成）',
    address: confirmationAddressFromDeliveryView(input.addressView, { summary: '上海市徐汇区 · 家（合成）' }),
    timeSlot: confirmationTimeSlotFromDeliverySlot(input.slot),
    scope: 'submit-order',
    accountRef: ACCOUNT_REF,
    taskRevision: TASK_REVISION,
    ceiling: STANDARD_CEILING,
    dishNames: DISH_NAMES,
    expiresAt: CONFIRM_EXPIRES,
  });

  const k07 = setupRealK07(viewModel);
  const receipt = consumeNativePurchaseConfirmation({
    ledger: k07.ledgerView,
    grant: k07.grant,
    expected: k07.binding,
    surface: 'native.confirm',
    now: T0,
  });
  const authorized = authorizePurchase({
    receipt,
    ceiling: STANDARD_CEILING,
    viewModel,
    now: T0,
  });

  return { viewModel, k07, receipt, authorized, binding: k07.binding };
}

// ---------------------------------------------------------------------------
// M07 下单提交
// ---------------------------------------------------------------------------

export interface SubmitRig {
  readonly submitter: OrderSubmitter;
  readonly authorization: AuthorizationRef;
  readonly orderBinding: OrderBinding;
  readonly idempotencyKey: string;
  readonly providerOrderRef: string;
  readonly executorCallCount: () => number;
}

export interface SubmissionStage extends SubmitRig {
  readonly first: OrderSubmissionRecord;
  readonly second: OrderSubmissionRecord;
  readonly confirmed: OrderSubmissionRecord;
}

/** 由被授权购买构造 M07 的九项绑定（参数摘要沿用 M06 的 sha256 口径）。 */
export function orderBindingFor(input: {
  readonly authorized: AuthorizedPurchase;
  readonly quote: Quote;
}): OrderBinding {
  return {
    actionId: input.authorized.actionId,
    merchantId: MERCHANT_ID,
    accountRef: ACCOUNT_REF,
    taskRevision: TASK_REVISION,
    paramsDigest: input.authorized.paramsDigest,
    quoteRef: input.quote.quoteRef,
    amount: input.authorized.amountMinor,
    currency: input.authorized.currency,
    scope: 'submit-order',
  };
}

/**
 * 装配一个**尚未提交**的下单器（真实 `FixtureOrderExecutor` / `FixtureOrderQueryPort`），
 * 供负例（伪造授权、错误幂等键）直接驱动，而不影响正例的状态。
 */
export function buildSubmitRig(input: {
  readonly authorized: AuthorizedPurchase;
  readonly quote: Quote;
}): SubmitRig {
  const orderBinding = orderBindingFor(input);
  const idempotencyKey = computeIdempotencyKey(orderBinding);
  const authorization = createAuthorizationRef({
    grantId: `grant-${idempotencyKey}`,
    grantedBy: 'native.confirm',
    issuedAt: T0,
    expiresAt: CONFIRM_EXPIRES,
    binding: orderBinding,
  });

  const executor = createFixtureOrderExecutor({
    respond: () => okResponse(PROVIDER_ORDER_REF, 'ok'),
  });
  const orderQuery = createFixtureOrderQueryPort({
    respond: (request) =>
      createOrderReceipt({
        idempotencyKey: request.idempotencyKey,
        providerOrderRef: PROVIDER_ORDER_REF,
        observedState: 'confirmed',
        observedAt: T0,
        verificationMode: 'real',
        detail: 'fixture 受控回执（不代表真实平台）',
      }),
  });
  const submitter = new OrderSubmitter({ clock: new FixtureClock(T0), executor, orderQuery });

  return {
    submitter,
    authorization,
    orderBinding,
    idempotencyKey,
    providerOrderRef: PROVIDER_ORDER_REF,
    executorCallCount: () => executor.calls.length,
  };
}

/**
 * 提交一次下单：真实 `FixtureOrderExecutor` 回放「HTTP 200 + 业务码 ok」⇒ `submitted`；
 * 再以真实 `FixtureOrderQueryPort` 取回受控签发回执 ⇒ `confirmed`（唯一可声称已下单的态）。
 */
export async function buildSubmissionStage(input: {
  readonly authorized: AuthorizedPurchase;
  readonly quote: Quote;
}): Promise<SubmissionStage> {
  const rig = buildSubmitRig(input);
  const first = await rig.submitter.submit({ authorization: rig.authorization, idempotencyKey: rig.idempotencyKey });
  const second = await rig.submitter.submit({ authorization: rig.authorization, idempotencyKey: rig.idempotencyKey });
  const queried = await rig.submitter.queryOriginalOrder(rig.idempotencyKey);

  if (queried.record.state !== 'confirmed') {
    throw new Error(`夹具期望 confirmed 记录，实际 ${queried.record.state}`);
  }

  return { ...rig, first: first.record, second: second.record, confirmed: queried.record };
}

// ---------------------------------------------------------------------------
// M08 支付读回
// ---------------------------------------------------------------------------

export interface PaymentStage {
  readonly tracker: PaymentTracker;
  readonly handoff: ReturnType<typeof createPaymentHandoff>;
  readonly callback: PaymentCallback;
  readonly paymentPort: PaymentQueryPort;
  readonly began: PaymentView;
  readonly returned: PaymentView;
  readonly paid: PaymentView;
}

/** 合成支付域名策略（`pay.meituan.test` 为 RFC 2606 保留的合成域名，非官方站）。 */
export function fixtureLinkPolicy() {
  return createFixtureLinkPolicy();
}

/**
 * 走一遍 M08：展示官方支付入口 → 回跳（只触发查询，**不**因 `rawOutcome=success` 置已付款）
 * → 平台受控读回 `paid` ⇒ 唯一能进 `confirmed_paid` 的路径。
 */
export async function buildPaymentStage(input: {
  readonly externalId: string;
  readonly amountMinor: number;
}): Promise<PaymentStage> {
  const linkPolicy = fixtureLinkPolicy();
  const paymentIntentRef = 'pay-intent-1';
  const tracker = new PaymentTracker({
    intent: {
      paymentIntentRef,
      externalId: input.externalId,
      accountRef: ACCOUNT_REF,
      amountMinor: input.amountMinor,
      currency: 'CNY',
      provider: 'meituan-cashier(fixture)',
    },
    clock: { now: () => T0 },
    linkPolicy,
  });

  const handoff = createPaymentHandoff({
    handoffRef: 'handoff-1',
    paymentIntentRef,
    mode: 'official_page',
    url: `https://${FIXTURE_PAYMENT_HOST}/cashier`,
    linkPolicy,
    issuedAt: T0,
    expiresAt: CONFIRM_EXPIRES,
    instructionForUser: '请在外部官方收银台完成支付；本应用不代填卡号/验证码/PIN。',
  });
  const callback = createPaymentCallback({
    callbackRef: 'callback-1',
    paymentIntentRef,
    returnUrl: `https://${FIXTURE_PAYMENT_HOST}/return?result=success`,
    linkPolicy,
    receivedAt: T0,
    rawOutcome: 'success',
  });
  const paymentPort = createFixturePaymentQueryPort({
    respond: () =>
      createPaymentReadback({
        paymentIntentRef,
        externalId: input.externalId,
        accountRef: ACCOUNT_REF,
        amountMinor: input.amountMinor,
        currency: 'CNY',
        providerPaymentRef: 'PAY-REF-2603-0001',
        paidState: 'paid',
        observedAt: T0,
        evidenceRef: 'ev-payment-1',
        verificationMode: 'real',
        detail: 'fixture 受控读回（不代表真实支付）',
      }),
  });

  const began = tracker.begin(handoff);
  const returned = tracker.handleReturn(callback);
  const paid = await tracker.refresh(paymentPort);

  return { tracker, handoff, callback, paymentPort, began, returned, paid };
}

// ---------------------------------------------------------------------------
// M09 订单生命周期
// ---------------------------------------------------------------------------

export interface LifecycleStage {
  readonly tracker: OrderLifecycleTracker;
  readonly paidView: OrderLifecycleView;
  readonly completedView: OrderLifecycleView;
  readonly unknownView: OrderLifecycleView;
}

/** 由本地意图构造 M09 跟踪器（意图即 M07 已确认下单的投影）。 */
export function orderIntentFor(externalId: string, amountMinor: number): OrderIntent {
  return { orderIntentRef: 'order-intent-1', externalId, accountRef: ACCOUNT_REF, amountMinor, currency: 'CNY' };
}

function lifecycleResult(rawStatusCode: string, evidenceRef: string): OrderQueryResult {
  return {
    externalId: PROVIDER_ORDER_REF,
    accountRef: ACCOUNT_REF,
    amountMinor: EXPECTED_QUOTE_AMOUNT_MINOR,
    currency: 'CNY',
    rawStatusCode,
    refundStatusCode: null,
    refundAmountMinor: null,
    observedAt: T0,
    evidenceRef,
  };
}

/**
 * 断线后**先查原单**：`resumeAfterDisconnect` → `poll`，逐阶段报告。
 * 另喂一个本地不认识的码，验证「未知状态码 ⇒ 七阶段全 unknown」。
 */
export async function buildLifecycleStage(externalId: string): Promise<LifecycleStage> {
  const tracker = new OrderLifecycleTracker({
    intent: orderIntentFor(externalId, EXPECTED_QUOTE_AMOUNT_MINOR),
    registry: FIXTURE_ORDER_STATUS_REGISTRY,
  });

  const port = createFixtureLifecycleQueryPort({
    results: [
      lifecycleResult('W_PAID_WAIT_ACCEPT', 'ev-order-1'),
      lifecycleResult('W_COMPLETED', 'ev-order-2'),
    ],
  });

  const paidView = await tracker.resumeAfterDisconnect(port);
  const completedView = await tracker.poll(port);

  const freshTracker = new OrderLifecycleTracker({
    intent: orderIntentFor(externalId, EXPECTED_QUOTE_AMOUNT_MINOR),
    registry: FIXTURE_ORDER_STATUS_REGISTRY,
  });
  const unknownPort = createFixtureLifecycleQueryPort({
    results: [lifecycleResult('W_NOT_A_REAL_CODE', 'ev-order-unknown')],
  });
  const unknownView = await freshTracker.resumeAfterDisconnect(unknownPort);

  return { tracker, paidView, completedView, unknownView };
}

// ---------------------------------------------------------------------------
// M08 × M09 桥：支付回跳 → query-first → paid 阶段报告
// ---------------------------------------------------------------------------

export interface BridgeStage {
  readonly withReadback: Awaited<ReturnType<typeof resumeOrderAfterPaymentReturn>>;
  readonly returnOnly: Awaited<ReturnType<typeof resumeOrderAfterPaymentReturn>>;
}

/**
 * 装配 M08×M09 桥的两种情形：
 * - `withReadback`：回跳 → 查原单 → 受控读回 ⇒ `paid` 阶段 `confirmed`（`confirmedBy='payment_readback'`）；
 * - `returnOnly`：只登记回跳、不读回 ⇒ `paid` 阶段只能是 `pending`（回跳**不是**付款证据）。
 * 每次都用一个**全新**的跟踪器，且用计数端口断言原单查询**恰好一次**。
 */
export async function buildBridgeStage(input: {
  readonly externalId: string;
  readonly amountMinor: number;
  readonly callback: PaymentCallback;
}): Promise<BridgeStage> {
  const linkPolicy = fixtureLinkPolicy();
  const paymentIntentRef = 'pay-intent-1';

  const makePayment = (): PaymentTracker =>
    new PaymentTracker({
      intent: {
        paymentIntentRef,
        externalId: input.externalId,
        accountRef: ACCOUNT_REF,
        amountMinor: input.amountMinor,
        currency: 'CNY',
        provider: 'meituan-cashier(fixture)',
      },
      clock: { now: () => T0 },
      linkPolicy,
    });

  const readbackPort = createFixturePaymentQueryPort({
    respond: () =>
      createPaymentReadback({
        paymentIntentRef,
        externalId: input.externalId,
        accountRef: ACCOUNT_REF,
        amountMinor: input.amountMinor,
        currency: 'CNY',
        providerPaymentRef: 'PAY-REF-2603-0001',
        paidState: 'paid',
        observedAt: T0,
        evidenceRef: 'ev-payment-1',
        verificationMode: 'real',
        detail: 'fixture 受控读回（不代表真实支付）',
      }),
  });

  const orderPort = (): ReturnType<typeof createFixtureLifecycleQueryPort> =>
    createFixtureLifecycleQueryPort({ results: [lifecycleResult('W_PAID_WAIT_ACCEPT', 'ev-order-bridge')] });

  // 回跳前必须先展示过官方入口：`not_started → callback_pending_verification` 在 M08
  // 的转换表里是**非法**的（一次从未展示的支付不可能有回跳）。桥因此要求先 `begin`。
  const handoff = createPaymentHandoff({
    handoffRef: 'handoff-bridge',
    paymentIntentRef,
    mode: 'official_page',
    url: `https://${FIXTURE_PAYMENT_HOST}/cashier`,
    linkPolicy,
    issuedAt: T0,
    expiresAt: CONFIRM_EXPIRES,
    instructionForUser: '请在外部官方收银台完成支付；本应用不代填卡号/验证码/PIN。',
  });

  const withReadback = await resumeOrderAfterPaymentReturn({
    payment: makePayment(),
    callback: input.callback,
    orderLifecycle: new OrderLifecycleTracker({
      intent: orderIntentFor(input.externalId, input.amountMinor),
      registry: FIXTURE_ORDER_STATUS_REGISTRY,
    }),
    orderPort: orderPort(),
    paymentPort: readbackPort,
    handoff,
  });

  const returnOnly = await resumeOrderAfterPaymentReturn({
    payment: makePayment(),
    callback: input.callback,
    orderLifecycle: new OrderLifecycleTracker({
      intent: orderIntentFor(input.externalId, input.amountMinor),
      registry: FIXTURE_ORDER_STATUS_REGISTRY,
    }),
    orderPort: orderPort(),
    handoff,
  });

  return { withReadback, returnOnly };
}

/** 便利：取某阶段的报告（M09 `stageReport`）。 */
export function stageOf(view: OrderLifecycleView, stage: Parameters<typeof stageReport>[1]) {
  return stageReport(view, stage);
}

/** 跨包核对：M06 确认链依赖的 M05 交付面必须齐全且不触真实平台。 */
export { assertAddressDeliveryOperationsCovered };

// ---------------------------------------------------------------------------
// 一次性走完整条消费旅程
// ---------------------------------------------------------------------------

export interface ConsumerJourney {
  readonly catalog: CatalogStage;
  readonly delivery: DeliveryStage;
  readonly cart: CartStage;
  readonly confirmation: ConfirmationStage;
  readonly submission: SubmissionStage;
  readonly payment: PaymentStage;
  readonly lifecycle: LifecycleStage;
  readonly bridge: BridgeStage;
}

/**
 * 走完整条消费者旅程（M03 → M04 → M05 → M06 → M07 → M08 → M09 + M08×M09 桥）。
 *
 * 顺序说明：M04 的 `requestQuote()` 明确要求已设置配送地址（没有地址的报价被
 * `CartValidationError` 拒绝），因此**地址/时段（M05）必然先于报价（M04）的取价步骤**；
 * 但购物车条目本身（M04）先由 M03 的 SKU 建好。这条依赖是本套件要断言的纪律之一，
 * 不是绕路。
 */
export async function runConsumerJourney(): Promise<ConsumerJourney> {
  const catalog = await buildCatalogStage();
  const delivery = await buildDeliveryStage();
  const cart = await buildCartStage(delivery.record.ref);
  const confirmation = buildConfirmationStage({
    quote: cart.quote,
    addressView: delivery.addressView,
    slot: delivery.slot,
  });
  const submission = await buildSubmissionStage({
    authorized: confirmation.authorized,
    quote: cart.quote,
  });
  const payment = await buildPaymentStage({
    externalId: submission.providerOrderRef,
    amountMinor: cart.quote.amount,
  });
  const lifecycle = await buildLifecycleStage(submission.providerOrderRef);
  const bridge = await buildBridgeStage({
    externalId: submission.providerOrderRef,
    amountMinor: cart.quote.amount,
    callback: payment.callback,
  });

  return { catalog, delivery, cart, confirmation, submission, payment, lifecycle, bridge };
}
