/**
 * 跨包动作状态对齐的用例（FA-UNIFY-ACTION-STATES；FA-VERIFY-WAVE **I-4 / I-5**）。
 *
 * 重点在**可失败的对照**：映射表不是恒真——不等价对必须被报成不等价，
 * 一侧新增状态必须让判据**失败**，版本不同必须产生不同幂等键。
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_STATE_ALIGNMENT,
  ACTION_STATE_DIFFERENCES,
  CLOCK_ACTION_STATES,
  WORKLEDGER_ACTION_STATES,
  assertActionStateAlignment,
  assertEquivalentActionStates,
  checkActionStateAlignment,
  computeActionStateStructuralEquivalence,
  deriveClockLedgerKey,
  translateClockStateToWorkledger,
  translateWorkledgerStateToClock,
  versionAwareClockLedgerOptions,
} from './action-state-alignment.js';
import { ACTION_STATE_LABELS as WORKLEDGER_LABELS } from './action-ledger.js';
import { ACTION_STATE_LABELS as CLOCK_LABELS, createActionLedger } from '../adapters/clock/action-contract.js';

describe('I-4：映射表覆盖两侧全部七态（双向、一对一）', () => {
  it('两侧各恰好 7 态，映射表恰好 7 对', () => {
    expect(CLOCK_ACTION_STATES).toHaveLength(7);
    expect(WORKLEDGER_ACTION_STATES).toHaveLength(7);
    expect(ACTION_STATE_ALIGNMENT).toHaveLength(7);
  });

  it('每对的中文标签逐字相同（这是"键名不同、标签相同"的事实基础）', () => {
    for (const entry of ACTION_STATE_ALIGNMENT) {
      expect(CLOCK_LABELS[entry.clock]).toBe(WORKLEDGER_LABELS[entry.workledger]);
    }
  });

  it('当前代码下判据通过（对齐成立）', () => {
    expect(checkActionStateAlignment()).toEqual([]);
    expect(() => assertActionStateAlignment()).not.toThrow();
  });
});

describe('I-4：新增即失败（不静默忽略）', () => {
  it('clock 侧多出一个状态 ⇒ 判据报「新增即失败」', () => {
    const problems = checkActionStateAlignment([...CLOCK_ACTION_STATES, 'paused'], WORKLEDGER_ACTION_STATES);
    expect(problems.some((text) => text.includes('新增即失败') && text.includes('paused'))).toBe(true);
    expect(() => assertActionStateAlignment([...CLOCK_ACTION_STATES, 'paused'], WORKLEDGER_ACTION_STATES)).toThrow(
      /新增即失败/,
    );
  });

  it('workledger 侧多出一个状态 ⇒ 判据报「新增即失败」', () => {
    const problems = checkActionStateAlignment(CLOCK_ACTION_STATES, [...WORKLEDGER_ACTION_STATES, 'partially_done']);
    expect(
      problems.some((text) => text.includes('新增即失败') && text.includes('partially_done')),
    ).toBe(true);
  });

  it('某侧**删除/改名**一个状态 ⇒ 也失败（映射表引用了不存在的状态）', () => {
    const problems = checkActionStateAlignment(
      CLOCK_ACTION_STATES.filter((state) => state !== 'confirmed'),
      WORKLEDGER_ACTION_STATES,
    );
    expect(problems.some((text) => text.includes('clock 侧不存在的状态：confirmed'))).toBe(true);
  });
});

describe('I-4：反向对照——不等价的两项必须报不等价（不是恒真）', () => {
  it('唯一不等价的是「已确认完成」这一对：可废止 vs 死终态', () => {
    const nonEquivalent = ACTION_STATE_ALIGNMENT.filter((entry) => !entry.equivalent);
    expect(nonEquivalent.map((entry) => [entry.clock, entry.workledger])).toEqual([
      ['confirmed', 'confirmed_complete'],
    ]);
  });

  it('结构计算（读两侧真实导出）同意这一对不等价，且理由指向**出边集合**', () => {
    const entry = ACTION_STATE_ALIGNMENT.find((candidate) => candidate.clock === 'confirmed')!;
    const structural = computeActionStateStructuralEquivalence(entry);
    expect(structural.equivalent).toBe(false);
    expect(structural.reasons.some((text) => text.includes('出边集合不同'))).toBe(true);
    // clock 的 confirmed 可被 expired 废止；workledger 的 confirmed_complete 无出边。
    expect(structural.reasons.join(' ')).toContain('invalidated_or_failed');
  });

  it('同义对（已准备）结构计算判等价——证明判据**不是恒真**', () => {
    const entry = ACTION_STATE_ALIGNMENT.find((candidate) => candidate.clock === 'prepared')!;
    expect(computeActionStateStructuralEquivalence(entry)).toEqual({ equivalent: true, reasons: [] });
  });

  it('assertEquivalentActionStates：同义对通过，非同义对抛错', () => {
    expect(() => assertEquivalentActionStates('prepared', 'prepared')).not.toThrow();
    expect(() => assertEquivalentActionStates('confirmed', 'confirmed_complete')).toThrow(/不等价/);
  });

  it('双向映射带等价标记（不硬映射）', () => {
    expect(translateClockStateToWorkledger('confirmed')).toMatchObject({
      from: 'confirmed',
      to: 'confirmed_complete',
      equivalent: false,
    });
    expect(translateWorkledgerStateToClock('confirmed_complete')).toMatchObject({
      from: 'confirmed_complete',
      to: 'confirmed',
      equivalent: false,
    });
    expect(translateClockStateToWorkledger('unknown')).toMatchObject({
      to: 'result_unknown',
      equivalent: true,
    });
  });

  it('未登记的状态无法互译（新增状态不可能静默通过）', () => {
    const unknown = 'paused' as unknown as Parameters<typeof translateClockStateToWorkledger>[0];
    expect(() => translateClockStateToWorkledger(unknown)).toThrow(/未登记映射/);
  });

  it('差异登记表：confirmed 对是「语义」差异，user_reported 对是「严格度」差异', () => {
    const confirmed = ACTION_STATE_DIFFERENCES.find((d) => d.clock === 'confirmed');
    expect(confirmed?.kind).toBe('meaning');
    expect(confirmed?.pair_equivalent).toBe(false);
    expect(confirmed?.recommendation.length ?? 0).toBeGreaterThan(0);

    const userReported = ACTION_STATE_DIFFERENCES.find((d) => d.clock === 'user_reported');
    expect(userReported?.kind).toBe('strictness');
    expect(userReported?.pair_equivalent).toBe(true);
  });
});

describe('I-5：幂等键收口——版本不同必须产生不同键', () => {
  const base = { requestId: 'req-alarm-1', toolId: 'clock.set_alarm' };

  it('同 requestId、revision 1 vs 999 ⇒ 不同幂等键', () => {
    const keyV1 = deriveClockLedgerKey({ ...base, revision: 1 });
    const keyV999 = deriveClockLedgerKey({ ...base, revision: 999 });
    expect(keyV1).not.toBe(keyV999);
  });

  it('同 requestId、同 revision ⇒ 同幂等键（重复点击仍应命中）', () => {
    expect(deriveClockLedgerKey({ ...base, revision: 3 })).toBe(deriveClockLedgerKey({ ...base, revision: 3 }));
  });

  it('不同 toolId ⇒ 不同幂等键', () => {
    expect(deriveClockLedgerKey({ ...base, revision: 1 })).not.toBe(
      deriveClockLedgerKey({ requestId: base.requestId, toolId: 'clock.dismiss_ringing_alarm', revision: 1 }),
    );
  });

  it('**修复后对照**：注入版本敏感推导后，同 requestId 的 revision 1 vs 999 不被判为同一动作', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    const first = ledger.begin({ ...base, revision: 1 }, 1000);
    expect(first.duplicate).toBe(false);
    expect(first.entry.request.revision).toBe(1);

    const second = ledger.begin({ ...base, revision: 999 }, 2000);
    expect(second.duplicate).toBe(false); // 修复前此处为 true，且返回 revision=1 的旧条目
    expect(second.entry.request.revision).toBe(999);
    expect(second.entry).not.toBe(first.entry);
    // 【原断言 → 新断言】原断言 `activeCount() === 2` 固化的是 **N-2 缺陷**：旧版本（v1）条目
    // 被版本敏感键判成"另一个动作"后**永久留在 active** 且无 API 可达 ⇒ R261「无未决动作」恒为假。
    // N-2 修复后：v1 被**显式取代**（superseded）并移出 active 计数，故只剩 v999 这条未决。
    // 若取代逻辑被回退（旧条目重新计入 active），此处会重新变红。
    expect(ledger.activeCount()).toBe(1);
    // 事实仍保留：被取代的 v1 条目可经 `supersededEntries()` 取回，且其原字段一个未丢
    // （"只是移出 active，不是删除/改写历史"）。
    const superseded = ledger.supersededEntries();
    expect(superseded.map((entry) => entry.request.revision)).toEqual([1]);
    expect(superseded[0]?.superseded).toBe(true);
    expect(superseded[0]?.request.requestId).toBe(base.requestId);
    expect(superseded[0]?.request.toolId).toBe(base.toolId);
    expect(superseded[0]?.state).toBe('prepared');
  });

  it('注入后，同 requestId 同 revision 的重复点击仍命中同一对象', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    const first = ledger.begin({ ...base, revision: 3 }, 1000);
    const again = ledger.begin({ ...base, revision: 3 }, 1500);
    expect(again.duplicate).toBe(true);
    expect(again.entry).toBe(first.entry);
    expect(ledger.activeCount()).toBe(1);
  });
});
