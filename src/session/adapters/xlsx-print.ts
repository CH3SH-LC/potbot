/**
 * **表格（XLSX）打印设置的会话交付接入口**（工作包 FA-XLS-PRINT-PRODUCT；XLS-16 的产品面）。
 *
 * ## 这个文件补的是什么（相对既有两处）
 *
 * | 既有 | 已有什么 | 还缺什么 |
 * |---|---|---|
 * | `src/spreadsheets/print-layout.ts` | 打印布局模型 + **XML 片段** + 注入既有工作表 / 工作簿 XML 的纯函数 | 片段没有真的落进 **.xlsx 容器字节** |
 * | `src/session/adapters/xlsx.ts` | 工作簿模型 → 真实 .xlsx 字节（`writeWorkbookXlsx`）+ 会话编辑协议 | 它不认识打印设置，产出的文件里没有任何分页 / 打印区域 |
 *
 * 本文件把两边接起来：**源 = 工作簿 + 保留部件 + 打印计划**，
 * **导出 = 先 `writeWorkbookXlsx` 出真容器，再把 `print-layout.ts` 的打印元素注入容器内的
 * `xl/workbook.xml` 与 `xl/worksheets/sheetN.xml`，最后重新打包成真实字节**。
 *
 * 因此判据不是"函数返回了东西"，而是"**把产出的 .xlsx 解开后，工作表里有
 * `pageSetup` / `pageMargins` / `rowBreaks`，工作簿里有 `_xlnm.Print_Area`**"——
 * 见 `xlsx-print.test.ts`。
 *
 * ## 为什么不能"只导出可见首屏"
 *
 * 可见首屏导出 = 丢掉 `rowBreaks` / `colBreaks` / `_xlnm.Print_Area` / `_xlnm.Print_Titles`：
 * 文件在 Excel 里再打开时分页、打印区域、重复标题全没了。本模块把 `PrintPlan` 里的每一项
 * **显式序列化进 XML 并且真的写进容器**，且**全区域**（而不是 dimension 的首格）进 `Print_Area`。
 * 反向对照见测试：同一份工作簿走 `writeWorkbookXlsx`（= "只导出可见首屏"）产出里
 * **一个打印元素都没有**，走本模块产出里**全都在**。
 *
 * ## PDF / 打印交接：最高只报「已交接」，`printed` 恒为字面量 `false`
 *
 * 本仓**没有**任何消费端（Excel / WPS / 安卓办公套件 / 打印机 / 虚拟 PDF）。
 * 因此 {@link handoffToPrint} 的结论结构里 `printed` 的类型就是**字面量 `false`**——
 * "声称已打印"在本层连**写出来**都写不出来；{@link confirmPrintOutcome} 在没有
 * **读回证据**（消费端 id + 输出 sha256 + 页数）时**显式抛错**，绝不默认"应该打出来了吧"。
 * 真机 / 消费端打开与出纸**未验证**（见 {@link PRINT_UNVERIFIED}）。
 *
 * ## 既有部件不被破坏
 *
 * 注入只**替换** `xl/workbook.xml` 与对应工作表部件的**文本**，ZIP 里其它条目（含 R249 保留的
 * 未知部件、样式、关系、`[Content_Types].xml`）**原样按序带回**；`sheetData` 由
 * `print-layout.ts` 的注入函数按 CT_Worksheet 序列插入，**不重写**。
 * 幂等：同一份源连写两次 ⇒ 字节逐字节相同，重复注入不会出现两个 `pageSetup`。
 *
 * ## 未验证边界（不编造）
 *
 * - **真实消费端打开 / 出纸未验证**（需真机 / 桌面 Office / 打印机）；
 * - **导入不解出打印设置**（{@link IMPORTED_PRINT_SETTINGS_RECOVERED} 为 `false`）：
 *   `readWorkbookXlsx` 从模型**重新生成**工作表与工作簿 XML，因此导入的原文件里的
 *   打印设置**不会**被恢复成 `PrintPlan`——这是"读侧不建模打印"的如实后果，不是静默丢弃
 *   （通道本身就不存在；导入后重导出的文件里查不到任何打印元素，用例把这条钉住）；
 * - 本文件是**纯的**：零 IO、零墙钟、零随机数（`src/**` 的机器化断言）。
 */

import {
  readZip,
  utf8Bytes,
  writeZip,
  type ZipEntry,
} from '../../artifacts/ooxml/index.js';
import {
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
  xlsxContentDigest,
} from '../../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXml,
} from '../../documents/docx/xml-parse.js';
import { ValidationError, type TemplateKind } from '../../protocol/index.js';
import {
  EMPTY_RESIDUAL,
  createPrintLayout,
  createPrintPlan,
  getSheetPrint,
  insertDefinedNamesXml,
  insertSheetPrintXml,
  isDefaultPrintLayout,
  readWorkbookXlsx,
  worksheetPartPath,
  writeWorkbookXlsx,
  type PrintLayout,
  type PrintLayoutInput,
  type PrintPlan,
  type WorkbookState,
  type XlsxResidual,
} from '../../spreadsheets/index.js';
import type {
  AdapterEditResult,
  AdapterExportResult,
  AdapterImportResult,
  DeliverableAdapter,
} from '../adapter.js';
import type { FileFormat } from '../formats.js';
import { xlsxDeliverableAdapter, type XlsxDeliverableSource } from './xlsx.js';

// ---------------------------------------------------------------------------
// 源
// ---------------------------------------------------------------------------

/**
 * 打印交付的源：工作簿 + 导入时保留的未知部件（R249）+ 打印计划。
 *
 * `plan` 为空计划 = **一个打印元素都不写**（文件字节与 `xlsxDeliverableAdapter` 同源同径）。
 */
export interface XlsxPrintSource {
  readonly workbook: WorkbookState;
  readonly residual: XlsxResidual;
  readonly plan: PrintPlan;
}

/** 从零建源（表名由调用方决定；打印计划缺省为空）。@throws {ValidationError} 表名非法 */
export function createPrintSource(
  workbook: WorkbookState,
  residual: XlsxResidual = EMPTY_RESIDUAL,
  plan: PrintPlan = createPrintPlan(),
): XlsxPrintSource {
  return Object.freeze({ workbook, residual, plan });
}

// ---------------------------------------------------------------------------
// 容器注入：真 .xlsx 字节 ← 打印元素
// ---------------------------------------------------------------------------

/** 写出结果：**真实容器字节** + 可审计的落盘登记。 */
export interface XlsxPrintWriteResult {
  /** 注入打印元素后的真实 .xlsx 字节（可写盘）。 */
  readonly bytes: Uint8Array;
  /** ZIP 部件数（与未注入时**相同**：只换文本，不增删部件）。 */
  readonly entry_count: number;
  /** 真实容器字节的 sha256（裸小写十六进制）。 */
  readonly content_digest: string;
  /** 真正被写入打印设置的工作表名（按工作簿顺序）。 */
  readonly sheets_with_print: readonly string[];
  /** 被改写文本的部件路径（`xl/workbook.xml` 视情况 + 工作表部件）。 */
  readonly rewritten_parts: readonly string[];
}

const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;

function decodeUtf8(data: Uint8Array, where: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ValidationError(`${where} 不是合法 UTF-8 XML（本模块不猜代码页）`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 打印计划引用的工作表必须都在工作簿里；否则**显式抛错**
 * （静默丢弃等于把用户的打印设置吃掉）。
 * @throws {ValidationError}
 */
function assertPlanFitsWorkbook(plan: PrintPlan, workbook: WorkbookState): void {
  const known = new Set(workbook.sheets.map((sheet) => sheet.name));
  for (const entry of plan.entries) {
    if (!known.has(entry.sheet)) {
      throw new ValidationError(
        `打印计划引用了工作簿里不存在的工作表 ${JSON.stringify(entry.sheet)}；` +
          `工作簿只有：${[...known].map((name) => JSON.stringify(name)).join(', ')}`,
      );
    }
  }
}

/**
 * **把工作簿写成带打印设置的真实 .xlsx。**
 *
 * 步骤（每一步都是既有的纯函数，本文件不新增 ZIP / XML 原语）：
 * 1. `writeWorkbookXlsx(workbook, residual)` → 真实容器字节（含 `xl/workbook.xml` 与工作表部件）；
 * 2. `insertDefinedNamesXml` 把 `_xlnm.Print_Area` / `_xlnm.Print_Titles` 插进工作簿部件；
 * 3. 逐表 `insertSheetPrintXml` 把 `printOptions` / `pageMargins` / `pageSetup` / `headerFooter` /
 *    `rowBreaks` / `colBreaks` 按 CT_Worksheet 序列插进工作表部件（**`sheetData` 原样保留**）；
 * 4. `writeZip` 把（**只有这几处文本被替换**的）条目表重新打包成最终字节。
 *
 * 空计划（每张表都没设打印）⇒ 第 2、3 步都是恒等的，最终字节 = 第 1 步的字节形状（无任何打印元素）。
 *
 * @throws {ValidationError} 计划引用了不存在的工作表，或部件不是合法 UTF-8 XML
 */
export function writeWorkbookXlsxWithPrint(
  workbook: WorkbookState,
  residual: XlsxResidual = EMPTY_RESIDUAL,
  plan: PrintPlan = createPrintPlan(),
): XlsxPrintWriteResult {
  assertPlanFitsWorkbook(plan, workbook);
  const written = writeWorkbookXlsx(workbook, residual);

  const archive = readZip(written.bytes);
  const sheetOrder = workbook.sheets.map((sheet) => sheet.name);

  const replacements = new Map<string, Uint8Array>();
  const rewritten: string[] = [];
  const sheetsWithPrint: string[] = [];

  const workbookPart = archive.by_path.get(XLSX_WORKBOOK_PART_PATH);
  if (workbookPart === undefined) {
    throw new ValidationError(`写出的包缺少 ${XLSX_WORKBOOK_PART_PATH}：容器不完整，拒绝继续注入`);
  }
  const workbookXml = insertDefinedNamesXml(
    decodeUtf8(workbookPart.data, XLSX_WORKBOOK_PART_PATH),
    plan,
    sheetOrder,
  );
  if (workbookXml !== decodeUtf8(workbookPart.data, XLSX_WORKBOOK_PART_PATH)) {
    replacements.set(XLSX_WORKBOOK_PART_PATH, utf8Bytes(workbookXml));
    rewritten.push(XLSX_WORKBOOK_PART_PATH);
  }

  workbook.sheets.forEach((sheet, index) => {
    const layout = getSheetPrint(plan, sheet.name);
    if (layout === undefined || isDefaultPrintLayout(layout)) {
      return; // 没设 ⇒ 一个字节都不动（反向对照就建立在这条上）
    }
    const partPath = worksheetPartPath(index);
    const part = archive.by_path.get(partPath);
    if (part === undefined) {
      throw new ValidationError(`写出的包缺少工作表部件 ${partPath}：容器不完整，拒绝继续注入`);
    }
    const source = decodeUtf8(part.data, partPath);
    const injected = insertSheetPrintXml(source, layout);
    if (injected !== source) {
      replacements.set(partPath, utf8Bytes(injected));
      rewritten.push(partPath);
    }
    sheetsWithPrint.push(sheet.name);
  });

  const entries: ZipEntry[] = archive.entries.map((entry) => ({
    path: entry.path,
    data: replacements.get(entry.path) ?? entry.data,
  }));
  const bytes = writeZip(entries);

  return Object.freeze({
    bytes,
    entry_count: entries.length,
    content_digest: xlsxContentDigest(bytes),
    sheets_with_print: Object.freeze(sheetsWithPrint),
    rewritten_parts: Object.freeze(rewritten),
  });
}

// ---------------------------------------------------------------------------
// 读回扫描：字节里到底有没有那些元素（"写了"是可核对的，不是自称的）
// ---------------------------------------------------------------------------

/** 一张工作表部件里实际出现的打印元素。 */
export interface SheetPrintScan {
  readonly part: string;
  readonly page_setup: boolean;
  readonly page_margins: boolean;
  readonly header_footer: boolean;
  readonly print_options: boolean;
  readonly fit_to_page: boolean;
  readonly row_breaks: number;
  readonly column_breaks: number;
}

/** 从字节里读回的打印事实（进交接回执，充当"设置真的落进文件"的证据）。 */
export interface XlsxPrintByteScan {
  /** 工作簿 `definedNames` 里出现的名称（如 `_xlnm.Print_Area`）。 */
  readonly defined_names: readonly string[];
  /** `_xlnm.Print_Area` 的名称正文（如 `'预算'!$A$1:$G$100`）。 */
  readonly print_areas: readonly string[];
  /** 逐工作表部件的元素存在性。 */
  readonly sheets: readonly SheetPrintScan[];
}

function scanWorksheet(part: string, xml: string): SheetPrintScan {
  const root = parseXml(xml);
  const countBreaks = (name: string): number => {
    const element = findChild(root, SPREADSHEETML_NAMESPACE, name);
    return element === null ? 0 : childElements(element).length;
  };
  const sheetPr = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetPr');
  const pageSetUpPr =
    sheetPr === null ? null : findChild(sheetPr, SPREADSHEETML_NAMESPACE, 'pageSetUpPr');
  return Object.freeze({
    part,
    page_setup: findChild(root, SPREADSHEETML_NAMESPACE, 'pageSetup') !== null,
    page_margins: findChild(root, SPREADSHEETML_NAMESPACE, 'pageMargins') !== null,
    header_footer: findChild(root, SPREADSHEETML_NAMESPACE, 'headerFooter') !== null,
    print_options: findChild(root, SPREADSHEETML_NAMESPACE, 'printOptions') !== null,
    fit_to_page:
      pageSetUpPr !== null && attributeValue(pageSetUpPr, '', 'fitToPage') === '1',
    row_breaks: countBreaks('rowBreaks'),
    column_breaks: countBreaks('colBreaks'),
  });
}

/**
 * 解开一份 .xlsx 字节，读回其中的打印事实。
 *
 * 这是交接回执里的**读回证据**：调用方不必相信任何"我已经写进去了"的说法，直接扫字节。
 *
 * @throws {ZipReadError} 不是合法 ZIP
 * @throws {XmlParseError} 部件不是合法 XML
 */
export function scanWorkbookPrintBytes(bytes: Uint8Array): XlsxPrintByteScan {
  const archive = readZip(bytes);
  const definedNames: string[] = [];
  const printAreas: string[] = [];
  const workbookPart = archive.by_path.get(XLSX_WORKBOOK_PART_PATH);
  if (workbookPart !== undefined) {
    const root = parseXml(decodeUtf8(workbookPart.data, XLSX_WORKBOOK_PART_PATH));
    const block = findChild(root, SPREADSHEETML_NAMESPACE, 'definedNames');
    if (block !== null) {
      for (const name of childElements(block)) {
        const value = attributeValue(name, '', 'name');
        if (value !== null) definedNames.push(value);
        if (value === '_xlnm.Print_Area') printAreas.push(directText(name));
      }
    }
  }
  const sheets: SheetPrintScan[] = [];
  for (const entry of archive.entries) {
    if (!WORKSHEET_PART.test(entry.path)) continue;
    sheets.push(scanWorksheet(entry.path, decodeUtf8(entry.data, entry.path)));
  }
  return Object.freeze({
    defined_names: Object.freeze(definedNames),
    print_areas: Object.freeze(printAreas),
    sheets: Object.freeze(sheets),
  });
}

// ---------------------------------------------------------------------------
// PDF / 打印交接：无消费端 ⇒ 结构化「已交接」，永不「已打印」
// ---------------------------------------------------------------------------

/** 消费端类别（本批**一个都没有装配**）。 */
export type PrintConsumerKind = 'excel' | 'wps' | 'android_office' | 'virtual_pdf' | 'printer';

/**
 * 消费端端口：把字节交给某个真实消费端。
 *
 * **本批没有任何实现**（真机 / 桌面 Office / 打印机都不在位）；这个接口存在的意义是
 * 让"交接"与"已打印"在类型层面就是两件事，而不是靠一句注释。
 */
export interface PrintConsumerPort {
  readonly consumer: PrintConsumerKind;
  /** 交出字节。回执只说明"收下了"，**不说明打出来了**。 */
  readonly submit: (bytes: Uint8Array, sheetNames: readonly string[]) => PrintSubmitReceipt;
}

/** 消费端对"收到字节"的回执（`read_back` 才是出纸证据）。 */
export interface PrintSubmitReceipt {
  readonly accepted: boolean;
  readonly detail: string;
}

/** 未验证清单（如实登记，不写进任何"已完成"的判定）。 */
export const PRINT_UNVERIFIED: readonly string[] = Object.freeze([
  '真实消费端（Excel / WPS / 安卓办公套件）打开文件是否按这些设置分页',
  '真实打印机 / 虚拟 PDF 是否出纸、出几页、页眉页脚格式码如何呈现',
  '重复标题行列（_xlnm.Print_Titles 的书写顺序）在真实 Excel 中的接受度',
]);

/** 有消费端之前的**状态上限**：最高只能报「已交接」。 */
export const PRINT_CEILING_WITHOUT_CONSUMER = 'handed_off' as const;

/** 打印交接状态（`printed` **不在**本层的可达集合里）。 */
export type PrintHandoffState = 'prepared' | 'handed_off';

/** 交接回执。`printed` 的类型就是字面量 `false`——本层写不出 `true`。 */
export interface PrintHandoffReceipt {
  readonly kind: 'print_handoff';
  readonly status: PrintHandoffState;
  /** **恒为 `false`**：没有消费端读回证据就不得声称已打印。 */
  readonly printed: false;
  /** 出纸证据（本层恒为 `null`）。 */
  readonly confirmed_by: null;
  /** 交付的容器字节摘要（会话层另做独立重算与比对）。 */
  readonly content_digest: string;
  /** 真正带打印设置的工作表（空 = 计划里没有任何打印设置）。 */
  readonly sheets_with_print: readonly string[];
  /** 手工分页符总数（行 + 列）——"不是只导出可见首屏"的**正向证据**。 */
  readonly manual_break_count: number;
  /** 消费端标识（未装配时为 `null`）。 */
  readonly consumer: PrintConsumerKind | null;
  /** 消费端对"收到字节"的回执原文（没有消费端时为 `null`）。 */
  readonly consumer_ack: string | null;
  /** 读回证据：从**产出的字节**里扫出来的打印事实。 */
  readonly read_back: XlsxPrintByteScan;
  /** 未验证清单（逐字取自 {@link PRINT_UNVERIFIED}）。 */
  readonly unverified: readonly string[];
  /** 人可读一句话（进页面回显 / 日志，不进任何判定）。 */
  readonly detail: string;
}

/** 交接结果（结构化；失败不抛错）。 */
export type PrintHandoffResult =
  | { readonly ok: true; readonly receipt: PrintHandoffReceipt }
  | { readonly ok: false; readonly kind: string; readonly detail: string };

/**
 * 把打印设置写进字节并**交接**给消费端（未装配消费端 = 只落地文件，不假装交了）。
 *
 * 无论走哪条分支，`printed` 都是 `false`：本层**没有任何路径**能产出 `true`——
 * 出纸证据只能来自消费端读回，见 {@link confirmPrintOutcome}。
 */
export function handoffToPrint(
  source: XlsxPrintSource,
  consumer: PrintConsumerPort | null = null,
): PrintHandoffResult {
  let written: XlsxPrintWriteResult;
  try {
    written = writeWorkbookXlsxWithPrint(source.workbook, source.residual, source.plan);
  } catch (error) {
    return { ok: false, kind: 'xlsx_print_write_failed', detail: describe(error) };
  }
  let readBack: XlsxPrintByteScan;
  try {
    readBack = scanWorkbookPrintBytes(written.bytes);
  } catch (error) {
    return { ok: false, kind: 'xlsx_print_scan_failed', detail: describe(error) };
  }
  if (consumer === null) {
    return {
      ok: true,
      receipt: Object.freeze({
        kind: 'print_handoff' as const,
        status: 'handed_off' as const,
        printed: false as const,
        confirmed_by: null,
        content_digest: written.content_digest,
        sheets_with_print: written.sheets_with_print,
        manual_break_count: readBack.sheets.reduce(
          (total, sheet) => total + sheet.row_breaks + sheet.column_breaks,
          0,
        ),
        consumer: null,
        consumer_ack: null,
        read_back: readBack,
        unverified: PRINT_UNVERIFIED,
        detail:
          '打印设置已写进 .xlsx 字节，但**没有消费端**：没有打开、没有渲染、没有出纸。' +
          '结论最高只能到「已交接」，`printed` 恒为 false。',
      }),
    };
  }
  let ack: PrintSubmitReceipt;
  try {
    ack = consumer.submit(written.bytes, written.sheets_with_print);
  } catch (error) {
    return { ok: false, kind: 'print_consumer_rejected', detail: describe(error) };
  }
  return {
    ok: true,
    receipt: Object.freeze({
      kind: 'print_handoff' as const,
      status: 'handed_off' as const,
      printed: false as const,
      confirmed_by: null,
      content_digest: written.content_digest,
      sheets_with_print: written.sheets_with_print,
      manual_break_count: readBack.sheets.reduce(
        (total, sheet) => total + sheet.row_breaks + sheet.column_breaks,
        0,
      ),
      consumer: consumer.consumer,
      consumer_ack: ack.detail,
      read_back: readBack,
      unverified: PRINT_UNVERIFIED,
      detail:
        `字节已交给消费端 ${consumer.consumer}（${ack.accepted ? '它说收下了' : '它说没收下'}）。` +
        '**收到 ≠ 打出来**：没有读回证据，结论仍停在「已交接」。',
    }),
  };
}

// ---------------------------------------------------------------------------
// 「已打印」的唯一入口：必须带消费端读回证据
// ---------------------------------------------------------------------------

/** 消费端读回证据（本批造不出来：没有消费端，就没有读回）。 */
export interface PrintConsumerEvidence {
  /** 出纸的消费端类别。 */
  readonly consumer: PrintConsumerKind;
  /** 消费端产物的 sha256（裸小写十六进制）——**读回来的**，不是我们算的。 */
  readonly read_back_sha256: string;
  /** 实际页数（≥ 1）。 */
  readonly pages: number;
}

/** 确认回执（**只有带证据才可能拿到**）。 */
export interface PrintConfirmedReceipt {
  readonly kind: 'print_handoff';
  readonly status: 'confirmed';
  readonly printed: true;
  readonly evidence: PrintConsumerEvidence;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * 把一次交接升级成「已打印」——**唯一**路径，且必须带消费端读回证据。
 *
 * 没有证据（`null` / `undefined` / 形状不对）⇒ **显式抛错**，不返回 `printed: true`。
 * 这是"结果不得编造"在本层的落点：交接回执里那句 `printed: false` 无法靠嘴改掉。
 *
 * @throws {ValidationError} 证据缺失或形状非法，或回执本身就不是 `printed: false`
 */
export function confirmPrintOutcome(
  receipt: PrintHandoffReceipt,
  evidence: PrintConsumerEvidence | null | undefined,
): PrintConfirmedReceipt {
  if (receipt.printed !== false) {
    throw new ValidationError('传入的交接回执不是 `printed: false`：本层只接受自己产出的回执');
  }
  if (evidence === null || evidence === undefined) {
    throw new ValidationError(
      '没有消费端读回证据，不得声称已打印：本批没有 Excel / WPS / 安卓办公套件 / 打印机 / 虚拟 PDF 消费端，' +
        '「已交接」就是上限',
    );
  }
  if (typeof evidence !== 'object') {
    throw new ValidationError('打印证据必须是对象');
  }
  if (typeof evidence.consumer !== 'string' || evidence.consumer.length === 0) {
    throw new ValidationError('打印证据必须给出消费端类别');
  }
  if (!SHA256_HEX.test(evidence.read_back_sha256)) {
    throw new ValidationError(
      '打印证据的 read_back_sha256 必须是 64 位小写十六进制（消费端读回的产物摘要）',
    );
  }
  if (!Number.isInteger(evidence.pages) || evidence.pages < 1) {
    throw new ValidationError('打印证据的 pages 必须是 ≥ 1 的整数');
  }
  return Object.freeze({
    kind: 'print_handoff' as const,
    status: 'confirmed' as const,
    printed: true as const,
    evidence: Object.freeze({ ...evidence }),
  });
}

// ---------------------------------------------------------------------------
// 适配器（与 ./xlsx.ts 同形）
// ---------------------------------------------------------------------------

/** 基础表格操作（`./xlsx.ts` 的封闭枚举）**原样转发**，本层不另造词汇。 */
export type XlsxPrintEdit =
  | {
      /**
       * 设一次打印布局（**整表覆盖**：没给的字段 = 未设置）。
       * 形状与 `print-layout.ts` 的 `PrintLayoutInput` **同一套**。
       */
      readonly op: 'set_print_layout';
      readonly sheet: string;
      readonly layout: PrintLayoutInput;
    }
  | { readonly op: 'clear_print_layout'; readonly sheet: string }
  | import('./xlsx.js').XlsxEdit;

const FORMAT: FileFormat = 'xlsx';
const TEMPLATE_KIND: TemplateKind = 'spreadsheet';

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串`);
  }
  return raw;
}

/** 两张布局是否等价（不可变纯数据 ⇒ 序列化比较是确定的）。 */
function sameLayout(left: PrintLayout | undefined, right: PrintLayout): boolean {
  if (left === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 计划里引用了这些表、但工作簿里已经没有它们（改名 / 删除之后）。 */
function planSheetsMissing(plan: PrintPlan, workbook: WorkbookState): readonly string[] {
  const known = new Set(workbook.sheets.map((sheet) => sheet.name));
  return plan.entries.map((entry) => entry.sheet).filter((name) => !known.has(name));
}

function withoutSheet(plan: PrintPlan, sheet: string): PrintPlan {
  return Object.freeze({
    entries: Object.freeze(plan.entries.filter((entry) => entry.sheet !== sheet)),
  });
}

function requireKnownSheet(source: XlsxPrintSource, raw: unknown): string {
  const name = requireString(raw, 'sheet');
  if (source.workbook.sheets.every((sheet) => sheet.name !== name)) {
    throw new ValidationError(`没有工作表 ${JSON.stringify(name)}`);
  }
  return name;
}

function applyPrintEdit(
  source: XlsxPrintSource,
  edit: unknown,
): AdapterEditResult<XlsxPrintSource> {
  if (typeof edit !== 'object' || edit === null) {
    return { ok: false, kind: 'invalid_edit', detail: '编辑必须是一个对象' };
  }
  const record = edit as Record<string, unknown>;
  const op = record['op'];
  try {
    switch (op) {
      case 'set_print_layout': {
        const sheet = requireKnownSheet(source, record['sheet']);
        const raw = record['layout'];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return {
            ok: false,
            kind: 'invalid_edit',
            detail: 'set_print_layout 的 layout 必须是对象（PrintLayoutInput）',
          };
        }
        const layout = createPrintLayout(raw as PrintLayoutInput);
        if (sameLayout(getSheetPrint(source.plan, sheet), layout)) {
          return {
            ok: true,
            source,
            changed: false,
            notes: Object.freeze([`${sheet} 的打印设置未变化（幂等空转）`]),
          };
        }
        return {
          ok: true,
          source: Object.freeze({
            ...source,
            plan: setPlanEntry(source.plan, sheet, layout),
          }),
          changed: true,
          notes: Object.freeze([`${sheet} 的打印设置已更新：${describeLayout(layout)}`]),
        };
      }
      case 'clear_print_layout': {
        const sheet = requireKnownSheet(source, record['sheet']);
        if (getSheetPrint(source.plan, sheet) === undefined) {
          return {
            ok: true,
            source,
            changed: false,
            notes: Object.freeze([`${sheet} 本就没有打印设置（幂等空转）`]),
          };
        }
        return {
          ok: true,
          source: Object.freeze({ ...source, plan: withoutSheet(source.plan, sheet) }),
          changed: true,
          notes: Object.freeze([`${sheet} 的打印设置已清除（该表不再写任何打印元素）`]),
        };
      }
      default:
        return delegateToBaseAdapter(source, edit);
    }
  } catch (error) {
    return { ok: false, kind: 'invalid_edit', detail: describe(error) };
  }
}

/** 本层不导出 `setSheetPrint` 之外的写入口：这里补一个"只在需要时新建"的包装。 */
function setPlanEntry(plan: PrintPlan, sheet: string, layout: PrintLayout): PrintPlan {
  const entries = [...plan.entries.filter((entry) => entry.sheet !== sheet)];
  entries.push(Object.freeze({ sheet, layout }));
  return Object.freeze({ entries: Object.freeze(entries) });
}

/** 人可读的一行布局摘要（进回执，不进判定）。 */
function describeLayout(layout: PrintLayout): string {
  if (isDefaultPrintLayout(layout)) return '全部未设置';
  const parts: string[] = [];
  if (layout.print_area !== null) parts.push(`打印区域 ${layout.print_area}`);
  if (layout.orientation !== null) parts.push(`方向 ${layout.orientation}`);
  if (layout.paper_size !== null) parts.push(`纸张 ${layout.paper_size}`);
  if (layout.repeat_rows !== null) parts.push(`重复行 ${layout.repeat_rows}`);
  if (layout.repeat_columns !== null) parts.push(`重复列 ${layout.repeat_columns}`);
  if (layout.row_breaks.length > 0) parts.push(`行分页 ${layout.row_breaks.join('/')}`);
  if (layout.column_breaks.length > 0) parts.push(`列分页 ${layout.column_breaks.join('/')}`);
  if (layout.margins !== null) parts.push('自定义边距');
  if (layout.header_footer !== null) parts.push('页眉页脚');
  if (layout.scaling !== null) {
    parts.push(
      layout.scaling.kind === 'percent'
        ? `缩放 ${String(layout.scaling.percent)}%`
        : `适配 ${String(layout.scaling.width)}×${String(layout.scaling.height)} 页`,
    );
  }
  return parts.join('、');
}

/**
 * 非打印操作（增删改表 / 改格子）转发给 `xlsxDeliverableAdapter`，**打印计划随源一起带过去**。
 *
 * 唯一多出来的一条守门：若这次操作让打印计划指向了一张**已经不存在的表**
 * （`rename_sheet` / `remove_sheet`），**结构化失败**——计划与工作簿必须自洽，
 * 静默把打印设置丢掉是不允许的。
 */
function delegateToBaseAdapter(
  source: XlsxPrintSource,
  edit: unknown,
): AdapterEditResult<XlsxPrintSource> {
  const base: XlsxDeliverableSource = { workbook: source.workbook, residual: source.residual };
  const result = xlsxDeliverableAdapter.applyEdit(base, edit);
  if (!result.ok) {
    return { ok: false, kind: result.kind, detail: result.detail };
  }
  const missing = planSheetsMissing(source.plan, result.source.workbook);
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'print_plan_sheet_lost',
      detail:
        `这次操作会让打印计划指向不存在的工作表（${missing.map((name) => JSON.stringify(name)).join('、')}）：` +
        '拒绝执行，以免静默丢掉打印设置；请先用 clear_print_layout 清掉对应的打印设置',
    };
  }
  return {
    ok: true,
    source: Object.freeze({
      workbook: result.source.workbook,
      residual: result.source.residual,
      plan: source.plan,
    }),
    changed: result.changed,
    notes: result.notes,
  };
}

/**
 * 导入：**不解出打印设置**（见 {@link IMPORTED_PRINT_SETTINGS_RECOVERED}）。
 *
 * 导入给的是工作簿模型 + 保留部件（R249），打印计划是空计划；
 * 消费方要保留原文件的打印设置，必须自己给出计划（本仓读侧不建模打印）。
 */
export const IMPORTED_PRINT_SETTINGS_RECOVERED = false;

/** 表格打印交付适配器（唯一冻结实例）。 */
export const xlsxPrintDeliverableAdapter: DeliverableAdapter<XlsxPrintSource> = Object.freeze({
  format: FORMAT,
  template_kind: TEMPLATE_KIND,
  describe(source: XlsxPrintSource): string {
    const names = source.workbook.sheets.map((sheet) => sheet.name);
    const withPrint = source.plan.entries.filter(
      (entry) => !isDefaultPrintLayout(entry.layout),
    );
    const print = withPrint.length === 0 ? '未设打印' : `打印设置：${withPrint.map((entry) => entry.sheet).join('、')}`;
    return `${String(names.length)} 张工作表（${names.join('、')}），${print}`;
  },
  exportBytes(source: XlsxPrintSource): AdapterExportResult {
    try {
      const result = writeWorkbookXlsxWithPrint(source.workbook, source.residual, source.plan);
      return {
        ok: true,
        bytes: result.bytes,
        entry_count: result.entry_count,
        digest: result.content_digest,
      };
    } catch (error) {
      return { ok: false, kind: 'xlsx_print_write_failed', detail: describe(error) };
    }
  },
  applyEdit: applyPrintEdit,
  importBytes(bytes: Uint8Array): AdapterImportResult<XlsxPrintSource> {
    try {
      const read = readWorkbookXlsx(bytes);
      return {
        ok: true,
        source: Object.freeze({
          workbook: read.workbook,
          residual: read.residual,
          plan: createPrintPlan(),
        }),
      };
    } catch (error) {
      return { ok: false, kind: 'xlsx_read_failed', detail: describe(error) };
    }
  },
});

/** 便于用例与调用方对照的导出（本层不复制 `xlsx.ts` 的适配器，只是引用）。 */
export { xlsxDeliverableAdapter };
export type { XlsxDeliverableSource };
