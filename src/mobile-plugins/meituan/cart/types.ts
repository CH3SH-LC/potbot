/**
 * M04 购物车与报价模型 —— 类型定义（零依赖、纯数据）。
 *
 * ## 本包的边界（美团线工作书 MEITUAN.md / M04）
 *
 * 美团**真实平台能力尚未核实**（未登录、无 token、无工具清单）。因此本包
 * **不接任何真实接口、不下单、不支付**，只提供可被 fixture 独立驱动的本地模型：
 * 购物车状态、报价（quote）结构、变更/过期失效判定、金额纪律。
 *
 * ## 三条结构性纪律（都在类型层面成立，不靠约定）
 *
 * 1. **本地没有价格**：`CartLine` 没有价格字段。价格只能出现在 `Quote` 里，
 *    而 `Quote` 只能由注入的 `QuotePort` 产生 ⇒ 本地**无法**算出总价去下单。
 * 2. **报价绑定参数摘要**：`Quote.paramsDigest` 必须等于请求携带的 `paramsDigest`，
 *    而 `paramsDigest` 是当前购物车参数的规范化指纹 ⇒ 任何参数变化都使旧报价失效。
 * 3. **过期只看注入时钟**：`Quote.expiresAt` 与 `QuoteClock.now()` 比较，
 *    本包**不读系统时间**（源码扫描由 `tests/mobile-meituan/M04/boundary.test.ts` 断言）。
 */

/** 规格选择：某个规格组（如「辣度」）下选中的选项（如「微辣」）。 */
export interface CartSpecSelection {
  readonly groupId: string;
  readonly optionId: string;
}

/**
 * 购物车条目。
 *
 * **没有任何价格/金额字段**——这是 M04「不能用模型计算价直接下单」的结构性保证：
 * 本地模型里根本不存在可用于下单的价格数字。
 */
export interface CartLine {
  /** 会话内稳定的条目 id（`line-1`、`line-2`…）。合并同规格时保留先到者的 id。 */
  readonly lineId: string;
  readonly merchantId: string;
  readonly dishId: string;
  readonly skuId: string;
  /** 规格选择，已按 `groupId` 规范化排序（同规格判定与顺序无关）。 */
  readonly specs: readonly CartSpecSelection[];
  /** 数量，正整数。 */
  readonly quantity: number;
}

/** 请求中的条目（与 `CartLine` 同构，但不带商家 id——商家在请求顶层）。 */
export interface QuoteRequestLine {
  readonly lineId: string;
  readonly dishId: string;
  readonly skuId: string;
  readonly specs: readonly CartSpecSelection[];
  readonly quantity: number;
}

/**
 * 配送参数：本包**只保存地址引用**，不保存地址明文。
 * 地址实体与其授权由 M05（`address-delivery/`）持有。
 */
export interface QuoteRequestDelivery {
  readonly addressRef: string;
}

/** 影响计价的用户选择。**不含任何金额**——费用与优惠一律由计价端口给出。 */
export interface QuoteRequestPricing {
  /** 用户勾选的优惠码（端口负责解释其含义与金额）。 */
  readonly couponCodes: readonly string[];
  /** 用户勾选的附加服务（如餐具、加急）；金额同样由端口给出。 */
  readonly serviceOptions: readonly string[];
}

/** 参数快照：摘要（digest）的唯一输入，也是「是否失效」的唯一判据。 */
export interface QuoteParamsSnapshot {
  readonly merchantId: string;
  readonly currency: string;
  /** 已按内容规范化排序（与加入顺序、条目 id 无关）。 */
  readonly lines: readonly QuoteRequestLine[];
  readonly delivery: QuoteRequestDelivery | null;
  readonly pricing: QuoteRequestPricing;
}

/** 交给计价端口的请求。`paramsDigest` 由本地模型算好，端口**必须原样回显**。 */
export interface QuoteRequest {
  readonly merchantId: string;
  readonly currency: string;
  readonly lines: readonly QuoteRequestLine[];
  readonly delivery: QuoteRequestDelivery | null;
  readonly pricing: QuoteRequestPricing;
  /** 本地算出的参数指纹；端口回显它即声明「本报价正是针对这组参数」。 */
  readonly paramsDigest: string;
  /** 发起时刻（注入时钟域的逻辑时间）。 */
  readonly requestedAt: number;
}

/** 报价中的一条明细。金额单位为**整数最小单位**（人民币为「分」）。 */
export interface QuoteItem {
  readonly lineId: string;
  readonly dishId: string;
  readonly skuId: string;
  readonly specs: readonly CartSpecSelection[];
  readonly quantity: number;
  readonly unitAmountMinor: number;
  readonly lineAmountMinor: number;
}

/** 费用项（配送费、打包费、服务费…）。`amountMinor` 为正的整数最小单位。 */
export interface QuoteFee {
  readonly code: string;
  readonly label: string;
  readonly amountMinor: number;
}

/** 优惠项。`amountMinor` 为**正的抵扣幅度**（不写负号），合计时做减法。 */
export interface QuoteDiscount {
  readonly code: string;
  readonly label: string;
  readonly amountMinor: number;
}

/**
 * 服务端报价。
 *
 * 字段与工作书一致：`quoteRef, amount, currency, items[], fees[], discount[], expiresAt, paramsDigest`
 * （其中 `discount[]` 在本包内命名为 `discounts`，元素同构）。
 *
 * `amount` 是**计价端口的最终价**（整数最小单位），本地只校验一致性、绝不改写它。
 */
export interface Quote {
  readonly quoteRef: string;
  readonly merchantId: string;
  /** 最终总价，整数最小单位（分）。由端口给出，本地不重算、不替换。 */
  readonly amount: number;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly items: readonly QuoteItem[];
  readonly fees: readonly QuoteFee[];
  readonly discounts: readonly QuoteDiscount[];
  /** 报价失效时刻（注入时钟域的逻辑时间）；`now() >= expiresAt` 即过期。 */
  readonly expiresAt: number;
  /** 端口回显的参数指纹。与当前购物车参数不符 ⇒ 报价失效。 */
  readonly paramsDigest: string;
  /** 端口生成报价时的逻辑时间。 */
  readonly pricedAt: number;
  /**
   * 恒为 `false` 的字面量：报价**不是**订单总额，也不构成任何下单授权。
   * 与既有适配器的 `isFinalPrice: false` 同一思路——把「不能拿它直接下单」写进类型。
   */
  readonly isOrderTotal: false;
}

/**
 * 计价端口。**报价的唯一来源**。
 *
 * 真实实现（美团侧计价接口）由后续包提供；本包只提供 fixture 实现
 * （见 `./fixture.ts`）。端口约定：
 * - 必须回显 `request.paramsDigest`；
 * - 必须让 `items` 与 `request.lines` 一一对应（同 `lineId`、同数量、同规格）；
 * - 必须满足 `amount = subtotal - Σdiscounts + Σfees`，且所有金额是整数最小单位。
 * 违反任一条，本地会**报错**（`QuoteIntegrityError`），而不是替端口「修正」。
 */
export interface QuotePort {
  price(request: QuoteRequest): Promise<Quote>;
}

/** 只读时钟端口。与 `src/clock` 的 `Clock` 结构兼容（后者 `now()` 返回的品牌数字可赋给 `number`）。 */
export interface QuoteClock {
  now(): number;
}

/** 报价失效原因。 */
export type QuoteStaleReason =
  /** 不是本会话当前持有的报价（例如已被更新的报价取代）。 */
  | 'not_current'
  /** 被显式作废（例如端口报告服务端费用变更）。 */
  | 'invalidated'
  /** 购物车参数已变（条目/数量/规格/地址/费用优惠任一变化都会改变指纹）。 */
  | 'params_changed'
  /** 已过期（注入时钟已到或已过 `expiresAt`）。 */
  | 'expired';

/** 报价可用性判定结果。**显式给出原因**，不静默沿用。 */
export interface QuoteCheck {
  readonly usable: boolean;
  readonly quoteRef: string;
  /** 为空数组表示可用；顺序固定为 not_current → invalidated → params_changed → expired。 */
  readonly reasons: readonly QuoteStaleReason[];
  readonly detail: string;
}

/**
 * 本地确认草稿。
 *
 * **它不是用户确认，也不构成任何下单授权**：只用来把「报价一旦失效，基于它的
 * 确认也就失效」这条规则显式化。真正的用户确认与原生确认流程由 M06
 * （`purchase-confirmation/`）持有；本包不提供任何提交/支付能力。
 */
export interface CartConfirmationDraft {
  readonly kind: 'local_draft_only';
  readonly draftRef: string;
  readonly quoteRef: string;
  readonly paramsDigest: string;
  readonly merchantId: string;
  readonly currency: string;
  readonly amount: number;
  readonly createdAt: number;
  /** 恒为 `false` 的字面量：本地草稿永远不具权威性。 */
  readonly authoritative: false;
}
