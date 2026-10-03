/**
 * **X02 补验**：单元格样式（`CellStyles`）随行列复制 / 移动迁移（X02 遗留项 (a)）。
 *
 * 判据是"样式与值 / 几何**共用同一映射**"：结构操作后，一份样式的地址必须与对应值的地址
 * **逐个落在同一处**——只移值不移样式（或反过来）都会让用户看到错位。
 *
 * 因此本文件不重复 `src/spreadsheets/ranges.test.ts` 的单点断言，而是把
 * `copyRows`/`moveRows`（值）、`copySheetRows`/`moveSheetRows`（几何）、
 * `copyCellStylesRows`/`moveCellStylesRows`（样式）三条路**放在一起对比地址集合**。
 */

import { describe, expect, it } from 'vitest';

import {
  cellStyleKeys,
  copyCellStylesColumns,
  copyCellStylesRows,
  createSheetLayout,
  getRowHeight,
  moveCellStylesColumns,
  moveCellStylesRows,
  moveSheetRows,
  setRowHeight,
  type SheetLayoutState,
} from '../../../../src/spreadsheets/ranges.js';
import {
  copyColumns,
  copyRows,
  createSheet,
  getCellValue,
  hasCell,
  moveColumns,
  moveRows,
  setCellValue,
  sheetEntries,
  type SheetState,
} from '../../../../src/spreadsheets/sheet.js';
import {
  getCellStyle,
  setCellStyle,
  type CellStyle,
  type CellStyles,
} from '../../../../src/spreadsheets/styles.js';
import { blank, numberValue, valuesEqual } from '../../../../src/spreadsheets/value.js';

const BOLD: CellStyle = { bold: true };
const FILLED: CellStyle = { fill_color: '#FFEE00' };

/** 已设置样式的地址集合（升序，便于比较）。 */
function styleRefs(styles: CellStyles): readonly string[] {
  return [...styles.keys()].sort();
}

/** 已有非空取值的地址集合（升序）。 */
function valueRefs(sheet: SheetState): readonly string[] {
  return sheetEntries(sheet)
    .filter((entry) => !valuesEqual(entry.value, blank))
    .map((entry) => entry.ref)
    .sort();
}

/** 一张 A/B 两列各有取值的行记录表（第 2、3 行）。 */
function rowSheet(): SheetState {
  let sheet = createSheet('行');
  sheet = setCellValue(sheet, 'A2', numberValue(1));
  sheet = setCellValue(sheet, 'B2', numberValue(10));
  sheet = setCellValue(sheet, 'A3', numberValue(2));
  sheet = setCellValue(sheet, 'B3', numberValue(20));
  return sheet;
}

/** 与 `rowSheet` 对应：第 2、3 行各挂一份样式。 */
function rowStyles(): CellStyles {
  let styles: CellStyles = new Map();
  styles = setCellStyle(styles, 'A2', BOLD);
  styles = setCellStyle(styles, 'B3', FILLED);
  return styles;
}

describe('X02 样式迁移：复制行 —— 样式地址与值地址逐个一致', () => {
  it('源保留、副本落在与 copyRows 相同的两行（第 10、11 行）', () => {
    const after = copyRows(rowSheet(), 2, 2, 10);
    const styled = copyCellStylesRows(rowStyles(), 2, 2, 10);
    // 值：A2/B2、A3/B3 保留，副本落在 A10/B10、A11/B11
    expect(valueRefs(after)).toEqual(['A10', 'A11', 'A2', 'A3', 'B10', 'B11', 'B2', 'B3']);
    // 样式：与值**完全同一组地址**
    expect(styleRefs(styled)).toEqual(['A10', 'A2', 'B11', 'B3']);
    // 每个样式地址上都有对应的值（样式没有留在空处）
    for (const ref of styleRefs(styled)) {
      expect(hasCell(after, ref)).toBe(true);
    }
  });

  it('源样式与副本样式描述符等价（按 style-parts 的键比较，不是对象同一性）', () => {
    const styled = copyCellStylesRows(rowStyles(), 2, 2, 10);
    const keys = cellStyleKeys(styled);
    expect(keys.get('A2')).toBe(keys.get('A10')); // 加粗副本
    expect(keys.get('B3')).toBe(keys.get('B11')); // 填充副本
    expect(keys.get('A2')).not.toBe(keys.get('B3')); // 两个不同样式不被并成一个
    expect(getCellStyle(styled, 'A10')).toEqual(BOLD); // 逐字保留原样式
  });
});

describe('X02 样式迁移：移动行 —— 样式与值、几何三路同址', () => {
  it('第 2 行样式与值、行高一起落到第 4 行（mapMovePosition 共用）', () => {
    let layout: SheetLayoutState = setRowHeight(createSheetLayout(rowSheet()), 2, 30);
    const movedSheet = moveSheetRows(layout, 2, 1, 5);
    const movedStyles = moveCellStylesRows(rowStyles(), 2, 1, 5);

    // 值：第 2 行的 A2/B2 落到第 4 行；A3/B3 上移到第 2 行
    expect(getCellValue(movedSheet.sheet, 'A4')).toEqual(numberValue(1));
    // 几何：第 2 行的行高落到第 4 行
    expect(getRowHeight(movedSheet, 4)).toBe(30);
    // 样式：A2 的加粗落到 A4（与值同一地址），A2 不再有样式
    expect(getCellStyle(movedStyles, 'A4')).toEqual(BOLD);
    expect(getCellStyle(movedStyles, 'A2')).toBeUndefined();
    // 第 3 行落在压缩段 ⇒ 样式随行上移到第 2 行（与值 B3→B2 同址）
    expect(getCellStyle(movedStyles, 'B2')).toEqual(FILLED);
    expect(getCellValue(movedSheet.sheet, 'B2')).toEqual(numberValue(20));
  });
});

describe('X02 样式迁移：列版与行版同构', () => {
  it('复制列：样式地址与 copyColumns、几何三路一致', () => {
    let sheet = createSheet('列');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', numberValue(2));
    const after = copyColumns(sheet, 1, 1, 5); // A 列复制到 E 列
    let styles: CellStyles = setCellStyle(new Map(), 'A1', BOLD);
    const styled = copyCellStylesColumns(styles, 1, 1, 5);
    expect(getCellValue(after, 'E1')).toEqual(numberValue(1)); // 副本值
    expect(styleRefs(styled)).toEqual(['A1', 'E1']); // 副本样式
    expect(getCellStyle(styled, 'E1')).toEqual(BOLD);
  });

  it('移动列：样式跟着列走', () => {
    let styles: CellStyles = setCellStyle(new Map(), 'A1', BOLD);
    const moved = moveCellStylesColumns(styles, 1, 1, 4); // A 列 → 第 3 列
    expect(getCellStyle(moved, 'C1')).toEqual(BOLD);
    expect(getCellStyle(moved, 'A1')).toBeUndefined();
  });
});

describe('X02 样式迁移：反面对照（不静默吞掉非法输入）', () => {
  const styles = rowStyles();

  it('复制：插入点落在被复制区间内部 / 非法坐标 ⇒ 显式抛', () => {
    expect(() => copyCellStylesRows(styles, 2, 3, 3)).toThrow(/内部/);
    expect(() => copyCellStylesRows(styles, 0, 1, 5)).toThrow(/整数/);
    expect(() => copyCellStylesRows(styles, 2, 0, 5)).toThrow(/整数/);
    expect(() => copyCellStylesColumns(styles, 1, 1, 0)).toThrow(/整数/);
  });

  it('移动：目标落在被移动区间内部 / 非法坐标 ⇒ 显式抛', () => {
    expect(() => moveCellStylesRows(styles, 2, 3, 3)).toThrow(/内部/);
    expect(() => moveCellStylesRows(styles, 2, 1, 0)).toThrow(/整数/);
    expect(() => moveCellStylesColumns(styles, 1, 2, 2)).toThrow(/内部/);
  });

  it('恒等移动（to === at / to === at+count）不改变样式表', () => {
    const identity = moveCellStylesRows(styles, 2, 1, 2);
    expect(styleRefs(identity)).toEqual(styleRefs(styles));
    expect([...identity.entries()].sort()).toEqual([...styles.entries()].sort());
  });
});
