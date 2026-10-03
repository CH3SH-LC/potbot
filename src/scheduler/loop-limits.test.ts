/**
 * KRN-04 下半：**轮次 / 工具调用 / 时间的硬闸门** —— 到顶即停、给部分结果 + 原因、
 * 复用既有 budgets 语义（不另造）。
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 轮次闸门：第 `max_turns + 1` 次申请被拒（`would_exceed_limit`），映射到 `model_calls` | 正例 |
 * | 2 | **被拒时一条都不扣**（拒绝后已用量不变） | **反例（核心）** |
 * | 3 | 工具调用闸门同理（`tool_calls`）；`max_tool_calls: 0` ⇒ 第一次就拒 | 正例 |
 * | 4 | 时间闸门：**不部分推进**（越界的推进整笔拒绝，已用量不变） | **反例** |
 * | 5 | 三项必须显式给全：缺项 / 负数 / 非整数 / 小数 ⇒ 抛 `ValidationError` | **反例** |
 * | 6 | `report()` 未超限 ⇒ `within_limits`，但仍 `complete_claimed: false` | 正例 |
 * | 7 | `report()` 超限 ⇒ `partial: true` + 命中维度 + 人可读原因 | 正例 |
 * | 8 | `report()` 复用既有 `planPartialDelivery`：如实列出 `withheld_refs` | 正例 |
 * | 9 | **复用对照**：底层就是既有 `HardBudgetLedger`，判据与直接 `reserve` 一致 | **对照** |
 * | 10 | 维度名不另造：映射结果全部落在既有的 `BUDGET_DIMENSIONS` 内 | **对照** |
 * | 11 | 介质如实：未注入流水 ⇒ 明说"不跨重启（未接线）"，不冒充持久 | **对照（诚实标注）** |
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../protocol/index.js';
import { BUDGET_DIMENSIONS, HardBudgetLedger, createMemoryJournal } from './budgets.js';
import {
  DEFAULT_LOOP_LIMIT_SPEC,
  LOOP_LIMIT_DIMENSIONS,
  createLoopLimitGate,
  loopLimitBudgets,
  validateLoopLimitSpec,
} from './loop-limits.js';

describe('KRN-04 循环上限', () => {
  it('1. 轮次闸门：第 max_turns + 1 次申请被拒，映射到 model_calls', () => {
    const gate = createLoopLimitGate({ max_turns: 2, max_tool_calls: 4, max_time: 10 });
    expect(gate.beginTurn().admitted).toBe(true);
    expect(gate.beginTurn().admitted).toBe(true);

    const third = gate.beginTurn();
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe('would_exceed_limit');
    expect(third.dimension).toBe('model_calls');
    expect(third.would_exceed).toContain('model_calls');
    expect(third.detail).toContain('轮次');
    expect(third.exhausted_dimensions).toContain('model_calls');
  });

  it('2. 被拒时一条都不扣（拒绝不是部分扣费）', () => {
    const gate = createLoopLimitGate({ max_turns: 1, max_tool_calls: 1, max_time: 1 });
    gate.beginTurn();
    const before = gate.ledger.used('model_calls');
    const refused = gate.beginTurn();
    expect(refused.admitted).toBe(false);
    expect(gate.ledger.used('model_calls')).toBe(before); // 已用量没有被推高
    expect(gate.ledger.used('model_calls')).toBe(1);

    // 工具调用也一样：被拒后计数保持不变。
    gate.beginToolCall();
    expect(gate.beginToolCall().admitted).toBe(false);
    expect(gate.ledger.used('tool_calls')).toBe(1);
  });

  it('3. 工具调用闸门：max_tool_calls 为 0 时第一次就拒', () => {
    const gate = createLoopLimitGate({ max_turns: 2, max_tool_calls: 0, max_time: 4 });
    expect(gate.beginTurn().admitted).toBe(true);
    const first = gate.beginToolCall();
    expect(first.admitted).toBe(false);
    expect(first.dimension).toBe('tool_calls');
    expect(gate.ledger.used('tool_calls')).toBe(0);
  });

  it('4. 时间闸门不部分推进：越界的推进整笔拒绝，已用量不变', () => {
    const gate = createLoopLimitGate({ max_turns: 2, max_tool_calls: 2, max_time: 5 });
    expect(gate.advanceTime(3).admitted).toBe(true);
    const refused = gate.advanceTime(3);
    expect(refused.admitted).toBe(false);
    expect(refused.dimension).toBe('time');
    expect(gate.ledger.used('time')).toBe(3); // 没有被推进到 5 或 6
    expect(gate.advanceTime(2).admitted).toBe(true);
    expect(gate.ledger.used('time')).toBe(5);
    expect(gate.ledger.exhausted('time')).toBe(true);
  });

  it('5. 上限必须显式给全且合法（"没有上限"不是合法配置）', () => {
    expect(() => validateLoopLimitSpec({ max_turns: 0, max_tool_calls: 1, max_time: 1 })).toThrow(
      ValidationError,
    );
    expect(() => validateLoopLimitSpec({ max_turns: 2, max_tool_calls: -1, max_time: 1 })).toThrow(
      ValidationError,
    );
    expect(() => validateLoopLimitSpec({ max_turns: 2, max_tool_calls: 1, max_time: 1.5 })).toThrow(
      ValidationError,
    );
    expect(() =>
      validateLoopLimitSpec({ max_turns: undefined as unknown as number, max_tool_calls: 1, max_time: 1 }),
    ).toThrow(ValidationError);
    expect(() =>
      createLoopLimitGate({ max_turns: 2, max_tool_calls: 1, max_time: 1 } as never),
    ).not.toThrow();
  });

  it('6. report() 未超限：within_limits，但不宣称完成', () => {
    const gate = createLoopLimitGate({ max_turns: 3, max_tool_calls: 3, max_time: 3 });
    gate.beginTurn();
    const report = gate.report();
    expect(report.status).toBe('within_limits');
    expect(report.partial).toBe(false);
    expect(report.complete_claimed).toBe(false); // "没超限"不等于"完成"
    expect(report.exhausted_dimensions).toHaveLength(0);
    expect(report.note).toContain('不由');
  });

  it('7. report() 超限：partial + 命中维度 + 人可读原因', () => {
    const gate = createLoopLimitGate({ max_turns: 1, max_tool_calls: 2, max_time: 2 });
    gate.beginTurn();
    const report = gate.report();
    expect(report.status).toBe('exhausted');
    expect(report.partial).toBe(true);
    expect(report.complete_claimed).toBe(false);
    expect(report.exhausted_dimensions).toContain('model_calls');
    expect(report.reason).toContain('模型调用');
    const row = report.usage.find((entry) => entry.dimension === 'model_calls');
    expect(row).toMatchObject({ used: 1, limit: 1, exhausted: true });
  });

  it('8. report() 复用 planPartialDelivery：如实列出未产出项', () => {
    const gate = createLoopLimitGate({ max_turns: 1, max_tool_calls: 2, max_time: 2 });
    gate.beginTurn();
    const report = gate.report({
      planned_refs: ['a.docx', 'b.docx'],
      delivered_refs: ['a.docx'],
    });
    expect(report.delivery).not.toBeNull();
    expect(report.delivery?.delivered_refs).toEqual(['a.docx']);
    expect(report.delivery?.withheld_refs).toEqual(['b.docx']);
    expect(report.delivery?.complete_claimed).toBe(false);
    expect(report.delivery?.reasons['b.docx']).toContain('预算已耗尽');
  });

  it('9. 复用对照：底层就是既有 HardBudgetLedger，判据与 reserve 一致', () => {
    const spec = { max_turns: 2, max_tool_calls: 4, max_time: 8 };
    const gate = createLoopLimitGate(spec);
    expect(gate.ledger).toBeInstanceOf(HardBudgetLedger);

    const plain = new HardBudgetLedger({ model_calls: spec.max_turns });
    for (let index = 0; index < spec.max_turns; index += 1) {
      expect(gate.beginTurn().admitted).toBe(true);
      expect(plain.reserve({ charges: { model_calls: 1 } }).allowed).toBe(true);
    }
    expect(gate.beginTurn().admitted).toBe(false);
    expect(plain.reserve({ charges: { model_calls: 1 } }).allowed).toBe(false);
    expect(gate.ledger.used('model_calls')).toBe(plain.used('model_calls'));
  });

  it('10. 维度名不另造：映射结果全部落在既有 BUDGET_DIMENSIONS 内', () => {
    expect(LOOP_LIMIT_DIMENSIONS).toEqual({
      turns: 'model_calls',
      tool_calls: 'tool_calls',
      time: 'time',
    });
    for (const dimension of Object.values(LOOP_LIMIT_DIMENSIONS)) {
      expect(BUDGET_DIMENSIONS).toContain(dimension);
    }
    expect(loopLimitBudgets(DEFAULT_LOOP_LIMIT_SPEC)).toEqual({
      model_calls: 8,
      tool_calls: 16,
      time: 64,
    });
  });

  it('11. 介质如实：未注入流水时明说"不跨重启"，不冒充持久', () => {
    const volatileGate = createLoopLimitGate({ max_turns: 1, max_tool_calls: 1, max_time: 1 });
    const volatileMedium = volatileGate.medium();
    expect(volatileMedium.durable).toBe(false);
    expect(volatileMedium.detail).toContain('未注入用量流水');
    expect(volatileMedium.detail).toContain('未接线');

    const journalBacked = createLoopLimitGate(
      { max_turns: 1, max_tool_calls: 1, max_time: 1 },
      { journal: createMemoryJournal() },
    );
    expect(journalBacked.medium()).toEqual(createMemoryJournal().describe());
    expect(journalBacked.medium().durable).toBe(false); // 内存流水仍是易失：如实标注
    expect(journalBacked.describe()).toContain('模型调用');
  });
});
