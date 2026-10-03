/**
 * M-R02 —— 单条预检（规格 + 数量/库存合成一次判定）。
 *
 * 顺序固定：先跑规格校验，再把数量校验附在后面（规格不满足时数量问题仍照常报告，
 * 让用户一次看到全部要改的地方）。`ok` 为真当且仅当两段都无问题。
 */

import { validateSpecSelection } from './specs.js';
import { checkLineQuantity, effectiveStock, maxAddableQuantity } from './stock.js';
import type { CatalogIssue, LinePreflightRequest, LinePreflightResult } from './types.js';

export function preflightLine(request: LinePreflightRequest): LinePreflightResult {
  const specResult = validateSpecSelection(request.sku, request.selections);
  const quantityIssues = checkLineQuantity(request.sku, request.selections, request.quantity);
  const issues: readonly CatalogIssue[] = Object.freeze([...specResult.issues, ...quantityIssues]);
  return Object.freeze({
    ok: specResult.ok && quantityIssues.length === 0,
    issues,
    maxAddableQuantity: maxAddableQuantity(request.sku, request.selections),
    availableQuantity: effectiveStock(request.sku, request.selections),
  });
}

/** 便捷布尔：本条能否加入购物车（规格满足且数量可用）。 */
export function canAddLine(request: LinePreflightRequest): boolean {
  return preflightLine(request).ok;
}
