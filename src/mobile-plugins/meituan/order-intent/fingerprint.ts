/**
 * M-I18 落盘意图指纹（确定性、零依赖、无系统时钟 / 无随机）。
 *
 * ## 它是什么、不是什么（如实说明强度）
 *
 * 这是一个**非密钥**的确定性校验和，用途只有一个：在恢复时发现落盘字节被
 * **意外损坏**或**朴素编辑**（例如有人把 `amountMinor` +1、把 `externalId`
 * 换成另一单，却没同步改指纹）。
 *
 * 它**不是** MAC、不是签名：一个能完整重写快照的攻击者可以重算指纹，因此本指纹
 * **不能**在敌手面前保护意图的完整性。真正的权威核验在 M09：恢复后调用方
 * `resumeAfterDisconnect(port)` **重新查原单**，用平台回执与本地意图逐项比对——
 * 那一步才决定「这一单到底是不是我们的、金额对不对」。
 *
 * ## 全部字段都进指纹
 *
 * 五个意图字段 + `subjectRef` + 版本 + 判别值都参与，且每个字段用**长度前缀**
 * 编码（`标签:长度:值;`），保证拼接结果对字段边界无歧义（例如
 * `("ab","c")` 与 `("a","bc")` 编码不同）。
 */

import { PERSISTED_ORDER_INTENT_KIND, PERSISTED_ORDER_INTENT_VERSION } from './types.js';
import type { OrderIntent } from '../order-lifecycle/index.js';

/** FNV-1a 32 位（UTF-16 码元逐位），无 BigInt / 无依赖。 */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // Math.imul 保持 32 位乘法语义，结果稳定且不依赖宿主大整数实现。
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 长度前缀编码，令拼接对字段边界无歧义。 */
function tagged(label: string, value: string): string {
  return `${label}:${value.length}:${value};`;
}

/** 指纹输入的字段子集（`intent` 五字段 + `subjectRef`）。 */
export interface OrderIntentIntegrityInput {
  readonly intent: OrderIntent;
  readonly subjectRef: string;
}

/** 由五字段 + `subjectRef` 计算确定性指纹，形如 `oi1-xxxxxxxxxxxxxxxx`。 */
export function computeOrderIntentIntegrityRef(input: OrderIntentIntegrityInput): string {
  const intent = input.intent;
  const canonical = [
    tagged('v', String(PERSISTED_ORDER_INTENT_VERSION)),
    tagged('k', PERSISTED_ORDER_INTENT_KIND),
    tagged('r', intent.orderIntentRef),
    // externalId 允许为 null：用**不同的标签**编码 null 与字符串，二者不会撞车。
    intent.externalId === null ? tagged('xn', 'null') : tagged('x', intent.externalId),
    tagged('a', intent.accountRef),
    tagged('m', String(intent.amountMinor)),
    tagged('c', intent.currency),
    tagged('s', input.subjectRef),
  ].join('');
  const low = fnv1a(canonical, 0x811c9dc5).toString(16).padStart(8, '0');
  const high = fnv1a(canonical, 0x9e3779b9).toString(16).padStart(8, '0');
  return `oi1-${low}${high}`;
}
