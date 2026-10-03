/**
 * **X-R01** 外部语料：产出方形态的工作簿（真实 ZIP 字节）+ 反向夹具。
 *
 * ## 这些字节是什么 / 不是什么
 *
 * 每一条 `bytes` 都是**真实可写盘的 .xlsx 容器**（`assembleOpcPackage` + `writeZip`，
 * 或手装容器），但它们**不是**真实 Excel / WPS 写出的文件——没有任何字节来自那两个软件。
 * 它们复刻的是外部文件的**结构特征**，用来把"导入 → 导出 → 重导入"的保真判据钉死。
 * 真正的外部语料一旦可用，走 {@link loadCorpusFromDirectory}（见 `corpus-io.ts`）纳入同一套回归。
 *
 * ## 语料清单
 *
 * | id | provenance | 覆盖的结构特征 |
 * | --- | --- | --- |
 * | `excel-multisheet-rich` | excel-emulation | 3 表（含隐藏）、共享公式、日期样式、共享字符串、冻结、合并、docProps、theme、calcChain、表级 `_rels`、外部关系 |
 * | `wps-default-content-types` | wps-emulation | Default 扩展名内容类型（无 Override）、custom 属性部件 |
 * | `excel-defined-names-shared-range` | excel-emulation | `<definedNames>`（`_xlnm.Print_Area` / `Print_Titles` / 用户自定义名）、**跨行跨列**的共享公式范围（`ref="B2:C3"`）、现代错误值 `#SPILL!` 往返 |
 * | `excel-drawing-sheet-rels` | excel-emulation | `xl/drawings/drawing1.xml` + 工作表级 `_rels` 的 `r:id="rId1"` 图形关系、工作表 XML 的 `<drawing r:id>` |
 * | `negative-not-zip` | negative-fixture | 非 ZIP 字节 ⇒ `ZipReadError` |
 * | `negative-truncated` | negative-fixture | 截断容器 ⇒ `ZipReadError` |
 * | `negative-missing-workbook` | negative-fixture | 缺 `xl/workbook.xml` ⇒ `ValidationError` |
 * | `negative-unsupported-error-code` | negative-fixture | 读侧枚举之外的错误值 `#FOO!` ⇒ `ValidationError`（能力边界反面：7 个经典 + 9 个现代 Excel 代码之外的代码仍被拒） |
 */

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  utf8Bytes,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { writeZip, type ZipEntry } from '../../../../src/artifacts/ooxml/zip.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';
import {
  STYLES_RELATIONSHIP_TYPE,
  XLSX_STYLES_CONTENT_TYPE,
  XLSX_STYLES_PART_PATH,
} from '../../../../src/spreadsheets/xlsx-write.js';

import type { CorpusEntry } from './schemas.js';

// ---------------------------------------------------------------------------
// 外部产出方用到、但本仓读侧不重建的内容类型 / 关系类型
// ---------------------------------------------------------------------------

const RELS_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_RELS_BASE = 'http://schemas.openxmlformats.org/package/2006/relationships';

const CONTENT_TYPES = {
  sharedStrings: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  calcChain: 'application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml',
  comments: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
  coreProps: 'application/vnd.openxmlformats-package.core-properties+xml',
  appProps: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
} as const;

const REL_TYPES = {
  sharedStrings: `${RELS_BASE}/sharedStrings`,
  theme: `${RELS_BASE}/theme`,
  calcChain: `${RELS_BASE}/calcChain`,
  comments: `${RELS_BASE}/comments`,
  externalLink: `${RELS_BASE}/externalLink`,
  coreProps: `${PKG_RELS_BASE}/metadata/core-properties`,
  appProps: `${RELS_BASE}/extended-properties`,
} as const;

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** 外部占位 URL：`.invalid` 是 RFC 2606 保留 TLD，不含任何真实主机 / 凭据。 */
const EXTERNAL_LINK_TARGET = 'https://example.invalid/shared/source-workbook.xlsx';

// ---------------------------------------------------------------------------
// 组装工具
// ---------------------------------------------------------------------------

/** 用 OPC 组装器包一个合法包（内容类型 / 关系部件由组装器生成）。 */
function assemblePackage(parts: readonly OpcPart[], relationships: readonly RelationshipGroup[]): Uint8Array {
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });
  return new Uint8Array(writeZip(assembled.entries));
}

/**
 * 手装一个容器：直接控制 `[Content_Types].xml` 与各个 `_rels` 部件。
 *
 * 为什么需要它：OPC 组装器固定用 `Override` 表达每个部件的内容类型，而真实 WPS 常靠
 * `<Default Extension="xml" .../>` 兜底。要覆盖"Default 解析"这条路径，就必须自己写内容类型。
 * 手装容器**不做**路径存在性校验，因此也用来造"缺部件"的反向夹具。
 */
function rawPackage(entries: readonly ZipEntry[]): Uint8Array {
  return new Uint8Array(writeZip(entries));
}

function textBytes(text: string): Uint8Array {
  return utf8Bytes(text);
}

// ---------------------------------------------------------------------------
// 语料 1：excel-multisheet-rich
// ---------------------------------------------------------------------------

const SUMMARY_SHEET = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<dimension ref="A1:C3"/>' +
  '<sheetViews><sheetView tabSelected="1" workbookViewId="0">' +
  '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
  '</sheetView></sheetViews>' +
  '<sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>Value</t></is></c>' +
  '<c r="C1" t="inlineStr"><is><t>Double</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>Alpha</t></is></c>' +
  '<c r="B2"><v>10</v></c>' +
  '<c r="C2"><f t="shared" ref="C2:C3" si="0">B2*2</f><v>20</v></c></row>' +
  '<row r="3"><c r="A3" t="inlineStr"><is><t>Beta</t></is></c>' +
  '<c r="B3"><v>7.5</v></c>' +
  '<c r="C3"><f t="shared" si="0"/><v>15</v></c></row>' +
  '</sheetData>' +
  '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>' +
  '</worksheet>';

const DATA_SHEET = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<dimension ref="A1:D4"/>' +
  '<sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>Amount</t></is></c>' +
  '<c r="C1" t="inlineStr"><is><t>Flag</t></is></c>' +
  '<c r="D1" t="inlineStr"><is><t>Date</t></is></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>0</v></c>' +
  '<c r="B2"><v>100.5</v></c>' +
  '<c r="C2" t="b"><v>1</v></c>' +
  '<c r="D2" s="1"><v>45000</v></c></row>' +
  '<row r="3"><c r="A3" t="s"><v>1</v></c>' +
  '<c r="B3"><f>SUM(B2:B2)</f><v>100.5</v></c>' +
  '<c r="C3" t="b"><v>0</v></c>' +
  '<c r="D3" t="e"><v>#DIV/0!</v></c></row>' +
  '</sheetData></worksheet>';

const HIDDEN_SHEET = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<dimension ref="A1:B2"/><sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>key</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>val</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>rate</t></is></c>' +
  '<c r="B2"><v>0.13</v></c></row>' +
  '</sheetData></worksheet>';

const WORKBOOK_3SHEETS = `${XML_DECL}<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
  `xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">` +
  '<bookViews><workbookView activeTab="0"/></bookViews>' +
  '<sheets>' +
  '<sheet name="Summary" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Data" sheetId="2" r:id="rId2"/>' +
  '<sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/>' +
  '</sheets></workbook>';

const STYLES = `${XML_DECL}<styleSheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs></styleSheet>';

const SHARED_STRINGS = `${XML_DECL}<sst xmlns="${SPREADSHEETML_NAMESPACE}" count="2" uniqueCount="2">` +
  '<si><t>Widget</t></si><si><t>Gadget</t></si></sst>';

/** theme 部件：真实 Excel 会带；本仓不建模 ⇒ 必须原样保留。 */
const THEME = `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">` +
  '<a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '</a:clrScheme></a:themeElements></a:theme>';

/** calcChain 部件：引用公式格的链条；本仓不重建 ⇒ 原样保留。 */
const CALC_CHAIN = `${XML_DECL}<calcChain xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<c r="C2" i="1"/><c r="C3" i="1"/><c r="B3" i="2"/></calcChain>';

/** 批注部件（工作表级关系指向它）⇒ 原样保留。 */
const COMMENTS = `${XML_DECL}<comments xmlns="${SPREADSHEETML_NAMESPACE}"><authors><author>qa</author></authors>` +
  '<commentList><comment ref="B2" authorId="0"><text><t>reviewed</t></text></comment></commentList></comments>';

const CORE_PROPS = `${XML_DECL}<cp:coreProperties ` +
  'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
  '<dc:creator>external</dc:creator><cp:lastModifiedBy>external</cp:lastModifiedBy></cp:coreProperties>';

const APP_PROPS = `${XML_DECL}<Properties ` +
  'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  '<Application>Microsoft Excel</Application><AppVersion>16.0300</AppVersion></Properties>';

function excelMultisheetRich(): CorpusEntry {
  const bytes = assemblePackage(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: WORKBOOK_3SHEETS },
      { path: XLSX_STYLES_PART_PATH, content_type: XLSX_STYLES_CONTENT_TYPE, data: STYLES },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: SUMMARY_SHEET },
      { path: 'xl/worksheets/sheet2.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: DATA_SHEET },
      { path: 'xl/worksheets/sheet3.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: HIDDEN_SHEET },
      { path: 'xl/sharedStrings.xml', content_type: CONTENT_TYPES.sharedStrings, data: SHARED_STRINGS },
      { path: 'xl/theme/theme1.xml', content_type: CONTENT_TYPES.theme, data: THEME },
      { path: 'xl/calcChain.xml', content_type: CONTENT_TYPES.calcChain, data: CALC_CHAIN },
      { path: 'xl/comments1.xml', content_type: CONTENT_TYPES.comments, data: COMMENTS },
      { path: 'docProps/core.xml', content_type: CONTENT_TYPES.coreProps, data: CORE_PROPS },
      { path: 'docProps/app.xml', content_type: CONTENT_TYPES.appProps, data: APP_PROPS },
    ],
    [
      {
        owner_part_path: null,
        declarations: [
          { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH },
          { type: REL_TYPES.coreProps, target: 'docProps/core.xml' },
          { type: REL_TYPES.appProps, target: 'docProps/app.xml' },
        ],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [
          { type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' },
          { type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet2.xml' },
          { type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet3.xml' },
          { type: STYLES_RELATIONSHIP_TYPE, target: 'styles.xml' },
          { type: REL_TYPES.theme, target: 'theme/theme1.xml' },
          { type: REL_TYPES.calcChain, target: 'calcChain.xml' },
          { type: REL_TYPES.sharedStrings, target: 'sharedStrings.xml' },
          { type: REL_TYPES.externalLink, target: EXTERNAL_LINK_TARGET, target_mode: 'External' },
        ],
      },
      {
        owner_part_path: 'xl/worksheets/sheet1.xml',
        declarations: [{ type: REL_TYPES.comments, target: '../comments1.xml' }],
      },
    ],
  );

  return {
    id: 'excel-multisheet-rich',
    provenance: 'excel-emulation',
    description: '3 表（含隐藏）+ 共享公式 + 日期 + 共享字符串 + 冻结/合并 + docProps/theme/calcChain/表级 rels + 外部关系',
    bytes,
    expected_import: 'ok',
    expected_preserved_parts: [
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/calcChain.xml',
      'xl/comments1.xml',
      'xl/theme/theme1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
    ],
    expected_content_types: {
      'docProps/core.xml': CONTENT_TYPES.coreProps,
      'xl/theme/theme1.xml': CONTENT_TYPES.theme,
      'xl/worksheets/_rels/sheet1.xml.rels': RELATIONSHIPS_CONTENT_TYPE,
    },
  };
}

// ---------------------------------------------------------------------------
// 语料 2：wps-default-content-types（手装容器，内容类型走 Default 扩展名）
// ---------------------------------------------------------------------------

const WPS_CONTENT_TYPES = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="${RELATIONSHIPS_CONTENT_TYPE}"/>` +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  `<Override PartName="/xl/workbook.xml" ContentType="${XLSX_MAIN_CONTENT_TYPE}"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${XLSX_WORKSHEET_CONTENT_TYPE}"/>` +
  '</Types>';

const WPS_ROOT_RELS = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP_TYPE}" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WPS_WORKBOOK_RELS = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet1.xml"/>` +
  '</Relationships>';

const WPS_WORKBOOK = `${XML_DECL}<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
  `xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">` +
  '<bookViews><workbookView activeTab="0"/></bookViews>' +
  '<sheets><sheet name="WPS Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>';

const WPS_SHEET = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<dimension ref="A1:B2"/><sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>City</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>Count</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>Shanghai</t></is></c><c r="B2"><v>24</v></c></row>' +
  '</sheetData></worksheet>';

const WPS_CUSTOM_PROPS = `${XML_DECL}<Properties ` +
  'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ProducedBy">' +
  '<vt:lpwstr>WPS</vt:lpwstr></property></Properties>';

function wpsDefaultContentTypes(): CorpusEntry {
  const bytes = rawPackage([
    { path: '[Content_Types].xml', data: textBytes(WPS_CONTENT_TYPES) },
    { path: '_rels/.rels', data: textBytes(WPS_ROOT_RELS) },
    { path: XLSX_WORKBOOK_PART_PATH, data: textBytes(WPS_WORKBOOK) },
    { path: 'xl/_rels/workbook.xml.rels', data: textBytes(WPS_WORKBOOK_RELS) },
    { path: 'xl/worksheets/sheet1.xml', data: textBytes(WPS_SHEET) },
    // 这两个部件在 [Content_Types].xml 里**没有 Override** ⇒ 只能靠 Default 的 xml 兜底
    { path: 'docProps/core.xml', data: textBytes(CORE_PROPS) },
    { path: 'docProps/custom.xml', data: textBytes(WPS_CUSTOM_PROPS) },
  ]);

  return {
    id: 'wps-default-content-types',
    provenance: 'wps-emulation',
    description: 'Default 扩展名内容类型（无 Override）+ custom 属性部件（靠 Default 解析）',
    bytes,
    expected_import: 'ok',
    expected_preserved_parts: ['docProps/core.xml', 'docProps/custom.xml'],
    expected_content_types: {
      'docProps/core.xml': 'application/xml',
      'docProps/custom.xml': 'application/xml',
    },
  };
}

// ---------------------------------------------------------------------------
// 语料 3：excel-defined-names-shared-range
//
// 外部产出方（Excel / WPS）的工作簿几乎总有 `<definedNames>`；本仓读侧只把
// `_xlnm.Print_Area` / `_xlnm.Print_Titles` 解析进 `print` 模型，用户自定义名**不建模**。
// 同时这里放一个**跨行跨列**的共享公式范围（主格 `ref="B2:C3"`、三个从属格），
// 把"按 (行偏移, 列偏移) 平移"钉死——既有的 `excel-multisheet-rich` 只覆盖了单列两行。
// ---------------------------------------------------------------------------

const DEFINED_NAMES_WORKBOOK = `${XML_DECL}<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
  `xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">` +
  '<bookViews><workbookView activeTab="0"/></bookViews>' +
  '<sheets><sheet name="Named" sheetId="1" r:id="rId1"/></sheets>' +
  '<definedNames>' +
  '<definedName name="_xlnm.Print_Area" localSheetId="0">\'Named\'!$A$1:$C$3</definedName>' +
  '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'Named\'!$1:$1</definedName>' +
  '<definedName name="QuarterlyTotal">\'Named\'!$B$2:$C$3</definedName>' +
  '</definedNames>' +
  '</workbook>';

const DEFINED_NAMES_SHEET = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
  '<dimension ref="A1:E3"/><sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>Value</t></is></c>' +
  '<c r="E1" t="e"><v>#SPILL!</v></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>Alpha</t></is></c>' +
  '<c r="B2"><f t="shared" ref="B2:C3" si="1">A2*2</f><v>20</v></c>' +
  '<c r="C2"><f t="shared" si="1"/><v>20</v></c>' +
  '<c r="D2"><v>2</v></c></row>' +
  '<row r="3"><c r="A3" t="inlineStr"><is><t>Beta</t></is></c>' +
  '<c r="B3"><f t="shared" si="1"/><v>15</v></c>' +
  '<c r="C3"><f t="shared" si="1"/><v>15</v></c></row>' +
  '</sheetData></worksheet>';

function excelDefinedNamesSharedRange(): CorpusEntry {
  const bytes = assemblePackage(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: DEFINED_NAMES_WORKBOOK },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: DEFINED_NAMES_SHEET },
      { path: 'docProps/core.xml', content_type: CONTENT_TYPES.coreProps, data: CORE_PROPS },
    ],
    [
      {
        owner_part_path: null,
        declarations: [
          { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH },
          { type: REL_TYPES.coreProps, target: 'docProps/core.xml' },
        ],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
      },
    ],
  );

  return {
    id: 'excel-defined-names-shared-range',
    provenance: 'excel-emulation',
    description: 'definedNames（Print_Area / Print_Titles / 用户自定义名）+ 跨行跨列共享公式范围（ref=B2:C3）+ 现代错误值 #SPILL!',
    bytes,
    expected_import: 'ok',
    expected_preserved_parts: ['docProps/core.xml'],
    expected_content_types: {
      'docProps/core.xml': CONTENT_TYPES.coreProps,
    },
  };
}

// ---------------------------------------------------------------------------
// 语料 4：excel-drawing-sheet-rels
//
// 外形（`xl/drawings/drawingN.xml`）+ 工作表级关系（`xl/worksheets/_rels/sheetN.xml.rels`）
// 是"图挂在表上"的标准形态：工作表 XML 里 `<drawing r:id="rId1"/>`，关系部件把 `rId1` 指到
// `../drawings/drawing1.xml`。**两份部件都在本仓读侧的"未知部件"集合里 ⇒ 逐字节保留**（R249）。
//
// 诚实边界（见 `xlsx-write.ts` 顶部）：工作表 XML 是**重建**的，本仓不恢复它内部对 `r:id` 的
// 引用——因此导出后 `<drawing>` 元素不会出现，而**关系部件的字节（含 `rId1 → drawing1.xml`）
// 原样保留**。本语料既钉住"两份部件逐字节保真 + 内容类型解析"，也把这个"引用未恢复"的边界
// 显式断言下来（在测试里），不夸大。
// ---------------------------------------------------------------------------

const DRAWING_RELATIONSHIP_TYPE = `${RELS_BASE}/drawing`;
const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';

const DRAWING_WORKBOOK = `${XML_DECL}<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
  `xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">` +
  '<bookViews><workbookView activeTab="0"/></bookViews>' +
  '<sheets><sheet name="Canvas" sheetId="1" r:id="rId1"/></sheets></workbook>';

/** 工作表 XML：末尾带 `<drawing r:id="rId1"/>`（CT_Worksheet 序列里 drawing 在 tableParts 之前）。 */
const DRAWING_SHEET = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}" ` +
  `xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}">` +
  '<dimension ref="A1:B2"/><sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>Shape</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><t>Label</t></is></c></row>' +
  '<row r="2"><c r="A2" t="inlineStr"><is><t>box</t></is></c>' +
  '<c r="B2" t="inlineStr"><is><t>hello</t></is></c></row>' +
  '</sheetData>' +
  '<drawing r:id="rId1"/></worksheet>';

/** 最小 DrawingML 容器（本仓不建模；只需是合法 XML 且能被原样带回）。 */
const DRAWING_PART = `${XML_DECL}<xdr:wsDr ` +
  'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>';

function excelDrawingSheetRels(): CorpusEntry {
  const bytes = assemblePackage(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: DRAWING_WORKBOOK },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: DRAWING_SHEET },
      { path: 'xl/drawings/drawing1.xml', content_type: DRAWING_CONTENT_TYPE, data: DRAWING_PART },
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
      {
        owner_part_path: 'xl/worksheets/sheet1.xml',
        declarations: [{ type: DRAWING_RELATIONSHIP_TYPE, target: '../drawings/drawing1.xml' }],
      },
    ],
  );

  return {
    id: 'excel-drawing-sheet-rels',
    provenance: 'excel-emulation',
    description: 'xl/drawings/drawing1.xml + 工作表级 _rels 的 r:id=rId1 图形关系 + 工作表 XML 的 <drawing r:id>',
    bytes,
    expected_import: 'ok',
    expected_preserved_parts: ['xl/drawings/drawing1.xml', 'xl/worksheets/_rels/sheet1.xml.rels'],
    expected_content_types: {
      'xl/drawings/drawing1.xml': DRAWING_CONTENT_TYPE,
      'xl/worksheets/_rels/sheet1.xml.rels': RELATIONSHIPS_CONTENT_TYPE,
    },
  };
}

// ---------------------------------------------------------------------------
// 语料 5–8：反向夹具
// ---------------------------------------------------------------------------

function negativeNotZip(): CorpusEntry {
  return {
    id: 'negative-not-zip',
    provenance: 'negative-fixture',
    description: '非 ZIP 字节（真实仓库产物里出现过同形态的伪 xlsx）⇒ ZipReadError',
    bytes: utf8Bytes('not really xlsx'),
    expected_import: { throws: 'zip' },
  };
}

function negativeTruncated(source: Uint8Array): CorpusEntry {
  const cut = Math.floor(source.length / 2);
  return {
    id: 'negative-truncated',
    provenance: 'negative-fixture',
    description: '把合法容器截成一半 ⇒ ZipReadError（不得返回半个工作簿）',
    bytes: source.subarray(0, cut),
    expected_import: { throws: 'zip' },
  };
}

function negativeMissingWorkbook(): CorpusEntry {
  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="${RELATIONSHIPS_CONTENT_TYPE}"/>` +
    '<Default Extension="xml" ContentType="application/xml"/></Types>';
  const rootRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP_TYPE}" Target="xl/workbook.xml"/>` +
    '</Relationships>';
  const bytes = rawPackage([
    { path: '[Content_Types].xml', data: textBytes(contentTypes) },
    { path: '_rels/.rels', data: textBytes(rootRels) },
    { path: 'xl/worksheets/sheet1.xml', data: textBytes(WPS_SHEET) },
  ]);
  return {
    id: 'negative-missing-workbook',
    provenance: 'negative-fixture',
    description: '容器合法但缺 xl/workbook.xml ⇒ ValidationError（不静默造一个空工作簿）',
    bytes,
    expected_import: { throws: 'validation' },
  };
}

function negativeUnsupportedErrorCode(): CorpusEntry {
  // 读侧枚举已扩到「7 个经典 + 9 个现代 Excel 代码」（X-R01 集成请求已落地，见 xlsx-read.ts）。
  // 这里用一个**两侧枚举都没有**的代码，钉住"枚举之外仍显式抛错、绝不静默降级"这条边界。
  const sheet = `${XML_DECL}<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>` +
    '<row r="1"><c r="A1" t="e"><v>#FOO!</v></c></row></sheetData></worksheet>';
  const workbook = `${XML_DECL}<workbook xmlns="${SPREADSHEETML_NAMESPACE}" ` +
    `xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"><sheets>` +
    '<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const bytes = assemblePackage(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbook },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheet },
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
  return {
    id: 'negative-unsupported-error-code',
    provenance: 'negative-fixture',
    description: '读侧枚举之外的错误值 #FOO! ⇒ ValidationError（能力边界反面：7 经典 + 9 现代之外的代码仍被拒）',
    bytes,
    expected_import: { throws: 'validation' },
  };
}

// ---------------------------------------------------------------------------
// 出口
// ---------------------------------------------------------------------------

/**
 * 构造内置语料（纯函数，每次返回**同一批字节**——`writeZip` 无时间 / 无随机）。
 *
 * 顺序即报告顺序；`negative-truncated` 派生自 `excel-multisheet-rich` 的字节。
 */
export function buildCorpus(): readonly CorpusEntry[] {
  const rich = excelMultisheetRich();
  return Object.freeze([
    rich,
    wpsDefaultContentTypes(),
    excelDefinedNamesSharedRange(),
    excelDrawingSheetRels(),
    negativeNotZip(),
    negativeTruncated(rich.bytes),
    negativeMissingWorkbook(),
    negativeUnsupportedErrorCode(),
  ]);
}

/** 供测试/工具引用的外部占位 URL（校验它未被改写）。 */
export const EXPECTED_EXTERNAL_TARGET = EXTERNAL_LINK_TARGET;

/** 外部产出方内容类型常量（测试断言用）。 */
export const EXTERNAL_CONTENT_TYPES = CONTENT_TYPES;
/** 外部产出方关系类型常量（测试断言用）。 */
export const EXTERNAL_REL_TYPES = REL_TYPES;
