/**
 * S6 验收用例 ⑤：**活服务验证器 verify-demo.mjs 的判别力自证**。
 *
 * 一个只会"报红"的仪器和只会"报绿"的仪器一样没用。这里用两个**假服务**给它做
 * 双向对照：
 *   - `fake-bad-service.mjs`（阴）：拿旧文件顶包、正文与 draft 不符、去重失效 ⇒ **必须报红**；
 *   - `fake-good-service.mjs`（阳）：判据真的满足 ⇒ **必须全绿**。
 *
 * 两个假服务都**不调用真实模型**，只用于校验仪器；不得用来代替 live 验收。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './support.js';

const VERIFY_DEMO = join(REPO_ROOT, 'scripts', 'demo', 'verify-demo.mjs');
const BAD_SERVICE = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-bad-service.mjs');
const GOOD_SERVICE = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-good-service.mjs');

const children: ChildProcess[] = [];

/** 启动假服务：传 port=0 让系统分配，从 stdout 解析**实际**端口（避免端口冲突）。 */
function startFakeService(script: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const timer = setTimeout(() => reject(new Error(`假服务启动超时：${script}`)), 15_000);
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /listening on (\d+)/.exec(buffer);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`假服务提前退出 code=${code}：${buffer}`));
    });
  });
}

function runVerifier(port: number, tag: string): { status: number | null; stdout: string } {
  const result = spawnSync(
    process.execPath,
    [VERIFY_DEMO, `--base=http://127.0.0.1:${port}`, `--tag=${tag}`, '--timeout=20000'],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return { status: result.status, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * 清理：Windows 上 `child.kill()` 偶发不生效（实测残留过假服务进程），补 `taskkill` 兜底；
 * 并显式放宽 hook 超时（逐个 taskkill 会超过默认 10s）。
 */
/**
 * **收尾清理的等价瘦身（只为耗时，不为判据）**：原先对每个子进程各调一次 `killHard`，
 * 也就是每个进程单开一次 `taskkill`（Windows 上单次实测 ≈0.9 s，且**与 `/PID` 个数无关**）。
 * `taskkill` 支持多个 `/PID`，此处合并成一次进程调用——杀死的进程集合、每个进程走的
 * `child.kill()` + `/F /T` 兜底、以及"已退出则跳过"的判据完全不变。
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
}, 120_000);

describe('verify-demo.mjs 的判别力（阴阳对照臂）', () => {
  it('对做坏的假服务：必须报红，且点名抓到"旧文件顶包 / 正文不符 / 去重失效"', async () => {
    const port = await startFakeService(BAD_SERVICE);
    const { status, stdout } = runVerifier(port, 's6-selftest-bad');

    expect(status, `验证器对坏服务返回了 ${status}（不得为 0）\n${stdout}`).not.toBe(0);
    expect(stdout, '应抓到"未知产物返回 200 顶包"').toContain('unknown_artifact_404');
    expect(stdout, '应抓到"下载正文与 draft 不符"').toContain('docx_paragraphs_equal_draft');
    expect(stdout, '应抓到"同 requestId 返回了不同 taskId"').toContain('duplicate_same_task');
    expect(stdout, '应抓到"声明摘要与实际字节不符"').toContain('download_sha256');
  }, 120_000);

  it('对满足判据的假服务：必须全绿（防止"恒报红"的空仪器）', async () => {
    const port = await startFakeService(GOOD_SERVICE);
    const { status, stdout } = runVerifier(port, 's6-selftest-good');

    const failedLines = stdout.split('\n').filter((line) => line.includes('[FAIL]'));
    expect(status, `验证器对好服务返回 ${status}，未通过项：\n${failedLines.join('\n')}`).toBe(0);
    expect(stdout).toContain('[PASS] docx_paragraphs_equal_draft');
    expect(stdout).toContain('[PASS] docx_no_system_appendices');
    expect(stdout).toContain('[PASS] draft_internal_provenance_retained');
    expect(stdout).toContain('[PASS] download_sha256');
    expect(stdout).toContain('[PASS] duplicate_same_task');
    // `duplicate_no_extra_model_call` 的**前提**是"能发现模型账本"——账本由 live 宿主写进
    // `.runtime/mobile-word-demo`（该目录 gitignore、随环境有无）。阳性臂夹具是**纯假服务**：
    // 它不调用模型、也不产生任何账本，所以这条判据在自检环境里**无证据可判**，仪器只能
    // 如实记为"未验证"（备注），既不 PASS 也不 FAIL。原先无条件要求它出现
    // `[PASS] duplicate_no_extra_model_call` 属**判据过时**：只有在环境里恰好残留 live 账本
    // 时该检查才会执行，纯假服务下必然不出现（实测：`未能发现模型账本文件`）。
    // 按新事实，正确口径是两个**诚实**结局之一：
    //   - 有账本 ⇒ 判据执行并通过（[PASS] duplicate_no_extra_model_call）；
    //   - 无账本 ⇒ 明确记为"未能发现模型账本文件"（未验证）。
    // 两者都不出现 ⇒ 仪器静默丢弃了这条判据，必须报红。
    const modelCallVerified = stdout.includes('[PASS] duplicate_no_extra_model_call');
    const modelCallUnverified = stdout.includes('未能发现模型账本文件');
    expect(
      modelCallVerified || modelCallUnverified,
      `"重复提交未二次调用模型"判据既未执行通过、也未如实记为未验证（判据被静默丢弃？）：\n${failedLines.join('\n') || stdout}`,
    ).toBe(true);
  }, 120_000);
});
