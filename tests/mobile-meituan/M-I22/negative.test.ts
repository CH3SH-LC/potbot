/**
 * M-I22 §5：统一负向对照。**同一批坏输入，三个编解码器必须一致拒绝**——
 * 单位小数位、非零超精度、形状非法、安全整数溢出、浮点污染。
 *
 * 若某一方"宽容放过"，那它就是金额判据里的暗门：同一笔金额会因为走哪条编解码路径
 * 而被接受或拒绝。所以本文件的断言都是**三方并列**的。
 */

import { describe, expect, it } from 'vitest';

import { AuthorizationError } from '../../../apps/mobile-kernel/actions/index.js';
import { formatWireAmount, minorDigitsOf, parseWireAmount } from '../../../apps/mobile-kernel/actions/index.js';
import { defaultWireBridge, WireBridgeError } from '../../../apps/mobile-ui/src/decisions/trust.js';
import {
  CartValidationError,
  asMinorUnits as cartAsMinorUnits,
  currencyExponent,
  minorUnitsToWireAmount,
  wireAmountToMinorUnits,
} from '../../../src/mobile-plugins/meituan/cart/index.js';

/** wire 语言合法、但对某个币种不可精确表示的串。 */
const SHAPE_VALID_BUT_LOSSY: readonly { readonly wire: string; readonly currency: string; readonly why: string }[] = Object.freeze([
  { wire: '1.234', currency: 'CNY', why: 'CNY 只有 2 位，末位 4 非零' },
  { wire: '1.005', currency: 'CNY', why: 'CNY 只有 2 位，末位 5 非零' },
  { wire: '5.5', currency: 'JPY', why: 'JPY 0 位，不接受任何小数' },
  { wire: '1.2345', currency: 'KWD', why: 'KWD 只有 3 位，末位 5 非零' },
]);

/** 形状本身就不合法的串（三个编解码器都该拒）。 */
const SHAPE_INVALID: readonly string[] = Object.freeze([
  '',
  '-1',
  '+1',
  '1.',
  '.5',
  '1e3',
  ' 1',
  '1 ',
  '1,5',
  'abc',
  '1.23456',
  '1.2.3',
  '1.2.3.4',
]);

describe('M-I22 §5.1 非零超精度按币种拒绝（三方一致）', () => {
  it("'1.234' 对 CNY 一律拒（wire 接受，我们更严）", () => {
    expect(() => wireAmountToMinorUnits('1.234', 'CNY')).toThrow(CartValidationError);
    expect(() => parseWireAmount('1.234', 'CNY')).toThrow(AuthorizationError);
    expect(() => defaultWireBridge.toMinorUnits('1.234', 'CNY')).toThrow(WireBridgeError);
  });

  it('每条 shape-valid-but-lossy 输入三方都是拒绝', () => {
    for (const { wire, currency, why } of SHAPE_VALID_BUT_LOSSY) {
      expect(() => wireAmountToMinorUnits(wire, currency), `M04: ${wire} ${currency}（${why}）`).toThrow();
      expect(() => parseWireAmount(wire, currency), `K07: ${wire} ${currency}（${why}）`).toThrow();
      expect(() => defaultWireBridge.toMinorUnits(wire, currency), `F05: ${wire} ${currency}（${why}）`).toThrow();
    }
  });
});

describe('M-I22 §5.2 币种小数位：JPY=0 / CNY=2 / KWD=3', () => {
  it('位数判定三方一致', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(minorDigitsOf('JPY')).toBe(0);
    expect(currencyExponent('CNY')).toBe(2);
    expect(minorDigitsOf('CNY')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(minorDigitsOf('KWD')).toBe(3);
  });

  it('JPY（0 位）：无小数点，任何小数位一律拒', () => {
    expect(minorUnitsToWireAmount(5, 'JPY')).toBe('5');
    expect(formatWireAmount(5, 'JPY')).toBe('5');
    expect(defaultWireBridge.fromMinorUnits(5, 'JPY')).toBe('5');
    expect(minorUnitsToWireAmount(5, 'JPY')).not.toContain('.');

    expect(wireAmountToMinorUnits('5', 'JPY')).toBe(5);
    expect(wireAmountToMinorUnits('5.00', 'JPY')).toBe(5); // 尾随零不算超精度
    expect(() => wireAmountToMinorUnits('5.5', 'JPY')).toThrow();
    expect(() => parseWireAmount('5.5', 'JPY')).toThrow();
    expect(() => defaultWireBridge.toMinorUnits('5.5', 'JPY')).toThrow();
  });

  it('KWD（3 位）：接受三位，第四位非零即拒', () => {
    expect(minorUnitsToWireAmount(1234, 'KWD')).toBe('1.234');
    expect(wireAmountToMinorUnits('1.234', 'KWD')).toBe(1234);
    expect(parseWireAmount('1.234', 'KWD')).toBe(1234);
    expect(defaultWireBridge.toMinorUnits('1.234', 'KWD')).toBe(1234);
    expect(() => wireAmountToMinorUnits('1.2345', 'KWD')).toThrow();
    expect(() => parseWireAmount('1.2345', 'KWD')).toThrow();
    expect(() => defaultWireBridge.toMinorUnits('1.2345', 'KWD')).toThrow();
  });
});

describe('M-I22 §5.3 形状非法一律拒（三方一致，不做宽松解析）', () => {
  it('每条非法串三方都是拒绝', () => {
    for (const bad of SHAPE_INVALID) {
      expect(() => wireAmountToMinorUnits(bad, 'CNY'), `M04: ${JSON.stringify(bad)}`).toThrow();
      expect(() => parseWireAmount(bad, 'CNY'), `K07: ${JSON.stringify(bad)}`).toThrow();
      expect(() => defaultWireBridge.toMinorUnits(bad, 'CNY'), `F05: ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('非字符串输入也一律拒', () => {
    for (const bad of [null, 1234, undefined, {}, []]) {
      expect(() => wireAmountToMinorUnits(bad as unknown as string, 'CNY')).toThrow();
      expect(() => parseWireAmount(bad, 'CNY')).toThrow();
      expect(() => defaultWireBridge.toMinorUnits(bad as unknown as string, 'CNY')).toThrow();
    }
  });
});

describe('M-I22 §5.4 安全整数溢出拒绝（不静默丢精度）', () => {
  it('wire 解析溢出三方一致拒', () => {
    expect(() => wireAmountToMinorUnits('9007199254740993', 'JPY')).toThrow(/安全整数范围/);
    expect(() => parseWireAmount('9007199254740993', 'JPY')).toThrow(AuthorizationError);
    expect(() => defaultWireBridge.toMinorUnits('9007199254740993', 'JPY')).toThrow(WireBridgeError);
  });

  it('领域 → wire 的溢出输入三方一致拒', () => {
    const tooBig = Number.MAX_SAFE_INTEGER + 1;
    expect(() => minorUnitsToWireAmount(tooBig, 'CNY')).toThrow(CartValidationError);
    expect(() => formatWireAmount(tooBig, 'CNY')).toThrow(AuthorizationError);
    expect(() => defaultWireBridge.fromMinorUnits(tooBig, 'CNY')).toThrow(WireBridgeError);
    expect(() => cartAsMinorUnits(tooBig, 'amount')).toThrow(CartValidationError);
  });
});

describe('M-I22 §5.5 浮点污染 0.1 + 0.2', () => {
  it('浮点世界本身就错（对照基准）', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('走 M04 边界：0.1 + 0.2 精确等于 30 分，回写 "0.30"', () => {
    const a = wireAmountToMinorUnits('0.1', 'CNY');
    const b = wireAmountToMinorUnits('0.2', 'CNY');
    expect(a + b).toBe(30);
    expect(minorUnitsToWireAmount(a + b, 'CNY')).toBe('0.30');
  });

  it('走 K07 / F05 边界得到同一结果', () => {
    const k07a = parseWireAmount('0.1', 'CNY');
    const k07b = parseWireAmount('0.2', 'CNY');
    expect(k07a + k07b).toBe(30);
    expect(formatWireAmount(k07a + k07b, 'CNY')).toBe('0.30');

    const f05a = defaultWireBridge.toMinorUnits('0.1', 'CNY');
    const f05b = defaultWireBridge.toMinorUnits('0.2', 'CNY');
    expect(f05a + f05b).toBe(30);
    expect(defaultWireBridge.fromMinorUnits(f05a + f05b, 'CNY')).toBe('0.30');
  });

  it('浮点值本身（非整数最小单位）三方一致拒——绝不被四舍五入"修好"', () => {
    expect(() => cartAsMinorUnits(0.1 + 0.2, 'amount')).toThrow(CartValidationError);
    expect(() => minorUnitsToWireAmount(123.45, 'CNY')).toThrow(CartValidationError);
    expect(() => formatWireAmount(123.45, 'CNY')).toThrow(AuthorizationError);
    expect(() => defaultWireBridge.fromMinorUnits(123.45, 'CNY')).toThrow(WireBridgeError);
  });
});
