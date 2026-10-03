/**
 * **打印 / PDF 交接**的产品端到端用例（工作包 FA-PROD-DEPTH-C）。
 *
 * ## 这个文件要证明的四件事（每条都配反向对照）
 *
 * | # | 正向 | 反向对照 |
 * |---|---|---|
 * | 1 | 打印设置（区域 / 方向 / 纸张 / 边距 / 重复标题 / 分页 / 页眉页脚 / 缩放）**写进真实 .xlsx 字节** | **不设打印设置时，一个打印元素都没有**（"只导出可见首屏"必须被检出为缺件） |
 * | 2 | 导出 PDF 的**同时**保住可编辑 PPTX（读回不变式真跑），页数一致 | 带图表源 ⇒ 出字节前结构化阻断，响应里**没有** editable_pptx |
 * | 3 | 交接结论 = 结构化「已交接」，`printed` 恒 `false`、`confirmed_by` 恒 `null` | **声称「已打印」必须被拒**（无消费端读回证据 ⇒ 显式抛错） |
 * | 4 | 真产品 HTTP（`createDemoServer` 的真实装配）确实挂载这些链 | `/api/**` 兜底 404 不被吞掉；产品侧没有的通道**如实报"没有"**，不假装有 |
 *
 * ## 判据一律落在"**字节里有什么**"，而且用**本套件自带的独立 ZIP 解析器**
 *
 * 与本仓既有单测（`src/session/adapters/xlsx-print.test.ts`）不同：那一份用**仓内的**
 * `readZip` / `parseXml` 读回（自产自检）。本文件从零写了一个最小 ZIP 读取器
 * （EOCD → 中央目录 → 逐条本地文件头 → 对 DEFLATE 条目真解压），并只在**纯文本 XML** 上
 * 做正则取证——**不 import** `src/artifacts/ooxml/**` 或任何产品解析器，避免"自我复述"。
 *
 * ## ⚠️ 诚实边界（结果不得编造；逐条标明这条链走到了哪一层）
 *
 * - **【产品 HTTP】** 第 2、4 节经 `createDemoServer()` 的**真实装配**起 `node:http` 服务：
 *   `/health`、`/api/ppt-facts/**`（PPTX 交付 + PDF）、`/api/xls-facts/**`（.xlsx 交付）、
 *   `/api/deliverables/**`（交付会话）都走真实路由与真实状态码。
 * - **【本仓 / 产品适配器 seam，不是 HTTP 路由】** 第 1、3 节的 XLSX 打印设置：**本基线
 *   `/api/**` 上没有任何一条路由暴露"打印设置"**（详见第 4 节实测状态码）。因此这里驱动的是
 *   `deliverable-host.ts`（文件头自称"design-06 P8/P9 的**产品入口**"）所用的**同一个交付会话
 *   seam** —— `DeliverableSession` + `xlsxPrintDeliverableAdapter`（XLS-16 的产品适配器）。
 *   这条链的**记录前提**是"打印适配器被挂进那个 adapter 槽"，而当前 HTTP 装配给它的是
 *   `xlsxDeliverableAdapter`（无打印能力）。这是**如实暴露的接线缺口**，不是本文件能改的事
 *   （工作包写权只允许新增本文件）。
 * - **【仍需真机 / 消费端】** 真实 Excel / WPS / 安卓办公套件打开后是否按这些设置分页、
 *   真实打印机或虚拟 PDF 是否出纸、出几页、页眉页脚格式码如何呈现 —— 本轮**没有消费端**，
 *   一律标未验证（随结果原样带出 `unverified` 清单）。
 *
 * ## 真服务冒烟
 *
 * 本文件在 `beforeAll` 里起**真** HTTP 服务并真实 `fetch`，状态码写进断言；另有仓库外的
 * `node main.js` 冒烟（curl）在交付说明里单独回报。**不跑全量、不跑 Gradle**。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError } from '../../../src/protocol/index.js';
import {
  EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
  EXPORT_INVARIANTS,
  PRESENTATION_HANDOFF_SEMANTICS,
  completionBlocked,
  handoffPresentation,
  type PresentationHandoffPort,
} from '../../../src/presentations/export-handoff.js';
import {
  DeliverableSession,
  PRINT_CEILING_WITHOUT_CONSUMER,
  PRINT_UNVERIFIED,
  confirmPrintOutcome,
  createPrintSource,
  digestBytes,
  handoffToPrint,
  xlsxDeliverableAdapter,
  xlsxPrintDeliverableAdapter,
  type DeliverablePublishPort,
  type DeliverablePublishRequest,
  type DeliverablePublishResult,
  type DeliverableSessionState,
  type PrintConsumerPort,
  type PrintHandoffReceipt,
  type SessionPersistence,
  type XlsxPrintSource,
} from '../../../src/session/index.js';
import {
  DEFAULT_MARGINS,
  createPrintLayout,
  createPrintPlan,
  createSheet,
  createWorkbook,
  setCellValue,
  setSheetPrint,
  textValue,
  type PrintLayout,
  type WorkbookState,
} from '../../../src/spreadsheets/index.js';
import { PPT_FACTS_ROOT } from './ppt-facts-product.js';
import { XLS_FACTS_ROOT } from './xls-facts-product.js';
import { createDemoServer, type DemoServer } from './main.js';

// ---------------------------------------------------------------------------
// 独立 ZIP 解析器（**不复用**产品解析器；本套件自带）
// ---------------------------------------------------------------------------

interface ZipMember {
  readonly path: string;
  readonly data: Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * 一个**独立实现**的 ZIP 读取器：只依赖 `node:zlib`（DEFLATE）与本地文件头 / 中央目录的
 * 字节布局，**不 import** `src/artifacts/ooxml/**` 或任何产品解析器。
 */
function unzipIndependently(bytes: Uint8Array): readonly ZipMember[] {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('独立解析器：找不到 ZIP 的 EOCD 记录');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  const members: ZipMember[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`独立解析器：第 ${String(index)} 条中央目录项签名不符`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`独立解析器：条目 ${path} 的本地文件头签名不符`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    members.push({ path, data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

function memberPaths(bytes: Uint8Array): readonly string[] {
  return unzipIndependently(bytes).map((member) => member.path);
}

function memberText(bytes: Uint8Array, path: string): string {
  const member = unzipIndependently(bytes).find((item) => item.path === path);
  if (member === undefined) throw new Error(`独立解析器：包里没有部件 ${path}`);
  return member.data.toString('utf8');
}

// ---------------------------------------------------------------------------
// 纯文本 XML 取证（正则；只看"字节里到底有没有那个元素"）
// ---------------------------------------------------------------------------

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attributesOf(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) out[key] = unescapeXml(value);
  }
  return Object.freeze(out);
}

/** 一张工作表 XML 里的打印取证结果（"有 / 没有"与属性逐项）。 */
interface SheetPrintFacts {
  readonly has_page_setup: boolean;
  readonly page_setup: Readonly<Record<string, string>>;
  readonly has_page_margins: boolean;
  readonly page_margins: Readonly<Record<string, string>>;
  readonly has_print_options: boolean;
  readonly print_options: Readonly<Record<string, string>>;
  readonly has_header_footer: boolean;
  readonly header_footer_text: string;
  readonly has_fit_to_page: boolean;
  readonly row_breaks: readonly Readonly<Record<string, string>>[];
  readonly column_breaks: readonly Readonly<Record<string, string>>[];
  readonly has_sheet_data: boolean;
}

function firstSelfClosing(xml: string, tag: string): Readonly<Record<string, string>> | null {
  const pattern = new RegExp(`<${tag}\\b([^>]*?)/?>`, '');
  const match = pattern.exec(xml);
  return match === null ? null : attributesOf(match[1] ?? '');
}

function innerOf(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, '');
  const match = pattern.exec(xml);
  return match === null ? null : (match[1] ?? null);
}

/** 逐项扫一张工作表 XML（`xl/worksheets/sheetN.xml`）。 */
function scanSheetPrint(xml: string): SheetPrintFacts {
  const breaksIn = (tag: string): readonly Readonly<Record<string, string>>[] => {
    const inner = innerOf(xml, tag);
    if (inner === null) return Object.freeze([]);
    const out: Readonly<Record<string, string>>[] = [];
    const pattern = /<brk\b([^>]*?)\/?>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(inner)) !== null) out.push(attributesOf(match[1] ?? ''));
    return Object.freeze(out);
  };
  const headerFooterInner = innerOf(xml, 'headerFooter');
  return Object.freeze({
    has_page_setup: /<pageSetup\b/.test(xml),
    page_setup: firstSelfClosing(xml, 'pageSetup') ?? Object.freeze({}),
    has_page_margins: /<pageMargins\b/.test(xml),
    page_margins: firstSelfClosing(xml, 'pageMargins') ?? Object.freeze({}),
    has_print_options: /<printOptions\b/.test(xml),
    print_options: firstSelfClosing(xml, 'printOptions') ?? Object.freeze({}),
    has_header_footer: headerFooterInner !== null,
    header_footer_text: unescapeXml(headerFooterInner ?? ''),
    has_fit_to_page: /<pageSetUpPr\b[^>]*fitToPage="1"/.test(xml),
    row_breaks: breaksIn('rowBreaks'),
    column_breaks: breaksIn('colBreaks'),
    has_sheet_data: /<sheetData\b/.test(xml),
  });
}

interface DefinedNameEntry {
  readonly name: string;
  readonly local_sheet_id: string;
  readonly text: string;
}

/** 读回 `xl/workbook.xml` 的 `definedNames`（打印区域 / 重复标题就落在这里）。 */
function definedNames(workbookXml: string): readonly DefinedNameEntry[] {
  const block = innerOf(workbookXml, 'definedNames');
  if (block === null) return Object.freeze([]);
  const out: DefinedNameEntry[] = [];
  const pattern = /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block)) !== null) {
    const attrs = attributesOf(match[1] ?? '');
    out.push(
      Object.freeze({
        name: attrs['name'] ?? '',
        local_sheet_id: attrs['localSheetId'] ?? '',
        text: unescapeXml(match[2] ?? ''),
      }),
    );
  }
  return Object.freeze(out);
}

/** 打印元素的"零/非零"总开关（反向对照的判据就落在它上面）。 */
function printElementCount(bytes: Uint8Array): number {
  let total = 0;
  for (const path of memberPaths(bytes)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue;
    const facts = scanSheetPrint(memberText(bytes, path));
    total +=
      (facts.has_page_setup ? 1 : 0) +
      (facts.has_page_margins ? 1 : 0) +
      (facts.has_print_options ? 1 : 0) +
      (facts.has_header_footer ? 1 : 0) +
      (facts.has_fit_to_page ? 1 : 0) +
      facts.row_breaks.length +
      facts.column_breaks.length;
  }
  if (/^xl\/workbook\.xml$/.test('xl/workbook.xml')) {
    total += definedNames(memberText(bytes, 'xl/workbook.xml')).length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// XLSX 打印夹具（内容在 A1 与 G100 —— "只导出可见首屏"抓得住的形状）
// ---------------------------------------------------------------------------

const SHEET_NAME = '预算';
const SHEET_PART = 'xl/worksheets/sheet1.xml';
const WORKBOOK_PART = 'xl/workbook.xml';

function budgetWorkbook(): WorkbookState {
  let sheet = createSheet(SHEET_NAME, { row_count: 100, column_count: 7 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'G100', textValue('合计'));
  return createWorkbook([sheet]);
}

/** 打印设置全开：区域 / 方向 / 纸张 / 边距 / 重复行 / 重复列 / 缩放 / 页眉页脚 / 分页。 */
function fullLayoutInput(): Record<string, unknown> {
  return {
    print_area: 'A1:G100',
    orientation: 'landscape',
    paper_size: 'a4',
    margins: { ...DEFAULT_MARGINS },
    repeat_rows: '1:3',
    repeat_columns: 'A:B',
    scaling: { kind: 'percent', percent: 90 },
    header_footer: { odd_header: '&L预算表&C第 &P 页 / 共 &N 页', odd_footer: '&C机密' },
    options: { grid_lines: true },
    row_breaks: [50],
    column_breaks: [3],
  };
}

function fullLayout(): PrintLayout {
  return createPrintLayout(fullLayoutInput());
}

function fullPrintSource(): XlsxPrintSource {
  return createPrintSource(budgetWorkbook(), undefined, setSheetPrint(createPrintPlan(), SHEET_NAME, fullLayout()));
}

// ---------------------------------------------------------------------------
// 交付会话 seam 的替身端口（内存落盘 + 真回读；不碰 node:fs）
// ---------------------------------------------------------------------------

/** 内存发布端口：写进 Map、**从落点回读**算摘要（I-1 的"回读摘要"不是我们自报的）。 */
function memoryPublishPort(): {
  readonly port: DeliverablePublishPort;
  bytesOf(digest: string): Uint8Array | null;
} {
  const store = new Map<string, Uint8Array>();
  return {
    port: {
      async publish(request: DeliverablePublishRequest): Promise<DeliverablePublishResult> {
        const stored = Uint8Array.from(request.bytes);
        const readback = digestBytes(stored);
        if (readback !== request.expected_digest) {
          return {
            ok: false,
            failure: { kind: 'digest_mismatch', detail: '回读摘要与导出摘要不一致（替身端口）' },
          };
        }
        store.set(readback, stored);
        return {
          ok: true,
          receipt: {
            artifact_id: `artifact-${readback.slice(0, 12)}`,
            task_revision: request.edit_revision,
            artifact_version: request.edit_revision,
            readback_digest: readback,
            byte_length: stored.byteLength,
            entry_count: memberPaths(stored).length,
            filename: request.filename,
            verifier: 'in-memory-readback',
            final_path: `memory://${request.filename}#${readback.slice(0, 8)}`,
          },
        };
      },
    },
    bytesOf(digest: string): Uint8Array | null {
      return store.get(digest) ?? null;
    },
  };
}

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

interface PrintSessionHarness {
  readonly session: DeliverableSession<XlsxPrintSource>;
  bytesOf(digest: string): Uint8Array | null;
}

/**
 * 建一个**产品交付会话**，adapter 槽放的是打印适配器（deliverable-host 的同一套 seam）。
 *
 * 种子源是**未设打印**的工作簿：随后 `set_print_layout` 才是真正的改动
 * （若种子里已经带着同一份布局，那次编辑会被如实判为"幂等空转"）。
 */
function printSession(): PrintSessionHarness {
  const publisher = memoryPublishPort();
  const created = DeliverableSession.createNew<XlsxPrintSource>(
    {
      id: 'print-seam-session',
      deliverable_id: 'print-seam-deliverable',
      filename: `${SHEET_NAME}.xlsx`,
      adapter: xlsxPrintDeliverableAdapter,
      persistence: memoryPersistence(),
      publish_port: publisher.port,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    },
    createPrintSource(budgetWorkbook()),
  );
  if (!created.ok) throw new Error(`交付会话创建失败：${created.message}`);
  return { session: created.value, bytesOf: publisher.bytesOf };
}

// ---------------------------------------------------------------------------
// 真实产品 HTTP（createDemoServer 的真实装配）
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

/** PPTX 交付请求体：三页（封面 / 事实正文 / 表格），模板决定页数。 */
function deckPayload(wantPdf: boolean): Record<string, unknown> {
  return {
    template: {
      presentation_id: 'print-public-e2e',
      title: '季度经营汇报',
      slides: [
        { kind: 'literal', title: '封面', text: '2026 年第三季度' },
        { kind: 'fact_text', title: '本季人数', fact_key: 'headcount' },
        {
          kind: 'table',
          title: '人数明细',
          shape_id: 20,
          columns: [{ heading: '人数', fact_key: 'headcount' }],
        },
      ],
    },
    facts: {
      target: {
        version: { task_id: 'print-public-e2e', task_revision: 2 },
        entries: [
          {
            fact_key: 'headcount',
            fact_ref: 'print-public-e2e-headcount-r2',
            value: { type: 'number', amount: 10, unit: '人', currency: null },
          },
        ],
      },
      history: [],
    },
    want_pdf: wantPdf,
  };
}

// ---------------------------------------------------------------------------
// 1. XLSX 打印设置：写进真实字节 + 独立解析器读回
// ---------------------------------------------------------------------------

describe('1. XLSX 打印设置：经交付会话 seam 写进真实字节，独立 ZIP 解析器逐项读回', () => {
  it('八项设置全部落进 xl/worksheets/sheet1.xml 与 xl/workbook.xml', async () => {
    const harness = printSession();
    const published = await harness.session.publish({
      idempotency_key: 'k-print-1',
      base_revision: 0,
      base_digest: harness.session.currentDigest(),
      edit: { op: 'set_print_layout', sheet: SHEET_NAME, layout: fullLayoutInput() },
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.message);
    expect(published.value.changed).toBe(true);
    const version = published.value.published;
    expect(version).not.toBeNull();
    if (version === null) throw new Error('发布成功却没有版本');

    const bytes = harness.bytesOf(version.content_digest);
    expect(bytes).not.toBeNull();
    if (bytes === null) throw new Error('发布端口里没有这一版字节');

    // --- 打印区域 / 重复标题落在 xl/workbook.xml ---
    const names = definedNames(memberText(bytes as Uint8Array, WORKBOOK_PART));
    const printArea = names.find((entry) => entry.name === '_xlnm.Print_Area');
    const printTitles = names.find((entry) => entry.name === '_xlnm.Print_Titles');
    expect(printArea?.text).toBe(`'${SHEET_NAME}'!$A$1:$G$100`);
    expect(printTitles?.text).toBe(`'${SHEET_NAME}'!$A:$B,'${SHEET_NAME}'!$1:$3`);
    expect(printArea?.local_sheet_id).toBe('0');

    // --- 方向 / 纸张 / 缩放 / 边距 / 分页 / 页眉页脚 / 打印选项落在工作表 ---
    const sheet = scanSheetPrint(memberText(bytes as Uint8Array, SHEET_PART));
    expect(sheet.has_page_setup).toBe(true);
    expect(sheet.page_setup['paperSize']).toBe('9'); // a4 = ECMA-376 编号 9
    expect(sheet.page_setup['orientation']).toBe('landscape');
    expect(sheet.page_setup['scale']).toBe('90');

    expect(sheet.has_page_margins).toBe(true);
    expect(sheet.page_margins).toEqual({
      left: '0.7',
      right: '0.7',
      top: '0.75',
      bottom: '0.75',
      header: '0.3',
      footer: '0.3',
    });

    expect(sheet.has_print_options).toBe(true);
    expect(sheet.print_options['gridLines']).toBe('1');

    expect(sheet.has_header_footer).toBe(true);
    expect(sheet.header_footer_text).toContain('&L预算表&C第 &P 页 / 共 &N 页');
    expect(sheet.header_footer_text).toContain('&C机密');

    // 手工分页符：`man="1"` 声明它是手工分页（否则消费端会忽略）。
    expect(sheet.row_breaks.length).toBe(1);
    expect(sheet.row_breaks[0]?.['id']).toBe('50');
    expect(sheet.row_breaks[0]?.['man']).toBe('1');
    expect(sheet.column_breaks.length).toBe(1);
    expect(sheet.column_breaks[0]?.['id']).toBe('3');
    expect(sheet.column_breaks[0]?.['man']).toBe('1');

    // `sheetData` 原样保留（打印注入不重写内容）。
    expect(sheet.has_sheet_data).toBe(true);
  });

  it('**反向对照**：不设打印设置 ⇒ 零 pageSetup / pageMargins / rowBreaks / Print_Area', () => {
    // ① 交付会话 seam 的基线源（无打印计划）：与"只导出可见首屏"同形。
    const source = createPrintSource(budgetWorkbook());
    const bare = xlsxPrintDeliverableAdapter.exportBytes(source);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(printElementCount(bare.bytes)).toBe(0);
    expect(definedNames(memberText(bare.bytes, WORKBOOK_PART)).length).toBe(0);

    // ② 交付链的基础适配器（产品 HTTP 现挂的就是它）：同样一个打印元素都没有。
    const base = xlsxDeliverableAdapter.exportBytes({ workbook: source.workbook, residual: source.residual });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(printElementCount(base.bytes)).toBe(0);
    expect(/<pageSetup\b/.test(memberText(base.bytes, SHEET_PART))).toBe(false);
    expect(/Print_Area/.test(memberText(base.bytes, WORKBOOK_PART))).toBe(false);
  });

  it('**反向对照**：先设后清 ⇒ 设置时 >0，清除后回到 0（打印元素不是"加进去就抹不掉"）', async () => {
    const harness = printSession();
    const set = await harness.session.publish({
      idempotency_key: 'k-print-set',
      base_revision: 0,
      base_digest: harness.session.currentDigest(),
      edit: { op: 'set_print_layout', sheet: SHEET_NAME, layout: fullLayoutInput() },
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const withPrint = harness.bytesOf((set.value.published as { content_digest: string }).content_digest);
    if (withPrint === null) throw new Error('没有设置后的字节');
    expect(printElementCount(withPrint)).toBeGreaterThan(0);

    const cleared = await harness.session.publish({
      idempotency_key: 'k-print-clear',
      base_revision: harness.session.currentRevision(),
      base_digest: harness.session.currentDigest(),
      edit: { op: 'clear_print_layout', sheet: SHEET_NAME },
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const withoutPrint = harness.bytesOf((cleared.value.published as { content_digest: string }).content_digest);
    if (withoutPrint === null) throw new Error('没有清除后的字节');
    expect(printElementCount(withoutPrint)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 交接上限：无消费端 ⇒ 最高「已交接」，写不出 printed: true
// ---------------------------------------------------------------------------

describe('2. 打印 / PDF 交接上限：无消费端 ⇒ 最高「已交接」', () => {
  it('handoffToPrint（无消费端）：状态 handed_off，printed 恒 false，confirmed_by 恒 null', () => {
    const result = handoffToPrint(fullPrintSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.receipt;
    expect(receipt.kind).toBe('print_handoff');
    expect(receipt.status).toBe('handed_off');
    expect(receipt.status).toBe(PRINT_CEILING_WITHOUT_CONSUMER);
    expect(receipt.printed).toBe(false);
    expect(receipt.confirmed_by).toBeNull();
    expect(receipt.consumer).toBeNull();
    expect(receipt.consumer_ack).toBeNull();
    // 读回证据来自**产出的字节**（不是自称）。
    expect(receipt.read_back.print_areas).toEqual([`'${SHEET_NAME}'!$A$1:$G$100`]);
    expect(receipt.manual_break_count).toBe(2); // 1 行 + 1 列
    expect(receipt.sheets_with_print).toEqual([SHEET_NAME]);
    expect(receipt.unverified.length).toBeGreaterThan(0);
    expect([...receipt.unverified]).toEqual([...PRINT_UNVERIFIED]);
  });

  it('即使消费端**收下了**字节，结论仍停在「已交接」（收到 ≠ 打出来）', () => {
    const consumer: PrintConsumerPort = {
      consumer: 'printer',
      submit: (bytes, sheets) => ({ accepted: true, detail: `收下 ${String(bytes.byteLength)} 字节 / ${sheets.join('、')}` }),
    };
    const result = handoffToPrint(fullPrintSource(), consumer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.status).toBe('handed_off');
    expect(result.receipt.printed).toBe(false);
    expect(result.receipt.confirmed_by).toBeNull();
    expect(result.receipt.consumer).toBe('printer');
    expect(result.receipt.consumer_ack).toContain('收下');
  });

  it('PPTX 侧同理：print_deck 不可回读，交接后不能升级为「已完成」', async () => {
    expect(PRESENTATION_HANDOFF_SEMANTICS.print_deck.readable).toBe(false);
    expect(PRESENTATION_HANDOFF_SEMANTICS.print_deck.effect).toBe('print');

    const port: PresentationHandoffPort = {
      async handoff() {
        return { delivered: true, handlerLabel: '系统打印栈（替身）', detail: '已交系统打印栈' };
      },
    };
    const result = await handoffPresentation(port, 'print_deck', {
      deck_id: 'deck-1',
      slide_range: null,
      include_hidden: false,
      artifact_path: '/tmp/deck.pptx',
    });
    expect(result.state).toBe('handed_off');
    expect(result.max_reachable_state).toBe('handed_off');
    expect(result.receipt.kind).toBe('none');
    expect(result.handoff_only).toBe(true);
    expect(completionBlocked(result).allowed).toBe(false);
    expect(completionBlocked(result).reason).toContain('不得升级');
    expect(EXPORT_HANDOFF_UNVERIFIED_CLAIMS.some((claim) => claim.claim.includes('打印'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 「声称已打印」必须被拒
// ---------------------------------------------------------------------------

describe('3. 声称已打印必须被拒（无消费端读回证据 ⇒ 显式抛错）', () => {
  function receipt(): PrintHandoffReceipt {
    const result = handoffToPrint(fullPrintSource());
    if (!result.ok) throw new Error(result.detail);
    return result.receipt;
  }

  it('没有证据 ⇒ 抛错（不返回 printed: true）', () => {
    expect(() => confirmPrintOutcome(receipt(), null)).toThrow(ValidationError);
    expect(() => confirmPrintOutcome(receipt(), undefined)).toThrow(/没有消费端读回证据/);
  });

  it('形状不对的证据 ⇒ 抛错（摘要非 64 位小写十六进制 / 页数 < 1）', () => {
    expect(() =>
      confirmPrintOutcome(receipt(), { consumer: 'printer', read_back_sha256: 'NOT-A-SHA', pages: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      confirmPrintOutcome(receipt(), { consumer: 'printer', read_back_sha256: 'a'.repeat(64), pages: 0 }),
    ).toThrow(ValidationError);
  });

  it('**伪造的回执**（手改成 printed: true）不被接受：本层只认自己产出的回执', () => {
    const forged = { ...receipt(), printed: true } as unknown as PrintHandoffReceipt;
    expect(() =>
      confirmPrintOutcome(forged, { consumer: 'printer', read_back_sha256: 'b'.repeat(64), pages: 2 }),
    ).toThrow(/只接受自己产出的回执/);
  });

  it('唯一可达的「已确认」路径：带齐消费端读回证据（消费端类别 + 读回摘要 + 页数）', () => {
    const confirmed = confirmPrintOutcome(receipt(), {
      consumer: 'virtual_pdf',
      read_back_sha256: 'c'.repeat(64),
      pages: 3,
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.printed).toBe(true);
    expect(confirmed.evidence.pages).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. 真产品 HTTP：createDemoServer 的真实装配 + 真 fetch
// ---------------------------------------------------------------------------

describe('4. 真产品 HTTP（createDemoServer 真实装配）：状态码与真实字节', () => {
  let workDir: string;
  let running: Running;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-print-public-'));
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

  it('/health 200；未知 /api 路由 404（兜底不被吞掉）', async () => {
    expect((await fetch(`${running.baseUrl}/health`)).status).toBe(200);
    const missing = await fetch(`${running.baseUrl}/api/definitely-not-a-route`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as Record<string, unknown>)['code']).toBe('not_found');
  });

  it('PPTX 导出：POST /api/ppt-facts/deliver（want_pdf）⇒ 200，PDF 与可编辑 PPTX 同时在且页数一致', async () => {
    const status = await fetch(`${running.baseUrl}${PPT_FACTS_ROOT}/status`);
    expect(status.status).toBe(200);

    const delivered = await postJson(running.baseUrl, `${PPT_FACTS_ROOT}/deliver`, deckPayload(true));
    expect(delivered.status).toBe(200);
    const delivery = delivered.json['delivery'] as Record<string, unknown>;
    expect(delivery['status']).toBe('delivered');

    const pptx = delivery['editable_pptx'] as Record<string, unknown>;
    const pdf = delivery['pdf'] as Record<string, unknown>;
    expect(pptx['editable']).toBe(true);
    expect(pptx['slide_count']).toBe(3);
    expect(pdf['page_count']).toBe(pptx['slide_count']);

    // 独立 ZIP 解析：PPTX 真容器、页数对得上、`p:sldId` 计数三方一致。
    const pptxBytes = new Uint8Array(Buffer.from(String(pptx['base64']), 'base64'));
    expect(Buffer.from(pptxBytes.subarray(0, 2)).toString('latin1')).toBe('PK');
    const slideParts = memberPaths(pptxBytes).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
    expect(slideParts.length).toBe(3);
    const presentationXml = memberText(pptxBytes, 'ppt/presentation.xml');
    expect(presentationXml.match(/<p:sldId /g)?.length ?? 0).toBe(3);

    // PDF 是**额外**产物：真 PDF 头，且不是"视觉保真"。
    const pdfBytes = new Uint8Array(Buffer.from(String(pdf['base64']), 'base64'));
    expect(Buffer.from(pdfBytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(pdf['fidelity']).toBe('text_outline');
    expect(pdf['visual_fidelity_verified']).toBe(false);

    // 读回不变式真跑了一次；不变式原样带出。
    const readback = delivery['readback'] as Record<string, unknown>;
    expect(readback['openable']).toBe(true);
    expect(readback['editable']).toBe(true);
    expect(delivery['invariants']).toEqual([...EXPORT_INVARIANTS]);
  });

  it('**反向对照**：带图表源 ⇒ 422 结构化阻断，响应里没有 editable_pptx 字节', async () => {
    const payload = deckPayload(true);
    payload['template'] = {
      presentation_id: 'print-public-e2e',
      title: '带图表的演示',
      slides: [
        { kind: 'literal', title: '封面', text: '封面' },
        {
          kind: 'chart',
          title: '人数趋势',
          shape_id: 30,
          chart_type: 'bar',
          categories: ['本季'],
          series: [{ name: '人数', fact_keys: ['headcount'] }],
        },
      ],
    };
    const response = await postJson(running.baseUrl, `${PPT_FACTS_ROOT}/deliver`, payload);
    expect(response.status).toBe(422);
    const delivery = response.json['delivery'] as Record<string, unknown>;
    expect(delivery['editable_pptx']).toBeUndefined();
    expect(delivery['bytes_emitted']).toBe(0);
  });

  it('XLSX 产品交付：POST /api/xls-facts/sessions ⇒ 201，/deliver ⇒ 200；字节里**零**打印元素（反向对照）', async () => {
    const created = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions`, {
      sessionId: 'print-http-xlsx',
      sheets: [SHEET_NAME],
      cells: [
        { sheet: SHEET_NAME, address: 'A1', value: { kind: 'text', value: '项目' } },
        { sheet: SHEET_NAME, address: 'G100', value: { kind: 'text', value: '合计' } },
      ],
    });
    expect(created.status).toBe(201);

    const delivered = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions/print-http-xlsx/deliver`, {});
    expect(delivered.status).toBe(200);
    const bytes = new Uint8Array(Buffer.from(String(delivered.json['fileBase64']), 'base64'));
    expect(bytes.byteLength).toBe(Number(delivered.json['byteLength']));

    // 产品侧交付的字节 = "只导出可见首屏"的形状：一个打印元素都没有。
    expect(printElementCount(bytes)).toBe(0);
    const sheet = scanSheetPrint(memberText(bytes, SHEET_PART));
    expect(sheet.has_page_setup).toBe(false);
    expect(sheet.has_page_margins).toBe(false);
    expect(sheet.row_breaks.length).toBe(0);
    expect(definedNames(memberText(bytes, WORKBOOK_PART)).length).toBe(0);

    // 未知子路径 404（命名空间内也要如实报"没有"）。
    expect((await fetch(`${running.baseUrl}${XLS_FACTS_ROOT}/sessions/print-http-xlsx/nope`)).status).toBe(404);
  });

  it('**接线缺口（如实暴露）**：产品 HTTP 上没有任何"打印设置"通道 ⇒ 设打印设置的编辑被结构化拒绝', async () => {
    const opened = await postJson(running.baseUrl, '/api/deliverables', {
      sessionId: 'print-http-deliverable',
      deliverableId: 'print-http-deliverable-file',
      filename: `${SHEET_NAME}.xlsx`,
      format: 'xlsx',
      title: '预算表',
    });
    expect(opened.status).toBe(201);
    const contentDigest = String(opened.json['contentDigest']);

    // 产品 HTTP 挂的是 `xlsxDeliverableAdapter`（封闭枚举里没有 print_layout）⇒ 422。
    const rejected = await postJson(running.baseUrl, '/api/deliverables/print-http-deliverable/edits', {
      idempotencyKey: 'k-http-print',
      baseRevision: 0,
      baseDigest: contentDigest,
      edit: { op: 'set_print_layout', sheet: SHEET_NAME, layout: fullLayoutInput() },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.json['code']).toBe('unsupported');

    // 会话状态里没有产生任何新版本（被拒 = 源零改动）。
    const status = await fetch(`${running.baseUrl}/api/deliverables/print-http-deliverable`);
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body['editRevision']).toBe(0);
    expect(body['versions']).toEqual([]);
    expect(body['currentVersion']).toBeNull();
  });
});
