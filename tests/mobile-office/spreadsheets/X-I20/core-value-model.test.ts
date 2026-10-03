/**
 * **X-I20 集成验收（值模型）**：错误码枚举为读侧拓宽 + 空白不当零不变式。
 *
 * 本文件整合两条已披露残留：
 * 1. **X-I03 消费的错误码枚举**：`#SPILL!` 等现代代码必须由 `value.ts` 一等地拥有
 *    （而不是读侧各自 `as` 硬塞），同时 **经典枚举 `SPREADSHEET_ERROR_CODES` 保持恰好 7 个**
 *    ——X-R02 的「封闭集合相等」判据依赖这个长度，不能因拓宽而破坏它。
 * 2. **X08 / X02 依赖的"空白不当零"**：空白是**无值**，不是 0；取数必须显式失败。
 *
 * 判据落在真实调用上（真实构造函数 / 真实读格路径），不 mock。
 */

import { describe, expect, it } from 'vitest';

import { createCellsState, readCell, writeCell } from '../../../../src/spreadsheets/cells.js';
import { createSheet } from '../../../../src/spreadsheets/sheet.js';
import {
  ALL_SPREADSHEET_ERROR_CODES,
  MODERN_EXCEL_ERROR_CODES,
  SPREADSHEET_ERROR_CODES,
  blank,
  errorValue,
  isBlank,
  isError,
  isModernSpreadsheetErrorCode,
  isSpreadsheetErrorCode,
  numberValue,
  requireNumericValue,
  valuesEqual,
} from '../../../../src/spreadsheets/value.js';

describe('X-I20 / X-I03：错误码枚举由 value.ts 拥有，经典 7 保持封闭', () => {
  it('经典枚举恰 7 个（不可因拓宽而漂移）', () => {
    expect(SPREADSHEET_ERROR_CODES).toEqual([
      '#NULL!',
      '#DIV/0!',
      '#VALUE!',
      '#REF!',
      '#NAME?',
      '#NUM!',
      '#N/A',
    ]);
  });

  it('现代码（读侧）可经 errorValue 构造——不再是"绕过枚举的类型断言"', () => {
    // 这是 X-I03 读路径需要的形状：`{ kind: 'error', code: '#SPILL!' }` 是一等错误值。
    expect(errorValue('#SPILL!')).toEqual({ kind: 'error', code: '#SPILL!' });
    expect(isError(errorValue('#CALC!'))).toBe(true);
    expect(isModernSpreadsheetErrorCode('#SPILL!')).toBe(true);
    expect(MODERN_EXCEL_ERROR_CODES).toContain('#SPILL!');
    expect(MODERN_EXCEL_ERROR_CODES).toContain('#PYTHON!');
  });

  it('并集口径唯一：ALL = 经典 + 现代，且逐个可构造', () => {
    expect(ALL_SPREADSHEET_ERROR_CODES.length).toBe(
      SPREADSHEET_ERROR_CODES.length + MODERN_EXCEL_ERROR_CODES.length,
    );
    for (const code of ALL_SPREADSHEET_ERROR_CODES) {
      expect(errorValue(code).code).toBe(code);
    }
  });

  it('反向对照：真正未知的代码仍显式失败（拓宽 ≠ 什么都收）', () => {
    for (const bogus of ['#WAT!', '#SPILL', '#SPILL!!', 'SPILL']) {
      // @ts-expect-error 故意传非法代码
      expect(() => errorValue(bogus)).toThrow(/未知的电子表格错误值/);
      expect(isSpreadsheetErrorCode(bogus)).toBe(false);
    }
  });

  it('现代码在逐码比较里不与其它错误码混同', () => {
    expect(valuesEqual(errorValue('#SPILL!'), errorValue('#SPILL!'))).toBe(true);
    expect(valuesEqual(errorValue('#SPILL!'), errorValue('#CALC!'))).toBe(false);
    expect(valuesEqual(errorValue('#SPILL!'), blank)).toBe(false);
  });
});

describe('X-I20 / X08 / X02：空白不当零（读格路径上的真实落点）', () => {
  it('从未写入的格读回是 blank，不是 0；取数显式失败', () => {
    const state = createCellsState(createSheet('S'));
    const value = readCell(state, 'B7');
    expect(isBlank(value)).toBe(true);
    expect(valuesEqual(value, numberValue(0))).toBe(false);
    expect(() => requireNumericValue(value, 'S!B7')).toThrow(/不得当作 0|R248/);
  });

  it('对照：真正写入的 0 是合法数值，与空白是两回事', () => {
    const state = writeCell(createCellsState(createSheet('S')), 'A1', numberValue(0));
    expect(requireNumericValue(readCell(state, 'A1'))).toBe(0);
    expect(isBlank(readCell(state, 'A1'))).toBe(false);
    expect(isBlank(readCell(state, 'A2'))).toBe(true); // 从未写入
  });

  it('错误值 ≠ 空白：错误是"有值且为错误"，不冒充空白也不冒充数值', () => {
    const state = writeCell(createCellsState(createSheet('S')), 'A1', errorValue('#SPILL!'));
    const value = readCell(state, 'A1');
    expect(value).toEqual({ kind: 'error', code: '#SPILL!' });
    expect(isBlank(value)).toBe(false);
    expect(valuesEqual(value, blank)).toBe(false);
    expect(() => requireNumericValue(value)).toThrow(/错误值/);
  });
});
