/**
 * FA-VERIFY-WAVE-2 · 第二轮跨包一致性复算
 *
 * 复算四类跨包口径：① 七态动作状态；② 事实版本比较；③ 幂等键；④ `reverted` / `confirmed` 语义。
 * 另附**时间来源**结论（墙钟扫描见报告 §时间来源）。
 *
 * 全部断言由验证方独立构造输入，不复用实现者用例。
 */

import { describe, expect, it } from 'vitest';

import type { Revision, TaskId } from '../../../src/protocol/index.js';
import {
  ACTION_STATES as CLOCK_STATES,
  ACTION_STATE_LABELS as CLOCK_LABELS,
  createActionLedger,
} from '../../../src/adapters/clock/action-contract.js';
import {
  ACTION_STATES as LEDGER_STATES,
  ACTION_STATE_LABELS as LEDGER_LABELS,
  deriveIdempotencyKey,
} from '../../../src/workledger/action-ledger.js';
import { classifyActionState } from '../../../src/scheduler/checkpoint.js';
import type { LateResultGateVerdict } from '../../../src/scheduler/late-result-gate.js';
import type { LateResultRecord } from '../../../src/scheduler/task-lifecycle.js';
import { isInstructionStale, type FactChangeBinding } from '../../../src/facts/dependency-invalidation.js';

type Exactly<V, T> = [T] extends [V] ? ([V] extends [T] ? true : false) : false;

// ---------------------------------------------------------------------------
// ① 七态动作状态（R242）
// ---------------------------------------------------------------------------

describe('跨包一致性 · 七态动作状态（R242）', () => {
  it('两份 ACTION_STATES 的**机器键名不同**（集合不相等）', () => {
    expect([...CLOCK_STATES]).toHaveLength(7);
    expect([...LEDGER_STATES]).toHaveLength(7);
    expect([...CLOCK_STATES].sort()).not.toEqual([...LEDGER_STATES].sort());
  });

  it('中文标签逐位相同、机器键名不同（分歧被标签掩盖）', () => {
    expect(CLOCK_LABELS['confirmed']).toBe(LEDGER_LABELS['confirmed_complete']);
    expect(CLOCK_LABELS['unknown']).toBe(LEDGER_LABELS['result_unknown']);
    expect(CLOCK_LABELS['user_reported']).toBe(LEDGER_LABELS['user_reported_complete']);
    expect(CLOCK_LABELS['failed']).toBe(LEDGER_LABELS['invalidated_or_failed']);
    // 反向：clock 的词表里不存在 workledger 的键，反之亦然
    expect((CLOCK_STATES as readonly string[]).includes('confirmed_complete')).toBe(false);
    expect((LEDGER_STATES as readonly string[]).includes('confirmed')).toBe(false);
  });

  it('（N-4 修复后）checkpoint 分类器**接受两侧词表**：clock 键名逐态正确归类；两表都不认的字符串仍具名抛错', () => {
    // 【原断言 → 新断言】原断言"喂 clock 键 ⇒ 抛（两词汇无法互操作）"固化 **N-4 缺陷**。
    // 修复后 clock 键名经 `translateClockStateToWorkledger()` 归口后**正确落到对应档**：
    expect(classifyActionState('confirmed_complete')).toBe('committed');
    expect(classifyActionState('confirmed' as never)).toBe('committed');
    expect(classifyActionState('unknown' as never)).toBe('unknown');
    expect(classifyActionState('result_unknown')).toBe('unknown');
    expect(classifyActionState('user_reported' as never)).toBe('unknown');
    expect(classifyActionState('failed' as never)).toBe('committed');
    expect(classifyActionState('prepared' as never)).toBe('in_flight');
    // 保留反向对照（判据不恒真）：**两侧词表都没有**的字符串仍必须具名抛错，不静默归并。
    // 若有人把 clock 词表从分类器里摘掉，上面几条会重新变红；若有人放宽成"未知即默认档"，这条会变红。
    expect(() => classifyActionState('paused' as never)).toThrow(/未分类的动作状态/);
  });
});

// ---------------------------------------------------------------------------
// ② 事实版本比较口径
// ---------------------------------------------------------------------------

describe('跨包一致性 · 事实版本比较', () => {
  const binding = (declared: number, current: number | undefined): FactChangeBinding => ({
    instruction_id: 'i1',
    utterance: '',
    task_id: 't1' as TaskId,
    task_revision: declared as Revision,
    ...(current === undefined ? {} : { current_task_revision: current as Revision }),
    at: 1 as never,
  });

  it('dependency-invalidation：**任何**不等于当前版本（含"超前"）都算过期', () => {
    expect(isInstructionStale(binding(3, 3))).toBe(false);
    expect(isInstructionStale(binding(3, 4))).toBe(true); // 落后 ⇒ 过期
    // 观察：**超前**也被判过期（口径 = `!==`，不区分方向）
    expect(isInstructionStale(binding(5, 3))).toBe(true);
    expect(isInstructionStale(binding(3, undefined))).toBe(false); // 未给 current ⇒ 不判
  });

  it('口径差异（观察）：同一"超前版本"在别处被当作**可用**——同一仓内 ≥3 种比较口径', () => {
    // facts/multi-artifact-update.ts:236 只拒 `to_revision < from_revision`（允许向前跳）
    // inbox/snapshot.ts:171 用 `declaredRevision >= current`（超前视为合格）
    // facts/dependency-invalidation.ts:107 用 `!==`（超前视为过期）
    // 本用例把"超前"这一输入固化，作为三条口径分歧的可复现锚点。
    const ahead = 5;
    const current = 3;
    expect(ahead > current).toBe(true);
    expect(isInstructionStale(binding(ahead, current))).toBe(true); // 此处判过期
    // （其余两处仅以源码为据，未在本文件内运行时复算；见报告 §2 具名列出）
  });
});

// ---------------------------------------------------------------------------
// ③ 幂等键
// ---------------------------------------------------------------------------

describe('跨包一致性 · 幂等键', () => {
  it('workledger：键含参数摘要与任务版本 ⇒ 参数变 / 版本变都产生新键', () => {
    const base = { task_id: 't' as TaskId, task_revision: 1 as Revision, action_kind: 'send' };
    const k1 = deriveIdempotencyKey({ ...base, param_digest: 'p1' });
    const k2 = deriveIdempotencyKey({ ...base, param_digest: 'p2' });
    const k3 = deriveIdempotencyKey({ ...base, task_revision: 2 as Revision, param_digest: 'p1' });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1.startsWith('act1:')).toBe(true);
  });

  it('反向对照：clock 台账**只按 requestId 去重**——revision 变了仍返回旧条目', () => {
    const ledger = createActionLedger();
    const first = ledger.begin({ requestId: 'req-1', toolId: 't', revision: 1 }, 100);
    const second = ledger.begin({ requestId: 'req-1', toolId: 't', revision: 999 }, 200);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.entry.request.revision).toBe(1); // 旧 revision 被复用，参数版本未参与键
  });

  it('结论：两套"幂等键"对"同键不同参数"给出相反答案（一为拒、一为静默复用）', () => {
    // workledger 的守护函数（assertIdempotencyKeyConsistent）对同键不同参数判 idempotency_key_mismatch；
    // clock 台账对同 requestId 不同 revision 判 duplicate —— 本用例只固化这一差异，不判优劣。
    const k1 = deriveIdempotencyKey({ task_id: 't' as TaskId, task_revision: 1 as Revision, action_kind: 'send', param_digest: 'a' });
    const k2 = deriveIdempotencyKey({ task_id: 't' as TaskId, task_revision: 1 as Revision, action_kind: 'send', param_digest: 'b' });
    expect(k1).not.toBe(k2);
    const ledger = createActionLedger();
    ledger.begin({ requestId: 'K', toolId: 't', revision: 1 }, 1);
    expect(ledger.begin({ requestId: 'K', toolId: 't', revision: 1 }, 2).duplicate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ④ reverted / confirmed 语义
// ---------------------------------------------------------------------------

describe('跨包一致性 · reverted / confirmed 语义', () => {
  it('reverted 唯一来源是字面量 false ⇒ 全仓"从未撤销"是类型不变式', () => {
    const literalFalse: Exactly<LateResultRecord['honored_as_success'], false> = true;
    expect(literalFalse).toBe(true);
  });

  // **2026-10-03 协调者更新（V-3 处置后）**：本探针原先钉住"同名不同型"这一**缺陷本身**。
  // 缺陷已处置（verdict 上冗余且取值恒等的 `honored_as_success` 已删除，发布决定由 `publish` 承担），
  // 探针随之改为钉住**修好之后的不变量**：记录层仍是字面量 false，且 verdict 上**不得**再出现该名字。
  it('（V-3 处置后）honored_as_success 在 `LateResultRecord` 仍是字面量 false；verdict 上已无此字段', () => {
    type HasKey<T, K extends string> = K extends keyof T ? true : false;
    const recordIsLiteralFalse: Exactly<LateResultRecord['honored_as_success'], false> = true;
    // 若日后有人把同名字段加回 verdict，下面这行**编译**失败——这才是本条探针要守的东西。
    const verdictHasNoHonoredAsSuccess: HasKey<LateResultGateVerdict, 'honored_as_success'> = false;
    const publishIsBoolean: Exactly<LateResultGateVerdict['publish'], boolean> = true;
    expect([recordIsLiteralFalse, verdictHasNoHonoredAsSuccess, publishIsBoolean]).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('confirmed 出口语义不同：clock 的 confirmed 可经 expired 废止；workledger 的 confirmed_complete 无出口（此前轮已具名）', () => {
    // 仅固化键名/语义差异（源码证据见报告 §2 I-4），本文件不重复其正向用例
    expect(CLOCK_LABELS['confirmed']).toBe('已确认完成');
    expect(LEDGER_LABELS['confirmed_complete']).toBe('已确认完成');
    expect((CLOCK_STATES as readonly string[]).includes('failed')).toBe(true);
    expect((LEDGER_STATES as readonly string[]).includes('invalidated_or_failed')).toBe(true);
  });
});
