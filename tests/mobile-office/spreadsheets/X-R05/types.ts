/**
 * **X-R05 操作契约**（Excel 线备用包：消费端重开重算与手机 PDF/打印差异）。
 *
 * 本文件只放**形状**与**入参校验**，不放实现。两个操作：
 *
 * | 操作 | 语义 | 实现 |
 * |---|---|---|
 * | `xls.consumer.reopen_recalc.v1` | 拿一份**真实 .xlsx 字节**，当消费端重开它，独立重算，逐格比对「文件里写的缓存」与「重算期望」 | {@link ../consumer-reopen.js} |
 * | `xls.print.phone_vs_file.v1` | 拿手机端**打印计划**（PDF 预览的事实来源）与**落盘打印设置**，逐项列出差异 | {@link ../print-diff.js} |
 *
 * ## 为什么这些形状值得独立成契约
 *
 * 1. **缓存不是结论**。`xlsx-write.ts` 把公式结果写进 `<v>`，消费端（Excel / WPS）**默认信任**
 *    这个缓存、打开时不重算。于是"手机算出的数"与"用户看到的数"是**两件事**：
 *    前者是模型重算，后者是文件里的缓存。本契约把两者**并列**成可比对象，而不是拿其中一个
 *    冒充另一个。
 * 2. **差异要有名字**。{@link CacheDivergenceKind} 是可机器判定的封闭枚举——
 *    `missing_cache`（该有缓存却只有公式）/ `stale_cache`（缓存与重算不一致）/
 *    `phantom_cache`（被阻塞却写了缓存 = 伪造结果）/ `cache_type_mismatch`（`t` 属性与值类别不符）/
 *    `formula_mismatch`（文件里的公式格在模型里不存在）。没有"差不多一致"的第三态。
 * 3. **打印是同一条**。手机 PDF 预览来自**内存里的**打印计划；消费端出纸来自**文件里的**
 *    打印设置。二者不是同一份数据，差异同样要有名字（{@link PrintDifferenceKind}）。
 */

import { ValidationError } from '../../../../src/protocol/index.js';
import type { PrintPlan } from '../../../../src/spreadsheets/print-layout.js';

/** 本包契约版本。字段只增不改；改语义必须升版本。 */
export const XR05_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// 操作 1：消费端重开重算
// ---------------------------------------------------------------------------

/** 操作名：消费端重开 + 独立重算 + 缓存比对。 */
export const CONSUMER_REOPEN_OPERATION = 'xls.consumer.reopen_recalc.v1' as const;
export type ConsumerReopenOperation = typeof CONSUMER_REOPEN_OPERATION;

/** 缓存比对的判定类别（封闭枚举，见文件头）。 */
export type CacheDivergenceKind =
  /** 重算得到确定值，但文件里该公式格**没有** `<v>` 缓存（消费端可能显示空，直到重算）。 */
  | 'missing_cache'
  /** 文件里有 `<v>`，但其值与独立重算的结果**不等**（缓存过期 / 写错）。 */
  | 'stale_cache'
  /** 独立重算判定该格**阻塞**（无值），文件里却写了 `<v>`——即"伪造结果"。 */
  | 'phantom_cache'
  /** `<v>` 存在，但 `t` 属性隐含的值类别与重算结果类别不符。 */
  | 'cache_type_mismatch'
  /** 文件里的某个公式格在重开的模型里找不到对应公式（读回丢失）。 */
  | 'formula_mismatch';

/** 一条公式格的「文件缓存 ↔ 重算期望」比对记录。 */
export interface FormulaCacheComparison {
  readonly sheet: string;
  readonly ref: string;
  /** 重开的模型里该格的公式原文。 */
  readonly formula: string;
  /** 独立重算的结论。 */
  readonly expected_kind: 'value' | 'blocked';
  /** 重算值的规范化文本（数的十进制 / 文本原文 / `1`|`0` / 错误码）；阻塞时为 `null`。 */
  readonly expected_text: string | null;
  /** 阻塞原因（仅在 `expected_kind === 'blocked'` 时非空）。 */
  readonly expected_block_reason: string | null;
  /** 文件 XML 里该格的 `<v>` 原文；没有缓存时为 `null`。 */
  readonly file_cache_text: string | null;
  /** 文件 XML 里该格的 `<c t="...">` 属性值；无该属性时为 `null`。 */
  readonly file_cache_type: string | null;
  /** 两者是否一致（`divergence === null` 的等价表述）。 */
  readonly agrees: boolean;
  readonly divergence: CacheDivergenceKind | null;
}

/** 消费端重开重算的**请求**。 */
export interface ReopenRecalcRequest {
  readonly schemaVersion: number;
  readonly operation: ConsumerReopenOperation;
  /** 文件名（只给名字，不给路径——与 `WorkbookDocument` 的口径一致）。 */
  readonly file_name: string;
  /** `TODAY()` 需要的显式当前日期（Excel 序列号）。不提供 ⇒ 含 `TODAY()` 的公式阻塞。 */
  readonly today_serial?: number;
}

/** 消费端重开重算的**报告**。 */
export interface ReopenRecalcReport {
  readonly operation: ConsumerReopenOperation;
  readonly schema_version: number;
  readonly file_name: string;
  /** 重开字节的 sha256（绑身份：同一报告只对应这一份字节）。 */
  readonly source_digest: string;
  readonly sheet_names: readonly string[];
  /** 模型里的公式格总数。 */
  readonly formula_count: number;
  /** 独立重算判定为阻塞的公式格数。 */
  readonly blocked_count: number;
  /** 逐格比对（按 `表名!地址` 升序，确定性）。 */
  readonly comparisons: readonly FormulaCacheComparison[];
  /** `comparisons` 里 `agrees === false` 的子集。 */
  readonly divergences: readonly FormulaCacheComparison[];
  /** `divergences` 为空 ⇔ 一致。 */
  readonly consistent: boolean;
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${where} 必须是一个对象`);
  }
  return value as Record<string, unknown>;
}

function requireOptionalSerial(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${where} 若给出必须是有限数（Excel 序列号），收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 校验一份消费端重开重算请求。
 *
 * 严格：未知 `operation`、版本不符、缺 `file_name`、`today_serial` 非法一律抛
 * `ValidationError`——**不静默补默认值**，否则调用方会以为请求被理解了。
 *
 * @throws {ValidationError}
 */
export function validateReopenRecalcRequest(value: unknown): ReopenRecalcRequest {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('validateReopenRecalcRequest 需要一个对象');
  }
  const raw = value as Record<string, unknown>;
  if (raw.operation !== CONSUMER_REOPEN_OPERATION) {
    throw new ValidationError(
      `operation 必须是 ${CONSUMER_REOPEN_OPERATION}，收到 ${JSON.stringify(raw.operation)}`,
    );
  }
  if (raw.schemaVersion !== XR05_SCHEMA_VERSION) {
    throw new ValidationError(
      `schemaVersion 必须是 ${String(XR05_SCHEMA_VERSION)}，收到 ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  if (typeof raw.file_name !== 'string' || raw.file_name.length === 0) {
    throw new ValidationError('file_name 必须是非空字符串');
  }
  const todaySerial = requireOptionalSerial(raw.today_serial, 'today_serial');
  return Object.freeze({
    schemaVersion: XR05_SCHEMA_VERSION,
    operation: CONSUMER_REOPEN_OPERATION,
    file_name: raw.file_name,
    ...(todaySerial === undefined ? {} : { today_serial: todaySerial }),
  });
}

// ---------------------------------------------------------------------------
// 操作 2：手机打印计划 ↔ 落盘打印设置
// ---------------------------------------------------------------------------

/** 操作名：手机打印计划与落盘打印设置的往返差异。 */
export const PRINT_ROUNDTRIP_OPERATION = 'xls.print.phone_vs_file.v1' as const;
export type PrintRoundtripOperation = typeof PRINT_ROUNDTRIP_OPERATION;

/** 差异类别（封闭枚举）。 */
export type PrintDifferenceKind =
  /** 手机侧设了，文件里**没有**（消费端看不到 / 按默认出纸）。 */
  | 'missing_in_file'
  /** 两边都有但值不同。 */
  | 'value_mismatch'
  /** 文件里有，手机计划里没有（外部文件带来的、本计划未声明的设置）。 */
  | 'unexpected_in_file';

/** 从**真实 .xlsx 字节**里独立读出的、一张工作表的打印设置（文件侧事实）。 */
export interface PersistedSheetPrint {
  readonly sheet: string;
  /** `_xlnm.Print_Area` 的名称正文（含 `表名!` 前缀），未设 ⇒ `null`。 */
  readonly print_area: string | null;
  /** `_xlnm.Print_Titles` 里的**行**部分（如 `$1:$3`），未设 ⇒ `null`。 */
  readonly print_titles_rows: string | null;
  /** `_xlnm.Print_Titles` 里的**列**部分（如 `$A:$B`），未设 ⇒ `null`。 */
  readonly print_titles_columns: string | null;
  /** `<pageSetup orientation="…">`，未写 ⇒ `null`。 */
  readonly orientation: string | null;
  /** `<pageSetup paperSize="N">` 的 N，未写 ⇒ `null`。 */
  readonly paper_size: number | null;
  /** `<pageSetup scale="N">`，未写 ⇒ `null`。 */
  readonly scale_percent: number | null;
  /** `<pageSetup fitToWidth="N">`，未写 ⇒ `null`。 */
  readonly fit_to_width: number | null;
  /** `<pageSetup fitToHeight="N">`，未写 ⇒ `null`。 */
  readonly fit_to_height: number | null;
  /** `<sheetPr><pageSetUpPr fitToPage="1"/>` 是否在（fitTo 生效的必要条件）。 */
  readonly fit_to_page_flag: boolean;
  /** `<pageMargins>` 的六项（英寸），未写 ⇒ `null`。 */
  readonly margins: Readonly<Record<string, number>> | null;
  /** `<headerFooter>` 的直接子元素文本（`oddHeader` → `…`），未写 ⇒ `null`。 */
  readonly header_footer: Readonly<Record<string, string>> | null;
  /** 手工行分页符（`<brk man="1" id="N">` 的 N，升序）。 */
  readonly row_breaks: readonly number[];
  /** 手工列分页符（升序）。 */
  readonly column_breaks: readonly number[];
  /** `<printOptions>` 的属性（`gridLines` → `1`），未写 ⇒ `null`。 */
  readonly print_options: Readonly<Record<string, string>> | null;
}

/** 一处打印差异。 */
export interface PrintDifference {
  readonly sheet: string;
  /** 设置项名（如 `print_area` / `orientation` / `row_breaks`）。 */
  readonly setting: string;
  readonly kind: PrintDifferenceKind;
  /** 手机计划侧的值（规范化文本；未设 ⇒ `null`）。 */
  readonly phone: string | null;
  /** 文件侧的值（规范化文本；未读回 ⇒ `null`）。 */
  readonly file: string | null;
  readonly detail: string;
}

/** 手机打印计划与落盘打印设置的**请求**。 */
export interface PrintRoundtripRequest {
  readonly schemaVersion: number;
  readonly operation: PrintRoundtripOperation;
  readonly file_name: string;
  /** 工作表顺序（用于把 `localSheetId` 映射回表名）。 */
  readonly sheet_order: readonly string[];
  /** 手机侧打印计划（PDF 预览的事实来源）。 */
  readonly phone_plan: PrintPlan;
}

/** 手机打印计划与落盘打印设置的**报告**。 */
export interface PrintRoundtripReport {
  readonly operation: PrintRoundtripOperation;
  readonly schema_version: number;
  readonly file_name: string;
  readonly source_digest: string;
  /** 手机计划里声明了打印设置的**工作表名**（只有一个字段非 `null` 才会被算进差异）。 */
  readonly phone_sheets: readonly string[];
  /** 文件侧独立读出的每张表的打印设置。 */
  readonly persisted: readonly PersistedSheetPrint[];
  /** 逐项差异（按 `表名` + `setting` 升序，确定性）。 */
  readonly differences: readonly PrintDifference[];
  /** 逐项**没有差异**的设置名（正向证据：这些确实往返成功）。 */
  readonly survived_settings: readonly string[];
  readonly consistent: boolean;
}

/**
 * 校验一份打印往返请求。
 *
 * @throws {ValidationError}
 */
export function validatePrintRoundtripRequest(value: unknown): PrintRoundtripRequest {
  const raw = requireObject(value, 'validatePrintRoundtripRequest');
  if (raw.operation !== PRINT_ROUNDTRIP_OPERATION) {
    throw new ValidationError(
      `operation 必须是 ${PRINT_ROUNDTRIP_OPERATION}，收到 ${JSON.stringify(raw.operation)}`,
    );
  }
  if (raw.schemaVersion !== XR05_SCHEMA_VERSION) {
    throw new ValidationError(
      `schemaVersion 必须是 ${String(XR05_SCHEMA_VERSION)}，收到 ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  if (typeof raw.file_name !== 'string' || raw.file_name.length === 0) {
    throw new ValidationError('file_name 必须是非空字符串');
  }
  if (!Array.isArray(raw.sheet_order) || raw.sheet_order.some((name) => typeof name !== 'string')) {
    throw new ValidationError('sheet_order 必须是字符串数组');
  }
  const plan = raw.phone_plan;
  if (typeof plan !== 'object' || plan === null || !Array.isArray((plan as { entries?: unknown }).entries)) {
    throw new ValidationError('phone_plan 必须是 PrintPlan（含 entries 数组）');
  }
  return value as PrintRoundtripRequest;
}

// ---------------------------------------------------------------------------
// 操作 3：页数级打印差异（手机分页计划 ↔ 消费端按文件设置的页数）
// ---------------------------------------------------------------------------

/**
 * 操作名：页数级打印差异。
 *
 * 与 {@link PRINT_ROUNDTRIP_OPERATION} 的区别：后者比的是**设置项文本**是否落盘；
 * 本操作比的是**由几何算出的页数**——手机 PDF 预览会分成几页（X09 `computePagePlan`
 * 用内存里的打印计划算），与消费端按**文件里读回的设置**算出的页数是不是同一个数。
 * 设置丢了但恰好页数相同（罕见）时前者报差异、后者不报；页数不同则无论如何都报。**两者互补**。
 */
export const PAGE_COUNT_OPERATION = 'xls.print.page_count.v1' as const;
export type PageCountOperation = typeof PAGE_COUNT_OPERATION;

/** 页数级差异类别（封闭枚举）。 */
export type PageDifferenceKind =
  /** 手机预览页数与消费端按文件设置算出的页数不同。 */
  | 'page_count_mismatch'
  /** 行分带数不同（每页容纳哪些行的划分不一致）。 */
  | 'row_band_mismatch'
  /** 列分带数不同。 */
  | 'column_band_mismatch'
  /** 打印区域规范化文本不同（`$` / 表名前缀 / 大小写归一后）。 */
  | 'print_area_mismatch'
  /** 手工行/列分页符不同（手机设了、文件里没有或值不同）。 */
  | 'manual_breaks_mismatch';

/** 一处页数级差异。 */
export interface PageDifference {
  readonly sheet: string;
  readonly kind: PageDifferenceKind;
  /** 手机侧值（文本；不适用 ⇒ `null`）。 */
  readonly phone: string | null;
  /** 文件侧值（文本；不适用 ⇒ `null`）。 */
  readonly file: string | null;
  readonly detail: string;
}

/** 一张工作表的页数级比对。 */
export interface SheetPageDiff {
  readonly sheet: string;
  /** 文件 `<dimension>` 读出的已用行数。 */
  readonly used_rows: number;
  /** 文件 `<dimension>` 读出的已用列数。 */
  readonly used_columns: number;
  readonly phone_pages: number;
  readonly file_pages: number;
  /** `file_pages - phone_pages`（正值 = 消费端比手机预览多印）。 */
  readonly pages_delta: number;
  readonly phone_row_bands: number;
  readonly file_row_bands: number;
  readonly phone_column_bands: number;
  readonly file_column_bands: number;
  readonly phone_print_area: string | null;
  readonly file_print_area: string | null;
  readonly phone_row_breaks: readonly number[];
  readonly file_row_breaks: readonly number[];
  readonly phone_column_breaks: readonly number[];
  readonly file_column_breaks: readonly number[];
  /** 本表命中的差异（可为空 = 本表一致）。 */
  readonly differences: readonly PageDifference[];
}

/** 页数级打印差异报告。 */
export interface PageCountDiffReport {
  readonly operation: PageCountOperation;
  readonly schema_version: number;
  readonly file_name: string;
  readonly source_digest: string;
  /** 逐表比对，顺序与 `sheet_order` 一致。 */
  readonly sheets: readonly SheetPageDiff[];
  /** 全部差异（按表序 + 类别），确定性。 */
  readonly differences: readonly PageDifference[];
  /** 手机预览总页数（各表求和）。 */
  readonly total_phone_pages: number;
  /** 消费端按文件设置会印的总页数。 */
  readonly total_file_pages: number;
  /** `total_file_pages - total_phone_pages`。 */
  readonly pages_delta: number;
  /** `differences` 为空 ⇔ 一致。 */
  readonly consistent: boolean;
}

/** 页数级打印差异的**请求**。 */
export interface PageCountDiffRequest {
  readonly schemaVersion: number;
  readonly operation: PageCountOperation;
  readonly file_name: string;
  readonly sheet_order: readonly string[];
  /** 手机侧打印计划（PDF 预览的事实来源）。 */
  readonly phone_plan: PrintPlan;
}

/**
 * 校验一份页数级打印差异请求。
 *
 * @throws {ValidationError}
 */
export function validatePageCountDiffRequest(value: unknown): PageCountDiffRequest {
  const raw = requireObject(value, 'validatePageCountDiffRequest');
  if (raw.operation !== PAGE_COUNT_OPERATION) {
    throw new ValidationError(
      `operation 必须是 ${PAGE_COUNT_OPERATION}，收到 ${JSON.stringify(raw.operation)}`,
    );
  }
  if (raw.schemaVersion !== XR05_SCHEMA_VERSION) {
    throw new ValidationError(
      `schemaVersion 必须是 ${String(XR05_SCHEMA_VERSION)}，收到 ${JSON.stringify(raw.schemaVersion)}`,
    );
  }
  if (typeof raw.file_name !== 'string' || raw.file_name.length === 0) {
    throw new ValidationError('file_name 必须是非空字符串');
  }
  if (!Array.isArray(raw.sheet_order) || raw.sheet_order.some((name) => typeof name !== 'string')) {
    throw new ValidationError('sheet_order 必须是字符串数组');
  }
  const plan = raw.phone_plan;
  if (typeof plan !== 'object' || plan === null || !Array.isArray((plan as { entries?: unknown }).entries)) {
    throw new ValidationError('phone_plan 必须是 PrintPlan（含 entries 数组）');
  }
  return value as PageCountDiffRequest;
}
