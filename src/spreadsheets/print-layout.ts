/**
 * 表格域：打印布局（design-06-P8 / XLS-16）。
 *
 * ## 这个文件要证明的事
 *
 * XLS-16 的验收句是「打印区域、方向、纸张、边距、重复标题行/列、分页、缩放、页眉页脚」，
 * 而且**分页信息必须落进文件**——不能只把当前可见首屏导出了事。
 *
 * 落进文件靠的是 OOXML 里四样真实存在的东西：
 *
 * | 打印概念 | 落在哪 |
 * |---|---|
 * | 打印区域 | `xl/workbook.xml` 的 `<definedNames>` 里 `name="_xlnm.Print_Area"` 的**绝对**区域 |
 * | 重复标题行/列 | 同上的 `name="_xlnm.Print_Titles"` |
 * | 方向 / 纸张 / 缩放 | 工作表 XML 的 `<pageSetup>`（适配页宽高另需 `<sheetPr><pageSetUpPr fitToPage="1"/>`） |
 * | 边距 | 工作表 XML 的 `<pageMargins>` |
 * | 页眉页脚 | 工作表 XML 的 `<headerFooter>`（`&L/&C/&R`、`&P` 页码等格式码） |
 * | 分页 | 工作表 XML 的 `<rowBreaks>` / `<colBreaks>`（手工分页符 `man="1"`） |
 * | 网格线 / 标题居中 | 工作表 XML 的 `<printOptions>` |
 *
 * ## 为什么不是"导出可见首屏"
 *
 * 可见首屏导出等于**丢掉 rowBreaks / colBreaks / Print_Area**：文件在 Excel 里再打开时
 * 分页、打印区域、重复标题全部丢失。本模块把这些信息**显式序列化进 XML**，并且用例的判据是
 * 「把产出的 XML **读回来**里面有没有这些元素」——而不是"函数返回了东西"。
 *
 * ## 与文件所有权的关系（如实登记）
 *
 * 本文件**只产出 OOXML 片段 / 提供注入函数**，不修改 `xlsx-write.ts`（同波其它包的所有权）。
 * {@link insertSheetPrintXml} / {@link insertDefinedNamesXml} 接收**既有工作表 / 工作簿 XML 文本**
 * （例如 `xlsx-write.ts` 的 `buildSheetXml()` / `buildWorkbookXml()` 的产出），把打印元素
 * 按 **CT_Worksheet / CT_Workbook 的序列位置**插进去再序列化回来。因此本模块产出的字节
 * 是**可直接写进 .xlsx 部件**的。
 *
 * ## 未验证边界（不编造）
 *
 * 真实打印机 / PDF 消费端本轮**没有**：本模块产出的是 Excel 打印设置的**文件表示**，
 * 「真实 Excel / 安卓端按这些设置出纸」属**未验证（需真机 / 消费端）**。
 * `_xlnm.Print_Titles` 里"列在前、行在后"的书写顺序是本模块的固定选择，
 * 与真实 Excel 的接受度同样**未验证（需真机 / 消费端）**。
 */

import {
  XML_DECLARATION,
  attr,
  el,
  formatDecimal,
  serializeXmlNode,
  type XmlElement,
} from '../artifacts/ooxml/index.js';
import {
  parseXml,
  serializeParsedXmlNode,
  type ParsedXmlElement,
  type ParsedXmlNode,
} from '../documents/docx/xml-parse.js';
import { ValidationError } from '../protocol/index.js';
import {
  MAX_COLUMN_NUMBER,
  MAX_ROW_NUMBER,
  columnLettersToNumber,
  columnNumberToLetters,
  parseRange,
  type CellRange,
} from './reference.js';

// ---------------------------------------------------------------------------
// 纸张 / 方向 / 缩放
// ---------------------------------------------------------------------------

/** 页面方向。 */
export type PageOrientation = 'portrait' | 'landscape';

/**
 * 多页打印顺序（`<pageSetup pageOrder>`）。
 *
 * - `down_then_over`：先把一列页带自上而下打完，再移到右侧列带（OOXML `downThenOver`，其**默认值**）。
 * - `over_then_down`：先自左向右打完一行页带，再下移（OOXML `overThenDown`）。
 *
 * 本模块**只写用户显式设置的顺序**；未设置（`null`）时不写该属性，交给消费端默认。
 * 真实 Excel 的默认取值为 `downThenOver`（本模块不声称与某一具体 Excel 版本的默认一致，属未验证）。
 */
export type PageOrder = 'down_then_over' | 'over_then_down';

/** 纸张名（受支持的白名单；值是 ECMA-376 的 `paperSize` 编号）。 */
export type PaperSizeName =
  | 'letter'
  | 'letter_small'
  | 'tabloid'
  | 'ledger'
  | 'legal'
  | 'statement'
  | 'executive'
  | 'a3'
  | 'a4'
  | 'a4_small'
  | 'a5'
  | 'b4'
  | 'b5'
  | 'folio'
  | 'quarto';

/** 纸张名 → `paperSize` 编号（ECMA-376 §18.18.55 的固定编号，不是自定义）。 */
export const PAPER_SIZES: Readonly<Record<PaperSizeName, number>> = Object.freeze({
  letter: 1,
  letter_small: 2,
  tabloid: 3,
  ledger: 4,
  legal: 5,
  statement: 6,
  executive: 7,
  a3: 8,
  a4: 9,
  a4_small: 10,
  a5: 11,
  b4: 12,
  b5: 13,
  folio: 14,
  quarto: 15,
});

/**
 * 纸张名的**物理尺寸**（英寸，纵向 = 宽 × 高）。给分页计算（X09）用。
 *
 * 这些是各纸张的**标称**尺寸；横向由调用方交换宽高得到。尺寸取标准 ISO/US 标称值，
 * 是布局计算的输入，**不**断言与真实打印机纸盒完全一致（那属未验证，需真机）。
 */
export const PAPER_DIMENSIONS_INCHES: Readonly<Record<PaperSizeName, readonly [number, number]>> = Object.freeze({
  letter: Object.freeze([8.5, 11] as const),
  letter_small: Object.freeze([8.5, 11] as const),
  tabloid: Object.freeze([11, 17] as const),
  ledger: Object.freeze([17, 11] as const),
  legal: Object.freeze([8.5, 14] as const),
  statement: Object.freeze([5.5, 8.5] as const),
  executive: Object.freeze([7.25, 10.5] as const),
  a3: Object.freeze([11.69, 16.54] as const),
  a4: Object.freeze([8.27, 11.69] as const),
  a4_small: Object.freeze([8.27, 11.69] as const),
  a5: Object.freeze([5.83, 8.27] as const),
  b4: Object.freeze([9.84, 13.9] as const),
  b5: Object.freeze([6.93, 9.84] as const),
  folio: Object.freeze([8.5, 13] as const),
  quarto: Object.freeze([8.5, 10.83] as const),
});

/**
 * 缩放：要么按百分比（`scale`），要么按页宽高适配（`fitToWidth` / `fitToHeight`）。
 *
 * **二者互斥**：Excel 里同时给 `scale` 与 `fitTo*` 是矛盾设置。本模块用**单一字段**
 * （{@link PrintLayout.scaling}）表达，因此"同时设置"**连写都写不出来**；
 * 两个 setter 后者覆盖前者，且每次覆盖都返回新状态。
 */
export type PrintScaling =
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'fit_to_pages'; readonly width: number; readonly height: number };

// ---------------------------------------------------------------------------
// 边距
// ---------------------------------------------------------------------------

/** 页边距（英寸；`header` / `footer` 是页眉页脚距页边的距离）。 */
export interface PageMargins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly header: number;
  readonly footer: number;
}

/** Excel 默认页边距（英寸）。 */
export const DEFAULT_MARGINS: PageMargins = Object.freeze({
  left: 0.7,
  right: 0.7,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3,
});

// ---------------------------------------------------------------------------
// 页眉页脚 / 打印选项
// ---------------------------------------------------------------------------

/**
 * 页眉页脚文本（Excel 的格式码：`&L` 左、`&C` 中、`&R` 右、`&P` 页码、`&N` 总页数）。
 *
 * `even_*` 只有 `different_odd_even` 为真才有意义；`first_*` 只有 `different_first` 为真才有意义。
 * **无意义的字段会被拒绝**（见 {@link setHeaderFooter}），不做静默丢弃——
 * 静默丢弃会让调用方以为"设了奇偶页不同"，实际文件里根本没有。
 */
export interface PageHeaderFooter {
  readonly odd_header?: string;
  readonly odd_footer?: string;
  readonly even_header?: string;
  readonly even_footer?: string;
  readonly first_header?: string;
  readonly first_footer?: string;
  readonly different_odd_even?: boolean;
  readonly different_first?: boolean;
  readonly scale_with_doc?: boolean;
  readonly align_with_margins?: boolean;
}

/** 打印选项（`<printOptions>`）。只写显式给出的项。 */
export interface PrintOptions {
  readonly grid_lines?: boolean;
  readonly headings?: boolean;
  readonly horizontal_centered?: boolean;
  readonly vertical_centered?: boolean;
}

// ---------------------------------------------------------------------------
// 布局状态
// ---------------------------------------------------------------------------

/**
 * 一张工作表的打印布局（不可变）。
 *
 * 所有字段都可为 `null`：`null` 表示**未设置**，序列化时**不写对应属性 / 元素**
 * （而不是写一个"默认值"冒充用户设置）。
 */
export interface PrintLayout {
  /**
   * 打印区域的**绝对**区域文本（如 `$A$1:$G$20`）；`null` = 未设置。
   *
   * **多区域**用逗号分隔（如 `$A$1:$G$20,$E$1:$E$20`）——这是 Excel 用一份
   * `_xlnm.Print_Area` 表达多个不连续打印区域的形状。经 {@link parsePrintAreas} 归一化、
   * 由 {@link parsePrintAreaDefinedName} 可解析回文本。
   */
  readonly print_area: string | null;
  readonly orientation: PageOrientation | null;
  readonly paper_size: PaperSizeName | null;
  readonly margins: PageMargins | null;
  /** 重复标题**行**（如 `1:3`，即第 1–3 行）；`null` = 未设置。 */
  readonly repeat_rows: string | null;
  /** 重复标题**列**（如 `A:B`）；`null` = 未设置。 */
  readonly repeat_columns: string | null;
  readonly scaling: PrintScaling | null;
  readonly header_footer: PageHeaderFooter | null;
  readonly options: PrintOptions | null;
  /** 手工**行**分页符：在这些行**之后**分页（1 起）。 */
  readonly row_breaks: readonly number[];
  /** 手工**列**分页符：在这些列**之后**分页（1 起）。 */
  readonly column_breaks: readonly number[];
  /**
   * 多页打印顺序；`null` / 缺省 = 未设置（不写 `pageOrder` 属性）。
   * 可选，以兼容既有构造点。
   */
  readonly page_order?: PageOrder | null;
}

/** 空布局：所有字段未设置。 */
export const EMPTY_PRINT_LAYOUT: PrintLayout = Object.freeze({
  print_area: null,
  orientation: null,
  paper_size: null,
  margins: null,
  repeat_rows: null,
  repeat_columns: null,
  scaling: null,
  header_footer: null,
  options: null,
  row_breaks: Object.freeze([]) as readonly number[],
  column_breaks: Object.freeze([]) as readonly number[],
  page_order: null,
});

/** {@link createPrintLayout} 的输入形态（原始文本 / 组合对象，由各 setter 校验）。 */
export interface PrintLayoutInput {
  readonly print_area?: string;
  readonly orientation?: PageOrientation;
  readonly paper_size?: PaperSizeName;
  readonly margins?: PageMargins;
  readonly repeat_rows?: string;
  readonly repeat_columns?: string;
  readonly scaling?: PrintScaling;
  readonly header_footer?: PageHeaderFooter;
  readonly options?: PrintOptions;
  readonly row_breaks?: readonly number[];
  readonly column_breaks?: readonly number[];
  readonly page_order?: PageOrder;
}

function withLayout(layout: PrintLayout, patch: Partial<PrintLayout>): PrintLayout {
  return Object.freeze({ ...layout, ...patch });
}

// ---------------------------------------------------------------------------
// 校验助手
// ---------------------------------------------------------------------------

function requireIntegerInRange(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${where} 必须是 ${String(min)}…${String(max)} 的整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${where} 必须是布尔值，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${where} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 英寸：非负有限数；输出时定点到 1e-6 英寸（不经过浮点乘除）。 */
function formatInches(value: number, where: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${where} 必须是非负有限数（英寸），收到 ${JSON.stringify(value)}`);
  }
  const text = formatDecimal(value, 6);
  if (!text.includes('.')) {
    return text;
  }
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function absoluteRangeText(range: CellRange): string {
  const start = `$${columnNumberToLetters(range.start.column)}$${String(range.start.row)}`;
  const end = `$${columnNumberToLetters(range.end.column)}$${String(range.end.row)}`;
  return start === end ? start : `${start}:${end}`;
}

// ---------------------------------------------------------------------------
// 打印区域（单区域 / 多区域）
// ---------------------------------------------------------------------------

/**
 * 在**引号外**按分隔符切分。
 *
 * 工作表名可以包含逗号（如 `'季度,汇总'!A1`），此时名字被单引号包裹；引号内的逗号
 * **不是**区域分隔符。本函数按此规则切分，避免把 `'a,b'!A1` 从中间劈开。
 */
function splitOutsideQuotes(text: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let buffer = '';
  let inQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "'") {
      if (inQuote && text[index + 1] === "'") {
        buffer += "''";
        index += 1;
        continue;
      }
      inQuote = !inQuote;
      buffer += char;
      continue;
    }
    if (char === separator && !inQuote) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

/** 引号外**最后一个** `target` 字符的下标；无则 `-1`。 */
function lastIndexOfOutsideQuotes(text: string, target: string): number {
  let found = -1;
  let inQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "'") {
      if (inQuote && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      inQuote = !inQuote;
      continue;
    }
    if (char === target && !inQuote) {
      found = index;
    }
  }
  return found;
}

/** 去单引号还原工作表名（内部 `''` 折回 `'`）。 */
function unquoteSheetName(reference: string): string {
  const trimmed = reference.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * 解析打印区域文本为**规范化绝对区域**列表。
 *
 * 支持**逗号分隔的多区域**（`"A1:G20,E1:E20"` ⇒ `['$A$1:$G$20', '$E$1:$E$20']`）：
 * Excel 用一份 `_xlnm.Print_Area` 表达多个不连续打印区域时就是这种形状。
 * 逐段经 {@link parseRange} 校验（越界 / 非法 ⇒ 抛），完全相同段**去重**（保持首次出现顺序）。
 *
 * @throws {ValidationError} 空串 / 空段 / 非法区域
 */
export function parsePrintAreas(text: string): readonly string[] {
  const source = requireText(text, 'print_area');
  const parts = splitOutsideQuotes(source, ',');
  const seen = new Set<string>();
  const areas: string[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) {
      throw new ValidationError(`print_area 的逗号分隔列表含空段：${JSON.stringify(text)}`);
    }
    const area = absoluteRangeText(parseRange(part));
    if (!seen.has(area)) {
      seen.add(area);
      areas.push(area);
    }
  }
  /* c8 ignore next -- requireText 已挡下空串，逗号切分至少产生一段，此处为防御 */
  if (areas.length === 0) {
    throw new ValidationError('print_area 不能为空');
  }
  return Object.freeze(areas);
}

/** 把绝对区域列表**序列化**为打印区域文本（逗号分隔，多区域保持给定顺序）。 */
export function formatPrintArea(areas: readonly string[]): string {
  return areas.join(',');
}

/** 归一化打印区域：解析后重建为**两端绝对**（多区域则逗号分隔）的文本。@throws {ValidationError} */
function normalizePrintArea(area: string): string {
  return formatPrintArea(parsePrintAreas(area));
}

/**
 * 从 `_xlnm.Print_Area` 正文解析回**归一化打印区域文本**。
 *
 * 输入是 definedName 里的**带表名前缀**正文（多区域时每段各带前缀），例如
 * `'预算'!$A$1:$G$20,'预算'!$E$1:$E$20` ⇒ `'$A$1:$G$20,$E$1:$E$20'`。
 * 表名前缀在**引号外**按 `!` 切分，因此名字里含 `,` / `!` 的工作表也解析正确。
 *
 * 给定 `sheet` 时，每段的表名前缀必须与之相符，否则**显式抛错**（不静默取末段）。
 * 不给定 `sheet` 时只去前缀、不校验。
 *
 * @throws {ValidationError} 空串 / 空段 / 非法区域 / 表名前缀不符
 */
export function parsePrintAreaDefinedName(text: string, sheet?: string): string {
  const source = requireText(text, 'print_area definedName');
  const segments = splitOutsideQuotes(source, ',');
  const seen = new Set<string>();
  const areas: string[] = [];
  for (const rawSegment of segments) {
    const segment = rawSegment.trim();
    if (segment.length === 0) {
      throw new ValidationError(`_xlnm.Print_Area 含空段：${JSON.stringify(text)}`);
    }
    const bang = lastIndexOfOutsideQuotes(segment, '!');
    const sheetReference = bang < 0 ? null : segment.slice(0, bang);
    const rangeText = bang < 0 ? segment : segment.slice(bang + 1);
    if (sheet !== undefined && sheetReference !== null) {
      const name = unquoteSheetName(sheetReference);
      if (name !== sheet) {
        throw new ValidationError(
          `_xlnm.Print_Area 的表名前缀 ${JSON.stringify(name)} 与工作表 ${JSON.stringify(sheet)} 不符`,
        );
      }
    }
    const area = absoluteRangeText(parseRange(rangeText.trim()));
    if (!seen.has(area)) {
      seen.add(area);
      areas.push(area);
    }
  }
  /* c8 ignore next -- requireText 已挡下空串，逗号切分至少产生一段，此处为防御 */
  if (areas.length === 0) {
    throw new ValidationError('_xlnm.Print_Area 不能为空');
  }
  return areas.join(',');
}

/** 归一化重复标题行 `"1:3"`。@throws {ValidationError} */
function normalizeRepeatRows(text: string): string {
  const match = /^(\d{1,7}):(\d{1,7})$/.exec(requireText(text, 'repeat_rows').trim());
  if (match === null) {
    throw new ValidationError(`repeat_rows 必须是 "起始行:结束行"（如 "1:3"），收到 ${JSON.stringify(text)}`);
  }
  const start = Number.parseInt(match[1] as string, 10);
  const end = Number.parseInt(match[2] as string, 10);
  if (start < 1 || end > MAX_ROW_NUMBER || start > end) {
    throw new ValidationError(
      `repeat_rows 越界或顺序颠倒：${JSON.stringify(text)}（须 1 ≤ 起始 ≤ 结束 ≤ ${String(MAX_ROW_NUMBER)}）`,
    );
  }
  return `${String(start)}:${String(end)}`;
}

/** 归一化重复标题列 `"A:B"`（大小写归一为大写）。@throws {ValidationError} */
function normalizeRepeatColumns(text: string): string {
  const match = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(requireText(text, 'repeat_columns').trim());
  if (match === null) {
    throw new ValidationError(`repeat_columns 必须是 "起始列:结束列"（如 "A:B"），收到 ${JSON.stringify(text)}`);
  }
  const start = columnLettersToNumber(match[1] as string);
  const end = columnLettersToNumber(match[2] as string);
  if (start > end) {
    throw new ValidationError(`repeat_columns 顺序颠倒：${JSON.stringify(text)}`);
  }
  return `${columnNumberToLetters(start)}:${columnNumberToLetters(end)}`;
}

function normalizeBreaks(values: readonly number[], max: number, where: string): readonly number[] {
  if (!Array.isArray(values)) {
    throw new ValidationError(`${where} 必须是数组`);
  }
  const unique = new Set<number>();
  for (const value of values) {
    unique.add(requireIntegerInRange(value, 1, max, where));
  }
  return Object.freeze([...unique].sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// 构造 / setter（全部纯函数，返回新布局）
// ---------------------------------------------------------------------------

/** 创建打印布局（缺省 = 全部未设置）。各字段经对应 setter 校验。@throws {ValidationError} */
export function createPrintLayout(input: PrintLayoutInput = {}): PrintLayout {
  let layout = EMPTY_PRINT_LAYOUT;
  if (input.print_area !== undefined) layout = setPrintArea(layout, input.print_area);
  if (input.orientation !== undefined) layout = setOrientation(layout, input.orientation);
  if (input.paper_size !== undefined) layout = setPaperSize(layout, input.paper_size);
  if (input.margins !== undefined) layout = setMargins(layout, input.margins);
  if (input.repeat_rows !== undefined || input.repeat_columns !== undefined) {
    layout = setPrintTitles(layout, { rows: input.repeat_rows, columns: input.repeat_columns });
  }
  if (input.scaling !== undefined) layout = setScaling(layout, input.scaling);
  if (input.header_footer !== undefined) layout = setHeaderFooter(layout, input.header_footer);
  if (input.options !== undefined) layout = setPrintOptions(layout, input.options);
  if (input.row_breaks !== undefined || input.column_breaks !== undefined) {
    layout = setPageBreaks(layout, { rows: input.row_breaks, columns: input.column_breaks });
  }
  if (input.page_order !== undefined) layout = setPageOrder(layout, input.page_order);
  return layout;
}

/** 设置打印区域（`null` = 清除）。输入会被归一化为绝对区域。@throws {ValidationError} */
export function setPrintArea(layout: PrintLayout, area: string | null): PrintLayout {
  return withLayout(layout, { print_area: area === null ? null : normalizePrintArea(area) });
}

/** 设置页面方向。@throws {ValidationError} 非 `portrait` / `landscape` */
export function setOrientation(layout: PrintLayout, orientation: PageOrientation): PrintLayout {
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new ValidationError(`orientation 只能是 portrait / landscape，收到 ${JSON.stringify(orientation)}`);
  }
  return withLayout(layout, { orientation });
}

/** 设置纸张。@throws {ValidationError} 不在 {@link PAPER_SIZES} 白名单 */
export function setPaperSize(layout: PrintLayout, paper: PaperSizeName): PrintLayout {
  if (!Object.prototype.hasOwnProperty.call(PAPER_SIZES, paper)) {
    throw new ValidationError(
      `未知纸张 ${JSON.stringify(paper)}；受支持的纸张名：${Object.keys(PAPER_SIZES).join(' / ')}`,
    );
  }
  return withLayout(layout, { paper_size: paper });
}

/** 设置页边距（英寸，非负有限数）。@throws {ValidationError} */
export function setMargins(layout: PrintLayout, margins: PageMargins): PrintLayout {
  if (typeof margins !== 'object' || margins === null) {
    throw new ValidationError('margins 必须是对象');
  }
  const fields: readonly (keyof PageMargins)[] = ['left', 'right', 'top', 'bottom', 'header', 'footer'];
  for (const field of fields) {
    formatInches(margins[field], `margins.${field}`);
  }
  return withLayout(layout, { margins: Object.freeze({ ...margins }) });
}

/**
 * 设置重复标题行 / 列（`null` = 清除该轴）。
 * @throws {ValidationError} 文本形态非法或越界
 */
export function setPrintTitles(
  layout: PrintLayout,
  titles: { readonly rows?: string | null; readonly columns?: string | null },
): PrintLayout {
  const patch: { repeat_rows?: string | null; repeat_columns?: string | null } = {};
  if (titles.rows !== undefined) {
    patch.repeat_rows = titles.rows === null ? null : normalizeRepeatRows(titles.rows);
  }
  if (titles.columns !== undefined) {
    patch.repeat_columns = titles.columns === null ? null : normalizeRepeatColumns(titles.columns);
  }
  return withLayout(layout, patch);
}

/** 设置缩放（百分比，10–400）。@throws {ValidationError} */
export function setScalePercent(layout: PrintLayout, percent: number): PrintLayout {
  const value = requireIntegerInRange(percent, 10, 400, 'setScalePercent');
  return withLayout(layout, { scaling: Object.freeze({ kind: 'percent' as const, percent: value }) });
}

/**
 * 设置"适配页宽高"。`width` / `height` 为 0 表示该方向**不限页数**（Excel 语义）；
 * 两者同时为 0 无意义，拒绝。
 * @throws {ValidationError}
 */
export function setFitToPages(layout: PrintLayout, width: number, height: number): PrintLayout {
  const w = requireIntegerInRange(width, 0, 32767, 'setFitToPages.width');
  const h = requireIntegerInRange(height, 0, 32767, 'setFitToPages.height');
  if (w === 0 && h === 0) {
    throw new ValidationError('setFitToPages 的 width / height 不能同时为 0（那等于不设缩放）');
  }
  return withLayout(layout, {
    scaling: Object.freeze({ kind: 'fit_to_pages' as const, width: w, height: h }),
  });
}

/** 设置缩放（判别联合形态）。@throws {ValidationError} */
export function setScaling(layout: PrintLayout, scaling: PrintScaling): PrintLayout {
  if (typeof scaling !== 'object' || scaling === null) {
    throw new ValidationError('scaling 必须是对象');
  }
  return scaling.kind === 'percent'
    ? setScalePercent(layout, scaling.percent)
    : setFitToPages(layout, scaling.width, scaling.height);
}

/**
 * 设置页眉页脚。`even_*` 需 `different_odd_even`、`first_*` 需 `different_first`，
 * 否则**显式拒绝**（不静默丢弃）。
 * @throws {ValidationError}
 */
export function setHeaderFooter(layout: PrintLayout, headerFooter: PageHeaderFooter | null): PrintLayout {
  if (headerFooter === null) {
    return withLayout(layout, { header_footer: null });
  }
  if (typeof headerFooter !== 'object') {
    throw new ValidationError('header_footer 必须是对象或 null');
  }
  const differentOddEven = headerFooter.different_odd_even ?? false;
  const differentFirst = headerFooter.different_first ?? false;
  if (typeof differentOddEven !== 'boolean' || typeof differentFirst !== 'boolean') {
    throw new ValidationError('different_odd_even / different_first 必须是布尔值');
  }
  if (!differentOddEven && (headerFooter.even_header !== undefined || headerFooter.even_footer !== undefined)) {
    throw new ValidationError(
      '设置了 even_header / even_footer 却未开启 different_odd_even：偶页页眉页脚不会生效，拒绝静默丢弃',
    );
  }
  if (!differentFirst && (headerFooter.first_header !== undefined || headerFooter.first_footer !== undefined)) {
    throw new ValidationError(
      '设置了 first_header / first_footer 却未开启 different_first：首页页眉页脚不会生效，拒绝静默丢弃',
    );
  }
  const slots: readonly (keyof PageHeaderFooter)[] = [
    'odd_header',
    'odd_footer',
    'even_header',
    'even_footer',
    'first_header',
    'first_footer',
  ];
  let hasContent = false;
  for (const slot of slots) {
    const value = headerFooter[slot];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new ValidationError(`${slot} 必须是字符串`);
    }
    hasContent = true;
  }
  if (!hasContent) {
    throw new ValidationError('header_footer 未给出任何页眉 / 页脚内容');
  }
  return withLayout(layout, { header_footer: Object.freeze({ ...headerFooter }) });
}

/** 设置打印选项。未给出的项不写。@throws {ValidationError} */
export function setPrintOptions(layout: PrintLayout, options: PrintOptions | null): PrintLayout {
  if (options === null) {
    return withLayout(layout, { options: null });
  }
  if (typeof options !== 'object') {
    throw new ValidationError('options 必须是对象或 null');
  }
  const fields: readonly (keyof PrintOptions)[] = [
    'grid_lines',
    'headings',
    'horizontal_centered',
    'vertical_centered',
  ];
  for (const field of fields) {
    if (options[field] !== undefined) requireBoolean(options[field], `options.${field}`);
  }
  return withLayout(layout, { options: Object.freeze({ ...options }) });
}

/**
 * 设置手工分页符（在这些行 / 列**之后**分页）。`null` = 清除该轴。
 * @throws {ValidationError} 越界 / 非整数
 */
export function setPageBreaks(
  layout: PrintLayout,
  breaks: { readonly rows?: readonly number[] | null; readonly columns?: readonly number[] | null },
): PrintLayout {
  const patch: { row_breaks?: readonly number[]; column_breaks?: readonly number[] } = {};
  if (breaks.rows !== undefined) {
    patch.row_breaks = breaks.rows === null ? Object.freeze([]) : normalizeBreaks(breaks.rows, MAX_ROW_NUMBER, 'row_breaks');
  }
  if (breaks.columns !== undefined) {
    patch.column_breaks =
      breaks.columns === null ? Object.freeze([]) : normalizeBreaks(breaks.columns, MAX_COLUMN_NUMBER, 'column_breaks');
  }
  return withLayout(layout, patch);
}

/** 设置多页打印顺序（`null` = 清除）。@throws {ValidationError} 非 `down_then_over` / `over_then_down` */
export function setPageOrder(layout: PrintLayout, order: PageOrder | null): PrintLayout {
  if (order !== null && order !== 'down_then_over' && order !== 'over_then_down') {
    throw new ValidationError(
      `page_order 只能是 down_then_over / over_then_down / null，收到 ${JSON.stringify(order)}`,
    );
  }
  return withLayout(layout, { page_order: order });
}

/** 是否"什么都没设"（此时不产出任何打印元素，文件字节不变）。 */
export function isDefaultPrintLayout(layout: PrintLayout): boolean {
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
// OOXML 片段
// ---------------------------------------------------------------------------

function boolAttr(value: boolean): string {
  return value ? '1' : '0';
}

/** `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`：适配页宽高**必须**有它才生效。 */
export function buildSheetPrFitToPage(): XmlElement {
  return el('sheetPr', [], [el('pageSetUpPr', [attr('fitToPage', '1')])]);
}

/** `<pageSetup>`；无任何可写属性时返回 `null`。 */
export function buildPageSetupElement(layout: PrintLayout): XmlElement | null {
  const attributes = [];
  if (layout.paper_size !== null) {
    attributes.push(attr('paperSize', String(PAPER_SIZES[layout.paper_size])));
  }
  if (layout.scaling !== null) {
    if (layout.scaling.kind === 'percent') {
      attributes.push(attr('scale', String(layout.scaling.percent)));
    } else {
      attributes.push(attr('fitToWidth', String(layout.scaling.width)));
      attributes.push(attr('fitToHeight', String(layout.scaling.height)));
    }
  }
  if (layout.page_order !== undefined && layout.page_order !== null) {
    attributes.push(attr('pageOrder', layout.page_order === 'over_then_down' ? 'overThenDown' : 'downThenOver'));
  }
  if (layout.orientation !== null) {
    attributes.push(attr('orientation', layout.orientation));
  }
  return attributes.length === 0 ? null : el('pageSetup', attributes);
}

/** `<pageMargins>`；未设置边距时返回 `null`。 */
export function buildPageMarginsElement(layout: PrintLayout): XmlElement | null {
  if (layout.margins === null) {
    return null;
  }
  const m = layout.margins;
  return el('pageMargins', [
    attr('left', formatInches(m.left, 'margins.left')),
    attr('right', formatInches(m.right, 'margins.right')),
    attr('top', formatInches(m.top, 'margins.top')),
    attr('bottom', formatInches(m.bottom, 'margins.bottom')),
    attr('header', formatInches(m.header, 'margins.header')),
    attr('footer', formatInches(m.footer, 'margins.footer')),
  ]);
}

/** `<printOptions>`；未设置时返回 `null`。 */
export function buildPrintOptionsElement(layout: PrintLayout): XmlElement | null {
  const options = layout.options;
  if (options === null) {
    return null;
  }
  const attributes = [];
  if (options.grid_lines !== undefined) attributes.push(attr('gridLines', boolAttr(options.grid_lines)));
  if (options.headings !== undefined) attributes.push(attr('headings', boolAttr(options.headings)));
  if (options.horizontal_centered !== undefined) {
    attributes.push(attr('horizontalCentered', boolAttr(options.horizontal_centered)));
  }
  if (options.vertical_centered !== undefined) {
    attributes.push(attr('verticalCentered', boolAttr(options.vertical_centered)));
  }
  return attributes.length === 0 ? null : el('printOptions', attributes);
}

/** `<headerFooter>`；未设置时返回 `null`。子元素顺序 = CT_HeaderFooter 序列。 */
export function buildHeaderFooterElement(layout: PrintLayout): XmlElement | null {
  const hf = layout.header_footer;
  if (hf === null) {
    return null;
  }
  const attributes = [];
  if (hf.different_first === true) attributes.push(attr('differentFirst', '1'));
  if (hf.different_odd_even === true) attributes.push(attr('differentOddEven', '1'));
  if (hf.scale_with_doc === false) attributes.push(attr('scaleWithDoc', '0'));
  if (hf.align_with_margins === false) attributes.push(attr('alignWithMargins', '0'));
  const children: XmlElement[] = [];
  const slots: readonly (readonly [keyof PageHeaderFooter, string])[] = [
    ['odd_header', 'oddHeader'],
    ['odd_footer', 'oddFooter'],
    ['even_header', 'evenHeader'],
    ['even_footer', 'evenFooter'],
    ['first_header', 'firstHeader'],
    ['first_footer', 'firstFooter'],
  ];
  for (const [field, elementName] of slots) {
    const value = hf[field];
    if (typeof value === 'string') {
      children.push(el(elementName, [], [value]));
    }
  }
  return el('headerFooter', attributes, children);
}

// ---------------------------------------------------------------------------
// 页眉页脚格式码：解析 / 序列化 / 展开
// ---------------------------------------------------------------------------

/**
 * 页眉页脚**字段码**（Excel format codes 里除分区码 `&L/&C/&R` 外的代码）。
 *
 * | 码 | 字段 | 语义 |
 * |---|---|---|
 * | `&P` | `page` | 当前页码 |
 * | `&N` | `total_pages` | 总页数 |
 * | `&D` | `date` | 当前日期 |
 * | `&T` | `time` | 当前时间 |
 * | `&F` | `file_name` | 工作簿文件名 |
 * | `&A` | `sheet_name` | 工作表（选项卡）名 |
 * | `&Z` | `file_path` | 文件完整路径 |
 * | `&G` | `picture` | 图片（正文里是二进制引用，本模块只识别、不展开） |
 *
 * 这些码写进文件时**原样保留**（{@link buildHeaderFooterElement} 把字符串直接放进
 * `<oddHeader>` 等元素），由消费端（Excel / WPS / 打印驱动）在出纸时解析。本模块额外提供
 * {@link tokenizeHeaderFooter} / {@link serializeHeaderFooterTokens} / {@link expandHeaderFooterFields}
 * 三个纯函数，供手机侧预览复用**同一张码表**，不必两边各写一份。
 */
export type HeaderFooterField =
  | 'page'
  | 'total_pages'
  | 'date'
  | 'time'
  | 'file_name'
  | 'sheet_name'
  | 'file_path'
  | 'picture';

/** 字段码字母 → 字段（Excel 里码字母大小写均可，故本表以**大写**为键）。 */
export const HEADER_FOOTER_FIELD_CODES: Readonly<Record<string, HeaderFooterField>> = Object.freeze({
  P: 'page',
  N: 'total_pages',
  D: 'date',
  T: 'time',
  F: 'file_name',
  A: 'sheet_name',
  Z: 'file_path',
  G: 'picture',
});

/** 字段 → 规范码字母（序列化用，大写）。 */
export const HEADER_FOOTER_FIELD_LETTERS: Readonly<Record<HeaderFooterField, string>> = Object.freeze({
  page: 'P',
  total_pages: 'N',
  date: 'D',
  time: 'T',
  file_name: 'F',
  sheet_name: 'A',
  file_path: 'Z',
  picture: 'G',
});

/** 页眉页脚分区码：`&L` 左 / `&C` 中 / `&R` 右。 */
export type HeaderFooterRegion = 'left' | 'center' | 'right';

const HEADER_FOOTER_REGION_CODES: Readonly<Record<string, HeaderFooterRegion>> = Object.freeze({
  L: 'left',
  C: 'center',
  R: 'right',
});

/** 页眉页脚文本解析后的一段令牌。 */
export type HeaderFooterToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'region'; readonly region: HeaderFooterRegion }
  | { readonly kind: 'field'; readonly field: HeaderFooterField }
  | { readonly kind: 'literal_ampersand' }
  | { readonly kind: 'unknown'; readonly text: string };

/**
 * 把页眉页脚文本**解析**成令牌序列。
 *
 * 识别：`&L/&C/&R`（分区）、`&P/&N/&D/&T/&F/&A/&Z/&G`（字段）、`&&`（字面 `&`）。
 * 其它 `&x` 序列（含末尾孤立的 `&`）归 `unknown` 并**原样保留**——不猜、不吞。
 */
export function tokenizeHeaderFooter(text: string): readonly HeaderFooterToken[] {
  if (typeof text !== 'string') {
    throw new ValidationError(`header/footer text 必须是字符串，收到 ${JSON.stringify(text)}`);
  }
  const tokens: HeaderFooterToken[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer.length > 0) {
      tokens.push(Object.freeze({ kind: 'text' as const, text: buffer }));
      buffer = '';
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char !== '&') {
      buffer += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      buffer += '&';
      continue;
    }
    const upper = next.toUpperCase();
    const region = HEADER_FOOTER_REGION_CODES[upper];
    const field = HEADER_FOOTER_FIELD_CODES[upper];
    if (region !== undefined) {
      flush();
      tokens.push(Object.freeze({ kind: 'region' as const, region }));
    } else if (field !== undefined) {
      flush();
      tokens.push(Object.freeze({ kind: 'field' as const, field }));
    } else if (next === '&') {
      flush();
      tokens.push(Object.freeze({ kind: 'literal_ampersand' as const }));
    } else {
      flush();
      tokens.push(Object.freeze({ kind: 'unknown' as const, text: `&${next}` }));
    }
    index += 1;
  }
  flush();
  return Object.freeze(tokens);
}

/**
 * 把令牌序列**序列化**回页眉页脚文本（与 {@link tokenizeHeaderFooter} 互逆，码字母规范为大写）。
 *
 * `text` / `unknown` 原样输出；分区输出 `&L/&C/&R`；字段输出规范大写码；字面 `&` 输出 `&&`。
 */
export function serializeHeaderFooterTokens(tokens: readonly HeaderFooterToken[]): string {
  let out = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out += token.text;
        break;
      case 'region':
        out += token.region === 'left' ? '&L' : token.region === 'right' ? '&R' : '&C';
        break;
      case 'field':
        out += `&${HEADER_FOOTER_FIELD_LETTERS[token.field]}`;
        break;
      case 'literal_ampersand':
        out += '&&';
        break;
      case 'unknown':
        out += token.text;
        break;
    }
  }
  return out;
}

/**
 * 展开字段码时提供的上下文值。**未提供的码原样保留**（不编造：日期 / 文件名 / 工作表名
 * 拿不到时，宁可留 `&D` 等消费端解析，也不填一个假值）。
 */
export interface HeaderFooterFieldContext {
  readonly page?: number;
  readonly total_pages?: number;
  readonly date?: string;
  readonly time?: string;
  readonly file_name?: string;
  readonly sheet_name?: string;
  readonly file_path?: string;
}

/** 取单个字段的展开文本；上下文未提供 ⇒ `null`（调用方保留原码）。 */
function resolveHeaderFooterField(field: HeaderFooterField, context: HeaderFooterFieldContext): string | null {
  switch (field) {
    case 'page':
      return context.page === undefined ? null : String(context.page);
    case 'total_pages':
      return context.total_pages === undefined ? null : String(context.total_pages);
    case 'date':
      return context.date ?? null;
    case 'time':
      return context.time ?? null;
    case 'file_name':
      return context.file_name ?? null;
    case 'sheet_name':
      return context.sheet_name ?? null;
    case 'file_path':
      return context.file_path ?? null;
    case 'picture':
      /* 图片是二进制引用，无法以文本展开；保留 &G 由消费端处理。 */
      return null;
  }
}

/**
 * 把文本里的字段码展开成具体值（`&D/&T/&F/&A` 及 `&P/&N/&Z`），`&&` → `&`。
 *
 * 分区码 `&L/&C/&R` **保留**（它们不是字段，是分区标记，交给分区函数处理）；
 * 上下文未提供的码、以及未识别的 `&x` 一律**原样保留**。
 */
export function expandHeaderFooterFields(text: string, context: HeaderFooterFieldContext): string {
  let out = '';
  for (const token of tokenizeHeaderFooter(text)) {
    switch (token.kind) {
      case 'text':
      case 'unknown':
        out += token.text;
        break;
      case 'literal_ampersand':
        out += '&';
        break;
      case 'region':
        out += serializeHeaderFooterTokens([token]);
        break;
      case 'field': {
        const resolved = resolveHeaderFooterField(token.field, context);
        out += resolved ?? serializeHeaderFooterTokens([token]);
        break;
      }
    }
  }
  return out;
}

/**
 * `<rowBreaks>` / `<colBreaks>`（手工分页符）。
 *
 * `brk` 的 `max` 是**另一轴的最后一个 0 起下标**（行分页符 `max=16383`，列分页符 `max=1048575`），
 * 照 Excel 的写法给出；`man="1"` 声明这是手工分页符（否则消费端会忽略）。
 */
export function buildRowBreaksElement(layout: PrintLayout): XmlElement | null {
  if (layout.row_breaks.length === 0) {
    return null;
  }
  const count = String(layout.row_breaks.length);
  return el('rowBreaks', [attr('count', count), attr('manualBreakCount', count)], [
    ...layout.row_breaks.map((row) =>
      el('brk', [attr('id', String(row)), attr('max', String(MAX_COLUMN_NUMBER - 1)), attr('man', '1')]),
    ),
  ]);
}

/** 列分页符 `<colBreaks>`；语义同 {@link buildRowBreaksElement}。 */
export function buildColumnBreaksElement(layout: PrintLayout): XmlElement | null {
  if (layout.column_breaks.length === 0) {
    return null;
  }
  const count = String(layout.column_breaks.length);
  return el('colBreaks', [attr('count', count), attr('manualBreakCount', count)], [
    ...layout.column_breaks.map((column) =>
      el('brk', [attr('id', String(column)), attr('max', String(MAX_ROW_NUMBER - 1)), attr('man', '1')]),
    ),
  ]);
}

/**
 * 一张工作表要写进 `<worksheet>` 的全部打印元素，**顺序 = CT_Worksheet 序列**：
 *
 * `sheetPr`（仅适配页宽高时）→ `printOptions` → `pageMargins` → `pageSetup` → `headerFooter`
 * → `rowBreaks` → `colBreaks`。
 *
 * 默认布局（什么都没设）⇒ 返回空数组（不往文件里写多余字节）。
 */
export function sheetPrintElements(layout: PrintLayout): readonly XmlElement[] {
  if (isDefaultPrintLayout(layout)) {
    return Object.freeze([]) as readonly XmlElement[];
  }
  const elements: XmlElement[] = [];
  if (layout.scaling !== null && layout.scaling.kind === 'fit_to_pages') {
    elements.push(buildSheetPrFitToPage());
  }
  const printOptions = buildPrintOptionsElement(layout);
  if (printOptions !== null) elements.push(printOptions);
  const margins = buildPageMarginsElement(layout);
  if (margins !== null) elements.push(margins);
  const pageSetup = buildPageSetupElement(layout);
  if (pageSetup !== null) elements.push(pageSetup);
  const headerFooter = buildHeaderFooterElement(layout);
  if (headerFooter !== null) elements.push(headerFooter);
  const rowBreaks = buildRowBreaksElement(layout);
  if (rowBreaks !== null) elements.push(rowBreaks);
  const columnBreaks = buildColumnBreaksElement(layout);
  if (columnBreaks !== null) elements.push(columnBreaks);
  return Object.freeze(elements);
}

// ---------------------------------------------------------------------------
// definedNames（打印区域 / 重复标题）
// ---------------------------------------------------------------------------

/** 打印计划：工作表名 → 打印布局（有序，键唯一）。 */
export interface PrintPlan {
  readonly entries: readonly { readonly sheet: string; readonly layout: PrintLayout }[];
}

/** 空计划。 */
export function createPrintPlan(): PrintPlan {
  return Object.freeze({ entries: Object.freeze([]) as PrintPlan['entries'] });
}

/** 设定某张表的打印布局（同名覆盖，保持原有顺序）。 */
export function setSheetPrint(plan: PrintPlan, sheet: string, layout: PrintLayout): PrintPlan {
  const name = requireText(sheet, 'setSheetPrint.sheet');
  const entries = plan.entries.filter((entry) => entry.sheet !== name);
  entries.push(Object.freeze({ sheet: name, layout }));
  return Object.freeze({ entries: Object.freeze(entries) });
}

/** 取某张表的打印布局。 */
export function getSheetPrint(plan: PrintPlan, sheet: string): PrintLayout | undefined {
  return plan.entries.find((entry) => entry.sheet === sheet)?.layout;
}

/**
 * 工作表名 → definedName 里的引用前缀。
 * 名字含非 `[A-Za-z0-9_.]` 字符（如中文、空格）时**必须**加单引号并把内部单引号翻倍。
 */
export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** 一条 `_xlnm.*` 打印名称。 */
export interface PrintDefinedName {
  readonly name: '_xlnm.Print_Area' | '_xlnm.Print_Titles';
  readonly sheet: string;
  readonly local_sheet_id: number;
  /** 名称正文（含 `工作表!区域`）。 */
  readonly text: string;
}

/**
 * 由打印计划与**工作表顺序**算出全部 `_xlnm.*` 打印名称。
 *
 * - `_xlnm.Print_Area`：`'预算'!$A$1:$G$20`
 * - `_xlnm.Print_Titles`：`'预算'!$A:$B,'预算'!$1:$3`（**本模块固定列在前、行在后**）
 *
 * 计划里的工作表若不在 `sheet_order` 里 ⇒ 抛（不静默丢弃：那等于把用户的打印设置丢掉）。
 * @throws {ValidationError}
 */
export function printDefinedNames(
  plan: PrintPlan,
  sheetOrder: readonly string[],
): readonly PrintDefinedName[] {
  const names: PrintDefinedName[] = [];
  for (const entry of plan.entries) {
    const localSheetId = sheetOrder.indexOf(entry.sheet);
    if (localSheetId < 0) {
      throw new ValidationError(
        `打印计划引用了工作簿里不存在的工作表 ${JSON.stringify(entry.sheet)}；工作簿只有：` +
          sheetOrder.map((name) => JSON.stringify(name)).join(', '),
      );
    }
    const prefix = quoteSheetName(entry.sheet);
    if (entry.layout.print_area !== null) {
      // 多区域：每段**各自**带表名前缀（Excel 的写法）。单区域时结果与旧实现逐字节一致。
      const areaText = parsePrintAreas(entry.layout.print_area)
        .map((area) => `${prefix}!${area}`)
        .join(',');
      names.push(
        Object.freeze({
          name: '_xlnm.Print_Area' as const,
          sheet: entry.sheet,
          local_sheet_id: localSheetId,
          text: areaText,
        }),
      );
    }
    const titleParts: string[] = [];
    if (entry.layout.repeat_columns !== null) {
      titleParts.push(`${prefix}!$${entry.layout.repeat_columns.replace(':', ':$')}`);
    }
    if (entry.layout.repeat_rows !== null) {
      titleParts.push(`${prefix}!$${entry.layout.repeat_rows.replace(':', ':$')}`);
    }
    if (titleParts.length > 0) {
      names.push(
        Object.freeze({
          name: '_xlnm.Print_Titles' as const,
          sheet: entry.sheet,
          local_sheet_id: localSheetId,
          text: titleParts.join(','),
        }),
      );
    }
  }
  return Object.freeze(names);
}

/**
 * `<definedNames>` 元素；没有任何打印名称时返回 `null`。
 *
 * 只有**打印区域 / 重复标题**会产生 definedName——方向、边距、分页等**不会**，
 * 它们写在 `<worksheet>` 里。这条边界是用例可断言的（见测试的反向对照）。
 */
export function buildDefinedNamesElement(plan: PrintPlan, sheetOrder: readonly string[]): XmlElement | null {
  const names = printDefinedNames(plan, sheetOrder);
  if (names.length === 0) {
    return null;
  }
  return el(
    'definedNames',
    [],
    names.map((entry) => el('definedName', [attr('name', entry.name), attr('localSheetId', String(entry.local_sheet_id))], [entry.text])),
  );
}

// ---------------------------------------------------------------------------
// 注入既有部件 XML（按 CT_Worksheet / CT_Workbook 序列插入）
// ---------------------------------------------------------------------------

/** CT_Worksheet 子元素的规范序列（ECMA-376 §18.3.1.99）。 */
const WORKSHEET_CHILD_ORDER: readonly string[] = Object.freeze([
  'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr',
  'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate',
  'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations',
  'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing',
  'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
]);

/** CT_Workbook 子元素的规范序列（ECMA-376 §18.2.27）。 */
const WORKBOOK_CHILD_ORDER: readonly string[] = Object.freeze([
  'fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets',
  'functionGroups', 'externalReferences', 'definedNames', 'calcPr', 'oleSize', 'customWorkbookViews',
  'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr',
  'webPublishObjects', 'extLst',
]);

/** 未知元素排在已知序列之后（尽力而为；生成器不会产出未知元素）。 */
const UNKNOWN_RANK = 1000;

function rankOf(order: readonly string[], localName: string): number {
  const index = order.indexOf(localName);
  return index < 0 ? UNKNOWN_RANK : index;
}

function toParsedElement(element: XmlElement): ParsedXmlElement {
  return parseXml(serializeXmlNode(element));
}

function removeByName(children: readonly ParsedXmlNode[], localName: string): ParsedXmlNode[] {
  return children.filter((child) => !(child.kind === 'element' && child.localName === localName));
}

function insertOrdered(
  children: ParsedXmlNode[],
  element: ParsedXmlElement,
  order: readonly string[],
): ParsedXmlNode[] {
  const rank = rankOf(order, element.localName);
  const out = [...children];
  for (let index = 0; index < out.length; index += 1) {
    const child = out[index];
    if (child === undefined || child.kind !== 'element') continue;
    if (rankOf(order, child.localName) > rank) {
      out.splice(index, 0, element);
      return out;
    }
  }
  out.push(element);
  return out;
}

/** 把 `<pageSetUpPr fitToPage="1"/>` 并进既有 `<sheetPr>`（或新建）；不动其它子元素。 */
function mergeSheetPr(children: readonly ParsedXmlNode[], wantsFitToPage: boolean): ParsedXmlNode[] {
  if (!wantsFitToPage) {
    return [...children];
  }
  const pageSetUpPr = toParsedElement(el('pageSetUpPr', [attr('fitToPage', '1')]));
  const index = children.findIndex((child) => child.kind === 'element' && child.localName === 'sheetPr');
  if (index < 0) {
    return [toParsedElement(buildSheetPrFitToPage()), ...children];
  }
  const existing = children[index] as ParsedXmlElement;
  const kept = existing.children.filter((child) => !(child.kind === 'element' && child.localName === 'pageSetUpPr'));
  const merged: ParsedXmlElement = Object.freeze({
    ...existing,
    children: Object.freeze([...kept, pageSetUpPr]) as readonly ParsedXmlNode[],
  });
  const out = [...children];
  out[index] = merged;
  return out;
}

function serializeRoot(root: ParsedXmlElement, children: readonly ParsedXmlNode[]): string {
  return `${XML_DECLARATION}\n${serializeParsedXmlNode(Object.freeze({ ...root, children: Object.freeze([...children]) }))}`;
}

/**
 * 把打印布局**注入既有工作表 XML**（例如 `xlsx-write.ts` 的 `buildSheetXml()` 产出）。
 *
 * 幂等：同名元素先移除再按序插入，重复调用不会产生重复的 `pageSetup`。
 * 既有元素（`sheetData` / `mergeCells` …）原样保留、顺序不变。
 *
 * @param worksheetXml `xl/worksheets/sheetN.xml` 的完整文本
 * @throws {XmlParseError} 输入不是合法 XML 文档
 */
export function insertSheetPrintXml(worksheetXml: string, layout: PrintLayout): string {
  if (isDefaultPrintLayout(layout)) {
    return worksheetXml;
  }
  const root = parseXml(worksheetXml);
  let children: ParsedXmlNode[] = [...root.children];
  const wantsFit = layout.scaling !== null && layout.scaling.kind === 'fit_to_pages';
  children = mergeSheetPr(children, wantsFit);
  for (const element of sheetPrintElements(layout)) {
    if (element.name === 'sheetPr') continue; // 已由 mergeSheetPr 处理
    const parsed = toParsedElement(element);
    children = removeByName(children, parsed.localName);
    children = insertOrdered(children, parsed, WORKSHEET_CHILD_ORDER);
  }
  return serializeRoot(root, children);
}

/**
 * 把 `_xlnm.Print_Area` / `_xlnm.Print_Titles` 注入既有工作簿 XML
 * （例如 `xlsx-write.ts` 的 `buildWorkbookXml()` 产出），插在 `<sheets>` 与 `<calcPr>` 之间。
 *
 * 计划里没有打印区域 / 重复标题时**原样返回**（不写空的 `<definedNames/>`）。
 *
 * @throws {ValidationError} 计划引用了不存在的工作表
 */
export function insertDefinedNamesXml(
  workbookXml: string,
  plan: PrintPlan,
  sheetOrder: readonly string[],
): string {
  const element = buildDefinedNamesElement(plan, sheetOrder);
  if (element === null) {
    return workbookXml;
  }
  const root = parseXml(workbookXml);
  let children: ParsedXmlNode[] = removeByName([...root.children], 'definedNames');
  children = insertOrdered(children, toParsedElement(element), WORKBOOK_CHILD_ORDER);
  return serializeRoot(root, children);
}
