/**
 * 表格域：**真实 .xlsx 字节** → `WorkbookState`（design-06-P8 / XLS-02、XLS-05、XLS-11、XLS-12；合同 R249）。
 *
 * ## 复用而不是重写
 *
 * - **容器**：`src/artifacts/ooxml/zip-read.ts` 的 `readZip`（自研 DEFLATE 解压 + 全部硬门）。
 * - **XML 读取**：`src/documents/docx/xml-parse.ts` 的 `parseXmlBytes` / `findChild` /
 *   `childElements` / `attributeValue` / `directText`——这是 `ooxml/xml.ts` 的**读侧对偶**，
 *   本轮**只读使用**（`src/documents/**` 不在我的写权内，一个字节都不改）。
 * - **命名空间常量**：`xl/workbook.xml` 用 `xlsx.ts` 已导出的 `SPREADSHEETML_NAMESPACE` /
 *   `OFFICE_RELATIONSHIPS_NAMESPACE`。
 *
 * ## 读回来的东西（逐项）
 *
 * 多工作表（名字 / 顺序 / 隐藏 / 活跃表）、六类取值（**公式读的是 `<f>` 原文，不是缓存值**）、
 * 日期（**识别日期数字格式**，还原成 `DateValue` 而不是一个裸数）、冻结窗格、合并区域、维度。
 *
 * 除模型本身外，本轮还把此前"读不回来"的部件一并解析进 {@link XlsxReadResult}：
 *
 * | 读回来的东西 | 落在结果字段 | 复用 |
 * |---|---|---|
 * | 打印设置（`pageSetup` / `pageMargins` / `headerFooter` / `rowBreaks` / `colBreaks` / `printOptions` / `_xlnm.*`） | `print: PrintPlan` | `print-layout.ts` 的类型与纸张表 |
 * | 工作表 / 工作簿保护 | `sheet_features[].protection` / `workbook_protection` | `protection/` 的解析器 |
 * | 数据验证 | `sheet_features[].data_validations` | `validation.ts` 的 `parseDataValidationsXml` |
 * | 条件格式 + 差异格式 | `sheet_features[].conditional_formats` / `differential_formats` | `conditional-format.ts` 的解析器 |
 * | ZIP 读取上限 | `ReadWorkbookOptions.limits` → `readZip` | `zip-read.ts` |
 * | 现代 Excel 错误值（`#SPILL!` 等） | `ErrorValue.code` | 见下 |
 *
 * **open→save 的边界（如实登记）**：`readWorkbookXlsx` 现在能把打印计划 / 保护等**读出来**，
 * 但低层 `xls-io.saveWorkbookDocument` 仍只把「模型 + 残留」交给写出器，**不转交打印计划 /
 * 保护**，因此走那条路保存仍会丢设置；能用读回结果保住设置的生产通道是
 * `package-assembly.assembleWorkbookPackage(workbook, { print })`（写侧接线属其所有者，见残留）。
 *
 * **本轮未建模的打印形状（不夸大保真度）**：`PrintLayout.paper_size` 只认
 * `print-layout.ts` 白名单里的 15 种纸张，白名单之外的 `paperSize` 编号读成 `null`；
 * 多段打印区域（逗号分隔）只保留整段文本；`<extLst>` 里的 x14 条件格式 / 验证**不解析**
 * （只解析标准 `<conditionalFormatting>` / `<dataValidations>`）。这些是能力边界，
 * 真机 / 真实 Excel 消费端的表现**未验证**。
 *
 * ## R249「未知部件原样保留」的形状
 *
 * 本模块**只解释它认识的部件**；其余一切进 {@link XlsxResidual}——原样字节 + 内容类型，
 * 连同**没被重建的关系声明**。写回时由 `xlsx-write.ts` 的 `mergeResidual` 带回去。
 * 边界（哪些还原不了）在 `XlsxResidual` 的注释里逐条写明，**不夸大保真度**。
 *
 * ## 共享公式（`<f t="shared">`）
 *
 * 主格 `<f t="shared" ref="范围" si="N">公式文本</f>` 原样读回它的公式文本。
 * 从属格 `<f t="shared" si="N"/>`（无文本）**按 OOXML 语义还原**：继承同一 `si` 主格的
 * 公式文本，并把**相对引用按主格 → 从属格的偏移平移**——语义就是「把主格公式**复制**到从属格」，
 * 与 Excel 复制一致：`$` 锁定的部分不动，其余照常平移（**含跨表引用的单元格部分**
 * `Sheet2!A1` ⇒ `Sheet2!B1`，以及整列 `A:A` / 整行 `1:1`）；表名（含引号与 3D 的
 * `Sheet1:Sheet3!`）、字符串字面量、函数名与自定义名不动。
 *
 * ## 本模块**显式拒绝**的东西（宁可失败，不静默降级）
 *
 * - **还原不了的共享公式从属格**：从属格落在主格 `ref` 范围外、`si` 找不到主格、
 *   或平移后越界——一律**抛 `ValidationError`**，而不是写一个静态的、错的公式。
 * - **真正未知的错误值代码**：读侧枚举（7 个经典 + 9 个现代 Excel 代码，见
 *   {@link XLSX_READ_ERROR_CODES}）之外的代码仍抛 `ValidationError`。现代代码（`#SPILL!` 等）
 *   已放行，但 `value.ts` 的规范枚举尚未扩到它们，故用一条**留痕的**类型断言构造
 *   {@link ErrorValue}——规范枚举的放宽属 `value.ts` 所有者（见残留）。
 */

import { ValidationError } from '../protocol/index.js';
import {
  resolveRelationshipTarget,
  type ContentTypeDefault,
  type RelationshipDeclaration,
} from '../artifacts/ooxml/index.js';
import { readZip, type ReadZipArchive, type ZipReadLimits } from '../artifacts/ooxml/zip-read.js';
import {
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
} from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  serializeParsedXmlNode,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { BUILTIN_DATE_NUMFMT_IDS, fromExcelSerial, isDateFormatCode } from './excel-date.js';
import { createSheet, setCellValue, type SheetOptions, type SheetState } from './sheet.js';
import { createWorkbook, setActiveSheet, setSheetHidden, type WorkbookState } from './workbook.js';
import {
  XLSX_STYLES_PART_PATH,
  type PreservedPart,
  type PreservedRelationshipGroup,
  type XlsxResidual,
} from './xlsx-write.js';
import {
  PAPER_SIZES,
  type PageHeaderFooter,
  type PageMargins,
  type PageOrder,
  type PageOrientation,
  type PaperSizeName,
  type PrintLayout,
  type PrintOptions,
  type PrintPlan,
  type PrintScaling,
} from './print-layout.js';
import { parseSheetProtectionXml, parseWorkbookProtectionXml, type SheetProtection, type WorkbookProtection } from './protection/index.js';
import { parseDataValidationsXml, type DataValidationRule } from './validation.js';
import {
  parseConditionalFormattingBlocks,
  parseDxfsXml,
  type CfRule,
  type DifferentialFormat,
} from './conditional-format.js';
import {
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  numberValue,
  textValue,
  type CellValue,
  type ErrorValue,
  type SpreadsheetErrorCode,
} from './value.js';

/** 读一份 .xlsx 的选项。 */
export interface ReadWorkbookOptions {
  /**
   * 传给 {@link readZip} 的**可选上限覆盖**（X-R04）。
   *
   * 未给的项取 ZIP 读取器的默认值；给非法值（负数 / 非整数）由 `readZip` 显式拒绝。
   */
  readonly limits?: Partial<ZipReadLimits>;
}

/** 一张工作表读回的"结构特性"（X06：保护 / 数据验证 / 条件格式）。 */
export interface XlsxSheetFeatures {
  readonly sheet: string;
  /** `<sheetProtection>` 模型；无保护时为 `null`（**不伪造一个全放行模型**）。 */
  readonly protection: SheetProtection | null;
  /** `<dataValidations>` 里的规则（保序）；无则为空数组。 */
  readonly data_validations: readonly DataValidationRule[];
  /** 本表全部 `<conditionalFormatting>` 块的规则（`dxfId` 已由 {@link XlsxReadResult.differential_formats} 还原）。 */
  readonly conditional_formats: readonly CfRule[];
}

/** 读回结果：模型 + 必须原样带回的残留（R249）+ 此前"读不回来"的打印 / 保护 / 验证 / 条件格式。 */
export interface XlsxReadResult {
  readonly workbook: WorkbookState;
  readonly residual: XlsxResidual;
  /**
   * 每张表的打印布局（X-R05）。只登记**非默认**布局（`null` 字段 + 空分页 = 不出现），
   * 与 `print-layout.ts` 的 `PrintPlan` 同型，可直接喂给 `package-assembly.ts` / 注入函数重写回文件。
   */
  readonly print: PrintPlan;
  /** `xl/styles.xml` 的 `<dxfs>`（条件格式差异格式），下标即 `dxfId`。 */
  readonly differential_formats: readonly DifferentialFormat[];
  /** 工作簿级保护（`<workbookProtection>`）；无则 `null`。 */
  readonly workbook_protection: WorkbookProtection | null;
  /** 每张表的结构特性（工作表顺序）。 */
  readonly sheet_features: readonly XlsxSheetFeatures[];
}

/** 共享字符串部件路径（存在即被**消费**——读成文本，不再作为未知部件保留）。 */
const SHARED_STRINGS_PART_PATH = 'xl/sharedStrings.xml';

/** workbook 部件自己的关系部件路径。 */
const WORKBOOK_RELS_PART_PATH = 'xl/_rels/workbook.xml.rels';

/** 内容类型无法确定时的兜底（合规的 OPC 包不会走到这里）。 */
const OCTET_STREAM = 'application/octet-stream';

/**
 * 现代 Excel（动态数组 / `_xlfn` 家族）会写出 `value.ts` 封闭枚举之外的错误值。
 *
 * X-R01 的集成请求：读路径必须能**读回**这些真实文件里的代码，否则一个只含 `#SPILL!` 的
 * 表格会让整份工作簿读失败——这是"读真实世界文件"的能力边界，不是静默降级。
 * 这里**只放宽读侧**；写出仍原样带回代码文本，因此 `#SPILL!` 也能往返。
 */
export type ModernExcelErrorCode =
  | '#SPILL!'
  | '#CALC!'
  | '#GETTING_DATA'
  | '#FIELD!'
  | '#UNKNOWN!'
  | '#CONNECT!'
  | '#BLOCKED!'
  | '#BUSY!'
  | '#PYTHON!';

/** 读侧认得的全部错误值代码：`value.ts` 的封闭枚举 + 现代 Excel 代码。 */
export const XLSX_READ_ERROR_CODES: readonly string[] = Object.freeze([
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#SPILL!',
  '#CALC!',
  '#GETTING_DATA',
  '#FIELD!',
  '#UNKNOWN!',
  '#CONNECT!',
  '#BLOCKED!',
  '#BUSY!',
  '#PYTHON!',
]);

function toErrorCode(text: string, where: string): SpreadsheetErrorCode | ModernExcelErrorCode {
  if (!XLSX_READ_ERROR_CODES.includes(text)) {
    throw new ValidationError(
      `${where} 含本仓不认识的错误值 ${JSON.stringify(text)}（读侧枚举：7 个经典 + 9 个现代 Excel 代码）`,
    );
  }
  return text as SpreadsheetErrorCode | ModernExcelErrorCode;
}

const MODERN_ERROR_CODES: readonly string[] = Object.freeze([
  '#SPILL!',
  '#CALC!',
  '#GETTING_DATA',
  '#FIELD!',
  '#UNKNOWN!',
  '#CONNECT!',
  '#BLOCKED!',
  '#BUSY!',
  '#PYTHON!',
]);

/**
 * 错误值 → `ErrorValue`。
 *
 * 经典代码走 `value.ts` 的 `errorValue`（保持封闭枚举的校验）；现代代码**绕过**它——
 * `value.ts` 的 `SPREADSHEET_ERROR_CODES` 尚未扩到现代代码（该文件的写权不在本单元，
 * 已登记为残留）。此处保留类型断言，语义上仍是"有值且是错误"，往返不受影响。
 */
function makeErrorValue(code: SpreadsheetErrorCode | ModernExcelErrorCode): ErrorValue {
  return MODERN_ERROR_CODES.includes(code)
    ? Object.freeze({ kind: 'error' as const, code: code as SpreadsheetErrorCode })
    : errorValue(code as SpreadsheetErrorCode);
}

// ---------------------------------------------------------------------------
// 内容类型
// ---------------------------------------------------------------------------

interface ContentTypes {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

function parseContentTypes(root: ParsedXmlElement | undefined): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (root === undefined) {
    return { defaults, overrides };
  }
  for (const child of childElements(root)) {
    if (child.localName === 'Default') {
      const extension = attributeValue(child, '', 'Extension');
      const type = attributeValue(child, '', 'ContentType');
      if (extension !== null && type !== null) defaults.set(extension.toLowerCase(), type);
    } else if (child.localName === 'Override') {
      const partName = attributeValue(child, '', 'PartName');
      const type = attributeValue(child, '', 'ContentType');
      if (partName !== null && type !== null) overrides.set(partName.replace(/^\/+/, ''), type);
    }
  }
  return { defaults, overrides };
}

function resolveContentType(path: string, contentTypes: ContentTypes): string {
  const override = contentTypes.overrides.get(path);
  if (override !== undefined) return override;
  const dot = path.lastIndexOf('.');
  if (dot !== -1) {
    const byExtension = contentTypes.defaults.get(path.slice(dot + 1).toLowerCase());
    if (byExtension !== undefined) return byExtension;
  }
  return OCTET_STREAM;
}

// ---------------------------------------------------------------------------
// 关系
// ---------------------------------------------------------------------------

interface RelationshipEntry {
  readonly id: string;
  readonly declaration: RelationshipDeclaration;
}

/**
 * 读一个关系部件。
 *
 * @param where 用于报错定位的部件路径
 * @throws {ValidationError} 同一关系部件里出现两条同 `Id` 的 `<Relationship>`
 *   ——关系 id 冲突是**结构性损坏**（Excel 会判定文件损坏），必须**准确拒绝**，
 *   不得静默让后者覆盖前者（这正是"损坏包准确拒绝"的一条）。
 */
function parseRelationshipPart(root: ParsedXmlElement | undefined, where: string): readonly RelationshipEntry[] {
  if (root === undefined) return [];
  const entries: RelationshipEntry[] = [];
  const seenIds = new Set<string>();
  for (const child of childElements(root)) {
    if (child.localName !== 'Relationship') continue;
    const id = attributeValue(child, '', 'Id');
    const type = attributeValue(child, '', 'Type');
    const target = attributeValue(child, '', 'Target');
    if (id === null || type === null || target === null) continue;
    if (seenIds.has(id)) {
      throw new ValidationError(
        `${where} 里关系 id ${JSON.stringify(id)} 出现了两次：关系 id 冲突是结构性损坏，必须拒绝，不得静默覆盖`,
      );
    }
    seenIds.add(id);
    const declaration: RelationshipDeclaration =
      attributeValue(child, '', 'TargetMode') === 'External'
        ? { type, target, target_mode: 'External' }
        : { type, target };
    entries.push({ id, declaration });
  }
  return Object.freeze(entries);
}

/** 只保留声明本体（丢掉 id）——`XlsxResidual` 只关心"要带回哪些关系"。 */
function declarationsOf(entries: readonly RelationshipEntry[]): readonly RelationshipDeclaration[] {
  return Object.freeze(entries.map((entry) => entry.declaration));
}

// ---------------------------------------------------------------------------
// 样式（只为"这个格是不是日期"服务）
// ---------------------------------------------------------------------------

interface StyleTable {
  /** `cellXfs` 各下标的 `numFmtId`（字符串原样，避免前导零差异）。 */
  readonly numFmtIds: readonly string[];
  /** 自定义 `numFmtId` → `formatCode`。 */
  readonly customFormats: ReadonlyMap<string, string>;
}

const EMPTY_STYLES: StyleTable = Object.freeze({ numFmtIds: Object.freeze([]) as readonly string[], customFormats: new Map<string, string>() });

function parseStyles(root: ParsedXmlElement | undefined): StyleTable {
  if (root === undefined) return EMPTY_STYLES;
  const numFmtIds: string[] = [];
  const customFormats = new Map<string, string>();
  for (const numFmt of childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'numFmts'))) {
    if (numFmt.localName !== 'numFmt') continue;
    const id = attributeValue(numFmt, '', 'numFmtId');
    const code = attributeValue(numFmt, '', 'formatCode');
    if (id !== null && code !== null) customFormats.set(id, code);
  }
  for (const xf of childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'cellXfs'))) {
    if (xf.localName !== 'xf') continue;
    numFmtIds.push(attributeValue(xf, '', 'numFmtId') ?? '0');
  }
  return { numFmtIds, customFormats };
}

/** 该样式下标是否表示日期 / 时间（内建 id 走确定路径，自定义格式码走启发式）。 */
function isDateStyle(styles: StyleTable, styleIndex: string | null): boolean {
  if (styleIndex === null) return false;
  const index = Number.parseInt(styleIndex, 10);
  if (!Number.isSafeInteger(index) || index < 0) return false;
  const numFmtId = styles.numFmtIds[index];
  if (numFmtId === undefined) return false;
  const numeric = Number.parseInt(numFmtId, 10);
  if (Number.isSafeInteger(numeric) && BUILTIN_DATE_NUMFMT_IDS.includes(numeric)) {
    return true;
  }
  const code = styles.customFormats.get(numFmtId);
  return code !== undefined && isDateFormatCode(code);
}

// ---------------------------------------------------------------------------
// 共享字符串
// ---------------------------------------------------------------------------

/** 空安全的子元素列表（`findChild` 返回 `null` 时视为无子元素）。 */
function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

/** 富文本容器（`<is>` / `<si>`）→ 纯文本：直接 `<t>`，或多个 `<r><t>` 片段拼接。 */
function richTextOf(container: ParsedXmlElement | null): string {
  if (container === null) return '';
  const direct = findChild(container, SPREADSHEETML_NAMESPACE, 't');
  if (direct !== null) return directText(direct);
  let merged = '';
  for (const run of childElements(container)) {
    if (run.localName !== 'r') continue;
    const t = findChild(run, SPREADSHEETML_NAMESPACE, 't');
    if (t !== null) merged += directText(t);
  }
  return merged;
}

function parseSharedStrings(root: ParsedXmlElement | undefined): readonly string[] {
  if (root === undefined) return Object.freeze([]) as readonly string[];
  const values: string[] = [];
  for (const si of childElements(root)) {
    if (si.localName !== 'si') continue;
    values.push(richTextOf(si));
  }
  return Object.freeze(values);
}

// ---------------------------------------------------------------------------
// 单元格
// ---------------------------------------------------------------------------

interface CellReadContext {
  readonly sharedStrings: readonly string[];
  readonly styles: StyleTable;
  readonly where: string;
}

/** 共享公式主格：`<f t="shared" ref="范围" si="N">公式文本</f>`。 */
interface SharedFormulaMaster {
  /** 主格公式**原文**。 */
  readonly text: string;
  /** 主格自身所在的格（用于算主格 → 从属格的偏移）。 */
  readonly ref: string;
  /** `ref` 属性声明的覆盖范围（`A1:B2` 形状）；缺省为 `null`。 */
  readonly range: string | null;
}

/** 本仓支持的单元格坐标上界（ECMA-376 的 XFD1048576）。 */
const MAX_COLUMN = 16384;
const MAX_ROW = 1048576;

/** 字母（1–3 位）→ 列号；越界（>XFD）返回 -1。 */
function columnFromLetters(letters: string): number {
  let column = 0;
  for (const ch of letters.toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 0x40);
  }
  return column >= 1 && column <= MAX_COLUMN ? column : -1;
}

/**
 * 字符串字面量的占位符：既不是引用字符、也不是标识符字符，更不是 `!`，
 * 于是屏蔽段里扫不出引用，也不会把边界判定带偏（不引入 NUL 等会污染仓库的字节）。
 */
const STRING_LITERAL_MASK = '~';

/**
 * 把公式里的**字符串字面量**替换成等长占位符（`STRING_LITERAL_MASK`），其余原样保留。
 *
 * 占位符与原文**逐位对齐**（长度不变），于是引用扫描可以在屏蔽串上定位、在原文上替换；
 * Excel 的转义写法 `""`（字面量内双引号）按同一段处理。
 */
function maskStringLiterals(text: string): string {
  let masked = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      if (inString && text[i + 1] === '"') {
        masked += STRING_LITERAL_MASK + STRING_LITERAL_MASK;
        i += 1;
        continue;
      }
      inString = !inString;
      masked += STRING_LITERAL_MASK;
      continue;
    }
    masked += inString ? STRING_LITERAL_MASK : ch;
  }
  return masked;
}

/** 词字符（会让匹配落在更大标识符里，此时不当作引用）。 */
function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_.]/.test(ch);
}

/** 引用形态：单元格 `A1` / 整列 `A` / 整行 `1`。 */
type ReferenceKind = 'cell' | 'column' | 'row';

/** 一个引用片段（单侧；区间由两个片段用 `:` 拼成）。 */
interface ReferencePart {
  readonly kind: ReferenceKind;
  /** 片段在原串里的结束下标。 */
  readonly end: number;
  readonly columnAbsolute: boolean;
  readonly rowAbsolute: boolean;
  /** cell / column：列号；row：不用（0）。 */
  readonly column: number;
  /** cell / row：行号；column：不用（0）。 */
  readonly row: number;
}

interface TranslatedSpan {
  readonly end: number;
  readonly replacement: string;
}

const CELL_REFERENCE = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/y;
const COLUMN_REFERENCE = /(\$?)([A-Za-z]{1,3})/y;
const ROW_REFERENCE = /(\$?)(\d{1,7})/y;
/** 表名：单引号形式（`''` 是转义的单引号）或裸名。 */
const SHEET_NAME = /'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*/y;

/** 识别一个引用片段（**不**校验边界与是否成区间）；识别不到返回 `null`。 */
function parseReferencePart(masked: string, start: number): ReferencePart | null {
  CELL_REFERENCE.lastIndex = start;
  const cell = CELL_REFERENCE.exec(masked);
  if (cell !== null) {
    const column = columnFromLetters(cell[2]!);
    const row = Number.parseInt(cell[4]!, 10);
    if (column !== -1 && row >= 1 && row <= MAX_ROW) {
      return {
        kind: 'cell',
        end: start + cell[0].length,
        columnAbsolute: cell[1] === '$',
        rowAbsolute: cell[3] === '$',
        column,
        row,
      };
    }
  }
  COLUMN_REFERENCE.lastIndex = start;
  const wholeColumn = COLUMN_REFERENCE.exec(masked);
  if (wholeColumn !== null) {
    const column = columnFromLetters(wholeColumn[2]!);
    if (column !== -1) {
      return {
        kind: 'column',
        end: start + wholeColumn[0].length,
        columnAbsolute: wholeColumn[1] === '$',
        rowAbsolute: false,
        column,
        row: 0,
      };
    }
  }
  ROW_REFERENCE.lastIndex = start;
  const wholeRow = ROW_REFERENCE.exec(masked);
  if (wholeRow !== null) {
    const row = Number.parseInt(wholeRow[2]!, 10);
    if (row >= 1 && row <= MAX_ROW) {
      return {
        kind: 'row',
        end: start + wholeRow[0].length,
        columnAbsolute: false,
        rowAbsolute: wholeRow[1] === '$',
        column: 0,
        row,
      };
    }
  }
  return null;
}

/**
 * 从 `start` 起匹配表名限定（裸名 / 单引号名 / 3D 的 `表1:表3`）直到 `!`。
 *
 * 命中返回 `!` 之后的下标（即引用本体的起点），匹配不到返回 `-1`。**表名本身绝不平移**：
 * 它只是被跳过，让后面的引用本体在正确的起点上被识别与平移。
 */
function matchSheetQualifier(masked: string, start: number): number {
  SHEET_NAME.lastIndex = start;
  const first = SHEET_NAME.exec(masked);
  if (first === null) return -1;
  let cursor = start + first[0].length;
  if (masked[cursor] === ':') {
    SHEET_NAME.lastIndex = cursor + 1;
    const second = SHEET_NAME.exec(masked);
    if (second === null) return -1;
    cursor += 1 + second[0].length;
  }
  return masked[cursor] === '!' ? cursor + 1 : -1;
}

/** 平移单个引用片段；越界（列 / 行 < 1 或超上界）⇒ 显式报错。 */
function shiftReferencePart(
  part: ReferencePart,
  deltaRow: number,
  deltaColumn: number,
  where: string,
  formula: string,
): string {
  const nextColumn = part.kind === 'row' ? 0 : part.columnAbsolute ? part.column : part.column + deltaColumn;
  const nextRow = part.kind === 'column' ? 0 : part.rowAbsolute ? part.row : part.row + deltaRow;
  if (part.kind !== 'row' && (nextColumn < 1 || nextColumn > MAX_COLUMN)) {
    throw new ValidationError(
      `${where} 是共享公式从属格，但主格公式 ${JSON.stringify(formula)} 的引用平移 ` +
        `(${deltaRow}, ${deltaColumn}) 后列越界：无法还原`,
    );
  }
  if (part.kind !== 'column' && (nextRow < 1 || nextRow > MAX_ROW)) {
    throw new ValidationError(
      `${where} 是共享公式从属格，但主格公式 ${JSON.stringify(formula)} 的引用平移 ` +
        `(${deltaRow}, ${deltaColumn}) 后行越界：无法还原`,
    );
  }
  switch (part.kind) {
    case 'column':
      return `${part.columnAbsolute ? '$' : ''}${lettersOf(nextColumn)}`;
    case 'row':
      return `${part.rowAbsolute ? '$' : ''}${nextRow}`;
    default:
      return `${part.columnAbsolute ? '$' : ''}${lettersOf(nextColumn)}${part.rowAbsolute ? '$' : ''}${nextRow}`;
  }
}

/**
 * 从 `start` 起识别一个引用（单元格 / 整列 / 整行，或它们的 `:` 区间）并平移到新文本。
 *
 * 识别不到、或后面紧邻标识符字符 / `(`（说明它是更大的名字或函数名，如 `A1NAME` / `LOG10(`）
 * ⇒ 返回 `null`。整列 / 整行**必须成区间**才算引用（裸 `A` / `1` 是名字，不是引用）。
 */
function translateReferenceSpan(
  masked: string,
  start: number,
  deltaRow: number,
  deltaColumn: number,
  where: string,
  formula: string,
): TranslatedSpan | null {
  const first = parseReferencePart(masked, start);
  if (first === null) return null;
  const parts: ReferencePart[] = [first];
  let end = first.end;
  if (masked[end] === ':') {
    const second = parseReferencePart(masked, end + 1);
    if (second !== null && second.kind === first.kind) {
      parts.push(second);
      end = second.end;
    }
  }
  if (parts.length === 1 && first.kind !== 'cell') return null;
  const after = end < masked.length ? masked[end] : undefined;
  if (isIdentifierChar(after) || after === '(') return null;
  return {
    end,
    replacement: parts.map((part) => shiftReferencePart(part, deltaRow, deltaColumn, where, formula)).join(':'),
  };
}

/**
 * 共享公式从属格：把主格公式的相对引用按 (deltaRow, deltaColumn) 平移。
 *
 * 语义 = 「主格公式**复制**到从属格」，与 Excel 复制一致：
 *
 * - 所有**相对**引用都平移；`$` 锁定的那一半不动（`$A$1` 全不动，`$A1` / `A$1` 只动非 `$` 的那半）。
 * - **跨表引用的单元格部分照常平移**（`Sheet2!A1` 右移一列 ⇒ `Sheet2!B1`、
 *   `'My Sheet'!B2` 下移一行 ⇒ `'My Sheet'!B3`），**表名一字不动**（含 `'A1'` 这种像坐标的表名）。
 * - 3D 引用 `Sheet1:Sheet3!A1` 只平移 `A1`。
 * - 整列 `A:A` / 整行 `1:1` 按列 / 行相对平移（`$A:$A` / `$1:$1` 锁定则不动）。
 * - 字符串字面量内的文本、函数名（`LOG10`）与自定义名（`A1NAME`）不动。
 * - 平移后越界 ⇒ **显式报错**，不静默写一个错位的公式。
 */
function shiftFormulaReferences(text: string, deltaRow: number, deltaColumn: number, where: string): string {
  if (deltaRow === 0 && deltaColumn === 0) return text;
  const masked = maskStringLiterals(text);
  let result = '';
  let last = 0;
  let index = 0;
  while (index < masked.length) {
    const before = index > 0 ? masked[index - 1] : undefined;
    // 从标识符 / `$` 中间起步 ⇒ 是更大 token 的一部分，换下一个起点。
    if (isIdentifierChar(before) || before === '$') {
      index += 1;
      continue;
    }
    const qualified = matchSheetQualifier(masked, index);
    const start = qualified === -1 ? index : qualified;
    const span = start < masked.length ? translateReferenceSpan(masked, start, deltaRow, deltaColumn, where, text) : null;
    if (span === null) {
      index += 1;
      continue;
    }
    result += text.slice(last, start) + span.replacement;
    last = span.end;
    index = span.end;
  }
  result += text.slice(last);
  return result;
}

/** 解析主格 `ref` 范围 → 列 / 行的闭区间。 */
function rangeBounds(range: string): { minColumn: number; maxColumn: number; minRow: number; maxRow: number } {
  const parts = range.split(':');
  const start = parts[0] ?? range;
  const end = parts[1] ?? start;
  const columns = [columnNumberOf(start), columnNumberOf(end)];
  const rows = [rowNumberOf(start), rowNumberOf(end)];
  return {
    minColumn: Math.min(...columns),
    maxColumn: Math.max(...columns),
    minRow: Math.min(...rows),
    maxRow: Math.max(...rows),
  };
}

/**
 * 还原一个无文本的共享公式从属格：继承主格公式文本、按偏移平移相对引用。
 *
 * `si` 悬空（找不到主格）或从属格落在主格 `ref` 范围外 ⇒ 抛 `ValidationError`。
 */
function resolveSharedDependent(
  ref: string,
  si: string,
  masters: ReadonlyMap<string, SharedFormulaMaster>,
  context: CellReadContext,
): string {
  const master = masters.get(si);
  if (master === undefined) {
    throw new ValidationError(
      `${context.where} 的 ${ref} 是**共享公式的从属格**（\`<f t="shared" si="${si}"/>\` 无文本），` +
        `但本表找不到 si=${si} 的主格公式：无法确定要继承哪条公式`,
    );
  }
  const column = columnNumberOf(ref);
  const row = rowNumberOf(ref);
  if (master.range !== null) {
    const bounds = rangeBounds(master.range);
    if (column < bounds.minColumn || column > bounds.maxColumn || row < bounds.minRow || row > bounds.maxRow) {
      throw new ValidationError(
        `${context.where} 的 ${ref} 是**共享公式的从属格**，但落在主格 si=${si} 的 ref 范围 ` +
          `${JSON.stringify(master.range)} 之外：无法确定偏移`,
      );
    }
  }
  const deltaRow = row - rowNumberOf(master.ref);
  const deltaColumn = column - columnNumberOf(master.ref);
  return shiftFormulaReferences(master.text, deltaRow, deltaColumn, `${context.where} 的 ${ref}`);
}

function readCell(
  cell: ParsedXmlElement,
  ref: string,
  context: CellReadContext,
  masters: ReadonlyMap<string, SharedFormulaMaster>,
): CellValue | null {
  const formula = findChild(cell, SPREADSHEETML_NAMESPACE, 'f');
  if (formula !== null) {
    const text = directText(formula);
    if (text.length === 0) {
      // 无文本的 `<f>`：只有共享公式的从属格能还原（继承 + 平移主格）；其余显式失败。
      const si = attributeValue(formula, '', 'si');
      if (attributeValue(formula, '', 't') === 'shared' && si !== null) {
        return formulaValue(resolveSharedDependent(ref, si, masters, context));
      }
      throw new ValidationError(
        `${context.where} 的 ${ref} 有一个无文本的 \`<f>\`：既不是共享公式从属格，也无公式可读`,
      );
    }
    return formulaValue(text);
  }

  const type = attributeValue(cell, '', 't');
  if (type === 'inlineStr') {
    const value = richTextOf(findChild(cell, SPREADSHEETML_NAMESPACE, 'is'));
    return value.length === 0 ? null : textValue(value);
  }

  const valueElement = findChild(cell, SPREADSHEETML_NAMESPACE, 'v');
  if (valueElement === null) {
    return null; // 无值 ⇒ 空白（**不写 0**）
  }
  const text = directText(valueElement);
  if (text.length === 0) {
    return null;
  }
  const where = `${context.where} 的 ${ref}`;

  switch (type) {
    case 's': {
      const index = Number.parseInt(text, 10);
      if (!Number.isSafeInteger(index) || index < 0 || index >= context.sharedStrings.length) {
        throw new ValidationError(`${where} 引用了越界的共享字符串下标 ${JSON.stringify(text)}`);
      }
      return textValue(context.sharedStrings[index] ?? '');
    }
    case 'str':
      return textValue(text);
    case 'b':
      return booleanValue(text === '1');
    case 'e':
      return makeErrorValue(toErrorCode(text, where));
    case 'd': {
      // ECMA-376 允许 `t="d"` 的 ISO 8601 文本日期；本仓**容错读入**（写出时用数字 + 日期样式）。
      const parsed = Date.parse(text);
      if (!Number.isFinite(parsed)) {
        throw new ValidationError(`${where} 是非法 ISO 日期 ${JSON.stringify(text)}`);
      }
      return dateValue(parsed);
    }
    case null:
    case 'n': {
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) {
        throw new ValidationError(`${where} 的数值无法解析：${JSON.stringify(text)}`);
      }
      if (isDateStyle(context.styles, attributeValue(cell, '', 's'))) {
        return dateValue(fromExcelSerial(numeric));
      }
      return numberValue(numeric);
    }
    default:
      throw new ValidationError(`${where} 的单元格类型 ${JSON.stringify(type)} 超出本仓支持范围`);
  }
}

// ---------------------------------------------------------------------------
// 工作表
// ---------------------------------------------------------------------------

function columnNumberOf(ref: string): number {
  const letters = /^([A-Za-z]{1,3})/.exec(ref)?.[1] ?? 'A';
  let column = 0;
  for (const ch of letters.toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 0x40);
  }
  return Math.max(column, 1);
}

function lettersOf(column: number): string {
  let remaining = Math.max(1, column);
  let letters = '';
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    letters = String.fromCharCode(0x41 + offset) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

function rowNumberOf(ref: string): number {
  const digits = /(\d{1,7})$/.exec(ref)?.[1];
  const row = digits === undefined ? 0 : Number.parseInt(digits, 10);
  return Number.isSafeInteger(row) && row > 0 ? row : 1;
}

interface ParsedWorksheet {
  readonly cells: readonly { readonly ref: string; readonly value: CellValue }[];
  readonly options: SheetOptions;
}

/** 按文档顺序遍历 `<sheetData>` 里的每个格子（含省略 `r` 时的位置补全）。 */
function eachCell(root: ParsedXmlElement, visit: (cell: ParsedXmlElement, ref: string) => void): void {
  let fallbackRow = 0;
  for (const row of childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetData'))) {
    if (row.localName !== 'row') continue;
    const rowAttr = attributeValue(row, '', 'r');
    const parsedRow = rowAttr === null ? fallbackRow + 1 : Number.parseInt(rowAttr, 10);
    const rowNumber = Number.isSafeInteger(parsedRow) && parsedRow > 0 ? parsedRow : fallbackRow + 1;
    fallbackRow = rowNumber;
    let fallbackColumn = 0;
    for (const cell of childElements(row)) {
      if (cell.localName !== 'c') continue;
      const declared = attributeValue(cell, '', 'r');
      const column = declared === null ? fallbackColumn + 1 : columnNumberOf(declared);
      fallbackColumn = column;
      visit(cell, declared ?? `${lettersOf(column)}${String(rowNumber)}`);
    }
  }
}

/**
 * 收集本表的共享公式**主格**（有文本的 `<f t="shared" si="N">…</f>`），按 `si` 建索引。
 *
 * 无文本的 `<f t="shared" si="N"/>` 是从属格，不在此处登记。同一 `si` 出现多个主格 ⇒
 * 无法确定继承哪条，**显式报错**。
 */
function collectSharedFormulaMasters(root: ParsedXmlElement, where: string): ReadonlyMap<string, SharedFormulaMaster> {
  const masters = new Map<string, SharedFormulaMaster>();
  eachCell(root, (cell, ref) => {
    const formula = findChild(cell, SPREADSHEETML_NAMESPACE, 'f');
    if (formula === null || attributeValue(formula, '', 't') !== 'shared') return;
    const si = attributeValue(formula, '', 'si');
    if (si === null) return;
    const text = directText(formula);
    if (text.length === 0) return; // 从属格
    if (masters.has(si)) {
      throw new ValidationError(`${where} 有多个共享公式主格声明 si=${si}：无法确定继承哪一条`);
    }
    masters.set(si, Object.freeze({ text, ref, range: attributeValue(formula, '', 'ref') }));
  });
  return masters;
}

function parseWorksheet(root: ParsedXmlElement, context: CellReadContext): ParsedWorksheet {
  const masters = collectSharedFormulaMasters(root, context.where);
  const cells: { ref: string; value: CellValue }[] = [];
  eachCell(root, (cell, ref) => {
    const value = readCell(cell, ref, context, masters);
    if (value !== null) {
      cells.push({ ref, value });
    }
  });
  return { cells, options: readSheetOptions(root, cells) };
}

function readSheetOptions(root: ParsedXmlElement, cells: readonly { readonly ref: string }[]): SheetOptions {
  let rowCount = 0;
  let columnCount = 0;
  for (const cell of cells) {
    columnCount = Math.max(columnCount, columnNumberOf(cell.ref));
    rowCount = Math.max(rowCount, rowNumberOf(cell.ref));
  }
  const dimension = findChild(root, SPREADSHEETML_NAMESPACE, 'dimension');
  const dimensionRef = dimension === null ? null : attributeValue(dimension, '', 'ref');
  const dimensionEnd = dimensionRef === null ? null : dimensionRef.split(':')[1];
  if (dimensionEnd !== undefined && dimensionEnd !== null) {
    columnCount = Math.max(columnCount, columnNumberOf(dimensionEnd));
    rowCount = Math.max(rowCount, rowNumberOf(dimensionEnd));
  }

  const pane = findChild(
    findChild(findChild(root, SPREADSHEETML_NAMESPACE, 'sheetViews'), SPREADSHEETML_NAMESPACE, 'sheetView'),
    SPREADSHEETML_NAMESPACE,
    'pane',
  );
  const frozen = pane !== null && attributeValue(pane, '', 'state') === 'frozen';
  const frozenRows = frozen ? Math.max(0, Number.parseInt(attributeValue(pane, '', 'ySplit') ?? '0', 10) || 0) : 0;
  const frozenColumns = frozen ? Math.max(0, Number.parseInt(attributeValue(pane, '', 'xSplit') ?? '0', 10) || 0) : 0;

  const merged: string[] = [];
  for (const mergeCell of childrenOf(findChild(root, SPREADSHEETML_NAMESPACE, 'mergeCells'))) {
    if (mergeCell.localName !== 'mergeCell') continue;
    const ref = attributeValue(mergeCell, '', 'ref');
    if (ref !== null) merged.push(ref);
  }

  return {
    row_count: Math.max(rowCount, 1),
    column_count: Math.max(columnCount, 1),
    frozen_rows: frozenRows,
    frozen_columns: frozenColumns,
    merged,
  };
}

// ---------------------------------------------------------------------------
// 工作簿
// ---------------------------------------------------------------------------

interface WorkbookSheetRef {
  readonly name: string;
  readonly relationshipId: string;
  readonly hidden: boolean;
}

function parseWorkbookSheets(root: ParsedXmlElement): readonly WorkbookSheetRef[] {
  const sheets = findChild(root, SPREADSHEETML_NAMESPACE, 'sheets');
  if (sheets === null) {
    throw new ValidationError('xl/workbook.xml 缺少 <sheets>：无法确定工作表清单');
  }
  const result: WorkbookSheetRef[] = [];
  for (const sheet of childElements(sheets)) {
    if (sheet.localName !== 'sheet') continue;
    const name = attributeValue(sheet, '', 'name');
    const relationshipId = attributeValue(sheet, OFFICE_RELATIONSHIPS_NAMESPACE, 'id');
    if (name === null || relationshipId === null) {
      throw new ValidationError('xl/workbook.xml 的 <sheet> 缺少 name 或 r:id');
    }
    result.push({ name, relationshipId, hidden: attributeValue(sheet, '', 'state') === 'hidden' });
  }
  if (result.length === 0) {
    throw new ValidationError('xl/workbook.xml 的 <sheets> 是空的：Excel 要求至少一张工作表');
  }
  return result;
}

function parseActiveTab(root: ParsedXmlElement): number {
  const view = findChild(
    findChild(root, SPREADSHEETML_NAMESPACE, 'bookViews'),
    SPREADSHEETML_NAMESPACE,
    'workbookView',
  );
  const raw = view === null ? null : attributeValue(view, '', 'activeTab');
  const index = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isSafeInteger(index) && index >= 0 ? index : 0;
}

function parsePart(archive: ReadZipArchive, path: string): ParsedXmlElement | undefined {
  const entry = archive.by_path.get(path);
  return entry === undefined ? undefined : parseXmlBytes(entry.data);
}

function requirePart(archive: ReadZipArchive, path: string): ParsedXmlElement {
  const root = parsePart(archive, path);
  if (root === undefined) {
    throw new ValidationError(`xlsx 缺少部件 ${path}`);
  }
  return root;
}

/**
 * 已知（本模块**解释并重建**）的部件路径——其余一律进残留。
 *
 * 注意工作表虽被重建，但**工作表级关系部件**（`xl/worksheets/_rels/sheetN.xml.rels`，
 * 典型内容是把批注 / 图形 / 表格挂到表上）**不在**已知集合里：本模型不重建表 XML 里的
 * `r:id` 引用，所以它的正确归宿是"未知部件"——**整份字节原样带回**（R249），
 * 而不是被本模块丢掉。这是 R249 在本模块的真实边界，如实登记、不夸大。
 */
function knownParts(worksheetPaths: readonly string[]): ReadonlySet<string> {
  const known = new Set<string>([
    '[Content_Types].xml',
    '_rels/.rels',
    XLSX_WORKBOOK_PART_PATH,
    WORKBOOK_RELS_PART_PATH,
    XLSX_STYLES_PART_PATH,
    'xl/_rels/styles.xml.rels',
    SHARED_STRINGS_PART_PATH,
    'xl/_rels/sharedStrings.xml.rels',
  ]);
  for (const path of worksheetPaths) {
    known.add(path);
  }
  return known;
}

// ---------------------------------------------------------------------------
// 打印设置读回（X-R05）：pageSetup / pageMargins / headerFooter / rowBreaks /
// colBreaks / printOptions / sheetPr-pageSetUpPr，以及 definedNames 的 _xlnm.*
// ---------------------------------------------------------------------------

/** 纸张编号 → 纸张名（`PAPER_SIZES` 的逆映射；未知编号不强行命名）。 */
const PAPER_NAME_BY_SIZE: ReadonlyMap<number, PaperSizeName> = new Map(
  (Object.entries(PAPER_SIZES) as readonly (readonly [PaperSizeName, number])[]).map(([name, size]) => [size, name]),
);

/** 去年表单限定前缀：`'预算'!$A$1` → `$A$1`（取最后一个 `!`，兼容名字里含 `!` 的引号名）。 */
function stripSheetPrefix(text: string): string {
  const separator = text.lastIndexOf('!');
  return separator < 0 ? text : text.slice(separator + 1);
}

function numberAttribute(element: ParsedXmlElement | null, name: string): number | null {
  if (element === null) return null;
  const raw = attributeValue(element, '', name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function intAttribute(element: ParsedXmlElement | null, name: string): number | null {
  const parsed = numberAttribute(element, name);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** `<pageMargins>` → 英寸边距（缺项按 0；整元素缺失 ⇒ `null`）。 */
function parseMargins(element: ParsedXmlElement | null): PageMargins | null {
  if (element === null) return null;
  const keys = ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const;
  const values: { left: number; right: number; top: number; bottom: number; header: number; footer: number } = {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    header: 0,
    footer: 0,
  };
  let any = false;
  for (const key of keys) {
    const value = numberAttribute(element, key);
    if (value !== null) {
      values[key] = value;
      any = true;
    }
  }
  return any ? Object.freeze(values) : null;
}

const HEADER_FOOTER_SLOTS: readonly (readonly [keyof PageHeaderFooter, string])[] = Object.freeze([
  ['odd_header', 'oddHeader'],
  ['odd_footer', 'oddFooter'],
  ['even_header', 'evenHeader'],
  ['even_footer', 'evenFooter'],
  ['first_header', 'firstHeader'],
  ['first_footer', 'firstFooter'],
]);

/** `<headerFooter>` → 页眉页脚模型；无内容且无标志 ⇒ `null`。 */
function parseHeaderFooter(element: ParsedXmlElement | null): PageHeaderFooter | null {
  if (element === null) return null;
  const model: {
    odd_header?: string;
    odd_footer?: string;
    even_header?: string;
    even_footer?: string;
    first_header?: string;
    first_footer?: string;
    different_odd_even?: boolean;
    different_first?: boolean;
    scale_with_doc?: boolean;
    align_with_margins?: boolean;
  } = {};
  if (attributeValue(element, '', 'differentFirst') === '1') model.different_first = true;
  if (attributeValue(element, '', 'differentOddEven') === '1') model.different_odd_even = true;
  if (attributeValue(element, '', 'scaleWithDoc') === '0') model.scale_with_doc = false;
  if (attributeValue(element, '', 'alignWithMargins') === '0') model.align_with_margins = false;
  for (const [field, elementName] of HEADER_FOOTER_SLOTS) {
    const child = findChild(element, SPREADSHEETML_NAMESPACE, elementName);
    if (child !== null) (model as Record<string, string | undefined>)[field] = directText(child);
  }
  return Object.keys(model).length === 0 ? null : Object.freeze(model);
}

const PRINT_OPTION_ATTRS: readonly (readonly [keyof PrintOptions, string])[] = Object.freeze([
  ['grid_lines', 'gridLines'],
  ['headings', 'headings'],
  ['horizontal_centered', 'horizontalCentered'],
  ['vertical_centered', 'verticalCentered'],
]);

/** `<printOptions>` → 打印选项；无显式属性 ⇒ `null`。 */
function parsePrintOptions(element: ParsedXmlElement | null): PrintOptions | null {
  if (element === null) return null;
  const model: {
    grid_lines?: boolean;
    headings?: boolean;
    horizontal_centered?: boolean;
    vertical_centered?: boolean;
  } = {};
  for (const [field, attribute] of PRINT_OPTION_ATTRS) {
    const raw = attributeValue(element, '', attribute);
    if (raw !== null) model[field] = raw === '1';
  }
  return Object.keys(model).length === 0 ? null : Object.freeze(model);
}

/** `<rowBreaks>` / `<colBreaks>` 里 `man="1"` 的手工分页符 id（去重、升序）。 */
function parseBreakIds(element: ParsedXmlElement | null): readonly number[] {
  const ids: number[] = [];
  for (const brk of childrenOf(element)) {
    if (brk.localName !== 'brk') continue;
    if (attributeValue(brk, '', 'man') !== '1') continue;
    const id = intAttribute(brk, 'id');
    if (id !== null && id >= 1) ids.push(id);
  }
  return Object.freeze([...new Set(ids)].sort((left, right) => left - right));
}

/** `<pageSetup>` 的缩放：需 `fitToPage="1"` 且有 `fitTo*` 才认适配，否则认百分比。 */
function parseScaling(pageSetup: ParsedXmlElement | null, fitToPage: boolean): PrintScaling | null {
  const fitToWidth = intAttribute(pageSetup, 'fitToWidth');
  const fitToHeight = intAttribute(pageSetup, 'fitToHeight');
  if (fitToPage && (fitToWidth !== null || fitToHeight !== null)) {
    const width = Math.max(0, fitToWidth ?? 0);
    const height = Math.max(0, fitToHeight ?? 0);
    if (width > 0 || height > 0) {
      return Object.freeze({ kind: 'fit_to_pages' as const, width, height });
    }
  }
  const percent = intAttribute(pageSetup, 'scale');
  if (percent !== null && percent >= 10 && percent <= 400) {
    return Object.freeze({ kind: 'percent' as const, percent });
  }
  return null;
}

function parseOrientation(pageSetup: ParsedXmlElement | null): PageOrientation | null {
  if (pageSetup === null) return null;
  const raw = attributeValue(pageSetup, '', 'orientation');
  return raw === 'portrait' || raw === 'landscape' ? raw : null;
}

function parsePageOrder(pageSetup: ParsedXmlElement | null): PageOrder | null {
  if (pageSetup === null) return null;
  const raw = attributeValue(pageSetup, '', 'pageOrder');
  if (raw === 'overThenDown') return 'over_then_down';
  if (raw === 'downThenOver') return 'down_then_over';
  return null;
}

/** `_xlnm.Print_Titles` 正文（如 `'S'!$A:$B,'S'!$1:$3`）→ 行 / 列文本。 */
function parsePrintTitles(text: string | null): { rows: string | null; columns: string | null } {
  let rows: string | null = null;
  let columns: string | null = null;
  if (text === null) return { rows, columns };
  for (const segment of text.split(',')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const normalized = stripSheetPrefix(trimmed).replace(/\$/g, '').replace(/\s+/g, '').toUpperCase();
    if (/^\d+:\d+$/.test(normalized)) rows = normalized;
    else if (/^[A-Z]+:[A-Z]+$/.test(normalized)) columns = normalized;
  }
  return { rows, columns };
}

/** 一张工作表 → `PrintLayout`（字段全部来自真实 XML；未设 ⇒ `null` / 空数组）。 */
function parsePrintLayout(
  root: ParsedXmlElement,
  areaText: string | null,
  titlesText: string | null,
): PrintLayout {
  const pageSetup = findChild(root, SPREADSHEETML_NAMESPACE, 'pageSetup');
  const pageSetUpPr = findChild(
    findChild(root, SPREADSHEETML_NAMESPACE, 'sheetPr'),
    SPREADSHEETML_NAMESPACE,
    'pageSetUpPr',
  );
  const fitToPage = pageSetUpPr !== null && attributeValue(pageSetUpPr, '', 'fitToPage') === '1';
  const paperSizeNumber = intAttribute(pageSetup, 'paperSize');
  const titles = parsePrintTitles(titlesText);

  return Object.freeze({
    print_area: areaText === null ? null : stripSheetPrefix(areaText),
    orientation: parseOrientation(pageSetup),
    paper_size: paperSizeNumber === null ? null : (PAPER_NAME_BY_SIZE.get(paperSizeNumber) ?? null),
    margins: parseMargins(findChild(root, SPREADSHEETML_NAMESPACE, 'pageMargins')),
    repeat_rows: titles.rows,
    repeat_columns: titles.columns,
    scaling: parseScaling(pageSetup, fitToPage),
    header_footer: parseHeaderFooter(findChild(root, SPREADSHEETML_NAMESPACE, 'headerFooter')),
    options: parsePrintOptions(findChild(root, SPREADSHEETML_NAMESPACE, 'printOptions')),
    row_breaks: parseBreakIds(findChild(root, SPREADSHEETML_NAMESPACE, 'rowBreaks')),
    column_breaks: parseBreakIds(findChild(root, SPREADSHEETML_NAMESPACE, 'colBreaks')),
    page_order: parsePageOrder(pageSetup),
  });
}

function isDefaultLayout(layout: PrintLayout): boolean {
  return (
    layout.print_area === null &&
    layout.orientation === null &&
    layout.paper_size === null &&
    layout.margins === null &&
    layout.repeat_rows === null &&
    layout.repeat_columns === null &&
    layout.scaling === null &&
    layout.header_footer === null &&
    layout.options === null &&
    layout.row_breaks.length === 0 &&
    layout.column_breaks.length === 0 &&
    (layout.page_order ?? null) === null
  );
}

// ---------------------------------------------------------------------------
// 保护 / 数据验证 / 条件格式读回（X06）
// ---------------------------------------------------------------------------

/**
 * 把一个**已解析元素**序列化成自含命名空间的片段，供 `protection/` / `validation.ts` /
 * `conditional-format.ts` 的**字符串入口**解析。
 *
 * `serializeParsedXmlNode` 不会重声明继承来的默认命名空间，因此这里补一条
 * `xmlns="…spreadsheetml…"`，否则那些解析器的 `namespace === SPREADSHEETML_NAMESPACE`
 * 过滤会全部失配。
 */
function serializeSheetFragment(element: ParsedXmlElement): string {
  const attributes = element.attributes.some((attribute) => attribute.name === 'xmlns')
    ? element.attributes
    : [{ name: 'xmlns', value: SPREADSHEETML_NAMESPACE }, ...element.attributes];
  return serializeParsedXmlNode(Object.freeze({ ...element, attributes: Object.freeze(attributes) }));
}

function parseSheetProtection(root: ParsedXmlElement): SheetProtection | null {
  const element = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetProtection');
  return element === null ? null : parseSheetProtectionXml(serializeSheetFragment(element));
}

function parseDataValidations(root: ParsedXmlElement): readonly DataValidationRule[] {
  const element = findChild(root, SPREADSHEETML_NAMESPACE, 'dataValidations');
  return element === null ? Object.freeze([]) : parseDataValidationsXml(serializeSheetFragment(element));
}

function parseConditionalFormats(root: ParsedXmlElement, dxfs: readonly DifferentialFormat[]): readonly CfRule[] {
  const blocks = childElements(root)
    .filter((child) => child.localName === 'conditionalFormatting')
    .map((block) => serializeSheetFragment(block));
  return blocks.length === 0 ? Object.freeze([]) : parseConditionalFormattingBlocks(blocks, dxfs);
}

function parseDifferentialFormats(stylesRoot: ParsedXmlElement | undefined): readonly DifferentialFormat[] {
  if (stylesRoot === undefined) return Object.freeze([]);
  const dxfs = findChild(stylesRoot, SPREADSHEETML_NAMESPACE, 'dxfs');
  return dxfs === null ? Object.freeze([]) : parseDxfsXml(serializeSheetFragment(dxfs));
}

/**
 * `xl/workbook.xml` 的 `<definedNames>` 里两张打印名称：工作表名 → `_xlnm.Print_Area` / `Print_Titles`。
 *
 * `localSheetId` 是**工作表下标**，按 `sheetOrder` 还原成表名（`xlsx-write` / Excel 都这么写）。
 */
function parsePrintDefinedNames(
  workbookRoot: ParsedXmlElement,
  sheetOrder: readonly string[],
): ReadonlyMap<string, { readonly area: string | null; readonly titles: string | null }> {
  const bySheet = new Map<string, { area: string | null; titles: string | null }>();
  for (const definedName of childrenOf(findChild(workbookRoot, SPREADSHEETML_NAMESPACE, 'definedNames'))) {
    if (definedName.localName !== 'definedName') continue;
    const name = attributeValue(definedName, '', 'name');
    const localSheetId = attributeValue(definedName, '', 'localSheetId');
    if (name !== '_xlnm.Print_Area' && name !== '_xlnm.Print_Titles') continue;
    if (localSheetId === null) continue;
    const index = Number.parseInt(localSheetId, 10);
    const sheetName = Number.isInteger(index) ? sheetOrder[index] : undefined;
    if (sheetName === undefined) continue;
    const entry = bySheet.get(sheetName) ?? { area: null, titles: null };
    if (name === '_xlnm.Print_Area') entry.area = directText(definedName);
    else entry.titles = directText(definedName);
    bySheet.set(sheetName, entry);
  }
  return bySheet;
}

/**
 * 读回一份 .xlsx。**纯函数**（同一字节 ⇒ 同一结果）。
 *
 * @param options 可选上限覆盖（X-R04）；缺省 = ZIP 读取器的默认上限。
 * @throws {ZipReadError} 容器不合法（截断 / CRC 不符 / 条目超限……）
 * @throws {ValidationError} 包结构或单元格内容超出本仓能忠实读回的范围
 */
export function readWorkbookXlsx(bytes: Uint8Array, options: ReadWorkbookOptions = {}): XlsxReadResult {
  const archive = readZip(bytes, options.limits);
  const contentTypes = parseContentTypes(parsePart(archive, '[Content_Types].xml'));

  const workbookRoot = requirePart(archive, XLSX_WORKBOOK_PART_PATH);
  const sheetRefs = parseWorkbookSheets(workbookRoot);
  const sheetOrder = sheetRefs.map((ref) => ref.name);
  const activeTab = parseActiveTab(workbookRoot);
  const printDefined = parsePrintDefinedNames(workbookRoot, sheetOrder);
  const workbookProtection = findChild(workbookRoot, SPREADSHEETML_NAMESPACE, 'workbookProtection');

  const workbookRelationships = parseRelationshipPart(
    parsePart(archive, WORKBOOK_RELS_PART_PATH),
    WORKBOOK_RELS_PART_PATH,
  );
  const targetById = new Map<string, RelationshipDeclaration>();
  for (const entry of workbookRelationships) {
    targetById.set(entry.id, entry.declaration);
  }
  const workbookRelsRoot = parsePart(archive, WORKBOOK_RELS_PART_PATH);

  const stylesRoot = parsePart(archive, XLSX_STYLES_PART_PATH);
  const styles = parseStyles(stylesRoot);
  const differentialFormats = parseDifferentialFormats(stylesRoot);
  const sharedStrings = parseSharedStrings(parsePart(archive, SHARED_STRINGS_PART_PATH));

  const worksheetPaths: string[] = [];
  const sheets: SheetState[] = [];
  const hidden: string[] = [];
  const printEntries: { sheet: string; layout: PrintLayout }[] = [];
  const sheetFeatures: XlsxSheetFeatures[] = [];
  for (const ref of sheetRefs) {
    const declaration = targetById.get(ref.relationshipId);
    if (declaration === undefined) {
      throw new ValidationError(`工作表 ${JSON.stringify(ref.name)} 的 ${ref.relationshipId} 在关系表里不存在`);
    }
    if (declaration.target_mode === 'External') {
      throw new ValidationError(`工作表 ${JSON.stringify(ref.name)} 指向外部目标 ${declaration.target}：本仓不支持`);
    }
    const path = resolveRelationshipTarget(XLSX_WORKBOOK_PART_PATH, declaration.target);
    worksheetPaths.push(path);
    const worksheetRoot = requirePart(archive, path);
    const parsed = parseWorksheet(worksheetRoot, {
      sharedStrings,
      styles,
      where: `工作表 ${JSON.stringify(ref.name)}`,
    });
    let sheet = createSheet(ref.name, parsed.options);
    for (const cell of parsed.cells) {
      sheet = setCellValue(sheet, cell.ref, cell.value);
    }
    if (ref.hidden) hidden.push(ref.name);
    sheets.push(sheet);

    const defined = printDefined.get(ref.name) ?? { area: null, titles: null };
    const layout = parsePrintLayout(worksheetRoot, defined.area, defined.titles);
    if (!isDefaultLayout(layout)) {
      printEntries.push({ sheet: ref.name, layout });
    }
    sheetFeatures.push(
      Object.freeze({
        sheet: ref.name,
        protection: parseSheetProtection(worksheetRoot),
        data_validations: parseDataValidations(worksheetRoot),
        conditional_formats: parseConditionalFormats(worksheetRoot, differentialFormats),
      }),
    );
  }

  let workbook = createWorkbook(sheets);
  for (const name of hidden) {
    workbook = setSheetHidden(workbook, name, true);
  }
  const activeIndex = Math.min(Math.max(activeTab, 0), sheets.length - 1);
  const activeName = sheets[activeIndex]?.name;
  if (activeName !== undefined) {
    workbook = setActiveSheet(workbook, activeName);
  }

  return Object.freeze({
    workbook,
    residual: buildResidual(archive, contentTypes, worksheetPaths, workbookRelsRoot),
    print: Object.freeze({ entries: Object.freeze(printEntries.map((entry) => Object.freeze(entry))) }),
    differential_formats: differentialFormats,
    workbook_protection:
      workbookProtection === null ? null : parseWorkbookProtectionXml(serializeSheetFragment(workbookProtection)),
    sheet_features: Object.freeze(sheetFeatures),
  });
}

function buildResidual(
  archive: ReadZipArchive,
  contentTypes: ContentTypes,
  worksheetPaths: readonly string[],
  workbookRelsRoot: ParsedXmlElement | undefined,
): XlsxResidual {
  const known = knownParts(worksheetPaths);
  const parts: PreservedPart[] = [];
  for (const entry of archive.entries) {
    if (known.has(entry.path)) continue;
    parts.push(
      Object.freeze({
        path: entry.path,
        content_type: resolveContentType(entry.path, contentTypes),
        data: entry.data,
      }),
    );
  }

  const contentDefaults: ContentTypeDefault[] = [];
  for (const [extension, contentType] of contentTypes.defaults) {
    if (extension === 'rels') continue; // 本模块始终生成它；重复会破坏组装期校验
    contentDefaults.push({ extension, content_type: contentType });
  }

  const relationships: PreservedRelationshipGroup[] = [];
  const rootRels = parsePart(archive, '_rels/.rels');
  if (rootRels !== undefined) {
    relationships.push({
      owner_part_path: null,
      declarations: declarationsOf(parseRelationshipPart(rootRels, '_rels/.rels')),
    });
  }
  if (workbookRelsRoot !== undefined) {
    relationships.push({
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: declarationsOf(parseRelationshipPart(workbookRelsRoot, WORKBOOK_RELS_PART_PATH)),
    });
  }

  return Object.freeze({
    parts: Object.freeze(parts),
    content_type_defaults: Object.freeze(contentDefaults),
    relationships: Object.freeze(relationships.map((group) => Object.freeze(group))),
  });
}
