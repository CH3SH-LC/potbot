/**
 * M03 「未知不补造」：未知字段绝不被默认成「营业中 / 有货 / 可配送 / 0 元起送」。
 *
 * 每个未知都带**原因**；把未知当已知用会被显式拒绝（`CatalogUnknownFieldError`）。
 */

import { describe, expect, it } from 'vitest';

import {
  CatalogUnknownFieldError,
  CatalogValidationError,
  buildMerchant,
  buildSku,
  checkDeliveryRange,
  checkMinOrder,
  evaluateOperatingHours,
  isKnown,
  isUnknown,
  known,
  makeWeekTime,
  mapKnown,
  requireKnown,
  unknown,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { createScenario, standardItems, standardMerchant } from './support.js';

const MON_10AM = makeWeekTime(0, 600);

describe('M03 未知：营业时间未知 ≠ 营业中', () => {
  it('营业时间未知 ⇒ state=unknown（带原因）', () => {
    const merchant = buildMerchant({ merchantId: 'm-unknown', name: '未知小店' });
    expect(isUnknown(merchant.operatingHours)).toBe(true);
    const status = evaluateOperatingHours(merchant.operatingHours, MON_10AM);
    expect(status.state).toBe('unknown');
    expect(status.detail.includes('未知')).toBe(true);
    expect(status.matchedWindow).toBeNull();
  });

  it('对照：营业时间已知时，同一时刻确实判定为营业中', () => {
    const merchant = standardMerchant();
    const status = evaluateOperatingHours(merchant.operatingHours, MON_10AM);
    expect(status.state).toBe('open');
  });
});

describe('M03 未知：配送范围未知 ≠ 可配送；起送未知 ≠ 0 元起送', () => {
  it('范围未知 ⇒ unknown，距离与半径均为 null', () => {
    const merchant = buildMerchant({ merchantId: 'm2', name: 'x' });
    const check = checkDeliveryRange(merchant.deliveryRange, { lat: 31.19, lng: 121.43 });
    expect(check.state).toBe('unknown');
    expect(check.distanceMeters).toBeNull();
    expect(check.radiusMeters).toBeNull();
  });

  it('起送未知 ⇒ unknown，起送金额为 null（不默认 0）', () => {
    const merchant = buildMerchant({ merchantId: 'm3', name: 'x' });
    const check = checkMinOrder(merchant.deliveryRange, 999_999);
    expect(check.state).toBe('unknown');
    expect(check.minOrderMinor).toBeNull();
  });

  it('对照：范围已知时确实判定在范围内/可比较起送', () => {
    const merchant = standardMerchant();
    expect(checkDeliveryRange(merchant.deliveryRange, { lat: 31.19, lng: 121.43 }).state).toBe('within');
    expect(checkMinOrder(merchant.deliveryRange, 2500).state).toBe('meets');
  });
});

describe('M03 未知：库存未知如实保留', () => {
  it('buildSku 默认库存未知，且 requireKnown 显式拒绝当已知用', () => {
    const sku = buildSku({ skuId: 'sku-q', priceMinor: 100 });
    expect(sku.stock.state).toBe('unknown');
    if (isUnknown(sku.stock)) {
      expect(sku.stock.reason.length).toBeGreaterThan(0);
    }
    expect(() => requireKnown(sku.stock, 'sku.stock')).toThrow(CatalogUnknownFieldError);
  });

  it('mapKnown 只映射已知值，未知连同原因原样保留', () => {
    const mapped = mapKnown(unknown('没数据'), (n: number) => n + 1);
    expect(mapped.state).toBe('unknown');
    if (isUnknown(mapped)) expect(mapped.reason).toBe('没数据');

    const mappedKnown = mapKnown(known(1, 'src'), (n: number) => n + 1);
    expect(isKnown(mappedKnown)).toBe(true);
    if (isKnown(mappedKnown)) expect(mappedKnown.value).toBe(2);
  });
});

describe('M03 未知：构造层面就禁止「无来源的已知 / 无原因的未知」', () => {
  it('known() 空 sourceRef ⇒ 抛错', () => {
    expect(() => known(1, '')).toThrow(CatalogValidationError);
  });

  it('unknown() 空原因 ⇒ 抛错', () => {
    expect(() => unknown('   ')).toThrow(CatalogValidationError);
  });

  it('requireKnown 对已知值返回原值', () => {
    expect(requireKnown(known(42, 'src'), 'x')).toBe(42);
  });
});

describe('M03 未知：声明总数未知不猜', () => {
  it('供应方未声明总数 ⇒ 快照 declaredTotal 保持未知', async () => {
    const scenario = createScenario();
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });
    expect(snapshot.declaredTotal.state).toBe('unknown');
  });

  it('供应方声明总数 ⇒ 快照如实取用该值', async () => {
    const scenario = createScenario({
      pages: [{ items: standardItems(), nextCursor: null, declaredTotal: 2 }],
    });
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });
    expect(isKnown(snapshot.declaredTotal)).toBe(true);
    if (isKnown(snapshot.declaredTotal)) expect(snapshot.declaredTotal.value).toBe(2);
  });
});
