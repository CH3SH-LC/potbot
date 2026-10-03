/**
 * FA-VERIFY-WAVE-4 · I-4 / I-5 闭环复核：
 * `src/workledger/action-state-alignment.ts` 的**映射**与**幂等键收口**是否真的生效。
 *
 * 关键判据（任务原文）：**同 `requestId` 不同 `revision` 不得被判为同一动作**。
 *
 * 验证方独立构造：
 * - I-4 正向：`checkActionStateAlignment()` 空问题、`confirmed ↔ confirmed_complete` 声明不等价。
 * - I-4 反向：任一侧多加一个状态 ⇒ 判据报错；结构等价计算与"硬映射谎报等价"不一致 ⇒ 判据报错。
 * - I-5 正向（注入版）：`createActionLedger(versionAwareClockLedgerOptions())` 下
 *   同 requestId、revision 1 vs 999 ⇒ **两个动作**（第二次 `duplicate: false`）。
 * - I-5 反向（默认版）：**不注入**时同 requestId、revision 1 vs 999 ⇒ `duplicate: true`
 *   且返回 **revision=1 的旧条目**——这是**不注入**时的口径，不再是生产口径。
 * - I-5 生产接线（源码级，**2026-10-03 修复后更新**）：三个生产调用点**均已注入**
 *   `versionAwareClockLedgerOptions()`（原断言固化的是"全部无参"的 I-5 接线缺陷）。
 * - N-2 修复后行为（**2026-10-03 更新**）：版本敏感的键把旧版本条目**显式取代**
 *   （`superseded: true`）并**移出** `activeCount()`，但条目本身**保留**，可经
 *   `supersededEntries()` 审计取回（原断言固化的是"旧版本条目永久留在 active、
 *   无 API 可达"的泄漏）。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_STATES as CLOCK_STATES,
  ACTION_STATE_LABELS as CLOCK_LABELS,
  createActionLedger,
  isTerminal,
  type ActionRequest,
} from '../../../src/adapters/clock/action-contract.js';
import {
  ACTION_STATES as LEDGER_STATES,
  ACTION_STATE_LABELS as LEDGER_LABELS,
} from '../../../src/workledger/action-ledger.js';
import {
  ACTION_STATE_ALIGNMENT,
  assertActionStateAlignment,
  assertEquivalentActionStates,
  checkActionStateAlignment,
  computeActionStateStructuralEquivalence,
  deriveClockLedgerKey,
  translateClockStateToWorkledger,
  translateWorkledgerStateToClock,
  versionAwareClockLedgerOptions,
} from '../../../src/workledger/action-state-alignment.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function req(requestId: string, revision: number, toolId = 'clock.set_alarm'): ActionRequest {
  return { requestId, toolId, revision };
}

// ---------------------------------------------------------------------------
// I-4：七态映射
// ---------------------------------------------------------------------------

describe('V4-I-4 · 七态映射（正向）', () => {
  it('两侧各七态，且对齐判据无问题', () => {
    expect([...CLOCK_STATES]).toHaveLength(7);
    expect([...LEDGER_STATES]).toHaveLength(7);
    expect(checkActionStateAlignment()).toEqual([]);
    expect(() => assertActionStateAlignment()).not.toThrow();
  });

  it('映射表是一对一且覆盖全部 14 个状态', () => {
    expect(ACTION_STATE_ALIGNMENT).toHaveLength(7);
    expect(new Set(ACTION_STATE_ALIGNMENT.map((entry) => entry.clock)).size).toBe(7);
    expect(new Set(ACTION_STATE_ALIGNMENT.map((entry) => entry.workledger)).size).toBe(7);
  });

  it('`confirmed ↔ confirmed_complete` 被声明为**不等价**（这正是 I-4 的分歧点）', () => {
    const translation = translateClockStateToWorkledger('confirmed');
    expect(translation.to).toBe('confirmed_complete');
    expect(translation.equivalent).toBe(false);
    expect(() => assertEquivalentActionStates('confirmed', 'confirmed_complete')).toThrow(/不等价/);
  });

  it('同义对（prepared / unknown / failed）可互译且断言通过', () => {
    for (const pair of [
      ['prepared', 'prepared'],
      ['unknown', 'result_unknown'],
      ['failed', 'invalidated_or_failed'],
    ] as const) {
      expect(() => assertEquivalentActionStates(pair[0], pair[1])).not.toThrow();
      expect(translateClockStateToWorkledger(pair[0]).equivalent).toBe(true);
      expect(translateWorkledgerStateToClock(pair[1]).equivalent).toBe(true);
    }
  });

  it('两侧中文标签逐位相同（分歧只在机器键名）', () => {
    for (const entry of ACTION_STATE_ALIGNMENT) {
      expect(CLOCK_LABELS[entry.clock]).toBe(LEDGER_LABELS[entry.workledger]);
      expect(translateClockStateToWorkledger(entry.clock).label).toBe(CLOCK_LABELS[entry.clock]);
    }
  });
});

describe('V4-I-4 · 反向对照：判据不是恒真', () => {
  it('clock 侧凭空多一个状态 ⇒ 判据报错（新增即失败）', () => {
    const problems = checkActionStateAlignment([...CLOCK_STATES, 'paused'], LEDGER_STATES);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/paused/);
    expect(() => assertActionStateAlignment([...CLOCK_STATES, 'paused'], LEDGER_STATES)).toThrow();
  });

  it('workledger 侧凭空多一个状态 ⇒ 判据报错', () => {
    const problems = checkActionStateAlignment(CLOCK_STATES, [...LEDGER_STATES, 'partially_done']);
    expect(problems.join('\n')).toMatch(/partially_done/);
  });

  it('结构等价计算**不恒真**：谎报 `confirmed ↔ confirmed_complete` 等价 ⇒ 计算出反例', () => {
    const lyingEntry = {
      clock: 'confirmed',
      workledger: 'confirmed_complete',
      equivalent: true,
      rationale: '验证方故意谎报为等价',
      differences: [],
    } as unknown as (typeof ACTION_STATE_ALIGNMENT)[number];
    const structural = computeActionStateStructuralEquivalence(lyingEntry);
    expect(structural.equivalent).toBe(false);
    expect(structural.reasons.length).toBeGreaterThan(0);
  });

  it('结构等价计算对真同义对返回等价（正向对照，防"恒 false"）', () => {
    const honest = ACTION_STATE_ALIGNMENT.find((entry) => entry.clock === 'prepared');
    expect(honest).toBeDefined();
    if (honest === undefined) return;
    expect(computeActionStateStructuralEquivalence(honest).equivalent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-5：幂等键
// ---------------------------------------------------------------------------

describe('V4-I-5 · 幂等键收口（注入版本敏感推导时）', () => {
  it('deriveClockLedgerKey：同 requestId、revision 1 vs 999 ⇒ **不同的键**', () => {
    const k1 = deriveClockLedgerKey(req('r-1', 1));
    const k999 = deriveClockLedgerKey(req('r-1', 999));
    expect(k1).not.toBe(k999);
    // 对照：同 requestId、同 revision ⇒ 同键（幂等仍然成立）。
    expect(deriveClockLedgerKey(req('r-1', 7))).toBe(deriveClockLedgerKey(req('r-1', 7)));
  });

  it('注入版本敏感推导后：同 requestId、不同 revision ⇒ 判为**两个动作**', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    const first = ledger.begin(req('r-1', 1), 100);
    const second = ledger.begin(req('r-1', 999), 101);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false); // ← 修复后的目标行为
    // 【原断言 → 新断言】原断言 `activeCount() === 2` 固化 **N-2 缺陷**（旧版本条目永久留在 active）。
    // 修复后 v1 被**显式取代**并移出 active ⇒ 只剩 v999 这条未决。取代逻辑被回退 ⇒ 此处重新变红。
    expect(ledger.activeCount()).toBe(1);
    // 事实保留：被取代的 v1 条目可经 `supersededEntries()` 取回（不是删除）。
    expect(ledger.supersededEntries().map((entry) => entry.request.revision)).toEqual([1]);
  });

  it('反向对照：注入版本敏感推导后，同 requestId **同** revision ⇒ 仍是同一动作', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    const a = ledger.begin(req('r-2', 5), 100);
    const b = ledger.begin(req('r-2', 5), 101);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.entry).toEqual(a.entry);
  });
});

describe('V4-I-5 · **不注入**时的口径：版本不参与判重（默认选项行为，非生产口径）', () => {
  it('createActionLedger() 无参：同 requestId、revision 1 vs 999 ⇒ duplicate 且返回旧条目', () => {
    const ledger = createActionLedger();
    const first = ledger.begin(req('r-3', 1), 100);
    const second = ledger.begin(req('r-3', 999), 101);
    expect(first.duplicate).toBe(false);
    // 这是**不注入**选项时的默认行为（未变）：第二个请求被判为重复，并拿到 revision=1 的旧条目。
    // 注：自 2026-10-03 起**生产调用点均已注入**（见下一条），故这只是"默认参数"的契约，不是生产口径。
    expect(second.duplicate).toBe(true);
    expect(second.entry.request.revision).toBe(1);
    expect(second.entry.request.revision).not.toBe(999);
    // 默认（不注入）台账**永不**触发取代路径 ⇒ 没有 superseded 条目（与注入版形成对照）。
    expect(ledger.supersededEntries()).toEqual([]);
  });

  it('生产调用点**均已注入** versionAwareClockLedgerOptions()（源码级）', () => {
    // 【原断言 → 新断言】原断言要求三个生产调用点全部无参（固化 I-5 接线缺陷：生产口径不校验版本）。
    // N-3/N-4 修复后三处**都注入了**版本敏感推导；任一处回退成无参 ⇒ 此用例重新变红。
    const sites = [
      'src/adapters/calendar/reconcile.ts',
      'src/adapters/meituan/handoff-verify.ts',
      'src/session/adapters/cal-clock.ts',
    ];
    for (const site of sites) {
      const text = readFileSync(join(REPO_ROOT, site), 'utf8');
      expect(text.includes('versionAwareClockLedgerOptions'), `${site} 未见版本敏感台账选项的引入`).toBe(true);
      const calls = [...text.matchAll(/createActionLedger\(([^)]*)\)/g)].map((match) => match[1] ?? '');
      expect(calls.length, `${site} 未见 createActionLedger 调用`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args, `${site} 的 createActionLedger 未注入版本敏感选项`).toContain('versionAwareClockLedgerOptions');
      }
    }
  });
});

describe('V4-I-5 · N-2 修复后：旧版本条目**移出 active 但事实保留**', () => {
  it('begin(v1) → begin(v999) → settle(requestId)：activeCount 归零，v1 可经 supersededEntries() 取回', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    ledger.begin(req('r-4', 1), 100);
    ledger.begin(req('r-4', 999), 101);
    // settle 以 requestId 为句柄，作用于**最近登记**的那条（v999）。
    ledger.settle('r-4', 'confirmed', 102);
    // 【原断言 → 新断言】原断言 `activeCount() === 1` 固化 **N-2 缺陷**：v1 从未被结算、
    // 且 get/settle 都够不到它 ⇒ 永久顶住 active（R261「无未决动作」恒为假）。
    // 修复后 v1 被**显式取代**并移出 active ⇒ 归零。取代逻辑被回退 ⇒ 此处重新变红。
    expect(ledger.activeCount()).toBe(0);
    expect(isTerminal(ledger.get('r-4')?.state ?? 'prepared')).toBe(true);
    // 事实保留（不是删除）：v1 被取代的条目可审计取回，原字段未丢。
    const superseded = ledger.supersededEntries();
    expect(superseded.map((entry) => entry.request.revision)).toEqual([1]);
    expect(superseded[0]?.request.requestId).toBe('r-4');
    expect(superseded[0]?.request.toolId).toBe('clock.set_alarm');
    expect(superseded[0]?.state).toBe('prepared');
    expect(superseded[0]?.supersededAtMs).toBe(101);
  });

  it('对照：不注入时**不会**产生 superseded 条目（取代是版本敏感台账独有路径）', () => {
    const ledger = createActionLedger();
    ledger.begin(req('r-5', 1), 100);
    ledger.settle('r-5', 'confirmed', 102);
    expect(ledger.activeCount()).toBe(0);
    // 默认台账同 requestId 只有一个键 ⇒ 永不触发取代路径。
    expect(ledger.supersededEntries()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 遗留：整份对齐模块在生产上**无消费者**；checkpoint 分类器仍不认 clock 词表
// ---------------------------------------------------------------------------

import { classifyActionState } from '../../../src/scheduler/checkpoint.js';

function listNonTestTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push(absolute);
    }
  };
  walk(root);
  return out;
}

describe('V4-I-4/I-5 · 遗留缺口（2026-10-03 修复后翻转）', () => {
  it('整份 `action-state-alignment` **确有**非测试消费者（N-3 已闭合）', () => {
    const symbols = [
      'translateClockStateToWorkledger',
      'translateWorkledgerStateToClock',
      'ACTION_STATE_ALIGNMENT',
      'assertActionStateAlignment',
      'checkActionStateAlignment',
      'deriveClockLedgerKey',
      'versionAwareClockLedgerOptions',
      'ACTION_STATE_DIFFERENCES',
    ];
    const consumers: string[] = [];
    for (const root of [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'apps')]) {
      if (statSync(root, { throwIfNoEntry: false }) === undefined) continue;
      for (const file of listNonTestTs(root)) {
        const rel = relative(REPO_ROOT, file).split(sep).join('/');
        // 模块自身与 barrel 再导出不算消费者。
        if (rel === 'src/workledger/action-state-alignment.ts') continue;
        if (rel === 'src/workledger/index.ts') continue;
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
          if (symbols.some((symbol) => trimmed.includes(symbol)) && !trimmed.startsWith('export')) {
            consumers.push(`${rel}: ${trimmed}`);
          }
        }
      }
    }
    // 【原断言 → 新断言】原断言 `consumers` 必须为空，固化 **N-3 缺陷**（整份对齐模块在生产上无消费者）。
    // N-3 修复后 `src/scheduler/checkpoint.ts` 消费映射/判据，三个生产调用点消费版本敏感选项。
    // 若有人把接线回退，下面按文件名的断言会重新变红。
    const consumerFiles = [...new Set(consumers.map((entry) => entry.slice(0, entry.indexOf(': '))))].sort();
    expect(consumerFiles).toContain('src/scheduler/checkpoint.ts');
    expect(consumerFiles).toContain('src/adapters/calendar/reconcile.ts');
    expect(consumerFiles).toContain('src/adapters/meituan/handoff-verify.ts');
    expect(consumerFiles).toContain('src/session/adapters/cal-clock.ts');
  });

  it('`checkpoint.classifyActionState` 现在**接受两侧词表**（N-4 已闭合）', () => {
    // 正向：workledger 词表的键可分类。
    expect(classifyActionState('confirmed_complete' as never)).toBe('committed');
    expect(classifyActionState('result_unknown' as never)).toBe('unknown');
    // 【原断言 → 新断言】原断言"clock 侧独有键名 ⇒ 抛"固化 **N-4 缺陷**（两词汇无法互操作）。
    // 修复后 clock 键名经权威映射表归口后**逐态正确归类**：
    expect(classifyActionState('prepared' as never)).toBe('in_flight');
    expect(classifyActionState('handed_off' as never)).toBe('unknown');
    expect(classifyActionState('submitted' as never)).toBe('unknown');
    expect(classifyActionState('confirmed' as never)).toBe('committed'); // 非等价项经显式裁决
    expect(classifyActionState('unknown' as never)).toBe('unknown');
    expect(classifyActionState('user_reported' as never)).toBe('unknown');
    expect(classifyActionState('failed' as never)).toBe('committed');
    // 保留反向对照（判据不恒真、不静默归并）：**两表都没有**的字符串仍必须**具名抛错**。
    expect(() => classifyActionState('paused' as never)).toThrow(/未分类的动作状态/);
  });
});
