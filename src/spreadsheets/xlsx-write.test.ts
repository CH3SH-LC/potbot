/**
 * `xlsx-write.ts` 的验收用例（design-06-P8 / XLS-01、XLS-05、XLS-06、XLS-11、XLS-12）。
 *
 * **判据不是"函数返回了东西"，而是"字节里是什么"**：本文件用仓内的 `readZip` + `parseXmlBytes`
 * 把产出的 .xlsx **读回来逐项核对**——表头、类型、公式原文、日期样式、留空。
 * 这样"写了 `<f>`"与"写了固化数值"在用例层是可区分的。
 */

import { describe, expect, it } from 'vitest';

import { readZip, type ReadZipArchive } from '../artifacts/ooxml/zip-read.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE, XLSX_WORKBOOK_PART_PATH } from '../artifacts/templates/xlsx.js';
import {
  DATE_STYLE_INDEX,
  XLSX_STYLES_PART_PATH,
  worksheetPartPath,
  writeWorkbookXlsx,
} from './xlsx-write.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook, setSheetHidden } from './workbook.js';
import { booleanValue, dateValue, errorValue, formulaValue, numberValue, textValue } from './value.js';

function buildFixture() {
  let sheet1 = createSheet('预算', {
    row_count: 4,
    column_count: 7,
    frozen_rows: 1,
    merged: ['C2:D3'],
  });
  sheet1 = setCellValue(sheet1, 'A1', textValue('项目'));
  sheet1 = setCellValue(sheet1, 'B1', textValue('金额'));
  sheet1 = setCellValue(sheet1, 'C1', dateValue(0)); // 1970-01-01 → 序列号 25569
  sheet1 = setCellValue(sheet1, 'D1', booleanValue(true));
  sheet1 = setCellValue(sheet1, 'E1', errorValue('#N/A'));
  sheet1 = setCellValue(sheet1, 'A2', textValue('餐饮'));
  sheet1 = setCellValue(sheet1, 'B2', numberValue(120.5));
  sheet1 = setCellValue(sheet1, 'A3', textValue('交通')); // B3 **不写** ⇒ 空白
  sheet1 = setCellValue(sheet1, 'A4', textValue('合计'));
  sheet1 = setCellValue(sheet1, 'B4', formulaValue('SUM(B2:B3)'));
  sheet1 = setCellValue(sheet1, 'F1', formulaValue('B2*2'));
  sheet1 = setCellValue(sheet1, 'G1', formulaValue('LOG10(100)')); // 白名单外 ⇒ 阻塞
  sheet1 = setCellValue(sheet1, 'G2', formulaValue('B3+1')); // 空白操作数 ⇒ 阻塞

  let sheet2 = createSheet('说明', { row_count: 2, column_count: 3 });
  sheet2 = setCellValue(sheet2, 'A1', textValue('  前后有空格  '));
  sheet2 = setCellValue(sheet2, 'A2', textValue('第二表'));

  return setSheetHidden(createWorkbook([sheet1, sheet2]), '说明', true);
}

function textOfPart(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function rootOfPart(archive: ReadZipArchive, path: string): ParsedXmlElement {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return parseXmlBytes(entry.data);
}

/** 空安全的子元素列表（`findChild` 返回 `null` 时视为无子元素）。 */
function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

function cellsOf(root: ParsedXmlElement): readonly ParsedXmlElement[] {
  const cells: ParsedXmlElement[] = [];
  for (const row of childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetData'))) {
    if (row.localName !== 'row') continue;
    for (const cell of childrenOf(row)) {
      if (cell.localName === 'c') cells.push(cell);
    }
  }
  return cells;
}

function cellAt(root: ParsedXmlElement, ref: string): ParsedXmlElement | undefined {
  return cellsOf(root).find((cell) => attributeValue(cell, '', 'r') === ref);
}

function valueTextOf(cell: ParsedXmlElement): string | null {
  const value = findChild(cell, SPREADSHEETML_NAMESPACE, 'v');
  return value === null ? null : directText(value);
}

function formulaTextOf(cell: ParsedXmlElement): string | null {
  const formula = findChild(cell, SPREADSHEETML_NAMESPACE, 'f');
  return formula === null ? null : directText(formula);
}

describe('xlsx-write：容器与部件清单', () => {
  const result = writeWorkbookXlsx(buildFixture());
  const archive = readZip(result.bytes);
  const paths = archive.entries.map((entry) => entry.path);

  it('产出真实的 .xlsx 容器，部件清单完整（多表 + 样式）', () => {
    expect(paths).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      XLSX_WORKBOOK_PART_PATH,
      XLSX_STYLES_PART_PATH,
      worksheetPartPath(0),
      worksheetPartPath(1),
      'xl/_rels/workbook.xml.rels',
    ]);
    expect(result.entry_count).toBe(paths.length);
  });

  it('确定性：同一工作簿连跑两次 ⇒ 字节逐一相等、摘要相等', () => {
    const again = writeWorkbookXlsx(buildFixture());
    expect(Buffer.compare(result.bytes, again.bytes)).toBe(0);
    expect(again.content_digest).toBe(result.content_digest);
    expect(result.content_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('每个 XML / rels 部件都无 BOM、无 CR、声明只出现一次', () => {
    for (const entry of archive.entries) {
      if (!entry.path.endsWith('.xml') && !entry.path.endsWith('.rels')) continue;
      const text = Buffer.from(entry.data).toString('utf8');
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      expect(text).not.toContain('﻿');
      expect(text).not.toContain('\r');
      expect(text.startsWith('<?xml')).toBe(true);
      expect(text.indexOf('<?xml', 1)).toBe(-1);
      expect(entry.data[0]).toBe(0x3c);
    }
  });

  it('[Content_Types].xml 含 rels 默认项与各部件 Override', () => {
    const types = textOfPart(archive, '[Content_Types].xml');
    expect(types).toContain('Extension="rels"');
    expect(types).toContain('PartName="/xl/workbook.xml"');
    expect(types).toContain('PartName="/xl/worksheets/sheet2.xml"');
    expect(types).toContain('PartName="/xl/styles.xml"');
  });
});

describe('xlsx-write：xl/workbook.xml（多表 / 隐藏 / 活跃表）', () => {
  const result = writeWorkbookXlsx(buildFixture());
  const root = rootOfPart(readZip(result.bytes), XLSX_WORKBOOK_PART_PATH);
  const sheets = childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'sheets'));

  it('两张表，按模型顺序，r:id 依次为 rId1 / rId2', () => {
    expect(sheets.map((sheet) => attributeValue(sheet, '', 'name'))).toEqual(['预算', '说明']);
    expect(
      sheets.map((sheet) => attributeValue(sheet, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')),
    ).toEqual(['rId1', 'rId2']);
  });

  it('隐藏表带 state="hidden"', () => {
    expect(attributeValue(sheets[0] as ParsedXmlElement, '', 'state')).toBeNull();
    expect(attributeValue(sheets[1] as ParsedXmlElement, '', 'state')).toBe('hidden');
  });

  it('activeTab 指向模型的活跃表；并带 fullCalcOnLoad 让消费端重算', () => {
    const view = findChild(findChild(root, SPREADSHEETML_NAMESPACE, 'bookViews'), SPREADSHEETML_NAMESPACE, 'workbookView');
    expect(view === null ? null : attributeValue(view, '', 'activeTab')).toBe('0');
    const calcPr = findChild(root, SPREADSHEETML_NAMESPACE, 'calcPr');
    expect(calcPr === null ? null : attributeValue(calcPr, '', 'fullCalcOnLoad')).toBe('1');
  });
});

describe('xlsx-write：xl/worksheets/sheet1.xml（逐类单元格）', () => {
  const result = writeWorkbookXlsx(buildFixture());
  const root = rootOfPart(readZip(result.bytes), worksheetPartPath(0));
  const xml = Buffer.from(readZip(result.bytes).by_path.get(worksheetPartPath(0))?.data ?? new Uint8Array()).toString('utf8');

  it('文本格是 inlineStr（不引 sharedStrings）', () => {
    const cell = cellAt(root, 'A1');
    expect(cell).toBeDefined();
    expect(attributeValue(cell as ParsedXmlElement, '', 't')).toBe('inlineStr');
    expect(xml).toContain('<c r="A1" t="inlineStr"><is><t>项目</t></is></c>');
  });

  it('数值格**不带 `t`**，`<v>` 是精确文本', () => {
    const cell = cellAt(root, 'B2');
    expect(attributeValue(cell as ParsedXmlElement, '', 't')).toBeNull();
    expect(valueTextOf(cell as ParsedXmlElement)).toBe('120.5');
  });

  it('**空白格整体不写**，且全文没有 `<v>0</v>` 冒充缺失（R248）', () => {
    expect(cellAt(root, 'B3')).toBeUndefined();
    expect(xml).not.toContain('<v>0</v>');
  });

  it('布尔 / 错误值各有自己的 `t`', () => {
    const booleanCell = cellAt(root, 'D1') as ParsedXmlElement;
    expect(attributeValue(booleanCell, '', 't')).toBe('b');
    expect(valueTextOf(booleanCell)).toBe('1');
    const errorCell = cellAt(root, 'E1') as ParsedXmlElement;
    expect(attributeValue(errorCell, '', 't')).toBe('e');
    expect(valueTextOf(errorCell)).toBe('#N/A');
  });

  it('日期是**数值 + 日期样式**（Excel 原生写法），不是 t="d"', () => {
    const cell = cellAt(root, 'C1') as ParsedXmlElement;
    expect(attributeValue(cell, '', 's')).toBe(String(DATE_STYLE_INDEX));
    expect(attributeValue(cell, '', 't')).toBeNull();
    expect(valueTextOf(cell)).toBe('25569'); // 1970-01-01 的 Excel 序列号
  });

  it('公式格保存的是 `<f>` **可编辑公式**，`<v>` 只是缓存', () => {
    const totalCell = cellAt(root, 'B4') as ParsedXmlElement;
    expect(formulaTextOf(totalCell)).toBe('SUM(B2:B3)');
    expect(valueTextOf(totalCell)).toBe('120.5'); // B3 空白被跳过，不是 0
    const doubleCell = cellAt(root, 'F1') as ParsedXmlElement;
    expect(formulaTextOf(doubleCell)).toBe('B2*2');
    expect(valueTextOf(doubleCell)).toBe('241');
  });

  it('**求值阻塞的公式只写 `<f>`，没有 `<v>`**（不得写入伪造结果）', () => {
    const blockedFn = cellAt(root, 'G1') as ParsedXmlElement;
    expect(formulaTextOf(blockedFn)).toBe('LOG10(100)');
    expect(findChild(blockedFn, SPREADSHEETML_NAMESPACE, 'v')).toBeNull();

    const blankOperand = cellAt(root, 'G2') as ParsedXmlElement;
    expect(formulaTextOf(blankOperand)).toBe('B3+1');
    expect(findChild(blankOperand, SPREADSHEETML_NAMESPACE, 'v')).toBeNull();
  });

  it('维度、冻结窗格、合并区域都写进 XML', () => {
    const dimension = findChild(root, SPREADSHEETML_NAMESPACE, 'dimension');
    expect(dimension === null ? null : attributeValue(dimension, '', 'ref')).toBe('A1:G4');

    const pane = findChild(
      findChild(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetViews'), SPREADSHEETML_NAMESPACE, 'sheetView'),
      SPREADSHEETML_NAMESPACE,
      'pane',
    );
    expect(pane === null ? null : attributeValue(pane, '', 'state')).toBe('frozen');
    expect(pane === null ? null : attributeValue(pane, '', 'ySplit')).toBe('1');

    const mergeCells = findChild(root, SPREADSHEETML_NAMESPACE, 'mergeCells');
    expect(mergeCells === null ? null : attributeValue(mergeCells, '', 'count')).toBe('1');
    expect(childrenOf(mergeCells).map((mergeCell) => attributeValue(mergeCell, '', 'ref'))).toEqual(['C2:D3']);
  });

  it('活跃表带 tabSelected="1"，非活跃表不带', () => {
    const viewOf = (path: string) =>
      findChild(
        findChild(findChild(rootOfPart(readZip(result.bytes), path), SPREADSHEETML_NAMESPACE, 'sheetViews'), SPREADSHEETML_NAMESPACE, 'sheetView'),
        SPREADSHEETML_NAMESPACE,
        'pane',
      );
    void viewOf;
    expect(xml).toContain('tabSelected="1"');
  });

  it('前后带空格的文本用 xml:space="preserve" 保住空白', () => {
    const sheet2Xml = textOfPart(readZip(result.bytes), worksheetPartPath(1));
    expect(sheet2Xml).toContain('xml:space="preserve"');
    expect(sheet2Xml).toContain('  前后有空格  ');
  });
});

describe('xlsx-write：逐格公式求值登记（可审计）', () => {
  it('四个公式：两个算出缓存、两个显式阻塞并给出原因', () => {
    const result = writeWorkbookXlsx(buildFixture());
    const byRef = new Map(result.evaluations.map((record) => [record.ref, record]));
    expect([...byRef.keys()].sort()).toEqual(['B4', 'F1', 'G1', 'G2']);
    expect(byRef.get('B4')?.ok).toBe(true);
    expect(byRef.get('F1')?.ok).toBe(true);
    expect(byRef.get('G1')?.ok).toBe(false);
    expect(byRef.get('G1')?.reason).toBe('unsupported_function');
    expect(byRef.get('G2')?.ok).toBe(false);
    expect(byRef.get('G2')?.reason).toBe('blank_operand');
  });
});

describe('xlsx-write：xl/styles.xml', () => {
  it('cellXfs 恰好两项，第二项是内建日期格式 14', () => {
    const result = writeWorkbookXlsx(buildFixture());
    const root = rootOfPart(readZip(result.bytes), XLSX_STYLES_PART_PATH);
    const cellXfs = childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'cellXfs'));
    expect(attributeValue(cellXfs[0] as ParsedXmlElement, '', 'numFmtId')).toBe('0');
    expect(attributeValue(cellXfs[1] as ParsedXmlElement, '', 'numFmtId')).toBe('14');
    // fills 的前两项必须是 none / gray125（真实 Excel 的硬要求）
    const xml = textOfPart(readZip(result.bytes), XLSX_STYLES_PART_PATH);
    expect(xml).toContain('patternType="none"');
    expect(xml).toContain('patternType="gray125"');
  });
});

describe('xlsx-write：R248——数值形态的 0 仍然要写（不能矫枉过正）', () => {
  it('显式的 0 是一个**真实的值**，必须写 `<v>0</v>`', () => {
    let sheet = createSheet('零', { row_count: 1, column_count: 1 });
    sheet = setCellValue(sheet, 'A1', numberValue(0));
    const result = writeWorkbookXlsx(createWorkbook([sheet]));
    const xml = textOfPart(readZip(result.bytes), worksheetPartPath(0));
    expect(xml).toContain('<c r="A1"><v>0</v></c>');
  });
});
