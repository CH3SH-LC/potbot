/**
 * **PPT 同版事实交付的产品 HTTP 入口**定向用例（工作包 FA-PPT-FACTS-PRODUCT2）。
 *
 * ## 这个套件自带一个**独立 ZIP 解析器**（不 import `src/presentations` 的任何读部件实现）
 *
 * 交付端点声称"产出了一份可编辑 PPTX（N 页、含这些部件）"。如果拿 `src` 自己的读回实现去核对，
 * 就是**自我复述**。因此本文件从零写了一个最小 ZIP 读取器（EOCD → 中央目录 → 逐条本地头 →
 * 对 deflate 条目真解压），用它**独立**核对：
 *
 * - 部件的**存在性**（`[Content_Types].xml` / `_rels/.rels` / `ppt/presentation.xml`）；
 * - 页数（`ppt/slides/slideN.xml` 的条数，以及 `presentation.xml` 里 `p:sldId` 的出现次数）；
 * - 与响应里自报的 `slide_count` / `preview.slide_count` 是否**三方一致**。
 *
 * ## 每条纪律都配反向对照
 *
 * | 正向 | 反向对照（"看起来通过"的另一种必须被抓出来） |
 * |---|---|
 * | 三处同版 ⇒ 200 delivered | **图表用了旧版值 ⇒ 409 blocked，响应里一个字节都没有** |
 * | 改事实 8→10 只重写表格 / 图表页 | **无关页被重写 ⇒ `unrelated_slide_rewritten`** |
 * | 改事实后受影响页确实被重写 | **受影响页没被重写 ⇒ `affected_slide_not_rewritten`** |
 * | 有事实来源 ⇒ 出字节 | **缺事实来源 ⇒ 422，不编数字、不出字节**；**编出来的数 ⇒ 409 `value_mismatch`** |
 * | PDF 是**额外**产物 | **导出 PDF 后可编辑 PPTX 仍在（PDF 没有替代它）**，且两者页数相等 |
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - 本套件**没有**在任何 Android 真机 / Office 消费端打开过产物：所有"打开无修复提示""显示为同一个数"
 *   的断言一律**未验证**（响应里随 `unverified` 原样带出，本文件只断言这份清单存在且被带出）。
 * - 带图表的源在**交付**这一步会结构化 `invariant_violated`（导入层不建模图表）——这是已知边界，
 *   本文件把它当成**应当发生**的事实来断言，而不是当成通过。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import { inflateRawSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { EXPORT_INVARIANTS } from '../../../src/presentations/export-handoff.js';
import {
  PPT_FACTS_ROOT,
  PPT_FACTS_ROUTES,
  handlePptxFactsRequest,
  routePptxFactsRequest,
  type PptxFactsWireResponse,
} from './ppt-facts-product.js';

// ---------------------------------------------------------------------------
// 一、独立 ZIP 解析器（本套件自带；**不**复用 src 的任何读部件实现）
// ---------------------------------------------------------------------------

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressed_size: number;
  readonly uncompressed_size: number;
  readonly local_header_offset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function u16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function u32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

/** 从尾部扫出 EOCD（注释最长 65535，故最多回扫 65557 字节）。 */
function findEocd(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - 22 - 65535);
  for (let offset = buf.length - 22; offset >= earliest; offset -= 1) {
    if (u32(buf, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP 里找不到 EOCD：这不是一个 ZIP 容器');
}

/** 逐条读中央目录，并**逐条**核对本地文件头签名（真解析，不是只看文件名）。 */
function readZipDirectory(bytes: Uint8Array): readonly ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(buf);
  const total = u16(buf, eocd + 10);
  const start = u32(buf, eocd + 16);
  const entries: ZipEntry[] = [];
  let cursor = start;
  for (let index = 0; index < total; index += 1) {
    if (u32(buf, cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`第 ${String(index + 1)} 条中央目录项的签名不对（偏移 ${String(cursor)}）`);
    }
    const method = u16(buf, cursor + 10);
    const compressedSize = u32(buf, cursor + 20);
    const uncompressedSize = u32(buf, cursor + 24);
    const nameLength = u16(buf, cursor + 28);
    const extraLength = u16(buf, cursor + 30);
    const commentLength = u16(buf, cursor + 32);
    const localOffset = u32(buf, cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (u32(buf, localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`部件 ${name} 的本地文件头签名不对`);
    }
    entries.push(
      Object.freeze({
        name,
        method,
        compressed_size: compressedSize,
        uncompressed_size: uncompressedSize,
        local_header_offset: localOffset,
      }),
    );
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return Object.freeze(entries);
}

/** 取一个部件的内容（stored 直读 / deflate 真解压）。 */
function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Buffer {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = u16(buf, entry.local_header_offset + 26);
  const extraLength = u16(buf, entry.local_header_offset + 28);
  const dataStart = entry.local_header_offset + 30 + nameLength + extraLength;
  const raw = buf.subarray(dataStart, dataStart + entry.compressed_size);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`部件 ${entry.name} 用了未预期的压缩方法 ${String(entry.method)}`);
}

function entryNames(entries: readonly ZipEntry[]): readonly string[] {
  return entries.map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// 二、固定装置（确定性：无墙钟、无随机、无 IO）
// ---------------------------------------------------------------------------

const TASK = 'task-quarterly';
const HEADCOUNT = 'headcount';

/** 供请求用的原始 JSON 事实快照（**故意**用 JSON 形态，走产品入口的读取路径）。 */
function snapshotJson(revision: number, headcount: number): Record<string, unknown> {
  return {
    version: { task_id: TASK, task_revision: revision },
    entries: [
      {
        fact_key: HEADCOUNT,
        fact_ref: `${TASK}-headcount-r${String(revision)}`,
        value: { type: 'number', amount: headcount, unit: '人', currency: null },
      },
    ],
  };
}

/** r1：人数 8；r2：人数 10。 */
const R1 = snapshotJson(1, 8);
const R2 = snapshotJson(2, 10);
/** **编出来的**版本：8 与 10 都不是它的值（用于"编数字"的反向对照）。 */
const R_INVENTED = snapshotJson(7, 99);

const TABLE_SHAPE_ID = 20;
const CHART_SHAPE_ID = 30;

/**
 * 四页模板：1 封面（**无关页**：纯字面量）／2 正文（`fact` 引用）／3 表格／4 图表。
 *
 * 页序即 slide_id 顺序（1..4）：`addSlide` 从 1 起分配。
 */
const TEMPLATE_FULL = {
  presentation_id: 'deck-ppt-facts-product',
  title: '季度经营汇报',
  slides: [
    { kind: 'literal', title: '封面', text: '2026 年第三季度' },
    { kind: 'fact_text', title: '本季人数', fact_key: HEADCOUNT },
    {
      kind: 'table',
      title: '人数明细',
      shape_id: TABLE_SHAPE_ID,
      columns: [{ heading: '人数', fact_key: HEADCOUNT }],
    },
    {
      kind: 'chart',
      title: '人数趋势',
      shape_id: CHART_SHAPE_ID,
      chart_type: 'bar',
      categories: ['本季'],
      series: [{ name: '人数', fact_keys: [HEADCOUNT] }],
    },
  ],
} as const;

/** 三页模板（**不含图表**）：交付 / PDF 用例走它——图表包导入层读不回，交付必然结构化失败。 */
const TEMPLATE_TABLE = {
  presentation_id: 'deck-ppt-facts-product',
  title: '季度经营汇报',
  slides: [
    { kind: 'literal', title: '封面', text: '2026 年第三季度' },
    { kind: 'fact_text', title: '本季人数', fact_key: HEADCOUNT },
    {
      kind: 'table',
      title: '人数明细',
      shape_id: TABLE_SHAPE_ID,
      columns: [{ heading: '人数', fact_key: HEADCOUNT }],
    },
  ],
} as const;

/** 模板里各页的 slide_id（`addSlide` 从 1 起，页序 = 模板顺序）。 */
const COVER_SLIDE_ID = 1;
/** 正文（`fact` 引用）页。 */
const TEXT_SLIDE_ID = 2;
/** 表格页。 */
const TABLE_SLIDE_ID = 3;
/** 图表页。 */
const CHART_SLIDE_ID = 4;

/** 各端点成功响应的公共形状（只声明本套件真的会读的字段）。 */
interface ResponseBody {
  readonly ok: boolean;
  readonly status?: string;
  readonly http_status?: number;
  readonly delivery: Record<string, unknown>;
  readonly slide_ids?: readonly number[];
  readonly slide_ids_before?: readonly number[];
  readonly slide_ids_after?: readonly number[];
  readonly codes?: readonly string[];
  readonly audit?: Record<string, unknown>;
  readonly report_before?: Record<string, unknown>;
  readonly report_after?: Record<string, unknown>;
  readonly version_from?: Record<string, unknown>;
  readonly version_to?: Record<string, unknown>;
  readonly describe_after?: string;
}

function asBody(response: PptxFactsWireResponse): ResponseBody {
  return response.body as ResponseBody;
}

function callDeliver(payload: Record<string, unknown>): PptxFactsWireResponse {
  const response = routePptxFactsRequest({ method: 'POST', pathname: `${PPT_FACTS_ROOT}/deliver`, body: payload });
  expect(response).not.toBeNull();
  if (response === null) throw new Error('deliver 路由不存在');
  return response;
}

function callApply(payload: Record<string, unknown>): PptxFactsWireResponse {
  const response = routePptxFactsRequest({ method: 'POST', pathname: `${PPT_FACTS_ROOT}/apply-facts`, body: payload });
  if (response === null) throw new Error('apply-facts 路由不存在');
  return response;
}

function callAudit(payload: Record<string, unknown>): PptxFactsWireResponse {
  const response = routePptxFactsRequest({ method: 'POST', pathname: `${PPT_FACTS_ROOT}/audit`, body: payload });
  if (response === null) throw new Error('audit 路由不存在');
  return response;
}

function auditOf(body: ResponseBody): Record<string, unknown> {
  return body.audit ?? {};
}

function stringsOf(value: readonly string[] | undefined): readonly string[] {
  return value ?? [];
}

// ---------------------------------------------------------------------------
// 三、模板装配：模型层自证（页数由模板决定，不是固定两页）
// ---------------------------------------------------------------------------

describe('模板装配：页数与形状由模板决定', () => {
  it('四页模板 ⇒ 四个 slide_id（1..4），表格 / 图表落在模板声明的页上', () => {
    // 走模型层端点（`apply-facts`）：四页模板里"该被重写的页"正是第 3 页（表格）与第 4 页（图表），
    // 这同时证明两个形状被装配到了模板声明的位置（否则审计的 slot 不可能对上）。
    const response = callApply({ template: TEMPLATE_FULL, from: R1, to: R2 });
    const body = asBody(response);
    expect(response.status).toBe(200);
    expect(body.slide_ids_before).toEqual([1, 2, 3, 4]);
    expect(body.slide_ids_after).toEqual([1, 2, 3, 4]);
    const audit = auditOf(body);
    expect(audit['rewrite_expected_slide_ids']).toEqual([TABLE_SLIDE_ID, CHART_SLIDE_ID]);
  });

  it('空 slides ⇒ 400（页数由模板决定；本入口不替调用方决定页数）', () => {
    const response = callDeliver({ template: { slides: [] }, facts: { target: R2, history: [] } });
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('invalid_template');
  });

  it('同一 shape_id 出现两次 ⇒ 400（绑定按它定位，重号会让"绑到哪个形状"变成隐式选择）', () => {
    const response = callDeliver({
      template: {
        slides: [
          { kind: 'table', title: 'A', shape_id: TABLE_SHAPE_ID, columns: [{ heading: '人数', fact_key: HEADCOUNT }] },
          { kind: 'table', title: 'B', shape_id: TABLE_SHAPE_ID, columns: [{ heading: '人数', fact_key: HEADCOUNT }] },
        ],
      },
      facts: { target: R2, history: [] },
    });
    expect(response.status).toBe(400);
    expect((response.body as { message: string }).message).toContain('shape_id=');
  });
});

// ---------------------------------------------------------------------------
// 四、交付端点：可编辑 PPTX + 结构化一致性报告（**独立 ZIP 解析器**读回核对）
// ---------------------------------------------------------------------------

describe('交付端点：给定事实快照 + 模板 ⇒ 可编辑 PPTX + 一致性报告', () => {
  it('三处同版 ⇒ 200 delivered；独立 ZIP 解析器核对页数与部件，三方一致', () => {
    const response = callDeliver({ template: TEMPLATE_TABLE, facts: { target: R2, history: [R1] } });
    const body = asBody(response);
    expect(response.status).toBe(200);
    expect(body.delivery['status']).toBe('delivered');

    const report = body.delivery['report'] as Record<string, unknown>;
    expect(report['ok']).toBe(true);
    expect(report['counts']).toEqual({ text: 1, table: 1, chart: 0 });

    const pptx = body.delivery['editable_pptx'] as Record<string, unknown>;
    expect(pptx['editable']).toBe(true);
    expect(pptx['slide_count']).toBe(3);
    expect(Number(pptx['byte_length'])).toBeGreaterThan(0);

    // --- 独立解析（不走 src 的任何读部件实现）---
    const bytes = Buffer.from(String(pptx['base64']), 'base64');
    expect(bytes.byteLength).toBe(Number(pptx['byte_length']));
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const entries = readZipDirectory(bytes);
    const names = entryNames(entries);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('ppt/presentation.xml');

    const slideParts = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slideParts.length).toBe(3);
    expect(names.length).toBe(Number(pptx['entry_count']));

    // 真解压 `presentation.xml`：`p:sldId` 的出现次数 = 页数（与自报值三方一致）。
    const presentationXml = readZipEntry(
      bytes,
      entries.find((entry) => entry.name === 'ppt/presentation.xml') as ZipEntry,
    ).toString('utf8');
    expect(presentationXml.match(/<p:sldId /g)?.length ?? 0).toBe(3);

    const preview = body.delivery['preview'] as Record<string, unknown>;
    expect(preview['slide_count']).toBe(3);
    expect((preview['slides'] as readonly unknown[]).length).toBe(3);

    // 读回不变式**真跑了一次**（复用 export-handoff 的 reopenEditablePptx）。
    const readback = body.delivery['readback'] as Record<string, unknown>;
    expect(readback['openable']).toBe(true);
    expect(readback['editable']).toBe(true);
    expect(readback['slide_count']).toBe(3);

    // 不变式原样带出（**不另造**第二套）。
    expect(body.delivery['invariants']).toEqual([...EXPORT_INVARIANTS]);

    // 未验证清单必须随交付原样带出（真机 / Office 打开未验证）。
    const unverified = body.delivery['unverified'] as readonly { claim: string; status: string }[];
    expect(unverified.length).toBeGreaterThan(0);
    expect(unverified.every((claim) => claim.status === 'unverified')).toBe(true);
  });

  it('导出 PDF **不得替代** PPTX：两者同时在，页数相等，且字节容器互不相同', () => {
    const response = callDeliver({
      template: TEMPLATE_TABLE,
      facts: { target: R2, history: [R1] },
      want_pdf: true,
    });
    const body = asBody(response);
    expect(response.status).toBe(200);
    const delivery = body.delivery;
    expect(delivery['status']).toBe('delivered');

    const pptx = delivery['editable_pptx'] as Record<string, unknown>;
    const pdf = delivery['pdf'] as Record<string, unknown> | null;
    expect(pdf).not.toBeNull();
    if (pdf === null) throw new Error('want_pdf 时必须有 PDF 产物');
    expect(pptx['editable']).toBe(true);
    expect(pptx['slide_count']).toBe(3);
    expect(pdf['page_count']).toBe(pptx['slide_count']);

    const pptxBytes = Buffer.from(String(pptx['base64']), 'base64');
    const pdfBytes = Buffer.from(String(pdf['base64']), 'base64');
    expect(pptxBytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // PDF 的保真级别如实标注：不是"视觉保真导出"。
    expect(pdf['fidelity']).toBe('text_outline');
    expect(pdf['visual_fidelity_verified']).toBe(false);
    expect(pdf['font_embedding']).toBe('not_embedded');

    // 独立 ZIP 解析：PPTX 仍在且页数对得上（PDF 没有把它换掉）。
    expect(readZipDirectory(pptxBytes).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).length).toBe(3);
  });

  it('带图表的源：模型层同版判据成立，但"可编辑读回"这一步必然失败 ⇒ 422 invariant_violated（不假装可交付）', () => {
    const response = callDeliver({ template: TEMPLATE_FULL, facts: { target: R2, history: [R1] } });
    const body = asBody(response);
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe('ppt_facts_invariant_violated');
    // 一个字节都没有（它不被当成"可交付"）。
    expect((body.delivery as Record<string, unknown>)['editable_pptx']).toBeUndefined();
    expect((body.delivery as Record<string, unknown>)['bytes_emitted']).toBe(0);
    // 冲突报告此时应当是 ok（冲突与"读不回"是两回事，不得混为一谈）。
    const report = (body.delivery as Record<string, unknown>)['report'] as Record<string, unknown>;
    expect(report['ok']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 五、同版约束：三处数值不同版 ⇒ 判冲突并在**出字节之前**阻断
// ---------------------------------------------------------------------------

describe('同版约束：三处数值不同版本 ⇒ 判冲突并阻断', () => {
  it('表格 / 图表用的是旧版值（r1=8）而目标是 r2=10 ⇒ 409 `stale_fact_version`，且**一个字节都没有**', () => {
    const response = callDeliver({
      template: TEMPLATE_FULL,
      facts: { target: R2, history: [R1] },
      source_version: R1, // 模板里写死的值来自 r1：旧版事实没有跟着更新
    });
    const body = asBody(response);
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe('ppt_facts_conflict');

    const delivery = body.delivery as Record<string, unknown>;
    expect(delivery['status']).toBe('blocked');
    expect(delivery['bytes_emitted']).toBe(0);
    // 阻断发生在"出字节之前"：响应里**根本没有** editable_pptx 这个字段。
    expect(delivery['editable_pptx']).toBeUndefined();
    expect(delivery['pdf']).toBeUndefined();

    const report = delivery['report'] as Record<string, unknown>;
    expect(report['ok']).toBe(false);
    const conflicts = report['conflicts'] as readonly { kind: string; stale_version: unknown }[];
    expect(conflicts.map((conflict) => conflict.kind)).toContain('stale_fact_version');
    expect(conflicts.some((conflict) => conflict.stale_version !== null)).toBe(true);
    expect(String((body as unknown as { message: string }).message)).toContain('同一事实版本');
  });

  it('反向对照：写死的数与目标版本、任何已知历史版本都对不上 ⇒ `value_mismatch`（不得被误认成"某版旧值"）', () => {
    const response = callDeliver({
      template: TEMPLATE_FULL,
      facts: { target: R2, history: [R1] },
      source_version: R_INVENTED, // 99：既不是 r2 的 10，也不是 r1 的 8
    });
    const body = asBody(response);
    expect(response.status).toBe(409);
    const report = (body.delivery as Record<string, unknown>)['report'] as Record<string, unknown>;
    const conflicts = report['conflicts'] as readonly { kind: string; values: readonly number[] }[];
    expect(conflicts.map((conflict) => conflict.kind)).toContain('value_mismatch');
    expect(conflicts.some((conflict) => conflict.values.includes(99))).toBe(true);
    expect(conflicts.every((conflict) => conflict.kind !== 'stale_fact_version')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 六、改事实 8 → 10：只更新受影响处，无关页不重写
// ---------------------------------------------------------------------------

describe('改事实 8 → 10：只有受影响的正文 / 表格 / 图表被更新，无关页不重写', () => {
  it('apply-facts ⇒ audit.ok；被重写的是表格页与图表页，**封面（无关页）纹丝不动**', () => {
    const response = callApply({ template: TEMPLATE_FULL, from: R1, to: R2 });
    const body = asBody(response);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('applied');

    const audit = auditOf(body);
    expect(audit['ok']).toBe(true);
    expect(audit['violations']).toEqual([]);

    // 页集合没变（改事实不该增删页）。
    expect(body.slide_ids_before).toEqual([1, 2, 3, 4]);
    expect(body.slide_ids_after).toEqual([1, 2, 3, 4]);

    // **实际**被重写的页 = 表格页（表 20 的值 8 → 10）与图表页（嵌入数据 8 → 10）。
    expect(audit['rewritten_slide_ids']).toEqual([TABLE_SLIDE_ID, CHART_SLIDE_ID]);
    // **无关页**（封面）与正文页（fact 引用，模型不动）都没被重写。
    expect(audit['unchanged_slide_ids']).toEqual([COVER_SLIDE_ID, TEXT_SLIDE_ID]);
    expect(audit['unrelated_slide_ids']).toEqual([COVER_SLIDE_ID]);
    // 正文页的**求值结果**变了（模型不动、交付出来的数变了）——这正是"改事实"的正向形态。
    expect(audit['text_affected_slide_ids']).toEqual([TEXT_SLIDE_ID]);
    // 该改的两页确实在该改的名单里。
    expect(audit['rewrite_expected_slide_ids']).toEqual([TABLE_SLIDE_ID, CHART_SLIDE_ID]);

    // 改前 / 改后都保持了"同版"。
    expect((body.report_before as Record<string, unknown>)['ok']).toBe(true);
    expect((body.report_after as Record<string, unknown>)['ok']).toBe(true);
    expect(body.version_from).toEqual({ task_id: TASK, task_revision: 1 });
    expect(body.version_to).toEqual({ task_id: TASK, task_revision: 2 });
    expect(String(body.describe_after)).toContain('@r2');
  });

  it('反向对照②：受影响页**没被重写** ⇒ `affected_slide_not_rewritten`', () => {
    // 改后模型仍停在 r1（表格 / 图表的值还是 8），而事实版本已经到 r2。
    const response = callAudit({
      previous: R1,
      next: R2,
      before: { template: TEMPLATE_FULL, at: R1 },
      after: { template: TEMPLATE_FULL, at: R1 },
    });
    const body = asBody(response);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);

    const audit = auditOf(body);
    expect(audit['ok']).toBe(false);
    expect(stringsOf(body.codes)).toContain('affected_slide_not_rewritten');
    const violations = audit['violations'] as readonly { code: string; slide_id: number; detail: string }[];
    const codesBySlide = new Map(violations.map((violation) => [violation.slide_id, violation.code]));
    expect(codesBySlide.get(TABLE_SLIDE_ID)).toBe('affected_slide_not_rewritten');
    expect(codesBySlide.get(CHART_SLIDE_ID)).toBe('affected_slide_not_rewritten');
    expect(violations.every((violation) => violation.detail.length > 0)).toBe(true);
  });

  it('反向对照①：**无关页被重写** ⇒ `unrelated_slide_rewritten`', () => {
    // 改后模型把封面（无事实引用、无绑定对象）也改了：与本次事实更新无关，属于越界重写。
    const rewrittenCover = {
      ...TEMPLATE_FULL,
      slides: [
        { kind: 'literal', title: '封面', text: '2026 年第三季度（被重写）' },
        ...TEMPLATE_FULL.slides.slice(1),
      ],
    };
    const response = callAudit({
      previous: R1,
      next: R2,
      before: { template: TEMPLATE_FULL, at: R1 },
      after: { template: rewrittenCover, at: R2 },
    });
    const body = asBody(response);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(stringsOf(body.codes)).toContain('unrelated_slide_rewritten');

    const audit = auditOf(body);
    const violations = audit['violations'] as readonly { code: string; slide_id: number }[];
    expect(violations.some((violation) => violation.code === 'unrelated_slide_rewritten' && violation.slide_id === COVER_SLIDE_ID)).toBe(true);
    // 表格 / 图表页这次**确实**跟着更新了，因此不该报"漏改"。
    expect(stringsOf(body.codes)).not.toContain('affected_slide_not_rewritten');
  });
});

// ---------------------------------------------------------------------------
// 七、反向对照③：缺事实来源却编数字
// ---------------------------------------------------------------------------

describe('反向对照③：缺事实来源却编数字', () => {
  it('facts 缺失 ⇒ 422 结构化未就绪，**不渲染、不出字节**', () => {
    const response = callDeliver({ template: TEMPLATE_TABLE });
    expect(response.status).toBe(422);
    const body = response.body as Record<string, unknown>;
    expect(body['code']).toBe('ppt_facts_fact_source_missing');
    expect(body['bytes_emitted']).toBe(0);
    expect(body['delivery']).toBeUndefined();
    expect(String(body['unblocked_by'])).toContain('attach_facts');
  });

  it('facts 形状非法（同一键两条）⇒ 400，不让"用哪一条"变成隐式选择', () => {
    const response = callDeliver({
      template: TEMPLATE_TABLE,
      facts: {
        target: {
          version: { task_id: TASK, task_revision: 2 },
          entries: [
            { fact_key: HEADCOUNT, fact_ref: 'a', value: { type: 'number', amount: 10, unit: '人', currency: null } },
            { fact_key: HEADCOUNT, fact_ref: 'b', value: { type: 'number', amount: 12, unit: '人', currency: null } },
          ],
        },
        history: [],
      },
    });
    expect(response.status).toBe(400);
    expect((response.body as { code: string }).code).toBe('invalid_facts');
    expect(String((response.body as { message: string }).message)).toContain('出现两次');
  });

  it('模板引用了事实版本里没有的键 ⇒ 422，不把缺失折成 0', () => {
    const response = callDeliver({
      template: {
        slides: [{ kind: 'table', title: '人数', shape_id: TABLE_SHAPE_ID, columns: [{ heading: '人数', fact_key: 'nobody.counts.this' }] }],
      },
      facts: { target: R2, history: [R1] },
    });
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe('template_build_failed');
    expect((response.body as { message: string }).message).toContain('缺失不得当零');
  });
});

// ---------------------------------------------------------------------------
// 八、路由与真 HTTP（真起 node:http，核对状态码与 content-type）
// ---------------------------------------------------------------------------

describe('HTTP 挂载：状态码与内容类型', () => {
  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handlePptxFactsRequest({ req, res, url })) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"code":"not_found"}');
    })();
  });
  let base = '';
  let started = false;

  afterAll(async () => {
    if (started) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function ensureStarted(): Promise<string> {
    if (!started) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('测试服务器没有拿到端口');
      base = `http://127.0.0.1:${String(address.port)}`;
      started = true;
    }
    return base;
  }

  it('GET /status ⇒ 200，带路由清单与"不能做什么"的如实登记', async () => {
    const origin = await ensureStarted();
    const response = await fetch(`${origin}${PPT_FACTS_ROOT}/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['routes']).toEqual([...PPT_FACTS_ROUTES]);
    expect(body['invariants']).toEqual([...EXPORT_INVARIANTS]);
    expect((body['explicit_refusals'] as readonly string[]).length).toBeGreaterThanOrEqual(4);
  });

  it('POST /deliver ⇒ 真 HTTP 上 200 / 409 / 422 三种状态码各自成立', async () => {
    const origin = await ensureStarted();
    const post = async (payload: unknown): Promise<Response> =>
      fetch(`${origin}${PPT_FACTS_ROOT}/deliver`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const delivered = await post({ template: TEMPLATE_TABLE, facts: { target: R2, history: [R1] } });
    expect(delivered.status).toBe(200);
    const deliveredBody = (await delivered.json()) as ResponseBody;
    expect(deliveredBody.delivery['status']).toBe('delivered');

    const conflicted = await post({ template: TEMPLATE_TABLE, facts: { target: R2, history: [R1] }, source_version: R1 });
    expect(conflicted.status).toBe(409);

    const notReady = await post({ template: TEMPLATE_TABLE });
    expect(notReady.status).toBe(422);
  });

  it('非本前缀 ⇒ 本模块不接管（返回 false，让 http.ts 的既有分支继续）', async () => {
    const origin = await ensureStarted();
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('not_found');
  });

  it('deliver 只接受 POST ⇒ 405；未知子路径 ⇒ 404', async () => {
    const origin = await ensureStarted();
    const wrongMethod = await fetch(`${origin}${PPT_FACTS_ROOT}/deliver`);
    expect(wrongMethod.status).toBe(405);
    const unknown = routePptxFactsRequest({ method: 'GET', pathname: `${PPT_FACTS_ROOT}/nope`, body: null });
    expect(unknown?.status).toBe(404);
  });

  it('http.ts 已把本路由挂上（静态核对：挂载点在 /api/** 兜底 404 之前）', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(process.cwd(), 'apps', 'demo', 'server', 'http.ts'), 'utf8');
    const mountIndex = source.indexOf('handlePptxFactsRequest({ req, res, url })');
    const fallbackIndex = source.indexOf("pathname.startsWith('/api/')");
    expect(mountIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeLessThan(fallbackIndex);
  });
});
