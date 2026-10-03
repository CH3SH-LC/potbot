/**
 * FA-VERIFY-WAVE-5 · §2 接线端点真伪（真 HTTP，≥10 个端点）。
 *
 * 对 `apps/demo/server/{documents-routes,research-routes,memory-routes,plugin-routes,route-wiring}`
 * 的端点，**经产品入口** `createDemoServer` 起的真实服务逐一打真实请求，判定：
 *
 * - **真做了事**：请求导致可核对的副作用（落盘 / 状态改变），或给出与"未就绪"可区分的诚实答案；
 * - **返回 200/404 但实际什么都没做**：空壳 / 恒成功 / 把"未就绪"说成"没有这个接口"。
 *
 * **每个正向都配反向对照**：同路径在**未装端口**的 handler 上必须给出**不同**的答案。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request, startProduct, startUnwired, type Running } from './http-util.js';

const RUN_DIR = mkdtempSync(join(tmpdir(), 'vw5-t2-'));
const UNWIRED_DIR = mkdtempSync(join(tmpdir(), 'vw5-t2-unwired-'));

let running: Running & { readonly demo: unknown };
let unwired: Running;

beforeAll(async () => {
  running = (await startProduct(RUN_DIR)) as Running & { readonly demo: unknown };
  unwired = await startUnwired(UNWIRED_DIR, { health: () => ({ ready: true }) });
}, 60_000);

afterAll(async () => {
  await running.close();
  await unwired.close();
  rmSync(RUN_DIR, { recursive: true, force: true });
  rmSync(UNWIRED_DIR, { recursive: true, force: true });
});

describe('§2.1 已接线前缀：答"真做了事"的一端', () => {
  it('① GET /api/memory/status → 200 且 ready=true（真装了持久端口）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/memory/status');
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(true);
    expect(r.body['reason']).toBeNull();
    // 四个记忆类型是真列的，不是空数组凑数
    expect(r.body['kinds']).toEqual(['session_message', 'task_fact', 'preference', 'template_experience']);
  });

  it('①R 反向对照：同路径在**未装端口**的 handler 上 → ready=false（不是 true）', async () => {
    const r = await request(unwired.baseUrl, 'GET', '/api/memory/status');
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(false);
    expect(String(r.body['reason'])).toContain('未注入记忆持久端口');
  });

  it('② GET /api/memory/entries?owner_id=<陌生> → 200 且结构化 not_found（不编造条目）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/memory/entries?owner_id=vw5-nobody');
    expect(r.status).toBe(200);
    expect(r.body['status']).toBe('not_found');
    expect(r.body['entries']).toEqual([]);
    expect((r.body['paging'] as Record<string, unknown>)['returned']).toBe(0);
  });

  it('③ POST /api/memory/status → 405（不是 500，也不是 200）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/memory/status', {});
    expect(r.status).toBe(405);
    expect(r.body['code']).toBe('method_not_allowed');
  });

  it('④ GET /api/plugins → 200 且 counts.total = 7 模板 + 3 基础角色', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/plugins');
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    const counts = r.body['counts'] as Record<string, unknown>;
    expect(counts['business_templates']).toBe(7);
    expect(counts['base_roles']).toBe(3);
    expect(counts['total']).toBe(10);
  });

  it('④R 反向对照：未装 store → 503 plugin_store_unwired（不是 200 列表）', async () => {
    const r = await request(unwired.baseUrl, 'GET', '/api/plugins');
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('plugin_store_unwired');
  });

  it('⑤ GET /api/plugins/template.does-not-exist → 404 unknown_plugin（与"整前缀未挂"可区分）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/plugins/template.does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body['code']).toBe('unknown_plugin');
  });

  it('⑥ GET /api/conversation-loop/status → 200 且 ready=true、reason=catalog_port_injected', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/conversation-loop/status');
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(true);
    expect(r.body['reason']).toBe('catalog_port_injected');
  });

  it('⑥R 反向对照：未装 loop → 503 loop_not_ready（带 unlock 指引）', async () => {
    const r = await request(unwired.baseUrl, 'GET', '/api/conversation-loop/status');
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('loop_not_ready');
    expect(Array.isArray(r.body['unlock'])).toBe(true);
  });

  it('⑦ GET /api/conversation-loop/<未知> → 404 unknown_loop_route（不是通用 not_found）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/conversation-loop/definitely-nope');
    expect(r.status).toBe(404);
    expect(r.body['code']).toBe('unknown_loop_route');
  });

  it('⑧ GET /api/adapters → 200（适配器产品面已挂）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/adapters');
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
  });

  it('⑨ GET /api/identity → 200 且带 runId / buildId', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/identity');
    expect(r.status).toBe(200);
    expect(typeof r.body['runId']).toBe('string');
    expect(typeof r.body['buildId']).toBe('string');
  });
});

describe('§2.2 真副作用：安装模板真的落盘并能跨进程读回', () => {
  it('⑩ POST /api/plugins/template.document/install → 真写状态；文件落盘；刷新后仍在', async () => {
    const before = await request(running.baseUrl, 'GET', '/api/plugins/template.document');
    expect(before.status).toBe(200);
    expect(before.body['install_record']).toBeNull();

    const install = await request(running.baseUrl, 'POST', '/api/plugins/template.document/install');
    expect([200, 201, 202]).toContain(install.status);

    const after = await request(running.baseUrl, 'GET', '/api/plugins/template.document');
    const record = after.body['install_record'] as Record<string, unknown> | null;
    expect(record).not.toBeNull();
    expect(record?.['plugin_id']).toBe('template.document');

    // 真落盘（不是进程内存冒充持久）
    const storeFile = join(RUN_DIR, 'plugins', 'plugin-store.json');
    expect(existsSync(storeFile)).toBe(true);
    const raw = readFileSync(storeFile, 'utf8');
    expect(raw).toContain('template.document');

    // 起**第二个**产品实例读同一个运行目录 ⇒ 状态跨实例存活
    const second = await startProduct(RUN_DIR);
    try {
      const reread = await request(second.baseUrl, 'GET', '/api/plugins/template.document');
      const rereadRecord = reread.body['install_record'] as Record<string, unknown> | null;
      expect(rereadRecord?.['plugin_id']).toBe('template.document');
    } finally {
      await second.close();
    }
  }, 60_000);
});

describe('§2.3 两组路由已**真挂载**：给出结构化答案，且与"根本不存在的路径"可区分', () => {
  it('⑪ GET /api/documents/status → 200（已挂载，注入产物端口 ⇒ ready=true；第五轮为 404 not_found）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/documents/status');
    expect(r.status).toBe(200);
    expect(r.body['root']).toBe('/api/documents');
    expect(r.body['ready']).toBe(true);
  });

  it('⑪R 反向对照：/api/documents/status 与**根本不存在的**路径给出**不同**答案（不再逐字相同）', async () => {
    const a = await request(running.baseUrl, 'GET', '/api/documents/status');
    const b = await request(running.baseUrl, 'GET', '/api/definitely-not-a-route');
    expect(a.status).toBe(200);
    expect(b.status).toBe(404);
    expect(b.body['code']).toBe('not_found');
    // 判别力：若该路由回退成"未挂载 ⇒ 落 /api/** 兜底 404"，a.status 会变回 404 ⇒ 本行变红
    expect(a.status).not.toBe(b.status);
    expect(a.body).not.toEqual(b.body);
  });

  it('⑫ GET /api/research/status → 200（已挂载；本机无联网/OCR ⇒ ready.chain_ready=false）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/research/status');
    expect(r.status).toBe(200);
    expect(r.body['root']).toBe('/api/research');
    expect((r.body['ready'] as Record<string, unknown>)['chain_ready']).toBe(false);
  });

  it('⑬ POST /api/research/query → 200 且结构化未就绪（不是 404，也不拿模型知识冒充）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/research/query', { query: 'x' });
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(false);
    expect(r.body['from_model_knowledge']).toBe(false);
    // 结构化未就绪：带 outcome.status = not-ready，绝不 500
    expect((r.body['outcome'] as Record<string, unknown>)['status']).toBe('not-ready');
  });

  it('⑭ POST /api/documents（产物生成，另一条既有路由）确实是 POST-only 且未被 404 吞掉', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/documents');
    // 既有产物路由：GET 不是它接受的动词 ⇒ 405（不是 404）⇒ 说明这条**确实挂上了**
    expect(r.status).toBe(405);
    expect(r.body['code']).toBe('method_not_allowed');
  });

  it('⑮ 已挂载前缀的根路径均 200，与不存在的命名空间 404 可区分', async () => {
    const memory = await request(running.baseUrl, 'GET', '/api/memory');
    const research = await request(running.baseUrl, 'GET', '/api/research');
    const nowhere = await request(running.baseUrl, 'GET', '/api/definitely-not-a-prefix');
    expect(memory.status).toBe(200);
    expect(research.status).toBe(200); // ← 第五轮此处为 404（research 未挂载）
    expect(nowhere.status).toBe(404);
    expect(nowhere.body['code']).toBe('not_found');
  });
});
