/**
 * **X-R05 源模块 B：手机打印计划 ↔ 落盘打印设置的往返差异**。
 *
 * ## 差异从哪来（这是本模块存在的理由）
 *
 * 手机端 PDF 预览 / 打印分页的**事实来源**是内存里的 {@link PrintPlan}（`print-layout.ts`）。
 * 消费端（Excel / WPS / 真实打印机）出纸的**事实来源**是 .xlsx 文件里的
 * `<pageSetup>` / `<pageMargins>` / `<definedNames>` 等。
 *
 * 这两份数据由**两条不同的通道**承载：
 *
 * - 手机侧：`print-layout.ts` 的 `insertSheetPrintXml` / `insertDefinedNamesXml` 把设置**注入**
 *   既有工作表 / 工作簿 XML（这是本仓文档化的用法，因为 `writeWorkbookXlsx` **没有**打印布局入参）；
 * - 文件侧：本模块**独立从字节解析**（不经过 `xlsx-read.ts`——它**根本不读打印设置**）。
 *
 * 于是出现一类真实、可复现的差异：**手机显示了分页/打印区域，但文件里没有**，
 * 消费端按默认出纸 —— 这正是"手机 PDF/打印差异"。
 * 本模块把这类差异逐项命名（{@link PrintDifferenceKind}），而不是"看起来差不多"。
 *
 * ## 与 X09 的边界（不争写）
 *
 * 分页**引擎**（行高列宽 → 页划）归 X09。本模块**不做**分页计算；它只做
 * 「手机计划 → 文件 → 读回」这条路上的**设置级差异**判定，并把 {@link injectPhonePrintPlan}
 * 作为"手机把计划写进文件"的最小真实通道。
 */

import { ValidationError } from '../../../../src/protocol/index.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../../../../src/documents/docx/xml-parse.js';
import { SPREADSHEETML_NAMESPACE, XLSX_WORKBOOK_PART_PATH, xlsxContentDigest } from '../../../../src/artifacts/templates/xlsx.js';
import {
  PAPER_SIZES,
  getSheetPrint,
  insertDefinedNamesXml,
  insertSheetPrintXml,
  isDefaultPrintLayout,
  type PageHeaderFooter,
  type PrintOptions,
  type PrintPlan,
  type PrintLayout,
} from '../../../../src/spreadsheets/print-layout.js';
import { worksheetPartNames } from './consumer-reopen.js';
import {
  PRINT_ROUNDTRIP_OPERATION,
  XR05_SCHEMA_VERSION,
  type PersistedSheetPrint,
  type PrintDifference,
  type PrintDifferenceKind,
  type PrintRoundtripReport,
} from './types.js';

// ---------------------------------------------------------------------------
// 文本规范化（两侧口径不同：手机用相对文本，文件用带表名 + `$` 的绝对文本）
// ---------------------------------------------------------------------------

/** 去掉工作表前缀，只留最后一个 `!` 之后的区域部分。 */
function stripSheetPrefix(text: string): string {
  const separator = text.lastIndexOf('!');
  return separator < 0 ? text : text.slice(separator + 1);
}

/** 区域文本归一：去 `$`、去表名前缀、大写、去空白。 */
function normalizeRange(text: string): string {
  return stripSheetPrefix(text).replace(/\$/g, '').replace(/\s+/g, '').toUpperCase();
}

/** 英寸数值 → 稳定文本（去掉浮点噪声：保留到 4 位小数后去尾零）。 */
function inchesText(text: string): string {
  const parsed = Number(text);
  /* c8 ignore next -- 属性由本仓写出，必为规范十进制；防御性回落原文 */
  if (!Number.isFinite(parsed)) return text;
  return parsed.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ---------------------------------------------------------------------------
// 文件侧：独立读打印设置
// ---------------------------------------------------------------------------

/** 解析 `_xlnm.Print_Titles` 的正文（`'S'!$A:$B,'S'!$1:$3`）→ 行 / 列。 */
function parsePrintTitles(text: string): { rows: string | null; columns: string | null } {
  let rows: string | null = null;
  let columns: string | null = null;
  for (const segment of text.split(',')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const tail = stripSheetPrefix(trimmed);
    const normalized = normalizeRange(tail);
    if (/^\d+:\d+$/.test(normalized)) {
      rows = normalized;
    } else if (/^[A-Z]+:[A-Z]+$/.test(normalized)) {
      columns = normalized;
    }
    // 其它形状（如命名区域）本模块不建模：留给下方"未识别"分支静默忽略是**不行的**，
    // 故这里只在可识别时赋值，不可识别时保持 null 由调用方从原文对比发现。
  }
  return { rows, columns };
}

function readAttributes(element: ParsedXmlElement | null, names: readonly string[]): Record<string, string> | null {
  if (element === null) return null;
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = attributeValue(element, '', name);
    if (value !== null) result[name] = value;
  }
  return Object.keys(result).length === 0 ? null : result;
}

const MARGIN_KEYS = ['left', 'right', 'top', 'bottom', 'header', 'footer'] as const;
const HEADER_FOOTER_KEYS = [
  'oddHeader',
  'oddFooter',
  'evenHeader',
  'evenFooter',
  'firstHeader',
  'firstFooter',
] as const;
const PRINT_OPTION_KEYS = ['gridLines', 'headings', 'horizontalCentered', 'verticalCentered'] as const;

function readWorksheetPrint(sheetName: string, data: Uint8Array, definedNames: Map<string, { area: string | null; titles: string | null }>): PersistedSheetPrint {
  const root = parseXmlBytes(data);

  const sheetPr = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetPr');
  const pageSetUpPr = findChild(sheetPr, SPREADSHEETML_NAMESPACE, 'pageSetUpPr');
  const fitToPageFlag = pageSetUpPr !== null && attributeValue(pageSetUpPr, '', 'fitToPage') === '1';

  const pageSetup = findChild(root, SPREADSHEETML_NAMESPACE, 'pageSetup');
  const pageMargins = findChild(root, SPREADSHEETML_NAMESPACE, 'pageMargins');
  const headerFooter = findChild(root, SPREADSHEETML_NAMESPACE, 'headerFooter');
  const rowBreaks = findChild(root, SPREADSHEETML_NAMESPACE, 'rowBreaks');
  const colBreaks = findChild(root, SPREADSHEETML_NAMESPACE, 'colBreaks');
  const printOptions = findChild(root, SPREADSHEETML_NAMESPACE, 'printOptions');

  const numberAttr = (element: ParsedXmlElement | null, name: string): number | null => {
    if (element === null) return null;
    const raw = attributeValue(element, '', name);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const intAttr = (element: ParsedXmlElement | null, name: string): number | null => {
    const parsed = numberAttr(element, name);
    return parsed !== null && Number.isInteger(parsed) ? parsed : null;
  };

  const breaksOf = (element: ParsedXmlElement | null): readonly number[] => {
    if (element === null) return Object.freeze([]);
    const ids: number[] = [];
    for (const brk of childElements(element)) {
      if (brk.localName !== 'brk') continue;
      if (attributeValue(brk, '', 'man') !== '1') continue;
      const id = intAttr(brk, 'id');
      if (id !== null) ids.push(id);
    }
    ids.sort((left, right) => left - right);
    return Object.freeze(ids);
  };

  const marginsAttributes = readAttributes(pageMargins, MARGIN_KEYS);
  const margins: Record<string, number> | null =
    marginsAttributes === null
      ? null
      : Object.fromEntries(MARGIN_KEYS.map((key) => [key, Number(marginsAttributes[key] ?? '0')]));

  const headerFooterValues: Record<string, string> = {};
  for (const key of HEADER_FOOTER_KEYS) {
    const child = findChild(headerFooter, SPREADSHEETML_NAMESPACE, key);
    if (child !== null) headerFooterValues[key] = directText(child);
  }

  const titles = definedNames.get(sheetName) ?? { area: null, titles: null };
  const parsedTitles = titles.titles === null ? { rows: null, columns: null } : parsePrintTitles(titles.titles);

  const printOptionAttributes = readAttributes(printOptions, PRINT_OPTION_KEYS);

  return Object.freeze({
    sheet: sheetName,
    print_area: titles.area,
    print_titles_rows: parsedTitles.rows,
    print_titles_columns: parsedTitles.columns,
    orientation: pageSetup === null ? null : attributeValue(pageSetup, '', 'orientation'),
    paper_size: intAttr(pageSetup, 'paperSize'),
    scale_percent: intAttr(pageSetup, 'scale'),
    fit_to_width: intAttr(pageSetup, 'fitToWidth'),
    fit_to_height: intAttr(pageSetup, 'fitToHeight'),
    fit_to_page_flag: fitToPageFlag,
    margins: margins === null ? null : Object.freeze(margins),
    header_footer:
      Object.keys(headerFooterValues).length === 0 ? null : Object.freeze({ ...headerFooterValues }),
    row_breaks: breaksOf(rowBreaks),
    column_breaks: breaksOf(colBreaks),
    print_options:
      printOptionAttributes === null ? null : Object.freeze({ ...printOptionAttributes }),
  });
}

/**
 * 从**真实 .xlsx 字节**独立读出每张工作表的打印设置。不建模型、不经过 `xlsx-read.ts`。
 *
 * @throws {ValidationError} 容器 / XML 不合法
 */
export function readFilePrintSettings(bytes: Uint8Array): readonly PersistedSheetPrint[] {
  const archive = readZip(bytes);
  const partNames = worksheetPartNames(bytes);
  const sheetOrder = [...partNames.values()];

  const workbookEntry = archive.by_path.get(XLSX_WORKBOOK_PART_PATH);
  if (workbookEntry === undefined) {
    throw new ValidationError(`字节里没有 ${XLSX_WORKBOOK_PART_PATH}`);
  }
  const workbookRoot = parseXmlBytes(workbookEntry.data);
  const definedNamesElement = findChild(workbookRoot, SPREADSHEETML_NAMESPACE, 'definedNames');

  const bySheet = new Map<string, { area: string | null; titles: string | null }>();
  for (const definedName of definedNamesElement === null ? [] : childElements(definedNamesElement)) {
    if (definedName.localName !== 'definedName') continue;
    const name = attributeValue(definedName, '', 'name');
    const localSheetId = attributeValue(definedName, '', 'localSheetId');
    if (name === null || localSheetId === null) continue;
    const index = Number(localSheetId);
    const sheetName = Number.isInteger(index) ? sheetOrder[index] : undefined;
    if (sheetName === undefined) continue;
    const entry = bySheet.get(sheetName) ?? { area: null, titles: null };
    if (name === '_xlnm.Print_Area') entry.area = directText(definedName);
    if (name === '_xlnm.Print_Titles') entry.titles = directText(definedName);
    bySheet.set(sheetName, entry);
  }

  const results: PersistedSheetPrint[] = [];
  for (const [partPath, sheetName] of partNames) {
    const entry = archive.by_path.get(partPath);
    if (entry === undefined) {
      throw new ValidationError(`工作表 ${JSON.stringify(sheetName)} 的部件 ${partPath} 不在包里`);
    }
    results.push(readWorksheetPrint(sheetName, entry.data, bySheet));
  }
  return Object.freeze(results);
}

// ---------------------------------------------------------------------------
// 手机侧 → 文件：把打印计划真实注入字节
// ---------------------------------------------------------------------------

/**
 * 把一份**打印计划**注入由 `writeWorkbookXlsx` 产出的字节里（手机"把打印设置写进文件"）。
 *
 * 走的是 `print-layout.ts` 文档化的两段注入：工作表 XML 注入 `pageSetup/pageMargins/…`，
 * 工作簿 XML 注入 `definedNames` 里的 `_xlnm.*`。写出后由 {@link readFilePrintSettings}
 * 独立读回。
 *
 * @throws {ValidationError} 计划引用了不存在的工作表
 */
export function injectPhonePrintPlan(
  bytes: Uint8Array,
  plan: PrintPlan,
  sheetOrder: readonly string[],
): Buffer {
  const archive = readZip(bytes);
  const partNames = worksheetPartNames(bytes);
  const nameByPart = new Map([...partNames].map(([partPath, name]) => [partPath, name]));

  const rewritten = archive.entries.map((entry) => {
    const sheetName = nameByPart.get(entry.path);
    if (sheetName !== undefined) {
      const layout = getSheetPrint(plan, sheetName);
      if (layout !== undefined) {
        return { path: entry.path, data: Buffer.from(insertSheetPrintXml(utf8(entry.data), layout)) };
      }
    }
    if (entry.path === XLSX_WORKBOOK_PART_PATH) {
      return {
        path: entry.path,
        data: Buffer.from(insertDefinedNamesXml(utf8(entry.data), plan, sheetOrder)),
      };
    }
    return { path: entry.path, data: entry.data };
  });

  return writeZip(rewritten);
}

// ---------------------------------------------------------------------------
// 差异
// ---------------------------------------------------------------------------

/** 一张表的「设置名 → 手机侧规范化文本」映射（未设 ⇒ 不出现）。 */
function phoneSettings(layout: PrintLayout): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (layout.print_area !== null) map.set('print_area', normalizeRange(layout.print_area));
  if (layout.repeat_rows !== null) map.set('print_titles_rows', normalizeRange(layout.repeat_rows));
  if (layout.repeat_columns !== null) map.set('print_titles_columns', normalizeRange(layout.repeat_columns));
  if (layout.orientation !== null) map.set('orientation', layout.orientation);
  if (layout.paper_size !== null) map.set('paper_size', String(PAPER_SIZES[layout.paper_size]));
  if (layout.scaling !== null) {
    if (layout.scaling.kind === 'percent') {
      map.set('scale_percent', String(layout.scaling.percent));
    } else {
      map.set('fit_to_width', String(layout.scaling.width));
      map.set('fit_to_height', String(layout.scaling.height));
      map.set('fit_to_page_flag', '1');
    }
  }
  if (layout.margins !== null) {
    map.set('margins', MARGIN_KEYS.map((key) => `${key}=${inchesText(String(layout.margins?.[key] ?? 0))}`).join(','));
  }
  if (layout.header_footer !== null) {
    const hf = layout.header_footer;
    const parts = HEADER_FOOTER_KEYS.filter((key) => fieldOf(hf, key) !== undefined).map(
      (key) => `${key}=${fieldOf(hf, key) ?? ''}`,
    );
    if (parts.length > 0) map.set('header_footer', parts.join(','));
  }
  const options = layout.options;
  if (options !== null) {
    const parts = PRINT_OPTION_KEYS.filter((key) => optionOf(options, key) !== undefined).map(
      (key) => `${key}=${optionOf(options, key) === true ? '1' : '0'}`,
    );
    if (parts.length > 0) map.set('print_options', parts.join(','));
  }
  if (layout.row_breaks.length > 0) map.set('row_breaks', [...layout.row_breaks].sort((a, b) => a - b).join(','));
  if (layout.column_breaks.length > 0) {
    map.set('column_breaks', [...layout.column_breaks].sort((a, b) => a - b).join(','));
  }
  return map;
}

/** `header_footer` 的蛇形字段名 → 元素的驼峰键（读回侧用元素名）。 */
const HEADER_FOOTER_FIELD: Readonly<Record<string, string>> = Object.freeze({
  odd_header: 'oddHeader',
  odd_footer: 'oddFooter',
  even_header: 'evenHeader',
  even_footer: 'evenFooter',
  first_header: 'firstHeader',
  first_footer: 'firstFooter',
});

function fieldOf(hf: PageHeaderFooter, elementKey: string): string | undefined {
  const snake = Object.entries(HEADER_FOOTER_FIELD).find(([, camel]) => camel === elementKey)?.[0];
  const value = snake === undefined ? undefined : (hf as Record<string, unknown>)[snake];
  return typeof value === 'string' ? value : undefined;
}

/** `print_options` 的蛇形字段名 → 属性名。 */
const PRINT_OPTION_FIELD: Readonly<Record<string, string>> = Object.freeze({
  grid_lines: 'gridLines',
  headings: 'headings',
  horizontal_centered: 'horizontalCentered',
  vertical_centered: 'verticalCentered',
});

function optionOf(options: PrintOptions, attributeKey: string): boolean | undefined {
  const snake = Object.entries(PRINT_OPTION_FIELD).find(([, camel]) => camel === attributeKey)?.[0];
  const value = snake === undefined ? undefined : (options as Record<string, unknown>)[snake];
  return typeof value === 'boolean' ? value : undefined;
}

/** 文件侧（规范化后）的「设置名 → 文本」。 */
function fileSettings(persisted: PersistedSheetPrint): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (persisted.print_area !== null) map.set('print_area', normalizeRange(persisted.print_area));
  if (persisted.print_titles_rows !== null) map.set('print_titles_rows', persisted.print_titles_rows);
  if (persisted.print_titles_columns !== null) map.set('print_titles_columns', persisted.print_titles_columns);
  if (persisted.orientation !== null) map.set('orientation', persisted.orientation);
  if (persisted.paper_size !== null) map.set('paper_size', String(persisted.paper_size));
  if (persisted.scale_percent !== null) map.set('scale_percent', String(persisted.scale_percent));
  if (persisted.fit_to_width !== null) map.set('fit_to_width', String(persisted.fit_to_width));
  if (persisted.fit_to_height !== null) map.set('fit_to_height', String(persisted.fit_to_height));
  if (persisted.fit_to_page_flag) map.set('fit_to_page_flag', '1');
  if (persisted.margins !== null) {
    map.set('margins', MARGIN_KEYS.map((key) => `${key}=${inchesText(String(persisted.margins?.[key] ?? 0))}`).join(','));
  }
  if (persisted.header_footer !== null) {
    const parts = HEADER_FOOTER_KEYS.filter((key) => persisted.header_footer?.[key] !== undefined).map(
      (key) => `${key}=${persisted.header_footer?.[key] ?? ''}`,
    );
    if (parts.length > 0) map.set('header_footer', parts.join(','));
  }
  if (persisted.print_options !== null) {
    const parts = PRINT_OPTION_KEYS.filter((key) => persisted.print_options?.[key] !== undefined).map(
      (key) => `${key}=${persisted.print_options?.[key] ?? ''}`,
    );
    if (parts.length > 0) map.set('print_options', parts.join(','));
  }
  if (persisted.row_breaks.length > 0) map.set('row_breaks', [...persisted.row_breaks].join(','));
  if (persisted.column_breaks.length > 0) map.set('column_breaks', [...persisted.column_breaks].join(','));
  return map;
}

const ALL_SETTINGS = Object.freeze([
  'print_area',
  'print_titles_rows',
  'print_titles_columns',
  'orientation',
  'paper_size',
  'scale_percent',
  'fit_to_width',
  'fit_to_height',
  'fit_to_page_flag',
  'margins',
  'header_footer',
  'print_options',
  'row_breaks',
  'column_breaks',
]);

/** {@link diffPhonePrintVsFile} 的选项。 */
export interface PrintDiffOptions {
  readonly file_name?: string;
}

/**
 * **手机打印计划 ↔ 落盘打印设置** 的逐项差异。
 *
 * 对 `sheet_order` 里每张表、{@link ALL_SETTINGS} 里每一项，取手机侧值（来自计划）与文件侧值
 * （从字节独立读出），按三条规则分类：
 * 手机有文件无 ⇒ `missing_in_file`；都有但不同 ⇒ `value_mismatch`；
 * 手机无文件有 ⇒ `unexpected_in_file`；两侧相同 ⇒ 记进 `survived_settings`（正向证据）。
 *
 * @throws {ValidationError} 字节不可读
 */
export function diffPhonePrintVsFile(
  bytes: Uint8Array,
  plan: PrintPlan,
  sheetOrder: readonly string[],
  options: PrintDiffOptions = {},
): PrintRoundtripReport {
  const fileName = options.file_name ?? 'print.xlsx';
  const persistedList = readFilePrintSettings(bytes);
  const persistedByName = new Map(persistedList.map((item) => [item.sheet, item]));

  const differences: PrintDifference[] = [];
  const survived: string[] = [];
  const phoneSheets: string[] = [];

  for (const sheet of sheetOrder) {
    const layout = getSheetPrint(plan, sheet);
    if (layout !== undefined && !isDefaultPrintLayout(layout)) {
      phoneSheets.push(sheet);
    }
    const phone = layout === undefined ? new Map<string, string>() : phoneSettings(layout);
    const persisted = persistedByName.get(sheet);
    const file = persisted === undefined ? new Map<string, string>() : fileSettings(persisted);

    for (const setting of ALL_SETTINGS) {
      const phoneValue = phone.get(setting) ?? null;
      const fileValue = file.get(setting) ?? null;
      if (phoneValue === null && fileValue === null) continue;
      const key = `${sheet}!${setting}`;
      if (phoneValue !== null && fileValue === null) {
        differences.push({
          sheet,
          setting,
          kind: 'missing_in_file' satisfies PrintDifferenceKind,
          phone: phoneValue,
          file: null,
          detail: `手机计划设了 ${setting}=${phoneValue}，落盘文件里没有：消费端会按默认出纸`,
        });
      } else if (phoneValue !== null && fileValue !== null && phoneValue !== fileValue) {
        differences.push({
          sheet,
          setting,
          kind: 'value_mismatch' satisfies PrintDifferenceKind,
          phone: phoneValue,
          file: fileValue,
          detail: `手机计划 ${setting}=${phoneValue}，文件里是 ${fileValue}`,
        });
      } else if (phoneValue === null && fileValue !== null) {
        differences.push({
          sheet,
          setting,
          kind: 'unexpected_in_file' satisfies PrintDifferenceKind,
          phone: null,
          file: fileValue,
          detail: `文件里有 ${setting}=${fileValue}，手机计划未声明（外部文件带来的设置）`,
        });
      } else {
        survived.push(key);
      }
    }
  }

  differences.sort((left, right) => {
    const leftKey = `${left.sheet}!${left.setting}`;
    const rightKey = `${right.sheet}!${right.setting}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  survived.sort();

  return Object.freeze({
    operation: PRINT_ROUNDTRIP_OPERATION,
    schema_version: XR05_SCHEMA_VERSION,
    file_name: fileName,
    source_digest: xlsxContentDigest(bytes),
    phone_sheets: Object.freeze(phoneSheets),
    persisted: persistedList,
    differences: Object.freeze(differences),
    survived_settings: Object.freeze(survived),
    consistent: differences.length === 0,
  });
}

/** 打印设置的名称清单（供调用方遍历；与差异算法同源，避免两处漂移）。 */
export const PRINT_SETTING_NAMES = ALL_SETTINGS;
