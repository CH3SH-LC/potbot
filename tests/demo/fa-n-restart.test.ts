/**
 * FA-N —— **重启路径开始测试**（合同 H2 末句 / R215–R217）。
 *
 * ## 为什么这一组必须真的"杀掉进程再拉起来"
 *
 * "会话能恢复"如果只在一个进程里断言，测的是**内存**，不是**重启**。
 * 所以这里的每个用例都：起真实宿主进程 → 干活 → **硬杀**（`taskkill /T`）→
 * 用**同一个运行目录**再起一个进程 → 再回答同一个问题。
 *
 * ## 判据（正例 + 反例，缺一不可）
 *
 * | 判据 | 正例 | 反例 |
 * |---|---|---|
 * | **不丢工作** | 重启后消息正文、消息 id、attempts 一个不少 | —— |
 * | **不重复建任务** | 重启后重试复用同一条消息，消息条数不变 | 不存在的会话重启后仍是 404 |
 * | **不盲重放**（R217） | 在途消息被如实标 `failed / server_restarted / retryable` | 已定局的 completed 消息**不能**重试（409） |
 * | **读不回来 ≠ 不存在**（R216） | —— | 落盘文件被改坏 ⇒ 503 `conversation_unreadable`（不是 404） |
 * | **游标继续**（R208） | 重启后带旧游标取事件，**不重放**已消费的 | —— |
 *
 * ## 诚实边界
 *
 * 模型上游是夹具（`fake-tool-model-server.mjs` 的 `HANG_ONCE` 用来制造"在途被杀"），
 * 不是 live 模型。真机层（荣耀 Magic7）本轮仍然未接。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './support.js';

const FAKE_MODEL = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-tool-model-server.mjs');
const HOST_MAIN = join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function killHard(child: ChildProcess): void {
  const pid = child.pid;
  // **已退出的进程不可能再泄漏**：本文件的每条用例在自己的流程里都会对"第一个"宿主显式
  // `killHard` 一次（那一次已做过 `taskkill` 兜底），`afterAll` 再兜底一遍时它必然已退出。
  // Windows 上 `taskkill` 对**已退出**的 PID 单次仍要 ≈0.9 s——直接跳过；兜底只对**仍活着**
  // 的进程生效（那才是 `kill()` 偶发不生效的形态）。
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  if (process.platform === 'win32' && typeof pid === 'number') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已退出即可 */
    }
  }
}

/**
 * **收尾清理的等价瘦身（只为耗时，不为判据）**
 *
 * 原先 `afterAll` 对**每一个仍活着的**子进程各调一次 `killHard`，也就是每个进程单开一次
 * `taskkill`。Windows 上单次 `taskkill` 实测 ≈0.9 s 且**与 `/PID` 个数无关**；`taskkill`
 * 支持多个 `/PID`，因此这里把兜底**合并成一次进程调用**——杀死的进程集合、每个进程走的
 * `child.kill()` + `/F /T` 兜底、以及"已退出则跳过"的判据全部不变，只是少了若干次进程创建。
 *
 * 用例数、通过数、断言、跳过数、`vitest*.config.ts` 一律未动。用例内那 4 次单进程
 * `killHard`（造"在途被杀"）语义必须保持"当场杀掉、当场重启"，**原样保留**。
 */
function killAll(): void {
  const alive: ChildProcess[] = [];
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill();
    alive.push(child);
  }
  if (process.platform !== 'win32') return;
  const pids = alive
    .map((child) => child.pid)
    .filter((pid): pid is number => typeof pid === 'number');
  if (pids.length === 0) return;
  try {
    spawnSync('taskkill', [...pids.flatMap((pid) => ['/PID', String(pid)]), '/F', '/T'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    /* 已退出即可 */
  }
}

afterAll(() => {
  killAll();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

function startChild(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  readyRegex = /listening on (\d+)/,
): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    children.push(child);
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`启动超时：${script}\n${buffer}`)), 30_000);
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = readyRegex.exec(buffer);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出 code=${String(code)}：${buffer}`));
    });
  });
}

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

interface Host {
  readonly baseUrl: string;
  readonly port: number;
  readonly child: ChildProcess;
}

async function startHost(modelPort: number, runDir: string): Promise<Host> {
  const hostPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(hostPort),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    ANTHROPIC_AUTH_TOKEN: 'fa-n-restart-token-not-a-real-secret',
    ANTHROPIC_MODEL: 'fa-n-fixture-model',
  };
  delete env['ANTHROPIC_API_KEY'];
  const { child } = await startChild(HOST_MAIN, [], env, /绑定：127\.0\.0\.1:(\d+)/);
  const host: Host = { baseUrl: `http://127.0.0.1:${hostPort}`, port: hostPort, child };
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${host.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return host;
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('宿主健康检查未就绪');
}

async function json(
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${host.baseUrl}${path}`, init);
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

interface MessageView {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly phase: string;
  readonly state: string;
  readonly attempts: number;
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } | null;
  readonly artifact: Record<string, unknown> | null;
}

async function waitRunning(host: Host, conversationId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await json(host, 'GET', `/api/conversations/${conversationId}/events`);
    const kinds = (events.body['events'] as Array<{ kind: string }> | undefined) ?? [];
    if (kinds.some((event) => event.kind === 'run_started')) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('等待 run_started 超时');
}

async function waitSettled(
  host: Host,
  conversationId: string,
  messageId: string,
  timeoutMs = 40_000,
): Promise<MessageView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await json(host, 'GET', `/api/conversations/${conversationId}`);
    const found = ((body.body['messages'] as MessageView[] | undefined) ?? []).find(
      (item) => item.messageId === messageId,
    );
    if (found !== undefined && ['completed', 'failed', 'cancelled'].includes(found.phase)) return found;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('等待定局超时');
}

let modelPort = 0;

beforeAll(async () => {
  const started = await startChild(FAKE_MODEL, ['0']);
  modelPort = started.port;
}, 60_000);

describe('FA-N 重启：会话恢复、不丢工作、不重复建任务、不盲重放', () => {
  it('在途消息被硬杀后重启：消息还在、被如实标为可重试的失败、重试复用同一条消息并真的完成', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'fa-n-restart-'));
    tempDirs.push(runDir);

    /* ---- 第一段：起进程，制造一条"在途"的消息 ---------------------------- */
    const first = await startHost(modelPort, runDir);
    const accepted = await json(first, 'POST', '/api/conversations/conv-restart/messages', {
      clientId: 'c-restart-1',
      text: 'HANG_ONCE 写一份邀请函。',
    });
    expect(accepted.status).toBe(202);

    const eventsBeforeKill = await json(first, 'GET', '/api/conversations/conv-restart/events');
    const cursorBeforeKill = String(eventsBeforeKill.body['cursor']);
    const messagesBefore = ((await json(first, 'GET', '/api/conversations/conv-restart')).body['messages'] ??
      []) as MessageView[];
    await waitRunning(first, 'conv-restart');
    expect(messagesBefore.filter((item) => item.role === 'user')).toHaveLength(1);

    /* ---- 硬杀（不是优雅退出：要测的就是"没来得及收尾"） ------------------ */
    killHard(first.child);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    /* ---- 第二段：同一个运行目录，新进程 ---------------------------------- */
    const second = await startHost(modelPort, runDir);

    /* ① 不丢工作：消息正文 / id / attempts 一个不少。 */
    const after = await json(second, 'GET', '/api/conversations/conv-restart');
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const messagesAfter = (after.body['messages'] ?? []) as MessageView[];
    const userMessages = messagesAfter.filter((item) => item.role === 'user');
    expect(userMessages, '重启不得丢消息').toHaveLength(1);
    expect(userMessages[0]?.messageId).toBe('c-restart-1');
    expect(userMessages[0]?.text).toContain('写一份邀请函');

    /* ② 不盲重放：在途那条被如实标成"服务重启导致失败"，且**可重试**。 */
    const interrupted = userMessages[0];
    expect(interrupted?.phase).toBe('failed');
    expect(interrupted?.state).toBe('failed');
    expect(interrupted?.error?.code).toBe('server_restarted');
    expect(interrupted?.error?.retryable).toBe(true);
    expect(interrupted?.error?.message).toContain('重放');

    /* ③ 游标继续：重启补的那条事件在旧游标**之后**，旧内容不重放。 */
    const delta = await json(
      second,
      'GET',
      `/api/conversations/conv-restart/events?cursor=${encodeURIComponent(cursorBeforeKill)}`,
    );
    const newEvents = (delta.body['events'] as Array<{ kind: string; seq: number }>) ?? [];
    const cursorSeq = Number(cursorBeforeKill.split(':').pop());
    expect(newEvents.length).toBeGreaterThan(0);
    for (const event of newEvents) expect(event.seq).toBeGreaterThan(cursorSeq);
    expect(newEvents.some((event) => event.kind === 'server_restarted')).toBe(true);

    /* ④ 重启自检的只读旁证。 */
    const identity = await json(second, 'GET', '/api/identity');
    expect(identity.body['runId']).toBe(runDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop());

    /* ⑤ 重试复用**同一条消息**（不新建），并真的跑完。 */
    const retried = await json(second, 'POST', '/api/conversations/conv-restart/messages/c-restart-1/retry', {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(retried.body['messageId']).toBe('c-restart-1');
    expect(retried.body['attempts']).toBe(1);

    const settled = await waitSettled(second, 'conv-restart', 'c-restart-1');
    expect(settled.phase, JSON.stringify(settled.error)).toBe('completed');
    expect(settled.artifact, '重试之后必须真的产出文件').not.toBeNull();

    const finalBody = await json(second, 'GET', '/api/conversations/conv-restart');
    const finalMessages = (finalBody.body['messages'] ?? []) as MessageView[];
    expect(
      finalMessages.filter((item) => item.role === 'user'),
      '重试不得新建第二条用户消息',
    ).toHaveLength(1);
    /* 助手消息也只有一个 id（重试复用同一个助手消息，不越积越多）。 */
    const assistantIds = finalMessages.filter((item) => item.role === 'assistant').map((item) => item.messageId);
    expect(new Set(assistantIds).size).toBe(assistantIds.length);
  }, 180_000);

  it('反例：重启后，已定局为 completed 的消息**不能**重试（409，不重复建任务）', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'fa-n-restart-ok-'));
    tempDirs.push(runDir);
    const first = await startHost(modelPort, runDir);

    await json(first, 'POST', '/api/conversations/conv-done/messages', {
      clientId: 'c-done-1',
      text: '写一份邀请函。',
    });
    const settled = await waitSettled(first, 'conv-done', 'c-done-1');
    expect(settled.phase).toBe('completed');

    killHard(first.child);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const second = await startHost(modelPort, runDir);
    const after = await json(second, 'GET', '/api/conversations/conv-done');
    expect(after.status).toBe(200);
    const userMessages = ((after.body['messages'] ?? []) as MessageView[]).filter((item) => item.role === 'user');
    expect(userMessages).toHaveLength(1);
    /* 已完成的消息跨重启仍然是 completed，**不会**被重启归位改写成失败。 */
    expect(userMessages[0]?.phase).toBe('completed');

    const retry = await json(second, 'POST', '/api/conversations/conv-done/messages/c-done-1/retry', {});
    expect(retry.status).toBe(409);
    expect(retry.body['code']).toBe('not_retryable');
  }, 180_000);

  it('反例：落盘文件被改坏 ⇒ 503 `conversation_unreadable`，**不是** 404', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'fa-n-restart-bad-'));
    tempDirs.push(runDir);
    const first = await startHost(modelPort, runDir);

    await json(first, 'POST', '/api/conversations/conv-broken/messages', {
      clientId: 'c-broken-1',
      text: '写一份邀请函。',
    });
    expect(readFileSync(join(runDir, 'conversations', 'conv-broken.json'), 'utf8').length).toBeGreaterThan(0);
    killHard(first.child);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    /* 把落盘状态改坏（模拟磁盘损坏 / 半截写入）。 */
    writeFileSync(join(runDir, 'conversations', 'conv-broken.json'), '{"schema":"potbot-conversation-store.v1","conversationId":', 'utf8');

    const second = await startHost(modelPort, runDir);
    const broken = await json(second, 'GET', '/api/conversations/conv-broken');
    expect(broken.status, JSON.stringify(broken.body)).toBe(503);
    expect(broken.body['code']).toBe('conversation_unreadable');
    expect(String(broken.body['message'])).toContain('读不回来');

    /* 对照：真的不存在的会话仍然是 404——两种情况**分得开**。 */
    const missing = await json(second, 'GET', '/api/conversations/never-existed');
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('conversation_not_found');
  }, 180_000);

  it('反例：不存在的会话在重启后**仍然**不存在（不会被凭空造出来）', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'fa-n-restart-empty-'));
    tempDirs.push(runDir);
    const first = await startHost(modelPort, runDir);
    killHard(first.child);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const second = await startHost(modelPort, runDir);
    const missing = await json(second, 'GET', '/api/conversations/ghost');
    expect(missing.status).toBe(404);
    const list = await json(second, 'GET', '/api/conversations');
    expect(list.status).toBe(200);
    expect((list.body['conversations'] as unknown[]) ?? []).toHaveLength(0);
  }, 180_000);
});
