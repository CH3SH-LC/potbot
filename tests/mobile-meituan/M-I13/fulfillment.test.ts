/**
 * M-I13 —— 生产模块起送金额与配送范围边界（重点打边界点）。
 * **import 生产路径**。
 */

import { describe, expect, it } from 'vitest';

import {
  CatalogValidationError,
  checkDeliveryRange,
  checkMinOrderAmount,
  minOrderShortfall,
  preflightMerchant,
} from '../../../src/mobile-plugins/meituan/spec-preflight/index.js';
import { MERCHANT_DRINK, MERCHANT_NOODLE } from './fixture.js';
import { issueWithCode } from './support.js';

describe('M-I13 生产起送金额边界（含等号）', () => {
  it('小计 == 起送金额 ⇒ 达成（等号在范围内）', () => {
    expect(checkMinOrderAmount(MERCHANT_NOODLE, 2000)).toEqual([]);
  });

  it('小计 == 起送金额 - 1 ⇒ below_min_order，limit=2000，actual=1999', () => {
    const issues = checkMinOrderAmount(MERCHANT_NOODLE, 1999);
    const issue = issueWithCode(issues, 'below_min_order');
    expect(issue.limit).toBe(2000);
    expect(issue.actual).toBe(1999);
  });

  it('小计高于起送金额 ⇒ 达成', () => {
    expect(checkMinOrderAmount(MERCHANT_NOODLE, 99999)).toEqual([]);
  });

  it('起送金额为 0（无门槛）⇒ 小计 0 也达成', () => {
    expect(checkMinOrderAmount(MERCHANT_DRINK, 0)).toEqual([]);
  });

  it('差额：1999 → 1；0 → 2000；已达成 → 0', () => {
    expect(minOrderShortfall(MERCHANT_NOODLE, 1999)).toBe(1);
    expect(minOrderShortfall(MERCHANT_NOODLE, 0)).toBe(2000);
    expect(minOrderShortfall(MERCHANT_NOODLE, 5000)).toBe(0);
  });

  it('负数小计是非法入参 ⇒ 抛错（不静默当 0）', () => {
    expect(() => checkMinOrderAmount(MERCHANT_NOODLE, -1)).toThrow(CatalogValidationError);
    expect(() => minOrderShortfall(MERCHANT_NOODLE, -5)).toThrow(CatalogValidationError);
  });

  it('非整数小计（分）是非法入参 ⇒ 抛错', () => {
    expect(() => checkMinOrderAmount(MERCHANT_NOODLE, 19.99)).toThrow(CatalogValidationError);
  });
});

describe('M-I13 生产配送范围边界（闭区间）', () => {
  it('闭区间：距离 == 半径 ⇒ 在范围内', () => {
    expect(checkDeliveryRange(MERCHANT_NOODLE, 3000)).toEqual([]);
  });

  it('闭区间：距离 == 半径 + 1 ⇒ out_of_range', () => {
    const issues = checkDeliveryRange(MERCHANT_NOODLE, 3001);
    const issue = issueWithCode(issues, 'out_of_range');
    expect(issue.limit).toBe(3000);
    expect(issue.actual).toBe(3001);
  });

  it('闭区间：距离 == 半径 - 1 ⇒ 在范围内', () => {
    expect(checkDeliveryRange(MERCHANT_NOODLE, 2999)).toEqual([]);
  });

  it('距离 0 ⇒ 在范围内', () => {
    expect(checkDeliveryRange(MERCHANT_NOODLE, 0)).toEqual([]);
  });
});

describe('M-I13 生产配送范围边界（开区间）', () => {
  it('开区间：距离 == 半径（恰好 500）⇒ out_of_range', () => {
    expect(checkDeliveryRange(MERCHANT_DRINK, 500)).toHaveLength(1);
  });

  it('开区间：距离 == 半径 - 1 ⇒ 在范围内', () => {
    expect(checkDeliveryRange(MERCHANT_DRINK, 499)).toEqual([]);
  });
});

describe('M-I13 生产配送范围非法入参', () => {
  it('负数距离 ⇒ 抛错（绝不能当成在范围内）', () => {
    expect(() => checkDeliveryRange(MERCHANT_NOODLE, -1)).toThrow(CatalogValidationError);
  });

  it('NaN / Infinity ⇒ 抛错', () => {
    expect(() => checkDeliveryRange(MERCHANT_NOODLE, Number.NaN)).toThrow(CatalogValidationError);
    expect(() => checkDeliveryRange(MERCHANT_NOODLE, Number.POSITIVE_INFINITY)).toThrow(CatalogValidationError);
  });
});

describe('M-I13 生产商家履约预检（合成）', () => {
  it('金额与范围都满足 ⇒ ok=true、issues 空、shortfall=0、inRange=true', () => {
    const result = preflightMerchant({ fulfillment: MERCHANT_NOODLE, subtotalMinor: 2000, distanceMeters: 3000 });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.shortfallMinor).toBe(0);
    expect(result.inRange).toBe(true);
  });

  it('金额不足且超范围 ⇒ 两条问题同时报告，shortfall 给出差额', () => {
    const result = preflightMerchant({ fulfillment: MERCHANT_NOODLE, subtotalMinor: 1500, distanceMeters: 4000 });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual(['below_min_order', 'out_of_range']);
    expect(result.shortfallMinor).toBe(500);
    expect(result.inRange).toBe(false);
  });

  it('金额刚好但距离超 ⇒ ok=false 但 shortfall=0', () => {
    const result = preflightMerchant({ fulfillment: MERCHANT_NOODLE, subtotalMinor: 2000, distanceMeters: 3001 });
    expect(result.ok).toBe(false);
    expect(result.shortfallMinor).toBe(0);
    expect(result.issues.map((issue) => issue.code)).toEqual(['out_of_range']);
  });
});
