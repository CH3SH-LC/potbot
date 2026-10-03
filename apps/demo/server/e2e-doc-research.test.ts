/**
 * FA-E2E-DOC-RESEARCH —— 对**新挂载的两组路由**（文档工作流 / 资料检索）做**产品端到端**。
 *
 * ## 本套件测什么（与任务书逐条对应）
 *
 * 1. **文档**：`GET /api/documents/status` 可达 → 导入一份**真实 DOCX 字节** → 做一次编辑
 *    （插入表格）→ 导出 → **由本套件自带的独立 ZIP 解析器读回**核对（**不复用**
 *    产品自检器 `selfCheckArtifactBytes`，避免量尺与被测对象同源）→ **换一个服务实例、
 *    同一运行目录**仍能读回**同一产物**（证明真落盘、不是进程内存）。
 * 2. **检索**：`GET /api/research/status` 可达 → 如实报告**查询 / 抓取 / OCR 三段未就绪**
 *    （含原因与解锁条件）→ 导入一份**私有 TXT** → 检索命中 → 答案正文**每句事实带可回读出处**
 *    → **删掉来源后索引联动失效**。
 * 3. **辨别力对照**：一个**未挂载**的路径（`/api/definitely-not-mounted`）必须仍返回
 *    404 `not_found`——证明"可达"不是因为兜底太宽。
 * 4. **不伪造**：检索侧无端口时**不得**返回任何"像检索结果"的内容（`from_model_knowledge`
 *    恒 false、命中为空、无伪造条目）；文档侧无端口时受管路由必须**结构化 503**。
 *
 * ## 为什么经 `createDemoServer`（而不是直接调路由模块）
 *
 * 任务要求"**真实 HTTP** + 产品入口"。`createDemoServer` 正是产品入口：它按
 * `POTBOT_RUN_DIR` 建**落盘的内核存储**，装配会话 / 交付 / 文档产物端口，并把
 * `documentsRoutes` / `researchRoutes` 交给 `createDemoRequestHandler`。本套件只把它
 * `listen(0, 127.0.0.1)`，不替换任何一层。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **真机 / 浏览器 / 真实联网 / 真实 OCR 一律未验证**：本套件只跑 in-process 服务 +
 *   回环 HTTP；检索侧的联网与 OCR 端口在本进程**根本没有装配**，因此相关能力**未实测**。
 * - 文档侧只证明"**模型态 + 字节往返 + 落盘回读**"；**Word 打开核对本轮不做** ⇒ 渲染效果
 *   **未验证**。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { createDemoServer } from './main.js';
import { createDocumentsRouteHost, handleDocumentsRequest } from './documents-routes.js';

// ---------------------------------------------------------------------------
// 独立 ZIP 解析器（**只读中央目录**，不 import 本仓任何模块）
//
// 与 FA-E2E-PRODUCT 同一条纪律：三格式互不冒充的判据必须是**独立证据**。若拿内核自己的
// 自检器来读回，则"自检器分不清容器"这类缺陷会同时污染被测对象与量尺。这里只依赖字节布局
// （EOCD 0x06054b50 → 中央目录 0x02014b50 → 文件名），压缩方法与数据本体一概不碰。
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const CENTRAL_FIXED_LENGTH = 46;

/** 列出 ZIP 包内的全部部件路径（**不校验、不解压**，只读中央目录）。 */
export function zipEntryNames(bytes: Uint8Array): readonly string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanFrom = Math.max(0, bytes.byteLength - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_LENGTH; offset >= scanFrom; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到 EOCD（0x06054b50）');
  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const names: string[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    names.push(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return Object.freeze(names);
}

// ---------------------------------------------------------------------------
// 夹具与 HTTP 小工具
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface Running {
  readonly runDir: string;
  readonly base: string;
  close(): Promise<void>;
}

/** 经**产品入口**起一个真实服务（`createDemoServer` + `listen(0, 127.0.0.1)`）。 */
async function startProduct(runDir: string): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  const server: Server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    runDir,
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

async function getJson(base: string, path: string): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as Json };
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

/** 真实 DOCX 字节：产物模板构建器产出一个**可被 `importDocx` 读回**的最小包。 */
function sampleDocxBytes(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '端到端往返样例',
      description: '这是一份用于文档路由产品端到端自证的正文，不含数字以免触发可追溯性校验。',
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

// ---------------------------------------------------------------------------
// 运行目录（隔离；每个 describe 一个）
// ---------------------------------------------------------------------------

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-e2e-docres-'));

afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

// ===========================================================================
// 1. 文档组
// ===========================================================================

describe('FA-E2E-DOC-RESEARCH：文档路由的产品端到端', () => {
  const runDir = join(RUN_ROOT, 'documents');
  let run: Running;
  const DOC_ID = 'e2e-doc-1';

  it('GET /api/documents/status 经产品入口可达（非 404）', async () => {
    run = await startProduct(runDir);
    const { status, json } = await getJson(run.base, '/api/documents/status');
    // 若本断言失败，说明两组 handler **没有被真正派发**（请求落到了 /api/** 兜底 404）。
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json['root']).toBe('/api/documents');
    expect(json['ready']).toBe(true); // createDemoServer 注入了文件落盘端口
    expect(json['render_verification']).toBe('unverified'); // 如实：Word 打开本轮不做
  }, 60000);

  it('导入真实 DOCX → 编辑（插表）→ 导出 → 独立 ZIP 解析器读回', async () => {
    const imported = await postJson(run.base, `/api/documents/${DOC_ID}/import`, {
      docx_base64: b64(sampleDocxBytes()),
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    expect(imported.json['persisted']).toBe(true);
    expect(typeof imported.json['digest_stored']).toBe('string');

    const before = await getJson(run.base, `/api/documents/${DOC_ID}/summary`);
    expect(before.status).toBe(200);
    const tablesBefore = (before.json['summary'] as Json)['tables'] as number;

    const edited = await postJson(run.base, `/api/documents/${DOC_ID}/table`, {
      operation: { kind: 'insert', rows: 2, columns: 2, text_prefix: '格' },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json['ok']).toBe(true);
    const tablesAfter = (edited.json['summary'] as Json)['tables'] as number;
    expect(tablesAfter).toBe(tablesBefore + 1);

    const exported = await getJson(run.base, `/api/documents/${DOC_ID}/export?body=1`);
    expect(exported.status).toBe(200);
    const docxB64 = exported.json['docx_base64'];
    expect(typeof docxB64).toBe('string');
    const bytes = new Uint8Array(Buffer.from(docxB64 as string, 'base64'));

    // **独立读数**：本套件自带的 ZIP 解析器直接看包内部件，不信任任何产品自检器。
    const names = zipEntryNames(bytes);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');

    // 编辑确实改了字节（导出摘要 ≠ 导入摘要）。
    expect(exported.json['digest']).not.toBe(imported.json['digest_stored']);
  }, 60000);

  it('换一个服务实例、同一运行目录 ⇒ 读回同一产物（真落盘，不是内存）', async () => {
    const beforeClose = await getJson(run.base, `/api/documents/${DOC_ID}/export`);
    expect(beforeClose.status).toBe(200);
    const digestOnDisk = beforeClose.json['digest'];

    await run.close();

    // **同一运行目录**起第二个实例：内存全空，只能靠落盘字节回答。
    const second = await startProduct(runDir);
    run = second;
    const summary = await getJson(second.base, `/api/documents/${DOC_ID}/summary`);
    expect(summary.status, JSON.stringify(summary.json)).toBe(200);
    expect(summary.json['digest']).toBe(digestOnDisk);

    // 且读回的字节仍是合法 DOCX（独立解析器再次核对）。
    const exported = await getJson(second.base, `/api/documents/${DOC_ID}/export?body=1`);
    const bytes = new Uint8Array(Buffer.from(exported.json['docx_base64'] as string, 'base64'));
    expect(zipEntryNames(bytes)).toContain('word/document.xml');
  }, 60000);

  it('【反向对照】坏路径被拒：非法 base64 / 不存在的文档 / 越界合并', async () => {
    const badB64 = await postJson(run.base, '/api/documents/bad-1/import', { docx_base64: '!!!not-base64!!!' });
    expect(badB64.status).toBe(422);
    expect(badB64.json['code']).toBe('invalid_base64');

    const missing = await getJson(run.base, '/api/documents/no-such-doc/summary');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('document_not_found');

    const outOfRange = await postJson(run.base, `/api/documents/${DOC_ID}/table`, {
      operation: { kind: 'merge', table_id: 'no-such-table', region: { top: 0, left: 0, rows: 1, columns: 1 } },
    });
    expect(outOfRange.status).toBe(404); // unknown_node
    expect(outOfRange.json['code']).toBe('unknown_node');

    // 未知子路由 ⇒ 结构化 404（不是静默成功）。
    const unknown = await postJson(run.base, `/api/documents/${DOC_ID}/definitely-not-a-subroute`, {});
    expect(unknown.status).toBe(404);
  }, 60000);

  describe('文档侧无端口 ⇒ 受管路由结构化 503（直接构造该场景）', () => {
    it('无 DocumentStorePort 时：status 报未就绪；受管路由 503 documents_not_ready', async () => {
      const host = createDocumentsRouteHost({}); // 显式不注入端口
      const server = createServer((req, res) => {
        void (async (): Promise<void> => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (await handleDocumentsRequest({ req, res, url, host })) return;
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_handled' }));
        })();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${String(port)}`;
      try {
        const status = await getJson(base, '/api/documents/status');
        expect(status.status).toBe(200);
        expect(status.json['ready']).toBe(false);

        const managed = await postJson(base, '/api/documents/any/import', { docx_base64: b64(sampleDocxBytes()) });
        expect(managed.status).toBe(503); // **不退回内存冒充持久**
        expect(managed.json['code']).toBe('documents_not_ready');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60000);
  });
});

// ===========================================================================
// 2. 检索组
// ===========================================================================

describe('FA-E2E-DOC-RESEARCH：检索路由的产品端到端', () => {
  const OWNER = 'owner-e2e';
  const TASK = 'task-e2e';

  it('GET /api/research/status 经产品入口可达，且三段未就绪如实（含原因与解锁条件）', async () => {
    const run = await startProduct(join(RUN_ROOT, 'research-status'));
    try {
      const { status, json } = await getJson(run.base, '/api/research/status');
      expect(status, JSON.stringify(json)).toBe(200);
      expect(json['from_model_knowledge']).toBe(false);

      const segments = json['segments'] as Json[];
      const byName = new Map(segments.map((segment) => [segment['name'] as string, segment]));
      for (const name of ['query', 'fetch', 'ocr']) {
        const segment = byName.get(name);
        expect(segment, `缺少 ${name} 段`).toBeTruthy();
      }
      // 联网查询：未装配真实端口 ⇒ 未就绪 + 原因 + 解锁条件。
      const query = byName.get('query') as Json;
      expect(query['ready']).toBe(false);
      expect(typeof query['reason']).toBe('string');
      expect((query['reason'] as string).length).toBeGreaterThan(0);
      expect(Array.isArray(query['unlock'])).toBe(true);
      expect((query['unlock'] as string[]).length).toBeGreaterThan(0);
      // 抓取：同上。
      const fetchSeg = byName.get('fetch') as Json;
      expect(fetchSeg['ready']).toBe(false);
      expect((fetchSeg['unlock'] as string[]).length).toBeGreaterThan(0);
      // OCR：**verified_supported 恒为 false**（本仓未对真实 OCR 引擎做端到端实测）。
      const ocr = byName.get('ocr') as Json;
      expect(ocr['verified_supported']).toBe(false);
      expect((ocr['unlock'] as string[]).length).toBeGreaterThan(0);
    } finally {
      await run.close();
    }
  }, 60000);

  it('无端口时 query / fetch **不得**返回任何"像检索结果"的内容', async () => {
    const run = await startProduct(join(RUN_ROOT, 'research-nofake'));
    try {
      const queried = await postJson(run.base, '/api/research/query', { query: '预算' });
      expect(queried.status).toBe(200);
      expect(queried.json['from_model_knowledge']).toBe(false);
      const outcome = queried.json['outcome'] as Json;
      expect(outcome['status']).toBe('not-ready');
      expect(outcome['fromModelKnowledge']).toBe(false);
      // 未就绪 ⇒ 不得有任何命中数组冒充检索结果。
      const results = outcome['results'];
      expect(results === undefined || (Array.isArray(results) && results.length === 0)).toBe(true);

      const fetched = await postJson(run.base, '/api/research/fetch', { url: 'https://example.invalid/' });
      expect(fetched.status).toBe(200);
      expect((fetched.json['outcome'] as Json)['status']).toBe('not-ready');
    } finally {
      await run.close();
    }
  }, 60000);

  it('私有 TXT 导入 → 检索命中 → 答案每句事实带可回读出处', async () => {
    const run = await startProduct(join(RUN_ROOT, 'research-corpus'));
    try {
      const imported = await postJson(run.base, '/api/research/corpus/import', {
        owner_id: OWNER,
        task_id: TASK,
        name: '预算.txt',
        media_type: 'text/plain',
        content_text: '季度预算为 1200 元。项目实施工期为 30 天。',
      });
      expect(imported.status, JSON.stringify(imported.json)).toBe(200);
      expect((imported.json['entry'] as Json)['status']).toBe('indexed');

      const searched = await postJson(run.base, '/api/research/corpus/search', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
      });
      expect(searched.status).toBe(200);
      expect(searched.json['from_model_knowledge']).toBe(false);
      const hits = searched.json['hits'] as Json[];
      expect(hits.length).toBeGreaterThan(0);

      const answered = await postJson(run.base, '/api/research/ask', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
        user_wants_citations: true,
      });
      expect(answered.status, JSON.stringify(answered.json)).toBe(200);
      expect(answered.json['accepted']).toBe(true);
      expect(answered.json['from_model_knowledge']).toBe(false);
      expect((answered.json['readback'] as Json)['ok']).toBe(true);

      const sentences = answered.json['sentences'] as Json[];
      expect(sentences.length).toBeGreaterThan(0);
      for (const sentence of sentences) {
        // 每句都给出依据的证据块 id。
        expect((sentence['evidence_chunk_ids'] as string[]).length).toBeGreaterThan(0);
        // **每句"事实"必须带非空、可回读的引用**（构造即校验：无出处不得标事实）。
        if (sentence['kind'] === 'fact') {
          const citations = sentence['citations'] as Json[];
          expect(citations.length).toBeGreaterThan(0);
          const parts = citations[0]?.['parts'] as Json[];
          expect(parts.length).toBeGreaterThan(0);
          expect(typeof parts[0]?.['quote']).toBe('string');
          expect((parts[0]?.['quote'] as string).length).toBeGreaterThan(0);
        }
      }
    } finally {
      await run.close();
    }
  }, 60000);

  it('删掉来源 ⇒ 索引联动失效（块移除 / 单条不可见 / 派生结果判失效）', async () => {
    const run = await startProduct(join(RUN_ROOT, 'research-delete'));
    try {
      const imported = await postJson(run.base, '/api/research/corpus/import', {
        owner_id: OWNER,
        task_id: TASK,
        name: '预算.txt',
        media_type: 'text/plain',
        content_text: '季度预算为 1200 元。项目实施工期为 30 天。',
      });
      const sourceId = (imported.json['entry'] as Json)['source_id'] as string;

      const answered = await postJson(run.base, '/api/research/ask', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
      });
      const answerKey = answered.json['answer_key'] as string;
      expect(typeof answerKey).toBe('string');

      const deleted = await postJson(run.base, '/api/research/corpus/delete', {
        owner_id: OWNER,
        task_id: TASK,
        source_id: sourceId,
        at: 50,
      });
      expect(deleted.status).toBe(200);
      expect(deleted.json['ok']).toBe(true);
      expect(deleted.json['still_registered']).toBe(false);
      expect(deleted.json['invalidated_keys']).toContain(answerKey);
      expect((deleted.json['derived_still_valid'] as boolean[]).every((value) => value === false)).toBe(true);

      const searched = await postJson(run.base, '/api/research/corpus/search', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
      });
      expect((searched.json['hits'] as Json[]).some((hit) => hit['source_id'] === sourceId)).toBe(false);

      const gone = await getJson(
        run.base,
        `/api/research/corpus/source?owner_id=${OWNER}&task_id=${TASK}&source_id=${sourceId}`,
      );
      expect(gone.status).toBe(404);
    } finally {
      await run.close();
    }
  }, 60000);

  it('【反向对照】坏路径被拒：缺隔离键 400 / 跨用户删除 404', async () => {
    const run = await startProduct(join(RUN_ROOT, 'research-bad'));
    try {
      const missingScope = await postJson(run.base, '/api/research/corpus/search', { query: '预算' });
      expect(missingScope.status).toBe(400);
      expect(missingScope.json['code']).toBe('invalid_owner_id');

      const imported = await postJson(run.base, '/api/research/corpus/import', {
        owner_id: OWNER,
        task_id: TASK,
        name: 'a.txt',
        media_type: 'text/plain',
        content_text: '预算 1200 元',
      });
      const sourceId = (imported.json['entry'] as Json)['source_id'] as string;

      const crossUser = await postJson(run.base, '/api/research/corpus/delete', {
        owner_id: 'someone-else',
        task_id: TASK,
        source_id: sourceId,
      });
      expect(crossUser.status).toBe(404);
      expect(crossUser.json['code']).toBe('source_not_visible');

      const still = await getJson(
        run.base,
        `/api/research/corpus/source?owner_id=${OWNER}&task_id=${TASK}&source_id=${sourceId}`,
      );
      expect(still.status).toBe(200); // 跨用户删除**没有**改动本域状态
    } finally {
      await run.close();
    }
  }, 60000);
});

// ===========================================================================
// 3. 辨别力对照：未挂载路径必须仍是 404 not_found
// ===========================================================================

describe('FA-E2E-DOC-RESEARCH：辨别力对照（"可达"不是因为兜底太宽）', () => {
  it('未挂载的 /api/definitely-not-mounted 仍返回 404 not_found', async () => {
    const run = await startProduct(join(RUN_ROOT, 'discrimination'));
    try {
      const notMounted = await getJson(run.base, '/api/definitely-not-mounted');
      expect(notMounted.status).toBe(404);
      expect(notMounted.json['code']).toBe('not_found');
      // 对照组：真正挂载的两个 status 端点**不是** 404（否则上面的 404 毫无辨别力）。
      const docsStatus = await getJson(run.base, '/api/documents/status');
      expect(docsStatus.status).toBe(200);
      const researchStatus = await getJson(run.base, '/api/research/status');
      expect(researchStatus.status).toBe(200);
    } finally {
      await run.close();
    }
  }, 60000);
});
