/**
 * S6 验收用例 ⑦：**模型失败分支的端到端验收（零额度，全部走夹具）**。
 *
 * 对应任务书/合同的硬要求：「**模型错误、空响应或解析失败不得替换为固定成功稿**」，
 * 以及主协调者 2026-10-02 追加的形态：**模型有响应但 `outputChars = 0`**（thinking 把
 * 输出预算吃光）——此时任务**必须转 `failed`、不得产出任何 artifact、不得返回旧文件**。
 *
 * ## 这一组为什么可信
 *
 * - **不消耗任何真实模型额度**：模型端点是本目录的 `fake-model-server.mjs`，
 *   宿主用 `ANTHROPIC_BASE_URL` 指过去；宿主是**编译后的真实宿主**
 *   （`.runtime/mobile-word-demo/build/apps/demo/server/main.js`），不是替身。
 * - **"重复提交不二次调用模型"用的是独立计数器**：直接读假模型端点自己数到的请求次数
 *   （`GET /__stats`），**不看被测方自己的账本**——这正是主协调者裁定的正确口径。
 * - 阳性对照臂（`ok` 模式）跑通全链（真实宿主 → 写盘 → 下载 → 独立读回），
 *   证明上面的"失败"是**因为模型响应不行**，不是因为夹具接错了。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, listFiles, readbackDocx } from './support.js';

const FAKE_MODEL = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-model-server.mjs');
const HOST_MAIN = join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

/**
 * 请求终止一个子进程（**不做同步 taskkill 兜底**）。
 *
 * Windows 上 `child.kill()` 偶发不生效（实测残留过假模型端点进程），因此需要一个
 * `taskkill /F /T` 兜底。但实测每次 `taskkill.exe` 调用（哪怕 PID 已经退出）要 ~1.2 s：
 * 逐个子进程兜底，7 个编译宿主 + 7 个假模型端点就是 ~17 s 的纯等待。这里只发 `kill()`；
 * 真正兜底**合并成一次多 PID 调用**（`taskkill /F /T /PID a /PID b …`，实测 3 个 PID
 * 仍只 ~1.3 s），统一在 {@link afterAll} 里做完——**被杀的是同一批进程，断言不受影响**。
 */
function requestKill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
}

// 显式放宽 hook 超时：Windows 上合并 taskkill 兜底 + 递归删除临时目录，默认 10s 仍可能不够。
afterAll(() => {
  for (const child of children) requestKill(child);
  // 仍活着的（`kill()` 偶发不生效的形态）用**一次** taskkill 兜底全部 PID；
  // 已退出的 PID 一并带上，taskkill 对它们是廉价的无操作（与逐 PID 版本同样的终态）。
  const pids = children.map((c) => c.pid).filter((p): p is number => typeof p === 'number');
  if (process.platform === 'win32' && pids.length > 0) {
    const args = ['/F', '/T'];
    for (const pid of pids) args.push('/PID', String(pid));
    try {
      spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已经退出就够了 */
    }
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

function startProcess(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ child: ChildProcess; output: () => string; match: Promise<RegExpExecArray> }> {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  children.push(child);
  let buffer = '';
  const waiters: { regex: RegExp; resolve: (m: RegExpExecArray) => void }[] = [];
  const feed = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter === undefined) continue; // noUncheckedIndexedAccess：显式处理缺失，不用 `!`
      const match = waiter.regex.exec(buffer);
      if (match) {
        waiters.splice(i, 1);
        waiter.resolve(match);
      }
    }
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  const match = new Promise<RegExpExecArray>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动超时：${script}\n${buffer}`)), 20_000);
    waiters.push({
      regex: /listening on (\d+)|绑定[：:][^:]*:(\d+)/,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
  return Promise.resolve({ child, output: () => buffer, match });
}

async function startFakeModel(mode: string): Promise<{ port: number; stats: () => Promise<number> }> {
  const { match } = await startProcess(FAKE_MODEL, ['0', mode]);
  const found = await match;
  const port = Number(found[1] ?? found[2]);
  const stats = async (): Promise<number> => {
    const response = await fetch(`http://127.0.0.1:${port}/__stats`);
    const body = (await response.json()) as { requests: number };
    return body.requests;
  };
  return { port, stats };
}

interface Host {
  readonly baseUrl: string;
  readonly runDir: string;
  readonly child: ChildProcess;
}

/**
 * 向系统要一个当前空闲的端口号（已观察到宿主在 `POTBOT_PORT=0` 时会把 `:0` 原样打日志，
 * 因此不能靠 "端口 0" 反过来发现真实端口——这是宿主日志的一处小瑕疵，已记入报告 N8）。
 */
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

async function startHost(modelPort: number): Promise<Host> {
  const runDir = mkdtempSync(join(tmpdir(), 's6-host-run-'));
  tempDirs.push(runDir);
  const hostPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(hostPort),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    // 本轮实测到的坑（已记入报告 N8）：宿主用 `POTBOT_RUN_DIR` 定位运行目录，
    // 而模型端口的**额度账本**走的是**另一个**变量 `POTBOT_RUNTIME_DIR`（默认落到
    // `.runtime/mobile-word-demo/<runId>/`）。不显式隔离就会读到真实账本，
    // 于是新起的隔离实例一开口就是 `model_budget_exhausted`。夹具必须两个都指到临时目录。
    POTBOT_RUNTIME_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    ANTHROPIC_AUTH_TOKEN: 's6-fixture-token-not-a-real-secret',
    ANTHROPIC_MODEL: 's6-fixture-model',
  };
  delete env['ANTHROPIC_API_KEY'];
  const { child } = await startProcess(HOST_MAIN, [], env);
  const host: Host = { baseUrl: `http://127.0.0.1:${hostPort}`, runDir, child };
  // 等健康检查就绪（**总预算 20s 不变**：100ms × 200 = 20s，原为 500ms × 40）。
  for (let i = 0; i < 200; i += 1) {
    try {
      const response = await fetch(`${host.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return host;
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const info = (child as unknown as { stdout?: { read?: () => string } }) ?? {};
  throw new Error(`宿主健康检查未就绪：${JSON.stringify(info)}`);
}

async function submitAndWait(host: Host, requestId: string, instruction: string): Promise<Record<string, unknown>> {
  const created = await fetch(`${host.baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, instruction }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(created.status, '提交应返回 202').toBe(202);
  const { taskId } = (await created.json()) as { taskId: string };
  // 同 `startHost`：**总预算 30s 不变**（100ms × 300 = 30s，原为 500ms × 60）。
  for (let i = 0; i < 300; i += 1) {
    const poll = await fetch(`${host.baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = (await poll.json()) as Record<string, unknown>;
    if (['ready', 'failed', 'interrupted'].includes(String(body['status']))) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('任务未在 30s 内到达终态');
}

const INSTRUCTION = '为新生读书会写一封温暖的邀请函，不编造时间地点和报名联系方式。';

describe('模型失败分支（夹具，零额度）', () => {
  it('[前置] 编译后的真实宿主存在', () => {
    expect(
      existsSync(HOST_MAIN),
      `[未满足] 找不到编译后的宿主 ${HOST_MAIN}；请先执行 node node_modules/typescript/bin/tsc -p tsconfig.demo.json`,
    ).toBe(true);
  });

  it('模型"有响应但无 text 块（outputChars=0）"⇒ 任务 failed、零 artifact、零残留文件', async () => {
    const model = await startFakeModel('truncated-thinking');
    const host = await startHost(model.port);

    const task = await submitAndWait(host, `s6-empty-${Date.now()}`, INSTRUCTION);

    expect(task['status'], '空响应必须判失败，不得兜底成成功稿').toBe('failed');
    expect(task['artifact'] ?? null, '失败任务不得携带 artifact').toBeNull();

    const error = task['error'] as { code?: string; message?: string; retryable?: boolean } | undefined;
    expect(typeof error?.code, '失败必须带稳定 code').toBe('string');
    expect(String(error?.code), `code 应为模型响应层错误，实际 ${String(error?.code)}`).toMatch(/^model_/);
    expect(/(truncated|empty_response)/.test(String(error?.code)), `code=${String(error?.code)}`).toBe(true);
    expect(typeof error?.retryable, 'retryable 必须是布尔').toBe('boolean');
    expect(/[一-龥]/.test(String(error?.message)), 'message 必须是中文说明').toBe(true);

    // 盘上不得留下任何产物字节。
    const artifacts = listFiles(join(host.runDir, 'artifacts'));
    expect(artifacts, `失败却落了文件：${artifacts.join('、')}`).toEqual([]);

    // 而且确实打过模型（证明不是"根本没调用"造成的假失败）。
    expect(await model.stats(), '应当真的请求过假模型端点').toBeGreaterThan(0);
    requestKill(host.child);
  }, 90_000);

  it('同 requestId 重复提交：返回同一 taskId，且假模型端点的请求计数**不增加**（独立证据）', async () => {
    const model = await startFakeModel('truncated-thinking');
    const host = await startHost(model.port);
    const requestId = `s6-dup-${Date.now()}`;

    const first = await submitAndWait(host, requestId, INSTRUCTION);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const beforeDup = await model.stats();

    const again = await fetch(`${host.baseUrl}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, instruction: INSTRUCTION }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(again.status).toBe(202);
    const againBody = (await again.json()) as { taskId: string };
    expect(againBody.taskId, '同 ID 同输入必须返回既有任务').toBe(first['taskId']);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const afterDup = await model.stats();
    expect(
      afterDup,
      `重复提交不得再调模型（假模型端点独立计数 ${beforeDup} → ${afterDup}）`,
    ).toBe(beforeDup);

    requestKill(host.child);
  }, 90_000);

  it('空白正文（model_empty_response 形态）同样必须失败且零产物', async () => {
    const model = await startFakeModel('blank');
    const host = await startHost(model.port);
    const task = await submitAndWait(host, `s6-blank-${Date.now()}`, INSTRUCTION);

    expect(task['status']).toBe('failed');
    expect(task['artifact'] ?? null).toBeNull();
    const code = String((task['error'] as { code?: string } | undefined)?.code ?? '');
    expect(code).toMatch(/^model_/);
    expect(code).toBe('model_empty_response');
    expect(listFiles(join(host.runDir, 'artifacts'))).toEqual([]);
    requestKill(host.child);
  }, 90_000);

  it('失败的产物 ID 下载必须是 404，不得返回任何旧文件', async () => {
    const model = await startFakeModel('truncated-thinking');
    const host = await startHost(model.port);
    await submitAndWait(host, `s6-404-${Date.now()}`, INSTRUCTION);

    const response = await fetch(`${host.baseUrl}/api/artifacts/art-does-not-exist-s6/download`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status, '未知产物必须 404').toBe(404);
    expect((await response.arrayBuffer()).byteLength).toBeLessThan(4096);
    requestKill(host.child);
  }, 90_000);

  it('[灵敏度对照] 同一请求在"空响应模型"与"正常模型"下**必须给出不同结论**（防止断言恒真）', async () => {
    // 项目经验 info-021：不会红的断言不是判据。若我的"空响应必须 failed"其实是恒真
    // （比如不管模型返回什么都失败），上面对照臂会过而这条会红——两条一起才说明
    // **判据真的按模型响应分流**。
    const emptyModel = await startFakeModel('truncated-thinking');
    const emptyHost = await startHost(emptyModel.port);
    const withEmpty = await submitAndWait(emptyHost, `s6-sens-empty-${Date.now()}`, INSTRUCTION);
    requestKill(emptyHost.child);

    const okModel = await startFakeModel('ok');
    const okHost = await startHost(okModel.port);
    const withOk = await submitAndWait(okHost, `s6-sens-ok-${Date.now()}`, INSTRUCTION);
    requestKill(okHost.child);

    expect(withEmpty['status']).toBe('failed');
    expect(withOk['status']).toBe('ready');
    expect(withEmpty['status'], '两种模型响应必须给出不同结论，否则判据无判别力').not.toBe(withOk['status']);
    expect(withEmpty['artifact'] ?? null).toBeNull();
    expect(withOk['artifact'] ?? null).not.toBeNull();
  }, 90_000);

  it('阳性对照臂：模型给出合法草稿时，全链跑通（ready + 下载 + 独立读回）', async () => {
    const model = await startFakeModel('ok');
    const host = await startHost(model.port);
    const task = await submitAndWait(host, `s6-ok-${Date.now()}`, INSTRUCTION);

    expect(task['status'], '对照组必须成功，否则上面的"失败"无法归因于模型响应').toBe('ready');
    const artifact = task['artifact'] as { downloadPath: string; sha256: string; byteLength: number } | undefined;
    expect(artifact?.downloadPath, '成功任务必须有可下载产物').toBeTypeOf('string');

    const download = await fetch(`${host.baseUrl}${artifact?.downloadPath}`, { signal: AbortSignal.timeout(15_000) });
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(artifact?.byteLength);

    const saved = join(host.runDir, 'downloaded.docx');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(saved, bytes);
    const readback = readbackDocx(saved);
    expect(readback.exitCode, `独立读回失败：${JSON.stringify(readback.parsed?.error)}`).toBe(0);
    expect(readback.parsed?.ok).toBe(true);
    // 正文段落 = 草稿逐字（夹具草稿两段）。
    const draft = task['draft'] as { title: string; paragraphs: { text: string }[] } | undefined;
    expect(readback.parsed?.document?.title).toBe(draft?.title);
    expect(readback.parsed?.document?.paragraphs?.slice(0, 3)).toEqual([
      draft?.title,
      ...(draft?.paragraphs ?? []).map((p) => p.text),
    ]);
    requestKill(host.child);
  }, 90_000);
});
