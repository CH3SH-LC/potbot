/**
 * M-I22 §1：领域 → wire 的金额字符串必须**属于**冻结契约 `confirm-action.schema.json`
 * 的 `amount` 语言，而且是它的**真子集**（"strictly stricter than wire"）。
 *
 * 关键纪律：schema 正则**运行时**从冻结文件读出并现场 `new RegExp`，不在测试里另抄
 * pattern。若有人改了契约，本文件会跟着变——不会出现"测试与契约各自漂移还都绿"。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CURRENCY_EXPONENT,
  currencyExponent,
  minorUnitsToWireAmount,
  wireAmountToMinorUnits,
} from '../../../src/mobile-plugins/meituan/cart/index.js';
import { MINOR_WIRE_CASES, loadConfirmActionSchema, loadWirePatterns } from './support.js';

describe('M-I22 §1 冻结 schema 的读取与形状', () => {
  it('确实读到了 confirm-action 契约（防止路径写错导致空验证假绿）', () => {
    const schema = loadConfirmActionSchema();
    expect(schema.$id).toBe('contracts/mobile-v1/schemas/confirm-action.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('amount');
    expect(schema.required).toContain('currency');
  });

  it('wire amount 语言是十进制字符串，且允许 1~4 位小数（本套件的"更严"基准）', () => {
    const { amount } = loadWirePatterns();
    expect(amount.source).toBe('^[0-9]+(\\.[0-9]{1,4})?$');
    // 基准语言确实宽于我们：整数元、1~4 位小数都被 wire 接受。
    for (const accepted of ['0', '5', '88', '12.3', '12.34', '1.234', '0.1234']) {
      expect(amount.test(accepted), `wire 应接受 ${accepted}`).toBe(true);
    }
    for (const rejected of ['', '-1', '+1', '1.', '.5', '1e3', ' 1', '1 ', '1,5', '1.23456', '1.2.3']) {
      expect(amount.test(rejected), `wire 应拒绝 ${JSON.stringify(rejected)}`).toBe(false);
    }
  });
});

describe('M-I22 §1 我们的输出属于 wire 语言', () => {
  it('每条 (最小单位, 币种) 的 wire 输出都匹配契约 amount / currency 正则', () => {
    const { amount, currency } = loadWirePatterns();
    for (const { minor, currency: code, wire } of MINOR_WIRE_CASES) {
      const produced = minorUnitsToWireAmount(minor, code);
      expect(produced, `${minor} ${code}`).toBe(wire);
      expect(amount.test(produced), `${produced} 不匹配契约 amount 正则`).toBe(true);
      expect(currency.test(code), `${code} 不匹配契约 currency 正则`).toBe(true);
    }
  });

  it('小数位数**恰好**等于币种位数（比 wire 的 1~4 位更窄）', () => {
    for (const { minor, currency } of MINOR_WIRE_CASES) {
      const produced = minorUnitsToWireAmount(minor, currency);
      const exponent = currencyExponent(currency);
      const producedDigits = produced.includes('.') ? (produced.split('.')[1] ?? '').length : 0;
      expect(producedDigits, `${produced} @ ${currency}`).toBe(exponent);
    }
  });
});

describe('M-I22 §1 我们严格更严（wire 接受而我们拒绝）', () => {
  it('存在 wire 合法但非零超精度的串，对固定位数币种必须被我们拒绝', () => {
    const { amount } = loadWirePatterns();
    // wire 语言接受三种不同位数的字符串……
    expect(amount.test('1.234')).toBe(true);
    expect(amount.test('5.5')).toBe(true);
    expect(amount.test('1.2345')).toBe(true);
    // ……但换成"位数由币种决定"的我们，同样输入一律拒（不截断、不四舍五入）。
    expect(() => wireAmountToMinorUnits('1.234', 'CNY')).toThrow();
    expect(() => wireAmountToMinorUnits('5.5', 'JPY')).toThrow();
    expect(() => wireAmountToMinorUnits('1.2345', 'KWD')).toThrow();
    // 且 JPY 不会被打成小数、CNY 不会被当成 3 位。
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('CNY')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
    expect(DEFAULT_CURRENCY_EXPONENT).toBe(2);
  });

  it('更强的一步：我们的解析语言 ⊂ wire 语言（对每个 wire 形状串做包含检查）', () => {
    const { amount } = loadWirePatterns();
    // 穷举 wire 形状的一批代表串：凡我们能解析的，wire 必须也接受。
    const candidates = [
      '0',
      '5',
      '88',
      '0.1',
      '0.05',
      '12.34',
      '1.2300',
      '0.1234',
      '000.00',
      '007.50',
      '9999999.99',
    ];
    for (const candidate of candidates) {
      let accepted = true;
      try {
        wireAmountToMinorUnits(candidate, 'CNY');
      } catch {
        accepted = false;
      }
      if (accepted) {
        expect(amount.test(candidate), `我们能解析 ${candidate}，wire 却拒绝`).toBe(true);
      }
    }
  });

  it('我们生成的 wire 串永不超过币种位数（即便 wire 允许到 4 位）', () => {
    const { amount } = loadWirePatterns();
    for (const minor of [0, 1, 5, 99, 100, 1234, 99999999, 999999999]) {
      for (const currency of ['CNY', 'JPY', 'KWD']) {
        const produced = minorUnitsToWireAmount(minor, currency);
        expect(amount.test(produced), produced).toBe(true);
        const digits = produced.includes('.') ? (produced.split('.')[1] ?? '').length : 0;
        expect(digits, `${produced} @ ${currency}`).toBeLessThanOrEqual(currencyExponent(currency));
      }
    }
  });
});
