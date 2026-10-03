import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  autoFitColumn,
  cellStyleKeys,
  clearRowHeight,
  copyCellStylesColumns,
  copyCellStylesRows,
  createSheetLayout,
  deleteSheetColumns,
  deleteSheetRows,
  freezePanes,
  getColumnWidth,
  getRowHeight,
  hideColumns,
  hideRows,
  insertSheetColumns,
  insertSheetRows,
  isColumnHidden,
  isRowHidden,
  mergeCells,
  moveCellStylesColumns,
  moveCellStylesRows,
  setColumnWidth,
  setRowHeight,
  unhideRows,
  unmergeCells,
} from './ranges.js';
import { createSheet, getCellValue, setCellValue } from './sheet.js';
import { getCellStyle, setCellStyle, type CellStyle, type CellStyles } from './styles.js';
import { blank, formulaValue, numberValue, requireNumericValue, textValue, valuesEqual } from './value.js';

/** 一张带 `A1=1` 与 `A5=SUM(A1:A4)` 的表，用于验证结构变更后的迁移。 */
function sampleSheet() {
  let sheet = createSheet('S');
  sheet = setCellValue(sheet, 'A1', numberValue(1));
  sheet = setCellValue(sheet, 'A5', formulaValue('SUM(A1:A4)'));
  return sheet;
}

describe('XLS-04 行列增删：单元格与公式引用正确迁移', () => {
  it('插入行：单元格下移，公式里的引用一起改（委托 sheet.ts 既有链路）', () => {
    const layout = createSheetLayout(sampleSheet());
    const inserted = insertSheetRows(layout, 2, 3);
    // 单元格 A5 → A8
    expect(requireNumericValue(getCellValue(inserted.sheet, 'A1'))).toBe(1);
    const moved = getCellValue(inserted.sheet, 'A8');
    expect(moved.kind).toBe('formula');
    // 公式里 A1 在插入点之上不动、A4 落到插入点之下 ⇒ 变 A7
    expect(moved.kind === 'formula' ? moved.text : '').toBe('SUM(A1:A7)');
    // 原地址已空（迁移不是"复制一份"）
    expect(valuesEqual(getCellValue(inserted.sheet, 'A5'), blank)).toBe(true);
    expect(inserted.sheet.row_count).toBe(layout.sheet.row_count + 3);
  });

  it('删除行命中公式引用 ⇒ 保留原文 + 登记 blocked，不伪造新引用', () => {
    const deleted = deleteSheetRows(createSheetLayout(sampleSheet()), 2, 3);
    // A5 上移到 A2；引用 A4 落在被删区间 ⇒ 阻断
    const moved = getCellValue(deleted.sheet, 'A2');
    expect(moved.kind).toBe('formula');
    expect(moved.kind === 'formula' ? moved.text : '').toBe('SUM(A1:A4)');
    expect(deleted.sheet.migration_blocked).toContain('A2');
  });

  it('列增删与行增删同构', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'C1', formulaValue('SUM(A1:B1)'));
    const inserted = insertSheetColumns(createSheetLayout(sheet), 2, 2);
    const moved = getCellValue(inserted.sheet, 'E1'); // C1 → E1
    expect(moved.kind === 'formula' ? moved.text : '').toBe('SUM(A1:D1)');
    const deleted = deleteSheetColumns(createSheetLayout(sheet), 1, 2); // 删 A、B 列
    // C1 → A1；引用 A1/B1 落在被删区间 ⇒ blocked
    expect(getCellValue(deleted.sheet, 'A1').kind).toBe('formula');
    expect(deleted.sheet.migration_blocked).toContain('A1');
  });

  it('行高随插入下移、随删除上移（几何与值同进同退）', () => {
    const layout = setRowHeight(createSheetLayout(sampleSheet()), 5, 30);
    const inserted = insertSheetRows(layout, 3, 2);
    expect(getRowHeight(inserted, 7)).toBe(30); // 5 → 7
    expect(getRowHeight(inserted, 5)).toBe(DEFAULT_ROW_HEIGHT);
    const deleted = deleteSheetRows(layout, 2, 3);
    expect(getRowHeight(deleted, 2)).toBe(30); // 5 → 2
  });

  it('隐藏行列随结构变更迁移；被删中的隐藏项消失', () => {
    const layout = hideRows(createSheetLayout(sampleSheet()), 4, 2); // 隐藏 4、5
    const inserted = insertSheetRows(layout, 2, 2); // 4→6、5→7
    expect(isRowHidden(inserted, 6)).toBe(true);
    expect(isRowHidden(inserted, 7)).toBe(true);
    expect(isRowHidden(inserted, 4)).toBe(false);

    const deleted = deleteSheetRows(layout, 4, 1); // 删掉行 4（隐藏项之一）
    expect(isRowHidden(deleted, 4)).toBe(true); // 原 5 上移成 4
    expect(deleted.hidden_rows).toHaveLength(1);
  });

  it('列宽 / 隐藏列随列增删迁移', () => {
    let layout = setColumnWidth(createSheetLayout(sampleSheet()), 3, 20);
    layout = hideColumns(layout, 2, 1);
    const inserted = insertSheetColumns(layout, 1, 2);
    expect(getColumnWidth(inserted, 5)).toBe(20); // 3 → 5
    expect(isColumnHidden(inserted, 4)).toBe(true); // 2 → 4
  });
});

describe('XLS-04 宽高 / 隐藏 / 自动调整 / 冻结', () => {
  const layout = createSheetLayout(createSheet('S'));

  it('未设置即默认；可设可清', () => {
    expect(getRowHeight(layout, 1)).toBe(DEFAULT_ROW_HEIGHT);
    expect(getColumnWidth(layout, 1)).toBe(DEFAULT_COLUMN_WIDTH);
    expect(getRowHeight(setRowHeight(layout, 1, 22), 1)).toBe(22);
    expect(getRowHeight(clearRowHeight(setRowHeight(layout, 1, 22), 1), 1)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('隐藏 / 取消隐藏', () => {
    const hidden = hideRows(layout, 3, 2);
    expect(isRowHidden(hidden, 3)).toBe(true);
    expect(isRowHidden(hidden, 4)).toBe(true);
    expect(isRowHidden(hidden, 2)).toBe(false);
    expect(isRowHidden(unhideRows(hidden, 3, 2), 3)).toBe(false);
  });

  it('自动调整按列内最长文本计宽（空列回到默认）', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'A1', textValue('abcdefgh')); // 8 字符 ⇒ 8+2
    const fitted = autoFitColumn(createSheetLayout(sheet), 1);
    expect(getColumnWidth(fitted, 1)).toBe(10);
    expect(getColumnWidth(autoFitColumn(createSheetLayout(sheet), 2), 2)).toBe(DEFAULT_COLUMN_WIDTH);
  });

  it('冻结窗格委托 sheet.ts 的 setFrozenPanes', () => {
    const frozen = freezePanes(layout, 2, 1);
    expect(frozen.sheet.frozen_rows).toBe(2);
    expect(frozen.sheet.frozen_columns).toBe(1);
  });

  it('反向对照：非法行号 / 非正尺寸显式抛（不静默接受 0 高）', () => {
    expect(() => setRowHeight(layout, 0, 10)).toThrow(/行号/);
    expect(() => setRowHeight(layout, 1, 0)).toThrow(/正有限数/);
    expect(() => setColumnWidth(layout, 1, -1)).toThrow(/正有限数/);
    expect(() => hideRows(layout, 1, 0)).toThrow(/count/);
  });
});

describe('XLS-04 合并 / 拆分', () => {
  function twoCells() {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'A1', textValue('top'));
    sheet = setCellValue(sheet, 'A2', numberValue(99));
    return sheet;
  }

  it('合并保留左上、清掉其余格；拆分还原合并元数据', () => {
    const merged = mergeCells(createSheetLayout(twoCells()), 'A1:B2');
    expect(merged.sheet.merged).toContain('A1:B2');
    expect(getCellValue(merged.sheet, 'A1').kind).toBe('text');
    expect(valuesEqual(getCellValue(merged.sheet, 'A2'), blank)).toBe(true); // 被并掉

    const unmerged = unmergeCells(merged, 'A1:B2');
    expect(unmerged.sheet.merged).toHaveLength(0);
  });

  it('合并区随插入行迁移（sheet.ts 负责合并区迁移）', () => {
    const merged = mergeCells(createSheetLayout(twoCells()), 'A1:B2');
    const inserted = insertSheetRows(merged, 1, 1);
    expect(inserted.sheet.merged).toContain('A2:B3');
  });

  it('反向对照：重叠 / 重复 / 单格 / 未合并，四种非法都显式抛', () => {
    const merged = mergeCells(createSheetLayout(twoCells()), 'A1:B2');
    expect(() => mergeCells(merged, 'A1:B2')).toThrow(/已经合并/);
    expect(() => mergeCells(merged, 'B2:C3')).toThrow(/重叠/);
    expect(() => mergeCells(createSheetLayout(twoCells()), 'A1')).toThrow(/至少需要两格/);
    expect(() => unmergeCells(merged, 'D4:E5')).toThrow(/不是已合并区/);
  });
});

describe('XLS-05：单元格样式随行列复制 / 移动迁移（与值共用同一映射）', () => {
  const BOLD: CellStyle = { bold: true };
  const FILLED: CellStyle = { fill_color: '#FFEE00' };
  const ITALIC: CellStyle = { italic: true };

  function styles(): CellStyles {
    let table: CellStyles = new Map();
    table = setCellStyle(table, 'A2', BOLD);
    table = setCellStyle(table, 'B5', FILLED);
    table = setCellStyle(table, 'C12', ITALIC);
    return table;
  }

  it('复制行：源样式保留，副本落到插入点，插入点之后的样式下移', () => {
    const after = copyCellStylesRows(styles(), 2, 1, 10);
    expect(getCellStyle(after, 'A2')).toEqual(BOLD); // 源保留
    expect(getCellStyle(after, 'A10')).toEqual(BOLD); // 副本落在插入点
    // B5 位于插入点之前 ⇒ 不动；C12 位于插入点之后 ⇒ 下移一行到 C13
    expect(getCellStyle(after, 'B5')).toEqual(FILLED);
    expect(getCellStyle(after, 'C13')).toEqual(ITALIC);
    expect(getCellStyle(after, 'C12')).toBeUndefined();
  });

  it('复制列：与 copyColumns 相同映射', () => {
    let table: CellStyles = setCellStyle(new Map(), 'C1', BOLD);
    const after = copyCellStylesColumns(table, 3, 1, 5); // C 列 → E 列
    expect(getCellStyle(after, 'C1')).toEqual(BOLD);
    expect(getCellStyle(after, 'E1')).toEqual(BOLD);
  });

  it('移动行：样式用与 moveRows 相同的 mapMovePosition 分段迁移', () => {
    const after = moveCellStylesRows(styles(), 2, 1, 5); // 第 2 行 → 第 4 行
    expect(getCellStyle(after, 'A2')).toBeUndefined();
    expect(getCellStyle(after, 'A4')).toEqual(BOLD);
    // B5 在目标之后（to === at+count 之外的恒等段）不动
    expect(getCellStyle(after, 'B5')).toEqual(FILLED);
  });

  it('移动列：样式跟着列走', () => {
    let table: CellStyles = setCellStyle(new Map(), 'A1', BOLD);
    const after = moveCellStylesColumns(table, 1, 1, 4); // A 列 → 第 3 列
    expect(getCellStyle(after, 'C1')).toEqual(BOLD);
    expect(getCellStyle(after, 'A1')).toBeUndefined();
  });

  it('cellStyleKeys 按描述符键比较：副本与源等价、不同样式不等价', () => {
    const after = copyCellStylesRows(styles(), 2, 1, 10);
    const keys = cellStyleKeys(after);
    expect(keys.get('A2')).toBe(keys.get('A10'));
    expect(keys.get('A2')).not.toBe(keys.get('B5'));
  });

  it('反向对照：坐标非法 / 自重叠显式抛', () => {
    expect(() => copyCellStylesRows(styles(), 2, 3, 3)).toThrow(/内部/);
    expect(() => copyCellStylesRows(styles(), 0, 1, 5)).toThrow(/整数/);
    expect(() => copyCellStylesRows(styles(), 2, 1, 0)).toThrow(/整数/);
    expect(() => moveCellStylesRows(styles(), 2, 3, 3)).toThrow(/内部/);
    expect(() => moveCellStylesColumns(styles(), 1, 1, 0)).toThrow(/整数/);
  });
});
