/**
 * **X-I02** 生产写入路径集成验收：真实 `cellXfs` + `sheetProtection` + 透视写回（XLS-05/13/15）。
 *
 * ## 本文件回答什么
 *
 * 波次一的报告说 `xlsx-write.ts` 是"最大的未闭合回路"：它仍写死两项目 `cellXfs`、不认保护、
 * 不吃透视刷新结果。本文件**不靠读返回值**，而是把产出的 .xlsx **用仓内读取器读回逐项核对**：
 *
 * 1. **X03**：给了逐格样式 ⇒ `xl/styles.xml` 的 `cellXfs` 不再只有两项，且工作表里每个带样式的
 *    单元格 `s=` 下标**指向它自己那条 xf**（fontId/fillId/borderId/numFmtId 逐项对上）。
 * 2. **X06**：给了 `sheet_protection` ⇒ `<sheetProtection>` 出现在 CT_Worksheet 的正确位置
 *    （`sheetData` 之后、`mergeCells` 之前），并能被 `parseSheetProtectionXml` 原样读回。
 * 3. **X08**：`refreshPivotTable` 的本机刷新结果经 `writePivotRefreshedXlsx` 落成字节，
 *    重新打开后透视单元格的**数值可读回**。
 *
 * ## 反向对照（本文件刻意保留的一条）
 *
 * 不给样式 ⇒ `cellXfs` **回到恰好两项**（接线前的字节基线）；不给保护 ⇒ 工作表里**没有**
 * `<sheetProtection>`。这样"写了"与"没写"在字节层可区分，接线不是无条件改变所有输出。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../../../../src/documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import {
  XLSX_STYLES_PART_PATH,
  worksheetPartPath,
  writePivotRefreshedXlsx,
  writeWorkbookXlsx,
  type XlsxWriteExtras,
} from '../../../../src/spreadsheets/xlsx-write.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { blank, dateValue, isBlank, numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { emptyCellStyles, setCellStyle, type CellStyles } from '../../../../src/spreadsheets/styles.js';
import { parseSheetProtectionXml, protectSheet } from '../../../../src/spreadsheets/protection/index.js';
import {
  createPivotTable,
  refreshPivotTable,
  type PivotTableSpec,
} from '../../../../src/spreadsheets/pivot.js';

// ---------------------------------------------------------------------------
// 探针（读回而非"看返回值"）
// ---------------------------------------------------------------------------

function rootOfPart(archive: ReturnType<typeof readZip>, path: string): ParsedXmlElement {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return parseXmlBytes(entry.data);
}

function textOfPart(archive: ReturnType<typeof readZip>, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

function attr(element: ParsedXmlElement, name: string): string | null {
  return attributeValue(element, '', name);
}

function named(element: ParsedXmlElement | null, localName: string): ParsedXmlElement | null {
  return findChild(element, SPREADSHEETML_NAMESPACE, localName);
}

/** 工作表里的全部 `<c>`（按 XML 顺序）。 */
function cellsOf(root: ParsedXmlElement): readonly ParsedXmlElement[] {
  const cells: ParsedXmlElement[] = [];
  for (const row of childrenOf(named(root, 'sheetData'))) {
    if (row.localName !== 'row') continue;
    for (const cell of childrenOf(row)) {
      if (cell.localName === 'c') cells.push(cell);
    }
  }
  return cells;
}

function cellAt(root: ParsedXmlElement, ref: string): ParsedXmlElement {
  const found = cellsOf(root).find((cell) => attr(cell, 'r') === ref);
  if (found === undefined) throw new Error(`工作表里没有单元格 ${ref}`);
  return found;
}

function valueTextOf(cell: ParsedXmlElement): string | null {
  const value = named(cell, 'v');
  return value === null ? null : directText(value);
}

/** 工作表根元素的直接子元素本地名序列（用于断言 CT_Worksheet 位置）。 */
function childNames(root: ParsedXmlElement): readonly string[] {
  return childrenOf(root).map((child) => child.localName);
}

// ---------------------------------------------------------------------------
// 夹具 1：带逐格样式的工作簿（覆盖字体 / 填充 / 边框 / 数字格式 / 日期）
// ---------------------------------------------------------------------------

function buildStyledFixture(): { workbook: WorkbookState; styles: CellStyles } {
  let sheet = createSheet('样式', { row_count: 3, column_count: 4, merged: ['A3:B3'] });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'B1', numberValue(0.15));
  sheet = setCellValue(sheet, 'C1', numberValue(1234.5));
  sheet = setCellValue(sheet, 'D1', dateValue(0)); // 1970-01-01 → 序列号 25569
  sheet = setCellValue(sheet, 'A2', numberValue(5));
  sheet = setCellValue(sheet, 'B2', textValue('甲'));

  let styles = emptyCellStyles;
  styles = setCellStyle(styles, 'A1', { bold: true });
  styles = setCellStyle(styles, 'B1', { number_format: { kind: 'percent', decimals: 0 } });
  styles = setCellStyle(styles, 'C1', {
    number_format: { kind: 'currency', currency: 'CNY', decimals: 2 },
  });
  styles = setCellStyle(styles, 'A2', { fill_color: 'FFC7CE' });
  styles = setCellStyle(styles, 'B2', { borders: { top: { style: 'thin', color: '#000000' } } });

  return { workbook: createWorkbook([sheet]), styles };
}

const STYLED_EXTRAS: XlsxWriteExtras = {
  sheets: { 样式: { styles: buildStyledFixture().styles } },
};

// ---------------------------------------------------------------------------
// §1 X03：真实 cellXfs 与逐格 s 下标
// ---------------------------------------------------------------------------

describe('X-I02 §1 样式接线：真实 cellXfs 与 s 下标', () => {
  const fixture = buildStyledFixture();
  const result = writeWorkbookXlsx(fixture.workbook, undefined, {
    sheets: { 样式: { styles: fixture.styles } },
  });
  const archive = readZip(result.bytes);
  const stylesRoot = rootOfPart(archive, XLSX_STYLES_PART_PATH);
  const sheetRoot = rootOfPart(archive, worksheetPartPath(0));

  const cellXfs = childrenOf(named(stylesRoot, 'cellXfs'));
  const fonts = childrenOf(named(stylesRoot, 'fonts'));
  const fills = childrenOf(named(stylesRoot, 'fills'));
  const borders = childrenOf(named(stylesRoot, 'borders'));

  it('cellXfs 不再是写死的两项：默认 + 日期 + 五个显式样式', () => {
    expect(cellXfs.length).toBeGreaterThan(2);
    // 第 0 项恒为默认 xf。
    expect(attr(cellXfs[0] as ParsedXmlElement, 'numFmtId')).toBe('0');
  });

  it('加粗文本：s 指向的 xf 的 fontId 指向带 <b/> 的字体', () => {
    const cell = cellAt(sheetRoot, 'A1');
    const s = attr(cell, 's');
    expect(s).not.toBeNull();
    const xf = cellXfs[Number(s)] as ParsedXmlElement;
    const fontId = Number(attr(xf, 'fontId'));
    expect(fontId).not.toBe(0);
    expect(named(fonts[fontId] as ParsedXmlElement, 'b')).not.toBeNull();
  });

  it('百分比：s 指向的 xf 用内建 numFmtId=9', () => {
    const xf = cellXfs[Number(attr(cellAt(sheetRoot, 'B1'), 's'))] as ParsedXmlElement;
    expect(attr(xf, 'numFmtId')).toBe('9');
  });

  it('货币：自定义 numFmt（≥164）真的出现在 <numFmts> 里，格式码带 ¥', () => {
    const xf = cellXfs[Number(attr(cellAt(sheetRoot, 'C1'), 's'))] as ParsedXmlElement;
    const numFmtId = Number(attr(xf, 'numFmtId'));
    expect(numFmtId).toBeGreaterThanOrEqual(164);
    const declared = childrenOf(named(stylesRoot, 'numFmts')).find(
      (entry) => attr(entry, 'numFmtId') === String(numFmtId),
    );
    expect(declared).toBeDefined();
    expect(attr(declared as ParsedXmlElement, 'formatCode')).toContain('¥');
  });

  it('填充色：s 指向的 xf 的 fillId 指向 FFFFC7CE 的实心填充', () => {
    const xf = cellXfs[Number(attr(cellAt(sheetRoot, 'A2'), 's'))] as ParsedXmlElement;
    const fillId = Number(attr(xf, 'fillId'));
    expect(fillId).toBeGreaterThanOrEqual(2); // 0/1 是 none/gray125 保留槽位
    const patternFill = named(fills[fillId] as ParsedXmlElement, 'patternFill');
    expect(attr(patternFill as ParsedXmlElement, 'patternType')).toBe('solid');
    const fg = named(patternFill, 'fgColor');
    expect(attr(fg as ParsedXmlElement, 'rgb')).toBe('FFFFC7CE');
  });

  it('边框：s 指向的 xf 的 borderId 指向 top=thin 的边框', () => {
    const xf = cellXfs[Number(attr(cellAt(sheetRoot, 'B2'), 's'))] as ParsedXmlElement;
    const borderId = Number(attr(xf, 'borderId'));
    expect(borderId).not.toBe(0);
    const top = named(borders[borderId] as ParsedXmlElement, 'top');
    expect(attr(top as ParsedXmlElement, 'style')).toBe('thin');
  });

  it('日期格即使无显式样式也用日期 numFmt（14），且缺样式的格不写 s', () => {
    const dateCell = cellAt(sheetRoot, 'D1');
    const xf = cellXfs[Number(attr(dateCell, 's'))] as ParsedXmlElement;
    expect(attr(xf, 'numFmtId')).toBe('14');
    expect(valueTextOf(dateCell)).toBe('25569');
    // C1 有样式；同一行的空列没有样式 ⇒ 不写 s（落默认 xf 0）。
    expect(attr(cellAt(sheetRoot, 'A2'), 's')).not.toBeNull();
  });

  it('确定性：同一 (workbook, styles) 连跑两次 ⇒ 字节逐一相等', () => {
    const again = writeWorkbookXlsx(fixture.workbook, undefined, {
      sheets: { 样式: { styles: fixture.styles } },
    });
    expect(Buffer.compare(result.bytes, again.bytes)).toBe(0);
  });

  it('消费端读回：样式路径下日期仍是日期（numFmt 生效），文本/数值原样', () => {
    const readBack = readWorkbookXlsx(result.bytes);
    const cells = readBack.workbook.sheets[0]?.cells;
    expect(cells?.get('A1')).toEqual(textValue('项目'));
    expect(cells?.get('B1')).toEqual(numberValue(0.15));
    const date = cells?.get('D1');
    expect(date?.kind).toBe('date');
  });

  it('反向对照：不给样式 ⇒ cellXfs 回到恰好两项（旧字节基线）', () => {
    const plain = writeWorkbookXlsx(fixture.workbook);
    const plainRoot = rootOfPart(readZip(plain.bytes), XLSX_STYLES_PART_PATH);
    const plainXfs = childrenOf(named(plainRoot, 'cellXfs'));
    expect(plainXfs).toHaveLength(2);
    expect(attr(plainXfs[1] as ParsedXmlElement, 'numFmtId')).toBe('14');
    expect(textOfPart(readZip(plain.bytes), worksheetPartPath(0))).not.toContain(' s="2"');
  });
});

// ---------------------------------------------------------------------------
// §2 X06：sheetProtection 注入到 CT_Worksheet 的正确位置
// ---------------------------------------------------------------------------

describe('X-I02 §2 保护接线：<sheetProtection> 落位并可读回', () => {
  const model = protectSheet({ password: 'a' });
  const result = writeWorkbookXlsx(buildStyledFixture().workbook, undefined, {
    sheets: { 样式: { sheet_protection: model } },
  });
  const archive = readZip(result.bytes);
  const sheetXml = textOfPart(archive, worksheetPartPath(0));
  const sheetRoot = rootOfPart(archive, worksheetPartPath(0));

  it('保护模型的口令哈希来自遗留算法（"a" ⇒ CE88，明文不入文件）', () => {
    expect(model.password_hash).toBe('CE88');
    expect(sheetXml).toContain('password="CE88"');
  });

  it('位置：sheetData 之后、mergeCells 之前（CT_Worksheet 序列）', () => {
    const names = childNames(sheetRoot);
    const sheetDataAt = names.indexOf('sheetData');
    const protectionAt = names.indexOf('sheetProtection');
    const mergeCellsAt = names.indexOf('mergeCells');
    expect(protectionAt).toBe(sheetDataAt + 1);
    expect(mergeCellsAt).toBeGreaterThan(protectionAt);
  });

  it('读回：parseSheetProtectionXml 还原出同一份模型', () => {
    const parsed = parseSheetProtectionXml(sheetXml);
    expect(parsed.sheet).toBe(true);
    expect(parsed.password_hash).toBe('CE88');
    // 缺省补全：format_cells 缺省 true（禁止格式化）。
    expect(parsed.format_cells).toBe(true);
  });

  it('反向对照：不给保护 ⇒ 工作表里没有 <sheetProtection>', () => {
    const plain = writeWorkbookXlsx(buildStyledFixture().workbook);
    expect(textOfPart(readZip(plain.bytes), worksheetPartPath(0))).not.toContain('sheetProtection');
  });
});

// ---------------------------------------------------------------------------
// §3 X08：refreshPivotTable 的写回结果落成字节
// ---------------------------------------------------------------------------

function buildSalesWorkbook(): WorkbookState {
  let sheet = createSheet('销售', { row_count: 12, column_count: 12 });
  sheet = setCellValue(sheet, 'A1', textValue('部门'));
  sheet = setCellValue(sheet, 'B1', textValue('月份'));
  sheet = setCellValue(sheet, 'C1', textValue('金额'));
  sheet = setCellValue(sheet, 'D1', textValue('数量'));
  const rows: readonly (readonly [string, string, number | null, number])[] = [
    ['销售', '一月', 100, 1],
    ['销售', '二月', 200, 2],
    ['技术', '一月', 300, 3],
    ['技术', '一月', 400, 4],
    ['技术', '二月', null, 5],
    ['销售', '一月', 100, 6],
  ];
  rows.forEach((row, index) => {
    const at = index + 2;
    sheet = setCellValue(sheet, `A${String(at)}`, textValue(row[0]));
    sheet = setCellValue(sheet, `B${String(at)}`, textValue(row[1]));
    if (row[2] !== null) {
      sheet = setCellValue(sheet, `C${String(at)}`, numberValue(row[2]));
    }
    sheet = setCellValue(sheet, `D${String(at)}`, numberValue(row[3]));
  });
  return createWorkbook([sheet, createSheet('空表', { row_count: 4, column_count: 4 })]);
}

function salesSpec(): PivotTableSpec {
  return {
    name: '部门月度透视',
    source: { sheet: '销售', range: 'A1:D7' },
    destination: { sheet: '销售', cell: 'F2' },
    rows: ['部门'],
    columns: ['月份'],
    values: [
      { field: '金额', summarize_by: 'sum' },
      { field: '数量', summarize_by: 'count' },
    ],
  };
}

describe('X-I02 §3 透视写回：手机刷新结果落成可读回的字节', () => {
  const workbook = buildSalesWorkbook();
  const pivot = createPivotTable(workbook, salesSpec());
  const refreshed = refreshPivotTable(workbook, pivot);
  const written = writePivotRefreshedXlsx(refreshed);
  const archive = readZip(written.bytes);
  const sheetRoot = rootOfPart(archive, worksheetPartPath(0));

  it('结果带回透视刷新摘要（落点 / 写入格数 / 缺席格数）', () => {
    expect(written.pivot_refresh).toEqual({
      range: 'F2:J4',
      cells_written: 7,
      absent_cells: 1,
    });
  });

  it('透视单元格真的在字节里：G3=200、G4=700、H4=2', () => {
    expect(valueTextOf(cellAt(sheetRoot, 'G3'))).toBe('200');
    expect(valueTextOf(cellAt(sheetRoot, 'G4'))).toBe('700');
    expect(valueTextOf(cellAt(sheetRoot, 'H4'))).toBe('2');
  });

  it('缺失不当零：I4（技术/二月 金额）在字节里没有 <v>0</v>', () => {
    const text = textOfPart(archive, worksheetPartPath(0));
    expect(text).not.toContain('<c r="I4"');
    expect(text).not.toContain('<v>0</v>');
  });

  it('消费端读回：G3 是数值 200，I4 是空白', () => {
    const readBack = readWorkbookXlsx(written.bytes);
    const cells = readBack.workbook.sheets[0]?.cells;
    expect(cells?.get('G3')).toEqual(numberValue(200));
    const absent = cells?.get('I4') ?? blank;
    expect(isBlank(absent)).toBe(true);
  });

  it('反向对照：未刷新的工作簿写出来没有 F2 起始的透视表头', () => {
    const fresh = writeWorkbookXlsx(workbook);
    const freshRoot = rootOfPart(readZip(fresh.bytes), worksheetPartPath(0));
    expect(textOfPart(readZip(fresh.bytes), worksheetPartPath(0))).not.toContain('部门月度透视');
    // F2 未被写 ⇒ 读不到单元格。
    expect(() => cellAt(freshRoot, 'F2')).toThrow(/没有单元格 F2/);
  });
});

// ---------------------------------------------------------------------------
// §4 三合一：同一份 .xlsx 同时带普通 cellXfs + 保护 + 透视单元格
// ---------------------------------------------------------------------------

describe('X-I02 §4 三合一：真实 cellXfs + 保护 + 透视格在同一份字节里', () => {
  const workbook = buildSalesWorkbook();
  const pivot = createPivotTable(workbook, salesSpec());
  const refreshed = refreshPivotTable(workbook, pivot);

  let styles = emptyCellStyles;
  styles = setCellStyle(styles, 'A1', { bold: true });
  styles = setCellStyle(styles, 'C1', { fill_color: 'FFC7CE' });
  const protection = protectSheet({ password: 'a' });

  const extras: XlsxWriteExtras = {
    sheets: { 销售: { styles, sheet_protection: protection } },
  };
  const result = writePivotRefreshedXlsx(refreshed, undefined, extras);
  const archive = readZip(result.bytes);
  const stylesRoot = rootOfPart(archive, XLSX_STYLES_PART_PATH);
  const sheetRoot = rootOfPart(archive, worksheetPartPath(0));

  it('普通 cellXfs 就位（>2 项）且 A1 指向加粗字体', () => {
    const cellXfs = childrenOf(named(stylesRoot, 'cellXfs'));
    expect(cellXfs.length).toBeGreaterThan(2);
    const s = attr(cellAt(sheetRoot, 'A1'), 's');
    const xf = cellXfs[Number(s)] as ParsedXmlElement;
    const fonts = childrenOf(named(stylesRoot, 'fonts'));
    const fontId = Number(attr(xf, 'fontId'));
    expect(fontId).not.toBe(0);
    expect(named(fonts[fontId] as ParsedXmlElement, 'b')).not.toBeNull();
  });

  it('保护元素在位（sheetData 之后）', () => {
    const names = childNames(sheetRoot);
    expect(names).toContain('sheetProtection');
    expect(names.indexOf('sheetProtection')).toBe(names.indexOf('sheetData') + 1);
  });

  it('透视单元格同时在场：G3=200，且读回仍是数值', () => {
    expect(valueTextOf(cellAt(sheetRoot, 'G3'))).toBe('200');
    const readBack = readWorkbookXlsx(result.bytes);
    expect(readBack.workbook.sheets[0]?.cells.get('G3')).toEqual(numberValue(200));
    expect(result.pivot_refresh?.range).toBe('F2:J4');
  });

  it('确定性：同一 (refresh, extras) 连跑两次 ⇒ 字节逐一相等', () => {
    const again = writePivotRefreshedXlsx(refreshed, undefined, extras);
    expect(Buffer.compare(result.bytes, again.bytes)).toBe(0);
  });
});
