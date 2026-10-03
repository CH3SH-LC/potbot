/**
 * FA-KRN-BUDGET-PRODUCT：把预算硬限制接进产品运行链路。
 *
 * ## 这个文件要钉死的判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 八维上限缺任一项 ⇒ 抛，且探测器点名缺的是哪一维（八维逐个） | **反例** |
 * | 2 | 判别力：未设上限的闸门**确实会放过**超额 ⇒ "缺项必须抛"不是形式主义 | **反向对照** |
 * | 3 | 完整配置 ⇒ 八维 `limitOf` 全非 null；非法值（负 / 非整 / NaN）⇒ 抛 | 正例 |
 * | 4 | 从 `POTBOT_BUDGET_*` 环境变量装配；缺键 / 非数字 ⇒ 抛 | 正例 + **反例** |
 * | 5 | 事前闸门：超限**整笔拒、一条都不扣**；同一形状在更大上限下放行 | **反例** + **对照** |
 * | 6 | 并发是占用式：达上限即拒，释放后名额回来 | **反例** + **对照** |
 * | 7 | 落盘流水为 JSONL；**重启后收敛且只上不下**，闸门继续拒 | 正例 |
 * | 8 | 换独立运行目录 ⇒ 额度归零、闸门放行；`detectForeignQuota` 判 false | **反向对照** |
 * | 9 | 判别力：模拟"换目录仍读旧流水"⇒ `detectForeignQuota` 判 true | **反向对照** |
 * | 10 | 脱敏：追踪不含注入的敏感 label；`detectRawLeak` 判空 | **反例** |
 * | 11 | 判别力：未脱敏的伪造追踪 ⇒ `detectRawLeak` 点名泄露原文 | **反向对照** |
 * | 12 | 部分结果：耗尽 ⇒ 部分 + 未产出项 + 原因，`complete_claimed === false` | **反例** |
 * | 13 | 对照：未耗尽 ⇒ 非部分，且 `complete_claimed` 仍恒 `false` | **对照** |
 * | 14 | 结构：接线层**没有**重置 / 清零 / 调大上限的入口 | **反例** |
 *
 * ## 诚实边界（本文件**不**据此宣称的结论）
 *
 * 第 7–9 条是**同进程模拟**：一个"重启后的新实例"或"指向旧流水的实例"读同一份落盘 JSONL。
 * **两个真实进程并发追加的实测未做**——JSONL 追加的跨进程原子性**未验证**。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError, asLogicalTime } from '../../../src/protocol/index.js';
import {
  BUDGET_DIMENSIONS,
  HardBudgetLedger,
  restoreBudgetFromJournal,
  type BudgetDimension,
  type ModelTurnInput,
  type ModelTurnOutput,
  type ModelTurnPort,
  type RedactedCharge,
  type ToolCallRequest,
  type ToolExecutorPort,
  type ToolReceipt,
} from '../../../src/scheduler/index.js';
import {
  BudgetGateRefusal,
  budgetLimitsFromEnv,
  createProductBudget,
  createProductBudgetGate,
  createRunDirBudgetJournal,
  detectForeignQuota,
  detectRawLeak,
  detectUnboundedDimensions,
  DEFAULT_SERVER_CHARGE_POLICY,
  serverDeterminedCharges,
  gateModelTurnPort,
  gateToolExecutor,
  gateToolLoopHost,
  resolveProductBudgetLimits,
  PRODUCT_BUDGET_ENV_KEYS,
  type ProductBudgetConfig,
  type ProductBudgetWiring,
} from './budget-wiring.js';
import { createDocumentToolCatalog, createToolLoopHost } from './tool-loop-product.js';
import { createSessionAdaptersWiring } from './session-adapters-wiring.js';

const SECRET = 'sk-live-BUDGET-SECRET-abcdef0123456789';
const USER_TEXT = '用户说：我的护照号是 E12345678';

/** 完整八维配置（每条用例都从它复制，避免互相污染）。 */
function fullConfig(): ProductBudgetConfig {
  return {
    task_calls: 5,
    model_calls: 5,
    tool_calls: 5,
    tokens: 100,
    cost_micros: 1_000_000,
    concurrency: 2,
    retries: 3,
    time: 1_000,
  };
}

let workDir: string;
let otherDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-budget-product-'));
  otherDir = mkdtempSync(join(tmpdir(), 'potbot-budget-other-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 / 2 / 3：八维上限的装配
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 八维上限装配：缺项即抛', () => {
  it('反例：八个维度**逐个**缺失都会被抛出，且探测器点名缺的是哪一维', () => {
    const full = fullConfig();
    for (const dimension of BUDGET_DIMENSIONS) {
      const raw: Partial<Record<BudgetDimension, number>> = { ...full };
      delete raw[dimension];
      expect(detectUnboundedDimensions(raw)).toEqual([dimension]);
      expect(() => resolveProductBudgetLimits(raw)).toThrow(ValidationError);
    }
    // 完整配置 ⇒ 探测器空（不是"一律报警"）。
    expect(detectUnboundedDimensions(full)).toEqual([]);
  });

  it('反例（判别力）：未设上限的闸门**确实会放过**超额 —— 缺项必须抛不是形式主义', () => {
    // 只配了 model_calls 的台账：token 无限 ⇒ 申请一百万也放行。这正是"漏配 = 无限额度"的形状。
    const unbounded = new HardBudgetLedger({ model_calls: 1 });
    expect(unbounded.reserve({ charges: { tokens: 5_000_000 } }).allowed).toBe(true);

    // 产品配置层对同一份配置直接拒：缺 token 上限 ⇒ 抛。
    const leaked: Partial<Record<BudgetDimension, number>> = { ...fullConfig() };
    delete leaked.tokens;
    expect(detectUnboundedDimensions(leaked)).toEqual(['tokens']);
    expect(() => resolveProductBudgetLimits(leaked)).toThrow(/没有上限|token/i);
  });

  it('正例：完整配置 ⇒ 八维上限全部登记；非法值 ⇒ 抛', () => {
    const limited = resolveProductBudgetLimits(fullConfig());
    for (const dimension of BUDGET_DIMENSIONS) {
      expect(limited[dimension]).toBe(fullConfig()[dimension]);
    }
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    for (const dimension of BUDGET_DIMENSIONS) {
      // 八维**一个都不许**是 null（产品层不允许"不设限"）。
      expect(product.ledger.limitOf(dimension)).not.toBeNull();
    }
    expect(() => resolveProductBudgetLimits({ ...fullConfig(), tokens: -1 })).toThrow(ValidationError);
    expect(() => resolveProductBudgetLimits({ ...fullConfig(), tokens: 1.5 })).toThrow(ValidationError);
    expect(() => resolveProductBudgetLimits({ ...fullConfig(), tokens: Number.NaN })).toThrow(ValidationError);
  });

  it('正例 + 反例：从 POTBOT_BUDGET_* 环境变量装配；缺键 / 非数字 ⇒ 抛', () => {
    const full = fullConfig();
    const env: NodeJS.ProcessEnv = {};
    for (const dimension of BUDGET_DIMENSIONS) {
      env[PRODUCT_BUDGET_ENV_KEYS[dimension]] = String(full[dimension]);
    }
    expect(budgetLimitsFromEnv(env)).toEqual(full);

    const missing: NodeJS.ProcessEnv = { ...env };
    delete missing[PRODUCT_BUDGET_ENV_KEYS.tokens];
    expect(() => budgetLimitsFromEnv(missing)).toThrow(ValidationError);

    expect(() => budgetLimitsFromEnv({ ...env, [PRODUCT_BUDGET_ENV_KEYS.tokens]: 'abc' })).toThrow(
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 5 / 6：事前闸门
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 事前闸门：整笔拒且一条都不扣', () => {
  it('反例 + 对照：会超限的申请整体被拒，已扣维度一个都不动', () => {
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    const first = product.admit({ charges: { tokens: 40, model_calls: 1 }, key: 'turn-1', at: asLogicalTime(1) });
    expect(first.allowed).toBe(true);
    expect(product.ledger.used('tokens')).toBe(40);
    expect(product.ledger.used('model_calls')).toBe(1);

    // tokens 会超（40 + 70 > 100）：整笔拒绝，model_calls **也不得**被扣。
    const refused = product.admit({
      charges: { model_calls: 1, tokens: 70 },
      key: 'turn-2',
      at: asLogicalTime(2),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('would_exceed_limit');
    expect(refused.would_exceed).toEqual(['tokens']);
    expect(product.ledger.used('model_calls')).toBe(1);
    expect(product.ledger.used('tokens')).toBe(40);

    // 对照：**同一形状**的申请在更大的 tokens 上限下放行 ⇒ 拒的是上限，不是申请形状。
    const generous = createProductBudget({ config: { ...fullConfig(), tokens: 1_000 }, runDir: otherDir });
    expect(generous.admit({ charges: { model_calls: 1, tokens: 70 } }).allowed).toBe(true);
  });

  it('反例 + 对照：并发是占用式 —— 达上限即拒，释放后名额回来', () => {
    const product = createProductBudget({ config: { ...fullConfig(), concurrency: 2 }, runDir: workDir });
    expect(product.acquire().acquired).toBe(true);
    expect(product.acquire().acquired).toBe(true);
    const third = product.acquire();
    expect(third.acquired).toBe(false);
    expect(third.reason).toBe('concurrency_limit_reached');
    // 占用式维度不得走累计记账。
    expect(product.admit({ charges: { concurrency: 1 } }).reason).toBe('occupancy_dimension_requires_acquire');
    expect(product.release()).toBe(1);
    expect(product.acquire().acquired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7：落盘流水 + 重启收敛（只上不下）
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 落盘流水：重启后收敛且只上不下', () => {
  it('正例：用量落 JSONL；重启后新实例收敛到应有用量，闸门继续拒', () => {
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    expect(product.medium()).toMatchObject({ kind: 'file', durable: true });

    product.admit({ charges: { tokens: 40, model_calls: 1, tool_calls: 2 }, key: 'turn-1', at: asLogicalTime(1) });
    product.admit({ charges: { tokens: 30 }, key: 'turn-2', at: asLogicalTime(2), label: USER_TEXT });

    // 流水确实是 JSONL：文件存在，每行都是可解析对象。
    expect(existsSync(product.journalPath)).toBe(true);
    const lines = readFileSync(product.journalPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // "重启"：同进程内的新实例读**同一份**落盘流水（真实跨进程未做，见文件头边界）。
    const restarted = createProductBudget({ config: fullConfig(), runDir: workDir });
    // before = 收敛**前**的用量：新实例这份台账此前是 0（这正是"白送额度"的形状）。
    expect(restarted.restoreReport.before['tokens']).toBe(0);
    expect(restarted.restoreReport.target['tokens']).toBe(70);
    expect(restarted.restoreReport.target['model_calls']).toBe(1);
    expect(restarted.restoreReport.target['tool_calls']).toBe(2);
    expect(restarted.restoreReport.charged['tokens']).toBe(70);
    // **只上不下**：从不回调账目。
    expect(restarted.restoreReport.lowered).toBe(false);
    expect(restarted.ledger.used('tokens')).toBe(70);

    // 闸门继续拒：70 + 31 > 100。
    const refused = restarted.admit({ charges: { tokens: 31 } });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('would_exceed_limit');
    expect(restarted.ledger.used('tokens')).toBe(70);
    // 70 + 30 = 100 仍可放行（收敛没有把额度"多扣"）。
    expect(restarted.admit({ charges: { tokens: 30 }, key: 'turn-3' }).allowed).toBe(true);

    // 幂等：同一份流水对**已对齐**的台账再收敛一次，增量为空（真幂等，不依赖进程内集合）。
    const again = restoreBudgetFromJournal(restarted.ledger, createRunDirBudgetJournal(workDir));
    expect(again.target['tokens']).toBe(100);
    expect(again.charged).toEqual({});
    expect(restarted.ledger.used('tokens')).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 8 / 9：换独立运行目录 ⇒ 额度归零（反向对照）
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 换运行目录 ⇒ 额度归零', () => {
  it('反向对照：独立运行目录读不到别处的额度，闸门放行本应被拒的消费', () => {
    const first = createProductBudget({ config: fullConfig(), runDir: workDir });
    first.admit({ charges: { tokens: 40, model_calls: 1 }, key: 'turn-1', at: asLogicalTime(1) });

    const fresh = createProductBudget({ config: fullConfig(), runDir: otherDir });
    expect(fresh.ledger.used('tokens')).toBe(0);
    expect(fresh.restoreReport.target['tokens']).toBeUndefined();

    // 探针只读判定：独立目录不是"带着别处额度"。
    const verdict = detectForeignQuota(fresh.ledger, { dimension: 'tokens', amount: 61 });
    expect(verdict.foreign_usage_detected).toBe(false);
    expect(verdict.before_usage).toBe(0);
    expect(verdict.fits_fresh_quota).toBe(true);

    // 对照：同样 61 在**旧目录**的重启实例上会被拒（40 + 61 > 100），在新目录放行。
    const restarted = createProductBudget({ config: fullConfig(), runDir: workDir });
    expect(restarted.admit({ charges: { tokens: 61 } }).allowed).toBe(false);
    expect(fresh.admit({ charges: { tokens: 61 }, key: 'fresh-1' }).allowed).toBe(true);
  });

  it('反向对照（判别力）：模拟"换目录仍读旧流水"⇒ detectForeignQuota 判 true', () => {
    const first = createProductBudget({ config: fullConfig(), runDir: workDir });
    first.admit({ charges: { tokens: 40, model_calls: 1 }, key: 'turn-1', at: asLogicalTime(1) });

    // 模拟接线 bug：新实例（新建的目录）**误指向**旧目录的流水。
    const buggyJournal = createRunDirBudgetJournal(workDir);
    const buggyLedger = new HardBudgetLedger(fullConfig(), { journal: buggyJournal });
    restoreBudgetFromJournal(buggyLedger, buggyJournal);

    const verdict = detectForeignQuota(buggyLedger, { dimension: 'tokens', amount: 61 });
    expect(verdict.foreign_usage_detected).toBe(true);
    expect(verdict.before_usage).toBe(40);
    expect(verdict.fits_fresh_quota).toBe(false);
    // 且闸门确实被旧额度挤掉（61 被拒）——这正是要检出的故障形状。
    expect(buggyLedger.reserve({ charges: { tokens: 61 } }).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10 / 11：脱敏追踪
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 脱敏追踪：绝不吐原文', () => {
  it('反例：注入的凭据 / 用户内容不出现在追踪与快照里', () => {
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    product.admit({
      charges: { tokens: 10, model_calls: 1 },
      key: 'turn-1',
      at: asLogicalTime(1),
      subject: SECRET,
      label: USER_TEXT,
    });
    product.admit({ charges: { retries: 1 }, key: 'retry-1', at: asLogicalTime(2), label: SECRET });

    const trace = product.trace();
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(USER_TEXT);
    expect(JSON.stringify(product.snapshot())).not.toContain(SECRET);

    // 只读探测器：干净 ⇒ 空。
    expect(detectRawLeak(trace, [SECRET, USER_TEXT])).toEqual([]);

    // 追踪里确实有东西（不是"空所以不泄露"）：摘要存在，且提示被收紧到极短。
    const withSubject = trace.filter((entry) => entry.subject !== null);
    expect(withSubject.length).toBeGreaterThan(0);
    for (const entry of withSubject) {
      expect(entry.subject?.digest.length).toBeGreaterThan(0);
      expect((entry.subject?.hint ?? '').length).toBeLessThanOrEqual(2);
    }
  });

  it('反向对照（判别力）：未脱敏的伪造追踪 ⇒ detectRawLeak 点名泄露原文', () => {
    const forged = [
      {
        index: 1,
        dimension: 'tokens',
        amount: 10,
        total: 10,
        at: asLogicalTime(1),
        subject: { digest: 'd', hint: '', length: SECRET.length, raw: SECRET },
        label: { digest: 'd', hint: '用户', length: USER_TEXT.length, raw: USER_TEXT },
      },
    ] as unknown as readonly RedactedCharge[];
    expect(detectRawLeak(forged, [SECRET, USER_TEXT])).toEqual([SECRET, USER_TEXT]);
  });
});

// ---------------------------------------------------------------------------
// 12 / 13：部分结果
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 部分结果：耗尽时如实列出未产出项', () => {
  it('反例：额度耗尽 ⇒ 部分结果 + 未产出项 + 原因，complete_claimed 字面量 false', () => {
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    expect(product.admit({ charges: { tokens: 100 }, key: 'burn', at: asLogicalTime(1) }).allowed).toBe(true);
    expect(product.ledger.exhausted('tokens')).toBe(true);

    const delivery = product.partialDelivery({
      ledger: product.ledger,
      planned_refs: ['a.docx', 'b.docx', 'c.docx'],
      delivered_refs: ['a.docx'],
    });
    expect(delivery.partial).toBe(true);
    expect(delivery.exhausted_dimensions).toContain('tokens');
    expect(delivery.delivered_refs).toEqual(['a.docx']);
    expect(delivery.withheld_refs).toEqual(['b.docx', 'c.docx']);
    expect(delivery.reasons['b.docx']).toMatch(/预算/);
    // 字面量 false：部分结果**不是**完整交付。
    expect(delivery.complete_claimed).toBe(false);
    expect(typeof delivery.complete_claimed).toBe('boolean');
  });

  it('对照：未耗尽 ⇒ 非部分，且 complete_claimed 仍恒 false', () => {
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    product.admit({ charges: { tokens: 10 }, key: 'light', at: asLogicalTime(1) });
    const delivery = product.partialDelivery({
      ledger: product.ledger,
      planned_refs: ['a.docx'],
      delivered_refs: ['a.docx'],
    });
    expect(delivery.partial).toBe(false);
    expect(delivery.withheld_refs).toEqual([]);
    expect(delivery.complete_claimed).toBe(false);
    expect(delivery.note).not.toContain('部分结果');
    expect(delivery.note).toContain('不含');
  });
});

// ---------------------------------------------------------------------------
// 14：结构上没有"清零 / 调大上限"的入口
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT 结构纪律：没有重置 / 调大上限的入口', () => {
  it('反例：接线层不暴露 reset / clear / 调大上限的任何方法', () => {
    const product = createProductBudget({ config: fullConfig(), runDir: workDir });
    const names = new Set<string>();
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(product) as object)) {
      names.add(key);
    }
    const forbidden = [...names].filter((name) => /reset|clear|raise|increase|widen|refill/i.test(name));
    expect(forbidden).toEqual([]);
    // 上限表是冻结的：改它不生效（严格模式下抛，宽松模式下静默丢弃但不改变台账）。
    const limits = product.ledger.limits;
    expect(Object.isFrozen(limits)).toBe(true);
    expect(product.ledger.limitOf('tokens')).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// N-7-10：真模型 / 真工具调用的事前闸门
// ---------------------------------------------------------------------------

describe('FA-KRN-BUDGET-PRODUCT（N-7-10）真调用事前闸门：耗尽 ⇒ 不发出', () => {
  /** 记录被调用次数的模型端口替身（**不联网**）。 */
  function spyModelPort(calls: { n: number }): ModelTurnPort {
    return {
      provider: 'spy',
      model: 'spy-model',
      real_executor: false,
      async nextTurn(_input: ModelTurnInput): Promise<ModelTurnOutput> {
        calls.n += 1;
        return { raw: JSON.stringify({ kind: 'answer', text: '（脚本化回答）' }) };
      },
    };
  }

  /** 记录被调用次数的工具执行器替身。 */
  function spyToolExecutor(calls: { n: number }): ToolExecutorPort {
    return {
      name: 'spy-tools',
      real_executor: false,
      async invoke(call: ToolCallRequest): Promise<ToolReceipt | null> {
        calls.n += 1;
        return { call_id: call.call_id, ok: true, content: '{"ok":true}' };
      },
    };
  }

  function capture(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  }

  it('反例：模型调用在发出前被拦住（耗尽 ⇒ 抛，底层端口一次都没被触到）', async () => {
    const wiring = createProductBudget({ config: { ...fullConfig(), model_calls: 1 }, runDir: workDir });
    const gate = createProductBudgetGate(wiring, null, { keyPrefix: 'unit' });
    const calls = { n: 0 };
    const gated = gateModelTurnPort(spyModelPort(calls), gate, { subject: 'unit' });

    await gated.nextTurn({ step: 1, instructions: 'x', observations: [], signal: null });
    expect(calls.n).toBe(1);

    let thrown: unknown = null;
    try {
      await gated.nextTurn({ step: 2, instructions: 'x', observations: [], signal: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BudgetGateRefusal);
    const refusal = thrown as BudgetGateRefusal;
    expect(refusal.code).toBe('budget_exhausted');
    expect(refusal.kind).toBe('model');
    expect(refusal.would_exceed).toContain('model_calls');
    // **没有发出**：底层端口只被调用过那一次（被放行的）。
    expect(calls.n).toBe(1);
    // 部分结果：`complete_claimed` 字面量 false，未产出项如实列出。
    expect(refusal.partial.partial).toBe(true);
    expect(refusal.partial.complete_claimed).toBe(false);
    expect(refusal.partial.withheld_refs).toEqual(['model-turn-step-2']);
  });

  it('反例：工具执行在运行前被拦住（耗尽 ⇒ 结构化回执，底层执行器零调用）', async () => {
    const wiring = createProductBudget({ config: { ...fullConfig(), tool_calls: 1 }, runDir: workDir });
    const gate = createProductBudgetGate(wiring, null, { keyPrefix: 'unit' });
    const calls = { n: 0 };
    const gated = gateToolExecutor(spyToolExecutor(calls), gate, { subject: 'unit' });

    const first = await gated.invoke({ call_id: 'c1', tool: 'write_document', arguments: {} }, null);
    expect(first?.ok).toBe(true);
    expect(calls.n).toBe(1);

    const second = await gated.invoke({ call_id: 'c2', tool: 'write_document', arguments: {} }, null);
    expect(second?.ok).toBe(false);
    expect(second?.error?.code).toBe('budget_exhausted');
    const content = JSON.parse(String(second?.content)) as Record<string, unknown>;
    expect(content['code']).toBe('budget_exhausted');
    expect((content['partial'] as Record<string, unknown>)['complete_claimed']).toBe(false);
    // **没有执行**：底层执行器只被调用过那一次。
    expect(calls.n).toBe(1);
  });

  it('正例：换服务实例、同运行目录 ⇒ 额度不回升；换独立目录 ⇒ 从零开始（反向对照）', () => {
    const first = createProductBudget({ config: { ...fullConfig(), model_calls: 1 }, runDir: workDir });
    const gate1 = createProductBudgetGate(first, null, { keyPrefix: 'run1' });
    expect(gate1.admit('model').allowed).toBe(true); // 用掉唯一额度

    // 换服务实例（新台账）读**同一份**落盘流水：额度不回升，继续拒。
    const restarted = createProductBudget({ config: { ...fullConfig(), model_calls: 1 }, runDir: workDir });
    expect(restarted.ledger.used('model_calls')).toBe(1);
    const gate2 = createProductBudgetGate(restarted, null, { keyPrefix: 'run2' });
    const refused = capture(() => gate2.admit('model'));
    expect(refused).toBeInstanceOf(BudgetGateRefusal);
    expect(restarted.ledger.used('model_calls')).toBe(1);

    // 反向对照：独立运行目录 ⇒ 从零开始，放行。
    const fresh = createProductBudget({ config: { ...fullConfig(), model_calls: 1 }, runDir: otherDir });
    expect(fresh.ledger.used('model_calls')).toBe(0);
    const gate3 = createProductBudgetGate(fresh, null, { keyPrefix: 'run3' });
    expect(gate3.admit('model').allowed).toBe(true);
  });

  it('反向对照：无上限配置 ⇒ 每次调用都抛"没有上限不是合法配置"，绝不默认放行', async () => {
    const gate = createProductBudgetGate(
      null,
      'ValidationError: 预算配置缺少 8 个维度的上限（…）："没有上限"不是合法配置——…',
    );
    expect(gate.wired).toBe(false);
    const refused = capture(() => gate.admit('model'));
    expect(refused).toBeInstanceOf(BudgetGateRefusal);
    const refusal = refused as BudgetGateRefusal;
    expect(refusal.code).toBe('budget_not_configured');
    expect(refusal.message).toContain('没有上限');
    expect(refusal.message).toContain('不是合法配置');
    expect(refusal.partial.complete_claimed).toBe(false);

    // 工具侧同样被拒（结构化回执，而不是放行）。
    const calls = { n: 0 };
    const gated = gateToolExecutor(spyToolExecutor(calls), gate);
    const receipt = await gated.invoke({ call_id: 'c', tool: 't', arguments: {} }, null);
    expect(receipt?.ok).toBe(false);
    expect(receipt?.error?.code).toBe('budget_not_configured');
    expect(calls.n).toBe(0);
  });

  it('产品接线：闸门真的坐在工具循环的**模型调用 / 工具执行**路径上（耗尽 ⇒ 报告未发出请求）', async () => {
    const wiring = createProductBudget({ config: { ...fullConfig(), model_calls: 1 }, runDir: workDir });
    const gate = createProductBudgetGate(wiring, null, { keyPrefix: 'loop' });
    const modelCalls = { n: 0 };
    const toolCalls = { n: 0 };
    const host = createToolLoopHost({
      catalog: createDocumentToolCatalog(),
      modelPort: gateModelTurnPort(spyModelPort(modelCalls), gate, { label: 'loop-model' }),
      toolExecutor: gateToolExecutor(spyToolExecutor(toolCalls), gate, { subject: 'loop' }),
    });

    const first = await host.run({ instructions: '写一份说明' });
    expect(first.status).toBe(200); // answered
    // 第一次被放行 ⇒ 模型端口被触到一次（真请求由此发出）。
    expect(modelCalls.n).toBe(1);

    const second = await host.run({ instructions: '再写一份说明' });
    expect(second.ok).toBe(false);
    // 第二次被闸门拒 ⇒ **模型端口一次都没被触到**（真实请求未发出）。
    expect(modelCalls.n).toBe(1);
    const secondBody = second.body as Record<string, unknown>;
    expect(String(secondBody['reason'])).toContain('预算');
    expect(String(secondBody['reason'])).toContain('未发出');
  });

  it('产品接线：整轮闸门给出干净的 429 / 503（不把预算拒绝伪装成"格式违约"）', async () => {
    // `task_calls=1` ⇒ 第二次 `/run` 在**轮次边界**被拒，直接 429。
    const wiring = createProductBudget({ config: { ...fullConfig(), task_calls: 1 }, runDir: workDir });
    const gate = createProductBudgetGate(wiring, null, { keyPrefix: 'host' });
    const modelCalls = { n: 0 };
    const host = gateToolLoopHost(
      createToolLoopHost({
        catalog: createDocumentToolCatalog(),
        modelPort: spyModelPort(modelCalls),
        toolExecutor: spyToolExecutor({ n: 0 }),
      }),
      gate,
    );

    const first = await host.run({ instructions: '第一轮' });
    expect(first.status).toBe(200);
    expect(modelCalls.n).toBe(1);

    const second = await host.run({ instructions: '第二轮' });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(429);
    const body = second.body as Record<string, unknown>;
    expect(body['code']).toBe('budget_exhausted');
    // 部分结果：字面量 false。
    expect((body['partial'] as Record<string, unknown>)['complete_claimed']).toBe(false);
    // **没有发出**：模型端口累计仍只有被放行的第一次。
    expect(modelCalls.n).toBe(1);

    // 反向对照：未装配 ⇒ 503（**不**默认放行）。
    const bare = gateToolLoopHost(
      createToolLoopHost({
        catalog: createDocumentToolCatalog(),
        modelPort: spyModelPort({ n: 0 }),
        toolExecutor: spyToolExecutor({ n: 0 }),
      }),
      createProductBudgetGate(null, '没配八维上限'),
    );
    const refused = await bare.run({ instructions: '未装配' });
    expect(refused.status).toBe(503);
    expect((refused.body as Record<string, unknown>)['code']).toBe('budget_not_configured');
  });
});

// ---------------------------------------------------------------------------
// FA-BUDGET-SERVER-KEY：计费量由服务端确定 + 无 key 也落盘（跨进程重启不回升）
// ---------------------------------------------------------------------------
//
// 监督（13:40）点名 `POST /api/session-adapters/tool-call` 两条病灶：
// ① `charges` 来自请求体（客户端自报"这次只花 0.0001"就能绕过硬限制）；
// ② 幂等 `key` 可省略，且**无 key 就不写 journal** ⇒ 重启后这笔不会被恢复（等于没扣）。
//
// 本节先用**真 HTTP** 把两条复现出来，再钉住修后的口径；反向对照另给两处（独立运行目录、
// 无上限配置）。跨**真实进程**重启的验收见交付说明里的真服务冒烟（本节是同进程的模拟重启）。

/** 把一个只挂了会话适配器接线的**真** `node:http` 服务起起来（确定性时钟）。 */
async function serveToolCall(
  runDir: string,
  budget: ProductBudgetWiring | null,
): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  const wiring = createSessionAdaptersWiring({
    runDir,
    store: null,
    now: () => 1_700_000_000_000,
    ...(budget === null ? { budget: null, budgetUnwiredReason: '测试：未配置' } : { budget }),
  });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void wiring.handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function postToolCall(
  baseUrl: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/session-adapters/tool-call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // 非 JSON：保留空对象
  }
  return { status: res.status, body: parsed };
}

function readJournal(path: string): readonly Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('FA-BUDGET-SERVER-KEY · 复现：客户端自报的计费量进不了台账', () => {
  it('复现①：客户端送 charges:{tokens:0.0001} ⇒ 记账量必须是服务端算出的数，**不是** 0.0001', async () => {
    const budget = createProductBudget({ config: { ...fullConfig(), tokens: 1_000 }, runDir: workDir });
    const running = await serveToolCall(workDir, budget);
    try {
      const r = await postToolCall(running.baseUrl, { charges: { tokens: 0.0001 } });
      expect(r.status).toBe(200);
      const outcome = r.body['outcome'] as Record<string, unknown>;
      expect(outcome['allowed']).toBe(true);
      const charged = outcome['charged'] as Record<string, number>;
      // **改前红**：旧实现原样采用请求体里的 0.0001（客户端说花多少就记多少）。
      expect(charged['tokens']).not.toBe(0.0001);
      // 服务端算出来的是非负整数（钱与 token 都不接受浮点自报）。
      expect(Number.isInteger(charged['tokens'])).toBe(true);
      expect(charged['tokens'] as number).toBeGreaterThanOrEqual(1);
      expect(r.body['charges_source']).toBe('server');
      // 台账与响应一致（响应不是编的）。
      expect(budget.ledger.used('tokens')).toBe(charged['tokens']);
      // 请求体里的**每个**数字都不生效：再送一个天大的数，结果一样。
      const huge = await postToolCall(running.baseUrl, { charges: { tokens: 999_999 } });
      expect((huge.body['outcome'] as Record<string, unknown>)['charged']).toMatchObject({
        tokens: charged['tokens'],
      });
    } finally {
      await running.close();
    }
  });

  it('复现②：**不带 key** 的调用也必须落盘 —— 同运行目录“重启”后额度不回升', async () => {
    const first = createProductBudget({ config: fullConfig(), runDir: workDir });
    const running = await serveToolCall(workDir, first);
    try {
      const r = await postToolCall(running.baseUrl, { charges: { tool_calls: 1 } });
      expect(r.status).toBe(200);

      // 流水里**确实有**这一笔（不是"没 key 就不写"）。
      const entries = readJournal(first.journalPath);
      // **改前红**：旧实现不带 key ⇒ 这里 length 为 0（这笔根本没落盘）。
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e['dimension'] === 'tool_calls' && e['amount'] === 1)).toBe(true);
      expect(r.body['identity_source']).toBe('server');
      expect(r.body['client_key_ignored']).toBe(false);
    } finally {
      await running.close();
    }

    // “重启”：同运行目录上的**新**实例读同一份落盘流水。
    const restarted = createProductBudget({ config: fullConfig(), runDir: workDir });
    // **改前红**：旧实现这笔根本没落盘 ⇒ 这里读到 0（额度回升，等于没扣）。
    expect(restarted.ledger.used('tool_calls')).toBe(1);
    expect(restarted.restoreReport.target['tool_calls']).toBe(1);
  });

  it('复现②附带：客户端送来的 key **不透传**成流水身份（身份一律由服务端确定）', async () => {
    const budget = createProductBudget({ config: fullConfig(), runDir: workDir });
    const running = await serveToolCall(workDir, budget);
    try {
      const r = await postToolCall(running.baseUrl, { charges: { tool_calls: 1 }, key: '客户端自封的key' });
      expect(r.status).toBe(200);
      const entries = readJournal(budget.journalPath);
      expect(entries.length).toBeGreaterThan(0);
      // **改前红**：旧实现把客户端 key 原样当流水身份 ⇒ 这里能读到它。
      for (const entry of entries) {
        expect(String(entry['key'])).not.toContain('客户端自封的key');
      }
      expect(r.body['client_key_ignored']).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('反向对照：独立运行目录 ⇒ 额度从零开始（流水不是写在全局位置）', async () => {
    const budget = createProductBudget({ config: fullConfig(), runDir: workDir });
    const running = await serveToolCall(workDir, budget);
    try {
      await postToolCall(running.baseUrl, { charges: { tool_calls: 1 } });
      expect(budget.ledger.used('tool_calls')).toBe(1);
    } finally {
      await running.close();
    }

    const fresh = createProductBudget({ config: fullConfig(), runDir: otherDir });
    expect(fresh.ledger.used('tool_calls')).toBe(0);
    expect(fresh.restoreReport.facts).toBe(0);
    // 独立目录里连流水文件都还不存在（没有写到全局位置）。
    expect(existsSync(fresh.journalPath)).toBe(false);
  });

  it('反向对照：无上限配置 ⇒ 抛（**不得**默认放行）；HTTP 边界上未装配 ⇒ 503', async () => {
    // 缺任一维 ⇒ 装配即抛（不是"缺项=不设限"）。
    const missing: Partial<Record<BudgetDimension, number>> = { ...fullConfig() };
    delete missing.tokens;
    expect(() => createProductBudget({ config: missing, runDir: workDir })).toThrow(ValidationError);
    expect(() => createProductBudget({ config: {}, runDir: workDir })).toThrow(ValidationError);

    // 未装配的台账在 HTTP 边界上如实 503 —— 不是 200 放行。
    const running = await serveToolCall(workDir, null);
    try {
      const r = await postToolCall(running.baseUrl, { charges: { tokens: 1 } });
      expect(r.status).toBe(503);
      expect(r.body['code']).toBe('budget_not_configured');
    } finally {
      await running.close();
    }
  });
});

describe('FA-BUDGET-SERVER-KEY · 服务端计费策略：值被忽略，量由策略定', () => {
  it('单元：只读"声明了哪几维"，**不读**调用方给的数字；`tokens` 另按实测字节折算', () => {
    // 声明了 tokens ⇒ 底数 1 + ceil(0 / 64) = 1；0.0001 这个数字完全不参与。
    expect(serverDeterminedCharges({ tokens: 0.0001 }, { input_bytes: 0 })).toEqual({ tokens: 1 });
    // 输入规模由服务端**实测**：128 字节 ⇒ ceil(128/64)=2 ⇒ 1 + 2 = 3。
    expect(serverDeterminedCharges({ tokens: 999_999 }, { input_bytes: 128 })).toEqual({ tokens: 3 });
    // 声明的值被忽略（0.0001 与 1e9 给出同一个结果）。
    expect(serverDeterminedCharges({ task_calls: 0.0001, tool_calls: 1e9 }, { input_bytes: 0 })).toEqual({
      task_calls: 1,
      tool_calls: 1,
    });
    // 未声明的维度不记（不是"一律记满八维"）。
    expect(serverDeterminedCharges({}, { input_bytes: 4096 })).toEqual({});
    // 占用式维度不被这里计成累计量：`concurrency` 声明了也只会得到 `1`，由 `reserve()` 去拒。
    expect(serverDeterminedCharges({ concurrency: 1 }, { input_bytes: 0 })).toEqual({ concurrency: 1 });
    expect(DEFAULT_SERVER_CHARGE_POLICY.per_dimension).toBe(1);
  });

  it('判别力：同进程两个接线实例各放行一笔 ⇒ 身份不撞号，重启后合计不丢', () => {
    const a = createProductBudget({ config: fullConfig(), runDir: workDir });
    const b = createProductBudget({ config: fullConfig(), runDir: workDir });
    expect(a.admit({ charges: { tool_calls: 1 } }).allowed).toBe(true);
    expect(b.admit({ charges: { tool_calls: 1 } }).allowed).toBe(true);

    const keys = new Set(readJournal(a.journalPath).map((entry) => String(entry['key'])));
    expect(keys.size).toBe(2);

    // 若两个实例共用身份基，两笔会在收敛时被去重成一笔（少扣）——这里必须合计为 2。
    const restarted = createProductBudget({ config: fullConfig(), runDir: workDir });
    expect(restarted.ledger.used('tool_calls')).toBe(2);
  });

  it('判别力：自定义策略真的改变记账量（策略是活旋钮，不是恒真的形式）', () => {
    const doubled = serverDeterminedCharges({ tool_calls: 1 }, { input_bytes: 0 }, {
      per_dimension: 2,
      bytes_per_token: 0,
      base_tokens: 0,
    });
    expect(doubled).toEqual({ tool_calls: 2 });
  });
});
