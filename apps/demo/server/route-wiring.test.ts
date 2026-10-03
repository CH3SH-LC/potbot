/**
 * FA-WIRE-PRODUCT-ROUTES 的定向套件：三组独立路由模块**挂到产品入口**之后的真实行为。
 *
 * 覆盖三类判据（每条都有反向对照）：
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 三个前缀各自可达 | 不是 404；产品（真实端口）下返回 200 |
 * | 未装配端口 = 结构化 503 | 不是 500、不是 404、不是假装可用 |
 * | 记忆真落盘 | 写一条 → 读回 → **换服务实例（同运行目录）仍在** |
 * | 既有路径不变 | `/health`、静态页、`/api/**` 兜底 404 与接线前同形 |
 *
 * 真实 HTTP：经 `createDemoServer` / `createDemoRequestHandler` **in-process** 起 `node:http` 服务。
 * 不跑全量、不跑 Gradle、不跑 live。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asLogicalTime, asRevision } from '../../../src/protocol/index.js';
import { createMemoryEntry } from '../../../src/memory/index.js';
import { createDemoServer, type DemoServer } from './main.js';
import { createDemoRequestHandler } from './http.js';
import { CONVERSATION_LOOP_ROOT } from './route-wiring.js';
import { JobIndex, createMemoryPersistence } from './jobs.js';
import { KernelHost } from './kernel.js';

const T = (n: number) => asLogicalTime(n);

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

interface RunningServer {
  readonly demo: DemoServer;
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startProduct(runDir: string): Promise<RunningServer> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  await listen(demo.server);
  const address = demo.server.address() as AddressInfo;
  return {
    demo,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(demo.server),
  };
}

/** 不带任何端口装配的裸入口（降级路径用）：`memoryRoutes` / `pluginRoutes` / `conversationLoop` 全缺省。 */
async function startBare(workDir: string, webDir: string): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const jobs = new JobIndex({ persistence: createMemoryPersistence(), runId: 'WIRE-BARE' });
  const host = new KernelHost({
    jobs,
    runDir: workDir,
    artifactRootDir: workDir.split('\\').join('/'),
    model: null,
    modelIsLive: false,
    documents: null,
    buildId: 'wire-bare',
  });
  const server = createServer(createDemoRequestHandler({ host, webDir }));
  await listen(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, close: () => closeServer(server) };
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

interface JsonReply {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function getJson(baseUrl: string, path: string): Promise<JsonReply> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<JsonReply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function idsOf(reply: JsonReply, key: string, field: string): string[] {
  const rows = reply.json[key];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => String((row as Record<string, unknown>)[field]));
}

// ---------------------------------------------------------------------------
// A. 产品装配（真实端口 + 真实 HTTP）
// ---------------------------------------------------------------------------

describe('A. 产品装配：三个前缀可达（真实端口）', () => {
  let runDir: string;
  let running: RunningServer;

  beforeAll(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'potbot-wire-'));
    running = await startProduct(runDir);
  });

  afterAll(async () => {
    if (running !== undefined) await running.close();
    rmSync(runDir, { recursive: true, force: true });
  });

  it('记忆：/api/memory/status 可达（不是 404）且就绪', async () => {
    const reply = await getJson(running.baseUrl, '/api/memory/status');
    expect(reply.status).toBe(200);
    expect(reply.json['ready']).toBe(true);
    expect(reply.json['root']).toBe('/api/memory');
  });

  it('模板平台：/api/plugins 可达（不是 404）且返回真实清单', async () => {
    const reply = await getJson(running.baseUrl, '/api/plugins');
    expect(reply.status).toBe(200);
    expect(Array.isArray(reply.json['plugins'])).toBe(true);
    expect((reply.json['plugins'] as unknown[]).length).toBeGreaterThan(0);
    expect(reply.json['ok']).toBe(true);
  });

  it('连续对话闭环：/api/conversation-loop/status 可达且就绪', async () => {
    const reply = await getJson(running.baseUrl, `${CONVERSATION_LOOP_ROOT}/status`);
    expect(reply.status).toBe(200);
    expect(reply.json['ready']).toBe(true);
    expect(reply.json['reason']).toBe('catalog_port_injected');
  });

  it('连续对话闭环：多轮归属同一任务（不新建第二个）+ 指代解析 + 结果解释', async () => {
    const conversationId = 'conv-wire-multi';
    const first = await postJson(running.baseUrl, `${CONVERSATION_LOOP_ROOT}/turns`, {
      conversation_id: conversationId,
      client_id: 'wire-c1',
      text: '帮我写一份周报。',
    });
    expect(first.status).toBe(200);
    expect(first.json['task_created']).toBe(true);
    const task = first.json['task'] as Record<string, unknown>;
    const taskId = String(task['task_id']);
    expect(taskId.length).toBeGreaterThan(0);

    const second = await postJson(running.baseUrl, `${CONVERSATION_LOOP_ROOT}/turns`, {
      conversation_id: conversationId,
      client_id: 'wire-c2',
      text: '再加一段本周风险。',
    });
    expect(second.status).toBe(200);
    expect(second.json['task_created']).toBe(false);
    expect(String((second.json['task'] as Record<string, unknown>)['task_id'])).toBe(taskId);

    const resolved = await postJson(running.baseUrl, `${CONVERSATION_LOOP_ROOT}/references/resolve`, {
      conversation_id: conversationId,
      hint: { kind: 'task', task_id: taskId },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.json['status']).toBe('resolved');

    const explained = await postJson(running.baseUrl, `${CONVERSATION_LOOP_ROOT}/explain`, {
      conversation_id: conversationId,
    });
    expect(explained.status).toBe(200);
    const explanation = explained.json['explanation'] as Record<string, unknown>;
    expect(typeof explanation['user_text']).toBe('string');
    expect((explanation['user_text'] as string).length).toBeGreaterThan(0);
  });

  it('反向对照：既有路径行为不变（/health、静态页、/api/** 兜底 404）', async () => {
    const health = await getJson(running.baseUrl, '/health');
    expect(health.status).toBe(200);
    expect(typeof health.json['ready']).toBe('boolean');

    const root = await fetch(`${running.baseUrl}/`);
    expect(root.status).toBe(200);

    const missing = await getJson(running.baseUrl, '/api/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// B. 未装配端口 = 结构化 503（不是 500、不是 404、不是假装可用）
// ---------------------------------------------------------------------------

describe('B. 未装配端口的降级路径：结构化 503', () => {
  let workDir: string;
  let bare: { baseUrl: string; close(): Promise<void> };

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-wire-bare-'));
    bare = await startBare(workDir, join(workDir, 'web'));
  });

  afterAll(async () => {
    if (bare !== undefined) await bare.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('记忆数据接口：无持久端口 ⇒ 503 memory_not_ready（不是 500 / 不是 404）', async () => {
    const reply = await getJson(bare.baseUrl, '/api/memory/entries?owner_id=owner-a');
    expect(reply.status).toBe(503);
    expect(reply.status).not.toBe(500);
    expect(reply.status).not.toBe(404);
    expect(reply.json['code']).toBe('memory_not_ready');
    expect(Array.isArray(reply.json['unlock'])).toBe(true);
  });

  it('记忆就绪探针：如实报 ready=false（不假装可用），仍不是 404', async () => {
    const reply = await getJson(bare.baseUrl, '/api/memory/status');
    expect(reply.status).toBe(200);
    expect(reply.json['ready']).toBe(false);
    expect(typeof reply.json['reason']).toBe('string');
  });

  it('模板平台：无 store ⇒ 整个 /api/plugins 503 plugin_store_unwired（不是 500 / 不是 404）', async () => {
    const list = await getJson(bare.baseUrl, '/api/plugins');
    expect(list.status).toBe(503);
    expect(list.status).not.toBe(500);
    expect(list.status).not.toBe(404);
    expect(list.json['code']).toBe('plugin_store_unwired');
    expect(list.json['stub']).toBe(true);

    const available = await getJson(bare.baseUrl, '/api/plugins/available-operations');
    expect(available.status).toBe(503);
    expect(available.json['code']).toBe('plugin_store_unwired');
  });

  it('连续对话闭环：无目录端口 ⇒ 整个前缀 503 loop_not_ready（不是 500 / 不是 404）', async () => {
    const turns = await postJson(bare.baseUrl, `${CONVERSATION_LOOP_ROOT}/turns`, {
      conversation_id: 'conv-bare',
      client_id: 'bare-c1',
      text: '写点什么。',
    });
    expect(turns.status).toBe(503);
    expect(turns.status).not.toBe(500);
    expect(turns.status).not.toBe(404);
    expect(turns.json['code']).toBe('loop_not_ready');
    expect(turns.json['ready']).toBe(false);

    const status = await getJson(bare.baseUrl, `${CONVERSATION_LOOP_ROOT}/status`);
    expect(status.status).toBe(503);
    expect(status.json['code']).toBe('loop_not_ready');
  });

  it('反向对照：裸入口下既有路径仍与接线前同形', async () => {
    const health = await getJson(bare.baseUrl, '/health');
    expect(health.status).toBe(200);

    const missing = await getJson(bare.baseUrl, '/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// C. 记忆真落盘（换服务实例、同运行目录仍在）
// ---------------------------------------------------------------------------

describe('C. 记忆落盘：写一条 → 读回 → 换服务实例仍在', () => {
  it('跨服务实例（同运行目录）读回同一条记忆', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'potbot-wire-persist-'));
    let first: RunningServer | null = null;
    let second: RunningServer | null = null;
    try {
      first = await startProduct(runDir);

      // 写一条：经**产品入口持有的同一个记忆宿主**（落盘端口就是它读写的那个文件）。
      const access = first.demo.memoryRoutes.open();
      expect(access.ok).toBe(true);
      if (!access.ok) throw new Error(access.message);
      const remembered = access.repository.remember(
        createMemoryEntry({
          kind: 'preference',
          memory_id: 'mem-wire-persist-1',
          owner_id: 'owner-wire',
          scope: { kind: 'user', task_id: null, template_id: null },
          source: { kind: 'user_statement', detail: '接线落盘测试' },
          confirmation: 'confirmed',
          created_at: T(10),
          updated_at: T(10),
          version: asRevision(0),
          status: 'active',
          preference_key: 'font',
          value_text: '宋体',
        }),
      );
      expect(remembered.ok).toBe(true);
      first.demo.memoryRoutes.persist(T(11));

      const readBack = await getJson(first.baseUrl, '/api/memory/entries?owner_id=owner-wire');
      expect(readBack.status).toBe(200);
      expect(idsOf(readBack, 'entries', 'memory_id')).toContain('mem-wire-persist-1');

      // 换服务实例：关掉第一个，用**同一运行目录**再起一个。
      await first.close();
      first = null;
      second = await startProduct(runDir);
      const afterRestart = await getJson(second.baseUrl, '/api/memory/entries?owner_id=owner-wire');
      expect(afterRestart.status).toBe(200);
      expect(idsOf(afterRestart, 'entries', 'memory_id')).toContain('mem-wire-persist-1');
    } finally {
      if (first !== null) await first.close();
      if (second !== null) await second.close();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
