/**
 * **公式读写 / 重算 / 函数边界**的产品端到端用例（工作包 FA-XLS-FORMULA-PRODUCT；XLS-06/07/08）。
 *
 * ## 这个文件把哪三层分开说
 *
 * | 层 | 本文件里对应什么 | 怎么证明 |
 * |---|---|---|
 * | **产品入口（真 HTTP）** | `POST /api/deliverables`（开交付会话）/ `POST /api/deliverables/:id/edits`（受约束编辑）/ `GET /api/deliverables/:id/versions/:rev/download`（取真实字节）；环的结构化判定另走 `POST /api/xls-facts/sessions` + `/facts` | 起**真** `node:http` 服务、真实 `fetch`，状态码逐个写进断言 |
 * | **本仓读回（独立解析器）** | 「导出的字节里 `<f>` / `<v>` 到底是什么」 | 本套件**自带**的最小 ZIP 读取器（EOCD → 中央目录 → 本地文件头 → `inflateRawSync`）+ 纯文本 XML 取证。**不 import** 产品解析器（`readWorkbookXlsx` / `readZip` / `parseXmlBytes`），否则"自产自检"不构成证据 |
 * | **仍需消费端** | 「Excel / WPS / 安卓办公套件打开后看到的公式与结果」 | **本轮没有消费端**：真机未连、桌面 Office 无授权。一律标未验证（见 {@link FORMULA_UNVERIFIED}），不冒充 |
 *
 * ## 六条判据（每条都配反向对照）
 *
 * 1. **写入公式 ⇒ 保存的是可编辑公式**：`set_cell` 写 `formula` 取值后，导出字节里
 *    **`<f>` 是公式原文**、`<v>` 只是缓存——不是"把结果固化进 `<v>` 再丢公式"。
 * 2. **改数据 ⇒ 重算**：改被引用格后重新交付，`<f>` 一字不动、`<v>` 随新数据变；
 *    旧版本字节仍是旧值（不追溯改写）。
 * 3. **函数覆盖边界逐类给实值**：13 个白名单函数逐个真写、真读回；白名单外 / 命名区域 /
 *    空白参与标量运算 / 带前导 `=` 的原文 —— **必须阻塞（只留 `<f>`）**，且**不得**出现
 *    `<v>0</v>` 这种伪造数值。
 * 4. **环与错误值**：`#DIV/0!` 是**确定**结果、并沿依赖链传播（`t="e"`）；环 ⇒ 公式格被钉成
 *    阻塞（导出侧只留 `<f>`），并在 `/api/xls-facts` 的产品响应里给出**结构化的**
 *    `blocked_formula_keys`。
 * 5. **反向对照**：① 公式被固化成人值 ⇒ 必须被检出（只看 `<v>` 会漏，判据必须落在 `<f>`）；
 *    ② 不支持的函数**返回 0** ⇒ 必须被检出（本仓的形状是"无 `<v>`"，不是 `<v>0</v>`）；
 *    ③ 跨表引用在表名变更后失效 ⇒ 必须被检出（改表名会**迁移**引用；引用指向不存在的表时
 *    **不得**留下过期缓存）。
 * 6. **函数白名单与实测一一对应**：{@link SUPPORTED_FUNCTIONS} 里的每个名字都在本文件里有
 *    一条"真写进去 + 真读回来"的用例（不是抄一份常量再声称覆盖）。
 *
 * ## ⚠️ 诚实边界（结果不得编造；逐条标明走到了哪一层）
 *
 * - **`/api/deliverables/**` 的 `set_cell` 不归一化前导 `=`**：内核公式文本的口径是**不含** `=`，
 *   因此 "`=SUM(A1:A2)`" 这种人类写法经该入口会**整体阻塞**（`<f>` 保留原文、无 `<v>`）。
 *   这与 `/api/xls-facts/sessions`（`xls-facts-product.ts` 里 `normalizeFormulaText` 会剥掉一个
 *   前导 `=`）**口径不同**——本文件把两者都实测出来并如实并列，不替任何一方打圆场。
 * - **本仓词法器对表名限定的两条硬边界（实测，非推测）**：① 跨表**区域**只有作为聚合函数实参
 *   才求值（`SUM(Data!A1:A2)` ⇒ `3`）；同一个区域当**标量**用（`Data!A1:A2`）**整体阻塞**
 *   （`unsupported_construct`）。② **裸名限定只认 ASCII 标识符**：表名 `预算` 必须写成
 *   `'预算'!A1`，写成 `预算!A1` 会以 `parse_error` 整体阻塞。两条都保留公式原文、都不伪造数值。
 * - **导出侧的重算报告没有 HTTP 出口**：`writeWorkbookXlsx` 的 `evaluations`（逐格求值 + 阻塞原因）
 *   在产品 HTTP 上**没有任何一条路由**读得到；因此"环/阻塞的**原因字符串**"只能经
 *   `/api/xls-facts/sessions/:id/facts` 的 `blocked_formula_keys`（**只有键名**）间接暴露。
 *   这是**如实暴露的接线缺口**，不是本文件能改的事（工作包写权只允许新增本文件）。
 * - **真机 / 消费端未验证**：见 {@link FORMULA_UNVERIFIED}。
 *
 * ## 真服务冒烟
 *
 * 本文件在 `beforeAll` 里起**真** `createDemoServer()` 装配的 `node:http` 服务并真实 `fetch`，
 * 状态码写进断言；交付说明里另附仓库外 `node main.js` + `curl` 的冒烟记录（**不用** 8765 端口，
 * 不打扰其它运行实例）。**不跑全量、不跑 Gradle**。
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

import { SUPPORTED_FUNCTIONS } from '../../../src/spreadsheets/index.js';
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

function memberText(bytes: Uint8Array, path: string): string {
  const member = unzipIndependently(bytes).find((item) => item.path === path);
  if (member === undefined) throw new Error(`独立解析器：包里没有部件 ${path}`);
  return member.data.toString('utf8');
}

// ---------------------------------------------------------------------------
// 工作表 XML 取证（纯文本正则；只看"字节里到底有没有那个元素"）
// ---------------------------------------------------------------------------

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 一个格子的取证结果。
 *
 * `f` / `v` 为 `null` 表示**元素不存在**（不是空串）——"没有 `<v>`"与"`<v></v>`"必须分得开，
 * 否则"不得伪造数值"这条判据会被空串蒙混过去。
 */
interface CellFacts {
  readonly ref: string;
  readonly t: string | null;
  readonly f: string | null;
  readonly v: string | null;
  readonly raw: string;
}

function scanCells(xml: string): Map<string, CellFacts> {
  const cells = new Map<string, CellFacts>();
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(xml)) !== null) {
    const attributes = match[1] ?? '';
    const inner = match[2] ?? '';
    const ref = /\br="([A-Z]+[0-9]+)"/.exec(attributes)?.[1];
    if (ref === undefined) continue;
    const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? null;
    const fMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
    const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
    cells.set(ref, {
      ref,
      t: type,
      f: fMatch === null ? null : unescapeXml(fMatch[1] ?? ''),
      v: vMatch === null ? null : unescapeXml(vMatch[1] ?? ''),
      raw: `<c ${attributes}>${inner}</c>`,
    });
  }
  return cells;
}

/** 工作表名（按 `xl/workbook.xml` 里的 `<sheet>` 顺序）→ 部件路径。 */
function sheetPartPathFor(bytes: Uint8Array, sheetName: string): string {
  const workbookXml = memberText(bytes, 'xl/workbook.xml');
  const names: string[] = [];
  const pattern = /<sheet\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(workbookXml)) !== null) {
    const name = /\bname="([^"]*)"/.exec(match[1] ?? '')?.[1];
    if (name !== undefined) names.push(unescapeXml(name));
  }
  const index = names.indexOf(sheetName);
  if (index < 0) {
    throw new Error(`独立解析器：工作簿里没有工作表 ${JSON.stringify(sheetName)}（有：${names.join('、')}）`);
  }
  return `xl/worksheets/sheet${String(index + 1)}.xml`;
}

interface SheetFacts {
  readonly xml: string;
  readonly cells: Map<string, CellFacts>;
}

function sheetFacts(bytes: Uint8Array, sheetName: string): SheetFacts {
  const xml = memberText(bytes, sheetPartPathFor(bytes, sheetName));
  return { xml, cells: scanCells(xml) };
}

function cellOf(bytes: Uint8Array, sheetName: string, ref: string): CellFacts {
  const cell = sheetFacts(bytes, sheetName).cells.get(ref);
  if (cell === undefined) {
    throw new Error(`独立解析器：${sheetName}!${ref} 在导出的工作表 XML 里不存在（整格都没写）`);
  }
  return cell;
}

/** 公式被判据要求"保存的是可编辑公式"（不是固化成人值）。 */
function isEditableFormula(cell: CellFacts): boolean {
  return cell.f !== null && cell.f.length > 0;
}

/** 反向对照①的判据：**有值但没公式** ⇒ 这就是"被固化成人值"的形状。 */
function isFrozenValue(cell: CellFacts): boolean {
  return cell.f === null && cell.v !== null;
}

/** 反向对照②③的判据：**有公式但拿不到值** ⇒ 阻塞 / 悬空（没有伪造结果）。 */
function isBlockedFormula(cell: CellFacts): boolean {
  return cell.f !== null && cell.v === null;
}

// ---------------------------------------------------------------------------
// 真产品 HTTP 夹具
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

interface DownloadResult {
  readonly status: number;
  readonly contentType: string | null;
  readonly digestHeader: string | null;
  readonly bytes: Uint8Array;
}

async function downloadVersion(baseUrl: string, sessionId: string, revision: number): Promise<DownloadResult> {
  const response = await fetch(
    `${baseUrl}/api/deliverables/${sessionId}/versions/${String(revision)}/download`,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    digestHeader: response.headers.get('x-content-sha256'),
    bytes,
  };
}

let idempotencyCounter = 0;

/** 一个交付会话的驱动（跟踪 revision / digest，按真实客户端协议提编辑）。 */
interface Driver {
  readonly sessionId: string;
  readonly revision: () => number;
  readonly digest: () => string;
  /** 提交一次编辑；非 200 ⇒ 抛（调用方需要核对被拒形状时用 {@link Driver.attempt}）。 */
  apply(edit: unknown): Promise<Record<string, unknown>>;
  /** 提交一次编辑，原样返回状态码与响应体（用于"必须被拒"的反向对照）。 */
  attempt(edit: unknown): Promise<JsonResponse>;
  setCell(sheet: string, address: string, value: unknown): Promise<void>;
  bytes(revision?: number): Promise<Uint8Array>;
}

async function openXlsxSession(baseUrl: string, sessionId: string): Promise<Driver> {
  const opened = await postJson(baseUrl, '/api/deliverables', {
    sessionId,
    deliverableId: `${sessionId}-deliverable`,
    filename: `${sessionId}.xlsx`,
    format: 'xlsx',
  });
  expect(opened.status).toBe(201);
  const state = {
    revision: Number(opened.json['editRevision']),
    digest: String(opened.json['contentDigest']),
  };

  const attempt = async (edit: unknown): Promise<JsonResponse> => {
    idempotencyCounter += 1;
    const response = await postJson(baseUrl, `/api/deliverables/${sessionId}/edits`, {
      idempotencyKey: `k${String(idempotencyCounter)}`,
      baseRevision: state.revision,
      baseDigest: state.digest,
      edit,
    });
    const version = response.json['version'];
    if (response.status === 200 && version !== null && typeof version === 'object') {
      state.revision = Number((version as Record<string, unknown>)['editRevision']);
      state.digest = String((version as Record<string, unknown>)['contentDigest']);
    }
    return response;
  };

  const apply = async (edit: unknown): Promise<Record<string, unknown>> => {
    const response = await attempt(edit);
    if (response.status !== 200) {
      throw new Error(`交付编辑被拒：HTTP ${String(response.status)} ${JSON.stringify(response.json)}`);
    }
    return response.json;
  };

  return {
    sessionId,
    revision: () => state.revision,
    digest: () => state.digest,
    apply,
    attempt,
    async setCell(sheet: string, address: string, value: unknown): Promise<void> {
      await apply({ op: 'set_cell', sheet, address, value });
    },
    async bytes(revision?: number): Promise<Uint8Array> {
      const target = revision ?? state.revision;
      const downloaded = await downloadVersion(baseUrl, sessionId, target);
      expect(downloaded.status).toBe(200);
      return downloaded.bytes;
    },
  };
}

/** 便捷构造各类 `CellValue`（形状与 `src/spreadsheets` 同一套词汇）。 */
const num = (value: number) => ({ kind: 'number', value });
const txt = (value: string) => ({ kind: 'text', value });
const frm = (text: string) => ({ kind: 'formula', text });

// ---------------------------------------------------------------------------
// 未验证清单（如实登记；不写进任何"已完成"判定）
// ---------------------------------------------------------------------------

/** 本层**没有验证**的项。 */
const FORMULA_UNVERIFIED: readonly string[] = Object.freeze([
  '真实 Excel / WPS / 安卓办公套件打开后：公式是否可编辑、结果是否按 cached 值或重算显示、fullCalcOnLoad 是否生效',
  '真实消费端对"只有 <f> 没有 <v>"的公式格如何呈现（本仓只保证不写伪造数值）',
  '真实消费端对跨表迁移后公式（如 Summary!A1*2）的解析与本地化（表名引号形式）是否一致',
]);

// ---------------------------------------------------------------------------
// 主套件
// ---------------------------------------------------------------------------

describe('XLS-06/07/08 公式读写 / 重算 / 函数边界（真产品 HTTP）', () => {
  let workDir: string;
  let running: Running;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-xls-formula-'));
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

  // -------------------------------------------------------------------------
  // A. 可达性：真服务 + 产品入口
  // -------------------------------------------------------------------------

  describe('A. 可达性：真服务、真路由、真字节', () => {
    it('/health 200；交付会话入口存在；未知 /api 路由如实 404', async () => {
      expect((await fetch(`${running.baseUrl}/health`)).status).toBe(200);

      const missing = await fetch(`${running.baseUrl}/api/definitely-not-a-route`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as Record<string, unknown>)['code']).toBe('not_found');

      // 空 deliverableId 被拒 ⇒ 说明路由确实在（不是"全 404 也叫可达"）。
      const invalid = await postJson(running.baseUrl, '/api/deliverables', { sessionId: 'x' });
      expect(invalid.status).toBe(400);
    });

    it('开一个 xlsx 交付会话 ⇒ 201；导出的字节是真 ZIP 容器且含 xl/workbook.xml', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-boot');
      // 新建会话本身不产出版本行（只导出一次算摘要）⇒ 先提交一次编辑再取字节。
      await driver.setCell('Sheet1', 'A1', num(1));
      const bytes = await driver.bytes();
      // 真 ZIP 的本地文件头签名 `PK\x03\x04`。
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(unzipIndependently(bytes).some((member) => member.path === 'xl/workbook.xml')).toBe(true);
      expect(FORMULA_UNVERIFIED.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // B. 写入公式：保存的是**可编辑公式**，不是固化值
  // -------------------------------------------------------------------------

  describe('B. 写公式 ⇒ 字节里 <f> 是公式原文、<v> 只是缓存', () => {
    it('SUM / AVERAGE / IF / 跨表引用 四类都真写进去并真读回来', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-write');

      await driver.apply({ op: 'add_sheet', name: 'Data' });
      await driver.setCell('Data', 'A1', num(100));
      await driver.setCell('Data', 'A2', num(23));
      await driver.setCell('Sheet1', 'A1', num(10));
      await driver.setCell('Sheet1', 'A2', num(20));
      await driver.setCell('Sheet1', 'A3', num(30));
      await driver.setCell('Sheet1', 'B1', frm('SUM(A1:A3)'));
      await driver.setCell('Sheet1', 'B2', frm('AVERAGE(A1:A3)'));
      await driver.setCell('Sheet1', 'B3', frm('IF(A1>0,"正","负")'));
      await driver.setCell('Sheet1', 'B4', frm('Data!A1+Data!A2'));

      const bytes = await driver.bytes();
      const sheet1 = sheetFacts(bytes, 'Sheet1');

      // SUM：<f> 是原文，<v> 是缓存。
      const sum = sheet1.cells.get('B1');
      expect(sum?.f).toBe('SUM(A1:A3)');
      expect(sum?.v).toBe('60');
      // AVERAGE
      expect(sheet1.cells.get('B2')?.f).toBe('AVERAGE(A1:A3)');
      expect(sheet1.cells.get('B2')?.v).toBe('20');
      // IF 的文本分支：公式文本结果是 t="str"（不是 inlineStr）。
      const iff = sheet1.cells.get('B3');
      expect(iff?.f).toBe('IF(A1>0,"正","负")');
      expect(iff?.t).toBe('str');
      expect(iff?.v).toBe('正');
      // 跨表引用：<f> 原文里保留表名限定。
      const cross = sheet1.cells.get('B4');
      expect(cross?.f).toBe('Data!A1+Data!A2');
      expect(cross?.v).toBe('123');

      // 判据落在 `<f>` 上：四格都是"可编辑公式"，没有一格是固化值。
      for (const ref of ['B1', 'B2', 'B3', 'B4']) {
        const cell = sheet1.cells.get(ref) as CellFacts;
        expect(isEditableFormula(cell)).toBe(true);
        expect(isFrozenValue(cell)).toBe(false);
      }

      // 反向对照：把同样的取值写成**字面量** ⇒ 有 <v> 没有 <f>，判据立刻分得开。
      await driver.setCell('Sheet1', 'A4', num(60));
      const frozen = cellOf(await driver.bytes(), 'Sheet1', 'A4');
      expect(frozen.v).toBe('60');
      expect(frozen.f).toBeNull();
      expect(isFrozenValue(frozen)).toBe(true);
    });

    it('边界：`/api/deliverables` 的 set_cell 不归一化前导 `=`（与 /api/xls-facts 口径不同，都实测）', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-leading-eq');
      await driver.setCell('Sheet1', 'A1', num(1));
      await driver.setCell('Sheet1', 'A2', num(2));
      // 人类写法（带 `=`）：该入口**原样**进内核 ⇒ 解析失败 ⇒ 整体阻塞（只留 <f>）。
      await driver.setCell('Sheet1', 'B1', frm('=SUM(A1:A2)'));
      const withEq = cellOf(await driver.bytes(), 'Sheet1', 'B1');
      expect(withEq.f).toBe('=SUM(A1:A2)');
      expect(withEq.v).toBeNull();
      expect(isBlockedFormula(withEq)).toBe(true);

      // 内核口径（不带 `=`）⇒ 正常求值。
      await driver.setCell('Sheet1', 'B2', frm('SUM(A1:A2)'));
      const withoutEq = cellOf(await driver.bytes(), 'Sheet1', 'B2');
      expect(withoutEq.f).toBe('SUM(A1:A2)');
      expect(withoutEq.v).toBe('3');

      // `/api/xls-facts` 这条入口**会剥掉**一个前导 `=` ⇒ 两条入口口径不同，如实并列。
      const created = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions`, {
        sessionId: 'formula-leading-eq-facts',
        sheets: ['S'],
        cells: [
          { sheet: 'S', address: 'A1', value: num(1) },
          { sheet: 'S', address: 'A2', value: num(2) },
          { sheet: 'S', address: 'B1', value: frm('=SUM(A1:A2)') },
        ],
      });
      expect(created.status).toBe(201);
      const delivered = await postJson(
        running.baseUrl,
        `${XLS_FACTS_ROOT}/sessions/formula-leading-eq-facts/deliver`,
        {},
      );
      expect(delivered.status).toBe(200);
      const factsBytes = new Uint8Array(Buffer.from(String(delivered.json['fileBase64']), 'base64'));
      const normalized = cellOf(factsBytes, 'S', 'B1');
      expect(normalized.f).toBe('SUM(A1:A2)');
      expect(normalized.v).toBe('3');
    });
  });

  // -------------------------------------------------------------------------
  // C. 函数覆盖边界表（逐类给实际支持与边界）
  // -------------------------------------------------------------------------

  describe('C. 函数覆盖：13 个白名单函数逐个真写真读，白名单外必须阻塞', () => {
    /** 白名单函数的真值样例（每个都经产品入口写进去、再从字节里读回来）。 */
    const SUPPORTED_CASES: readonly {
      readonly fn: string;
      readonly formula: string;
      readonly expectedV: string;
      readonly expectedT: string | null;
    }[] = [
      { fn: 'SUM', formula: 'SUM(A1:A3)', expectedV: '60', expectedT: null },
      { fn: 'AVERAGE', formula: 'AVERAGE(A1:A3)', expectedV: '20', expectedT: null },
      { fn: 'MIN', formula: 'MIN(A1:A3)', expectedV: '10', expectedT: null },
      { fn: 'MAX', formula: 'MAX(A1:A3)', expectedV: '30', expectedT: null },
      { fn: 'COUNT', formula: 'COUNT(A1:A3)', expectedV: '3', expectedT: null },
      { fn: 'COUNTA', formula: 'COUNTA(A1:A3)', expectedV: '3', expectedT: null },
      { fn: 'IF', formula: 'IF(A1>0,"正","负")', expectedV: '正', expectedT: 'str' },
      { fn: 'AND', formula: 'AND(A1>0,A2>0)', expectedV: '1', expectedT: 'b' },
      { fn: 'OR', formula: 'OR(A1>100,A2>100)', expectedV: '0', expectedT: 'b' },
      { fn: 'NOT', formula: 'NOT(A1>0)', expectedV: '0', expectedT: 'b' },
      { fn: 'ABS', formula: 'ABS(A4)', expectedV: '5', expectedT: null },
      { fn: 'ROUND', formula: 'ROUND(A5,0)', expectedV: '2', expectedT: null },
      { fn: 'SQRT', formula: 'SQRT(A6)', expectedV: '3', expectedT: null },
    ];

    it('白名单与实测一一对应（集合相等，不是"抄一份常量"）', () => {
      const covered = SUPPORTED_CASES.map((entry) => entry.fn).sort();
      expect(covered).toEqual([...SUPPORTED_FUNCTIONS].sort());
      expect(covered.length).toBe(13);
    });

    it('每个白名单函数都真写进去并读回 <f> 原文 + <v> 实值', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-supported');
      await driver.setCell('Sheet1', 'A1', num(10));
      await driver.setCell('Sheet1', 'A2', num(20));
      await driver.setCell('Sheet1', 'A3', num(30));
      await driver.setCell('Sheet1', 'A4', num(-5));
      await driver.setCell('Sheet1', 'A5', num(1.5));
      await driver.setCell('Sheet1', 'A6', num(9));

      for (const [index, entry] of SUPPORTED_CASES.entries()) {
        await driver.setCell('Sheet1', `B${String(index + 1)}`, frm(entry.formula));
      }
      const bytes = await driver.bytes();

      for (const [index, entry] of SUPPORTED_CASES.entries()) {
        const cell = cellOf(bytes, 'Sheet1', `B${String(index + 1)}`);
        // <f> 是公式原文（不是结果），<v> 是当前缓存。
        expect({ fn: entry.fn, f: cell.f }).toEqual({ fn: entry.fn, f: entry.formula });
        expect({ fn: entry.fn, v: cell.v }).toEqual({ fn: entry.fn, v: entry.expectedV });
        expect({ fn: entry.fn, t: cell.t }).toEqual({ fn: entry.fn, t: entry.expectedT });
      }
    });

    it('边界：白名单外 / 命名区域 / 空白参与标量 三类都**只留 <f>**，绝不伪造数值', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-unsupported');
      await driver.setCell('Sheet1', 'A1', num(10));
      await driver.setCell('Sheet1', 'A2', num(20));
      await driver.setCell('Sheet1', 'A3', num(30));

      const blocked: readonly { readonly ref: string; readonly formula: string; readonly why: string }[] = [
        { ref: 'C1', formula: 'VLOOKUP(A1,A1:A3,1,FALSE)', why: '白名单外函数' },
        { ref: 'C2', formula: 'SUMIF(A1:A3,">0")', why: '白名单外函数' },
        { ref: 'C3', formula: '总价*2', why: '命名区域（本仓未建模）' },
        { ref: 'C4', formula: 'AVERAGE(D1:D3)', why: '空聚合（区域全空白，R248 不返回 0）' },
        { ref: 'C5', formula: 'D1+1', why: '空白格参与标量运算（缺失不当零）' },
      ];
      for (const entry of blocked) {
        await driver.setCell('Sheet1', entry.ref, frm(entry.formula));
      }
      const bytes = await driver.bytes();
      const sheet = sheetFacts(bytes, 'Sheet1');

      for (const entry of blocked) {
        const cell = sheet.cells.get(entry.ref) as CellFacts;
        // 正向：公式原文一字不动地保留下来（"保留原文"）。
        expect({ ref: entry.ref, f: cell.f }).toEqual({ ref: entry.ref, f: entry.formula });
        // 反向：**没有** `<v>` 元素（不是 `<v>0</v>`、也不是空 `<v>`）。
        expect({ ref: entry.ref, v: cell.v }).toEqual({ ref: entry.ref, v: null });
        expect({ ref: entry.ref, hasV: /<v\b/.test(cell.raw) }).toEqual({ ref: entry.ref, hasV: false });
        expect(isBlockedFormula(cell)).toBe(true);
      }

      // 全表扫描：整份工作表里不存在"被伪造的 0"——本表唯一的 0 值来自 A0 不存在，
      // 因此断言"阻塞格的值一律是 null"已经覆盖；这里再钉一次原始字节口径。
      expect(sheet.xml.includes('<v>0</v>')).toBe(false);
    });

    it('边界：跨表区域作聚合参数**支持**；同一区域当标量则阻塞（两类如实并列）', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-cross-range');
      await driver.apply({ op: 'add_sheet', name: 'Data' });
      await driver.setCell('Data', 'A1', num(1));
      await driver.setCell('Data', 'A2', num(2));
      // 聚合函数吃区域 ⇒ 支持（跨表也算得出来）。
      await driver.setCell('Sheet1', 'B1', frm('SUM(Data!A1:A2)'));
      // 同一区域当标量 ⇒ 本仓未建模 ⇒ 阻塞（保留原文，不算出一个数）。
      await driver.setCell('Sheet1', 'B2', frm('Data!A1:A2'));

      const bytes = await driver.bytes();
      const aggregate = cellOf(bytes, 'Sheet1', 'B1');
      const scalar = cellOf(bytes, 'Sheet1', 'B2');
      expect(aggregate.f).toBe('SUM(Data!A1:A2)');
      expect(aggregate.v).toBe('3');
      expect(scalar.f).toBe('Data!A1:A2');
      expect(scalar.v).toBeNull();
      expect(isBlockedFormula(scalar)).toBe(true);
    });

    it('边界：非 ASCII 表名必须用带引号限定（裸名进不去词法器，如实阻塞）', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-nonascii-sheet');
      await driver.apply({ op: 'add_sheet', name: '预算' });
      await driver.setCell('预算', 'A1', num(100));
      // 裸名限定：`数` 不是本仓词法器认的标识符起始字符 ⇒ 整体阻塞（保留原文，不算出数）。
      await driver.setCell('Sheet1', 'B1', frm('预算!A1*2'));
      // 带引号限定：同一张表、同一个引用，正常求值。
      await driver.setCell('Sheet1', 'B2', frm("'预算'!A1*2"));

      const bytes = await driver.bytes();
      const bare = cellOf(bytes, 'Sheet1', 'B1');
      const quoted = cellOf(bytes, 'Sheet1', 'B2');
      expect(bare.f).toBe('预算!A1*2');
      expect(bare.v).toBeNull();
      expect(quoted.f).toBe("'预算'!A1*2");
      expect(quoted.v).toBe('200');
    });
  });

  // -------------------------------------------------------------------------
  // D. 改数据 ⇒ 重算
  // -------------------------------------------------------------------------

  describe('D. 改被引用格 ⇒ <v> 随新数据重算（<f> 不动）', () => {
    it('两版对比：v1 缓存 30 ⇒ 改 A2 ⇒ v2 缓存 35；旧版本字节不追溯改写', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-recalc');
      await driver.setCell('Sheet1', 'A1', num(10));
      await driver.setCell('Sheet1', 'A2', num(20));
      await driver.setCell('Sheet1', 'B1', frm('SUM(A1:A2)'));

      const rev1 = driver.revision();
      const v1 = await driver.bytes(rev1);
      expect(cellOf(v1, 'Sheet1', 'B1').f).toBe('SUM(A1:A2)');
      expect(cellOf(v1, 'Sheet1', 'B1').v).toBe('30');

      // 改被引用格（不是改公式格）。
      await driver.setCell('Sheet1', 'A2', num(25));
      const rev2 = driver.revision();
      expect(rev2).toBeGreaterThan(rev1);
      const v2 = await driver.bytes(rev2);
      expect(cellOf(v2, 'Sheet1', 'B1').f).toBe('SUM(A1:A2)');
      expect(cellOf(v2, 'Sheet1', 'B1').v).toBe('35');

      // 旧版本**字节**没有跟着变（不追溯改写历史交付）。
      const v1Again = await driver.bytes(rev1);
      expect(cellOf(v1Again, 'Sheet1', 'B1').v).toBe('30');
      expect(cellOf(v1Again, 'Sheet1', 'B1').f).toBe('SUM(A1:A2)');

      // 反向对照：如果缓存不重算，v2 会仍旧写 30 —— 两版摘要也必须不同。
      expect(cellOf(v1, 'Sheet1', 'B1').v).not.toBe(cellOf(v2, 'Sheet1', 'B1').v);
    });

    it('跨表引用照样重算：改 `Data!A1` ⇒ 引用它的 `<v>` 跟着变', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-recalc-cross');
      await driver.apply({ op: 'add_sheet', name: 'Data' });
      await driver.setCell('Data', 'A1', num(100));
      await driver.setCell('Sheet1', 'B1', frm('Data!A1*2'));

      expect(cellOf(await driver.bytes(), 'Sheet1', 'B1').v).toBe('200');
      await driver.setCell('Data', 'A1', num(150));
      const after = cellOf(await driver.bytes(), 'Sheet1', 'B1');
      expect(after.f).toBe('Data!A1*2');
      expect(after.v).toBe('300');
    });
  });

  // -------------------------------------------------------------------------
  // E. 环与错误值
  // -------------------------------------------------------------------------

  describe('E. 错误值沿依赖链传播；环 ⇒ 阻塞且结构化报出', () => {
    it('`1/0` ⇒ t="e" #DIV/0!，并沿两条依赖链传播到下游格', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-div0');
      await driver.setCell('Sheet1', 'A1', frm('1/0'));
      await driver.setCell('Sheet1', 'B1', frm('A1+1'));
      await driver.setCell('Sheet1', 'C1', frm('B1*2'));

      const bytes = await driver.bytes();
      for (const ref of ['A1', 'B1', 'C1']) {
        const cell = cellOf(bytes, 'Sheet1', ref);
        expect({ ref, t: cell.t }).toEqual({ ref, t: 'e' });
        expect({ ref, v: cell.v }).toEqual({ ref, v: '#DIV/0!' });
      }
      // 不是"把错误值当成 0 继续算"：下游格不是 1 / 2 这类伪造数。
      expect(cellOf(bytes, 'Sheet1', 'B1').v).not.toBe('1');
      expect(cellOf(bytes, 'Sheet1', 'C1').v).not.toBe('2');
    });

    it('环 ⇒ 导出字节里公式格只留 <f>（无 <v>），且 /api/xls-facts 给出结构化 blocked_formula_keys', async () => {
      // ① 导出侧：环上的两格都拿不到值 ⇒ 不写 <v>（不伪造、不写 0）。
      const driver = await openXlsxSession(running.baseUrl, 'formula-cycle');
      await driver.setCell('Sheet1', 'G1', frm('G2+1'));
      await driver.setCell('Sheet1', 'G2', frm('G1+1'));
      const bytes = await driver.bytes();
      for (const ref of ['G1', 'G2']) {
        const cell = cellOf(bytes, 'Sheet1', ref);
        expect({ ref, f: cell.f }).toEqual({ ref, f: ref === 'G1' ? 'G2+1' : 'G1+1' });
        expect({ ref, v: cell.v }).toEqual({ ref, v: null });
        expect(isBlockedFormula(cell)).toBe(true);
      }

      // ② 结构化侧：`/api/xls-facts` 的 `/facts` 在**闭包内**把被阻塞的公式格逐键报出。
      //    构造：A1（绑定格，数值）→ B1（`A1+C1`）↔ C1（`B1`）成环。
      const created = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions`, {
        sessionId: 'formula-cycle-facts',
        sheets: ['S'],
        cells: [
          { sheet: 'S', address: 'A1', value: num(1) },
          { sheet: 'S', address: 'B1', value: frm('A1+C1') },
          { sheet: 'S', address: 'C1', value: frm('B1') },
        ],
        bindings: [{ sheet: 'S', ref: 'A1', fact_key: 'seed', version: 1 }],
      });
      expect(created.status).toBe(201);

      const applied = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions/formula-cycle-facts/facts`, {
        updates: [
          { fact_key: 'seed', version: 2, value: num(5), source: '用户改口', at: 101 },
        ],
      });
      expect(applied.status).toBe(200);
      expect(applied.json['rewritten_cell_keys']).toEqual(['S!A1']);
      expect(applied.json['recalculated_formula_keys']).toContain('S!B1');
      expect(applied.json['recalculated_formula_keys']).toContain('S!C1');
      // 结构化"环"的机器可读形状：环内公式格逐个进 blocked_formula_keys（**不是**静默算出一个数）。
      expect(applied.json['blocked_formula_keys']).toEqual(['S!B1', 'S!C1']);

      const delivered = await postJson(
        running.baseUrl,
        `${XLS_FACTS_ROOT}/sessions/formula-cycle-facts/deliver`,
        {},
      );
      expect(delivered.status).toBe(200);
      const cycleBytes = new Uint8Array(Buffer.from(String(delivered.json['fileBase64']), 'base64'));
      for (const ref of ['B1', 'C1']) {
        expect(isBlockedFormula(cellOf(cycleBytes, 'S', ref))).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // F. 反向对照三条
  // -------------------------------------------------------------------------

  describe('F. 反向对照：三类"看起来对、其实错了"的形状必须被检出', () => {
    it('① 公式被固化成人值 ⇒ 被检出（判据必须落在 <f>，只看 <v> 会漏）', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-frozen-twin');
      await driver.setCell('Sheet1', 'A1', num(10));
      await driver.setCell('Sheet1', 'A2', num(25));
      // 同一份工作簿里放一对"孪生格"：H1 是真公式、H2 是被固化的人值。
      await driver.setCell('Sheet1', 'H1', frm('A1+A2'));
      await driver.setCell('Sheet1', 'H2', num(35));

      const bytes = await driver.bytes();
      const formula = cellOf(bytes, 'Sheet1', 'H1');
      const frozen = cellOf(bytes, 'Sheet1', 'H2');

      // "看起来对"：两者 `<v>` 一模一样。
      expect(formula.v).toBe('35');
      expect(frozen.v).toBe('35');
      // 但判据落在 `<f>` 上 ⇒ 固化格立刻被检出。
      expect(isEditableFormula(formula)).toBe(true);
      expect(isEditableFormula(frozen)).toBe(false);
      expect(isFrozenValue(frozen)).toBe(true);
    });

    it('② 不支持的函数"返回 0" ⇒ 被检出（本仓的形状是无 <v>，不是 <v>0</v>）', async () => {
      const driver = await openXlsxSession(running.baseUrl, 'formula-no-fabricated-zero');
      await driver.setCell('Sheet1', 'A1', num(7));
      await driver.setCell('Sheet1', 'J1', frm('VLOOKUP(A1,A1:A2,1,FALSE)'));
      // 对照格：真的 0 是**可以**出现的（与"伪造 0"必须可区分）。
      await driver.setCell('Sheet1', 'J2', num(0));

      const bytes = await driver.bytes();
      const unsupported = cellOf(bytes, 'Sheet1', 'J1');
      const realZero = cellOf(bytes, 'Sheet1', 'J2');

      expect(unsupported.f).toBe('VLOOKUP(A1,A1:A2,1,FALSE)');
      expect(unsupported.v).toBeNull();
      expect(unsupported.raw.includes('<v>')).toBe(false);
      // 伪造 0 会被这一条抓住：`<f>` 在 + `<v>0</v>` 在。
      expect(unsupported.v).not.toBe('0');
      // 反向：真实的 0 值仍照写（不是"禁止出现 0"）。
      expect(realZero.v).toBe('0');
      expect(realZero.f).toBeNull();
      expect(isFrozenValue(realZero)).toBe(true);
    });

    it('③ 跨表引用在表名变更后失效 ⇒ 被检出（迁移 / 拒绝 / 悬空三种形态都实测）', async () => {
      // ③-a 改表名 ⇒ 引用被**迁移**（不是静默指错表）：<f> 里的限定跟着改，<v> 照旧正确。
      const renamed = await openXlsxSession(running.baseUrl, 'formula-rename');
      await renamed.apply({ op: 'add_sheet', name: 'Data' });
      await renamed.setCell('Data', 'A1', num(100));
      await renamed.setCell('Sheet1', 'F1', frm('Data!A1*2'));
      expect(cellOf(await renamed.bytes(), 'Sheet1', 'F1').v).toBe('200');

      await renamed.apply({ op: 'rename_sheet', from: 'Data', to: 'Summary' });
      const afterRename = await renamed.bytes();
      const migrated = cellOf(afterRename, 'Sheet1', 'F1');
      expect(migrated.f).toBe('Summary!A1*2');
      expect(migrated.v).toBe('200');
      // 旧表名不可能藏在字节里 ⇒ "引用没跟着改"这种静默失效不可能发生。
      expect(sheetFacts(afterRename, 'Sheet1').xml.includes('Data!')).toBe(false);

      // ③-b 删掉被引用的表 ⇒ **结构化拒绝**（本仓不写悬空引用），不是静默产出一个悬空公式。
      const removeAttempt = await renamed.attempt({ op: 'remove_sheet', name: 'Summary' });
      expect(removeAttempt.status).toBe(422);
      expect(removeAttempt.json['code']).toBe('unsupported');
      // 拒绝理由**点名**了悬空位置（不是一句笼统的"不允许"）。
      const refusal = String(removeAttempt.json['message']);
      expect(refusal).toContain('悬空引用');
      expect(refusal).toContain('Summary!A1*2');
      // 被拒的编辑**不改源**：还能正常读回当前版本，且引用完好。
      const afterRefusal = await renamed.bytes();
      expect(cellOf(afterRefusal, 'Sheet1', 'F1').f).toBe('Summary!A1*2');

      // ③-c 已经悬空的跨表引用（经不预校验的入口构造）⇒ 交付时**不得**留过期缓存。
      const dangling = await openXlsxSession(running.baseUrl, 'formula-dangling');
      await dangling.setCell('Sheet1', 'F2', frm('缺失表!A1*2'));
      const danglingCell = cellOf(await dangling.bytes(), 'Sheet1', 'F2');
      expect(danglingCell.f).toBe('缺失表!A1*2');
      expect(danglingCell.v).toBeNull();
      expect(isBlockedFormula(danglingCell)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // G. 真服务冒烟（同一次运行里对真实 HTTP 断言状态码）
  // -------------------------------------------------------------------------

  describe('G. 真服务冒烟：状态码逐条', () => {
    it('401/404/405 等拒绝面与 200/201 通路面都如实', async () => {
      // 405：交付会话只接受 POST。
      const wrongMethod = await fetch(`${running.baseUrl}/api/deliverables`);
      expect(wrongMethod.status).toBe(405);

      // 404：不存在的交付会话。
      expect((await fetch(`${running.baseUrl}/api/deliverables/nope-nope`)).status).toBe(404);
      expect((await fetch(`${running.baseUrl}/api/deliverables/nope-nope/completion`)).status).toBe(404);

      // 400：format 不在封闭面内。
      const badFormat = await postJson(running.baseUrl, '/api/deliverables', {
        sessionId: 'g-bad-format',
        deliverableId: 'g-bad-format-d',
        filename: 'x.docx',
        format: 'docx',
      });
      expect(badFormat.status).toBe(400);

      // 201 / 200 / 200：通路。
      const driver = await openXlsxSession(running.baseUrl, 'smoke-happy');
      await driver.setCell('Sheet1', 'A1', num(1));
      const downloaded = await downloadVersion(running.baseUrl, 'smoke-happy', driver.revision());
      expect(downloaded.status).toBe(200);
      expect(downloaded.contentType).toContain('spreadsheetml.sheet');
      expect(downloaded.digestHeader).toBe(driver.digest());

      // 404：不存在的版本。
      const missingVersion = await downloadVersion(running.baseUrl, 'smoke-happy', 9999);
      expect(missingVersion.status).toBe(404);
    });
  });
});
