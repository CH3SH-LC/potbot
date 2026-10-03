/**
 * F10 food / 金额展示 —— 把 M04 的**整数最小单位**金额转成可展示视图。
 *
 * ## 为什么单独一层
 *
 * 外卖所有金额在 M 线契约（M04 `Quote` / `money.ts`）里都是**整数最小单位**
 * （人民币为「分」）。F10 页面**不得**自己算价，也不得用浮点承载金额：
 * 本模块只做「整数 → 十进制字符串」的展示转换，转换本身委托给 M04 的
 * `formatMinorUnitsAsDecimalString`（不重复实现，避免两套口径）。
 *
 * `display` 只用于展示与断言；**任何计算都必须回到 `amountMinor`**。
 */

import { formatMinorUnitsAsDecimalString } from '../../../../src/mobile-plugins/meituan/cart/index.js';

/** 可展示金额：整数值 + 币种 + 十进制字符串（三者恒一致）。 */
export interface FoodMoneyView {
  /** 整数最小单位（分）。**唯一可用于比较/累加的量**。 */
  readonly amountMinor: number;
  /** ISO-4217 三个大写字母。 */
  readonly currency: string;
  /** 十进制字符串（如 `'12.34'`），由 M04 口径生成，绝不经过浮点。 */
  readonly display: string;
}

/**
 * 构造展示金额。非法输入（非整数最小单位 / 非法币种）由 M04 的转换函数**显式抛错**，
 * 本模块不吞异常、不四舍五入。
 */
export function toFoodMoneyView(amountMinor: number, currency: string): FoodMoneyView {
  return Object.freeze({
    amountMinor,
    currency,
    display: formatMinorUnitsAsDecimalString(amountMinor, currency),
  });
}
