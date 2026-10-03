/**
 * 表格交付：**导出侧公式求值报告**的产品 HTTP 出口（工作包 FA-XLS-FORMULA-REPORT）。
 *
 * ## 这个文件补的是哪一个洞（已实测的接线缺口）
 *
 * `src/spreadsheets/xlsx-write.ts` 的 `writeWorkbookXlsx` 早就把"逐格公式算没算出来、被阻塞是因为什么"
 * 做成了机器可读的登记（`XlsxWriteResult.evaluations` → {@link FormulaEvaluationRecord}：
 * `sheet` / `ref` / `formula` / `ok` / `reason` / `detail`）。但**产品 `/api/**` 上没有任何一条路由
 * 读得到它**：因此"环 / 公式阻塞的**原因字符串**"只能经 `/api/xls-facts/sessions/:id/facts` 的
 * `blocked_formula_keys`（**只有键名、没有原因**）间接暴露（该缺口由 `xls-formula-e2e.test.ts`
 * 头部如实登记）。本模块把这条登记**接上 HTTP**，且**不重写任何判定口径**——求值结论与阻塞原因
 * **原样透出内核**（见 {@link buildFormulaReport}：逐格结论只来自 `writeWorkbookXlsx` 的登记）。
 *
 * ## 端点（全部挂在 {@link XLS_FORMULA_REPORT_ROOT} 下）
 *
 * | 端点 | 语义 | 读的是哪份字节 |
 * |---|---|---|
 * | `GET /status` | 就绪探针（版本字节来源是否接线，逐条如实报出） | —— |
 * | `GET /sessions/:sessionId/versions/:revision/report` | 某一**交付会话**某一**编辑版本**的逐格公式求值报告 | `DeliverableHost.versionBytes`（盘上那版真实字节） |
 *
 * **"给定一个交付会话 / 版本"** 在这里是**字面意思**：本路由不另建会话，读的是
 * `/api/deliverables/**` 那条链已经交付并落盘的版本字节（与
 * `GET /api/deliverables/:id/versions/:rev/download` **同一份来源、同一份摘要校验**）。
 * 因此"这个报告说的是哪一版"由交付链自己给出，不是本模块的复述。
 *
 * ## 三条硬约束（每条都有反向对照，见同名 `.test.ts`）
 *
 * 1. **原因原样透出**：`blocked` 的 `reason` 是内核 `FormulaEvalBlockReason` 的**字面值**
 *    （`circular_reference` / `parse_error` / `unsupported_function` / `empty_aggregate` …），
 *    `detail` 是内核的证据句。本模块**不翻译、不归类、不编造**任何原因字符串。
 * 2. **没有报告就说没有报告**：源里**一个单元格都没有**（空白源）⇒ `report_state: "no_report"`，
 *    `cells` 为 **`null`**（**不是 `[]`**）——空数组会被读成"逐格全过"，那是伪造。
 * 3. **会话 / 版本不存在 ⇒ 404**：会话不存在给 `session_not_found`；会话存在但该编辑版本没有
 *    已交付文件给 `version_not_found`——与 `http.ts` 既有下载路由同一套词。
 *
 * ## ⚠️ 如实标注（结果不得编造；不夸大）
 *
 * - **求的是核心白名单**：`writeWorkbookXlsx` 的登记来自 `evaluate.ts` 的 `SUPPORTED_FUNCTIONS`
 *   （13 个）。因此 `xlsx-07` 的扩展函数（如 `VLOOKUP`）在**导出侧**是 `unsupported_function`——
 *   这不是本模块的取舍，而是**导出路径的真实口径**（导出写进 `<v>` 的就是这份结论）。
 *   扩展白名单那条重算口径（`recalcWorkbook`）**只**被本模块用来取**环成员键**，不用来改判结论。
 * - **只报结论，不报缓存值**：`FormulaEvaluationRecord` 只带 `ok` / `reason` / `detail`，
 *   不带算出来的数值；本模块**不额外读值**（值见交付字节本身的 `<v>`）。
 * - **`reason` 词表**：内核用 `unsupported_function`（不是 `unknown_function`）表示"函数不在白名单内"。
 *   本模块**不得**把它改名成 `unknown_function`——那会是编造原因。
 * - **消费端未验证**：真实 Excel / WPS / 安卓办公套件如何呈现"只有 `<f>` 没有 `<v>`"的阻塞格，
 *   本包**未验证**（见 {@link XLS_FORMULA_REPORT_UNVERIFIED}）。
 * - **非 xlsx 版本不报**：docx / pptx 版本没有公式求值报告，本模块给结构化 `not_a_spreadsheet`，
 *   不假装有。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { ValidationError } from '../../../src/protocol/index.js';
import {
  readWorkbookXlsx,
  recalcWorkbook,
  sheetEntries,
  writeWorkbookXlsx,
  type FormulaEvaluationRecord,
  type WorkbookState,
} from '../../../src/spreadsheets/index.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` 只按这个前缀转交（与 `/api/xls-facts` 不重叠）。 */
export const XLS_FORMULA_REPORT_ROOT = '/api/xls-formula';

/** 会话 id 的合法形状（与交付链同一套安全字符）。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** 未验证清单（如实登记，不写进任何"已完成"判定）。 */
export const XLS_FORMULA_REPORT_UNVERIFIED: readonly string[] = Object.freeze([
  '真实 Excel / WPS / 安卓办公套件打开交付字节时，对"只有 <f> 没有 <v>"的阻塞格如何呈现',
  '安卓端把本报告渲染成气泡 / 面板的消费路径（本包只交付只读 HTTP 出口，未接页面）',
]);

/** 逐格结论的三值词汇（与 {@link FormulaReportCell.conclusion} 同一套；这里只是自证用）。 */
export const FORMULA_REPORT_CONCLUSIONS: readonly string[] = Object.freeze([
  'ok',
  'blocked',
  'not_a_formula',
]);

/** 空报告（空白源）的统一原因句（可核对、可执行）。 */
export const NO_REPORT_REASON =
  '这一版的交付字节里一个单元格都没有（空白源）：没有任何可报告的求值结论，' +
  '本层返回结构化 no_report 而不是空数组（空数组会被读成"逐格全过"，那是伪造）';

/** 版本字节来源未接线时的统一原因句。 */
export const UNWIRED_REASON =
  '本进程没有装配交付会话宿主（DeliverableHost）：读不到"某一版交付字节"，' +
  '因此给不出导出侧求值报告。这是如实未就绪，不是"没有这个接口"。';

// ---------------------------------------------------------------------------
// 形状小工具（自足；不 import http.ts 的私有实现）
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 报告形状
// ---------------------------------------------------------------------------

/** 一个格子的求值结论。 */
export interface FormulaReportCell {
  /** `"表名!A1"`（与内核 `CellKey` 同形）。 */
  readonly key: string;
  readonly sheet: string;
  /** A1 记法（不含表名）。 */
  readonly ref: string;
  /** 公式原文（非公式格为 `null`）。**原文透出**，不归一化、不加 `=`。 */
  readonly formula: string | null;
  readonly conclusion: 'ok' | 'blocked' | 'not_a_formula';
  /**
   * 阻塞原因（**内核字面值**，原样透出；非阻塞为 `null`）。
   *
   * 例：`circular_reference` / `parse_error` / `unsupported_function` / `empty_aggregate` /
   * `blank_operand` / `invalid_arguments` …… 本模块不翻译、不改名、不归类。
   */
  readonly reason: string | null;
  /** 内核给的证据句（非阻塞为 `null`）。 */
  readonly detail: string | null;
  /** 环成员键（仅当 `reason === 'circular_reference'`；否则 `null`）。 */
  readonly cycle_members: readonly string[] | null;
  /** 非公式格的取值类别（公式格为 `null`）；便于看出"这不是公式"。 */
  readonly value_kind: string | null;
}

/** 逐格报告的汇总计数。 */
export interface FormulaReportSummary {
  readonly total_cells: number;
  readonly formula_cells: number;
  readonly ok: number;
  readonly blocked: number;
  readonly not_a_formula: number;
}

/** 一份导出侧公式求值报告。 */
export interface FormulaReport {
  /**
   * `available` = 这一版至少有一个非空单元格（逐格结论见 `cells`）；
   * `no_report` = 这一版**一个单元格都没有** ⇒ `cells` 为 `null`（**不是 `[]`**）。
   */
  readonly report_state: 'available' | 'no_report';
  /** `no_report` 时的原因；`available` 时为 `null`。 */
  readonly reason: string | null;
  /** 逐格结论；`no_report` 时为 **`null`**（空数组在这里连构造都构造不出来）。 */
  readonly cells: readonly FormulaReportCell[] | null;
  readonly summary: FormulaReportSummary;
  /** 检测到的环（每个元素是一组互相可达或自引用的公式格键，已排序）。 */
  readonly cycles: readonly (readonly string[])[];
  /**
   * 补充说明：`available` 且**没有任何公式格**时给出提示句（防止"0 个阻塞"被读成"全部通过"）；
   * 其余情况为 `null`。
   */
  readonly note: string | null;
}

function isEmptySummary(): FormulaReportSummary {
  return Object.freeze({ total_cells: 0, formula_cells: 0, ok: 0, blocked: 0, not_a_formula: 0 });
}

/**
 * 由**一份工作簿状态**构建逐格求值报告（**纯函数**：不改工作簿，不碰 node:http）。
 *
 * 公式格的结论**只**来自 `writeWorkbookXlsx(workbook).evaluations`（导出侧真实口径）；
 * 非公式格由工作簿本身枚举（`sheetEntries`）标 `not_a_formula`；环成员键取自
 * `recalcWorkbook(workbook).cycles`（内核依赖图的 SCC），**只用于给 `circular_reference`
 * 补上成员键**，不改任何结论。
 *
 * @throws {ValidationError} 公式格在导出登记里缺失（结构上不应发生；宁可显式失败也不编造原因）
 */
export function buildFormulaReport(workbook: WorkbookState): FormulaReport {
  const written = writeWorkbookXlsx(workbook);
  const recordByKey = new Map<string, FormulaEvaluationRecord>();
  for (const record of written.evaluations) {
    recordByKey.set(`${record.sheet}!${record.ref}`, record);
  }

  const cycles = recalcWorkbook(workbook).cycles;
  const cycleByKey = new Map<string, readonly string[]>();
  for (const cycle of cycles) {
    for (const key of cycle) {
      cycleByKey.set(key, cycle);
    }
  }

  const cells: FormulaReportCell[] = [];
  let ok = 0;
  let blocked = 0;
  let notAFormula = 0;
  let formulaCells = 0;

  for (const sheet of workbook.sheets) {
    for (const entry of sheetEntries(sheet)) {
      const key = `${sheet.name}!${entry.ref}`;
      if (entry.value.kind !== 'formula') {
        notAFormula += 1;
        cells.push(
          Object.freeze({
            key,
            sheet: sheet.name,
            ref: entry.ref,
            formula: null,
            conclusion: 'not_a_formula' as const,
            reason: null,
            detail: null,
            cycle_members: null,
            value_kind: entry.value.kind,
          }),
        );
        continue;
      }

      formulaCells += 1;
      const record = recordByKey.get(key);
      if (record === undefined) {
        // 结构上不可达：`writeWorkbookXlsx` 的登记就是对同一份 `workbook.sheets` 逐公式格产生的。
        // 真出现了说明发生了两套来源分叉——**显式失败**，绝不给一个编造的原因。
        throw new ValidationError(
          `导出侧求值登记里缺少公式格 ${key}（导出登记与工作簿不一致，拒绝给出编造的原因）`,
        );
      }

      if (record.ok) {
        ok += 1;
        cells.push(
          Object.freeze({
            key,
            sheet: sheet.name,
            ref: entry.ref,
            formula: entry.value.text,
            conclusion: 'ok' as const,
            reason: null,
            detail: null,
            cycle_members: null,
            value_kind: null,
          }),
        );
        continue;
      }

      blocked += 1;
      const reason = record.reason ?? null;
      cells.push(
        Object.freeze({
          key,
          sheet: sheet.name,
          ref: entry.ref,
          formula: entry.value.text,
          conclusion: 'blocked' as const,
          reason,
          detail: record.detail ?? null,
          // 只有环才补成员键；别的阻塞原因没有"成员"可言（不硬塞空数组冒充）。
          cycle_members: reason === 'circular_reference' ? (cycleByKey.get(key) ?? null) : null,
          value_kind: null,
        }),
      );
    }
  }

  if (cells.length === 0) {
    return Object.freeze({
      report_state: 'no_report' as const,
      reason: NO_REPORT_REASON,
      cells: null,
      summary: isEmptySummary(),
      cycles: Object.freeze(cycles.map((cycle) => Object.freeze([...cycle]))),
      note: null,
    });
  }

  const summary: FormulaReportSummary = Object.freeze({
    total_cells: cells.length,
    formula_cells: formulaCells,
    ok,
    blocked,
    not_a_formula: notAFormula,
  });

  return Object.freeze({
    report_state: 'available' as const,
    reason: null,
    cells: Object.freeze(cells),
    summary,
    cycles: Object.freeze(cycles.map((cycle) => Object.freeze([...cycle]))),
    note:
      formulaCells === 0
        ? '这一版没有任何公式格：逐格结论全是 not_a_formula，没有一个公式可求值（"0 个阻塞"不等于"全部通过"）'
        : null,
  });
}

// ---------------------------------------------------------------------------
// 版本字节来源（交付链接口；产品路径注入真实 DeliverableHost）
// ---------------------------------------------------------------------------

/** 一份已交付版本的字节摘要（与 `DeliverableHost.versionBytes` 的结构对齐）。 */
export interface DeliveredVersionBytes {
  readonly bytes: Uint8Array;
  readonly file_format: string;
  readonly content_digest: string;
  readonly filename: string;
}

/**
 * 版本字节来源。
 *
 * 生产装配（`http.ts`）把它接到**交付会话宿主**上：`hasSession` ↔ `DeliverableHost.status`，
 * `readVersion` ↔ `DeliverableHost.versionBytes`（同一份盘上字节 + 同一份摘要校验）。
 */
export interface XlsFormulaReportSource {
  hasSession(sessionId: string): boolean;
  readVersion(sessionId: string, revision: number): Promise<DeliveredVersionBytes | undefined>;
}

/** 报告宿主（路由只读它）。 */
export interface XlsFormulaReportHost {
  readonly root: string;
  /** `null` = 本进程没有装配交付会话宿主 ⇒ 报告端点结构化 503（不是 404）。 */
  readonly source: XlsFormulaReportSource | null;
}

export interface XlsFormulaReportHostOptions {
  readonly source?: XlsFormulaReportSource | null;
}

/** 建一个报告宿主。生产路径传**真实交付宿主**；不传 ⇒ 未接线（如实 503）。 */
export function createXlsFormulaReportHost(
  options: XlsFormulaReportHostOptions = {},
): XlsFormulaReportHost {
  return Object.freeze({
    root: XLS_FORMULA_REPORT_ROOT,
    source: options.source ?? null,
  });
}

// ---------------------------------------------------------------------------
// 纯路由核心（不碰 node:http，便于直接单测）
// ---------------------------------------------------------------------------

export interface XlsFormulaWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

export interface XlsFormulaWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 本命名空间是否归本模块管（挂载点的可判前缀）。 */
export function isXlsFormulaReportPath(pathname: string): boolean {
  return pathname === XLS_FORMULA_REPORT_ROOT || pathname.startsWith(`${XLS_FORMULA_REPORT_ROOT}/`);
}

function ok(body: unknown, status = 200): XlsFormulaWireResponse {
  return Object.freeze({ status, body });
}

function fail(status: number, code: string, message: string): XlsFormulaWireResponse {
  return Object.freeze({ status, body: Object.freeze({ code, message, retryable: false }) });
}

function segmentsOf(pathname: string): readonly string[] {
  const rest = pathname.slice(XLS_FORMULA_REPORT_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
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

function statusView(host: XlsFormulaReportHost): Record<string, unknown> {
  const wired = host.source !== null;
  return Object.freeze({
    root: XLS_FORMULA_REPORT_ROOT,
    ready: wired,
    version_source: wired ? 'deliverable-host' : 'unwired',
    reason: wired ? null : UNWIRED_REASON,
    conclusions: FORMULA_REPORT_CONCLUSIONS,
    /** 报告只覆盖 xlsx 版本；docx / pptx 版本给结构化 not_a_spreadsheet。 */
    reportable_formats: Object.freeze(['xlsx']),
    /** 原因字符串的词表来源（本模块不自带词表，也不改名）。 */
    reason_vocabulary_source: 'src/spreadsheets/evaluate.ts 的 FormulaEvalBlockReason（原样透出）',
    unverified: XLS_FORMULA_REPORT_UNVERIFIED,
  });
}

/**
 * 处理一条 `/api/xls-formula/**` 路由（**纯函数**：不碰 node:http）。
 *
 * @returns `null` = 不是本命名空间（调用方落到 404 / 其它路由）。
 */
export async function routeXlsFormulaReportRequest(
  request: XlsFormulaWireRequest,
  host: XlsFormulaReportHost,
): Promise<XlsFormulaWireResponse | null> {
  if (!isXlsFormulaReportPath(request.pathname)) return null;
  const method = request.method.toUpperCase();
  const segments = segmentsOf(request.pathname);

  // -- GET /api/xls-formula[/status] ---------------------------------------
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'status')) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', '只接受 GET');
    return ok(statusView(host));
  }

  // -- GET /api/xls-formula/sessions/:id/versions/:rev/report ---------------
  if (segments.length === 5 && segments[0] === 'sessions' && segments[2] === 'versions' && segments[4] === 'report') {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', '只接受 GET');

    const sessionId = decodeId(segments[1]);
    if (sessionId === null) {
      return fail(404, 'session_not_found', `没有这个交付会话 ${JSON.stringify(String(segments[1] ?? ''))}`);
    }
    const rawRevision = segments[3] ?? '';
    if (!/^\d{1,9}$/.test(rawRevision)) {
      return fail(404, 'version_not_found', `编辑版本号必须是十进制整数（收到 ${JSON.stringify(rawRevision)}）`);
    }
    const revision = Number.parseInt(rawRevision, 10);

    const source = host.source;
    if (source === null) {
      return fail(503, 'formula_report_unwired', UNWIRED_REASON);
    }
    if (!source.hasSession(sessionId)) {
      return fail(404, 'session_not_found', `没有这个交付会话 ${sessionId}`);
    }

    let version: DeliveredVersionBytes | undefined;
    try {
      version = await source.readVersion(sessionId, revision);
    } catch (error) {
      return fail(502, 'version_unreadable', `读交付版本字节失败：${describe(error)}`);
    }
    if (version === undefined) {
      return fail(
        404,
        'version_not_found',
        `交付会话 ${sessionId} 里没有编辑版本 ${String(revision)} 的已交付文件（未发布或摘要已不符）`,
      );
    }

    if (version.file_format !== 'xlsx') {
      return fail(
        422,
        'not_a_spreadsheet',
        `版本 ${String(revision)} 的格式是 ${JSON.stringify(version.file_format)}：公式求值报告只对 xlsx 成立，` +
          'docx / pptx 没有这份报告（不假装有）',
      );
    }

    let workbook: WorkbookState;
    try {
      workbook = readWorkbookXlsx(version.bytes).workbook;
    } catch (error) {
      return fail(502, 'unreadable_delivery', `交付字节读不回来（不是合法 .xlsx？）：${describe(error)}`);
    }

    let report: FormulaReport;
    try {
      report = buildFormulaReport(workbook);
    } catch (error) {
      return fail(500, 'report_failed', `构建求值报告失败：${describe(error)}`);
    }

    return ok(
      Object.freeze({
        sessionId,
        revision,
        file_format: version.file_format,
        /** **交付那一版**的字节摘要（与下载端 `x-content-sha256` 同源）。 */
        content_digest: version.content_digest,
        /** 本次求值所用的导出展开摘要（证明结论确实来自一次真实导出）。 */
        export_content_digest: writeWorkbookXlsx(workbook).content_digest,
        evaluation_source: 'writeWorkbookXlsx().evaluations（核心白名单口径，原样透出）',
        ...report,
      }),
    );
  }

  return fail(404, 'not_found', `没有这个公式报告接口 ${method} ${request.pathname}`);
}

// ---------------------------------------------------------------------------
// node:http 适配器（挂载点）
// ---------------------------------------------------------------------------

export interface XlsFormulaHttpInput {
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

/**
 * **挂载点**：处理一次 `/api/xls-formula/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 里加**两行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * import { handleXlsFormulaReportRequest, createXlsFormulaReportHost } from './xls-formula-report.js';
 * ...
 * if (await handleXlsFormulaReportRequest({ req, res, url, method }, xlsFormulaReportHost)) return;
 * ```
 *
 * 只读：只接受 GET / HEAD，不读请求体。
 */
export async function handleXlsFormulaReportRequest(
  input: XlsFormulaHttpInput,
  host: XlsFormulaReportHost,
): Promise<boolean> {
  const pathname = input.url.pathname;
  if (!isXlsFormulaReportPath(pathname)) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  const response = await routeXlsFormulaReportRequest({ method, pathname, body: null }, host);
  if (response === null) return false;
  sendJson(input.res, response.status, response.body);
  return true;
}

// ---------------------------------------------------------------------------
// 可达性自证：本路由**直接消费**（因而使其产品可达）的内核模块清单
// ---------------------------------------------------------------------------

/** 本路由**直接 import 并调用**的内核模块（→ 它们获得了非测试消费者）。 */
export const XLS_FORMULA_REPORT_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'src/spreadsheets/xlsx-write.ts',
  'src/spreadsheets/xlsx-read.ts',
  'src/spreadsheets/recalc.ts',
  'src/spreadsheets/sheet.ts',
]);

/** 仍未由本路由接线的能力（如实登记，不声称已覆盖）。 */
export const XLS_FORMULA_REPORT_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  '安卓 / 网页页面把本报告渲染成决策气泡（本包只交付只读 HTTP 出口）',
  'docx / pptx 版本的公式求值报告（非表格格式没有这份报告，给结构化 not_a_spreadsheet）',
  '扩展函数白名单（XLS-07 `evaluateWithFunctions`）作为**导出侧**口径（导出仍走核心白名单）',
]);

