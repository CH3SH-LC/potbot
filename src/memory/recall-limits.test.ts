/**
 * 实例化记忆检索（有上限 / 隔离 / 不复制整份历史）单测
 * （design-06 P4 / MEM-04；合同 R236 / R237 / R240）。
 *
 * 正反例：
 * - **正例**：注入有数量与长度上限，命中被如实截断；
 * - **反例 1**：申请超天花板的上限 ⇒ **抛**（"没有上限"不是选项，R237）；
 * - **反例 2**：跨用户 / 跨任务检索**取不到**对方记忆（隔离，R237）；
 * - **反例 3（可达坏状态，I-1 修复）**：上限**咬住**时闸门**不**响（300 条历史 / 声明上限 20
 *   ⇒ 注入 20 条，`assertNotHistoryDump` 不抛）；一旦注入**越过自己声明的上限**
 *   （注入路径没把上限接上：注入 100 条 > 声明 20 条）⇒ `assertNotHistoryDump` **必抛**。
 *   同一用例里同时断言"正常路径不抛"与"坏路径抛"，互为反向对照。
 *   > 修复前该判据（`injected >= visible && visible > max_items`）在本模块公开路径上
 *   > **恒假**（见 `recall-limits.ts` 文件头），这两条断言当时**不可能失败**；
 * - **反例 4**：查不到 ⇒ 摘要为空串，**不编造**（R240）。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError, asTaskId, asTemplateId, type TaskId } from '../protocol/index.js';
import {
  DEFAULT_MEMORY_LIMITS,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type MemoryEntry,
  type MemoryQueryLimits,
  type OwnerId,
  type SessionMessageMemory,
  type TaskFactMemory,
} from './types.js';
import {
  MemoryRepository,
  createMemoryRepository,
  type MemoryQuery,
  type MemoryRecallResult,
} from './repository.js';
import {
  INJECTION_CEILINGS,
  assertNotHistoryDump,
  auditRecallIsolation,
  buildInstanceRecallInjection,
  describeInjectionBudget,
  resolveInstanceLimits,
} from './recall-limits.js';

const U1: OwnerId = asOwnerId('user-a');
const U2: OwnerId = asOwnerId('user-b');
const T1: TaskId = asTaskId('task-1');
const T2: TaskId = asTaskId('task-2');

function sessionMessage(id: string, owner: OwnerId, at: number, text: string): SessionMessageMemory {
  return createMemoryEntry({
    kind: 'session_message',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_statement', detail: '会话消息' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    conversation_id: 'conv-1',
    role: 'user',
    text,
  }) as SessionMessageMemory;
}

function taskFact(id: string, owner: OwnerId, at: number, taskId: TaskId, key: string, value: string): TaskFactMemory {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'task', task_id: taskId, template_id: null },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    task_id: taskId,
    fact_key: key,
    value_text: value,
  }) as TaskFactMemory;
}

function seed(repo: MemoryRepository, entry: MemoryEntry): void {
  const result = repo.remember(entry);
  if (!result.ok) throw new Error(`seed 失败：${result.detail}`);
}

/**
 * **坏路径注入器**（只存在于测试）：模拟"注入路径没有把上限接到检索上"——
 * 检索本身是真的，但上限被抬到 100 条，调用方声明的 20 条被无视。
 *
 * 这是"整份历史可能被塞进上下文"的**可达**前提形态：上限一旦没咬住，
 * 注入条数就会越过声明值。判据必须对此报警（修复前它恒假，永远报不出来）。
 */
class RaisedLimitRepository extends MemoryRepository {
  override recall(query: MemoryQuery, _limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS): MemoryRecallResult {
    return super.recall(query, { max_items: 100, max_chars: 1_000_000 });
  }
}

describe('MEM-04 上限解析（不能关掉上限）', () => {
  it('未申请时用默认上限；默认上限本身不越天花板', () => {
    expect(resolveInstanceLimits(undefined)).toEqual(DEFAULT_MEMORY_LIMITS);
    expect(DEFAULT_MEMORY_LIMITS.max_items).toBeLessThanOrEqual(INJECTION_CEILINGS.max_items);
    expect(DEFAULT_MEMORY_LIMITS.max_chars).toBeLessThanOrEqual(INJECTION_CEILINGS.max_chars);
  });

  it('反例：非正整数上限 ⇒ 抛（沿用 requireMemoryQueryLimits）', () => {
    expect(() => resolveInstanceLimits({ max_items: 0, max_chars: 100 })).toThrow(ValidationError);
    expect(() => resolveInstanceLimits({ max_items: 10, max_chars: -1 })).toThrow(ValidationError);
    expect(() => resolveInstanceLimits({ max_items: 1.5, max_chars: 100 })).toThrow(ValidationError);
  });

  it('反例：申请超天花板的上限 ⇒ 抛，{不静默夹取}', () => {
    expect(() => resolveInstanceLimits({ max_items: 1_000_000, max_chars: 100 })).toThrow(/天花板/);
    expect(() => resolveInstanceLimits({ max_items: 10, max_chars: 99_999_999 })).toThrow(/天花板/);
    // 恰好等于天花板是允许的
    expect(resolveInstanceLimits(INJECTION_CEILINGS)).toEqual(INJECTION_CEILINGS);
  });
});

describe('MEM-04 有上限的注入（整份历史复制不可能）', () => {
  it('历史 60 条、上限 20 条 ⇒ 注入 20 条、如实截断、不是整份复制', () => {
    const repo = createMemoryRepository();
    for (let i = 0; i < 60; i += 1) {
      seed(repo, sessionMessage(`m-${String(i).padStart(2, '0')}`, U1, i, `历史消息 ${String(i)}`));
    }

    const injection = buildInstanceRecallInjection(repo, {
      owner_id: U1,
      instance_id: 'inst-1',
      requested_limits: { max_items: 20, max_chars: INJECTION_CEILINGS.max_chars },
    });

    expect(injection.status).toBe('found');
    expect(injection.included_ids).toHaveLength(20);
    expect(injection.truncated).toBe(true);
    expect(injection.audit.owner_visible_total).toBe(60);
    expect(injection.audit.injected).toBe(20);
    expect(injection.audit.full_history_copy).toBe(false);
    expect(() => assertNotHistoryDump(injection)).not.toThrow();
    expect(describeInjectionBudget(injection)).toContain('20 / 可见 60');
  });

  it('字符上限生效：长文本下按 max_chars 少注入', () => {
    const repo = createMemoryRepository();
    for (let i = 0; i < 10; i += 1) {
      seed(repo, sessionMessage(`m-${String(i)}`, U1, 100 - i, 'x'.repeat(50)));
    }
    const injection = buildInstanceRecallInjection(repo, {
      owner_id: U1,
      instance_id: 'inst-2',
      requested_limits: { max_items: 50, max_chars: 120 },
    });
    // 每条 50 字符，120 字符上限最多 2 条
    expect(injection.included_ids.length).toBeLessThanOrEqual(2);
    expect(injection.truncated).toBe(true);
  });

  it('反例：上限未生效（注入越过声明上限）⇒ 闸门必抛；正常截断路径不误判', () => {
    // 正常路径：300 条历史 + 声明上限 20 ⇒ 注入 20 条，上限**咬住**，闸门不响
    const okRepo = createMemoryRepository();
    for (let i = 0; i < 300; i += 1) {
      seed(okRepo, sessionMessage(`ok-${String(i).padStart(3, '0')}`, U1, i, `历史消息 ${String(i)}`));
    }
    const okInjection = buildInstanceRecallInjection(okRepo, { owner_id: U1, instance_id: 'inst-ok' });
    expect(okInjection.audit.owner_visible_total).toBe(300);
    expect(okInjection.audit.injected).toBe(20);
    expect(okInjection.audit.full_history_copy).toBe(false);
    expect(() => assertNotHistoryDump(okInjection)).not.toThrow(); // 正常截断不得被误判为复制

    // 坏路径：同一条历史，注入路径把上限抬到 100（上限没接到注入上）
    const badRepo = new RaisedLimitRepository();
    for (let i = 0; i < 300; i += 1) {
      seed(badRepo, sessionMessage(`bad-${String(i).padStart(3, '0')}`, U1, i, `历史消息 ${String(i)}`));
    }
    const badRequest = { owner_id: U1, instance_id: 'inst-bad' };
    // 注入 100 条 > 声明上限 20 条 ⇒ 生产路径**抛**，不得静默返回"看起来正常"的注入
    expect(() => buildInstanceRecallInjection(badRepo, badRequest)).toThrow(/整份历史复制/);
    // 中间态直取：审计如实标记"上限未生效"
    const badAudit = auditRecallIsolation(badRepo, badRequest, 100);
    expect(badAudit.owner_visible_total).toBe(300);
    expect(badAudit.injected).toBe(100);
    expect(badAudit.full_history_copy).toBe(true);
  });
});

describe('MEM-04 跨用户 / 跨任务隔离', () => {
  it('反例：别人的记忆不可注入，且审计如实计数', () => {
    const repo = createMemoryRepository();
    seed(repo, sessionMessage('mine', U1, 1, '我的偏好是蓝色'));
    seed(repo, sessionMessage('theirs', U2, 2, '我的偏好是红色'));

    const injection = buildInstanceRecallInjection(repo, {
      owner_id: U1,
      instance_id: 'inst-3',
      text: '偏好',
    });

    expect(injection.status).toBe('found');
    expect(injection.included_ids).toEqual([asMemoryId('mine')]);
    expect(injection.digest).toContain('蓝色');
    expect(injection.digest).not.toContain('红色'); // 不泄漏对方内容
    expect(injection.audit.foreign_excluded).toBe(1);
    expect(injection.audit.owner_visible_total).toBe(1);
  });

  it('反例：跨任务记忆不可注入（本任务范围外被排除）', () => {
    const repo = createMemoryRepository();
    seed(repo, taskFact('f-t1', U1, 1, T1, 'headcount', '10'));
    seed(repo, taskFact('f-t2', U1, 2, T2, 'headcount', '99'));

    const injection = buildInstanceRecallInjection(repo, {
      owner_id: U1,
      instance_id: 'inst-4',
      task_id: T1,
    });

    expect(injection.status).toBe('found');
    expect(injection.included_ids).toEqual([asMemoryId('f-t1')]);
    expect(injection.digest).toContain('10');
    expect(injection.digest).not.toContain('99');
    expect(injection.audit.out_of_scope_excluded).toBe(1);
  });

  it('反例：查不到 ⇒ 摘要为空串，不编造', () => {
    const repo = createMemoryRepository();
    seed(repo, sessionMessage('m-1', U1, 1, '随便一条'));

    const injection = buildInstanceRecallInjection(repo, {
      owner_id: U1,
      instance_id: 'inst-5',
      text: '根本不存在的关键词',
    });
    expect(injection.status).toBe('not_found');
    expect(injection.digest).toBe('');
    expect(injection.included_ids).toHaveLength(0);
    expect(() => assertNotHistoryDump(injection)).not.toThrow();
  });

  it('模板范围检索同样受限（模板范围记忆按模板过滤）', () => {
    const repo = createMemoryRepository();
    seed(
      repo,
      createMemoryEntry({
        kind: 'template_experience',
        memory_id: asMemoryId('e-1'),
        owner_id: U1,
        scope: { kind: 'template', task_id: null, template_id: asTemplateId('tpl.a') },
        source: { kind: 'tool_result', detail: '已封存证据' },
        confirmation: 'confirmed',
        created_at: 1,
        updated_at: 1,
        version: 0,
        status: 'active',
        template_id: asTemplateId('tpl.a'),
        lesson: '写文档先设字体',
        applies_to_version: '0.9.0',
      }),
    );
    const injection = buildInstanceRecallInjection(repo, {
      owner_id: U1,
      instance_id: 'inst-6',
      template_id: asTemplateId('tpl.b'),
    });
    expect(injection.status).toBe('not_found');
    expect(injection.audit.out_of_scope_excluded).toBe(1);
  });
});
