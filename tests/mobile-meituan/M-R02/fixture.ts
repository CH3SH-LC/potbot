/**
 * M-R02 —— 本地 fixture（**不是真实平台数据**）。
 *
 * 目录内容纯属本地构造，用来独立驱动校验规则。真实商家/菜单/库存必须由 M03
 * 在核实美团能力后接入；本 fixture **不得**被当成生产开关（工作书 §2、M10 边界）。
 *
 * 关键字段故意设置出边界点，方便回归：
 * - `m-noodle`：起送 2000 分、配送 3000 米、闭区间；
 * - `m-drink`：起送 0（无起送门槛）、配送 500 米、**开区间**（恰好 500 米算超范围）；
 * - 一个多选「加料」组，其中一个选项 `available=false`；
 * - 一个 SKU 选项库存 3（比 SKU 总库存 50 更紧）。
 */

import type { DishSku, MerchantFulfillment, SkuSpecGroup } from './types.js';

const spicy = (): SkuSpecGroup => ({
  groupId: 'spicy',
  name: '辣度',
  selectionMode: 'single',
  required: true,
  minSelections: 1,
  maxSelections: 1,
  options: [
    { optionId: 'mild', name: '微辣', available: true, stock: null },
    { optionId: 'medium', name: '中辣', available: true, stock: null },
    { optionId: 'hot', name: '特辣', available: true, stock: null },
  ],
});

const portion = (): SkuSpecGroup => ({
  groupId: 'portion',
  name: '份量',
  selectionMode: 'single',
  required: false,
  minSelections: 0,
  maxSelections: 1,
  options: [
    { optionId: 'normal', name: '标准', available: true, stock: null },
    { optionId: 'large', name: '大份', available: true, stock: 3 },
  ],
});

const addons = (): SkuSpecGroup => ({
  groupId: 'addon',
  name: '加料',
  selectionMode: 'multi',
  required: false,
  minSelections: 0,
  maxSelections: 3,
  options: [
    { optionId: 'egg', name: '加蛋', available: true, stock: null },
    { optionId: 'beef', name: '加牛肉', available: true, stock: 5 },
    // 故意下架：选择它必须使有效库存归零并报 option_unavailable
    { optionId: 'chili-oil', name: '加辣油（已下架）', available: false, stock: null },
  ],
});

export const MERCHANT_NOODLE: MerchantFulfillment = Object.freeze({
  merchantId: 'm-noodle',
  currency: 'CNY',
  minOrderAmountMinor: 2000,
  deliveryRangeMeters: 3000,
  rangeBoundary: 'inclusive',
});

export const MERCHANT_DRINK: MerchantFulfillment = Object.freeze({
  merchantId: 'm-drink',
  currency: 'CNY',
  minOrderAmountMinor: 0,
  deliveryRangeMeters: 500,
  rangeBoundary: 'exclusive',
});

/** 基础面：仅必选辣度，总库存 50，单条上限 10。 */
export const SKU_NOODLE_BASE: DishSku = Object.freeze({
  skuId: 'sku-noodle-base',
  dishId: 'dish-noodle',
  merchantId: 'm-noodle',
  name: '牛肉面（标准）',
  stock: 50,
  maxQuantity: 10,
  minQuantity: 1,
  specGroups: Object.freeze([spicy()]),
});

/** 全规格：辣度（必选单选）+ 份量（可选单选，大份库存 3）+ 加料（多选 0..3）。 */
export const SKU_NOODLE_FULL: DishSku = Object.freeze({
  skuId: 'sku-noodle-full',
  dishId: 'dish-noodle',
  merchantId: 'm-noodle',
  name: '牛肉面（可加料）',
  stock: 50,
  maxQuantity: null,
  minQuantity: 1,
  specGroups: Object.freeze([spicy(), portion(), addons()]),
});

/** 不限量 SKU（stock: null），必选甜度单选。 */
const sugarGroup = (): SkuSpecGroup => ({
  groupId: 'sugar',
  name: '甜度',
  selectionMode: 'single',
  required: true,
  minSelections: 1,
  maxSelections: 1,
  options: [
    { optionId: 'sugar-free', name: '无糖', available: true, stock: null },
    { optionId: 'half', name: '半糖', available: true, stock: null },
  ],
});

export const SKU_DRINK: DishSku = Object.freeze({
  skuId: 'sku-drink',
  dishId: 'dish-drink',
  merchantId: 'm-drink',
  name: '柠檬茶',
  stock: null,
  maxQuantity: 20,
  minQuantity: 1,
  specGroups: Object.freeze([sugarGroup()]),
});

export const FIXTURE_MERCHANTS: readonly MerchantFulfillment[] = Object.freeze([MERCHANT_NOODLE, MERCHANT_DRINK]);

export const FIXTURE_SKUS: readonly DishSku[] = Object.freeze([SKU_NOODLE_BASE, SKU_NOODLE_FULL, SKU_DRINK]);

/** 取 SKU 或抛错（测试辅助）。 */
export function skuById(skuId: string): DishSku {
  const found = FIXTURE_SKUS.find((sku) => sku.skuId === skuId);
  if (found === undefined) throw new Error(`fixture 中没有 SKU ${skuId}`);
  return found;
}
