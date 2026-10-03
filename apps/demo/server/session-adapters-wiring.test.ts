/**
 * FA-FIX-TAUTOLOGY · `/api/session-adapters/**` 的**真 HTTP** 测试。
 *
 * 三条被点名的"接线空转"逐条有正例 + 反向对照：
 *
 * | 点名 | 正例（真的调用了） | 反向对照（判据不恒真） |
 * |---|---|---|
 * | **N-5-4** 两个会话适配器只被 barrel 导出 | `status` 报出 `calClockToolAdapter.tool`；`cal-clock` 真的建出自管提醒；`research-citations` 真的渲染出带出处的正文并导出字节 | 未知 op ⇒ `unsupported_op`；**无引用的"事实"句**被拒（不冒充），导出随之 `ok:false` |
 * | **N-5-5** `budget-wiring.ts` 只有自己的 test | `tool-call` 真的过 `admit()` 才放行 | 额度用尽 ⇒ `429 budget_exhausted`；预算未装配 ⇒ `503`（**不是**"不设限"）|
 * | **N-5-6** 检查点归约只有自己的 test | `POST /checkpoint` 落盘 → `GET` 读回带恢复计划 | 没有检查点时 `GET` 报 `absent`、`restore` 报 409（**不是**假装恢复）|
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeCheckpointRecovery, createSessionAdaptersWiring } from './session-adapters-wiring.js';
import { createProductBudget } from './budget-wiring.js';
import { createDemoServer, type DemoServer } from './main.js';
import { createDemoRequestHandler } from './http.js';

const FIXED_NOW = 1_700_000_000_000;

interface Running {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<Running> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // 非 JSON：保留 raw
  }
  return { status: res.status, body: parsed, raw };
}

/** 把接线模块单独挂在一个**真** `node:http` 服务上（确定性时钟；不牵进整个宿主）。 */
async function serveWiring(runDir: string, withBudget: boolean): Promise<Running> {
  const wiring = createSessionAdaptersWiring({
    runDir,
    store: null,
    now: () => FIXED_NOW,
    ...(withBudget
      ? { budget: createProductBudget({ config: { task_calls: 1, model_calls: 1, tool_calls: 1, tokens: 10, cost_micros: 1, concurrency: 1, retries: 0, time: 1_000 }, runDir }) }
      : { budget: null, budgetUnwiredReason: '测试：未配置' }),
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void wiring.handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res });
  });
  return listen(server);
}

describe('N-5-4 · 时钟 / 日历适配器：真 HTTP 按名调用', () => {
  let dir: string;
  let running: Running;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fa-fix-tautology-cal-'));
    running = await serveWiring(dir, false);
  });
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('status 报出适配器身份与就绪汇总（`calClockToolAdapter` / `clockCalendarReadiness` 真的被调用）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/session-adapters/status');
    expect(r.status).toBe(200);
    const cal = r.body['cal_clock'] as Record<string, unknown>;
    expect(cal['tool']).toBe('cal-clock');
    expect(cal['templates']).toEqual(['template.clock', 'template.calendar']);
    expect(typeof cal['describe']).toBe('string');
    expect((cal['describe'] as string).length).toBeGreaterThan(0);
    expect(Object.keys(cal['verdict_counts'] as Record<string, number>).length).toBeGreaterThan(0);
    const research = r.body['research_citations'] as Record<string, unknown>;
    expect(research['kind']).toBe('research_citations');
    // 本机无真实联网端口 ⇒ 如实未就绪（不是"查过了但没结果"）。
    expect((research['readiness'] as Record<string, unknown>)['ready']).toBe(false);
    expect((research['readiness'] as Record<string, unknown>)['fromModelKnowledge']).toBe(false);
  });

  it('alarm.propose → alarm.commit → alarm.list 走通（自管提醒真的建出来了）', async () => {
    const proposed = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {
      op: {
        op: 'alarm.propose',
        label: '开始写周报',
        zoneId: 'Asia/Shanghai',
        repeat: { kind: 'once' },
        atMs: FIXED_NOW + 3_600_000,
      },
    });
    expect(proposed.status).toBe(200);
    expect(proposed.body['ok']).toBe(true);
    // 提案**不落地**（changed=false），且带可核对的绝对时刻。
    expect(proposed.body['changed']).toBe(false);
    const proposalOutcome = proposed.body['outcome'] as Record<string, unknown>;
    expect(proposalOutcome['kind']).toBe('alarm_proposal');
    const proposal = proposalOutcome['proposal'] as Record<string, unknown>;
    expect(proposal['kind']).toBe('ready');
    expect(proposal['absoluteMs']).toBe(FIXED_NOW + 3_600_000);

    const committed = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {
      op: { op: 'alarm.commit', proposal, idempotencyKey: 'k-1' },
    });
    expect(committed.status).toBe(200);
    expect(committed.body['changed']).toBe(true);
    expect((committed.body['outcome'] as Record<string, unknown>)['kind']).toBe('alarm_created');

    const listed = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {
      op: { op: 'alarm.list' },
    });
    const listing = (listed.body['outcome'] as Record<string, unknown>)['query'] as Record<string, unknown>;
    expect(listing['total']).toBe(1);
  });

  it('反向对照：未知 op ⇒ 结构化 `unsupported_op`（不是 200 也不是 500）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {
      op: { op: '这不是一个操作' },
    });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(false);
    expect(r.body['kind']).toBe('unsupported_op');
  });

  it('反向对照：缺 op ⇒ 400 `missing_op`（不静默当空操作）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {});
    expect(r.status).toBe(400);
    expect(r.body['code']).toBe('missing_op');
  });

  it('产品基线：系统时钟 / 日历段如实未就绪（没有真机端口就不假装）', async () => {
    const system = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {
      op: { op: 'system.alarm_list' },
    });
    const systemOutcome = system.body['outcome'] as Record<string, unknown>;
    expect(systemOutcome['kind']).toBe('system_alarm_listing');
    expect(systemOutcome['conclusive']).toBe(false);

    const calendar = await request(running.baseUrl, 'POST', '/api/session-adapters/cal-clock', {
      op: { op: 'calendar.directory' },
    });
    const dirView = (calendar.body['outcome'] as Record<string, unknown>)['view'] as Record<string, unknown>;
    expect(dirView['readGranted']).toBe(false);
  });
});

describe('N-5-4 · 检索呈现适配器：真 HTTP 按名调用 `researchCitationPresenter`', () => {
  let dir: string;
  let running: Running;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fa-fix-tautology-res-'));
    running = await serveWiring(dir, false);
  });
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const SOURCE = {
    sourceId: 'src-a',
    title: '成本核算表',
    url: 'https://example.com/a',
    retrievedAt: '2026-10-01T09:00:00+08:00',
  };

  it('带引用的事实句 ⇒ 正文内联可读出处、导出成功', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/research-citations', {
      query: '甲方案成本是多少',
      sources: [SOURCE],
      claims: [
        {
          kind: 'fact',
          text: '甲方案的成本为 100 元',
          citations: [{ sourceId: 'src-a', quote: '甲方案的成本为 100 元' }],
        },
        { kind: 'unknown', text: '海外税率未在资料中出现' },
      ],
      classification: { reachable: true, hits: 1 },
    });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(r.body['kind']).toBe('research_citations');
    expect(r.body['text']).toContain('甲方案的成本为 100 元（出处：');
    expect(r.body['text']).toContain('《成本核算表》');
    // 内部字段名**不得**出现在用户可见正文里。
    expect(r.body['text']).not.toContain('chunkId');
    expect(r.body['text']).not.toContain('locator');
    expect(r.body['citation_count']).toBe(1);
    expect((r.body['export'] as Record<string, unknown>)['ok']).toBe(true);
    expect(r.body['used_model_knowledge']).toBe(false);
    // `auditRendering` 真的被调用过：对同一份渲染文本报"未检出机械删除"。
    expect(r.body['audit_rendering']).toEqual([]);
  });

  it('反向对照：**无引用的"事实"句**被拒（有来源 ≠ 来源支持结论），导出随之失败', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/research-citations', {
      query: '无依据的事实',
      sources: [SOURCE],
      claims: [{ kind: 'fact', text: '凭空断言的一事实' }],
      classification: { reachable: true, hits: 1 },
    });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(false);
    // 被拒的陈述**不出现**在正文里。
    expect(r.body['text']).not.toContain('凭空断言的一事实');
    const exported = r.body['export'] as Record<string, unknown>;
    expect(exported['ok']).toBe(false);
    expect(exported['kind']).toBe('render_integrity_failed');
  });

  it('反向对照：引用**未登记**的来源 ⇒ 判失败（不得冒充可回读出处）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/research-citations', {
      query: '引用未登记来源',
      sources: [SOURCE],
      claims: [
        { kind: 'fact', text: '来自别处的一句话', citations: [{ sourceId: 'src-不存在', quote: '原文' }] },
      ],
      classification: { reachable: true, hits: 1 },
    });
    expect(r.body['ok']).toBe(false);
    expect((r.body['failures'] as readonly string[]).length).toBeGreaterThan(0);
  });

  it('用户要求引用 ⇒ 附引用栏目；`edit` 走封闭枚举的呈现编辑', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/research-citations', {
      query: '甲方案成本是多少',
      sources: [SOURCE],
      claims: [
        { kind: 'fact', text: '甲方案的成本为 100 元', citations: [{ sourceId: 'src-a', quote: '甲方案的成本为 100 元' }] },
      ],
      classification: { reachable: true, hits: 1 },
      edit: { op: 'set_citation_preference', userWantsCitations: true },
    });
    expect(r.body['ok']).toBe(true);
    expect(r.body['text']).toContain('引用：');
  });

  it('反向对照：非法 edit ⇒ 结构化被拒（不是静默忽略）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/session-adapters/research-citations', {
      query: 'q',
      edit: { op: '不存在的编辑' },
    });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(false);
    expect(r.body['kind']).toBe('unsupported_op');
  });
});

describe('N-5-5 · 预算闸门：`ProductBudgetWiring.admit()` 是产品侧真实调用点', () => {
  let dir: string;
  let gated: Running;
  let ungated: Running;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fa-fix-tautology-bud-'));
    gated = await serveWiring(dir, true);
    ungated = await serveWiring(dir, false);
  });
  afterAll(async () => {
    await gated.close();
    await ungated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('首次调用在额度内 ⇒ 放行，并回出脱敏追踪与台账摘要', async () => {
    const r = await request(gated.baseUrl, 'POST', '/api/session-adapters/tool-call', {
      charges: { task_calls: 1 },
      key: 'turn-1',
    });
    expect(r.status).toBe(200);
    expect(r.body['admitted']).toBe(true);
    const outcome = r.body['outcome'] as Record<string, unknown>;
    expect(outcome['allowed']).toBe(true);
    expect((outcome['charged'] as Record<string, number>)['task_calls']).toBe(1);
    expect(typeof r.body['describe']).toBe('string');
    expect(Array.isArray(r.body['trace'])).toBe(true);
  });

  it('反向对照：额度用尽 ⇒ `429 budget_exhausted`（超限整笔拒，工作不开始）', async () => {
    const r = await request(gated.baseUrl, 'POST', '/api/session-adapters/tool-call', {
      charges: { task_calls: 1 },
      key: 'turn-2',
    });
    expect(r.status).toBe(429);
    expect(r.body['code']).toBe('budget_exhausted');
    expect((r.body['outcome'] as Record<string, unknown>)['allowed']).toBe(false);
  });

  it('反向对照：预算未装配 ⇒ `503 budget_not_configured`（**不是**"不设限"）', async () => {
    const r = await request(ungated.baseUrl, 'POST', '/api/session-adapters/tool-call', {
      charges: { task_calls: 1 },
    });
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('budget_not_configured');
    expect((r.body['unlock'] as readonly string[]).length).toBeGreaterThan(0);
  });

  it('放行的同时可以派发一次时钟操作（工具调用路径 = 闸门 + 派发）', async () => {
    const r = await request(gated.baseUrl, 'POST', '/api/session-adapters/tool-call', {
      charges: { tool_calls: 1 },
      key: 'turn-3',
      op: { op: 'world_clock', zoneIds: ['Asia/Shanghai', 'UTC'] },
    });
    // task_calls 那维已用尽，但本笔只扣 tool_calls ⇒ 仍放行（维度互不牵连）。
    expect(r.status).toBe(200);
    const op = r.body['op'] as Record<string, unknown>;
    expect(op['ok']).toBe(true);
    expect((op['outcome'] as Record<string, unknown>)['kind']).toBe('world_clock');
  });
});

describe('N-5-6 · 检查点：构造 / 落盘 / 读回 / 恢复计划（`src/scheduler/checkpoint.ts` 归约）', () => {
  let dir: string;
  let demo: DemoServer;
  let running: Running;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fa-fix-tautology-ckpt-'));
    demo = await createDemoServer({ POTBOT_RUN_DIR: dir });
    running = await listen(demo.server);
  }, 60_000);
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('产品路径（`createDemoServer`）确实注入了内核 store', () => {
    expect(demo.sessionAdapters).toBeDefined();
    expect(typeof demo.sessionAdapters.handle).toBe('function');
  });

  it('反向对照：没有检查点时 `GET` 报 `absent`、`restore` 报 409（**不是**假装恢复）', async () => {
    const before = await request(running.baseUrl, 'GET', '/api/session-adapters/checkpoint');
    expect(before.status).toBe(200);
    expect(before.body['status']).toBe('absent');
    expect(before.body['plan']).toBeNull();

    const restore = await request(running.baseUrl, 'POST', '/api/session-adapters/checkpoint/restore');
    expect(restore.status).toBe(409);
    expect(restore.body['code']).toBe('checkpoint_not_usable');
  });

  it('POST 构造并落盘 ⇒ `GET` 读回同一 id 且带恢复计划（归约真的跑过）', async () => {
    const taken = await request(running.baseUrl, 'POST', '/api/session-adapters/checkpoint', {});
    expect(taken.status).toBe(200);
    expect(taken.body['committed']).toBe(true);
    expect(taken.body['blind_replay_allowed']).toBe(false);
    const id = taken.body['checkpoint_id'] as string;
    expect(id.startsWith('ckpt-')).toBe(true);

    const loaded = await request(running.baseUrl, 'GET', '/api/session-adapters/checkpoint');
    expect(loaded.body['status']).toBe('ok');
    expect(loaded.body['checkpoint_id']).toBe(id);
    const plan = loaded.body['plan'] as Record<string, unknown>;
    expect(Array.isArray(plan['replayed'])).toBe(true);
    expect(Array.isArray(plan['withheld'])).toBe(true);
    expect(plan['blind_replay_allowed']).toBe(false);
  });

  it('重启恢复路径的只读视图：`describeCheckpointRecovery` 不写任何东西（再读仍同一 id）', async () => {
    const before = describeCheckpointRecovery(demo.host.store);
    expect(before.status).toBe('ok');
    expect(before.plan).not.toBeNull();
    const after = await request(running.baseUrl, 'GET', '/api/session-adapters/checkpoint');
    expect(after.body['checkpoint_id']).toBe(before.checkpoint_id);
  });

  it('反向对照：内核 store 缺席时检查点段结构化 503（不新建第二份账本）', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'fa-fix-tautology-nostore-'));
    const bare = await serveWiring(dir2, false);
    try {
      const r = await request(bare.baseUrl, 'GET', '/api/session-adapters/checkpoint');
      expect(r.status).toBe(503);
      expect(r.body['code']).toBe('kernel_store_unwired');
    } finally {
      await bare.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('降级替身：`http.ts` 未注入会话适配器接线时，前缀仍作答（不是 404）', () => {
  let dir: string;
  let running: Running;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fa-fix-tautology-fb-'));
    const handler = createDemoRequestHandler({
      host: { health: () => ({ ready: true }) } as never,
      webDir: dir,
    });
    running = await listen(createServer(handler));
  });
  afterAll(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('`GET /api/session-adapters/status` 200；检查点段 503；对照 `/api/不存在` 仍是 404', async () => {
    const status = await request(running.baseUrl, 'GET', '/api/session-adapters/status');
    expect(status.status).toBe(200);
    expect((status.body['checkpoint'] as Record<string, unknown>)['wired']).toBe(false);

    const checkpoint = await request(running.baseUrl, 'GET', '/api/session-adapters/checkpoint');
    expect(checkpoint.status).toBe(503);

    const missing = await request(running.baseUrl, 'GET', '/api/definitely-not-a-route');
    expect(missing.status).toBe(404);
  });
});
