/**
 * 共享事实绑定的表格交付（`xls-facts-product.ts`）的定向套件（FA-XLS-FACTS-PRODUCT）。
 *
 * ## 本套件要证明的五件事（每条都有反向对照）
 *
 * 1. **事实绑定 + 只更新受影响格**：改一条共享事实 ⇒ 只有绑定它的格被改写，无关格一个都不动；
 *    公式闭包被重算、受影响的图表被点出、无关图表不出现。
 * 2. **真实字节**：交付的 .xlsx 由**本套件自带的独立 ZIP 解析器**（{@link unzipIndependently}）
 *    读回逐格核对——**不复用**产品自检器（`readWorkbookXlsx`），否则"自产自检"不算证据。
 * 3. **跨模板发布未接线 ⇒ 结构化 not-wired**：docx / pptx 逐目标给出 `wire_state` / `reason`，
 *    且 `claimed_published` **恒为字面量 `false`**。
 * 4. **三处数值必须同版本**：表格 / 文档 / 演示三处不一致 ⇒ **报冲突**，`resolved` 给 `null`，
 *    绝不静默取其一。
 * 5. **反向对照**：无关格被改、迟到版本被应用、无通道却宣称已发布 —— 三条都必须被检出。
 *
 * ## 真实 HTTP
 *
 * 第四节经 `createDemoRequestHandler` **in-process** 起 `node:http` 服务，证明 `/api/xls-facts/**`
 * 确实被产品入口挂载（不是 404、不是 500）。不跑全量、不跑 Gradle、不跑 live。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { inflateRawSync } from 'node:zlib';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import type {
  CellFactBinding,
  FactUpdateApplication,
  TemplatePublicationResult,
} from '../../../src/spreadsheets/facts-binding.js';
import type { ChartSpec } from '../../../src/spreadsheets/index.js';
import { JobIndex, createMemoryPersistence } from './jobs.js';
import { KernelHost } from './kernel.js';
import { createDemoRequestHandler } from './http.js';
import {
  FACT_CARRIERS,
  NO_CHANNEL_REASON,
  XLS_FACTS_MODULES_REACHABLE_BY_ROUTE,
  XLS_FACTS_ROOT,
  checkFactVersionConsistency,
  createXlsFactsHost,
  handleXlsFactsRequest,
  isXlsFactsPath,
  routeXlsFactsRequest,
  type CellInput,
  type XlsFactsChannelPort,
  type XlsFactsHost,
  type XlsFactsWireResponse,
} from './xls-facts-product.js';

const T = (n: number) => asLogicalTime(n);

// ---------------------------------------------------------------------------
// 独立 ZIP 解析器（**不复用**产品自检器；本套件自带）
// ---------------------------------------------------------------------------

interface ZipMember {
  readonly path: string;
  readonly data: Buffer;
}

/**
 * 一个**独立实现**的 ZIP 读取器：只依赖 Node 的 `node:zlib`（DEFLATE）与本地文件头 /
 * 中央目录的字节布局，**不 import** `src/artifacts/ooxml/zip-read.ts` 或任何产品解析器。
 *
 * 条目按中央目录逐条读；STORE（方法 0）取原字节，DEFLATE（方法 8）用 `inflateRawSync`。
 */
function unzipIndependently(bytes: Uint8Array): readonly ZipMember[] {
  const buffer = Buffer.from(bytes);
  // ① 从尾部找 EOCD（中央目录结束记录）。
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('独立解析器：找不到 ZIP 的 EOCD 记录');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  const members: ZipMember[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`独立解析器：第 ${String(index)} 条中央目录项签名不符`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`独立解析器：条目 ${path} 的本地文件头签名不符`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    members.push({ path, data });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

/** 独立解析器：把一份 .xlsx 的工作表部件读成 `A1 → {t, value}`（inlineStr / 数值 / 公式缓存）。 */
function readSheetCellsIndependently(bytes: Uint8Array, partPath: string): Map<string, { t: string | null; value: string }> {
  const member = unzipIndependently(bytes).find((item) => item.path === partPath);
  if (member === undefined) throw new Error(`独立解析器：包里没有部件 ${partPath}`);
  const xml = member.data.toString('utf8');
  const cells = new Map<string, { t: string | null; value: string }>();
  const cellPattern = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(xml)) !== null) {
    const attributes = match[1] ?? '';
    const inner = match[2] ?? '';
    const ref = /\br="([A-Z]+[0-9]+)"/.exec(attributes)?.[1];
    if (ref === undefined) continue;
    const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? null;
    let value = '';
    const inline = /<is>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/is>/.exec(inner);
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
    if (inline !== null) value = inline[1] ?? '';
    else if (v !== null) value = v[1] ?? '';
    cells.set(ref, { t: type, value });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BASE_CELLS: readonly CellInput[] = [
  { sheet: '预算', address: 'A1', value: { kind: 'number', value: 10 } },
  { sheet: '预算', address: 'A2', value: { kind: 'number', value: 100 } },
  { sheet: '预算', address: 'A3', value: { kind: 'formula', text: '=A1*A2' } },
  { sheet: '预算', address: 'B1', value: { kind: 'text', value: '不受影响' } },
  { sheet: '预算', address: 'B2', value: { kind: 'number', value: 7 } },
];

const BASE_BINDINGS: readonly CellFactBinding[] = [
  { sheet: '预算', ref: 'A1', fact_key: 'headcount', version: 1 },
  { sheet: '预算', ref: 'A2', fact_key: 'unit_price', version: 1 },
];

const BASE_CHARTS: readonly ChartSpec[] = [
  { name: 'c_affected', kind: 'column', series: [{ values: { sheet: '预算', range: 'A1' } }] },
  { name: 'c_untouched', kind: 'column', series: [{ values: { sheet: '预算', range: 'B2' } }] },
];

function newSessionBody(sessionId: string): Parameters<XlsFactsHost['createSession']>[0] {
  return {
    sessionId,
    sheets: ['预算'],
    cells: BASE_CELLS,
    bindings: BASE_BINDINGS,
    charts: BASE_CHARTS,
  };
}

/** 建一个"产品形状"的会话（无发布通道）。 */
function freshHost(): XlsFactsHost {
  const host = createXlsFactsHost({});
  host.createSession(newSessionBody('s-product'));
  return host;
}

async function call(
  host: XlsFactsHost,
  method: string,
  path: string,
  body?: unknown,
): Promise<XlsFactsWireResponse | null> {
  const url = new URL(`http://xls-facts.test${path}`);
  return routeXlsFactsRequest(
    { method, pathname: url.pathname, query: url.searchParams, body: body ?? null },
    host,
  );
}

function bodyOf(response: XlsFactsWireResponse | null): Record<string, unknown> {
  expect(response).not.toBeNull();
  return (response as XlsFactsWireResponse).body as Record<string, unknown>;
}

/** 应用一条 headcount 更新，返回内核报告（HTTP 形状）。 */
async function applyHeadcount(
  host: XlsFactsHost,
  sessionId: string,
  version: number,
  value: number,
): Promise<Record<string, unknown>> {
  const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/${sessionId}/facts`, {
    updates: [{ fact_key: 'headcount', version, value: { kind: 'number', value }, source: '用户改口', at: 100 + version }],
  });
  expect(response?.status).toBe(200);
  return bodyOf(response);
}

// ---------------------------------------------------------------------------
// A. 可达性 + 纯路由
// ---------------------------------------------------------------------------

describe('A. 可达性与就绪探针', () => {
  it('前缀识别 + 内核模块可达性自证', () => {
    expect(isXlsFactsPath(XLS_FACTS_ROOT)).toBe(true);
    expect(isXlsFactsPath(`${XLS_FACTS_ROOT}/sessions`)).toBe(true);
    expect(isXlsFactsPath('/api/other')).toBe(false);
    expect(XLS_FACTS_MODULES_REACHABLE_BY_ROUTE).toContain('src/spreadsheets/facts-binding.ts');
    expect(XLS_FACTS_MODULES_REACHABLE_BY_ROUTE).toContain('src/spreadsheets/package-assembly.ts');
  });

  it('/status 就绪，两个目标都如实未接线（不假装可用）', async () => {
    const host = createXlsFactsHost({});
    const response = await call(host, 'GET', `${XLS_FACTS_ROOT}/status`);
    const body = bodyOf(response);
    expect(response?.status).toBe(200);
    expect(body['ready']).toBe(true);
    expect(body['root']).toBe(XLS_FACTS_ROOT);
    expect(body['unwired_targets']).toEqual(['docx', 'pptx']);
    expect(body['note']).toBe(NO_CHANNEL_REASON);
  });
});

// ---------------------------------------------------------------------------
// B. 事实绑定 + 只更新受影响格 / 公式 / 图表
// ---------------------------------------------------------------------------

describe('B. 改共享事实：只更新受影响格 / 公式 / 图表', () => {
  it('改写绑定格、重算闭包、点出受影响图表；无关格与无关图表一字不动', async () => {
    const host = freshHost();

    // 反向对照①：把 A1 绑到不存在的表 ⇒ 显式 422，不静默通过。
    const dangling = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-product/bind`, {
      sheet: '不存在的表',
      ref: 'A1',
      fact_key: 'x',
      version: 1,
    });
    expect(dangling?.status).toBe(422);

    const report = await applyHeadcount(host, 's-product', 2, 12);

    expect(report['applied_fact_keys']).toEqual(['headcount']);
    expect(report['rewritten_cell_keys']).toEqual(['预算!A1']);
    // 无关格清单是机器可读的：另一个绑定格 A2 与未绑定格 B1 / B2 都在里面。
    expect(report['untouched_bound_cell_keys']).toEqual(['预算!A2']);
    expect(report['untouched_cell_keys']).toContain('预算!B1');
    expect(report['untouched_cell_keys']).toContain('预算!B2');
    expect(report['untouched_cell_keys']).not.toContain('预算!A1');
    // 公式闭包：A3 = A1*A2 依赖被改写格 ⇒ 重算；受影响图表只有引用 A1 的那张。
    expect(report['recalculated_formula_keys']).toContain('预算!A3');
    expect(report['affected_charts']).toEqual(['预算!c_affected']);
    expect(report['untouched_charts']).toEqual(['预算!c_untouched']);
    expect(report['rejected']).toEqual([]);
  });

  it('绑定到公式格的误绑：显式失败（不就近套用）', async () => {
    const host = createXlsFactsHost({});
    host.createSession({
      sessionId: 's-misbind',
      sheets: ['S'],
      cells: [{ sheet: 'S', address: 'A1', value: { kind: 'formula', text: '=1+1' } }],
      bindings: [{ sheet: 'S', ref: 'A1', fact_key: 'bad', version: 1 }],
    } satisfies Parameters<XlsFactsHost['createSession']>[0]);
    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-misbind/facts`, {
      updates: [{ fact_key: 'bad', version: 2, value: { kind: 'number', value: 5 }, source: 'x', at: 1 }],
    });
    expect(response?.status).toBe(422);
    expect((bodyOf(response)['code'] as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C. 真实字节：独立 ZIP 解析器读回
// ---------------------------------------------------------------------------

describe('C. 交付真实字节：本套件独立 ZIP 解析器读回核对', () => {
  it('交付的 .xlsx 解开后，绑定格 / 无关格 / 公式缓存 / 图表部件都在', async () => {
    const host = freshHost();
    await applyHeadcount(host, 's-product', 2, 12);
    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-product/deliver`);
    expect(response?.status).toBe(200);
    const body = bodyOf(response);
    expect(body['binding_metadata_persisted']).toBe(false);

    const base64 = body['fileBase64'] as string;
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    expect(bytes.byteLength).toBe(body['byteLength']);

    // ① 独立解析 ZIP：条目表里有工作表部件与图表部件。
    const members = unzipIndependently(bytes);
    const paths = members.map((member) => member.path);
    expect(paths).toContain('xl/worksheets/sheet1.xml');
    expect(paths.some((path) => path.startsWith('xl/charts/'))).toBe(true);

    // ② 逐格核对：改写后的绑定格、未改的绑定格、公式缓存、无关格。
    const cells = readSheetCellsIndependently(bytes, 'xl/worksheets/sheet1.xml');
    expect(cells.get('A1')?.value).toBe('12'); // headcount 已更新
    expect(cells.get('A2')?.value).toBe('100'); // unit_price 未动
    expect(cells.get('A3')?.value).toBe('1200'); // 公式闭包缓存在容器里
    expect(cells.get('B1')).toEqual({ t: 'inlineStr', value: '不受影响' });
    expect(cells.get('B2')?.value).toBe('7');
  });

  it('反向对照：无图表时交付字节里一个图表部件都没有', async () => {
    const host = createXlsFactsHost({});
    host.createSession({
      sessionId: 's-no-chart',
      sheets: ['S'],
      cells: [{ sheet: 'S', address: 'A1', value: { kind: 'number', value: 1 } }],
    });
    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-no-chart/deliver`);
    const bytes = new Uint8Array(Buffer.from(bodyOf(response)['fileBase64'] as string, 'base64'));
    const paths = unzipIndependently(bytes).map((member) => member.path);
    expect(paths.some((path) => path.startsWith('xl/charts/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. 跨模板发布：未接线 ⇒ 结构化 not-wired，claimed_published 恒 false
// ---------------------------------------------------------------------------

describe('D. 跨模板发布：未接线 ⇒ 结构化 not-wired', () => {
  it('产品宿（无通道）：docx / pptx 逐目标 not-wired，claimed_published 恒 false', async () => {
    const host = freshHost();
    await applyHeadcount(host, 's-product', 2, 12);
    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-product/publish`, {
      factKeys: ['headcount'],
      artifactRevision: 'rev-1',
    });
    expect(response?.status).toBe(200);
    const body = bodyOf(response);
    expect(body['unwiredTargets']).toEqual(['docx', 'pptx']);
    expect(body['claimedPublished']).toBe(false);
    const results = body['results'] as TemplatePublicationResult[];
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.wire_state).toBe('not-wired');
      expect(result.acknowledged).toBe(false);
      expect(result.claimed_published).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(typeof result.reason).toBe('string');
    }
  });

  it('接线替身：即便通道给回执，claimed_published 仍恒 false；通道报旧版本 ⇒ 一致性抓得到', async () => {
    const docxChannel: XlsFactsChannelPort = {
      target: 'docx',
      publish: async () => ({ ok: true, receipt_ref: 'docx-receipt-1' }),
      carrier_version: (factKey) => (factKey === 'headcount' ? 2 : null),
    };
    // pptx 通道故意"停在上一个版本"：spreadsheet=headcount v2，pptx 仍 v1。
    const pptxChannel: XlsFactsChannelPort = {
      target: 'pptx',
      publish: async () => ({ ok: true, receipt_ref: 'pptx-receipt-1' }),
      carrier_version: (factKey) => (factKey === 'headcount' ? 1 : null),
    };
    const host = createXlsFactsHost({ channels: [docxChannel, pptxChannel] });
    host.createSession(newSessionBody('s-wired'));
    await applyHeadcount(host, 's-wired', 2, 12);

    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-wired/publish`, {
      factKeys: ['headcount'],
      artifactRevision: 'rev-1',
    });
    const body = bodyOf(response);
    expect(body['unwiredTargets']).toEqual([]);
    expect(body['claimedPublished']).toBe(false);
    const results = body['results'] as TemplatePublicationResult[];
    for (const result of results) {
      expect(result.wire_state).toBe('published');
      expect(result.acknowledged).toBe(true);
      expect(result.claimed_published).toBe(false); // 有回执也不宣称"已生效"
    }
    // 三处版本不一致（表格 v2 / docx v2 / pptx v1）⇒ 报冲突。
    const consistency = body['consistency'] as { consistent: boolean; conflicts: { fact_key: string }[] };
    expect(consistency.consistent).toBe(false);
    expect(consistency.conflicts.map((entry) => entry.fact_key)).toEqual(['headcount']);
  });
});

// ---------------------------------------------------------------------------
// E. 三处数值同版本：一致性核对（不同版本 ⇒ 报冲突，不静默取其一）
// ---------------------------------------------------------------------------

describe('E. 三处数值必须同版本', () => {
  it('checkFactVersionConsistency：一致 / 冲突 / 单载体不可比', () => {
    const consistent = checkFactVersionConsistency([
      { carrier: 'spreadsheet', fact_key: 'headcount', version: 2 },
      { carrier: 'docx', fact_key: 'headcount', version: 2 },
      { carrier: 'pptx', fact_key: 'headcount', version: 2 },
    ]);
    expect(consistent.consistent).toBe(true);
    expect(consistent.conflicts).toEqual([]);
    expect(consistent.resolved['headcount']).toBe(2);

    const conflicted = checkFactVersionConsistency([
      { carrier: 'spreadsheet', fact_key: 'headcount', version: 2 },
      { carrier: 'docx', fact_key: 'headcount', version: 2 },
      { carrier: 'pptx', fact_key: 'headcount', version: 1 },
    ]);
    expect(conflicted.consistent).toBe(false);
    expect(conflicted.conflicts).toHaveLength(1);
    // **绝不静默取其一**：冲突事实的 resolved 必须是 null。
    expect(conflicted.resolved['headcount']).toBeNull();

    const single = checkFactVersionConsistency([
      { carrier: 'spreadsheet', fact_key: 'headcount', version: 2 },
    ]);
    expect(single.consistent).toBe(true); // 没有"冲突"，但…
    expect(single.uncomparable_fact_keys).toEqual(['headcount']); // …也不能冒充三方一致
  });

  it('HTTP：三处载体不一致 ⇒ 报冲突；一致 ⇒ resolved 给版本', async () => {
    const host = freshHost();
    await applyHeadcount(host, 's-product', 2, 12);

    const conflicted = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-product/consistency`, {
      carriers: [
        { carrier: 'docx', fact_key: 'headcount', version: 2 },
        { carrier: 'pptx', fact_key: 'headcount', version: 3 },
      ],
    });
    expect(conflicted?.status).toBe(200);
    const conflictBody = bodyOf(conflicted);
    expect(conflictBody['consistent']).toBe(false);
    expect((conflictBody['conflicts'] as { fact_key: string }[]).map((entry) => entry.fact_key)).toEqual([
      'headcount',
    ]);
    expect((conflictBody['resolved'] as Record<string, number | null>)['headcount']).toBeNull();
    expect(FACT_CARRIERS).toEqual(['spreadsheet', 'docx', 'pptx']);

    const same = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-product/consistency`, {
      carriers: [
        { carrier: 'docx', fact_key: 'headcount', version: 2 },
        { carrier: 'pptx', fact_key: 'headcount', version: 2 },
      ],
    });
    expect(bodyOf(same)['consistent']).toBe(true);
    expect((bodyOf(same)['resolved'] as Record<string, number | null>)['headcount']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F. 反向对照：三条违规都必须被检出
// ---------------------------------------------------------------------------

describe('F. 反向对照：应然 vs 实然', () => {
  it('无关格被改 / 迟到版本被应用 / 无通道却宣称已发布 —— 三条都被检出', async () => {
    const host = createXlsFactsHost({});
    host.createSession({
      sessionId: 's-reverse',
      sheets: ['预算'],
      cells: BASE_CELLS,
      bindings: [{ sheet: '预算', ref: 'A1', fact_key: 'headcount', version: 3 }],
      charts: BASE_CHARTS,
    });

    // 先制造一条**被拒**（迟到）的更新，作为"迟到版本被应用"的反向对照素材。
    const report = (await applyHeadcount(host, 's-reverse', 2, 999)) as unknown as FactUpdateApplication;
    expect(report.applied_fact_keys).toEqual([]);
    expect(report.rejected[0]?.fact_key).toBe('headcount');
    expect(report.rejected[0]?.code).toBe('stale_version');

    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-reverse/verify`, {
      // 实然①：B1 是无关格，却被"写了"。
      rewritten_cell_keys: ['预算!A1', '预算!B1'],
      // 实然②：迟到的 headcount 更新被"应用了"。
      applied_fact_keys: ['headcount'],
      // 实然③：docx 通道未接线（not-wired），却宣称已发布。
      publication_claims: [{ target: 'docx', claimed_published: true, wire_state: 'not-wired' }],
    });
    expect(response?.status).toBe(200);
    const codes = (bodyOf(response)['violations'] as { code: string }[]).map((entry) => entry.code);
    expect(codes).toContain('unrelated_cell_rewritten');
    expect(codes).toContain('stale_update_applied');
    expect(codes).toContain('claimed_published_without_wire');
  });

  it('忠实实现 ⇒ 违规列表为空（一次正确应用）', async () => {
    const host = freshHost();
    await applyHeadcount(host, 's-product', 2, 12);
    const response = await call(host, 'POST', `${XLS_FACTS_ROOT}/sessions/s-product/verify`, {
      rewritten_cell_keys: ['预算!A1'],
      applied_fact_keys: [],
      publication_claims: [{ target: 'docx', claimed_published: false, wire_state: 'not-wired' }],
    });
    expect(bodyOf(response)['violations']).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G. 真实 HTTP：经 createDemoRequestHandler 起服务（产品入口确实挂载）
// ---------------------------------------------------------------------------

interface Running {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startBare(workDir: string): Promise<Running> {
  const jobs = new JobIndex({ persistence: createMemoryPersistence(), runId: 'XLS-FACTS-BARE' });
  const host = new KernelHost({
    jobs,
    runDir: workDir,
    artifactRootDir: workDir.split('\\').join('/'),
    model: null,
    modelIsLive: false,
    documents: null,
    buildId: 'xls-facts-bare',
  });
  const server: Server = createServer(createDemoRequestHandler({ host, webDir: join(workDir, 'web') }));
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error === undefined || error === null ? resolvePromise() : reject(error)));
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

describe('G. 真实 HTTP：/api/xls-facts/** 确实被产品入口挂载', () => {
  let workDir: string;
  let running: Running;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-xls-facts-'));
    running = await startBare(workDir);
  });

  afterAll(async () => {
    if (running !== undefined) await running.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('状态码：status 200 / 建会话 201 / facts 200 / deliver 200 / 未知子路径 404', async () => {
    const status = await fetch(`${running.baseUrl}${XLS_FACTS_ROOT}/status`);
    expect(status.status).toBe(200);

    const created = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions`, newSessionBody('s-http'));
    expect(created.status).toBe(201);
    expect(created.json['sessionId']).toBe('s-http');

    const facts = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions/s-http/facts`, {
      updates: [{ fact_key: 'headcount', version: 2, value: { kind: 'number', value: 12 }, source: '用户改口', at: 7 }],
    });
    expect(facts.status).toBe(200);
    expect(facts.json['rewritten_cell_keys']).toEqual(['预算!A1']);

    const delivered = await postJson(running.baseUrl, `${XLS_FACTS_ROOT}/sessions/s-http/deliver`, {});
    expect(delivered.status).toBe(200);
    const bytes = new Uint8Array(Buffer.from(delivered.json['fileBase64'] as string, 'base64'));
    expect(readSheetCellsIndependently(bytes, 'xl/worksheets/sheet1.xml').get('A1')?.value).toBe('12');

    const missing = await fetch(`${running.baseUrl}${XLS_FACTS_ROOT}/sessions/s-http/nope`);
    expect(missing.status).toBe(404);
  });

  it('既有路径不变：/health 200，/api/** 兜底 404', async () => {
    expect((await fetch(`${running.baseUrl}/health`)).status).toBe(200);
    const missing = await fetch(`${running.baseUrl}/api/definitely-not-a-route`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as Record<string, unknown>)['code']).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// H. 直接盯住 handleXlsFactsRequest 的布尔契约（非本前缀 ⇒ false）
// ---------------------------------------------------------------------------

describe('H. node:http 适配器的布尔契约', () => {
  it('非本前缀返回 false（不吞掉其它路由）', async () => {
    const host = createXlsFactsHost({});
    const handled = await handleXlsFactsRequest(
      { req: {} as never, res: {} as never, url: new URL('http://x/other') },
      host,
    );
    expect(handled).toBe(false);
  });
});
