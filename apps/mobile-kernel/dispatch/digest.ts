/**
 * K05 确定性**结构摘要**（非加密）。
 *
 * 用途：让"同一份计划重放得到同一摘要"可被断言；**不是**安全哈希，不用于完整性 / 防篡改 /
 * 密钥派生。契约 `contracts/mobile-v1` 的 `sha256:` 摘要是另一回事（那由 K09 StoragePort 提供），
 * 本包在手机运行时里避免依赖 `node:crypto`，故用一个纯 TS 的 FNV-1a 32 位实现。
 *
 * 纯函数、零 IO、不读墙钟、不引随机数。
 */

/** FNV-1a 32 位，返回 8 位小写十六进制。确定性：同输入恒同输出。 */
export function structuralDigest(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    // 逐 UTF-16 code unit 混入（对本层用途足够；不声称对任意 Unicode 等价串唯一）。
    hash ^= input.charCodeAt(index);
    // 32 位乘法：hash *= 16777619，用移位避免超出安全整数。
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
