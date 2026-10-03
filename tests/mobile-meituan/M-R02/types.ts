/**
 * M-R02 备用包：SKU 必选/多选、库存、起送金额、配送范围边界 —— 类型定义。
 *
 * ## 本包的边界（美团线工作书 MEITUAN.md / 备用队列 M-R02）
 *
 * 美团**真实平台能力尚未核实**（未登录、无 token、无工具清单）。因此本包
 * **不接任何真实接口、不下单、不支付**：只提供可被本地 fixture 独立驱动的
 * 「点餐前校验」纯模型——把下一层（选规格 / 加减数量 / 判断能否凑起送 / 是否在配送范围）
 * 的判定规则变成可回归的、显式报错的结构。
 *
 * ## 本包负责的四类边界（逐条可测试）
 *
 * 1. **规格必选 / 多选**：单选的组恰好选 1 个；多选的组在 [min, max] 内；必选组不能空；
 *    引用了不存在的组/选项、重复选项、选了不可用选项一律显式报错。
 * 2. **库存**：`effectiveStock = min(SKU 总库存, 各已选选项库存)`，`null` 表示不限量；
 *    不可用选项使有效库存归零；数量必须是正整数且在库存/上下限之内。
 * 3. **起送金额**：`subtotal >= minOrderAmount` 即达成（**含等号**）；不足时给出差额。
 * 4. **配送范围边界**：默认**闭区间**（`distance <= range` 在范围内）；可切换为**开区间**
 *    （`distance < range`）；负数距离是非法入参，必须抛错而不是当成「在范围内」。
 *
 * ## 与 M03/M04 的关系
 *
 * 真实目录（商家/菜单/SKU）归 M03（`catalog/`），购物车与报价归 M04（`cart/`）。
 * 本包只提供**校验模型**，不持有价格、不产生报价。金额一律是整数最小单位（人民币为「分」）。
 */

/** 规格选择：某个规格组（如「辣度」）下选中的选项（如「微辣」）。 */
export interface SpecSelection {
  readonly groupId: string;
  readonly optionId: string;
}

/** 单个规格选项。 */
export interface SpecOption {
  readonly optionId: string;
  readonly name: string;
  /** 该选项当前是否可选（商家可能下架某口味/某加料）。 */
  readonly available: boolean;
  /** 该选项自身的库存；`null` = 不单独限制（由 SKU 总库存兜底）。非负整数。 */
  readonly stock: number | null;
}

/** 规格组的单选 / 多选模式。 */
export type SpecSelectionMode = 'single' | 'multi';

/** 规格组（如「辣度」「加料」）。 */
export interface SkuSpecGroup {
  readonly groupId: string;
  readonly name: string;
  readonly selectionMode: SpecSelectionMode;
  /** 必选组必须至少选一个选项。 */
  readonly required: boolean;
  /** 多选组的下限（单选组忽略此字段；必选单选等价于恰好 1）。 */
  readonly minSelections: number;
  /** 多选组的上限（单选组忽略此字段；单选最多 1 由 `selectionMode` 决定）。 */
  readonly maxSelections: number;
  readonly options: readonly SpecOption[];
}

/**
 * 一个可售 SKU（某道菜在某商家下的一个点法）。
 *
 * 注意：本类型**没有价格字段**——价格归 M04 报价端口，本地模型不持有。
 */
export interface DishSku {
  readonly skuId: string;
  readonly dishId: string;
  readonly merchantId: string;
  readonly name: string;
  /** SKU 总库存；`null` = 不限量。非负整数。 */
  readonly stock: number | null;
  /** 单条数量上限；`null` = 不额外限制。正整数。 */
  readonly maxQuantity: number | null;
  /** 单条数量下限；默认为 1。 */
  readonly minQuantity: number;
  readonly specGroups: readonly SkuSpecGroup[];
}

/** 配送范围边界的开闭语义。 */
export type RangeBoundary = 'inclusive' | 'exclusive';

/** 商家的履约参数（起送金额、配送范围）。本类型不含任何优惠/配送费计算。 */
export interface MerchantFulfillment {
  readonly merchantId: string;
  readonly currency: string;
  /** 起送金额，整数最小单位（分）。 */
  readonly minOrderAmountMinor: number;
  /** 配送半径，单位米。 */
  readonly deliveryRangeMeters: number;
  /** 边界语义：闭区间含端点，开区间不含端点。 */
  readonly rangeBoundary: RangeBoundary;
}

/** 校验问题码。所有失败都带码，便于上层按码分支而不是抠字符串。 */
export type CatalogIssueCode =
  // —— 规格 ——
  | 'invalid_id'
  | 'unknown_group'
  | 'unknown_option'
  | 'duplicate_option'
  | 'required_group_missing'
  | 'single_group_multi_selected'
  | 'too_few_selections'
  | 'too_many_selections'
  | 'option_unavailable'
  // —— 数量 / 库存 ——
  | 'not_positive_integer'
  | 'below_min_quantity'
  | 'above_max_quantity'
  | 'insufficient_stock'
  // —— 履约 ——
  | 'below_min_order'
  | 'out_of_range';

/** 一条校验问题。`limit`/`actual` 用于给出「差多少」的确切数字。 */
export interface CatalogIssue {
  readonly code: CatalogIssueCode;
  readonly message: string;
  readonly groupId?: string;
  readonly optionId?: string;
  /** 规则边界（库存上限、起送金额、配送半径…）。 */
  readonly limit?: number;
  /** 实际值（请求数量、小计金额、距离…）。 */
  readonly actual?: number;
}

/** 规格校验结果。`issues` 为空表示通过。 */
export interface SpecValidationResult {
  readonly ok: boolean;
  readonly issues: readonly CatalogIssue[];
}

/** 单条（SKU + 规格 + 数量）预检请求。 */
export interface LinePreflightRequest {
  readonly sku: DishSku;
  readonly selections: readonly SpecSelection[];
  readonly quantity: number;
}

/** 单条预检结果。`maxAddableQuantity` / `availableQuantity` 供 UI 步进器使用。 */
export interface LinePreflightResult {
  readonly ok: boolean;
  readonly issues: readonly CatalogIssue[];
  /** 本条在当前规格下最多可加的数量；`null` = 无已知上限（不限量且无单条上限）。 */
  readonly maxAddableQuantity: number | null;
  /** 当前规格下的有效库存；`null` = 不限量。 */
  readonly availableQuantity: number | null;
}

/** 商家履约预检请求（小计金额 + 距离）。 */
export interface MerchantPreflightRequest {
  readonly fulfillment: MerchantFulfillment;
  /** 加入本条后的购物车小计，整数最小单位（分），非负。 */
  readonly subtotalMinor: number;
  /** 到店/到用户的配送距离，单位米，非负。 */
  readonly distanceMeters: number;
}

/** 商家履约预检结果。 */
export interface MerchantPreflightResult {
  readonly ok: boolean;
  readonly issues: readonly CatalogIssue[];
  /** 距起送金额还差多少（已满足为 0）。 */
  readonly shortfallMinor: number;
  /** 是否在配送范围内（按商家声明的边界语义）。 */
  readonly inRange: boolean;
}

/** 金额一律整数最小单位；本常量供上层断言币种口径。 */
export const MONEY_MINOR_UNIT_NOTE = 'CNY 金额为「分」，一律非负整数';

/** 本包的验证模式标记：fixture，不是真实平台。 */
export const M_R02_VERIFICATION_MODE = 'fixture' as const;
