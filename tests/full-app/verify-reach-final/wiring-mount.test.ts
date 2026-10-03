/**
 * FA-VERIFY-REACH-FINAL · 接线波的产品面独立验证（真 `node:http` + 真产品入口）。
 *
 * 被测：经**产品入口** `main.ts`（`createDemoServer` → `createDemoRequestHandler`）实测。
 *
 * ## 本文件在第五轮（HEAD `8e5bf46`）留的**翻正钩子已翻正**（HEAD `0529754`）
 *
 * 1. 第五轮实测发现：`documents-routes.ts` / `research-routes.ts` 只是被
 *    `main.ts` / `http.ts` / `route-wiring.ts` **import**（`http.ts` 还把 handle 构造成从未被读的
 *    局部变量），分发链**从未调用** ⇒ 产品服务上 `/api/documents/status`、`/api/research/status`
 *    **实测 404**（import-only 接线）。当时把期望钉成 404，并声明"协调者一旦真挂载就变红"。
 * 2. **本轮协调者真的改了**（`49e3073` 补派发调用、`0529754` 挂 roles 路由）：三条前缀现在都
 *    被 `createDemoRequestHandler` 真调用。本文件**把 §0 的期望从 404 翻成 200**
 *    （下方实测状态码为证），并新增 `/api/roles/reachability` 的 200 实测。
 * 2b. **`fa/fix-weak-control` 后**（HEAD `e4bb1b7`）：`/api/roles/reachability` 与 `/api/roles/status`
 *    从"逐字相同的别名端点"拆成两个视图 —— §0 相应翻正为"reachability 给模块清单（**无** ready）、
 *    status 给就绪视图（ready === true）"，并保留"两正文必须不同"的反向对照。
 * 3. **保留的判据**：import-only 与真派发的**静态**区分（handler 名在 `http.ts` 里出现几次）仍在本文件
 *    与 `reachability.test.ts` §2.5 里保留，并用真实历史快照 `8e5bf46:http.ts` 反向对照。
 *
 * 【反空断言】每个"正向"都配一个**能变红的反向对照**：同一条路径在**未装端口**的
 * handler 上必须给出不同的、可判定的结果。恒真的断言在这里过不了。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { createDemoRequestHandler } from '../../../apps/demo/server/http.js';
import { createDemoServer, type DemoServer } from '../../../apps/demo/server/main.js';
import {
  createDocumentsRouteHost,
  handleDocumentsRequest,
  type DocumentStorePort,
} from '../../../apps/demo/server/documents-routes.js';
import { createResearchRouteHost, handleResearchRequest } from '../../../apps/demo/server/research-routes.js';
import { classifyDispatch } from './reach-scan.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

interface Json {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function req(
  baseUrl: string,
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<Json> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, json: parsed };
}

// ---------------------------------------------------------------------------
// 产品服务（真 main.ts）
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const liveServers: Server[] = [];

afterAll(async () => {
  while (liveServers.length > 0) await close(liveServers.pop() as Server);
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

let productPromise: Promise<{ demo: DemoServer; baseUrl: string; runDir: string }> | null = null;

async function product(): Promise<{ demo: DemoServer; baseUrl: string; runDir: string }> {
  productPromise ??= (async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'fa-reach-final-product-'));
    tempDirs.push(runDir);
    const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    const baseUrl = await listen(demo.server);
    liveServers.push(demo.server);
    return { demo, baseUrl, runDir };
  })();
  return productPromise;
}

/** 未装配端口的产品 handler（同一条 http 分发链，只是三组端口缺席）——反向对照用。 */
async function bareHandler(): Promise<string> {
  const { demo } = await product();
  const handler = createDemoRequestHandler({
    host: demo.host,
    webDir: demo.paths.webDir,
  });
  const server = createServer(handler);
  const baseUrl = await listen(server);
  liveServers.push(server);
  return baseUrl;
}

// ===========================================================================
// 0. 任务书点名的接线模块：存在 + 落在入口 import 闭包 + **实测分发真相**
// ===========================================================================

describe('0. 任务书点名的接线模块（documents-routes / research-routes）', () => {
  it('两个文件在本 HEAD **存在**（第四轮普查时的不存在结论已过期）', () => {
    expect(existsSync(join(ROOT, 'apps/demo/server/documents-routes.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'apps/demo/server/research-routes.ts'))).toBe(true);
    // 反向对照：本轮确实存在的其余接线模块
    for (const f of ['route-wiring.ts', 'memory-routes.ts', 'plugin-routes.ts', 'conversation-loop.ts']) {
      expect(existsSync(join(ROOT, 'apps/demo/server', f)), `${f} 应存在`).toBe(true);
    }
  });

  it('两个模块都被产品入口 import 进静态闭包（这是 documents 44 个模块翻"可达"的全部来源）', () => {
    const http = readFileSync(join(ROOT, 'apps/demo/server/http.ts'), 'utf8');
    const main = readFileSync(join(ROOT, 'apps/demo/server/main.ts'), 'utf8');
    const wiring = readFileSync(join(ROOT, 'apps/demo/server/route-wiring.ts'), 'utf8');
    expect(http.includes("from './documents-routes.js'"), 'http.ts import 了文档路由').toBe(true);
    expect(http.includes("from './research-routes.js'"), 'http.ts import 了检索路由').toBe(true);
    expect(main.includes("from './documents-routes.js'"), 'main.ts 也 import 了文档路由').toBe(true);
    expect(wiring.includes("from './documents-routes.js'"), 'route-wiring.ts 也 import 了文档路由').toBe(true);
    // 反向对照：一个**不存在**的模块名不会被 import（证明上面的检查有辨别力）
    expect(http.includes("from './definitely-not-a-route-module.js'")).toBe(false);
    // 判别实验（可复现）：删掉上面全部指向这两组路由的 import 行后重跑扫描器 ⇒ 44 个整批退回不可达
    // （488/385/103）；只删其中一处没有效果 —— 任一 import 边存在即足以托住这 44 个。
  });

  it('**实测（关键，已翻正）**：产品服务上 /api/documents/status 与 /api/research/status 现为 200 —— 分发链已挂载（第五轮为 404）', async () => {
    const { baseUrl } = await product();

    const docs = await req(baseUrl, '/api/documents/status');
    expect(
      docs.status,
      '产品入口注入了文件落盘产物端口 ⇒ 已挂载，应为 200（第五轮 import-only 时为 404）',
    ).toBe(200);
    expect(docs.json['root']).toBe('/api/documents');
    expect(docs.json['ready'], '注入真端口 ⇒ ready 为 true').toBe(true);

    const research = await req(baseUrl, '/api/research/status');
    expect(research.status, '检索路由已挂载：本机无联网/OCR 端口 ⇒ 200 但 ready 如实未就绪').toBe(200);
    expect(research.json['root']).toBe('/api/research');
    expect((research.json['ready'] as Record<string, unknown>)['chain_ready']).toBe(false);

    // 反向对照：同一个产品服务上**真挂载**的兄弟前缀同样答 200/非 404（证明探针与服务器都正常）
    expect((await req(baseUrl, '/api/memory/status')).status).toBe(200);
    expect((await req(baseUrl, '/api/plugins')).status).not.toBe(404);
  });

  it('**实测（已翻正）**：/api/roles/reachability ⇒ 200 且给模块清单；/api/roles/status ⇒ 200 且 ready === true（两视图已分开）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/roles/reachability');
    expect(r.status, 'roles 路由已挂进产品（第五轮该前缀落 404）').toBe(200);
    expect(r.json['root']).toBe('/api/roles');
    // 翻正：本轮已把 `/reachability`（模块清单 / 边界面）与 `/status`（就绪与依赖）**分开**；
    // 修复前二者是逐字相同的别名端点。故 reachability 现在**不再**带 ready，而是带模块清单。
    expect(Array.isArray(r.json['reachable_modules']), 'reachability 给可达模块清单').toBe(true);
    // 判别力：若回退成"别名端点"（reachability 复用 status 正文），本行立刻重新变红。
    expect(r.json['ready'], 'reachability 不再复述就绪（那是 /status 的事）').toBeUndefined();

    const status = await req(baseUrl, '/api/roles/status');
    expect(status.status, '/api/roles/status 同前缀已挂载').toBe(200);
    expect(status.json['ready'], 'main.ts 注入了 store + 复用 memoryRoutes 的同一 repository ⇒ ready').toBe(true);
    // 判别力之二：两个端点响应体必须**不同**（别名端点会给出逐字相同的正文）
    expect(JSON.stringify(r.json)).not.toBe(JSON.stringify(status.json));

    // 反向对照：前缀内的未知子路径**不是 200**。实测：GET 走"非读方法 ⇒ 405 只接受 POST"分支；
    // POST 才落到 switch 的 default ⇒ 404 unknown_roles_route（两种答案与"前缀本身没接"的 not_found 都分开）。
    const unknownGet = await req(baseUrl, '/api/roles/definitely-not-a-route');
    expect(unknownGet.status, 'GET 未知子路径 ⇒ 405（不是 200）').toBe(405);
    const unknownPost = await req(baseUrl, '/api/roles/definitely-not-a-route', { method: 'POST' });
    expect(unknownPost.status, 'POST 未知子路径 ⇒ 404 unknown_roles_route').toBe(404);
    expect(unknownPost.json['code']).toBe('unknown_roles_route');
  });

  it('静态取证（已翻正）：http.ts **已调用** handleDocumentsRequest / handleResearchRequest / rolesWiring.handle', () => {
    const http = readFileSync(join(ROOT, 'apps/demo/server/http.ts'), 'utf8');
    const countOf = (needle: string): number => http.split(needle).length - 1;
    expect(
      countOf('handleDocumentsRequest'),
      'import（1）+ 分发链调用（≥1）⇒ ≥2；若回退成 import-only 会变回 1，本用例即变红',
    ).toBeGreaterThanOrEqual(2);
    expect(
      countOf('handleResearchRequest'),
      '同上',
    ).toBeGreaterThanOrEqual(2);
    expect(countOf('rolesWiring'), 'rolesWiring 被真调用（含装配与分发链）').toBeGreaterThanOrEqual(2);
    // 反向对照：既有真挂载的三组在分发链里**确实**被调用
    expect(countOf('handleMemoryRequest')).toBeGreaterThanOrEqual(2);
    expect(countOf('handlePluginRequest')).toBeGreaterThanOrEqual(2);
    // 保留判据：import-only 检测器对 HEAD 与历史快照给出不同答案（详见 reachability.test.ts §2.5）
    expect(classifyDispatch(http, 'handleDocumentsRequest', 'documents-routes').kind).toBe('dispatched');
  });

  it('反向对照：从未挂载的命名空间仍是 404 not_found（探针有辨别力）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/definitely-not-mounted');
    expect(r.status).toBe(404);
    expect(r.json['code']).toBe('not_found');
  });
});

// ===========================================================================
// 0b. 两组路由模块**自身**可用（手工挂载 ⇒ 有真实 HTTP 响应）
//     —— 与产品分发链分开判：模块没问题，缺的只是分发链那一行
// ===========================================================================

describe('0b. 两组路由模块自身的可用性（独立手工挂载；产品现也已挂载，见 §0）', () => {
  function memoryStore(): DocumentStorePort {
    const files = new Map<string, Uint8Array>();
    return {
      read: (id) => files.get(id) ?? null,
      write: (id, bytes) => {
        files.set(id, bytes);
      },
    };
  }

  it('手工把 handleDocumentsRequest 接进 node:http ⇒ /api/documents/status 200（同一路径在产品服务上现亦为 200）', async () => {
    const host = createDocumentsRouteHost({ store: memoryStore() });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      void handleDocumentsRequest({ req: request, res: response, url, host }).then((handled) => {
        if (!handled) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{"code":"not_found"}');
        }
      });
    });
    const baseUrl = await listen(server);
    liveServers.push(server);

    const r = await req(baseUrl, '/api/documents/status');
    expect(r.status, '模块本身可用：一行挂载即 200').toBe(200);
    expect(r.json['ready'], '注入了产物端口 ⇒ ready 为 true').toBe(true);
    expect(r.json['root']).toBe('/api/documents');
    // 反向对照：另一组前缀交回调用方（返回 false ⇒ 落到 404）
    expect((await req(baseUrl, '/api/research/status')).status).toBe(404);
  });

  it('反向对照：无产物端口 ⇒ /api/documents/status 仍是 200 但 ready === false（不假装可用）', async () => {
    const host = createDocumentsRouteHost({});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      void handleDocumentsRequest({ req: request, res: response, url, host }).then((handled) => {
        if (!handled) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{"code":"not_found"}');
        }
      });
    });
    const baseUrl = await listen(server);
    liveServers.push(server);
    const r = await req(baseUrl, '/api/documents/status');
    expect(r.status).toBe(200);
    expect(r.json['ready'], '无端口 ⇒ 如实 false').toBe(false);
    expect(r.json['reason']).not.toBeNull();
  });

  it('手工把 handleResearchRequest 接进 node:http ⇒ /api/research/status 200（同一路径在产品服务上现亦为 200）', async () => {
    const host = createResearchRouteHost({});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      void handleResearchRequest({ req: request, res: response, url }, { host }).then((handled) => {
        if (!handled) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{"code":"not_found"}');
        }
      });
    });
    const baseUrl = await listen(server);
    liveServers.push(server);

    const r = await req(baseUrl, '/api/research/status');
    expect(r.status, '模块本身可用：一行挂载即 200').toBe(200);
    expect(r.json['root']).toBe('/api/research');
    expect((r.json['ready'] as Record<string, unknown>)['chain_ready'], '本机无联网/OCR ⇒ 整链如实未就绪').toBe(false);
    // 反向对照：另一组前缀交回调用方
    expect((await req(baseUrl, '/api/documents/status')).status).toBe(404);
  });
});

// ===========================================================================
// 1. 记忆入口 /api/memory/**
// ===========================================================================

describe('1. 记忆入口：产品服务上真的挂上了（且带真持久端口）', () => {
  it('GET /api/memory/status ⇒ 200 且 ready === true（证明 main.ts 注入了文件落盘端口）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/memory/status');
    expect(r.status, '不再是 404：该前缀已被产品入口接管').toBe(200);
    expect(r.json['ready'], '真持久端口 ⇒ ready 必须为 true').toBe(true);
    expect(r.json['root']).toBe('/api/memory');
    expect(r.json['isolation']).toBe('per_owner');
  });

  it('反向对照：未装端口的 handler 上同一条路径 ready === false（判据有辨别力）', async () => {
    const bare = await bareHandler();
    const r = await req(bare, '/api/memory/status');
    expect(r.status).toBe(200);
    expect(r.json['ready'], '无持久端口 ⇒ 如实 false，不假装').toBe(false);
    expect(r.json['reason']).not.toBeNull();
  });

  it('数据接口：产品上可查到空记忆（200），未装端口时是结构化 503（不是 404/500）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/memory/entries?owner_id=owner-a');
    expect(r.status).toBe(200);

    const bare = await bareHandler();
    const notReady = await req(bare, '/api/memory/entries?owner_id=owner-a');
    expect(notReady.status, '未就绪 ⇒ 503，不退回进程内存').toBe(503);
    expect(typeof notReady.json['code']).toBe('string');
  });

  it('方法反向对照：POST /api/memory/status ⇒ 405（不是 200，也不是 404）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/memory/status', { method: 'POST' });
    expect(r.status).toBe(405);
  });
});

// ===========================================================================
// 2. 模板入口 /api/plugins/**
// ===========================================================================

describe('2. 模板平台入口：产品服务上真的挂上了（且带文件落盘 store）', () => {
  it('GET /api/plugins ⇒ 非 404；未装 store 的 handler ⇒ 503 plugin_store_unwired', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/plugins');
    expect(r.status, '产品入口注入了 InstallStateStore ⇒ 不应是 404').not.toBe(404);
    expect(r.status, '注入了真 store ⇒ 不应是 503').not.toBe(503);

    const bare = await bareHandler();
    const unwired = await req(bare, '/api/plugins');
    expect(unwired.status, '无持久介质 ⇒ 结构化 503').toBe(503);
    expect(unwired.json['code']).toBe('plugin_store_unwired');
  });

  it('未知插件 ⇒ 404（模块自己的 404，与"整模块 503"是两种不同的答案）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/plugins/template.does-not-exist');
    expect(r.status).toBe(404);
  });
});

// ===========================================================================
// 3. 连续对话闭环入口 /api/conversation-loop/**
// ===========================================================================

describe('3. 连续对话闭环入口：产品服务上真的挂上了', () => {
  it('GET /api/conversation-loop/status ⇒ 200 且 ready === true', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/conversation-loop/status');
    expect(r.status, '不再是 404').toBe(200);
    expect(r.json['ready']).toBe(true);
    expect(r.json['root']).toBe('/api/conversation-loop');
  });

  it('反向对照：loop 为 null 的装配 ⇒ 503 loop_not_ready（且带 unlock 指引）', async () => {
    const { createConversationLoopRoutes } = await import('../../../apps/demo/server/route-wiring.js');
    const routes = createConversationLoopRoutes({ loop: null });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      void routes
        .handle({ method: request.method ?? 'GET', pathname: url.pathname, url, req: request, res: response })
        .then((handled) => {
          if (!handled) {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{"code":"not_found"}');
          }
        });
    });
    const baseUrl = await listen(server);
    liveServers.push(server);

    const r = await req(baseUrl, '/api/conversation-loop/status');
    expect(r.status).toBe(503);
    expect(r.json['code']).toBe('loop_not_ready');
    expect(Array.isArray(r.json['unlock'])).toBe(true);
  });

  it('前缀内的未知子路径 ⇒ 404 unknown_loop_route（与"前缀本身没接"分开判）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/conversation-loop/definitely-not-a-route');
    expect(r.status).toBe(404);
    expect(r.json['code']).toBe('unknown_loop_route');
  });

  it('POST /api/conversation-loop/status ⇒ 405；缺字段的 turns ⇒ 400（不是 500）', async () => {
    const { baseUrl } = await product();
    expect((await req(baseUrl, '/api/conversation-loop/status', { method: 'POST' })).status).toBe(405);
    const bad = await req(baseUrl, '/api/conversation-loop/turns', { method: 'POST', body: {} });
    expect(bad.status).toBe(400);
    expect(typeof bad.json['code']).toBe('string');
  });

  it('真跑一次 turns：产品端口装配的闭环能接住一轮提交（正向，非仅探针）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/conversation-loop/turns', {
      method: 'POST',
      body: { conversation_id: 'c-1', client_id: 'k-1', text: '把这段话写成正式一点的文件' },
    });
    // 允许业务上拒绝，但必须是**结构化**答案而不是 5xx / 404 / 503
    expect([200, 400, 409, 422]).toContain(r.status);
    expect(typeof r.json['ok']).toBe('boolean');
    if (r.status === 200) expect(r.json['ok']).toBe(true);
  });
});

// ===========================================================================
// 4. 与既有 e2e-routes 用例的**矛盾**（只报告，不修）
// ===========================================================================

describe('4. 既有 e2e-routes.test.ts 的"产品未接线 ⇒ 404"断言已与代码矛盾', () => {
  it('实测：产品服务上 /api/memory/status 与 /api/plugins **都不是** 404', async () => {
    const { baseUrl } = await product();
    const memoryStatus = await req(baseUrl, '/api/memory/status');
    const plugins = await req(baseUrl, '/api/plugins');
    // apps/demo/server/e2e-routes.test.ts:131-135 断言这三个都是 404 —— 本实测与之矛盾。
    expect(memoryStatus.status).not.toBe(404);
    expect(plugins.status).not.toBe(404);
  });

  it('同一时刻，真正未接线的命名空间仍是 404（证明探针本身有辨别力）', async () => {
    const { baseUrl } = await product();
    const r = await req(baseUrl, '/api/this-namespace-does-not-exist');
    expect(r.status).toBe(404);
    expect(r.json['code']).toBe('not_found');
  });
});
