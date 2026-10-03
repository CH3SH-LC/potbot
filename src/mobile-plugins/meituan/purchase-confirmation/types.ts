/**
 * M06 购买确认 —— **业务合同、确认 ViewModel、订单参数与一次性确认的类型**（零依赖、纯类型）。
 *
 * ## 本包要关掉的洞（美团线工作书 MEITUAN.md / M06）
 *
 * 「用户确认」最容易被偷换成**一个布尔值**：模型或 JS 传 `{ confirmed: true }` 就当成批准。
 * 本包的结构性对策有三层，任何一层被绕过都还剩两层：
 *
 * 1. **展示数据只能来自权威来源**：`PurchaseConfirmationViewModel` 由
 *    {@link buildPurchaseConfirmationViewModel} 从 **M04 报价**（服务端最终价）+ 已绑定的
 *    地址视图/时段/范围构造，`displayOnly: true` 恒为字面量——**ViewModel 本身不构成授权**，
 *    它只是「给用户看的那一屏」。
 * 2. **订单参数摘要与金额上限是硬绑定**：`paramsDigest`（`sha256:<64hex>`，覆盖商家、
 *    条目 SKU-规格-数量、地址与其版本、时段、范围、币种）与 `AmountCeiling` 一起进 ViewModel；
 *    任一关键条件变化 ⇒ 摘要变 ⇒ 旧确认对不上。
 * 3. **一次性原生确认只能由本包签发**：{@link NativeConfirmationReceipt} 在模块私有的
 *    `WeakSet` 里登记；形状相同但未登记的对象一律 `untrusted_native_confirmation`。
 *    签发**必须**先经 K07 账本 `consume()` 原子占用一张一次性授权
 *    （见 `confirmation.ts`：`K07LedgerView` 是 K07 `AuthorizationLedger` 的结构投影，
 *    **不 import K07**，避免跨线耦合拖垮两线的独立可测性）。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **未接真实美团接口**：真实平台能力尚未核实；本包只有模型、合同声明与夹具。
 * - **未接原生确认页 / Android 进程**：`consumeNativePurchaseConfirmation` 的调用者边界
 *   （「只有原生确认页能调」）是**架构约定**，本包未在真机验证。
 * - **未持久化到手机 DB**：一次性语义依赖 K07 账本的原子占用；本包不持有存储。
 */

import type { CartSpecSelection, Quote } from '../cart/index.js';

// ---------------------------------------------------------------------------
// 范围词表（逐字取自 contracts/mobile-v1/schemas/confirm-action.schema.json 的 scope.enum）
// ---------------------------------------------------------------------------

export const CONFIRM_SCOPES = [
  'purchase',
  'payment',
  'submit-order',
  'write-file',
  'external-mutation',
] as const;

export type ConfirmScope = (typeof CONFIRM_SCOPES)[number];

// ---------------------------------------------------------------------------
// 升级后的美团业务合同（v2）
// ---------------------------------------------------------------------------

/** 本版合同的版本标记。合同从 v1 的「禁止购买」升级为「受确认保护的购买」。 */
export const MEITUAN_BUSINESS_CONTRACT_VERSION = 'meituan-business-v2';

/** 本版美团业务合同登记的动作。 */
export const MEITUAN_ACTION_KINDS = [
  'search-merchant',
  'read-menu',
  'read-address',
  'price-quote',
  'prepare-purchase',
  'submit-order',
  'pay-order',
  'cancel-order',
  'query-order',
] as const;

export type MeituanActionKind = (typeof MEITUAN_ACTION_KINDS)[number];

/**
 * 单条动作的合同规则。
 *
 * `autonomousAllowed` 对一切**改动外部世界**的动作恒为字面量 `false`：
 * 「自主购买」在类型层面不可表达。旧合同（`src/adapters/meituan/contract.ts`）
 * 用 `assertNotPurchaseAction` 直接**禁止**下单/支付；本次用户授权开发下单能力后，
 * 升级为「允许，但**必须**携带一次性用户确认」——保护没有删掉，只是换了落点。
 */
export interface MeituanActionRule {
  readonly actionId: MeituanActionKind;
  /** 是否改动外部世界（下单、支付、取消为 true；查询与本地准备为 false）。 */
  readonly mutatesExternalWorld: boolean;
  /** 是否**必须**携带一次性原生确认。 */
  readonly requiresUserConfirmation: boolean;
  /** 该动作要求的范围；只读动作为 `null`。 */
  readonly requiredScope: ConfirmScope | null;
  /** 是否允许自主（无用户确认）执行。改动外部世界的动作恒为 false。 */
  readonly autonomousAllowed: boolean;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// 订单参数（digest 的唯一输入）
// ---------------------------------------------------------------------------

/** 订单中的一条餐品：菜品 / SKU / 规格 / 数量。**不含金额**（金额来自报价）。 */
export interface OrderLineParam {
  readonly dishId: string;
  readonly skuId: string;
  readonly specs: readonly CartSpecSelection[];
  readonly quantity: number;
}

/**
 * **订单参数**——「摘要里到底钉了哪些量」的显式清单。
 *
 * 覆盖工作书要求逐项明确的六项：商家、SKU/规格/数量、收货地址、时段、动作范围、币种。
 * 地址用**引用 + 版本**（`addressRef` + `addressVersion`）：M05 换了地址版本即视为地址变化。
 * 联系人只保存**引用/掩码**（`contactRef`），不保存手机号明文。
 */
export interface OrderParams {
  readonly merchantId: string;
  readonly currency: string;
  readonly lines: readonly OrderLineParam[];
  readonly addressRef: string;
  /** 地址版本（M05 绑定）：版本变化会让旧确认失效。 */
  readonly addressVersion: number;
  /** 配送时段引用（M05）。 */
  readonly timeSlotRef: string;
  /** 联系人引用（掩码/引用，不是手机号明文）。 */
  readonly contactRef: string;
  /** 动作范围（如 `submit-order`）。 */
  readonly scope: ConfirmScope;
}

// ---------------------------------------------------------------------------
// 金额上限
// ---------------------------------------------------------------------------

/**
 * 金额上限（**策略输入，不是模型可编的值**）。
 * 未配置上限（`null`）时本包**拒绝**购买（`ceiling_not_configured`）——宁可不放行。
 */
export interface AmountCeiling {
  /** 上限，整数最小单位（分）。 */
  readonly ceilingMinor: number;
  readonly currency: string;
  /** 上限由谁设定（可审计：用户 / 任务策略 / 家长控制…）。 */
  readonly setBy: string;
}

// ---------------------------------------------------------------------------
// 确认 ViewModel（给用户看的那一屏）
// ---------------------------------------------------------------------------

export interface ConfirmationLineView {
  readonly lineId: string;
  readonly dishId: string;
  readonly dishName: string;
  readonly skuId: string;
  /** 规格的**展示串**（`辣度=微辣 & 份量=大份`，已排序）。 */
  readonly specText: string;
  readonly specs: readonly CartSpecSelection[];
  readonly quantity: number;
  readonly unitAmountMinor: number;
  readonly lineAmountMinor: number;
}

export interface ConfirmationMerchantView {
  readonly merchantId: string;
  readonly merchantName: string;
}

export interface ConfirmationAddressView {
  readonly addressRef: string;
  readonly addressVersion: number;
  /** 地址摘要（可展示，已脱敏：不含门牌/电话明文由上层保证）。 */
  readonly addressSummary: string;
  /** 联系人引用（引用，不是手机号）。 */
  readonly contactRef: string;
  /** 联系人展示（掩码，如 `1** **** 5678`）。 */
  readonly contactMasked: string;
}

export interface ConfirmationTimeSlotView {
  readonly slotRef: string;
  readonly slotLabel: string;
}

// ---------------------------------------------------------------------------
// M05 交付面（**结构投影**；本包不 import M05——与 K07LedgerView 同一纪律）
// ---------------------------------------------------------------------------

/**
 * M05 `AddressView` 的结构投影。
 *
 * 确认只取**引用 / 版本 / 掩码联系人**：`ref` 含版本（`<addressId>#v<version>`），
 * `contactMasked` 是掩码串。本包**不接收**手机号明文——真实 M05 `AddressView` 天然满足本类型，
 * 适配层（真机由原生页 / 集成层）读入后交给 {@link confirmationAddressFromDeliveryView}。
 */
export interface DeliveryAddressViewLike {
  readonly addressId: string;
  /** M05 引用，含版本：`<addressId>#v<version>`。 */
  readonly ref: string;
  readonly version: number;
  /** 联系人掩码（如 `1** **** 5678`）；不是明文。 */
  readonly contactMasked: string;
  /** 手机号掩码（可选，仅展示）。 */
  readonly phoneMasked?: string;
  readonly label?: string;
  readonly region?: string;
}

/** M05 `DeliverySlot` 的结构投影：时段只取 id（进摘要）与展示标签。 */
export interface DeliverySlotLike {
  readonly slotId: string;
  readonly label: string;
}

/**
 * M05 `ADDRESS_DELIVERY_OPERATIONS` 条目的结构投影。
 * 用于跨包核对「M06 确认依赖的 M05 操作都在，且都不触碰真实平台」。
 */
export interface AddressDeliveryOperationView {
  readonly name: string;
  readonly kind: string;
  readonly touchesRealPlatform: boolean;
  readonly needsPermission: boolean;
  readonly mutatesBook: boolean;
}

export interface ConfirmationAmountView {
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly feeMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  /** 展示串（如 `39.80 CNY`）；纯展示，不参与任何计算。 */
  readonly formattedTotal: string;
}

export interface ConfirmationCeilingView {
  readonly ceilingMinor: number;
  readonly currency: string;
  readonly setBy: string;
}

/**
 * 购买确认 ViewModel：**给用户看的那一屏**，也是「关键条件」的显式清单。
 *
 * 两个恒真的字面量字段把边界写进类型：
 * - `displayOnly: true`——ViewModel **不是**授权，看到它不等于用户已批准；
 * - `requiresNativeConfirmation: true`——真正下单/支付**必须**另经一次性原生确认。
 */
export interface PurchaseConfirmationViewModel {
  readonly kind: 'meituan-purchase-confirmation';
  readonly viewModelVersion: 1;
  readonly contractVersion: string;
  /** 合同动作**类别**（决定确认要求与范围，如 `submit-order`）。 */
  readonly contractAction: MeituanActionKind;
  /** 本次确认动作的**实例 id**（交给 K07 的 `actionId`，如 `act-m06`）。 */
  readonly actionId: string;
  readonly scope: ConfirmScope;
  readonly merchant: ConfirmationMerchantView;
  readonly lines: readonly ConfirmationLineView[];
  readonly delivery: ConfirmationAddressView;
  readonly timeSlot: ConfirmationTimeSlotView;
  readonly amounts: ConfirmationAmountView;
  readonly ceiling: ConfirmationCeilingView;
  /** 订单参数摘要（`sha256:<64hex>`）。 */
  readonly paramsDigest: string;
  readonly quoteRef: string;
  /** 确认有效期终点（注入时钟域）。 */
  readonly expiresAt: number;
  readonly requiresNativeConfirmation: true;
  readonly displayOnly: true;
}

// ---------------------------------------------------------------------------
// 一次性原生确认（K07 语义的消费面）
// ---------------------------------------------------------------------------

/**
 * K07 `AuthorizationGrant` 的**结构投影**（只取本包核对所需的字段）。
 *
 * 本包**不 import** K07：`confirmation.ts` 只要求一个满足 {@link K07LedgerView} 的账本对象，
 * K07 的 `AuthorizationLedger` 天然满足它（结构子类型）。真机接线上由适配层把账本传入。
 */
export interface K07GrantView {
  readonly grantId: string;
  readonly actionId: string;
  readonly accountRef: string;
  readonly taskRevision: number;
  readonly paramsDigest: string;
  readonly quoteRef: string;
  readonly amount: number;
  readonly currency: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly consumed: boolean;
  readonly consumedAt: number | null;
}

/** K07 的 `consume()` 入参（`actual` 是八项绑定，与 K07 `ActionBinding` 同形）。 */
export interface K07ConsumeInput {
  readonly grantId: string;
  readonly actual: {
    readonly actionId: string;
    readonly accountRef: string;
    readonly taskRevision: number;
    readonly paramsDigest: string;
    readonly quoteRef: string;
    readonly amount: number;
    readonly currency: string;
    readonly scope: string;
  };
}

/** K07 `consume()` 的返回（只取本包所需字段；K07 的返回类型是其超集）。 */
export interface K07ConsumeOutcome {
  readonly grant: K07GrantView;
  readonly submission: { readonly submissionId: string; readonly actionId: string };
}

/**
 * K07 账本的**结构视图**——一次性原生确认的**唯一可信来源**。
 *
 * `consume()` 是 K07 的**原子占用**：找不到授权抛 `grant_not_found`、已占用抛
 * `grant_already_consumed`、绑定不符抛 `grant_binding_mismatch`。
 * 因此「调用方自造一张授权」在本包不可表达：伪造的 `grantId` 在 K07 账本里根本不存在。
 */
export interface K07LedgerView {
  consume(input: K07ConsumeInput): K07ConsumeOutcome;
}

/**
 * 八项绑定 + 期限（K07 `ConfirmAction` 的形状，本包用来核对与传给 `consume`）。
 * 这是下单参数在授权侧的投影：`paramsDigest` 即 {@link OrderParams} 的摘要。
 */
export interface PurchaseBinding {
  readonly actionId: string;
  readonly accountRef: string;
  readonly taskRevision: number;
  readonly paramsDigest: string;
  readonly quoteRef: string;
  readonly amount: number;
  readonly currency: string;
  readonly scope: ConfirmScope;
  readonly expiresAt: number;
}

/**
 * **一次性原生确认回执**——本包可信签发器产出的确认凭证。
 *
 * 它只能由 {@link consumeNativePurchaseConfirmation} 产生（登记进模块私有 `WeakSet`）；
 * 调用方自造或拷贝同形对象一律 `untrusted_native_confirmation`。
 * `consumed: true` 是字面量：回执**生来就是已占用的一次性确认**。
 */
export interface NativeConfirmationReceipt {
  readonly actionId: string;
  readonly grantId: string;
  readonly submissionId: string;
  readonly binding: PurchaseBinding;
  /** 被确认的订单参数摘要（与 ViewModel 一致）。 */
  readonly paramsDigest: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** 原生确认页确认时刻（注入时钟域）。 */
  readonly confirmedAt: number;
  /** 确认界面标识（可审计：谁批的）。 */
  readonly surface: string;
  readonly consumed: true;
}

/**
 * 一次**被授权**的购买：所有关键条件在此逐项钉住。
 * 它由 {@link authorizePurchase} 产生，是「拿一次性确认 + 金额上限」核对之后的产物。
 */
export interface AuthorizedPurchase {
  readonly actionId: string;
  readonly grantId: string;
  readonly submissionId: string;
  readonly paramsDigest: string;
  readonly amountMinor: number;
  readonly ceilingMinor: number;
  readonly currency: string;
  readonly scope: ConfirmScope;
  readonly authorizedAt: number;
  /** 恒为字面量 true：授权购买**必须**经原生确认。 */
  readonly requiresNativeConfirmation: true;
}

/** 只读时钟端口（判过期用；本包不读系统时间）。 */
export interface PurchaseClock {
  now(): number;
}

/** 构造 ViewModel 所需的一切输入（报价来自 M04，地址/时段来自 M05 的视图）。 */
export interface PurchaseConfirmationInputs {
  /** 本次确认动作的**实例 id**（交给 K07 的 `actionId`）。 */
  readonly actionId: string;
  /** 合同动作**类别**：范围与确认要求由它决定（如 `submit-order` / `pay-order`）。 */
  readonly contractAction: MeituanActionKind;
  /** M04 的服务端报价（最终价的唯一来源）。 */
  readonly quote: Quote;
  readonly merchantName: string;
  readonly address: ConfirmationAddressView;
  readonly timeSlot: ConfirmationTimeSlotView;
  readonly scope: ConfirmScope;
  /** 账号/收款方引用（不是凭据）。 */
  readonly accountRef: string;
  readonly taskRevision: number;
  readonly ceiling: AmountCeiling;
  /** `dishId` → 展示名（可选）。 */
  readonly dishNames?: Readonly<Record<string, string>>;
  /** 订单确认有效期终点（注入时钟域）。 */
  readonly expiresAt: number;
}
