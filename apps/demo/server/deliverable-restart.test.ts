/**
 * 工作包 **FA-DELIVERABLE-RESTART**：交付宿主（XLSX / PPTX）的**落盘与跨重启读回**。
 *
 * ## 这条用例要证明的不是"文件写下去了"，而是"重启后真的读得回来"
 *
 * `main.ts` 一直把交付会话状态写到 `<runDir>/deliverables/<id>.json`（`session_persistence.save`），
 * 但交付宿主**没有任何恢复调用点**：重启后 `#entries` 是空的，`GET /api/deliverables/:id`
 * 直接 404。于是"落盘成功"与"能重新打开"是两件事。本文件把这件事钉死——与字处理链的
 * `session-restore-persist.test.ts` **同一套判据形状**。
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 同目录、换服务实例（进程内状态全新） | XLSX / PPTX 会话 200，**版本历史逐项一致**，下载字节**逐字节相同** |
 * | DOCX（对照，本来就好的那条链） | 仍然 200（`restoredFromDisk` 为真）——本修复不得把好的弄坏 |
 * | 换**独立**运行目录 | 仍然 404（反向对照：证明数据落在**这个**运行目录里，不是全局位置） |
 * | 从未存在的交付会话 | 404（恢复逻辑不能把"没有"变成"什么都能开"） |
 *
 * ## 为什么经 `createDemoServer` 起服务
 *
 * 任务要求"真服务冒烟 + 真实落盘"。`createDemoServer` 正是产品入口：它按环境变量解析
 * 运行目录、建**落盘的内核存储**（`<runDir>/kernel-store/store.json`）、组装会话 / 交付
 * 两个宿主，并挂到同一条 `createDemoRequestHandler` 上。本文件只把它 `listen(0, '127.0.0.1')`，
 * **不替换任何一层**——替换掉持久化就不是在测产品了。
 *
 * ## 为什么"换实例"是真的换
 *
 * 每个进程用**独立的 `createDemoServer`**（全新的 store 对象、全新的 `DeliverableHost`
 * 与空的 `#entries`、全新的时钟），**只共享同一个运行目录**。这与"同一个宿主里再查一次"
 * 是两件事：后者根本不会经过恢复路径。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import { bytesEqual, getBytes, getJson, postJson, sha256Of, startProduct, type Json } from './e2e-full-chain-harness.js';
import type { RunningProduct } from './e2e-full-chain-harness.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const XLSX_SESSION = 'dr-xlsx';
const PPTX_SESSION = 'dr-pptx';
const DOCX_SESSION = 'dr-docx';

const OFFICIAL_MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

const running: RunningProduct[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const product of running.splice(0)) {
    await product.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'potbot-deliverable-restart-'));
  tempDirs.push(dir);
  return dir;
}

async function start(runDir: string): Promise<RunningProduct> {
  const product = await startProduct(runDir);
  running.push(product);
  return product;
}

/** 从会话产物里读出编辑版本号（回执形状与产品面一致）。 */
function revisionOf(body: Json): number {
  return body['editRevision'] as number;
}

function digestOf(body: Json): string {
  return String(body['contentDigest']);
}

interface Delivered {
  readonly sessionId: string;
  readonly revision: number;
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/** 交付一个 XLSX：开空白表格 → 建表 → 写格（两次交付 ⇒ 版本历史里有两行）。 */
async function deliverXlsx(baseUrl: string): Promise<Delivered> {
  const created = await postJson(baseUrl, '/api/deliverables', {
    sessionId: XLSX_SESSION,
    deliverableId: 'dr-xlsx-1',
    filename: '重启核对.xlsx',
    format: 'xlsx',
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json['templateKind']).toBe('spreadsheet');

  let revision = revisionOf(created.json);
  let digest = digestOf(created.json);
  const step = async (key: string, edit: unknown): Promise<void> => {
    const outcome = await postJson(baseUrl, `/api/deliverables/${XLSX_SESSION}/edits`, {
      idempotencyKey: key,
      baseRevision: revision,
      baseDigest: digest,
      edit,
    });
    expect(outcome.status, JSON.stringify(outcome.json)).toBe(200);
    revision = revisionOf(outcome.json);
    digest = String((outcome.json['version'] as Json)['contentDigest']);
  };
  await step('dr-xlsx-1', { op: 'add_sheet', name: '明细' });
  await step('dr-xlsx-2', {
    op: 'set_cell',
    sheet: '明细',
    address: 'A1',
    value: { kind: 'text', value: '跨重启' },
  });

  const download = await getBytes(baseUrl, `/api/deliverables/${XLSX_SESSION}/versions/${String(revision)}/download`);
  expect(download.status, '交付后立刻下载必须 200').toBe(200);
  expect(download.contentType).toBe(OFFICIAL_MIME.xlsx);
  return { sessionId: XLSX_SESSION, revision, digest, bytes: download.bytes };
}

/** 交付一个 PPTX：开空白演示 → 加两页。 */
async function deliverPptx(baseUrl: string): Promise<Delivered> {
  const created = await postJson(baseUrl, '/api/deliverables', {
    sessionId: PPTX_SESSION,
    deliverableId: 'dr-pptx-1',
    filename: '重启核对.pptx',
    format: 'pptx',
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json['templateKind']).toBe('presentation');

  let revision = revisionOf(created.json);
  let digest = digestOf(created.json);
  const step = async (key: string, edit: unknown): Promise<void> => {
    const outcome = await postJson(baseUrl, `/api/deliverables/${PPTX_SESSION}/edits`, {
      idempotencyKey: key,
      baseRevision: revision,
      baseDigest: digest,
      edit,
    });
    expect(outcome.status, JSON.stringify(outcome.json)).toBe(200);
    revision = revisionOf(outcome.json);
    digest = String((outcome.json['version'] as Json)['contentDigest']);
  };
  await step('dr-pptx-1', { op: 'add_slide', title: '跨重启：第一页' });
  await step('dr-pptx-2', { op: 'add_slide', title: '跨重启：第二页' });

  const download = await getBytes(baseUrl, `/api/deliverables/${PPTX_SESSION}/versions/${String(revision)}/download`);
  expect(download.status, '交付后立刻下载必须 200').toBe(200);
  expect(download.contentType).toBe(OFFICIAL_MIME.pptx);
  return { sessionId: PPTX_SESSION, revision, digest, bytes: download.bytes };
}

/** DOCX 对照：走字处理链（`/api/sessions`），本来就具备落盘恢复。 */
async function deliverDocx(baseUrl: string): Promise<Uint8Array> {
  const source = buildDocxTemplate({
    requirement: {
      title: '重启核对文档',
      description: '',
      paragraphs: ['第一段', '第二段'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '交付重启夹具' }],
  }).bytes;
  const created = await postJson(baseUrl, '/api/sessions', {
    sessionId: DOCX_SESSION,
    filename: '重启核对.docx',
    mode: 'new',
    docxBase64: Buffer.from(source).toString('base64'),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const edit = await postJson(baseUrl, `/api/sessions/${DOCX_SESSION}/edits`, {
    idempotencyKey: 'dr-docx-1',
    baseRevision: revisionOf(created.json),
    baseDigest: digestOf(created.json),
    intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
  });
  expect(edit.status, JSON.stringify(edit.json)).toBe(200);
  const download = await getBytes(baseUrl, `/api/sessions/${DOCX_SESSION}/versions/1/download`);
  expect(download.status, 'DOCX 交付后立刻下载必须 200').toBe(200);
  return download.bytes;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('FA-DELIVERABLE-RESTART：交付产物跨重启读回', () => {
  it('同运行目录换服务实例：XLSX/PPTX 会话、版本历史与字节全部读回（DOCX 对照同时为真）', async () => {
    const runDir = tempDir();

    let xlsx: Delivered;
    let pptx: Delivered;
    let docxBytes: Uint8Array;

    // ---- 进程 A：交付三种格式，然后**整个服务关掉** ----
    const processA = await start(runDir);
    xlsx = await deliverXlsx(processA.baseUrl);
    pptx = await deliverPptx(processA.baseUrl);
    docxBytes = await deliverDocx(processA.baseUrl);
    await processA.close();
    running.splice(running.indexOf(processA), 1);

    // ---- 进程 B：全新 store / 全新宿主 / 空内存，**只共享同一个运行目录** ----
    const processB = await start(runDir);

    for (const delivered of [xlsx, pptx]) {
      const status = await getJson(processB.baseUrl, `/api/deliverables/${delivered.sessionId}`);
      expect(
        status.status,
        `重启后交付会话 ${delivered.sessionId} 必须读得回来（改前为 404）: ${JSON.stringify(status.json)}`,
      ).toBe(200);
      expect(status.json['fileFormat'], '格式随会话自己的映射行走').toBe(
        delivered.sessionId === XLSX_SESSION ? 'xlsx' : 'pptx',
      );

      // **版本历史可读回**：不是"能开一个空会话"，而是当初那几版都还在。
      const versions = status.json['versions'] as readonly Json[];
      expect(versions.length, `重启后仍应看到已交付的 ${String(delivered.revision)} 版`).toBe(
        delivered.revision,
      );
      const current = status.json['currentVersion'] as Json;
      expect(current['editRevision']).toBe(delivered.revision);
      expect(current['contentDigest']).toBe(delivered.digest);

      // **字节可读回**：盘上那份就是当初交付的那份（逐字节）。
      const bytes = await getBytes(
        processB.baseUrl,
        `/api/deliverables/${delivered.sessionId}/versions/${String(delivered.revision)}/download`,
      );
      expect(bytes.status, `重启后下载 ${delivered.sessionId} 第 ${String(delivered.revision)} 版`).toBe(200);
      expect(bytes.headers.get('x-potbot-file-format')).toBe(
        delivered.sessionId === XLSX_SESSION ? 'xlsx' : 'pptx',
      );
      expect(sha256Of(bytes.bytes), '响应体与响应头摘要一致').toBe(delivered.digest);
      expect(bytesEqual(bytes.bytes, delivered.bytes), '重启前后下载到的字节逐字节相同').toBe(true);
    }

    // DOCX 对照：本修复不得把本来就能恢复的那条链弄坏。
    const docxStatus = await getJson(processB.baseUrl, `/api/sessions/${DOCX_SESSION}`);
    expect(docxStatus.status, 'DOCX 会话仍应恢复成功（对照）').toBe(200);
    expect(docxStatus.json['restoredFromDisk']).toBe(true);
    const docxAfter = await getBytes(processB.baseUrl, `/api/sessions/${DOCX_SESSION}/versions/1/download`);
    expect(docxAfter.status).toBe(200);
    expect(bytesEqual(docxAfter.bytes, docxBytes), 'DOCX 重启前后字节逐字节相同').toBe(true);
  }, 120_000);

  it('反向对照：换独立运行目录 ⇒ 交付会话仍 404（数据落在本运行目录，不是全局位置）', async () => {
    const runDir = tempDir();
    const otherDir = tempDir();

    const processA = await start(runDir);
    const xlsx = await deliverXlsx(processA.baseUrl);
    await processA.close();
    running.splice(running.indexOf(processA), 1);

    const processC = await start(otherDir);
    const status = await getJson(processC.baseUrl, `/api/deliverables/${xlsx.sessionId}`);
    expect(status.status, '独立目录里没有这个交付会话').toBe(404);
    const bytes = await getBytes(
      processC.baseUrl,
      `/api/deliverables/${xlsx.sessionId}/versions/${String(xlsx.revision)}/download`,
    );
    expect(bytes.status, '独立目录里也下载不到那一版').toBe(404);
  }, 120_000);

  it('负例：从未存在的交付会话仍 404（恢复逻辑不能把"没有"变成"什么都能开"）', async () => {
    const runDir = tempDir();
    const product = await start(runDir);
    const status = await getJson(product.baseUrl, '/api/deliverables/nope-never-existed');
    expect(status.status).toBe(404);
  }, 60_000);
});
