/**
 * M03 商家/菜单目录 —— 类型定义（零依赖、纯数据）。
 *
 * ## 本包边界（美团线工作书 MEITUAN.md / M03）
 *
 * 「商家/菜单/SKU/规格、营业库存、配送范围与分页」。
 * 独立验收：**真实来源/时间、分页完整，未知不补造菜品；恶意商家描述不变成指令**。
 *
 * 美团**真实平台能力尚未核实**（未登录、无 token、无工具清单），因此本包
 * **不接任何真实接口、不下单、不支付**。目录数据一律来自注入的 `CatalogPort`
 * （fixture 实现随包提供），时间一律来自注入的 `CatalogClock`。
 *
 * ## 四条结构性纪律（写进类型，不靠约定）
 *
 * 1. **每条数据必带来源**：`CatalogMerchant` / `CatalogItem` / `CatalogPage` 都有
 *    非可选的 `sourceRef`。没有来源就构造不出条目 ⇒ 编造在类型层面被挡住。
 * 2. **未知不补默认**：营业时间、库存、配送范围、声明总数一律 `MaybeKnown<T>`；
 *    未知必须带原因，`requireKnown` 把「当已知用」变成显式报错。
 * 3. **文本只能是数据**：店名/描述/规格名一律 `UntrustedText`（见 `./untrusted.ts`）；
 *    分类/分组/条目/SKU 一律用不透明 id 做键，自由文本不得冒充 id。
 * 4. **分页完整性可判定**：`CatalogSnapshot.completeness` 只可能是 `complete` 或
 *    `partial`，且 `partial` 必须带 `stopReason`；不完整的菜单绝不当完整菜单用。
 */

import type { MaybeKnown } from './known.js';
import type { UntrustedText } from './untrusted.js';

/** 来源归属：谁、经哪个端点、哪一刻给出。时间来自注入时钟，不读系统时间。 */
export interface SourceRef {
  /** 提供方标识（如 `fixture` / `meituan.openapi`）。 */
  readonly provider: string;
  /** 端点/接口标识（不透明字符串，不要求可解析）。 */
  readonly endpoint: string;
  /** 取数时刻（注入时钟域的逻辑时间，毫秒）。 */
  readonly retrievedAt: number;
  /** 供应方可选的回显引用（如 requestId），用于对账。 */
  readonly traceRef?: string;
}

/** 营业时段：某星期几的一个时间窗。`dayOfWeek` 星期一 = 0 … 星期日 = 6。 */
export interface OperatingWindow {
  readonly dayOfWeek: number;
  /** 开始（当日分钟数，0–1439）。 */
  readonly openMinute: number;
  /**
   * 结束（当日分钟数，0–1439）。
   * `closeMinute < openMinute` 表示**跨午夜**（如 22:00→次日 02:00）。
   * `closeMinute === openMinute` 视为歧义，校验时直接拒绝（不允许默默当成 24 小时）。
   */
  readonly closeMinute: number;
}

/** 配送范围：以门店为圆心的半径模型 + 起送金额。 */
export interface DeliveryRange {
  readonly kind: 'radius';
  readonly centerLat: number;
  readonly centerLng: number;
  /** 半径（米，正数）。 */
  readonly radiusMeters: number;
  /** 起送金额（整数最小单位）。 */
  readonly minOrderMinor: number;
}

/** 库存状态种类。 */
export type StockKind = 'in_stock' | 'low_stock' | 'out_of_stock';

/** 库存：种类 + 可选剩余数量。 */
export interface StockState {
  readonly kind: StockKind;
  /** 剩余份数；未知则 null（**不**默认成 0 或无限）。 */
  readonly remaining: number | null;
}

/** 规格选项（如「微辣」）。`priceDeltaMinor` 可为 0，也可为负（加价/减价）。 */
export interface SpecOption {
  readonly optionId: string;
  readonly label: UntrustedText;
  readonly priceDeltaMinor: number;
}

/** 规格组（如「辣度」）。 */
export interface SpecGroup {
  readonly groupId: string;
  readonly name: UntrustedText;
  /** 是否必选。 */
  readonly required: boolean;
  /** 是否可多选。 */
  readonly multiSelect: boolean;
  readonly options: readonly SpecOption[];
}

/** SKU 上的规格选择（引用某个组的某个选项）。 */
export interface SkuSpecSelection {
  readonly groupId: string;
  readonly optionId: string;
}

/** SKU：一个可下单的具体规格组合及其单价、库存。 */
export interface CatalogSku {
  readonly skuId: string;
  readonly specSelections: readonly SkuSpecSelection[];
  /** 单价（整数最小单位）。 */
  readonly priceMinor: number;
  readonly stock: MaybeKnown<StockState>;
}

/** 菜品（条目）。 */
export interface CatalogItem {
  /** 条目 id（不透明）。 */
  readonly itemId: string;
  readonly merchantId: string;
  readonly name: UntrustedText;
  readonly description: UntrustedText | null;
  readonly specGroups: readonly SpecGroup[];
  readonly skus: readonly CatalogSku[];
  /** 来源归属——非可选，编造菜品无法通过校验。 */
  readonly sourceRef: SourceRef;
}

/** 商家。 */
export interface CatalogMerchant {
  readonly merchantId: string;
  readonly name: UntrustedText;
  readonly description: UntrustedText | null;
  readonly operatingHours: MaybeKnown<readonly OperatingWindow[]>;
  readonly deliveryRange: MaybeKnown<DeliveryRange>;
  readonly sourceRef: SourceRef;
}

/** 菜单分页请求。 */
export interface CatalogMenuPageRequest {
  readonly merchantId: string;
  /** 首页为 null；后续页用上一页返回的 `nextCursor`。 */
  readonly cursor: string | null;
  readonly pageSize: number;
  /** 发起时刻（注入时钟域的逻辑时间）。 */
  readonly requestedAt: number;
}

/** 菜单分页结果。 */
export interface CatalogPage {
  readonly merchantId: string;
  readonly items: readonly CatalogItem[];
  /** 下一页游标；null 表示这是最后一页。 */
  readonly nextCursor: string | null;
  /** 页序号，从 0 起。 */
  readonly pageIndex: number;
  /** 供应方声明的总数；可能未知（未知不猜）。 */
  readonly declaredTotal: MaybeKnown<number>;
  readonly sourceRef: SourceRef;
}

/** 目录来源端口。真实实现（美团侧接口）由后续包提供；本包只提供 fixture。 */
export interface CatalogPort {
  fetchMerchant(merchantId: string, requestedAt: number): Promise<CatalogMerchant>;
  fetchMenuPage(request: CatalogMenuPageRequest): Promise<CatalogPage>;
}

/** 只读时钟端口。与 `src/clock` 的 `Clock` 结构兼容（`now()` 返回数字）。 */
export interface CatalogClock {
  now(): number;
}

/** 快照完整性。 */
export type SnapshotCompleteness = 'complete' | 'partial';

/** 分页汇总出的完整/部分菜单快照。 */
export interface CatalogSnapshot {
  readonly merchantId: string;
  readonly items: readonly CatalogItem[];
  /** 各页的来源归属（按页序）。 */
  readonly sourceRefs: readonly SourceRef[];
  /** 取数完成时刻（注入时钟域）。 */
  readonly fetchedAt: number;
  readonly pageCount: number;
  /** 只有「取到 `nextCursor === null` 才自然结束」才是 complete。 */
  readonly completeness: SnapshotCompleteness;
  /** 供应方声明总数（逐页取到的第一个已知值；全部未知则未知）。 */
  readonly declaredTotal: MaybeKnown<number>;
  /** 结束方式说明（complete 时为「最后一页 nextCursor=null」）。 */
  readonly stopReason: string;
}
