import { describe, expect, it } from 'vitest';

import {
  clearCells,
  copyCells,
  createCellsState,
  cutCells,
  fillRange,
  pasteCells,
  readCell,
  readRange,
  writeCell,
  writeRange,
} from './cells.js';
import { createSheet, setCellValue } from './sheet.js';
import { emptyCellStyles, getCellStyle, setCellStyle } from './styles.js';
import {
  blank,
  errorValue,
  formulaValue,
  isFormula,
  numberValue,
  requireNumericValue,
  textValue,
  valuesEqual,
  type CellValue,
} from './value.js';

/** 建一张铺好若干格的表（用 sheet.ts 原语，避免各用例重复样板）。 */
function makeState(cells: readonly (readonly [string, CellValue])[], styles = emptyCellStyles) {
  let sheet = createSheet('S');
  for (const [address, value] of cells) {
    sheet = setCellValue(sheet, address, value);
  }
  return createCellsState(sheet, styles);
}

describe('XLS-03 类型不冒充：读 / 写 / 区域读取', () => {
  it('写进去什么类型就读出什么类型，文本 "120" 不被当数值', () => {
    const state = writeCell(createCellsState(createSheet('S')), 'A1', textValue('120'));
    expect(readCell(state, 'A1').kind).toBe('text');
    // 想从文本格取数 ⇒ 显式失败（R248 的"不冒充"在读取路径上的落点）
    expect(() => requireNumericValue(readCell(state, 'A1'))).toThrow(/不得冒充数值/);
  });

  it('错误值 ≠ 空值：错误值有值只是那个值是错误', () => {
    const state = writeCell(createCellsState(createSheet('S')), 'A1', errorValue('#DIV/0!'));
    expect(readCell(state, 'A1').kind).toBe('error');
    expect(valuesEqual(readCell(state, 'A1'), blank)).toBe(false);
    expect(() => requireNumericValue(readCell(state, 'A1'))).toThrow(/错误值/);
    // 从未设置的格才是 blank
    expect(valuesEqual(readCell(state, 'A2'), blank)).toBe(true);
  });

  it('readRange 保留空白格与二维形状（不跳过空白，否则行列错位）', () => {
    const state = writeRange(createCellsState(createSheet('S')), 'B2', [
      [numberValue(1), blank],
      [textValue('x'), numberValue(2)],
    ]);
    const values = readRange(state, 'B2:C3');
    expect(values.start).toEqual({ column: 2, row: 2 });
    expect(values.end).toEqual({ column: 3, row: 3 });
    expect(values.rows).toHaveLength(2);
    expect(values.rows[0]?.[0]).toEqual(numberValue(1));
    expect(valuesEqual(values.rows[0]?.[1] ?? blank, blank)).toBe(true);
    expect(values.rows[1]?.[0]?.kind).toBe('text');
  });

  it('清空区域连值带样式一起清', () => {
    let state = makeState(
      [
        ['A1', numberValue(1)],
        ['B1', numberValue(2)],
      ],
      setCellStyle(emptyCellStyles, 'A1', { bold: true }),
    );
    state = clearCells(state, 'A1:B1');
    expect(valuesEqual(readCell(state, 'A1'), blank)).toBe(true);
    expect(valuesEqual(readCell(state, 'B1'), blank)).toBe(true);
    expect(getCellStyle(state.styles, 'A1')).toBeUndefined();
  });
});

describe('XLS-03 复制 / 剪切 / 粘贴', () => {
  const base = () => makeState([
    ['A1', numberValue(2)],
    ['A2', numberValue(3)],
    ['B1', formulaValue('SUM(A1:A2)')],
  ]);

  it('粘贴「全部」：公式**仍是公式**（反向对照：若固化成值，本用例必红）', () => {
    const state = base();
    const pasted = pasteCells(state, 'C1', copyCells(state, 'B1'), 'all');
    const dest = readCell(pasted, 'C1');
    expect(isFormula(dest)).toBe(true);
    expect(dest.kind === 'formula' ? dest.text : '').toBe('SUM(A1:A2)');
    // 5 是它的求值结果，但**不是**它现在的形状
    expect(valuesEqual(dest, numberValue(5))).toBe(false);
  });

  it('剪切把源清空、把快照留在剪贴板里', () => {
    const state = base();
    const { state: afterCut, clipboard } = cutCells(state, 'B1');
    expect(valuesEqual(readCell(afterCut, 'B1'), blank)).toBe(true);
    const pasted = pasteCells(afterCut, 'D1', clipboard, 'all');
    expect(isFormula(readCell(pasted, 'D1'))).toBe(true);
  });

  it('选择性粘贴「值」：公式经过**真实求值器**变成标量（不是编的数）', () => {
    const state = base();
    const pasted = pasteCells(state, 'C1', copyCells(state, 'B1'), 'values');
    const dest = readCell(pasted, 'C1');
    expect(dest.kind).toBe('number');
    expect(requireNumericValue(dest)).toBe(5);
    expect(isFormula(dest)).toBe(false);
  });

  it('选择性粘贴「值」遇到算不出的公式 ⇒ 抛，绝不伪造', () => {
    const state = makeState([['B1', formulaValue('SUM(A1:A2)')]]); // A1/A2 空白
    const clipboard = copyCells(state, 'B1');
    expect(() => pasteCells(state, 'C1', clipboard, 'values')).toThrow(/无法求值|不伪造/);
  });

  it('选择性粘贴「公式」：只搬公式，常量不搬（落点置空）', () => {
    const state = makeState([
      ['A1', numberValue(7)],
      ['A2', formulaValue('A1*2')],
    ]);
    const pasted = pasteCells(state, 'C1', copyCells(state, 'A1:A2'), 'formulas');
    expect(valuesEqual(readCell(pasted, 'C1'), blank)).toBe(true); // 常量没搬
    expect(isFormula(readCell(pasted, 'C2'))).toBe(true); // 公式搬了
  });

  it('选择性粘贴「格式」：只搬样式，值一个都不动', () => {
    const state = makeState(
      [
        ['A1', numberValue(5)],
        ['C1', numberValue(99)],
      ],
      setCellStyle(emptyCellStyles, 'A1', { bold: true }),
    );
    const pasted = pasteCells(state, 'C1', copyCells(state, 'A1'), 'formats');
    expect(requireNumericValue(readCell(pasted, 'C1'))).toBe(99); // 落点的值没被覆盖
    expect(getCellStyle(pasted.styles, 'C1')?.bold).toBe(true); // 样式搬到了
  });

  it('反向对照：「值」模式不搬样式（否则选择性粘贴失去区分度）', () => {
    const state = makeState([['A1', numberValue(5)]], setCellStyle(emptyCellStyles, 'A1', { bold: true }));
    const pasted = pasteCells(state, 'C1', copyCells(state, 'A1'), 'values');
    expect(getCellStyle(pasted.styles, 'C1')).toBeUndefined();
  });
});

describe('XLS-03 批量填充', () => {
  it('repeat：把种子原样平铺（含公式逐字照搬）', () => {
    const state = makeState([
      ['A1', numberValue(1)],
      ['A2', numberValue(2)],
    ]);
    const filled = fillRange(state, 'A1:A2', 'A1:A6');
    const read = (ref: string) => requireNumericValue(readCell(filled, ref));
    expect([read('A1'), read('A2'), read('A3'), read('A4'), read('A5'), read('A6')]).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('series：按最后一个差续等差数列（反向对照：若退化成 repeat，本例必红）', () => {
    const state = makeState([
      ['A1', numberValue(0)],
      ['A2', numberValue(2)],
    ]);
    const filled = fillRange(state, 'A1:A2', 'A1:A5', 'series');
    const read = (ref: string) => requireNumericValue(readCell(filled, ref));
    expect([read('A1'), read('A2'), read('A3'), read('A4'), read('A5')]).toEqual([0, 2, 4, 6, 8]);
  });

  it('横向系列：向右续等差', () => {
    const state = makeState([
      ['A1', numberValue(10)],
      ['B1', numberValue(20)],
    ]);
    const filled = fillRange(state, 'A1:B1', 'A1:D1', 'series');
    expect(requireNumericValue(readCell(filled, 'C1'))).toBe(30);
    expect(requireNumericValue(readCell(filled, 'D1'))).toBe(40);
  });

  it('series 遇到非数值种子 ⇒ 抛（不编造序列）', () => {
    const state = makeState([
      ['A1', numberValue(1)],
      ['A2', textValue('x')],
    ]);
    expect(() => fillRange(state, 'A1:A2', 'A1:A5', 'series')).toThrow(/只支持数值序列/);
  });

  it('series 只有一个种子值 ⇒ 抛（推不出步长，明确拒绝）', () => {
    const state = makeState([['A1', numberValue(1)]]);
    expect(() => fillRange(state, 'A1', 'A1:A5', 'series')).toThrow(/至少需要两个数值/);
  });

  it('填充区必须以种子为左上角并包含它', () => {
    const state = makeState([['A1', numberValue(1)]]);
    expect(() => fillRange(state, 'A2:A3', 'A1:A6')).toThrow(/左上角/);
    expect(() => fillRange(state, 'A1:A3', 'A1:A2')).toThrow(/包含/);
  });
});
