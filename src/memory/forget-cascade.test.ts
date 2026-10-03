/**
 * 记忆生命周期与联动失效级联单测（design-06 P4 / MEM-05；合同 R237 / R238 / R240）。
 *
 * 正反例：
 * - **正例**：查看 / 修改 / 停用 / 删除 / 忘记各有产物；
 * - **反例 1**：**修改**与**停用**同样触发派生条目联动失效（仓库本身只管 delete/forget）；
 * - **反例 2**：未被触碰的记忆所派生的条目**不被误伤**（不过度失效）；
 * - **反例 3**：跨用户查看 / 删除 / 忘记**被拒**且不泄漏（R237）；
 * - **反例 4**（核心）：**忘记 + 重启（同进程模拟）后不复活**；且"离线旧快照恢复"也**不能**
 *   把已忘记的条目带回来（墓碑优先）；一份**未忘记**的旧快照恢复则**能**带回条目——
 *   这证明"不复活"是墓碑语义而非恢复坏了。
 * - **反例 5**：底层动作失败 ⇒ `ok: false`，不宣称成功（R240）。
 *
 * ⚠️ 重启部分为**同进程模拟**（`restart.ts` 的 `reopenMemoryStore`），**未做真实跨进程验证**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import {
  asDerivedId,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type OwnerId,
  type PreferenceMemory,
  type TaskFactMemory,
} from './types.js';
import { createMemoryRepository, type MemoryRepository } from './repository.js';
import {
  cascadeDerivedInvalidation,
  deleteMemory,
  disableMemory,
  forgetMemory,
  forgetOwnerMemory,
  modifyMemory,
  viewMemory,
} from './forget-cascade.js';
import { createMemoryBackup, reopenMemoryStore, restoreMemoryBackup } from './restart.js';

const U1: OwnerId = asOwnerId('user-a');
const U2: OwnerId = asOwnerId('user-b');
const AT = asLogicalTime(50);

function preference(id: string, owner: OwnerId, key = 'font', value = '宋体'): PreferenceMemory {
  return createMemoryEntry({
    kind: 'preference',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'user', task_id: null, template_id: null },
    source: { kind: 'user_statement', detail: '用户陈述' },
    confirmation: 'confirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    preference_key: key,
    value_text: value,
  }) as PreferenceMemory;
}

function taskFact(id: string, owner: OwnerId): TaskFactMemory {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'task', task_id: asTaskId('task-1'), template_id: null },
    source: { kind: 'user_confirmation', detail: '用户确认' },
    confirmation: 'confirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    task_id: asTaskId('task-1'),
    fact_key: 'headcount',
    value_text: '10',
  }) as TaskFactMemory;
}

/** 建库：pref-1（含 3 个派生）+ fact-1（含 1 个派生）+ 一个无关派生。 */
function seeded(): MemoryRepository {
  const repo = createMemoryRepository();
  for (const entry of [preference('pref-1', U1), taskFact('fact-1', U1)]) {
    const result = repo.remember(entry);
    if (!result.ok) throw new Error(result.detail);
  }
  repo.registerDerived({ derived_id: asDerivedId('idx-1'), owner_id: U1, kind: 'index', derived_from: [asMemoryId('pref-1')], invalidated: false });
  repo.registerDerived({ derived_id: asDerivedId('sum-1'), owner_id: U1, kind: 'summary', derived_from: [asMemoryId('pref-1')], invalidated: false });
  repo.registerDerived({ derived_id: asDerivedId('expd-1'), owner_id: U1, kind: 'experience', derived_from: [asMemoryId('pref-1')], invalidated: false });
  repo.registerDerived({ derived_id: asDerivedId('cache-1'), owner_id: U1, kind: 'cache', derived_from: [asMemoryId('fact-1')], invalidated: false });
  repo.registerDerived({ derived_id: asDerivedId('other-1'), owner_id: U1, kind: 'summary', derived_from: [asMemoryId('unrelated')], invalidated: false });
  return repo;
}

const invalidatedIds = (repo: MemoryRepository): string[] =>
  repo.listDerived().filter((record) => record.invalidated).map((record) => record.derived_id).sort();

describe('MEM-05 查看（带隔离）', () => {
  it('正例：查看自己的记忆，附派生条目状态', () => {
    const repo = seeded();
    const view = viewMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U1 });
    expect(view.ok).toBe(true);
    expect(view.status).toBe('active');
    expect(view.derived_valid).toHaveLength(3);
    expect(view.derived_invalidated).toHaveLength(0);
  });

  it('反例：跨用户查看被拒，不泄漏内容（R237）', () => {
    const repo = seeded();
    const view = viewMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U2 });
    expect(view.ok).toBe(false);
    expect(view.entry).toBeNull();
    expect(view.detail).toContain('隔离');
  });

  it('反例：查看不存在的记忆 ⇒ ok:false，不编造内容', () => {
    const repo = seeded();
    const view = viewMemory(repo, { memory_id: asMemoryId('nope'), owner_id: U1 });
    expect(view.ok).toBe(false);
    expect(view.entry).toBeNull();
  });
});

describe('MEM-05 修改 / 停用触发联动失效（仓库本身不含这格）', () => {
  it('反例：修改前置派生有效；修改后 → pref-1 的派生全失效，fact-1 与无关派生不受影响', () => {
    const repo = seeded();
    expect(invalidatedIds(repo)).toEqual([]);

    const outcome = modifyMemory(repo, {
      memory_id: asMemoryId('pref-1'),
      owner_id: U1,
      patch: { value_text: '黑体' },
      at: AT,
    });

    expect(outcome.ok).toBe(true);
    expect([...outcome.cascade.invalidated].sort()).toEqual(['expd-1', 'idx-1', 'sum-1']);
    expect(invalidatedIds(repo)).toEqual(['expd-1', 'idx-1', 'sum-1']);
    // 未由 pref-1 派生的条目**未被误伤**
    expect(outcome.cascade.surviving).toContain('cache-1');
    expect(outcome.cascade.surviving).toContain('other-1');
  });

  it('反例：停用同样触发联动失效', () => {
    const repo = seeded();
    const outcome = disableMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U1, at: AT });
    expect(outcome.ok).toBe(true);
    expect([...outcome.cascade.invalidated].sort()).toEqual(['expd-1', 'idx-1', 'sum-1']);
    expect(repo.get(asMemoryId('pref-1'))?.status).toBe('disabled');
  });

  it('反例：跨用户修改被拒（ok:false，无联动失效）', () => {
    const repo = seeded();
    const outcome = modifyMemory(repo, {
      memory_id: asMemoryId('pref-1'),
      owner_id: U2,
      patch: { value_text: '越权' },
      at: AT,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.affected).toHaveLength(0);
    expect(invalidatedIds(repo)).toEqual([]);
  });

  it('反例：底层写入失败 ⇒ ok:false，不宣称修改成功、也不联动失效（R240）', () => {
    let armed = false;
    const repo = createMemoryRepository({
      faults: {
        beforeWrite: () => {
          if (armed) throw new Error('模拟写失败');
        },
      },
    });
    const stored = repo.remember(preference('pref-1', U1));
    expect(stored.ok).toBe(true);
    repo.registerDerived({ derived_id: asDerivedId('idx-1'), owner_id: U1, kind: 'index', derived_from: [asMemoryId('pref-1')], invalidated: false });

    armed = true; // 之后的写入都失败
    const outcome = modifyMemory(repo, {
      memory_id: asMemoryId('pref-1'),
      owner_id: U1,
      patch: { value_text: '黑体' },
      at: AT,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.affected).toHaveLength(0);
    expect(outcome.cascade.invalidated).toHaveLength(0);
    // 内容未被改动
    expect(repo.get(asMemoryId('pref-1'))?.kind).toBe('preference');
  });
});

describe('MEM-05 删除 / 忘记 / 整主体忘记', () => {
  it('删除：写墓碑、检索不再返回、派生联动失效', () => {
    const repo = seeded();
    const outcome = deleteMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U1, at: AT });
    expect(outcome.ok).toBe(true);
    expect(repo.get(asMemoryId('pref-1'))?.status).toBe('deleted');
    const recalled = repo.recall({ owner_id: U1 });
    expect(recalled.entries.map((e) => e.memory_id)).not.toContain(asMemoryId('pref-1'));
    // 仓库 delete 已联动失效；级联工具对其幂等，故看总状态而非本次增量
    expect(invalidatedIds(repo)).toEqual(['expd-1', 'idx-1', 'sum-1']);
  });

  it('忘记：条目从存储移除 + 墓碑；派生联动失效', () => {
    const repo = seeded();
    const outcome = forgetMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U1 });
    expect(outcome.ok).toBe(true);
    expect(repo.get(asMemoryId('pref-1'))).toBeUndefined();
    expect(invalidatedIds(repo)).toEqual(['expd-1', 'idx-1', 'sum-1']);
  });

  it('反例：跨用户忘记被拒（R237）', () => {
    const repo = seeded();
    const outcome = forgetMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U2 });
    expect(outcome.ok).toBe(false);
    expect(repo.get(asMemoryId('pref-1'))).toBeDefined(); // 未被动
  });

  it('整主体忘记：本人全部清空、他人不受影响', () => {
    const repo = seeded();
    const other = preference('pref-2', U2, 'font', '仿宋');
    const stored = repo.remember(other);
    expect(stored.ok).toBe(true);

    const outcome = forgetOwnerMemory(repo, { owner_id: U1 });
    expect([...outcome.affected].sort()).toEqual(['fact-1', 'pref-1']);
    expect(repo.get(asMemoryId('pref-2'))).toBeDefined();
  });

  it('级联工具幂等：重复失效不重复计数', () => {
    const repo = seeded();
    const first = cascadeDerivedInvalidation(repo, [asMemoryId('pref-1')]);
    expect(first.invalidated).toHaveLength(3);
    const second = cascadeDerivedInvalidation(repo, [asMemoryId('pref-1')]);
    expect(second.invalidated).toHaveLength(0);
  });
});

describe('MEM-05 忘记后重启不复活（同进程模拟；未做真实跨进程验证）', () => {
  it('反例（核心）：忘记 → 重启后条目不再出现、派生仍失效、同 id 不可复用', () => {
    const repo = seeded();
    forgetMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U1 });

    const backup = createMemoryBackup(repo, { at: AT });
    const reopened = reopenMemoryStore(backup);
    expect(reopened.kind).toBe('reopened');
    if (reopened.kind !== 'reopened') return;

    const next = reopened.repository;
    expect(next.get(asMemoryId('pref-1'))).toBeUndefined();
    expect(next.recall({ owner_id: U1 }).entries.map((e) => e.memory_id)).not.toContain(asMemoryId('pref-1'));
    // 派生条目的失效态**跨重启保留**
    expect(invalidatedIds(next)).toEqual(['expd-1', 'idx-1', 'sum-1']);
    // 复用同一个 id 复活被拒
    const revive = next.remember(preference('pref-1', U1, 'font', '想复活'));
    expect(revive.ok).toBe(false);
    if (!revive.ok) expect(revive.reason).toBe('forgotten_id');
    expect(reopened.report.restart_mode).toBe('same_process');
  });

  it('反例（核心）：离线旧快照恢复**不能**带回已忘记的条目（墓碑优先）', () => {
    const repo = seeded();
    const beforeForget = createMemoryBackup(repo, { at: AT }); // 含 pref-1 的旧快照
    forgetMemory(repo, { memory_id: asMemoryId('pref-1'), owner_id: U1 });
    const afterForget = createMemoryBackup(repo, { at: asLogicalTime(60) }); // 墓碑已在

    const reopened = reopenMemoryStore(afterForget);
    if (reopened.kind !== 'reopened') throw new Error('应有重启结果');
    const target = reopened.repository;

    // 把"忘记前"的旧快照并回去：墓碑必须挡下 pref-1
    const merged = restoreMemoryBackup(target, beforeForget);
    expect(merged.kind).toBe('restored');
    if (merged.kind === 'restored') expect(merged.report.skipped_tombstoned).toBeGreaterThanOrEqual(1);
    expect(target.get(asMemoryId('pref-1'))).toBeUndefined();
    expect(target.listDerived().find((r) => r.derived_id === asDerivedId('idx-1'))?.invalidated).toBe(true);
  });

  it('对照：一份未忘记的旧快照恢复**能**带回条目（证明机制真的在恢复，不是坏了）', () => {
    const repo = seeded();
    const beforeForget = createMemoryBackup(repo, { at: AT });
    // 全新仓库（无墓碑）恢复旧快照
    const fresh = reopenMemoryStore(beforeForget);
    if (fresh.kind !== 'reopened') throw new Error('应有重启结果');
    expect(fresh.repository.get(asMemoryId('pref-1'))).toBeDefined();
    expect(fresh.repository.recall({ owner_id: U1 }).entries.length).toBeGreaterThan(0);
  });
});
