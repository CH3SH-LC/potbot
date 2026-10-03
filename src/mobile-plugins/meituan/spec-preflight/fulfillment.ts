/**
 * M-R02 —— 起送金额与配送范围边界。
 *
 * ## 起送金额
 * `subtotalMinor >= minOrderAmountMinor` 为达成（**含等号**）。不足时返回确切差额
 * `shortfallMinor = minOrderAmountMinor - subtotalMinor`；已达成时为 0。
 *
 * ## 配送范围
 * - `rangeBoundary = 'inclusive'`（默认）：`distance <= range` 在范围内；
 * - `rangeBoundary = 'exclusive'`：`distance < range` 在范围内。
 *
 * 负数金额 / 负数距离 / 非有限数是**非法入参**，抛 `CatalogValidationError`——
 * 绝不能把负数距离当成「在范围内」。
 */

import { CatalogValidationError } from './errors.js';
import type { CatalogIssue, MerchantFulfillment } from './types.js';

function requireNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CatalogValidationError(`${label} 必须是非负整数，实际 ${String(value)}`);
  }
}

function requireNonNegativeFinite(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CatalogValidationError(`${label} 必须是非负有限数，实际 ${String(value)}`);
  }
}

/** 起送金额校验。返回问题列表（空 = 达成）。 */
export function checkMinOrderAmount(
  fulfillment: MerchantFulfillment,
  subtotalMinor: number,
): readonly CatalogIssue[] {
  requireNonNegativeInt(subtotalMinor, 'subtotalMinor');
  requireNonNegativeInt(fulfillment.minOrderAmountMinor, 'minOrderAmountMinor');
  if (subtotalMinor >= fulfillment.minOrderAmountMinor) return Object.freeze([]);
  return Object.freeze([
    {
      code: 'below_min_order' as const,
      message: `未达起送金额 ${fulfillment.minOrderAmountMinor}（${fulfillment.currency}），当前 ${subtotalMinor}`,
      limit: fulfillment.minOrderAmountMinor,
      actual: subtotalMinor,
    },
  ]);
}

/** 距起送金额还差多少（已达成 = 0）。 */
export function minOrderShortfall(fulfillment: MerchantFulfillment, subtotalMinor: number): number {
  requireNonNegativeInt(subtotalMinor, 'subtotalMinor');
  requireNonNegativeInt(fulfillment.minOrderAmountMinor, 'minOrderAmountMinor');
  return Math.max(0, fulfillment.minOrderAmountMinor - subtotalMinor);
}

/** 配送范围校验。返回问题列表（空 = 在范围内）。 */
export function checkDeliveryRange(
  fulfillment: MerchantFulfillment,
  distanceMeters: number,
): readonly CatalogIssue[] {
  requireNonNegativeFinite(distanceMeters, 'distanceMeters');
  requireNonNegativeFinite(fulfillment.deliveryRangeMeters, 'deliveryRangeMeters');
  const inside =
    fulfillment.rangeBoundary === 'inclusive'
      ? distanceMeters <= fulfillment.deliveryRangeMeters
      : distanceMeters < fulfillment.deliveryRangeMeters;
  if (inside) return Object.freeze([]);
  return Object.freeze([
    {
      code: 'out_of_range' as const,
      message: `超出配送范围 ${fulfillment.deliveryRangeMeters} 米，实际 ${distanceMeters} 米`,
      limit: fulfillment.deliveryRangeMeters,
      actual: distanceMeters,
    },
  ]);
}

/**
 * 商家履约预检：把小计与距离两件事合成一次判定。
 * `ok` 为真当且仅当起送与范围都满足。
 */
export function preflightMerchant(params: {
  readonly fulfillment: MerchantFulfillment;
  readonly subtotalMinor: number;
  readonly distanceMeters: number;
}): {
  readonly ok: boolean;
  readonly issues: readonly CatalogIssue[];
  readonly shortfallMinor: number;
  readonly inRange: boolean;
} {
  const issues: CatalogIssue[] = [];
  issues.push(...checkMinOrderAmount(params.fulfillment, params.subtotalMinor));
  issues.push(...checkDeliveryRange(params.fulfillment, params.distanceMeters));
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    shortfallMinor: minOrderShortfall(params.fulfillment, params.subtotalMinor),
    inRange: checkDeliveryRange(params.fulfillment, params.distanceMeters).length === 0,
  });
}
