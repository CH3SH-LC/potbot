/**
 * **X01-resave-fidelity**：导入 → 另存的**字节级保真审计**（Excel 线）。
 *
 * 判据来自 EXCEL.md 的 X01 独立验收「核对…样式/关系和旧文件不变」，以及
 * 明确的「不能用"保留未知部件"代替保真验证」。用例分三组：
 *
 * 1. **自产文件另存**：读 → 写是幂等的 ⇒ 审计报"容器字节相同、无未知部件"；
 * 2. **外部（Excel/WPS 形状）文件另存**：带未知部件 + 工作表级关系 + 富样式表时，
 *    未知部件**逐字节不变**（`preserved_parts_lossless === true`），而**已知的样式部件会被重建**
 *    ——审计必须**如实报告这一点**，不能因为"老文件还在"就说"样式没丢"；
 * 3. **CSV → XLSX 的导入保存保真**：CSV 导入出的工作簿经 XLSX 保存 / 读回，取值与容器身份都保住。
 *
 * 夹具手法同 `src/spreadsheets/xls-io.test.ts`：`assembleOpcPackage` + `writeZip` 手装真实字节。
 *
 * ## 未验证（不得由本文件绿灯替代）
 *
 * - **真实安卓 WPS / Excel 打开**：本轮未做；`consumer-reopen` 层未验证。
 * - 本文件只做**字节级**对比，不判断"重建后的工作表在语义上是否等价"。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import { utf8Bytes } from '../../../../src/artifacts/ooxml/xml.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';
import { createWorkbook, getSheet } from '../../../../src/spreadsheets/workbook.js';
import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';
import {
  importCsvWorkbook,
  saveWorkbookDocument,
  openWorkbookDocument,
  withWorkbookEdits,
  createWorkbookDocument,
} from '../../../../src/spreadsheets/xls-io.js';
import {
  auditWorkbookResave,
  partFidelityOf,
} from '../../../../src/spreadsheets/xlsx-preservation/index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function assemble(
  parts: readonly OpcPart[],
  relationships: readonly RelationshipGroup[],
  defaults: readonly ContentTypeDefault[] = [],
): Uint8Array {
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }, ...defaults],
    relationships,
  });
  return writeZip(assembled.entries);
}

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';

const SHEET_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>` +
  '<row r="1"><c r="A1"><v>1</v></c><c r="B1" s="1"><v>0.5</v></c></row>' +
  '</sheetData></worksheet>';

/** 别家软件产出的**富样式表**（多字体 / 填充 + 一条自定义百分比格式）。 */
const EXTERNAL_STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<styleSheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="14"/><name val="Arial"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="164" fontId="1" fillId="1" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '</cellXfs></styleSheet>';

const CORE_XML = '<core xmlns="http://x"/>';
const BINARY_PART = Uint8Array.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0xfe]);
const SHEET_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
  '</Relationships>';
const DRAWING_XML = '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>';

/** 外部形状的包：富样式 + 四个未知部件（含工作表级关系）。 */
function externalPackage(): Uint8Array {
  return assemble(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: WORKBOOK_XML },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: SHEET_XML },
      {
        path: 'xl/styles.xml',
        content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
        data: EXTERNAL_STYLES_XML,
      },
      { path: 'docProps/core.xml', content_type: 'application/vnd.openxmlformats-package.core-properties+xml', data: utf8Bytes(CORE_XML) },
      { path: 'xl/media/image1.bin', content_type: 'image/png', data: BINARY_PART },
      { path: 'xl/worksheets/_rels/sheet1.xml.rels', content_type: RELATIONSHIPS_CONTENT_TYPE, data: utf8Bytes(SHEET_RELS_XML) },
      { path: 'xl/drawings/drawing1.xml', content_type: 'application/vnd.openxmlformats-officedocument.drawing+xml', data: utf8Bytes(DRAWING_XML) },
    ],
    [
      {
        owner_part_path: null,
        declarations: [
          { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH },
          {
            type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
            target: 'docProps/core.xml',
          },
        ],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
      },
    ],
    [{ extension: 'bin', content_type: 'image/png' }],
  );
}

/** 外部包 → 读 → 写，返回原件与另存件字节。 */
function resaveExternal(): { original: Uint8Array; resaved: Buffer } {
  const original = externalPackage();
  const { workbook, residual } = readWorkbookXlsx(original);
  const resaved = writeWorkbookXlsx(workbook, residual).bytes;
  return { original, resaved };
}

// ---------------------------------------------------------------------------
// 1. 自产文件另存
// ---------------------------------------------------------------------------

describe('X01 保真审计：自产工作簿的另存是幂等的', () => {
  it('读 → 写字节稳定：审计报 byte_identical，且没有未知部件', () => {
    let sheet = createSheet('S', { row_count: 2, column_count: 2 });
    sheet = setCellValue(sheet, 'A1', textValue('项目'));
    sheet = setCellValue(sheet, 'B1', numberValue(120.5));
    const original = writeWorkbookXlsx(createWorkbook([sheet])).bytes;
    const { workbook, residual } = readWorkbookXlsx(original);
    const resaved = writeWorkbookXlsx(workbook, residual).bytes;

    const audit = auditWorkbookResave(original, resaved);
    expect(audit.byte_identical).toBe(true);
    expect(audit.preserved_parts_lossless).toBe(true);
    expect(audit.parts.filter((part) => part.role === 'preserved')).toEqual([]);
    expect(audit.relationships.every((group) => group.added.length === 0 && group.removed.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 外部文件另存
// ---------------------------------------------------------------------------

describe('X01 保真审计：外部（Excel/WPS 形状）文件另存', () => {
  const { original, resaved } = resaveExternal();
  const audit = auditWorkbookResave(original, resaved);

  it('未知部件（含工作表级关系）逐字节不变 —— preserved_parts_lossless', () => {
    expect(audit.preserved_parts_lossless).toBe(true);
    const preservedPaths = audit.parts.filter((part) => part.role === 'preserved').map((part) => part.path).sort();
    expect(preservedPaths).toEqual([
      'docProps/core.xml',
      'xl/drawings/drawing1.xml',
      'xl/media/image1.bin',
      'xl/worksheets/_rels/sheet1.xml.rels',
    ]);
    for (const path of preservedPaths) {
      expect(partFidelityOf(audit, path)?.status, path).toBe('identical');
    }
  });

  it('二进制未知部件没有经过文本往返（字节仍带非 UTF-8 字节）', () => {
    const part = partFidelityOf(audit, 'xl/media/image1.bin');
    expect(part?.status).toBe('identical');
    expect(part?.original_bytes).toBe(BINARY_PART.byteLength);
  });

  it('**如实报告**：已知的 xl/styles.xml 被重建 ⇒ changed（不因老部件还在就宣称样式没丢）', () => {
    const styles = partFidelityOf(audit, 'xl/styles.xml');
    expect(styles?.role).toBe('known');
    expect(styles?.status).toBe('changed');
    // 富样式表（2 字体 / 2 填充 / 3 cellXfs）被替换成最小样式表（1 字体 / 2 填充 / 2 cellXfs）
    expect(styles?.original_bytes).not.toBe(styles?.resaved_bytes);
  });

  it('包级关系：core-properties 关系被保留；另存件新增了 styles 关系（如实登记，不是丢失）', () => {
    const root = audit.relationships.find((group) => group.owner === null);
    expect(root?.preserved.some((fingerprint) => fingerprint.includes('docProps/core.xml'))).toBe(true);
    expect(root?.removed).toEqual([]);

    const workbookGroup = audit.relationships.find((group) => group.owner === XLSX_WORKBOOK_PART_PATH);
    expect(workbookGroup?.preserved.some((fingerprint) => fingerprint.includes('worksheets/sheet1.xml'))).toBe(true);
    expect(workbookGroup?.added.some((fingerprint) => fingerprint.includes('/styles'))).toBe(true);
    expect(workbookGroup?.removed).toEqual([]);
  });

  it('工作表级关系部件本身也被识别为一个持有者的关系组（drawing 关系保留）', () => {
    const sheetGroup = audit.relationships.find((group) => group.owner === 'xl/worksheets/sheet1.xml');
    expect(sheetGroup?.preserved.some((fingerprint) => fingerprint.includes('drawings/drawing1.xml'))).toBe(true);
    expect(sheetGroup?.removed).toEqual([]);
  });

  it('内容类型默认项 bin → image/png 被保留', () => {
    expect(audit.content_type_defaults.preserved).toContainEqual({ extension: 'bin', content_type: 'image/png' });
  });

  it('读回还能读到原值（外部文件的取值经另存仍在）', () => {
    const sheet = getSheet(readWorkbookXlsx(resaved).workbook, 'S');
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual(numberValue(1));
  });
});

// ---------------------------------------------------------------------------
// 3. CSV → XLSX 导入保存保真
// ---------------------------------------------------------------------------

describe('X01 保真审计：CSV 导入 → XLSX 保存 → 读回', () => {
  it('CSV 文本导入后经 XLSX 保存，取值逐格保住且容器身份稳定', () => {
    const csv = utf8Bytes('项目,金额\n餐饮,120.5\n交通,88\n');
    const imported = importCsvWorkbook(csv, { type_mode: 'auto' });
    expect(imported.row_count).toBe(3);
    expect(imported.column_count).toBe(2);

    const document = withWorkbookEdits(createWorkbookDocument('预算.xlsx'), imported.workbook);
    const saved = saveWorkbookDocument(document);

    // 再由"打开 → 另存"走一遍，审计应报幂等
    const opened = openWorkbookDocument('预算.xlsx', saved.bytes);
    const resaved = saveWorkbookDocument(opened);
    const audit = auditWorkbookResave(saved.bytes, resaved.bytes);
    expect(audit.byte_identical).toBe(true);
    expect(audit.preserved_parts_lossless).toBe(true);

    // 取值经 XLSX 往返仍在
    const reopened = readWorkbookXlsx(resaved.bytes).workbook;
    const sheet = getSheet(reopened, imported.sheet_name);
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A1')).toEqual(textValue('项目'));
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'B2')).toEqual(numberValue(120.5));
    expect(getCellValue(sheet as NonNullable<typeof sheet>, 'A2')).toEqual(textValue('餐饮'));
  });
});
