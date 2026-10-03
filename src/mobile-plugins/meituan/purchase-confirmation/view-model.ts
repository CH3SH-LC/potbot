/**
 * M06 **确认 ViewModel** 构造 —— 工作书要求逐项明确的六件事，一个都不能从模型字符串来：
 *
 * 1. **商家**（`merchant.merchantId` / `merchantName`）；
 * 2. **SKU / 规格 / 数量**（每条 `line.skuId` / `specs` / `specText` / `quantity`）；
 * 3. **总费用**（`amounts.totalMinor`，来自 M04 服务端报价，**本地不重算**）；
 * 4. **收货地址**（`delivery.addressRef` + `addressVersion` + 掩码联系人）；
 * 5. **配送时段**（`timeSlot.slotRef` / `slotLabel`）；
 * 6. **动作范围**（`scope`，并与合同 {@link assertScopePermitted} 核对）。
 *
 * 其中 1/2/3/4/5/6 会一起进 {@link computeOrderParamsDigest}；摘要被钉进一次性确认，
 * 因此**任一关键条件变化 ⇒ 旧确认失配**。
 *
 * 构造即校验：参数不全抛 `order_params_incomplete`，超出金额上限抛
 * `amount_exceeds_ceiling`——**过不了闸门就不产出 ViewModel**（不产出一个「展示出来却被拒」的屏）。
 */

import {
  formatMinorUnitsAsDecimalString,
  isValidMinorUnits,
  sumMinorUnits,
  type Quote,
} from '../cart/index.js';
import { assertWithinCeiling } from './ceiling.js';
import { computeOrderParamsDigest } from './digest.js';
import { PurchaseConfirmationError } from './errors.js';
import {
  MEITUAN_BUSINESS_CONTRACT_VERSION,
  type AddressDeliveryOperationView,
  type ConfirmationAddressView,
  type ConfirmationLineView,
  type ConfirmationTimeSlotView,
  type DeliveryAddressViewLike,
  type DeliverySlotLike,
  type OrderParams,
  type PurchaseConfirmationInputs,
  type PurchaseConfirmationViewModel,
} from './types.js';
import { assertScopePermitted } from './contract.js';
import { sortedSpecsKey } from './digest.js';

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PurchaseConfirmationError(
      'order_params_incomplete',
      `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PurchaseConfirmationError(
      'order_params_incomplete',
      `字段 ${field} 必须是非负安全整数，收到 ${JSON.stringify(value)}`,
      field,
    );
  }
  return value;
}

/** 规格展示串：`辣度=微辣 & 份量=大份`（空规格 → `默认`）。 */
export function specTextOf(specs: readonly { groupId: string; optionId: string }[]): string {
  const sorted = [...specs].sort((a, b) =>
    a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
  );
  if (sorted.length === 0) return '默认';
  return sorted.map((spec) => `${spec.groupId}=${spec.optionId}`).join(' & ');
}

/**
 * 从确认输入 + **M04 服务端报价**组装订单参数。
 * 这是「digest 里到底钉了什么」的显式清单，也会被适配层用来构造 K07 的 `ConfirmAction`。
 */
export function buildOrderParams(input: PurchaseConfirmationInputs): OrderParams {
  const quote = input.quote;
  const merchantId = requireNonEmpty(quote?.merchantId, 'merchantId');
  const currency = requireNonEmpty(quote?.currency, 'currency');
  requireNonEmpty(input.address?.addressRef, 'addressRef');
  requireNonEmpty(input.timeSlot?.slotRef, 'timeSlotRef');
  requireNonEmpty(input.address?.contactRef, 'contactRef');
  requireNonNegativeInteger(input.address?.addressVersion, 'addressVersion');
  const scope = input.scope;
  const lines = quote.items.map((item) => ({
    dishId: requireNonEmpty(item.dishId, 'lines.dishId'),
    skuId: requireNonEmpty(item.skuId, 'lines.skuId'),
    specs: item.specs,
    quantity: requireNonNegativeInteger(item.quantity, 'lines.quantity'),
  }));
  if (lines.length === 0) {
    throw new PurchaseConfirmationError(
      'order_params_incomplete',
      '订单没有任何条目（lines 为空）：无餐品不下单',
      'lines',
    );
  }
  return Object.freeze({
    merchantId,
    currency,
    lines: Object.freeze(lines.map((line) => Object.freeze({ ...line }))),
    addressRef: input.address.addressRef,
    addressVersion: input.address.addressVersion,
    timeSlotRef: input.timeSlot.slotRef,
    contactRef: input.address.contactRef,
    scope,
  });
}

/**
 * 构造给用户看的确认 ViewModel。
 *
 * @throws {PurchaseConfirmationError} 参数不全 / 范围不符 / 金额超限 / 金额非整数最小单位。
 */
export function buildPurchaseConfirmationViewModel(
  input: PurchaseConfirmationInputs,
): PurchaseConfirmationViewModel {
  const quote: Quote = input.quote;
  const actionId = requireNonEmpty(input.actionId, 'actionId');
  requireNonEmpty(input.merchantName, 'merchantName');

  // 范围与合同核对（下单/支付/取消各要自己的范围）。
  assertScopePermitted(input.contractAction, input.scope);

  const params = buildOrderParams(input);
  const paramsDigest = computeOrderParamsDigest(params);

  if (!isValidMinorUnits(quote.amount)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `报价总价不是整数最小单位：${String(quote.amount)}`,
      'amount',
    );
  }

  // 金额上限：过不了就不产出 ViewModel。
  assertWithinCeiling(quote.amount, quote.currency, input.ceiling);

  const dishNames = input.dishNames ?? {};
  const lines: readonly ConfirmationLineView[] = Object.freeze(
    quote.items.map((item) =>
      Object.freeze({
        lineId: item.lineId,
        dishId: item.dishId,
        dishName: dishNames[item.dishId] ?? item.dishId,
        skuId: item.skuId,
        specText: specTextOf(item.specs),
        specs: item.specs,
        quantity: item.quantity,
        unitAmountMinor: item.unitAmountMinor,
        lineAmountMinor: item.lineAmountMinor,
      }),
    ),
  );

  const feeMinor = sumMinorUnits(quote.fees.map((fee) => fee.amountMinor), 'fees');
  const discountMinor = sumMinorUnits(quote.discounts.map((discount) => discount.amountMinor), 'discounts');

  return Object.freeze({
    kind: 'meituan-purchase-confirmation' as const,
    viewModelVersion: 1 as const,
    contractVersion: MEITUAN_BUSINESS_CONTRACT_VERSION,
    contractAction: input.contractAction,
    actionId,
    scope: input.scope,
    merchant: Object.freeze({ merchantId: quote.merchantId, merchantName: input.merchantName }),
    lines,
    delivery: Object.freeze({
      addressRef: input.address.addressRef,
      addressVersion: input.address.addressVersion,
      addressSummary: input.address.addressSummary,
      contactRef: input.address.contactRef,
      contactMasked: input.address.contactMasked,
    }),
    timeSlot: Object.freeze({
      slotRef: input.timeSlot.slotRef,
      slotLabel: input.timeSlot.slotLabel,
    }),
    amounts: Object.freeze({
      currency: quote.currency,
      subtotalMinor: quote.subtotalMinor,
      feeMinor,
      discountMinor,
      totalMinor: quote.amount,
      formattedTotal: `${formatMinorUnitsAsDecimalString(quote.amount, quote.currency)} ${quote.currency}`,
    }),
    ceiling: Object.freeze({
      ceilingMinor: input.ceiling.ceilingMinor,
      currency: input.ceiling.currency,
      setBy: input.ceiling.setBy,
    }),
    paramsDigest,
    quoteRef: quote.quoteRef,
    expiresAt: requireNonNegativeInteger(input.expiresAt, 'expiresAt'),
    requiresNativeConfirmation: true as const,
    displayOnly: true as const,
  });
}

/**
 * 重建 ViewModel 当前应对应的订单参数摘要（用于「关键条件变化即失效」的复核）：
 * 拿着 ViewModel 的报价/地址/时段/范围，重新算一遍摘要，与 `viewModel.paramsDigest` 比对。
 * **相同 ⇒ 未被改动；不同 ⇒ 旧确认已失配。**
 */
export function recomputeDigestForViewModel(viewModel: {
  readonly merchant: { readonly merchantId: string };
  readonly lines: readonly {
    readonly dishId: string;
    readonly skuId: string;
    readonly specs: readonly { readonly groupId: string; readonly optionId: string }[];
    readonly quantity: number;
  }[];
  readonly delivery: { readonly addressRef: string; readonly addressVersion: number; readonly contactRef: string };
  readonly timeSlot: { readonly slotRef: string };
  readonly scope: PurchaseConfirmationViewModel['scope'];
  readonly amounts: { readonly currency: string };
}): string {
  return computeOrderParamsDigest({
    merchantId: viewModel.merchant.merchantId,
    currency: viewModel.amounts.currency,
    lines: viewModel.lines.map((line) => ({
      dishId: line.dishId,
      skuId: line.skuId,
      specs: line.specs,
      quantity: line.quantity,
    })),
    addressRef: viewModel.delivery.addressRef,
    addressVersion: viewModel.delivery.addressVersion,
    timeSlotRef: viewModel.timeSlot.slotRef,
    contactRef: viewModel.delivery.contactRef,
    scope: viewModel.scope,
  });
}

/** 摘要是否与 ViewModel 自身参数一致（不一致即 `view_model_binding_mismatch`）。 */
export function assertDigestMatchesViewModel(viewModel: PurchaseConfirmationViewModel): void {
  const recomputed = recomputeDigestForViewModel(viewModel);
  if (recomputed !== viewModel.paramsDigest) {
    throw new PurchaseConfirmationError(
      'view_model_binding_mismatch',
      `ViewModel 的 paramsDigest（${viewModel.paramsDigest}）与按其参数重算的摘要（${recomputed}）不一致：` +
        `展示数据与订单参数不符，须重新构造确认`,
      'paramsDigest',
    );
  }
}

/** 规格键（供外部核对；与 digest 内部口径一致）。 */
export function viewModelSpecKey(specs: readonly { groupId: string; optionId: string }[]): string {
  return sortedSpecsKey(specs);
}

// ---------------------------------------------------------------------------
// M05 交付面接入（**消费 M-I05 的地址/时段摘要**）
// ---------------------------------------------------------------------------
//
// 本包**不 import M05**（与 K07LedgerView 同一纪律）。原因有二：
// 1. 结构投影让 M06 的独立可测性不被 M05 的改动拖累；
// 2. 适配层（真机为原生页 / 集成层）负责把**真实** M05 `AddressView` / `DeliverySlot`
//    传进来——这样「确认里钉的地址就是 M05 绑定的那一份」在类型与运行期都可核对。
//
// 关键点：`ref`（含版本）与 `slotId` 会落进 `OrderParams` 并进 `computeOrderParamsDigest`
// ⇒ **改地址（换版本/引用）或改配送时间（换 slotId）都会让旧确认的 `paramsDigest` 失配**，
// `consumeNativePurchaseConfirmation` 随以 `native_confirmation_binding_mismatch` 拒绝。

/** M06 确认链依赖的 M05 交付操作名（跨包合同，逐项核对）。 */
export const PURCHASE_CONFIRMATION_DELIVERY_DEPENDENCIES = Object.freeze([
  'resolveDelivery',
  'applyLocationFix',
  'locateAndBind',
  'loadDeliverySlots',
  'selectDeliverySlot',
] as const);

/**
 * 核对 M05 声明的交付操作面（`ADDRESS_DELIVERY_OPERATIONS`）覆盖 M06 确认依赖，
 * 且这些操作都**不触碰真实平台**。
 *
 * 「M06 消费 M05 交付面」因此在运行期可核对，而不是靠注释：任何一项缺失，或某一项
 * 声明 `touchesRealPlatform !== false`，都当场拒绝。
 *
 * @throws {PurchaseConfirmationError} `invalid_view_model_input`（`field='address-delivery'`）。
 */
export function assertAddressDeliveryOperationsCovered(
  operations: readonly AddressDeliveryOperationView[],
): void {
  if (!Array.isArray(operations)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      'M05 交付操作面必须是数组',
      'address-delivery',
    );
  }
  const byName = new Map<string, AddressDeliveryOperationView>();
  for (const operation of operations) {
    if (operation !== null && typeof operation === 'object' && typeof operation.name === 'string') {
      byName.set(operation.name, operation);
    }
  }
  for (const dependency of PURCHASE_CONFIRMATION_DELIVERY_DEPENDENCIES) {
    const operation = byName.get(dependency);
    if (operation === undefined) {
      throw new PurchaseConfirmationError(
        'invalid_view_model_input',
        `M05 交付面缺少 M06 确认依赖的操作 ${dependency}：确认链接不上，不得凭本地假设继续`,
        'address-delivery',
      );
    }
    if (operation.touchesRealPlatform !== false) {
      throw new PurchaseConfirmationError(
        'invalid_view_model_input',
        `M06 确认依赖的操作 ${dependency} 声明会触碰真实平台` +
          `（touchesRealPlatform=${String(operation.touchesRealPlatform)}）：超出本地确认边界`,
        'address-delivery',
      );
    }
  }
}

/**
 * 从 M05 的地址视图（结构投影）构造确认收货地址视图。
 *
 * - `addressRef` / `addressVersion` **逐字**取自 M05 的 `ref` / `version`——版本进摘要，
 *   因此改地址即失效；
 * - 联系人只带**掩码**（`contactMasked`）与**引用**（`contactRef`）——本函数不接收、
 *   不产生手机号明文（真实 M05 `AddressView` 里也没有明文）；
 * - `contactRef` 缺省由 `addressId` 确定性导出（联系人与地址记录同版本变化）。
 *
 * @throws {PurchaseConfirmationError} 引用 / 版本 / 掩码不合法 ⇒ `order_params_incomplete`
 *   （与 `buildOrderParams` 的字段拒因口径一致）。
 */
export function confirmationAddressFromDeliveryView(
  view: DeliveryAddressViewLike,
  options: { readonly summary?: string; readonly contactRef?: string } = {},
): ConfirmationAddressView {
  const addressRef = requireNonEmpty(view?.ref, 'addressRef');
  const addressVersion = requireNonNegativeInteger(view?.version, 'addressVersion');
  const addressId = requireNonEmpty(view?.addressId, 'addressId');
  const contactMasked = requireNonEmpty(view?.contactMasked, 'contactMasked');
  const derivedSummary = [view?.label, view?.region]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');
  const addressSummary = requireNonEmpty(options.summary ?? derivedSummary, 'addressSummary');
  const contactRef = requireNonEmpty(options.contactRef ?? `contact:${addressId}`, 'contactRef');
  return Object.freeze({ addressRef, addressVersion, addressSummary, contactRef, contactMasked });
}

/**
 * 从 M05 的配送时段（结构投影）构造确认时段视图：`slotRef` 取 M05 的 `slotId`（进摘要）。
 *
 * @throws {PurchaseConfirmationError} 时段 id / 标签不合法 ⇒ `order_params_incomplete`。
 */
export function confirmationTimeSlotFromDeliverySlot(slot: DeliverySlotLike): ConfirmationTimeSlotView {
  return Object.freeze({
    slotRef: requireNonEmpty(slot?.slotId, 'timeSlotRef'),
    slotLabel: requireNonEmpty(slot?.label, 'timeSlotLabel'),
  });
}
