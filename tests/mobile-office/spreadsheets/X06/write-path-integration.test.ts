/**
 * **X06（增量 / X-I11）**：保护**真的落进 .xlsx 字节**了吗？（写侧接线验收）
 *
 * 本文件不只看函数返回值，而是把 `writeWorkbookXlsx` 产出的**真实容器字节**用仓内 `readZip`
 * 读回，再用 `parseXmlBytes` 定位工作表里的 `<sheetProtection>`，核对：
 *
 * 1. **正向**：给出 `sheet_protection` ⇒ `xl/worksheets/sheet1.xml` 里出现 `<sheetProtection>`，
 *    `password` 属性是遗留哈希（`CE88`），且它的**兄弟元素次序**是 `sheetData` 之后（CT_Worksheet 序列）；
 * 2. **反向对照**：不给该输入 ⇒ 工作表里**没有** `<sheetProtection>`（不凭空注入）。
 *
 * 这直接回答 X06 遗留的"protection exists but is unwired"：写侧（X-I02 的 `xlsx-write.ts`）已把
 * `buildSheetProtectionElement` 接到 `SheetExtras.sheet_protection`。
 *
 * 注：只 import 写侧 / 读侧（**只读依赖**），不改动它们。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { childElements, findChild, parseXmlBytes } from '../../../../src/documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import { worksheetPartPath, writeWorkbookXlsx, type XlsxWriteExtras } from '../../../../src/spreadsheets/xlsx-write.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { numberValue } from '../../../../src/spreadsheets/value.js';
import { protectSheet } from '../../../../src/spreadsheets/protection/index.js';

function buildWorkbook() {
  let sheet = createSheet('S');
  sheet = setCellValue(sheet, 'A1', numberValue(1));
  sheet = setCellValue(sheet, 'B1', numberValue(2));
  return createWorkbook([sheet]);
}

function sheetRootOf(bytes: Uint8Array) {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(worksheetPartPath(0));
  if (entry === undefined) throw new Error('缺少工作表部件');
  return parseXmlBytes(entry.data);
}

const PROTECTED: XlsxWriteExtras = {
  sheets: { S: { sheet_protection: protectSheet({ password: 'a', format_cells: false, select_locked_cells: true }) } },
};

describe('X06-P §1 写侧接线：保护落进工作表字节', () => {
  it('给出 sheet_protection ⇒ 工作表里出现 <sheetProtection password="CE88">', () => {
    const bytes = writeWorkbookXlsx(buildWorkbook(), undefined, PROTECTED).bytes;
    const root = sheetRootOf(bytes);
    const element = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetProtection');
    expect(element).not.toBeNull();
    const password = element?.attributes.find((attribute) => attribute.name === 'password');
    expect(password?.value).toBe('CE88');
  });

  it('位置正确：<sheetProtection> 紧跟 <sheetData> 之后（CT_Worksheet 序列）', () => {
    const bytes = writeWorkbookXlsx(buildWorkbook(), undefined, PROTECTED).bytes;
    const root = sheetRootOf(bytes);
    const order = childElements(root).map((child) => child.localName);
    expect(order.indexOf('sheetProtection')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('sheetProtection')).toBe(order.indexOf('sheetData') + 1);
  });

  it('显式 false 的项写出 "0"（formatCells 缺省 true ⇒ 放开要显式写）', () => {
    const bytes = writeWorkbookXlsx(buildWorkbook(), undefined, PROTECTED).bytes;
    const root = sheetRootOf(bytes);
    const element = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetProtection');
    const formatCells = element?.attributes.find((attribute) => attribute.name === 'formatCells');
    expect(formatCells?.value).toBe('0');
  });

  it('反向对照：不给 sheet_protection ⇒ 工作表里没有 <sheetProtection>', () => {
    const bytes = writeWorkbookXlsx(buildWorkbook()).bytes;
    const root = sheetRootOf(bytes);
    expect(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetProtection')).toBeNull();
  });
});
