/**
 * M04 独立验收：**领域 ↔ wire 金额边界换算**。
 *
 * 依据 `contracts/mobile-v1/README.md`「金额与时间编码（总协调裁决，2026-10-03）」：
 * 领域层用整数最小单位，wire 层用十进制字符串，**换算只在边界发生且必须精确**，
 * 小数位数**由币种决定**。该裁决点名当事包为 K07 与 **M04**。
 *
 * 本文件刻意**不经过会话**先单独验证换算原语，再用一个真实 fixture 报价把原语
 * 与领域对象接起来；最后把输出与**冻结的 contract schema 正则**对照，防止自证。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CartValidationError,
  DEFAULT_CURRENCY_EXPONENT,
  currencyExponent,
  formatMinorUnitsAsDecimalString,
  minorUnitsToWireAmount,
  wireAmountToMinorUnits,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { createScenario, fillStandardCart } from './support.js';

/** 从冻结契约里读出 wire 金额/币种正则，而不是在测试里另写一份。 */
function loadContractPatterns(): { readonly amount: RegExp; readonly currency: RegExp } {
  const path = fileURLToPath(
    new URL('../../../contracts/mobile-v1/schemas/confirm-action.schema.json', import.meta.url),
  );
  const schema = JSON.parse(readFileSync(path, 'utf8')) as {
    $defs: { amount: { pattern: string }; currency: { pattern: string } };
  };
  return {
    amount: new RegExp(schema.$defs.amount.pattern),
    currency: new RegExp(schema.$defs.currency.pattern),
  };
}

describe('M04 边界换算：币种小数位', () => {
  it('常见币种小数位正确，表外币种按默认 2 位且如实声明', () => {
    expect(currencyExponent('CNY')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
    // 表外币种不是「0 位」也不是「报错」，而是默认 2 位（有据可查的约定）。
    expect(currencyExponent('ZZZ')).toBe(DEFAULT_CURRENCY_EXPONENT);
    expect(DEFAULT_CURRENCY_EXPONENT).toBe(2);
  });

  it('非法币种一律拒绝', () => {
    expect(() => currencyExponent('cny')).toThrow(CartValidationError);
    expect(() => currencyExponent('CN')).toThrow(CartValidationError);
    expect(() => currencyExponent('CNYY')).toThrow(CartValidationError);
    expect(() => currencyExponent('')).toThrow(CartValidationError);
  });
});

describe('M04 边界换算：领域 → wire（位数随币种）', () => {
  it('CNY 保留两位，含前导 0', () => {
    expect(minorUnitsToWireAmount(5, 'CNY')).toBe('0.05');
    expect(minorUnitsToWireAmount(0, 'CNY')).toBe('0.00');
    expect(minorUnitsToWireAmount(8800, 'CNY')).toBe('88.00');
    expect(minorUnitsToWireAmount(1234, 'CNY')).toBe('12.34');
  });

  it('JPY（0 位）不出现小数点', () => {
    expect(minorUnitsToWireAmount(5, 'JPY')).toBe('5');
    expect(minorUnitsToWireAmount(0, 'JPY')).toBe('0');
    expect(minorUnitsToWireAmount(1234, 'JPY')).toBe('1234');
  });

  it('KWD（3 位）按三位输出', () => {
    expect(minorUnitsToWireAmount(1234, 'KWD')).toBe('1.234');
    expect(minorUnitsToWireAmount(5, 'KWD')).toBe('0.005');
  });

  it('非整数 / 负 / NaN 金额拒绝（不取整、不四舍五入）', () => {
    expect(() => minorUnitsToWireAmount(1.5, 'CNY')).toThrow(CartValidationError);
    expect(() => minorUnitsToWireAmount(-1, 'CNY')).toThrow(CartValidationError);
    expect(() => minorUnitsToWireAmount(Number.NaN, 'CNY')).toThrow(CartValidationError);
    expect(() => minorUnitsToWireAmount(Number.POSITIVE_INFINITY, 'CNY')).toThrow(CartValidationError);
  });

  it('输出与冻结契约的 amount / currency 正则一致', () => {
    const { amount, currency } = loadContractPatterns();
    const samples = [
      minorUnitsToWireAmount(5, 'CNY'),
      minorUnitsToWireAmount(0, 'CNY'),
      minorUnitsToWireAmount(8800, 'CNY'),
      minorUnitsToWireAmount(1234, 'KWD'),
      minorUnitsToWireAmount(5, 'JPY'),
    ];
    for (const value of samples) {
      expect(amount.test(value), `${value} 不匹配契约 amount 正则`).toBe(true);
    }
    expect(currency.test('CNY')).toBe(true);
    expect(currency.test('KWD')).toBe(true);
  });
});

describe('M04 边界换算：wire → 领域（逐位解析，精确）', () => {
  it('基本解析', () => {
    expect(wireAmountToMinorUnits('0.05', 'CNY')).toBe(5);
    expect(wireAmountToMinorUnits('88.00', 'CNY')).toBe(8800);
    expect(wireAmountToMinorUnits('12.34', 'CNY')).toBe(1234);
    expect(wireAmountToMinorUnits('0.1', 'CNY')).toBe(10);
    // 无小数点 = 整数元。
    expect(wireAmountToMinorUnits('88', 'CNY')).toBe(8800);
  });

  it('尾随零不算超精度，但非零超精度必须抛错', () => {
    expect(wireAmountToMinorUnits('1.2300', 'CNY')).toBe(123);
    expect(wireAmountToMinorUnits('1.2000', 'CNY')).toBe(120);
    expect(() => wireAmountToMinorUnits('1.234', 'CNY')).toThrow(/超过币种 CNY 的 2 位/);
    expect(() => wireAmountToMinorUnits('1.005', 'CNY')).toThrow(CartValidationError);
  });

  it('JPY 只接受整数元', () => {
    expect(wireAmountToMinorUnits('5', 'JPY')).toBe(5);
    expect(wireAmountToMinorUnits('5.00', 'JPY')).toBe(5);
    expect(() => wireAmountToMinorUnits('5.5', 'JPY')).toThrow(CartValidationError);
  });

  it('KWD 接受三位', () => {
    expect(wireAmountToMinorUnits('1.234', 'KWD')).toBe(1234);
    expect(() => wireAmountToMinorUnits('1.2345', 'KWD')).toThrow(CartValidationError);
  });

  it('前导零与全零', () => {
    expect(wireAmountToMinorUnits('000.00', 'CNY')).toBe(0);
    expect(wireAmountToMinorUnits('007.50', 'CNY')).toBe(750);
  });

  it('形状非法一律拒绝（不做宽松解析）', () => {
    for (const bad of ['', '-1', '+1', '1.', '.5', '1e3', ' 1', '1 ', '1,5', 'abc', '1.23456', '1.2.3']) {
      expect(() => wireAmountToMinorUnits(bad, 'CNY'), `应拒绝 ${JSON.stringify(bad)}`).toThrow(
        CartValidationError,
      );
    }
    expect(() => wireAmountToMinorUnits(null as unknown as string, 'CNY')).toThrow(CartValidationError);
    expect(() => wireAmountToMinorUnits(1234 as unknown as string, 'CNY')).toThrow(CartValidationError);
  });

  it('超出安全整数范围时拒绝（不静默丢精度）', () => {
    expect(() => wireAmountToMinorUnits('9007199254740993', 'JPY')).toThrow(/安全整数范围/);
  });

  it('我们比 wire 更严：wire 允许 4 位小数，但会丢精度的币种组合被拒绝', () => {
    const { amount } = loadContractPatterns();
    // 契约正则本身接受 '1.234'（1~4 位），但对 CNY 而言这会产生非零超精度 ⇒ 我们必须拒绝。
    expect(amount.test('1.234')).toBe(true);
    expect(() => wireAmountToMinorUnits('1.234', 'CNY')).toThrow(CartValidationError);
  });
});

describe('M04 边界换算：往返一致（无浮点）', () => {
  it('领域 → wire → 领域 恒等', () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, 'CNY'],
      [1, 'CNY'],
      [5, 'CNY'],
      [99, 'CNY'],
      [100, 'CNY'],
      [999999999, 'CNY'],
      [7, 'JPY'],
      [123456, 'JPY'],
      [1234, 'KWD'],
      [1, 'KWD'],
    ];
    for (const [minor, currency] of cases) {
      const wire = minorUnitsToWireAmount(minor, currency);
      expect(wireAmountToMinorUnits(wire, currency), `${minor} ${currency} via ${wire}`).toBe(minor);
    }
  });

  it('wire → 领域 → wire 归一化恒等（补零到币种位数）', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['0.05', '0.05'],
      ['0.00', '0.00'],
      ['88.00', '88.00'],
      ['12.34', '12.34'],
      ['0.1', '0.10'],
      ['88', '88.00'],
      ['1.2300', '1.23'],
    ];
    for (const [wire, normalized] of cases) {
      expect(minorUnitsToWireAmount(wireAmountToMinorUnits(wire, 'CNY'), 'CNY')).toBe(normalized);
    }
  });

  it('0.1 + 0.2：走边界也不出现浮点污染', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const a = wireAmountToMinorUnits('0.1', 'CNY');
    const b = wireAmountToMinorUnits('0.2', 'CNY');
    expect(a + b).toBe(30);
    expect(minorUnitsToWireAmount(a + b, 'CNY')).toBe('0.30');
  });

  it('大额整数仍精确（不经过浮点累加）', () => {
    // 9999999.99 元 = 999999999 分，仍在安全整数范围内且往返精确。
    expect(wireAmountToMinorUnits('9999999.99', 'CNY')).toBe(999999999);
    expect(minorUnitsToWireAmount(999999999, 'CNY')).toBe('9999999.99');
  });
});

describe('M04 边界换算：与领域报价对接', () => {
  it('fixture 报价的整数金额可精确渲染成 wire 字符串并解析回原值', async () => {
    const scenario = createScenario();
    fillStandardCart(scenario.session);
    const quote = await scenario.session.requestQuote();

    // 面条 3800×2 + 茶 800×1 = 8400；打包费 100 + 配送费 300 = 400 ⇒ 8800 分。
    expect(quote.amount).toBe(8800);
    const wire = minorUnitsToWireAmount(quote.amount, quote.currency);
    expect(wire).toBe('88.00');
    expect(wireAmountToMinorUnits(wire, quote.currency)).toBe(quote.amount);
    // 币种字符串也满足契约的 `^[A-Z]{3}$`。
    expect(loadContractPatterns().currency.test(quote.currency)).toBe(true);
  });

  it('历史函数 formatMinorUnitsAsDecimalString 对 CNY 行为不变，且对其它币种正确', () => {
    expect(formatMinorUnitsAsDecimalString(30, 'CNY')).toBe('0.30');
    expect(formatMinorUnitsAsDecimalString(30, 'CNY')).toBe(minorUnitsToWireAmount(30, 'CNY'));
    expect(formatMinorUnitsAsDecimalString(1234, 'JPY')).toBe('1234');
    expect(formatMinorUnitsAsDecimalString(1234, 'KWD')).toBe('1.234');
    expect(() => formatMinorUnitsAsDecimalString(12.34, 'CNY')).toThrow(CartValidationError);
  });
});
