/**
 * FA-VERIFY-WAVE-9 · 任务第 1 项 —— 前八轮问题的**逐条闭环复核**（运行时复现部分）。
 *
 * 判据独立于实现者：每条都用**验证方自造的输入 / 自造仓库 / 直接调用被测函数**复现，
 * 不引用实现者或其它验证轮的结论文字。只报告不修。
 *
 * 覆盖：I-1/N-1（记忆注入闸门）、I-3（回归判据独立性）、I-4/N-3/N-4（七态映射 + checkpoint
 * 分类器）、I-5/N-2/N-5（幂等键收口 + 旧版本泄漏）。
 * 其余条目（V-* / Q-* / B9 / 半截接线）见 T3。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { describe, expect, it } from 'vitest';

import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type MemoryEntry,
  type OwnerId,
  type SessionMessageMemory,
} from '../../../src/memory/types.js';
import { createMemoryRepository, type MemoryRepository } from '../../../src/memory/repository.js';
import {
  assertNotHistoryDump,
  auditRecallIsolation,
  buildInstanceRecallInjection,
  type InstanceRecallInjection,
} from '../../../src/memory/recall-limits.js';
import {
  createActionLedger,
  isTerminal,
  type ActionRequest,
} from '../../../src/adapters/clock/action-contract.js';
import { versionAwareClockLedgerOptions } from '../../../src/workledger/action-state-alignment.js';
import { classifyActionState, classifyActionStateDetailed } from '../../../src/scheduler/checkpoint.js';
import { verifyRegressionCriterion } from '../../../src/plugins/regression.js';

import { countCalls, codeOf, findReferences, nonTestFiles } from './source-probe.js';

const ROOT = process.cwd();
const OWNER: OwnerId = asOwnerId('w9-owner');

// ---------------------------------------------------------------------------
// I-1 / N-1 —— 记忆注入闸门「整份历史复制」
// ---------------------------------------------------------------------------

function sessionMessage(id: string, at: number, owner: OwnerId = OWNER): SessionMessageMemory {
  return createMemoryEntry({
    kind: 'session_message',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_statement', detail: 'w9 会话消息' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    conversation_id: 'w9-conv',
    role: 'user',
    text: `历史消息 ${id}`,
  }) as SessionMessageMemory;
}

/** 一个**无视**传入 `limits` 的仓库（模拟"上限没接到注入上"的违约通道）。 */
function ignoringLimitsRepository(entries: readonly MemoryEntry[]): MemoryRepository {
  const result = {
    status: 'found' as const,
    entries,
    total_matched: entries.length,
    truncated: false,
    limits: { max_items: 1_000_000, max_chars: 1_000_000 },
    detail: null,
  };
  return {
    recall: () => result,
    listByKind: () => entries,
  } as unknown as MemoryRepository;
}

describe('W9-I-1/N-1 · 「整份历史复制」闸门', () => {
  const request = (limits: { max_items: number; max_chars: number }) => ({
    owner_id: OWNER,
    instance_id: 'w9-inst',
    requested_limits: limits,
  });

  it('N-1：闸门承载函数**确有**非测试调用方（生产接线，源码级）', () => {
    const calls = countCalls(ROOT, ['buildInstanceRecallInjection', 'assertNotHistoryDump']);
    const files = [...new Set(calls.map((c) => c.file))].sort();
    // eslint-disable-next-line no-console
    console.log(`[W9 N-1] gate carriers in non-test code: ${files.join(', ')}`);
    expect(files).toContain('apps/demo/server/memory-routes.ts');
    expect(calls.some((c) => c.file === 'src/memory/recall-limits.ts')).toBe(true);
  });

  it('守约仓库 + 穷举上限：闸门恒不触发，且 injected ≤ limits.max_items', () => {
    const repo = createMemoryRepository();
    for (let i = 0; i < 30; i += 1) {
      expect(repo.remember(sessionMessage(`w9-honest-${String(i).padStart(3, '0')}`, i)).ok).toBe(true);
    }
    for (const max of [1, 5, 20, 50]) {
      const injection = buildInstanceRecallInjection(repo, request({ max_items: max, max_chars: 8000 }));
      expect(injection.audit.full_history_copy).toBe(false);
      expect(injection.included_ids.length).toBeLessThanOrEqual(max);
    }
  });

  it('违约仓库（recall 无视 limits）+ 声明上限 20 ⇒ 闸门**抛**（判据不恒假）', () => {
    const many: MemoryEntry[] = [];
    for (let i = 0; i < 300; i += 1) many.push(sessionMessage(`w9-bad-${String(i).padStart(3, '0')}`, i));
    const repo = ignoringLimitsRepository(many);
    expect(() => buildInstanceRecallInjection(repo, request({ max_items: 20, max_chars: 8000 }))).toThrow(
      /整份历史复制/,
    );
  });

  it('判据本体可两向：直接喂 injected 计数给 auditRecallIsolation（反向对照）', () => {
    const empty = { listByKind: () => [] } as unknown as MemoryRepository;
    const limits = { max_items: 20, max_chars: 8000 };
    expect(auditRecallIsolation(empty, { owner_id: OWNER, instance_id: 'x' }, 20, limits).full_history_copy).toBe(false);
    expect(auditRecallIsolation(empty, { owner_id: OWNER, instance_id: 'x' }, 21, limits).full_history_copy).toBe(true);
  });

  it('assertNotHistoryDump 对 full_history_copy=true 的注入必抛（判据非空操作）', () => {
    const crafted = {
      instance_id: 'x',
      limits: { max_items: 20, max_chars: 8000 },
      audit: { owner_visible_total: 300, injected: 21, full_history_copy: true },
    } as unknown as InstanceRecallInjection;
    expect(() => assertNotHistoryDump(crafted)).toThrow(/整份历史复制/);
  });
});

// ---------------------------------------------------------------------------
// I-3 —— 回归判据独立性
// ---------------------------------------------------------------------------

describe('W9-I-3 · 回归判据是否独立于产出矩阵', () => {
  it('正向：满足成功条件的观测 ⇒ passed 被认可', () => {
    const observed = {
      installed: true,
      enabled: true,
      authorized: true,
      dependencies_ready: true,
      actually_supported: true,
      ready: true,
      gate_ok: true,
    };
    expect(verifyRegressionCriterion('success', 'passed', observed).ok).toBe(true);
  });

  it('反向 1：五态不全却标 passed ⇒ 判据报错', () => {
    const observed = { installed: true, enabled: true, ready: true, gate_ok: true };
    expect(verifyRegressionCriterion('success', 'passed', observed).ok).toBe(false);
  });

  it('反向 2：观测值 `installed:false` 却标 passed ⇒ 判据报错（真读观测值）', () => {
    const observed = {
      installed: false,
      enabled: true,
      authorized: true,
      dependencies_ready: true,
      actually_supported: true,
      ready: true,
      gate_ok: true,
    };
    expect(verifyRegressionCriterion('success', 'passed', observed).ok).toBe(false);
  });

  it('反向 3：判据函数签名只有 3 参（拿不到 criterion 文本）', () => {
    expect(verifyRegressionCriterion.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// I-4 / N-3 / N-4 —— 七态映射 + checkpoint 分类器
// ---------------------------------------------------------------------------

describe('W9-I-4/N-4 · checkpoint 分类器是否接受两侧词表', () => {
  it('N-4：clock 侧独有键名**不再抛**，且逐态归类（含非等价项显式裁决）', () => {
    expect(classifyActionState('confirmed_complete')).toBe('committed');
    expect(classifyActionState('result_unknown')).toBe('unknown');
    // clock 侧（原缺陷：这四个键此前运行期抛「未分类的动作状态」）
    expect(classifyActionState('confirmed')).toBe('committed');
    expect(classifyActionState('unknown')).toBe('unknown');
    expect(classifyActionState('user_reported')).toBe('unknown');
    expect(classifyActionState('failed')).toBe('committed');
  });

  it('`confirmed` 的落点带**显式裁决**标记（不是静默等价翻译）', () => {
    const detail = classifyActionStateDetailed('confirmed');
    expect(detail.side).toBe('clock');
    expect(detail.equivalent).toBe(false);
    expect(detail.adjudication).not.toBeNull();
    // 反向对照：两侧都不认的字符串仍必须**具名抛错**（不静默归并）。
    expect(() => classifyActionState('paused')).toThrow(/未分类的动作状态/);
  });

  it('N-3：`action-state-alignment` 模块**确有**非测试消费者（checkpoint.ts）', () => {
    const refs = findReferences(ROOT, [
      'checkActionStateAlignment',
      'translateClockStateToWorkledger',
      'CLOCK_ACTION_STATES',
      'WORKLEDGER_ACTION_STATES',
      'versionAwareClockLedgerOptions',
    ]);
    const files = [...new Set(refs.map((r) => r.file))].sort();
    // eslint-disable-next-line no-console
    console.log(`[W9 N-3] alignment consumers: ${files.join(', ')}`);
    expect(files).toContain('src/scheduler/checkpoint.ts');
  });
});

// ---------------------------------------------------------------------------
// I-5 / N-2 / N-5 —— 幂等键收口
// ---------------------------------------------------------------------------

function req(requestId: string, revision: number, toolId = 'clock.set_alarm'): ActionRequest {
  return { requestId, toolId, revision };
}

describe('W9-I-5/N-2 · 幂等键与旧版本条目', () => {
  it('I-5：注入版本敏感推导 ⇒ 同 requestId 不同 revision 判为两个动作', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    expect(ledger.begin(req('w9-r', 1), 100).duplicate).toBe(false);
    expect(ledger.begin(req('w9-r', 999), 101).duplicate).toBe(false);
  });

  it('I-5：同 requestId 同 revision 仍是同一动作（幂等未被破坏）', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    expect(ledger.begin(req('w9-s', 7), 100).duplicate).toBe(false);
    expect(ledger.begin(req('w9-s', 7), 101).duplicate).toBe(true);
  });

  it('N-2：begin(v1)→begin(v999)→settle ⇒ activeCount 归零，v1 经 supersededEntries 可审计取回', () => {
    const ledger = createActionLedger(versionAwareClockLedgerOptions());
    ledger.begin(req('w9-t', 1), 100);
    ledger.begin(req('w9-t', 999), 101);
    // 两次 begin 后：v1 被显式取代 ⇒ 只剩 v999 未决（不是 2）。
    expect(ledger.activeCount()).toBe(1);
    ledger.settle('w9-t', 'confirmed', 102);
    // 原 N-2 缺陷：settle 只作用于最近条目，v1 永久留在 active ⇒ 恒 ≥1。修复后归零。
    expect(ledger.activeCount()).toBe(0);
    expect(isTerminal(ledger.get('w9-t')?.state ?? 'prepared')).toBe(true);
    expect(ledger.supersededEntries().map((e) => e.request.revision)).toEqual([1]);
  });

  it('N-5：默认（不注入）台账仍不校验版本 —— 但**生产调用点已无一处**使用默认口径', () => {
    const ledger = createActionLedger();
    expect(ledger.begin(req('w9-u', 1), 100).duplicate).toBe(false);
    const second = ledger.begin(req('w9-u', 999), 101);
    expect(second.duplicate).toBe(true);
    expect(second.entry.request.revision).toBe(1);

    // 生产接线（源码级，验证方自读）：三个调用点都注入了版本敏感选项。
    for (const site of [
      'src/adapters/calendar/reconcile.ts',
      'src/adapters/meituan/handoff-verify.ts',
      'src/session/adapters/cal-clock.ts',
    ]) {
      const code = codeOf(ROOT, site);
      expect(code, `${site} 未见 versionAwareClockLedgerOptions`).toContain('versionAwareClockLedgerOptions');
      const args = [...code.matchAll(/createActionLedger\(([^)]*)\)/g)].map((m) => m[1] ?? '');
      expect(args.length, `${site} 未见 createActionLedger(`).toBeGreaterThan(0);
      for (const a of args) expect(a, `${site} 的 createActionLedger 未注入选项`).toContain('versionAwareClockLedgerOptions');
    }
  });
});

// ---------------------------------------------------------------------------
// nonTestFiles 卫生检查（防"扫描器扫空集"的假绿）
// ---------------------------------------------------------------------------

describe('W9 · 扫描器自证', () => {
  it('非测试文件集非空且含关键文件', () => {
    const files = nonTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('src/scheduler/checkpoint.ts');
    expect(files).toContain('apps/demo/server/http.ts');
  });
});
