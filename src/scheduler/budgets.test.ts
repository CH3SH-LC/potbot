/**
 * KRN-12：任务 / 模型 / 工具调用、token / 费用、并发、重试与时间预算为**硬限制**；
 * **重启和多工作进程不能清零额度**；具备**脱敏追踪**与**部分结果交付**。
 *
 * ## 这个文件要钉死的判据
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 超限的预留 ⇒ 拒，且**一条都不扣**（不做半截扣费） | **反例** |
 * | 2 | 限额之内的预留 ⇒ 放行并记账；未设限的维度恒可放行 | **对照** |
 * | 3 | 并发是**占用式**：达上限即拒，释放后名额回来 | **反例 + 对照** |
 * | 4 | 重启：流水在 ⇒ 用量**不回滚**，闸门继续拒 | **反例** |
 * | 5 | 同输入换**易失**流水 ⇒ 结论相反（额度归零、闸门放行） | **反向对照** |
 * | 6 | 多工作进程（同进程两实例读同一份落盘流水）⇒ 后开的那个也看得到前一个的用量 | 正例 |
 * | 7 | 脱敏追踪：原文（凭据 / 用户内容）**不出现在**追踪里 | **反例** |
 * | 8 | 部分结果交付：耗尽时如实列出未产出项且不宣称完成；未耗尽时不含"因预算中断" | 正例 + **对照** |
 *
 * ## 诚实边界
 *
 * 第 6 条是**同进程模拟**（两个台账实例读**同一份落盘流水**），
 * **不是**两个真实进程并发追加的实测——真实跨进程并发追加**未做**，本文件不据此宣称。
 */

import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { asLogicalTime } from '../protocol/index.js';
import {
  BUDGET_DIMENSIONS,
  type BudgetDimension,
  type BudgetJournal,
  type BudgetJournalEntry,
  HardBudgetLedger,
  createMemoryJournal,
  describeBudget,
  factsFromJournal,
  planPartialDelivery,
  reconcileBudgetFromFacts,
  redact,
  restoreBudgetFromJournal,
} from './budgets.js';

let workDir: string;
let journalPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-budget-'));
  journalPath = join(workDir, 'budget.jsonl');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1 / 2：硬限制的事前闸门
// ---------------------------------------------------------------------------

describe('KRN-12 硬限制：事前闸门，不做事后断言', () => {
  it('反例：会超限的预留被拒，且**一条都不扣**', () => {
    const ledger = new HardBudgetLedger({ model_calls: 2, tokens: 100 });
    expect(ledger.reserve({ charges: { model_calls: 1, tokens: 40 } }).allowed).toBe(true);
    expect(ledger.used('model_calls')).toBe(1);

    // tokens 会超（40 + 70 > 100）：整笔拒绝，model_calls **也不得**被扣。
    const refused = ledger.reserve({ charges: { model_calls: 1, tokens: 70 } });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe('would_exceed_limit');
    expect(refused.would_exceed).toEqual(['tokens']);
    expect(ledger.used('model_calls')).toBe(1);
    expect(ledger.used('tokens')).toBe(40);

    // 恰好用满（40 + 60 = 100）⇒ 允许；再要 1 就拒。
    expect(ledger.reserve({ charges: { model_calls: 1, tokens: 60 } }).allowed).toBe(true);
    expect(ledger.used('tokens')).toBe(100);
    const exact = ledger.reserve({ charges: { tokens: 1 } });
    expect(exact.allowed).toBe(false);
    expect(exact.reason).toBe('would_exceed_limit');
  });

  it('对照：限额之内放行并记账；**未设限**的维度恒可放行（不是"一律拒绝"）', () => {
    const ledger = new HardBudgetLedger({ tool_calls: 3 });
    expect(ledger.reserve({ charges: { tool_calls: 3 } }).allowed).toBe(true);
    expect(ledger.used('tool_calls')).toBe(3);
    expect(ledger.exhausted('tool_calls')).toBe(true);
    expect(ledger.reserve({ charges: { tool_calls: 1 } }).allowed).toBe(false);
    // 未登记上限的维度：不设限（null ≠ 0）。
    expect(ledger.limitOf('tokens')).toBeNull();
    expect(ledger.exhausted('tokens')).toBe(false);
    expect(ledger.reserve({ charges: { tokens: 1_000_000 } }).allowed).toBe(true);
  });

  it('反例：非法数量 / 占用式维度走累计记账 ⇒ 结构化拒绝，不改动账目', () => {
    const ledger = new HardBudgetLedger({ tokens: 10 });
    const negative = ledger.reserve({ charges: { tokens: -5 } });
    expect(negative.allowed).toBe(false);
    expect(negative.reason).toBe('invalid_amount');
    expect(ledger.used('tokens')).toBe(0);

    const occupancy = ledger.reserve({ charges: { concurrency: 1 } });
    expect(occupancy.allowed).toBe(false);
    expect(occupancy.reason).toBe('occupancy_dimension_requires_acquire');
    expect(ledger.used('concurrency')).toBe(0);
  });

  it('反例：并发达上限即拒，释放后名额回来（占用式 ≠ 累计式）', () => {
    const ledger = new HardBudgetLedger({ concurrency: 2 });
    expect(ledger.acquire().acquired).toBe(true);
    expect(ledger.acquire().acquired).toBe(true);
    const third = ledger.acquire();
    expect(third.acquired).toBe(false);
    expect(third.reason).toBe('concurrency_limit_reached');
    expect(third.in_flight).toBe(2);
    expect(ledger.release()).toBe(1);
    expect(ledger.acquire().acquired).toBe(true);
    // 释放不会降到 0 以下。
    ledger.release();
    ledger.release();
    ledger.release();
    expect(ledger.used('concurrency')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4 / 5 / 6：重启与多工作进程不清零
// ---------------------------------------------------------------------------

describe('KRN-12 重启与多工作进程不得清零额度', () => {
  it('反例：落盘流水在 ⇒ 重启后台账收敛到已用量，闸门**继续拒**', () => {
    const limit = { model_calls: 2 };
    const first = new HardBudgetLedger(limit, { journal: createFileBudgetJournal(journalPath) });
    first.charge('model_calls', 1, { at: asLogicalTime(1), key: 'call-1' });
    first.charge('model_calls', 1, { at: asLogicalTime(2), key: 'call-2' });
    expect(first.used('model_calls')).toBe(2);

    // "重启"：新台账（一开始是 0，这正是过去白送额度的形状）+ 同一份落盘流水。
    const restarted = new HardBudgetLedger(limit, { journal: createFileBudgetJournal(journalPath) });
    expect(restarted.used('model_calls')).toBe(0);
    const report = restoreBudgetFromJournal(restarted, createFileBudgetJournal(journalPath));
    expect(report.before['model_calls']).toBe(0);
    expect(report.target['model_calls']).toBe(2);
    expect(report.charged['model_calls']).toBe(2);
    expect(report.lowered).toBe(false);
    expect(restarted.used('model_calls')).toBe(2);
    // 闸门继续拒（额度没被重启清零）。
    expect(restarted.reserve({ charges: { model_calls: 1 } }).allowed).toBe(false);
  });

  it('反向对照：同输入换**易失**流水 ⇒ 重启后额度归零、闸门放行（证明上一条有判别力）', () => {
    const limit = { model_calls: 2 };
    const ephemeral = createMemoryJournal();
    const first = new HardBudgetLedger(limit, { journal: ephemeral });
    first.charge('model_calls', 1, { at: asLogicalTime(1), key: 'call-1' });
    first.charge('model_calls', 1, { at: asLogicalTime(2), key: 'call-2' });

    // 易失流水：重启后读回空 ⇒ 目标用量 0 ⇒ 闸门放行本应被拒的消费。
    const freshJournal = createMemoryJournal();
    const restarted = new HardBudgetLedger(limit, { journal: freshJournal });
    const report = restoreBudgetFromJournal(restarted, freshJournal);
    expect(report.target['model_calls']).toBeUndefined();
    expect(restarted.used('model_calls')).toBe(0);
    expect(restarted.reserve({ charges: { model_calls: 1 } }).allowed).toBe(true);
  });

  it('正例（同进程模拟）：第二个工作进程读同一份落盘流水 ⇒ 看得到第一个的用量', () => {
    const durable = createFileBudgetJournal(journalPath);
    const limit = { tool_calls: 5 };

    const workerA = new HardBudgetLedger(limit, { journal: durable });
    workerA.charge('tool_calls', 3, { at: asLogicalTime(1), key: 'a-1', label: '工作进程 A' });

    // 工作进程 B：全新的台账，但同一份**落盘**流水。
    const workerB = new HardBudgetLedger(limit, { journal: createFileBudgetJournal(journalPath) });
    const report = restoreBudgetFromJournal(workerB, createFileBudgetJournal(journalPath));
    expect(report.target['tool_calls']).toBe(3);
    expect(workerB.used('tool_calls')).toBe(3);
    // B 只剩 2 次可用：要 3 次会被硬拒。
    expect(workerB.reserve({ charges: { tool_calls: 3 } }).allowed).toBe(false);
    expect(workerB.reserve({ charges: { tool_calls: 2 } }).allowed).toBe(true);

    // **幂等**：同一份流水再收敛一次，增量必须为 0。
    const again = restoreBudgetFromJournal(workerB, createFileBudgetJournal(journalPath));
    expect(again.charged).toEqual({});
  });

  it('只上不下：台账高于目标时**不回调**（R218），并如实留下差值供告警', () => {
    const ledger = new HardBudgetLedger({ tokens: 100 });
    ledger.charge('tokens', 50, { at: asLogicalTime(1), label: '真实消耗' });
    const report = reconcileBudgetFromFacts(ledger, [
      { key: 'k1', dimension: 'tokens', amount: 10, at: asLogicalTime(2) },
    ]);
    expect(report.target['tokens']).toBe(10);
    expect(report.before['tokens']).toBe(50);
    expect(report.charged).toEqual({});
    expect(ledger.used('tokens')).toBe(50);
  });

  it('流水的事实折算按 key 去重（同一条消耗追加两次只算一次）', () => {
    const facts = factsFromJournal([
      { key: 'k1', dimension: 'tokens', amount: 10, at: asLogicalTime(1) },
      { key: 'k1', dimension: 'tokens', amount: 10, at: asLogicalTime(2) },
      { key: 'k2', dimension: 'tokens', amount: 5, at: asLogicalTime(3) },
    ]);
    expect(facts).toHaveLength(2);
    const ledger = new HardBudgetLedger({ tokens: 100 });
    reconcileBudgetFromFacts(ledger, facts);
    expect(ledger.used('tokens')).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 7：脱敏追踪
// ---------------------------------------------------------------------------

describe('KRN-12 脱敏追踪', () => {
  it('反例：原文（凭据 / 用户内容）不得出现在追踪与快照里', () => {
    const secret = 'sk-live-SUPER-SECRET-TOKEN-abcdef';
    const userText = '用户说：我的身份证号是 310101199001011234';
    const ledger = new HardBudgetLedger({ model_calls: 5, tokens: 100 });
    ledger.reserve({
      charges: { model_calls: 1, tokens: 10 },
      at: asLogicalTime(1),
      subject: secret,
      label: userText,
    });
    ledger.acquire({ at: asLogicalTime(2), subject: userText });
    ledger.charge('retries', 1, { at: asLogicalTime(3), label: secret });

    const serialized = JSON.stringify(ledger.redactedTrace());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('SUPER-SECRET');
    expect(serialized).not.toContain('310101199001011234');
    expect(serialized).not.toContain('身份证号');
    // 追踪仍然可用：有维度、有数量、有摘要。
    const first = ledger.redactedTrace()[0]!;
    expect(first.dimension).toBe('model_calls');
    expect(first.amount).toBe(1);
    expect(first.label?.digest.length).toBeGreaterThan(16);
    expect(first.label?.hint).toBe('用户');
    expect(serialized).toBe(JSON.stringify(ledger.snapshot().trace));
  });

  it('redact：短原文不给提示（提示过长等于没脱敏），长原文只给前 2 字符', () => {
    expect(redact('ab').hint).toBe('');
    expect(redact('abc').hint).toBe('');
    expect(redact('abcdef').hint).toBe('ab');
    expect(redact('abcdef').length).toBe(6);
    // 同一原文 ⇒ 同一摘要（可复核），不同原文 ⇒ 不同摘要。
    expect(redact('abcdef').digest).toBe(redact('abcdef').digest);
    expect(redact('abcdef').digest).not.toBe(redact('abcdeg').digest);
  });
});

// ---------------------------------------------------------------------------
// 8：部分结果交付
// ---------------------------------------------------------------------------

describe('KRN-12 部分结果交付', () => {
  it('正例：有维度耗尽 ⇒ 如实列出未产出项，且**不宣称完成**', () => {
    const ledger = new HardBudgetLedger({ model_calls: 1 });
    ledger.reserve({ charges: { model_calls: 1 } });
    expect(ledger.exhaustedDimensions()).toEqual(['model_calls']);

    const delivery = planPartialDelivery({
      ledger,
      planned_refs: ['报告.md', '附录.csv', '图表.png'],
      delivered_refs: ['报告.md'],
    });
    expect(delivery.partial).toBe(true);
    expect(delivery.complete_claimed).toBe(false);
    expect(delivery.delivered_refs).toEqual(['报告.md']);
    expect(delivery.withheld_refs).toEqual(['附录.csv', '图表.png']);
    expect(delivery.reasons['附录.csv']).toContain('预算已耗尽');
    expect(delivery.note).toContain('部分结果');
  });

  it('对照：没有维度耗尽 ⇒ 不含"因预算而中断"的成分（`partial` 为假）', () => {
    const ledger = new HardBudgetLedger({ model_calls: 3 });
    ledger.reserve({ charges: { model_calls: 1 } });
    const delivery = planPartialDelivery({
      ledger,
      planned_refs: ['报告.md'],
      delivered_refs: ['报告.md'],
    });
    expect(delivery.partial).toBe(false);
    expect(delivery.exhausted_dimensions).toEqual([]);
    expect(delivery.withheld_refs).toEqual([]);
    expect(delivery.note).toContain('没有维度耗尽');
    // 但"部分交付"这个对象**永不**宣称完整。
    expect(delivery.complete_claimed).toBe(false);
  });

  it('反例：计划了却没产出、又没登记原因 ⇒ 仍然出现在 withheld 里（不得静默省略）', () => {
    const ledger = new HardBudgetLedger({});
    const delivery = planPartialDelivery({
      ledger,
      planned_refs: ['甲', '乙'],
      delivered_refs: ['甲'],
    });
    expect(delivery.withheld_refs).toEqual(['乙']);
    expect(delivery.reasons['乙']).toBe('未产出（原因未登记）');
  });
});

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

describe('KRN-12 证据可读性', () => {
  it('八个维度都登记在案，describeBudget 如实输出用量与上限', () => {
    expect(BUDGET_DIMENSIONS).toHaveLength(8);
    const ledger = new HardBudgetLedger({ tokens: 10, concurrency: 1 });
    ledger.charge('tokens', 10);
    ledger.acquire();
    const line = describeBudget(ledger);
    expect(line).toContain('token 用量 10/10!');
    expect(line).toContain('并发 1/1!');
    expect(line).toContain('模型调用 0/∞');
  });
});

/** 落盘流水（JSONL；追加写，读回时忽略不完整尾行）。 */
export function createFileBudgetJournal(filePath: string): BudgetJournal {
  const line = (entry: BudgetJournalEntry): string =>
    JSON.stringify({
      key: entry.key,
      dimension: entry.dimension,
      amount: entry.amount,
      at: Number(entry.at),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    });

  return {
    append(entry: BudgetJournalEntry): void {
      const directory = dirname(filePath);
      if (directory.length > 0 && !existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
      }
      // 单行追加：并发写者不会互相覆盖（各自的行是独立的字节区间）。
      appendFileSync(filePath, `${line(entry)}\n`, 'utf8');
    },
    read(): readonly BudgetJournalEntry[] {
      if (!existsSync(filePath)) {
        return Object.freeze([]);
      }
      const parsed: BudgetJournalEntry[] = [];
      for (const raw of readFileSync(filePath, 'utf8').split('\n')) {
        const text = raw.trim();
        if (text.length === 0) {
          continue;
        }
        try {
          const value = JSON.parse(text) as {
            key: string;
            dimension: BudgetDimension;
            amount: number;
            at: number;
            note?: string;
          };
          if (!BUDGET_DIMENSIONS.includes(value.dimension)) {
            continue;
          }
          parsed.push(
            Object.freeze({
              key: value.key,
              dimension: value.dimension,
              amount: value.amount,
              at: asLogicalTime(value.at),
              ...(value.note === undefined ? {} : { note: value.note }),
            }),
          );
        } catch {
          // 崩溃写了一半的尾行：丢弃，不影响已完整的行。
        }
      }
      return Object.freeze(parsed);
    },
    describe() {
      return { kind: 'file' as const, durable: true, detail: `追加式 JSONL：${filePath}` };
    },
  };
}
