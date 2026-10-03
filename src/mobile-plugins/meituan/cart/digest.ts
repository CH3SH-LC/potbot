/**
 * 参数指纹（`paramsDigest`）——「报价是否过期/是否还配得上当前购物车」的唯一判据。
 *
 * ## 为什么需要它
 *
 * M04 的核心价值是**旧报价不能静默沿用**。做法不是逐字段比较（漏一个字段就漏一种
 * 失效场景），而是把**全部影响计价的参数**拍成一个规范化快照，再算指纹：
 * 只要快照里任何一项变了，指纹就变，旧报价立刻对不上。
 *
 * 快照覆盖（与工作书的失效清单一一对应）：
 * - 条目增删 ⇒ `lines`
 * - 数量、规格 ⇒ `lines` 内的 `quantity` / `specs`
 * - 配送地址 ⇒ `delivery.addressRef`
 * - 费用/优惠 ⇒ `pricing.couponCodes` / `pricing.serviceOptions`
 * - 币种、商家 ⇒ `currency` / `merchantId`
 *
 * ## 口径说明
 *
 * - 指纹是**结构指纹**（FNV-1a 32 位），用于一致性判定，**不是**密码学摘要，
 *   不用于任何安全用途。
 * - 条目按**内容**排序后再入摘要 ⇒ 指纹与加入顺序、条目 id 无关：
 *   两份内容相同的购物车，即使在两个会话里以不同顺序组装，指纹也相同。
 * - 本模块是纯函数，不读时钟、不读随机数、不读环境。
 */

import { specsKey } from './specs.js';
import type { QuoteParamsSnapshot, QuoteRequestLine } from './types.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32 位散列（小写 8 位十六进制）。结构指纹，非密码学摘要。 */
export function fnv1a32Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 单条目的内容键（用于「同规格合并」判定与摘要内的条目排序）。 */
export function lineContentKey(line: QuoteRequestLine): string {
  return `${line.dishId}|${line.skuId}|${specsKey(line.specs)}`;
}

function lineCanonical(line: QuoteRequestLine): string {
  return JSON.stringify([line.dishId, line.skuId, specsKey(line.specs), line.quantity]);
}

/** 快照的规范载荷（纯文本、可重现、与对象键序无关）。 */
export function canonicalDigestPayload(snapshot: QuoteParamsSnapshot): string {
  const lines = snapshot.lines.map(lineCanonical);
  lines.sort();
  return JSON.stringify({
    v: 1,
    merchantId: snapshot.merchantId,
    currency: snapshot.currency,
    addressRef: snapshot.delivery === null ? null : snapshot.delivery.addressRef,
    couponCodes: [...snapshot.pricing.couponCodes].sort(),
    serviceOptions: [...snapshot.pricing.serviceOptions].sort(),
    lines,
  });
}

/** 计算参数指纹。前缀 `v1-` 便于将来换算法时区分。 */
export function computeParamsDigest(snapshot: QuoteParamsSnapshot): string {
  return `v1-${fnv1a32Hex(canonicalDigestPayload(snapshot))}`;
}
