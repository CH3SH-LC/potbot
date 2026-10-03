import { describe, expect, it } from 'vitest';

import {
  ALL_SPREADSHEET_ERROR_CODES,
  MODERN_EXCEL_ERROR_CODES,
  SPREADSHEET_ERROR_CODES,
  blank,
  booleanValue,
  cellTypeName,
  dateValue,
  errorValue,
  formulaValue,
  isBlank,
  isError,
  isFormula,
  isModernSpreadsheetErrorCode,
  isNumericCell,
  isSpreadsheetErrorCode,
  numberValue,
  requireNumericValue,
  textValue,
  valuesEqual,
  type CellValue,
} from './value.js';

describe('XLS-03：六类取值互相不冒充', () => {
  it('每一类都有自己的类别名，且守卫只认自己那一类', () => {
    const samples: readonly (readonly [CellValue, string])[] = [
      [numberValue(120), 'number'],
      [textValue('120'), 'text'],
      [booleanValue(true), 'boolean'],
      [dateValue(0), 'date'],
      [blank, 'blank'],
      [errorValue('#DIV/0!'), 'error'],
      [formulaValue('SUM(A1:A3)'), 'formula'],
    ];
    for (const [value, kind] of samples) {
      expect(cellTypeName(value)).toBe(kind);
    }
    expect(isNumericCell(numberValue(1))).toBe(true);
    expect(isNumericCell(textValue('1'))).toBe(false);
    expect(isNumericCell(formulaValue('1'))).toBe(false);
    expect(isBlank(blank)).toBe(true);
    expect(isError(errorValue('#REF!'))).toBe(true);
    expect(isFormula(formulaValue('A1'))).toBe(true);
  });

  it('valuesEqual 是类型严格的：数字 1 ≠ 文本 "1" ≠ 布尔 true', () => {
    expect(valuesEqual(numberValue(1), textValue('1'))).toBe(false);
    expect(valuesEqual(numberValue(1), booleanValue(true))).toBe(false);
    expect(valuesEqual(textValue('1'), booleanValue(true))).toBe(false);
    expect(valuesEqual(numberValue(1), numberValue(1))).toBe(true);
    expect(valuesEqual(textValue('1'), textValue('1'))).toBe(true);
  });

  it('blank 只等于 blank；date 按毫秒比较；error 按错误码比较', () => {
    expect(valuesEqual(blank, blank)).toBe(true);
    expect(valuesEqual(blank, numberValue(0))).toBe(false);
    expect(valuesEqual(blank, textValue(''))).toBe(false);
    expect(valuesEqual(dateValue(86_400_000), dateValue(86_400_000))).toBe(true);
    expect(valuesEqual(dateValue(0), numberValue(0))).toBe(false);
    expect(valuesEqual(errorValue('#REF!'), errorValue('#REF!'))).toBe(true);
    expect(valuesEqual(errorValue('#REF!'), errorValue('#N/A'))).toBe(false);
  });

  it('日期与数值不同类，即使二者内部都是"数"', () => {
    expect(dateValue(1).kind).not.toBe(numberValue(1).kind);
    expect(cellTypeName(dateValue(1))).toBe('date');
    expect(cellTypeName(numberValue(1))).toBe('number');
  });
});

describe('R248：缺失不当零——空白格取数必须显式失败', () => {
  it('空白单元格取数值 ⇒ 抛 ValidationError，且**绝不返回 0**', () => {
    expect(() => requireNumericValue(blank, '预算!B7')).toThrow(/不得当作 0/);
    expect(() => requireNumericValue(blank)).toThrow(/R248/);
  });

  it('对照：真正已知的 0 是合法数值，与空白是两回事', () => {
    expect(requireNumericValue(numberValue(0))).toBe(0);
    expect(isBlank(numberValue(0))).toBe(false);
    expect(valuesEqual(numberValue(0), blank)).toBe(false);
  });

  it('文本 / 布尔 / 日期 / 错误 / 公式都不得冒充数值', () => {
    expect(() => requireNumericValue(textValue('12'))).toThrow(/不得冒充数值/);
    expect(() => requireNumericValue(booleanValue(true))).toThrow(/不得冒充数值/);
    expect(() => requireNumericValue(dateValue(0))).toThrow(/不得冒充数值/);
    expect(() => requireNumericValue(errorValue('#VALUE!'))).toThrow(/错误值/);
    expect(() => requireNumericValue(formulaValue('A1+1'))).toThrow(/不得冒充数值/);
  });
});

describe('构造期不变量', () => {
  it('数值只接受有限数（NaN / Infinity 写不进电子表格）', () => {
    expect(() => numberValue(Number.NaN)).toThrow(/有限数/);
    expect(() => numberValue(Number.POSITIVE_INFINITY)).toThrow(/有限数/);
  });

  it('日期只接受有限毫秒数', () => {
    expect(() => dateValue(Number.NaN)).toThrow(/有限毫秒数/);
  });

  it('错误值只接受枚举内的代码', () => {
    for (const code of SPREADSHEET_ERROR_CODES) {
      expect(errorValue(code).code).toBe(code);
    }
    // @ts-expect-error 故意传非法代码，验证运行期也挡得住
    expect(() => errorValue('#BOGUS!')).toThrow(/未知的电子表格错误值/);
  });

  it('公式文本不能为空', () => {
    expect(() => formulaValue('')).toThrow(/不能为空/);
  });
});

describe('X-I20：错误码枚举为读侧拓宽（经典 7 保持封闭）', () => {
  it('经典枚举仍**恰好 7 个**（X-R02 的封闭集合判据依赖这个长度）', () => {
    expect(SPREADSHEET_ERROR_CODES.length).toBe(7);
  });

  it('并集 = 经典 7 + 现代 9，且每个都是 errorValue 可构造的一等错误值', () => {
    expect(MODERN_EXCEL_ERROR_CODES.length).toBe(9);
    expect(ALL_SPREADSHEET_ERROR_CODES.length).toBe(SPREADSHEET_ERROR_CODES.length + MODERN_EXCEL_ERROR_CODES.length);
    // 逐个构造：现代码不再是"绕过枚举硬塞进去"，而是 errorValue 接受的值
    for (const code of ALL_SPREADSHEET_ERROR_CODES) {
      expect(errorValue(code).code).toBe(code);
      expect(isSpreadsheetErrorCode(code)).toBe(true);
    }
    expect(errorValue('#SPILL!')).toEqual({ kind: 'error', code: '#SPILL!' });
  });

  it('isModernSpreadsheetErrorCode 只认现代码；经典码不算', () => {
    expect(isModernSpreadsheetErrorCode('#SPILL!')).toBe(true);
    expect(isModernSpreadsheetErrorCode('#PYTHON!')).toBe(true);
    expect(isModernSpreadsheetErrorCode('#DIV/0!')).toBe(false);
    expect(isModernSpreadsheetErrorCode('nonsense')).toBe(false);
    expect(isSpreadsheetErrorCode('#N/A')).toBe(true);
    expect(isSpreadsheetErrorCode('nonsense')).toBe(false);
  });

  it('真正未知的错误码仍然显式失败（拓宽不是"什么都收"）', () => {
    // @ts-expect-error 故意传非法代码
    expect(() => errorValue('#WAT!')).toThrow(/未知的电子表格错误值/);
    // @ts-expect-error 故意传非法代码
    expect(() => errorValue('#SPILL')).toThrow(/未知的电子表格错误值/);
  });

  it('现代错误值参与 valuesEqual 的逐码比较（不把 #SPILL! 当成 #CALC!）', () => {
    expect(valuesEqual(errorValue('#SPILL!'), errorValue('#SPILL!'))).toBe(true);
    expect(valuesEqual(errorValue('#SPILL!'), errorValue('#CALC!'))).toBe(false);
    expect(valuesEqual(errorValue('#SPILL!'), blank)).toBe(false);
  });
});
