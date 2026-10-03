/**
 * **X-R05 源模块 C：页数级打印差异（手机分页计划 ↔ 消费端按文件设置的页数）**。
 *
 * ## 为什么要单独做一层"页数"差异（`print-diff.ts` 不够）
 *
 * `print-diff.ts` 比的是**设置项文本**（`print_area` / `orientation` / `row_breaks` …）是否
 * 原样存在于 .xlsx 里。它解决的是"设置丢没丢"；但它**回答不了**用户真正关心的问题：
 * **手机 PDF 预览会分几页？消费端打开后实际会印几页？**
 *
 * 本模块把两端**各自的页数**算出来并列：
 *
 * - 手机侧：{@link PrintPlan}（内存里的打印计划）经 X09 `resolvePrintSettings` + `computePagePlan`
 *   算出 {@link PagePlan}——**这就是手机 PDF 预览的事实来源**（见 X09 文档："唯一总页数来源"）。
 * - 文件侧：从**真实字节**独立读出打印设置（不经 `xlsx-read.ts`——它不读打印设置），
 *   再喂给**同一个** X09 引擎，算出消费端按文件设置会分几页。
 *
 * 于是"手机显示 1 页、消费端出纸 2 页"这类差异变成一个**可机器判定的数字对**，而不是"看起来不一样"。
 *
 * ## 行高列宽来自哪（不编造几何）
 *
 * 页数由**几何**（行高 / 列宽）+ 设置共同决定。行高列宽属于**文档本身**，不是打印设置；
 * 本模块的**已用区域**从文件 `<dimension>` **读字节得来**（`A1:C90` → 90 行 3 列），
 * 行高 / 列宽用 Excel 默认值（列 8.43 字符 = 960 twips、行 15pt = 300 twips，与 X09 口径一致）。
 * 两侧用**同一份几何**，因此差异只可能来自**打印设置**——这正是要隔离的变量。
 * 需要非默认可另给 `gridOverrides`（不静默猜测）。
 *
 * ## 边界（不夸大口径）
 *
 * - 本模块**不**做 PDF 光栅化、**不**接真实打印机 / 消费端；它到"分页计划"为止（与 X09 同界）。
 * - 文件侧设置来自本仓会写出的那几类元素；x14 / 外部未知打印元素**未覆盖**。
 * - `resolvePrintSettings` 的默认纸张是 A4（见其文件头）——两侧同缺省时一致，故不影响差值判定。
 */

import { columnLettersToNumber } from '../../../../src/spreadsheets/reference.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  attributeValue,
  findChild,
  parseXmlBytes,
} from '../../../../src/documents/docx/xml-parse.js';
import {
  SPREADSHEETML_NAMESPACE,
  xlsxContentDigest,
} from '../../../../src/artifacts/templates/xlsx.js';
import {
  EMPTY_PRINT_LAYOUT,
  PAPER_SIZES,
  getSheetPrint,
  type PageHeaderFooter,
  type PageMargins,
  type PageOrientation,
  type PaperSizeName,
  type PrintLayout,
  type PrintOptions,
  type PrintPlan,
  type PrintScaling,
} from '../../../../src/spreadsheets/print-layout.js';
import {
  computePagePlan,
  excelColumnWidthToTwips,
  excelRowHeightToTwips,
  resolvePrintSettings,
  type PagePlan,
  type SheetGridGeometry,
} from '../../../../src/mobile-plugins/spreadsheets/rendering/index.js';
import { worksheetPartNames } from './consumer-reopen.js';
import { readFilePrintSettings } from './print-diff.js';
import {
  PAGE_COUNT_OPERATION,
  XR05_SCHEMA_VERSION,
  type PageCountDiffReport,
  type PageDifference,
  type PageDifferenceKind,
  type PersistedSheetPrint,
  type SheetPageDiff,
} from './types.js';

// ---------------------------------------------------------------------------
// 默认几何（X09 口径：8.43 字符列宽 = 960 twips；15pt 行高 = 300 twips）
// ---------------------------------------------------------------------------

const DEFAULT_COLUMN_WIDTH_TWIPS = excelColumnWidthToTwips(8.43);
const DEFAULT_ROW_HEIGHT_TWIPS = excelRowHeightToTwips(15);

/** paperSize 编号 → 纸张名（{@link PAPER_SIZES} 的反查）。 */
const PAPER_NAME_BY_SIZE = new Map<number, PaperSizeName>(
  (Object.entries(PAPER_SIZES) as [PaperSizeName, number][]).map(([name, size]) => [size, name]),
);

interface UsedRange {
  readonly rows: number;
  readonly columns: number;
}

// ---------------------------------------------------------------------------
// 文件侧：已用区域（从 <dimension> 读字节得来，不问模型）
// ---------------------------------------------------------------------------

/**
 * 从**字节**读出每张工作表的已用区域（`<dimension ref="A1:C90"/>`）。
 *
 * `dimension` 缺失（空表时本仓会省略）⇒ 按 1×1 处理（`computePagePlan` 需要 `last ≥ first`）。
 *
 * @throws {ValidationError} 工作表部件缺失 / 表名解析失败
 */
export function readUsedRanges(bytes: Uint8Array): ReadonlyMap<string, UsedRange> {
  const archive = readZip(bytes);
  const partNames = worksheetPartNames(bytes);
  const ranges = new Map<string, UsedRange>();
  for (const [partPath, sheetName] of partNames) {
    const entry = archive.by_path.get(partPath);
    if (entry === undefined) {
      throw new ValidationError(`工作表 ${JSON.stringify(sheetName)} 的部件 ${partPath} 不在包里`);
    }
    const root = parseXmlBytes(entry.data);
    const dimension = findChild(root, SPREADSHEETML_NAMESPACE, 'dimension');
    const ref = dimension === null ? null : attributeValue(dimension, '', 'ref');
    let rows = 1;
    let columns = 1;
    if (ref !== null) {
      const end = ref.split(':')[1] ?? ref;
      const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(end);
      if (match !== null) {
        columns = Math.max(columns, columnLettersToNumber(match[1] as string));
        rows = Math.max(rows, Number.parseInt(match[2] as string, 10));
      }
    }
    ranges.set(sheetName, Object.freeze({ rows, columns }));
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// 文件侧：持久化设置 → PrintLayout（喂给 X09 的 resolvePrintSettings）
// ---------------------------------------------------------------------------

const HEADER_FOOTER_READ_FIELD: Readonly<Record<string, keyof PageHeaderFooter>> = Object.freeze({
  oddHeader: 'odd_header',
  oddFooter: 'odd_footer',
  evenHeader: 'even_header',
  evenFooter: 'even_footer',
  firstHeader: 'first_header',
  firstFooter: 'first_footer',
});

const PRINT_OPTION_READ_FIELD: Readonly<Record<string, keyof PrintOptions>> = Object.freeze({
  gridLines: 'grid_lines',
  headings: 'headings',
  horizontalCentered: 'horizontal_centered',
  verticalCentered: 'vertical_centered',
});

function marginsFromPersisted(margins: Readonly<Record<string, number>> | null): PageMargins | null {
  if (margins === null) return null;
  return Object.freeze({
    left: margins.left ?? 0,
    right: margins.right ?? 0,
    top: margins.top ?? 0,
    bottom: margins.bottom ?? 0,
    header: margins.header ?? 0,
    footer: margins.footer ?? 0,
  });
}

function headerFooterFromPersisted(
  values: Readonly<Record<string, string>> | null,
): PageHeaderFooter | null {
  if (values === null) return null;
  const out: Record<string, string> = {};
  for (const [elementKey, snake] of Object.entries(HEADER_FOOTER_READ_FIELD)) {
    const value = values[elementKey];
    if (typeof value === 'string') out[snake] = value;
  }
  return Object.keys(out).length === 0 ? null : Object.freeze(out) as PageHeaderFooter;
}

function optionsFromPersisted(values: Readonly<Record<string, string>> | null): PrintOptions | null {
  if (values === null) return null;
  const out: Record<string, boolean> = {};
  for (const [attributeKey, snake] of Object.entries(PRINT_OPTION_READ_FIELD)) {
    const value = values[attributeKey];
    if (value !== undefined) out[snake] = value === '1' || value.toLowerCase() === 'true';
  }
  return Object.keys(out).length === 0 ? null : Object.freeze(out) as PrintOptions;
}

function scalingFromPersisted(persisted: PersistedSheetPrint): PrintScaling | null {
  if (persisted.scale_percent !== null) {
    return Object.freeze({ kind: 'percent', percent: persisted.scale_percent });
  }
  // fitToWidth/fitToHeight 只有 sheetPr/pageSetUpPr 的 fitToPage=1 才在 Excel 里生效。
  if (persisted.fit_to_page_flag) {
    return Object.freeze({
      kind: 'fit_to_pages',
      width: persisted.fit_to_width ?? 1,
      height: persisted.fit_to_height ?? 1,
    });
  }
  return null;
}

/**
 * 把**从字节独立读出的**打印设置还原成 {@link PrintLayout}，以便复用 X09 的
 * `resolvePrintSettings` 分页解析（避免两处各写一份解析、悄悄漂移）。
 */
export function fileLayoutFromPersisted(persisted: PersistedSheetPrint): PrintLayout {
  return Object.freeze({
    print_area: persisted.print_area,
    orientation: persisted.orientation as PageOrientation | null,
    paper_size:
      persisted.paper_size === null ? null : PAPER_NAME_BY_SIZE.get(persisted.paper_size) ?? null,
    margins: marginsFromPersisted(persisted.margins),
    repeat_rows: persisted.print_titles_rows,
    repeat_columns: persisted.print_titles_columns,
    scaling: scalingFromPersisted(persisted),
    header_footer: headerFooterFromPersisted(persisted.header_footer),
    options: optionsFromPersisted(persisted.print_options),
    row_breaks: persisted.row_breaks,
    column_breaks: persisted.column_breaks,
    page_order: null,
  });
}

// ---------------------------------------------------------------------------
// 规范化：区域文本 / 分页符
// ---------------------------------------------------------------------------

/**
 * 区域文本规范化：逐段剥工作表前缀、去 `$`、去空白、大写、按逗号重排。
 * 多区域用顶层逗号切分（单引号内的逗号不切）——与本仓 `_xlnm.Print_Area` 写法一致。
 */
function normalizeArea(text: string | null): string | null {
  if (text === null) return null;
  const parts: string[] = [];
  let buffer = '';
  let inQuote = false;
  for (const char of text) {
    if (char === "'") inQuote = !inQuote;
    if (char === ',' && !inQuote) {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  return parts
    .map((part) => {
      const bang = part.lastIndexOf('!');
      const body = bang >= 0 ? part.slice(bang + 1) : part;
      return body.replace(/\$/g, '').replace(/\s+/g, '').toUpperCase();
    })
    .filter((part) => part.length > 0)
    .join(',');
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((value, index) => value === b[index]);
}

function numbersText(values: readonly number[]): string {
  return [...values].sort((left, right) => left - right).join(',');
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** {@link diffPageCountVsFile} 的选项。 */
export interface PageCountDiffOptions {
  readonly file_name?: string;
  /**
   * 覆盖某表的几何（行高 / 列宽）。不提供时：已用区域从 `<dimension>` 读，行高列宽用默认值。
   * 提供时**以调用方为准**（调用方自担与文件一致的责任）。
   */
  readonly gridOverrides?: Readonly<Record<string, SheetGridGeometry>>;
  /** 页数硬上限，透传给 X09（默认 5000）。 */
  readonly maxPages?: number;
}

function gridForSheet(sheet: string, used: UsedRange, overrides?: Readonly<Record<string, SheetGridGeometry>>): SheetGridGeometry {
  const override = overrides?.[sheet];
  if (override !== undefined) return override;
  return Object.freeze({
    firstRow: 1,
    firstColumn: 1,
    lastRow: used.rows,
    lastColumn: used.columns,
    defaultColumnWidthTwips: DEFAULT_COLUMN_WIDTH_TWIPS,
    defaultRowHeightTwips: DEFAULT_ROW_HEIGHT_TWIPS,
  });
}

function computePlan(grid: SheetGridGeometry, settings: ReturnType<typeof resolvePrintSettings>, maxPages?: number): PagePlan {
  return maxPages === undefined
    ? computePagePlan({ grid, settings })
    : computePagePlan({ grid, settings, maxPages });
}

function compareSheet(
  sheet: string,
  used: UsedRange,
  phonePlan: PagePlan,
  filePlan: PagePlan,
  phoneLayout: PrintLayout,
  persisted: PersistedSheetPrint,
): SheetPageDiff {
  const differences: PageDifference[] = [];
  const push = (kind: PageDifferenceKind, phone: string | null, file: string | null, detail: string): void => {
    differences.push(Object.freeze({ sheet, kind, phone, file, detail }));
  };

  if (phonePlan.totalPages !== filePlan.totalPages) {
    push(
      'page_count_mismatch',
      String(phonePlan.totalPages),
      String(filePlan.totalPages),
      `手机预览 ${phonePlan.totalPages} 页，消费端按文件里的设置会印 ${filePlan.totalPages} 页（差 ${filePlan.totalPages - phonePlan.totalPages}）`,
    );
  }
  if (phonePlan.rowStrips.length !== filePlan.rowStrips.length) {
    push(
      'row_band_mismatch',
      String(phonePlan.rowStrips.length),
      String(filePlan.rowStrips.length),
      `行分带数：手机 ${phonePlan.rowStrips.length}，文件 ${filePlan.rowStrips.length}`,
    );
  }
  if (phonePlan.columnStrips.length !== filePlan.columnStrips.length) {
    push(
      'column_band_mismatch',
      String(phonePlan.columnStrips.length),
      String(filePlan.columnStrips.length),
      `列分带数：手机 ${phonePlan.columnStrips.length}，文件 ${filePlan.columnStrips.length}`,
    );
  }

  const phoneArea = normalizeArea(phoneLayout.print_area);
  const fileArea = normalizeArea(persisted.print_area);
  if (phoneArea !== fileArea) {
    push(
      'print_area_mismatch',
      phoneArea,
      fileArea,
      `打印区域：手机 \`${phoneArea ?? '(未设)'}\`，文件 \`${fileArea ?? '(未设)'}\``,
    );
  }

  if (!sameNumbers(phoneLayout.row_breaks, persisted.row_breaks)) {
    push(
      'manual_breaks_mismatch',
      numbersText(phoneLayout.row_breaks),
      numbersText(persisted.row_breaks),
      `手工行分页符：手机 [${numbersText(phoneLayout.row_breaks)}]，文件 [${numbersText(persisted.row_breaks)}]`,
    );
  }
  if (!sameNumbers(phoneLayout.column_breaks, persisted.column_breaks)) {
    push(
      'manual_breaks_mismatch',
      numbersText(phoneLayout.column_breaks),
      numbersText(persisted.column_breaks),
      `手工列分页符：手机 [${numbersText(phoneLayout.column_breaks)}]，文件 [${numbersText(persisted.column_breaks)}]`,
    );
  }

  return Object.freeze({
    sheet,
    used_rows: used.rows,
    used_columns: used.columns,
    phone_pages: phonePlan.totalPages,
    file_pages: filePlan.totalPages,
    pages_delta: filePlan.totalPages - phonePlan.totalPages,
    phone_row_bands: phonePlan.rowStrips.length,
    file_row_bands: filePlan.rowStrips.length,
    phone_column_bands: phonePlan.columnStrips.length,
    file_column_bands: filePlan.columnStrips.length,
    phone_print_area: phoneArea,
    file_print_area: fileArea,
    phone_row_breaks: Object.freeze([...phoneLayout.row_breaks].sort((a, b) => a - b)),
    file_row_breaks: Object.freeze([...persisted.row_breaks].sort((a, b) => a - b)),
    phone_column_breaks: Object.freeze([...phoneLayout.column_breaks].sort((a, b) => a - b)),
    file_column_breaks: Object.freeze([...persisted.column_breaks].sort((a, b) => a - b)),
    differences: Object.freeze(differences),
  });
}

/**
 * **页数级打印差异**：手机分页计划（PDF 预览的事实来源）↔ 消费端按文件设置会印的页数。
 *
 * 对 `sheet_order` 每张表：手机侧用内存里的 {@link PrintPlan}，文件侧用从**真实字节**独立读出的
 * 打印设置，两者都喂给 X09 `computePagePlan`，逐表比对页数 / 分带数 / 打印区域 / 手工分页符。
 *
 * @throws {ValidationError} 字节不可读 / 表缺几何
 */
export function diffPageCountVsFile(
  bytes: Uint8Array,
  plan: PrintPlan,
  sheetOrder: readonly string[],
  options: PageCountDiffOptions = {},
): PageCountDiffReport {
  const fileName = options.file_name ?? 'print.xlsx';
  const persistedList = readFilePrintSettings(bytes);
  const persistedByName = new Map(persistedList.map((item) => [item.sheet, item]));
  const usedRanges = readUsedRanges(bytes);

  const sheets: SheetPageDiff[] = [];
  const differences: PageDifference[] = [];
  let totalPhonePages = 0;
  let totalFilePages = 0;

  for (const sheet of sheetOrder) {
    const used = usedRanges.get(sheet);
    if (used === undefined) {
      throw new ValidationError(`字节里没有工作表 ${JSON.stringify(sheet)}（sheet_order 与之不符）`);
    }
    const persisted = persistedByName.get(sheet);
    if (persisted === undefined) {
      throw new ValidationError(`读回结果里没有工作表 ${JSON.stringify(sheet)}`);
    }
    const grid = gridForSheet(sheet, used, options.gridOverrides);
    const phoneLayout = getSheetPrint(plan, sheet) ?? EMPTY_PRINT_LAYOUT;
    const phonePlan = computePlan(grid, resolvePrintSettings(phoneLayout), options.maxPages);
    const filePlan = computePlan(grid, resolvePrintSettings(fileLayoutFromPersisted(persisted)), options.maxPages);

    const sheetDiff = compareSheet(sheet, used, phonePlan, filePlan, phoneLayout, persisted);
    sheets.push(sheetDiff);
    differences.push(...sheetDiff.differences);
    totalPhonePages += sheetDiff.phone_pages;
    totalFilePages += sheetDiff.file_pages;
  }

  return Object.freeze({
    operation: PAGE_COUNT_OPERATION,
    schema_version: XR05_SCHEMA_VERSION,
    file_name: fileName,
    source_digest: xlsxContentDigest(bytes),
    sheets: Object.freeze(sheets),
    differences: Object.freeze(differences),
    total_phone_pages: totalPhonePages,
    total_file_pages: totalFilePages,
    pages_delta: totalFilePages - totalPhonePages,
    consistent: differences.length === 0,
  });
}
