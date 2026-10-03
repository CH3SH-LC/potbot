/**
 * 表格域：金额 / 数量的**定点精度与单位**（design-06-P8 / XLS-17；合同 R248）。
 *
 * ## 为什么不能直接用 `number`
 *
 * IEEE-754 双精度算不了钱：`0.1 + 0.2 !== 0.3`。XLS-17 要求「金额精度、单位、**缺失不当零**，
 * 关键预算独立复算」。本模块的做法是把金额存成 **`bigint` 的最小单位整数**
 * （`amount_minor` + `scale`），加减法在整数域完成，**没有任何一步经过浮点**。
 *
 * ## 浮点误差不许被静默吞掉
 *
 * `parseQuantity` 拒绝"小数位多于 `scale`"的输入，**不四舍五入、不静默截断**。
 * 于是 `parseQuantity(0.1 + 0.2, 2, 'CNY')` 会**显式失败**（该和的十进制展开有 17 位小数），
 * 而 `parseQuantity('0.1', …)` 加 `parseQuantity('0.2', …)` **精确等于** `0.30`。
 * 前者失败不是缺陷，是把"调用方已经在浮点里丢了精度"这件事摆到台面上。
 *
 * ## 单位与币种
 *
 * 单位（`unit`）与币种（`currency`）不同的两个量**不得相加**——那正是"跨单位求和"这一类
 * 静默错误。缺失（空列表求和）**返回 `empty` 而不是 0**（R248）。
 */

import { ValidationError } from '../protocol/index.js';

/** 一个定点数量：`amount_minor × 10^-scale` 个 `unit`（可选币种 `currency`）。 */
export interface Quantity {
  /** 最小单位整数（如"分"）。**唯一真值**，不做浮点还原。 */
  readonly amount_minor: bigint;
  /** 小数位（0…20）。 */
  readonly scale: number;
  /** 单位（非空）。 */
  readonly unit: string;
  /** 币种（`null` 表示未标注币种）。 */
  readonly currency: string | null;
}

/** 求和结果：要么给数量，要么给**不可计算的原因**（缺失不写成 0）。 */
export type QuantitySum =
  | { readonly ok: true; readonly quantity: Quantity }
  | { readonly ok: false; readonly reason: 'empty' | 'unit_mismatch' };

const MAX_SCALE = 20;
const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function requireScale(scale: number, where: string): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new ValidationError(`${where} 的 scale 必须是 0…${String(MAX_SCALE)} 的整数，收到 ${String(scale)}`);
  }
}

function requireUnit(unit: string, where: string): void {
  if (typeof unit !== 'string' || unit.length === 0) {
    throw new ValidationError(`${where} 的 unit 不能为空`);
  }
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** 把有限数转成其最短往返十进制表示（**不引入额外精度**），再交给字符串解析。 */
function numberToDecimalText(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`parseQuantity 只接受有限数，收到 ${String(value)}`);
  }
  return String(value);
}

/**
 * 解析一个定点数量。**任何一步都不经浮点。**
 *
 * @param amount 十进制文本（如 `'19.99'`）或有限数（会先转成其最短往返十进制文本）
 * @throws {ValidationError} scale/unit 非法、文本不可解析、或**小数位多于 scale**（拒绝静默丢精度）
 */
export function parseQuantity(
  amount: string | number,
  scale: number,
  unit: string,
  currency: string | null = null,
): Quantity {
  requireScale(scale, 'parseQuantity');
  requireUnit(unit, 'parseQuantity');
  const text = typeof amount === 'number' ? numberToDecimalText(amount) : amount;
  const match = typeof text === 'string' ? DECIMAL_PATTERN.exec(text.trim()) : null;
  if (match === null) {
    throw new ValidationError(`无法解析定点数量：${JSON.stringify(amount)}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const integerPart = match[2];
  const fraction = match[3] ?? '';
  /* c8 ignore next 4 -- 正则已保证 group2 存在；此处仅为 noUncheckedIndexedAccess 收窄 */
  if (integerPart === undefined) {
    throw new ValidationError(`无法解析定点数量：${JSON.stringify(amount)}`);
  }
  if (fraction.length > scale) {
    throw new ValidationError(
      `小数位超出精度：输入 ${JSON.stringify(text)} 有 ${String(fraction.length)} 位小数，scale=${String(scale)}——` +
        '拒绝静默四舍五入（XLS-17 金额精度）',
    );
  }
  const padded = fraction.padEnd(scale, '0');
  const minor = BigInt(integerPart) * powerOfTen(scale) + BigInt(padded === '' ? '0' : padded);
  return Object.freeze({
    amount_minor: sign * minor,
    scale,
    unit,
    currency: currency === undefined ? null : currency,
  });
}

/** 把 `quantity` 换算到 `scale` 位小数（只能放大精度，不能丢精度）。@throws {ValidationError} */
function rescale(quantity: Quantity, scale: number): bigint {
  if (scale === quantity.scale) {
    return quantity.amount_minor;
  }
  if (scale < quantity.scale) {
    throw new ValidationError(
      `不能把 scale=${String(quantity.scale)} 的量降到 scale=${String(scale)}：会丢精度`,
    );
  }
  return quantity.amount_minor * powerOfTen(scale - quantity.scale);
}

function assertSameUnit(a: Quantity, b: Quantity, where: string): void {
  if (a.unit !== b.unit) {
    throw new ValidationError(`${where} 拒绝跨单位相加：${JSON.stringify(a.unit)} vs ${JSON.stringify(b.unit)}`);
  }
  if (a.currency !== b.currency) {
    throw new ValidationError(
      `${where} 拒绝跨币种相加：${JSON.stringify(a.currency)} vs ${JSON.stringify(b.currency)}`,
    );
  }
}

/** 两个同类量相加（单位与币种必须相同；精度取两者较大者）。@throws {ValidationError} */
export function addQuantities(a: Quantity, b: Quantity): Quantity {
  assertSameUnit(a, b, 'addQuantities');
  const scale = Math.max(a.scale, b.scale);
  const minor = rescale(a, scale) + rescale(b, scale);
  return Object.freeze({ amount_minor: minor, scale, unit: a.unit, currency: a.currency });
}

/**
 * 求和。**空列表 ⇒ `{ ok: false, reason: 'empty' }`，绝不返回 0**（R248：缺失不当零）。
 * 任一元素单位 / 币种不一致 ⇒ `unit_mismatch`。
 */
export function sumQuantities(list: readonly Quantity[]): QuantitySum {
  if (list.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  let accumulator: Quantity | undefined;
  for (const item of list) {
    if (accumulator === undefined) {
      accumulator = item;
      continue;
    }
    if (accumulator.unit !== item.unit || accumulator.currency !== item.currency) {
      return { ok: false, reason: 'unit_mismatch' };
    }
    accumulator = addQuantities(accumulator, item);
  }
  /* c8 ignore next -- 列表非空时 accumulator 必已赋值 */
  if (accumulator === undefined) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, quantity: accumulator };
}

/** 格式化为定点十进制文本：`{1999, scale:2, 'CNY'}` → `"19.99"`。@throws {ValidationError} */
export function formatQuantity(quantity: Quantity): string {
  requireScale(quantity.scale, 'formatQuantity');
  const negative = quantity.amount_minor < 0n;
  const absolute = negative ? -quantity.amount_minor : quantity.amount_minor;
  const text = absolute.toString().padStart(quantity.scale + 1, '0');
  const integerPart = text.slice(0, text.length - quantity.scale);
  const fractionPart = quantity.scale === 0 ? '' : text.slice(text.length - quantity.scale);
  const body = quantity.scale === 0 ? integerPart : `${integerPart}.${fractionPart}`;
  return `${negative ? '-' : ''}${body}`;
}

/** 比较两个同类量。单位 / 币种不同 ⇒ 抛。@throws {ValidationError} */
export function compareQuantities(a: Quantity, b: Quantity): -1 | 0 | 1 {
  assertSameUnit(a, b, 'compareQuantities');
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// X08 增量：聚合所需的精确运算（减法 / 取反 / 极值 / 舍入 / 除法）
//
// 分组汇总不能只用加法：`min` / `max` 要比大小、`average` 要除法、对账要减法。
// 这些**同样不经浮点**——除法在整数域做**显式**舍入，舍入口径由调用方指定，
// 每个金额结果都能复算到"哪一位、怎么进位"。
// ---------------------------------------------------------------------------

/** 显式舍入口径。**没有一个默认值**是"随便挑"的：调用方必须写出用哪种。 */
export type RoundingMode = 'half_away_from_zero' | 'half_even' | 'floor' | 'ceil' | 'truncate';

/** 取反（单位 / 币种不变，精度不变）。 */
export function negateQuantity(quantity: Quantity): Quantity {
  return Object.freeze({
    amount_minor: -quantity.amount_minor,
    scale: quantity.scale,
    unit: quantity.unit,
    currency: quantity.currency,
  });
}

/** 两个同类量相减（单位与币种必须相同；精度取两者较大者）。@throws {ValidationError} */
export function subtractQuantities(a: Quantity, b: Quantity): Quantity {
  return addQuantities(a, negateQuantity(b));
}

/**
 * 放大精度（只能放大，不能丢精度）。
 * @throws {ValidationError} 目标精度比原精度低（那需要显式舍入，走 {@link roundQuantity}）
 */
export function scaleQuantity(quantity: Quantity, scale: number): Quantity {
  requireScale(scale, 'scaleQuantity');
  return Object.freeze({
    amount_minor: rescale(quantity, scale),
    scale,
    unit: quantity.unit,
    currency: quantity.currency,
  });
}

/** 整数域的有符号除法 + 显式舍入。`divisor` 必须 > 0。 */
function divideRounded(numerator: bigint, divisor: bigint, mode: RoundingMode): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  switch (mode) {
    case 'truncate':
      break;
    case 'floor':
      if (remainder !== 0n && negative) quotient += 1n;
      break;
    case 'ceil':
      if (remainder !== 0n && !negative) quotient += 1n;
      break;
    case 'half_away_from_zero':
      if (2n * remainder >= divisor) quotient += 1n;
      break;
    case 'half_even': {
      const twice = 2n * remainder;
      if (twice > divisor) quotient += 1n;
      else if (twice === divisor && quotient % 2n === 1n) quotient += 1n;
      break;
    }
    default: {
      const never: never = mode;
      throw new ValidationError(`未覆盖的舍入口径：${String(never)}`);
    }
  }
  return negative ? -quotient : quotient;
}

/**
 * 把量降到 `scale` 位小数，按 `mode` 显式舍入。**降精度必须走这里**——
 * `addQuantities` 那条路只会升精度、绝不静默丢。
 * `scale >= quantity.scale` 时无损放大。@throws {ValidationError}
 */
export function roundQuantity(quantity: Quantity, scale: number, mode: RoundingMode): Quantity {
  requireScale(scale, 'roundQuantity');
  if (scale >= quantity.scale) {
    return scaleQuantity(quantity, scale);
  }
  const divisor = powerOfTen(quantity.scale - scale);
  return Object.freeze({
    amount_minor: divideRounded(quantity.amount_minor, divisor, mode),
    scale,
    unit: quantity.unit,
    currency: quantity.currency,
  });
}

/**
 * 除以一个正除数，结果取 `scale` 位小数（`scale` 不得低于被除量的精度，否则要先舍入）。
 * @throws {ValidationError} 除数非正整数、或 scale 低于被除量精度
 */
export function divideQuantity(
  quantity: Quantity,
  divisor: number | bigint,
  scale: number,
  mode: RoundingMode,
): Quantity {
  requireScale(scale, 'divideQuantity');
  const big = typeof divisor === 'bigint' ? divisor : BigInt(divisor);
  if (!Number.isInteger(typeof divisor === 'number' ? divisor : 1) || big <= 0n) {
    throw new ValidationError(`divideQuantity 的除数必须是正整数，收到 ${String(divisor)}`);
  }
  if (scale < quantity.scale) {
    throw new ValidationError(
      `divideQuantity 的目标精度 scale=${String(scale)} 低于被除量精度 ${String(quantity.scale)}：先显式舍入`,
    );
  }
  const numerator = quantity.amount_minor * powerOfTen(scale - quantity.scale);
  return Object.freeze({
    amount_minor: divideRounded(numerator, big, mode),
    scale,
    unit: quantity.unit,
    currency: quantity.currency,
  });
}

/**
 * 最小值；空列表 ⇒ `empty`，单位 / 币种不一致 ⇒ `unit_mismatch`（与 {@link sumQuantities} 同约定）。
 * 返回**原元素本身**（保留它自己的 scale），不做归一化——`1.5`(scale 1) 与 `1.50`(scale 2)
 * 数值相等，比较按最小单位进行，因此谁被选中只取决于值，不取决于写法。
 */
export function minQuantities(list: readonly Quantity[]): QuantitySum {
  return pickExtreme(list, 'min');
}

/** 最大值；空列表 ⇒ `empty`，单位 / 币种不一致 ⇒ `unit_mismatch`。返回原元素本身（同 {@link minQuantities}）。 */
export function maxQuantities(list: readonly Quantity[]): QuantitySum {
  return pickExtreme(list, 'max');
}

function pickExtreme(list: readonly Quantity[], which: 'min' | 'max'): QuantitySum {
  if (list.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  let best = list[0] as Quantity;
  for (const item of list) {
    if (best.unit !== item.unit || best.currency !== item.currency) {
      return { ok: false, reason: 'unit_mismatch' };
    }
    if (compareQuantities(which === 'min' ? item : best, which === 'min' ? best : item) < 0) {
      best = item;
    }
  }
  return { ok: true, quantity: best };
}

/**
 * 平均值 = 精确求和 ÷ 元素个数，再按 `mode` 舍入到 `scale`。
 * 空列表 ⇒ `empty`（不是 0）；单位 / 币种不一致 ⇒ `unit_mismatch`。
 */
export function averageQuantities(
  list: readonly Quantity[],
  scale: number,
  mode: RoundingMode,
): QuantitySum {
  const total = sumQuantities(list);
  if (!total.ok) {
    return total;
  }
  return { ok: true, quantity: divideQuantity(total.quantity, BigInt(list.length), scale, mode) };
}
