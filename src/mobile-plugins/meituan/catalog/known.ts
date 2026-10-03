/**
 * 「已知 / 未知」判别结构 —— 本包对「未知不补造」的结构性落点。
 *
 * 目录里任何一个**可能拿不到**的字段（营业时间、库存、配送范围、商家声明总数）
 * 都用 `MaybeKnown<T>` 表达：
 * - `Known<T>` 必须带 `sourceRef`（谁给的？哪一刻给的？没有来源不算已知）；
 * - `Unknown` 必须带**非空原因**（为什么不知道？不允许无理由的未知）。
 *
 * 这样「字段缺失就默认成 0 / 默认成营业中 / 默认成可配送」在构造层面就写不出来：
 * 要造一个已知值，就得指名来源。
 */

import { CatalogUnknownFieldError, CatalogValidationError } from './errors.js';

/** 已核实来源的已知值。 */
export interface Known<T> {
  readonly state: 'known';
  readonly value: T;
  /** 该值的来源引用（非空）。 */
  readonly sourceRef: string;
}

/** 明确的未知：原因必填。 */
export interface Unknown {
  readonly state: 'unknown';
  /** 为什么未知（非空）；必须如实保留，不得补默认值。 */
  readonly reason: string;
}

/** 已知或未知。 */
export type MaybeKnown<T> = Known<T> | Unknown;

/** 造一个已知值。`sourceRef` 为空即抛错——已知必须有出处。 */
export function known<T>(value: T, sourceRef: string): Known<T> {
  if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
    throw new CatalogValidationError('known() 必须带非空 sourceRef；没有来源的「已知」等于编造');
  }
  return Object.freeze({ state: 'known', value, sourceRef });
}

/** 造一个未知值。`reason` 为空即抛错——未知必须说明原因。 */
export function unknown(reason: string): Unknown {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new CatalogValidationError('unknown() 必须给出非空原因；不允许无理由的未知');
  }
  return Object.freeze({ state: 'unknown', reason });
}

/** 判别：是否为已知。 */
export function isKnown<T>(value: MaybeKnown<T>): value is Known<T> {
  return value.state === 'known';
}

/** 判别：是否为未知。 */
export function isUnknown<T>(value: MaybeKnown<T>): value is Unknown {
  return value.state === 'unknown';
}

/** 取已知值；若是未知则抛 `CatalogUnknownFieldError`（而不是返回 undefined）。 */
export function requireKnown<T>(value: MaybeKnown<T>, label: string): T {
  if (!isKnown(value)) {
    throw new CatalogUnknownFieldError(`${label} 未知（${value.reason}）；不得当作已知使用`);
  }
  return value.value;
}

/**
 * 已知值映射：只对已知值应用 `fn`，未知**原样保留**（连同原因）。
 * 绝不把未知变成某个默认映射结果。
 */
export function mapKnown<T, U>(value: MaybeKnown<T>, fn: (inner: T) => U): MaybeKnown<U> {
  if (!isKnown(value)) return value;
  return known(fn(value.value), value.sourceRef);
}
