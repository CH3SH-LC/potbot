/**
 * FA-N —— **连续对话真实闭环**（合同 H2 / R207–R209 / R219）。
 *
 * ## 这一组测的是"真的跑起来了吗"，不是"函数返回值对不对"
 *
 * 被测对象是**编译后的真实宿主进程**（`.runtime/.../build/apps/demo/server/main.js`），
 * 用真 HTTP 打它，运行目录是 `mkdtemp` 出来的**隔离目录**（不碰仓库的 `.runtime/`）。
 * 模型上游是 `tests/demo/fixtures/fake-tool-model-server.mjs`——它实现的是宿主真正会打的
 * `POST /v1/messages`（Anthropic 形状）并**提出工具调用**，所以跑的是**真实执行器**
 * （`createRealExecutor` → `converseOnce` → 受约束解析 → `runToolLoop`）与**真实发布链**
 * （写盘 + 回读 + 出版投影）。
 *
 * **诚实边界（必须写在这里，也写在交付说明里）**：上游是夹具，不是 live 模型。
 * 因此本组证明的是"服务端这条链是真的"，**不是**"live 模型能写出好文章"。
 *
 * ## 判据
 *
 * ① 多轮对话：用户发消息 → 真实工具循环 → **真的产出 DOCX** → HTTP 下载 → Python 独立读回；
 * ② 重复投递同一个 `clientId`：**不新建消息、不新建任务、不再调模型**（R207）；
 * ③ 续取游标：只返回**严格大于**游标的事件，已消费内容**不重放**（R208）；
 * ④ 「已接收」与「业务完成」是**两条不同的记录**（R209）；
 * ⑤ 循环说完成但没有产物 ⇒ 记**失败**，不记完成（R226）；
 * ⑥ `/api/identity` 报的是**实际生效**的端口与运行目录（R219）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { REPO_ROOT, readbackDocx } from './support.js';

const FAKE_MODEL = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-tool-model-server.mjs');
const HOST_MAIN = join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

/**
 * **收尾清理的等价瘦身（只为耗时，不为判据）**
 *
 * 本文件的 `afterAll` 原先对**每一个**子进程各调一次 `killHard`，也就是每个进程单开一次
 * `taskkill`。Windows 上**单次 `taskkill` 实测 ≈0.9 s，且与 `/PID` 个数无关**；本文件
 * 13 个宿主 + 1 个假模型端点 ⇒ 收尾阶段纯开销 ≈12 s（实测占单跑总时长两成以上）。
 *
 * `taskkill` 本身就支持多个 `/PID`，因此这里把兜底**合并成一次进程调用**。等价的判据：
 * - 杀死的进程集合相同（`children` 里仍活着的那些）；
 * - 每个进程仍走 `child.kill()`，仍补 `/F /T` 兜底（`/F` 强杀 + `/T` 连子孙）；
 * - 已退出（本进程已回收）的句柄直接跳过——`kill` / `taskkill` 对它们都是无操作的重复。
 *
 * 用例数、通过数、断言、跳过数、`vitest*.config.ts` 一律未动。
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
  readonly runDir: string;
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
    ANTHROPIC_AUTH_TOKEN: 'fa-n-fixture-token-not-a-real-secret',
    ANTHROPIC_MODEL: 'fa-n-fixture-model',
  };
  delete env['ANTHROPIC_API_KEY'];
  const { child } = await startChild(HOST_MAIN, [], env, /绑定：127\.0\.0\.1:(\d+)/);
  const host: Host = { baseUrl: `http://127.0.0.1:${hostPort}`, runDir, port: hostPort, child };
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

async function fakeStats(modelPort: number): Promise<{ requests: number; toolTurns: number; finalTurns: number }> {
  const response = await fetch(`http://127.0.0.1:${modelPort}/__stats`);
  return (await response.json()) as { requests: number; toolTurns: number; finalTurns: number };
}

interface MessageView {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly state: string;
  readonly phase: string;
  readonly attempts: number;
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean } | null;
  readonly artifact: Record<string, unknown> | null;
}

async function conversation(host: Host, id: string): Promise<Record<string, unknown>> {
  const out = await json(host, 'GET', `/api/conversations/${id}`);
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  return out.body;
}

function messagesOf(body: Record<string, unknown>): MessageView[] {
  return (body['messages'] ?? []) as MessageView[];
}

/** 轮询到某条消息**业务定局**（completed / failed / cancelled）为止。 */
async function waitSettled(
  host: Host,
  conversationId: string,
  messageId: string,
  timeoutMs = 40_000,
): Promise<MessageView> {
  const deadline = Date.now() + timeoutMs;
  let last: MessageView | null = null;
  while (Date.now() < deadline) {
    const body = await conversation(host, conversationId);
    const found = messagesOf(body).find((item) => item.messageId === messageId);
    if (found !== undefined) {
      last = found;
      if (found.phase === 'completed' || found.phase === 'failed' || found.phase === 'cancelled') {
        return found;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待定局超时；最后看到：${JSON.stringify(last)}`);
}

let modelPort = 0;
let runDir = '';
let host: Host;

beforeEach(async () => {
  if (modelPort === 0) {
    const started = await startChild(FAKE_MODEL, ['0']);
    modelPort = started.port;
  }
  runDir = mkdtempSync(join(tmpdir(), 'fa-n-run-'));
  tempDirs.push(runDir);
  host = await startHost(modelPort, runDir);
}, 90_000);

describe('FA-N H2：连续对话 → 真实工具循环 → 真实文件 → 下载 → 独立读回', () => {
  it('一条多轮对话真的产出一份可下载、可独立读回的 DOCX', async () => {
    const before = await fakeStats(modelPort);

    /* ① 第一轮：用户提出要求。**202 = 已接收**，不是"完成"。 */
    const sent = await json(host, 'POST', '/api/conversations/conv-h2/messages', {
      clientId: 'c-h2-1',
      text: '帮我写一份新生读书会的邀请函。',
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body['conversationId']).toBe('conv-h2');
    expect(sent.body['messageId']).toBe('c-h2-1');
    expect(sent.body['phase']).toBe('accepted');
    expect(sent.body['state']).toBe('received');
    expect(sent.body['duplicate']).toBe(false);

    /* ② 等它业务定局。 */
    const settled = await waitSettled(host, 'conv-h2', 'c-h2-1');
    expect(settled.phase, JSON.stringify(settled.error)).toBe('completed');
    expect(settled.artifact, '业务完成必须带一份真实产物').not.toBeNull();

    /* ③ 助手消息也在，且是"业务完成"而不是"已接收"。 */
    const body = await conversation(host, 'conv-h2');
    const assistant = messagesOf(body).find((item) => item.role === 'assistant');
    expect(assistant, '必须有一条助手消息').toBeDefined();
    expect(assistant?.phase).toBe('completed');
    expect(String(assistant?.text)).toContain('文档已经写好');

    /* ④ 工具真的被调用了（夹具的独立计数，不依赖被测方的账本）。 */
    const after = await fakeStats(modelPort);
    expect(after.requests - before.requests).toBeGreaterThanOrEqual(2); // 至少：提工具 + 收尾
    expect(after.toolTurns - before.toolTurns).toBe(1);

    /* ⑤ 下载 + Python 独立读回：盘上那份就是交付的那份。 */
    const artifact = settled.artifact as { artifactId: string; downloadPath: string; sha256: string };
    const downloaded = await fetch(`${host.baseUrl}${artifact.downloadPath}`, { signal: AbortSignal.timeout(30_000) });
    expect(downloaded.status, '下载必须成功').toBe(200);
    expect(downloaded.headers.get('x-content-sha256')).toBe(artifact.sha256);
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);

    const target = join(runDir, 'downloaded.docx');
    writeFileSync(target, bytes);
    const readback = readbackDocx(target);
    expect(readback.ok, `独立读回失败：${readback.stdout}`).toBe(true);
    expect(readback.parsed?.document?.paragraphs.join('\n')).toContain('新生读书会邀请函');
    expect(readback.parsed?.document?.paragraphs.join('\n')).toContain('带着好奇心来就好');
  }, 120_000);

  it('第二轮追问复用同一会话：上下文里看得到上一轮（多轮，不是一次性）', async () => {
    await json(host, 'POST', '/api/conversations/conv-h2b/messages', {
      clientId: 'c-h2b-1',
      text: '写一份邀请函。',
    });
    await waitSettled(host, 'conv-h2b', 'c-h2b-1');

    const second = await json(host, 'POST', '/api/conversations/conv-h2b/messages', {
      clientId: 'c-h2b-2',
      text: '再写一版。',
    });
    expect(second.status).toBe(202);
    const settled = await waitSettled(host, 'conv-h2b', 'c-h2b-2');
    expect(settled.phase).toBe('completed');

    const body = await conversation(host, 'conv-h2b');
    const userMessages = messagesOf(body).filter((item) => item.role === 'user');
    expect(userMessages.map((item) => item.messageId)).toEqual(['c-h2b-1', 'c-h2b-2']);
    /* 第二轮产生了**新的**产物版本（同一任务下的下一版），不是复用第一版。 */
    const artifacts = messagesOf(body)
      .map((item) => (item.artifact as { artifactId?: string } | null)?.artifactId)
      .filter((value): value is string => typeof value === 'string');
    expect(new Set(artifacts).size).toBe(2);
  }, 120_000);
});

describe('FA-N R207：重复投递不重复建任务', () => {
  it('同一个 clientId 发两次：第二次 duplicate，且**不再调模型**、消息条数不变', async () => {
    const before = await fakeStats(modelPort);

    const first = await json(host, 'POST', '/api/conversations/conv-idem/messages', {
      clientId: 'c-idem-1',
      text: '写一份邀请函。',
    });
    expect(first.status).toBe(202);
    expect(first.body['duplicate']).toBe(false);
    await waitSettled(host, 'conv-idem', 'c-idem-1');

    const afterFirst = await fakeStats(modelPort);

    const again = await json(host, 'POST', '/api/conversations/conv-idem/messages', {
      clientId: 'c-idem-1',
      text: '写一份邀请函。',
    });
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body['duplicate']).toBe(true);
    expect(again.body['messageId']).toBe('c-idem-1');

    const afterSecond = await fakeStats(modelPort);
    expect(afterSecond.requests, '重复投递不得再调一次模型').toBe(afterFirst.requests);
    expect(afterSecond.requests).toBeGreaterThan(before.requests);

    const body = await conversation(host, 'conv-idem');
    expect(messagesOf(body).filter((item) => item.role === 'user')).toHaveLength(1);
  }, 120_000);

  it('同一个 clientId 换内容：409 结构化拒绝（不当成新消息）', async () => {
    await json(host, 'POST', '/api/conversations/conv-conflict/messages', {
      clientId: 'c-conf-1',
      text: '第一版要求。',
    });
    const clash = await json(host, 'POST', '/api/conversations/conv-conflict/messages', {
      clientId: 'c-conf-1',
      text: '完全不同的要求。',
    });
    expect(clash.status).toBe(409);
    expect(clash.body['code']).toBe('idempotency_conflict');
    await waitSettled(host, 'conv-conflict', 'c-conf-1');
    const body = await conversation(host, 'conv-conflict');
    expect(messagesOf(body).filter((item) => item.role === 'user')).toHaveLength(1);
  }, 120_000);
});

describe('FA-N R208：续取游标不重放已消费内容', () => {
  it('带游标取事件：只回**严格大于**该游标的事件；重复取同一游标返回空', async () => {
    await json(host, 'POST', '/api/conversations/conv-cursor/messages', {
      clientId: 'c-cur-1',
      text: '写一份邀请函。',
    });
    await waitSettled(host, 'conv-cursor', 'c-cur-1');

    const all = await json(host, 'GET', '/api/conversations/conv-cursor/events');
    expect(all.status).toBe(200);
    const events = all.body['events'] as Array<{ seq: number; kind: string }>;
    expect(events.length).toBeGreaterThan(3);
    const cursor = String(all.body['cursor']);
    expect(cursor).toContain('conv:conv-cursor:');

    /* 已消费到 cursor 之后再取：**一条都不重放**。 */
    const replayed = await json(host, 'GET', `/api/conversations/conv-cursor/events?cursor=${encodeURIComponent(cursor)}`);
    expect(replayed.status).toBe(200);
    expect((replayed.body['events'] as unknown[]).length).toBe(0);
    expect(replayed.body['cursor']).toBe(cursor);
    expect((replayed.body['pending'] as unknown[]).length).toBe(0);

    /* 新动作产生的新事件**只**包含严格大于游标的那几条。 */
    await json(host, 'POST', '/api/conversations/conv-cursor/messages', {
      clientId: 'c-cur-2',
      text: '再写一版。',
    });
    const delta = await json(host, 'GET', `/api/conversations/conv-cursor/events?cursor=${encodeURIComponent(cursor)}`);
    const newEvents = delta.body['events'] as Array<{ seq: number }>;
    expect(newEvents.length).toBeGreaterThan(0);
    const cursorSeq = Number(cursor.split(':').pop());
    for (const event of newEvents) {
      expect(event.seq).toBeGreaterThan(cursorSeq);
    }
    await waitSettled(host, 'conv-cursor', 'c-cur-2');
  }, 120_000);

  it('跨会话游标被结构化拒绝（不静默从头重放）', async () => {
    await json(host, 'POST', '/api/conversations/conv-a/messages', { clientId: 'c-a-1', text: '写一份邀请函。' });
    /* 先把 conv-b **建出来**（不消耗模型额度）：否则会先撞上 404"没有这个会话"，
       测不到游标校验那一条。 */
    const created = await json(host, 'POST', '/api/conversations', { conversationId: 'conv-b', name: '另一个会话' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const foreign = await json(host, 'GET', '/api/conversations/conv-b/events?cursor=' + encodeURIComponent('conv:conv-a:3'));
    expect(foreign.status).toBe(409);
    expect(foreign.body['code']).toBe('cursor_conversation_mismatch');
    await waitSettled(host, 'conv-a', 'c-a-1');
  }, 120_000);
});

describe('FA-N R209 / R226：状态分得开，不把"说完了"当成"做完了"', () => {
  it('循环说完成但没有产出任何产物 ⇒ 记失败（code=no_artifact），不记完成', async () => {
    await json(host, 'POST', '/api/conversations/conv-noart/messages', {
      clientId: 'c-noart-1',
      text: 'NO_TOOL 请你只是回复我一句话，不要生成文档。',
    });
    const settled = await waitSettled(host, 'conv-noart', 'c-noart-1');
    expect(settled.phase).toBe('failed');
    expect(settled.error?.code).toBe('no_artifact');
    expect(settled.artifact).toBeNull();
    expect(settled.error?.message).toContain('没有');
  }, 120_000);

  it('工具被内容拒绝（只给一段）⇒ 如实回给模型；最终仍无产物 ⇒ 失败', async () => {
    await json(host, 'POST', '/api/conversations/conv-baddoc/messages', {
      clientId: 'c-bad-1',
      text: 'BAD_DOC 写一份只有一段的文档。',
    });
    const settled = await waitSettled(host, 'conv-baddoc', 'c-bad-1');
    expect(settled.phase).toBe('failed');
    expect(settled.artifact).toBeNull();

    /* 工具确实被调用过，而且**失败原因进了事件**（不是被吞掉）。 */
    const events = await json(host, 'GET', '/api/conversations/conv-baddoc/events');
    const kinds = (events.body['events'] as Array<{ kind: string; detail: Record<string, unknown> | null }>);
    expect(kinds.some((event) => event.kind === 'tool_failed')).toBe(true);
  }, 120_000);

  it('取消一条在途消息：状态是 cancelled，与完成 / 失败都不同', async () => {
    /* 夹具 `HANG_ONCE` 会挂住第一次请求 ⇒ 这条消息会停在"执行中"。 */
    await json(host, 'POST', '/api/conversations/conv-cancel/messages', {
      clientId: 'c-cancel-1',
      text: 'HANG_ONCE 写一份邀请函。',
    });
    /* 等到它真的进入执行中。 */
    let running = false;
    for (let i = 0; i < 60 && !running; i += 1) {
      const events = await json(host, 'GET', '/api/conversations/conv-cancel/events');
      running = (events.body['events'] as Array<{ kind: string }>).some((event) => event.kind === 'run_started');
      if (!running) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(running, '这条消息应当已经进入执行中').toBe(true);

    const cancelled = await json(host, 'POST', '/api/conversations/conv-cancel/messages/c-cancel-1/cancel', {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body['phase']).toBe('cancelled');

    const settled = await waitSettled(host, 'conv-cancel', 'c-cancel-1');
    expect(settled.phase).toBe('cancelled');
    expect(settled.state).toBe('cancelled');
  }, 120_000);
});

describe('FA-N R219：宿主与验证者核对的是**同一个候选**', () => {
  it('/api/identity 报的端口与运行目录就是实际生效的那一份', async () => {
    const identity = await json(host, 'GET', '/api/identity');
    expect(identity.status).toBe(200);
    expect(identity.body['port']).toBe(host.port);
    expect(String(identity.body['runDir'])).toBe(runDir);
    /* 运行 id **由运行目录名派生**：改了 RUN_DIR 就会跟着变，不是写死的常量。 */
    const expectedRunId = runDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    expect(identity.body['runId']).toBe(expectedRunId);
    expect(identity.body['kernelStorePath']).toBe(join(runDir, 'kernel-store', 'store.json'));
    expect(identity.body['conversationDir']).toBe(join(runDir, 'conversations'));
  }, 90_000);
});

describe('FA-N 未接入时如实降级', () => {
  it('对不存在的会话取状态是 404（**不**隐式建一个空会话）', async () => {
    const missing = await json(host, 'GET', '/api/conversations/never-created');
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('conversation_not_found');
  }, 60_000);

  it('events 路由缺少会话同样是 404（不是空事件流）', async () => {
    const missing = await json(host, 'GET', '/api/conversations/never-created/events');
    expect(missing.status).toBe(404);
  }, 60_000);
});

describe('FA-N 会话目录确实落了盘（重启的前提）', () => {
  it('发过消息后，运行目录里出现该会话的落盘文件', async () => {
    await json(host, 'POST', '/api/conversations/conv-persist/messages', {
      clientId: 'c-persist-1',
      text: '写一份邀请函。',
    });
    await waitSettled(host, 'conv-persist', 'c-persist-1');
    expect(existsSync(join(runDir, 'conversations', 'conv-persist.json'))).toBe(true);
  }, 120_000);
});
