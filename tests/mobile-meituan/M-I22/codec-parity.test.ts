/**
 * M-I22 §2：仓库里**并存**的三个金额 wire 编解码器必须产出同一结果。
 *
 * - M04 `cart/money.ts`：integration request 点名的边界函数（`minorUnitsToWireAmount`）；
 * - K07 `apps/mobile-kernel/actions/wire-codec.ts`：`formatWireAmount` / `parseWireAmount`；
 * - F05 `apps/mobile-ui/src/decisions/trust.ts`：`defaultWireBridge`。
 *
 * 生产代码里三者互不 import（各自写了理由），因此**没有**任何运行时机制保证它们等价。
 * 本文件就是那台机器：同一 `(最小单位, 币种)` 必须产出同一 wire 串，同一 wire 串必须
 * 解析回同一整数；否则"金额跨边界换算"就成了"看走哪条路"。
 *
 * 口径确实不一致的两处（表外币种 / 表外 0 位币种）本文件**如实断言**其分歧，见 §2.3。
 */

import { describe, expect, it } from 'vitest';

import { AuthorizationError } from '../../../apps/mobile-kernel/actions/index.js';
import {
  CURRENCY_MINOR_DIGITS as K07_MINOR_DIGITS,
  formatWireAmount,
  minorDigitsOf,
  parseWireAmount,
} from '../../../apps/mobile-kernel/actions/index.js';
import {
  CURRENCY_MINOR_DIGITS as F05_MINOR_DIGITS,
  defaultWireBridge,
  WireBridgeError,
} from '../../../apps/mobile-ui/src/decisions/trust.js';
import {
  currencyExponent,
  minorUnitsToWireAmount,
  wireAmountToMinorUnits,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { MINOR_WIRE_CASES, SHARED_CURRENCIES } from './support.js';

const SAMPLE_MINORS: readonly number[] = Object.freeze([0, 1, 5, 99, 100, 1234, 8800, 999_999_999]);

describe('M-I22 §2.1 三个编解码器对领域 → wire 产出完全一致', () => {
  it('所有共认币种 × 样品最小单位，三者输出逐字符相同', () => {
    for (const currency of SHARED_CURRENCIES) {
      for (const minor of SAMPLE_MINORS) {
        const cartWire = minorUnitsToWireAmount(minor, currency);
        const k07Wire = formatWireAmount(minor, currency);
        const f05Wire = defaultWireBridge.fromMinorUnits(minor, currency);
        expect(k07Wire, `K07 vs M04 @ ${minor} ${currency}`).toBe(cartWire);
        expect(f05Wire, `F05 vs M04 @ ${minor} ${currency}`).toBe(cartWire);
      }
    }
  });

  it('三方的币种位数表在共认币种上一致', () => {
    for (const currency of SHARED_CURRENCIES) {
      const digits = currencyExponent(currency);
      expect(minorDigitsOf(currency), `K07 位数 @ ${currency}`).toBe(digits);
      expect(K07_MINOR_DIGITS[currency], `K07 表 @ ${currency}`).toBe(digits);
      expect(F05_MINOR_DIGITS[currency], `F05 表 @ ${currency}`).toBe(digits);
    }
  });

  it('已知样品与"由 ISO 位数推出的期望 wire"一致（三方都不能自证）', () => {
    for (const { minor, currency, wire } of MINOR_WIRE_CASES) {
      expect(minorUnitsToWireAmount(minor, currency), `M04 ${minor} ${currency}`).toBe(wire);
      expect(formatWireAmount(minor, currency), `K07 ${minor} ${currency}`).toBe(wire);
      expect(defaultWireBridge.fromMinorUnits(minor, currency), `F05 ${minor} ${currency}`).toBe(wire);
    }
  });
});

describe('M-I22 §2.2 wire → 领域解析三方一致且往返恒等（换算恰好一次）', () => {
  it('同一 wire 串三方解析成同一整数', () => {
    for (const { minor, currency, wire } of MINOR_WIRE_CASES) {
      expect(wireAmountToMinorUnits(wire, currency), `M04 ${wire} ${currency}`).toBe(minor);
      expect(parseWireAmount(wire, currency), `K07 ${wire} ${currency}`).toBe(minor);
      expect(defaultWireBridge.toMinorUnits(wire, currency), `F05 ${wire} ${currency}`).toBe(minor);
    }
  });

  it('每个编解码器自身领域 → wire → 领域恒等（不会重复乘/除一次）', () => {
    for (const currency of SHARED_CURRENCIES) {
      for (const minor of SAMPLE_MINORS) {
        expect(wireAmountToMinorUnits(minorUnitsToWireAmount(minor, currency), currency)).toBe(minor);
        expect(parseWireAmount(formatWireAmount(minor, currency), currency)).toBe(minor);
        expect(defaultWireBridge.toMinorUnits(defaultWireBridge.fromMinorUnits(minor, currency), currency)).toBe(
          minor,
        );
      }
    }
  });

  it('跨编解码器往返同样恒等（M04 出 → K07 入 → F05 出 …）', () => {
    for (const currency of SHARED_CURRENCIES) {
      for (const minor of SAMPLE_MINORS) {
        const viaCart = minorUnitsToWireAmount(minor, currency);
        expect(parseWireAmount(viaCart, currency)).toBe(minor);
        expect(defaultWireBridge.toMinorUnits(viaCart, currency)).toBe(minor);
        const viaK07 = formatWireAmount(minor, currency);
        expect(wireAmountToMinorUnits(viaK07, currency)).toBe(minor);
        expect(defaultWireBridge.toMinorUnits(viaK07, currency)).toBe(minor);
      }
    }
  });
});

describe('M-I22 §2.3 已核实的口径分歧（如实登记，不假装一致）', () => {
  it('表外币种：M04 默认 2 位；K07 / F05 fail-closed 抛错', () => {
    expect(currencyExponent('ZZZ')).toBe(2);
    expect(minorUnitsToWireAmount(123, 'ZZZ')).toBe('1.23');
    expect(() => minorDigitsOf('ZZZ')).toThrow(AuthorizationError);
    expect(() => formatWireAmount(123, 'ZZZ')).toThrow(AuthorizationError);
    expect(() => defaultWireBridge.fromMinorUnits(123, 'ZZZ')).toThrow(WireBridgeError);
  });

  it('表外 0 位币种（BIF）：M04 认识并给 0 位；K07 / F05 直接拒绝', () => {
    expect(currencyExponent('BIF')).toBe(0);
    expect(minorUnitsToWireAmount(5, 'BIF')).toBe('5');
    expect(() => minorDigitsOf('BIF')).toThrow(AuthorizationError);
    expect(() => defaultWireBridge.fromMinorUnits(5, 'BIF')).toThrow(WireBridgeError);
  });

  it('分歧方向是"更严"而非"算错"：K07 / F05 拒绝的输入 M04 也不会给出错误位数', () => {
    // 对 M04 认识的 0 位币种，K07/F05 只是不认识而拒绝——不是算出不同结果。
    expect(() => minorDigitsOf('BIF')).toThrow();
    expect(currencyExponent('BIF')).toBe(0);
    // 3 位币种三方一致（无歧义）。
    expect(minorUnitsToWireAmount(1234, 'KWD')).toBe('1.234');
    expect(formatWireAmount(1234, 'KWD')).toBe('1.234');
    expect(defaultWireBridge.fromMinorUnits(1234, 'KWD')).toBe('1.234');
  });
});
