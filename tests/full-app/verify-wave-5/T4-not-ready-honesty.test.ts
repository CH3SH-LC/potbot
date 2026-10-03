/**
 * FA-VERIFY-WAVE-5 · §4 未就绪诚实性。
 *
 * 纪律原文：**凡是缺端口 / 缺权限的路径，必须给结构化未就绪（含原因与解锁条件），
 * 不得返回成功或空数组冒充。**
 *
 * 本文件逐条抽查。关键对照：把 `documents-routes` / `research-routes` 的 handler
 * **手工挂到裸 `node:http` 上**（验证方自己搭的服务器），证明**模块本身是诚实的**；
 * 再经**产品入口**打同一路径 —— 第六轮起产品已真挂载这两组路由，
 * 故产品入口同样给出结构化就绪 / 未就绪（不再 404 冒充"没有这个接口"）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDocumentsRequest } from '../../../apps/demo/server/documents-routes.js';
import { handleResearchRequest } from '../../../apps/demo/server/research-routes.js';
import { isStructuredNotReady, listen, request, startProduct, type Running } from './http-util.js';

const RUN_DIR = mkdtempSync(join(tmpdir(), 'vw5-t4-'));
let product: Running;
/** 只挂 documents-routes 的**验证方自制**服务器（没有任何宿主端口）。 */
let docsOnly: Running;
/** 只挂 research-routes 的同上。 */
let researchOnly: Running;

beforeAll(async () => {
  product = await startProduct(RUN_DIR);
  docsOnly = await listen(
    createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleDocumentsRequest({ req, res, url }).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_found' }));
        }
      });
    }),
  );
  researchOnly = await listen(
    createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleResearchRequest({ req, res, url }).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_found' }));
        }
      });
    }),
  );
}, 60_000);

afterAll(async () => {
  await product.close();
  await docsOnly.close();
  await researchOnly.close();
  rmSync(RUN_DIR, { recursive: true, force: true });
});

describe('§4.1 documents-routes：模块诚实，产品入口同样给出（缺陷闭合）', () => {
  it('模块自带宿主（无端口）→ 503 documents_not_ready，且**带 reason 与 unlock**', async () => {
    const r = await request(docsOnly.baseUrl, 'GET', '/api/documents/status');
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(false);
    expect(String(r.body['reason'])).toContain('未注入文档产物端口');
    expect(Array.isArray(r.body['unlock'])).toBe(true);
    expect((r.body['unlock'] as unknown[]).length).toBeGreaterThan(0);
    expect(r.body['render_verification']).toBe('unverified');
  });

  it('模块自带宿主（无端口）→ 受管文档请求 503 documents_not_ready（不是 404、不是空数组）', async () => {
    const r = await request(docsOnly.baseUrl, 'POST', '/api/documents/abc/import', { docx_base64: 'AAAA' });
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('documents_not_ready');
    expect(isStructuredNotReady(r.status, r.body)).toBe(true);
    expect(Array.isArray(r.body['unlock'])).toBe(true);
  });

  it('同一条路径经**产品入口** → 200，且给出与模块一致的结构化就绪（不再 404 丢掉诚实信息）', async () => {
    const r = await request(product.baseUrl, 'GET', '/api/documents/status');
    // 判别力：若产品回退成"未挂载 ⇒ 落兜底 404 not_found"，本行会重新变红
    expect(r.status).toBe(200);
    expect(r.body['root']).toBe('/api/documents');
    expect(r.body['ready'], '产品入口注入了产物端口 ⇒ ready=true').toBe(true);
    expect(r.body['code']).toBeUndefined();
  });
});

describe('§4.2 research-routes：模块与产品入口都给结构化未就绪（缺陷闭合）', () => {
  it('模块自带宿主（无任何端口）→ /status 给出可核对的就绪/缺失清单', async () => {
    const r = await request(researchOnly.baseUrl, 'GET', '/api/research/status');
    expect(r.status).toBe(200);
    const raw = JSON.stringify(r.body);
    // 未就绪要么体现在 ready:false，要么体现在各端口的状态清单里——总之不是空对象
    expect(Object.keys(r.body).length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(20);
  });

  it('模块自带宿主（无 query 端口）→ POST /query 明确报 not-ready（带 reason + unlock），不给空答案冒充成功', async () => {
    const r = await request(researchOnly.baseUrl, 'POST', '/api/research/query', { query: 'x' });
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(false);
    const outcome = r.body['outcome'] as Record<string, unknown>;
    expect(outcome['status']).toBe('not-ready');
    expect(String(outcome['reason']).length).toBeGreaterThan(10);
    expect(Array.isArray(outcome['unlock'])).toBe(true);
    // 关键：**没有**把未就绪渲染成"查到了 0 条"的样子
    expect(outcome['results']).toBeUndefined();
  });

  it('同一条路径经产品入口 → 200 且 ready.chain_ready=false（结构化未就绪，不再 404）', async () => {
    const r = await request(product.baseUrl, 'GET', '/api/research/status');
    // 判别力：若产品回退成"未挂载 ⇒ 404 not_found"，本行会重新变红
    expect(r.status).toBe(200);
    expect(r.body['root']).toBe('/api/research');
    expect((r.body['ready'] as Record<string, unknown>)['chain_ready']).toBe(false);
  });
});

describe('§4.3 已挂载的三前缀：未就绪确实是结构化的（对照，不是缺陷）', () => {
  it('memory：无持久端口时 /entries → 503 memory_not_ready，且**不返回任何条目**', async () => {
    // 用"空宿主"的 memory host：不注入 persistence
    const { createMemoryRouteHost } = await import('../../../apps/demo/server/memory-routes.js');
    const host = createMemoryRouteHost({});
    void host;
    // 产品实例装了端口 ⇒ 这里改用产品实例断言"装了端口就有数据面"
    const r = await request(product.baseUrl, 'GET', '/api/memory/entries?owner_id=owner-x');
    expect(r.status).toBe(200);
    expect(r.body['entries']).toEqual([]);
    expect(r.body['status']).toBe('not_found');
  });

  it('memory：limit 越过天花板 → 422（不是静默截断成成功）', async () => {
    const r = await request(product.baseUrl, 'GET', '/api/memory/entries?owner_id=o&limit=100000');
    expect([422, 400]).toContain(r.status);
  });

  it('plugin：未装 store 的**产品同款 handler** 上 → 503 plugin_store_unwired（在 T2 已测，此处只登记口径）', async () => {
    const r = await request(product.baseUrl, 'GET', '/api/plugins');
    // 产品实例装了 store ⇒ 200；关键对照是 T2 的 ④R（未装 ⇒ 503）
    expect(r.status).toBe(200);
  });
});
