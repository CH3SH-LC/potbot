/**
 * FA-VERIFY-WAVE-2 · 第二轮独立验证：调度域（第一轮**未覆盖**的模块）
 *
 * 覆盖模块：`scheduler/constrained-response`、`revocation`、`authorization-provenance`、
 * `checkpoint`、`id-clock-continuity`、`event-log`、`loop-limits`、`permission-check`。
 *
 * 输入由验证方自造；不复用实现者 fixture。**跨进程 / 真实崩溃恢复一律未实测**——
 * 本文件只做同进程纯逻辑复算。
 */

import { describe, expect, it } from 'vitest';

import type {
  EventId,
  KernelEvent,
  LogicalTime,
  PendingEvent,
  StoreSnapshot,
  TaskId,
} from '../../../src/protocol/index.js';
import {
  createToolCatalog,
  mustAcceptResponse,
  parseConstrainedResponse,
  type ToolSpec,
} from '../../../src/scheduler/constrained-response.js';
import {
  activeRevocationFor,
  evaluateRevocation,
  isCallRecalled,
  resolveAuthorizationValidity,
  revocationEffectOnCall,
  revokeAuthorization,
  type RevocationLedger,
} from '../../../src/scheduler/revocation.js';
import {
  authorizationState,
  grantAuthorization,
  grantCovers,
  latestAuthorization,
  narrowAuthorization,
  normalizeScope,
  traceProvenance,
  type AuthorizationRegistry,
} from '../../../src/scheduler/authorization-provenance.js';
import {
  CHECKPOINT_CLASSES,
  classifyActionState,
  classifyRunStatus,
  planCheckpointRestore,
  type WorkCheckpoint,
} from '../../../src/scheduler/checkpoint.js';
import {
  assertClockResumed,
  assertHighWaterMonotonic,
  mergeHighWater,
  numericSuffix,
  observedHighWater,
  planIdContinuity,
  resumeTimeAfter,
} from '../../../src/scheduler/id-clock-continuity.js';
import { checkSaveBeforeDeliver, detectEventIdGaps } from '../../../src/scheduler/event-log.js';
import { createLoopLimitGate, validateLoopLimitSpec } from '../../../src/scheduler/loop-limits.js';
import {
  callerEffectivePermissions,
  checkToolCall,
  detectDelegationEscalation,
  recordUntrustedApprovalClaim,
  type Delegation,
  type PermissionContext,
} from '../../../src/scheduler/permission-check.js';

const T = (value: number): LogicalTime => value as LogicalTime;

function kernelEvent(id: string, at: number, taskId: string | null): KernelEvent {
  return {
    event_id: id as EventId,
    kind: 'message_accepted',
    at: T(at),
    task_id: taskId === null ? null : (taskId as TaskId),
    group_id: null,
    instance_id: null,
    message_id: null,
    run_id: null,
    request_id: null,
    rejection_reason: null,
    data: {},
  };
}

function pendingEvent(id: string, taskId: string, createdAt: number, deliveredAt: number | null): PendingEvent {
  return {
    event_id: id as EventId,
    kind: 'wakeup' as PendingEvent['kind'],
    task_id: taskId as TaskId,
    group_id: 'g1' as PendingEvent['group_id'],
    instance_id: 'i1' as PendingEvent['instance_id'],
    created_at: T(createdAt),
    reason: '',
    payload: {},
    delivered: deliveredAt !== null,
    delivered_at: deliveredAt === null ? null : T(deliveredAt),
  };
}

// ===========================================================================
// 1. constrained-response —— 自由文本绝不执行
// ===========================================================================

const SUM_TOOL: ToolSpec = {
  tool_id: 'calc.add',
  summary: 'add',
  parameters: [
    { name: 'a', type: 'number', required: true, description: 'a', minimum: 0, maximum: 100 },
    { name: 'mode', type: 'string', required: false, description: 'm', enum_values: ['fast', 'slow'] },
  ],
};

describe('独立验证 · scheduler/constrained-response', () => {
  const catalog = createToolCatalog([SUM_TOOL]);

  it('正向：合法动作只是**待执行请求**（executed 恒 false）；合法回答可读', () => {
    const ok = parseConstrainedResponse('{"kind":"action","tool":"calc.add","arguments":{"a":3}}', catalog);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.executed).toBe(false);
      expect(ok.response.kind).toBe('action');
      expect(mustAcceptResponse(ok)).toBeDefined();
    }
    const answer = parseConstrainedResponse({ kind: 'answer', text: 'done' }, catalog);
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(answer.response.kind).toBe('answer');
  });

  it('反向对照 A：自由文本 / 坏 JSON / 非对象 ⇒ 各自具名拒，且不执行', () => {
    const free = parseConstrainedResponse('帮我查天气', catalog);
    expect(free).toMatchObject({ ok: false, accepted: false, executed: false, code: 'free_text_not_action' });
    const bad = parseConstrainedResponse('{ not json', catalog);
    expect(bad).toMatchObject({ ok: false, code: 'malformed_json' });
    const arr = parseConstrainedResponse([1, 2], catalog);
    expect(arr).toMatchObject({ ok: false, code: 'not_an_object' });
    expect(() => mustAcceptResponse(free)).toThrow();
  });

  it('反向对照 B：未知工具 / 多余字段 / 多余参数 / 越界 / 枚举违约 各自具名', () => {
    expect(parseConstrainedResponse('{"kind":"action","tool":"nope","arguments":{}}', catalog)).toMatchObject({ code: 'unknown_tool' });
    expect(parseConstrainedResponse('{"kind":"action","tool":"calc.add","arguments":{"a":1},"x":1}', catalog)).toMatchObject({
      code: 'unknown_envelope_field',
    });
    expect(parseConstrainedResponse('{"kind":"action","tool":"calc.add","arguments":{"a":1,"b":2}}', catalog)).toMatchObject({
      code: 'unknown_argument',
    });
    expect(parseConstrainedResponse('{"kind":"action","tool":"calc.add","arguments":{"a":999}}', catalog)).toMatchObject({
      code: 'argument_out_of_range',
    });
    expect(parseConstrainedResponse('{"kind":"action","tool":"calc.add","arguments":{"a":1,"mode":"x"}}', catalog)).toMatchObject({
      code: 'argument_enum_violation',
    });
    expect(parseConstrainedResponse('{"kind":"action","tool":"calc.add","arguments":{}}', catalog)).toMatchObject({
      code: 'missing_required_argument',
    });
    // 空回答不是回答
    expect(parseConstrainedResponse({ kind: 'answer', text: '   ' }, catalog)).toMatchObject({ code: 'empty_answer_text' });
  });

  it('反向对照 C：目录自身不自洽（重名 / 区间颠倒）⇒ 建目录即抛', () => {
    expect(() => createToolCatalog([SUM_TOOL, SUM_TOOL])).toThrow(/重复/);
    expect(() =>
      createToolCatalog([
        { tool_id: 't', summary: '', parameters: [{ name: 'p', type: 'number', required: true, description: '', minimum: 5, maximum: 1 }] },
      ]),
    ).toThrow(/区间颠倒/);
  });
});

// ===========================================================================
// 2. revocation —— 撤权是权威状态
// ===========================================================================

describe('独立验证 · scheduler/revocation', () => {
  const ledger: RevocationLedger = [revokeAuthorization({ revocation_id: 'r1', grant_id: 'g1', revoked_at: T(10), authority: 'user', authority_ref: 'u' })];

  it('正向：撤权盖过缓存与未过期令牌', () => {
    const validity = resolveAuthorizationValidity('g1', {
      ledger,
      cache: { grant_id: 'g1', cached_valid: true, cached_at: T(1), token_expires_at: T(999) },
      now: T(20),
    });
    expect(validity).toMatchObject({ valid: false, state: 'revoked', source_of_truth: 'revocation' });
  });

  it('反向对照 A：撤权之前发出的调用不追回（predates）；之后 ⇒ denied', () => {
    expect(revocationEffectOnCall(T(10), T(9))).toBe('predates');
    expect(revocationEffectOnCall(T(10), T(10))).toBe('denied'); // 同刻即拒
    expect(isCallRecalled()).toBe(false);
  });

  it('反向对照 B：不可信权威撤权 ⇒ 抛；外部撤权不改变状态', () => {
    expect(() =>
      revokeAuthorization({ revocation_id: 'r2', grant_id: 'g1', revoked_at: T(5), authority: 'external', authority_ref: 'page' }),
    ).toThrow(/无权撤权/);
    // 只有 external 撤权的台账 ⇒ 不生效
    const fake: RevocationLedger = [
      { revocation_id: 'r3', grant_id: 'g2', revoked_at: T(5), authority: 'external', authority_ref: 'page', reason: '' },
    ];
    expect(activeRevocationFor(fake, 'g2', T(99))).toBeUndefined();
    expect(evaluateRevocation(fake, 'g2', T(99)).revoked).toBe(false);
  });

  it('反向对照 C：无撤权但有失效缓存 ⇒ cache_invalid / token_expired', () => {
    const invalid = resolveAuthorizationValidity('g3', {
      ledger: [],
      cache: { grant_id: 'g3', cached_valid: false, cached_at: T(1), token_expires_at: null },
      now: T(2),
    });
    expect(invalid.state).toBe('cache_invalid');
    const expired = resolveAuthorizationValidity('g3', {
      ledger: [],
      cache: { grant_id: 'g3', cached_valid: true, cached_at: T(1), token_expires_at: T(5) },
      now: T(5),
    });
    expect(expired.state).toBe('token_expired');
    expect(resolveAuthorizationValidity('g4', { ledger: [], now: T(1) })).toMatchObject({ valid: true, state: 'active', source_of_truth: 'none' });
  });
});

// ===========================================================================
// 3. authorization-provenance —— 只许收窄
// ===========================================================================

describe('独立验证 · scheduler/authorization-provenance', () => {
  it('正向：授予 / 过期判定 / 覆盖判定', () => {
    const grant = grantAuthorization({
      grant_id: 'g1',
      source: 'user',
      source_ref: 'u',
      subject_instance_id: null,
      scope: ['a', 'b', 'a'],
      granted_at: T(1),
      expires_at: T(10),
    });
    expect(grant.scope).toEqual(['a', 'b']); // 去重
    expect(authorizationState(grant, T(5))).toBe('active');
    expect(grantCovers(grant, 'a', T(5))).toBe(true);
    expect(grantCovers(grant, 'z', T(5))).toBe(false);
    expect(authorizationState(grant, T(10))).toBe('expired'); // 到期即过期（含端点）
    expect(grantCovers(grant, 'a', T(10))).toBe(false);
  });

  it('反向对照 A：收窄只能做减法；加新权限 / 时间倒流 ⇒ 抛', () => {
    const grant = grantAuthorization({
      grant_id: 'g1',
      source: 'user',
      source_ref: 'u',
      subject_instance_id: null,
      scope: ['a', 'b'],
      granted_at: T(1),
    });
    const narrowed = narrowAuthorization(grant, ['a'], { at: T(2) });
    expect(narrowed.scope).toEqual(['a']);
    expect(narrowed.revision).toBe(2);
    expect(narrowed.expires_at).toBe(grant.expires_at); // 不得延长期限
    expect(() => narrowAuthorization(grant, ['a', 'c'], { at: T(2) })).toThrow(/收窄只能做减法|widening/);
    expect(() => narrowAuthorization(grant, ['a'], { at: T(0) })).toThrow(/倒流/);
  });

  it('反向对照 B：空权限 token / 空 grant_id / 负有效期 ⇒ 抛', () => {
    expect(() => normalizeScope(['a', '  '])).toThrow(/空权限/);
    expect(() =>
      grantAuthorization({ grant_id: '  ', source: 'user', source_ref: 'u', subject_instance_id: null, scope: ['a'], granted_at: T(1) }),
    ).toThrow(/grant_id/);
    expect(() =>
      grantAuthorization({ grant_id: 'g', source: 'user', source_ref: 'u', subject_instance_id: null, scope: ['a'], granted_at: T(5), expires_at: T(1) }),
    ).toThrow(/有效期/);
  });

  it('正向 + 反向：latestAuthorization 取最大 revision；委派链缺失即截断', () => {
    const g1 = grantAuthorization({ grant_id: 'root', source: 'user', source_ref: 'u', subject_instance_id: null, scope: ['a'], granted_at: T(1) });
    const child = grantAuthorization({
      grant_id: 'child',
      source: 'kernel',
      source_ref: 'k',
      subject_instance_id: 'i',
      scope: ['a'],
      granted_at: T(2),
      parent_grant_id: 'root',
    });
    const registry: AuthorizationRegistry = [g1, child];
    expect(latestAuthorization(registry, 'root')?.grant_id).toBe('root');
    const chain = traceProvenance(registry, 'child');
    expect(chain.map((entry) => entry.grant_id)).toEqual(['root', 'child']);
    // parent 指向不存在 ⇒ 截断，不编造
    const orphan = grantAuthorization({ grant_id: 'orphan', source: 'user', source_ref: 'u', subject_instance_id: null, scope: ['a'], granted_at: T(1), parent_grant_id: 'ghost' });
    expect(traceProvenance([orphan], 'orphan').map((entry) => entry.grant_id)).toEqual(['orphan']);
  });
});

// ===========================================================================
// 4. checkpoint —— 七态 → 三档（唯一映射）
// ===========================================================================

describe('独立验证 · scheduler/checkpoint', () => {
  it('正向：七态各自落到确定档位（穷尽）', () => {
    expect(classifyActionState('prepared')).toBe('in_flight');
    expect(classifyActionState('handed_off')).toBe('unknown');
    expect(classifyActionState('submitted')).toBe('unknown');
    expect(classifyActionState('result_unknown')).toBe('unknown');
    expect(classifyActionState('user_reported_complete')).toBe('unknown');
    expect(classifyActionState('confirmed_complete')).toBe('committed');
    expect(classifyActionState('invalidated_or_failed')).toBe('committed');
    expect(classifyRunStatus('running')).toBe('in_flight');
    expect(classifyRunStatus('finished')).toBe('committed');
    expect(classifyRunStatus('aborted')).toBe('committed');
  });

  it('（N-4 修复后）clock 短键名传入分类器 ⇒ 经映射表归口到对应档；两表都不认的字符串 ⇒ 仍抛', () => {
    // 【原断言 → 新断言】原断言"clock 短键名 ⇒ 抛（不落到默认档）"固化 **N-4 缺陷**
    // （分类器只认 workledger 词表、两词汇无法互操作）。N-4 修复后分类器**接受两侧词表**：
    expect(classifyActionState('confirmed' as never)).toBe('committed');
    expect(classifyActionState('unknown' as never)).toBe('unknown');
    expect(classifyActionState('failed' as never)).toBe('committed');
    expect(classifyActionState('user_reported' as never)).toBe('unknown');
    // 保留反向对照：**两表都没有**的字符串仍必须具名抛错（不静默落到默认档）。
    // 若有人把 clock 词表摘掉，上面几条重新变红；若有人把未知输入默认成一个档，这条变红。
    expect(() => classifyActionState('paused' as never)).toThrow(/未分类的动作状态/);
  });

  it('反向对照 B：planCheckpointRestore 只重排 in_flight，扣留 unknown', () => {
    const checkpoint: WorkCheckpoint = {
      taken_at: T(1),
      entries: [],
      committed: ['c'],
      in_flight: ['f'],
      unknown: ['u'],
      replay_allowed: ['f'],
      no_replay: ['u'],
      blind_replay_allowed: false,
    };
    const plan = planCheckpointRestore(checkpoint);
    expect(plan.replayed).toEqual(['f']);
    expect(plan.withheld).toEqual(['u']);
    expect(plan.already_committed).toEqual(['c']);
    expect(plan.blind_replay_allowed).toBe(false);
  });

  it('正向：CHECKPOINT_CLASSES 恰为三档', () => {
    expect([...CHECKPOINT_CLASSES]).toEqual(['committed', 'in_flight', 'unknown']);
  });
});

// ===========================================================================
// 5. id-clock-continuity —— 高水位只增不减 / 时钟不回原点
// ===========================================================================

describe('独立验证 · scheduler/id-clock-continuity', () => {
  it('正向：高水位合并逐命名空间取大；缺表不拉低', () => {
    expect(mergeHighWater({ evt: 5 }, { evt: 3, msg: 2 }, undefined)).toEqual({ evt: 5, msg: 2 });
    expect(numericSuffix('msg-42')).toBe(42);
    expect(numericSuffix('no-digits')).toBeNull();
  });

  it('反向对照 A：高水位倒退 ⇒ 抛（不静默取大）', () => {
    expect(() => assertHighWaterMonotonic({ evt: 5 }, { evt: 3 })).toThrow(/只增不减|倒退/);
    expect(() => assertHighWaterMonotonic({ evt: 5 }, {})).toThrow(); // 键消失也算倒退
    expect(() => assertHighWaterMonotonic({ evt: 3 }, { evt: 5 })).not.toThrow();
  });

  it('反向对照 B：逻辑钟重启必须**严格前进**；原地不动 ⇒ 抛', () => {
    expect(() => assertClockResumed(T(10), T(10))).toThrow(/倒退|原地/);
    expect(() => assertClockResumed(T(10), T(9))).toThrow();
    expect(() => assertClockResumed(T(10), T(11))).not.toThrow();
    expect(() => resumeTimeAfter({} as StoreSnapshot, 0)).toThrow(/步长/);
  });

  it('正向：从持久记录观测高水位；时钟恢复严格大于最后观测', () => {
    const snapshot = {
      messages: [],
      work_items: [],
      runs: [],
      inbox_entries: [],
      read_receipts: [],
      actionable_inputs: [],
      kernel_events: [kernelEvent('evt-7', 30, null)],
      delivery_events: [pendingEvent('evt-9', 't1', 40, null)],
      tasks: [],
    } as unknown as StoreSnapshot;
    expect(observedHighWater(snapshot).evt).toBe(9);
    expect(resumeTimeAfter(snapshot, 1)).toBe(41); // max(at=40) + 1
    const plan = planIdContinuity({ snapshot, persisted: { evt: 3 } });
    expect(plan.effective.evt).toBe(9); // 观测值 9 > 持久值 3
  });
});

// ===========================================================================
// 6. event-log —— 序号洞 / 先保存再投递
// ===========================================================================

describe('独立验证 · scheduler/event-log', () => {
  it('正向：kernel + delivery 合并看序号洞；连续则无洞', () => {
    const gaps = detectEventIdGaps({
      kernel_events: [kernelEvent('evt-1', 1, null), kernelEvent('evt-3', 3, null)],
      delivery_events: [pendingEvent('evt-2', 't1', 2, T(2))],
    });
    expect(gaps).toEqual([]); // evt-2 在 delivery 里 ⇒ 不是洞
    const withGap = detectEventIdGaps({
      kernel_events: [kernelEvent('evt-1', 1, null), kernelEvent('evt-4', 4, null)],
      delivery_events: [],
    });
    expect(withGap[0]?.missing).toEqual([2, 3]);
  });

  it('反向对照 A：只看 kernel_events 会把 outbox 事件误判成丢弃（本模块合并两类）', () => {
    const onlyKernel = detectEventIdGaps({
      kernel_events: [kernelEvent('evt-1', 1, null), kernelEvent('evt-3', 3, null)],
      delivery_events: [],
    });
    expect(onlyKernel[0]?.missing).toEqual([2]); // 单独看 ⇒ 误报
  });

  it('反向对照 B：已投递却 delivered_at 早于 created_at ⇒ save_before_deliver 违规', () => {
    const violations = checkSaveBeforeDeliver({
      kernel_events: [kernelEvent('evt-1', 1, 't1'), { ...kernelEvent('evt-2', 2, 't1'), kind: 'work_item_created' }],
      delivery_events: [pendingEvent('evt-5', 't1', 5, T(3))],
    });
    expect(violations.some((v) => v.rule === 'save_before_deliver')).toBe(true);
  });

  it('反向对照 C：投递意图之前无任何落盘记录 ⇒ record_before_deliver 违规', () => {
    const violations = checkSaveBeforeDeliver({
      kernel_events: [],
      delivery_events: [pendingEvent('evt-1', 'tX', 5, null)],
    });
    expect(violations.some((v) => v.rule === 'record_before_deliver')).toBe(true);
  });
});

// ===========================================================================
// 7. loop-limits —— 有界工具循环
// ===========================================================================

describe('独立验证 · scheduler/loop-limits', () => {
  it('正向：轮次 / 工具调用 / 时间三条上限各自计量', () => {
    const gate = createLoopLimitGate({ max_turns: 2, max_tool_calls: 1, max_time: 10 });
    expect(gate.beginTurn().admitted).toBe(true);
    expect(gate.beginTurn().admitted).toBe(true);
    const third = gate.beginTurn();
    expect(third.admitted).toBe(false);
    expect(third.reason).toBe('would_exceed_limit');
    expect(gate.ledger.used('model_calls')).toBe(2); // 整笔拒绝，一条都不扣
    expect(gate.beginToolCall().admitted).toBe(true);
    expect(gate.beginToolCall().admitted).toBe(false);
    expect(gate.advanceTime(5).admitted).toBe(true);
    // 5 + 6 > 10 ⇒ 拒，且不部分推进
    expect(gate.advanceTime(6).admitted).toBe(false);
    expect(gate.ledger.used('time')).toBe(5);
  });

  it('反向对照 A：缺项 / 负数 / 非整数 ⇒ 抛（"没有上限"不是合法配置）', () => {
    expect(() => validateLoopLimitSpec({ max_turns: 1, max_tool_calls: 0, max_time: 0 })).not.toThrow();
    expect(() => validateLoopLimitSpec({ max_turns: 0, max_tool_calls: 1, max_time: 1 })).toThrow(/有界|整数/);
    expect(() => validateLoopLimitSpec({ max_turns: 1, max_tool_calls: -1, max_time: 1 })).toThrow();
    expect(() => validateLoopLimitSpec({ max_turns: 1.5, max_tool_calls: 1, max_time: 1 })).toThrow();
  });

  it('反向对照 B：到上限 ⇒ 部分结果，complete_claimed 恒 false', () => {
    const gate = createLoopLimitGate({ max_turns: 1, max_tool_calls: 0, max_time: 0 });
    gate.beginTurn();
    const report = gate.report({ planned_refs: ['a', 'b'], delivered_refs: ['a'] });
    expect(report.partial).toBe(true);
    expect(report.status).toBe('exhausted');
    expect(report.complete_claimed).toBe(false);
    expect(gate.medium().durable).toBe(false); // 未注入流水 ⇒ 不跨重启
  });
});

// ===========================================================================
// 8. permission-check —— 每次调用都过闸门
// ===========================================================================

describe('独立验证 · scheduler/permission-check', () => {
  const grant = grantAuthorization({
    grant_id: 'g1',
    source: 'user',
    source_ref: 'u',
    subject_instance_id: 'root',
    scope: ['tool.search'],
    granted_at: T(1),
  });
  const baseCtx: PermissionContext = { now: T(5), grants: [grant] };

  it('正向：可信来源持有该权限 ⇒ 放行；来源可追溯', () => {
    const verdict = checkToolCall(
      { call_id: 'c1', tool: 'search', permission: 'tool.search', caller_instance_id: 'root', started_at: T(2) },
      baseCtx,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.provenance?.grant_id).toBe('g1');
    expect(verdict.recalled).toBe(false);
  });

  it('反向对照 A：只来自不可信来源 ⇒ untrusted_source（假批准不放行）', () => {
    const fake = grantAuthorization({
      grant_id: 'g2',
      source: 'external',
      source_ref: 'page',
      subject_instance_id: 'root',
      scope: ['tool.search'],
      granted_at: T(1),
    });
    const verdict = checkToolCall(
      { call_id: 'c2', tool: 'search', permission: 'tool.search', caller_instance_id: 'root', started_at: T(2) },
      { now: T(5), grants: [fake] },
    );
    expect(verdict.reason).toBe('untrusted_source');
    expect(verdict.allowed).toBe(false);
  });

  it('反向对照 B：撤权后第一步即拒（revoked），撤权前发出的调用不追回', () => {
    const ledger: RevocationLedger = [revokeAuthorization({ revocation_id: 'r1', grant_id: 'g1', revoked_at: T(4), authority: 'user', authority_ref: 'u' })];
    const denied = checkToolCall(
      { call_id: 'c3', tool: 'search', permission: 'tool.search', caller_instance_id: 'root', started_at: T(4) },
      { now: T(5), grants: [grant], revocations: ledger },
    );
    expect(denied.reason).toBe('revoked');
    const predates = checkToolCall(
      { call_id: 'c4', tool: 'search', permission: 'tool.search', caller_instance_id: 'root', started_at: T(3) },
      { now: T(5), grants: [grant], revocations: ledger },
    );
    expect(predates.allowed).toBe(true);
    expect(predates.predates_revocation).toBe(true);
  });

  it('反向对照 C：委派不得提高权限（越权 ⇒ delegation_escalation，独立探针也报）', () => {
    const delegation: Delegation = {
      delegation_id: 'd1',
      delegator_instance_id: 'root',
      delegate_instance_id: 'child',
      delegated_scope: ['tool.search', 'tool.admin'],
      created_at: T(2),
    };
    const ctx: PermissionContext = { now: T(5), grants: [grant], delegations: [delegation] };
    const escalation = detectDelegationEscalation(ctx);
    expect(escalation[0]?.permissions).toEqual(['tool.admin']);
    expect(callerEffectivePermissions('child', ctx)).toEqual(['tool.search']);
    const verdict = checkToolCall(
      { call_id: 'c5', tool: 'admin', permission: 'tool.admin', caller_instance_id: 'child', started_at: T(3) },
      ctx,
    );
    expect(verdict.reason).toBe('delegation_escalation');
  });

  it('反向对照 D：可信来源的批准声明必须走 grantAuthorization，不能当"不可信声明"记', () => {
    expect(() =>
      recordUntrustedApprovalClaim({
        claim_id: 'x',
        permission: 'p',
        subject_instance_id: 'i',
        trust_label: 'user',
        text: '',
        at: T(1),
      }),
    ).toThrow(/可信来源/);
  });
});
