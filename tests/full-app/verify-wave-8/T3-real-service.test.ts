/**
 * FA-VERIFY-WAVE-8 · T3 —— **真服务对抗**（本轮第四疑点）。
 *
 * 经**产品入口** `createDemoServer`（真 `node:http`、真 `fetch`、真落盘）起一个服务，
 * 把**所有已知前缀**各打一次，与 `dispatch-graph` 里的派发表**交叉核对**：
 * **有派发行却落兜底 404 = bug**（这正是"合并吞掉派发"的运行时形态）。
 *
 * 反向对照：一个确实不存在的路径必须是兜底 404（证明本用例能分辨"派发了"与"没派发"）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDemoServer, type DemoServer } from '../../../apps/demo/server/main.js';
import { DELEGATED_ROUTES, OWN_ROUTES, isCatchAll404 } from './dispatch-graph.js';

interface Hit {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

let demo: DemoServer;
let base: string;

const hit = async (method: string, path: string): Promise<Hit> => {
  const res = await fetch(`${base}${path}`, { method });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // 非 JSON（静态页等）：body 留空
  }
  return { status: res.status, body };
};

beforeAll(async () => {
  demo = await createDemoServer({ POTBOT_RUN_DIR: mkdtempSync(join(tmpdir(), 'fa-vw8-svc-')) });
  await new Promise<void>((resolve, reject) => {
    demo.server.once('error', reject);
    demo.server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = demo.server.address() as AddressInfo;
  base = `http://127.0.0.1:${String(port)}`;
}, 60000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    demo.server.close(() => {
      resolve();
    });
  });
});

describe('T3 · 真服务对抗', () => {
  it('每个转交前缀都活着（不落兜底 404）', async () => {
    // 防"空断言"：转交前缀至少要有 12 个（少于此说明抓漏了）。
    expect(DELEGATED_ROUTES.length).toBeGreaterThanOrEqual(12);
    const dead: Record<string, unknown> = {};
    for (const unit of DELEGATED_ROUTES) {
      const res = await hit('GET', unit.root);
      if (isCatchAll404(res.body)) dead[unit.root] = res;
    }
    expect(dead).toEqual({});
  });

  it('每个自有前缀都活着（不落兜底 404）', async () => {
    const dead: Record<string, unknown> = {};
    for (const route of OWN_ROUTES) {
      const res = await hit('GET', route.probe);
      if (isCatchAll404(res.body)) dead[route.root] = res;
    }
    expect(dead).toEqual({});
  });

  it('POST-only 的入口给 405（而非兜底 404）', async () => {
    for (const path of ['/api/documents', '/api/sessions', '/api/deliverables']) {
      const res = await hit('GET', path);
      expect(res.status, `${path} 应 405`).toBe(405);
      expect(res.body['code']).toBe('method_not_allowed');
      expect(isCatchAll404(res.body)).toBe(false);
    }
  });

  it('健康与身份端点如实作答', async () => {
    const health = await hit('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body['ready']).toBe(true);
    // 无模型配置时如实 false，绝不假装能生成。
    expect(health.body['modelConfigured']).toBe(false);
    const identity = await hit('GET', '/api/identity');
    expect(identity.status).toBe(200);
    expect(typeof identity.body['runId']).toBe('string');
  });

  it('每个已知前缀都不返回"裸 500"（未就绪要结构化，不是内部错误）', async () => {
    const roots = [...DELEGATED_ROUTES.map((unit) => unit.root), ...OWN_ROUTES.map((route) => route.probe)];
    const fiveHundreds: Record<string, unknown> = {};
    for (const root of roots) {
      const res = await hit('GET', root);
      if (res.status >= 500) fiveHundreds[root] = res;
    }
    expect(fiveHundreds).toEqual({});
  });

  it('反向对照：确实不存在的路径必须是兜底 404（证明本用例分得清）', async () => {
    const res = await hit('GET', '/api/definitely-not-a-route-xyz');
    expect(res.status).toBe(404);
    expect(isCatchAll404(res.body)).toBe(true);
  });
});
