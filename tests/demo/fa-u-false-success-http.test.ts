/**
 * FA-U 第二件 —— **R264 第 3 条**的 HTTP 级复现（外部监督 S-1026-01 的善后）。
 *
 * ## 复现的是什么
 *
 * 监督给出的最小复现：新建 XLSX 会话 → `set_cell Sheet1!A1` 成功 → 用返回的 revision/digest
 * 与**新幂等键**提交 `set_cell MissingSheet!A1`（被拒）→ 查完成视图。
 *
 * 修复前：交付链不登记任何工作项 / 轮次 / 动作，而判据①是**集合的 `every()`**——
 * 空数组恒真 ⇒「空工作集 + 任一历史产物」推出 `completed_and_successful`，
 * **哪怕最新一步已被拒**。
 *
 * 修复后：每次交付尝试都落一条真实工作项（成功 → `completed`，被拒 → `failed`），
 * 于是被拒的那一步**参与**判据，完成视图报"已完成但有未成之事"。
 *
 * ## 怎么跑
 *
 * 与 `fa-u-deliverables-e2e.test.ts` 同一套：`startDemoServer()` **进程内**起真宿主，
 * 运行目录是 `mkdtemp` 的隔离目录（不碰仓库 `.runtime/`、不接模型、不连真机）。
 * 请求形状由**页面自己的模块**产出（`deliverable-ops.js`），不是这里手抄的一份。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDemoServer } from '../../apps/demo/server/main.js';
import { loadWebGlobal } from './word-ui/harness.js';

interface DeliverablesModule {
  planOpen(input: Record<string, unknown>): { method: string; path: string; body?: unknown };
  planEdit(input: Record<string, unknown>): { method: string; path: string; body?: unknown };
  planCompletion(input: Record<string, unknown>): { method: string; path: string };
  safeId(prefix: string, nowMs: number, salt?: string): string;
}

let Lib: DeliverablesModule;
let baseUrl = '';
let runDir = '';
let closeServer: () => Promise<void> = () => Promise.resolve();

afterAll(async () => {
  await closeServer();
  if (runDir.length > 0) rmSync(runDir, { recursive: true, force: true });
}, 60_000);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function call(plan: {
  method: string;
  path: string;
  body?: unknown;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method: plan.method,
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json' },
  };
  if (plan.body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), 'content-type': 'application/json' };
    init.body = JSON.stringify(plan.body);
  }
  const response = await fetch(`${baseUrl}${plan.path}`, init);
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

beforeAll(async () => {
  Lib = loadWebGlobal<DeliverablesModule>('deliverable-ops.js', 'PotbotDeliverables');
  runDir = mkdtempSync(join(tmpdir(), 'potbot-fa-u-r264-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(port),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
  };
  delete env['ANTHROPIC_BASE_URL'];
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  const created = await startDemoServer(env);
  baseUrl = `http://127.0.0.1:${String(created.port)}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      created.server.close(() => resolve());
    });
}, 120_000);

describe('S-1026-01 的 HTTP 级复现（R264 第 3 条）', () => {
  it('成功一步 → 被拒一步 ⇒ `/completion` **不得**报"已完成且成功"', async () => {
    const sessionId = Lib.safeId('r264-repro', 1, 'a');

    // ① 新建（空白 XLSX，只有 Sheet1）。
    const opened = await call(
      Lib.planOpen({
        sessionId,
        deliverableId: Lib.safeId('r264-del', 1, 'a'),
        filename: '复现.xlsx',
        format: 'xlsx',
        title: '复现',
      }),
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    let revision = opened.body['editRevision'] as number;
    let digest = opened.body['contentDigest'] as string;
    console.log('R264-OPEN', JSON.stringify(opened.body));

    // ② 第一步：写进真实存在的 Sheet1 —— 成功。
    const step1 = await call(
      Lib.planEdit({
        sessionId,
        idempotencyKey: 'r264-step-1',
        baseRevision: revision,
        baseDigest: digest,
        edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '季度' } },
      }),
    );
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);
    revision = step1.body['editRevision'] as number;
    digest = String((step1.body['version'] as Record<string, unknown>)['contentDigest']);
    console.log('R264-STEP1', JSON.stringify({ status: step1.status, editRevision: revision }));

    // ③ 第二步：写进**不存在**的表，用返回的 revision/digest 与**新幂等键** —— 被拒。
    const step2 = await call(
      Lib.planEdit({
        sessionId,
        idempotencyKey: 'r264-step-2',
        baseRevision: revision,
        baseDigest: digest,
        edit: { op: 'set_cell', sheet: 'MissingSheet', address: 'A1', value: { kind: 'text', value: 'x' } },
      }),
    );
    expect(step2.status, '不存在的表必须被拒').toBeGreaterThanOrEqual(400);
    console.log('R264-STEP2', JSON.stringify({ status: step2.status, body: step2.body }));

    // ④ 完成视图：被拒的那一步必须**参与**结论。
    const completion = await call(Lib.planCompletion({ sessionId }));
    expect(completion.status, JSON.stringify(completion.body)).toBe(200);
    console.log('R264-COMPLETION', JSON.stringify(completion.body));

    expect(completion.body['completed']).toBe(true);
    expect(
      completion.body['label'],
      '被拒之后不得报"已完成且成功"（这正是 S-1026-01 的假成功）',
    ).not.toBe('completed_and_successful');
    expect(completion.body['label']).toBe('completed_with_unfinished_business');

    const flags = completion.body['flags'] as Record<string, boolean>;
    expect(flags['anyWorkItemFailed']).toBe(true);
    const counts = completion.body['counts'] as Record<string, number>;
    expect(counts['workItems'], '两次交付尝试 ⇒ 两条工作记录').toBe(2);
  }, 120_000);

  it('对照：全部成功 ⇒ 仍然报"已完成且成功"（修复不是把成功也一起堵死）', async () => {
    const sessionId = Lib.safeId('r264-happy', 2, 'b');
    const opened = await call(
      Lib.planOpen({
        sessionId,
        deliverableId: Lib.safeId('r264-del', 2, 'b'),
        filename: '正常.xlsx',
        format: 'xlsx',
        title: '正常',
      }),
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const revision = opened.body['editRevision'] as number;
    const digest = opened.body['contentDigest'] as string;

    const step1 = await call(
      Lib.planEdit({
        sessionId,
        idempotencyKey: 'r264-ok-1',
        baseRevision: revision,
        baseDigest: digest,
        edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: 'ok' } },
      }),
    );
    expect(step1.status, JSON.stringify(step1.body)).toBe(200);

    const completion = await call(Lib.planCompletion({ sessionId }));
    console.log('R264-HAPPY-COMPLETION', JSON.stringify(completion.body));
    expect(completion.body['completed']).toBe(true);
    expect(completion.body['label']).toBe('completed_and_successful');
  }, 120_000);

  it('只开会话、一次编辑都没有 ⇒ 不判完成（空工作集不适用该口径）', async () => {
    const sessionId = Lib.safeId('r264-empty', 3, 'c');
    const opened = await call(
      Lib.planOpen({
        sessionId,
        deliverableId: Lib.safeId('r264-del', 3, 'c'),
        filename: '空.xlsx',
        format: 'xlsx',
        title: '空',
      }),
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);

    const completion = await call(Lib.planCompletion({ sessionId }));
    console.log('R264-EMPTY-COMPLETION', JSON.stringify(completion.body));
    expect(completion.body['completed'], '没有工作记录 ⇒ 不许说"都做完了"').toBe(false);
    expect(completion.body['label']).toBe('not_completed');
  }, 60_000);
});
