/**
 * **XLSX 结构操作的产品 HTTP 入口**用例（工作包 FA-XLS-STRUCTURE-PRODUCT）。
 *
 * ## 这个文件要证明的事（每条配反向对照）
 *
 * | # | 正向 | 反向对照 |
 * |---|---|---|
 * | 1 | 冻结 / 合并 / 宽高 / 隐藏 / 自动调整 ⇒ 导出里**有**对应的 `<cols>/<col>` / `<row ht>` / `<row hidden>` / `<mergeCells>` / `<pane>` | **不做任何结构操作** ⇒ 导出里**零**这些元素 |
 * | 2 | 行列增删后**公式引用真的迁移**（`A1*2` → `A2*2` / `B1*2`，读自**真实字节**的 `<f>`） | 删中的引用**不伪造**：逐字保留 + `migration_blocked` 登记 |
 * | 3 | 复制 / 移动 / 重命名 / 整表隐藏写进 `xl/workbook.xml`（`state="hidden"`） | —— |
 * | 4 | 合并越界 / 重叠、删唯一表、非法宽高 ⇒ **具名拒绝**（422/404 + 稳定 code） | **拒绝发生在导出之前** ⇒ 拒绝响应**没有任何字节 / 摘要**（源零改动） |
 * | 5 | 真产品 HTTP（`createDemoServer` 真实装配）确实挂载 `/api/xls-structure/**` | 未知子路径仍如实 404 |
 *
 * ## 判据落在"**字节里有什么**"，用**本套件自带的独立 ZIP 解析器**
 *
 * 第 1–3 节的读回**不 import** 任何产品解析器：本文件从零写了一个最小 ZIP 读取器
 * （EOCD → 中央目录 → 逐条本地文件头 → 对 DEFLATE 条目真解压），只在**纯文本 XML** 上做正则取证，
 * 避免"自我复述"。第 4、5 节走真实路由 / 真实 `createDemoServer` 装配。
 *
 * ## ⚠️ 诚实边界（结果不得编造）
 *
 * - **真实消费端未验证**：没有 Excel / WPS / 安卓办公套件在位。本文件只证明"结构**真的写进了
 *   .xlsx 字节**"，不证明"消费端呈现得对"。仓库外的 `node main.js` + curl 冒烟在交付说明里单独回报。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSheet,
  createWorkbook,
  formulaValue,
  numberValue,
  setCellValue,
  writeWorkbookXlsx,
} from '../../../src/spreadsheets/index.js';
import { createDemoServer, type DemoServer } from './main.js';
import {
  StructureRejection,
  XLS_STRUCTURE_OPS,
  XLS_STRUCTURE_ROOT,
  buildStructure,
  handleXlsStructureRequest,
  isXlsStructurePath,
  routeXlsStructureRequest,
  scanWorkbookStructureBytes,
  writeWorkbookXlsxWithStructure,
} from './xls-structure-product.js';

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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SHEET = 'Sheet1';

/** 一张带公式（引用 A 列）的小表：行列增删后公式必须迁移。 */
function baseWorkbook(): Record<string, unknown> {
  return {
    sheets: [
      {
        name: SHEET,
        row_count: 20,
        column_count: 12,
        cells: [
          { ref: 'A1', number: 10 },
          { ref: 'A2', number: 20 },
          { ref: 'B1', text: '标题' },
          { ref: 'B2', formula: 'A1*2' },
          { ref: 'B3', formula: 'A2+1' },
        ],
      },
    ],
  };
}

interface Applied {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly parts: Map<string, string>;
}

function apply(body: Record<string, unknown>): Applied {
  const built = buildStructure(body);
  return {
    status: 200,
    body: {
      applied: built.applied,
      sheets: built.sheets,
      geometry: built.geometry,
      readBack: built.readBack,
      contentDigest: built.export.content_digest,
      byteLength: built.export.bytes.byteLength,
    },
    parts: unzipIndependently(built.export.bytes),
  };
}

function sheetXml(parts: Map<string, string>, index = 1): string {
  const xml = parts.get(`xl/worksheets/sheet${String(index)}.xml`);
  if (xml === undefined) throw new Error(`包里没有 sheet${String(index)}.xml`);
  return xml;
}

function workbookXml(parts: Map<string, string>): string {
  const xml = parts.get('xl/workbook.xml');
  if (xml === undefined) throw new Error('包里没有 xl/workbook.xml');
  return xml;
}

// ---------------------------------------------------------------------------
// 1. 反向对照 + 各能力的真实字节
// ---------------------------------------------------------------------------

describe('1. 真实字节：不做结构操作 ⇒ 零结构元素；做了 ⇒ 对应元素落进字节', () => {
  it('**反向对照**：ops 为空 ⇒ 导出里零 <cols> / <pane> / <mergeCells> / ht= / hidden=', () => {
    const { parts } = apply({ workbook: baseWorkbook(), ops: [] });
    const xml = sheetXml(parts);
    expect(xml).not.toContain('<cols');
    expect(xml).not.toContain('<pane');
    expect(xml).not.toContain('<mergeCells');
    expect(xml).not.toMatch(/<row[^>]*ht="/);
    expect(xml).not.toMatch(/<row[^>]*hidden=/);
    expect(workbookXml(parts)).not.toContain('state="hidden"');
  });

  it('冻结窗格 + 合并：<pane xSplit/ySplit> 与 <mergeCells> 落进真实字节', () => {
    const { parts, body } = apply({
      workbook: baseWorkbook(),
      ops: [
        { op: 'freeze_panes', sheet: SHEET, rows: 1, columns: 1 },
        { op: 'merge_cells', sheet: SHEET, range: 'A5:C5' },
      ],
    });
    const xml = sheetXml(parts);
    expect(xml).toContain('<pane');
    expect(xml).toMatch(/<pane[^>]*xSplit="1"/);
    expect(xml).toMatch(/<pane[^>]*ySplit="1"/);
    expect(xml).toContain('<mergeCells');
    expect(xml).toContain('ref="A5:C5"');
    const scan = body['readBack'] as Record<string, unknown>;
    const sheetScan = (scan['sheets'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(sheetScan['pane']).not.toBeNull();
    expect(sheetScan['merge_cells']).toEqual(['A5:C5']);
  });

  it('列宽 / 行高 / 隐藏行列 / 自动调整：<cols> 与行属性落进真实字节', () => {
    const { parts, body } = apply({
      workbook: baseWorkbook(),
      ops: [
        { op: 'set_column_width', sheet: SHEET, column: 'C', width: 18 },
        { op: 'auto_fit_column', sheet: SHEET, column: 'B' },
        { op: 'set_row_height', sheet: SHEET, row: 2, height: 30 },
        { op: 'set_rows_hidden', sheet: SHEET, at: 3, count: 1, hidden: true },
        { op: 'set_columns_hidden', sheet: SHEET, at: 4, count: 1, hidden: true },
      ],
    });
    const xml = sheetXml(parts);
    expect(xml).toContain('<cols');
    expect(xml).toMatch(/<col[^>]*min="2"[^>]*width="8.43"/); // auto_fit 的启发式结果
    expect(xml).toMatch(/<col[^>]*min="3"[^>]*width="18"/);
    expect(xml).toMatch(/<col[^>]*min="4"[^>]*hidden="1"/);
    expect(xml).toMatch(/<row r="2"[^>]*ht="30"/);
    expect(xml).toMatch(/<row r="2"[^>]*customHeight="1"/);
    expect(xml).toMatch(/<row r="3"[^>]*hidden="1"/);

    const scan = body['readBack'] as Record<string, unknown>;
    const sheetScan = (scan['sheets'] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(sheetScan['cols']).toHaveLength(3);
    expect(sheetScan['formatted_rows']).toEqual([
      expect.objectContaining({ r: 2, ht: 30, hidden: false }),
      expect.objectContaining({ r: 3, hidden: true }),
    ]);
    // 清几何的反向对照：撤销之后这些元素必须消失。
    const cleared = apply({
      workbook: baseWorkbook(),
      ops: [
        { op: 'set_column_width', sheet: SHEET, column: 'B', width: 18 },
        { op: 'set_column_width', sheet: SHEET, column: 'B', width: null },
        { op: 'set_row_height', sheet: SHEET, row: 2, height: 30 },
        { op: 'set_row_height', sheet: SHEET, row: 2, height: null },
      ],
    });
    expect(sheetXml(cleared.parts)).not.toContain('<cols');
    expect(sheetXml(cleared.parts)).not.toMatch(/<row[^>]*ht="/);
  });

  it('复制 / 移动 / 重命名 / 整表隐藏：xl/workbook.xml 里 state="hidden" 且表数正确', () => {
    const { parts, body } = apply({
      workbook: baseWorkbook(),
      ops: [
        { op: 'add_sheet', name: 'Sheet2' },
        { op: 'copy_sheet', sheet: SHEET, new_name: 'Sheet3' },
        { op: 'move_sheet', sheet: 'Sheet3', to_index: 0 },
        { op: 'rename_sheet', from: 'Sheet2', to: '数据' },
        { op: 'hide_sheet', sheet: '数据', hidden: true },
      ],
    });
    const wb = workbookXml(parts);
    expect(wb).toContain('state="hidden"');
    expect(wb).toContain('name="数据"');
    const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((match) => match[1]);
    // Sheet3 被移到下标 0 ⇒ 顺序是 Sheet3 / Sheet1 / 数据。
    expect(names).toEqual(['Sheet3', SHEET, '数据']);
    const scan = body['readBack'] as Record<string, unknown>;
    expect(scan['hidden_sheets']).toEqual(['数据']);
    expect((body['sheets'] as unknown[]).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. 公式引用迁移（读自真实字节的 <f>）
// ---------------------------------------------------------------------------

describe('2. 行列增删：公式引用真的迁移（断言落在真实字节的 <f> 上）', () => {
  it('插入一行 ⇒ B2 的 A1*2 迁移成 A2*2（单元格与公式一起动）', () => {
    const { parts } = apply({ workbook: baseWorkbook(), ops: [{ op: 'insert_rows', sheet: SHEET, at: 1, count: 1 }] });
    const xml = sheetXml(parts);
    expect(xml).toContain('<f>A2*2</f>');
    expect(xml).toContain('<f>A3+1</f>');
    expect(xml).not.toContain('<f>A1*2</f>');
    // 数值单元格也从 A1 挪到 A2。
    expect(xml).toMatch(/<c r="A2"><v>10<\/v>/);
  });

  it('插入一列 ⇒ B2 的 A1*2 迁移成 B1*2', () => {
    const { parts } = apply({
      workbook: baseWorkbook(),
      ops: [{ op: 'insert_columns', sheet: SHEET, at: 1, count: 1 }],
    });
    const xml = sheetXml(parts);
    expect(xml).toContain('<f>B1*2</f>');
    expect(xml).toContain('<f>B2+1</f>');
    expect(xml).not.toContain('<f>A1*2</f>');
  });

  it('删除一列（删中被引用列）⇒ **不伪造**：原文保留 + migration_blocked 登记', () => {
    const { body, parts } = apply({
      workbook: baseWorkbook(),
      ops: [{ op: 'delete_columns', sheet: SHEET, at: 1, count: 1 }],
    });
    // 原 B2（=A1*2）/ B3（=A2+1）迁到 A2 / A3；两者的引用都落在被删的 A 列里
    // ⇒ 公式原文**逐字保留** + 两处登记（不伪造一个新引用）。
    expect(sheetXml(parts)).toContain('<f>A1*2</f>');
    expect(sheetXml(parts)).toContain('<f>A2+1</f>');
    const sheets = body['sheets'] as Record<string, unknown>[];
    expect(sheets[0]?.['migration_blocked']).toEqual(['A2', 'A3']);
  });
});

// ---------------------------------------------------------------------------
// 3. 具名拒绝 + 源零改动
// ---------------------------------------------------------------------------

interface Rejected {
  readonly status: number;
  readonly code: string;
}

async function reject(body: Record<string, unknown>): Promise<Rejected> {
  const response = await routeXlsStructureRequest({ method: 'POST', pathname: `${XLS_STRUCTURE_ROOT}/apply`, body });
  if (response === null) throw new Error('路由未处理');
  const json = response.body as Record<string, unknown>;
  return { status: response.status, code: String(json['code']) };
}

describe('3. 具名拒绝：合并越界 / 重叠、删唯一表、非法宽高 ⇒ 源零改动', () => {
  it('合并越界 ⇒ 422 merge_out_of_bounds', async () => {
    const rejected = await reject({ workbook: baseWorkbook(), ops: [{ op: 'merge_cells', sheet: SHEET, range: 'A1:XFE1' }] });
    expect(rejected).toEqual({ status: 422, code: 'merge_out_of_bounds' });
  });

  it('合并重叠 ⇒ 422 merge_overlap', async () => {
    const rejected = await reject({
      workbook: baseWorkbook(),
      ops: [
        { op: 'merge_cells', sheet: SHEET, range: 'A5:C5' },
        { op: 'merge_cells', sheet: SHEET, range: 'B5:D5' },
      ],
    });
    expect(rejected).toEqual({ status: 422, code: 'merge_overlap' });
  });

  it('合并单格 ⇒ 422 merge_too_small', async () => {
    const rejected = await reject({ workbook: baseWorkbook(), ops: [{ op: 'merge_cells', sheet: SHEET, range: 'A5' }] });
    expect(rejected).toEqual({ status: 422, code: 'merge_too_small' });
  });

  it('删除唯一工作表 ⇒ 422 last_sheet_forbidden', async () => {
    const rejected = await reject({ workbook: baseWorkbook(), ops: [{ op: 'delete_sheet', sheet: SHEET }] });
    expect(rejected).toEqual({ status: 422, code: 'last_sheet_forbidden' });
  });

  it('非法宽高（0 / 负数）⇒ 422 invalid_size', async () => {
    expect(await reject({ workbook: baseWorkbook(), ops: [{ op: 'set_column_width', sheet: SHEET, column: 'B', width: 0 }] })).toEqual(
      { status: 422, code: 'invalid_size' },
    );
    expect(await reject({ workbook: baseWorkbook(), ops: [{ op: 'set_row_height', sheet: SHEET, row: 2, height: -5 }] })).toEqual(
      { status: 422, code: 'invalid_size' },
    );
  });

  it('未知工作表 ⇒ 404 sheet_not_found', async () => {
    const rejected = await reject({ workbook: baseWorkbook(), ops: [{ op: 'freeze_panes', sheet: '没有这张表', rows: 1 }] });
    expect(rejected).toEqual({ status: 404, code: 'sheet_not_found' });
  });

  it('**源零改动**：拒绝响应里没有任何字节 / 摘要；同一请求重放得到同一摘要', async () => {
    const rejected = await routeXlsStructureRequest({
      method: 'POST',
      pathname: `${XLS_STRUCTURE_ROOT}/apply`,
      body: {
        workbook: baseWorkbook(),
        ops: [
          { op: 'merge_cells', sheet: SHEET, range: 'A5:C5' },
          { op: 'merge_cells', sheet: SHEET, range: 'B5:D5' }, // 会被拒
        ],
      },
    });
    const json = rejected?.body as Record<string, unknown>;
    expect(json['bytesBase64']).toBeUndefined();
    expect(json['contentDigest']).toBeUndefined();

    // 只带合法 op 的请求两次 ⇒ 摘要相同（拒绝的批次没有污染任何共享状态）。
    const first = apply({ workbook: baseWorkbook(), ops: [{ op: 'merge_cells', sheet: SHEET, range: 'A5:C5' }] });
    const second = apply({ workbook: baseWorkbook(), ops: [{ op: 'merge_cells', sheet: SHEET, range: 'A5:C5' }] });
    expect(first.body['contentDigest']).toBe(second.body['contentDigest']);
  });

  it('内核拒绝（删除行列与合并区部分重叠）不失真：ValidationError ⇒ 422 invalid_operation', async () => {
    const built = buildStructure({
      workbook: baseWorkbook(),
      ops: [{ op: 'merge_cells', sheet: SHEET, range: 'A1:B3' }],
    });
    expect(built.export.bytes.byteLength).toBeGreaterThan(0);
    const rejected = await reject({
      workbook: baseWorkbook(),
      ops: [
        { op: 'merge_cells', sheet: SHEET, range: 'A1:B3' },
        { op: 'delete_rows', sheet: SHEET, at: 2, count: 1 }, // 与合并区部分重叠 ⇒ 内核显式阻塞
      ],
    });
    expect(rejected).toEqual({ status: 422, code: 'invalid_operation' });
  });
});

// ---------------------------------------------------------------------------
// 4. 纯路由与独立函数
// ---------------------------------------------------------------------------

describe('4. 纯路由：前缀判定 / status / 方法 / 未知路径', () => {
  it('isXlsStructurePath 只认本前缀（且不吞父级）', () => {
    expect(isXlsStructurePath(XLS_STRUCTURE_ROOT)).toBe(true);
    expect(isXlsStructurePath(`${XLS_STRUCTURE_ROOT}/apply`)).toBe(true);
    expect(isXlsStructurePath('/api/xls-facts')).toBe(false);
    expect(isXlsStructurePath('/api/xls-print/export')).toBe(false);
  });

  it('非本命名空间 ⇒ 路由返回 null（不误吞）', async () => {
    expect(await routeXlsStructureRequest({ method: 'GET', pathname: '/api/xls-facts', body: null })).toBeNull();
  });

  it('GET /status ⇒ 200，列出全部结构操作', async () => {
    const response = await routeXlsStructureRequest({ method: 'GET', pathname: `${XLS_STRUCTURE_ROOT}/status`, body: null });
    const json = response?.body as Record<string, unknown>;
    expect(response?.status).toBe(200);
    expect(json['ops']).toEqual(XLS_STRUCTURE_OPS);
  });

  it('未知子路径 ⇒ 404；GET /apply ⇒ 405', async () => {
    const missing = await routeXlsStructureRequest({ method: 'GET', pathname: `${XLS_STRUCTURE_ROOT}/nope`, body: null });
    expect(missing?.status).toBe(404);
    const wrongMethod = await routeXlsStructureRequest({ method: 'GET', pathname: `${XLS_STRUCTURE_ROOT}/apply`, body: null });
    expect(wrongMethod?.status).toBe(405);
  });

  it('**反向对照**：无几何的工作簿经本模块写出 ⇒ 与 writeWorkbookXlsx 逐字节相同', () => {
    let sheet = createSheet(SHEET);
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', formulaValue('A1+1'));
    const workbook = createWorkbook([sheet]);
    const direct = writeWorkbookXlsx(workbook);
    const withStructure = writeWorkbookXlsxWithStructure(workbook, new Map());
    expect(withStructure.content_digest).toBe(direct.content_digest);
    expect(withStructure.rewritten_parts).toEqual([]);
  });

  it('StructureRejection 带稳定 code（供 HTTP 层映射）', () => {
    const error = new StructureRejection('merge_overlap', '重叠');
    expect(error.code).toBe('merge_overlap');
    expect(error.name).toBe('StructureRejection');
  });

  it('scanWorkbookStructureBytes 对一份无结构字节读回零元素', () => {
    const scan = scanWorkbookStructureBytes(writeWorkbookXlsx(createWorkbook([createSheet(SHEET)])).bytes);
    expect(scan.hidden_sheets).toEqual([]);
    expect(scan.sheets[0]?.pane).toBeNull();
    expect(scan.sheets[0]?.merge_cells).toEqual([]);
    expect(scan.sheets[0]?.cols).toEqual([]);
    expect(scan.sheets[0]?.formatted_rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. 真产品 HTTP（createDemoServer 的真实装配）
// ---------------------------------------------------------------------------

interface Running {
  readonly baseUrl: string;
  readonly demo: DemoServer;
  close(): Promise<void>;
}

async function startProductServer(env: NodeJS.ProcessEnv): Promise<Running> {
  const demo = await createDemoServer(env);
  const server: Server = demo.server;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    demo,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined || error === null ? resolvePromise() : rejectPromise(error)));
      }),
  };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('5. 真产品 HTTP（createDemoServer 真实装配）：前缀真的被派发', () => {
  let workDir: string;
  let running: Running;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-xls-structure-http-'));
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

  it('GET /api/xls-structure/status ⇒ 200（新前缀没有落到 /api/** 兜底 404）', async () => {
    const response = await fetch(`${running.baseUrl}${XLS_STRUCTURE_ROOT}/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['root']).toBe(XLS_STRUCTURE_ROOT);
  });

  it('POST /api/xls-structure/apply ⇒ 200，返回真实 .xlsx 字节且读回有结构元素', async () => {
    const { status, json } = await postJson(running.baseUrl, `${XLS_STRUCTURE_ROOT}/apply`, {
      workbook: baseWorkbook(),
      ops: [
        { op: 'freeze_panes', sheet: SHEET, rows: 1, columns: 0 },
        { op: 'merge_cells', sheet: SHEET, range: 'A5:C5' },
        { op: 'set_row_height', sheet: SHEET, row: 2, height: 30 },
      ],
    });
    expect(status).toBe(200);
    const bytes = Buffer.from(String(json['bytesBase64']), 'base64');
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const parts = unzipIndependently(new Uint8Array(bytes));
    const xml = sheetXml(parts);
    expect(xml).toContain('<pane');
    expect(xml).toContain('<mergeCells');
    expect(xml).toMatch(/<row r="2"[^>]*ht="30"/);
  });

  it('未知子路径仍如实 404', async () => {
    const response = await fetch(`${running.baseUrl}${XLS_STRUCTURE_ROOT}/definitely-not-here`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe('not_found');
  });

  it('handleXlsStructureRequest 对非本前缀返回 false（挂载点不误吞）', async () => {
    const handled = await handleXlsStructureRequest({
      req: { method: 'GET' } as never,
      res: { writeHead: () => undefined, end: () => undefined } as never,
      url: new URL('http://127.0.0.1/api/xls-facts/status'),
    });
    expect(handled).toBe(false);
  });
});
