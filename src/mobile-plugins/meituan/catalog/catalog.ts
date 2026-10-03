/**
 * 目录服务 —— 本包对外的**唯一**门面：读商家、翻菜单、判营业、判配送、取菜品。
 *
 * 一切数据都来自注入的 `CatalogPort`，一切时间都来自注入的 `CatalogClock`。
 * 服务层负责把「来源齐备、未知如实、文本不作指令、分页完整」这些纪律**逐一落实**：
 * 每次端口返回都过一遍校验器；未知字段原样保留；本类不提供任何下单/支付入口。
 */

import { CatalogSourceError } from './errors.js';
import { checkDeliveryRange, checkMinOrder, type DeliveryPoint, type MinOrderCheck, type RangeCheck } from './delivery.js';
import { evaluateOperatingHours, type OperatingStatus, type WeekTime } from './hours.js';
import { CatalogPager, type FetchMenuOptions } from './pagination.js';
import type { CatalogClock, CatalogItem, CatalogMerchant, CatalogPort, CatalogSnapshot } from './types.js';
import { validateCatalogItem, validateCatalogMerchant } from './validate.js';

export class CatalogService {
  readonly #port: CatalogPort;
  readonly #clock: CatalogClock;
  readonly #pager: CatalogPager;

  constructor(deps: { port: CatalogPort; clock: CatalogClock }) {
    this.#port = deps.port;
    this.#clock = deps.clock;
    this.#pager = new CatalogPager(deps);
  }

  /** 当前注入时钟的逻辑时间。 */
  now(): number {
    return this.#clock.now();
  }

  /** 读取商家并校验（来源、id、未知原因）。 */
  async loadMerchant(merchantId: string): Promise<CatalogMerchant> {
    const merchant = await this.#port.fetchMerchant(merchantId, this.#clock.now());
    if (merchant === null || typeof merchant !== 'object') {
      throw new CatalogSourceError(`商家 ${merchantId} 的返回不是对象`);
    }
    if (merchant.merchantId !== merchantId) {
      throw new CatalogSourceError(`请求商家 ${merchantId}，端口返回了 ${String(merchant.merchantId)}（串商家）`);
    }
    validateCatalogMerchant(merchant, `merchant[${merchantId}]`);
    return merchant;
  }

  /** 翻完整菜单（或按上限截停，产出 partial 快照）。 */
  async loadMenu(options: FetchMenuOptions): Promise<CatalogSnapshot> {
    return this.#pager.fetchMenu(options);
  }

  /** 从快照里取某道菜；不存在返回 null（不猜、不补造）。 */
  findItem(snapshot: CatalogSnapshot, itemId: string): CatalogItem | null {
    return snapshot.items.find((item) => item.itemId === itemId) ?? null;
  }

  /** 取某道菜；不存在直接抛错（显式失败，不返回编造条目）。 */
  requireItem(snapshot: CatalogSnapshot, itemId: string): CatalogItem {
    const item = this.findItem(snapshot, itemId);
    if (item === null) {
      throw new CatalogSourceError(`菜品 ${itemId} 不在本次菜单快照中；不得补造`);
    }
    validateCatalogItem(item, `item[${itemId}]`);
    return item;
  }

  /** 判定商家在给定时刻的营业状态。 */
  operatingStatusOf(merchant: CatalogMerchant, at: WeekTime): OperatingStatus {
    return evaluateOperatingHours(merchant.operatingHours, at);
  }

  /** 判定某收货点是否在配送范围内。 */
  deliveryRangeOf(merchant: CatalogMerchant, point: DeliveryPoint): RangeCheck {
    return checkDeliveryRange(merchant.deliveryRange, point);
  }

  /** 判定金额是否达到起送门槛。 */
  minOrderOf(merchant: CatalogMerchant, subtotalMinor: number): MinOrderCheck {
    return checkMinOrder(merchant.deliveryRange, subtotalMinor);
  }
}
