/**
 * **XLSX 打印设置的产品 HTTP 入口**（工作包 FA-XLS-PRINT-ROUTE；XLS-16 的产品面）。
 *
 * ## 这个文件补的是什么缺口（把 `fa/prod-depth-c` 的实测结论翻正）
 *
 * `fa/prod-depth-c` 实测（见 `apps/demo/server/print-public-e2e.test.ts` 第 4 节）：
 * 产品 HTTP 上 `print` 出现 **0 次** —— `POST /api/deliverables/:id/edits {op:'set_print_layout'}`
 * 被服务端的**封闭枚举**结构化拒绝（422）；`src/session/adapters/xlsx-print.ts` 的打印能力
 * **只活在适配器层与交付 seam 里**，用户经产品入口**够不到**。
 *
 * 本文件新增独立前缀 `/api/xls-print/**`（与既有前缀**不重叠**，由 `route-dispatch-scan` 现推校验），
 * 把那层能力接到 HTTP：
 *
 * | 产品端点 | 复用的既有能力（**只调用、不重造**） |
 * |---|---|
 * | `POST /api/xls-print/export` | `xlsxPrintDeliverableAdapter.exportBytes` + `scanWorkbookPrintBytes` |
 * | `POST /api/xls-print/sessions` | `DeliverableSession.createNew` / `importBytes`（**既有交付 seam**） |
 * | `POST /api/xls-print/sessions/:id/edits` | `DeliverableSession.publish`（`set_print_layout` / `clear_print_layout`） |
 * | `GET /api/xls-print/sessions/:id` | `status()` + `getSheetPrint` / `scanWorkbookPrintBytes` |
 * | `GET /api/xls-print/sessions/:id/versions/:rev/download` | 文档端口**回读**（不重导） |
 * | `GET /api/xls-print/sessions/:id/handoff` | `handoffToPrint`（结构化「已交接」，`printed` 恒 `false`） |
 * | `POST /api/xls-print/sessions/:id/confirm` | `confirmPrintOutcome`（无消费端读回证据 ⇒ **拒绝**） |
 *
 * ## 三条纪律（每条都配反向对照，见 `xls-print-route.test.ts`）
 *
 * 1. **不建第二份账本**：会话就是 `DeliverableSession<XlsxPrintSource>`（`deliverable-host.ts`
 *    用的**同一个** seam，adapter 槽换成 `xlsxPrintDeliverableAdapter`）；发布端口把字节写进
 *    **同一个** `DocumentPort`（与交付宿主**同一份**产物根，`<root>/<artifactId>/<filename>`），
 *    而不是另起一个产物目录 / 另起一份会话落盘账。本模块**不 import `node:fs`**。
 * 2. **打印交接无消费端 ⇒ 最高只到「已交接」**：`handoffToPrint(..., null)` 的回执里
 *    `printed` 的类型就是字面量 `false`；`/confirm` 在**没有装配任何消费端**时**一律拒绝**
 *    （即使带上形状合法的"读回证据"），只有真的装配了消费端、且 `confirmPrintOutcome`
 *    接住合法证据时，才可能拿到 `printed: true`。
 * 3. **反向对照**：不设打印设置 ⇒ 导出里**零** `pageSetup` / `pageMargins` / `rowBreaks` /
 *    `Print_Area`（"只导出可见首屏"必须被检出为缺件）；**声称已打印**必须被拒。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **真实出纸 / PDF 渲染未验证**：本批**没有**任何消费端（Excel / WPS / 安卓办公套件 /
 *   打印机 / 虚拟 PDF 都不在位）。路由只证明"打印设置**真的写进了 .xlsx 字节**"，
 *   不证明"打得出来"。未验证清单随每次交接原样带出（`unverified`）。
 * - **导入不解出打印设置**（`xlsxPrintDeliverableAdapter` 的既有事实）：导入的源里
 *   打印计划是空计划（本仓读侧不建模打印）。
 * - **本文件在 http.ts / main.ts 上只做加法**：挂一条前缀 + 注入宿主，不改动既有路由分支。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readZip } from '../../../src/artifacts/ooxml/index.js';
import { ValidationError, type TemplateKind } from '../../../src/protocol/index.js';
import {
  EMPTY_RESIDUAL,
  createPrintLayout,
  createPrintPlan,
  createSheet,
  createWorkbook,
  getSheetPrint,
  isDefaultPrintLayout,
  setCellValue,
  setSheetPrint,
  textValue,
  type PrintLayout,
  type PrintLayoutInput,
  type PrintPlan,
  type WorkbookState,
} from '../../../src/spreadsheets/index.js';
import {
  DeliverableSession,
  PRINT_CEILING_WITHOUT_CONSUMER,
  PRINT_UNVERIFIED,
  confirmPrintOutcome,
  createPrintSource,
  digestBytes,
  handoffToPrint,
  scanWorkbookPrintBytes,
  xlsxPrintDeliverableAdapter,
} from '../../../src/session/index.js';
import type {
  DeliverableFailureCode,
  DeliverablePublishPort,
  DeliverablePublishRequest,
  DeliverablePublishResult,
  DeliverableSessionOptions,
  DeliverableSessionState,
  PrintConfirmedReceipt,
  PrintConsumerEvidence,
  PrintConsumerPort,
  PrintHandoffReceipt,
  PrintHandoffResult,
  SessionFailure,
  SessionPersistence,
  SessionResult,
  XlsxPrintByteScan,
  XlsxPrintSource,
} from '../../../src/session/index.js';
// 文档物化端口（**与交付宿主同一份**）：本模块只把字节交给它，不自己写盘（不建第二份账本）。
import type { DocumentPort } from '../documents/port.js';

// ---------------------------------------------------------------------------
// 挂载点与常量
// ---------------------------------------------------------------------------

/** 本模块拥有的顶层前缀（`route-dispatch-scan` 现推前缀表会读它）。**与既有前缀不重叠**。 */
export const XLS_PRINT_ROOT = '/api/xls-print';

/** 本路由**直接 import 并调用**的内核模块（→ 它们获得了非测试消费者）。 */
export const XLS_PRINT_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'src/session/adapters/xlsx-print.ts',
  'src/spreadsheets/print-layout.ts',
]);

/** 本路由仍未覆盖的边界（如实登记，不声称已覆盖）。 */
export const XLS_PRINT_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  '真实消费端（Excel / WPS / 安卓办公套件）打开并按设置分页 —— 本批无消费端',
  '真实打印机 / 虚拟 PDF 出纸 —— 本批无消费端',
  '导入既有 .xlsx 时恢复原文件的打印设置（读侧不建模打印）',
]);

/** 本路由层的未验证清单（逐字取自 `PRINT_UNVERIFIED`，再加本路由的口径）。 */
export const XLS_PRINT_UNVERIFIED: readonly string[] = Object.freeze([...PRINT_UNVERIFIED]);

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[\p{L}\p{N}._-]{1,128}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DEFAULT_MAX_SESSIONS = 64;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 宽松 base64 解码：形状不对（长度 / 字符集）⇒ `null`，不猜。 */
function decodeBase64(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/** 会话内存落盘（**不建第二份落盘账**：状态只在本进程里活）。 */
function memoryPersistence(): SessionPersistence {
  let state: DeliverableSessionState | null = null;
  return {
    save(next: DeliverableSessionState): void {
      state = next;
    },
    load(): unknown {
      return state;
    },
  };
}

/** 本路由用到的失败码：会话层的码表 + 本层自有的 `session_limit_reached`（映射 503）。 */
type XlsPrintFailureCode = DeliverableFailureCode | 'session_limit_reached';

/** 结构化未就绪（会话层失败码；HTTP 面据此映射状态码）。 */
function fail(code: XlsPrintFailureCode, message: string): SessionFailure {
  return {
    ok: false,
    code: code as DeliverableFailureCode,
    message,
    detail: { extra: Object.freeze({}) },
  };
}

/** 打印元素总数（从**字节**读回的事实，不是"我写了什么"的自称）。 */
function countPrintElements(scan: XlsxPrintByteScan): number {
  let total = scan.defined_names.length; // _xlnm.Print_Area / _xlnm.Print_Titles
  for (const sheet of scan.sheets) {
    total += sheet.page_setup ? 1 : 0;
    total += sheet.page_margins ? 1 : 0;
    total += sheet.header_footer ? 1 : 0;
    total += sheet.print_options ? 1 : 0;
    total += sheet.fit_to_page ? 1 : 0;
    total += sheet.row_breaks + sheet.column_breaks;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 请求体 → 源（工作簿 + 打印计划）
// ---------------------------------------------------------------------------

/** 读打印计划：`[{ sheet, layout }]`（每项一次整表覆盖）。 */
function readPlan(raw: unknown): PrintPlan {
  if (raw === undefined || raw === null) return createPrintPlan();
  if (!Array.isArray(raw)) {
    throw new ValidationError('plan 必须是 [{ sheet, layout }] 数组');
  }
  let plan = createPrintPlan();
  for (const entry of raw) {
    if (!isRecord(entry)) throw new ValidationError('plan 的每一项必须是 { sheet, layout } 对象');
    const sheet = entry['sheet'];
    if (typeof sheet !== 'string' || sheet.length === 0) {
      throw new ValidationError('plan 项缺 sheet（工作表名）');
    }
    const layoutRaw = entry['layout'];
    if (!isRecord(layoutRaw)) {
      throw new ValidationError(`plan 项 ${JSON.stringify(sheet)} 的 layout 必须是对象（PrintLayoutInput）`);
    }
    plan = setSheetPrint(plan, sheet, createPrintLayout(layoutRaw as PrintLayoutInput));
  }
  return plan;
}

/** 读工作簿规格：`{ sheets: [{ name, row_count?, column_count?, cells?: [{ ref, text }] }] }`。 */
function readWorkbookSpec(raw: unknown): WorkbookState {
  if (!isRecord(raw)) throw new ValidationError('workbook 必须是对象');
  const sheetsRaw = raw['sheets'];
  if (!Array.isArray(sheetsRaw) || sheetsRaw.length === 0) {
    throw new ValidationError('workbook.sheets 必须是非空数组');
  }
  const sheets = sheetsRaw.map((entry) => {
    if (!isRecord(entry)) throw new ValidationError('workbook.sheets 的每一项必须是对象');
    const name = entry['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new ValidationError('工作表缺 name（工作表名）');
    }
    const rowCount = entry['row_count'];
    const columnCount = entry['column_count'];
    let sheet = createSheet(name, {
      ...(typeof rowCount === 'number' ? { row_count: rowCount } : {}),
      ...(typeof columnCount === 'number' ? { column_count: columnCount } : {}),
    });
    const cells = entry['cells'];
    if (cells !== undefined) {
      if (!Array.isArray(cells)) throw new ValidationError(`工作表 ${JSON.stringify(name)} 的 cells 必须是数组`);
      for (const cell of cells) {
        if (!isRecord(cell)) throw new ValidationError('cell 必须是 { ref, text } 对象');
        const ref = cell['ref'];
        const text = cell['text'];
        if (typeof ref !== 'string' || typeof text !== 'string') {
          throw new ValidationError('cell 需要 string 类型的 ref 与 text');
        }
        sheet = setCellValue(sheet, ref, textValue(text));
      }
    }
    return sheet;
  });
  return createWorkbook(sheets);
}

/**
 * 请求体 → 打印源。
 *
 * 两条来源：`fileBase64`（导入既有 .xlsx，走打印适配器的**既有** `importBytes`）或
 * `workbook`（从规格新建）。两条来源之上再套 `plan`（打印计划）。
 */
function buildSource(body: Record<string, unknown>): XlsxPrintSource {
  const plan = readPlan(body['plan']);
  const fileBase64 = body['fileBase64'];
  if (typeof fileBase64 === 'string') {
    const bytes = decodeBase64(fileBase64);
    if (bytes === null) throw new ValidationError('fileBase64 不是合法 base64');
    const imported = xlsxPrintDeliverableAdapter.importBytes?.(bytes);
    if (imported === undefined) throw new ValidationError('打印适配器没有提供导入能力');
    if (!imported.ok) throw new ValidationError(`导入失败：${imported.detail}`);
    return createPrintSource(imported.source.workbook, imported.source.residual, plan);
  }
  return createPrintSource(readWorkbookSpec(body['workbook']), EMPTY_RESIDUAL, plan);
}

// ---------------------------------------------------------------------------
// 宿主：会话注册表 + 交付 seam + 文档端口
// ---------------------------------------------------------------------------

export interface XlsPrintHostOptions {
  /**
   * 文档物化端口（**与交付宿主同一份**）。省略 / `null` ⇒ 会话**发不出去**：
   * `/edits` 与 `/download` 结构化失败（**不**退回直接写文件，也不建第二份产物目录）。
   * 一次性 `/export` 与 `/handoff` 不依赖端口（它们在内存里出字节 + 扫字节）。
   */
  readonly documents: DocumentPort | null;
  /**
   * 打印消费端（本批产品路径**恒为 `null`**）。
   *
   * 存在的意义是让"已交接"与"已打印"在路由层就是两件事：消费端缺席时 `/confirm`
   * **一律拒绝**；只有真的装配了消费端，`confirmPrintOutcome` 才可能被合法证据满足。
   */
  readonly consumer?: PrintConsumerPort | null;
  readonly max_sessions?: number;
  readonly now?: () => Date;
}

/** 开会话的回执（与 `/api/deliverables` 同一形状）。 */
export interface OpenedXlsPrintSession {
  readonly session_id: string;
  readonly deliverable_id: string;
  readonly filename: string;
  readonly file_format: 'xlsx';
  readonly template_kind: TemplateKind;
  readonly edit_revision: number;
  readonly content_digest: string;
}

/** 一张工作表的打印事实（读自源里的打印计划）。 */
export interface XlsPrintSheetView {
  readonly sheet: string;
  readonly has_print_settings: boolean;
  readonly layout: PrintLayout | null;
}

/** 会话的打印视图（计划 + 从**当前字节**读回的事实）。 */
export interface XlsPrintView {
  readonly sheets: readonly XlsPrintSheetView[];
  readonly sheets_with_print: readonly string[];
  readonly content_digest: string;
  readonly read_back: XlsxPrintByteScan | null;
  readonly print_element_count: number;
}

/** 某一版已交付字节（与交付宿主 `DeliverableVersionBytes` 同一口径）。 */
export interface XlsPrintVersionBytes {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly artifact_id: string;
  readonly content_digest: string;
  readonly file_format: string;
  readonly mime_type: string;
}

export interface XlsPrintHost {
  readonly documents_wired: boolean;
  readonly consumer_wired: boolean;
  readonly session_count: number;
  open(input: {
    readonly session_id: string;
    readonly deliverable_id: string;
    readonly filename: string;
    readonly body: Record<string, unknown>;
  }): SessionResult<OpenedXlsPrintSession>;
  publish(sessionId: string, input: {
    readonly idempotency_key: string;
    readonly base_revision: number;
    readonly base_digest: string;
    readonly edit?: unknown;
  }): Promise<SessionResult<{ readonly replayed: boolean; readonly changed: boolean; readonly edit_revision: number; readonly notes: readonly string[]; readonly published: unknown }>>;
  status(sessionId: string): ReturnType<DeliverableSession<XlsxPrintSource>['status']> | undefined;
  printView(sessionId: string): XlsPrintView | undefined;
  handoff(sessionId: string): PrintHandoffResult | undefined;
  confirm(sessionId: string, evidence: PrintConsumerEvidence | null): SessionResult<PrintConfirmedReceipt>;
  versionBytes(sessionId: string, revision: number): Promise<XlsPrintVersionBytes | undefined>;
}

/** 构造打印路由宿主（产品装配处只调用一次）。 */
export function createXlsPrintHost(options: XlsPrintHostOptions): XlsPrintHost {
  const documents = options.documents;
  const consumer = options.consumer ?? null;
  const maxSessions = options.max_sessions ?? DEFAULT_MAX_SESSIONS;
  const now = options.now ?? ((): Date => new Date());
  const entries = new Map<string, DeliverableSession<XlsxPrintSource>>();

  /** 单一 artifactId 派生（确定性；`artifactId` 由文档端口当目录名用）。 */
  const artifactIdFor = (sessionId: string, revision: number): string =>
    `xls-print-${sha256Hex(`${sessionId}\u0000${String(revision)}`).slice(0, 20)}`;

  /**
   * 发布端口：把字节**经同一个文档端口**写盘并回读。
   *
   * 这是"不建第二份账本"的落点：产物落进交付宿主用的**同一个**产物根，
   * 而不是本模块另开一个目录；摘要以**端口回读**为准（不是我们自报的）。
   */
  function publishPortFor(sessionId: string): DeliverablePublishPort {
    return {
      publish: (request: DeliverablePublishRequest): Promise<DeliverablePublishResult> =>
        materialize(sessionId, request),
    };
  }

  async function materialize(
    sessionId: string,
    request: DeliverablePublishRequest,
  ): Promise<DeliverablePublishResult> {
    if (documents === null) {
      return {
        ok: false,
        failure: {
          kind: 'document_port_unavailable',
          detail: '物化端口未接入：无法写盘，因此不交付（不建第二份产物目录，也不用直接写文件顶替）',
        },
      };
    }
    const artifactId = artifactIdFor(sessionId, request.edit_revision);
    let receipt: { readonly path: string; readonly byteLength: number; readonly sha256: string };
    try {
      receipt = await documents.materialize({
        artifactId,
        filename: request.filename,
        bytes: request.bytes,
        expectedSha256: request.expected_digest,
        format: 'xlsx',
      });
    } catch (error) {
      return { ok: false, failure: { kind: 'materialize_failed', detail: describe(error) } };
    }
    if (receipt.sha256 !== request.expected_digest) {
      return {
        ok: false,
        failure: {
          kind: 'readback_digest_mismatch',
          detail: `端口回读摘要 ${receipt.sha256} ≠ 期望 ${request.expected_digest}：不记入交付`,
        },
      };
    }
    let entryCount = 0;
    try {
      entryCount = readZip(request.bytes).entries.length;
    } catch {
      entryCount = 0; // 摘要已核对；部件数读不到时如实报 0，不编造
    }
    return {
      ok: true,
      receipt: Object.freeze({
        artifact_id: artifactId,
        task_revision: request.edit_revision,
        artifact_version: request.edit_revision,
        readback_digest: receipt.sha256,
        byte_length: receipt.byteLength,
        entry_count: entryCount,
        filename: request.filename,
        verifier: 'document-port-readback',
        final_path: receipt.path,
      }),
    };
  }

  function optionsFor(
    sessionId: string,
    deliverableId: string,
    filename: string,
  ): DeliverableSessionOptions<XlsxPrintSource> {
    return {
      id: sessionId,
      deliverable_id: deliverableId,
      filename,
      adapter: xlsxPrintDeliverableAdapter,
      persistence: memoryPersistence(),
      publish_port: publishPortFor(sessionId),
      now,
    };
  }

  function open(input: {
    readonly session_id: string;
    readonly deliverable_id: string;
    readonly filename: string;
    readonly body: Record<string, unknown>;
  }): SessionResult<OpenedXlsPrintSession> {
    if (entries.has(input.session_id)) {
      return fail('session_already_exists', `会话 ${input.session_id} 已存在`);
    }
    if (entries.size >= maxSessions) {
      return fail('session_limit_reached', `打印会话数已达上限 ${String(maxSessions)}`);
    }
    const sessionOptions = optionsFor(input.session_id, input.deliverable_id, input.filename);
    let created: SessionResult<DeliverableSession<XlsxPrintSource>>;
    const fileBase64 = input.body['fileBase64'];
    try {
      if (typeof fileBase64 === 'string') {
        const bytes = decodeBase64(fileBase64);
        if (bytes === null) return fail('import_failed', 'fileBase64 不是合法 base64');
        created = DeliverableSession.importBytes(sessionOptions, bytes);
      } else {
        created = DeliverableSession.createNew(sessionOptions, buildSource(input.body));
      }
    } catch (error) {
      // 参数 / 打印设置非法：**请求侧**错误（4xx），不是 5xx。
      return fail('unsupported', describe(error));
    }
    if (!created.ok) return created;
    entries.set(input.session_id, created.value);
    const status = created.value.status();
    return {
      ok: true,
      value: Object.freeze({
        session_id: status.session_id,
        deliverable_id: status.deliverable_id,
        filename: status.filename,
        file_format: 'xlsx' as const,
        template_kind: status.template_kind,
        edit_revision: status.edit_revision,
        content_digest: status.content_digest,
      }),
    };
  }

  function entryFor(sessionId: string): DeliverableSession<XlsxPrintSource> | undefined {
    return entries.get(sessionId);
  }

  function printView(sessionId: string): XlsPrintView | undefined {
    const session = entryFor(sessionId);
    if (session === undefined) return undefined;
    const source = session.source();
    const sheets = source.workbook.sheets.map((sheet) => {
      const layout = getSheetPrint(source.plan, sheet.name) ?? null;
      return Object.freeze({
        sheet: sheet.name,
        has_print_settings: layout !== null && !isDefaultPrintLayout(layout),
        layout,
      });
    });
    const exported = xlsxPrintDeliverableAdapter.exportBytes(source);
    if (!exported.ok) {
      return Object.freeze({
        sheets: Object.freeze(sheets),
        sheets_with_print: Object.freeze(sheets.filter((view) => view.has_print_settings).map((view) => view.sheet)),
        content_digest: session.currentDigest(),
        read_back: null,
        print_element_count: 0,
      });
    }
    let scan: XlsxPrintByteScan | null = null;
    try {
      scan = scanWorkbookPrintBytes(exported.bytes);
    } catch {
      scan = null;
    }
    return Object.freeze({
      sheets: Object.freeze(sheets),
      sheets_with_print: Object.freeze(sheets.filter((view) => view.has_print_settings).map((view) => view.sheet)),
      content_digest: exported.digest,
      read_back: scan,
      print_element_count: scan === null ? 0 : countPrintElements(scan),
    });
  }

  function handoff(sessionId: string): PrintHandoffResult | undefined {
    const session = entryFor(sessionId);
    if (session === undefined) return undefined;
    return handoffToPrint(session.source(), consumer);
  }

  function confirm(
    sessionId: string,
    evidence: PrintConsumerEvidence | null,
  ): SessionResult<PrintConfirmedReceipt> {
    const session = entryFor(sessionId);
    if (session === undefined) return fail('session_not_found', `没有打印会话 ${sessionId}`);
    // **产品路径恒无消费端**：没有消费端 ⇒ 没有读回证据 ⇒ 一律拒绝"已打印"。
    if (consumer === null) {
      return fail(
        'unsupported',
        '没有任何消费端被装配（Excel / WPS / 安卓办公套件 / 打印机 / 虚拟 PDF 都不在位）：' +
          `没有读回证据，不得声称已打印；「已交接」（${PRINT_CEILING_WITHOUT_CONSUMER}）就是上限`,
      );
    }
    const handed = handoffToPrint(session.source(), consumer);
    if (!handed.ok) return fail('publish_failed', `交接失败：${handed.detail}`);
    try {
      return { ok: true, value: confirmPrintOutcome(handed.receipt, evidence) };
    } catch (error) {
      return fail('unsupported', describe(error));
    }
  }

  async function versionBytes(sessionId: string, revision: number): Promise<XlsPrintVersionBytes | undefined> {
    const session = entryFor(sessionId);
    if (session === undefined) return undefined;
    const version = session.publishedAt(revision);
    if (version === null) return undefined;
    if (documents === null) return undefined;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await documents.readBack(version.artifact_id, 'xlsx');
    } catch {
      return undefined;
    }
    if (bytes === undefined) return undefined;
    // 盘上那份与交付时记的不是同一份 ⇒ 不返回（不发自证无关的字节）。
    if (digestBytes(bytes) !== version.content_digest) return undefined;
    return Object.freeze({
      bytes,
      filename: version.filename,
      artifact_id: version.artifact_id,
      content_digest: version.content_digest,
      file_format: version.file_format,
      mime_type: version.mime_type,
    });
  }

  const host: XlsPrintHost = {
    documents_wired: documents !== null,
    consumer_wired: consumer !== null,
    get session_count(): number {
      return entries.size;
    },
    open,
    async publish(sessionId, input) {
      const session = entryFor(sessionId);
      if (session === undefined) return fail('session_not_found', `没有打印会话 ${sessionId}`);
      const outcome = await session.publish({
        idempotency_key: input.idempotency_key,
        base_revision: input.base_revision,
        base_digest: input.base_digest,
        ...(input.edit === undefined ? {} : { edit: input.edit }),
      });
      if (!outcome.ok) return outcome;
      return {
        ok: true,
        value: Object.freeze({
          replayed: outcome.value.replayed,
          changed: outcome.value.changed,
          edit_revision: outcome.value.edit_revision,
          notes: outcome.value.notes,
          published: outcome.value.published,
        }),
      };
    },
    status: (sessionId) => entryFor(sessionId)?.status(),
    printView,
    handoff,
    confirm,
    versionBytes,
  };
  return Object.freeze(host);
}

// ---------------------------------------------------------------------------
// 纯路由（不碰 node:http；可单测）
// ---------------------------------------------------------------------------

export interface XlsPrintWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

export interface XlsPrintWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 本命名空间是否归本模块管（挂载点的可判前缀）。 */
export function isXlsPrintPath(pathname: string): boolean {
  return pathname === XLS_PRINT_ROOT || pathname.startsWith(`${XLS_PRINT_ROOT}/`);
}

function ok(body: unknown, status = 200): XlsPrintWireResponse {
  return Object.freeze({ status, body });
}

function bad(status: number, code: string, message: string, extra?: Record<string, unknown>): XlsPrintWireResponse {
  return Object.freeze({
    status,
    body: Object.freeze({ code, message, retryable: false, ...(extra ?? {}) }),
  });
}

/** 会话层失败码 → HTTP 状态（与既有交付链同一口径，不另起一套）。 */
function statusOf(code: string): number {
  switch (code) {
    case 'session_not_found':
      return 404;
    case 'session_already_exists':
    case 'stale_revision':
    case 'idempotency_conflict':
      return 409;
    case 'session_limit_reached':
      return 503;
    case 'unsupported':
      return 422;
    case 'invalid_filename':
    case 'import_failed':
      return 400;
    default:
      return 502;
  }
}

function failureResponse(failure: SessionFailure): XlsPrintWireResponse {
  return bad(statusOf(failure.code), failure.code, failure.message, {
    ...(failure.detail.publishFailureKind === undefined
      ? {}
      : { publishFailureKind: failure.detail.publishFailureKind }),
  });
}

function segmentsOf(pathname: string): readonly string[] {
  const rest = pathname.slice(XLS_PRINT_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
  return rest === '' ? [] : rest.split('/');
}

function decodeId(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return SAFE_ID.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** 下载路径：`/api/xls-print/sessions/:id/versions/:rev/download`。 */
export function parseXlsPrintDownloadPath(
  pathname: string,
): { readonly sessionId: string; readonly revision: number } | null {
  if (!isXlsPrintPath(pathname)) return null;
  const segments = segmentsOf(pathname);
  if (segments.length !== 5) return null;
  if (segments[0] !== 'sessions' || segments[2] !== 'versions' || segments[4] !== 'download') return null;
  const sessionId = decodeId(segments[1]);
  const revision = Number(segments[3]);
  if (sessionId === null || !Number.isInteger(revision) || revision < 0) return null;
  return { sessionId, revision };
}

function versionEntry(published: unknown): unknown {
  if (!isRecord(published)) return null;
  return Object.freeze({
    editRevision: published['edit_revision'],
    taskRevision: published['task_revision'],
    artifactVersion: published['artifact_version'],
    artifactId: published['artifact_id'],
    contentDigest: published['content_digest'],
    byteLength: published['byte_length'],
    entryCount: published['entry_count'],
    filename: published['filename'],
    fileFormat: published['file_format'],
    mimeType: published['mime_type'],
    publishedAt: published['published_at'],
  });
}

/**
 * 处理一条 `/api/xls-print/**` 路由（**纯函数**：不碰 node:http）。
 *
 * @returns `null` = 不是本命名空间（调用方落到 404 / 其它路由）。
 */
export async function routeXlsPrintRequest(
  request: XlsPrintWireRequest,
  host: XlsPrintHost,
): Promise<XlsPrintWireResponse | null> {
  const pathname = request.pathname;
  if (!isXlsPrintPath(pathname)) return null;
  // 下载是二进制响应，由 HTTP 层直接处理（本纯函数只服务 JSON 面）。
  if (parseXlsPrintDownloadPath(pathname) !== null) return null;

  const method = request.method.toUpperCase();
  const segments = segmentsOf(pathname);
  const body = isRecord(request.body) ? request.body : {};

  // -- GET /api/xls-print[/status] -----------------------------------------
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'status')) {
    if (method !== 'GET' && method !== 'HEAD') return bad(405, 'method_not_allowed', '只接受 GET');
    return ok({
      root: XLS_PRINT_ROOT,
      ready: host.documents_wired,
      documents_wired: host.documents_wired,
      consumer_wired: host.consumer_wired,
      sessions: host.session_count,
      print_ceiling_without_consumer: PRINT_CEILING_WITHOUT_CONSUMER,
      modules_reachable: XLS_PRINT_MODULES_REACHABLE_BY_ROUTE,
      not_wired: XLS_PRINT_NOT_WIRED_BY_ROUTE,
      unverified: XLS_PRINT_UNVERIFIED,
      note: '打印设置会写进真实 .xlsx 字节；本批没有消费端 ⇒ 结论最高只到「已交接」，`printed` 恒 false。',
    });
  }

  // -- POST /api/xls-print/export（一次性：设打印设置 ⇒ 真实字节） ----------
  if (segments.length === 1 && segments[0] === 'export') {
    if (method !== 'POST') return bad(405, 'method_not_allowed', '只接受 POST');
    let source: XlsxPrintSource;
    try {
      source = buildSource(body);
    } catch (error) {
      return bad(422, 'invalid_request', describe(error));
    }
    const exported = xlsxPrintDeliverableAdapter.exportBytes(source);
    if (!exported.ok) return bad(502, exported.kind, exported.detail);
    let scan: XlsxPrintByteScan;
    try {
      scan = scanWorkbookPrintBytes(exported.bytes);
    } catch (error) {
      return bad(502, 'scan_failed', describe(error));
    }
    return ok({
      contentDigest: exported.digest,
      entryCount: exported.entry_count,
      byteLength: exported.bytes.byteLength,
      bytesBase64: Buffer.from(exported.bytes).toString('base64'),
      sheetsWithPrint: source.plan.entries
        .filter((entry) => !isDefaultPrintLayout(entry.layout))
        .map((entry) => entry.sheet),
      printElementCount: countPrintElements(scan),
      readBack: scan,
    });
  }

  // -- /api/xls-print/sessions/** ------------------------------------------
  if (segments[0] !== 'sessions') {
    return bad(404, 'not_found', `没有这个打印接口 ${method} ${pathname}`);
  }

  // POST /api/xls-print/sessions（开会话）
  if (segments.length === 1) {
    if (method !== 'POST') return bad(405, 'method_not_allowed', '只接受 POST');
    const sessionId = body['sessionId'];
    const deliverableId = body['deliverableId'];
    const filename = body['filename'];
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) {
      return bad(400, 'invalid_session_id', 'sessionId 必填且必须是 1–128 位安全字符');
    }
    if (typeof deliverableId !== 'string' || !SAFE_ID.test(deliverableId)) {
      return bad(400, 'invalid_deliverable_id', 'deliverableId 必填且必须是 1–128 位安全字符');
    }
    if (typeof filename !== 'string' || filename.length === 0) {
      return bad(400, 'invalid_filename', 'filename 必填且必须是非空字符串');
    }
    const opened = host.open({
      session_id: sessionId,
      deliverable_id: deliverableId,
      filename,
      body,
    });
    if (!opened.ok) return failureResponse(opened);
    // 响应一律 camelCase（与 `/api/deliverables` 同一口径，不把内部状态形状倒出去）。
    return ok(
      {
        sessionId: opened.value.session_id,
        deliverableId: opened.value.deliverable_id,
        filename: opened.value.filename,
        fileFormat: opened.value.file_format,
        templateKind: opened.value.template_kind,
        editRevision: opened.value.edit_revision,
        contentDigest: opened.value.content_digest,
      },
      201,
    );
  }

  const sessionId = decodeId(segments[1]);
  if (sessionId === null) {
    return bad(404, 'session_not_found', `没有这个打印会话 ${JSON.stringify(String(segments[1] ?? ''))}`);
  }

  // GET /api/xls-print/sessions/:id（状态 + 打印视图）
  if (segments.length === 2) {
    if (method !== 'GET' && method !== 'HEAD') return bad(405, 'method_not_allowed', '只接受 GET');
    const status = host.status(sessionId);
    if (status === undefined) return bad(404, 'session_not_found', `没有打印会话 ${sessionId}`);
    const view = host.printView(sessionId);
    return ok({
      sessionId: status.session_id,
      deliverableId: status.deliverable_id,
      filename: status.filename,
      fileFormat: status.file_format,
      templateKind: status.template_kind,
      editRevision: status.edit_revision,
      contentDigest: status.content_digest,
      sourceKind: status.source_kind,
      versions: status.published.map(versionEntry),
      print: view === undefined
        ? null
        : {
            sheets: view.sheets.map((entry) => ({
              sheet: entry.sheet,
              hasPrintSettings: entry.has_print_settings,
              layout: entry.layout,
            })),
            sheetsWithPrint: view.sheets_with_print,
            contentDigest: view.content_digest,
            printElementCount: view.print_element_count,
            readBack: view.read_back,
          },
      log: status.log.slice(-32).map((entry) => ({
        seq: entry.seq,
        kind: entry.kind,
        baseRevision: entry.base_revision,
        resultRevision: entry.result_revision,
        at: entry.at,
        changed: entry.changed,
        rejection: entry.rejection,
      })),
    });
  }

  const action = segments[2];

  // POST /api/xls-print/sessions/:id/edits（编辑 + 交付一版）
  if (action === 'edits' && segments.length === 3) {
    if (method !== 'POST') return bad(405, 'method_not_allowed', '只接受 POST');
    const idempotencyKey = body['idempotencyKey'];
    const baseRevision = body['baseRevision'];
    const baseDigest = body['baseDigest'];
    if (typeof idempotencyKey !== 'string' || !SAFE_ID.test(idempotencyKey)) {
      return bad(400, 'invalid_idempotency_key', '缺少合法的 idempotencyKey（1–128 位安全字符）');
    }
    if (typeof baseRevision !== 'number' || !Number.isInteger(baseRevision) || baseRevision < 0) {
      return bad(400, 'invalid_base_revision', 'baseRevision 必须是 ≥0 的整数');
    }
    if (typeof baseDigest !== 'string' || !SHA256_HEX.test(baseDigest)) {
      return bad(400, 'invalid_base_digest', 'baseDigest 必须是 64 位小写十六进制');
    }
    const outcome = await host.publish(sessionId, {
      idempotency_key: idempotencyKey,
      base_revision: baseRevision,
      base_digest: baseDigest,
      ...(body['edit'] === undefined ? {} : { edit: body['edit'] }),
    });
    if (!outcome.ok) return failureResponse(outcome);
    return ok({
      sessionId,
      replayed: outcome.value.replayed,
      changed: outcome.value.changed,
      editRevision: outcome.value.edit_revision,
      notes: outcome.value.notes,
      version: versionEntry(outcome.value.published),
    });
  }

  // GET /api/xls-print/sessions/:id/handoff（结构化「已交接」）
  if (action === 'handoff' && segments.length === 3) {
    if (method !== 'GET' && method !== 'HEAD') return bad(405, 'method_not_allowed', '只接受 GET');
    const result = host.handoff(sessionId);
    if (result === undefined) return bad(404, 'session_not_found', `没有打印会话 ${sessionId}`);
    if (!result.ok) return bad(502, result.kind, result.detail);
    return ok(handoffView(result.receipt));
  }

  // POST /api/xls-print/sessions/:id/confirm（无消费端读回证据 ⇒ 拒绝）
  if (action === 'confirm' && segments.length === 3) {
    if (method !== 'POST') return bad(405, 'method_not_allowed', '只接受 POST');
    const rawEvidence = body['evidence'];
    let evidence: PrintConsumerEvidence | null = null;
    if (rawEvidence !== undefined && rawEvidence !== null) {
      if (!isRecord(rawEvidence)) return bad(422, 'invalid_evidence', 'evidence 必须是对象');
      evidence = {
        consumer: rawEvidence['consumer'] as PrintConsumerEvidence['consumer'],
        read_back_sha256: rawEvidence['read_back_sha256'] as string,
        pages: rawEvidence['pages'] as number,
      };
    }
    const outcome = host.confirm(sessionId, evidence);
    if (!outcome.ok) return failureResponse(outcome);
    return ok({
      kind: outcome.value.kind,
      status: outcome.value.status,
      printed: outcome.value.printed,
      evidence: outcome.value.evidence,
    });
  }

  return bad(404, 'not_found', `没有这个打印接口 ${method} ${pathname}`);
}

/** 把交接回执转成 HTTP JSON（字段名保持与 `PrintHandoffReceipt` 一致，便于逐项核对）。 */
function handoffView(receipt: PrintHandoffReceipt): Record<string, unknown> {
  return Object.freeze({
    kind: receipt.kind,
    status: receipt.status,
    printed: receipt.printed,
    confirmed_by: receipt.confirmed_by,
    content_digest: receipt.content_digest,
    sheets_with_print: receipt.sheets_with_print,
    manual_break_count: receipt.manual_break_count,
    consumer: receipt.consumer,
    consumer_ack: receipt.consumer_ack,
    read_back: receipt.read_back,
    unverified: receipt.unverified,
    detail: receipt.detail,
  });
}

// ---------------------------------------------------------------------------
// HTTP 挂载点
// ---------------------------------------------------------------------------

export interface XlsPrintHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readRawBody(
  req: IncomingMessage,
): Promise<{ readonly ok: true; readonly raw: string } | { readonly ok: false }> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { readonly ok: true; readonly raw: string } | { readonly ok: false }): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * **挂载点**：处理一次 `/api/xls-print/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**一行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * if (await handleXlsPrintRequest({ req, res, url, method }, xlsPrintHost)) return;
 * ```
 *
 * 产品装配处（`main.ts`）构造一次宿主并复用（注入**同一个** `DocumentPort`）。
 */
export async function handleXlsPrintRequest(
  input: XlsPrintHttpInput,
  host: XlsPrintHost,
): Promise<boolean> {
  const pathname = input.url.pathname;
  if (!isXlsPrintPath(pathname)) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();

  // --- 二进制下载（在纯路由之前处理：响应不是 JSON） ------------------------
  const download = parseXlsPrintDownloadPath(pathname);
  if (download !== null) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(input.res, 405, { code: 'method_not_allowed', message: '该接口只接受 GET', retryable: false });
      return true;
    }
    const found = await host.versionBytes(download.sessionId, download.revision);
    if (found === undefined) {
      sendJson(input.res, 404, {
        code: 'version_not_found',
        message: '这个打印会话里没有该编辑版本的已交付文件（未发布或摘要已不符）',
        retryable: false,
      });
      return true;
    }
    const asciiFallback = found.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
    input.res.writeHead(200, {
      'content-type': found.mime_type,
      'content-length': found.bytes.byteLength,
      'content-disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(
        found.filename,
      )}`,
      'x-content-sha256': found.content_digest,
      'x-potbot-artifact-id': found.artifact_id,
      'x-potbot-file-format': found.file_format,
      'cache-control': 'no-store',
    });
    if (method === 'HEAD') {
      input.res.end();
      return true;
    }
    input.res.end(Buffer.from(found.bytes));
    return true;
  }

  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(input.res, 413, {
        code: 'body_too_large',
        message: `请求体超过 ${String(MAX_BODY_BYTES)} 字节上限`,
        retryable: false,
      });
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw) as unknown;
      } catch {
        sendJson(input.res, 400, { code: 'invalid_json', message: '请求体不是合法 JSON', retryable: false });
        return true;
      }
    }
  }

  const response = await routeXlsPrintRequest({ method, pathname, body }, host);
  if (response === null) {
    // 唯一到这里的形状是"下载路径但被 handle 层拦下"——已在上面处理；其余落到 404。
    sendJson(input.res, 404, { code: 'not_found', message: `没有这个打印接口 ${method} ${pathname}`, retryable: false });
    return true;
  }
  sendJson(input.res, response.status, response.body);
  return true;
}
