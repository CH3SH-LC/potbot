/**
 * **打印设置解析**：把 `print-layout.ts` 的 `PrintLayout`（字符串形态的打印区域/重复标题）
 * 解析成结构化数值（{@link ResolvedPrintSettings}），供分页引擎使用。
 *
 * 默认值口径与 Excel 一致：方向缺省=纵向、纸张缺省=A4、边距缺省=`DEFAULT_MARGINS`、
 * 缩放缺省=100%、打印顺序缺省=down_then_over。**未设置**与"设成默认值"在文件里不同，
 * 但在**分页几何**上等价。
 */

import {
  DEFAULT_MARGINS,
  type PageOrder,
  type PrintLayout,
} from '../../../spreadsheets/print-layout.js';
import { columnLettersToNumber, parseRange, type CellRange } from '../../../spreadsheets/reference.js';
import { RenderingError } from './errors.js';
import type { ColumnSpan, ResolvedPrintSettings, RowSpan } from './types.js';

/** 按顶层逗号切分（单引号内的逗号属于工作表名，不切）。 */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let inQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "'") {
      inQuote = !inQuote;
      buffer += char;
      continue;
    }
    if (char === ',' && !inQuote) {
      out.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  out.push(buffer);
  return out;
}

/** 取最后一个**引号外**的 `!`（工作表前缀分隔符）下标；无则 -1。 */
function lastBangOutsideQuotes(text: string): number {
  let inQuote = false;
  let bang = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "'") inQuote = !inQuote;
    else if (char === '!' && !inQuote) bang = index;
  }
  return bang;
}

/**
 * 解析打印区域文本为**区域列表**：支持 OOXML `_xlnm.Print_Area` 的
 * **多区域**（逗号分隔）与**工作表前缀**（`'预算'!$A$1:$G$20`——本引擎按单表处理，
 * 前缀被剥离）。单段返回长度 1 的数组；空文本返回 `[]`。
 *
 * 这样 X-R05 `readFilePrintSettings` 读回的真实 definedName 正文可以直接喂给分页引擎。
 * @throws {RenderingError} 任一段不是合法区域
 */
export function parsePrintAreaList(text: string): readonly CellRange[] {
  const ranges: CellRange[] = [];
  for (const part of splitTopLevel(text)) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const bang = lastBangOutsideQuotes(trimmed);
    const body = bang >= 0 ? trimmed.slice(bang + 1) : trimmed;
    try {
      ranges.push(parseRange(body));
    } catch {
      throw new RenderingError('invalid_settings', { field: 'print_area', value: text });
    }
  }
  return Object.freeze(ranges);
}

function parseRowSpan(text: string, field: string): RowSpan {
  const match = /^(\d{1,7}):(\d{1,7})$/.exec(text.trim());
  if (match === null) {
    throw new RenderingError('invalid_settings', { field, value: text });
  }
  const start = Number.parseInt(match[1] as string, 10);
  const end = Number.parseInt(match[2] as string, 10);
  if (start < 1 || start > end) {
    throw new RenderingError('invalid_settings', { field, value: text });
  }
  return Object.freeze({ start, end });
}

function parseColumnSpan(text: string, field: string): ColumnSpan {
  const match = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(text.trim());
  if (match === null) {
    throw new RenderingError('invalid_settings', { field, value: text });
  }
  const start = columnLettersToNumber(match[1] as string);
  const end = columnLettersToNumber(match[2] as string);
  if (start > end) {
    throw new RenderingError('invalid_settings', { field, value: text });
  }
  return Object.freeze({ start, end });
}

/** 解析一份 `PrintLayout`（例如由 `createPrintLayout` 构造）为分页用的结构化设置。 */
export function resolvePrintSettings(layout: PrintLayout): ResolvedPrintSettings {
  const areas: readonly CellRange[] =
    layout.print_area === null ? Object.freeze([]) : parsePrintAreaList(layout.print_area);
  return Object.freeze({
    orientation: layout.orientation ?? 'portrait',
    paperSize: layout.paper_size ?? 'a4',
    margins: layout.margins ?? DEFAULT_MARGINS,
    scaling: layout.scaling,
    // 单区域走 printArea；多区域走 printAreas（互斥，见 ResolvedPrintSettings 注释）。
    printArea: areas.length === 1 ? (areas[0] as CellRange) : null,
    printAreas: areas.length > 1 ? areas : null,
    repeatRows: layout.repeat_rows === null ? null : parseRowSpan(layout.repeat_rows, 'repeat_rows'),
    repeatColumns:
      layout.repeat_columns === null ? null : parseColumnSpan(layout.repeat_columns, 'repeat_columns'),
    manualRowBreaks: Object.freeze([...layout.row_breaks]),
    manualColumnBreaks: Object.freeze([...layout.column_breaks]),
    headerFooter: layout.header_footer,
    pageOrder: (layout.page_order ?? 'down_then_over') as PageOrder,
  });
}
