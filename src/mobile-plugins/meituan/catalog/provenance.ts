/**
 * 来源归属与内容指纹。
 *
 * 「真实来源/时间」在本包里是**可检查**的：`SourceRef` 必须写明 provider/endpoint/
 * retrievedAt，且 retrievedAt 来自注入时钟。任何商家/菜品/页面若拿不出合法来源，
 * 校验直接失败（`CatalogProvenanceError`）。
 *
 * 内容指纹沿用 M04 的口径：FNV-1a 32 位**结构指纹**，用于一致性判定与对账，
 * **不是**密码学摘要，不用于任何安全用途。
 */

import { CatalogProvenanceError, CatalogValidationError } from './errors.js';

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

/** 任意 JSON 可序列化值的内容指纹（键序无关，前缀 `c1-` 便于换算法时区分）。 */
export function contentDigest(value: unknown): string {
  return `c1-${fnv1a32Hex(stableStringify(value))}`;
}

/** 键序稳定的 JSON 序列化（对象键升序；数组保持顺序）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** 校验来源引用；非法即抛 `CatalogProvenanceError`。返回原对象。 */
export function assertSourceRef(ref: unknown, label: string): void {
  if (ref === null || typeof ref !== 'object') {
    throw new CatalogProvenanceError(`${label} 缺少来源引用：目录数据必须能指回具体来源，不能编造`);
  }
  const candidate = ref as Partial<Record<keyof SourceRefLike, unknown>>;
  requireNonEmptyString(candidate.provider, `${label}.sourceRef.provider`);
  requireNonEmptyString(candidate.endpoint, `${label}.sourceRef.endpoint`);
  const retrievedAt = candidate.retrievedAt;
  if (typeof retrievedAt !== 'number' || !Number.isFinite(retrievedAt) || retrievedAt < 0) {
    throw new CatalogProvenanceError(
      `${label}.sourceRef.retrievedAt 必须是来自注入时钟的非负有限数，收到 ${String(retrievedAt)}`,
    );
  }
  if (candidate.traceRef !== undefined) {
    requireNonEmptyString(candidate.traceRef, `${label}.sourceRef.traceRef`);
  }
}

/** 内部：`SourceRef` 的形状视图（避免与 types.ts 形成值依赖）。 */
interface SourceRefLike {
  readonly provider: string;
  readonly endpoint: string;
  readonly retrievedAt: number;
  readonly traceRef?: string;
}

function requireNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CatalogProvenanceError(`${label} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
}

/** 来源引用的稳定键（用于对账/去重，不用于安全）。 */
export function sourceRefKey(ref: SourceRefLike): string {
  const trace = ref.traceRef === undefined ? '' : `#${ref.traceRef}`;
  return `${ref.provider}|${ref.endpoint}|${ref.retrievedAt}${trace}`;
}

/** 校验一个非负整数的分钟/秒级数值（供营业时段等使用）。 */
export function assertIntegerInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CatalogValidationError(`${label} 必须是 [${min}, ${max}] 的整数，收到 ${String(value)}`);
  }
  return value;
}
