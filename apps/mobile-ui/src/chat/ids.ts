/**
 * F02 chat —— 确定性 id / 摘要（零依赖、纯函数）。
 *
 * 为什么不用 `Math.random()` / `Date.now()` / `crypto`：
 *   - 视图模型的 id 与幂等键必须**可复现**——同一输入在任何时候得到同一结果，
 *     测试才能机器化断言，内核才能靠 `idempotencyKey` 真正去重。
 *   - 手机内核运行在受限运行时（QuickJS 等），不假定 `node:crypto` 可用；
 *     这里用纯 TS 的 FNV-1a 64 位散列，零依赖、无平台假设。
 *
 * 注意：这是**幂等键构造**用途的散列，不是密码学摘要。不要用它做安全校验。
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64 位散列，返回 16 位小写十六进制（定长）。
 * 按 Unicode 码位处理，代理对不会被拆成两个码元。
 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const ch of input) {
    const codePoint = ch.codePointAt(0) ?? 0;
    // 码位可能 > 0xFFFF，按 4 字节处理，避免不同字符塌缩到同一字节序列。
    for (let shift = 0; shift <= 24; shift += 8) {
      const byte = (codePoint >>> shift) & 0xff;
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME) & MASK_64;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/** 定长带前缀 id。前缀用于人读排障，不参与唯一性语义。 */
export function prefixedId(prefix: string, seed: string): string {
  return `${prefix}-${fnv1a64Hex(seed)}`;
}

/**
 * 助手消息的尝试 id：`<messageId>#t<index>`。
 * 尝试 id 与消息 id 一起构成 chunk 的寻址坐标（I3 尝试隔离）。
 */
export function attemptIdFor(messageId: string, attemptIndex: number): string {
  const n = Number.isInteger(attemptIndex) && attemptIndex > 0 ? attemptIndex : 1;
  return `${messageId}#t${n}`;
}
