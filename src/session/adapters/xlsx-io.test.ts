/**
 * FA-XLS-IO-REACH 用例：把 `src/spreadsheets/xls-io.ts` 的**文件层会话**接进会话交付链。
 *
 * ## 四组判据
 *
 * 1. **同形**：新适配器与 `adapters/xlsx.ts` 用同一个 {@link DeliverableAdapter} 接缝
 *    （`format` / `template_kind` 分开声明、编辑是封闭枚举、失败结构化不抛穿）。
 * 2. **文件层会话语义**（XLS-01）：新建 → 编辑 → 保存 → **关闭重开** → 继续编辑 → 再保存，
 *    内容一路不丢；另存只换名字、内容摘要不变。
 * 3. **真实字节往返 + 未知部件不静默丢失**（R249）：含未知部件与二进制部件的包，
 *    导入 → 改一格 → 另存 → 重开，未知部件**逐字节**仍在，且 `preserved_part_paths`
 *    给出正向证据；**三条反向对照**证明这些断言不是恒真。
 * 4. **CSV 的显式口径**：编码 / 分隔符 / 类型全部显式；不符即**结构化失败**。
 *    两条反向对照是本工作包的硬要求：GBK 按 utf-8 读必须报错；分号文件按逗号读
 *    **不得静默成功**。
 *
 * 另有 XLS-18：接口点未接线 ⇒ 结构化 `not-wired`，`claimed_published` 恒为**字面量**
 * `false`（类型层 + 运行时两层各一条）。
 *
 * ## 明确未验证的部分（不得由本文件的绿灯替代）
 *
 * - **消费端打开**：安卓 WPS / Excel 能否打开、编辑、另存 —— 本轮**未做**，标"未验证"。
 * - **真机（手机）保存重开** —— 本轮**未做**；本文件的"保存关闭重开"是**文件层**往返。
 * - **跨模板事实发布** —— 端口未实现；本文件只断言"未接线被如实转达"。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../../artifacts/ooxml/index.js';
import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../../artifacts/ooxml/xml.js';
import { writeZip } from '../../artifacts/ooxml/zip.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../artifacts/templates/xlsx.js';
import {
  XLS18_FACT_PUBLICATION_PORT,
  blank,
  booleanValue,
  formulaValue,
  getCellValue,
  getSheet,
  hasCell,
  numberValue,
  sheetNames,
  textValue,
  writeWorkbookXlsx,
  type CellValue,
  type WorkbookDocument,
} from '../../spreadsheets/index.js';
import { digestBytes } from '../canonical.js';
import {
  DEFAULT_IMPORTED_FILE_NAME,
  exportDeliverableCsv,
  importDeliverableFromCsv,
  newDeliverable,
  openDeliverableFromXlsx,
  publishWorkbookFacts,
  renameDeliverable,
  reopenDeliverable,
  saveDeliverable,
  saveDeliverableAs,
  unknownPartsDropped,
  xlsxIoDeliverableAdapter,
  type XlsxFactPublicationOutcome,
  type XlsxIoEdit,
} from './xlsx-io.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CORE_XML = '<core xmlns="http://x"/>';
/** 故意含非 UTF-8 字节：文本往返会把它改坏，字节往返不会。 */
const BINARY_PART = Uint8Array.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0xfe]);

/** 本仓**不建模**的部件（夹具里只放两个，够证明"逐字节带回"即可）。 */
const UNKNOWN_PART_PATHS = ['docProps/core.xml', 'xl/media/image1.bin'] as const;

/** 一份带未知部件的 .xlsx 字节（模拟别家软件产出的包）。 */
function packageWithUnknownParts(): Uint8Array {
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>` +
    '<row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
  const parts: readonly OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
    { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
    {
      path: 'docProps/core.xml',
      content_type: 'application/vnd.openxmlformats-package.core-properties+xml',
      data: utf8Bytes(CORE_XML),
    },
    { path: 'xl/media/image1.bin', content_type: 'image/png', data: BINARY_PART },
  ];
  const relationships: readonly RelationshipGroup[] = [
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
  ];
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [
      { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
      { extension: 'bin', content_type: 'image/png' },
    ],
    relationships,
  });
  return writeZip(assembled.entries);
}

/** 取一张工作表；没有就当场失败（比 `as NonNullable` 更能指出是哪条断言塌了）。 */
function sheetOf(document: WorkbookDocument, name: string) {
  const sheet = getSheet(document.workbook, name);
  if (sheet === undefined) throw new Error(`夹具/断言：工作簿里没有工作表 ${JSON.stringify(name)}`);
  return sheet;
}

/** 打开（导入）一个包，失败即抛（夹具用；断言的"结构化失败"另有专门的用例）。 */
function openOrThrow(fileName: string, bytes: Uint8Array): WorkbookDocument {
  const opened = openDeliverableFromXlsx(fileName, bytes);
  if (!opened.ok) throw new Error(`夹具失败：${opened.detail}`);
  return opened.source;
}

/** 用**适配器自己的编辑通道**建一份带内容的文档（顺带每一步都断言编辑成功）。 */
function documentWithCells(
  fileName: string,
  sheetName: string,
  cells: readonly (readonly [string, CellValue])[],
): WorkbookDocument {
  let document = newDeliverable(fileName, sheetName);
  for (const entry of cells) {
    const applied = xlsxIoDeliverableAdapter.applyEdit(document, {
      op: 'set_cell',
      sheet: sheetName,
      address: entry[0],
      value: entry[1],
    } satisfies XlsxIoEdit);
    if (!applied.ok) throw new Error(`夹具失败：${applied.detail}`);
    document = applied.source;
  }
  return document;
}

function saveOrThrow(document: WorkbookDocument) {
  const saved = saveDeliverable(document);
  if (!saved.ok) throw new Error(`夹具失败：${saved.detail}`);
  return saved;
}

// ---------------------------------------------------------------------------
// ① 同形：会话交付链上的接缝
// ---------------------------------------------------------------------------

describe('适配器形状：与 adapters/xlsx.ts 同形', () => {
  it('format / template_kind 分开声明；describe 给出文件名与表清单', () => {
    expect(xlsxIoDeliverableAdapter.format).toBe('xlsx');
    expect(xlsxIoDeliverableAdapter.template_kind).toBe('spreadsheet');
    expect(xlsxIoDeliverableAdapter.describe(newDeliverable('台账.xlsx'))).toBe(
      '台账.xlsx：1 张工作表（Sheet1）',
    );
    expect(xlsxIoDeliverableAdapter.describe(newDeliverable('台账.xlsx', '一', '二'))).toBe(
      '台账.xlsx：2 张工作表（一、二）',
    );
  });

  it('importBytes 只吃 .xlsx：CSV 字节 ⇒ 结构化失败（不静默当成表格）', () => {
    const outcome = xlsxIoDeliverableAdapter.importBytes?.(utf8Bytes('a,b\n1,2\n'));
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      expect(outcome.kind).toBe('xlsx_read_failed');
    }
  });

  it('importBytes 用显式默认文件名（接口无文件名参数），并读回真实 .xlsx', () => {
    const saved = saveOrThrow(newDeliverable('原件.xlsx'));
    const imported = xlsxIoDeliverableAdapter.importBytes?.(saved.save.bytes);
    expect(imported?.ok).toBe(true);
    if (imported !== undefined && imported.ok) {
      expect(imported.source.file_name).toBe(DEFAULT_IMPORTED_FILE_NAME);
      expect(sheetNames(imported.source.workbook)).toEqual(['Sheet1']);
    }
  });

  it('未支持的编辑操作 ⇒ 结构化 unsupported_op（封闭枚举，不猜）', () => {
    const outcome = xlsxIoDeliverableAdapter.applyEdit(newDeliverable('a.xlsx'), { op: '删除全部' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('unsupported_op');
  });
});

// ---------------------------------------------------------------------------
// ② 文件层会话：新建 / 另存 / 重命名 / 关闭重开
// ---------------------------------------------------------------------------

describe('XLS-01 文件层会话（复用 xls-io 的 WorkbookDocument）', () => {
  it('新建 → 改一格 → 保存 → 关闭重开 → 读回一致 → 继续编辑 → 再保存', () => {
    const created = newDeliverable('台账.xlsx', '数据');
    expect(created.source_digest).toBeNull();

    const applied = xlsxIoDeliverableAdapter.applyEdit(created, {
      op: 'set_cell',
      sheet: '数据',
      address: 'B2',
      value: numberValue(120.5),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.changed).toBe(true);

    const first = saveOrThrow(applied.source);
    expect(first.save.file_name).toBe('台账.xlsx');

    // 关闭重开：新文档的来源摘要 = 刚写出字节的内容摘要
    const reopened = reopenDeliverable(applied.source, first.save.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.source.source_digest).toBe(first.save.content_digest);
    expect(getCellValue(sheetOf(reopened.source, '数据'), 'B2')).toEqual(numberValue(120.5));

    // 继续编辑并再保存
    const continued = xlsxIoDeliverableAdapter.applyEdit(reopened.source, {
      op: 'set_cell',
      sheet: '数据',
      address: 'B3',
      value: textValue('继续编辑'),
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    const second = saveOrThrow(continued.source);

    const final = reopenDeliverable(continued.source, second.save.bytes);
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    const finalSheet = sheetOf(final.source, '数据');
    expect(getCellValue(finalSheet, 'B2')).toEqual(numberValue(120.5));
    expect(getCellValue(finalSheet, 'B3')).toEqual(textValue('继续编辑'));
  });

  it('另存为：只换名字，**内容摘要逐字节不变**', () => {
    const document = newDeliverable('原件.xlsx', '数据');
    const original = saveOrThrow(document);
    const copy = saveDeliverableAs(document, '副本.xlsx');
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.document.file_name).toBe('副本.xlsx');
    expect(copy.save.content_digest).toBe(original.save.content_digest);
    expect(Buffer.from(copy.save.bytes).equals(Buffer.from(original.save.bytes))).toBe(true);
    // 原件不受影响
    expect(document.file_name).toBe('原件.xlsx');
  });

  it('重命名（两种入口）只改文件名：内容与残留都不动', () => {
    const document = newDeliverable('旧名.xlsx', '数据');

    const byFunction = renameDeliverable(document, '新名.xlsx');
    expect(byFunction.ok).toBe(true);
    if (byFunction.ok) {
      expect(byFunction.source.file_name).toBe('新名.xlsx');
      expect(byFunction.source.workbook).toBe(document.workbook);
      expect(byFunction.source.residual).toBe(document.residual);
      expect(byFunction.changed).toBe(true);
    }

    const byEdit = xlsxIoDeliverableAdapter.applyEdit(document, { op: 'rename_file', file_name: '别名.xlsx' });
    expect(byEdit.ok).toBe(true);
    if (byEdit.ok) {
      expect(byEdit.source.file_name).toBe('别名.xlsx');
      expect(getCellValue(sheetOf(byEdit.source, '数据'), 'A1')).toEqual(blank);
    }

    // 空文件名 / 含路径分隔符 ⇒ 结构化失败（不给路径猜测留口子）
    const bad = renameDeliverable(document, 'dir/文件.xlsx');
    expect(bad.ok).toBe(false);
    const badEdit = xlsxIoDeliverableAdapter.applyEdit(document, { op: 'rename_file', file_name: '' });
    expect(badEdit.ok).toBe(false);
  });

  it('幂等空转不算改动（changed=false ⇒ 不产生新版本）', () => {
    const document = documentWithCells('幂等.xlsx', '数据', [['A1', textValue('x')]]);
    const same: XlsxIoEdit = { op: 'set_cell', sheet: '数据', address: 'A1', value: textValue('x') };
    const again = xlsxIoDeliverableAdapter.applyEdit(document, same);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);

    const cleared = xlsxIoDeliverableAdapter.applyEdit(document, {
      op: 'clear_cell',
      sheet: '数据',
      address: 'A1',
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.changed).toBe(true);

    const clearEmpty = xlsxIoDeliverableAdapter.applyEdit(document, {
      op: 'clear_cell',
      sheet: '数据',
      address: 'Z9',
    });
    expect(clearEmpty.ok).toBe(true);
    if (clearEmpty.ok) expect(clearEmpty.changed).toBe(false);
  });

  it('删最后一张表被挡（R250）、未知表名结构化失败（源零改动）', () => {
    const document = newDeliverable('单表.xlsx', '唯一');
    const last = xlsxIoDeliverableAdapter.applyEdit(document, { op: 'remove_sheet', name: '唯一' });
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.kind).toBe('last_sheet');

    const unknown = xlsxIoDeliverableAdapter.applyEdit(document, {
      op: 'set_cell',
      sheet: '没有这张',
      address: 'A1',
      value: textValue('x'),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.kind).toBe('unknown_sheet');
  });
});

// ---------------------------------------------------------------------------
// ③ 真实字节往返 + 未知部件不静默丢失（R249）
// ---------------------------------------------------------------------------

describe('R249 真实字节往返：改一格 → 另存 → 重开，未知部件一个都不丢', () => {
  const source = packageWithUnknownParts();

  it('导入 → 改一格 → 另存 → 重开：改动生效、其它格不变、未知部件逐字节仍在', () => {
    const opened = openOrThrow('别家产出.xlsx', source);
    expect(opened.source_digest).toBe(digestBytes(source));
    expect(getCellValue(sheetOf(opened, 'S'), 'A1')).toEqual(numberValue(1));

    const edited = xlsxIoDeliverableAdapter.applyEdit(opened, {
      op: 'set_cell',
      sheet: 'S',
      address: 'B1',
      value: textValue('编辑过'),
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const saved = saveDeliverableAs(edited.source, '副本.xlsx');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.document.file_name).toBe('副本.xlsx');

    // 正向证据：登记的未知部件逐条出现在 preserved_part_paths 里
    for (const path of UNKNOWN_PART_PATHS) {
      expect(saved.save.preserved_part_paths, `preserved ${path}`).toContain(path);
    }
    expect(unknownPartsDropped(saved.document, saved.save)).toEqual([]);
    expect(saved.save.dropped_relationships).toEqual([]);

    // 逐字节：**非 UTF-8 的二进制部件**也必须原样（文本往返会把它改坏）
    const archive = readZip(saved.save.bytes);
    expect(
      Buffer.from(archive.by_path.get('xl/media/image1.bin')?.data ?? new Uint8Array()).equals(
        Buffer.from(BINARY_PART),
      ),
    ).toBe(true);
    expect(
      Buffer.from(archive.by_path.get('docProps/core.xml')?.data ?? new Uint8Array()).toString('utf8'),
    ).toBe(CORE_XML);

    // 关闭重开：改动读得回来，未知部件仍登记着
    const reopened = reopenDeliverable(saved.document, saved.save.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.source.file_name).toBe('副本.xlsx');
    const sheet = sheetOf(reopened.source, 'S');
    expect(getCellValue(sheet, 'B1')).toEqual(textValue('编辑过'));
    expect(getCellValue(sheet, 'A1')).toEqual(numberValue(1));
    expect(unknownPartsDropped(reopened.source, saved.save)).toEqual([]);
  });

  it('**反向对照 a**：绕开文档层直接写裸模型 ⇒ 未知部件确实消失（证明上面的绿灯不是恒真）', () => {
    const opened = openOrThrow('别家产出.xlsx', source);
    const bare = writeWorkbookXlsx(opened.workbook);
    for (const path of UNKNOWN_PART_PATHS) {
      expect(readZip(bare.bytes).by_path.has(path), `不应保留 ${path}`).toBe(false);
      expect(bare.preserved_part_paths).not.toContain(path);
    }
  });

  it('**反向对照 b**：证据里少一个部件就会被 unknownPartsDropped 抓出来（逐条比对，不是"空即非空"）', () => {
    const opened = openOrThrow('别家产出.xlsx', source);
    const kept = UNKNOWN_PART_PATHS[0];
    const partial = unknownPartsDropped(opened, { preserved_part_paths: [kept] });
    expect(partial).not.toContain(kept);
    expect(partial).toContain(UNKNOWN_PART_PATHS[1]);

    const nothing = unknownPartsDropped(opened, { preserved_part_paths: [] });
    for (const path of UNKNOWN_PART_PATHS) expect(nothing).toContain(path);
  });
});

// ---------------------------------------------------------------------------
// ④ CSV：口径显式，不符即显式失败
// ---------------------------------------------------------------------------

describe('CSV 导入 / 导出：编码 / 分隔符 / 类型全部显式', () => {
  it('导出 → 导入往返：实际使用的口径随结论回报，源摘要 = CSV 字节摘要', () => {
    const document = documentWithCells('数据.xlsx', '数据', [
      ['A1', textValue('名称')],
      ['B1', textValue('数量')],
      ['A2', textValue('餐饮, 含税')],
      ['B2', numberValue(120.5)],
      ['A3', textValue('')],
    ]);

    const exported = exportDeliverableCsv(document, { delimiter: ',', encoding: 'utf-8', quote: 'all-text' });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.sheet).toBe('数据');
    expect(exported.encoding).toBe('utf-8');
    expect(exported.delimiter).toBe(',');
    expect(exported.newline).toBe('lf');
    expect(exported.had_bom).toBe(false);
    expect(exported.row_count).toBe(3);
    expect(exported.column_count).toBe(2);

    const imported = importDeliverableFromCsv('回读.xlsx', exported.bytes, {
      delimiter: ',',
      type_mode: 'auto',
      sheet_name: '数据',
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.sheet_name).toBe('数据');
    expect(imported.encoding).toBe('utf-8');
    expect(imported.delimiter).toBe(',');
    expect(imported.had_bom).toBe(false);
    expect(imported.row_count).toBe(3);
    expect(imported.column_count).toBe(2);
    expect(imported.source.file_name).toBe('回读.xlsx');
    expect(imported.source.source_digest).toBe(digestBytes(exported.bytes));
    expect(imported.source.residual.parts).toEqual([]);

    const sheet = sheetOf(imported.source, '数据');
    expect(getCellValue(sheet, 'A2')).toEqual(textValue('餐饮, 含税'));
    expect(getCellValue(sheet, 'B2')).toEqual(numberValue(120.5));
    expect(getCellValue(sheet, 'E2')).toEqual(blank);
    expect(getCellValue(sheet, 'A3')).toEqual(textValue('')); // 显式空文本 ≠ 没有值
    expect(hasCell(sheet, 'E2')).toBe(false);
  });

  it('默认类型口径 = 文本：007 / 1,000 不被静默强转（R248）', () => {
    // 用 `;` 分隔，好让 `1,000` 整体落在一个字段里（逗号在这里是**文内容**，不是分隔符）。
    const bytes = utf8Bytes('007;1,000;50%;TRUE\n');
    const asText = importDeliverableFromCsv('编号.xlsx', bytes, { delimiter: ';' });
    expect(asText.ok).toBe(true);
    if (!asText.ok) return;
    expect(getCellValue(sheetOf(asText.source, 'Sheet1'), 'A1')).toEqual(textValue('007'));

    const auto = importDeliverableFromCsv('编号.xlsx', bytes, { delimiter: ';', type_mode: 'auto' });
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;
    const sheet = sheetOf(auto.source, 'Sheet1');
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('007')); // 前导零：编号，不是数
    expect(getCellValue(sheet, 'B1')).toEqual(textValue('1,000'));
    expect(getCellValue(sheet, 'C1')).toEqual(textValue('50%'));
    expect(getCellValue(sheet, 'D1')).toEqual(booleanValue(true)); // auto 下才推断
  });

  it('**反向对照（硬要求）**：GBK 按 utf-8 读 ⇒ 结构化失败，绝不静默乱码', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31, 0x0a]); // "中文,1\n"

    const wrong = importDeliverableFromCsv('中文.csv', gbk, { encoding: 'utf-8' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.kind).toBe('csv_encoding_mismatch');
      expect(wrong.detail).toMatch(/UTF-8/);
    }

    // 正向：显式 gbk 才读得对
    const right = importDeliverableFromCsv('中文.csv', gbk, { encoding: 'gbk' });
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    expect(right.encoding).toBe('gbk');
    const sheet = sheetOf(right.source, 'Sheet1');
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('中文'));
    expect(getCellValue(sheet, 'B1')).toEqual(textValue('1'));
  });

  it('**反向对照（硬要求）**：分号文件按逗号读 ⇒ 结构化失败，不得静默成功', () => {
    const text = 'a;b;c\n1;2;3\n';

    const wrong = importDeliverableFromCsv('分号.csv', utf8Bytes(text), { delimiter: ',' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.kind).toBe('csv_delimiter_mismatch');
      expect(wrong.detail).toMatch(/分隔符/);
    }

    // 正向：显式分号 ⇒ 3 列
    const right = importDeliverableFromCsv('分号.csv', utf8Bytes(text), { delimiter: ';' });
    expect(right.ok).toBe(true);
    if (!right.ok) return;
    expect(right.column_count).toBe(3);
    expect(getCellValue(sheetOf(right.source, 'Sheet1'), 'C2')).toEqual(textValue('3'));

    // 显式声明"确实一列"才放行——是**声明**，不是嗅探
    const declared = importDeliverableFromCsv('分号.csv', utf8Bytes(text), {
      delimiter: ',',
      single_column: true,
    });
    expect(declared.ok).toBe(true);
    if (declared.ok) expect(declared.column_count).toBe(1);

    // 反向对照：源里根本没有别的候选分隔符 ⇒ 单列是合理的，不该被拦
    const genuinelySingle = importDeliverableFromCsv('单列.csv', utf8Bytes('a\nb\n'), { delimiter: ',' });
    expect(genuinelySingle.ok).toBe(true);
  });

  it('BOM 是显式选项：utf-8-bom 导出带 BOM；声明 utf-8-bom 但源无 BOM ⇒ 结构化失败', () => {
    const document = documentWithCells('bom.xlsx', '数据', [['A1', textValue('x')]]);

    const bom = exportDeliverableCsv(document, { encoding: 'utf-8-bom' });
    expect(bom.ok).toBe(true);
    if (!bom.ok) return;
    expect(bom.had_bom).toBe(true);
    expect(Buffer.from(bom.bytes.subarray(0, 3)).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);

    const plain = exportDeliverableCsv(document, { encoding: 'utf-8' });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(Buffer.from(plain.bytes.subarray(0, 3)).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);

    const wrong = importDeliverableFromCsv('x.csv', plain.bytes, { encoding: 'utf-8-bom' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.kind).toBe('csv_encoding_mismatch');

    const auto = importDeliverableFromCsv('x.csv', bom.bytes, { encoding: 'auto' });
    expect(auto.ok).toBe(true);
    if (auto.ok) expect(auto.encoding).toBe('utf-8-bom');
  });

  it('公式装不进 CSV：默认结构化失败；formulas:"value" 才写求值结果', () => {
    const document = documentWithCells('计算.xlsx', '计算', [
      ['A1', numberValue(2)],
      ['A2', numberValue(3)],
      ['A3', formulaValue('SUM(A1:A2)')],
    ]);

    const refused = exportDeliverableCsv(document);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.kind).toBe('csv_formulas_not_representable');

    const values = exportDeliverableCsv(document, { formulas: 'value' });
    expect(values.ok).toBe(true);
    if (values.ok) expect(Buffer.from(values.bytes).toString('utf8')).toBe('2\n3\n5\n');
  });

  it('多表工作簿导出 CSV 必须显式指定 sheet ⇒ 否则结构化失败', () => {
    const document = newDeliverable('多表.xlsx', '一', '二');
    const refused = exportDeliverableCsv(document);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.kind).toBe('csv_sheet_selection_invalid');

    const chosen = exportDeliverableCsv(document, { sheet: '二' });
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.sheet).toBe('二');
  });

  it('文件名非法 ⇒ CSV 导入结构化失败（不落一份没有名字的文档）', () => {
    const bad = importDeliverableFromCsv('', utf8Bytes('a\n'), {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe('csv_import_failed');
  });

  it('CSV 导入的工作簿可继续走交付链：导出成真实 .xlsx 字节', () => {
    const imported = importDeliverableFromCsv('进货.csv', utf8Bytes('品名,数量\n米,3\n'), {
      delimiter: ',',
      type_mode: 'auto',
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const exported = xlsxIoDeliverableAdapter.exportBytes(imported.source);
    expect(exported.ok).toBe(true);
    if (exported.ok) {
      expect(exported.bytes.length).toBeGreaterThan(0);
      expect(exported.digest).toBe(digestBytes(exported.bytes));
      const reopened = reopenDeliverable(imported.source, exported.bytes);
      expect(reopened.ok).toBe(true);
      if (reopened.ok) {
        expect(getCellValue(sheetOf(reopened.source, 'Sheet1'), 'A2')).toEqual(textValue('米'));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ⑤ XLS-18：未接线 ⇒ 结构化 not-wired
// ---------------------------------------------------------------------------

describe('XLS-18：跨模板事实发布未接线 ⇒ 结构化 not-wired，claimed_published 恒 false', () => {
  /** 类型层：`claimed_published` 必须是**字面量** `false`（不是 `boolean`）。 */
  type MustBeFalse<T extends false> = T;

  it('claimed_published 恒为字面量 false（类型层）', () => {
    const literalCheck: MustBeFalse<XlsxFactPublicationOutcome['claimed_published']> = false;
    expect(literalCheck).toBe(false);
  });

  it('保存之后发起发布 ⇒ not-wired，不宣称已发布', () => {
    const saved = saveOrThrow(newDeliverable('预算.xlsx', '预算'));
    const outcome = publishWorkbookFacts(saved.save, {
      fact_keys: ['trip.headcount'],
      artifact_revision: 'rev-1',
    });
    expect(outcome.status).toBe('not-wired');
    expect(outcome.port_id).toBe('xls18.cross_template_fact_publication');
    expect(outcome.port_status).toBe('unimplemented');
    expect([...outcome.targets]).toEqual(['docx', 'pptx']);
    expect(outcome.claimed_published).toBe(false);
    // 发布必须说得出"它引用的是哪一版字节"
    expect(outcome.source_digest).toBe(saved.save.content_digest);
    expect(outcome.artifact_revision).toBe('rev-1');
    expect([...outcome.requested_fact_keys]).toEqual(['trip.headcount']);
    expect(outcome.reason.length).toBeGreaterThan(0);
    expect(outcome.unlock).toMatch(/解锁条件/);
  });

  it('**反向对照**：端口本身确实抛 ⇒ not-wired 是从真实的未实现端口转达的，不是编的', () => {
    expect(XLS18_FACT_PUBLICATION_PORT.status).toBe('unimplemented');
    expect(XLS18_FACT_PUBLICATION_PORT.port_id).toBe(outcomePortId());
    expect(() =>
      XLS18_FACT_PUBLICATION_PORT.publish({
        fact_keys: ['k'],
        artifact_revision: 'r',
        source_digest: 'd',
      }),
    ).toThrow(/尚未实现/);
  });

  it('事实键 / 版本标识为空 ⇒ 显式失败（发布必须说得出版本）', () => {
    const saved = saveOrThrow(newDeliverable('预算.xlsx'));
    expect(() =>
      publishWorkbookFacts(saved.save, { fact_keys: [], artifact_revision: 'r' }),
    ).toThrow(/fact_keys/);
    expect(() =>
      publishWorkbookFacts(saved.save, { fact_keys: ['k'], artifact_revision: '' }),
    ).toThrow(/artifact_revision/);
  });
});

/** 端口 id 的**唯一来源**（避免测试里另写一份字面量）。 */
function outcomePortId(): string {
  return XLS18_FACT_PUBLICATION_PORT.port_id;
}

// ---------------------------------------------------------------------------
// ⑥ 会话动词的直接判据
// ---------------------------------------------------------------------------

describe('会话动词：结构化而非抛穿', () => {
  it('打开非 .xlsx 字节 / 用垃圾字节重开 ⇒ 结构化 xlsx_read_failed', () => {
    const notAZip = openDeliverableFromXlsx('x.xlsx', utf8Bytes('这不是一个 ZIP'));
    expect(notAZip.ok).toBe(false);
    if (!notAZip.ok) expect(notAZip.kind).toBe('xlsx_read_failed');

    const document = newDeliverable('a.xlsx');
    const reopened = reopenDeliverable(document, utf8Bytes('也不是 ZIP'));
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.kind).toBe('xlsx_read_failed');
  });

  it('另存到非法文件名 ⇒ 结构化写失败（不抛）', () => {
    const document = newDeliverable('a.xlsx');
    const saved = saveDeliverableAs(document, 'dir/副本.xlsx');
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.kind).toBe('xlsx_write_failed');

    const empty = saveDeliverableAs(document, '');
    expect(empty.ok).toBe(false);
  });

  it('新建时表名非法 ⇒ 显式抛（入口参数错误，不假装建过）', () => {
    expect(() => newDeliverable('a.xlsx', '带/斜杠')).toThrow();
    expect(() => newDeliverable('')).toThrow();
  });

  it('多表：add_sheet / rename_sheet / set_active_sheet 后保存重开，表清单与活跃表都对', () => {
    let document = newDeliverable('多表.xlsx', '一');
    const added = xlsxIoDeliverableAdapter.applyEdit(document, { op: 'add_sheet', name: '二' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    document = added.source;
    const renamed = xlsxIoDeliverableAdapter.applyEdit(document, { op: 'rename_sheet', from: '二', to: '明细' });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    document = renamed.source;
    const activated = xlsxIoDeliverableAdapter.applyEdit(document, { op: 'set_active_sheet', name: '明细' });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    document = activated.source;

    const saved = saveOrThrow(document);
    const reopened = reopenDeliverable(document, saved.save.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(sheetNames(reopened.source.workbook)).toEqual(['一', '明细']);
    expect(reopened.source.workbook.active_sheet).toBe(1);
  });

  it('文字部件（docProps/core.xml）经全新文档一轮往返后仍在（残留跟着会话走）', () => {
    const opened = openOrThrow('别家产出.xlsx', packageWithUnknownParts());
    const first = saveOrThrow(opened);
    const reopened = reopenDeliverable(opened, first.save.bytes);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const second = saveOrThrow(reopened.source);
    expect(readZip(second.save.bytes).by_path.has('docProps/core.xml')).toBe(true);
    expect(unknownPartsDropped(reopened.source, second.save)).toEqual([]);
  });
});
