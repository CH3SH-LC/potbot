/**
 * M08 金额纪律：一切金额都是**整数最小单位**（人民币为「分」），币种必填。
 *
 * 与 M04（`cart/money.ts`）/ M09（`order-lifecycle/money.ts`）同一口径，但本包
 * **自持实现**，不跨包 import：支付金额是「平台说收了多少钱」与「我方意图收多少钱」
 * 之间的核对判据，一旦依赖别包模块，别包的任何改动都会顺着 import 影响这条判据。
 *
 * 本模块只做整数校验，**不做任何换算**：出现浮点金额一律拒绝，而不是四舍五入——
 * 四舍五入会把一笔不符的金额「修」成相符的，正是本包要防的事。
 */

import { PaymentError } from './errors.js';

/** ISO-4217 形状的币种代码（三个大写字母）。 */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

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

/** 校验一个金额是合法的整数最小单位；否则抛 {@link PaymentError}。 */
export function asMinorUnits(value: unknown, label: string): number {
  if (!isValidMinorUnits(value)) {
    throw new PaymentError(
      'invalid_payment_request',
      `${label} 必须是（非负、安全范围内的）整数最小单位，收到 ${String(value)}；金额不得使用浮点或小数单位`,
      label,
    );
  }
  return value;
}

/** 校验币种：必填、三个大写字母。 */
export function asCurrencyCode(value: unknown, label = 'currency'): string {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new PaymentError(
      'invalid_payment_request',
      `${label} 必填且必须是三个大写字母的 ISO-4217 代码，收到 ${JSON.stringify(value)}`,
      label,
    );
  }
  return value;
}

/** 校验非空字符串。 */
export function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PaymentError('invalid_payment_request', `${label} 不能为空`, label);
  }
  return value;
}

/** 校验安全整数（用于时刻、版本等）。 */
export function asSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PaymentError('invalid_payment_request', `${label} 必须是安全整数，收到 ${JSON.stringify(value)}`, label);
  }
  return value;
}
