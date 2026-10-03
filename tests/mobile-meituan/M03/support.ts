/**
 * M03 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景都由**显式 fixture** 驱动：可控时钟 + 确定性目录端口 + 结构化构造器。
 * 这里没有真实美团接口、没有网络、没有系统时间。
 * 未知字段一律显式标未知，fixture 不替测试「补全」。
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
  unknown,
  type CatalogItem,
  type CatalogMerchant,
  type CatalogPort,
  type FixtureCatalogConfig,
  type FixtureCatalogPort,
  type SpecGroup,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 1_600_000_000_000;

export const MERCHANT_ID = 'merchant-1';

/** 标准规格组：辣度，必选、单选。 */
export function spiceGroup(): SpecGroup {
  return buildSpecGroup({
    groupId: 'spice',
    name: '辣度',
    required: true,
    options: [buildOption('mild', '微辣', 0), buildOption('hot', '特辣', 200)],
  });
}

/** 标准两份菜品：牛肉面（带辣度规格）+ 冰红茶（无规格）。 */
export function standardItems(merchantId = MERCHANT_ID): readonly CatalogItem[] {
  const noodle = buildItem({
    itemId: 'dish-noodle',
    merchantId,
    name: '牛肉面',
    description: '招牌牛肉面',
    specGroups: [spiceGroup()],
    skus: [
      buildSku({
        skuId: 'sku-noodle-mild',
        priceMinor: 3800,
        specSelections: [{ groupId: 'spice', optionId: 'mild' }],
        stock: known({ kind: 'in_stock', remaining: 5 }, 'fixture-stock'),
      }),
      buildSku({
        skuId: 'sku-noodle-hot',
        priceMinor: 4000,
        specSelections: [{ groupId: 'spice', optionId: 'hot' }],
        stock: known({ kind: 'in_stock', remaining: 5 }, 'fixture-stock'),
      }),
    ],
  });
  const tea = buildItem({
    itemId: 'dish-tea',
    merchantId,
    name: '冰红茶',
    skus: [buildSku({ skuId: 'sku-tea', priceMinor: 800 })],
  });
  return Object.freeze([noodle, tea]);
}

/** 标准商家：营业 + 配送范围已知。 */
export function standardMerchant(merchantId = MERCHANT_ID): CatalogMerchant {
  return buildMerchant({
    merchantId,
    name: '示例小吃店',
    description: '一家测试用的小店',
    operatingHours: known(
      [
        { dayOfWeek: 0, openMinute: 600, closeMinute: 1320 },
        { dayOfWeek: 5, openMinute: 1320, closeMinute: 120 },
      ],
      'fixture-hours',
    ),
    deliveryRange: known(
      { kind: 'radius', centerLat: 31.19, centerLng: 121.43, radiusMeters: 3000, minOrderMinor: 2000 },
      'fixture-range',
    ),
  });
}

export interface Scenario {
  readonly service: CatalogService;
  readonly port: FixtureCatalogPort;
  readonly clock: FixtureCatalogClock;
  readonly merchant: CatalogMerchant;
}

/** 造一个完整场景：给 pages 即回放给定分页，缺省为「两页各一份菜」。 */
export function createScenario(
  config: Partial<Omit<FixtureCatalogConfig, 'merchant'>> & { readonly merchant?: CatalogMerchant } = {},
): Scenario {
  const clock = new FixtureCatalogClock(T0);
  const merchant = config.merchant ?? standardMerchant();
  const items = standardItems(merchant.merchantId);
  const port = createFixtureCatalogPort({
    merchant,
    pages: config.pages ?? [{ items: [items[0]!] }, { items: [items[1]!] }],
    ...(config.tamperPage === undefined ? {} : { tamperPage: config.tamperPage }),
    ...(config.tamperMerchant === undefined ? {} : { tamperMerchant: config.tamperMerchant }),
  });
  const service = new CatalogService({ port, clock });
  return { service, port, clock, merchant };
}

/** 单页（末页）配置构造小工具。 */
export function singlePage(items: readonly CatalogItem[], declaredTotal?: number | null) {
  return [
    {
      items,
      nextCursor: null,
      ...(declaredTotal === undefined ? {} : { declaredTotal }),
    },
  ];
}

export { createFixtureCatalogPort, CatalogService, unknown, known };
export type { CatalogPort };
