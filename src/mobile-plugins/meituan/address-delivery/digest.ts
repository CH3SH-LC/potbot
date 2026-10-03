/**
 * 地址内容指纹 —— 「地址版本是否变了」的判据。
 *
 * 复用 M04 的 `paramsDigest` 思路与其 FNV-1a 实现（`../cart/digest.js`）：
 * 不逐字段做「哪一项变了」的补丁式比较，而是把**全部投递相关字段**拍成
 * 一个规范化载荷后算指纹。载荷里任何一项变了，指纹就变。
 *
 * 与 M04 的差异：这里把 `version` 也放进引用（`ref`），因此**版本变化**与
 * **内容变化**都能被看见——即使某种改动恰好没进内容指纹，引用也会变。
 *
 * 口径：FNV-1a 32 位是**结构指纹**，用于一致性判定，不是密码学摘要。
 */

import { fnv1a32Hex } from '../cart/digest.js';

import type { AddressSource, DeliveryPlanInput } from './types.js';

/** 参与内容指纹的字段集合（全部投递相关字段）。 */
export interface AddressContentInput {
  readonly label: string;
  readonly contactName: string;
  readonly phone: string;
  readonly region: string;
  readonly detail: string;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly source: AddressSource;
}

/** 内容指纹的规范载荷（纯文本、可重现、与对象键序无关）。 */
export function canonicalAddressPayload(address: AddressContentInput): string {
  return JSON.stringify([
    address.label,
    address.contactName,
    address.phone,
    address.region,
    address.detail,
    address.lat === null ? null : address.lat,
    address.lng === null ? null : address.lng,
    address.source,
  ]);
}

/** 计算地址内容指纹。前缀 `av1-`（address v1）便于将来换算法时区分。 */
export function computeAddressContentDigest(address: AddressContentInput): string {
  return `av1-${fnv1a32Hex(canonicalAddressPayload(address))}`;
}

/** 构造交给 M04 的配送引用：地址 id + 版本。版本一变，引用必变。 */
export function makeAddressRef(addressId: string, version: number): string {
  return `${addressId}#v${version}`;
}

/** 解析引用为 `{ addressId, version }`；形状不符返回 `null`（不猜测）。 */
export function parseAddressRef(ref: string): { readonly addressId: string; readonly version: number } | null {
  const marker = '#v';
  const at = ref.lastIndexOf(marker);
  if (at <= 0) return null;
  const addressId = ref.slice(0, at);
  const rawVersion = ref.slice(at + marker.length);
  if (!/^\d+$/.test(rawVersion)) return null;
  const version = Number.parseInt(rawVersion, 10);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { addressId, version };
}

/**
 * 配送方案（地址 + 时段 + 过期点）的规范载荷。
 *
 * 三要素**全部**入载荷：地址引用（含版本）、选中时段 id、时段过期点。任一变化
 * ⇒ 载荷变 ⇒ 指纹变。`JSON.stringify` 对数组与对象键序无关，可重现。
 */
export function canonicalDeliveryPlanPayload(plan: DeliveryPlanInput): string {
  return JSON.stringify([plan.addressRef, plan.slotId, plan.slotExpiresAt]);
}

/**
 * 计算配送方案指纹，即绑定的 `planRef`。前缀 `dp1-`（delivery plan v1）。
 *
 * 假定 `slotExpiresAt` 是有限数（由 `createDeliveryPlan` 校验）：`JSON.stringify`
 * 会把 `NaN` / `Infinity` 写成 `null`，这里不静默容忍，故构造入口负责拒绝。
 */
export function computeDeliveryPlanDigest(plan: DeliveryPlanInput): string {
  return `dp1-${fnv1a32Hex(canonicalDeliveryPlanPayload(plan))}`;
}
