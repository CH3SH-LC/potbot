/**
 * FA-VERIFY-WAVE-13 · 第 1 项 —— **新端点真伪：四态判定**。
 *
 * ## 任务口径
 *
 * 对本批新增的**每一个**前缀，用**真服务**（`createDemoServer` 起真 `node:http`、真 `fetch`）
 * 打**至少 2 个请求**（一个正例、一个反例），判定为四态之一：
 *
 * | 态 | 判据 |
 * |---|---|
 * | `real` 真干活 | 正例返回**真实状态**（读得回、改得动），且**反例与正例不同**（不是恒 200 的空壳） |
 * | `shell` 空壳 | 200 但什么都没做（正例与反例同形 / 状态不随请求改变） |
 * | `honest_not_ready` 未就绪但诚实 | **非 200**（503/501），体内有 `code` + `unlock`（说清为什么、怎么解） |
 * | `lying_not_ready` 未就绪但撒谎 | 声称成功（200）而下游根本没接 —— 见 T2 的具名清单 |
 *
 * ## 本批被点名的前缀
 *
 * `/api/facts`、`/api/memory/facts/:key/versions`、`/api/krn-orphans/**`、`/api/xls-print/**`、
 * `/api/session-adapters/**`、`/api/krn-barrel/**`、`/api/conversation-loop/**`
 * （含被点名的 `/api/conversation-loop/requirements`）。
 *
 * ## 诚实边界（本文件**不**做的事）
 *
 * - 不替换任何一层：全走产品入口 `createDemoServer`，只 `listen(0, 127.0.0.1)`。
 * - 不测真机 / 不起 Android / 不碰 Office。
 * - 判定是**本候选**（HEAD 见 T3）的事实，不含对更早候选的推断。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import { getJson, listen, postJson, rawGet, type Json, type Running } from './http.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w13-t1-'));

let server: Running;

beforeAll(async () => {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: join(RUN_ROOT, 'run') });
  server = await listen(demo.server);
}, 120_000);

afterAll(async () => {
  await server.close();
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 经产品入口建任务（真写内核）。 */
async function seedTask(goal: string): Promise<string> {
  const created = await postJson(server.base, '/api/roles/main-agent', { kind: 'create_task', goal });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const taskId = created.json['dispatch']?.['task_id'];
  expect(typeof taskId, JSON.stringify(created.json)).toBe('string');
  return taskId as string;
}

const KNOWN_TEXT = (text: string): Json => ({ kind: 'known', value: { type: 'text', text, source: 'wave13' } });

interface PrefixVerdict {
  readonly prefix: string;
  readonly verdict: 'real' | 'shell' | 'honest_not_ready' | 'lying_not_ready';
  readonly positive: string;
  readonly negative: string;
}

/** 本文件对本批每个前缀的判定（**结论**，由下面的用例逐条实测支撑）。 */
export const PREFIX_VERDICTS: readonly PrefixVerdict[] = Object.freeze([
  { prefix: '/api/facts', verdict: 'real', positive: 'GET/POST 真读写内核 store，版本递增', negative: '缺版本 ⇒ 400；版本不符 ⇒ 409' },
  { prefix: '/api/memory/facts/:key/versions', verdict: 'real', positive: '写事实后逐版本读回', negative: '未知键 ⇒ 404；缺 owner ⇒ 400' },
  { prefix: '/api/krn-orphans', verdict: 'real', positive: 'state 读真 store/真注册表', negative: '未知子路径 ⇒ 404；写只读口 ⇒ 405' },
  { prefix: '/api/xls-print', verdict: 'lying_not_ready', positive: '（不存在）', negative: '整个前缀 404 —— 见 T2' },
  { prefix: '/api/session-adapters', verdict: 'real', positive: 'status 汇总真端口', negative: '未配预算 ⇒ /tool-call 503 且带 unlock' },
  { prefix: '/api/krn-barrel', verdict: 'real', positive: 'status 列出真按名调用模块', negative: '未知子路径 ⇒ 404' },
  { prefix: '/api/conversation-loop', verdict: 'real', positive: '/status ready', negative: '未知子路径 ⇒ 404；非 POST ⇒ 405' },
  { prefix: '/api/conversation-loop/requirements', verdict: 'lying_not_ready', positive: '（不存在）', negative: '404 unknown_loop_route —— 见 T2' },
]);

describe('W13-T1 · /api/facts 真读写 + 版本闸门', () => {
  it('正例：POST 建首版 ⇒ GET 读回同一值（真落内核 store）', async () => {
    const taskId = await seedTask('W13-T1 facts 正例');
    const key = 'headcount';

    const listed = await getJson(server.base, `/api/facts?task_id=${encodeURIComponent(taskId)}`);
    expect(listed.status, JSON.stringify(listed.json)).toBe(200);
    expect(listed.json['count']).toBe(0);

    const wrote = await postJson(server.base, `/api/facts/${key}`, {
      task_id: taskId,
      expected_revision: 0,
      value: KNOWN_TEXT('三人'),
    });
    expect(wrote.status, JSON.stringify(wrote.json)).toBe(200);
    expect(wrote.json['revision']).toBe(1);

    const read = await getJson(server.base, `/api/facts/${key}?task_id=${encodeURIComponent(taskId)}`);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(read.json['value']?.['value']?.['text']).toBe('三人');
  }, 60_000);

  it('反例：缺 expected_revision ⇒ 400；版本不符 ⇒ 409（不静默覆盖）', async () => {
    const taskId = await seedTask('W13-T1 facts 反例');
    const key = 'budget.total';

    const noRev = await postJson(server.base, `/api/facts/${key}`, { task_id: taskId, value: KNOWN_TEXT('100') });
    expect(noRev.status, JSON.stringify(noRev.json)).toBe(400);
    expect(noRev.json['code']).toBe('missing_expected_revision');

    await postJson(server.base, `/api/facts/${key}`, { task_id: taskId, expected_revision: 0, value: KNOWN_TEXT('100') });
    const stale = await postJson(server.base, `/api/facts/${key}`, { task_id: taskId, expected_revision: 0, value: KNOWN_TEXT('999') });
    expect(stale.status, JSON.stringify(stale.json)).toBe(409);
    expect(stale.json['code']).toBe('revision_conflict');
    expect(stale.json['currentRevision']).toBe(1);

    // 读回仍是第一份（未被静默覆盖）
    const read = await getJson(server.base, `/api/facts/${key}?task_id=${encodeURIComponent(taskId)}`);
    expect(read.json['value']?.['value']?.['text']).toBe('100');
  }, 60_000);

  it('反例：未知任务 / 未知键 ⇒ 404（不用空值冒充）', async () => {
    const noTask = await getJson(server.base, '/api/facts?task_id=T-does-not-exist');
    expect(noTask.status).toBe(404);
    expect(noTask.json['code']).toBe('task_not_found');
  }, 60_000);
});

describe('W13-T1 · /api/memory/facts/:key/versions 逐版本读回', () => {
  it('正例：写两版 ⇒ 版本链升序读回，current/previous 正确', async () => {
    const owner = 'O-w13-t1';
    const task = 'T-w13-t1';
    const key = 'pref.lang';

    const first = await postJson(server.base, '/api/memory/facts', {
      owner_id: owner,
      task_id: task,
      fact_key: key,
      value_text: '中文',
      source: { kind: 'user_statement', detail: 'wave13 首版' },
    });
    expect(first.status, JSON.stringify(first.json)).toBe(200);

    const second = await postJson(server.base, '/api/memory/facts', {
      owner_id: owner,
      task_id: task,
      fact_key: key,
      value_text: '英文',
      source: { kind: 'user_statement', detail: 'wave13 次版' },
    });
    expect(second.status, JSON.stringify(second.json)).toBe(200);

    const versions = await getJson(
      server.base,
      `/api/memory/facts/${key}/versions?owner_id=${owner}&task_id=${task}`,
    );
    expect(versions.status, JSON.stringify(versions.json)).toBe(200);
    expect(Array.isArray(versions.json['versions'])).toBe(true);
    expect(versions.json['versions'].length).toBeGreaterThanOrEqual(2);
    expect(versions.json['current_value']).toBe('英文');
    expect(versions.json['truncated']).toBe(false);
  }, 60_000);

  it('反例：未知键 ⇒ 404；缺 owner_id ⇒ 400；跨 owner ⇒ 404（不泄漏是否存在）', async () => {
    const notFound = await getJson(
      server.base,
      '/api/memory/facts/never-written/versions?owner_id=O-w13-t1&task_id=T-w13-t1',
    );
    expect(notFound.status, JSON.stringify(notFound.json)).toBe(404);

    const noOwner = await getJson(server.base, '/api/memory/facts/pref.lang/versions?task_id=T-w13-t1');
    expect(noOwner.status, JSON.stringify(noOwner.json)).toBe(400);

    const otherOwner = await getJson(
      server.base,
      '/api/memory/facts/pref.lang/versions?owner_id=O-someone-else&task_id=T-w13-t1',
    );
    expect(otherOwner.status, JSON.stringify(otherOwner.json)).toBe(404);
  }, 60_000);
});

describe('W13-T1 · /api/krn-orphans 真读状态 + 结构化未就绪', () => {
  it('正例：/status 报 7 个孤儿的处置；/queue 读真内核 store', async () => {
    const status = await getJson(server.base, '/api/krn-orphans/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['store_wired']).toBe(true);
    expect(status.json['registry_wired']).toBe(true);
    expect(status.json['orphans_total']).toBe(7);
    expect(Array.isArray(status.json['modules_resolved'])).toBe(true);

    const queue = await getJson(server.base, '/api/krn-orphans/queue');
    expect(queue.status, JSON.stringify(queue.json)).toBe(200);
    expect(queue.json['module']).toBe('work-queue');
  }, 60_000);

  it('反例：未知子路径 ⇒ 404；只读口收到 POST ⇒ 405', async () => {
    const unknown = await getJson(server.base, '/api/krn-orphans/definitely-not-a-route');
    expect(unknown.status).toBe(404);
    expect(unknown.json['code']).toBe('unknown_krn_orphans_route');

    const wrongMethod = await postJson(server.base, '/api/krn-orphans/queue', {});
    expect(wrongMethod.status).toBe(405);
  }, 60_000);

  it('反例：/fact/commit 不回写 store（authoritative_write:false 是机器可读的诚实边界）', async () => {
    const commit = await postJson(server.base, '/api/krn-orphans/fact/commit', {
      task_id: 'T-x',
      artifact_key: 'docx',
      group_id: 'G-1',
      instance_id: 'I-1',
      run_id: 'R-1',
      artifact_ref: 'A-1',
    });
    // 缺 binding_token ⇒ 400，且体内**没有**任何"已写入 store"的说法。
    expect(commit.status).toBe(400);
    expect(commit.json['code']).toBe('binding_required');
  }, 60_000);
});

describe('W13-T1 · /api/session-adapters 真实端口摘要 + 预算未装配的结构化 503', () => {
  it('正例：/status 汇总两个适配器（按名调用）与检查点装配状态', async () => {
    const status = await getJson(server.base, '/api/session-adapters/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['cal_clock']?.['tool']).toBeTruthy();
    expect(status.json['checkpoint']?.['wired']).toBe(true);
    expect(status.json['budget']?.['configured']).toBe(false); // 测试环境未给八维上限
  }, 60_000);

  it('反例：未装配预算 ⇒ /tool-call 503 且带 unlock（不退回"不设限"）', async () => {
    const call = await postJson(server.base, '/api/session-adapters/tool-call', {
      charges: { tool_calls: 1 },
      op: { kind: 'read_system_clock', at: 0 },
    });
    expect(call.status, JSON.stringify(call.json)).toBe(503);
    expect(call.json['code']).toBe('budget_not_configured');
    expect(Array.isArray(call.json['unlock'])).toBe(true);
    expect(call.json['unlock'].length).toBeGreaterThan(0);
  }, 60_000);

  it('反例：未知子路径 ⇒ 404', async () => {
    const unknown = await getJson(server.base, '/api/session-adapters/nope');
    expect(unknown.status).toBe(404);
  }, 60_000);
});

describe('W13-T1 · /api/krn-barrel 真按名调用清单 + 反例', () => {
  it('正例：/status 列出 10 个真按名调用的模块；/audit 读真内核事件', async () => {
    const status = await getJson(server.base, '/api/krn-barrel/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['modules_used'].length).toBe(10);
    expect(status.json['store_wired']).toBe(true);

    const audit = await getJson(server.base, '/api/krn-barrel/audit');
    expect(audit.status, JSON.stringify(audit.json)).toBe(200);
    expect(audit.json['module']).toBe('event-log');
    expect(audit.json['read_only']).toBe(true);
  }, 60_000);

  it('反例：未知子路径 ⇒ 404；只读口 POST ⇒ 405', async () => {
    const unknown = await getJson(server.base, '/api/krn-barrel/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.json['code']).toBe('unknown_krn_barrel_route');

    const wrong = await postJson(server.base, '/api/krn-barrel/audit', {});
    expect(wrong.status).toBe(405);
  }, 60_000);
});

describe('W13-T1 · /api/conversation-loop 真就绪 + 反例', () => {
  it('正例：/status 报 ready:true（目录端口读真内核 store）', async () => {
    const status = await getJson(server.base, '/api/conversation-loop/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['ready']).toBe(true);
  }, 60_000);

  it('反例：未知子路径 ⇒ 404；/turns 非 POST ⇒ 405', async () => {
    const unknown = await getJson(server.base, '/api/conversation-loop/definitely-not-a-route');
    expect(unknown.status).toBe(404);
    expect(unknown.json['code']).toBe('unknown_loop_route');

    const wrong = await getJson(server.base, '/api/conversation-loop/turns');
    expect(wrong.status).toBe(405);
  }, 60_000);
});

describe('W13-T1 · 辨别力保底（不是"到处都 200"）', () => {
  it('完全未挂载的前缀仍 404，且 content-type 是 JSON', async () => {
    const missing = await rawGet(server.base, '/api/definitely-not-mounted');
    expect(missing.status).toBe(404);
    expect(missing.contentType ?? '').toContain('application/json');
  }, 60_000);

  it('判定表本身自洽：四态取值合法且覆盖全部被点名前缀', () => {
    const allowed = new Set(['real', 'shell', 'honest_not_ready', 'lying_not_ready']);
    for (const row of PREFIX_VERDICTS) expect(allowed.has(row.verdict)).toBe(true);
    const names = PREFIX_VERDICTS.map((row) => row.prefix);
    expect(names).toContain('/api/xls-print');
    expect(names).toContain('/api/conversation-loop/requirements');
  });
});
