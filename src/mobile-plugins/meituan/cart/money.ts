/**
 * M04 金额纪律：一切金额都是**整数最小单位**（人民币为「分」），币种必填。
 *
 * 为什么不用浮点：
 * - `0.1 + 0.2 !== 0.3`；用「元」的浮点数累加，一百多块的单子就可能出现
 *   `123.45000000000002` 这类值。本地一旦容忍它，后续的下单参数就会被污染。
 * - 因此本模块只提供整数运算与整数校验：**非整数一律拒绝**，而不是四舍五入。
 *
 * 注意：本模块**不产生**任何「最终价」。最终价只能来自 `QuotePort`
 * （见 `./session.ts` 的一致性校验），本地只做加减法核对。
 *
 * 此外本模块提供**领域 ↔ wire 边界换算**（`minorUnitsToWireAmount` /
 * `wireAmountToMinorUnits`）：按 `contracts/mobile-v1` 金额裁决，wire 层是十进制
 * 字符串、领域层是整数最小单位，换算只在边界发生且必须精确、位数由币种决定。
 */

import { CartValidationError } from './errors.js';

/** ISO-4217 形状的币种代码（三个大写字母）。 */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** `Number.MAX_SAFE_INTEGER` 之内的非负整数才是合法金额。 */
export function isValidMinorUnits(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

/** 校验币种：必填、三个大写字母。 */
export function asCurrencyCode(value: string): string {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new CartValidationError(
      `币种必填且必须是三个大写字母的 ISO-4217 代码，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 校验一个金额是合法的整数最小单位。
 * **非整数直接抛错**（不取整、不四舍五入）——浮点污染必须看得见。
 */
export function asMinorUnits(value: number, label: string): number {
  if (!isValidMinorUnits(value)) {
    throw new CartValidationError(
      `${label} 必须是（非负、安全范围内的）整数最小单位，收到 ${String(value)}；` +
        '金额不得使用浮点或小数单位',
    );
  }
  return value;
}

/** 整数求和。空数组返回 0（合法的「无费用」）。 */
export function sumMinorUnits(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    asMinorUnits(value, `${label}[${String(total)}]`);
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new CartValidationError(`${label} 求和溢出安全整数范围`);
    }
  }
  return total;
}

/** 整数乘法（单价 × 数量）。 */
export function multiplyMinorUnits(unit: number, quantity: number, label: string): number {
  asMinorUnits(unit, `${label}.unit`);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new CartValidationError(`${label}.quantity 必须是正整数，收到 ${String(quantity)}`);
  }
  const product = unit * quantity;
  if (!Number.isSafeInteger(product)) {
    throw new CartValidationError(`${label} 乘积溢出安全整数范围`);
  }
  return product;
}

// ─────────────────────────────────────────────────────────────────────────────
// 领域 ↔ wire 边界换算（`contracts/mobile-v1` 金额裁决第 2~3 条）
//
// 裁决原文：领域层一律用整数最小单位（`amountMinor: number` + `currency`），
// 小数位数**由币种决定**；换算**只在边界发生且必须精确**——wire→领域按字符串
// 逐位解析（禁止「浮点解析再乘一百」这类会引入误差的写法），领域→wire 定点
// 格式化且位数与币种一致。
//
// 本模块提供这一对边界函数（其余模块不得各自发明换算）。M04 正是该裁决点名的
// 当事包之一（K07 授权账本、M04 购物车/报价）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 币种小数位（ISO-4217 exponent）：`CNY`=2、`JPY`=0、`KWD`=3……
 *
 * 这是边界换算的**唯一位数依据**。表外币种按 {@link DEFAULT_CURRENCY_EXPONENT}
 * 处理（如实说明，不假装知道）。
 */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  // 0 位小数
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // 3 位小数
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
});

/** 表外币种的小数位默认值（2 是最常见的取值；这是**约定**，不是对币种的断言）。 */
export const DEFAULT_CURRENCY_EXPONENT = 2;

/**
 * wire 金额字符串的形状，与 `contracts/mobile-v1/schemas/confirm-action.schema.json`
 * 的 `$defs.amount.pattern` 逐字一致（`^[0-9]+(\.[0-9]{1,4})?$`）。
 */
const WIRE_AMOUNT_PATTERN = /^[0-9]+(\.[0-9]{1,4})?$/;

/** 取币种的小数位（整数最小单位 ⇒ 该币种金额小数点后的位数）。 */
export function currencyExponent(currency: string): number {
  asCurrencyCode(currency);
  const exponent = CURRENCY_EXPONENTS[currency];
  return exponent === undefined ? DEFAULT_CURRENCY_EXPONENT : exponent;
}

/**
 * 领域 → wire：把整数最小单位格式化成**定点**十进制字符串，位数与币种一致。
 *
 * 例：`5 + CNY` → `'0.05'`；`5 + JPY` → `'5'`；`1234 + KWD` → `'1.234'`。
 * 纯字符串位移，**不经过浮点**。
 *
 * @throws {CartValidationError} `amountMinor` 不是非负安全整数时。
 */
export function minorUnitsToWireAmount(amountMinor: number, currency: string): string {
  asMinorUnits(amountMinor, 'amountMinor');
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * wire → 领域：把 wire 十进制字符串**逐位**解析成整数最小单位。
 *
 * 纪律（mobile-v1 金额裁决第 3 条）：
 * - **禁止浮点解析**（把字符串先转成浮点再乘一百会引入误差）：这里只做字符串
 *   位移、补零与整数拼接，最终一次 `Number()` 只作用于**纯数字串**并用
 *   `String(minor) === minorText` 做往返精确性校验；
 * - 小数位**超过币种位数且末位非零** ⇒ 抛错（拒绝静默截断/四舍五入），
 *   例如 `'1.234'` 对 `CNY`；尾随零不算超精度（`'1.2300'` 对 `CNY` 合法 = 123 分）；
 * - 超出安全整数范围 ⇒ 抛错，绝不静默丢精度。
 *
 * @throws {CartValidationError} 形状非法、精度溢出、或超出安全整数范围时。
 */
export function wireAmountToMinorUnits(amount: string, currency: string): number {
  if (typeof amount !== 'string' || !WIRE_AMOUNT_PATTERN.test(amount)) {
    throw new CartValidationError(
      `金额必须是形如 ^[0-9]+(\\.[0-9]{1,4})?$ 的十进制字符串，收到 ${JSON.stringify(amount)}`,
    );
  }
  const exponent = currencyExponent(currency);
  const dot = amount.indexOf('.');
  const integerPart = dot === -1 ? amount : amount.slice(0, dot);
  const fractionPart = dot === -1 ? '' : amount.slice(dot + 1);
  if (fractionPart.length > exponent) {
    const overflow = fractionPart.slice(exponent);
    if (/[^0]/.test(overflow)) {
      throw new CartValidationError(
        `金额 ${amount} 的小数位超过币种 ${currency} 的 ${exponent} 位且末位非零，` +
          '拒绝截断或四舍五入（边界换算必须精确）',
      );
    }
  }
  const keptFraction = fractionPart.slice(0, exponent).padEnd(exponent, '0');
  const minorText = `${integerPart}${keptFraction}`.replace(/^0+(?=\d)/, '');
  const minor = Number(minorText);
  if (!Number.isSafeInteger(minor) || String(minor) !== minorText) {
    throw new CartValidationError(`金额 ${amount} 超出安全整数范围，拒绝静默丢精度`);
  }
  return minor;
}

/**
 * 把整数最小单位渲染成十进制字符串（如 `1234` + `CNY` → `'12.34'`）。
 *
 * 现为 {@link minorUnitsToWireAmount} 的**币种感知**别名：对 `CNY` 与历史行为一致，
 * 对 `JPY`（0 位）/`KWD`（3 位）等币种给出正确位数。仅供展示与断言，不参与计算。
 */
export function formatMinorUnitsAsDecimalString(amountMinor: number, currency: string): string {
  return minorUnitsToWireAmount(amountMinor, currency);
}
