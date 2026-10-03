/**
 * `excel-date.ts` 的单元测试（design-06-P8 / XLS-05）。
 *
 * 判据是**与 Excel 一致的锚点**（1970-01-01 = 25569）与**往返无损**，以及"哪些数字格式算日期"。
 */

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_DATE_NUMFMT_IDS,
  EXCEL_EPOCH_MS,
  MS_PER_DAY,
  fromExcelSerial,
  isBuiltinDateFormatId,
  isDateFormatCode,
  toExcelSerial,
} from './excel-date.js';

describe('excel-date：序列号锚点', () => {
  it('1970-01-01 是第 25569 天（与 Excel 一致）', () => {
    expect(toExcelSerial(0)).toBe(25569);
    expect(fromExcelSerial(25569)).toBe(0);
  });

  it('一天是一整天：86400000 毫秒 ⇔ 序列号 +1', () => {
    expect(toExcelSerial(MS_PER_DAY)).toBe(25570);
    expect(fromExcelSerial(25570)).toBe(MS_PER_DAY);
  });

  it('小数部分当作当天时刻', () => {
    expect(toExcelSerial(43_200_000)).toBe(25569.5); // 正午
    expect(fromExcelSerial(25569.5)).toBe(43_200_000);
  });

  it('负的 epoch 毫秒（1969）也在范围内', () => {
    expect(toExcelSerial(-MS_PER_DAY)).toBe(25568);
    expect(fromExcelSerial(25568)).toBe(-MS_PER_DAY);
  });

  it('往返无损：往返后回到**同一毫秒**', () => {
    for (const epochMs of [0, 1, 1_700_000_000_000, 1_699_999_999_999, -1_000_000_000]) {
      expect(fromExcelSerial(toExcelSerial(epochMs))).toBe(epochMs);
    }
  });

  it('原点是 1899-12-30（文档化的常量，不是魔数散落各处）', () => {
    expect(EXCEL_EPOCH_MS).toBe(-2_209_161_600_000);
    expect(fromExcelSerial(0)).toBe(EXCEL_EPOCH_MS);
  });

  it('非有限数显式抛（不静默变成 NaN 序列号）', () => {
    expect(() => toExcelSerial(Number.NaN)).toThrow();
    expect(() => toExcelSerial(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => fromExcelSerial(Number.NaN)).toThrow();
  });
});

describe('excel-date：哪些格式算日期', () => {
  it('内建日期 id 集合是 ECMA-376 的 14–22 与 45–47', () => {
    expect([...BUILTIN_DATE_NUMFMT_IDS]).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
    expect(isBuiltinDateFormatId(14)).toBe(true);
    expect(isBuiltinDateFormatId(22)).toBe(true);
    expect(isBuiltinDateFormatId(0)).toBe(false);
    expect(isBuiltinDateFormatId(49)).toBe(false); // 49 = 文本格式
  });

  it('自定义格式码：含 y/m/d/h/s 判为日期', () => {
    expect(isDateFormatCode('m/d/yyyy')).toBe(true);
    expect(isDateFormatCode('yyyy"年"m"月"')).toBe(true);
    expect(isDateFormatCode('[h]:mm:ss')).toBe(true);
    expect(isDateFormatCode('[$-409]d-mmm-yy;@')).toBe(true);
  });

  it('数值 / 文本 / 百分比格式**不是**日期', () => {
    expect(isDateFormatCode('General')).toBe(false);
    expect(isDateFormatCode('0.00')).toBe(false);
    expect(isDateFormatCode('#,##0')).toBe(false);
    expect(isDateFormatCode('0%')).toBe(false);
    expect(isDateFormatCode('')).toBe(false);
  });

  it('字面量与转义字符里的字母不参与判定', () => {
    expect(isDateFormatCode('"m"0')).toBe(false); // m 在字面量里
    expect(isDateFormatCode('0.00\\m')).toBe(false); // m 被转义
    expect(isDateFormatCode('[Red]0.00')).toBe(false); // 颜色区段里的 Red 不算
  });
});
