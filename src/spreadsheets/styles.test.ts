import { describe, expect, it } from 'vitest';

import { createSheet, getCellValue, setCellValue } from './sheet.js';
import {
  MAX_STYLE_RANGE_CELLS,
  applyRangeStyle,
  clearCellStyle,
  clearRangeStyle,
  displayCell,
  emptyCellStyles,
  formatCellDisplay,
  formatDatePattern,
  getCellStyle,
  mergeCellStyle,
  migrateCellStyles,
  normalizeColor,
  setCellStyle,
  type CellStyle,
} from './styles.js';
import {
  blank,
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  numberValue,
  requireNumericValue,
  textValue,
  valuesEqual,
} from './value.js';

/** 造一张带单个单元格的表（省得每个用例重复三行）。 */
function sheetWith(address: string, value: ReturnType<typeof numberValue>) {
  return setCellValue(createSheet('S'), address, value);
}

describe('XLS-05 样式属性：字体 / 边框 / 底纹 / 对齐 / 换行 / 缩进', () => {
  it('整份样式可逐项读回，颜色被规范化为大写 #RRGGBB', () => {
    const style: CellStyle = {
      bold: true,
      italic: true,
      font_family: 'Calibri',
      font_size: 12,
      font_color: '#ff0000',
      fill_color: '00ff00',
      horizontal_align: 'center',
      vertical_align: 'middle',
      wrap_text: true,
      indent: 2,
      borders: {
        top: { style: 'thin', color: '#000000' },
        bottom: { style: 'double', color: null },
      },
      number_format: { kind: 'percent', decimals: 1 },
    };
    const styles = setCellStyle(emptyCellStyles, 'B2', style);
    const read = getCellStyle(styles, 'B2');
    expect(read).toBeDefined();
    expect(read?.bold).toBe(true);
    expect(read?.italic).toBe(true);
    expect(read?.font_family).toBe('Calibri');
    expect(read?.font_size).toBe(12);
    expect(read?.font_color).toBe('#FF0000');
    expect(read?.fill_color).toBe('#00FF00');
    expect(read?.horizontal_align).toBe('center');
    expect(read?.vertical_align).toBe('middle');
    expect(read?.wrap_text).toBe(true);
    expect(read?.indent).toBe(2);
    expect(read?.borders?.top).toEqual({ style: 'thin', color: '#000000' });
    expect(read?.borders?.bottom).toEqual({ style: 'double', color: null });
  });

  it('mergeCellStyle 只改 patch 里出现的项（局部修改）', () => {
    let styles = setCellStyle(emptyCellStyles, 'A1', { font_size: 10, italic: true });
    styles = mergeCellStyle(styles, 'A1', { bold: true });
    const read = getCellStyle(styles, 'A1');
    expect(read?.bold).toBe(true);
    expect(read?.italic).toBe(true); // 未被 patch 覆盖
    expect(read?.font_size).toBe(10); // 未被 patch 覆盖
  });

  it('未设置的格没有样式（缺省 ≠ 空样式对象）；clearCellStyle 回到未设置', () => {
    expect(getCellStyle(emptyCellStyles, 'Z9')).toBeUndefined();
    const styles = setCellStyle(emptyCellStyles, 'A1', { bold: true });
    expect(getCellStyle(styles, 'A1')).toBeDefined();
    expect(getCellStyle(clearCellStyle(styles, 'A1'), 'A1')).toBeUndefined();
  });

  it('非法样式显式抛（不静默吞掉）', () => {
    expect(() => normalizeColor('red')).toThrow(/RRGGBB/);
    expect(() => normalizeColor('#12345')).toThrow(/RRGGBB/);
    expect(() => setCellStyle(emptyCellStyles, 'A1', { font_size: 0 })).toThrow(/正有限数/);
    expect(() => setCellStyle(emptyCellStyles, 'A1', { font_size: -3 })).toThrow(/正有限数/);
    // @ts-expect-error 故意传非法对齐值，验证运行期也挡得住
    expect(() => setCellStyle(emptyCellStyles, 'A1', { horizontal_align: 'diagonal' })).toThrow(/horizontal_align/);
    expect(() => setCellStyle(emptyCellStyles, 'A1', { indent: -1 })).toThrow(/indent/);
  });

  it('反向对照：非法边框线型必须被挡（否则样式契约形同虚设）', () => {
    // @ts-expect-error 故意传非法线型
    expect(() => setCellStyle(emptyCellStyles, 'A1', { borders: { top: { style: 'wiggly', color: null } } })).toThrow(
      /style/,
    );
  });

  it('单元格保护（XLS-15）：protection 随样式整体读写，非法 locked 显式抛', () => {
    const unlocked = setCellStyle(emptyCellStyles, 'A1', { protection: { locked: false } });
    expect(getCellStyle(unlocked, 'A1')?.protection).toEqual({ locked: false });
    // locked:true 是合法值（是否"渲染等价"由 style-parts 描述符层决定，这里照读回）。
    const lockedTrue = setCellStyle(emptyCellStyles, 'A1', { protection: { locked: true } });
    expect(getCellStyle(lockedTrue, 'A1')?.protection).toEqual({ locked: true });
    // @ts-expect-error 故意传非布尔 locked，验证运行期也挡得住
    expect(() => setCellStyle(emptyCellStyles, 'A1', { protection: { locked: 'no' } })).toThrow(/locked/);
  });
});

describe('XLS-05 数字格式：显示值与实际值分别验收', () => {
  it('百分比：0.5 显示成 50%，实际值仍是 0.5（未被乘 100）', () => {
    const styles = setCellStyle(emptyCellStyles, 'A1', { number_format: { kind: 'percent', decimals: 0 } });
    const outcome = displayCell(sheetWith('A1', numberValue(0.5)), styles, 'A1');
    expect(outcome.display).toBe('50%');
    // 实际值原样：既是 .5 不是 50，也没有变成文本
    expect(valuesEqual(outcome.actual, numberValue(0.5))).toBe(true);
  });

  it('反向对照：格式施加到区域后，底层数值**一个都没变**', () => {
    const sheet = setCellValue(setCellValue(createSheet('S'), 'A1', numberValue(0.5)), 'A2', numberValue(0.25));
    const styles = applyRangeStyle(emptyCellStyles, 'A1:A2', {
      number_format: { kind: 'percent', decimals: 0 },
    });
    // 显示是百分比
    expect(displayCell(sheet, styles, 'A1').display).toBe('50%');
    expect(displayCell(sheet, styles, 'A2').display).toBe('25%');
    // 底层仍是原数字（若实现"顺手把值 *100 写回"，这里必红）
    expect(requireNumericValue(getCellValue(sheet, 'A1'))).toBe(0.5);
    expect(requireNumericValue(getCellValue(sheet, 'A2'))).toBe(0.25);
  });

  it('货币：符号在符号位、千分位在手写分组里', () => {
    const styles = setCellStyle(emptyCellStyles, 'A1', {
      number_format: { kind: 'currency', currency: 'USD', decimals: 2 },
    });
    expect(displayCell(sheetWith('A1', numberValue(1234.5)), styles, 'A1').display).toBe('$1,234.50');
    const cny = setCellStyle(emptyCellStyles, 'A1', {
      number_format: { kind: 'currency', currency: 'CNY', decimals: 2 },
    });
    expect(displayCell(sheetWith('A1', numberValue(-12.3)), cny, 'A1').display).toBe('-¥12.30');
  });

  it('数值格式 + 千分位', () => {
    const styles = setCellStyle(emptyCellStyles, 'A1', {
      number_format: { kind: 'number', decimals: 2, grouping: true },
    });
    expect(displayCell(sheetWith('A1', numberValue(1234567.5)), styles, 'A1').display).toBe('1,234,567.50');
  });

  it('日期格式：数值按 Excel 序列号显示成日期，数值本身不变', () => {
    const styles = setCellStyle(emptyCellStyles, 'A1', {
      number_format: { kind: 'date', pattern: 'yyyy-mm-dd' },
    });
    const outcome = displayCell(sheetWith('A1', numberValue(44927)), styles, 'A1');
    expect(outcome.display).toBe('2023-01-01');
    expect(valuesEqual(outcome.actual, numberValue(44927))).toBe(true); // 仍是那个数，不是日期类型
    // 日期值本身按图案显示
    expect(formatCellDisplay(dateValue(0), { number_format: { kind: 'date', pattern: 'm/d/yyyy' } })).toBe('1/1/1970');
    expect(formatDatePattern(0, 'yyyy/mm/dd')).toBe('1970/01/01');
    expect(formatDatePattern(86_400_000, 'dd/mm/yyyy')).toBe('02/01/1970');
  });

  it('文本 / 布尔 / 错误值**不套**数字格式（类型不冒充）', () => {
    const percent: CellStyle = { number_format: { kind: 'percent', decimals: 0 } };
    expect(formatCellDisplay(textValue('0.5'), percent)).toBe('0.5'); // 文本原样，不被当数字
    expect(formatCellDisplay(booleanValue(true), percent)).toBe('TRUE');
    expect(formatCellDisplay(errorValue('#DIV/0!'), percent)).toBe('#DIV/0!');
    expect(formatCellDisplay(blank, percent)).toBe('');
    expect(formatCellDisplay(formulaValue('SUM(A1:A2)'), percent)).toBe('=SUM(A1:A2)');
  });
});

describe('样式表范围操作与结构迁移', () => {
  it('applyRangeStyle 铺满区域；clearRangeStyle 只清区域内的 key', () => {
    let styles = applyRangeStyle(emptyCellStyles, 'A1:B2', { bold: true });
    expect(getCellStyle(styles, 'A1')?.bold).toBe(true);
    expect(getCellStyle(styles, 'B2')?.bold).toBe(true);
    styles = setCellStyle(styles, 'D4', { italic: true });
    const cleared = clearRangeStyle(styles, 'A1:B2');
    expect(getCellStyle(cleared, 'A1')).toBeUndefined();
    expect(getCellStyle(cleared, 'D4')?.italic).toBe(true); // 区域外保留
  });

  it('反向对照：超大区域显式拒绝，不把内存撑爆', () => {
    expect(() => applyRangeStyle(emptyCellStyles, 'A1:XFD1048576', { bold: true })).toThrow(
      new RegExp(String(MAX_STYLE_RANGE_CELLS)),
    );
  });

  it('行列插入 / 删除时样式 key 跟值一起迁移（用 reference.ts 同款映射）', () => {
    const styles = setCellStyle(setCellStyle(emptyCellStyles, 'A5', { bold: true }), 'A1', { italic: true });
    const afterInsert = migrateCellStyles(styles, 'row', 3, 2, 'insert');
    expect(getCellStyle(afterInsert, 'A5')).toBeUndefined(); // 下移到 A7
    expect(getCellStyle(afterInsert, 'A7')?.bold).toBe(true);
    expect(getCellStyle(afterInsert, 'A1')?.italic).toBe(true); // 插入点之上不动

    const afterDelete = migrateCellStyles(afterInsert, 'row', 3, 2, 'delete');
    expect(getCellStyle(afterDelete, 'A5')?.bold).toBe(true); // A7 上移回 A5
  });

  it('删除命中的样式随之消失（不留在别的行上）', () => {
    const styles = applyRangeStyle(emptyCellStyles, 'A1:A5', { bold: true });
    const after = migrateCellStyles(styles, 'row', 2, 2, 'delete'); // 删第 2、3 行
    expect(getCellStyle(after, 'A1')?.bold).toBe(true);
    expect(getCellStyle(after, 'A2')?.bold).toBe(true); // 原 A4 上移
    expect(getCellStyle(after, 'A4')).toBeUndefined(); // 原 A4 移走后不留残影
    expect(getCellStyle(after, 'A5')).toBeUndefined();
  });
});
