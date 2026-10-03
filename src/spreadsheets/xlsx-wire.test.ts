/**
 * XLS-10 / XLS-11 接线验收用例：**已交付的片段是否真的落进了 .xlsx 容器**。
 *
 * ## 判据不是"函数返回了东西"，而是"字节里有什么"
 *
 * 每个用例都用仓内的 `readZip` + `parseXmlBytes` 把产出的 .xlsx **读回来逐项核对**：
 * 部件是否存在、关系是否指得着、Content_Types 是否覆盖得住、工作表里到底有没有那个元素。
 *
 * ## 两组方向相反的证据
 *
 * - **正向**：给了数据验证 / 条件格式 / 结构化表格 ⇒ `dataValidations`、`conditionalFormatting`、
 *   x14 `extLst`、`xl/tables/tableN.xml`、工作表级 `_rels`、`[Content_Types].xml` Override、
 *   工作表 `<tableParts>` 逐个出现，且**能被自己的读取器读回**（`readWorkbookXlsx` 与 `parseXmlBytes`）。
 * - **反向对照**：不给这些输入 ⇒ 上述任何东西**一个都不出现**（部件、关系、Content_Types、
 *   `tableParts` 都不出现）；并且 `assertPackageIntegrity` 会抓住"悬空关系 / 部件没有内容类型"。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { resolveRelationshipTarget, utf8Bytes, writeZip } from '../artifacts/ooxml/index.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  findChildren,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE, XLSX_WORKBOOK_PART_PATH } from '../artifacts/templates/xlsx.js';
import { XLSX_STYLES_PART_PATH, tablePartPath, writeWorkbookXlsx, type XlsxWriteExtras } from './xlsx-write.js';
import { readWorkbookXlsx } from './xlsx-read.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook } from './workbook.js';
import { numberValue, textValue, type CellValue } from './value.js';
import { createStructuredTable } from './structured-table.js';
import { X14_NAMESPACE, XM_NAMESPACE, buildDxfsXml, type CfRule } from './conditional-format.js';
import type { DataValidationRule } from './validation.js';

// ---------------------------------------------------------------------------
// 探针（与 xlsx-write.test.ts 同口径：读回而非"看返回值"）
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

/** `.rels` 路径 → 持有者路径（`_rels/.rels` → `null`）。 */
function relsOwnerPath(relsPath: string): string | null {
  if (relsPath === '_rels/.rels') return null;
  const match = /^(.*)_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (match === null) throw new Error(`无法从 ${relsPath} 反推持有者`);
  return `${match[1] ?? ''}${match[2] ?? ''}`;
}

/**
 * 包完整性硬门（对应要求 5 的后半句）：**不得有悬空关系、不得有部件缺内容类型**。
 * 抓不到就抛——它是"悬空关系必须被抓到"这条判据的可执行形状。
 */
function assertPackageIntegrity(bytes: Uint8Array): void {
  const archive = readZip(bytes);
  const paths = new Set(archive.entries.map((entry) => entry.path));

  const typesEntry = archive.by_path.get('[Content_Types].xml');
  if (typesEntry === undefined) throw new Error('缺少 [Content_Types].xml');
  const defaults = new Set<string>();
  const overrides = new Set<string>();
  for (const child of childElements(parseXmlBytes(typesEntry.data))) {
    const extension = attr(child, 'Extension');
    const partName = attr(child, 'PartName');
    if (child.localName === 'Default' && extension !== null) defaults.add(extension.toLowerCase());
    if (child.localName === 'Override' && partName !== null) overrides.add(partName.replace(/^\/+/, ''));
  }

  for (const path of paths) {
    if (path === '[Content_Types].xml') continue;
    if (path.endsWith('.rels')) {
      if (!defaults.has('rels')) throw new Error(`关系部件 ${path} 没有 rels 默认内容类型`);
      continue;
    }
    if (!overrides.has(path)) throw new Error(`部件 ${path} 没有 [Content_Types].xml Override（部件没被内容类型覆盖）`);
  }

  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const owner = relsOwnerPath(entry.path);
    for (const relationship of childElements(parseXmlBytes(entry.data))) {
      if (relationship.localName !== 'Relationship') continue;
      if (attr(relationship, 'TargetMode') === 'External') continue;
      const target = attr(relationship, 'Target');
      if (target === null) continue;
      const resolved = resolveRelationshipTarget(owner, target);
      if (!paths.has(resolved)) {
        throw new Error(`悬空关系：${entry.path} → ${target}（解析为 ${resolved}，包内不存在）`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const DETAIL_TABLE = createStructuredTable({
  name: '明细表',
  range: 'A1:C4',
  columns: ['项目', '数量', '金额'],
  totals_row: true,
  style: { name: 'TableStyleMedium2', show_row_stripes: true },
});

const SUMMARY_TABLE = createStructuredTable({
  name: '汇总表',
  range: 'A1:B3',
  columns: ['月份', '合计'],
});

/** 两张表共用同一个填充色 ⇒ 用于验证 `dxfs` **跨表全局去重**。 */
const RED_FILL = { fill_color: 'FFC7CE' } as const;

const DETAIL_RULES: readonly CfRule[] = [
  { range: 'C2:C4', priority: 1, type: 'cellIs', operator: 'greaterThan', formulas: ['100'], format: RED_FILL },
  { range: 'C2:C4', priority: 2, type: 'dataBar', data_bar: { color: '638EC6' }, extended: true },
];

const SUMMARY_RULES: readonly CfRule[] = [
  { range: 'B2:B3', priority: 1, type: 'cellIs', operator: 'lessThan', formulas: ['0'], format: RED_FILL },
];

const DETAIL_VALIDATIONS: readonly DataValidationRule[] = [
  { ranges: ['A2:A4'], type: 'list', list_values: ['甲', '乙', '丙'], show_error_message: true, error: '请从下拉里选' },
];

const SUMMARY_VALIDATIONS: readonly DataValidationRule[] = [
  { ranges: ['B2:B3'], type: 'whole', operator: 'between', formula1: '0', formula2: '1000' },
];

function cell(sheet: ReturnType<typeof createSheet>, ref: string, value: CellValue) {
  return setCellValue(sheet, ref, value);
}

function buildWorkbook() {
  let detail = createSheet('明细', { row_count: 4, column_count: 3 });
  detail = cell(detail, 'A1', textValue('项目'));
  detail = cell(detail, 'B1', textValue('数量'));
  detail = cell(detail, 'C1', textValue('金额'));
  detail = cell(detail, 'A2', textValue('甲'));
  detail = cell(detail, 'B2', numberValue(2));
  detail = cell(detail, 'C2', numberValue(120));
  detail = cell(detail, 'A3', textValue('乙'));
  detail = cell(detail, 'B3', numberValue(3));
  detail = cell(detail, 'C3', numberValue(300));
  detail = cell(detail, 'A4', textValue('合计'));
  detail = cell(detail, 'C4', numberValue(420));

  let summary = createSheet('汇总', { row_count: 3, column_count: 2 });
  summary = cell(summary, 'A1', textValue('月份'));
  summary = cell(summary, 'B1', textValue('合计'));
  summary = cell(summary, 'A2', textValue('一月'));
  summary = cell(summary, 'B2', numberValue(120));
  summary = cell(summary, 'A3', textValue('二月'));
  summary = cell(summary, 'B3', numberValue(300));

  return createWorkbook([detail, summary]);
}

const EXTRAS: XlsxWriteExtras = {
  sheets: {
    明细: {
      data_validations: DETAIL_VALIDATIONS,
      conditional_formats: DETAIL_RULES,
      tables: [DETAIL_TABLE],
    },
    汇总: {
      data_validations: SUMMARY_VALIDATIONS,
      conditional_formats: SUMMARY_RULES,
      tables: [SUMMARY_TABLE],
    },
  },
};

// ---------------------------------------------------------------------------
// 正向：部件真的被写进容器
// ---------------------------------------------------------------------------

describe('xlsx-wire：注入后部件清单完整（表部件 + 工作表级关系）', () => {
  const result = writeWorkbookXlsx(buildWorkbook(), undefined, EXTRAS);
  const archive = readZip(result.bytes);
  const paths = archive.entries.map((entry) => entry.path);

  it('部件定序与清单：表部件紧跟样式，工作表级 rels 排在最后', () => {
    expect(paths).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      XLSX_WORKBOOK_PART_PATH,
      XLSX_STYLES_PART_PATH,
      tablePartPath(1),
      tablePartPath(2),
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/_rels/sheet1.xml.rels',
      'xl/worksheets/_rels/sheet2.xml.rels',
    ]);
    expect(result.table_part_paths).toEqual([tablePartPath(1), tablePartPath(2)]);
  });

  it('[Content_Types].xml 覆盖了表部件', () => {
    const types = textOfPart(archive, '[Content_Types].xml');
    expect(types).toContain('PartName="/xl/tables/table1.xml"');
    expect(types).toContain('PartName="/xl/tables/table2.xml"');
    expect(types).toContain('spreadsheetml.table+xml');
  });

  it('工作表级 _rels 把表挂到对应工作表上（相对目标 ../tables/…）', () => {
    const rels = rootOfPart(archive, 'xl/worksheets/_rels/sheet1.xml.rels');
    const relationships = childElements(rels);
    expect(relationships).toHaveLength(1);
    expect(attr(relationships[0] as ParsedXmlElement, 'Target')).toBe('../tables/table1.xml');
    expect(attr(relationships[0] as ParsedXmlElement, 'Id')).toBe('rId1');

    const rels2 = childElements(rootOfPart(archive, 'xl/worksheets/_rels/sheet2.xml.rels'));
    expect(attr(rels2[0] as ParsedXmlElement, 'Target')).toBe('../tables/table2.xml');
  });

  it('确定性：同一输入连跑两次 ⇒ 字节逐一相等', () => {
    const again = writeWorkbookXlsx(buildWorkbook(), undefined, EXTRAS);
    expect(Buffer.compare(result.bytes, again.bytes)).toBe(0);
  });

  it('包完整性硬门：无悬空关系、无部件缺内容类型', () => {
    expect(() => assertPackageIntegrity(result.bytes)).not.toThrow();
  });

  it('能被自己的读取器读回：工作簿模型往返一致', () => {
    const readBack = readWorkbookXlsx(result.bytes);
    expect(readBack.workbook.sheets.map((sheet) => sheet.name)).toEqual(['明细', '汇总']);
    const detail = readBack.workbook.sheets[0];
    expect(detail).toBeDefined();
    expect(detail?.cells.get('C3')).toEqual({ kind: 'number', value: 300 });
    // 表部件对读取器是"未建模部件" ⇒ 走 R249 残留原样带回（不丢）
    const residualPaths = readBack.residual.parts.map((part) => part.path);
    expect(residualPaths).toContain('xl/tables/table1.xml');
    expect(residualPaths).toContain('xl/tables/table2.xml');
  });
});

// ---------------------------------------------------------------------------
// 正向：工作表 XML 里的三段注入
// ---------------------------------------------------------------------------

describe('xlsx-wire：工作表 XML 注入 dataValidations / conditionalFormatting / tableParts / x14', () => {
  const archive = readZip(writeWorkbookXlsx(buildWorkbook(), undefined, EXTRAS).bytes);
  const sheet1 = rootOfPart(archive, 'xl/worksheets/sheet1.xml');
  const sheet2 = rootOfPart(archive, 'xl/worksheets/sheet2.xml');

  it('数据验证：type / sqref / 内联列表公式逐项写对', () => {
    const validations = findChild(sheet1, SPREADSHEETML_NAMESPACE, 'dataValidations');
    expect(validations === null ? null : attr(validations, 'count')).toBe('1');
    const rule = (childrenOf(validations)[0] as ParsedXmlElement | undefined) ?? null;
    expect(rule === null ? null : attr(rule, 'type')).toBe('list');
    expect(rule === null ? null : attr(rule, 'sqref')).toBe('A2:A4');
    const formula1 = rule === null ? null : findChild(rule, SPREADSHEETML_NAMESPACE, 'formula1');
    expect(formula1 === null ? null : directText(formula1)).toBe('"甲,乙,丙"');
  });

  it('数据验证：whole + between 的两个界都写进去', () => {
    const validations = findChild(sheet2, SPREADSHEETML_NAMESPACE, 'dataValidations');
    const rule = (childrenOf(validations)[0] as ParsedXmlElement | undefined) ?? null;
    expect(rule === null ? null : attr(rule, 'type')).toBe('whole');
    expect(rule === null ? null : attr(rule, 'operator')).toBe('between');
    expect(rule === null ? null : directText(findChild(rule, SPREADSHEETML_NAMESPACE, 'formula1') as ParsedXmlElement)).toBe('0');
    expect(rule === null ? null : directText(findChild(rule, SPREADSHEETML_NAMESPACE, 'formula2') as ParsedXmlElement)).toBe('1000');
  });

  it('条件格式标准块：同范围的标准规则共用一块，dxfId 指向 dxfs[0]', () => {
    const blocks = findChildren(sheet1, SPREADSHEETML_NAMESPACE, 'conditionalFormatting');
    expect(blocks).toHaveLength(1);
    expect(attr(blocks[0] as ParsedXmlElement, 'sqref')).toBe('C2:C4');
    const rules = childElements(blocks[0] as ParsedXmlElement);
    // 扩展规则（dataBar）**只**出现在 x14 块里 ⇒ 标准块只剩 cellIs 这一条
    expect(rules.map((rule) => attr(rule, 'type'))).toEqual(['cellIs']);
    expect(attr(rules[0] as ParsedXmlElement, 'dxfId')).toBe('0');
    expect(attr(rules[0] as ParsedXmlElement, 'operator')).toBe('greaterThan');
    expect(attr(rules[0] as ParsedXmlElement, 'priority')).toBe('1');
  });

  it('x14 扩展块：extLst/ext/x14:conditionalFormattings 就位，sqref 与 GUID 齐备', () => {
    const extLst = findChild(sheet1, SPREADSHEETML_NAMESPACE, 'extLst');
    expect(extLst).not.toBeNull();
    const ext = (childrenOf(extLst)[0] as ParsedXmlElement | undefined) ?? null;
    expect(ext === null ? null : attr(ext, 'uri')).toBe('{B025F937-C7B1-47D3-B67F-A62EFF666E3E}');
    const container = ext === null ? null : findChild(ext, X14_NAMESPACE, 'conditionalFormattings');
    expect(container).not.toBeNull();
    const block = (childrenOf(container)[0] as ParsedXmlElement | undefined) ?? null;
    const cfRule = block === null ? null : findChild(block, X14_NAMESPACE, 'cfRule');
    expect(cfRule === null ? null : attr(cfRule, 'type')).toBe('dataBar');
    expect(cfRule === null ? null : attr(cfRule, 'id')).toMatch(/^\{[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}\}$/);
    const sqref = block === null ? null : findChild(block, XM_NAMESPACE, 'sqref');
    expect(sqref === null ? null : directText(sqref)).toBe('C2:C4');
  });

  it('tableParts：count 与 r:id 齐备，且根元素声明了 xmlns:r', () => {
    const tableParts = findChild(sheet1, SPREADSHEETML_NAMESPACE, 'tableParts');
    expect(tableParts === null ? null : attr(tableParts, 'count')).toBe('1');
    const part = (childrenOf(tableParts)[0] as ParsedXmlElement | undefined) ?? null;
    const relId = part === null ? null : attributeValue(part, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    expect(relId).toBe('rId1');
    expect(textOfPart(archive, 'xl/worksheets/sheet1.xml')).toContain('xmlns:r=');
  });
});

// ---------------------------------------------------------------------------
// 正向：xl/tables/tableN.xml 内容可读回且与输入一致
// ---------------------------------------------------------------------------

describe('xlsx-wire：表部件内容可读回、与输入一致', () => {
  const archive = readZip(writeWorkbookXlsx(buildWorkbook(), undefined, EXTRAS).bytes);

  it('table1.xml：name / displayName / ref / 列 / 汇总行 / 样式都在', () => {
    const table = rootOfPart(archive, tablePartPath(1));
    expect(attr(table, 'name')).toBe('明细表');
    expect(attr(table, 'id')).toBe('1');
    expect(attr(table, 'ref')).toBe('A1:C4');
    expect(attr(table, 'totalsRowCount')).toBe('1');
    const columns = childrenOf(findChild(table, SPREADSHEETML_NAMESPACE, 'tableColumns'));
    expect(columns.map((column) => attr(column, 'name'))).toEqual(['项目', '数量', '金额']);
    const style = findChild(table, SPREADSHEETML_NAMESPACE, 'tableStyleInfo');
    expect(style === null ? null : attr(style, 'name')).toBe('TableStyleMedium2');
    expect(style === null ? null : attr(style, 'showRowStripes')).toBe('1');
    // autoFilter 覆盖标题行到最后一个数据行（不含汇总行）
    const autoFilter = findChild(table, SPREADSHEETML_NAMESPACE, 'autoFilter');
    expect(autoFilter === null ? null : attr(autoFilter, 'ref')).toBe('A1:C3');
  });

  it('table2.xml：无汇总行的表 id 全局唯一（2）', () => {
    const table = rootOfPart(archive, tablePartPath(2));
    expect(attr(table, 'name')).toBe('汇总表');
    expect(attr(table, 'id')).toBe('2');
    expect(attr(table, 'ref')).toBe('A1:B3');
  });
});

// ---------------------------------------------------------------------------
// 正向：styles 的 dxfs（跨表全局去重 + 与模块产出一致）
// ---------------------------------------------------------------------------

describe('xlsx-wire：xl/styles.xml 注入 dxfs', () => {
  const result = writeWorkbookXlsx(buildWorkbook(), undefined, EXTRAS);
  const archive = readZip(result.bytes);
  const stylesXml = textOfPart(archive, XLSX_STYLES_PART_PATH);
  const styles = rootOfPart(archive, XLSX_STYLES_PART_PATH);

  it('dxfs 跨表全局去重：两张表同色 ⇒ 只有一条 dxf', () => {
    const dxfs = findChild(styles, SPREADSHEETML_NAMESPACE, 'dxfs');
    expect(dxfs === null ? null : attr(dxfs, 'count')).toBe('1');
    const dxf = (childrenOf(dxfs)[0] as ParsedXmlElement | undefined) ?? null;
    const fill = dxf === null ? null : findChild(dxf, SPREADSHEETML_NAMESPACE, 'fill');
    const patternFill = fill === null ? null : findChild(fill, SPREADSHEETML_NAMESPACE, 'patternFill');
    const bgColor = patternFill === null ? null : findChild(patternFill, SPREADSHEETML_NAMESPACE, 'bgColor');
    expect(bgColor === null ? null : attr(bgColor, 'rgb')).toBe('FFFFC7CE');
  });

  it('dxfs 与 conditional-format.ts 的 buildDxfsXml 逐字一致（去重后同一份格式）', () => {
    const expected = buildDxfsXml([{ fill_color: 'FFC7CE' }]);
    expect(expected).not.toBeNull();
    // 模块片段带一个与基座重复的默认 xmlns；元素树里被去掉，其余逐字相同
    expect(stylesXml).toContain((expected as string).replace(` xmlns="${SPREADSHEETML_NAMESPACE}"`, ''));
  });

  it('既有 styles 部件未被破坏：cellXfs / fills 老内容仍在，dxfs 排在 cellXfs 之后', () => {
    expect(stylesXml).toContain('patternType="none"');
    expect(stylesXml).toContain('patternType="gray125"');
    const cellXfs = childrenOf(findChild(styles, SPREADSHEETML_NAMESPACE, 'cellXfs'));
    expect(cellXfs).toHaveLength(2);
    expect(stylesXml.indexOf('<dxfs')).toBeGreaterThan(stylesXml.indexOf('<cellXfs'));
  });
});

// ---------------------------------------------------------------------------
// 反向对照：不给输入 ⇒ 一个都不出现
// ---------------------------------------------------------------------------

describe('xlsx-wire：反向对照——不给附加内容就什么都不写', () => {
  const result = writeWorkbookXlsx(buildWorkbook());
  const archive = readZip(result.bytes);
  const paths = archive.entries.map((entry) => entry.path);

  it('部件清单里没有表部件、没有工作表级 rels', () => {
    expect(paths).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      XLSX_WORKBOOK_PART_PATH,
      XLSX_STYLES_PART_PATH,
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/_rels/workbook.xml.rels',
    ]);
    expect(result.table_part_paths).toEqual([]);
  });

  it('[Content_Types].xml 没有表内容类型', () => {
    expect(textOfPart(archive, '[Content_Types].xml')).not.toContain('spreadsheetml.table+xml');
  });

  it('工作表里没有 dataValidations / conditionalFormatting / tableParts / extLst / xmlns:r', () => {
    const xml = textOfPart(archive, 'xl/worksheets/sheet1.xml');
    expect(xml).not.toContain('dataValidations');
    expect(xml).not.toContain('conditionalFormatting');
    expect(xml).not.toContain('tableParts');
    expect(xml).not.toContain('extLst');
    expect(xml).not.toContain('xmlns:r=');
  });

  it('styles.xml 里没有 dxfs', () => {
    expect(textOfPart(archive, XLSX_STYLES_PART_PATH)).not.toContain('<dxfs');
  });

  it('包完整性硬门同样通过（不写 ≠ 写歪）', () => {
    expect(() => assertPackageIntegrity(result.bytes)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 反向对照：完整性硬门**真的会抓**悬空关系 / 缺内容类型
// ---------------------------------------------------------------------------

const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOC_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const WORKSHEET_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

function buildRawPackage(types: string, rootRels: string, workbookRels: string | null): Uint8Array {
  const entries = [
    { path: '[Content_Types].xml', data: utf8Bytes(types) },
    { path: '_rels/.rels', data: utf8Bytes(rootRels) },
    { path: 'xl/workbook.xml', data: utf8Bytes(`<workbook xmlns="${SPREADSHEETML_NAMESPACE}"/>`) },
  ];
  if (workbookRels !== null) {
    entries.push({ path: 'xl/_rels/workbook.xml.rels', data: utf8Bytes(workbookRels) });
  }
  return writeZip(entries);
}

describe('xlsx-wire：完整性硬门抓住坏包（它自己也得能被证伪）', () => {
  it('悬空关系 ⇒ 抛', () => {
    const types = `<?xml version="1.0"?><Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
    const rootRels = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_DOC_NS}" Target="xl/workbook.xml"/></Relationships>`;
    // 引用了 worksheets/sheet1.xml，但包里根本没有这个部件
    const workbookRels = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${WORKSHEET_REL_NS}" Target="worksheets/sheet1.xml"/></Relationships>`;
    expect(() => assertPackageIntegrity(buildRawPackage(types, rootRels, workbookRels))).toThrow(/悬空关系/);
  });

  it('部件存在但没有内容类型覆盖 ⇒ 抛', () => {
    // 只声明了 rels 默认项与 workbook 的 Override；表部件没有任何内容类型覆盖
    const types = `<?xml version="1.0"?><Types xmlns="${CT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
    const rootRels = `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_DOC_NS}" Target="xl/workbook.xml"/></Relationships>`;
    const bytes = buildRawPackage(types, rootRels, null);
    // 追加一个没有 Override 的表部件
    const withTable = writeZip([
      { path: '[Content_Types].xml', data: utf8Bytes(types) },
      { path: '_rels/.rels', data: utf8Bytes(rootRels) },
      { path: 'xl/workbook.xml', data: utf8Bytes(`<workbook xmlns="${SPREADSHEETML_NAMESPACE}"/>`) },
      { path: 'xl/tables/table1.xml', data: utf8Bytes(`<table xmlns="${SPREADSHEETML_NAMESPACE}"/>`) },
    ]);
    expect(bytes.length).toBeGreaterThan(0);
    expect(() => assertPackageIntegrity(withTable)).toThrow(/没有 \[Content_Types\].xml Override/);
  });
});

// ---------------------------------------------------------------------------
// 参数纪律：未知工作表名显式失败（不静默丢弃）
// ---------------------------------------------------------------------------

describe('xlsx-wire：extras 指向未知工作表 ⇒ 显式失败', () => {
  it('抛 ValidationError', () => {
    expect(() =>
      writeWorkbookXlsx(buildWorkbook(), undefined, {
        sheets: { 不存在的表: { data_validations: DETAIL_VALIDATIONS } },
      }),
    ).toThrow(/不存在的工作表/);
  });
});
