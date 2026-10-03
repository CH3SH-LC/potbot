/**
 * 表格域：**CSV 编解码**与**工作簿文件层会话**（design-06-P8 / XLS-01、XLS-02、XLS-18 的文件层）。
 *
 * ## 这个文件回答的三个问题
 *
 * 1. **CSV 进出表格域时，编码 / 分隔符 / 类型是谁说了算？** —— 全部**显式**：调用方给出
 *    `encoding` / `delimiter`，类型由 `type_mode`（或逐列 `column_types`）决定；本模块
 *    **不猜**。默认口径是"一切都当文本"（`'text'`），因为把 `007` 读成 `7`、把 `1,000`
 *    读成 `1000` 这类静默强制转换，正是"结果不得编造"要挡的事。
 * 2. **一份工作簿在"新建 → 导入 → 另存 → 重命名 → 保存关闭重开 → 继续编辑"这条路上，
 *    什么时候会丢东西？** —— 答案是"调用方忘了带上读回时的残留（`XlsxResidual`）时"。
 *    因此本模块把**工作簿 + 残留 + 文件名**绑成一个 {@link WorkbookDocument}：
 *    只要走文档层，未知部件（`docProps/`、工作表级关系、旧图形……）就跟着走，
 *    而且 **`writeWorkbookXlsx` 的 `preserved_part_paths` 给出正向证据**可供核对。
 * 3. **XLS-18 的跨模板事实发布怎么办？** —— 本轮**只登记接口点、不实现**
 *    （见 {@link XLS18_FACT_PUBLICATION_PORT}）：它要接到文档 / PPT 池的"同版事实"发布通道，
 *    那两个池的文件不在本工作包的写权内。
 *
 * ## 本模块**不做**的事（如实登记，不夸大）
 *
 * - **不**打开 / 验证消费端：文件层往返通过 ≠ 安卓 WPS / Excel 能打开能编辑。
 *   消费端验证**本轮未做**（标"未验证"），不得由本模块的任何绿灯替代。
 * - **不**导出 GBK：Node 有 GBK 解码器（`TextDecoder`）但**没有**编码器，因此导入支持
 *   读取 GBK，导出只支持 `utf-8` / `utf-8-bom`。这是能力边界，不是参数疏漏。
 * - **不**把公式写进 CSV：CSV 没有公式语法。默认 `formulas: 'error'` —— 遇到公式格**显式失败**，
 *   而不是把缓存值写成常量（那会让"可编辑公式"在导出这一步变成"固化的数值"）。
 */

import {
  ValidationError,
  civilFromDays,
  dayNumberUtc,
  formatIsoTimestampUtc,
  timestampFromCivilUtc,
} from '../protocol/index.js';
import { resolveRelationshipTarget } from '../artifacts/ooxml/index.js';
import { xlsxContentDigest } from '../artifacts/templates/xlsx.js';
import { evaluateWorkbookCell } from './evaluate.js';
import { formatCellAddress, parseCellAddress, type CellAddress } from './reference.js';
import {
  createSheet,
  getCellValue,
  setCellValue,
  sheetEntries,
  type SheetState,
} from './sheet.js';
import {
  activeSheet,
  createWorkbook,
  getSheet,
  type WorkbookState,
} from './workbook.js';
import { readWorkbookXlsx } from './xlsx-read.js';
import {
  EMPTY_RESIDUAL,
  writeWorkbookXlsx,
  type FormulaEvaluationRecord,
  type XlsxResidual,
} from './xlsx-write.js';
import {
  blank,
  booleanValue,
  dateValue,
  numberValue,
  textValue,
  type CellValue,
} from './value.js';

// ---------------------------------------------------------------------------
// CSV：显式口径的常量与类型
// ---------------------------------------------------------------------------

/** 导出时可选编码（Node 没有 GBK 编码器，故导出不含 `gbk`）。 */
export const CSV_EXPORT_ENCODINGS = ['utf-8', 'utf-8-bom'] as const;
export type CsvExportEncoding = (typeof CSV_EXPORT_ENCODINGS)[number];

/** 导入时可选编码：三种具体编码 + `auto`（BOM 优先 → 严格 UTF-8 → 严格 GBK）。 */
export const CSV_IMPORT_ENCODINGS = ['auto', 'utf-8', 'utf-8-bom', 'gbk'] as const;
export type CsvImportEncoding = (typeof CSV_IMPORT_ENCODINGS)[number];

/** 字段分隔符（显式给出，本模块**不做**分隔符嗅探）。 */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** 换行风格。导入时三种（`\n` / `\r\n` / `\r`）都接受。 */
export type CsvNewline = 'lf' | 'crlf';

/** 单元格类型口径。 */
export type CsvCellType = 'text' | 'number' | 'boolean' | 'date' | 'auto';

/** 导入类型模式：整表默认口径（`column_types` 可逐列覆盖）。 */
export type CsvTypeMode = 'text' | 'auto';

/** UTF-8 BOM 字节。 */
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf]);

/** 无符号整数 / 小数的**严格**十进制写法：拒绝 `007`、`1,000`、`0x10`、`1.`、`.5`、`Infinity`。 */
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** `YYYY-MM-DD`。 */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 本模块导出的日期形式：毫秒精度的 UTC ISO 8601。 */
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** 导入选项。 */
export interface CsvImportOptions {
  /** 源字节的编码。默认 `'auto'`。 */
  readonly encoding?: CsvImportEncoding;
  /** 字段分隔符。默认 `','`。 */
  readonly delimiter?: CsvDelimiter;
  /** 生成的唯一工作表名。默认 `'Sheet1'`。 */
  readonly sheet_name?: string;
  /** 整表类型口径。默认 `'text'`（不推断、不静默强转）。 */
  readonly type_mode?: CsvTypeMode;
  /** 逐列类型覆盖（第 0 项 = A 列）。未给出的列用 `type_mode`。 */
  readonly column_types?: readonly CsvCellType[];
}

/** 导入结果（编码 / 分隔符 / 尺寸都如实回报，供调用方核对）。 */
export interface CsvImportResult {
  readonly workbook: WorkbookState;
  readonly sheet_name: string;
  /** **实际使用**的编码（`auto` 已解析成具体结论）。 */
  readonly encoding: Exclude<CsvImportEncoding, 'auto'>;
  readonly delimiter: CsvDelimiter;
  readonly had_bom: boolean;
  readonly row_count: number;
  readonly column_count: number;
}

/** 导出选项。 */
export interface CsvExportOptions {
  /** 要导出的工作表名。工作簿多于一张表时**必须**显式给出（不默认只导第一张）。 */
  readonly sheet?: string;
  readonly delimiter?: CsvDelimiter;
  readonly newline?: CsvNewline;
  readonly encoding?: CsvExportEncoding;
  /** 文本字段的引号口径：`'minimal'`（仅必要时加引号）/ `'all-text'`（文本一律加引号）。 */
  readonly quote?: 'minimal' | 'all-text';
  /** 公式格的处置：`'error'`（默认，显式失败）/ `'value'`（写求值结果，阻塞则失败）。 */
  readonly formulas?: 'error' | 'value';
}

/** 导出结果。 */
export interface CsvExportResult {
  readonly bytes: Buffer;
  readonly sheet: string;
  readonly encoding: CsvExportEncoding;
  readonly delimiter: CsvDelimiter;
  readonly newline: CsvNewline;
  readonly had_bom: boolean;
  readonly row_count: number;
  readonly column_count: number;
}

// ---------------------------------------------------------------------------
// CSV：解码 / 编码（编码学在两端都显式）
// ---------------------------------------------------------------------------

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

/** 严格解码（`fatal`：非法字节**抛**，绝不静默替换成 U+FFFD）。 */
function decodeStrict(bytes: Uint8Array, label: string, decoder: InstanceType<typeof TextDecoder>): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ValidationError(`CSV 不是合法的 ${label} 字节序列：拒绝静默替换（请显式给出正确的 encoding）`);
  }
}

interface DecodedSource {
  readonly text: string;
  readonly encoding: Exclude<CsvImportEncoding, 'auto'>;
  readonly had_bom: boolean;
}

function decodeCsv(bytes: Uint8Array, encoding: CsvImportEncoding): DecodedSource {
  const bom = hasUtf8Bom(bytes);
  if (encoding === 'utf-8-bom') {
    if (!bom) {
      throw new ValidationError('encoding 声明为 utf-8-bom，但源字节没有 UTF-8 BOM');
    }
    return { text: decodeStrict(bytes.subarray(3), 'UTF-8', new TextDecoder('utf-8', { fatal: true })), encoding, had_bom: true };
  }
  if (encoding === 'gbk') {
    if (bom) {
      throw new ValidationError('encoding 声明为 gbk，但源字节带 UTF-8 BOM（GBK 无 BOM）');
    }
    return { text: decodeStrict(bytes, 'GBK', new TextDecoder('gbk', { fatal: true })), encoding, had_bom: false };
  }
  if (encoding === 'utf-8') {
    const body = bom ? bytes.subarray(3) : bytes;
    return { text: decodeStrict(body, 'UTF-8', new TextDecoder('utf-8', { fatal: true })), encoding, had_bom: bom };
  }
  // auto：BOM 优先；否则严格 UTF-8；再否则严格 GBK；都失败则如实报不可读。
  if (bom) {
    return {
      text: decodeStrict(bytes.subarray(3), 'UTF-8', new TextDecoder('utf-8', { fatal: true })),
      encoding: 'utf-8-bom',
      had_bom: true,
    };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', had_bom: false };
  } catch {
    // 退一步：GBK（常见于 Windows 记事本另存的中文 CSV）
  }
  return { text: decodeStrict(bytes, 'GBK', new TextDecoder('gbk', { fatal: true })), encoding: 'gbk', had_bom: false };
}

/** 编码导出字节（BOM 是**显式选择**的结果，不是默认行为）。 */
export function encodeCsvBytes(text: string, encoding: CsvExportEncoding): Buffer {
  const body = Buffer.from(new TextEncoder().encode(text));
  return encoding === 'utf-8-bom'
    ? Buffer.concat([Buffer.from(UTF8_BOM), body])
    : body;
}

// ---------------------------------------------------------------------------
// CSV：字段级解析（RFC 4180 风格的状态机）
// ---------------------------------------------------------------------------

export interface CsvField {
  readonly text: string;
  /** 该字段是否被引号包裹（`""` 空串与裸空串因此可区分）。 */
  readonly quoted: boolean;
}

const EMPTY_FIELD: CsvField = Object.freeze({ text: '', quoted: false });

/**
 * 把整份 CSV 文本切成行 × 字段。
 *
 * 规则（**显式**，不"尽力而为"）：
 * - 被引号包裹的字段内可含分隔符 / `\n` / `\r`，内部 `""` 表示一个字面引号；
 * - 未加引号的字段里出现 `"` ⇒ **抛**（无法判定作者意图）；
 * - 引号闭合后同一字段内还有非分隔符字符 ⇒ **抛**；
 * - 行终止符 `\n` / `\r\n` / `\r` 都接受；文件末尾的单个换行**不**产生空行。
 *
 * @throws {ValidationError}
 */
export function parseCsvRows(text: string, delimiter: CsvDelimiter): readonly (readonly CsvField[])[] {
  const rows: CsvField[][] = [];
  let row: CsvField[] = [];
  let index = 0;
  const length = text.length;

  const pushField = (field: CsvField): void => {
    row.push(field);
  };
  const endRow = (): void => {
    rows.push(row);
    row = [];
  };

  while (index < length) {
    // 一个字段
    let quoted = false;
    let value = '';
    if (text.charAt(index) === '"') {
      quoted = true;
      index += 1;
      for (;;) {
        if (index >= length) {
          throw new ValidationError(`CSV 第 ${String(rows.length + 1)} 行有未闭合的引号`);
        }
        const ch = text.charAt(index);
        if (ch === '"') {
          if (text.charAt(index + 1) === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += ch;
        index += 1;
      }
      const after = index < length ? text.charAt(index) : '';
      if (after !== '' && after !== delimiter && after !== '\n' && after !== '\r') {
        throw new ValidationError(
          `CSV 第 ${String(rows.length + 1)} 行：引号闭合后出现 ${JSON.stringify(after)}——未加引号的引号本模块不猜，显式失败`,
        );
      }
    } else {
      for (;;) {
        const ch = index < length ? text.charAt(index) : '';
        if (ch === '' || ch === delimiter || ch === '\n' || ch === '\r') break;
        if (ch === '"') {
          throw new ValidationError(
            `CSV 第 ${String(rows.length + 1)} 行：未加引号的字段里出现引号——本模块不猜，显式失败`,
          );
        }
        value += ch;
        index += 1;
      }
    }
    pushField({ text: value, quoted });

    const next = index < length ? text.charAt(index) : '';
    if (next === delimiter) {
      index += 1;
      // 行尾的分隔符表示最后一个空字段
      if (index >= length) {
        pushField(EMPTY_FIELD);
        endRow();
        break;
      }
      continue;
    }
    if (next === '\r') {
      index += 1;
      if (text.charAt(index) === '\n') index += 1;
      endRow();
      if (index >= length) break;
      continue;
    }
    if (next === '\n') {
      index += 1;
      endRow();
      if (index >= length) break;
      continue;
    }
    endRow();
    break;
  }

  return Object.freeze(rows.map((fields) => Object.freeze(fields)));
}

// ---------------------------------------------------------------------------
// CSV：类型判定（每一类都有确定的、可复述的规则）
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` → epoch 毫秒；不是**真实存在的日期**返回 `null`（`2026-02-30` 不被静默进位）。 */
function parseIsoDate(text: string): number | null {
  const match = ISO_DATE_PATTERN.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = timestampFromCivilUtc(year, month, day);
  // 用纯整数 civil 算法**读回**校验：`2026-02-30` 会被静默进位成 3 月，这里必须识别出来（R248 口径）。
  // 刻意不用 `new Date()`：合同 R50.4 禁该 token（内核零墙非确定性）。
  const back = civilFromDays(dayNumberUtc(ms));
  if (back.year !== year || back.month !== month || back.day !== day) {
    return null;
  }
  return ms;
}

/** `'auto'` 口径下的类型推断（**保守**：拿不准就是文本）。 */
function inferCellValue(text: string): CellValue {
  if (NUMBER_PATTERN.test(text)) return numberValue(Number(text));
  const upper = text.toUpperCase();
  if (upper === 'TRUE') return booleanValue(true);
  if (upper === 'FALSE') return booleanValue(false);
  const dateOnly = parseIsoDate(text);
  if (dateOnly !== null) return dateValue(dateOnly);
  if (ISO_DATETIME_PATTERN.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return dateValue(parsed);
  }
  return textValue(text);
}

/** 显式类型的字段解析：不符合该类型 ⇒ **抛**（不静默退回文本）。 */
function requireTypedValue(text: string, type: Exclude<CsvCellType, 'text' | 'auto'>, where: string): CellValue {
  if (type === 'number') {
    if (!NUMBER_PATTERN.test(text)) {
      throw new ValidationError(`${where} 声明为 number，但字段 ${JSON.stringify(text)} 不是严格十进制数`);
    }
    return numberValue(Number(text));
  }
  if (type === 'boolean') {
    const upper = text.toUpperCase();
    if (upper === 'TRUE') return booleanValue(true);
    if (upper === 'FALSE') return booleanValue(false);
    throw new ValidationError(`${where} 声明为 boolean，但字段 ${JSON.stringify(text)} 既不是 TRUE 也不是 FALSE`);
  }
  const dateOnly = parseIsoDate(text);
  if (dateOnly !== null) return dateValue(dateOnly);
  const timestamp = ISO_DATETIME_PATTERN.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isFinite(timestamp)) return dateValue(timestamp);
  throw new ValidationError(
    `${where} 声明为 date，但字段 ${JSON.stringify(text)} 不是 YYYY-MM-DD 或 UTC ISO 8601 时间戳`,
  );
}

function parseCsvCell(field: CsvField, type: CsvCellType, where: string): CellValue {
  if (field.text === '') {
    // 引号空串是"显式的空文本"，裸空字段是"没有值"——二者不是同一件事（R248 的口径）。
    return field.quoted ? textValue('') : blank;
  }
  if (type === 'text') return textValue(field.text);
  if (type === 'auto') {
    // 作者加引号 = 显式声明"这是文本"，比任何启发式都可靠。
    return field.quoted ? textValue(field.text) : inferCellValue(field.text);
  }
  return requireTypedValue(field.text, type, where);
}

// ---------------------------------------------------------------------------
// CSV：导入
// ---------------------------------------------------------------------------

/**
 * CSV 文本 / 字节 → 工作簿（单表）。
 *
 * @throws {ValidationError} 编码不符、字段非法、类型不符
 */
export function importCsvWorkbook(bytes: Uint8Array, options: CsvImportOptions = {}): CsvImportResult {
  const delimiter = options.delimiter ?? ',';
  const sheetName = options.sheet_name ?? 'Sheet1';
  const typeMode = options.type_mode ?? 'text';
  const decoded = decodeCsv(bytes, options.encoding ?? 'auto');
  const rows = parseCsvRows(decoded.text, delimiter);

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let sheet = createSheet(sheetName, {
    row_count: Math.max(rows.length, 1),
    column_count: Math.max(width, 1),
  });
  rows.forEach((row, rowIndex) => {
    row.forEach((field, columnIndex) => {
      const columnType = options.column_types?.[columnIndex] ?? typeMode;
      const ref = formatCellAddress({ column: columnIndex + 1, row: rowIndex + 1 });
      const value = parseCsvCell(field, columnType, `CSV 第 ${String(rowIndex + 1)} 行第 ${String(columnIndex + 1)} 列`);
      if (value.kind === 'blank') return; // 空白字段**不落格**：读回来仍是 blank，不是 0、不是 ""
      sheet = setCellValue(sheet, ref, value);
    });
  });

  return Object.freeze({
    workbook: createWorkbook([sheet]),
    sheet_name: sheetName,
    encoding: decoded.encoding,
    delimiter,
    had_bom: decoded.had_bom,
    row_count: rows.length,
    column_count: width,
  });
}

// ---------------------------------------------------------------------------
// CSV：导出
// ---------------------------------------------------------------------------

function needsQuotes(text: string, delimiter: CsvDelimiter): boolean {
  return (
    text.includes('"') ||
    text.includes(delimiter) ||
    text.includes('\n') ||
    text.includes('\r') ||
    /^\s/.test(text) ||
    /\s$/.test(text)
  );
}

function quoteCsvField(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** 一个待写出格的上下文（公式格的求值需要它）。 */
interface CsvCellContext {
  readonly workbook: WorkbookState;
  readonly sheet: string;
  readonly address: CellAddress;
  readonly where: string;
  readonly delimiter: CsvDelimiter;
  readonly quote: 'minimal' | 'all-text';
  readonly formulas: 'error' | 'value';
}

function csvCellText(value: CellValue, context: CsvCellContext): string {
  const encodeText = (text: string): string =>
    context.quote === 'all-text' || needsQuotes(text, context.delimiter) ? quoteCsvField(text) : text;

  switch (value.kind) {
    case 'blank':
      return ''; // 空字段（不是 0，也不是 ""）——R248
    case 'text':
      return encodeText(value.value);
    case 'number':
      return String(value.value);
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE';
    case 'date':
      return formatIsoTimestampUtc(value.epoch_ms);
    case 'error':
      return value.code;
    case 'formula': {
      if (context.formulas === 'error') {
        throw new ValidationError(
          `CSV 装不下公式（${context.where} 是 ${JSON.stringify(value.text)}）：默认显式失败，` +
            '不把公式写成固化数值。要导出求值结果请显式给 formulas: "value"',
        );
      }
      const outcome = evaluateWorkbookCell(context.workbook, context.sheet, context.address);
      if (!outcome.ok) {
        throw new ValidationError(
          `CSV 导出 formulas: "value" 时 ${context.where} 的公式 ${JSON.stringify(value.text)} 求值被阻塞` +
            `（${outcome.reason}：${outcome.detail}）：不写一个猜出来的值`,
        );
      }
      return csvCellText(outcome.value, { ...context, formulas: 'error' });
    }
    default: {
      const never: never = value;
      throw new ValidationError(`未覆盖的取值类别：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 工作簿 → CSV 字节。
 *
 * 导出范围是**有内容的矩形范围**（不写 `SheetState` 声明出来的 1000 行空表）；
 * 范围内的空白格写成**空字段**。
 *
 * @throws {ValidationError} 工作表不存在 / 多表未指定 / 公式格（默认口径）/ 编码不支持
 */
export function exportWorkbookCsv(workbook: WorkbookState, options: CsvExportOptions = {}): CsvExportResult {
  const delimiter = options.delimiter ?? ',';
  const newline = options.newline ?? 'lf';
  const encoding = options.encoding ?? 'utf-8';
  const quote = options.quote ?? 'minimal';
  const formulas = options.formulas ?? 'error';

  let sheet: SheetState | undefined;
  if (options.sheet === undefined) {
    if (workbook.sheets.length > 1) {
      throw new ValidationError(
        `工作簿有 ${String(workbook.sheets.length)} 张工作表，CSV 只能装一张：` +
          `必须显式指定 sheet（可选：${workbook.sheets.map((item) => item.name).join(' / ')}）`,
      );
    }
    sheet = activeSheet(workbook);
  } else {
    sheet = getSheet(workbook, options.sheet);
    if (sheet === undefined) {
      throw new ValidationError(`exportWorkbookCsv：工作簿里没有工作表 ${JSON.stringify(options.sheet)}`);
    }
  }

  let maxRow = 0;
  let maxColumn = 0;
  for (const entry of sheetEntries(sheet)) {
    const address = parseCellAddress(entry.ref);
    maxRow = Math.max(maxRow, address.row);
    maxColumn = Math.max(maxColumn, address.column);
  }

  const lines: string[] = [];
  for (let row = 1; row <= maxRow; row += 1) {
    const fields: string[] = [];
    for (let column = 1; column <= maxColumn; column += 1) {
      const address = { column, row };
      const ref = formatCellAddress(address);
      const value = sheet.cells.get(ref) ?? blank;
      fields.push(
        csvCellText(value, {
          workbook,
          sheet: sheet.name,
          address,
          where: `${sheet.name}!${ref}`,
          delimiter,
          quote,
          formulas,
        }),
      );
    }
    lines.push(fields.join(delimiter));
  }

  const text = lines.length === 0 ? '' : `${lines.join(newline === 'crlf' ? '\r\n' : '\n')}\n`;
  return Object.freeze({
    bytes: encodeCsvBytes(text, encoding),
    sheet: sheet.name,
    encoding,
    delimiter,
    newline,
    had_bom: encoding === 'utf-8-bom',
    row_count: maxRow,
    column_count: maxColumn,
  });
}

// ---------------------------------------------------------------------------
// 工作簿文件层会话（XLS-01：新建 / 导入 / 另存 / 重命名 / 保存关闭重开）
// ---------------------------------------------------------------------------

/**
 * 一份**打开了的工作簿**：文件名 + 模型 + 读回时的残留。
 *
 * 残留必须跟模型一起走，否则未知部件（`docProps/`、工作表级关系……）会在下一次保存时
 * 无声消失——这正是 {@link saveWorkbookDocument} 不接受裸 `WorkbookState` 的原因。
 */
export interface WorkbookDocument {
  readonly file_name: string;
  readonly workbook: WorkbookState;
  readonly residual: XlsxResidual;
  /** 来源字节的 sha256（新建为 `null`）：供"保存关闭重开"这条路上的身份核对。 */
  readonly source_digest: string | null;
}

function requireFileName(fileName: unknown, where: string): string {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new ValidationError(`${where} 的文件名必须是非空字符串`);
  }
  if (/[\\/]/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new ValidationError(`${where} 的文件名不得含路径分隔符（只给文件名，不给路径）：${JSON.stringify(fileName)}`);
  }
  return fileName;
}

/** 新建一份空工作簿文档（默认一张 `Sheet1`，与 Excel 新建一致）。 */
export function createWorkbookDocument(fileName: string, sheets?: readonly SheetState[]): WorkbookDocument {
  const name = requireFileName(fileName, 'createWorkbookDocument');
  return Object.freeze({
    file_name: name,
    workbook: createWorkbook(sheets),
    residual: EMPTY_RESIDUAL,
    source_digest: null,
  });
}

/** 打开（导入）一份 .xlsx 字节。 */
export function openWorkbookDocument(fileName: string, bytes: Uint8Array): WorkbookDocument {
  const name = requireFileName(fileName, 'openWorkbookDocument');
  const { workbook, residual } = readWorkbookXlsx(bytes);
  return Object.freeze({ file_name: name, workbook, residual, source_digest: xlsxContentDigest(bytes) });
}

/** `xl/sharedStrings.xml` 的部件路径（本模块**从不产出**它，只在读回的外部包里认得它）。 */
const SHARED_STRINGS_PART_PATH = 'xl/sharedStrings.xml';

/**
 * 文件层对**文本单元格**的表示口径：**`inlineStr`**（不产出 `xl/sharedStrings.xml`）。
 *
 * ## 为什么是 `inlineStr`（刻意的决策，不是遗漏）
 *
 * - **自洽**：文本随格走（`<c t="inlineStr"><is><t>…</t></is></c>`），不引一张与工作表分离的
 *   索引表，也就不存在"索引越界 / 表与格不同步"这一类只有 sharedStrings 才有的失效面。
 * - **读侧已覆盖外部写法**：真实 Excel / WPS 常用 `t="s"` + `xl/sharedStrings.xml`，读回时
 *   `xlsx-read.ts` 把它们**解析进模型**（`t="s"` 按下标取文本）。因此"外部包用 sharedStrings、
 *   本仓另存为 inlineStr"是一次**表示迁移**，单元格取值不变——用 {@link SharedStringsSaveDecision}
 *   与 `dropped_relationships` 显式登记，而不是静默发生。
 * - **写出的是合法 OOXML**：`inlineStr` 是 ECMA-376 的正式表示，消费端（Excel / WPS / 安卓 Office）
 *   可正常打开。
 *
 * ## 代价（如实登记，不夸大）
 *
 * 写出**不产出** `xl/sharedStrings.xml`，于是源包里指向它的工作簿关系会在保存时被登记丢弃
 * （见 {@link WorkbookSaveResult.dropped_relationships}）。丢的是**关系的表示方式**，不是文本
 * 内容本身（内容已随 inlineStr 写回）。本常量把这一决策固定在类型层，供调用方与测试核对。
 */
export const XLSX_TEXT_CELL_REPRESENTATION = 'inlineStr' as const;

/**
 * 保存时关于 `sharedStrings` 的**显式决策记录**。
 *
 * 这是把"writer 用 inlineStr、源包的 sharedStrings 关系被丢弃"从隐式行为变成**可核对的字段**：
 * 调用方无需解析错误字符串，就能区分"这次保存发生了 sharedStrings 表示迁移"与普通保存。
 */
export interface SharedStringsSaveDecision {
  /** 本模块**从不**产出 `xl/sharedStrings.xml`（恒为 `false`）。 */
  readonly emitted: false;
  /** 文本单元格的表示口径（恒为 {@link XLSX_TEXT_CELL_REPRESENTATION}）。 */
  readonly text_cell_representation: typeof XLSX_TEXT_CELL_REPRESENTATION;
  /** 源包**是否**带 `xl/sharedStrings.xml` 的工作簿关系（外部 Excel / WPS 常见）。 */
  readonly source_used_shared_strings: boolean;
  /** 源包的 `sharedStrings` 关系**是否**被登记丢弃（源用过、且本次写出未保留该部件）。 */
  readonly dropped: boolean;
}

/** 源包的保留关系里是否有"指向 `xl/sharedStrings.xml`"的内部声明。 */
function residualUsedSharedStrings(document: WorkbookDocument): boolean {
  return document.residual.relationships.some((group) =>
    group.declarations.some((declaration) => {
      if (declaration.target_mode === 'External') return false;
      try {
        return resolveRelationshipTarget(group.owner_part_path, declaration.target) === SHARED_STRINGS_PART_PATH;
      } catch {
        return false; /* c8 ignore next -- 读回时目标已被解析过；防御性兜底 */
      }
    }),
  );
}

/** 保存结果（含 R249 的**正向证据**：哪些未知部件被原样带回）。 */
export interface WorkbookSaveResult {
  readonly file_name: string;
  readonly bytes: Buffer;
  readonly content_digest: string;
  readonly entry_count: number;
  readonly evaluations: readonly FormulaEvaluationRecord[];
  readonly preserved_part_paths: readonly string[];
  readonly dropped_relationships: readonly string[];
  /** `sharedStrings` 表示口径的**显式决策**（见 {@link SharedStringsSaveDecision}）。 */
  readonly shared_strings: SharedStringsSaveDecision;
}

/** 保存（写出 .xlsx 字节）：**残留一起写出**，未知部件不会被静默丢掉。 */
export function saveWorkbookDocument(document: WorkbookDocument): WorkbookSaveResult {
  const written = writeWorkbookXlsx(document.workbook, document.residual);
  const usedSharedStrings = residualUsedSharedStrings(document);
  // `dropped` 以**写出的真实结果**为准：源用过 sharedStrings，且本模块确实没有把该部件保留下来。
  // （读侧把 `xl/sharedStrings.xml` 视为已知部件、不放进残留，故它不会出现在 preserved_part_paths。）
  const sharedStrings: SharedStringsSaveDecision = Object.freeze({
    emitted: false,
    text_cell_representation: XLSX_TEXT_CELL_REPRESENTATION,
    source_used_shared_strings: usedSharedStrings,
    dropped: usedSharedStrings && !written.preserved_part_paths.includes(SHARED_STRINGS_PART_PATH),
  });
  return Object.freeze({
    file_name: document.file_name,
    bytes: written.bytes,
    content_digest: written.content_digest,
    entry_count: written.entry_count,
    evaluations: written.evaluations,
    preserved_part_paths: written.preserved_part_paths,
    dropped_relationships: written.dropped_relationships,
    shared_strings: sharedStrings,
  });
}

/** 重命名（只改文件名，内容与残留一字不动）。 */
export function renameWorkbookDocument(document: WorkbookDocument, fileName: string): WorkbookDocument {
  return Object.freeze({ ...document, file_name: requireFileName(fileName, 'renameWorkbookDocument') });
}

/** 另存为（换名 + 立即写出）：内容与原件逐字节一致，只有文件名不同。 */
export function saveWorkbookDocumentAs(
  document: WorkbookDocument,
  fileName: string,
): { readonly document: WorkbookDocument; readonly save: WorkbookSaveResult } {
  const renamed = renameWorkbookDocument(document, fileName);
  return Object.freeze({ document: renamed, save: saveWorkbookDocument(renamed) });
}

/** 关闭后重新打开：用**刚写出的字节**建立一份全新文档（残留从字节重新读回）。 */
export function reopenWorkbookDocument(document: WorkbookDocument, bytes: Uint8Array): WorkbookDocument {
  return openWorkbookDocument(document.file_name, bytes);
}

/** 把编辑后的模型装回文档（**残留、文件名、来源摘要都保留**）。 */
export function withWorkbookEdits(document: WorkbookDocument, workbook: WorkbookState): WorkbookDocument {
  return Object.freeze({ ...document, workbook });
}

/** 文档里登记的未知部件路径（保存前后可逐条核对）。 */
export function unknownPartPaths(document: WorkbookDocument): readonly string[] {
  return Object.freeze(document.residual.parts.map((part) => part.path));
}

// ---------------------------------------------------------------------------
// XLS-18：跨模板事实发布的**接口点**（只登记，不实现）
// ---------------------------------------------------------------------------

/**
 * 一次"同版事实"发布请求（由表格侧发起）。
 *
 * `fact_keys` 是这次被改动、需要向别的模板发布同版取值的共享事实键；
 * `artifact_revision` / `source_digest` 用来让消费端判断"拿到的是哪一版"。
 */
export interface CrossTemplateFactPublicationRequest {
  readonly fact_keys: readonly string[];
  /** 事实所属的产出物版本标识（由上层记忆 / 版本层提供，本模块不发明）。 */
  readonly artifact_revision: string;
  /** 表格侧字节摘要（`WorkbookSaveResult.content_digest`）。 */
  readonly source_digest: string;
}

/** 发布回执（未实现，故只有形状）。 */
export interface CrossTemplateFactPublicationReceipt {
  readonly published_fact_keys: readonly string[];
  readonly targets: readonly ('docx' | 'pptx')[];
  readonly artifact_revision: string;
}

/**
 * XLS-18「向文档 / PPT 发布同版事实」的对接点。
 *
 * **本轮只登记，不实现**：发布通道属于文档池 / PPT 池（以及记忆层的共享事实记录），
 * 不在本工作包的写权内。`publish` 一律抛错，绝不返回一个假的回执——
 * "接口点存在"与"能力已具备"必须能被调用方区分。
 */
export interface CrossTemplateFactPublicationPort {
  readonly port_id: 'xls18.cross_template_fact_publication';
  readonly status: 'unimplemented';
  readonly consumers: readonly ('docx' | 'pptx')[];
  publish(request: CrossTemplateFactPublicationRequest): CrossTemplateFactPublicationReceipt;
}

/** 已登记的接口点单例。 */
export const XLS18_FACT_PUBLICATION_PORT: CrossTemplateFactPublicationPort = Object.freeze({
  port_id: 'xls18.cross_template_fact_publication' as const,
  status: 'unimplemented' as const,
  consumers: Object.freeze(['docx', 'pptx'] as const),
  publish(): CrossTemplateFactPublicationReceipt {
    throw new ValidationError(
      'XLS-18 的跨模板事实发布尚未实现（接口点已登记）：它要接到文档 / PPT 池的"同版事实"发布通道，' +
        '本轮不实现，也不返回假回执',
    );
  },
});
