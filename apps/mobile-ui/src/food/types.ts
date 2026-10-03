/**
 * F10 food —— 卡片词表、通用视图类型与「卡片 ↔ M 线命令操作」映射。
 *
 * ## 本包定位（FRONTEND.md / F10）
 *
 * 外卖线（M 组）的**可见页面归 F**：选店 / 菜单 / 规格 / 购物车 / 地址 / 报价 / 订单卡。
 * 公共确认卡归 F05（`decisions/`），本包**只提供外卖具体字段**，不重造确认卡；
 * 通用文件容器归 F06，本包不碰。
 *
 * ## 三条纪律（写进类型与常量，不靠约定）
 *
 * 1. **消费 M 组契约**：本包不新造一套外卖数据模型，所有价格 / 规格 / 报价 / 订单
 *    状态都来自 `src/mobile-plugins/meituan/**` 的既有类型与判定函数。
 * 2. **选项不硬编码**：规格选项一律来自注入的目录数据（见 `catalog.ts`），
 *    本模块**没有**任何内置的辣度/份量选项表。
 * 3. **不伪造成功**：报价卡只反映 M04 的 `QuoteCheck`；订单卡只反映 M09 的
 *    七阶段报告与 M07 的提交状态。未知一律显式展示为未知。
 */

import type { CommandOperation } from '../../../../contracts/mobile-v1/types.js';

/**
 * 外卖卡种类。与 FRONTEND.md 的 F10 行一一对应。
 */
export type FoodCardKind = 'store' | 'menu' | 'spec' | 'cart' | 'address' | 'quote' | 'order';

export const FOOD_CARD_KINDS: readonly FoodCardKind[] = Object.freeze([
  'store',
  'menu',
  'spec',
  'cart',
  'address',
  'quote',
  'order',
]);

/**
 * 每张卡**消费**的 M 线命令操作（对应 `contracts/mobile-v1/schemas/command.schema.json`
 * 的 `operation` 枚举）。
 *
 * 本表是给内核接线者的机器可读声明：例如报价卡只消费 `query`（拿报价），
 * **不含** `apply` / `export`；购物车与地址卡是本地选择态（`mutate`）。
 * 任何试图在本包这一层引入下单/支付操作的改动都会与本表冲突（下单提交归 M07）。
 */
export const FOOD_CARD_OPERATIONS: Readonly<Record<FoodCardKind, readonly CommandOperation[]>> =
  Object.freeze({
    store: Object.freeze(['query'] as const),
    menu: Object.freeze(['query'] as const),
    spec: Object.freeze(['query'] as const),
    cart: Object.freeze(['mutate'] as const),
    address: Object.freeze(['mutate'] as const),
    quote: Object.freeze(['query'] as const),
    // 订单卡的「创建」指**发起订单跟踪任务**，不是下单提交；下单提交归 M07，不在本包。
    order: Object.freeze(['create', 'query'] as const),
  });

/** 所有卡片视图的公共前缀。 */
export interface FoodCardBase {
  readonly kind: FoodCardKind;
  /** 卡片标题（展示用，不参与判定）。 */
  readonly title: string;
}

/** 卡片通用备注：说明「本卡不做什么」，避免展示层越界。 */
export const FOOD_UI_BOUNDARY = Object.freeze({
  /** 本包不提交订单（下单提交状态机归 M07）。 */
  submitsOrder: false,
  /** 本包不发起支付。 */
  pays: false,
  /** 本包不接真实美团接口；数据来自注入的 M 组端口 / fixture。 */
  connectsRealPlatform: false,
  /** 本包本地不产生任何价格；价格只能来自 M04 `QuotePort`。 */
  computesPriceLocally: false,
  note: 'F10 只做外卖可见卡片的视图模型：价格来自报价端口，订单状态来自 M09 查询结果，规格选项来自注入目录。',
} as const);
