/**
 * `xlsx-read.ts` 的验收用例（design-06-P8 / XLS-02、XLS-05、XLS-11、XLS-12；合同 R249）。
 *
 * 三组判据：
 * 1. **往返**：模型 → 字节 → 模型，逐格逐项相等（公式必须是**原文**，不是缓存值）；
 * 2. **R249**：未知部件与它没被重建的关系，读一遍带出来、写回去**字节不变**；
 * 3. **真实世界的形状**：`sharedStrings`、`t="d"`、共享公式从属格——能读的读对，读不了的**显式失败**。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../artifacts/ooxml/index.js';
import { writeZip } from '../artifacts/ooxml/zip.js';
import { readZip } from '../artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../artifacts/ooxml/xml.js';
import {
  SPREADSHEETML_NAMESPACE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  WORKSHEET_RELATIONSHIP_TYPE,
} from '../artifacts/templates/xlsx.js';
import { readWorkbookXlsx } from './xlsx-read.js';
import {
  worksheetPartPath,
  writeWorkbookXlsx,
  type PreservedPart,
  type XlsxResidual,
} from './xlsx-write.js';
import { createSheet, getCellValue, setCellValue } from './sheet.js';
import { createWorkbook, getSheet, setSheetHidden } from './workbook.js';
import {
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  numberValue,
  textValue,
  type CellValue,
} from './value.js';

function buildFixture() {
  let sheet1 = createSheet('预算', {
    row_count: 4,
    column_count: 7,
    frozen_rows: 1,
    frozen_columns: 1,
    merged: ['C2:D3'],
  });
  sheet1 = setCellValue(sheet1, 'A1', textValue('项目'));
  sheet1 = setCellValue(sheet1, 'B1', textValue('金额'));
  sheet1 = setCellValue(sheet1, 'C1', dateValue(0));
  sheet1 = setCellValue(sheet1, 'D1', booleanValue(true));
  sheet1 = setCellValue(sheet1, 'E1', errorValue('#N/A'));
  sheet1 = setCellValue(sheet1, 'A2', textValue('餐饮'));
  sheet1 = setCellValue(sheet1, 'B2', numberValue(120.5));
  sheet1 = setCellValue(sheet1, 'A3', textValue('交通'));
  sheet1 = setCellValue(sheet1, 'A4', textValue('合计'));
  sheet1 = setCellValue(sheet1, 'B4', formulaValue('SUM(B2:B3)'));
  sheet1 = setCellValue(sheet1, 'G1', formulaValue('LOG10(100)'));
  sheet1 = setCellValue(sheet1, 'G2', formulaValue('B3+1'));

  let sheet2 = createSheet('说明', { row_count: 2, column_count: 3 });
  sheet2 = setCellValue(sheet2, 'A1', textValue('  前后有空格  '));
  sheet2 = setCellValue(sheet2, 'A2', textValue('第二表'));

  return setSheetHidden(createWorkbook([sheet1, sheet2]), '说明', true);
}

/** 手工装一个包（用于构造本仓写不出的"真实世界"形状）。 */
function assemble(parts: readonly OpcPart[], relationships: readonly RelationshipGroup[]): Uint8Array {
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });
  return writeZip(assembled.entries);
}

function singleSheetPackage(sheetXml: string, extraParts: readonly OpcPart[] = []): Uint8Array {
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return assemble(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
      ...extraParts,
    ],
    [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
      },
    ],
  );
}

function worksheetXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>${body}</sheetData></worksheet>`
  );
}

describe('xlsx-read：往返（模型 → 字节 → 模型）', () => {
  const original = buildFixture();
  const { workbook: restored } = readWorkbookXlsx(writeWorkbookXlsx(original).bytes);

  it('工作表清单、顺序、隐藏、活跃表都回来了', () => {
    expect(restored.sheets.map((sheet) => sheet.name)).toEqual(['预算', '说明']);
    expect(restored.sheets[0]?.hidden).toBe(false);
    expect(restored.sheets[1]?.hidden).toBe(true);
    expect(restored.active_sheet).toBe(0);
  });

  it('**六类取值逐格相等**（含空白——空白读回来仍是空白，不是 0）', () => {
    const sheet = getSheet(restored, '预算');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    const expected: readonly (readonly [string, CellValue])[] = [
      ['A1', textValue('项目')],
      ['B1', textValue('金额')],
      ['C1', dateValue(0)],
      ['D1', booleanValue(true)],
      ['E1', errorValue('#N/A')],
      ['A2', textValue('餐饮')],
      ['B2', numberValue(120.5)],
      ['A3', textValue('交通')],
      ['A4', textValue('合计')],
      ['G2', formulaValue('B3+1')],
      ['B3', { kind: 'blank' }],
    ];
    for (const [ref, value] of expected) {
      expect(getCellValue(sheet, ref), `单元格 ${ref}`).toEqual(value);
    }
  });

  it('**公式读回的是 `<f>` 原文，不是缓存值**（XLS-06 的关键判据）', () => {
    const sheet = getSheet(restored, '预算');
    expect(sheet === undefined ? undefined : getCellValue(sheet, 'B4')).toEqual(formulaValue('SUM(B2:B3)'));
    expect(sheet === undefined ? undefined : getCellValue(sheet, 'G1')).toEqual(formulaValue('LOG10(100)'));
  });

  it('冻结窗格与合并区域回来了', () => {
    const sheet = getSheet(restored, '预算');
    expect(sheet?.frozen_rows).toBe(1);
    expect(sheet?.frozen_columns).toBe(1);
    expect(sheet?.merged).toEqual(['C2:D3']);
  });

  it('维度（行列数）经 `<dimension>` 往返', () => {
    const sheet = getSheet(restored, '预算');
    expect(sheet?.row_count).toBe(4);
    expect(sheet?.column_count).toBe(7);
  });

  it('前后空格原样保留（xml:space="preserve" 的往返）', () => {
    const sheet = getSheet(restored, '说明');
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual(textValue('  前后有空格  '));
  });

  it('读回再写出 ⇒ 容器字节稳定（幂等）', () => {
    const first = writeWorkbookXlsx(original).bytes;
    const second = writeWorkbookXlsx(restored).bytes;
    expect(Buffer.compare(first, second)).toBe(0);
  });
});

describe('xlsx-read：R249 未知部件原样保留', () => {
  const EXTRA_XML = '<core xmlns="http://x/"/>';
  const extraPart: PreservedPart = {
    path: 'docProps/core.xml',
    content_type: 'application/vnd.openxmlformats-package.core-properties+xml',
    data: utf8Bytes(EXTRA_XML),
  };
  const residual: XlsxResidual = {
    parts: [extraPart],
    content_type_defaults: [{ extension: 'bin', content_type: 'application/octet-stream' }],
    relationships: [
      {
        owner_part_path: null,
        declarations: [
          {
            type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
            target: 'docProps/core.xml',
          },
        ],
      },
    ],
  };

  it('写出时带上未知部件与它的关系', () => {
    const written = writeWorkbookXlsx(buildFixture(), residual);
    const archive = readZip(written.bytes);
    expect(archive.by_path.has('docProps/core.xml')).toBe(true);
    expect(written.dropped_relationships).toEqual([]);
  });

  it('读回时把未知部件**连字节一起**带出来', () => {
    const written = writeWorkbookXlsx(buildFixture(), residual);
    const { residual: captured } = readWorkbookXlsx(written.bytes);
    const preserved = captured.parts.find((part) => part.path === 'docProps/core.xml');
    expect(preserved).toBeDefined();
    expect(preserved?.content_type).toBe(extraPart.content_type);
    expect(Buffer.from(preserved?.data ?? new Uint8Array()).toString('utf8')).toBe(EXTRA_XML);
    expect(
      captured.relationships.some((group) =>
        group.declarations.some((declaration) => declaration.target === 'docProps/core.xml'),
      ),
    ).toBe(true);
  });

  it('读→写→再读，未知部件仍在（R249 的完整回路）', () => {
    const first = writeWorkbookXlsx(buildFixture(), residual);
    const { workbook, residual: captured } = readWorkbookXlsx(first.bytes);
    const second = writeWorkbookXlsx(workbook, captured);
    const archive = readZip(second.bytes);
    const entry = archive.by_path.get('docProps/core.xml');
    expect(entry).toBeDefined();
    expect(Buffer.from(entry?.data ?? new Uint8Array()).toString('utf8')).toBe(EXTRA_XML);
    // 二次读回仍能解析（包结构没被破坏）
    expect(readWorkbookXlsx(second.bytes).workbook.sheets.map((sheet) => sheet.name)).toEqual(['预算', '说明']);
  });

  it('读自己写出的文件 ⇒ 没有"未知部件"（已知部件一个都不多不少）', () => {
    const { residual: captured } = readWorkbookXlsx(writeWorkbookXlsx(buildFixture()).bytes);
    expect(captured.parts).toEqual([]);
  });

  it('目标不存在的保留关系被**显式丢弃**并登记（不是静默吞掉）', () => {
    const dangling: XlsxResidual = {
      parts: [],
      content_type_defaults: [],
      relationships: [
        { owner_part_path: null, declarations: [{ type: 'http://x/nope', target: 'missing/part.bin' }] },
      ],
    };
    const written = writeWorkbookXlsx(buildFixture(), dangling);
    expect(written.dropped_relationships).toEqual(['null → missing/part.bin（目标部件不在本包内）']);
  });
});

describe('xlsx-read：真实世界的形状', () => {
  it('sharedStrings：t="s" 按下标解析成文本（含富文本片段拼接）', () => {
    const bytes = singleSheetPackage(
      worksheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'),
      [
        {
          path: 'xl/sharedStrings.xml',
          content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
          data:
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            `<sst xmlns="${SPREADSHEETML_NAMESPACE}" count="2" uniqueCount="2">` +
            `<si><t>来自共享字符串</t></si>` +
            `<si><r><t>富</t></r><r><t>文本</t></r></si>` +
            `</sst>`,
        },
      ],
    );
    const { workbook } = readWorkbookXlsx(bytes);
    const sheet = getSheet(workbook, 'S');
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual(textValue('来自共享字符串'));
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'B1')).toEqual(textValue('富文本'));
  });

  it('t="d" 的 ISO 文本日期被容错读成 DateValue', () => {
    const bytes = singleSheetPackage(worksheetXml('<row r="1"><c r="A1" t="d"><v>1970-01-01T00:00:00Z</v></c></row>'));
    const sheet = getSheet(readWorkbookXlsx(bytes).workbook, 'S');
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual(dateValue(0));
  });

  it('省略 `r` 的稀疏单元格按位置定位（真实文件的常见写法）', () => {
    const bytes = singleSheetPackage(worksheetXml('<row><c><v>1</v></c><c><v>2</v></c></row>'));
    const sheet = getSheet(readWorkbookXlsx(bytes).workbook, 'S');
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual(numberValue(1));
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'B1')).toEqual(numberValue(2));
  });

  it('**共享公式的从属格显式失败**（不写一个静态的错公式）', () => {
    const bytes = singleSheetPackage(worksheetXml('<row r="1"><c r="A1"><f t="shared" si="0"/><v>1</v></c></row>'));
    expect(() => readWorkbookXlsx(bytes)).toThrow(/共享公式的从属格/);
  });

  it('未知错误值代码显式失败（错误值集合是封闭枚举）', () => {
    const bytes = singleSheetPackage(worksheetXml('<row r="1"><c r="A1" t="e"><v>#WAT!</v></c></row>'));
    expect(() => readWorkbookXlsx(bytes)).toThrow(/不认识的错误值/);
  });

  it('缺少 xl/workbook.xml ⇒ 显式失败，不是"读出一个空工作簿"', () => {
    expect(() => readWorkbookXlsx(utf8Bytes('not a zip'))).toThrow();
  });
});
