/**
 * 分型范围存储单测（design-06 P4 / MEM-01 / MEM-02；合同 R234 / R235）。
 *
 * 核心断言：四类**分别存储**（互不相通）、五元信息齐全、
 * 且**任务内约束不得自动外溢为长期偏好**（默认拒绝 + 结构化拒因）。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId, asTemplateId } from '../protocol/index.js';
import {
  applyScopePromotion,
  createTypedScopeStore,
  evaluateScopePromotion,
  provenanceOf,
  type ScopePromotionRequest,
} from './typed-scope.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type MemoryEntry,
  type OwnerId,
  type PreferenceMemory,
} from './types.js';

const U1: OwnerId = asOwnerId('user-a');
const TASK = asTaskId('task-1');
const TPL = asTemplateId('template.document');
const AT = asLogicalTime(10);

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`mem-${String(counter)}`);
}

function sessionMessage(id = nextId()): MemoryEntry {
  return createMemoryEntry({
    kind: 'session_message',
    memory_id: id,
    owner_id: U1,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_statement', detail: '本轮对话' },
    confirmation: 'unconfirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    conversation_id: 'conv-1',
    role: 'user',
    text: '把报告做成一页',
  });
}

function taskFact(id = nextId(), value = 'A4'): MemoryEntry {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: id,
    owner_id: U1,
    scope: { kind: 'task', task_id: TASK, template_id: null },
    source: { kind: 'user_statement', detail: '本次任务要求' },
    confirmation: 'unconfirmed',
    created_at: 2,
    updated_at: 2,
    version: 0,
    status: 'active',
    task_id: TASK,
    fact_key: 'paper_size',
    value_text: value,
  });
}

function preference(id = nextId(), key = 'font_family', value = '宋体'): PreferenceMemory {
  return createMemoryEntry({
    kind: 'preference',
    memory_id: id,
    owner_id: U1,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_confirmation', detail: '用户长期偏好' },
    confirmation: 'confirmed',
    created_at: 3,
    updated_at: 3,
    version: 0,
    status: 'active',
    preference_key: key,
    value_text: value,
  }) as PreferenceMemory;
}

function templateExperience(id = nextId()): MemoryEntry {
  return createMemoryEntry({
    kind: 'template_experience',
    memory_id: id,
    owner_id: U1,
    scope: { kind: 'template', task_id: null, template_id: TPL },
    source: { kind: 'tool_result', detail: '已封存证据' },
    confirmation: 'unconfirmed',
    created_at: 4,
    updated_at: 4,
    version: 0,
    status: 'active',
    template_id: TPL,
    lesson: '图表与表格用同一套配色',
    applies_to_version: '0.9.0',
  });
}

function promotionRequest(overrides: Partial<ScopePromotionRequest> = {}): ScopePromotionRequest {
  return {
    source: taskFact(),
    preference_key: 'paper_size',
    value_text: 'A4',
    explicit_user_confirmation: false,
    origin: { kind: 'user_confirmation', detail: '用户在前台确认' },
    at: AT,
    newMemoryId: nextId,
    ...overrides,
  };
}

describe('MEM-01：四类记忆分别存储，互不相通', () => {
  it('四条不同类别的记忆各落入各自的存储，lanes 计数互不影响', () => {
    const store = createTypedScopeStore();
    expect(store.record(sessionMessage()).ok).toBe(true);
    expect(store.record(taskFact()).ok).toBe(true);
    expect(store.record(preference()).ok).toBe(true);
    expect(store.record(templateExperience()).ok).toBe(true);

    expect(store.lanes()).toEqual({
      session_message: 1,
      task_fact: 1,
      preference: 1,
      template_experience: 1,
    });
    expect(store.sessionMessages()).toHaveLength(1);
    expect(store.taskFacts()).toHaveLength(1);
    expect(store.preferences()).toHaveLength(1);
    expect(store.templateExperiences()).toHaveLength(1);
  });

  it('**反向对照**：记录任务事实**不会**在偏好存储里留下任何条目', () => {
    const store = createTypedScopeStore();
    store.record(taskFact());
    store.record(taskFact(nextId(), 'A5'));
    expect(store.taskFacts()).toHaveLength(2);
    expect(store.preferences()).toHaveLength(0); // 任务事实不得混进偏好
    expect(store.sessionMessages()).toHaveLength(0);
  });

  it('**反向对照**：范围种类与记忆种类不匹配 ⇒ 拒绝落位，且不写任何存储', () => {
    const store = createTypedScopeStore();
    const valid = preference();
    // 手改 scope 为任务范围（模拟"想把偏好挂到任务上"的越界写法）
    const tampered = {
      ...valid,
      scope: { kind: 'task', task_id: TASK, template_id: null },
    } as PreferenceMemory;

    const result = store.record(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scope_kind_mismatch');
    expect(store.lanes().preference).toBe(0);
  });

  it('**反向对照**：同 id 重复写入被拒（不跨类覆盖）', () => {
    const store = createTypedScopeStore();
    const id = nextId();
    expect(store.record(taskFact(id)).ok).toBe(true);
    const again = store.record(taskFact(id, 'A3'));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('duplicate_id');
    // 原值未被覆盖
    expect(store.taskFacts()[0]?.value_text).toBe('A4');
  });
});

describe('MEM-02：每条记忆带范围 · 来源 · 确认状态 · 时间 · 版本', () => {
  it('provenanceOf 归一四类条目的五元信息', () => {
    const fact = taskFact();
    const p = provenanceOf(fact);
    expect(p.kind).toBe('task_fact');
    expect(p.scope).toEqual({ kind: 'task', task_id: TASK, template_id: null });
    expect(p.source.kind).toBe('user_statement');
    expect(p.confirmation).toBe('unconfirmed');
    expect(p.created_at).toBe(2);
    expect(p.updated_at).toBe(2);
    expect(p.version).toBe(0);
    expect(p.status).toBe('active');

    const pref = provenanceOf(preference());
    expect(pref.scope.kind).toBe('user');
    expect(pref.confirmation).toBe('confirmed');

    const exp = provenanceOf(templateExperience());
    expect(exp.scope.kind).toBe('template');
  });
});

describe('R235：任务内约束**不自动**变成全局个人偏好', () => {
  it('默认路径（无用户显式确认）⇒ 拒绝升格，偏好存储保持为空', () => {
    const store = createTypedScopeStore();
    const fact = taskFact();
    store.record(fact);

    const decision = evaluateScopePromotion(promotionRequest({ source: fact }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('requires_explicit_user_confirmation');

    const applied = applyScopePromotion(store, decision);
    expect(applied.ok).toBe(false);
    // 任务内约束没有外溢：偏好存储 0 条，任务事实仍在
    expect(store.preferences()).toHaveLength(0);
    expect(store.taskFacts()).toHaveLength(1);
  });

  it('经用户**显式确认**且来源为 user_confirmation ⇒ 放行为用户范围偏好', () => {
    const store = createTypedScopeStore();
    const fact = taskFact();
    store.record(fact);

    const decision = evaluateScopePromotion(
      promotionRequest({ source: fact, explicit_user_confirmation: true }),
    );
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('应放行');

    expect(decision.entry.scope.kind).toBe('user');
    expect(decision.entry.confirmation).toBe('confirmed');
    expect(decision.note).toContain('显式确认');

    const applied = applyScopePromotion(store, decision);
    expect(applied.ok).toBe(true);
    expect(store.preferences()).toHaveLength(1);
    // 来源任务条目不受影响（升格不迁移、不删除）
    expect(store.taskFacts()).toHaveLength(1);
  });

  it('**反向对照**：显式确认但来源是推断 ⇒ 仍拒绝（推断不得写进长期偏好）', () => {
    const decision = evaluateScopePromotion(
      promotionRequest({
        explicit_user_confirmation: true,
        origin: { kind: 'inference', detail: '系统猜的' },
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('source_not_user_originated');
  });

  it('**反向对照**：来源不是任务范围条目 ⇒ 不走升格口', () => {
    const decision = evaluateScopePromotion(promotionRequest({ source: preference() }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('source_not_task_constraint');
  });
});
