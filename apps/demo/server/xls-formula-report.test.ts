/**
 * 导出侧公式求值报告（`xls-formula-report.ts`）的定向套件（工作包 FA-XLS-FORMULA-REPORT）。
 *
 * ## 本套件要证明的四件事（每条都有反向对照）
 *
 * 1. **原因原样透出**：`blocked` 的 `reason` 逐字等于内核 `FormulaEvalBlockReason`
 *    （`circular_reference` / `unsupported_function` / `empty_aggregate` / `parse_error` …），
 *    本层**没有**自己的词表、**没有**改名（尤其：内核用 `unsupported_function`，
 *    不是 `unknown_function`——这条差异被显式盯住）。
 * 2. **没有报告 ⇒ 结构化 no_report**：空白源（一个单元格都没有）返回 `report_state: "no_report"`
 *    且 `cells` 为 **`null`**——**不是 `[]`**（空数组会被读成"逐格全过"）。
 * 3. **反向对照**：环报 `circular_reference` **且给出环成员键**；白名单外函数报
 *    `unsupported_function`；**真零**（`J2 = 0`）**不得**被判为阻塞。三条都在报告里逐条点名。
 * 4. **真产品 HTTP**：经 `createDemoServer()` 起**真**服务，走**真**交付链
 *    （`POST /api/deliverables` → `POST /api/deliverables/:id/edits`），再打
 *    `/api/xls-formula/sessions/:id/versions/:rev/report`，状态码逐个写进断言；
 *    会话 / 版本不存在 ⇒ 404。
 *
 * ## 真实 HTTP 与边界
 *
 * 本套件不跑全量、不跑 Gradle、不跑 live 模型；仓外 `node main.js` + `curl` 冒烟记录见交付说明
 * （**不用** 8765，不打扰其它运行实例）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSheet,
  createWorkbook,
  getSheet,
  setCellValue,
  writeWorkbookXlsx,
  type CellValue,
  type SheetState,
  type WorkbookState,
} from '../../../src/spreadsheets/index.js';
import { createDemoServer, type DemoServer } from './main.js';
import { XLS_FACTS_ROOT } from './xls-facts-product.js';
import {
  FORMULA_REPORT_CONCLUSIONS,
  NO_REPORT_REASON,
  UNWIRED_REASON,
  XLS_FORMULA_REPORT_MODULES_REACHABLE_BY_ROUTE,
  XLS_FORMULA_REPORT_ROOT,
  buildFormulaReport,
  createXlsFormulaReportHost,
  handleXlsFormulaReportRequest,
  isXlsFormulaReportPath,
  routeXlsFormulaReportRequest,
  type DeliveredVersionBytes,
  type FormulaReport,
  type FormulaReportCell,
  type XlsFormulaReportHost,
  type XlsFormulaReportSource,
  type XlsFormulaWireResponse,
} from './xls-formula-report.js';

// ---------------------------------------------------------------------------
// 形状小工具
// ---------------------------------------------------------------------------

const num = (value: number): CellValue => ({ kind: 'number', value });
const frm = (text: string): CellValue => ({ kind: 'formula', text });

/** 建一份单表工作簿（`cells` 为 `ref → 取值`）。 */
function workbookOf(cells: Readonly<Record<string, CellValue>>, sheetName = 'S'): WorkbookState {
  let sheet: SheetState = createSheet(sheetName);
  for (const [ref, value] of Object.entries(cells)) {
    sheet = setCellValue(sheet, ref, value);
  }
  return createWorkbook([sheet]);
}

/** 在报告里按 `ref` 找一个格子的结论（找不到直接失败，避免"没断言到"。）。 */
function cellOf(report: FormulaReport, ref: string): FormulaReportCell {
  const cells = report.cells;
  expect(cells).not.toBeNull();
  const found = (cells as readonly FormulaReportCell[]).find((cell) => cell.ref === ref);
  if (found === undefined) throw new Error(`报告里没有 ${ref}`);
  return found;
}

function okBody(response: XlsFormulaWireResponse | null): Record<string, unknown> {
  expect(response).not.toBeNull();
  return (response as XlsFormulaWireResponse).body as Record<string, unknown>;
}

async function call(
  host: XlsFormulaReportHost,
  method: string,
  path: string,
): Promise<XlsFormulaWireResponse | null> {
  return routeXlsFormulaReportRequest({ method, pathname: path, body: null }, host);
}

/** 一个"交付链接口"的替身：直接从一份工作簿导出真实字节（与产品同一份导出函数）。 */
function fakeSource(workbooks: Readonly<Record<string, WorkbookState>>): XlsFormulaReportSource {
  return {
    hasSession: (sessionId) => Object.hasOwn(workbooks, sessionId),
    readVersion: async (sessionId, revision): Promise<DeliveredVersionBytes | undefined> => {
      const workbook = workbooks[sessionId];
      if (workbook === undefined) return undefined;
      if (revision !== 1) return undefined;
      const written = writeWorkbookXlsx(workbook);
      return {
        bytes: written.bytes,
        file_format: 'xlsx',
        content_digest: written.content_digest,
        filename: `${sessionId}.xlsx`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// A. 纯函数：逐格结论 + 原因原样透出 + 三种 conclusion
// ---------------------------------------------------------------------------

describe('A. buildFormulaReport：逐格结论与原因原样透出', () => {
  it('ok / blocked（带内核原因）/ not_a_formula 三值齐全；真零 J2=0 不算阻塞', () => {
    const report = buildFormulaReport(
      workbookOf({
        A1: num(1), // 非公式格 → not_a_formula
        J2: num(0), // **真零**：必须 not_a_formula，且不进 blocked
        A2: frm('A1+1'), // 正常求值 → ok
        B1: frm('A1+C1'), // 环
        C1: frm('B1'), // 环
        D1: frm('FOOBAR(1)'), // 白名单外函数
        F1: frm('SUM(F2:F3)'), // 空白区域求和 → empty_aggregate（R248）
        H1: frm('1+'), // 语法超出子集 → parse_error
      }),
    );

    expect(report.report_state).toBe('available');
    expect(report.reason).toBeNull();

    // ① 三值词汇一一落地。
    expect(cellOf(report, 'A1').conclusion).toBe('not_a_formula');
    expect(cellOf(report, 'A1').value_kind).toBe('number');
    expect(cellOf(report, 'A2').conclusion).toBe('ok');
    expect(cellOf(report, 'B1').conclusion).toBe('blocked');

    // ② 原因 = 内核字面值，原样透出（不是本层翻译过的词）。
    expect(cellOf(report, 'B1').reason).toBe('circular_reference');
    expect(cellOf(report, 'C1').reason).toBe('circular_reference');
    expect(cellOf(report, 'D1').reason).toBe('unsupported_function');
    expect(cellOf(report, 'F1').reason).toBe('empty_aggregate');
    expect(cellOf(report, 'H1').reason).toBe('parse_error');

    // ③ **不同名**：内核没有 `unknown_function` 这个字符串（brief 里那个名字是误写）。
    expect(cellOf(report, 'D1').reason).not.toBe('unknown_function');

    // ④ detail 是内核的证据句（非空），本层没有另写。
    expect((cellOf(report, 'B1').detail ?? '').length).toBeGreaterThan(0);
    expect((cellOf(report, 'F1').detail ?? '').length).toBeGreaterThan(0);

    // ⑤ 汇总：blocked 只数公式格；J2 不在里面。
    expect(report.summary).toEqual({
      total_cells: 8,
      formula_cells: 6,
      ok: 1,
      blocked: 5,
      not_a_formula: 2,
    });
    expect(report.note).toBeNull();
  });

  it('反向对照 · 环：circular_reference **且给出环成员键**（不是只给一个落点）', () => {
    const report = buildFormulaReport(workbookOf({ B1: frm('A1+C1'), C1: frm('B1'), A1: num(1) }));
    const b1 = cellOf(report, 'B1');
    const c1 = cellOf(report, 'C1');

    expect(b1.reason).toBe('circular_reference');
    // 环成员键：B1 与 C1 **都在**，两格报同一组（可核对是不是同一个环）。
    expect(b1.cycle_members).toEqual(['S!B1', 'S!C1']);
    expect(c1.cycle_members).toEqual(['S!B1', 'S!C1']);
    expect(report.cycles).toEqual([['S!B1', 'S!C1']]);

    // 环外的 ok 格不许带成员键（不硬塞空数组冒充）。
    const report2 = buildFormulaReport(workbookOf({ A1: num(2), A2: frm('A1+1') }));
    expect(cellOf(report2, 'A2').cycle_members).toBeNull();
    expect(report2.cycles).toEqual([]);
  });

  it('反向对照 · 真零：J2=0 是数据不是缺失，既 not_a_formula 也不进 blocked', () => {
    const report = buildFormulaReport(workbookOf({ J2: num(0), A1: frm('SUM(J2:J2)') }));
    const j2 = cellOf(report, 'J2');
    expect(j2.conclusion).toBe('not_a_formula');
    expect(j2.reason).toBeNull();
    expect(report.summary.blocked).toBe(0);
    // SUM(J2:J2) 里 J2 是**真零** ⇒ 有数值贡献 ⇒ ok（不是 empty_aggregate）。
    expect(cellOf(report, 'A1').conclusion).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// B. 诚实性：没有报告 ⇒ 结构化 no_report（不是空数组）
// ---------------------------------------------------------------------------

describe('B. 没有求值报告时返回结构化 no_report', () => {
  it('空白源（一个单元格都没有）⇒ report_state=no_report 且 cells 为 null（**不是 []**）', () => {
    const report = buildFormulaReport(createWorkbook([createSheet('S')]));
    expect(report.report_state).toBe('no_report');
    expect(report.cells).toBeNull();
    expect(report.reason).toBe(NO_REPORT_REASON);
    expect(report.summary).toEqual({
      total_cells: 0,
      formula_cells: 0,
      ok: 0,
      blocked: 0,
      not_a_formula: 0,
    });
    expect(report.cycles).toEqual([]);
    // 关键反例：**不是** 空数组（空数组会被读成"逐格全过"）。
    expect(report.cells as unknown).not.toEqual([]);
  });

  it('有格但一个公式都没有 ⇒ available，但 note 明说"0 个阻塞 ≠ 全部通过"', () => {
    const report = buildFormulaReport(workbookOf({ A1: num(1), B1: frm('1') }));
    const onlyValues = buildFormulaReport(workbookOf({ A1: num(1), B1: { kind: 'text', value: 'x' } }));
    expect(report.note).toBeNull(); // 有公式 ⇒ 不需要提示
    expect(onlyValues.report_state).toBe('available');
    expect(onlyValues.summary.formula_cells).toBe(0);
    expect(onlyValues.summary.not_a_formula).toBe(2);
    expect(onlyValues.note).not.toBeNull();
    expect(onlyValues.note ?? '').toContain('不等于');
  });
});

// ---------------------------------------------------------------------------
// C. 纯路由：404 / 503 / 422 / 405 / 前缀
// ---------------------------------------------------------------------------

describe('C. 纯路由：状态码与错误形状', () => {
  const wired = () => createXlsFormulaReportHost({ source: fakeSource({ s1: workbookOf({ A1: num(1) }) }) });

  it('前缀不重叠 + 内核模块可达性自证', () => {
    expect(isXlsFormulaReportPath(XLS_FORMULA_REPORT_ROOT)).toBe(true);
    expect(isXlsFormulaReportPath(`${XLS_FORMULA_REPORT_ROOT}/status`)).toBe(true);
    expect(isXlsFormulaReportPath('/api/other')).toBe(false);
    // 与共享事实前缀**不重叠**（两条路由互不吞并）。
    expect(isXlsFormulaReportPath(XLS_FACTS_ROOT)).toBe(false);
    expect(XLS_FACTS_ROOT.startsWith(`${XLS_FORMULA_REPORT_ROOT}/`)).toBe(false);
    expect(XLS_FORMULA_REPORT_ROOT.startsWith(`${XLS_FACTS_ROOT}/`)).toBe(false);
    expect(XLS_FORMULA_REPORT_MODULES_REACHABLE_BY_ROUTE).toContain('src/spreadsheets/xlsx-write.ts');
    expect(XLS_FORMULA_REPORT_MODULES_REACHABLE_BY_ROUTE).toContain('src/spreadsheets/recalc.ts');
    expect(FORMULA_REPORT_CONCLUSIONS).toEqual(['ok', 'blocked', 'not_a_formula']);
  });

  it('status：就绪探针如实报出三条结论词汇与词表来源', async () => {
    const response = await call(wired(), 'GET', `${XLS_FORMULA_REPORT_ROOT}/status`);
    const body = okBody(response);
    expect(response?.status).toBe(200);
    expect(body['root']).toBe(XLS_FORMULA_REPORT_ROOT);
    expect(body['ready']).toBe(true);
    expect(body['version_source']).toBe('deliverable-host');
    expect(body['conclusions']).toEqual(['ok', 'blocked', 'not_a_formula']);
    expect(body['reportable_formats']).toEqual(['xlsx']);
  });

  it('未接线版本来源 ⇒ 报告端点结构化 503（不是 404）', async () => {
    const host = createXlsFormulaReportHost({});
    const missing = await call(host, 'GET', `${XLS_FORMULA_REPORT_ROOT}/sessions/s1/versions/1/report`);
    expect(missing?.status).toBe(503);
    expect(okBody(missing)['code']).toBe('formula_report_unwired');
    expect(okBody(missing)['message']).toBe(UNWIRED_REASON);

    const status = await call(host, 'GET', `${XLS_FORMULA_REPORT_ROOT}/status`);
    expect(status?.status).toBe(200);
    expect(okBody(status)['ready']).toBe(false);
  });

  it('反向对照 · 会话 / 版本不存在 ⇒ 404（两个码分得开）', async () => {
    const host = wired();
    const noSession = await call(host, 'GET', `${XLS_FORMULA_REPORT_ROOT}/sessions/nope/versions/1/report`);
    expect(noSession?.status).toBe(404);
    expect(okBody(noSession)['code']).toBe('session_not_found');

    const noVersion = await call(host, 'GET', `${XLS_FORMULA_REPORT_ROOT}/sessions/s1/versions/9/report`);
    expect(noVersion?.status).toBe(404);
    expect(okBody(noVersion)['code']).toBe('version_not_found');
  });

  it('非 xlsx 版本 ⇒ 422 not_a_spreadsheet（不假装有报告）', async () => {
    const source: XlsFormulaReportSource = {
      hasSession: () => true,
      readVersion: async () => ({
        bytes: new Uint8Array([0x50, 0x4b]),
        file_format: 'pptx',
        content_digest: 'x',
        filename: 'a.pptx',
      }),
    };
    const response = await call(
      createXlsFormulaReportHost({ source }),
      'GET',
      `${XLS_FORMULA_REPORT_ROOT}/sessions/s1/versions/1/report`,
    );
    expect(response?.status).toBe(422);
    expect(okBody(response)['code']).toBe('not_a_spreadsheet');
  });

  it('字节读不回来 ⇒ 502 unreadable_delivery（不编造报告）', async () => {
    const source: XlsFormulaReportSource = {
      hasSession: () => true,
      readVersion: async () => ({
        bytes: new Uint8Array([1, 2, 3, 4]),
        file_format: 'xlsx',
        content_digest: 'x',
        filename: 'a.xlsx',
      }),
    };
    const response = await call(
      createXlsFormulaReportHost({ source }),
      'GET',
      `${XLS_FORMULA_REPORT_ROOT}/sessions/s1/versions/1/report`,
    );
    expect(response?.status).toBe(502);
    expect(okBody(response)['code']).toBe('unreadable_delivery');
  });

  it('只读：POST /status 405；未知子路径 404；非本前缀 ⇒ null', async () => {
    const host = wired();
    expect((await call(host, 'POST', `${XLS_FORMULA_REPORT_ROOT}/status`))?.status).toBe(405);
    expect((await call(host, 'GET', `${XLS_FORMULA_REPORT_ROOT}/nope`))?.status).toBe(404);
    expect(await call(host, 'GET', '/api/other')).toBeNull();
  });

  it('node:http 适配器的布尔契约：非本前缀返回 false（不吞掉其它路由）', async () => {
    const handled = await handleXlsFormulaReportRequest(
      { req: {} as never, res: {} as never, url: new URL('http://x/other') },
      createXlsFormulaReportHost({}),
    );
    expect(handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. 真产品 HTTP：开交付会话 → 提编辑 → 打报告端点
// ---------------------------------------------------------------------------

interface Running {
  readonly baseUrl: string;
  readonly demo: DemoServer;
  close(): Promise<void>;
}

async function startProductServer(env: NodeJS.ProcessEnv): Promise<Running> {
  const demo = await createDemoServer(env);
  const server: Server = demo.server;
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    demo,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error === undefined || error === null ? resolvePromise() : reject(error)));
      }),
  };
}

interface JsonResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function getJson(baseUrl: string, path: string): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

let idempotencyCounter = 0;

/** 一个交付会话的驱动（跟踪 revision / digest，按真实客户端协议提编辑）。 */
async function openXlsxSession(baseUrl: string, sessionId: string): Promise<{
  readonly sessionId: string;
  readonly revision: () => number;
  apply(edit: unknown): Promise<void>;
  setCell(sheet: string, address: string, value: CellValue): Promise<void>;
}> {
  const opened = await postJson(baseUrl, '/api/deliverables', {
    sessionId,
    deliverableId: `${sessionId}-deliverable`,
    filename: `${sessionId}.xlsx`,
    format: 'xlsx',
  });
  expect(opened.status).toBe(201);
  let revision = Number(opened.json['editRevision']);
  let digest = String(opened.json['contentDigest']);

  const apply = async (edit: unknown): Promise<void> => {
    idempotencyCounter += 1;
    const response = await postJson(baseUrl, `/api/deliverables/${sessionId}/edits`, {
      idempotencyKey: `k${String(idempotencyCounter)}`,
      baseRevision: revision,
      baseDigest: digest,
      edit,
    });
    if (response.status !== 200) {
      throw new Error(`交付编辑被拒：HTTP ${String(response.status)} ${JSON.stringify(response.json)}`);
    }
    const version = response.json['version'] as Record<string, unknown>;
    revision = Number(version['editRevision']);
    digest = String(version['contentDigest']);
  };

  return {
    sessionId,
    revision: () => revision,
    apply,
    setCell: (sheet, address, value) => apply({ op: 'set_cell', sheet, address, value }),
  };
}

describe('D. 真产品 HTTP：/api/xls-formula/** 挂载 + 交付链版本', () => {
  let workDir: string;
  let running: Running;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-xls-report-'));
    running = await startProductServer({
      POTBOT_RUN_DIR: workDir,
      POTBOT_WEB_DIR: join(workDir, 'web'),
      POTBOT_BIND: '127.0.0.1',
      POTBOT_PORT: '0',
    });
  });

  afterAll(async () => {
    if (running !== undefined) await running.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('状态码：status 200 / 报告 200 / 未知会话 404 / 未知版本 404', async () => {
    const status = await getJson(running.baseUrl, `${XLS_FORMULA_REPORT_ROOT}/status`);
    expect(status.status).toBe(200);
    expect(status.json['ready']).toBe(true);

    const driver = await openXlsxSession(running.baseUrl, 'rpt-smoke');
    await driver.setCell('Sheet1', 'A1', num(1));
    await driver.setCell('Sheet1', 'J2', num(0));
    await driver.setCell('Sheet1', 'A2', frm('A1+1'));
    await driver.setCell('Sheet1', 'B1', frm('A1+C1'));
    await driver.setCell('Sheet1', 'C1', frm('B1'));
    await driver.setCell('Sheet1', 'D1', frm('FOOBAR(1)'));
    await driver.setCell('Sheet1', 'F1', frm('SUM(F2:F3)'));

    const report = await getJson(
      running.baseUrl,
      `${XLS_FORMULA_REPORT_ROOT}/sessions/rpt-smoke/versions/${String(driver.revision())}/report`,
    );
    expect(report.status).toBe(200);
    expect(report.json['report_state']).toBe('available');
    expect(report.json['file_format']).toBe('xlsx');

    const cells = report.json['cells'] as FormulaReportCell[];
    const byRef = new Map(cells.map((cell) => [cell.ref, cell]));

    // ① 环：circular_reference **且给出环成员键**。
    expect(byRef.get('B1')?.conclusion).toBe('blocked');
    expect(byRef.get('B1')?.reason).toBe('circular_reference');
    expect(byRef.get('B1')?.cycle_members).toEqual(['Sheet1!B1', 'Sheet1!C1']);
    expect(byRef.get('C1')?.cycle_members).toEqual(['Sheet1!B1', 'Sheet1!C1']);

    // ② 白名单外函数：内核字面值 unsupported_function。
    expect(byRef.get('D1')?.reason).toBe('unsupported_function');
    expect(byRef.get('D1')?.formula).toBe('FOOBAR(1)');

    // ③ 真零 J2=0：not_a_formula，不是 blocked。
    expect(byRef.get('J2')?.conclusion).toBe('not_a_formula');
    expect(byRef.get('J2')?.reason).toBeNull();

    // ④ 公式原文透出 + 正常求值格 ok。
    expect(byRef.get('A2')?.conclusion).toBe('ok');
    expect(byRef.get('A2')?.formula).toBe('A1+1');

    // ⑤ 汇总：blocked 只计公式格。
    expect(report.json['summary']).toEqual({
      total_cells: 7,
      formula_cells: 5,
      ok: 1,
      blocked: 4,
      not_a_formula: 2,
    });
    expect(report.json['cycles']).toEqual([['Sheet1!B1', 'Sheet1!C1']]);

    const noSession = await getJson(
      running.baseUrl,
      `${XLS_FORMULA_REPORT_ROOT}/sessions/nope/versions/1/report`,
    );
    expect(noSession.status).toBe(404);
    expect(noSession.json['code']).toBe('session_not_found');

    const noVersion = await getJson(
      running.baseUrl,
      `${XLS_FORMULA_REPORT_ROOT}/sessions/rpt-smoke/versions/9999/report`,
    );
    expect(noVersion.status).toBe(404);
    expect(noVersion.json['code']).toBe('version_not_found');
  });

  it('诚实性：空白版本 ⇒ report_state=no_report 且 cells 为 null（HTTP 上不是 []）', async () => {
    const driver = await openXlsxSession(running.baseUrl, 'rpt-empty');
    // 只加一张空表（不改任何单元格）⇒ 这一版的交付字节里一个单元格都没有。
    await driver.apply({ op: 'add_sheet', name: 'Empty2' });

    const report = await getJson(
      running.baseUrl,
      `${XLS_FORMULA_REPORT_ROOT}/sessions/rpt-empty/versions/${String(driver.revision())}/report`,
    );
    expect(report.status).toBe(200);
    expect(report.json['report_state']).toBe('no_report');
    expect(report.json['cells']).toBeNull();
    expect(report.json['cells']).not.toEqual([]);
    expect(report.json['reason']).toBe(NO_REPORT_REASON);
  });

  it('既有路径不变：/health 200；/api/xls-facts 前缀仍归它自己；未知 /api 404', async () => {
    expect((await fetch(`${running.baseUrl}/health`)).status).toBe(200);

    // 两条前缀不互相吞并：xls-facts 的 status 仍由那条路由作答。
    const factsStatus = await getJson(running.baseUrl, `${XLS_FACTS_ROOT}/status`);
    expect(factsStatus.status).toBe(200);
    expect(factsStatus.json['root']).toBe(XLS_FACTS_ROOT);

    const missing = await getJson(running.baseUrl, '/api/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('not_found');
  });
});
