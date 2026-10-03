/**
 * **规范化指纹**（交付会话私有；design-06 P8/P9）。
 *
 * 回答一个问题：**这两次提交的输入是不是同一份**。幂等键（R137/R146）与日志
 * （R139）都靠它，而不是靠"看起来差不多"。
 *
 * ## 与 `src/documents/session/canonical.ts` 的关系（如实登记）
 *
 * 两者**口径相同**（键排序 JSON + sha256 裸小写 hex + `undefined` 视同缺省），
 * 但**各写一份**：合并需要改动字处理会话那条已经「待验收」的链，本轮明确不做。
 * 合并的正确去处是一个共享的 `src/hash/**`，属于**后续收敛项**，
 * 已登记在 `.task-manifest/outputs/FA-T/interface-declaration.md`。
 *
 * 纪律：只 import `node:crypto`；零 IO、零墙钟、零随机数、零语义归一化
 * （归一化会引入"两个不同输入被当成同一个"的风险，而幂等的失败方向恰好是反的）。
 */

import { createHash } from 'node:crypto';

/** 稳定 JSON：对象键按字典序，数组保序，`undefined` 视同缺省（与 JSON 语义一致）。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(`<${String(value)}>`);
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return '"<undefined>"';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify(`<bytes:${createHash('sha256').update(value).digest('hex')}>`);
  }
  if (value instanceof Map) {
    const keys = [...value.keys()].map((key) => String(key)).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value.get(key))}`);
    return `{${parts.join(',')}}`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  // 函数 / symbol / bigint 这类不该出现在编辑里的值：显式标记，不静默。
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
