/**
 * FA-VERIFY-WAVE-12 · 第 6 项 —— 本批新增产品面：**真干活 vs 空壳**独立判定。
 *
 * 对象：`/api/facts`、`/api/session-adapters`、`/api/krn-barrel`、`/api/documents` 子树，
 * 以及被点名的 `/api/xls-print`（若已合）。
 *
 * ## 判据（**真服务**打真请求，不看源码注释）
 *
 * | 面 | 真干活的样子 | 空壳/未就绪的样子 |
 * |---|---|---|
 * | `/api/facts` | 缺 `task_id` ⇒ 400；未知任务 ⇒ 404；能读能写、写后能读回、版本冲突 ⇒ 409 | 404 not_found（路由没挂）或恒 200 空体 |
 * | `/api/session-adapters` | `/status` 报真实就绪；`/cal-clock` 真算；`/tool-call` 未配预算 ⇒ 503 | 404 / 恒 200 |
 * | `/api/krn-barrel` | `/audit` `/continuity` 从**同一份内核 store** 反推；未注入 store ⇒ 结构化 503 | 404 / 恒 200 |
 * | `/api/documents` | `/status` 报 ready；未知 id 的 `summary` ⇒ 结构化 4xx | 404 not_found |
 * | `/api/xls-print` | —— | **无此路由** ⇒ 404 not_found（XLS-16 打印能力以 `src/spreadsheets/print-layout.ts` + `src/session/adapters/xlsx-print.ts` 模块层合入，未暴露为该 HTTP 面） |
 *
 * **空壳的反向对照**：另起一个**未注入任何宿主**的 handler（`createDemoRequestHandler` 只给
 * `host`/`webDir`），`/api/krn-barrel/audit` 必须退成结构化 503（`store_unwired`）——
 * 证明上面那个 200 是**读了真 store** 得来的，不是写死的常量。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asLogicalTime, asRevision, asTaskId, createTaskRecord } from '../../../src/protocol/index.js';
import { createDemoRequestHandler } from '../../../apps/demo/server/http.js';

import { getJson, listen, postJson, startProduct, type Json, type Running } from './http.js';

let workDir = '';
let main: Running;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-wave12-surfaces-'));
  main = await startProduct(join(workDir, 'run'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

function seedTask(taskId: string, revision: number): void {
  main.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-VERIFY-WAVE-12 产品面夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
  });
}

function code(body: Json): unknown {
  return body['code'];
}

describe('T6 · /api/facts —— 读写真事实（不是空壳）', () => {
  const TASK = 'T-wave12-facts';

  beforeAll(() => {
    seedTask(TASK, 1);
  });

  it('缺 task_id ⇒ 400；未知任务 ⇒ 404；空任务列表 ⇒ 200 count 0', async () => {
    const missing = await getJson(main.baseUrl, '/api/facts');
    expect(missing.status).toBe(400);
    expect(code(missing.json)).toBe('missing_task_id');

    const unknown = await getJson(main.baseUrl, '/api/facts?task_id=T-does-not-exist');
    expect(unknown.status).toBe(404);
    expect(code(unknown.json)).toBe('task_not_found');

    const empty = await getJson(main.baseUrl, `/api/facts?task_id=${TASK}`);
    expect(empty.status, JSON.stringify(empty.json)).toBe(200);
    expect(empty.json['count']).toBe(0);
  });

  it('写入 → 读回 → 历史 → 版本冲突 409 → 无 version 拒绝 400', async () => {
    const noVersion = await postJson(main.baseUrl, '/api/facts/headcount', {
      task_id: TASK,
      value: { kind: 'unknown', reason: 'wave12 未取到值' },
    });
    expect(noVersion.status).toBe(400);
    expect(code(noVersion.json)).toBe('missing_expected_revision');

    const written = await postJson(main.baseUrl, '/api/facts/headcount', {
      task_id: TASK,
      expected_revision: 0,
      value: { kind: 'unknown', reason: 'wave12 未取到值' },
    });
    expect(written.status, JSON.stringify(written.json)).toBe(200);
    expect(written.json['revision']).toBe(1);

    const readback = await getJson(main.baseUrl, `/api/facts/headcount?task_id=${TASK}`);
    expect(readback.status, JSON.stringify(readback.json)).toBe(200);
    expect(readback.json['factKey']).toBe('headcount');
    expect(readback.json['current']).toBe(true);

    const listed = await getJson(main.baseUrl, `/api/facts?task_id=${TASK}`);
    expect(listed.status).toBe(200);
    expect(listed.json['count']).toBe(1);

    const history = await getJson(main.baseUrl, `/api/facts/headcount/history?task_id=${TASK}`);
    expect(history.status, JSON.stringify(history.json)).toBe(200);
    expect((history.json['versions'] as readonly Json[]).length).toBe(1);

    // 陈旧版本写入：不得静默覆盖。
    const stale = await postJson(main.baseUrl, '/api/facts/headcount', {
      task_id: TASK,
      expected_revision: 0,
      value: { kind: 'unknown', reason: '陈旧' },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json)).toBe('revision_conflict');
  }, 30_000);
});

describe('T6 · /api/session-adapters —— 真就绪报告 + 真算 + 未配预算的诚实未就绪', () => {
  it('/status 200 报真就绪（预算未配 ⇒ configured:false，不假装）', async () => {
    const status = await getJson(main.baseUrl, '/api/session-adapters/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['ready']).toBe(true);
    const budget = status.json['budget'] as Json;
    expect(budget['configured']).toBe(false);
    expect((status.json['checkpoint'] as Json)['wired']).toBe(true);
  });

  it('/cal-clock 真算（calendar.attendees 固定 invitationSent:false）', async () => {
    const response = await postJson(main.baseUrl, '/api/session-adapters/cal-clock', {
      op: { op: 'calendar.attendees', attendeeCount: 3 },
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.json['ok']).toBe(true);
  }, 30_000);

  it('/tool-call 未配预算 ⇒ 503 budget_not_configured（不退回"不设限"）', async () => {
    const response = await postJson(main.baseUrl, '/api/session-adapters/tool-call', {});
    expect(response.status).toBe(503);
    expect(code(response.json)).toBe('budget_not_configured');
  });
});

describe('T6 · /api/krn-barrel —— 读端点从同一份内核 store 反推', () => {
  it('/status 200 且 store_wired:true；/audit、/continuity 均 200', async () => {
    const status = await getJson(main.baseUrl, '/api/krn-barrel/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['store_wired']).toBe(true);

    const audit = await getJson(main.baseUrl, '/api/krn-barrel/audit');
    expect(audit.status, JSON.stringify(audit.json)).toBe(200);
    expect(audit.json['module']).toBe('event-log');
    expect(audit.json['read_only']).toBe(true);

    const continuity = await getJson(main.baseUrl, '/api/krn-barrel/continuity');
    expect(continuity.status, JSON.stringify(continuity.json)).toBe(200);
    expect(continuity.json['module']).toBe('id-clock-continuity');
  });
});

describe('T6 · /api/documents 子树', () => {
  it('/status 200 报 ready:true；未知文档 id 的 summary ⇒ 结构化 4xx（真查了 store）', async () => {
    const status = await getJson(main.baseUrl, '/api/documents/status');
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['ready']).toBe(true);

    const summary = await getJson(main.baseUrl, '/api/documents/__no_such_doc__/summary');
    expect(summary.status, `未知文档应结构化报错而不是 404 not_found：${JSON.stringify(summary.json)}`).toBeGreaterThanOrEqual(400);
    expect(summary.status).toBeLessThan(500);
    // 它是"查过产物端口后如实说没有"，不是"路由没挂"。
    expect(code(summary.json)).not.toBe('not_found');
  });
});

describe('T6 · /api/xls-print 与 /api/xls-facts', () => {
  it('无 `/api/xls-print` 这一路由 ⇒ 404 not_found（打印能力以模块层合入，未暴露为该 HTTP 面）', async () => {
    const response = await getJson(main.baseUrl, '/api/xls-print/status');
    expect(response.status).toBe(404);
    expect(code(response.json)).toBe('not_found');
  });

  it('对照：/api/xls-facts（已合入）不是 404', async () => {
    const response = await getJson(main.baseUrl, '/api/xls-facts');
    expect(response.status).not.toBe(404);
  });
});

describe('T6 · 空壳反向对照：未注入 store 的 handler', () => {
  it('/api/krn-barrel/audit 在无 store 时退成 503 store_unwired（证明 200 是读了真 store）', async () => {
    const handler = createDemoRequestHandler({
      host: { health: () => ({ ready: true }), logicalNow: () => asLogicalTime(0) },
      webDir: workDir,
    } as never);
    const bare = await listen(createServer(handler as never));
    try {
      const response = await getJson(bare.baseUrl, '/api/krn-barrel/audit');
      expect(response.status, JSON.stringify(response.json)).toBe(503);
      expect(code(response.json)).toBe('store_unwired');
    } finally {
      await bare.close();
    }
  });
});
