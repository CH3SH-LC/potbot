/**
 * FA-VERIFY-WAVE-9 · 任务第 3 项 —— 对 `apps/demo/server/**` 的路由用**真服务**打 ≥12 端点。
 *
 * 做法：经**产品入口** `createDemoServer` 起真 `node:http`，真 `fetch`；判据不只看状态码，
 * 还要求可核对的**结构字段**或**读回**（写口必须能跨请求读回，证明不是空壳）。
 *
 * 上一轮发现的空壳端点 N-7-1 / 别名端点 N-7-2 本轮**已闭合**（前者改正为 503 结构化未就绪，
 * 后者把 /reachability 与 /status 拆成两个视图）；并证明 toolLoop / xlsFacts 两条
 * "半截接线"事故的派发**功能上真的在**。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { createDemoServer } from '../../../apps/demo/server/main.js';

type Json = Record<string, unknown>;

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

async function getJson(base: string, path: string): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, json: (await r.json()) as Json };
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Json };
}

/** 一个只挂一组独立路由的最小真实服务（供"缺端口 ⇒ 结构化未就绪"的反向对照）。 */
async function startMounted(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): Promise<Running> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      if (await handler(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'not_handled' }));
    })();
  });
  return listen(server);
}

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w9-probe-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

let run: Running;

beforeAll(async () => {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: join(RUN_ROOT, 'product') });
  run = await listen(demo.server);
});

afterAll(async () => {
  if (run !== undefined) await run.close();
});

// ===========================================================================
// 1. 逐端点（真服务，≥12）
// ===========================================================================

describe('W9 · 产品入口逐端点（真 node:http）', () => {
  it('① GET /health — 带真实身份，且如实标 modelVerified:false', async () => {
    const { status, json } = await getJson(run.base, '/health');
    expect(status).toBe(200);
    expect(typeof json['buildId']).toBe('string');
    expect(typeof json['bootId']).toBe('string');
    expect(json['modelVerified']).toBe(false);
  });

  it('② GET /api/identity — 报告运行身份（runId）', async () => {
    const { status, json } = await getJson(run.base, '/api/identity');
    expect(status).toBe(200);
    expect(typeof json['runId']).toBe('string');
  });

  it('③ GET /api/documents/status — ready:true 但渲染恒标 unverified（诚实）', async () => {
    const { status, json } = await getJson(run.base, '/api/documents/status');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
    expect(json['render_verification']).toBe('unverified');
  });

  it('④ POST /api/research/query — 未装配端口 ⇒ not-ready 信封，**没有** results', async () => {
    const { status, json } = await postJson(run.base, '/api/research/query', { query: 'x' });
    expect(status).toBe(200);
    expect(json['ready']).toBe(false);
    const outcome = json['outcome'] as Json;
    expect(outcome['status']).toBe('not-ready');
    expect(outcome['results']).toBeUndefined();
  });

  it('⑤ GET /api/memory/status — ready:true 且列四类记忆', async () => {
    const { status, json } = await getJson(run.base, '/api/memory/status');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
    expect((json['kinds'] as string[]).length).toBe(4);
  });

  it('⑥ GET /api/plugins — 业务模板 7 / 基础角色 3', async () => {
    const { status, json } = await getJson(run.base, '/api/plugins');
    expect(status).toBe(200);
    expect((json['counts'] as Json)['total']).toBe(10);
  });

  it('⑦ GET /api/conversation-loop/status — ready:true', async () => {
    const { status, json } = await getJson(run.base, '/api/conversation-loop/status');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
  });

  it('⑧ GET /api/roles/status — ready:true 且逐操作列出就绪视图（三类角色在 /reachability）', async () => {
    const { status, json } = await getJson(run.base, '/api/roles/status');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
    // status 是"就绪与依赖视图"（operations），不是别名端点；三类基础角色的清单在 /reachability。
    expect(Array.isArray(json['operations'])).toBe(true);
    expect((json['operations'] as unknown[]).length).toBeGreaterThan(0);
    const reach = await getJson(run.base, '/api/roles/reachability');
    expect(reach.status).toBe(200);
    expect((reach.json['roles'] as unknown[]).length).toBe(3);
  });

  it('⑨ GET /api/xls-facts/status — ready:true 且如实列未接线目标', async () => {
    const { status, json } = await getJson(run.base, '/api/xls-facts/status');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
    expect(Array.isArray(json['unverified'])).toBe(true);
  });

  it('⑩ GET /api/tool-loop/status — **结构化未就绪**（不是 404）【半截接线②功能证据】', async () => {
    const { status, json } = await getJson(run.base, '/api/tool-loop/status');
    expect(status).toBe(200); // 挂上了；模块自己给结构化未就绪
    expect(json['ready']).toBe(false);
    expect(typeof json['not_ready_reason']).toBe('string');
    expect(String(json['not_ready_reason'])).not.toBe('');
  });

  it('⑪ GET /api/session-adapters — ready:true', async () => {
    const { status, json } = await getJson(run.base, '/api/session-adapters');
    expect(status).toBe(200);
    expect(json['ready']).toBe(true);
  });

  it('⑫ GET /api/ppt-facts/status — ok:true', async () => {
    const { status, json } = await getJson(run.base, '/api/ppt-facts/status');
    expect(status).toBe(200);
    expect(json['ok']).toBe(true);
  });

  it('⑬ GET /api/adapters — 目录标三态（implemented / blocked / not_ready）', async () => {
    const { status, json } = await getJson(run.base, '/api/adapters');
    expect(status).toBe(200);
    const kinds = new Set((json['entryPoints'] as Json[]).map((e) => e['kind']));
    for (const k of kinds) expect(['implemented', 'not_ready', 'blocked']).toContain(k);
  });

  it('⑭ GET /api/adapters/readiness — 计数里 confirmed 未就绪 + 阻塞 > 0', async () => {
    const { status, json } = await getJson(run.base, '/api/adapters/readiness');
    expect(status).toBe(200);
    const totals = json['totals'] as Json;
    expect((totals['not_ready'] as number) + (totals['blocked'] as number)).toBeGreaterThan(0);
  });

  it('⑮ GET /api/definitely-not-mounted-w9 — 兜底 404 not_found（辨别力对照）', async () => {
    const { status, json } = await getJson(run.base, '/api/definitely-not-mounted-w9');
    expect(status).toBe(404);
    expect(json['code']).toBe('not_found');
  });

  it('⑯ POST /api/documents/:id/import 空 base64 ⇒ 422 invalid_base64（真校验）', async () => {
    const { status, json } = await postJson(run.base, '/api/documents/docW9/import', { docx_base64: '' });
    expect(status).toBe(422);
    expect(json['code']).toBe('invalid_base64');
  });

  it('⑰ 未挂前缀与已挂前缀可区分：/api/ppt-facts ⇒ 404 unknown_ppt_facts_route', async () => {
    const { status, json } = await getJson(run.base, '/api/ppt-facts');
    expect(status).toBe(404);
    expect(json['code']).toBe('unknown_ppt_facts_route');
    expect(json['code']).not.toBe('not_found');
  });

  it('⑱ 写口真落盘 + 跨请求读回：导入 docx 后导出 digest 一致（不是空壳）', async () => {
    const bytes = buildDocxTemplate({
      requirement: { title: '收尾对照样例', description: '正文不含数字。' },
      fact_snapshot: [],
      references: [],
    }).bytes;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const imp = await postJson(run.base, '/api/documents/w9-doc/import', {
      docx_base64: Buffer.from(bytes).toString('base64'),
    });
    expect(imp.status).toBe(200);
    const exp = await getJson(run.base, '/api/documents/w9-doc/export');
    expect(exp.status).toBe(200);
    // 导出的 digest 必须等于送进去字节的 sha256（不是进程内缓存的自我复述）
    expect(exp.json['digest']).toBe(digest);
  });
});

// ===========================================================================
// 2. 空壳端点复现（N-7-1 / N-7-2）
// ===========================================================================

describe('W9 · 空壳 / 别名端点（第六轮发现，本轮已闭合）', () => {
  it('N-7-1 已闭合：capability_discovery 恒返 503 结构化未就绪（no_capability_directory + unlock）', async () => {
    const queries = ['', 'doc', 'document', 'clock', 'meituan', 'x'];
    for (const q of queries) {
      const { status, json } = await postJson(run.base, '/api/roles/main-agent', {
        kind: 'capability_discovery',
        query: q,
      });
      // 判别力：回退成"成功的空结果"（200 { ok:true, capabilities:[] }）⇒ status 变 200 ⇒ 本行重新变红
      expect(status).toBe(503);
      expect(json['code']).toBe('roles_not_ready');
      expect(json['reason']).toBe('no_capability_directory');
      expect(json['ready']).toBe(false);
      expect(Array.isArray(json['unlock'])).toBe(true);
    }
    const { json } = await postJson(run.base, '/api/roles/main-agent', {
      kind: 'capability_discovery',
      query: '',
    });
    const raw = JSON.stringify(json);
    // 有结构化未就绪信号，且**没有**"成功的空能力列表"
    expect(raw).toContain('no_capability_directory');
    expect(raw).toContain('unlock');
    expect(json['capabilities']).toBeUndefined();
    expect(json['ok']).toBeUndefined();
  });

  it('N-7-1 对照：能力目录**真实存在**（/api/plugins 列出 10 个插件）——只是没接进这条链', async () => {
    const { json } = await getJson(run.base, '/api/plugins');
    const plugins = json['plugins'] as Json[];
    expect(plugins.length).toBe(10);
    expect(plugins.some((p) => Array.isArray(p['capability_ids']))).toBe(true);
  });

  it('N-7-2 已闭合：/api/roles/reachability 与 /api/roles/status **不再**逐字相同', async () => {
    const a = await fetch(`${run.base}/api/roles/reachability`);
    const b = await fetch(`${run.base}/api/roles/status`);
    const ta = await a.text();
    const tb = await b.text();
    // 判别力：回退成别名端点（两路由复用同一正文）⇒ ta === tb ⇒ 本行重新变红
    expect(ta).not.toBe(tb);
    const ja = JSON.parse(ta) as Json;
    const jb = JSON.parse(tb) as Json;
    expect('reachable_modules' in ja).toBe(true);
    expect('ready' in ja).toBe(false);
    expect('ready' in jb).toBe(true);
  });
});

// ===========================================================================
// 3. 未就绪诚实性（缺端口 ⇒ 结构化，不是 404）
// ===========================================================================

describe('W9 · 未就绪诚实性反向对照', () => {
  it('未装 loop ⇒ 503 loop_not_ready + unlock（不是 404）', async () => {
    const { createConversationLoopRoutes } = await import('../../../apps/demo/server/route-wiring.js');
    const routes = createConversationLoopRoutes({ loop: null } as never);
    const mounted = await startMounted((req, res) => routes.handle({ method: req.method ?? 'GET', pathname: new URL(req.url ?? '/', 'http://x').pathname, url: new URL(req.url ?? '/', 'http://x'), req, res } as never));
    try {
      const { status, json } = await getJson(mounted.base, '/api/conversation-loop/status');
      expect(status).toBe(503);
      expect(json['code']).toBe('loop_not_ready');
    } finally {
      await mounted.close();
    }
  });
});
