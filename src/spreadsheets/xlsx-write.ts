/**
 * 表格域：`WorkbookState` → **真实 .xlsx 字节**（design-06-P8 / XLS-01、XLS-05、XLS-06、XLS-10、XLS-11、XLS-12）。
 *
 * ## 复用而不是重写（任务书硬要求）
 *
 * - **容器与 XML 原语**：`src/artifacts/ooxml/**` 的 `assembleOpcPackage` / `writeZip` / `el` / `attr`
 *   / `serializeXmlDocument` / `formatDecimal`。本文件**不自己拼 XML 字符串、不自己写 ZIP**。
 * - **部件骨架**：`src/artifacts/templates/xlsx.ts` 已把内容类型、命名空间、关系类型、工作簿部件路径
 *   定义成导出常量，本文件**直接 import**，不重复声明一个字面量（`xlsx.ts` 本轮**零改动**，
 *   其 golden sha256 判据不受影响）。
 * - **求值**：公式的 `<v>` 缓存来自 `evaluate.ts`（受限子集），不引第三方引擎。
 *
 * ## XLS-10 / XLS-11 接线（本文件新增的唯一一件事：把已交付的片段**写进容器**）
 *
 * 数据验证（`validation.ts`）、条件格式（`conditional-format.ts`）与结构化表格
 * （`structured-table.ts`）此前只**产出片段**。本文件通过可选的 {@link XlsxWriteExtras}
 * 把片段落进真实的 .xlsx：
 * - `<dataValidations>` / `<conditionalFormatting>` / x14 `extLst` 注入工作表 XML
 *   （`buildDataValidationsXml` / `buildCfRuleElement` / `buildX14ConditionalFormattingXml`）；
 * - `xl/tables/tableN.xml` 部件 + 工作表级 `_rels` + `[Content_Types].xml` Override +
 *   工作表 `<tableParts>`（`buildTableDefinitionXml`）；
 * - `xl/styles.xml` 注入 `<dxfs>`（`buildDxfsXml`），与既有 `dxfs` **合并**而非覆盖。
 *
 * **反向对照是刻意的**：不给这些输入 ⇒ 上述部件 / 关系 / Content_Types 条目 / `tableParts`
 * **一个都不出现**（见 `xlsx-wire.test.ts`），从而"写了"与"没写"在字节层可区分。
 *
 * ## 与 `buildXlsxTemplate`（模板层）的关系
 *
 * 模板层产出**一张固定的分项 / 合计表**（合同 §6 的最小验收形态，本轮不动）。
 * 本文件产出的是**任意工作簿模型**：多工作表、六类取值、公式、日期、冻结、合并。
 * 二者共用同一套部件骨架与容器原语，但**互不调用**——一条单表、一条多表，各自可独立验收。
 *
 * ## 确定性的边界（与 W-A 相同，且不新增变量）
 *
 * 无 IO、无时钟（`new Date(` / `Date.now(` 是内核纪律禁词）、无随机、无 locale。
 * 因此"同一 `WorkbookState` ⇒ 同一字节"是可断言的。
 *
 * ## 单元格输出口径（逐类）
 *
 * | 模型取值 | `t` | 载荷 | 说明 |
 * |---|---|---|---|
 * | `text` | `inlineStr` | `<is><t>…</t></is>` | 不引 `sharedStrings`，无索引越界面 |
 * | `number` | 无 | `<v>…</v>` | 数值格**不带 `t`** |
 * | `boolean` | `b` | `<v>1\|0</v>` | |
 * | `error` | `e` | `<v>#DIV/0!</v>` | |
 * | `date` | 无 | `<v>序列号</v>` + `s="日期样式"` | **Excel 原生写法**：日期是带日期数字格式的数值，不是 `t="d"` |
 * | `formula` | 视缓存 | **`<f>原文</f>`** + `<v>缓存</v>` | **求值成功才写缓存；阻塞则只写 `<f>`**（XLS-08） |
 * | `blank` | — | **整体不写** | Excel 的空格表示；R248 下**绝不写 `<v>0</v>`** |
 */

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  buildRelsPartPath,
  el,
  formatDecimal,
  resolveRelationshipTarget,
  serializeXmlDocument,
  writeZip,
  relationshipIdAt,
  utf8Bytes,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type XmlElement,
  type XmlNode,
} from '../artifacts/ooxml/index.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
  xlsxContentDigest,
} from '../artifacts/templates/xlsx.js';
import { parseXmlBytes, type ParsedXmlElement } from '../documents/docx/xml-parse.js';
import { ValidationError } from '../protocol/index.js';
import { buildDataValidationsXml, type DataValidationRule } from './validation.js';
import {
  buildCfRuleElement,
  buildDxfsXml,
  buildX14ConditionalFormattingXml,
  normalizeColor,
  normalizePriorities,
  requiresX14,
  X14_CF_EXT_URI,
  X14_NAMESPACE,
  type CfRule,
  type DifferentialFormat,
} from './conditional-format.js';
import { buildTableDefinitionXml, type StructuredTable } from './structured-table.js';
import { columnNumberToLetters, MAX_COLUMN_NUMBER, MAX_ROW_NUMBER } from './reference.js';
import { sheetEntries, type SheetState } from './sheet.js';
import type { WorkbookState } from './workbook.js';
import { toExcelSerial } from './excel-date.js';
import {
  evaluateWorkbookFormulas,
  type EvalOutcome,
  type FormulaEvalBlockReason,
  type ScalarValue,
} from './evaluate.js';
import { type CellValue } from './value.js';
import { buildSheetProtectionElement, type SheetProtection } from './protection/index.js';
import { buildStyleTable, renderStyleTableXml, type StyleTable } from './style-parts/cellxfs.js';
import { styleKey } from './style-parts/descriptor.js';
import type { CellStyle, CellStyles } from './styles.js';

// ---------------------------------------------------------------------------
// 常量（全部复用模板层已导出的那一份，这里只补模板层没有的两条）
// ---------------------------------------------------------------------------

/** 样式部件的内容类型（模板层不产出样式，故模板层没有这条常量）。 */
export const XLSX_STYLES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';

/** 样式部件路径。 */
export const XLSX_STYLES_PART_PATH = 'xl/styles.xml';

/** 部件级关系：workbook → styles。 */
export const STYLES_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

/** 日期样式在 `cellXfs` 里的下标（0 是默认样式，1 是日期样式）。 */
export const DATE_STYLE_INDEX = 1;

/** 日期样式引用的**内建** `numFmtId`（`m/d/yyyy`；ECMA-376 自带，无需在 `<numFmts>` 里重声明）。 */
export const DATE_STYLE_NUMFMT_ID = 14;

/** 结构化表格部件（`xl/tables/tableN.xml`）的内容类型。 */
export const XLSX_TABLE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';

/** 部件级关系：worksheet → table。 */
export const TABLE_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table';

/** 结构化表格部件路径：第 `id`（1 起，工作簿内全局唯一）张表 → `xl/tables/table{id}.xml`。 */
export function tablePartPath(id: number): string {
  return `xl/tables/table${String(id)}.xml`;
}

/** 工作表部件路径：第 `index`（0 起）张 → `xl/worksheets/sheet{n}.xml`。 */
export function worksheetPartPath(index: number): string {
  return `xl/worksheets/sheet${String(index + 1)}.xml`;
}

/** 工作表关系目标（相对 `xl/`）。 */
function worksheetRelationshipTarget(index: number): string {
  return `worksheets/sheet${String(index + 1)}.xml`;
}

// ---------------------------------------------------------------------------
// 保留部件（R249：既有文件的未知部件原样保留）
// ---------------------------------------------------------------------------

/** 一个**本模块不建模**的部件：路径 + 内容类型 + **原样字节**。 */
export interface PreservedPart {
  readonly path: string;
  readonly content_type: string;
  readonly data: Uint8Array;
}

/** 一组**本模块不重建**的关系声明（按持有者分组）。 */
export interface PreservedRelationshipGroup {
  readonly owner_part_path: string | null;
  readonly declarations: readonly RelationshipDeclaration[];
}

/**
 * 读回时未能建模、写回时必须原样带回的东西（R249）。
 *
 * 语义边界（**如实登记，不夸大**）：
 * - `parts` 的**字节原样保留**；其内容类型以 `Override` 形式写回（原始若走 `Default` 扩展名，
 *   这里会**归一化**为 `Override`——语义不变，字节可能不同）。
 * - `relationships` 里**目标解析不到任何部件**的声明会被丢弃（否则组装期会抛
 *   `relationship_target_missing`）；丢弃是显式的，且见 {@link XlsxWriteResult.dropped_relationships}。
 * - 被保留部件**内部**对关系 id 的引用（如旧工作表 XML 里的 `r:id`）不会恢复——
 *   因为工作表的 XML 是由模型**重新生成**的。这是本仓 R249 支持范围的真实边界。
 */
export interface XlsxResidual {
  readonly parts: readonly PreservedPart[];
  readonly content_type_defaults: readonly ContentTypeDefault[];
  readonly relationships: readonly PreservedRelationshipGroup[];
}

/** 空残留：从零构建一份工作簿时用。 */
export const EMPTY_RESIDUAL: XlsxResidual = Object.freeze({
  parts: Object.freeze([]) as readonly PreservedPart[],
  content_type_defaults: Object.freeze([]) as readonly ContentTypeDefault[],
  relationships: Object.freeze([]) as readonly PreservedRelationshipGroup[],
});

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

/** 一个公式格的求值登记（**可审计**：哪些公式算了、哪些被阻塞、为什么）。 */
export interface FormulaEvaluationRecord {
  readonly sheet: string;
  readonly ref: string;
  readonly formula: string;
  readonly ok: boolean;
  readonly reason?: FormulaEvalBlockReason;
  readonly detail?: string;
}

/** 写出结果。 */
export interface XlsxWriteResult {
  /** 真实容器字节（可写盘的 .xlsx）。 */
  readonly bytes: Buffer;
  /** ZIP 部件数。 */
  readonly entry_count: number;
  /** 裸小写十六进制 sha256（真实容器字节）。 */
  readonly content_digest: string;
  /** 逐格公式求值登记。 */
  readonly evaluations: readonly FormulaEvaluationRecord[];
  /**
   * 被原样带回包内的**保留部件**路径（R249 可审计性）。
   *
   * 这是一条"没有被静默丢掉"的**正向证据**：调用方可以逐条核对读回时登记的未知部件
   * 是否都出现在这里（`xlsx-read.ts` 的残留 → 本字段 → ZIP 条目，三段可对照）。
   */
  readonly preserved_part_paths: readonly string[];
  /** 因目标缺失而被丢弃的保留关系（R249 的边界，显式登记）。 */
  readonly dropped_relationships: readonly string[];
  /**
   * 被写进包内的结构化表格部件路径（按分配顺序）。
   *
   * 这是一条"表真的落了盘"的**正向证据**：调用方可逐条核对部件、`[Content_Types].xml` 的
   * Override、工作表级 `_rels` 的目标与工作表 `<tableParts>` 的 `r:id` 是否四段自洽
   * （见 `xlsx-wire.test.ts` 的"无悬空关系"用例）。
   */
  readonly table_part_paths: readonly string[];
  /**
   * 透视刷新写回的审计摘要（仅 {@link writePivotRefreshedXlsx} 会填）。
   *
   * 这是一条"透视刷新结果真的落了字节"的**正向证据**：调用方可核对落点区域与写入格数，
   * 并用仓内读取器重新打开同一批字节核对单元格值。
   */
  readonly pivot_refresh?: PivotRefreshDigest;
}

// ---------------------------------------------------------------------------
// 附加内容（XLS-10 / XLS-11）：默认**全空** —— 不给就一个字节都不多写
// ---------------------------------------------------------------------------

/** 一张工作表的附加内容（都缺省 = 该表不注入任何东西）。 */
export interface SheetExtras {
  /** 数据验证规则（写入工作表的 `<dataValidations>`）。 */
  readonly data_validations?: readonly DataValidationRule[];
  /** 条件格式规则（走标准块或 x14 扩展块，见 `conditional-format.ts`）。 */
  readonly conditional_formats?: readonly CfRule[];
  /** 结构化表格（写入 `xl/tables/tableN.xml` 并在工作表挂 `<tableParts>`）。 */
  readonly tables?: readonly StructuredTable[];
  /**
   * 该表的**逐格样式**（`styles.ts` 的 `CellStyles`：A1 地址 → `CellStyle`）。
   *
   * 给出后本写入器会走**真实样式表**：把全部工作表的样式收敛成一份 X03 的
   * `StyleTable`（`buildStyleTable`），用 `renderStyleTableXml` 渲染 `cellXfs`，并给每个
   * 有样式的单元格写 `s="{下标}"`。**任一张表给了样式**即触发；一张都不给 ⇒ 维持旧的
   * 最小两项目 `cellXfs`（字节与接线前逐字节相同，反向对照）。
   *
   * 日期单元格即使没有显式样式，也会自动指向日期 `numFmt`（`m/d/yyyy`）——与旧行为的语义一致。
   */
  readonly styles?: CellStyles;
  /**
   * 工作表保护模型（`protection/sheet-protection.ts` 的 `SheetProtection`）。
   *
   * 给出后经 `buildSheetProtectionElement` 转成 `<sheetProtection>` 元素，注入到
   * CT_Worksheet 的 **`sheetProtection` 位置**（`sheetData` 之后、`mergeCells` 之前）。
   * 必须 `sheet: true`，否则显式失败（不静默丢弃）。
   */
  readonly sheet_protection?: SheetProtection;
}

/** 整份工作簿的附加内容，**按工作表名**给出。 */
export interface XlsxWriteExtras {
  /**
   * 工作表名 → 该表的附加内容。
   *
   * 未知的表名**显式失败**（`ValidationError`）而不是被静默丢弃——"结果不得编造"在参数层的落点。
   */
  readonly sheets?: Readonly<Record<string, SheetExtras>>;
}

/** 空附加内容：不注入任何验证 / 条件格式 / 表格。 */
export const EMPTY_EXTRAS: XlsxWriteExtras = Object.freeze({});

// ---------------------------------------------------------------------------
// 数字 → `<v>` 文本
// ---------------------------------------------------------------------------

/**
 * 数值 → 写入 `<v>` 的**精确文本**。
 *
 * `Number::toString(10)` 给出最短可往返十进制且**与 locale 无关**，因此它天然是确定性的。
 * 唯一的坑是指数记法（`String(1e21) === '1e+21'`）——`<v>` 里不合法，必须展开成定式；
 * 展开复用 W-A 的 `formatDecimal`（BigInt 进位，不经浮点乘除），再把尾随零去掉。
 */
function numberToXmlText(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) {
    return text;
  }
  const expanded = formatDecimal(value, 20);
  const dot = expanded.indexOf('.');
  if (dot === -1) {
    return expanded;
  }
  const trimmed = expanded.slice(0, dot) + expanded.slice(dot).replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

// ---------------------------------------------------------------------------
// `xl/styles.xml`
// ---------------------------------------------------------------------------

/**
 * 生成 `xl/styles.xml`：**最小合法**样式表 + 一条日期样式。
 *
 * `cellXfs` 只有两项：下标 0 = 默认（`numFmtId=0`，所有不带 `s` 的单元格都用它），
 * 下标 1 = 日期样式（`numFmtId=14`，即内建 `m/d/yyyy`）。日期单元格写 `s="1"`。
 *
 * `fills` 的两项（`none` + `gray125`）是 Excel 的传统要求：第 0 项必须是 `none`、
 * 第 1 项必须是 `gray125`，否则真实 Excel 会报"文件已损坏"。这是**被广泛实测**的约束，
 * 因此照做而不是"最小化掉"。
 *
 * ## `dxfs` 是**合并**进来的，不是覆盖（XLS-11）
 *
 * `dxfs` 承载条件格式的差异格式，`conditional-format.ts` 用 `buildDxfsXml` 产出。它必须排在
 * `cellXfs` 之后（CT_Stylesheet 的序列要求）。这里采取**追加 / 合并**语义：若基底已有一份
 * `dxfs`，则把新 `dxf` 子元素并进它并更新 `count`，而不是拿新块把旧块换掉——
 * 这样"写入条件格式"永远不会把别人已有的差异格式抹掉。
 *
 * @param dxfs 由 `buildDxfsXml` 产出的 `<dxfs>` 元素（`null` / 缺省 = 不注入，字节与旧版一致）
 * @param styleTable X03 的样式表（`buildStyleTable`）；缺省 / `null` ⇒ 用最小两项目表（旧字节基线）。
 *   给出后经 `renderStyleTableXml` 渲染真实的 `numFmts/fonts/fills/borders/cellXfs`（XLS-05 接线）。
 */
export function buildStylesXml(dxfs: XmlElement | null = null, styleTable: StyleTable | null = null): string {
  const styleSheet = styleTable === null ? minimalStyleSheetElement() : styleSheetFromTable(styleTable);
  const withDxfs = dxfs === null ? styleSheet : mergeDxfs(styleSheet, dxfs);
  return serializeXmlDocument(withDxfs);
}

/** **最小合法**样式表的元素树（`cellXfs` 恰好两项：默认 + 日期）——无样式输入时的字节基线。 */
function minimalStyleSheetElement(): XmlElement {
  return el('styleSheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], [
    el('fonts', [attr('count', '1')], [
      el('font', [], [el('sz', [attr('val', '11')]), el('name', [attr('val', 'Calibri')])]),
    ]),
    el('fills', [attr('count', '2')], [
      el('fill', [], [el('patternFill', [attr('patternType', 'none')])]),
      el('fill', [], [el('patternFill', [attr('patternType', 'gray125')])]),
    ]),
    el('borders', [attr('count', '1')], [
      el('border', [], [el('left', []), el('right', []), el('top', []), el('bottom', []), el('diagonal', [])]),
    ]),
    el('cellStyleXfs', [attr('count', '1')], [
      el('xf', [attr('numFmtId', '0'), attr('fontId', '0'), attr('fillId', '0'), attr('borderId', '0')]),
    ]),
    el('cellXfs', [attr('count', '2')], [
      el('xf', [
        attr('numFmtId', '0'),
        attr('fontId', '0'),
        attr('fillId', '0'),
        attr('borderId', '0'),
        attr('xfId', '0'),
      ]),
      el('xf', [
        attr('numFmtId', String(DATE_STYLE_NUMFMT_ID)),
        attr('fontId', '0'),
        attr('fillId', '0'),
        attr('borderId', '0'),
        attr('xfId', '0'),
        attr('applyNumberFormat', '1'),
      ]),
    ]),
  ]);
}

/**
 * 由 X03 的样式表渲染 `styleSheet` 元素树。
 *
 * 直接消费 `renderStyleTableXml` 产出的五段片段（`numFmts/fonts/fills/borders/cellXfs`），
 * 按 CT_Stylesheet 的顺序补上必需的 `cellStyleXfs`（让 `xfId="0"` 可解析），再用
 * {@link elementFromFragment} 解析回元素树——这样 `dxfs` 合并逻辑对两条路径一视同仁，
 * 本文件**不手拼**任何 XML 字符串给序列化器以外的地方。
 */
function styleSheetFromTable(table: StyleTable): XmlElement {
  const parts = renderStyleTableXml(table);
  const xml =
    `<styleSheet xmlns="${SPREADSHEETML_NAMESPACE}">` +
    parts.numFmts +
    parts.fonts +
    parts.fills +
    parts.borders +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    parts.cellXfs +
    '</styleSheet>';
  const parsed = elementFromFragment(xml);
  // 复刻既有最小表：根元素显式声明 SpreadsheetML 主命名空间（片段转换时会剥掉同值声明）。
  return el('styleSheet', [attr('xmlns', SPREADSHEETML_NAMESPACE)], parsed.children);
}

/**
 * 把 `dxfs` 并进 `styleSheet`（CT_Stylesheet 里 `dxfs` 紧跟 `cellXfs` / `cellStyles` 之后）。
 *
 * 基底已有 `<dxfs>` ⇒ **追加子元素并更新 `count`**；没有 ⇒ 在 `cellXfs` 之后插入。
 * 无论哪条路径，都**不覆盖**既有差异格式。
 */
function mergeDxfs(styleSheet: XmlElement, dxfs: XmlElement): XmlElement {
  const children: XmlNode[] = [];
  let inserted = false;
  let existingIndex = -1;
  styleSheet.children.forEach((child, index) => {
    if (typeof child !== 'string' && child.name === 'dxfs') existingIndex = index;
  });
  if (existingIndex === -1) {
    for (const child of styleSheet.children) {
      children.push(child);
      if (typeof child !== 'string' && child.name === 'cellXfs') {
        children.push(dxfs);
        inserted = true;
      }
    }
    if (!inserted) children.push(dxfs); // cellXfs 缺失（本仓不会发生）：仍要写进去，不静默丢
    return el(styleSheet.name, styleSheet.attributes, children);
  }
  const merged = styleSheet.children.map((child, index) => {
    if (index !== existingIndex || typeof child === 'string') return child;
    const mergedChildren: XmlNode[] = [...child.children, ...dxfs.children];
    return el('dxfs', [attr('count', String(mergedChildren.length))], mergedChildren);
  });
  return el(styleSheet.name, styleSheet.attributes, merged);
}

// ---------------------------------------------------------------------------
// `xl/workbook.xml`
// ---------------------------------------------------------------------------

/**
 * 生成 `xl/workbook.xml`：有序工作表清单 + 活跃表 + 隐藏标记 + `fullCalcOnLoad`。
 *
 * `r:id` 由**表顺序**决定（第 i 张 = `relationshipIdAt(i)`），与部件级关系的声明顺序一字不差；
 * 样式关系排在全部工作表关系**之后**，因此它的 id 是 `relationshipIdAt(sheets.length)`。
 *
 * `<calcPr fullCalcOnLoad="1"/>` 是对消费端的**诚实信号**：本仓只对白名单子集写缓存，
 * 其余公式**故意留空**（XLS-08 的"保留 + 阻塞"）；让 Excel 打开时整体重算，
 * 阻塞的公式在真实软件里仍有结果，而且在软件里**可编辑、可追溯**。
 */
export function buildWorkbookXml(workbook: WorkbookState): string {
  const sheets = workbook.sheets.map((sheet, index) => {
    const attributes = [
      attr('name', sheet.name),
      attr('sheetId', String(index + 1)),
      attr('r:id', relationshipIdAt(index)),
    ];
    if (sheet.hidden) {
      attributes.push(attr('state', 'hidden'));
    }
    return el('sheet', attributes);
  });
  const workbookElement = el(
    'workbook',
    [attr('xmlns', SPREADSHEETML_NAMESPACE), attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE)],
    [
      el('bookViews', [], [
        el('workbookView', [attr('activeTab', String(workbook.active_sheet))]),
      ]),
      el('sheets', [], sheets),
      el('calcPr', [attr('fullCalcOnLoad', '1')]),
    ],
  );
  return serializeXmlDocument(workbookElement);
}

// ---------------------------------------------------------------------------
// `xl/worksheets/sheetN.xml`
// ---------------------------------------------------------------------------

/** 文本 `<t>`：首尾空白必须显式声明保留，否则读取方会折叠它。 */
function textElement(text: string): XmlElement {
  const needsPreserve = text !== text.trim();
  const attributes = needsPreserve ? [attr('xml:space', 'preserve')] : [];
  return el('t', attributes, [text]);
}

function cellElement(
  cell: { readonly ref: string; readonly value: CellValue },
  outcome: EvalOutcome | undefined,
  styleIndex: number | null,
): XmlElement | null {
  const value = cell.value;
  // `s` 属性只在"该格有样式下标"时出现：无样式（默认 xf 0）时省略，与接线前逐字节一致。
  const styleAttributes = styleIndex === null ? [] : [attr('s', String(styleIndex))];
  switch (value.kind) {
    case 'blank':
      return null; // 空白格**整体不写**：这是 Excel 的空格表示，也是 R248 的执行点
    case 'text':
      return el('c', [attr('r', cell.ref), ...styleAttributes, attr('t', 'inlineStr')], [
        el('is', [], [textElement(value.value)]),
      ]);
    case 'number':
      return el('c', [attr('r', cell.ref), ...styleAttributes], [el('v', [], [numberToXmlText(value.value)])]);
    case 'boolean':
      return el('c', [attr('r', cell.ref), ...styleAttributes, attr('t', 'b')], [el('v', [], [value.value ? '1' : '0'])]);
    case 'error':
      return el('c', [attr('r', cell.ref), ...styleAttributes, attr('t', 'e')], [el('v', [], [value.code])]);
    case 'date': {
      // 日期是 Excel 原生写法：数值 + 日期样式。无样式表时固定用内建日期槽位（下标 1）。
      const index = styleIndex ?? DATE_STYLE_INDEX;
      return el('c', [attr('r', cell.ref), attr('s', String(index))], [
        el('v', [], [numberToXmlText(toExcelSerial(value.epoch_ms))]),
      ]);
    }
    case 'formula':
      return formulaCellElement(cell.ref, value.text, outcome, styleIndex);
    default: {
      const never: never = value;
      throw new Error(`未覆盖的取值：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 公式格：**`<f>` 是主体，`<v>` 只是缓存**（XLS-08）。
 *
 * - 求值成功 ⇒ 写 `<f>原文</f><v>缓存</v>`，缓存的 `t` 随结果类型（数 / `str` / `b` / `e`）；
 * - 求值阻塞 ⇒ **只写 `<f>原文</f>`**，不写 `<v>`。这是"不得返回伪造结果"在字节层的形状：
 *   宁可让消费端重算，也不把一个猜出来的数写进去。
 */
function formulaCellElement(
  ref: string,
  text: string,
  outcome: EvalOutcome | undefined,
  styleIndex: number | null,
): XmlElement {
  const formula = el('f', [], [text]);
  const styleAttributes = styleIndex === null ? [] : [attr('s', String(styleIndex))];
  if (outcome === undefined || !outcome.ok) {
    return el('c', [attr('r', ref), ...styleAttributes], [formula]);
  }
  const cached = cachedValueElement(outcome.value);
  return cached === null
    ? el('c', [attr('r', ref), ...styleAttributes], [formula])
    : cached.t === null
      ? el('c', [attr('r', ref), ...styleAttributes], [formula, cached.v])
      : el('c', [attr('r', ref), ...styleAttributes, attr('t', cached.t)], [formula, cached.v]);
}

interface CachedElement {
  readonly t: string | null;
  readonly v: XmlElement;
}

function cachedValueElement(value: ScalarValue): CachedElement | null {
  switch (value.kind) {
    case 'number':
      return { t: null, v: el('v', [], [numberToXmlText(value.value)]) };
    case 'text':
      // 公式的文本结果是 `t="str"`（**不是** `inlineStr`：后者只用于字面量文本格）。
      return { t: 'str', v: el('v', [], [value.value]) };
    case 'boolean':
      return { t: 'b', v: el('v', [], [value.value ? '1' : '0']) };
    case 'error':
      return { t: 'e', v: el('v', [], [value.code]) };
    /* c8 ignore next 2 -- ScalarValue 只有上面四类 */
    default:
      return null;
  }
}

/** 冻结窗格：0 行 0 列即不冻结。 */
function paneElement(sheet: SheetState): XmlElement | null {
  const rows = sheet.frozen_rows;
  const columns = sheet.frozen_columns;
  if (rows === 0 && columns === 0) {
    return null;
  }
  const activePane = rows > 0 && columns > 0 ? 'bottomRight' : rows > 0 ? 'bottomLeft' : 'topRight';
  const attributes = [];
  if (columns > 0) attributes.push(attr('xSplit', String(columns)));
  if (rows > 0) attributes.push(attr('ySplit', String(rows)));
  attributes.push(
    attr('topLeftCell', `${columnNumberToLetters(Math.min(columns + 1, MAX_COLUMN_NUMBER))}${String(rows + 1)}`),
    attr('activePane', activePane),
    attr('state', 'frozen'),
  );
  return el('pane', attributes);
}

function dimensionElement(sheet: SheetState): XmlElement | null {
  if (sheet.column_count > MAX_COLUMN_NUMBER || sheet.row_count > MAX_ROW_NUMBER) {
    return null; // 越界就整体省略：写一个越界的 dimension 会让真实 Excel 判文件损坏
  }
  const last = `${columnNumberToLetters(Math.max(sheet.column_count, 1))}${String(Math.max(sheet.row_count, 1))}`;
  return el('dimension', [attr('ref', `A1:${last}`)]);
}

function sheetViewsElement(sheet: SheetState, selected: boolean): XmlElement {
  const attributes = [attr('workbookViewId', '0')];
  if (selected) {
    attributes.unshift(attr('tabSelected', '1'));
  }
  const pane = paneElement(sheet);
  return el('sheetViews', [], [
    el('sheetView', attributes, pane === null ? [] : [pane]),
  ]);
}

/**
 * 单元格 → 样式下标的解析器。
 *
 * `ref` 是规范化 A1 地址，`value` 是该格的取值；返回 `null` 表示"不写 `s`"（落到默认 xf 0）。
 */
export type CellStyleIndexResolver = (ref: string, value: CellValue) => number | null;

/** 无样式表时的解析器：日期格用内建日期槽位，其余不写 `s`（与接线前逐字节一致）。 */
function legacyStyleIndexOf(_ref: string, value: CellValue): number | null {
  return value.kind === 'date' ? DATE_STYLE_INDEX : null;
}

/** 单元格按行分组（`sheetEntries` 已按行、列排好序）。 */
function sheetDataElement(
  sheet: SheetState,
  evaluations: ReadonlyMap<string, EvalOutcome>,
  styleIndexOf: CellStyleIndexResolver,
): XmlElement {
  const rows: XmlElement[] = [];
  let currentRow = -1;
  let currentCells: XmlElement[] = [];
  const flush = (): void => {
    if (currentRow >= 0) {
      rows.push(el('row', [attr('r', String(currentRow))], currentCells));
    }
  };
  for (const entry of sheetEntries(sheet)) {
    const row = Number.parseInt(entry.ref.replace(/^[A-Z]+/, ''), 10);
    if (row !== currentRow) {
      flush();
      currentRow = row;
      currentCells = [];
    }
    const outcome = evaluations.get(`${sheet.name}!${entry.ref}`);
    const cell = cellElement(entry, outcome, styleIndexOf(entry.ref, entry.value));
    if (cell !== null) {
      currentCells.push(cell);
    }
  }
  flush();
  return el('sheetData', [], rows);
}

function mergeCellsElement(sheet: SheetState): XmlElement | null {
  if (sheet.merged.length === 0) {
    return null;
  }
  return el('mergeCells', [attr('count', String(sheet.merged.length))], [
    ...sheet.merged.map((ref) => el('mergeCell', [attr('ref', ref)])),
  ]);
}

// ---------------------------------------------------------------------------
// XLS-10 / XLS-11：把已交付的片段注入工作表（都是可选；缺省 ⇒ 工作表字节与旧版一致）
// ---------------------------------------------------------------------------

/**
 * 一张工作表要注入的元素（按 CT_Worksheet 的序列要求排列）。
 *
 * 全部可选：缺省 = 该位置不出现任何东西。**反向对照**就建立在这条上——
 * 不注入 ⇒ `buildSheetXml` 的字节与 XLS-10/11 接线之前逐字节相同。
 */
export interface SheetInjection {
  /** `<dataValidations count=N>…</dataValidations>`（来自 `buildDataValidationsXml`）。 */
  readonly data_validations?: XmlElement | null;
  /** 一个或多个并列的 `<conditionalFormatting sqref="…">`（标准块）。 */
  readonly conditional_formatting?: readonly XmlElement[];
  /** `<extLst>` 包着的 x14 条件格式扩展块；无扩展规则时为 `null`。 */
  readonly x14?: XmlElement | null;
  /** 工作表 `<tableParts count=N>`；无表时为 `null`。 */
  readonly table_parts?: XmlElement | null;
  /** `<sheetProtection …/>`；无保护时为 `null`（XLS-15 接线，位置在 `sheetData` 之后）。 */
  readonly sheet_protection?: XmlElement | null;
}

/**
 * 把一段**自含命名空间的 XML 片段**转成写侧的 {@link XmlElement} 树。
 *
 * 为什么需要它：`validation.ts` / `conditional-format.ts` / `structured-table.ts` 的出口是
 * **字符串片段**（它们各自带了 `xmlns`，可独立解析）。要把片段嵌进元素树，唯一不"手拼 XML 字符串"
 * 的办法就是**解析回元素树**——读侧 `parseXmlBytes` 正是为此存在（本文件不新增任何解析逻辑）。
 *
 * 递归时只去掉**会被基座重新声明的重复声明**：与 SpreadsheetML 主命名空间同值的默认 `xmlns`，
 * 以及与 {@link X14_NAMESPACE} 同值的 `xmlns:x14`（后者改由外层 `<ext>` 声明，与真实 Excel 的
 * 规范写法一致）。带前缀的 `xmlns:xm` 会被保留——它是片段语义的一部分，不能丢。
 */
function elementFromFragment(xml: string): XmlElement {
  return toWriterElement(parseXmlBytes(utf8Bytes(xml)));
}

const REDUNDANT_NAMESPACE_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ['xmlns', SPREADSHEETML_NAMESPACE],
  ['xmlns:x14', X14_NAMESPACE],
]);

function toWriterElement(node: ParsedXmlElement): XmlElement {
  return el(
    node.name,
    node.attributes
      .filter((attribute) => REDUNDANT_NAMESPACE_ATTRIBUTES.get(attribute.name) !== attribute.value)
      .map((attribute) => attr(attribute.name, attribute.value)),
    node.children.map((child) => (child.kind === 'text' ? child.value : toWriterElement(child))),
  );
}

/**
 * 生成一张工作表的 XML（`spec` 顺序 = CT_Worksheet 的序列要求）。
 *
 * `selected` 为真时该表带 `tabSelected="1"`（与工作簿的 `activeTab` 对齐）。
 * `injection` 缺省 = 不注入数据验证 / 条件格式 / 表格（字节与接线前一致）。
 *
 * CT_Worksheet 的序列：`…sheetData → sheetProtection → mergeCells → conditionalFormatting* →
 * dataValidations → … → tableParts → extLst`。
 */
export function buildSheetXml(
  sheet: SheetState,
  evaluations: ReadonlyMap<string, EvalOutcome>,
  selected: boolean,
  injection: SheetInjection = {},
  styleIndexOf: CellStyleIndexResolver = legacyStyleIndexOf,
): string {
  const children: XmlElement[] = [];
  const dimension = dimensionElement(sheet);
  if (dimension !== null) children.push(dimension);
  children.push(sheetViewsElement(sheet, selected), sheetDataElement(sheet, evaluations, styleIndexOf));
  // XLS-15：`<sheetProtection>` 紧随 `sheetData`、在 `mergeCells` 之前（CT_Worksheet 序列）。
  if (injection.sheet_protection !== undefined && injection.sheet_protection !== null) {
    children.push(injection.sheet_protection);
  }
  const mergeCells = mergeCellsElement(sheet);
  if (mergeCells !== null) children.push(mergeCells);

  for (const block of injection.conditional_formatting ?? []) children.push(block);
  if (injection.data_validations !== undefined && injection.data_validations !== null) {
    children.push(injection.data_validations);
  }
  if (injection.table_parts !== undefined && injection.table_parts !== null) {
    children.push(injection.table_parts);
  }
  if (injection.x14 !== undefined && injection.x14 !== null) children.push(injection.x14);

  const rootAttributes = [attr('xmlns', SPREADSHEETML_NAMESPACE)];
  if (injection.table_parts !== undefined && injection.table_parts !== null) {
    // `<tablePart r:id="…">` 用到 `r` 前缀；没有表时不声明，避免无谓的命名空间声明
    rootAttributes.push(attr('xmlns:r', OFFICE_RELATIONSHIPS_NAMESPACE));
  }
  return serializeXmlDocument(el('worksheet', rootAttributes, children));
}

// ---------------------------------------------------------------------------
// 条件格式的差异格式（dxfs）：跨工作表**全局去重**后并进 styles
// ---------------------------------------------------------------------------

/**
 * 差异格式的去重键——与 `conditional-format.ts` 内部的 `formatKey` **同口径**
 * （同样的字段、同样的顺序、同样的 `normalizeColor` 归一化），因此"哪些规则共用一条 `dxf`"
 * 与模块自身编译的结果一致。
 *
 * 之所以在本文件重写这 4 行：`dxfId` 必须**跨工作表全局唯一**（`dxfs` 只有一份），
 * 而模块的 `compileConditionalFormats` 是**逐表**编译、id 逐表从 0 起；跨表汇编需要一张
 * 全局的"格式 → dxfId"表，模块没有导出这张表的构造入口。判据由测试兜底：
 * 本文件产出的 `<dxfs>` 与 `buildDxfsXml(同样格式)` **逐字节相同**。
 */
function cfFormatKey(format: DifferentialFormat): string {
  return [
    format.fill_color === undefined ? '' : normalizeColor(format.fill_color),
    format.font_color === undefined ? '' : normalizeColor(format.font_color),
    format.font_bold === true ? 'b' : '',
    format.border_color === undefined ? '' : normalizeColor(format.border_color),
  ].join('|');
}

/** 标准（非 x14）条件格式块：按范围分组，组内规则按 `<cfRule>` 顺序排列。 */
function conditionalFormattingElements(
  rules: readonly CfRule[],
  dxfIdByKey: ReadonlyMap<string, number>,
): readonly XmlElement[] {
  const order: string[] = [];
  const groups = new Map<string, XmlElement[]>();
  for (const rule of rules) {
    if (requiresX14(rule)) continue;
    let bucket = groups.get(rule.range);
    if (bucket === undefined) {
      bucket = [];
      groups.set(rule.range, bucket);
      order.push(rule.range);
    }
    const dxfId = rule.format === undefined ? undefined : dxfIdByKey.get(cfFormatKey(rule.format));
    bucket.push(buildCfRuleElement(rule, dxfId));
  }
  return Object.freeze(order.map((range) => el('conditionalFormatting', [attr('sqref', range)], groups.get(range) ?? [])));
}

/** 把 x14 条件格式片段包进 `<extLst><ext uri="…" xmlns:x14="…">…</ext></extLst>`。 */
function x14ExtListElement(extended: readonly CfRule[]): XmlElement | null {
  const xml = buildX14ConditionalFormattingXml(extended);
  if (xml === null) return null;
  return el('extLst', [], [
    el('ext', [attr('uri', X14_CF_EXT_URI), attr('xmlns:x14', X14_NAMESPACE)], [elementFromFragment(xml)]),
  ]);
}

/**
 * 单个工作表 → 注入元素（数据验证 / 条件格式 / x14 / 表格）。
 *
 * @param dxfIdByKey 跨表全局的"差异格式键 → dxfId"
 * @param tableParts 该表的 `<tableParts>`（由表格汇编给出；无表时 `null`）
 */
function compileSheetInjection(sheet: SheetState, extras: SheetExtras, dxfIdByKey: ReadonlyMap<string, number>, tableParts: XmlElement | null): SheetInjection {
  const validationXml = extras.data_validations === undefined ? null : buildDataValidationsXml(extras.data_validations);
  const rules = extras.conditional_formats === undefined ? [] : normalizePriorities(extras.conditional_formats);
  const x14 = x14ExtListElement(rules.filter(requiresX14));
  return {
    data_validations: validationXml === null ? null : elementFromFragment(validationXml),
    conditional_formatting: conditionalFormattingElements(rules, dxfIdByKey),
    x14,
    table_parts: tableParts,
    sheet_protection:
      extras.sheet_protection === undefined ? null : buildSheetProtectionElement(extras.sheet_protection),
  };
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

function makeKey(sheet: string, ref: string): string {
  return `${sheet}!${ref}`;
}

/** 求值登记 → 公式缓存表 + 审计记录。 */
function evaluateFormulas(workbook: WorkbookState): {
  readonly cache: ReadonlyMap<string, EvalOutcome>;
  readonly records: readonly FormulaEvaluationRecord[];
} {
  const cache = new Map<string, EvalOutcome>();
  const records: FormulaEvaluationRecord[] = [];
  for (const entry of evaluateWorkbookFormulas(workbook)) {
    const ref = `${columnNumberToLetters(entry.address.column)}${String(entry.address.row)}`;
    const outcome = entry.outcome;
    cache.set(makeKey(entry.sheet, ref), outcome);
    records.push(
      outcome.ok
        ? { sheet: entry.sheet, ref, formula: entry.text, ok: true }
        : { sheet: entry.sheet, ref, formula: entry.text, ok: false, reason: outcome.reason, detail: outcome.detail },
    );
  }
  return { cache, records: Object.freeze(records.map((record) => Object.freeze(record))) };
}

/** 合并保留部件与保留关系，并按组装期的硬约束过滤。 */
interface AssemblyInput {
  readonly parts: readonly OpcPart[];
  readonly defaults: readonly ContentTypeDefault[];
  readonly relationships: readonly RelationshipGroup[];
  /** 真正被带回包内的保留部件路径（审计用）。 */
  readonly preserved: readonly string[];
  readonly dropped: readonly string[];
}

function mergeResidual(
  generatedParts: readonly OpcPart[],
  generatedGroups: readonly RelationshipGroup[],
  residual: XlsxResidual,
): AssemblyInput {
  const generatedPaths = new Set(generatedParts.map((part) => part.path));
  const generatedRelsPaths = new Set(
    generatedGroups.map((group) => buildRelsPartPath(group.owner_part_path)),
  );
  generatedRelsPaths.add(buildRelsPartPath(null));

  const keptParts: PreservedPart[] = [];
  const addressable = new Set<string>(generatedPaths);
  for (const path of generatedRelsPaths) {
    addressable.add(path);
  }
  for (const part of residual.parts) {
    if (generatedPaths.has(part.path) || generatedRelsPaths.has(part.path)) {
      continue; // 与模型生成的部件冲突 ⇒ 以模型为准（旧字节不再有意义）
    }
    if (part.path === '[Content_Types].xml' || part.path === '_rels/.rels') {
      continue;
    }
    keptParts.push(part);
    addressable.add(part.path);
  }

  const defaults: ContentTypeDefault[] = [
    // OPC 要求必须有 `rels` 默认项；这是本模块唯一生成的默认项。
    { extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE },
  ];
  const seenExtensions = new Set(defaults.map((entry) => entry.extension));
  for (const entry of residual.content_type_defaults) {
    if (seenExtensions.has(entry.extension)) continue;
    if (!/^[A-Za-z0-9.+_-]+$/.test(entry.extension)) continue;
    defaults.push(entry);
    seenExtensions.add(entry.extension);
  }

  const groups = generatedGroups.map((group) => ({
    owner_part_path: group.owner_part_path,
    declarations: [...group.declarations],
  }));
  const dropped: string[] = [];
  const seenTargets = new Set(
    generatedGroups.flatMap((group) =>
      group.declarations.map((declaration) =>
        descriptorOf(group.owner_part_path, declaration),
      ),
    ),
  );

  for (const preserved of residual.relationships) {
    const owner = preserved.owner_part_path;
    if (owner !== null && !addressable.has(owner)) {
      // 持有者本身没被保留（或与生成的部件冲突）⇒ 这组关系无处安放。
      for (const declaration of preserved.declarations) {
        dropped.push(`${String(owner)} → ${declaration.target}（持有者部件不在本包内）`);
      }
      continue;
    }
    let group = groups.find((candidate) => candidate.owner_part_path === owner);
    if (group === undefined) {
      group = { owner_part_path: owner, declarations: [] };
      groups.push(group);
    }
    for (const declaration of preserved.declarations) {
      const descriptor = descriptorOf(owner, declaration);
      if (seenTargets.has(descriptor)) continue;
      if (declaration.target_mode === 'External') {
        group.declarations.push(declaration);
        seenTargets.add(descriptor);
        continue;
      }
      let target: string;
      try {
        target = resolveRelationshipTarget(owner, declaration.target);
      } catch {
        dropped.push(`${String(owner)} → ${declaration.target}（目标非法）`);
        continue;
      }
      if (!addressable.has(target)) {
        dropped.push(`${String(owner)} → ${declaration.target}（目标部件不在本包内）`);
        continue;
      }
      group.declarations.push(declaration);
      seenTargets.add(descriptor);
    }
  }

  return {
    parts: [
      ...generatedParts,
      ...keptParts.map((part) => ({
        path: part.path,
        content_type: part.content_type,
        data: part.data,
      })),
    ],
    preserved: Object.freeze(keptParts.map((part) => part.path)),
    defaults,
    relationships: groups.map((group) => ({
      owner_part_path: group.owner_part_path,
      declarations: Object.freeze([...group.declarations]),
    })),
    dropped,
  };
}

/** 一条关系声明的去重键（外部关系按 URL 区分，内部关系按解析后的部件路径区分）。 */
function descriptorOf(owner: string | null, declaration: RelationshipDeclaration): string {
  if (declaration.target_mode === 'External') {
    return `${String(owner)}→ext:${declaration.target}`;
  }
  /* c8 ignore next -- 声明经由生成路径保证合法；防御性回落到原始 target */
  return `${String(owner)}→${safeResolve(owner, declaration.target) ?? declaration.target}`;
}

function safeResolve(owner: string | null, target: string): string | null {
  try {
    return resolveRelationshipTarget(owner, target);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// XLS-05 接线：样式表从"逐格样式"收敛出来
// ---------------------------------------------------------------------------

/**
 * 日期单元格在没有显式样式时使用的默认日期描述符（`m/d/yyyy` = 内建 `numFmtId=14`）。
 *
 * 与接线前的最小表**语义相同**：日期格指向日期 `numFmt`，只是下标由样式表决定而非固定为 1。
 */
const DEFAULT_DATE_STYLE: CellStyle = Object.freeze({
  number_format: { kind: 'date', pattern: 'm/d/yyyy' } as const,
});

/** 一份写入用的样式计划：工作簿级样式表 + 逐表逐格的样式下标解析器。 */
interface StylePlan {
  /** `null` = 无样式输入，走最小两项目表。 */
  readonly table: StyleTable | null;
  resolverFor(sheetName: string): CellStyleIndexResolver;
}

/** 某格的**有效样式**：显式样式优先；日期格在缺样式/缺数字格式时补上默认日期格式。 */
function effectiveCellStyle(
  styles: CellStyles | undefined,
  ref: string,
  value: CellValue,
): CellStyle | undefined {
  const explicit = styles === undefined ? undefined : styles.get(ref);
  if (value.kind !== 'date') {
    return explicit;
  }
  if (explicit === undefined) {
    return DEFAULT_DATE_STYLE;
  }
  if (explicit.number_format !== undefined) {
    return explicit;
  }
  return { ...explicit, number_format: DEFAULT_DATE_STYLE.number_format };
}

/**
 * 决定本次写入用不用真实样式表，并算出逐格 `s` 下标。
 *
 * 触发条件：**任一张表给出了 `styles`**。样式表是工作簿级的（`styles.xml` 只有一份），
 * 所以跨表收集全部有效样式后统一 `buildStyleTable` 去重、编号（`renderStyleTableXml` 在
 * {@link buildStylesXml} 里消费它）。没有样式输入时返回 `table: null`，`s` 下标解析器退化为
 * 旧的"日期=1"，从而最小表路径的字节与接线前**逐字节相同**。
 *
 * @throws {ValidationError} 某样式含本仓无法表达的键（由 `canonicalizeStyle` 抛，不静默丢弃）
 */
function buildStylePlan(
  workbook: WorkbookState,
  extrasBySheet: ReadonlyMap<string, SheetExtras>,
): StylePlan {
  const usesStyles = workbook.sheets.some((sheet) => extrasBySheet.get(sheet.name)?.styles !== undefined);
  if (!usesStyles) {
    return { table: null, resolverFor: () => legacyStyleIndexOf };
  }

  const collected: CellStyle[] = [];
  for (const sheet of workbook.sheets) {
    const styles = extrasBySheet.get(sheet.name)?.styles;
    for (const entry of sheetEntries(sheet)) {
      const effective = effectiveCellStyle(styles, entry.ref, entry.value);
      if (effective !== undefined) collected.push(effective);
    }
  }
  const table = buildStyleTable(collected);

  const indexByCell = new Map<string, number>();
  for (const sheet of workbook.sheets) {
    const styles = extrasBySheet.get(sheet.name)?.styles;
    for (const entry of sheetEntries(sheet)) {
      const effective = effectiveCellStyle(styles, entry.ref, entry.value);
      if (effective === undefined) continue;
      const at = table.indexByKey.get(styleKey(effective));
      if (at === undefined) {
        /* c8 ignore next -- buildStyleTable 收录了 collected 里的每个键；防御性兜底 */
        throw new ValidationError(`样式未进入样式表（内部错误）：${sheet.name}!${entry.ref}`);
      }
      indexByCell.set(makeKey(sheet.name, entry.ref), at);
    }
  }

  return {
    table,
    resolverFor: (sheetName) => (ref, _value) => indexByCell.get(makeKey(sheetName, ref)) ?? null,
  };
}

/**
 * 把工作簿模型写成一份真实的 .xlsx。
 *
 * @param workbook 模型（不可变）
 * @param residual 读回时保留的未知部件 / 关系（R249）；缺省 = 从零构建
 * @param extras 附加内容（数据验证 / 条件格式 / 结构化表格 / 逐格样式 / 工作表保护）；缺省 = 一个字节都不多写
 * @throws {ValidationError} 模型非法，或 `extras` 指向未知工作表 / 规则非法
 *   （模型合法性由 `workbook.ts` / `sheet.ts` 保证，此处不重复校验）
 */
export function writeWorkbookXlsx(
  workbook: WorkbookState,
  residual: XlsxResidual = EMPTY_RESIDUAL,
  extras: XlsxWriteExtras = EMPTY_EXTRAS,
): XlsxWriteResult {
  const { cache, records } = evaluateFormulas(workbook);
  const activeName = workbook.sheets[workbook.active_sheet]?.name;

  const extrasBySheet = normalizeExtras(workbook, extras);

  // ⓪ XLS-05 接线：任一张表给了样式 ⇒ 收敛出一份真实样式表（含日期样式）；
  //    一张都不给 ⇒ table 为 null，走最小两项目表（字节与接线前逐字节相同）。
  const stylePlan = buildStylePlan(workbook, extrasBySheet);

  // ① 差异格式（dxfs）跨表全局去重：dxfs 只有一份，dxfId 必须全局唯一。
  const dxfFormats: DifferentialFormat[] = [];
  const dxfIdByKey = new Map<string, number>();
  for (const sheet of workbook.sheets) {
    const rules = extrasBySheet.get(sheet.name)?.conditional_formats;
    if (rules === undefined) continue;
    for (const rule of normalizePriorities(rules)) {
      if (rule.format === undefined || requiresX14(rule)) continue;
      const key = cfFormatKey(rule.format);
      if (dxfIdByKey.has(key)) continue;
      dxfIdByKey.set(key, dxfFormats.length);
      dxfFormats.push(rule.format);
    }
  }
  const dxfsXml = buildDxfsXml(dxfFormats);
  const dxfsElement = dxfsXml === null ? null : elementFromFragment(dxfsXml);

  // ② 结构化表格：全局分配部件路径 / id，产出部件、工作表级关系与 `<tableParts>`。
  const tableParts: OpcPart[] = [];
  const tablePartPaths: string[] = [];
  const sheetTableGroups: RelationshipGroup[] = [];
  const tablePartsBySheet = new Map<string, XmlElement>();
  let tableId = 0;
  workbook.sheets.forEach((sheet, index) => {
    const tables = extrasBySheet.get(sheet.name)?.tables ?? [];
    if (tables.length === 0) return;
    const declarations: RelationshipDeclaration[] = [];
    for (const table of tables) {
      tableId += 1;
      const path = tablePartPath(tableId);
      tableParts.push({ path, content_type: XLSX_TABLE_CONTENT_TYPE, data: buildTableDefinitionXml(table, tableId) });
      tablePartPaths.push(path);
      // 工作表在 xl/worksheets/ 下，表部件在 xl/tables/ 下 ⇒ 目标相对工作表是 ../tables/…
      declarations.push({ type: TABLE_RELATIONSHIP_TYPE, target: `../tables/table${String(tableId)}.xml` });
    }
    const parts = tables.map((_table, position) => el('tablePart', [attr('r:id', relationshipIdAt(position))]));
    tablePartsBySheet.set(sheet.name, el('tableParts', [attr('count', String(tables.length))], parts));
    sheetTableGroups.push({ owner_part_path: worksheetPartPath(index), declarations });
  });

  const generatedParts: OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: buildWorkbookXml(workbook) },
    { path: XLSX_STYLES_PART_PATH, content_type: XLSX_STYLES_CONTENT_TYPE, data: buildStylesXml(dxfsElement, stylePlan.table) },
    ...tableParts,
  ];
  workbook.sheets.forEach((sheet, index) => {
    const sheetExtras = extrasBySheet.get(sheet.name) ?? {};
    const injection = compileSheetInjection(
      sheet,
      sheetExtras,
      dxfIdByKey,
      tablePartsBySheet.get(sheet.name) ?? null,
    );
    generatedParts.push({
      path: worksheetPartPath(index),
      content_type: XLSX_WORKSHEET_CONTENT_TYPE,
      data: buildSheetXml(sheet, cache, sheet.name === activeName, injection, stylePlan.resolverFor(sheet.name)),
    });
  });

  const generatedGroups: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [
        { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH },
      ],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [
        ...workbook.sheets.map((_sheet, index) => ({
          type: WORKSHEET_RELATIONSHIP_TYPE,
          target: worksheetRelationshipTarget(index),
        })),
        { type: STYLES_RELATIONSHIP_TYPE, target: 'styles.xml' },
      ],
    },
    ...sheetTableGroups,
  ];

  const merged = mergeResidual(generatedParts, generatedGroups, residual);

  const assembled = assembleOpcPackage({
    parts: merged.parts,
    content_type_defaults: merged.defaults,
    relationships: merged.relationships,
  });

  const bytes = writeZip(assembled.entries);
  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    content_digest: xlsxContentDigest(bytes),
    evaluations: records,
    preserved_part_paths: Object.freeze([...merged.preserved]),
    dropped_relationships: Object.freeze([...merged.dropped]),
    table_part_paths: Object.freeze(tablePartPaths),
  });
}

/**
 * 把 `XlsxWriteExtras.sheets` 收敛成"工作表名 → 附加内容"的表，并对未知表名**显式失败**。
 * @throws {ValidationError} 附加内容指向工作簿里不存在的工作表
 */
function normalizeExtras(workbook: WorkbookState, extras: XlsxWriteExtras): ReadonlyMap<string, SheetExtras> {
  const index = new Map<string, SheetExtras>();
  const sheets = extras.sheets;
  if (sheets === undefined) return index;
  const known = new Set(workbook.sheets.map((sheet) => sheet.name));
  for (const [name, value] of Object.entries(sheets)) {
    if (!known.has(name)) {
      throw new ValidationError(
        `XlsxWriteExtras 指向工作簿里不存在的工作表 ${JSON.stringify(name)}：不得静默丢弃附加内容`,
      );
    }
    index.set(name, value);
  }
  return index;
}

// ---------------------------------------------------------------------------
// XLS-13 接线：把 `refreshPivotTable` 的写回结果落成 .xlsx 字节
// ---------------------------------------------------------------------------

/**
 * `refreshPivotTable` 结果的**结构子集**。
 *
 * 刻意**不** `import` `pivot.ts`：`pivot.ts → charts.ts → xlsx-write.ts` 会构成循环依赖。
 * 这里用结构类型吸收结果，`PivotRefreshResult`（`pivot.ts` 的返回类型）可**直接**传入而无需转换。
 */
export interface PivotRefreshWriteBack {
  /** 刷新后的工作簿（`refreshPivotTable(...).workbook`）——其中已含写回的透视单元格。 */
  readonly workbook: WorkbookState;
  /** 写出的落点区域（A1 记法，含表头行）。 */
  readonly range: string;
  /** 实际写入**数值**的格数。 */
  readonly cells_written: number;
  /** 因"该组没有数值"而留空的格数（**不是 0**）。 */
  readonly absent_cells: number;
}

/** 透视刷新写回的审计摘要（正向证据：落点与写入格数）。 */
export interface PivotRefreshDigest {
  readonly range: string;
  readonly cells_written: number;
  readonly absent_cells: number;
}

/**
 * 把 `refreshPivotTable` 的**本机刷新结果**写成一份真实的 .xlsx。
 *
 * 透视区的汇总值在手机端算好后写进工作表模型（`refreshPivotTable` 的返回），本函数把它交给
 * 同一条写入管线（{@link writeWorkbookXlsx}），并在结果里带回 {@link PivotRefreshDigest}。
 * 因此产出的字节既带普通 `cellXfs` / 保护，也带**已被读回可核对**的透视单元格——
 * 不需打开桌面 Excel。
 *
 * @throws {ValidationError} 同 {@link writeWorkbookXlsx}
 */
export function writePivotRefreshedXlsx(
  refresh: PivotRefreshWriteBack,
  residual: XlsxResidual = EMPTY_RESIDUAL,
  extras: XlsxWriteExtras = EMPTY_EXTRAS,
): XlsxWriteResult {
  const result = writeWorkbookXlsx(refresh.workbook, residual, extras);
  return Object.freeze({
    ...result,
    pivot_refresh: Object.freeze({
      range: refresh.range,
      cells_written: refresh.cells_written,
      absent_cells: refresh.absent_cells,
    }),
  });
}
