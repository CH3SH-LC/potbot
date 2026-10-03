/**
 * **X05 落盘层**：排序 / 扩表的结果写成**真实 .xlsx 字节**，并由**独立消费者重开**证明
 * 「表范围 `table/@ref` 与筛选范围 `autoFilter/@ref` 真的进了文件」（XLS-09 × XLS-10）。
 *
 * ## 为什么"读到返回值"不算数
 *
 * `data-ops.test.ts` 证明了内存状态对——但内存里 `table.range === 'B3:C8'` 与
 * "一份真实 .xlsx 的 `xl/tables/table1.xml` 里 `ref="B3:C8"`"是**两件事**。
 * 后者只能靠**真实字节 + 独立读回**证明。本文件因此**不复用写入侧的任何结构**做断言：
 *
 * - 写：走 `data-ops/xlsx-export.ts`（委托外层 `writeWorkbookXlsx`）；
 * - 读一（另一个读回器）：`xlsx-read.ts` 的 `readWorkbookXlsx`——与本层不同实现的读侧，
 *   表部件对它是**未知部件**，因此以**原样字节**落在 `residual.parts` 里，正则解析；
 * - 读二（原始容器）：`readZip`——直读 ZIP，独立核对表部件、`[Content_Types].xml`、
 *   工作表 `_rels` 与工作表 `<tableParts>` 四段自洽。
 *
 * ## 反面对照
 *
 * 同一张表在**扩表前 / 扩表后**的 `ref` 与 `autoFilter/@ref` 必须不同
 * （`B3:C7`→`B3:C8`；`B3:C6`→`B3:C7`）。若断言对两者都能通过，就说明它没在追真实字节。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import {
  DATA_OPERATION_KINDS,
  applyDataOperation,
  parseDataOperation,
} from '../../../../src/spreadsheets/data-ops/operations.js';
import { appendTableRow, sortTable } from '../../../../src/spreadsheets/data-ops/table-compose.js';
import {
  sortExpandTableXlsx,
  writeSheetXlsx,
} from '../../../../src/spreadsheets/data-ops/xlsx-export.js';
import { getCellValue, hasCell, createSheet, setCellValue, type SheetState } from '../../../../src/spreadsheets/sheet.js';
import {
  createStructuredTable,
  tableDataRange,
  tableHeaderRange,
  tableTotalsRange,
  type StructuredTable,
} from '../../../../src/spreadsheets/structured-table.js';
import { blank, numberValue, textValue, type CellValue } from '../../../../src/spreadsheets/value.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';

// ---------------------------------------------------------------------------
// 独立解析助手（不复用写入侧任何对象）
// ---------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function attrOf(xml: string, tag: string, name: string): string | null {
  const tagMatch = new RegExp(`<${tag}\\b([^>]*)`).exec(xml);
  if (tagMatch === null) return null;
  const attrMatch = new RegExp(`\\b${name}="([^"]*)"`).exec(tagMatch[1] as string);
  return attrMatch === null ? null : (attrMatch[1] as string);
}

/** 从表部件 XML 文本里抽出本用例关心的字段（纯正则，不 import 写入侧的类型）。 */
function parseTablePart(xml: string): {
  readonly ref: string | null;
  readonly autoFilterRef: string | null;
  readonly name: string | null;
  readonly displayName: string | null;
  readonly headerRowCount: string | null;
  readonly totalsRowCount: string | null;
  readonly columnCountDeclared: string | null;
  readonly columnNames: readonly string[];
} {
  const columnNames: string[] = [];
  const re = /<tableColumn\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const name = /\bname="([^"]*)"/.exec(match[1] as string);
    if (name !== null) columnNames.push(name[1] as string);
  }
  return {
    ref: attrOf(xml, 'table', 'ref'),
    autoFilterRef: attrOf(xml, 'autoFilter', 'ref'),
    name: attrOf(xml, 'table', 'name'),
    displayName: attrOf(xml, 'table', 'displayName'),
    headerRowCount: attrOf(xml, 'table', 'headerRowCount'),
    totalsRowCount: attrOf(xml, 'table', 'totalsRowCount'),
    columnCountDeclared: attrOf(xml, 'tableColumns', 'count'),
    columnNames,
  };
}

/** 用 [ref, value] 列表建表（绝对坐标）。 */
function sheetWith(cells: readonly (readonly [string, CellValue])[]): SheetState {
  let sheet = createSheet('S', { row_count: 12, column_count: 10 });
  for (const [ref, value] of cells) sheet = setCellValue(sheet, ref, value);
  return sheet;
}

// ---------------------------------------------------------------------------
// 夹具：费用表 B3:C7（标题行 3 / 数据体 4–6 / 汇总行 7）
// ---------------------------------------------------------------------------

function costTable(): StructuredTable {
  return createStructuredTable({
    name: '费用表',
    range: 'B3:C7',
    columns: ['项目', { name: '金额', totals_function: 'min' }],
    totals_row: true,
  });
}

function costSheet(): SheetState {
  return sheetWith([
    ['B3', textValue('项目')], ['C3', textValue('金额')],
    ['B4', textValue('餐饮')], ['C4', numberValue(300)],
    ['B5', textValue('交通')], ['C5', numberValue(100)],
    ['B6', textValue('住宿')], ['C6', numberValue(200)],
    ['B7', textValue('合计')], ['C7', textValue('合计金额')],
    ['D10', textValue('表外')],
  ]);
}

// ---------------------------------------------------------------------------
// 1. 排序 + 扩表 → 真实 .xlsx → 独立读回
// ---------------------------------------------------------------------------

describe('X05 落盘：排序 + 扩表写进真实 .xlsx，独立消费者重开', () => {
  it('扩表前：表 ref=B3:C7、autoFilter ref=B3:C6（反面对照的基准）', () => {
    const sorted = sortTable(costSheet(), costTable(), [{ column: 3, direction: 'asc' }]);
    const file = writeSheetXlsx(sorted.sheet, sorted.table);
    expect(file.write.table_part_paths).toEqual(['xl/tables/table1.xml']);

    const archive = readZip(file.bytes);
    const tablePart = archive.by_path.get('xl/tables/table1.xml');
    if (tablePart === undefined) throw new Error('ZIP 里找不到 xl/tables/table1.xml');
    const parsed = parseTablePart(decode(tablePart.data));
    expect(parsed.ref).toBe('B3:C7');
    expect(parsed.autoFilterRef).toBe('B3:C6'); // 汇总行不属于筛选范围
  });

  it('扩表后：内存表范围长到 B3:C8；同一条链路写出的字节里 ref=B3:C8、autoFilter ref=B3:C7', () => {
    const sorted = sortTable(costSheet(), costTable(), [{ column: 3, direction: 'asc' }]);
    expect(sorted.movedRows).toBe(3);
    const expanded = appendTableRow(sorted.sheet, sorted.table, [textValue('打车'), numberValue(50)]);

    // 内存口径（复用 X05 既有运算，非本层新增）
    expect(expanded.table.range).toBe('B3:C8');
    expect(tableHeaderRange(expanded.table)).toBe('B3:C3');
    expect(tableDataRange(expanded.table)).toBe('B4:C7');
    expect(tableTotalsRange(expanded.table)).toBe('B8:C8');
    expect(expanded.row).toBe(7);

    const file = writeSheetXlsx(expanded.sheet, expanded.table);

    // —— 读一：另一个读回器（xlsx-read.ts）把表部件当未知部件原样保留在 residual 里 ——
    const reopened = readWorkbookXlsx(file.bytes);
    const preserved = reopened.residual.parts.find((part) => part.path === 'xl/tables/table1.xml');
    if (preserved === undefined) throw new Error('residual 里没有保留表部件');
    const viaReader = parseTablePart(decode(preserved.data));
    expect(viaReader.ref).toBe('B3:C8');
    expect(viaReader.autoFilterRef).toBe('B3:C7');
    expect(viaReader.name).toBe('费用表');
    expect(viaReader.displayName).toBe('费用表');
    expect(viaReader.headerRowCount).toBe('1');
    expect(viaReader.totalsRowCount).toBe('1');
    expect(viaReader.columnCountDeclared).toBe('2');
    expect([...viaReader.columnNames]).toEqual(['项目', '金额']);

    // —— 读二：原始容器（readZip）独立核对四段自洽 ——
    const archive = readZip(file.bytes);
    const tablePart = archive.by_path.get('xl/tables/table1.xml');
    if (tablePart === undefined) throw new Error('ZIP 里找不到表部件');
    const viaZip = parseTablePart(decode(tablePart.data));
    expect(viaZip.ref).toBe('B3:C8');
    expect(viaZip.autoFilterRef).toBe('B3:C7');

    const contentTypes = archive.by_path.get('[Content_Types].xml');
    if (contentTypes === undefined) throw new Error('缺 [Content_Types].xml');
    expect(decode(contentTypes.data)).toContain('PartName="/xl/tables/table1.xml"');

    const sheetRels = archive.by_path.get('xl/worksheets/_rels/sheet1.xml.rels');
    if (sheetRels === undefined) throw new Error('缺工作表级关系部件');
    const relsText = decode(sheetRels.data);
    expect(relsText).toContain('/relationships/table');
    expect(relsText).toContain('../tables/table1.xml');

    const worksheet = archive.by_path.get('xl/worksheets/sheet1.xml');
    if (worksheet === undefined) throw new Error('缺工作表部件');
    const worksheetText = decode(worksheet.data);
    expect(worksheetText).toContain('<tableParts count="1"');
    expect(worksheetText).toContain('<tablePart r:id=');

    // 表内的排序与扩表结果确实进了单元格字节
    expect(getCellValue(reopened.workbook.sheets[0] as SheetState, 'B4')).toEqual(textValue('交通'));
    expect(getCellValue(reopened.workbook.sheets[0] as SheetState, 'C4')).toEqual(numberValue(100));
    expect(getCellValue(reopened.workbook.sheets[0] as SheetState, 'B7')).toEqual(textValue('打车'));
    expect(getCellValue(reopened.workbook.sheets[0] as SheetState, 'C7')).toEqual(numberValue(50));
    expect(getCellValue(reopened.workbook.sheets[0] as SheetState, 'B8')).toEqual(textValue('合计'));
  });

  it('sortExpandTableXlsx 一次完成：运算回执 + 真实字节（表范围已增长）', () => {
    const result = sortExpandTableXlsx(
      costSheet(),
      costTable(),
      [{ column: 3, direction: 'asc' }],
      [textValue('打车'), numberValue(50)],
    );
    expect(result.moved_rows).toBe(3);
    expect(result.appended_row).toBe(7);
    expect(result.table.range).toBe('B3:C8');
    expect(result.warnings.join(' ')).toContain('汇总行不动');
    expect(result.file.write.table_part_paths).toEqual(['xl/tables/table1.xml']);

    const archive = readZip(result.file.bytes);
    const tablePart = archive.by_path.get('xl/tables/table1.xml');
    if (tablePart === undefined) throw new Error('ZIP 里找不到表部件');
    expect(parseTablePart(decode(tablePart.data)).ref).toBe('B3:C8');
    expect(parseTablePart(decode(tablePart.data)).autoFilterRef).toBe('B3:C7');
  });

  it('反面对照：不挂表时 table_part_paths 为空、包内无表部件', () => {
    const file = writeSheetXlsx(costSheet());
    expect(file.write.table_part_paths).toEqual([]);
    const archive = readZip(file.bytes);
    expect(archive.by_path.get('xl/tables/table1.xml')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. blanks:'first' 的方向无关语义（X05 修复）落到字节
// ---------------------------------------------------------------------------

describe("X05 落盘：blanks:'first' 是结果语义，不随排序方向翻转", () => {
  /** 清单 A1:B5：键列 B 里第二行是空白。 */
  function listTable(): StructuredTable {
    return createStructuredTable({ name: '清单', range: 'A1:B5', columns: ['名', '值'] });
  }
  function listSheet(): SheetState {
    return sheetWith([
      ['A1', textValue('名')], ['B1', textValue('值')],
      ['A2', textValue('甲')], ['B2', numberValue(2)],
      ['A3', textValue('乙')], ['B3', blank],
      ['A4', textValue('丙')], ['B4', numberValue(1)],
      ['A5', textValue('丁')], ['B5', numberValue(3)],
    ]);
  }

  it('模型口径：asc / desc 下第一行数体都是空白行（方向无关）', () => {
    const asc = sortTable(listSheet(), listTable(), [{ column: 2, direction: 'asc' }], { blanks: 'first' });
    const desc = sortTable(listSheet(), listTable(), [{ column: 2, direction: 'desc' }], { blanks: 'first' });
    expect(getCellValue(asc.sheet, 'A2')).toEqual(textValue('乙'));
    expect(getCellValue(desc.sheet, 'A2')).toEqual(textValue('乙'));
    // 反向对照：默认 blanks:'last' 时空白行落到数据体末行
    const last = sortTable(listSheet(), listTable(), [{ column: 2, direction: 'desc' }]);
    expect(getCellValue(last.sheet, 'A5')).toEqual(textValue('乙'));
  });

  it('字节口径：desc + blanks:first 写盘并重开后，空白行仍在数据体第一行', () => {
    const sorted = sortTable(listSheet(), listTable(), [{ column: 2, direction: 'desc' }], { blanks: 'first' });
    const file = writeSheetXlsx(sorted.sheet, sorted.table);
    const reopened = readWorkbookXlsx(file.bytes);
    const sheet = reopened.workbook.sheets[0] as SheetState;
    expect(getCellValue(sheet, 'A2')).toEqual(textValue('乙'));
    expect(hasCell(sheet, 'B2')).toBe(false); // 空白不落显式条目
    expect(getCellValue(sheet, 'B3')).toEqual(numberValue(3)); // 丁
    expect(getCellValue(sheet, 'B4')).toEqual(numberValue(2)); // 甲
    expect(getCellValue(sheet, 'B5')).toEqual(numberValue(1)); // 丙
  });
});

// ---------------------------------------------------------------------------
// 3. 封闭 5-kind 枚举 + changedObjects / warnings 回执（集成边界上原样保留）
// ---------------------------------------------------------------------------

describe('X05 落盘：命令模式与回执在集成边界上原样保留', () => {
  it('DATA_OPERATION_KINDS 仍是封闭 5 枚举，未知 kind 显式失败', () => {
    expect([...DATA_OPERATION_KINDS]).toEqual(['sort', 'filter', 'dedupe', 'dropBlankRows', 'findReplace']);
    expect(() => parseDataOperation({ kind: 'pivot', range: 'A1:B4' })).toThrow(ValidationError);
  });

  it('JSON 命令 → applyDataOperation 的回执（changedObjects / warnings）可被落盘前的编排消费', () => {
    const op = parseDataOperation(
      JSON.parse(JSON.stringify({ kind: 'sort', range: 'A1:B3', keys: [{ column: 2, direction: 'asc' }] })),
    );
    const sheet = sheetWith([
      ['A1', textValue('甲')], ['B1', numberValue(3)],
      ['A2', textValue('乙')], ['B2', numberValue(1)],
      ['A3', textValue('丙')], ['B3', numberValue(2)],
    ]);
    const result = applyDataOperation(sheet, op);
    expect(result.changedObjects).toEqual(['A1:B3']);
    expect(result.warnings.join(' ')).toContain('不重写');
    // 回执描述的范围与落盘后重开读到的首行一致（回执不是空话）
    const file = writeSheetXlsx(result.sheet);
    const reopened = readWorkbookXlsx(file.bytes);
    expect(getCellValue(reopened.workbook.sheets[0] as SheetState, 'A1')).toEqual(textValue('乙'));
  });
});

// ---------------------------------------------------------------------------
// 4. 嵌套筛选组语义 → 真实字节
// ---------------------------------------------------------------------------

describe('X05 落盘：嵌套 and/or 筛选组的结果写盘并重开', () => {
  it('嵌套筛选组：命中的整行留下、不命中的整行删除，重开后一致', () => {
    const op = parseDataOperation({
      kind: 'filter',
      range: 'A1:B6',
      header: true,
      group: {
        op: 'and',
        conditions: [
          {
            op: 'or',
            conditions: [
              { column: 2, operator: 'greaterThanOrEqual', value: { kind: 'number', value: 80 } },
              { column: 1, operator: 'equals', value: { kind: 'text', value: '丙' } },
            ],
          },
        ],
      },
    });
    const sheet = sheetWith([
      ['A1', textValue('名')], ['B1', textValue('分')],
      ['A2', textValue('甲')], ['B2', numberValue(90)],
      ['A3', textValue('乙')], ['B3', numberValue(55)],
      ['A4', textValue('丙')], ['B4', numberValue(70)],
      ['A5', textValue('丁')], ['B5', numberValue(40)],
      ['A6', textValue('戊')], ['B6', numberValue(80)],
    ]);
    const result = applyDataOperation(sheet, op);
    expect(result.changedObjects).toEqual(['A1:B6']);
    expect(result.warnings).toEqual([]);

    const file = writeSheetXlsx(result.sheet);
    const reopened = readWorkbookXlsx(file.bytes);
    const read = reopened.workbook.sheets[0] as SheetState;
    // 标题行钉住（header:true 才不会被当作数据行筛掉）
    expect(getCellValue(read, 'A1')).toEqual(textValue('名'));
    expect(getCellValue(read, 'B1')).toEqual(textValue('分'));
    expect(getCellValue(read, 'A2')).toEqual(textValue('甲'));
    expect(getCellValue(read, 'B2')).toEqual(numberValue(90));
    expect(getCellValue(read, 'A3')).toEqual(textValue('丙'));
    expect(getCellValue(read, 'B3')).toEqual(numberValue(70));
    expect(getCellValue(read, 'A4')).toEqual(textValue('戊'));
    expect(getCellValue(read, 'B4')).toEqual(numberValue(80));
    // 被筛掉的行不残留
    expect(hasCell(read, 'A5')).toBe(false);
    expect(hasCell(read, 'B5')).toBe(false);
  });
});
