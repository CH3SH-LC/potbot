/**
 * M06 **金额上限**——把「最多花多少钱」变成一道机器可验的闸门。
 *
 * ## 为什么金额上限是**必填**而不是可选
 *
 * 「模型自己决定花多少」正是本包要关的洞之一。若上限可选、缺省即「无上限」，
 * 那就等于把一个会失控的开支开关交给调用方。因此本包的口径是：
 * **没有配置上限 = 不放行**（`ceiling_not_configured`），而不是「默认无限额」。
 *
 * 上限由**策略**设定（用户 / 任务策略），是 {@link AmountCeiling} 的输入，不是模型可编的字段。
 */

import { isValidMinorUnits } from '../cart/index.js';
import { PurchaseConfirmationError } from './errors.js';
import type { AmountCeiling } from './types.js';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** 校验一份金额上限的定义；非法即抛 `ceiling_not_configured`（缺上限也走这条）。 */
export function validateCeiling(ceiling: AmountCeiling | null | undefined): AmountCeiling {
  if (ceiling === null || ceiling === undefined) {
    throw new PurchaseConfirmationError(
      'ceiling_not_configured',
      '未配置金额上限：没有上限即不得购买（本包不默认「无限额」）',
    );
  }
  if (!isValidMinorUnits(ceiling.ceilingMinor)) {
    throw new PurchaseConfirmationError(
      'ceiling_not_configured',
      `金额上限 ceilingMinor 必须是（非负、安全范围内的）整数最小单位（分），收到 ${String(ceiling.ceilingMinor)}`,
      'amount',
    );
  }
  if (typeof ceiling.currency !== 'string' || !CURRENCY_PATTERN.test(ceiling.currency)) {
    throw new PurchaseConfirmationError(
      'ceiling_not_configured',
      `金额上限币种必须是 ISO 4217 大写三字母，收到 ${JSON.stringify(ceiling.currency)}`,
      'currency',
    );
  }
  if (typeof ceiling.setBy !== 'string' || ceiling.setBy.trim().length === 0) {
    throw new PurchaseConfirmationError(
      'ceiling_not_configured',
      '金额上限必须标明由谁设定（setBy 不能为空）——上限要可审计',
      'setBy',
    );
  }
  return Object.freeze({ ...ceiling });
}

/**
 * 断言一笔订单金额在上限之内。
 *
 * 判定顺序（顺序即优先级，测试依赖它给出确定性拒因）：
 * 1. 上限缺失 / 非法 ⇒ `ceiling_not_configured`；
 * 2. 金额不是整数最小单位 ⇒ `invalid_view_model_input`；
 * 3. 币种不符 ⇒ `ceiling_currency_mismatch`；
 * 4. 超过上限 ⇒ `amount_exceeds_ceiling`（等于上限**放行**：<= 即通过）。
 */
export function assertWithinCeiling(amountMinor: number, currency: string, ceiling: AmountCeiling): void {
  const validated = validateCeiling(ceiling);
  if (!isValidMinorUnits(amountMinor)) {
    throw new PurchaseConfirmationError(
      'invalid_view_model_input',
      `订单金额必须是（非负、安全范围内的）整数最小单位（分），收到 ${String(amountMinor)}`,
      'amount',
    );
  }
  if (currency !== validated.currency) {
    throw new PurchaseConfirmationError(
      'ceiling_currency_mismatch',
      `订单币种 ${currency} 与金额上限币种 ${validated.currency} 不符：不得跨币种套用上限`,
      'currency',
    );
  }
  if (amountMinor > validated.ceilingMinor) {
    throw new PurchaseConfirmationError(
      'amount_exceeds_ceiling',
      `订单金额 ${amountMinor} 分超过金额上限 ${validated.ceilingMinor} 分` +
        `（由 ${validated.setBy} 设定）：须重新确认或调低金额`,
      'amount',
    );
  }
}

/** 纯查询：金额是否在上限内（不抛错，供展示层预判）。 */
export function isWithinCeiling(amountMinor: number, currency: string, ceiling: AmountCeiling): boolean {
  try {
    assertWithinCeiling(amountMinor, currency, ceiling);
    return true;
  } catch {
    return false;
  }
}
