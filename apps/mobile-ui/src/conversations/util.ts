/**
 * F03 conversations —— 确定性 id 与时间戳校验（零依赖、纯函数）。
 *
 * 与 F02 相同的取舍：不用 `Math.random()` / `Date.now()` / `crypto`。
 * 会话 id 与创建序号必须可复现，测试才能逐字段断言；手机内核可能跑在受限运行时
 * （QuickJS 等），不假定 `node:crypto` 可用。这里用纯 TS 的 FNV-1a 64 位散列。
 *
 * 注意：这是**标识/排序**用途的散列，不是密码学摘要，不要用于安全校验。
 */

import { ConversationError, type ConversationLifecycle } from './types.js';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64 位散列，返回 16 位小写十六进制（定长）。按 Unicode 码位处理。 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const ch of input) {
    const codePoint = ch.codePointAt(0) ?? 0;
    for (let shift = 0; shift <= 24; shift += 8) {
      const byte = (codePoint >>> shift) & 0xff;
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME) & MASK_64;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/** 由可选外部 id 与序号确定性生成会话 id。 */
export function conversationIdFor(title: string, seq: number, providedId?: string): string {
  if (providedId !== undefined) return providedId;
  return `conv-${fnv1a64Hex(`${seq}|${title}`)}`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** 是否合法 UTC ISO 8601 时间戳（与契约同形状）。 */
export function isIsoUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value);
}

/**
 * 断言时间戳合法，否则抛 `invalid-activity`。
 * 不合法时**不猜测**、不落成空串——排序键被污染会让「最近活跃」失真。
 */
export function requireIsoTimestamp(value: unknown, field: string): string {
  if (!isIsoUtcTimestamp(value)) {
    throw new ConversationError('invalid-activity', `${field} 必须是 UTC ISO 8601 时间戳`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

/** 规范化标题：去首尾空白；空则抛 `invalid-title`（不把空串当标题写下去）。 */
export function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConversationError('invalid-title', '会话标题必须是非空字符串');
  }
  return value.trim();
}

const ALLOWED_LIFECYCLE: readonly ConversationLifecycle[] = ['active', 'archived'];

/**
 * 断言生命周期取值合法，否则抛 `invalid-lifecycle`。
 *
 * 事件落点（`applyConversationUpdate`）接受调用方投递的 patch，取值不受编译期约束；
 * 若放行未知值（如 `'deleted'`），该会话会**同时**从 `active` 与 `archived` 两个筛选里
 * 消失（`all` 仍能查到），列表出现「查得到总数、却哪一页都不显示」的错位。故显式拒绝。
 */
export function requireLifecycle(value: unknown): ConversationLifecycle {
  if (!ALLOWED_LIFECYCLE.includes(value as ConversationLifecycle)) {
    throw new ConversationError('invalid-lifecycle', 'lifecycle 只能是 active 或 archived', {
      value: value === undefined ? null : String(value),
    });
  }
  return value as ConversationLifecycle;
}
