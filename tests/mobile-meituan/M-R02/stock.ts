/**
 * M-R02 —— 库存与数量校验。
 *
 * 有效库存的定义：
 *   `effectiveStock = min( SKU 总库存, 各已选选项库存 )`，`null` 表示不参与限制。
 * - SKU 总库存或任一已选选项库存为 `null` ⇒ 该项不限制；
 * - 所有参与项都为 `null` ⇒ 有效库存为 `null`（不限量）；
 * - 任一已选选项 `available=false` ⇒ 有效库存为 `0`（下架选项 = 无法下单）。
 *
 * 数量规则：必须是正整数；不得低于 `minQuantity`（默认 1）；不得高于 `maxQuantity`；
 * 不得高于有效库存。
 *
 * 引用了不存在规格组/选项的调用是**调用方错误**：抛 `CatalogValidationError`，
 * 不做静默兜底（请先跑 `validateSpecSelection`）。
 */

import { CatalogValidationError } from './errors.js';
import type { CatalogIssue, DishSku, SpecSelection } from './types.js';

function lookups(sku: DishSku) {
  const groups = new Map<string, { options: Map<string, { available: boolean; stock: number | null }> }>();
  for (const group of sku.specGroups) {
    const options = new Map<string, { available: boolean; stock: number | null }>();
    for (const option of group.options) {
      options.set(option.optionId, { available: option.available, stock: option.stock });
    }
    groups.set(group.groupId, { options });
  }
  return groups;
}

/**
 * 当前规格下的有效库存。`null` = 不限量；`0` = 不可下单（下架或库存售罄）。
 */
export function effectiveStock(sku: DishSku, selections: readonly SpecSelection[] = []): number | null {
  const groups = lookups(sku);
  const candidates: number[] = [];
  if (sku.stock !== null) {
    if (!Number.isInteger(sku.stock) || sku.stock < 0) {
      throw new CatalogValidationError(`SKU ${sku.skuId} 的 stock 必须是非负整数或 null`);
    }
    candidates.push(sku.stock);
  }
  for (const selection of selections) {
    const group = groups.get(selection.groupId);
    const option = group?.options.get(selection.optionId);
    if (group === undefined || option === undefined) {
      throw new CatalogValidationError(
        `SKU ${sku.skuId} 不存在规格 ${selection.groupId}=${selection.optionId}；请先校验规格`,
      );
    }
    if (!option.available) return 0;
    if (option.stock !== null) {
      if (!Number.isInteger(option.stock) || option.stock < 0) {
        throw new CatalogValidationError(`选项 ${selection.groupId}=${selection.optionId} 的 stock 非法`);
      }
      candidates.push(option.stock);
    }
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/**
 * 数量校验。返回问题列表（空 = 通过）。数量不是有效正整数时只报这一条。
 */
export function checkLineQuantity(
  sku: DishSku,
  selections: readonly SpecSelection[],
  quantity: number,
): readonly CatalogIssue[] {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return Object.freeze([
      {
        code: 'not_positive_integer' as const,
        message: `数量必须是正整数，实际 ${String(quantity)}`,
        actual: quantity,
      },
    ]);
  }
  const issues: CatalogIssue[] = [];
  const available = effectiveStock(sku, selections);
  if (available !== null && quantity > available) {
    issues.push({
      code: 'insufficient_stock',
      message: `库存不足：需要 ${quantity}，可用 ${available}`,
      limit: available,
      actual: quantity,
    });
  }
  const minQuantity = Number.isInteger(sku.minQuantity) && sku.minQuantity > 0 ? sku.minQuantity : 1;
  if (quantity < minQuantity) {
    issues.push({
      code: 'below_min_quantity',
      message: `数量不得低于 ${minQuantity}，实际 ${quantity}`,
      limit: minQuantity,
      actual: quantity,
    });
  }
  if (sku.maxQuantity !== null) {
    if (!Number.isInteger(sku.maxQuantity) || sku.maxQuantity <= 0) {
      throw new CatalogValidationError(`SKU ${sku.skuId} 的 maxQuantity 必须是正整数或 null`);
    }
    if (quantity > sku.maxQuantity) {
      issues.push({
        code: 'above_max_quantity',
        message: `数量不得超过 ${sku.maxQuantity}，实际 ${quantity}`,
        limit: sku.maxQuantity,
        actual: quantity,
      });
    }
  }
  return Object.freeze(issues);
}

/**
 * 当前规格下最多可加的数量（供步进器上限）。
 *
 * - 返回 `0`：任一已选选项下架，或有效库存不足以满足 `minQuantity`；
 * - 返回 `null`：不限量且无单条上限；
 * - 否则为各有限上界（有效库存、`maxQuantity`）的最小值。
 */
export function maxAddableQuantity(sku: DishSku, selections: readonly SpecSelection[] = []): number | null {
  const available = effectiveStock(sku, selections);
  const minQuantity = Number.isInteger(sku.minQuantity) && sku.minQuantity > 0 ? sku.minQuantity : 1;
  if (available === 0) return 0;
  if (available !== null && available < minQuantity) return 0;
  const bounds: number[] = [];
  if (available !== null) bounds.push(available);
  if (sku.maxQuantity !== null) bounds.push(sku.maxQuantity);
  if (bounds.length === 0) return null;
  return Math.min(...bounds);
}
