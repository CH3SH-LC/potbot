/**
 * **表格（XLSX）文件层交付适配器** —— `src/spreadsheets/xls-io.ts` 的**消费端**接线（design-06-P8 / R247–R250）。
 *
 * ## 这个文件为什么存在（V-9：死模块）
 *
 * `src/spreadsheets/xls-io.ts`（CSV 编解码 + **文件层会话** + XLS-18 接口点）此前**全仓引用数为 0**：
 * 同目录的 `index.ts` 把它 `export *` 出去了（内核侧可见），但**没有任何产品 / 适配器消费它**——
 * 它是"仅测试可达"的典型。本文件就是那条**产品形状**的消费边：
 * 与 `src/session/adapters/xlsx.ts` **同形**（同一个 {@link DeliverableAdapter} 接缝、同一套
 * `CellValue` 词汇、同一套结构化失败口径），把**文件层会话**（新建 / 导入 / 另存 / 关闭重开）
 * 接进会话交付链。
 *
 * ## 它**只加**三件事，其余一律复用（不另造）
 *
 * | 加的东西 | 为什么非加不可 |
 * |---|---|
 * | **会话动词**（{@link newDeliverable} / {@link openDeliverableFromXlsx} / {@link saveDeliverableAs} / {@link reopenDeliverable} …） | 让文件层会话在会话交付链上有一个**名字**；每个动词都**直接转调** `xls-io.ts`，不含第二套实现 |
 * | **CSV 的显式口径与两道守卫** | `xls-io` 已把编码 / 分隔符做成显式参数；本层再挡两种**静默成功**：声明了某编码却读不过去、声明了某分隔符却一次都没出现（见 {@link importDeliverableFromCsv}） |
 * | **XLS-18 的结构化 `not-wired`** | 端口未实现，`publish` 会抛；本层把它**转成结构化结论**（{@link XlsxFactPublicationOutcome}），`claimed_published` 恒为字面量 `false` |
 *
 * 会话语义（文件名 + 模型 + **残留**绑在一起走）来自 `WorkbookDocument`：本适配器的源**就是**
 * `WorkbookDocument`，不是"再造一个壳"。因此 {@link saveDeliverable} **必然**带上残留——
 * `xls-io.ts` 那条"不接受裸 `WorkbookState`"的纪律在这里**结构上无法绕过**。
 *
 * ## R249：未知部件不得被静默丢弃（正向证据 + 一道会失败的检查）
 *
 * 保存结果里 `preserved_part_paths` 是"哪些未知部件被原样带回"的**正向证据**；
 * {@link unknownPartsDropped} 把它与文档登记的未知部件逐条比对，非空即**结构化失败**
 * （`unknown_part_dropped`）——而不是把"少了一个部件"写进日志了事。
 *
 * ## 本文件**不做**的事（如实登记，不夸大）
 *
 * - **不打开 / 不验证消费端**：安卓 WPS / Excel 能否打开、编辑、另存**本轮未做**，标"未验证"。
 *   本文件里的"保存关闭重开"是**文件层**往返，不是真机往返。
 * - **不实现 XLS-18**：只把"未接线"如实转达（见上表第三行）。
 * - **不嗅探编码 / 分隔符**：一切显式；拿不准就**显式失败**，不猜（那是"结果不得编造"的形状）。
 * - **不落盘、不读盘、不读墙钟**：本文件是纯的（`src/**` 的 W-DISC 机器化断言）。
 */

import { ValidationError, type TemplateKind } from '../../protocol/index.js';
import {
  CSV_DELIMITERS,
  SPREADSHEET_ERROR_CODES,
  XLS18_FACT_PUBLICATION_PORT,
  addSheet,
  clearCell,
  createSheet,
  createWorkbookDocument,
  exportWorkbookCsv,
  getCellValue,
  getSheet,
  hasCell,
  importCsvWorkbook,
  openWorkbookDocument,
  removeSheet,
  renameSheet,
  renameWorkbookDocument,
  reopenWorkbookDocument,
  saveWorkbookDocument,
  saveWorkbookDocumentAs,
  setActiveSheet,
  setCellValue,
  sheetNames,
  unknownPartPaths,
  valuesEqual,
  withWorkbookEdits,
  type CellValue,
  type CsvDelimiter,
  type CsvExportEncoding,
  type CsvExportOptions,
  type CsvImportEncoding,
  type CsvImportOptions,
  type CsvImportResult,
  type CsvNewline,
  type SheetState,
  type SpreadsheetErrorCode,
  type WorkbookDocument,
  type WorkbookSaveResult,
} from '../../spreadsheets/index.js';
import { digestBytes } from '../canonical.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterImportResult,
  DeliverableAdapter,
} from '../adapter.js';
import type { FileFormat } from '../formats.js';

// ---------------------------------------------------------------------------
// 形状常量
// ---------------------------------------------------------------------------

const FORMAT: FileFormat = 'xlsx';
const TEMPLATE_KIND: TemplateKind = 'spreadsheet';

/**
 * `DeliverableAdapter.importBytes` **没有文件名参数**（接口如此），而 `WorkbookDocument`
 * 要求一个非空文件名。故这里用一条**显式常量**当默认名，而不是让适配器去猜一个名字；
 * 要改名用 `rename_file` 编辑或 {@link renameDeliverable}。
 */
export const DEFAULT_IMPORTED_FILE_NAME = '导入.xlsx';

// ---------------------------------------------------------------------------
// 源：**就是**文件层会话文档（不另造壳）
// ---------------------------------------------------------------------------

/**
 * 交付源 = `xls-io.ts` 的 {@link WorkbookDocument}（文件名 + 模型 + 残留 + 来源摘要）。
 *
 * 直接用它当源，而不是像 `adapters/xlsx.ts` 那样另定义一个 `{workbook, residual}`：
 * 那一层之所以要包，是因为它的源只有 `WorkbookState`；文件层会话**本来就把该带的东西绑好了**，
 * 再包一层只会让"残留跟不跟得走"重新变成一个可以被忘掉的问题。
 */
export type XlsxIoDeliverableSource = WorkbookDocument;

// ---------------------------------------------------------------------------
// 取值形状校验（与 `adapters/xlsx.ts` 同一套七类判别联合；该校验函数未导出，故此处同形重写）
// ---------------------------------------------------------------------------

function readCellValue(raw: unknown): CellValue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  switch (record['kind']) {
    case 'blank':
      return Object.freeze({ kind: 'blank' as const });
    case 'number': {
      const value = record['value'];
      return typeof value === 'number' && Number.isFinite(value)
        ? Object.freeze({ kind: 'number' as const, value })
        : null;
    }
    case 'text': {
      const value = record['value'];
      return typeof value === 'string' ? Object.freeze({ kind: 'text' as const, value }) : null;
    }
    case 'boolean': {
      const value = record['value'];
      return typeof value === 'boolean' ? Object.freeze({ kind: 'boolean' as const, value }) : null;
    }
    case 'date': {
      const epoch = record['epoch_ms'];
      return typeof epoch === 'number' && Number.isFinite(epoch)
        ? Object.freeze({ kind: 'date' as const, epoch_ms: epoch })
        : null;
    }
    case 'error': {
      const code = record['code'];
      return typeof code === 'string' && (SPREADSHEET_ERROR_CODES as readonly string[]).includes(code)
        ? Object.freeze({ kind: 'error' as const, code: code as SpreadsheetErrorCode })
        : null;
    }
    case 'formula': {
      const text = record['text'];
      return typeof text === 'string' && text.length > 0
        ? Object.freeze({ kind: 'formula' as const, text })
        : null;
    }
    default:
      return null;
  }
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${field} 必须是非空字符串`);
  }
  return raw;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 会话动词（新建 / 导入 / 另存 / 重命名 / 关闭重开）——全部**转调** xls-io.ts
// ---------------------------------------------------------------------------

/**
 * 新建一份空工作簿文档（默认一张 `Sheet1`，与 Excel 新建一致）。
 *
 * 表数**由调用方决定**（R250：不得只有一张固定分项表）。
 *
 * @throws {ValidationError} 文件名非法 / 表名非法
 */
export function newDeliverable(fileName: string, ...sheetNames: readonly string[]): WorkbookDocument {
  return createWorkbookDocument(
    fileName,
    sheetNames.length === 0 ? undefined : sheetNames.map((name) => createSheet(name)),
  );
}

/** 打开（导入）一份既有 .xlsx 字节；失败**结构化**返回，不抛穿会话层。 */
export function openDeliverableFromXlsx(
  fileName: string,
  bytes: Uint8Array,
): AdapterImportResult<XlsxIoDeliverableSource> {
  try {
    return { ok: true, source: openWorkbookDocument(fileName, bytes) };
  } catch (error) {
    return { ok: false, kind: 'xlsx_read_failed', detail: describeError(error) };
  }
}

/** 另存为（换名 + 立即写出）；失败结构化返回。内容与原件逐字节一致，只有文件名不同。 */
export function saveDeliverableAs(
  document: XlsxIoDeliverableSource,
  fileName: string,
): XlsxIoSaveOutcome {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    return { ok: false, kind: 'xlsx_write_failed', detail: '另存的文件名必须是非空字符串' };
  }
  try {
    const { document: renamed, save } = saveWorkbookDocumentAs(document, fileName);
    return wrapSave(renamed, save);
  } catch (error) {
    return { ok: false, kind: 'xlsx_write_failed', detail: describeError(error) };
  }
}

/** 重命名（只改文件名，内容与残留一字不动）。 */
export function renameDeliverable(
  document: XlsxIoDeliverableSource,
  fileName: string,
): AdapterEditResult<XlsxIoDeliverableSource> {
  try {
    const renamed = renameWorkbookDocument(document, fileName);
    return {
      ok: true,
      source: renamed,
      changed: renamed.file_name !== document.file_name,
      notes: Object.freeze([`文件名 ${document.file_name} 改为 ${renamed.file_name}`]),
    };
  } catch (error) {
    return { ok: false, kind: 'invalid_edit', detail: describeError(error) };
  }
}

/** 关闭后重新打开：用**刚写出的字节**建立一份全新文档（残留从字节重新读回）。失败结构化返回。 */
export function reopenDeliverable(
  document: XlsxIoDeliverableSource,
  bytes: Uint8Array,
): AdapterImportResult<XlsxIoDeliverableSource> {
  try {
    return { ok: true, source: reopenWorkbookDocument(document, bytes) };
  } catch (error) {
    return { ok: false, kind: 'xlsx_read_failed', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// 保存：正向证据 + 「未知部件不得被静默丢弃」的检查
// ---------------------------------------------------------------------------

/** 写出结果里"哪些未知部件被原样带回"的部分（比 `XlsxWriteResult` 更窄，便于对照）。 */
export interface XlsxIoPreservingWrite {
  readonly preserved_part_paths: readonly string[];
}

/**
 * 保存结果（含 R249 的**正向证据**：{@link XlsxIoPreservingWrite}）。
 *
 * 失败是**结构化**的：`unknown_part_dropped` 表示文档登记的未知部件没有全部出现在
 * 写出的证据里——那正是"静默丢东西"的形状，必须当场失败，而不是记一条日志继续。
 */
export type XlsxIoSaveOutcome =
  | {
      readonly ok: true;
      readonly document: XlsxIoDeliverableSource;
      readonly save: WorkbookSaveResult;
    }
  | {
      readonly ok: false;
      readonly kind: 'xlsx_write_failed' | 'unknown_part_dropped';
      readonly detail: string;
    };

/**
 * 文档登记的未知部件里，**没有**出现在写出证据中的那些（空数组 = 一个都没丢）。
 *
 * 第二条参数是**结构性**的（只要给得出 `preserved_part_paths` 即可）：这样"丢部件会被抓到"
 * 这条断言可以用一个**空证据**直接构造出来做反向对照，而不是只在真写出时才是真的。
 */
export function unknownPartsDropped(
  document: XlsxIoDeliverableSource,
  write: XlsxIoPreservingWrite,
): readonly string[] {
  const kept = new Set(write.preserved_part_paths);
  return Object.freeze(unknownPartPaths(document).filter((path) => !kept.has(path)));
}

function wrapSave(
  document: XlsxIoDeliverableSource,
  save: WorkbookSaveResult,
): XlsxIoSaveOutcome {
  const dropped = unknownPartsDropped(document, save);
  if (dropped.length > 0) {
    return {
      ok: false,
      kind: 'unknown_part_dropped',
      detail:
        `保存时未知部件被静默丢弃（R249）：${dropped.join('、')}。` +
        '文档层登记的未知部件必须与 preserved_part_paths 逐条对上；发出一个"少部件"的文件不算成功。',
    };
  }
  return { ok: true, document, save };
}

/**
 * 保存（写出真实 .xlsx 字节）：**残留一起写出**，未知部件不会被静默丢掉。
 *
 * 文件名不变（要换名请用 {@link saveDeliverableAs}）。
 */
export function saveDeliverable(document: XlsxIoDeliverableSource): XlsxIoSaveOutcome {
  try {
    return wrapSave(document, saveWorkbookDocument(document));
  } catch (error) {
    return { ok: false, kind: 'xlsx_write_failed', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// CSV 导入 / 导出：口径**全部显式**，不符即显式失败
// ---------------------------------------------------------------------------

/**
 * CSV 失败的结构化类别（供调用方决定怎么报，而不是解析一段人话）。
 *
 * `csv_encoding_mismatch` / `csv_field_invalid` 的分类依据是底层 `ValidationError` 的文本，
 * 而那几句话**已被 `src/spreadsheets/xls-io.test.ts` 钉住**（如 `/不是合法的 UTF-8/`）——
 * 底层口径一旦改动，那边会先红。
 */
export type XlsxIoCsvFailureKind =
  | 'csv_encoding_mismatch'
  | 'csv_delimiter_mismatch'
  | 'csv_content_invalid'
  | 'csv_formulas_not_representable'
  | 'csv_sheet_selection_invalid'
  | 'csv_import_failed'
  | 'csv_export_failed';

const ENCODING_FAILURE_PATTERN = /不是合法的 (UTF-8|GBK)|没有 UTF-8 BOM|GBK 无 BOM/;
const FORMULA_FAILURE_PATTERN = /CSV 装不下公式|求值被阻塞/;
const SHEET_FAILURE_PATTERN = /必须显式指定 sheet|工作簿里没有工作表/;

function classifyImportFailure(error: unknown): XlsxIoCsvFailureKind {
  const detail = describeError(error);
  if (ENCODING_FAILURE_PATTERN.test(detail)) return 'csv_encoding_mismatch';
  return 'csv_content_invalid';
}

function classifyExportFailure(error: unknown): XlsxIoCsvFailureKind {
  const detail = describeError(error);
  if (FORMULA_FAILURE_PATTERN.test(detail)) return 'csv_formulas_not_representable';
  if (SHEET_FAILURE_PATTERN.test(detail)) return 'csv_sheet_selection_invalid';
  return 'csv_export_failed';
}

/** 导入选项 = `xls-io` 的显式口径 + 一条"确实只有一列"的显式声明（见下）。 */
export interface XlsxIoCsvImportOptions extends CsvImportOptions {
  /**
   * 显式声明：**这份 CSV 确实只有一列**（且正文里含其它候选分隔符字符）。
   *
   * 不声明时，若"声明的分隔符在源字节里一次都没出现、而别的候选分隔符出现了"，
   * 本层**显式失败**（`csv_delimiter_mismatch`）——这正是"分号文件按逗号读"的形状。
   * 真的只有一列时，调用方给出本声明即可放行：**是显式声明，不是嗅探。**
   */
  readonly single_column?: boolean;
}

/** 导入结果：**实际使用**的编码 / 分隔符随结论一起回报，供调用方核对。 */
export type XlsxIoCsvImportOutcome =
  | {
      readonly ok: true;
      readonly source: XlsxIoDeliverableSource;
      readonly sheet_name: string;
      /** `auto` 已解析成具体结论（不把"猜"当成结论）。 */
      readonly encoding: Exclude<CsvImportEncoding, 'auto'>;
      readonly delimiter: CsvDelimiter;
      readonly had_bom: boolean;
      readonly row_count: number;
      readonly column_count: number;
    }
  | { readonly ok: false; readonly kind: XlsxIoCsvFailureKind; readonly detail: string };

/** `,` / `;` / `\t` / `|` 都是单字节 ASCII：直接按字节值比对即可，无需先解码（对 GBK / UTF-8 同样成立）。 */
function delimiterByte(delimiter: CsvDelimiter): number {
  return delimiter.charCodeAt(0);
}

/**
 * 分隔符守卫：**声明的分隔符一个都没出现、而别的候选分隔符出现了** ⇒ 抛。
 *
 * 这不是嗅探（本层不猜该用哪个分隔符），而是**拒绝静默成功**：一列 `a;b;c` 读成单列
 * `"a;b;c"` 是"看起来成功、其实读错了"的典型——那种成功比失败更难查。
 *
 * @throws {ValidationError}
 */
function guardDeclaredDelimiter(
  bytes: Uint8Array,
  delimiter: CsvDelimiter,
  singleColumn: boolean,
): void {
  if (singleColumn) return;
  if (bytes.includes(delimiterByte(delimiter))) return;
  const other = CSV_DELIMITERS.filter((item) => item !== delimiter).find((item) =>
    bytes.includes(delimiterByte(item)),
  );
  if (other === undefined) return; // 别的候选分隔符也没出现 ⇒ 单列是合理的，放行
  throw new ValidationError(
    `声明的分隔符 ${JSON.stringify(delimiter)} 在源字节里一次都没出现，却出现了 ${JSON.stringify(other)}：` +
      '这多半是分隔符声明错了。本适配器不嗅探、不猜——请显式给出正确的 delimiter；' +
      '若这份 CSV 确实只有一列（且正文含其它候选分隔符字符），显式传 single_column: true。',
  );
}

function buildDocumentFromCsv(
  fileName: string,
  bytes: Uint8Array,
  imported: CsvImportResult,
): XlsxIoDeliverableSource {
  // 复用 `createWorkbookDocument`：文件名校验与文档构造都不再写第二份。
  // 再把 `source_digest` 覆写成"这份文档是从哪份源字节来的"（CSV 导入 ⇒ 是 CSV 字节的摘要）。
  const created = createWorkbookDocument(fileName, imported.workbook.sheets);
  return Object.freeze({ ...created, source_digest: digestBytes(bytes) });
}

/**
 * CSV 字节 → 交付源（单表工作簿文档）。
 *
 * 编码（`utf-8` / `utf-8-bom` / `gbk` / `auto`）、分隔符、类型口径（`type_mode` / `column_types`）
 * **全部显式**：默认口径是"一切都当文本"，不做 `007 → 7` 这类静默强转（R248）。
 *
 * 两种**静默成功**在这里被挡掉：
 * 1. 声明 `utf-8` 去读 GBK 字节 ⇒ `csv_encoding_mismatch`（严格解码，绝不替换成 U+FFFD）；
 * 2. 分号文件按逗号读 ⇒ `csv_delimiter_mismatch`（见 {@link guardDeclaredDelimiter}）。
 */
export function importDeliverableFromCsv(
  fileName: string,
  bytes: Uint8Array,
  options: XlsxIoCsvImportOptions = {},
): XlsxIoCsvImportOutcome {
  const delimiter = options.delimiter ?? ',';
  try {
    guardDeclaredDelimiter(bytes, delimiter, options.single_column ?? false);
  } catch (error) {
    return { ok: false, kind: 'csv_delimiter_mismatch', detail: describeError(error) };
  }
  let imported: CsvImportResult;
  try {
    imported = importCsvWorkbook(bytes, options);
  } catch (error) {
    return { ok: false, kind: classifyImportFailure(error), detail: describeError(error) };
  }
  try {
    return {
      ok: true,
      source: buildDocumentFromCsv(fileName, bytes, imported),
      sheet_name: imported.sheet_name,
      encoding: imported.encoding,
      delimiter: imported.delimiter,
      had_bom: imported.had_bom,
      row_count: imported.row_count,
      column_count: imported.column_count,
    };
  } catch (error) {
    // 只有文件名非法会走到这里（其余构造步骤已在上一步完成）。
    return { ok: false, kind: 'csv_import_failed', detail: describeError(error) };
  }
}

/** 导出结果：**实际使用**的编码 / 分隔符 / 换行随结论一起回报。 */
export type XlsxIoCsvExportOutcome =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly sheet: string;
      readonly encoding: CsvExportEncoding;
      readonly delimiter: CsvDelimiter;
      readonly newline: CsvNewline;
      readonly had_bom: boolean;
      readonly row_count: number;
      readonly column_count: number;
    }
  | { readonly ok: false; readonly kind: XlsxIoCsvFailureKind; readonly detail: string };

/**
 * 交付源 → CSV 字节（**不是**交付格式，是给"另存成 CSV"这条显式路径用的）。
 *
 * 默认口径与本仓一致：多表未指定 `sheet` ⇒ 显式失败；公式格默认**显式失败**
 * （不把公式写成固化数值）。
 */
export function exportDeliverableCsv(
  document: XlsxIoDeliverableSource,
  options: CsvExportOptions = {},
): XlsxIoCsvExportOutcome {
  try {
    const exported = exportWorkbookCsv(document.workbook, options);
    return {
      ok: true,
      bytes: exported.bytes,
      sheet: exported.sheet,
      encoding: exported.encoding,
      delimiter: exported.delimiter,
      newline: exported.newline,
      had_bom: exported.had_bom,
      row_count: exported.row_count,
      column_count: exported.column_count,
    };
  } catch (error) {
    return { ok: false, kind: classifyExportFailure(error), detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// XLS-18：跨模板事实发布的接口点 —— 未接线 ⇒ 结构化 `not-wired`
// ---------------------------------------------------------------------------

/** 一次发布尝试的输入（表格侧发起）。 */
export interface XlsxFactPublicationRequest {
  /** 这次被改动、需要向别的模板发布同版取值的共享事实键。 */
  readonly fact_keys: readonly string[];
  /** 事实所属的产出物版本标识（由上层记忆 / 版本层提供，本层不发明）。 */
  readonly artifact_revision: string;
}

/**
 * 发布结论。
 *
 * **`claimed_published` 恒为字面量 `false`**：本层**不**宣称"已在文档 / PPT 里生效"。
 * `XLS18_FACT_PUBLICATION_PORT` 今天 `status === 'unimplemented'`，调用它必抛；本层把那个
 * 抛错**转成结构化结论**，而不是把异常穿出会话层、也不是伪造一个回执。
 */
export interface XlsxFactPublicationOutcome {
  readonly status: 'not-wired';
  readonly port_id: 'xls18.cross_template_fact_publication';
  readonly port_status: 'unimplemented';
  readonly targets: readonly ('docx' | 'pptx')[];
  readonly requested_fact_keys: readonly string[];
  /** 这次发布**指向的**表格字节版本（`WorkbookSaveResult.content_digest`）。 */
  readonly source_digest: string;
  readonly artifact_revision: string;
  readonly claimed_published: false;
  readonly reason: string;
  readonly unlock: string;
}

const NOT_WIRED_UNLOCK =
  '解锁条件：文档池 / PPT 池实现"同版事实"发布通道（`CrossTemplateFactPublicationPort.publish`），' +
  '并把该通道装配进 `src/spreadsheets/xls-io.ts` 的 `XLS18_FACT_PUBLICATION_PORT`。' +
  '本适配器只如实转达端口状态，不代为实现。';

/**
 * 尝试把一次保存之后的改动**发布**给文档 / PPT 模板。
 *
 * 只接受 {@link WorkbookSaveResult}（而不是裸文档）：一次发布必须说得出"它引用的是哪一版字节"，
 * 否则消费端无从判断拿到的是哪一版（`source_digest` 就是这个问题在本层的答案）。
 *
 * @throws {ValidationError} 事实键为空 / 版本标识为空（入口参数错误，不假装发布过）
 */
export function publishWorkbookFacts(
  save: WorkbookSaveResult,
  request: XlsxFactPublicationRequest,
): XlsxFactPublicationOutcome {
  if (request.fact_keys.length === 0) {
    throw new ValidationError('publishWorkbookFacts：fact_keys 不能为空（没有要发布的事实就不要发起发布）');
  }
  for (const key of request.fact_keys) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new ValidationError('publishWorkbookFacts：fact_keys 里每一项都必须是非空字符串');
    }
  }
  if (typeof request.artifact_revision !== 'string' || request.artifact_revision.length === 0) {
    throw new ValidationError('publishWorkbookFacts：artifact_revision 必须是非空字符串（发布必须说得出版本）');
  }

  let reason: string;
  try {
    XLS18_FACT_PUBLICATION_PORT.publish({
      fact_keys: Object.freeze([...request.fact_keys]),
      artifact_revision: request.artifact_revision,
      source_digest: save.content_digest,
    });
    // 端口类型把 `status` 钉成字面量 `'unimplemented'`：能走到这里说明 xls-io 的端口契约变了。
    // 即便如此也不宣称已发布——"端口返回回执"与"用户在文档里看到了"仍不是同一件事。
    reason = '端口返回了回执：本适配器不据此宣称已发布（claimed_published 恒 false）。';
  } catch (error) {
    reason = describeError(error);
  }

  return Object.freeze({
    status: 'not-wired' as const,
    port_id: 'xls18.cross_template_fact_publication' as const,
    port_status: 'unimplemented' as const,
    targets: Object.freeze([...XLS18_FACT_PUBLICATION_PORT.consumers]),
    requested_fact_keys: Object.freeze([...request.fact_keys]),
    source_digest: save.content_digest,
    artifact_revision: request.artifact_revision,
    claimed_published: false as const,
    reason,
    unlock: NOT_WIRED_UNLOCK,
  });
}

// ---------------------------------------------------------------------------
// 编辑（封闭枚举）—— 与 `adapters/xlsx.ts` 同一套词汇 + 文件层那条 `rename_file`
// ---------------------------------------------------------------------------

/**
 * **产品入口上的表格编辑**（封闭枚举）。
 *
 * 刻意**不做**"自然语言 → 表格操作"：本文件只定义**受约束的结构化意图**，
 * 自然语言到它的翻译是模型层的事（R134）。每个操作都只改一处、且不可变。
 */
export type XlsxIoEdit =
  | {
      readonly op: 'set_cell';
      readonly sheet: string;
      readonly address: string;
      /** 取值形状与 `src/spreadsheets` 的 `CellValue` **同一套**（不另造第二套词汇）。 */
      readonly value: CellValue;
    }
  | { readonly op: 'clear_cell'; readonly sheet: string; readonly address: string }
  | { readonly op: 'rename_file'; readonly file_name: string }
  | { readonly op: 'add_sheet'; readonly name: string }
  | { readonly op: 'remove_sheet'; readonly name: string }
  | { readonly op: 'rename_sheet'; readonly from: string; readonly to: string }
  | { readonly op: 'set_active_sheet'; readonly name: string };

/** 按表名换掉一张工作表（保持其余表与顺序不变；活跃表下标无需动）。 */
function replaceSheet(
  document: XlsxIoDeliverableSource,
  name: string,
  next: SheetState,
): XlsxIoDeliverableSource {
  const workbook = document.workbook;
  return withWorkbookEdits(document, {
    sheets: workbook.sheets.map((item) => (item.name === name ? next : item)),
    active_sheet: workbook.active_sheet,
  });
}

function applyXlsxIoEdit(
  document: XlsxIoDeliverableSource,
  edit: unknown,
): AdapterEditResult<XlsxIoDeliverableSource> {
  if (typeof edit !== 'object' || edit === null) {
    return { ok: false, kind: 'invalid_edit', detail: '编辑必须是一个对象' };
  }
  const record = edit as Record<string, unknown>;
  const op = record['op'];
  const workbook = document.workbook;
  try {
    switch (op) {
      case 'set_cell': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const address = requireString(record['address'], 'address');
        const value = readCellValue(record['value']);
        if (value === null) {
          return {
            ok: false,
            kind: 'invalid_value',
            detail: 'value 不是合法的单元格取值（只能是 blank / number / text / boolean / date / error / formula）',
          };
        }
        const sheet = getSheet(workbook, sheetName);
        if (sheet === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(sheetName)}` };
        }
        const before = getCellValue(sheet, address);
        const wasSet = hasCell(sheet, address);
        const next = setCellValue(sheet, address, value);
        return {
          ok: true,
          source: replaceSheet(document, sheetName, next),
          // 只有"取值真的变了，或这个格子此前从未设置过"才算改动（幂等空转不产生新版本）。
          changed: wasSet ? !valuesEqual(before, value) : true,
          notes: Object.freeze([`${sheetName}!${address} 设为 ${value.kind}`]),
        };
      }
      case 'clear_cell': {
        const sheetName = requireString(record['sheet'], 'sheet');
        const address = requireString(record['address'], 'address');
        const sheet = getSheet(workbook, sheetName);
        if (sheet === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(sheetName)}` };
        }
        const next = clearCell(sheet, address);
        return {
          ok: true,
          source: replaceSheet(document, sheetName, next),
          changed: hasCell(sheet, address),
          notes: Object.freeze([`${sheetName}!${address} 清空`]),
        };
      }
      case 'rename_file': {
        const fileName = record['file_name'];
        if (typeof fileName !== 'string' || fileName.length === 0) {
          return { ok: false, kind: 'invalid_edit', detail: 'file_name 必须是非空字符串' };
        }
        const renamed = renameWorkbookDocument(document, fileName);
        return {
          ok: true,
          source: renamed,
          changed: renamed.file_name !== document.file_name,
          notes: Object.freeze([`文件名 ${document.file_name} 改为 ${renamed.file_name}`]),
        };
      }
      case 'add_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) !== undefined) {
          return { ok: false, kind: 'duplicate_sheet', detail: `工作表 ${JSON.stringify(name)} 已存在` };
        }
        return {
          ok: true,
          source: withWorkbookEdits(document, addSheet(workbook, name)),
          changed: true,
          notes: Object.freeze([`新增工作表 ${name}`]),
        };
      }
      case 'remove_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(name)}` };
        }
        if (workbook.sheets.length <= 1) {
          return {
            ok: false,
            kind: 'last_sheet',
            detail: '这是最后一张工作表：删除会让工作簿不合法（R250 要求至少一张真实表）',
          };
        }
        return {
          ok: true,
          source: withWorkbookEdits(document, removeSheet(workbook, name)),
          changed: true,
          notes: Object.freeze([`删除工作表 ${name}`]),
        };
      }
      case 'rename_sheet': {
        const from = requireString(record['from'], 'from');
        const to = requireString(record['to'], 'to');
        if (getSheet(workbook, from) === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(from)}` };
        }
        const next = renameSheet(workbook, from, to);
        return {
          ok: true,
          source: withWorkbookEdits(document, next),
          changed: next !== workbook,
          notes: Object.freeze([`工作表 ${from} 改名为 ${to}`]),
        };
      }
      case 'set_active_sheet': {
        const name = requireString(record['name'], 'name');
        if (getSheet(workbook, name) === undefined) {
          return { ok: false, kind: 'unknown_sheet', detail: `没有工作表 ${JSON.stringify(name)}` };
        }
        const next = setActiveSheet(workbook, name);
        return {
          ok: true,
          source: withWorkbookEdits(document, next),
          changed: next.active_sheet !== workbook.active_sheet,
          notes: Object.freeze([`活跃表切到 ${name}`]),
        };
      }
      default:
        return {
          ok: false,
          kind: 'unsupported_op',
          detail:
            `不支持的表格操作 ${JSON.stringify(String(op))}（封闭枚举：set_cell / clear_cell / rename_file / ` +
            'add_sheet / remove_sheet / rename_sheet / set_active_sheet）',
        };
    }
  } catch (error) {
    // 底层纯函数以抛错表达形状问题（非法地址 / 非法表名 / 重名 / 悬空引用）：
    // **结构化成编辑失败**，而不是让异常穿出会话层（那会绕过"源零改动"的承诺）。
    return { ok: false, kind: 'invalid_edit', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/**
 * 文件层表格交付适配器（唯一实例，纯函数集合）。
 *
 * 与 `xlsxDeliverableAdapter` 的分工：那个直接吃 `{workbook, residual}`（源就是模型），
 * 这个吃 {@link WorkbookDocument}（源是**文件层会话**：文件名 + 模型 + 残留 + 来源摘要），
 * 因此多了"另存 / 改名 / 关闭重开"这条路上的身份与证据。
 */
export const xlsxIoDeliverableAdapter: DeliverableAdapter<XlsxIoDeliverableSource> = Object.freeze({
  format: FORMAT,
  template_kind: TEMPLATE_KIND,
  describe(source: XlsxIoDeliverableSource): string {
    const names = sheetNames(source.workbook);
    return `${source.file_name}：${String(names.length)} 张工作表（${names.join('、')}）`;
  },
  exportBytes(source: XlsxIoDeliverableSource): AdapterExportResult {
    const outcome = saveDeliverable(source);
    if (!outcome.ok) {
      return { ok: false, kind: outcome.kind, detail: outcome.detail };
    }
    return {
      ok: true,
      bytes: outcome.save.bytes,
      entry_count: outcome.save.entry_count,
      digest: outcome.save.content_digest,
    };
  },
  applyEdit: applyXlsxIoEdit,
  /**
   * 从既有 **.xlsx** 字节导入。
   *
   * CSV 不走这里（它的编码 / 分隔符 / 类型口径要显式给）：请用
   * {@link importDeliverableFromCsv}——一条"看起来支持、用起来猜错"的入口不如没有。
   */
  importBytes(bytes: Uint8Array): AdapterImportResult<XlsxIoDeliverableSource> {
    return openDeliverableFromXlsx(DEFAULT_IMPORTED_FILE_NAME, bytes);
  },
});
