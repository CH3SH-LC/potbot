/**
 * 配送范围与起送金额判定 —— 未知绝不等于「可配送」。
 *
 * 工作书 M03 要求覆盖「配送范围」。本模块把两类判定都做成**三态**：
 * - 范围：`within` / `out_of_range` / `unknown`；
 * - 起送：`meets` / `below` / `unknown`。
 *
 * 关键：配送范围未知时，结论只能是 `unknown`，**绝不**默认成「在范围内」；
 * 起送金额未知时也**绝不**默认成 0 元起送。距离用 haversine（米），仅用于比较半径，
 * 不参与任何计价。
 */

import { CatalogValidationError } from './errors.js';
import { isKnown, type MaybeKnown } from './known.js';
import { validateDeliveryRange } from './validate.js';
import type { DeliveryRange } from './types.js';

const EARTH_RADIUS_METERS = 6_371_000;

/** 经纬度点。 */
export interface DeliveryPoint {
  readonly lat: number;
  readonly lng: number;
}

function assertPoint(point: DeliveryPoint, label: string): void {
  if (typeof point.lat !== 'number' || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new CatalogValidationError(`${label}.lat 必须是 [-90, 90] 的有限数`);
  }
  if (typeof point.lng !== 'number' || !Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) {
    throw new CatalogValidationError(`${label}.lng 必须是 [-180, 180] 的有限数`);
  }
}

/** 球面距离（米）。 */
export function haversineMeters(a: DeliveryPoint, b: DeliveryPoint): number {
  assertPoint(a, 'a');
  assertPoint(b, 'b');
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 范围判定状态。 */
export type RangeState = 'within' | 'out_of_range' | 'unknown';

export interface RangeCheck {
  readonly state: RangeState;
  /** 点到门店中心的距离（米）；未知时为 null。 */
  readonly distanceMeters: number | null;
  /** 半径（米）；未知时为 null。 */
  readonly radiusMeters: number | null;
  readonly detail: string;
}

/** 起送判定状态。 */
export type MinOrderState = 'meets' | 'below' | 'unknown';

export interface MinOrderCheck {
  readonly state: MinOrderState;
  /** 起送金额（整数最小单位）；未知时为 null。 */
  readonly minOrderMinor: number | null;
  /** 差额（还差多少，整数最小单位）；不适用时为 null。 */
  readonly shortfallMinor: number | null;
  readonly detail: string;
}

/**
 * 判定某点是否在配送范围内。
 * 范围未知 ⇒ `unknown`（带原因），**不**默认「可配送」。
 */
export function checkDeliveryRange(range: MaybeKnown<DeliveryRange>, point: DeliveryPoint): RangeCheck {
  if (!isKnown(range)) {
    return Object.freeze({
      state: 'unknown',
      distanceMeters: null,
      radiusMeters: null,
      detail: `配送范围未知（${range.reason}）；不得默认按可配送处理`,
    });
  }
  validateDeliveryRange(range.value, 'deliveryRange');
  const distance = haversineMeters({ lat: range.value.centerLat, lng: range.value.centerLng }, point);
  if (distance <= range.value.radiusMeters) {
    return Object.freeze({
      state: 'within',
      distanceMeters: distance,
      radiusMeters: range.value.radiusMeters,
      detail: `距离约 ${distance.toFixed(0)} 米，在 ${range.value.radiusMeters} 米配送范围内`,
    });
  }
  return Object.freeze({
    state: 'out_of_range',
    distanceMeters: distance,
    radiusMeters: range.value.radiusMeters,
    detail: `距离约 ${distance.toFixed(0)} 米，超出 ${range.value.radiusMeters} 米配送范围`,
  });
}

/**
 * 判定金额是否达到起送门槛。
 * 范围/金额未知 ⇒ `unknown`，**不**默认 0 元起送。
 */
export function checkMinOrder(range: MaybeKnown<DeliveryRange>, subtotalMinor: number): MinOrderCheck {
  if (typeof subtotalMinor !== 'number' || !Number.isInteger(subtotalMinor) || subtotalMinor < 0) {
    throw new CatalogValidationError(`subtotalMinor 必须是非负整数最小单位，收到 ${String(subtotalMinor)}`);
  }
  if (!isKnown(range)) {
    return Object.freeze({
      state: 'unknown',
      minOrderMinor: null,
      shortfallMinor: null,
      detail: `起送金额未知（${range.reason}）；不得默认按 0 元起送处理`,
    });
  }
  validateDeliveryRange(range.value, 'deliveryRange');
  const min = range.value.minOrderMinor;
  if (subtotalMinor >= min) {
    return Object.freeze({
      state: 'meets',
      minOrderMinor: min,
      shortfallMinor: 0,
      detail: `已达起送金额 ${min}（整数最小单位）`,
    });
  }
  return Object.freeze({
    state: 'below',
    minOrderMinor: min,
    shortfallMinor: min - subtotalMinor,
    detail: `未达起送金额 ${min}，还差 ${min - subtotalMinor}（整数最小单位）`,
  });
}
