/**
 * 任务事实版本化更新单测（design-06 P4 / MEM-03；合同 R235 / R236 / R240）。
 *
 * 正反例：
 * - **正例**：更新任务事实**留来源与版本**（追加新版本），并按当前指令与旧偏好差异执行；
 * - **反例 1**：不得**静默改写历史事实**——旧条目的值原样保留（`disabled` 可审计）；
 * - **反例 2**：缺来源 / 写入失败 ⇒ **如实失败**，不宣称已更新（R240）。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId, type TaskId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  readTaskFactHistory,
  resolvePreferenceConflict,
  updateTaskFact,
  type MemorySource,
  type OwnerId,
  type PreferenceMemory,
  type TaskFactMemory,
} from './index.js';

const U1: OwnerId = asOwnerId('user-a');
const TASK: TaskId = asTaskId('task-1');
const SOURCE: MemorySource = { kind: 'user_statement', detail: '用户在第 3 轮口述' };

let counter = 0;
function nextId(): ReturnType<typeof asMemoryId> {
  counter += 1;
  return asMemoryId(`fact-${String(counter)}`);
}

function update(
  repo: ReturnType<typeof createMemoryRepository>,
  value_text: string,
  overrides: Partial<Parameters<typeof updateTaskFact>[0]> = {},
): ReturnType<typeof updateTaskFact> {
  return updateTaskFact({
    repository: repo,
    owner_id: U1,
    task_id: TASK,
    fact_key: 'attendees',
    value_text,
    source: SOURCE,
    at: asLogicalTime(10),
    newMemoryId: nextId,
    ...overrides,
  });
}

describe('MEM-03 / R236：更新任务事实留来源与版本', () => {
  it('首次写入版本 r0，带来源；再次写入追加 r1 并记录被取代条目与旧值', () => {
    const repo = createMemoryRepository();
    const first = update(repo, '8 人');
    expect(first.kind).toBe('updated');
    if (first.kind !== 'updated') return;
    expect(first.entry.version).toBe(0);
    expect(first.superseded).toBeNull();
    expect(first.previous_value).toBeNull();
    expect(first.explanation).toContain('user_statement');

    const second = update(repo, '10 人');
    expect(second.kind).toBe('updated');
    if (second.kind !== 'updated') return;
    expect(second.entry.version).toBe(1);
    expect(second.previous_value).toBe('8 人');
    expect(second.superseded).toBe(first.entry.memory_id);
    expect(second.explanation).toContain('r0 → r1');
    expect(second.explanation).toContain('历史版本原样保留');
  });

  it('**不悄悄改历史事实**：旧条目值 / 版本原样保留，只是状态变为 disabled', () => {
    const repo = createMemoryRepository();
    const first = update(repo, '8 人');
    if (first.kind !== 'updated') throw new Error('首次应更新');
    const before = repo.get(first.entry.memory_id) as TaskFactMemory;

    const second = update(repo, '10 人');
    expect(second.kind).toBe('updated');

    const after = repo.get(first.entry.memory_id) as TaskFactMemory;
    expect(after.value_text).toBe(before.value_text); // 值没被改写
    expect(after.version).toBe(before.version); // 版本没被改写
    expect(after.status).toBe('disabled'); // 只是失效（可见、可审计）

    const history = readTaskFactHistory(repo, { owner_id: U1, task_id: TASK, fact_key: 'attendees' });
    expect(history.map((entry) => entry.value_text)).toEqual(['8 人', '10 人']);
    expect(history.map((entry) => entry.version)).toEqual([0, 1]);
  });

  it('默认检索只返回当前有效值；带 include_disabled 可读回历史', () => {
    const repo = createMemoryRepository();
    update(repo, '8 人');
    update(repo, '10 人');

    const active = repo.recall({ owner_id: U1, kinds: ['task_fact'], task_id: TASK });
    expect(active.status).toBe('found');
    expect(active.entries.map((entry) => (entry.kind === 'task_fact' ? entry.value_text : ''))).toEqual(['10 人']);

    const all = repo.recall({ owner_id: U1, kinds: ['task_fact'], task_id: TASK, include_disabled: true });
    expect(all.entries).toHaveLength(2);
  });
});

describe('MEM-03 正反例：同值不新增 / 缺来源 / 写入失败', () => {
  it('新值与当前有效值相同 ⇒ no_change（不写新版本，不制造假历史）', () => {
    const repo = createMemoryRepository();
    update(repo, '10 人');
    const again = update(repo, '10 人');
    expect(again.kind).toBe('no_change');
    if (again.kind !== 'no_change') return;
    expect(again.reason).toContain('不新增版本');
    expect(repo.listByKind('task_fact')).toHaveLength(1);
  });

  it('缺来源 ⇒ 失败 missing_source，且**不写入任何条目**', () => {
    const repo = createMemoryRepository();
    const result = update(repo, '10 人', { source: { kind: 'user_statement', detail: '' } });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('missing_source');
    expect(repo.listByKind('task_fact')).toHaveLength(0);
  });

  it('写入失败 ⇒ 失败 store_failed，历史条目**保持有效**且原值不变（R240）', () => {
    const repo = createMemoryRepository();
    const first = update(repo, '8 人');
    if (first.kind !== 'updated') throw new Error('首次应更新');

    const failing = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          throw new Error('模拟磁盘失败');
        },
      },
    });
    // 让失败仓库先拥有历史（用快照搬运）
    failing.restoreSnapshot(repo.snapshot());
    const result = update(failing, '10 人');
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('store_failed');

    const stillActive = failing.get(first.entry.memory_id) as TaskFactMemory;
    expect(stillActive.status).toBe('active'); // 历史没有被误失效
    expect(stillActive.value_text).toBe('8 人');
    expect(failing.listByKind('task_fact')).toHaveLength(1); // 新版本未落库
  });
});

describe('MEM-03 / R236：当前指令优先于旧偏好并说明差异', () => {
  function preference(key: string, value: string): PreferenceMemory {
    return createMemoryEntry({
      kind: 'preference',
      memory_id: `pref-${key}`,
      owner_id: U1,
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_confirmation', detail: '历史偏好' },
      confirmation: 'confirmed',
      created_at: 1,
      updated_at: 1,
      version: 0,
      status: 'active',
      preference_key: key,
      value_text: value,
    }) as PreferenceMemory;
  }

  it('冲突时按当前要求执行（applied 恒 current），并**列出**差异而非静默丢弃旧偏好', () => {
    const resolution = resolvePreferenceConflict({
      current_instructions: [{ preference_key: 'attendees', value: '10 人' }],
      preferences: [preference('attendees', '8 人')],
    });
    expect(resolution.applied).toBe('current');
    expect(resolution.conflicts).toHaveLength(1);
    expect(resolution.conflicts[0]?.preferred_value).toBe('8 人');
    expect(resolution.conflicts[0]?.current_value).toBe('10 人');
    expect(resolution.conflicts[0]?.note).toContain('按当前要求执行');
    // 旧偏好被"列出"而不是被删——它仍在输入里可查（说明差异，不静默改历史）
    expect(resolution.unopposed).toHaveLength(0);
  });

  it('不冲突的旧偏好归入 unopposed（可继续沿用）', () => {
    const resolution = resolvePreferenceConflict({
      current_instructions: [{ preference_key: 'attendees', value: '10 人' }],
      preferences: [preference('attendees', '10 人'), preference('font', '宋体')],
    });
    expect(resolution.conflicts).toHaveLength(0);
    expect(resolution.unopposed.map((entry) => entry.preference_key)).toEqual(['attendees', 'font']);
  });
});
