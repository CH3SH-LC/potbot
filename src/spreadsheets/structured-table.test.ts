/**
 * `structured-table.ts` 的验收用例（design-06-P8 / XLS-10）。
 *
 * 判据落在两件事上：① 插入 / 删除行列后**表范围与列定义仍然对齐**（用区域的绝对地址断言）；
 * ② 汇总行 / 表定义 XML 是**真的可写进文件**的片段（用 `parseXml` 读回来核对属性）。
 */

import { describe, expect, it } from 'vitest';

import {
  attributeValue,
  childElements,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE } from '../artifacts/templates/xlsx.js';
import { createSheet, getCellValue, setCellValue, type SheetState } from './sheet.js';
import { blank, numberValue, textValue } from './value.js';
import {
  buildTableDefinitionXml,
  buildTotalsFormulas,
  createStructuredTable,
  deleteTableColumns,
  deleteTableRows,
  insertTableColumns,
  insertTableRows,
  isValidTableName,
  migrateTableRange,
  shiftTableForColumnDelete,
  shiftTableForColumnInsert,
  structuredReference,
  tableColumnLetter,
  tableColumnPosition,
  tableDataRange,
  tableHeaderRange,
  tableTotalsRange,
  type StructuredTable,
} from './structured-table.js';

function makeTable(): StructuredTable {
  return createStructuredTable({
    name: '费用表',
    range: 'B3:C6',
    columns: ['项目', { name: '金额', totals_function: 'sum' }],
    totals_row: true,
    style: { name: 'TableStyleMedium2', show_row_stripes: true },
  });
}

function makeSheet(): SheetState {
  let sheet = createSheet('S', { row_count: 10, column_count: 8 });
  sheet = setCellValue(sheet, 'B3', textValue('项目'));
  sheet = setCellValue(sheet, 'C3', textValue('金额'));
  sheet = setCellValue(sheet, 'B4', textValue('餐饮'));
  sheet = setCellValue(sheet, 'C4', numberValue(100));
  sheet = setCellValue(sheet, 'B5', textValue('交通'));
  sheet = setCellValue(sheet, 'C5', numberValue(200));
  sheet = setCellValue(sheet, 'B6', textValue('合计'));
  sheet = setCellValue(sheet, 'C6', numberValue(300));
  return sheet;
}

describe('XLS-10 结构化表格与区域', () => {
  it('标题行 / 数据体 / 汇总行三段划分正确', () => {
    const table = makeTable();
    expect(tableHeaderRange(table)).toBe('B3:C3');
    expect(tableDataRange(table)).toBe('B4:C5');
    expect(tableTotalsRange(table)).toBe('B6:C6');
    expect(table.range).toBe('B3:C6');
    expect(table.totals_row_count).toBe(1);
  });

  it('反向对照：无汇总行时 totalsRange 为 null，数据体一直到底', () => {
    const plain = createStructuredTable({ name: '清单', range: 'A1:B4', columns: ['名称', '数量'] });
    expect(tableTotalsRange(plain)).toBeNull();
    expect(tableDataRange(plain)).toBe('A2:B4');
  });

  it('列定位与结构化引用', () => {
    const table = makeTable();
    expect(tableColumnPosition(table, '金额')).toEqual({ index: 2, column: 3 });
    expect(tableColumnPosition(table, '不存在')).toBeUndefined();
    expect(tableColumnLetter(table, '金额')).toBe('C');
    expect(structuredReference(table, '金额')).toBe('费用表[金额]');
    expect(() => structuredReference(table, '不存在')).toThrow(/没有列/);
  });

  it('汇总行公式用 SUBTOTAL + 结构化引用；无聚合的列不编造公式', () => {
    const formulas = buildTotalsFormulas(makeTable());
    expect(formulas.map((entry) => entry.formula)).toEqual([null, 'SUBTOTAL(109,费用表[金额])']);
    expect(formulas.map((entry) => entry.label)).toEqual(['项目', '金额']);
  });

  it('反向对照：没有汇总行时生成汇总公式直接抛错', () => {
    const plain = createStructuredTable({ name: '清单', range: 'A1:B4', columns: ['名称', '数量'] });
    expect(() => buildTotalsFormulas(plain)).toThrow(/没有汇总行/);
  });

  it('创建期拒绝：列数与区域宽度不符 / 列名重复 / 非法表名', () => {
    expect(() => createStructuredTable({ name: '表', range: 'A1:C4', columns: ['名称', '数量'] })).toThrow(/列数/);
    expect(() => createStructuredTable({ name: '表', range: 'A1:B4', columns: ['名称', '名称'] })).toThrow(/列名重复/);
    expect(() => createStructuredTable({ name: 'A1', range: 'A1:B4', columns: ['名称', '数量'] })).toThrow(/表名非法/);
  });

  it('表名合法性：汉字可、形如单元格引用与含空格不可', () => {
    expect(isValidTableName('费用表')).toBe(true);
    expect(isValidTableName('_t1')).toBe(true);
    expect(isValidTableName('A1')).toBe(false); // 反向对照：与单元格引用歧义
    expect(isValidTableName('有 空格')).toBe(false);
    expect(isValidTableName('1表')).toBe(false);
  });
});

describe('XLS-10 区域迁移', () => {
  it('表前插入行 ⇒ 整表下移（尺寸不变）', () => {
    const moved = migrateTableRange(makeTable(), 'row', 1, 1, 'insert');
    expect(moved.range).toBe('B4:C7');
  });

  it('数据体内插入行 ⇒ 表尾伸长（区域扩展，反向对照于"下移"）', () => {
    const grown = migrateTableRange(makeTable(), 'row', 4, 1, 'insert');
    expect(grown.range).toBe('B3:C7');
    expect(grown.totals_row_count).toBe(1);
  });

  it('反向对照：插在汇总行之后 ⇒ 表完全不动', () => {
    const same = migrateTableRange(makeTable(), 'row', 7, 1, 'insert');
    expect(same.range).toBe('B3:C6');
  });

  it('表前删除行 ⇒ 整表上移', () => {
    const moved = migrateTableRange(makeTable(), 'row', 1, 1, 'delete');
    expect(moved.range).toBe('B2:C5');
  });

  it('数据体内删除行 ⇒ 表尾收缩', () => {
    const shrunk = migrateTableRange(makeTable(), 'row', 4, 1, 'delete');
    expect(shrunk.range).toBe('B3:C5');
  });

  it('反向对照：删除触及标题行 / 汇总行 ⇒ 显式阻塞（不猜）', () => {
    expect(() => migrateTableRange(makeTable(), 'row', 3, 1, 'delete')).toThrow(/标题行 \/ 汇总行/);
    expect(() => migrateTableRange(makeTable(), 'row', 6, 1, 'delete')).toThrow(/标题行 \/ 汇总行/);
    expect(() => migrateTableRange(makeTable(), 'row', 3, 4, 'delete')).toThrow(/标题行 \/ 汇总行/);
  });

  it('列轴：表前插列整体右移；表内插列必须走 insertTableColumns', () => {
    expect(migrateTableRange(makeTable(), 'column', 1, 1, 'insert').range).toBe('C3:D6');
    expect(migrateTableRange(makeTable(), 'column', 9, 1, 'insert').range).toBe('B3:C6');
    expect(() => migrateTableRange(makeTable(), 'column', 3, 1, 'insert')).toThrow(/insertTableColumns/);
    expect(() => migrateTableRange(makeTable(), 'column', 3, 1, 'delete')).toThrow(/deleteTableColumns/);
  });

  it('insertTableColumns / deleteTableColumns 同步维护列定义与宽度', () => {
    const inserted = insertTableColumns(makeTable(), 3, ['备注']);
    expect(inserted.range).toBe('B3:D6');
    expect(inserted.columns.map((column) => column.name)).toEqual(['项目', '备注', '金额']);

    const deleted = deleteTableColumns(makeTable(), 2, 1);
    expect(deleted.range).toBe('B3:B6');
    expect(deleted.columns.map((column) => column.name)).toEqual(['金额']);

    expect(() => deleteTableColumns(makeTable(), 2, 2)).toThrow(/至少要保留一列/);
    expect(() => insertTableColumns(makeTable(), 3, ['项目'])).toThrow(/列名重复/);
  });
});

describe('XLS-10 与工作表联动', () => {
  it('insertTableRows：表范围扩展且单元格随之下移', () => {
    const { sheet, table } = insertTableRows(makeSheet(), makeTable(), 4, 1);
    expect(table.range).toBe('B3:C7');
    expect(getCellValue(sheet, 'B4')).toBe(blank); // 新插入的空行
    expect(getCellValue(sheet, 'B5')).toEqual(textValue('餐饮'));
    expect(getCellValue(sheet, 'C6')).toEqual(numberValue(200));
  });

  it('deleteTableRows：表范围收缩且下方单元格上移', () => {
    const { sheet, table } = deleteTableRows(makeSheet(), makeTable(), 4, 1);
    expect(table.range).toBe('B3:C5');
    expect(getCellValue(sheet, 'B4')).toEqual(textValue('交通'));
    expect(getCellValue(sheet, 'C4')).toEqual(numberValue(200));
  });

  it('shiftTableForColumnInsert / Delete：表随整列平移', () => {
    const inserted = shiftTableForColumnInsert(makeSheet(), makeTable(), 1, 1);
    expect(inserted.table.range).toBe('C3:D6');
    expect(getCellValue(inserted.sheet, 'C3')).toEqual(textValue('项目'));

    const deleted = shiftTableForColumnDelete(makeSheet(), makeTable(), 1, 1);
    expect(deleted.table.range).toBe('A3:B6');
    expect(getCellValue(deleted.sheet, 'A3')).toEqual(textValue('项目'));
  });
});

function childOf(element: ParsedXmlElement, localName: string): ParsedXmlElement {
  const found = findChild(element, SPREADSHEETML_NAMESPACE, localName);
  if (found === null) throw new Error(`缺少子元素 ${localName}`);
  return found;
}

function attrOf(element: ParsedXmlElement, localName: string): string | null {
  return attributeValue(element, '', localName);
}

describe('XLS-10 表定义 OOXML', () => {
  it('产出可解析的 <table> 片段：ref / 列 / 汇总 / 样式 / 筛选范围都不含汇总行', () => {
    const xml = buildTableDefinitionXml(makeTable(), 3);
    const root = parseXml(xml);
    expect(root.localName).toBe('table');
    expect(attrOf(root, 'id')).toBe('3');
    expect(attrOf(root, 'name')).toBe('费用表');
    expect(attrOf(root, 'ref')).toBe('B3:C6');
    expect(attrOf(root, 'headerRowCount')).toBe('1');
    expect(attrOf(root, 'totalsRowCount')).toBe('1');

    const columns = childOf(root, 'tableColumns');
    expect(attrOf(columns, 'count')).toBe('2');
    const columnElements = childElements(columns);
    expect(columnElements.map((element) => attrOf(element, 'name'))).toEqual(['项目', '金额']);
    const second = columnElements[1];
    if (second === undefined) throw new Error('缺少第二列');
    expect(attrOf(second, 'totalsRowFunction')).toBe('sum');

    const filter = childOf(root, 'autoFilter');
    expect(attrOf(filter, 'ref')).toBe('B3:C5'); // 反向对照：不含汇总行 6

    const style = childOf(root, 'tableStyleInfo');
    expect(attrOf(style, 'name')).toBe('TableStyleMedium2');
    expect(attrOf(style, 'showRowStripes')).toBe('1');
  });

  it('反向对照：表 id 非法直接抛错', () => {
    expect(() => buildTableDefinitionXml(makeTable(), 0)).toThrow(/id/);
  });
});
