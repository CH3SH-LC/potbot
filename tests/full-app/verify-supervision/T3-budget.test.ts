/**
 * FA-VERIFY-SUPERVISION · T3 —— 复核监督第 3 组「新八维预算流水」。
 *
 * ## 本文件的**两段历史**
 *
 * - **第一段（候选 `5aef3a6`）**：本包复算出监督两条判断**都成立** ——
 *   `charges` 的数字逐字来自请求体；不带 `key` 就不写 journal ⇒ 重启后额度**回升**。
 * - **第二段（候选 `5935008`，合入 main 的 `7479fab "fix(app-server): 预算计费量由服务端确定
 *   + 无 key 也落盘（跨进程重启不回升）"` 之后）**：两条都修掉。**断言改写为核对修复后的行为**。
 *
 * 【新契约】`/tool-call` 的 `charges` 数字与 `key` **都不进台账**：维度按"声明了哪几维"，
 * 数量按服务端策略（`serverDeterminedCharges`：每维 1 笔；`tokens` 按服务端**实测**的请求体字节折算，
 * 策略常数 `bytes_per_token`）；身份由 `admit()` 服务端生成并**无条件落盘**。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { PRODUCT_BUDGET_ENV_KEYS, createProductBudget } from '../../../apps/demo/server/budget-wiring.js';
import { createDemoServer } from '../../../apps/demo/server/main.js';
import { BUDGET_DIMENSIONS } from '../../../src/scheduler/budgets.js';
import { getJson, listen, postJson, type Json, type Running } from './http-util.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-vsv-t3-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

function budgetEnv(overrides: Partial<Record<(typeof BUDGET_DIMENSIONS)[number], number>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    env[PRODUCT_BUDGET_ENV_KEYS[dimension]] = String(overrides[dimension] ?? 100);
  }
  return env;
}

async function startProduct(runDir: string, env: NodeJS.ProcessEnv): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir, ...env });
  return listen(demo.server);
}

function describeOf(status: Json): string {
  return String((status['budget'] as Json | undefined)?.['describe'] ?? '');
}

// ===========================================================================
// 前半：真 HTTP —— 计费量由服务端确定；身份由服务端确定且一律落盘
// ===========================================================================

describe('T3-A /tool-call：计费量与持久身份都由**服务端**确定（真 HTTP + 换端点读回）', () => {
  it('① 请求体里声明的数字**进不了台账**：5 与 999999 记的都是服务端策略的 1', async () => {
    const runDir = join(RUN_ROOT, 'http-server-charges');
    const run = await startProduct(runDir, budgetEnv({ model_calls: 100 }));
    try {
      const first = await postJson(run.base, '/api/session-adapters/tool-call', {
        charges: { model_calls: 5 },
      });
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      // 声明值被如实回显（可读性），但**入账值**是服务端算的。
      expect((first.json['declared_charges'] as Json)['model_calls']).toBe(5);
      expect((first.json['charged_charges'] as Json)['model_calls']).toBe(1);
      expect(first.json['charges_source']).toBe('server');

      const second = await postJson(run.base, '/api/session-adapters/tool-call', {
        charges: { model_calls: 999_999 },
      });
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      expect((second.json['charged_charges'] as Json)['model_calls']).toBe(1);

      const status = await getJson(run.base, '/api/session-adapters/status');
      expect(describeOf(status.json)).toContain('模型调用 2/100'); // 两次调用各记 1，与声明的 5 / 999999 无关
    } finally {
      await run.close();
    }
  }, 60000);

  it('② 自报 `tokens:0.0001` 无效：入账 token 是服务端按**实测字节**算出的整数', async () => {
    const runDir = join(RUN_ROOT, 'http-token-policy');
    const run = await startProduct(runDir, budgetEnv({ tokens: 1000 }));
    try {
      const res = await postJson(run.base, '/api/session-adapters/tool-call', {
        charges: { tokens: 0.0001 },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const charged = Number((res.json['charged_charges'] as Json)['tokens']);
      expect(Number.isInteger(charged)).toBe(true);
      expect(charged).toBeGreaterThan(0);
      expect(charged).not.toBe(0.0001);
      expect(describeOf({ budget: { describe: res.json['describe'] } })).toContain(`token 用量 ${String(charged)}/1000`);
    } finally {
      await run.close();
    }
  }, 60000);

  it('③ 闸门本身仍有效：超限整笔拒 429 budget_exhausted', async () => {
    const runDir = join(RUN_ROOT, 'http-over');
    const run = await startProduct(runDir, budgetEnv({ model_calls: 1 }));
    try {
      const first = await postJson(run.base, '/api/session-adapters/tool-call', { charges: { model_calls: 1 } });
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      const second = await postJson(run.base, '/api/session-adapters/tool-call', { charges: { model_calls: 1 } });
      expect(second.status, JSON.stringify(second.json)).toBe(429);
      expect(second.json['code']).toBe('budget_exhausted');
    } finally {
      await run.close();
    }
  }, 60000);

  it('④ 【原反例】不带 key 也**照样落盘**，且重启后额度**不回升**', async () => {
    const runDir = join(RUN_ROOT, 'http-no-key');
    const env = budgetEnv({ model_calls: 100 });

    const run1 = await startProduct(runDir, env);
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await postJson(run1.base, '/api/session-adapters/tool-call', { charges: { model_calls: 1 } });
        expect(res.status, JSON.stringify(res.json)).toBe(200);
        expect(res.json['identity_source']).toBe('server');
      }
      // 修复前：请求体不带 `key` ⇒ 流水**一字不写**（本断言当时为 `''`）。
      const journal = join(runDir, 'budget-journal.jsonl');
      expect(existsSync(journal), `流水不存在：${journal}`).toBe(true);
      expect(readFileSync(journal, 'utf8').trim().length).toBeGreaterThan(0);
    } finally {
      await run1.close();
    }

    // **重启**（同一 runDir 的全新服务实例）：用量从流水收敛回来 ⇒ 不回升。
    const run2 = await startProduct(runDir, env);
    try {
      const status = await getJson(run2.base, '/api/session-adapters/status');
      expect(describeOf(status.json)).toContain('模型调用 2/100');
    } finally {
      await run2.close();
    }
  }, 60000);
});

// ===========================================================================
// 后半：产品类级"重启收敛" —— 无 key 也落盘
// ===========================================================================

describe('T3-B ProductBudgetWiring：无 key 也落盘 ⇒ 新实例（重启）同样看得到用量', () => {
  it('【原反例】不带 key 的消耗：新实例用量**不为 0**（额度不再回升）', () => {
    const runDir = join(RUN_ROOT, 'wiring-no-key');
    const config = {
      model_calls: 100,
      task_calls: 10,
      tool_calls: 10,
      tokens: 10,
      cost_micros: 10,
      concurrency: 10,
      retries: 10,
      time: 10,
    };
    const w1 = createProductBudget({ config, runDir });
    const admitted = w1.admit({ charges: { model_calls: 4 } }); // 故意不给 key
    expect(admitted.allowed).toBe(true);
    expect(w1.ledger.used('model_calls')).toBe(4);

    const journal = join(runDir, 'budget-journal.jsonl');
    expect(existsSync(journal)).toBe(true);
    expect(readFileSync(journal, 'utf8').trim().length).toBeGreaterThan(0);

    // 重启：新实例从流水收敛 ⇒ 用量**保持 4**（修复前这里是 0）。
    const w2 = createProductBudget({ config, runDir });
    expect(w2.ledger.used('model_calls')).toBe(4);
    expect(w2.restoreReport.lowered).toBe(false);
  }, 30000);

  it('带 key 时仍按 key 幂等：同 key 重放不重复计入', () => {
    const runDir = join(RUN_ROOT, 'wiring-key');
    const config = {
      model_calls: 100,
      task_calls: 10,
      tool_calls: 10,
      tokens: 10,
      cost_micros: 10,
      concurrency: 10,
      retries: 10,
      time: 10,
    };
    const w1 = createProductBudget({ config, runDir });
    expect(w1.admit({ charges: { model_calls: 3 }, key: 'charge-K1' }).allowed).toBe(true);
    expect(w1.ledger.used('model_calls')).toBe(3);

    const w2 = createProductBudget({ config, runDir });
    expect(w2.ledger.used('model_calls')).toBe(3);
    expect(w2.admit({ charges: { model_calls: 3 }, key: 'charge-K1' }).allowed).toBe(true);

    const w3 = createProductBudget({ config, runDir });
    expect(w3.ledger.used('model_calls')).toBe(3); // 同 key 去重 ⇒ 仍 3
  }, 30000);
});
