/**
 * M09 金额纪律：一切金额都是**整数最小单位**（人民币为「分」），币种必填。
 *
 * 与 M04（`cart/money.ts`）同一口径，但本包**自持实现**，不跨包 import：
 * M09 的职责是对平台回执做**核对**，一旦它依赖 M04 的模块，M04 的任何改动
 * 都会顺着 import 影响「平台金额是否与我方意图一致」这条判据。
 *
 * 本模块只做整数校验，**不做任何换算**（不把「元」转成「分」）：
 * 出现浮点金额一律拒绝，而不是四舍五入——四舍五入会把一笔不符的金额
 * 「修」成相符的，正是本包要防的事。
 */

import { OrderValidationError } from './errors.js';

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

/** 校验一个金额是合法的整数最小单位；否则抛 {@link OrderValidationError}。 */
export function asMinorUnits(value: unknown, label: string): number {
  if (!isValidMinorUnits(value)) {
    throw new OrderValidationError(
      `${label} 必须是（非负、安全范围内的）整数最小单位，收到 ${String(value)}；金额不得使用浮点或小数单位`,
    );
  }
  return value;
}

/** 校验币种：必填、三个大写字母。 */
export function asCurrencyCode(value: unknown, label = 'currency'): string {
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new OrderValidationError(
      `${label} 必填且必须是三个大写字母的 ISO-4217 代码，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 校验非空字符串。 */
export function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OrderValidationError(`${label} 不能为空`);
  }
  return value;
}
