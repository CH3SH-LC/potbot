/**
 * FA-VERIFY-WAVE-6 · 真服务对抗（任务第 3 项）+ 未就绪诚实性（任务第 4 项）。
 *
 * 判据独立于实现者：本文件**自行**经 `createDemoServer`（产品入口）起真实 `node:http`
 * 服务、自行构造输入、自行核对**做法**（不是只看状态码）。核心问题：
 *
 * > 有没有"返回 200 但什么也没做"的端点？
 *
 * 做法：凡是**写口**，都要求一个**读回**去证明它真的落到了产品存储/端口上（证据不能是
 * 响应体自己说的那句话）。凡缺端口的路径，必须是**结构化未就绪**（具名 code + 原因 +
 * 解锁条件），而不是 404（"没有这个接口"）/ 500 / 假装可用。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { createDemoServer } from '../../../apps/demo/server/main.js';
import { createRolesWiring } from '../../../apps/demo/server/roles-wiring.js';
import { createDocumentsRouteHost, handleDocumentsRequest } from '../../../apps/demo/server/documents-routes.js';
import { createMemoryRouteHost, handleMemoryRequest } from '../../../apps/demo/server/memory-routes.js';
import { handlePluginRequest } from '../../../apps/demo/server/plugin-routes.js';
import { createConversationLoopRoutes } from '../../../apps/demo/server/route-wiring.js';

type Json = Record<string, any>;

interface Running {
  readonly base: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<Running> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error))),
      ),
  };
}

async function startProduct(runDir: string): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  return listen(demo.server);
}

/** 起一个只挂一组独立路由的最小真实服务（用于"缺端口 ⇒ 未就绪"的对抗）。 */
async function startMounted(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
): Promise<Running> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handler(req, res, url)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'not_handled' }));
    })();
  });
  return listen(server);
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

function sampleDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: { title: '第六轮真服务对抗样例', description: '正文不含数字，避免触发可追溯性校验。' },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-vw6-probe-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

// ===========================================================================
// 1. 真实 HTTP 逐端点（≥ 18 个）
// ===========================================================================

describe('真服务对抗：产品入口的端点逐个打（真 node:http）', () => {
  const runDir = join(RUN_ROOT, 'product');
  let run: Running;

  it('起服务并打 /health、/api/identity', async () => {
    run = await startProduct(runDir);
    const health = await getJson(run.base, '/health');
    expect(health.status).toBe(200);
    expect(typeof health.json['ready']).toBe('boolean');

    const identity = await getJson(run.base, '/api/identity');
    expect(identity.status).toBe(200);
    expect(typeof identity.json['runId']).toBe('string');
  }, 60000);

  it('GET /api/roles/status：就绪面如实（store 与 repository 都在产品里装配了）', async () => {
    const { status, json } = await getJson(run.base, '/api/roles/status');
    expect(status).toBe(200);
    expect(json['ports']['kernel_store']).toBe(true);
    expect(json['ports']['memory_repository']).toBe(true);
    expect(json['ready']).toBe(true);
  });

  it('POST /api/roles/main-agent（create_task）的 200 不是空壳：任务真的落进产品内核 store', async () => {
    const created = await postJson(run.base, '/api/roles/main-agent', {
      kind: 'create_task',
      goal: '第六轮对抗：产出一份季度汇报',
      capability_id: 'cap.doc',
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const taskId = created.json['dispatch']['task_id'] as string;
    expect(typeof taskId).toBe('string');
    expect(created.json['dispatch']['artifacts_produced']).toBe(0);

    // **读回证据**：换一个端点、用内核存储派生完成视图。若 create_task 只是回了一句
    // "已派发"，这里会 404 task_unknown。
    const completion = await getJson(run.base, `/api/tasks/${taskId}/completion`);
    expect(completion.status, JSON.stringify(completion.json)).toBe(200);
    expect(completion.json['taskId']).toBe(taskId);
    // 新建任务没有任何工作项 ⇒ 空集不得推成功（S-1026-01）。
    expect(completion.json['label']).not.toBe('completed_and_successful');
  });

  it('POST /api/roles/group-fork/context：本任务必要信息放行面可用', async () => {
    const created = await postJson(run.base, '/api/roles/main-agent', {
      kind: 'create_task',
      goal: '第六轮对抗：分身上下文',
    });
    const taskId = created.json['dispatch']['task_id'] as string;
    const context = await postJson(run.base, '/api/roles/group-fork/context', {
      task_id: taskId,
      items: [{ ref: 'P-1', scope: 'personal_history', text: '这是不该放行的个人历史' }],
    });
    expect(context.status, JSON.stringify(context.json)).toBe(200);
    expect(context.json['all_items_task_scoped']).toBe(true);
    expect(context.json['withheld_personal_history']).toContain('P-1');
  });

  it('POST /api/roles/group-fork/signals 与 /route 都真的返回结构判定', async () => {
    const signals = await postJson(run.base, '/api/roles/group-fork/signals', {
      signals: [
        { channel: 'uplink', kind: 'question', from_instance_id: 'I-1', task_id: 'T-1', at: 1, question_key: 'q', text: '缺数据' },
      ],
    });
    expect(signals.status).toBe(200);
    expect(signals.json['aggregated'][0]['question_key']).toBe('q');

    const route = await postJson(run.base, '/api/roles/group-fork/route', {
      topology: { fork_instance_id: 'I-F', edges: [{ from: 'I-1', to: 'I-2', via: 'direct' }] },
      from: 'I-1',
      to: 'I-2',
    });
    expect(route.status).toBe(200);
    expect(route.json['decision']['route']).toBe('direct');
  });

  it('POST /api/roles/experience/synthesize：非终态任务 ⇒ 422 具名拒绝，且不写库', async () => {
    const created = await postJson(run.base, '/api/roles/main-agent', {
      kind: 'create_task',
      goal: '第六轮对抗：经验固化门槛',
    });
    const taskId = created.json['dispatch']['task_id'] as string;
    const { status, json } = await postJson(run.base, '/api/roles/experience/synthesize', {
      owner_id: 'probe-owner',
      task_id: taskId,
      template_id: 'WF-001',
      evidence: [
        {
          evidence_ref: 'ev-1',
          template_id: 'WF-001',
          sealed: true,
          readback_verified: true,
          outcome: 'success',
          lesson: '不该被固化的经验',
          applies_to_version: 'v1',
        },
      ],
    });
    expect(status, JSON.stringify(json)).toBe(422);
    expect(json['code']).toBe('experience_trigger_rejected');
    expect(json['written']).toEqual([]);
  });

  it('GET /api/documents/status：可达且如实标未验证渲染', async () => {
    const { status, json } = await getJson(run.base, '/api/documents/status');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
    expect(json['render_verification']).toBe('unverified');
  });

  it('文档写口有读回证据：导入的字节摘要 == 我送进去的字节摘要', async () => {
    const bytes = sampleDocx();
    const id = 'probe-doc';
    const imported = await postJson(run.base, `/api/documents/${id}/import`, { docx_base64: b64(bytes) });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    expect(imported.json['digest_stored']).toBe(sha256(bytes));

    // **独立读回**：summary 报的 digest 也必须是我那份字节的摘要（不是进程内缓存）。
    const summary = await getJson(run.base, `/api/documents/${id}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.json['digest']).toBe(sha256(bytes));

    // 插一张表 ⇒ 表数 +1，且导出字节改变。
    const edited = await postJson(run.base, `/api/documents/${id}/table`, {
      operation: { kind: 'insert', rows: 2, columns: 2 },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect((edited.json['summary'] as Json)['tables']).toBe(1);
    const exported = await getJson(run.base, `/api/documents/${id}/export`);
    expect(exported.json['digest']).not.toBe(sha256(bytes));
  });

  it('GET /api/research/status 与 POST /api/research/query 皆可达', async () => {
    const status = await getJson(run.base, '/api/research/status');
    expect(status.status).toBe(200);
    expect(status.json['from_model_knowledge']).toBe(false);
    const query = await postJson(run.base, '/api/research/query', { query: '季度预算' });
    expect(query.status).toBe(200);
    expect(query.json['outcome']['status']).toBe('not-ready');
  });

  it('检索写口有读回证据：导入的正文能被检索到，且命中来自我导入的来源', async () => {
    const imported = await postJson(run.base, '/api/research/corpus/import', {
      owner_id: 'probe-owner',
      task_id: 'probe-task',
      name: '预算.txt',
      media_type: 'text/plain',
      content_text: '第六轮对抗：季度预算为 1200 元。',
    });
    expect(imported.status, JSON.stringify(imported.json)).toBe(200);
    const sourceId = imported.json['entry']['source_id'] as string;

    const found = await postJson(run.base, '/api/research/corpus/search', {
      owner_id: 'probe-owner',
      task_id: 'probe-task',
      query: '预算',
    });
    expect(found.status).toBe(200);
    expect((found.json['hits'] as Json[]).some((hit) => hit['source_id'] === sourceId)).toBe(true);
  });

  it('GET /api/memory/status 与 GET /api/memory/entries（需要隔离键）', async () => {
    const status = await getJson(run.base, '/api/memory/status');
    expect(status.status).toBe(200);
    expect(status.json['ready']).toBe(true);

    const entries = await getJson(run.base, '/api/memory/entries?owner_id=probe-owner');
    expect(entries.status).toBe(200);

    // 缺隔离键 ⇒ 400（不是"给你全部"）。
    const missingKey = await getJson(run.base, '/api/memory/entries');
    expect(missingKey.status).toBe(400);
    expect(missingKey.json['code']).toBe('invalid_owner_id');
  });

  it('GET /api/plugins、/api/conversation-loop/status、/api/adapters/readiness 皆可达', async () => {
    const plugins = await getJson(run.base, '/api/plugins');
    expect(plugins.status).toBe(200);
    expect(plugins.json['ok']).toBe(true);
    expect((plugins.json['plugins'] as Json[]).length).toBeGreaterThan(0);

    const loop = await getJson(run.base, '/api/conversation-loop/status');
    expect(loop.status).toBe(200);
    expect(loop.json['ready']).toBe(true);

    const adapters = await getJson(run.base, '/api/adapters/readiness');
    expect(adapters.status).toBe(200);
    expect(adapters.json['ok']).toBe(true);
  });

  it('适配器纯函数口真的算（parse-time 不是空 ok）', async () => {
    const parsed = await postJson(run.base, '/api/adapters/clock/parse-time', {
      text: '明天早上七点半',
      nowMs: Date.UTC(2026, 9, 3, 0, 0, 0),
      zoneId: 'Asia/Shanghai',
    });
    expect(parsed.status, JSON.stringify(parsed.json)).toBe(200);
    expect(parsed.json['ok']).toBe(true);
    // 至少给出一个可核对的结构字段，而不是只有 ok。
    expect(Object.keys(parsed.json).length).toBeGreaterThan(1);
  });

  it('恒成功猎捕：空输入 / 未知取值不得被当成 200 成功', async () => {
    // 空信号数组 ⇒ 结构化 422，而不是"accepted: 0"的 200。
    const emptySignals = await postJson(run.base, '/api/roles/group-fork/signals', { signals: [] });
    expect(emptySignals.status).toBe(422);

    // 未知表格操作 ⇒ 422 not_implemented（不是"成功但什么都没做"）。
    const unknownOp = await postJson(run.base, '/api/documents/probe-doc/table', { operation: { kind: 'no_such_op' } });
    expect(unknownOp.status).toBe(422);
    expect(unknownOp.json['code']).toBe('not_implemented');

    // 未知 kind ⇒ 422 invalid_request。
    const unknownKind = await postJson(run.base, '/api/roles/main-agent', { kind: 'teleport' });
    expect(unknownKind.status).toBe(422);
    expect(unknownKind.json['code']).toBe('invalid_request');
  });

  it('扫一遍 GET 端点：没有"200 但空壳"的响应（body 非空对象）', async () => {
    const paths = [
      '/health',
      '/api/identity',
      '/api/roles/status',
      '/api/documents/status',
      '/api/research/status',
      '/api/memory/status',
      '/api/plugins',
      '/api/conversation-loop/status',
      '/api/adapters/readiness',
    ];
    for (const path of paths) {
      const { status, json } = await getJson(run.base, path);
      expect(status, path).toBe(200);
      expect(json !== null && typeof json === 'object' && Object.keys(json).length > 0, `${path} 返回了空壳`).toBe(true);
    }
  });

  it('辨别力：未挂载路径仍是 404 not_found；错误方法 405', async () => {
    const missing = await getJson(run.base, '/api/definitely-not-mounted-vw6');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('not_found');

    const wrongMethod = await getJson(run.base, '/api/roles/status'); // GET ok
    expect(wrongMethod.status).toBe(200);
    const statusPost = await postJson(run.base, '/api/roles/status', {});
    expect(statusPost.status).toBe(405);
  });

  it('收尾：关服务', async () => {
    await run.close();
  });
});

// ===========================================================================
// 1b. 集成 HEAD 新合入的产品面（PPT 同版事实 / 共享事实表格 / 补充适配器入口）
// ===========================================================================

describe('真服务对抗：d9233a8 新合入的三组产品面', () => {
  const runDir = join(RUN_ROOT, 'product-new');
  let run: Running;

  it('GET /api/ppt-facts/status 可达且如实（纯函数路由，无"端口未装配"形态）', async () => {
    run = await startProduct(runDir);
    const { status, json } = await getJson(run.base, '/api/ppt-facts/status');
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json['ok']).toBe(true);
    expect(json['root']).toBe('/api/ppt-facts');
    expect(Array.isArray(json['unverified'])).toBe(true);
  }, 60000);

  it('GET /api/xls-facts/status 可达，且产品路径上 docx/pptx 发布通道**如实未接线**', async () => {
    const { status, json } = await getJson(run.base, '/api/xls-facts/status');
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json['root']).toBe('/api/xls-facts');
    // 产品不注入任何发布通道 ⇒ unwired_targets 非空（不是"假装能发布"）。
    expect((json['unwired_targets'] as string[]).length).toBeGreaterThan(0);
  });

  it('GET /api/adapters/extra 可达（补充入口真的挂上了）', async () => {
    const { status, json } = await getJson(run.base, '/api/adapters/extra');
    expect(status, JSON.stringify(json)).toBe(200);
    expect(json['ok']).toBe(true);
    expect(Array.isArray(json['modules'])).toBe(true);
  });

  it('辨别力：新前缀外仍是 404', async () => {
    const nope = await getJson(run.base, '/api/ppt-facts-no-such');
    expect(nope.status).toBe(404);
  });

  it('收尾：关服务', async () => {
    await run.close();
  });
});

// ===========================================================================
// 2. 未就绪诚实性（缺端口路径必须结构化：code + 原因 + 解锁）
// ===========================================================================

describe('未就绪诚实性：缺端口 ⇒ 结构化（不是 404 / 500 / 假装可用）', () => {
  it('文档：无 DocumentStorePort ⇒ 503 documents_not_ready + unlock', async () => {
    const host = createDocumentsRouteHost({});
    const run = await startMounted((req, res, url) => handleDocumentsRequest({ req, res, url, host }));
    try {
      const { status, json } = await postJson(run.base, '/api/documents/x/import', { docx_base64: b64(sampleDocx()) });
      expect(status).toBe(503);
      expect(json['code']).toBe('documents_not_ready');
      expect(typeof json['message']).toBe('string');
      expect((json['unlock'] as string[]).length).toBeGreaterThan(0);
    } finally {
      await run.close();
    }
  });

  it('角色：无 Store / 无 Repository ⇒ 503 roles_not_ready + reason + unlock', async () => {
    const wiring = createRolesWiring({});
    const run = await startMounted((req, res, url) => wiring.handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res }));
    try {
      const main = await postJson(run.base, '/api/roles/main-agent', { kind: 'create_task', goal: 'x' });
      expect(main.status).toBe(503);
      expect(main.json['code']).toBe('roles_not_ready');
      expect(main.json['reason']).toBe('no_kernel_store');
      expect((main.json['unlock'] as string[]).length).toBeGreaterThan(0);

      const exp = await postJson(run.base, '/api/roles/experience/synthesize', { task_id: 'T', template_id: 'WF-001', evidence: [] });
      expect(exp.status).toBe(503);
      expect(exp.json['reason']).toBe('no_kernel_store');
    } finally {
      await run.close();
    }
  });

  it('记忆：无持久端口 ⇒ 503 memory_not_ready + unlock（不返回任何记忆数据）', async () => {
    const host = createMemoryRouteHost({});
    const run = await startMounted((req, res, url) => handleMemoryRequest({ req, res, url, host }));
    try {
      const { status, json } = await getJson(run.base, '/api/memory/entries?owner_id=probe');
      expect(status).toBe(503);
      expect(json['code']).toBe('memory_not_ready');
      expect((json['unlock'] as string[]).length).toBeGreaterThan(0);
      // 未就绪 ⇒ 不得有任何"条目"字段。
      expect(json['entries']).toBeUndefined();
    } finally {
      await run.close();
    }
  });

  it('模板平台：无 store ⇒ 503 plugin_store_unwired + 解锁动作', async () => {
    const run = await startMounted((req, res, url) =>
      handlePluginRequest({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res }, {}),
    );
    try {
      const { status, json } = await getJson(run.base, '/api/plugins');
      expect(status).toBe(503);
      expect(json['code']).toBe('plugin_store_unwired');
      expect(json['status']).toBe('not_ready');
      expect(typeof json['unblockedBy']).toBe('string');
    } finally {
      await run.close();
    }
  });

  it('对话闭环：无 loop ⇒ 503 loop_not_ready + unlock', async () => {
    const routes = createConversationLoopRoutes({ loop: null });
    const run = await startMounted((req, res, url) =>
      routes.handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res }),
    );
    try {
      const { status, json } = await getJson(run.base, '/api/conversation-loop/status');
      expect(status).toBe(503);
      expect(json['code']).toBe('loop_not_ready');
      expect((json['unlock'] as string[]).length).toBeGreaterThan(0);
    } finally {
      await run.close();
    }
  });

  it('检索：三段未就绪（query / fetch / ocr）各有 reason 与 unlock', async () => {
    const runDir = join(RUN_ROOT, 'research-notready');
    const run = await startProduct(runDir);
    try {
      const { json } = await getJson(run.base, '/api/research/status');
      const segments = json['segments'] as Json[];
      const byName = new Map(segments.map((s) => [s['name'] as string, s]));
      let checked = 0;
      for (const name of ['query', 'fetch']) {
        const segment = byName.get(name) as Json;
        expect(segment['ready'], name).toBe(false);
        expect(typeof segment['reason'], name).toBe('string');
        expect((segment['reason'] as string).length, name).toBeGreaterThan(0);
        expect((segment['unlock'] as string[]).length, name).toBeGreaterThan(0);
        checked += 1;
      }
      // OCR 段：接口写好了但**未实测** ⇒ 恒为 verified_supported=false + configured=false（仍带 unlock）。
      const ocr = byName.get('ocr') as Json;
      expect(ocr['verified_supported']).toBe(false);
      expect(ocr['configured']).toBe(false);
      expect((ocr['unlock'] as string[]).length).toBeGreaterThan(0);
      checked += 1;
      expect(checked).toBe(3);
    } finally {
      await run.close();
    }
  }, 60000);

  it('适配器：readiness 里对未接通能力给出 reason 与 unblockedBy（不是空 verdict）', async () => {
    const runDir = join(RUN_ROOT, 'adapters-notready');
    const run = await startProduct(runDir);
    try {
      const { json } = await getJson(run.base, '/api/adapters/readiness');
      const totals = json['totals'] as Json;
      // 产品路径不传任何端口 ⇒ 必定有未就绪/阻塞项。
      expect((totals['not_ready'] as number) + (totals['blocked'] as number)).toBeGreaterThan(0);
      const clock = (json['packages'] as Json)['clock'] as Json;
      const nonImplemented = (clock['subitems'] as Json[]).filter((item) => item['verdict'] !== 'implemented');
      expect(nonImplemented.length).toBeGreaterThan(0);
      for (const item of nonImplemented) {
        expect(typeof item['reason']).toBe('string');
        expect((item['reason'] as string).length).toBeGreaterThan(0);
      }
    } finally {
      await run.close();
    }
  }, 60000);
});
