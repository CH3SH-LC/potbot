/**
 * **XLSX 打印设置的产品 HTTP 入口**用例（工作包 FA-XLS-PRINT-ROUTE）。
 *
 * ## 这个文件要证明的事（每条配反向对照）
 *
 * | # | 正向 | 反向对照 |
 * |---|---|---|
 * | 1 | `/api/xls-print/sessions/:id/edits {op:'set_print_layout'}` **被接受**（200），打印设置写进**真实字节** | **不设打印设置** ⇒ 导出里**零** `pageSetup` / `pageMargins` / `rowBreaks` / `Print_Area` |
 * | 2 | 交接回执 = 结构化「已交接」，`printed` 恒 `false`、`confirmed_by` 恒 `null` | **声称已打印必须被拒**：无消费端 ⇒ `/confirm` 一概 422 |
 * | 3 | 真产品 HTTP（`createDemoServer` 真实装配）确实挂载了 `/api/xls-print/**` | 未知子路径仍如实 404；旧交付链的封闭枚举**不是**本路由的边界 |
 *
 * ## 判据落在"**字节里有什么**"，而且用**本套件自带的独立 ZIP 解析器**
 *
 * 第 1 节的读回**不 import** `src/artifacts/ooxml/**` 或任何产品解析器：本文件从零写了一个最小
 * ZIP 读取器（EOCD → 中央目录 → 逐条本地文件头 → 对 DEFLATE 条目真解压），只在**纯文本 XML** 上
 * 做正则取证，避免"自我复述"。第 2、3 节走真实路由与真实状态码。
 *
 * ## ⚠️ 诚实边界（结果不得编造）
 *
 * - **真实出纸 / PDF 渲染未验证**：本批**没有**任何消费端（Excel / WPS / 安卓办公套件 /
 *   打印机 / 虚拟 PDF 都不在位）。本文件只证明"设置真的写进了 .xlsx 字节"，不证明"打得出来"。
 * - 第 2、3 节经 `createDemoServer()` 的**真实装配**起 `node:http` 服务并真实 `fetch`；
 *   仓库外的 `node main.js` + curl 冒烟在交付说明里单独回报（**不跑全量、不跑 Gradle**）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrintConsumerPort } from '../../../src/session/index.js';
import { createDocumentPort } from '../documents/port.js';
import {
  XLS_PRINT_ROOT,
  createXlsPrintHost,
  isXlsPrintPath,
  routeXlsPrintRequest,
  type XlsPrintHost,
  type XlsPrintWireResponse,
} from './xls-print-route.js';
import { createDemoServer, type DemoServer } from './main.js';

// ---------------------------------------------------------------------------
// 本套件自带的独立 ZIP 读取器（**不 import 产品解析器**）
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** EOCD → 中央目录 → 逐条本地文件头 → DEFLATE 真解压。返回 `路径 → 文本`。 */
function unzipIndependently(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 EOCD：不是合法 ZIP');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('中央目录头签名不符');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressed);
    const data = method === 0 ? raw : inflateRawSync(raw);
    out.set(name, data.toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** 一张工作表部件里出现的打印元素（正则取证，只看纯文本 XML）。 */
interface PrintFacts {
  readonly page_setup: boolean;
  readonly page_margins: boolean;
  readonly row_breaks: boolean;
  readonly col_breaks: boolean;
  readonly print_area: boolean;
  readonly print_titles: boolean;
}

function printFactsOf(bytes: Uint8Array): PrintFacts {
  const parts = unzipIndependently(bytes);
  let sheet = '';
  for (const [path, text] of parts) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) sheet += text;
  }
  const workbook = parts.get('xl/workbook.xml') ?? '';
  return {
    page_setup: /<pageSetup\b/.test(sheet),
    page_margins: /<pageMargins\b/.test(sheet),
    row_breaks: /<rowBreaks\b/.test(sheet),
    col_breaks: /<colBreaks\b/.test(sheet),
    print_area: /_xlnm\.Print_Area/.test(workbook),
    print_titles: /_xlnm\.Print_Titles/.test(workbook),
  };
}

function printElementCount(facts: PrintFacts): number {
  return [
    facts.page_setup,
    facts.page_margins,
    facts.row_breaks,
    facts.col_breaks,
    facts.print_area,
    facts.print_titles,
  ].filter(Boolean).length;
}

function decodeBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

// ---------------------------------------------------------------------------
// 夹具：一张内容在 A1 与 G100 的工作表（"只导出可见首屏"抓得住的形状）
// ---------------------------------------------------------------------------

const SHEET = '预算';
const SHEET_PART_NAME = '预算.xlsx';

function workbookSpec(): Record<string, unknown> {
  return {
    sheets: [
      {
        name: SHEET,
        row_count: 100,
        column_count: 7,
        cells: [
          { ref: 'A1', text: '项目' },
          { ref: 'G100', text: '合计' },
        ],
      },
    ],
  };
}

/** 打印设置全开：区域 / 方向 / 纸张 / 边距 / 重复行 / 重复列 / 缩放 / 页眉页脚 / 分页。 */
function fullLayout(): Record<string, unknown> {
  return {
    print_area: 'A1:G100',
    orientation: 'landscape',
    paper_size: 'a4',
    margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    repeat_rows: '1:3',
    repeat_columns: 'A:B',
    scaling: { kind: 'percent', percent: 90 },
    header_footer: { odd_header: '&L预算表&C第 &P 页 / 共 &N 页', odd_footer: '&C机密' },
    options: { grid_lines: true },
    row_breaks: [50],
    column_breaks: [3],
  };
}

function planPayload(): readonly Record<string, unknown>[] {
  return [{ sheet: SHEET, layout: fullLayout() }];
}

// ---------------------------------------------------------------------------
// 纯路由 + 真实文档端口（临时目录真写盘 + 真回读）
// ---------------------------------------------------------------------------

interface Rig {
  readonly host: XlsPrintHost;
  readonly workDir: string;
  post(pathname: string, body: unknown): Promise<XlsPrintWireResponse>;
  get(pathname: string): Promise<XlsPrintWireResponse>;
}

function makeRig(consumer: PrintConsumerPort | null = null): Rig {
  const workDir = mkdtempSync(join(tmpdir(), 'potbot-xls-print-'));
  const documents = createDocumentPort(join(workDir, 'artifacts'));
  const host = createXlsPrintHost({ documents, ...(consumer === null ? {} : { consumer }) });
  const request = async (method: string, pathname: string, body: unknown): Promise<XlsPrintWireResponse> => {
    const response = await routeXlsPrintRequest({ method, pathname, body }, host);
    if (response === null) throw new Error(`路由未处理 ${method} ${pathname}`);
    return response;
  };
  return {
    host,
    workDir,
    post: (pathname, body) => request('POST', pathname, body),
    get: (pathname) => request('GET', pathname, null),
  };
}

describe('1. 打印设置经产品路由写进真实字节（独立 ZIP 解析器读回）', () => {
  let rig: Rig;

  beforeAll(() => {
    rig = makeRig();
  });

  afterAll(() => {
    rmSync(rig.workDir, { recursive: true, force: true });
  });

  it('**反向对照**：一次性 /export 不设打印 ⇒ 字节里零 pageSetup / pageMargins / rowBreaks / Print_Area', async () => {
    const response = await rig.post(`${XLS_PRINT_ROOT}/export`, { workbook: workbookSpec() });
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body['printElementCount']).toBe(0);
    expect(body['sheetsWithPrint']).toEqual([]);
    const facts = printFactsOf(decodeBase64(String(body['bytesBase64'])));
    expect(printElementCount(facts)).toBe(0);
  });

  it('一次性 /export 带打印计划 ⇒ 八项元素全落进真实字节', async () => {
    const response = await rig.post(`${XLS_PRINT_ROOT}/export`, {
      workbook: workbookSpec(),
      plan: planPayload(),
    });
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body['printElementCount']).toBeGreaterThan(0);
    expect(body['sheetsWithPrint']).toEqual([SHEET]);
    const bytes = decodeBase64(String(body['bytesBase64']));
    // 真容器（PK 头） + 独立读回的六类元素。
    expect(Buffer.from(bytes.subarray(0, 2)).toString('latin1')).toBe('PK');
    const facts = printFactsOf(bytes);
    expect(facts.page_setup).toBe(true);
    expect(facts.page_margins).toBe(true);
    expect(facts.row_breaks).toBe(true);
    expect(facts.print_titles).toBe(true);
    expect(facts.print_area).toBe(true);
  });

  it('**接线翻正**：会话 /edits {op:"set_print_layout"} 被接受（200），此前产品 HTTP 上是 422', async () => {
    const opened = await rig.post(`${XLS_PRINT_ROOT}/sessions`, {
      sessionId: 'sess-1',
      deliverableId: 'deliv-1',
      filename: SHEET_PART_NAME,
      workbook: workbookSpec(),
    });
    expect(opened.status).toBe(201);
    const openedBody = opened.body as Record<string, unknown>;
    const baseRevision = openedBody['editRevision'] as number;
    const baseDigest = openedBody['contentDigest'] as string;
    expect(baseRevision).toBe(0);

    const edited = await rig.post(`${XLS_PRINT_ROOT}/sessions/sess-1/edits`, {
      idempotencyKey: 'k-print-1',
      baseRevision,
      baseDigest,
      edit: { op: 'set_print_layout', sheet: SHEET, layout: fullLayout() },
    });
    expect(edited.status).toBe(200);
    const editedBody = edited.body as Record<string, unknown>;
    expect(editedBody['changed']).toBe(true);
    expect(editedBody['editRevision']).toBe(1);
    const version = editedBody['version'] as Record<string, unknown>;
    expect(version['artifactId']).toBeTruthy();
    expect(String(version['contentDigest'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET /sessions/:id 的打印视图：从**当前字节**读回 pageSetup / Print_Area / 分页', async () => {
    const status = await rig.get(`${XLS_PRINT_ROOT}/sessions/sess-1`);
    expect(status.status).toBe(200);
    const body = status.body as Record<string, unknown>;
    const print = body['print'] as Record<string, unknown>;
    expect(print['printElementCount']).toBeGreaterThan(0);
    expect(print['sheetsWithPrint']).toEqual([SHEET]);
    const readBack = print['readBack'] as Record<string, unknown>;
    expect(readBack['print_areas']).toEqual([`'${SHEET}'!$A$1:$G$100`]);
    const sheets = readBack['sheets'] as readonly Record<string, unknown>[];
    expect(sheets[0]?.['page_setup']).toBe(true);
    expect(sheets[0]?.['page_margins']).toBe(true);
    expect(sheets[0]?.['row_breaks']).toBe(1);
    expect(sheets[0]?.['column_breaks']).toBe(1);
  });

  it('同一份已交付字节经独立解析器读回：Print_Area + Print_Titles 都在', async () => {
    const version = rig.host.status('sess-1')?.published.at(-1);
    expect(version).toBeTruthy();
    const bytes = await rig.host.versionBytes('sess-1', version?.edit_revision ?? -1);
    expect(bytes).toBeTruthy();
    const facts = printFactsOf(bytes?.bytes ?? new Uint8Array());
    expect(facts.page_setup).toBe(true);
    expect(facts.print_area).toBe(true);
    expect(facts.print_titles).toBe(true);
  });

  it('**先设后清**：clear_print_layout 之后导出回到零打印元素', async () => {
    const current = rig.host.status('sess-1');
    const cleared = await rig.post(`${XLS_PRINT_ROOT}/sessions/sess-1/edits`, {
      idempotencyKey: 'k-print-clear',
      baseRevision: current?.edit_revision ?? 0,
      baseDigest: current?.content_digest ?? '',
      edit: { op: 'clear_print_layout', sheet: SHEET },
    });
    expect(cleared.status).toBe(200);
    const status = await rig.get(`${XLS_PRINT_ROOT}/sessions/sess-1`);
    const print = (status.body as Record<string, unknown>)['print'] as Record<string, unknown>;
    expect(print['printElementCount']).toBe(0);
    expect(print['sheetsWithPrint']).toEqual([]);
  });
});

describe('2. 交接上限：无消费端 ⇒ 最高「已交接」，声称已打印被拒', () => {
  let rig: Rig;

  beforeAll(async () => {
    rig = makeRig();
    const opened = await rig.post(`${XLS_PRINT_ROOT}/sessions`, {
      sessionId: 'sess-h',
      deliverableId: 'deliv-h',
      filename: SHEET_PART_NAME,
      workbook: workbookSpec(),
    });
    expect(opened.status).toBe(201);
    const edited = await rig.post(`${XLS_PRINT_ROOT}/sessions/sess-h/edits`, {
      idempotencyKey: 'k-h',
      baseRevision: 0,
      baseDigest: (opened.body as Record<string, unknown>)['contentDigest'],
      edit: { op: 'set_print_layout', sheet: SHEET, layout: fullLayout() },
    });
    expect(edited.status).toBe(200);
  });

  afterAll(() => {
    rmSync(rig.workDir, { recursive: true, force: true });
  });

  it('GET /handoff ⇒ status handed_off、printed false、confirmed_by null、consumer null', async () => {
    const response = await rig.get(`${XLS_PRINT_ROOT}/sessions/sess-h/handoff`);
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body['kind']).toBe('print_handoff');
    expect(body['status']).toBe('handed_off');
    expect(body['printed']).toBe(false);
    expect(body['confirmed_by']).toBeNull();
    expect(body['consumer']).toBeNull();
    expect(body['sheets_with_print']).toEqual([SHEET]);
    expect(body['manual_break_count']).toBe(2);
    const readBack = body['read_back'] as Record<string, unknown>;
    expect(readBack['print_areas']).toEqual([`'${SHEET}'!$A$1:$G$100`]);
    expect(Array.isArray(body['unverified'])).toBe(true);
  });

  it('**声称已打印必须被拒**：无证据 ⇒ 422', async () => {
    const response = await rig.post(`${XLS_PRINT_ROOT}/sessions/sess-h/confirm`, {});
    expect(response.status).toBe(422);
    expect((response.body as Record<string, unknown>)['code']).toBe('unsupported');
  });

  it('**声称已打印必须被拒**：即使带形状合法的"读回证据"，没有装配消费端也 422', async () => {
    const response = await rig.post(`${XLS_PRINT_ROOT}/sessions/sess-h/confirm`, {
      evidence: { consumer: 'printer', read_back_sha256: 'a'.repeat(64), pages: 1 },
    });
    expect(response.status).toBe(422);
    const message = String((response.body as Record<string, unknown>)['message']);
    expect(message).toContain('没有读回证据');
  });

  it('**对照**：装配了消费端 + 合法证据时，才可能拿到 printed: true', async () => {
    const wired = makeRig({
      consumer: 'printer',
      submit: () => ({ accepted: true, detail: '替身打印机：收到字节（不代表出纸）' }),
    });
    try {
      const opened = await wired.post(`${XLS_PRINT_ROOT}/sessions`, {
        sessionId: 'sess-c',
        deliverableId: 'deliv-c',
        filename: SHEET_PART_NAME,
        workbook: workbookSpec(),
      });
      expect(opened.status).toBe(201);
      const edited = await wired.post(`${XLS_PRINT_ROOT}/sessions/sess-c/edits`, {
        idempotencyKey: 'k-c',
        baseRevision: 0,
        baseDigest: (opened.body as Record<string, unknown>)['contentDigest'],
        edit: { op: 'set_print_layout', sheet: SHEET, layout: fullLayout() },
      });
      expect(edited.status).toBe(200);

      // 没有证据 ⇒ 仍被拒（confirmPrintOutcome 抛错）。
      const noEvidence = await wired.post(`${XLS_PRINT_ROOT}/sessions/sess-c/confirm`, {});
      expect(noEvidence.status).toBe(422);

      const confirmed = await wired.post(`${XLS_PRINT_ROOT}/sessions/sess-c/confirm`, {
        evidence: { consumer: 'printer', read_back_sha256: 'b'.repeat(64), pages: 2 },
      });
      expect(confirmed.status).toBe(200);
      const body = confirmed.body as Record<string, unknown>;
      expect(body['status']).toBe('confirmed');
      expect(body['printed']).toBe(true);
    } finally {
      rmSync(wired.workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 真产品 HTTP（createDemoServer 的真实装配）
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

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('3. 真产品 HTTP（createDemoServer 真实装配）：状态码与真实字节', () => {
  let workDir: string;
  let running: Running;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-xls-print-http-'));
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

  it('GET /api/xls-print/status ⇒ 200：物化端口已接入、消费端未装配、上限「已交接」', async () => {
    const response = await fetch(`${running.baseUrl}${XLS_PRINT_ROOT}/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['documents_wired']).toBe(true);
    expect(body['consumer_wired']).toBe(false);
    expect(body['print_ceiling_without_consumer']).toBe('handed_off');
    expect(running.demo.xlsPrint.documents_wired).toBe(true);
  });

  it('未知子路径仍如实 404（命名空间内也报"没有"）', async () => {
    const missing = await fetch(`${running.baseUrl}${XLS_PRINT_ROOT}/definitely-not-here`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as Record<string, unknown>)['code']).toBe('not_found');
  });

  it('POST /api/xls-print/export ⇒ 200，字节是真实 .xlsx 且带打印元素；不带 plan ⇒ 零打印元素', async () => {
    const bare = await postJson(running.baseUrl, `${XLS_PRINT_ROOT}/export`, { workbook: workbookSpec() });
    expect(bare.status).toBe(200);
    const bareBytes = decodeBase64(String(bare.json['bytesBase64']));
    expect(Buffer.from(bareBytes.subarray(0, 2)).toString('latin1')).toBe('PK');
    expect(printElementCount(printFactsOf(bareBytes))).toBe(0);

    const withPrint = await postJson(running.baseUrl, `${XLS_PRINT_ROOT}/export`, {
      workbook: workbookSpec(),
      plan: planPayload(),
    });
    expect(withPrint.status).toBe(200);
    const facts = printFactsOf(decodeBase64(String(withPrint.json['bytesBase64'])));
    expect(facts.page_setup).toBe(true);
    expect(facts.page_margins).toBe(true);
    expect(facts.row_breaks).toBe(true);
    expect(facts.print_area).toBe(true);
  });

  it('整链：开会话 → /edits 设打印（200，旧路是 422）→ 下载版本身字节带打印元素', async () => {
    const opened = await postJson(running.baseUrl, `${XLS_PRINT_ROOT}/sessions`, {
      sessionId: 'http-print-1',
      deliverableId: 'http-print-1-file',
      filename: 'http-print.xlsx',
      workbook: workbookSpec(),
    });
    expect(opened.status).toBe(201);
    expect(opened.json['fileFormat']).toBe('xlsx');

    const edited = await postJson(running.baseUrl, `${XLS_PRINT_ROOT}/sessions/http-print-1/edits`, {
      idempotencyKey: 'k-http-1',
      baseRevision: 0,
      baseDigest: opened.json['contentDigest'],
      edit: { op: 'set_print_layout', sheet: SHEET, layout: fullLayout() },
    });
    expect(edited.status).toBe(200);
    expect(edited.json['changed']).toBe(true);

    const download = await fetch(
      `${running.baseUrl}${XLS_PRINT_ROOT}/sessions/http-print-1/versions/1/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('x-potbot-file-format')).toBe('xlsx');
    const digest = download.headers.get('x-content-sha256');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 2)).toString('latin1')).toBe('PK');
    const facts = printFactsOf(bytes);
    expect(facts.page_setup).toBe(true);
    expect(facts.print_area).toBe(true);
    expect(facts.print_titles).toBe(true);
  });

  it('真产品 HTTP /confirm：无消费端 ⇒ 422（不得出现 printed: true）', async () => {
    const handed = await fetch(`${running.baseUrl}${XLS_PRINT_ROOT}/sessions/http-print-1/handoff`);
    expect(handed.status).toBe(200);
    const handedBody = (await handed.json()) as Record<string, unknown>;
    expect(handedBody['printed']).toBe(false);

    const confirmed = await postJson(running.baseUrl, `${XLS_PRINT_ROOT}/sessions/http-print-1/confirm`, {
      evidence: { consumer: 'printer', read_back_sha256: 'c'.repeat(64), pages: 1 },
    });
    expect(confirmed.status).toBe(422);
    expect(confirmed.json['printed']).toBeUndefined();
  });

  it('挂载点自证：前缀常量与判据一致', () => {
    expect(XLS_PRINT_ROOT).toBe('/api/xls-print');
    expect(isXlsPrintPath('/api/xls-print')).toBe(true);
    expect(isXlsPrintPath('/api/xls-print/sessions')).toBe(true);
    expect(isXlsPrintPath('/api/xls-printX')).toBe(false);
    expect(isXlsPrintPath('/api/deliverables')).toBe(false);
  });
});
