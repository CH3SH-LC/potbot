/**
 * 工作包 **FA-DELIVERABLE-INPUT-BYTES** —— `POST /api/deliverables` 的 `fileBase64`
 * **不得被静默丢弃**。
 *
 * ## 被证实的缺口（`fa/prod-depth-f` 实测；本套件改前逐条复现为红）
 *
 * `fileBase64` 经 HTTP 解码后确实传进了宿主（`deliverables.open({ bytes })`），但宿主
 * `#openWith` **只按 `format` 建空白源**，`input.bytes` 从未被读取 ⇒ 改**前**本套件实测：
 * 一份真 DOCX 当 XLSX 送进去返回 **201**，且起始摘要 = `2a1e0254406d4025a4b86ecac77…`
 * ——与**空白 xlsx 逐字节一致**。内容被**静默丢弃**（不是报错）。
 *
 * 它**不构成跨格式冒充**（产物仍是真 xlsx，安全性质成立），但属**潜在"假成功"**：
 * 调用方以为自己的字节被吸收了，实际上一个字都没进去。
 *
 * ## 本套件钉住的纪律（改后行为）
 *
 * | 输入 | 要求 |
 * |---|---|
 * | 非空 `fileBase64` 且与该格式相符 | **真吸收**：走既有导入链（`DeliverableSession.importBytes`），`sourceKind='imported'`、`sourceDigest` = 上传字节摘要 |
 * | 非空 `fileBase64` 但格式不符 | **具名 4xx**（`import_failed` → 400），**绝不**退化成空白源 |
 * | 不带 `fileBase64` | **行为不变**：仍建空白源 |
 *
 * ## 诚实边界
 *
 * - 全部断言经**产品入口** `createDemoServer`（真 Host + 真落盘 FileStore）走真实 HTTP。
 * - 本套件**不跑全量套件**、**不调用真实模型**（模型一律未配置 ⇒ 如实为 `null`）。
 * - 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';

import {
  getJson,
  postJson,
  startProduct,
  type Json,
  type RunningProduct,
} from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 夹具 / 小工具
// ---------------------------------------------------------------------------

/** 一份真实的、非空 DOCX（用于"格式不符"路径）。 */
function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '交付入口字节套件文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: 'FA-DELIVERABLE-INPUT-BYTES 夹具' }],
  }).bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function statusIs(response: { status: number; json: Json }, expected: number): void {
  expect(response.status, JSON.stringify(response.json)).toBe(expected);
}

interface Download {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

async function download(baseUrl: string, path: string): Promise<Download> {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/**
 * 经**产品 HTTP** 交付一版非空白 xlsx，返回其下载字节。
 *
 * 为什么要先交付一份再拿它的字节日志：`fileBase64` 的"真吸收"必须用一份**与宿主空白源
 * 摘要不同**的字节来证明——否则"摘要相等"既可能是吸收成功，也可能是压根没读（正是本 bug）。
 */
async function deliverNonBlankXlsx(
  baseUrl: string,
  sessionId: string,
  deliverableId: string,
): Promise<Uint8Array> {
  const created = await postJson(baseUrl, '/api/deliverables', {
    sessionId,
    deliverableId,
    filename: '导入源.xlsx',
    format: 'xlsx',
  });
  statusIs(created, 201);
  statusIs(
    await postJson(baseUrl, `/api/deliverables/${sessionId}/edits`, {
      idempotencyKey: `${sessionId}-1`,
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_sheet', name: '明细' },
    }),
    200,
  );
  const got = await download(baseUrl, `/api/deliverables/${sessionId}/versions/1/download`);
  expect(got.status, '交付源必须能下载回字节').toBe(200);
  return got.bytes;
}

async function deliverNonBlankPptx(
  baseUrl: string,
  sessionId: string,
  deliverableId: string,
): Promise<Uint8Array> {
  const created = await postJson(baseUrl, '/api/deliverables', {
    sessionId,
    deliverableId,
    filename: '导入源.pptx',
    format: 'pptx',
  });
  statusIs(created, 201);
  statusIs(
    await postJson(baseUrl, `/api/deliverables/${sessionId}/edits`, {
      idempotencyKey: `${sessionId}-1`,
      baseRevision: created.json['editRevision'],
      baseDigest: created.json['contentDigest'],
      edit: { op: 'add_slide', title: '封面' },
    }),
    200,
  );
  const got = await download(baseUrl, `/api/deliverables/${sessionId}/versions/1/download`);
  expect(got.status, '交付源必须能下载回字节').toBe(200);
  return got.bytes;
}

// ---------------------------------------------------------------------------
// 主服务
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-dib-'));
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// 主判据：非空 fileBase64 必须被**真吸收**
// ===========================================================================

describe('非空 fileBase64：与格式相符时必须被真吸收（不得静默丢弃）', () => {
  it('XLSX：导入一份非空白 .xlsx ⇒ sourceKind=imported、sourceDigest=上传字节摘要，且与空白源**不同**', async () => {
    const delivered = await deliverNonBlankXlsx(main.baseUrl, 'dib-src-xlsx', 'd-dib-src-xlsx');
    const deliveredDigest = sha256(delivered);

    // 空白对照（同一格式，不带 fileBase64）。
    const blank = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-blank-xlsx',
      deliverableId: 'd-dib-blank-xlsx',
      filename: '空白对照.xlsx',
      format: 'xlsx',
    });
    statusIs(blank, 201);
    const blankDigest = blank.json['contentDigest'];
    // 先证明"非空白"这条对照本身有效：两份字节确实不同。
    expect(blankDigest, '非空白源与空白源的摘要必须不同（否则本对照无效）').not.toBe(deliveredDigest);

    // 真吸收：把交付字节当导入源送进新会话。
    const imported = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-import-xlsx',
      deliverableId: 'd-dib-import-xlsx',
      filename: '导入件.xlsx',
      format: 'xlsx',
      fileBase64: Buffer.from(delivered).toString('base64'),
    });
    statusIs(imported, 201);

    // ① 起始摘要**不得**等于空白 xlsx 摘要（这正是改前红掉的那条）。
    expect(
      imported.json['contentDigest'],
      'fileBase64 被静默丢弃：起始摘要等于空白 xlsx（内容未吸收）',
    ).not.toBe(blankDigest);

    // ② 会话状态如实标注来源是"导入"，并记下上传字节摘要。
    const status = await getJson(main.baseUrl, '/api/deliverables/dib-import-xlsx');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['sourceKind'], '导入源必须如实登记为 imported').toBe('imported');
    expect(status.json['sourceDigest'], '上传字节摘要必须被记下').toBe(deliveredDigest);
  });

  it('PPTX：导入一份非空白 .pptx ⇒ sourceKind=imported、sourceDigest=上传字节摘要', async () => {
    const delivered = await deliverNonBlankPptx(main.baseUrl, 'dib-src-pptx', 'd-dib-src-pptx');
    const deliveredDigest = sha256(delivered);

    const blank = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-blank-pptx',
      deliverableId: 'd-dib-blank-pptx',
      filename: '空白对照.pptx',
      format: 'pptx',
    });
    statusIs(blank, 201);
    expect(blank.json['contentDigest'], '非空白源与空白源摘要必须不同').not.toBe(deliveredDigest);

    const imported = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-import-pptx',
      deliverableId: 'd-dib-import-pptx',
      filename: '导入件.pptx',
      format: 'pptx',
      fileBase64: Buffer.from(delivered).toString('base64'),
    });
    statusIs(imported, 201);
    expect(imported.json['contentDigest'], '起始摘要不得等于空白 pptx').not.toBe(blank.json['contentDigest']);

    const status = await getJson(main.baseUrl, '/api/deliverables/dib-import-pptx');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['sourceKind'], '导入源必须如实登记为 imported').toBe('imported');
    expect(status.json['sourceDigest']).toBe(deliveredDigest);
  });
});

// ===========================================================================
// 反向对照 ①：格式不符必须**具名 4xx**，绝不静默建空白源
// ===========================================================================

describe('格式不符：非空 fileBase64 与该格式不符 ⇒ 具名 4xx（不吞成 500、不静默）', () => {
  it('真 DOCX 字节当 XLSX ⇒ 400 import_failed，且会话**未被创建**', async () => {
    const response = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-forged-xlsx',
      deliverableId: 'd-dib-forged-xlsx',
      filename: '冒充.xlsx',
      format: 'xlsx',
      fileBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    expect(response.status, JSON.stringify(response.json)).toBe(400);
    expect(response.json['code'], '格式不符必须具名报因（不是 500、不是静默）').toBe('import_failed');

    // 静默丢弃的旧行为会**留下一个空白会话**；具名拒绝则什么都不建。
    const status = await getJson(main.baseUrl, '/api/deliverables/dib-forged-xlsx');
    expect(status.status, '被拒的会话不得被创建').toBe(404);
  });

  it('真 DOCX 字节当 PPTX ⇒ 400 import_failed', async () => {
    const response = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-forged-pptx',
      deliverableId: 'd-dib-forged-pptx',
      filename: '冒充.pptx',
      format: 'pptx',
      fileBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    expect(response.status, JSON.stringify(response.json)).toBe(400);
    expect(response.json['code']).toBe('import_failed');
  });

  it('合法 base64 但不是任何 ZIP 包 ⇒ 400 import_failed（不静默当空白源）', async () => {
    const response = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-garbage',
      deliverableId: 'd-dib-garbage',
      filename: '垃圾.xlsx',
      format: 'xlsx',
      fileBase64: Buffer.from('this is not a zip at all').toString('base64'),
    });
    expect(response.status, JSON.stringify(response.json)).toBe(400);
    expect(response.json['code']).toBe('import_failed');
  });
});

// ===========================================================================
// 反向对照 ②：不带 fileBase64 ⇒ 行为不变（仍建空白源）
// ===========================================================================

describe('反向对照：不带 fileBase64 时行为不变（仍建空白源）', () => {
  it('省略 fileBase64 ⇒ 201，仍建空白源；且与"导入件"是两种不同的起始摘要', async () => {
    const first = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-ctrl-a',
      deliverableId: 'd-dib-ctrl-a',
      filename: '空白A.xlsx',
      format: 'xlsx',
    });
    statusIs(first, 201);

    const second = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-ctrl-b',
      deliverableId: 'd-dib-ctrl-b',
      filename: '空白B.xlsx',
      format: 'xlsx',
    });
    statusIs(second, 201);
    // 空白源是确定性的：两次独立空白开会的起始摘要一致。
    expect(second.json['contentDigest'], '空白源摘要必须可复现').toBe(first.json['contentDigest']);

    // 未导入 ⇒ sourceKind 不得谎称 imported。
    const status = await getJson(main.baseUrl, '/api/deliverables/dib-ctrl-a');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['sourceKind']).not.toBe('imported');
  });

  it('显式空串 fileBase64 ⇒ 具名 4xx（空字节不得被当成"没给"而静默建空白源）', async () => {
    const response = await postJson(main.baseUrl, '/api/deliverables', {
      sessionId: 'dib-empty',
      deliverableId: 'd-dib-empty',
      filename: '空串.xlsx',
      format: 'xlsx',
      fileBase64: '',
    });
    expect(response.status, JSON.stringify(response.json)).toBe(400);
    expect(response.json['code']).toBe('import_failed');
  });
});
