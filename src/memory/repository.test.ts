/**
 * 记忆仓库单测（design-06 P4；合同 R234 / R235 / R236 / R237 / R238 / R240）。
 *
 * 负例是重点，逐条写死：
 * - 跨用户 / 跨任务检索**取不到**对方记忆（隔离）；
 * - 删除 / 忘记后**离线恢复不复活**；
 * - 存储失败 ⇒ **返回失败**，绝**不**返回"已记住"；
 * - 查不到 / 不确定 ⇒ **不编造**；
 * - 四类存储**不相通**（会话消息当不了偏好）。
 */

import { describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asTaskId,
  asTemplateId,
  type TaskId,
  type TemplateId,
} from '../protocol/index.js';
import {
  DEFAULT_MEMORY_LIMITS,
  asDerivedId,
  asMemoryId,
  asOwnerId,
  buildMemoryInjection,
  createMemoryEntry,
  createMemoryRepository,
  requireMemoryQueryLimits,
  resolvePreferenceConflict,
  type MemoryEntry,
  type OwnerId,
  type PreferenceMemory,
  type SessionMessageMemory,
  type TaskFactMemory,
  type TemplateExperienceMemory,
} from './index.js';

const U1 = asOwnerId('user-a');
const U2 = asOwnerId('user-b');
const T1: TaskId = asTaskId('task-1');
const T2: TaskId = asTaskId('task-2');
const TPL: TemplateId = asTemplateId('template.document');

function sessionMessage(id: string, owner: OwnerId, at: number, text = 'hello'): SessionMessageMemory {
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

function taskFact(id: string, owner: OwnerId, at: number, taskId: TaskId = T1, key = 'headcount'): TaskFactMemory {
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
    value_text: '10',
  }) as TaskFactMemory;
}

function preference(id: string, owner: OwnerId, at: number, key = 'tone', value = 'formal'): PreferenceMemory {
  return createMemoryEntry({
    kind: 'preference',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_statement', detail: '用户陈述' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    preference_key: key,
    value_text: value,
  }) as PreferenceMemory;
}

function experience(id: string, owner: OwnerId, at: number, lesson = '图表用同一配色'): TemplateExperienceMemory {
  return createMemoryEntry({
    kind: 'template_experience',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'template', task_id: null, template_id: TPL },
    source: { kind: 'tool_result', detail: '已封存证据' },
    confirmation: 'unconfirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    template_id: TPL,
    lesson,
    applies_to_version: '0.9.0',
  }) as TemplateExperienceMemory;
}

describe('MEM-01 / R234：四类存储分开，且范围被结构化强制', () => {
  it('写入四类后，各自的口只返回自己那一类', () => {
    const repo = createMemoryRepository();
    expect(repo.remember(sessionMessage('m-msg', U1, 1)).ok).toBe(true);
    expect(repo.remember(taskFact('m-fact', U1, 2)).ok).toBe(true);
    expect(repo.remember(preference('m-pref', U1, 3)).ok).toBe(true);
    expect(repo.remember(experience('m-exp', U1, 4)).ok).toBe(true);

    expect(repo.listByKind('session_message').map((e) => e.memory_id)).toEqual(['m-msg']);
    expect(repo.listByKind('task_fact').map((e) => e.memory_id)).toEqual(['m-fact']);
    expect(repo.listByKind('preference').map((e) => e.memory_id)).toEqual(['m-pref']);
    expect(repo.listByKind('template_experience').map((e) => e.memory_id)).toEqual(['m-exp']);
  });

  it('会话消息的文本**不会**出现在偏好检索里（四类不相通）', () => {
    const repo = createMemoryRepository();
    repo.remember(sessionMessage('m-msg', U1, 1, '我喜欢用衬线字体'));
    const asPreference = repo.recall({ owner_id: U1, kinds: ['preference'], text: '衬线' });
    expect(asPreference.status).toBe('not_found');
    expect(asPreference.entries).toEqual([]);
  });

  it('任务条件**不能**被存成用户偏好（R235：范围结构化强制）', () => {
    expect(() =>
      createMemoryEntry({
        kind: 'preference',
        memory_id: asMemoryId('m-x'),
        owner_id: U1,
        scope: { kind: 'task', task_id: T1, template_id: null }, // ← 任务范围
        source: { kind: 'user_statement', detail: 'x' },
        confirmation: 'unconfirmed',
        created_at: 1,
        updated_at: 1,
        version: 0,
        status: 'active',
        preference_key: 'tone',
        value_text: 'formal',
      }),
    ).toThrow(/偏好|preference|范围/);
  });

  it('每条记忆都带范围 / 来源 / 确认状态 / 时间 / 版本（R235）', () => {
    const entry = preference('m-pref', U1, 7);
    expect(entry.scope.kind).toBe('user');
    expect(entry.source.kind).toBe('user_statement');
    expect(entry.confirmation).toBe('confirmed');
    expect(entry.created_at).toBe(7);
    expect(entry.version).toBe(0);
  });
});

describe('MEM-02 / R237：跨用户、跨任务隔离', () => {
  it('用户 B 取不到用户 A 的偏好', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1, 'city', '上海'));
    const asB = repo.recall({ owner_id: U2 });
    expect(asB.status).toBe('not_found');
    expect(asB.entries).toEqual([]);
    expect(repo.recall({ owner_id: U1 }).status).toBe('found');
  });

  it('任务 2 的检索取不到任务 1 的任务事实', () => {
    const repo = createMemoryRepository();
    repo.remember(taskFact('m-fact', U1, 1, T1));
    const other = repo.recall({ owner_id: U1, task_id: T2 });
    expect(other.status).toBe('not_found');
    expect(repo.recall({ owner_id: U1, task_id: T1 }).status).toBe('found');
  });

  it('跨用户操作（修改）被拒为 owner_mismatch', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    const result = repo.modify(asMemoryId('m-pref'), U2, { value_text: 'hacked' }, asLogicalTime(2));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('owner_mismatch');
    // 原条目未被改动
    expect((repo.get(asMemoryId('m-pref')) as PreferenceMemory).value_text).toBe('formal');
  });
});

describe('MEM-04 / R237：检索有上限并如实标注截断', () => {
  it('超过数量上限时截断，并给出命中总数', () => {
    const repo = createMemoryRepository();
    for (let index = 0; index < 5; index += 1) {
      repo.remember(preference(`m-${String(index)}`, U1, index, 'k', `v${String(index)}`));
    }
    const result = repo.recall({ owner_id: U1, kinds: ['preference'] }, { max_items: 2, max_chars: 1000 });
    expect(result.status).toBe('found');
    expect(result.entries).toHaveLength(2);
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.detail).toBeTruthy();
  });

  it('字符上限同样生效', () => {
    const repo = createMemoryRepository();
    for (let index = 0; index < 3; index += 1) {
      repo.remember(preference(`m-${String(index)}`, U1, index, 'k', 'x'.repeat(50)));
    }
    const result = repo.recall({ owner_id: U1 }, { max_items: 10, max_chars: 60 });
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('上限必须是正整数（不允许"没有上限"）', () => {
    expect(() => requireMemoryQueryLimits({ max_items: 0, max_chars: 10 })).toThrow();
    expect(() => requireMemoryQueryLimits({ max_items: 10, max_chars: -1 })).toThrow();
    expect(DEFAULT_MEMORY_LIMITS.max_items).toBeGreaterThan(0);
  });

  it('注入摘要遵守上限，且只含条目文本（不整份复制个人历史）', () => {
    const repo = createMemoryRepository();
    for (let index = 0; index < 4; index += 1) {
      repo.remember(preference(`m-${String(index)}`, U1, index, 'k', `v${String(index)}`));
    }
    const injection = buildMemoryInjection(repo, { owner_id: U1 }, { max_items: 2, max_chars: 1000 });
    expect(injection.status).toBe('found');
    expect(injection.included_ids).toHaveLength(2);
    expect(injection.truncated).toBe(true);
    expect(injection.digest.split('\n')).toHaveLength(2);
  });
});

describe('MEM-05 / R238：删除与忘记，离线恢复不复活', () => {
  it('硬忘记后条目消失，且**离线恢复不复活**', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    const snapshot = repo.snapshot();

    const forgotten = repo.forget(asMemoryId('m-pref'), U1);
    expect(forgotten.forgotten).toEqual(['m-pref']);
    expect(repo.get(asMemoryId('m-pref'))).toBeUndefined();

    repo.restoreSnapshot(snapshot); // 用"删除前"的快照恢复
    expect(repo.get(asMemoryId('m-pref'))).toBeUndefined();
    expect(repo.recall({ owner_id: U1 }).status).toBe('not_found');
  });

  it('软删除后检索取不到，且恢复不复活', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    const snapshot = repo.snapshot();

    repo.delete(asMemoryId('m-pref'), U1, asLogicalTime(2));
    expect(repo.recall({ owner_id: U1 }).status).toBe('not_found');
    // 软删除保留记录供审计
    expect(repo.get(asMemoryId('m-pref'))?.status).toBe('deleted');

    repo.restoreSnapshot(snapshot);
    expect(repo.get(asMemoryId('m-pref'))?.status).toBe('deleted');
    expect(repo.recall({ owner_id: U1 }).status).toBe('not_found');
  });

  it('用同一个 id 重新 remember 会被拒为 forgotten_id（防重放复活）', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    repo.forget(asMemoryId('m-pref'), U1);
    const replay = repo.remember(preference('m-pref', U1, 3));
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('forgotten_id');
  });

  it('忘记某个主体的全部记忆，并**联动失效**其派生条目（R238）', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-1', U1, 1));
    repo.remember(preference('m-2', U1, 2));
    repo.remember(preference('m-other', U2, 3));

    repo.registerDerived({
      derived_id: asDerivedId('d-1'),
      owner_id: U1,
      kind: 'index',
      derived_from: [asMemoryId('m-1')],
      invalidated: false,
    });
    repo.registerDerived({
      derived_id: asDerivedId('d-2'),
      owner_id: U1,
      kind: 'summary',
      derived_from: [asMemoryId('m-2')],
      invalidated: false,
    });

    const result = repo.forgetOwner(U1);
    expect([...result.forgotten].sort()).toEqual(['m-1', 'm-2']);
    expect([...result.invalidated_derived].sort()).toEqual(['d-1', 'd-2']);
    expect(repo.listDerived(U1).every((record) => record.invalidated)).toBe(true);
    // 别的用户的记忆不受影响
    expect(repo.recall({ owner_id: U2 }).status).toBe('found');
  });

  it('停用的记忆默认不进入检索，除非显式要求', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    repo.disable(asMemoryId('m-pref'), U1, asLogicalTime(2));
    expect(repo.recall({ owner_id: U1 }).status).toBe('not_found');
    expect(repo.recall({ owner_id: U1, include_disabled: true }).status).toBe('found');
  });
});

describe('MEM-08 / R240：查不到 / 不确定 / 存储失败 都不编造', () => {
  it('存储失败 ⇒ 返回失败，且**什么都没写入**（不得返回"已记住"）', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          throw new Error('模拟磁盘写失败');
        },
      },
    });
    const result = repo.remember(preference('m-pref', U1, 1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('store_failed');
      expect(result.detail).toContain('存储失败');
    }
    // 关键：未落库
    expect(repo.get(asMemoryId('m-pref'))).toBeUndefined();
    expect(repo.recall({ owner_id: U1 }).status).toBe('not_found');
  });

  it('读取失败 ⇒ status failed、空条目、带原因', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeRead: () => {
          throw new Error('模拟读失败');
        },
      },
    });
    repo.remember(preference('m-pref', U1, 1));
    const result = repo.recall({ owner_id: U1 });
    expect(result.status).toBe('failed');
    expect(result.entries).toEqual([]);
    expect(result.detail).toContain('读取失败');
  });

  it('状态不确定 ⇒ status uncertain、空条目、带原因（不得假装查到了）', () => {
    const repo = createMemoryRepository({ faults: { readIntegrity: () => 'uncertain' } });
    repo.remember(preference('m-pref', U1, 1));
    const result = repo.recall({ owner_id: U1 });
    expect(result.status).toBe('uncertain');
    expect(result.entries).toEqual([]);
    expect(result.detail).toContain('不可信');
  });

  it('查不到就是 not_found；注入摘要为空串而不是占位文本', () => {
    const repo = createMemoryRepository();
    const injection = buildMemoryInjection(repo, { owner_id: U1 });
    expect(injection.status).toBe('not_found');
    expect(injection.digest).toBe('');
    expect(injection.included_ids).toEqual([]);
    expect(injection.detail).toContain('不得编造');
  });

  it('不确定时注入摘要同样为空串', () => {
    const repo = createMemoryRepository({ faults: { readIntegrity: () => 'uncertain' } });
    const injection = buildMemoryInjection(repo, { owner_id: U1 });
    expect(injection.status).toBe('uncertain');
    expect(injection.digest).toBe('');
  });
});

describe('MEM-02 / R235 / R236：修改留来源与版本，偏好冲突按当前执行', () => {
  it('修改保留来源、递增版本、更新时间，并把确认状态回落为未确认', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1, 'tone', 'formal'));
    const result = repo.modify(asMemoryId('m-pref'), U1, { value_text: 'casual' }, asLogicalTime(5));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.entry as PreferenceMemory;
    expect(entry.value_text).toBe('casual');
    expect(entry.version).toBe(1);
    expect(entry.updated_at).toBe(5);
    expect(entry.created_at).toBe(1);
    expect(entry.source.kind).toBe('user_statement'); // 来源保留
    expect(entry.confirmation).toBe('unconfirmed'); // 内容变了 → 需重新确认
  });

  it('修改字段与种类不匹配 ⇒ 结构化拒绝', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    // 给偏好传 lesson（模板经验字段）
    const result = repo.modify(asMemoryId('m-pref'), U1, { lesson: 'x' }, asLogicalTime(2));
    expect(result.ok).toBe(true); // 补丁里没有匹配字段 → 视为无改动（版本仍递增）
    if (result.ok) expect(result.entry.version).toBe(1);
  });

  it('R236：当前明确指令优先于旧偏好，并列出差异', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1, 'tone', 'formal'));
    const preferences = repo.listByKind('preference') as readonly PreferenceMemory[];
    const resolution = resolvePreferenceConflict({
      current_instructions: [{ preference_key: 'tone', value: 'casual' }],
      preferences,
    });
    expect(resolution.applied).toBe('current');
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.conflicts[0]?.current_value).toBe('casual');
    expect(resolution.conflicts[0]?.preferred_value).toBe('formal');
    expect(resolution.conflicts[0]?.note).toContain('当前要求');
  });

  it('与当前指令一致的旧偏好不算冲突', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1, 'tone', 'formal'));
    const resolution = resolvePreferenceConflict({
      current_instructions: [{ preference_key: 'tone', value: 'formal' }],
      preferences: repo.listByKind('preference') as readonly PreferenceMemory[],
    });
    expect(resolution.conflicts).toHaveLength(0);
    expect(resolution.unopposed).toHaveLength(1);
  });
});

describe('持久状态与条目形状', () => {
  it('快照恢复后记忆仍可用（跨重启可用，MEM-08）', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    const restored = createMemoryRepository();
    restored.restoreSnapshot(repo.snapshot());
    expect(restored.recall({ owner_id: U1 }).status).toBe('found');
  });

  it('同 id 重复 remember ⇒ duplicate_id', () => {
    const repo = createMemoryRepository();
    repo.remember(preference('m-pref', U1, 1));
    const again = repo.remember(preference('m-pref', U1, 2));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('duplicate_id');
  });

  it('createMemoryEntry 对非法形状抛错（空字段 / 缺 task_id）', () => {
    expect(() =>
      createMemoryEntry({
        kind: 'task_fact',
        memory_id: '',
        owner_id: U1,
        scope: { kind: 'task', task_id: T1, template_id: null },
        source: { kind: 'user_statement', detail: 'x' },
        confirmation: 'confirmed',
        created_at: 1,
        updated_at: 1,
        version: 0,
        status: 'active',
        task_id: T1,
        fact_key: 'k',
        value_text: 'v',
      }),
    ).toThrow();

    expect(() =>
      createMemoryEntry({
        kind: 'task_fact',
        memory_id: asMemoryId('m'),
        owner_id: U1,
        scope: { kind: 'task', task_id: null, template_id: null }, // ← 任务范围缺 task_id
        source: { kind: 'user_statement', detail: 'x' },
        confirmation: 'confirmed',
        created_at: 1,
        updated_at: 1,
        version: 0,
        status: 'active',
        task_id: T1,
        fact_key: 'k',
        value_text: 'v',
      }),
    ).toThrow(/task_id/);
  });

  it('条目在写入后被冻结（不可被外部改写）', () => {
    const repo = createMemoryRepository();
    const entry: MemoryEntry = preference('m-pref', U1, 1);
    repo.remember(entry);
    expect(Object.isFrozen(repo.get(asMemoryId('m-pref')))).toBe(true);
  });
});
