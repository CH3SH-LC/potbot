/**
 * M06 的 **fixture**：可控时钟与标准金额上限 / 地址 / 时段常量。
 *
 * ## 这不是真实能力
 *
 * 美团真实平台能力尚未核实，本包不接真实接口。这里只有**确定性、纯本地**的常量与时钟，
 * 用于独立驱动与验证模型本身；任何「成功」都来自显式 fixture，**不构成**真实订单或确认。
 *
 * 一次性确认的 fixture 账本**不在此处**：为了证明本包**真实消费 K07**，
 * `tests/mobile-meituan/M06/` 直接装配**真实 K07 账本**
 * （`apps/mobile-kernel/actions`）作为 `K07LedgerView`，不走本包自造的假账本。
 */

import { PurchaseConfirmationError } from './errors.js';
import type { AmountCeiling, PurchaseClock, ConfirmationAddressView, ConfirmationTimeSlotView } from './types.js';

/** 可控时钟：时间只能被显式推进（不读系统时间）。 */
export class FixturePurchaseClock implements PurchaseClock {
  #now: number;
  #advances = 0;

  constructor(start = 0) {
    if (!Number.isFinite(start) || start < 0) {
      throw new PurchaseConfirmationError(
        'invalid_view_model_input',
        `fixture 时钟初值必须是非负有限数，收到 ${String(start)}`,
      );
    }
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  get advanceCount(): number {
    return this.#advances;
  }

  advance(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      throw new PurchaseConfirmationError(
        'invalid_view_model_input',
        `时钟推进必须是有限正数，收到 ${String(deltaMs)}`,
      );
    }
    this.#now += deltaMs;
    this.#advances += 1;
    return this.#now;
  }

  advanceTo(target: number): number {
    if (!Number.isFinite(target)) {
      throw new PurchaseConfirmationError(
        'invalid_view_model_input',
        `时钟目标必须是有限数，收到 ${String(target)}`,
      );
    }
    return this.advance(target - this.#now);
  }
}

/** 标准金额上限（¥100.00 = 10000 分），由「用户」设定。 */
export const STANDARD_CEILING: AmountCeiling = Object.freeze({
  ceilingMinor: 10_000,
  currency: 'CNY',
  setBy: 'user',
});

/** 标准地址视图（**掩码**，不含电话/门牌明文）。 */
export const STANDARD_ADDRESS: ConfirmationAddressView = Object.freeze({
  addressRef: 'addr-home',
  addressVersion: 3,
  addressSummary: '上海市某区某路（脱敏）',
  contactRef: 'contact:masked-1',
  contactMasked: 'masked:***',
});

/** 标准配送时段。 */
export const STANDARD_TIME_SLOT: ConfirmationTimeSlotView = Object.freeze({
  slotRef: 'slot-asap',
  slotLabel: '立即送出（约 35 分钟）',
});
