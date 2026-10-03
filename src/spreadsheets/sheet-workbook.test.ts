import { describe, expect, it } from 'vitest';

import {
  clearCell,
  clearRange,
  createSheet,
  getCellValue,
  hasCell,
  insertColumns,
  insertRows,
  isValidSheetName,
  mapMovePosition,
  migrateFormulaText,
  normalizeAddress,
  setCellValue,
  setFrozenPanes,
  sheetEntries,
  deleteColumns,
  deleteRows,
} from './sheet.js';
import { blank, formulaValue, isFormula, numberValue, textValue } from './value.js';
import {
  activeSheet,
  addSheet,
  copySheet,
  createWorkbook,
  getSheet,
  getSheetIndex,
  moveSheet,
  removeSheet,
  renameSheet,
  setActiveSheet,
  setSheetHidden,
  sheetNames,
} from './workbook.js';

describe('工作表基础读写', () => {
  it('未设置过的单元格读回是 blank（不是 0、不是空串）', () => {
    const sheet = createSheet('S');
    expect(getCellValue(sheet, 'A1')).toBe(blank);
    expect(hasCell(sheet, 'A1')).toBe(false);
    expect(getCellValue(sheet, 'A1').kind).toBe('blank');
  });

  it('写入 / 读回 / 清空是纯函数：旧状态不变', () => {
    const original = createSheet('S');
    const written = setCellValue(original, 'B2', numberValue(120));
    expect(getCellValue(written, 'B2')).toEqual(numberValue(120));
    expect(getCellValue(original, 'B2')).toBe(blank);
    const cleared = clearCell(written, 'B2');
    expect(getCellValue(cleared, 'B2')).toBe(blank);
    expect(getCellValue(written, 'B2')).toEqual(numberValue(120));
  });

  it('clearRange 只清区域内的格子', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B2', numberValue(2));
    sheet = setCellValue(sheet, 'C3', numberValue(3));
    const cleared = clearRange(sheet, 'A1:B2');
    expect(hasCell(cleared, 'A1')).toBe(false);
    expect(hasCell(cleared, 'B2')).toBe(false);
    expect(hasCell(cleared, 'C3')).toBe(true);
  });

  it('地址可用文本或结构化形式，非法地址显式抛', () => {
    expect(normalizeAddress('b2')).toBe('B2');
    expect(normalizeAddress({ column: 2, row: 2 })).toBe('B2');
    expect(() => normalizeAddress('#REF!')).toThrow();
  });

  it('sheetEntries 按行、列稳定排序', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'B2', textValue('b'));
    sheet = setCellValue(sheet, 'A1', textValue('a'));
    sheet = setCellValue(sheet, 'A2', textValue('c'));
    expect(sheetEntries(sheet).map((entry) => entry.ref)).toEqual(['A1', 'A2', 'B2']);
  });

  it('冻结窗格元数据与非负校验', () => {
    const sheet = setFrozenPanes(createSheet('S'), 1, 2);
    expect(sheet.frozen_rows).toBe(1);
    expect(sheet.frozen_columns).toBe(2);
    expect(() => setFrozenPanes(sheet, -1, 0)).toThrow(/非负整数/);
  });

  it('工作表名合法性（≤31、禁用字符）', () => {
    expect(isValidSheetName('预算表')).toBe(true);
    expect(isValidSheetName('')).toBe(false);
    expect(isValidSheetName('a'.repeat(32))).toBe(false);
    expect(isValidSheetName('a/b')).toBe(false);
    expect(() => createSheet('a:b')).toThrow(/工作表名非法/);
  });
});

describe('XLS-04：行列增删时单元格键与公式一起迁移', () => {
  it('插入行：下方单元格下移，上方不动', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'A3', numberValue(3));
    const after = insertRows(sheet, 2, 1);
    expect(hasCell(after, 'A1')).toBe(true);
    expect(getCellValue(after, 'A3')).toBe(blank);
    expect(getCellValue(after, 'A4')).toEqual(numberValue(3));
    expect(after.row_count).toBe(1001);
  });

  it('插入行：公式里的引用同步迁移', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'B1', formulaValue('SUM(A3:A4)'));
    sheet = setCellValue(sheet, 'A3', numberValue(10));
    const after = insertRows(sheet, 2, 1);
    const cell = getCellValue(after, 'B1');
    expect(isFormula(cell)).toBe(true);
    if (isFormula(cell)) {
      expect(cell.text).toBe('SUM(A4:A5)');
    }
    expect(getCellValue(after, 'A4')).toEqual(numberValue(10));
    expect(after.migration_blocked).toEqual([]);
  });

  it('插入行：无法安全改写的公式**保留原文并登记**，不伪造引用', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'B1', formulaValue('LOG10(A3)'));
    const after = insertRows(sheet, 2, 1);
    const cell = getCellValue(after, 'B1');
    expect(isFormula(cell)).toBe(true);
    if (isFormula(cell)) {
      expect(cell.text).toBe('LOG10(A3)'); // 逐字保留
    }
    expect(after.migration_blocked).toEqual(['B1']);
  });

  it('删除行：区间内的单元格消失，区间后的上移', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'A2', numberValue(2));
    sheet = setCellValue(sheet, 'A5', numberValue(5));
    const after = deleteRows(sheet, 2, 2);
    expect(hasCell(after, 'A2')).toBe(false);
    expect(getCellValue(after, 'A3')).toEqual(numberValue(5));
  });

  it('删除行命中公式引用 ⇒ 阻塞并登记，公式原文保留', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'C1', formulaValue('SUM(A2:A3)'));
    const after = deleteRows(sheet, 2, 2);
    const cell = getCellValue(after, 'C1');
    expect(isFormula(cell)).toBe(true);
    if (isFormula(cell)) {
      expect(cell.text).toBe('SUM(A2:A3)');
    }
    expect(after.migration_blocked).toEqual(['C1']);
  });

  it('列增删与行增删同构', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'C1', numberValue(3));
    expect(getCellValue(insertColumns(sheet, 2, 1), 'D1')).toEqual(numberValue(3));
    expect(getCellValue(deleteColumns(sheet, 2, 1), 'B1')).toEqual(numberValue(3));
  });

  it('migrateFormulaText 把阻塞原因暴露给调用方', () => {
    expect(migrateFormulaText('A3', 'row', 2, 1, 'insert')).toEqual({ ok: true, text: 'A4' });
    const blocked = migrateFormulaText('LOG10(A3)', 'row', 2, 1, 'insert');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toBe('ambiguous_token');
    }
  });

  it('合并区随插入撑大，删除部分重叠时显式阻塞', () => {
    const sheet = createSheet('S', { merged: ['A2:A4'] });
    const grown = insertRows(sheet, 3, 1);
    expect(grown.merged).toEqual(['A2:A5']);
    const before = insertRows(sheet, 1, 1);
    expect(before.merged).toEqual(['A3:A5']);
    expect(() => deleteRows(sheet, 3, 1)).toThrow(/部分重叠/);
  });
});

describe('XLS-04：mapMovePosition 语义锚点（本批不得改变）', () => {
  it('向后移动 [2,3]→6 之前：块 / 其间 / 目标之后的四段各自映射', () => {
    expect(mapMovePosition(1, 2, 2, 6)).toBe(1); // 块前不动
    expect(mapMovePosition(2, 2, 2, 6)).toBe(4); // 块首 → to - count
    expect(mapMovePosition(3, 2, 2, 6)).toBe(5);
    expect(mapMovePosition(4, 2, 2, 6)).toBe(2); // 其间压缩 -count
    expect(mapMovePosition(5, 2, 2, 6)).toBe(3);
    expect(mapMovePosition(6, 2, 2, 6)).toBe(6); // 目标及之后不动
  });

  it('向前移动 [4,5]→2 之前：镜像分段', () => {
    expect(mapMovePosition(1, 4, 2, 2)).toBe(1);
    expect(mapMovePosition(2, 4, 2, 2)).toBe(4); // 目标段下移 +count
    expect(mapMovePosition(3, 4, 2, 2)).toBe(5);
    expect(mapMovePosition(4, 4, 2, 2)).toBe(2); // 块首 → to
    expect(mapMovePosition(5, 4, 2, 2)).toBe(3);
    expect(mapMovePosition(6, 4, 2, 2)).toBe(6);
  });

  it('恒等映射：to === at 与 to === at + count 均逐点不动', () => {
    for (const position of [1, 2, 3, 4, 5, 6, 7]) {
      expect(mapMovePosition(position, 3, 2, 3)).toBe(position);
      expect(mapMovePosition(position, 3, 2, 5)).toBe(position);
    }
  });
});

describe('XLS-02 / R250：多工作表，不是只有一张固定表', () => {
  it('默认工作簿含一张 Sheet1', () => {
    const workbook = createWorkbook();
    expect(sheetNames(workbook)).toEqual(['Sheet1']);
    expect(activeSheet(workbook).name).toBe('Sheet1');
  });

  it('新增 / 重名拒绝 / 非法名拒绝', () => {
    const workbook = createWorkbook();
    const added = addSheet(workbook, '清单');
    expect(sheetNames(added)).toEqual(['Sheet1', '清单']);
    expect(() => addSheet(added, '清单')).toThrow(/拒绝重名/);
    expect(() => addSheet(added, 'a*b')).toThrow(/工作表名非法/);
  });

  it('删除：最后一张不得删', () => {
    const workbook = addSheet(createWorkbook(), '第二张');
    const removed = removeSheet(workbook, '第二张');
    expect(sheetNames(removed)).toEqual(['Sheet1']);
    expect(() => removeSheet(removed, 'Sheet1')).toThrow(/至少保留一张/);
    expect(() => removeSheet(removed, '不存在')).toThrow(/没有工作表/);
  });

  it('重命名：重名拒绝、同名幂等', () => {
    const workbook = addSheet(createWorkbook(), '第二张');
    expect(sheetNames(renameSheet(workbook, '第二张', '明细'))).toEqual(['Sheet1', '明细']);
    expect(() => renameSheet(workbook, '第二张', 'Sheet1')).toThrow(/拒绝重名/);
    expect(sheetNames(renameSheet(workbook, '第二张', '第二张'))).toEqual(['Sheet1', '第二张']);
  });

  it('复制是深拷贝：改副本不影响原件', () => {
    const source = setCellValue(createSheet('源'), 'A1', numberValue(7));
    const workbook = createWorkbook([source]);
    const copied = copySheet(workbook, '源', '副本');
    const copyState = getSheet(copied, '副本');
    expect(copyState).toBeDefined();
    if (copyState === undefined) {
      return;
    }
    expect(getCellValue(copyState, 'A1')).toEqual(numberValue(7));
    const mutatedCopy = setCellValue(copyState, 'A1', numberValue(999));
    expect(getCellValue(mutatedCopy, 'A1')).toEqual(numberValue(999));
    const original = getSheet(copied, '源');
    expect(original === undefined ? undefined : getCellValue(original, 'A1')).toEqual(numberValue(7));
    expect(() => copySheet(copied, '源', '副本')).toThrow(/拒绝重名/);
  });

  it('移动 / 隐藏 / 活跃表', () => {
    let workbook = addSheet(addSheet(createWorkbook(), 'B'), 'C');
    expect(sheetNames(workbook)).toEqual(['Sheet1', 'B', 'C']);
    workbook = moveSheet(workbook, 'C', 0);
    expect(sheetNames(workbook)).toEqual(['C', 'Sheet1', 'B']);
    expect(getSheetIndex(workbook, 'C')).toBe(0);
    workbook = setSheetHidden(workbook, 'B', true);
    expect(getSheet(workbook, 'B')?.hidden).toBe(true);
    workbook = setActiveSheet(workbook, 'B');
    expect(activeSheet(workbook).name).toBe('B');
    expect(() => setActiveSheet(workbook, '没有')).toThrow(/没有工作表/);
    expect(() => moveSheet(workbook, 'C', 9)).toThrow(/越界/);
  });

  it('createWorkbook 收到重名工作表 ⇒ 显式抛', () => {
    expect(() => createWorkbook([createSheet('A'), createSheet('A')])).toThrow(/重名工作表/);
  });
});
