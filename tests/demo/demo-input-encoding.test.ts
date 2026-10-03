/**
 * S6 验收用例 ⑨：**输入编码体检的独立验证（夹具，零额度）**。
 *
 * S3 在落库 / 去重 / 扣额度 / 调模型**之前**加了检查：
 *  - 含 U+FFFD（替换字符）⇒ `instruction_encoding_broken`
 *  - 含裸控制字符（C0 除 `\t\n\r`、DEL、C1）⇒ `instruction_control_characters`
 * 两者都 `retryable:false`、**零额度**。
 *
 * ## 三条我都要验，而且第 ② 条最重要
 *
 * ① 两类污染各被拒、**零额度**、HTTP 400 + `DemoError` 形状；
 * ② **正常中文 / 日文 / emoji / 制表换行绝不被误杀**（过度拦截会把现场正常请求打死，
 *    这比漏拦更致命）；
 * ③ 拒绝必须发生在**调用模型之前**——用**假模型端点自己的请求计数**证明（独立证据）。
 *
 * 全部走夹具：宿主是编译后的真实宿主，模型端点是我的 `fake-model-server.mjs`。**零真实请求。**
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './support.js';

const FAKE_MODEL = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-model-server.mjs');
const HOST_MAIN = join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function killHard(child: ChildProcess): void {
  const pid = child.pid;
  // **已退出的进程不可能再泄漏**：本文件每条用例在结尾都已对 host / model 各调过一次
  // `killHard`（`child.kill()` + `taskkill` 兜底），`afterAll` 再兜底一遍时它们必然已退出。
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
 * `taskkill`（Windows 上单次实测 ≈0.9 s，且**与 `/PID` 个数无关**）。`taskkill` 支持多个
 * `/PID`，因此这里把兜底**合并成一次进程调用**——杀死的进程集合、每个进程走的
 * `child.kill()` + `/F /T` 兜底、以及"已退出则跳过"的判据全部不变，只是少了若干次进程创建。
 * 用例内那 6 次单进程 `killHard`（每条用例结尾）**原样保留**：它们的作用是当场释放端口与
 * run 目录，时序不能改。
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

// 显式放宽 hook 超时（Windows 上 `taskkill` 兜底 + 删临时目录会超过默认 10s）。
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
    const timer = setTimeout(() => reject(new Error(`启动超时：${script}\n${buffer}`)), 20_000);
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
  readonly child: ChildProcess;
}

async function startHost(modelPort: number): Promise<Host> {
  const runDir = mkdtempSync(join(tmpdir(), 's6-enc-run-'));
  tempDirs.push(runDir);
  const hostPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(hostPort),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_RUNTIME_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    ANTHROPIC_AUTH_TOKEN: 's6-fixture-token-not-a-real-secret',
    ANTHROPIC_MODEL: 's6-fixture-model',
  };
  delete env['ANTHROPIC_API_KEY'];
  // 注意：就绪正则必须带捕获组，`startChild` 用 `match[1]` 取端口。
  const { child } = await startChild(HOST_MAIN, [], env, /绑定：127\.0\.0\.1:(\d+)/);
  const host: Host = { baseUrl: `http://127.0.0.1:${hostPort}`, runDir, child };
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

function ledgerLineCount(runDir: string): number {
  const path = join(runDir, 'model-ledger.jsonl');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
}

async function fakeModelRequests(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/__stats`);
  const body = (await response.json()) as { requests: number };
  return body.requests;
}

async function post(
  host: Host,
  requestId: string,
  instruction: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${host.baseUrl}/api/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, instruction }),
    signal: AbortSignal.timeout(10_000),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** 拒绝时必须是 `DemoError` 形状（code 稳定 / message 中文 / retryable 布尔）。 */
function expectDemoError(body: Record<string, unknown>, expectedCode: string): void {
  const error = (body['error'] ?? body) as Record<string, unknown>;
  expect(typeof error['code'], `必须是 DemoError 形状，实得 ${JSON.stringify(body)}`).toBe('string');
  expect(error['code']).toBe(expectedCode);
  expect(typeof error['message'], 'message 必须是字符串').toBe('string');
  expect(/[一-龥]/.test(String(error['message'])), 'message 必须是中文说明').toBe(true);
  expect(typeof error['retryable'], 'retryable 必须是布尔').toBe('boolean');
  expect(error['retryable'], '这类输入问题不可重试').toBe(false);
}

/** 用码点构造样本，避免把裸控制字符直接写进源码文件（免得被编辑器吃掉）。 */
const CTRL = {
  /** C0 BEL（不属于允许的 \t \n \r）。 */
  c0Bel: String.fromCodePoint(0x0007),
  /** DEL。 */
  del: String.fromCodePoint(0x007f),
  /** C1 NEL。 */
  c1Nel: String.fromCodePoint(0x0085),
  /** 唯一允许的空白控制字符，必须放行。 */
  tab: String.fromCodePoint(0x0009),
  newline: String.fromCodePoint(0x000a),
  carriageReturn: String.fromCodePoint(0x000d),
  /** U+FFFD 替换字符（乱码的指纹）。 */
  replacement: String.fromCodePoint(0xfffd),
};

describe('输入编码体检（夹具，零额度）', () => {
  it('[前置] 编译后的真实宿主存在', () => {
    expect(
      existsSync(HOST_MAIN),
      '[未满足] 找不到编译后的宿主；请先 node node_modules/typescript/bin/tsc -p tsconfig.demo.json',
    ).toBe(true);
  });

  it('含 U+FFFD ⇒ instruction_encoding_broken、HTTP 400、零额度、零模型调用', async () => {
    const model = await startChild(FAKE_MODEL, ['0', 'ok']);
    const host = await startHost(model.port);
    const before = ledgerLineCount(host.runDir);

    const result = await post(host, 's6-enc-fffd', `为新生读书会${CTRL.replacement}写一封邀请函`);
    expect(result.status, '必须在 HTTP 层就拒绝').toBe(400);
    expectDemoError(result.body, 'instruction_encoding_broken');

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(ledgerLineCount(host.runDir), '被拒的请求不得扣额度').toBe(before);
    expect(await fakeModelRequests(model.port), '必须在调用模型之前就拒绝').toBe(0);
    killHard(host.child);
    killHard(model.child);
  }, 60_000);

  it('含裸控制字符（C0 / DEL / C1）⇒ instruction_control_characters、HTTP 400、零额度', async () => {
    const model = await startChild(FAKE_MODEL, ['0', 'ok']);
    const host = await startHost(model.port);
    const before = ledgerLineCount(host.runDir);

    const samples: { readonly label: string; readonly text: string }[] = [
      { label: 'C0-BEL', text: `为读书会写一封邀请函${CTRL.c0Bel}请尽快` },
      { label: 'DEL', text: `为读书会写一封邀请函${CTRL.del}请尽快` },
      { label: 'C1-NEL', text: `为读书会写一封邀请函${CTRL.c1Nel}请尽快` },
    ];
    // 自证样本真的带上了目标字符，否则这三条会静默空过。
    const hasBareControl = (text: string): boolean =>
      [...text].some((ch) => {
        const cp = ch.codePointAt(0) ?? 0;
        return (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f);
      });
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(hasBareControl(sample.text), `${sample.label} 样本没带上裸控制字符`).toBe(true);
    }

    for (const sample of samples) {
      const result = await post(host, `s6-enc-ctrl-${sample.label}`, sample.text);
      expect(result.status, `${sample.label} 必须在 HTTP 层拒绝`).toBe(400);
      expectDemoError(result.body, 'instruction_control_characters');
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(ledgerLineCount(host.runDir), '被拒的请求不得扣额度').toBe(before);
    expect(await fakeModelRequests(model.port), '必须在调用模型之前就拒绝').toBe(0);
    killHard(host.child);
    killHard(model.child);
  }, 60_000);

  it('**正向对照：正常中文 / 日文 / emoji / 制表符 / 换行必须放行**（过度拦截比漏拦更糟）', async () => {
    const model = await startChild(FAKE_MODEL, ['0', 'ok']);
    const host = await startHost(model.port);

    const instruction =
      `为新生读书会写一封温暖的邀请函（日本語もOK）。${CTRL.newline}` +
      `第二行${CTRL.tab}带制表符与回车${CTRL.carriageReturn}。${CTRL.newline}` +
      '愿你有 📚 与 ☕。';
    const accepted = await post(host, `s6-enc-ok-${Date.now()}`, instruction);
    expect(
      accepted.status,
      `正常多语言输入被拒了：HTTP ${accepted.status} ${JSON.stringify(accepted.body)}`,
    ).toBe(202);

    const taskId = String(accepted.body['taskId']);
    let task: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(`${host.baseUrl}/api/tasks/${encodeURIComponent(taskId)}`);
      task = (await response.json()) as Record<string, unknown>;
      if (['ready', 'failed'].includes(String(task['status']))) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    expect(task['status'], `正常输入应当跑到成功，实得 ${JSON.stringify(task['error'])}`).toBe('ready');

    // 原文保存：**除了 CR→LF 这一处归一化以外，逐字符保留**（emoji / 制表符 / 换行不得被吞）。
    // 这个归一化是我实测到的行为（见报告 N10），不是我先假定再放宽：下面的断言会**钉死**
    // "只有 CR 被归一化、其余逐字不变"，若宿主改成吞掉 emoji 或改写内容，这里会立刻变红。
    const index = JSON.parse(readFileSync(join(host.runDir, 'app-index.json'), 'utf8')) as {
      tasks?: readonly { taskId?: string; instruction?: string }[];
    };
    const record = (index.tasks ?? []).find((item) => item.taskId === taskId);
    const stored = String(record?.instruction ?? '');
    const expectedWithCrNormalized = instruction.replace(/\r\n?/g, '\n');
    expect(stored, '原文保存后除 CR→LF 外必须逐字符一致').toBe(expectedWithCrNormalized);
    expect(/\r/.test(stored), 'CR 已被宿主归一化（如实登记为 N10）').toBe(false);
    // 关键字符逐个到场，防止"整体被清洗"也算过。
    for (const piece of ['📚', '☕', '\t', '\n', '（日本語もOK）', '为新生读书会写一封温暖的邀请函']) {
      expect(stored.includes(piece), `原文丢了片段：${JSON.stringify(piece)}`).toBe(true);
    }

    killHard(host.child);
    killHard(model.child);
  }, 60_000);
});
