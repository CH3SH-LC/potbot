/**
 * FA-XLS-IO 工作包验收用例（design-06-P8 / XLS-01、XLS-02、XLS-18 的文件层）。
 *
 * ## 三组判据
 *
 * 1. **文件层闭环**（XLS-01）：新建 → 导入真实 XLSX → 另存 → 重命名 → 保存关闭重开 → 继续编辑，
 *    每一步都能读回；CSV 的**编码 / 分隔符 / 类型**三件事都是显式参数，不是启发式。
 * 2. **未知部件不静默损坏**（R249）：含未知部件与工作表级关系的包，导入 → **编辑** → 保存后
 *    未知部件**逐字节**仍在；并且有一条**反向对照**（绕开文档层、丢掉残留）证明这条断言不是恒真。
 * 3. **多工作表正确**（XLS-02）：增 / 删 / 复 / 改 / 移 / 藏之后，活跃表按**身份**跟随、
 *    跨表引用被改写、悬空引用被显式挡住；写出的工作簿确实是多张表。
 *
 * ## 明确未验证的部分（不得由本文件的绿灯替代）
 *
 * - **安卓 WPS / Excel 打开、编辑、另存**：本轮**未做**，标"未验证"。
 * - **真机（手机）保存重开**：本轮**未做**，标"未验证"；本文件的"保存关闭重开"是**文件层**往返。
 * - **跨模板事实发布**：只登记接口点，未实现（用例只断言"登记存在且确实未实现"）。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../artifacts/ooxml/index.js';
import { readZip } from '../artifacts/ooxml/zip-read.js';
import { writeZip } from '../artifacts/ooxml/zip.js';
import { utf8Bytes } from '../artifacts/ooxml/xml.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
  buildXlsxTemplate,
  type XlsxFactEntry,
  type XlsxFactValue,
  type XlsxSheetSpec,
} from '../artifacts/templates/xlsx.js';
import { asFactRef, type FactSource, type KnownFactValue } from '../protocol/index.js';
import { evaluateWorkbookCell } from './evaluate.js';
import { hasCell, createSheet, getCellValue, setCellValue } from './sheet.js';
import {
  activeSheetName,
  addSheet,
  copySheet,
  createWorkbook,
  getSheet,
  moveSheet,
  removeSheet,
  renameSheet,
  setActiveSheet,
  setSheetHidden,
  sheetNames,
  sheetReferenceSites,
} from './workbook.js';
import { readWorkbookXlsx } from './xlsx-read.js';
import { writeWorkbookXlsx } from './xlsx-write.js';
import {
  XLS18_FACT_PUBLICATION_PORT,
  XLSX_TEXT_CELL_REPRESENTATION,
  createWorkbookDocument,
  encodeCsvBytes,
  exportWorkbookCsv,
  importCsvWorkbook,
  openWorkbookDocument,
  parseCsvRows,
  renameWorkbookDocument,
  reopenWorkbookDocument,
  saveWorkbookDocument,
  saveWorkbookDocumentAs,
  unknownPartPaths,
  withWorkbookEdits,
} from './xls-io.js';
import { blank, booleanValue, dateValue, formulaValue, numberValue, textValue } from './value.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SOURCE: FactSource = { kind: 'user_confirmation', detail: 'FA-XLS-IO 夹具' };

function numberFact(factKey: string, amount: number): XlsxFactEntry {
  const value: KnownFactValue = Object.freeze({ type: 'number', amount, unit: '元', currency: null });
  return Object.freeze({ fact_ref: asFactRef(`fact-${factKey}`), fact_key: factKey, value, source: SOURCE });
}

function unknownFact(factKey: string): XlsxFactEntry {
  const value: XlsxFactValue = { kind: 'unknown', reason: '夹具：未提供' };
  return Object.freeze({ fact_ref: asFactRef(`fact-${factKey}`), fact_key: factKey, value, source: SOURCE });
}

const TEMPLATE_SPEC: XlsxSheetSpec = {
  sheet_name: '预算',
  label_header: '项目',
  value_header: '金额',
  unit: '元',
  lines: [
    { label: '餐饮', fact_key: 'budget.food' },
    { label: '交通', fact_key: 'budget.transport' },
  ],
  total_label: '合计',
  scale: 2,
};

const TEMPLATE_FACTS: readonly XlsxFactEntry[] = [
  numberFact('budget.food', 120),
  unknownFact('budget.transport'),
];

/** 手工装一个包（用于构造"别的软件产出的、本仓不完全建模的"文件形状）。 */
function assemble(
  parts: readonly OpcPart[],
  relationships: readonly RelationshipGroup[],
  defaults: readonly { readonly extension: string; readonly content_type: string }[] = [],
): Uint8Array {
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [
      { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
      ...defaults,
    ],
    relationships,
  });
  return writeZip(assembled.entries);
}

const CORE_XML = '<core xmlns="http://x"/>';
/** 故意含非 UTF-8 字节：文本往返会把它改坏，字节往返不会。 */
const BINARY_PART = Uint8Array.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0xfe]);
const SHEET_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
  '</Relationships>';
const DRAWING_XML = '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>';

const UNKNOWN_PART_PATHS = ['docProps/core.xml', 'xl/media/image1.bin', 'xl/worksheets/_rels/sheet1.xml.rels', 'xl/drawings/drawing1.xml'];

/** 一份带"未知部件 + 工作表级关系"的工作簿字节（模拟别家软件产出的包）。 */
function packageWithUnknownParts(): Uint8Array {
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`;
  return assemble(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
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

function entryBytes(bytes: Uint8Array, path: string): Uint8Array | undefined {
  return readZip(bytes).by_path.get(path)?.data;
}

// ---------------------------------------------------------------------------
// XLS-01：文件层会话（新建 / 另存 / 重命名 / 保存关闭重开）
// ---------------------------------------------------------------------------

describe('XLS-01：工作簿文件层会话', () => {
  it('新建 → 编辑 → 保存 → 关闭重开 → 继续编辑 → 再保存：内容一路不丢', () => {
    const created = createWorkbookDocument('台账.xlsx');
    expect(created.source_digest).toBeNull();
    expect(sheetNames(created.workbook)).toEqual(['Sheet1']);

    let sheet = created.workbook.sheets[0];
    expect(sheet).toBeDefined();
    sheet = setCellValue(sheet as NonNullable<typeof sheet>, 'A1', textValue('项目'));
    sheet = setCellValue(sheet, 'B2', numberValue(120.5));
    const edited = withWorkbookEdits(created, createWorkbook([sheet]));

    const first = saveWorkbookDocument(edited);
    expect(first.file_name).toBe('台账.xlsx');

    // 关闭重开
    const reopened = reopenWorkbookDocument(edited, first.bytes);
    expect(reopened.source_digest).toBe(first.content_digest);
    const reopenedSheet = getSheet(reopened.workbook, 'Sheet1');
    expect(getCellValue(reopenedSheet as NonNullable<typeof reopenedSheet>, 'B2')).toEqual(numberValue(120.5));

    // 继续编辑并再保存
    const continued = withWorkbookEdits(
      reopened,
      createWorkbook([
        setCellValue(reopenedSheet as NonNullable<typeof reopenedSheet>, 'B3', textValue('继续编辑')),
      ]),
    );
    const second = saveWorkbookDocument(continued);
    const final = reopenWorkbookDocument(continued, second.bytes);
    const finalSheet = getSheet(final.workbook, 'Sheet1');
    expect(getCellValue(finalSheet as NonNullable<typeof finalSheet>, 'B2')).toEqual(numberValue(120.5));
    expect(getCellValue(finalSheet as NonNullable<typeof finalSheet>, 'B3')).toEqual(textValue('继续编辑'));
  });

  it('另存为新文件名：**内容逐字节相同**，只有名字不同', () => {
    const document = createWorkbookDocument('原件.xlsx');
    const saved = saveWorkbookDocument(document);
    const { document: copy, save: copySave } = saveWorkbookDocumentAs(document, '副本.xlsx');
    expect(copy.file_name).toBe('副本.xlsx');
    expect(document.file_name).toBe('原件.xlsx');
    expect(Buffer.compare(saved.bytes, copySave.bytes)).toBe(0);
    expect(copySave.content_digest).toBe(saved.content_digest);
  });

  it('重命名只改文件名（不落盘、内容与残留都不动）', () => {
    const document = createWorkbookDocument('旧名.xlsx');
    const renamed = renameWorkbookDocument(document, '新名.xlsx');
    expect(renamed.file_name).toBe('新名.xlsx');
    expect(renamed.workbook).toBe(document.workbook);
    expect(renamed.residual).toBe(document.residual);
  });

  it('文件名校验：空 / 含路径分隔符 ⇒ 显式失败（不给路径猜测留口子）', () => {
    expect(() => createWorkbookDocument('')).toThrow(/非空字符串/);
    expect(() => createWorkbookDocument('dir/文件.xlsx')).toThrow(/路径分隔符/);
    expect(() => renameWorkbookDocument(createWorkbookDocument('a.xlsx'), '..\\b.xlsx')).toThrow(/路径分隔符/);
  });
});

describe('XLS-01：导入真实 XLSX（模板层产出的既有文件）', () => {
  const built = buildXlsxTemplate(TEMPLATE_SPEC, TEMPLATE_FACTS);

  it('导入既有 .xlsx：表名、文本、数值、空白都按类读回', () => {
    const document = openWorkbookDocument('既有预算.xlsx', built.bytes);
    expect(sheetNames(document.workbook)).toEqual(['预算']);
    expect(document.source_digest).toBe(built.content_digest);
    const sheet = getSheet(document.workbook, '预算');
    const target = sheet as NonNullable<typeof sheet>;
    expect(getCellValue(target, 'A2')).toEqual(textValue('餐饮'));
    expect(getCellValue(target, 'B2')).toEqual(numberValue(120));
    // 事实缺失的那一行**不写 0**，读回来仍是 blank（R248 在 I/O 层的形状）
    expect(getCellValue(target, 'B3')).toEqual(blank);
    expect(hasCell(target, 'B3')).toBe(false);
  });

  it('导入 → 改数据 → 另存 → 读回：改动生效、其它格不变', () => {
    const document = openWorkbookDocument('既有预算.xlsx', built.bytes);
    const sheet = getSheet(document.workbook, '预算') as NonNullable<ReturnType<typeof getSheet>>;
    const edited = withWorkbookEdits(document, createWorkbook([setCellValue(sheet, 'B2', numberValue(150))]));
    const saved = saveWorkbookDocument(edited);
    const back = reopenWorkbookDocument(edited, saved.bytes);
    const backSheet = getSheet(back.workbook, '预算') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(backSheet, 'B2')).toEqual(numberValue(150));
    expect(getCellValue(backSheet, 'A2')).toEqual(textValue('餐饮'));
  });
});

// ---------------------------------------------------------------------------
// XLS-01：未知部件不静默损坏（R249）
// ---------------------------------------------------------------------------

describe('XLS-01 / R249：未知部件与工作表级关系原样保留', () => {
  const source = packageWithUnknownParts();

  it('导入时把未知部件**连字节**登记进文档', () => {
    const document = openWorkbookDocument('别家产出.xlsx', source);
    const known = unknownPartPaths(document);
    for (const path of UNKNOWN_PART_PATHS) {
      expect(known, `未知部件 ${path}`).toContain(path);
    }
    expect(getCellValue(getSheet(document.workbook, 'S') as NonNullable<ReturnType<typeof getSheet>>, 'A1')).toEqual(numberValue(1));
  });

  it('**编辑后保存**：未知部件逐字节仍在，且出现在 preserved_part_paths（正向证据）', () => {
    const document = openWorkbookDocument('别家产出.xlsx', source);
    const sheet = getSheet(document.workbook, 'S') as NonNullable<ReturnType<typeof getSheet>>;
    const edited = withWorkbookEdits(document, createWorkbook([setCellValue(sheet, 'B1', textValue('编辑过'))]));

    const saved = saveWorkbookDocument(edited);
    for (const path of UNKNOWN_PART_PATHS) {
      expect(saved.preserved_part_paths, `preserved ${path}`).toContain(path);
    }
    expect(Buffer.from(entryBytes(saved.bytes, 'xl/media/image1.bin') ?? new Uint8Array()).equals(Buffer.from(BINARY_PART))).toBe(true);
    expect(Buffer.from(entryBytes(saved.bytes, 'docProps/core.xml') ?? new Uint8Array()).toString('utf8')).toBe(CORE_XML);
    expect(
      Buffer.from(entryBytes(saved.bytes, 'xl/worksheets/_rels/sheet1.xml.rels') ?? new Uint8Array()).toString('utf8'),
    ).toBe(SHEET_RELS_XML);
    expect(
      Buffer.from(entryBytes(saved.bytes, 'xl/drawings/drawing1.xml') ?? new Uint8Array()).toString('utf8'),
    ).toBe(DRAWING_XML);

    // 编辑本身生效了（不是"什么都没写"）
    const back = readWorkbookXlsx(saved.bytes).workbook;
    expect(getCellValue(getSheet(back, 'S') as NonNullable<ReturnType<typeof getSheet>>, 'B1')).toEqual(textValue('编辑过'));
  });

  it('**反向对照**：绕开文档层（丢掉残留直接写）⇒ 未知部件确实会消失', () => {
    const document = openWorkbookDocument('别家产出.xlsx', source);
    const sheet = getSheet(document.workbook, 'S') as NonNullable<ReturnType<typeof getSheet>>;
    const edited = withWorkbookEdits(document, createWorkbook([setCellValue(sheet, 'B1', textValue('编辑过'))]));

    const withoutResidual = writeWorkbookXlsx(edited.workbook);
    for (const path of UNKNOWN_PART_PATHS) {
      expect(readZip(withoutResidual.bytes).by_path.has(path), `不应保留 ${path}`).toBe(false);
      expect(withoutResidual.preserved_part_paths).not.toContain(path);
    }
    // 这条对照证明上面"逐字节仍在"的断言不是恒真
  });

  it('保存关闭重开后，未知部件仍在（残留跟着文档走了一整圈）', () => {
    const document = openWorkbookDocument('别家产出.xlsx', source);
    const first = saveWorkbookDocument(document);
    const reopened = reopenWorkbookDocument(document, first.bytes);
    const second = saveWorkbookDocument(reopened);
    for (const path of UNKNOWN_PART_PATHS) {
      expect(readZip(second.bytes).by_path.has(path), `二次往返 ${path}`).toBe(true);
    }
    expect(second.dropped_relationships).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// XLS-01：CSV 编解码（编码 / 分隔符 / 类型都显式）
// ---------------------------------------------------------------------------

function csvFixtureWorkbook() {
  let sheet = createSheet('数据', { row_count: 5, column_count: 5 });
  sheet = setCellValue(sheet, 'A1', textValue('名称'));
  sheet = setCellValue(sheet, 'B1', textValue('数量'));
  sheet = setCellValue(sheet, 'C1', textValue('启用'));
  sheet = setCellValue(sheet, 'D1', textValue('日期'));
  sheet = setCellValue(sheet, 'E1', textValue('备注'));
  sheet = setCellValue(sheet, 'A2', textValue('餐饮, 含税'));
  sheet = setCellValue(sheet, 'B2', numberValue(120.5));
  sheet = setCellValue(sheet, 'C2', booleanValue(true));
  sheet = setCellValue(sheet, 'D2', dateValue(Date.UTC(2026, 9, 3)));
  sheet = setCellValue(sheet, 'A3', textValue('引号"测试'));
  // B3 / C3 / D3 留空 —— 导出应当写空字段，读回是 blank
  sheet = setCellValue(sheet, 'E3', textValue(''));
  return createWorkbook([sheet]);
}

describe('XLS-01：CSV 导出 / 导入是显式口径', () => {
  it('往返：数值 / 文本（含分隔符与引号）/ 布尔 / 日期 / 空白 都能回来', () => {
    const exported = exportWorkbookCsv(csvFixtureWorkbook(), { delimiter: ',', encoding: 'utf-8', quote: 'all-text' });
    expect(exported.delimiter).toBe(',');
    const imported = importCsvWorkbook(exported.bytes, { delimiter: ',', type_mode: 'auto' });
    const sheet = getSheet(imported.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(sheet, 'A2')).toEqual(textValue('餐饮, 含税'));
    expect(getCellValue(sheet, 'B2')).toEqual(numberValue(120.5));
    expect(getCellValue(sheet, 'C2')).toEqual(booleanValue(true));
    expect(getCellValue(sheet, 'D2')).toEqual(dateValue(Date.UTC(2026, 9, 3)));
    expect(getCellValue(sheet, 'E2')).toEqual(blank);
    expect(getCellValue(sheet, 'A3')).toEqual(textValue('引号"测试'));
    expect(getCellValue(sheet, 'B3')).toEqual(blank);
    expect(getCellValue(sheet, 'E3')).toEqual(textValue('')); // 显式空文本 ≠ 没有值
    expect(imported.encoding).toBe('utf-8');
    expect(imported.had_bom).toBe(false);
  });

  it('编码是导出选项：utf-8-bom 写出 BOM，utf-8 不写；导入 auto 能认出 BOM', () => {
    const plain = exportWorkbookCsv(csvFixtureWorkbook(), { encoding: 'utf-8' });
    const bom = exportWorkbookCsv(csvFixtureWorkbook(), { encoding: 'utf-8-bom' });
    expect(bom.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(plain.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(importCsvWorkbook(bom.bytes, { encoding: 'auto' }).encoding).toBe('utf-8-bom');
    expect(importCsvWorkbook(plain.bytes, { encoding: 'auto' }).encoding).toBe('utf-8');
  });

  it('声明 utf-8-bom 但源没有 BOM ⇒ 抛（编码是显式契约，不是建议）', () => {
    const plain = exportWorkbookCsv(csvFixtureWorkbook(), { encoding: 'utf-8' });
    expect(() => importCsvWorkbook(plain.bytes, { encoding: 'utf-8-bom' })).toThrow(/没有 UTF-8 BOM/);
  });

  it('GBK 字节：显式写 gbk 才读得对；**反向对照**：按 utf-8 读 ⇒ 抛（不静默乱码）', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31, 0x0a]); // "中文,1\n"
    expect(() => importCsvWorkbook(gbk, { encoding: 'utf-8' })).toThrow(/不是合法的 UTF-8/);
    const imported = importCsvWorkbook(gbk, { encoding: 'gbk' });
    expect(imported.encoding).toBe('gbk');
    const sheet = getSheet(imported.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('中文'));
    expect(getCellValue(sheet, 'B1')).toEqual(textValue('1')); // 默认口径：一切当文本
    // auto 也能落到 gbk（BOM 不是 GBK 的特征，UTF-8 严格解码失败后回退）
    expect(importCsvWorkbook(gbk, { encoding: 'auto' }).encoding).toBe('gbk');
  });

  it('分隔符是显式参数：分号文件用逗号读 ⇒ 只有一列（不嗅探、不猜）', () => {
    const text = 'a;b;c\n1;2;3\n';
    const asComma = importCsvWorkbook(utf8Bytes(text), { delimiter: ',' });
    const commaSheet = getSheet(asComma.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(asComma.column_count).toBe(1);
    expect(getCellValue(commaSheet, 'A1')).toEqual(textValue('a;b;c'));
    const asSemicolon = importCsvWorkbook(utf8Bytes(text), { delimiter: ';' });
    const semiSheet = getSheet(asSemicolon.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(asSemicolon.column_count).toBe(3);
    expect(getCellValue(semiSheet, 'C2')).toEqual(textValue('3'));
    // 制表符分隔同理
    const tsv = exportWorkbookCsv(csvFixtureWorkbook(), { delimiter: '\t', newline: 'crlf' });
    expect(tsv.newline).toBe('crlf');
    expect(tsv.bytes.toString('utf8')).toContain('\r\n');
    expect(importCsvWorkbook(tsv.bytes, { delimiter: '\t' }).column_count).toBe(5);
  });

  it('类型口径：默认一切文本；type_mode auto 才推断；**007 / 1,000 / 50% 不当数字**', () => {
    const text = '1;007;1,000;50%;TRUE;2026-10-03\n';
    const asText = importCsvWorkbook(utf8Bytes(text), { delimiter: ';', type_mode: 'text' });
    const textSheet = getSheet(asText.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(textSheet, 'A1')).toEqual(textValue('1'));

    const auto = importCsvWorkbook(utf8Bytes(text), { delimiter: ';', type_mode: 'auto' });
    const autoSheet = getSheet(auto.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(autoSheet, 'A1')).toEqual(numberValue(1));
    expect(getCellValue(autoSheet, 'B1')).toEqual(textValue('007')); // 前导零：编号，不是数
    expect(getCellValue(autoSheet, 'C1')).toEqual(textValue('1,000'));
    expect(getCellValue(autoSheet, 'D1')).toEqual(textValue('50%'));
    expect(getCellValue(autoSheet, 'E1')).toEqual(booleanValue(true));
    expect(getCellValue(autoSheet, 'F1')).toEqual(dateValue(Date.UTC(2026, 9, 3)));
  });

  it('auto：加引号的字段一律文本（作者显式声明胜过启发式）', () => {
    const imported = importCsvWorkbook(utf8Bytes('"1","TRUE",\n'), { type_mode: 'auto' });
    const sheet = getSheet(imported.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('1'));
    expect(getCellValue(sheet, 'B1')).toEqual(textValue('TRUE'));
  });

  it('逐列显式类型：不符即抛（不静默退回文本）', () => {
    const ok = importCsvWorkbook(utf8Bytes('a,12\n'), { column_types: ['text', 'number'] });
    expect(getCellValue(getSheet(ok.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>, 'B1')).toEqual(numberValue(12));
    expect(() => importCsvWorkbook(utf8Bytes('a,xx\n'), { column_types: ['text', 'number'] })).toThrow(/声明为 number/);
    expect(() => importCsvWorkbook(utf8Bytes('a,2026-02-30\n'), { column_types: ['text', 'date'] })).toThrow(/声明为 date/);
    expect(() => importCsvWorkbook(utf8Bytes('a,yes\n'), { column_types: ['text', 'boolean'] })).toThrow(/声明为 boolean/);
  });

  it('日期：2026-02-30 不是真实日期 ⇒ auto 下保持文本（不静默进位到 3 月 2 日）', () => {
    const imported = importCsvWorkbook(utf8Bytes('2026-02-30\n'), { type_mode: 'auto' });
    expect(getCellValue(getSheet(imported.workbook, 'Sheet1') as NonNullable<ReturnType<typeof getSheet>>, 'A1')).toEqual(textValue('2026-02-30'));
  });

  it('公式不写进 CSV：默认**显式失败**；formulas:"value" 才写求值结果', () => {
    let sheet = createSheet('计算');
    sheet = setCellValue(sheet, 'A1', numberValue(2));
    sheet = setCellValue(sheet, 'A2', numberValue(3));
    sheet = setCellValue(sheet, 'A3', formulaValue('SUM(A1:A2)'));
    const workbook = createWorkbook([sheet]);
    expect(() => exportWorkbookCsv(workbook)).toThrow(/CSV 装不下公式/);
    const withValues = exportWorkbookCsv(workbook, { formulas: 'value' });
    expect(withValues.bytes.toString('utf8')).toBe('2\n3\n5\n');
    // 反向对照：默认口径绝不把公式写成固化数值
    expect(() => exportWorkbookCsv(workbook, { formulas: 'error' })).toThrow();
  });

  it('求值被阻塞的公式在 formulas:"value" 下也失败（不写猜出来的值）', () => {
    let sheet = createSheet('计算');
    sheet = setCellValue(sheet, 'A1', formulaValue('LOG10(100)'));
    expect(() => exportWorkbookCsv(createWorkbook([sheet]), { formulas: 'value' })).toThrow(/求值被阻塞/);
  });

  it('多表工作簿必须显式指定 sheet（不默认只导第一张）', () => {
    const workbook = addSheet(csvFixtureWorkbook(), '第二张');
    expect(() => exportWorkbookCsv(workbook)).toThrow(/必须显式指定 sheet/);
    const exported = exportWorkbookCsv(workbook, { sheet: '第二张' });
    expect(exported.sheet).toBe('第二张');
    expect(exported.row_count).toBe(0); // 空表 ⇒ 空文件，而不是 1000 行空行
    expect(() => exportWorkbookCsv(workbook, { sheet: '没有' })).toThrow(/没有工作表/);
  });

  it('畸形 CSV 显式失败：未闭合引号 / 未加引号的引号 / 引号后有杂字符', () => {
    expect(() => parseCsvRows('"未闭合\n', ',')).toThrow(/未闭合的引号/);
    expect(() => parseCsvRows('a"b,c\n', ',')).toThrow(/未加引号的字段里出现引号/);
    expect(() => parseCsvRows('"a"x,b\n', ',')).toThrow(/引号闭合后出现/);
  });

  it('导出只写"有内容的矩形范围"（不写 SheetState 声明的空行空列）', () => {
    let sheet = createSheet('小', { row_count: 1000, column_count: 26 });
    sheet = setCellValue(sheet, 'A1', textValue('x'));
    sheet = setCellValue(sheet, 'B2', textValue('y'));
    const exported = exportWorkbookCsv(createWorkbook([sheet]));
    expect(exported.row_count).toBe(2);
    expect(exported.column_count).toBe(2);
    expect(exported.bytes.toString('utf8')).toBe('x,\n,y\n');
  });
});

// ---------------------------------------------------------------------------
// XLS-02：多工作表正确
// ---------------------------------------------------------------------------

function threeSheetWorkbook() {
  let first = createSheet('首页', { row_count: 3, column_count: 3 });
  first = setCellValue(first, 'A1', textValue('第一'));
  let second = createSheet('明细', { row_count: 3, column_count: 3 });
  second = setCellValue(second, 'A1', textValue('第二'));
  let third = createSheet('汇总', { row_count: 3, column_count: 3 });
  third = setCellValue(third, 'A1', textValue('第三'));
  return createWorkbook([first, second, third]);
}

describe('XLS-02：多工作表增删复制移动隐藏', () => {
  it('增 / 删 / 复 / 改 / 移 / 藏之后，保存重开：清单、顺序、隐藏、活跃表都对', () => {
    let workbook = threeSheetWorkbook();
    workbook = addSheet(workbook, '备注', 1);
    workbook = copySheet(workbook, '明细', '明细副本');
    workbook = renameSheet(workbook, '备注', '说明');
    workbook = moveSheet(workbook, '说明', 0);
    workbook = setSheetHidden(workbook, '明细副本', true);
    workbook = setActiveSheet(workbook, '汇总');
    workbook = removeSheet(workbook, '首页');

    expect(sheetNames(workbook)).toEqual(['说明', '明细', '汇总', '明细副本']);
    const saved = writeWorkbookXlsx(workbook);
    const restored = readWorkbookXlsx(saved.bytes).workbook;
    expect(sheetNames(restored)).toEqual(['说明', '明细', '汇总', '明细副本']);
    expect(restored.active_sheet).toBe(2);
    expect(activeSheetName(restored)).toBe('汇总');
    expect(getSheet(restored, '明细副本')?.hidden).toBe(true);
    expect(getSheet(restored, '明细')?.hidden).toBe(false);
    // 内容也跟着走（复制是深拷贝、移动不丢内容）
    expect(getCellValue(getSheet(restored, '明细副本') as NonNullable<ReturnType<typeof getSheet>>, 'A1')).toEqual(textValue('第二'));
  });

  it('写出的文件里 <sheets> 就是多张表（不是被压成一张固定分项表）', () => {
    const saved = writeWorkbookXlsx(threeSheetWorkbook());
    const archive = readZip(saved.bytes);
    const workbookXml = Buffer.from(archive.by_path.get(XLSX_WORKBOOK_PART_PATH)?.data ?? new Uint8Array()).toString('utf8');
    expect(workbookXml.match(/<sheet /g)?.length).toBe(3);
    expect(archive.by_path.has('xl/worksheets/sheet1.xml')).toBe(true);
    expect(archive.by_path.has('xl/worksheets/sheet3.xml')).toBe(true);
  });

  it('活跃表**按身份**跟随：删掉活跃表前面的表，活跃表仍是原来那张', () => {
    let workbook = threeSheetWorkbook();
    workbook = setActiveSheet(workbook, '汇总');
    expect(workbook.active_sheet).toBe(2);
    const afterRemove = removeSheet(workbook, '首页');
    expect(activeSheetName(afterRemove)).toBe('汇总');
    expect(afterRemove.active_sheet).toBe(1);
    // **反向对照**：若沿用旧下标 2，活跃表会指向另一张表（名字不同）——这条断言让"按下标"站不住
    expect(sheetNames(afterRemove)[workbook.active_sheet]).not.toBe('汇总');
  });

  it('移动工作表后活跃表身份不变', () => {
    let workbook = setActiveSheet(threeSheetWorkbook(), '明细');
    const moved = moveSheet(workbook, '汇总', 0);
    expect(sheetNames(moved)).toEqual(['汇总', '首页', '明细']);
    expect(activeSheetName(moved)).toBe('明细');
    expect(moved.active_sheet).toBe(2);
    // **反向对照**：旧下标 2 在移动后指向的是"首页"——正是"活跃表悄悄换成别的表"的形态
    expect(sheetNames(moved)[workbook.active_sheet]).toBe('首页');
  });

  it('活跃表被删除时，落到原位置的相邻表（不越界、不静默变成别的含义）', () => {
    let workbook = setActiveSheet(threeSheetWorkbook(), '明细');
    const afterRemove = removeSheet(workbook, '明细');
    expect(sheetNames(afterRemove)).toEqual(['首页', '汇总']);
    expect(activeSheetName(afterRemove)).toBe('汇总');
  });

  it('名称冲突：新增 / 复制 / 重命名到已存在的名字 ⇒ 显式抛', () => {
    const workbook = threeSheetWorkbook();
    expect(() => addSheet(workbook, '明细')).toThrow(/拒绝重名/);
    expect(() => copySheet(workbook, '明细', '首页')).toThrow(/拒绝重名/);
    expect(() => renameSheet(workbook, '明细', '首页')).toThrow(/拒绝重名/);
  });
});

describe('XLS-02：跨表引用正确', () => {
  function referencingWorkbook() {
    let base = createSheet('Source', { row_count: 3, column_count: 3 });
    base = setCellValue(base, 'A1', numberValue(5));
    let user = createSheet('User', { row_count: 3, column_count: 3 });
    user = setCellValue(user, 'A1', formulaValue('Source!A1+1'));
    user = setCellValue(user, 'A2', formulaValue('Source!A1*2'));
    user = setCellValue(user, 'A3', formulaValue('SUM(Source!A1:A1)'));
    return createWorkbook([base, user]);
  }

  it('重命名工作表：跨表引用被改写，且**求值仍指向新表名**', () => {
    const renamed = renameSheet(referencingWorkbook(), 'Source', 'Budget');
    const user = getSheet(renamed, 'User') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(user, 'A1')).toEqual(formulaValue('Budget!A1+1'));
    expect(getCellValue(user, 'A2')).toEqual(formulaValue('Budget!A1*2'));
    expect(getCellValue(user, 'A3')).toEqual(formulaValue('SUM(Budget!A1:A1)'));
    // 行为判据：改写后的公式**真的算得出来**
    expect(evaluateWorkbookCell(renamed, 'User', { column: 1, row: 1 })).toEqual({ ok: true, value: numberValue(6) });
    // **反向对照**：把引用换回旧表名（模拟"没改写"）⇒ 求值阻塞，且原因是找不到表
    const userSheet = getSheet(renamed, 'User') as NonNullable<ReturnType<typeof getSheet>>;
    const stale = createWorkbook([
      getSheet(renamed, 'Budget') as NonNullable<ReturnType<typeof getSheet>>,
      setCellValue(userSheet, 'A1', formulaValue('Source!A1+1')),
    ]);
    const staleOutcome = evaluateWorkbookCell(stale, 'User', { column: 1, row: 1 });
    expect(staleOutcome.ok).toBe(false);
    expect(staleOutcome.ok ? '' : staleOutcome.reason).toBe('unknown_sheet');
  });

  it('重命名到"需要引号的名字"时写引号形式（非 ASCII 名在公式里必须引号包裹）', () => {
    const renamed = renameSheet(referencingWorkbook(), 'Source', '预算表');
    const user = getSheet(renamed, 'User') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(user, 'A1')).toEqual(formulaValue("'预算表'!A1+1"));
    expect(evaluateWorkbookCell(renamed, 'User', { column: 1, row: 1 })).toEqual({ ok: true, value: numberValue(6) });
  });

  it('重命名也要改写"表自己引用自己"的限定名（带引号形式）', () => {
    let sheet = createSheet('自引');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'A2', formulaValue("'自引'!A1"));
    const renamed = renameSheet(createWorkbook([sheet]), '自引', '改名后');
    const target = getSheet(renamed, '改名后') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(target, 'A2')).toEqual(formulaValue("'改名后'!A1"));
    expect(evaluateWorkbookCell(renamed, '改名后', { column: 1, row: 2 })).toEqual({ ok: true, value: numberValue(1) });
  });

  it('重命名遇到大小写变体 / 字符串字面量 ⇒ 显式阻塞（不猜该改哪一处）', () => {
    let sheet = createSheet('Sheet1');
    sheet = setCellValue(sheet, 'A2', formulaValue('sheet1!A1'));
    expect(() => renameSheet(createWorkbook([sheet]), 'Sheet1', '新名')).toThrow(/大小写变体/);

    let literal = createSheet('预算');
    literal = setCellValue(literal, 'A2', formulaValue('IF(B1="预算!A1",1,0)'));
    expect(() => renameSheet(createWorkbook([literal]), '预算', '新预算')).toThrow(/双引号字符串字面量/);
    // 反向对照：与表名无关的字符串字面量**不该**阻塞改名
    let unrelated = createSheet('表A');
    unrelated = setCellValue(unrelated, 'A2', formulaValue('IF(B1="别的!A1",1,0)'));
    expect(sheetNames(renameSheet(createWorkbook([unrelated]), '表A', '表B'))).toEqual(['表B']);
  });

  it('删除**被引用**的工作表 ⇒ 抛，并指出引用位置；删除**不被引用**的 ⇒ 正常', () => {
    const workbook = referencingWorkbook();
    const sites = sheetReferenceSites(workbook, 'Source');
    expect(sites.map((site) => `${site.sheet}!${site.ref}`)).toEqual(['User!A1', 'User!A2', 'User!A3']);
    expect(() => removeSheet(workbook, 'Source')).toThrow(/跨表引用/);

    const noRefs = addSheet(threeSheetWorkbook(), '孤表');
    expect(sheetNames(removeSheet(noRefs, '孤表'))).toEqual(['首页', '明细', '汇总']);
  });

  it('表自身的自引用不阻止删表（引用随表一起消失）', () => {
    let sheet = createSheet('自引');
    sheet = setCellValue(sheet, 'A2', formulaValue("'自引'!A1"));
    const workbook = addSheet(createWorkbook([sheet]), '别的');
    expect(sheetNames(removeSheet(workbook, '自引'))).toEqual(['别的']);
  });
});

// ---------------------------------------------------------------------------
// XLS-18：文件层（真机 / 消费端**未验证**）+ 跨模板发布的接口点登记
// ---------------------------------------------------------------------------

describe('XLS-18：共享事实改动的文件层闭环（真机与消费端未验证）', () => {
  it('改人数/费用 ⇒ 公式同版更新 ⇒ 保存重开 → 继续改 → 再保存，数值一致', () => {
    let sheet = createSheet('预算', { row_count: 4, column_count: 4 });
    sheet = setCellValue(sheet, 'A1', textValue('人数'));
    sheet = setCellValue(sheet, 'B1', numberValue(10));
    sheet = setCellValue(sheet, 'A2', textValue('人均费用'));
    sheet = setCellValue(sheet, 'B2', numberValue(100));
    sheet = setCellValue(sheet, 'A3', textValue('合计'));
    sheet = setCellValue(sheet, 'B3', formulaValue('B1*B2'));
    const document = createWorkbookDocument('预算.xlsx', [sheet]);

    // 从对话改共享事实：人数 10 → 20
    const changed = withWorkbookEdits(document, createWorkbook([setCellValue(sheet, 'B1', numberValue(20))]));
    const saved = saveWorkbookDocument(changed);
    const totalRow = saved.evaluations.find((record) => record.sheet === '预算' && record.ref === 'B3');
    expect(totalRow?.ok).toBe(true);
    const computed = evaluateWorkbookCell(changed.workbook, '预算', { column: 2, row: 3 });
    expect(computed).toEqual({ ok: true, value: numberValue(2000) });

    // 手机保存 → 重开 → 继续改 → 再保存
    const reopened = reopenWorkbookDocument(changed, saved.bytes);
    const reopenedSheet = getSheet(reopened.workbook, '预算') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(reopenedSheet, 'B1')).toEqual(numberValue(20));
    expect(getCellValue(reopenedSheet, 'B3')).toEqual(formulaValue('B1*B2')); // 是可编辑公式，不是固化数值
    const again = withWorkbookEdits(reopened, createWorkbook([setCellValue(reopenedSheet, 'B2', numberValue(150))]));
    const second = saveWorkbookDocument(again);
    expect(evaluateWorkbookCell(again.workbook, '预算', { column: 2, row: 3 })).toEqual({ ok: true, value: numberValue(3000) });
    expect(second.bytes.length).toBeGreaterThan(0);
  });

  it('跨模板事实发布：接口点**已登记**且明确标为未实现（不返回假回执）', () => {
    expect(XLS18_FACT_PUBLICATION_PORT.port_id).toBe('xls18.cross_template_fact_publication');
    expect(XLS18_FACT_PUBLICATION_PORT.status).toBe('unimplemented');
    expect([...XLS18_FACT_PUBLICATION_PORT.consumers]).toEqual(['docx', 'pptx']);
    expect(() =>
      XLS18_FACT_PUBLICATION_PORT.publish({
        fact_keys: ['trip.headcount'],
        artifact_revision: 'r1',
        source_digest: 'deadbeef',
      }),
    ).toThrow(/尚未实现/);
  });
});

// ---------------------------------------------------------------------------
// 编解码原语的直接判据（供上面的场景用例对照）
// ---------------------------------------------------------------------------

describe('CSV 原语', () => {
  it('parseCsvRows：引号 / 转义 / 三种换行 / 末尾换行不产生空行', () => {
    expect(parseCsvRows('a,b\n', ',').map((row) => row.map((field) => field.text))).toEqual([['a', 'b']]);
    expect(parseCsvRows('a,b\r\nc,d\r\n', ',').length).toBe(2);
    expect(parseCsvRows('a\rb\r', ',').length).toBe(2);
    expect(parseCsvRows('"a\nb",c\n', ',')[0]?.[0]?.text).toBe('a\nb');
    expect(parseCsvRows('"a""b"\n', ',')[0]?.[0]?.text).toBe('a"b');
    expect(parseCsvRows('a,\n', ',')[0]?.map((field) => field.quoted)).toEqual([false, false]);
    expect(parseCsvRows('"",\n', ',')[0]?.[0]?.quoted).toBe(true);
  });

  it('encodeCsvBytes：BOM 由参数决定，不是默认行为', () => {
    expect(encodeCsvBytes('a', 'utf-8').length).toBe(1);
    expect(encodeCsvBytes('a', 'utf-8-bom').length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// XLS-01：sharedStrings 表示决策（X-R01 回归锁定的缺口 → 显式化）
// ---------------------------------------------------------------------------

/** 一份**外部产**、用 `t="s"` + `xl/sharedStrings.xml` 的包。 */
function packageWithSharedStrings(): Uint8Array {
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${relNs}">` +
    '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
    '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>';
  const sstXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<sst xmlns="${SPREADSHEETML_NAMESPACE}" count="1" uniqueCount="1"><si><t>项目</t></si></sst>`;
  return assemble(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
      {
        path: 'xl/sharedStrings.xml',
        content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
        data: sstXml,
      },
    ],
    [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [
          { type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' },
          { type: `${relNs}/sharedStrings`, target: 'sharedStrings.xml' },
        ],
      },
    ],
    [{ extension: 'xml', content_type: 'application/xml' }],
  );
}

describe('XLS-01：sharedStrings 表示决策（inlineStr）', () => {
  const source = packageWithSharedStrings();

  it('读侧：外部 t="s" 解析成模型文本（值不丢）', () => {
    const document = openWorkbookDocument('外部.xlsx', source);
    const sheet = getSheet(document.workbook, 'S') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('项目'));
  });

  it('存侧：决策字段显式登记（不产出 sharedStrings、口径 inlineStr、源用过且被丢弃）', () => {
    const document = openWorkbookDocument('外部.xlsx', source);
    const saved = saveWorkbookDocument(document);
    expect(XLSX_TEXT_CELL_REPRESENTATION).toBe('inlineStr');
    expect(saved.shared_strings).toEqual({
      emitted: false,
      text_cell_representation: 'inlineStr',
      source_used_shared_strings: true,
      dropped: true,
    });
    expect(readZip(saved.bytes).by_path.has('xl/sharedStrings.xml')).toBe(false);
    expect(saved.dropped_relationships.some((entry) => entry.includes('sharedStrings'))).toBe(true);
    // 文本以 inlineStr 写回，保存关闭重开后值仍一致
    const xml = Buffer.from(readZip(saved.bytes).by_path.get('xl/worksheets/sheet1.xml')?.data ?? new Uint8Array()).toString('utf8');
    expect(xml).toContain('inlineStr');
    expect(xml).not.toContain('t="s"');
    const reopened = reopenWorkbookDocument(document, saved.bytes);
    const sheet = getSheet(reopened.workbook, 'S') as NonNullable<ReturnType<typeof getSheet>>;
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('项目'));
  });

  it('反向对照：没有 sharedStrings 的文档 ⇒ 决策字段为 false（不是恒真）', () => {
    const created = createWorkbookDocument('新建.xlsx');
    const sheet = created.workbook.sheets[0] as NonNullable<(typeof created.workbook.sheets)[number]>;
    const edited = withWorkbookEdits(created, createWorkbook([setCellValue(sheet, 'A1', textValue('纯文本'))]));
    const saved = saveWorkbookDocument(edited);
    expect(saved.shared_strings.source_used_shared_strings).toBe(false);
    expect(saved.shared_strings.dropped).toBe(false);
  });
});
