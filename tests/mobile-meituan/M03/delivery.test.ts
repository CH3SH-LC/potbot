/**
 * M03 配送范围与起送金额：三态判定，未知绝不默认成「可配送 / 0 元起送」。
 */

import { describe, expect, it } from 'vitest';

import {
  checkDeliveryRange,
  checkMinOrder,
  haversineMeters,
  known,
  unknown,
  type DeliveryRange,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';

const CENTER = { lat: 31.19, lng: 121.43 };

function range(): DeliveryRange {
  return { kind: 'radius', centerLat: CENTER.lat, centerLng: CENTER.lng, radiusMeters: 3000, minOrderMinor: 2000 };
}

describe('M03 距离：haversine 合理性', () => {
  it('同一点距离为 0', () => {
    expect(haversineMeters(CENTER, CENTER)).toBe(0);
  });

  it('纬度相差 1 度约 111 公里', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('非法坐标抛错', () => {
    expect(() => haversineMeters({ lat: 91, lng: 0 }, CENTER)).toThrow();
    expect(() => haversineMeters(CENTER, { lat: 0, lng: 181 })).toThrow();
  });
});

describe('M03 配送范围：三态', () => {
  it('门店中心 ⇒ within', () => {
    const check = checkDeliveryRange(known(range(), 'src'), CENTER);
    expect(check.state).toBe('within');
    expect(check.distanceMeters).toBe(0);
    expect(check.radiusMeters).toBe(3000);
  });

  it('近处（约 1.1 公里）⇒ within', () => {
    const check = checkDeliveryRange(known(range(), 'src'), { lat: 31.20, lng: 121.43 });
    expect(check.state).toBe('within');
  });

  it('远处（约 11 公里）⇒ out_of_range', () => {
    const check = checkDeliveryRange(known(range(), 'src'), { lat: 31.29, lng: 121.43 });
    expect(check.state).toBe('out_of_range');
    expect(check.distanceMeters !== null && check.distanceMeters > 3000).toBe(true);
  });

  it('范围未知 ⇒ unknown，绝不默认可配送', () => {
    const check = checkDeliveryRange(unknown('接口未返回配送范围'), CENTER);
    expect(check.state).toBe('unknown');
    expect(check.distanceMeters).toBeNull();
  });
});

describe('M03 起送金额：三态', () => {
  it('达标 / 未达标 / 未知', () => {
    const r = known(range(), 'src');
    expect(checkMinOrder(r, 2000).state).toBe('meets');
    expect(checkMinOrder(r, 2500).state).toBe('meets');

    const below = checkMinOrder(r, 1500);
    expect(below.state).toBe('below');
    expect(below.shortfallMinor).toBe(500);

    const unk = checkMinOrder(unknown('未提供'), 99999);
    expect(unk.state).toBe('unknown');
    expect(unk.minOrderMinor).toBeNull();
    expect(unk.shortfallMinor).toBeNull();
  });

  it('非法小计金额抛错', () => {
    expect(() => checkMinOrder(known(range(), 'src'), -1)).toThrow();
    expect(() => checkMinOrder(known(range(), 'src'), 1.5)).toThrow();
  });
});
