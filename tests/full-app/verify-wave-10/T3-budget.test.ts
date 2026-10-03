/**
 * FA-VERIFY-WAVE-10 · 第 3 项 —— **预算**（`7479fab`）独立复核。
 *
 * 三条判据（任务原文）：
 *   a) 客户端自报的 `charges` **不得**进台账（记账量由服务端确定）；
 *   b) **无 key 也必须落盘**（不是"没给 key 就不记流水"）；
 *   c) 跨进程重启**额度不回升**（两个真 `node` 进程，同一运行目录）。
 *
 * (a)(b) 走产品入口真 HTTP；(c) 用独立进程探针 `budget-restart-probe.mjs`。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import { listen, postJson, getJson, type Json, type Running } from './http.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w10-t3-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 八维上限全给（缺一维 ⇒ 预算"未装配"，那是另一条边界）。 */
function budgetEnv(runDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    POTBOT_RUN_DIR: runDir,
    POTBOT_BUDGET_TASK_CALLS: '10',
    POTBOT_BUDGET_MODEL_CALLS: '10',
    POTBOT_BUDGET_TOOL_CALLS: '10',
    POTBOT_BUDGET_TOKENS: '100000',
    POTBOT_BUDGET_COST_MICROS: '100000',
    POTBOT_BUDGET_CONCURRENCY: '4',
    POTBOT_BUDGET_RETRIES: '10',
    POTBOT_BUDGET_TIME: '100000',
    ...overrides,
  };
}

async function startProduct(name: string, overrides: Record<string, string> = {}): Promise<Running> {
  const demo = await createDemoServer(budgetEnv(join(RUN_ROOT, name), overrides));
  return listen(demo.server);
}

describe('W10-T3 · (a) 客户端自报的 charges 不进台账', () => {
  it('声明 charges:{task_calls:999}（上限 3）⇒ 3 次放行、第 4 次 429（按服务端的 1 记，不按 999）', async () => {
    const run = await startProduct('charges-ignored', { POTBOT_BUDGET_TASK_CALLS: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const call = await postJson(run.base, '/api/session-adapters/tool-call', {
          charges: { task_calls: 999 },
        });
        statuses.push(call.status);
      }
      // 若客户端自报的 999 进了台账，第一次就会因超限被拒（3 < 999）。修复后的实际：三次放行、第四次耗尽。
      expect(statuses).toEqual([200, 200, 200, 429]);
    } finally {
      await run.close();
    }
  }, 60000);

  it('客户端送 charges:{tokens:0.0001} ⇒ 台账记的是服务端算出的整数 token，不是 0.0001', async () => {
    const run = await startProduct('tokens-ignored');
    try {
      const call = await postJson(run.base, '/api/session-adapters/tool-call', {
        charges: { tokens: 0.0001 },
      });
      expect(call.status, JSON.stringify(call.json)).toBe(200);
      const charged = call.json['charged_charges'] as Json;
      expect(charged['tokens']).not.toBe(0.0001);
      expect(Number.isInteger(charged['tokens'])).toBe(true);
      expect(Number(charged['tokens'])).toBeGreaterThan(0);
      expect(call.json['charges_source']).toBe('server');
      // 声明量如实回显（供核对），但不是台账量。
      expect((call.json['declared_charges'] as Json)['tokens']).toBe(0.0001);
    } finally {
      await run.close();
    }
  }, 60000);
});

describe('W10-T3 · (b) 无 key 也必须落盘；客户端 key 不透传', () => {
  it('不带 key 的调用 ⇒ 流水文件里有行（不是"没 key 就不记"）', async () => {
    const runDir = join(RUN_ROOT, 'no-key-persist');
    const demo = await createDemoServer(budgetEnv(runDir));
    const run = await listen(demo.server);
    try {
      const before = existsSync(join(runDir, 'budget-journal.jsonl'))
        ? readFileSync(join(runDir, 'budget-journal.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').length
        : 0;
      const call = await postJson(run.base, '/api/session-adapters/tool-call', { charges: { task_calls: 1 } });
      expect(call.status, JSON.stringify(call.json)).toBe(200);
      expect(call.json['identity_source']).toBe('server');

      const journal = readFileSync(join(runDir, 'budget-journal.jsonl'), 'utf8');
      const lines = journal.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length).toBeGreaterThan(before);
    } finally {
      await run.close();
    }
  }, 60000);

  it('客户端送 key ⇒ 被忽略（client_key_ignored=true），流水里不出现该 key', async () => {
    const runDir = join(RUN_ROOT, 'client-key-ignored');
    const demo = await createDemoServer(budgetEnv(runDir));
    const run = await listen(demo.server);
    try {
      const call = await postJson(run.base, '/api/session-adapters/tool-call', {
        charges: { task_calls: 1 },
        key: 'client-controlled-key-ABC',
      });
      expect(call.status, JSON.stringify(call.json)).toBe(200);
      expect(call.json['client_key_ignored']).toBe(true);
      const journal = readFileSync(join(runDir, 'budget-journal.jsonl'), 'utf8');
      expect(journal).toContain('task_calls');
      expect(journal).not.toContain('client-controlled-key-ABC');
    } finally {
      await run.close();
    }
  }, 60000);

  it('八维上限未给全 ⇒ /tool-call 结构化 503（不退化成"不设限"）', async () => {
    const run = await startProduct('unwired', {
      POTBOT_BUDGET_TASK_CALLS: '',
      POTBOT_BUDGET_TOKENS: '',
    });
    try {
      const call = await postJson(run.base, '/api/session-adapters/tool-call', { charges: { task_calls: 1 } });
      expect(call.status).toBe(503);
      expect(call.json['code']).toBe('budget_not_configured');
      const status = await getJson(run.base, '/api/session-adapters/status');
      expect(status.json['budget']['configured']).toBe(false);
    } finally {
      await run.close();
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// (c) 跨进程重启额度不回升
// ---------------------------------------------------------------------------

interface BudgetProbe {
  readonly mode: string;
  readonly pid: number;
  readonly used_task_calls: number;
  readonly journalLines: number;
  readonly admitted?: boolean;
  readonly charged_task_calls?: number | null;
  readonly restore_lowered?: boolean;
  readonly fresh_probe_allowed?: boolean;
  readonly used_before_probe?: number;
}

function runBudgetProbe(args: readonly string[]): BudgetProbe {
  const loader = pathToFileURL(join(HERE, 'node-ts-loader.mjs')).href;
  const probe = join(HERE, 'budget-restart-probe.mjs');
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--experimental-loader', loader, probe, ...args],
    { encoding: 'utf8', cwd: HERE, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`探针失败 status=${String(result.status)}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const lines = String(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new Error(`探针没有输出 JSON\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return JSON.parse(last) as BudgetProbe;
}

describe('W10-T3 · (c) 跨进程重启额度不回升', () => {
  it('进程 A 无 key 放行 3 笔 → 进程 B（新 PID）读到 used=3，再申请 8 笔被拒', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'w10-budget-xproc-'));
    try {
      const admitted = runBudgetProbe(['admit', runDir]);
      expect(admitted.admitted).toBe(true);
      expect(admitted.used_task_calls).toBe(3);
      expect(admitted.journalLines).toBeGreaterThan(0);

      const inspected = runBudgetProbe(['inspect', runDir]);
      // **两个不同的 PID** 才叫跨进程。
      expect(inspected.pid).not.toBe(admitted.pid);
      // 额度不回升：新进程在**任何探针申请之前**读回的已用量是 3（不是 0）。
      expect(inspected.used_before_probe).toBe(3);
      // 反向对照：3 + 8 = 11 > 上限 10 ⇒ 新进程里申请 8 笔必须被拒（证明恢复回来的用量真的参与判定）。
      expect(inspected.fresh_probe_allowed).toBe(false);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 60000);

  it('反向对照：独立运行目录 ⇒ 新进程 used=0（额度不跨目录收敛）', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'w10-budget-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'w10-budget-b-'));
    try {
      const admitted = runBudgetProbe(['admit', dirA]);
      expect(admitted.used_task_calls).toBe(3);
      const fresh = runBudgetProbe(['inspect', dirB]);
      expect(fresh.used_before_probe).toBe(0);
      // 全新额度下 8 笔放行（证明上面 dirA 的拒绝确实是"带过来的用量"造成的）。
      expect(fresh.fresh_probe_allowed).toBe(true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  }, 60000);
});
