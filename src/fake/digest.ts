/**
 * 可复现序列化与摘要（归属 D06，`src/fake/`）。
 *
 * 为什么不用 `JSON.stringify` 直接输出证据：
 * - 对象键序取决于属性插入顺序，同样的语义换个构造顺序就会得到不同字节，无法做「逐字节一致」的判据；
 * - `undefined` / 非有限数 / bigint 在 `JSON.stringify` 下会静默变形（丢键、变 null、抛错），
 *   证据一旦静默变形就失去可追踪性。
 *
 * 本模块给出**规范化 JSON**：键按字典序排序、数组保序、`undefined` 处置显式、
 * 不可序列化类型显式抛错。相同语义 → 相同字节。
 */

import { createHash } from 'node:crypto';

/** 规范化序列化无法完成时抛出（例如数据里混入函数、bigint、NaN）。 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function serialize(value: unknown, path: string): string {
  if (value === null || value === undefined) return 'null';

  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        `${path} 出现非有限数字（${String(value)}），无法生成可复现证据`,
      );
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (typeof value === 'bigint') {
    throw new CanonicalJsonError(`${path} 出现 bigint，会随平台变形，禁止写入证据`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) => serialize(item, `${path}[${i}]`));
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`)
      .join(',');
    return `{${body}}`;
  }

  throw new CanonicalJsonError(`${path} 出现不可序列化的值（typeof = ${typeof value}）`);
}

/**
 * 规范化 JSON 文本：对象键升序、数组保序、`undefined` 键被丢弃、数组中的 `undefined` 记为 `null`。
 * @throws {CanonicalJsonError}
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

/** 十六进制 SHA-256（node 内建 `node:crypto`，不引入新依赖）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 带算法前缀的内容摘要，便于日后换算法时仍可辨认。 */
export function contentDigest(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}
