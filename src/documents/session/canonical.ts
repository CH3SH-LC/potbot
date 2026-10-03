/**
 * **规范化指纹**（会话层私有的确定性摘要工具）。
 *
 * 用途只有一个：回答"这两次提交的**输入**是不是同一份"。幂等键（R137/R146）
 * 与计划日志（R139）都靠它，而不是靠"看起来差不多"。
 *
 * 纪律：
 * - **键排序**的 JSON 编码（对象字段顺序不同 ⇒ 同一指纹；否则 `{a,b}` 与 `{b,a}`
 *   会被判成两份输入，幂等键就会莫名失效）；
 * - 只 import `node:crypto`：零 IO、零墙钟、零随机数；
 * - **不做任何语义归一化**——归一化会引入"两个不同输入被当成同一个"的风险，
 *   而幂等的失败方向恰好是反的（宁可判成两份，也不要吞掉一次真实编辑）。
 */

import { createHash } from 'node:crypto';

/** 稳定 JSON：对象键按字典序，数组保序，`undefined` 视同缺省（与 JSON 语义一致）。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    // NaN / Infinity 在 JSON 里没有表示：写成字符串标记，避免被静默转成 null。
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(`<${String(value)}>`);
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return '"<undefined>"';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  // 函数 / symbol / bigint 这类不该出现在意图里的值：显式标记，不静默。
  return JSON.stringify(`<${typeof value}>`);
}

/** 对任意可规范化值取 sha256（裸小写 hex，无前缀）。 */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** 对原始字节取 sha256（裸小写 hex）。与 `src/artifacts/digest.ts` 同口径。 */
export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
