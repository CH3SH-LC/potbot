/**
 * 规范化摘要（D05；合同 §十「阻塞指纹的哈希算法 → D05 定」）。
 *
 * 只做一件事：把**已经规范化**的字符串/字符串数组映射成稳定摘要。
 * 用 `node:crypto` 的内置 sha256（**不引入新依赖**），对同一输入逐字节确定 ⇒ 满足 Q8-c 重现性。
 *
 * 规范化（排序 / 去重 / 长度前缀编码）**不**在本文件：那属于各领域的语义
 * （见 `fingerprint.ts` 的 `normalizeBlockingFingerprint`）。本文件只提供纯函数摘要，
 * 避免"编码两次"这类分叉（D01 的 `toActionableInputKey` vs `actionableKey` 教训）。
 */

import { createHash } from 'node:crypto';

/** 对一段已规范化的文本取 sha256 十六进制摘要（确定性、无时间戳）。 */
export function canonicalDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 对一组已规范化的分量取摘要。
 * 用 JSON 数组编码（而不是拼接分隔符）——数组编码无歧义，且不含控制字符。
 */
export function digestOfParts(parts: readonly string[]): string {
  return canonicalDigest(JSON.stringify(parts));
}
