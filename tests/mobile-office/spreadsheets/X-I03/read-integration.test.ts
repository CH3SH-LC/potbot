/**
 * **X-I03 集成验收**：`xlsx-read.ts` 的生产读路径（打印设置 / 保护 / 数据验证 / 条件格式 /
 * ZIP 上限 / 现代错误值）。
 *
 * 判据全部落在**真实 .xlsx 字节**上，不 mock：
 * 1. X-R05：手机把 `PrintPlan` 注入字节后，`readWorkbookXlsx` 必须把
 *    `pageSetup/pageMargins/headerFooter/rowBreaks/colBreaks/printOptions` 与
 *    `_xlnm.Print_Area` / `_xlnm.Print_Titles` **读回成 `PrintPlan`**；
 *    并且读回的打印计划经生产装配器 `assembleWorkbookPackage` 再保存后**仍在文件里**
 *    （这是本单元能闭合的"open→save"生产路径；低层 `xls-io` 的保存仍待写侧接线，见残留）。
 * 2. X06：`<sheetProtection>` / `<workbookProtection>` / `<dataValidations>` /
 *    `<conditionalFormatting>` / `<dxfs>` 经保护包 + `validation.ts` + `conditional-format.ts`
 *    的解析器读回。
 * 3. X-R04：可选 `limits` 透传到 `readZip`（非法上限被 `ZipReadError` 拒绝）。
 * 4. X-R01：读侧接受现代 Excel 错误值（`#SPILL!` 等），真正未知的仍显式失败（`#WAT!`）。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { readZip, ZipReadError } from '../../../../src/artifacts/ooxml/zip-read.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';
import { assembleWorkbookPackage } from '../../../../src/spreadsheets/package-assembly.js';
import {
  createPrintLayout,
  createPrintPlan,
  getSheetPrint,
  insertDefinedNamesXml,
  insertSheetPrintXml,
  setSheetPrint,
  type PrintPlan,
} from '../../../../src/spreadsheets/print-layout.js';
import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { EMPTY_RESIDUAL, writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';

const SHEET_ORDER = ['预算', '明细'] as const;

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encode(text: string): Buffer {
  return Buffer.from(new TextEncoder().encode(text));
}

function budgetWorkbook() {
  let budget = createSheet('预算', { row_count: 12, column_count: 4 });
  budget = setCellValue(budget, 'A1', textValue('项目'));
  budget = setCellValue(budget, 'B1', numberValue(100));
  budget = setCellValue(budget, 'A2', textValue('餐饮'));
  budget = setCellValue(budget, 'B2', numberValue(120.5));
  let detail = createSheet('明细', { row_count: 3, column_count: 3 });
  detail = setCellValue(detail, 'A1', textValue('明细'));
  return createWorkbook([budget, detail]);
}

/** 手机侧打印计划：预算表设齐打印区域 / 方向 / 纸张 / 边距 / 重复标题 / 分页 / 页眉脚 / 选项。 */
function budgetPrintPlan(): PrintPlan {
  const layout = createPrintLayout({
    print_area: '$A$1:$D$12',
    orientation: 'landscape',
    paper_size: 'a4',
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    repeat_rows: '1:1',
    repeat_columns: 'A:A',
    scaling: { kind: 'percent', percent: 85 },
    header_footer: { odd_header: '&C预算表', odd_footer: '&R第 &P 页 / 共 &N 页' },
    options: { grid_lines: true, horizontal_centered: true },
    row_breaks: [6],
    column_breaks: [3],
  });
  return setSheetPrint(createPrintPlan(), '预算', layout);
}

/**
 * 把打印计划**注入字节**：工作表 XML 走 `insertSheetPrintXml`，工作簿 XML 走
 * `insertDefinedNamesXml`（`print-layout.ts` 文档化的两段注入，等价于手机侧落盘）。
 */
function injectPrint(bytes: Uint8Array, plan: PrintPlan, sheetOrder: readonly string[]): Buffer {
  const archive = readZip(bytes);
  const nameByPart = new Map(sheetOrder.map((name, index) => [`xl/worksheets/sheet${String(index + 1)}.xml`, name]));
  const entries = archive.entries.map((entry) => {
    const sheetName = nameByPart.get(entry.path);
    if (sheetName !== undefined) {
      const layout = getSheetPrint(plan, sheetName);
      if (layout !== undefined) {
        return { path: entry.path, data: encode(insertSheetPrintXml(utf8(entry.data), layout)) };
      }
    }
    if (entry.path === XLSX_WORKBOOK_PART_PATH) {
      return { path: entry.path, data: encode(insertDefinedNamesXml(utf8(entry.data), plan, sheetOrder)) };
    }
    return { path: entry.path, data: entry.data };
  });
  return writeZip(entries);
}

/** 手工装一个最小单表包（用于构造本仓写出器不产出的形状，如保护 / 现代错误值）。 */
function singleSheetPackage(sheetXml: string, workbookBody = ''): Uint8Array {
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    workbookBody +
    `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const parts: OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
    { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
  ];
  const relationships: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
    },
  ];
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });
  return writeZip(assembled.entries);
}

function worksheetXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>${body}</sheetData></worksheet>`
  );
}

// ---------------------------------------------------------------------------
// X-R05：打印设置读回 + 生产保存路径的存活
// ---------------------------------------------------------------------------

describe('X-I03 / X-R05 打印设置读回', () => {
  const injected = injectPrint(writeWorkbookXlsx(budgetWorkbook()).bytes, budgetPrintPlan(), SHEET_ORDER);

  it('读回 worksheet 级设置（pageSetup / pageMargins / headerFooter / 分页 / printOptions）', () => {
    const result = readWorkbookXlsx(injected);
    const entry = result.print.entries.find((item) => item.sheet === '预算');
    expect(entry).toBeDefined();
    const layout = entry?.layout;
    expect(layout?.orientation).toBe('landscape');
    expect(layout?.paper_size).toBe('a4');
    expect(layout?.scaling).toEqual({ kind: 'percent', percent: 85 });
    expect(layout?.margins).toEqual({ left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 });
    expect(layout?.header_footer).toEqual({ odd_header: '&C预算表', odd_footer: '&R第 &P 页 / 共 &N 页' });
    expect(layout?.options).toEqual({ grid_lines: true, horizontal_centered: true });
    expect(layout?.row_breaks).toEqual([6]);
    expect(layout?.column_breaks).toEqual([3]);
  });

  it('读回 definedNames 的 _xlnm.Print_Area / _xlnm.Print_Titles', () => {
    const result = readWorkbookXlsx(injected);
    const layout = result.print.entries.find((item) => item.sheet === '预算')?.layout;
    expect(layout?.print_area).toBe('$A$1:$D$12');
    expect(layout?.repeat_rows).toBe('1:1');
    expect(layout?.repeat_columns).toBe('A:A');
  });

  it('没设打印的明细表不出现在打印计划里（不写默认值冒充）', () => {
    const result = readWorkbookXlsx(injected);
    expect(result.print.entries.map((item) => item.sheet)).toEqual(['预算']);
  });

  it('**open→save 生产路径**：读回的打印计划经 assembleWorkbookPackage 再保存后仍在文件里', () => {
    const first = readWorkbookXlsx(injected);
    const saved = assembleWorkbookPackage(first.workbook, { print: first.print });
    const second = readWorkbookXlsx(saved.bytes);
    const before = first.print.entries.find((item) => item.sheet === '预算')?.layout;
    const after = second.print.entries.find((item) => item.sheet === '预算')?.layout;
    expect(after).toEqual(before);
    // 正向核验：字节里确实带回了那两个 definedName 与 pageSetup
    const archive = readZip(saved.bytes);
    const workbookXml = utf8(archive.by_path.get(XLSX_WORKBOOK_PART_PATH)?.data ?? new Uint8Array());
    expect(workbookXml).toContain('_xlnm.Print_Area');
    const sheetXml = utf8(archive.by_path.get('xl/worksheets/sheet1.xml')?.data ?? new Uint8Array());
    expect(sheetXml).toContain('<pageSetup');
    expect(sheetXml).toContain('landscape');
  });

  it('无打印设置的普通工作簿：print 计划为空（不虚构）', () => {
    const plain = writeWorkbookXlsx(budgetWorkbook()).bytes;
    expect(readWorkbookXlsx(plain).print.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// X-R04：ZIP 读取上限透传
// ---------------------------------------------------------------------------

describe('X-I03 / X-R04 readZip limits 透传', () => {
  const bytes = writeWorkbookXlsx(budgetWorkbook()).bytes;

  it('收紧上限 ⇒ readZip 拒绝（ZipReadError），默认上限 ⇒ 通过', () => {
    expect(() => readWorkbookXlsx(bytes, { limits: { maxEntries: 1 } })).toThrow(ZipReadError);
    expect(readWorkbookXlsx(bytes).workbook.sheets.map((sheet) => sheet.name)).toEqual(['预算', '明细']);
  });

  it('非法上限（负数）被 ZipReadError 显式拒绝', () => {
    expect(() => readWorkbookXlsx(bytes, { limits: { maxEntryUncompressedBytes: -1 } })).toThrow(ZipReadError);
  });
});

// ---------------------------------------------------------------------------
// X-R01：现代错误值
// ---------------------------------------------------------------------------

describe('X-I03 / X-R01 现代 Excel 错误值', () => {
  it('#SPILL! 被读成 error 单元（不再是"整份文件读不了"）', () => {
    const bytes = singleSheetPackage(worksheetXml('<row r="1"><c r="A1" t="e"><v>#SPILL!</v></c></row>'));
    const sheet = readWorkbookXlsx(bytes).workbook.sheets[0];
    expect(sheet).toBeDefined();
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual({ kind: 'error', code: '#SPILL!' });
  });

  it('#SPILL! 往返：读回 → 写出 → 再读，错误码不变', () => {
    const bytes = singleSheetPackage(worksheetXml('<row r="1"><c r="A1" t="e"><v>#SPILL!</v></c></row>'));
    const restored = readWorkbookXlsx(bytes).workbook;
    const reBytes = writeWorkbookXlsx(restored).bytes;
    const sheet = readWorkbookXlsx(reBytes).workbook.sheets[0];
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual({ kind: 'error', code: '#SPILL!' });
  });

  it('真正未知的错误值仍显式失败（不是"什么都接受"）', () => {
    const bytes = singleSheetPackage(worksheetXml('<row r="1"><c r="A1" t="e"><v>#WAT!</v></c></row>'));
    expect(() => readWorkbookXlsx(bytes)).toThrow(/不认识的错误值/);
  });
});

// ---------------------------------------------------------------------------
// X06：保护 / 数据验证 / 条件格式
// ---------------------------------------------------------------------------

describe('X-I03 / X06 保护 / 数据验证 / 条件格式读回', () => {
  it('sheetProtection 与 workbookProtection 经保护包读回', () => {
    const sheetXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
      `<sheetProtection sheet="1" password="CF03" formatCells="0"/>` +
      `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
    const bytes = singleSheetPackage(sheetXml, '<workbookProtection lockStructure="1"/>');
    const result = readWorkbookXlsx(bytes);
    const features = result.sheet_features.find((item) => item.sheet === 'S');
    expect(features?.protection?.sheet).toBe(true);
    expect(features?.protection?.password_hash).toBe('CF03');
    expect(features?.protection?.format_cells).toBe(false);
    expect(result.workbook_protection?.lock_structure).toBe(true);
  });

  it('dataValidations / conditionalFormatting / dxfs 经各自解析器读回', () => {
    const written = writeWorkbookXlsx(createWorkbook([createSheet('S', { row_count: 5, column_count: 5 })]), EMPTY_RESIDUAL, {
      sheets: {
        S: {
          data_validations: [{ ranges: ['A1:A5'], type: 'list', list_values: ['甲', '乙', '丙'] }],
          conditional_formats: [
            {
              range: 'B1:B5',
              priority: 1,
              type: 'cellIs',
              operator: 'greaterThan',
              formulas: ['10'],
              format: { fill_color: 'FFEE0000' },
            },
          ],
        },
      },
    });
    const result = readWorkbookXlsx(written.bytes);
    const features = result.sheet_features.find((item) => item.sheet === 'S');
    expect(features?.protection).toBeNull();
    expect(features?.data_validations).toHaveLength(1);
    expect(features?.data_validations[0]?.list_values).toEqual(['甲', '乙', '丙']);
    expect(features?.conditional_formats).toHaveLength(1);
    expect(features?.conditional_formats[0]?.range).toBe('B1:B5');
    expect(features?.conditional_formats[0]?.format?.fill_color).toBe('FFEE0000');
    expect(result.differential_formats).toHaveLength(1);
    expect(result.differential_formats[0]?.fill_color).toBe('FFEE0000');
  });

  it('无保护 / 无验证 / 无条件的普通工作簿：全部为空，不虚构', () => {
    const result = readWorkbookXlsx(writeWorkbookXlsx(budgetWorkbook()).bytes);
    for (const features of result.sheet_features) {
      expect(features.protection).toBeNull();
      expect(features.data_validations).toEqual([]);
      expect(features.conditional_formats).toEqual([]);
    }
    expect(result.workbook_protection).toBeNull();
    expect(result.differential_formats).toEqual([]);
  });
});
