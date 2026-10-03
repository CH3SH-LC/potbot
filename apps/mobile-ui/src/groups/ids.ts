/**
 * F04 groups —— 确定性 id / 摘要（零依赖、纯函数）。
 *
 * 与 F02 `chat/ids.ts`、F03 `conversations/util.ts` 相同的取舍：不用 `Math.random()` /
 * `Date.now()` / `crypto`。任务的 `groupId`、命令的 `commandId`/`idempotencyKey` 必须可复现，
 * 测试才能逐字段断言，内核才能靠 `idempotencyKey` 真正去重；手机内核可能跑在受限运行时
 * （QuickJS 等），不假定 `node:crypto` 可用。这里用纯 TS 的 FNV-1a 64 位散列。
 *
 * 注意：这是**标识/幂等键**用途的散列，不是密码学摘要，不要用于安全校验。
 */

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

/** 定长带前缀 id。前缀只做人读排障，不参与唯一性语义。 */
export function prefixedId(prefix: string, seed: string): string {
  return `${prefix}-${fnv1a64Hex(seed)}`;
}

/** 由（会话, 名称, 序号）确定性生成群组 id。 */
export function groupIdFor(name: string, seq: number, providedId?: string): string {
  if (providedId !== undefined) return providedId;
  return `grp-${fnv1a64Hex(`${seq}|${name}`)}`;
}
