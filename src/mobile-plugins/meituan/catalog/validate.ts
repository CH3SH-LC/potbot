/**
 * 目录结构的运行时校验 —— 把「未知不补造」「文本不成键」「SKU 规格自洽」变成可失败检查。
 *
 * 端口（真实或 fixture）交回来的每一份商家/菜品/分页都要过这里，任何一条不合法即抛错。
 * 这些检查是**上游出错必须上报**的证据，不是「本地替上游修正」：
 * 校验器从不改写数据，只判定通过与抛出。
 */

import {
  CatalogProvenanceError,
  CatalogSourceError,
  CatalogValidationError,
} from './errors.js';
import { asOpaqueId } from './ids.js';
import { isKnown, type MaybeKnown } from './known.js';
import { assertIntegerInRange, assertSourceRef } from './provenance.js';
import type {
  CatalogItem,
  CatalogMerchant,
  CatalogPage,
  CatalogSku,
  DeliveryRange,
  OperatingWindow,
  SpecGroup,
  StockKind,
} from './types.js';
import type { UntrustedText } from './untrusted.js';

const STOCK_KINDS: readonly StockKind[] = Object.freeze(['in_stock', 'low_stock', 'out_of_stock']);

/** 校验一个金额是合法的整数最小单位（可为负：规格加/减价）。 */
export function assertMinorAmount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new CatalogValidationError(`${label} 必须是整数最小单位，收到 ${String(value)}；金额不得使用浮点`);
  }
  return value;
}

/** 校验非负金额（价格/起送费）。 */
export function assertNonNegativeMinorAmount(value: unknown, label: string): number {
  const amount = assertMinorAmount(value, label);
  if (amount < 0) {
    throw new CatalogValidationError(`${label} 不得为负，收到 ${amount}`);
  }
  return amount;
}

/** 校验不可信文本包装对象。 */
export function assertUntrustedText(value: unknown, label: string): asserts value is UntrustedText {
  if (value === null || typeof value !== 'object') {
    throw new CatalogValidationError(`${label} 必须是 UntrustedText（不可信文本包装）`);
  }
  const text = value as Partial<UntrustedText>;
  if (text.kind !== 'untrusted_text') {
    throw new CatalogValidationError(`${label}.kind 必须是 'untrusted_text'（文本只能作数据）`);
  }
  if (typeof text.raw !== 'string' || typeof text.display !== 'string') {
    throw new CatalogValidationError(`${label} 缺少 raw/display 字符串`);
  }
  if (text.executable !== false) {
    throw new CatalogValidationError(`${label}.executable 必须恒为 false：商家文本绝不是指令`);
  }
  if (!Array.isArray(text.flags)) {
    throw new CatalogValidationError(`${label}.flags 必须是数组`);
  }
}

/** 校验营业时段数组。 */
export function validateOperatingWindows(windows: readonly OperatingWindow[], label: string): void {
  windows.forEach((window, index) => {
    const at = `${label}[${index}]`;
    assertIntegerInRange(window.dayOfWeek, 0, 6, `${at}.dayOfWeek`);
    assertIntegerInRange(window.openMinute, 0, 1439, `${at}.openMinute`);
    assertIntegerInRange(window.closeMinute, 0, 1439, `${at}.closeMinute`);
    if (window.openMinute === window.closeMinute) {
      throw new CatalogValidationError(
        `${at} 开始与结束相同（${window.openMinute}）：含义歧义；不得默认解释为 24 小时营业`,
      );
    }
  });
}

/** 校验配送范围。 */
export function validateDeliveryRange(range: DeliveryRange, label: string): void {
  if (range.kind !== 'radius') {
    throw new CatalogValidationError(`${label}.kind 目前只支持 'radius'，收到 ${String(range.kind)}`);
  }
  if (typeof range.centerLat !== 'number' || !Number.isFinite(range.centerLat) || range.centerLat < -90 || range.centerLat > 90) {
    throw new CatalogValidationError(`${label}.centerLat 必须是 [-90, 90] 的有限数`);
  }
  if (typeof range.centerLng !== 'number' || !Number.isFinite(range.centerLng) || range.centerLng < -180 || range.centerLng > 180) {
    throw new CatalogValidationError(`${label}.centerLng 必须是 [-180, 180] 的有限数`);
  }
  if (typeof range.radiusMeters !== 'number' || !Number.isFinite(range.radiusMeters) || range.radiusMeters <= 0) {
    throw new CatalogValidationError(`${label}.radiusMeters 必须是正的有限数`);
  }
  assertNonNegativeMinorAmount(range.minOrderMinor, `${label}.minOrderMinor`);
}

/** 校验库存。 */
export function validateStock(stock: MaybeKnown<{ kind: StockKind; remaining: number | null }>, label: string): void {
  if (!isKnown(stock)) {
    if (typeof stock.reason !== 'string' || stock.reason.length === 0) {
      throw new CatalogValidationError(`${label} 未知原因不得为空`);
    }
    return;
  }
  const value = stock.value;
  if (!STOCK_KINDS.includes(value.kind)) {
    throw new CatalogValidationError(`${label}.kind 非法：${String(value.kind)}`);
  }
  if (value.remaining !== null) {
    assertIntegerInRange(value.remaining, 0, Number.MAX_SAFE_INTEGER, `${label}.remaining`);
  }
  if (value.kind === 'out_of_stock' && value.remaining !== null && value.remaining !== 0) {
    throw new CatalogValidationError(`${label} 缺货时 remaining 必须为 0 或 null`);
  }
}

/** 校验一个规格组：id 不透明、选项唯一、至少一个选项。 */
export function validateSpecGroup(group: SpecGroup, label: string): void {
  asOpaqueId(group.groupId, `${label}.groupId`);
  assertUntrustedText(group.name, `${label}.name`);
  if (typeof group.required !== 'boolean' || typeof group.multiSelect !== 'boolean') {
    throw new CatalogValidationError(`${label} 的 required/multiSelect 必须是布尔`);
  }
  if (group.options.length === 0) {
    throw new CatalogValidationError(`${label} 没有任何选项`);
  }
  const seen = new Set<string>();
  group.options.forEach((option, index) => {
    const at = `${label}.options[${index}]`;
    asOpaqueId(option.optionId, `${at}.optionId`);
    assertUntrustedText(option.label, `${at}.label`);
    assertMinorAmount(option.priceDeltaMinor, `${at}.priceDeltaMinor`);
    if (seen.has(option.optionId)) {
      throw new CatalogValidationError(`${label} 选项 id 重复：${option.optionId}`);
    }
    seen.add(option.optionId);
  });
}

/** 校验一个 SKU：规格引用必须指向本菜品的组/选项，必选组必须恰好覆盖一次。 */
export function validateSku(sku: CatalogSku, groups: readonly SpecGroup[], label: string): void {
  asOpaqueId(sku.skuId, `${label}.skuId`);
  assertNonNegativeMinorAmount(sku.priceMinor, `${label}.priceMinor`);
  validateStock(sku.stock, `${label}.stock`);

  const groupById = new Map(groups.map((group) => [group.groupId, group]));
  const covered = new Map<string, string>();
  for (const [index, selection] of sku.specSelections.entries()) {
    const at = `${label}.specSelections[${index}]`;
    asOpaqueId(selection.groupId, `${at}.groupId`);
    asOpaqueId(selection.optionId, `${at}.optionId`);
    const group = groupById.get(selection.groupId);
    if (group === undefined) {
      throw new CatalogValidationError(`${at} 引用了本菜品不存在的规格组 ${selection.groupId}`);
    }
    if (covered.has(selection.groupId)) {
      throw new CatalogValidationError(`${at} 重复选择了规格组 ${selection.groupId}`);
    }
    if (!group.options.some((option) => option.optionId === selection.optionId)) {
      throw new CatalogValidationError(`${at} 的选项 ${selection.optionId} 不属于组 ${selection.groupId}`);
    }
    covered.set(selection.groupId, selection.optionId);
  }
  for (const group of groups) {
    if (group.required && !covered.has(group.groupId)) {
      throw new CatalogValidationError(`${label} 缺少必选规格组 ${group.groupId} 的选择`);
    }
  }
}

/** 校验菜品：id 不透明、来源齐备、规格/SKU 自洽。 */
export function validateCatalogItem(item: CatalogItem, label = 'item'): void {
  asOpaqueId(item.itemId, `${label}.itemId`);
  asOpaqueId(item.merchantId, `${label}.merchantId`);
  assertUntrustedText(item.name, `${label}.name`);
  if (item.description !== null) assertUntrustedText(item.description, `${label}.description`);
  assertSourceRef(item.sourceRef, label);

  const groupIds = new Set<string>();
  item.specGroups.forEach((group, index) => {
    validateSpecGroup(group, `${label}.specGroups[${index}]`);
    if (groupIds.has(group.groupId)) {
      throw new CatalogValidationError(`${label} 规格组 id 重复：${group.groupId}`);
    }
    groupIds.add(group.groupId);
  });

  if (item.skus.length === 0) {
    throw new CatalogValidationError(`${label} 没有任何 SKU`);
  }
  const skuIds = new Set<string>();
  item.skus.forEach((sku, index) => {
    validateSku(sku, item.specGroups, `${label}.skus[${index}]`);
    if (skuIds.has(sku.skuId)) {
      throw new CatalogValidationError(`${label} SKU id 重复：${sku.skuId}`);
    }
    skuIds.add(sku.skuId);
  });
}

/** 校验商家。 */
export function validateCatalogMerchant(merchant: CatalogMerchant, label = 'merchant'): void {
  asOpaqueId(merchant.merchantId, `${label}.merchantId`);
  assertUntrustedText(merchant.name, `${label}.name`);
  if (merchant.description !== null) assertUntrustedText(merchant.description, `${label}.description`);
  assertSourceRef(merchant.sourceRef, label);
  if (isKnown(merchant.operatingHours)) {
    if (!Array.isArray(merchant.operatingHours.value)) {
      throw new CatalogValidationError(`${label}.operatingHours 已知值必须是数组`);
    }
    validateOperatingWindows(merchant.operatingHours.value, `${label}.operatingHours`);
  } else if (merchant.operatingHours.reason.length === 0) {
    throw new CatalogValidationError(`${label}.operatingHours 未知原因不得为空`);
  }
  if (isKnown(merchant.deliveryRange)) {
    validateDeliveryRange(merchant.deliveryRange.value, `${label}.deliveryRange`);
  } else if (merchant.deliveryRange.reason.length === 0) {
    throw new CatalogValidationError(`${label}.deliveryRange 未知原因不得为空`);
  }
}

/**
 * 校验分页：页内商家一致、公告总数与页内容不自相矛盾、来源齐备、条目合法。
 * `expectedMerchantId` 用于防止串商家。
 */
export function validateCatalogPage(page: CatalogPage, expectedMerchantId: string, label = 'page'): void {
  if (page.merchantId !== expectedMerchantId) {
    throw new CatalogSourceError(
      `${label} 的 merchantId=${page.merchantId} 与请求的 ${expectedMerchantId} 不符（串商家）`,
    );
  }
  assertSourceRef(page.sourceRef, label);
  if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0) {
    throw new CatalogValidationError(`${label}.pageIndex 必须是非负整数`);
  }
  if (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0)) {
    throw new CatalogValidationError(`${label}.nextCursor 必须是 null 或非空字符串`);
  }
  page.items.forEach((item, index) => {
    validateCatalogItem(item, `${label}.items[${index}]`);
    if (item.merchantId !== expectedMerchantId) {
      throw new CatalogSourceError(`${label}.items[${index}] 属于商家 ${item.merchantId}，不属于 ${expectedMerchantId}`);
    }
  });
  if (isKnown(page.declaredTotal)) {
    assertIntegerInRange(page.declaredTotal.value, 0, Number.MAX_SAFE_INTEGER, `${label}.declaredTotal`);
    if (page.declaredTotal.value < page.items.length) {
      throw new CatalogProvenanceError(
        `${label} 声明总数 ${page.declaredTotal.value} 小于本页条目数 ${page.items.length}（自相矛盾）`,
      );
    }
  } else if (page.declaredTotal.reason.length === 0) {
    throw new CatalogValidationError(`${label}.declaredTotal 未知原因不得为空`);
  }
}

/** 断言来源存在（供服务层在缺少 sourceRef 时抛出定位清晰的错误）。 */
export function requireSourceRef(ref: unknown, label: string): void {
  assertSourceRef(ref, label);
}
