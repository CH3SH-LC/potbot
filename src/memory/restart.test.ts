/**
 * 重启持久性 / 备份 / 迁移 / 保留期 / 可用性报告单测
 * （design-06 P4 / MEM-08；合同 R237 / R238 / R240）。
 *
 * 正反例：
 * - **正例**：备份 → 重启（同进程模拟）后记忆仍可用；范围备份只覆盖指定主体；
 * - **反例 1**：损坏 / schema 不符的备份 ⇒ 结构化 `failed`，**不**返回任何仓库（不编造条目）；
 * - **反例 2**：保留期清理**只清过期**，保留期内条目不受影响；`retain_disabled` 生效；
 * - **反例 3（核心）**：`not_found` / `uncertain` / `failed` 一律 `can_claim_remembered: false`，
 *   `assertCanClaimRemembered` 抛错（**不得编造"已经记住"**，R240）。
 *
 * ⚠️ 重启部分为**同进程模拟**（`reopenMemoryStore` 新建仓库并从备份恢复），
 * **未做真实跨进程验证**；真实跨进程持久化属 `src/storage/file-store.ts` 职责。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError, asLogicalTime, asTaskId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type OwnerId,
  type PreferenceMemory,
  type SessionMessageMemory,
} from './types.js';
import { createMemoryRepository, type MemoryRepository } from './repository.js';
import {
  MEMORY_BACKUP_SCHEMA,
  applyMemoryRetention,
  assertCanClaimRemembered,
  planMemoryMigration,
  planMemoryRetention,
  reopenMemoryStore,
  reportMemoryAvailability,
  serializeMemoryBackup,
} from './restart.js';

const U1: OwnerId = asOwnerId('user-a');
const U2: OwnerId = asOwnerId('user-b');

function preference(id: string, owner: OwnerId, at: number, value = '宋体'): PreferenceMemory {
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
    preference_key: 'font',
    value_text: value,
  }) as PreferenceMemory;
}

function session(id: string, owner: OwnerId, at: number, text: string): SessionMessageMemory {
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

function seed(repo: MemoryRepository, entry: PreferenceMemory | SessionMessageMemory): void {
  const result = repo.remember(entry);
  if (!result.ok) throw new Error(result.detail);
}

describe('MEM-08 重启后记忆仍可用（同进程模拟；未做真实跨进程验证）', () => {
  it('正例：备份 → 重启 → 检索仍命中；报告标注 same_process', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('pref-1', U1, 1));
    seed(repo, session('msg-1', U1, 2, '我喜欢简洁的排版'));

    const backup = serializeMemoryBackup(repo, { at: asLogicalTime(100) });
    const reopened = reopenMemoryStore(backup);
    expect(reopened.kind).toBe('reopened');
    if (reopened.kind !== 'reopened') return;

    expect(reopened.report.restart_mode).toBe('same_process');
    expect(reopened.report.incoming_entries).toBe(2);
    expect(reopened.repository.get(asMemoryId('pref-1'))).toBeDefined();

    const availability = reportMemoryAvailability(reopened.repository.recall({ owner_id: U1 }));
    expect(availability.availability).toBe('available');
    expect(availability.can_claim_remembered).toBe(true);
  });

  it('备份范围可解释：给 owners 只覆盖该主体', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('pref-1', U1, 1));
    seed(repo, preference('pref-2', U2, 2));

    const backup = serializeMemoryBackup(repo, { at: asLogicalTime(100), owners: [U1] });
    const reopened = reopenMemoryStore(backup);
    if (reopened.kind !== 'reopened') throw new Error('应有重启结果');
    expect(reopened.report.owner_ids).toEqual([U1]);
    expect(reopened.repository.get(asMemoryId('pref-1'))).toBeDefined();
    expect(reopened.repository.get(asMemoryId('pref-2'))).toBeUndefined(); // U2 不在范围
  });

  it('反例：损坏 / schema 不符的备份 ⇒ failed，不返回仓库（不编造条目）', () => {
    const unreadable = reopenMemoryStore('{ this is not json');
    expect(unreadable.kind).toBe('failed');
    if (unreadable.kind === 'failed') expect(unreadable.reason).toBe('unreadable');

    const badSchema = reopenMemoryStore(JSON.stringify({ schema: 'other.v9', snapshot: {} }));
    expect(badSchema.kind).toBe('failed');
    if (badSchema.kind === 'failed') expect(badSchema.reason).toBe('bad_schema');

    const corrupt = reopenMemoryStore(JSON.stringify({ schema: MEMORY_BACKUP_SCHEMA, snapshot: { session_messages: 'nope' } }));
    expect(corrupt.kind).toBe('failed');
    if (corrupt.kind === 'failed') expect(corrupt.reason).toBe('corrupt');
  });
});

describe('MEM-08 迁移可解释', () => {
  it('同 schema ⇒ 支持且步骤明确', () => {
    const plan = planMemoryMigration(MEMORY_BACKUP_SCHEMA, MEMORY_BACKUP_SCHEMA);
    expect(plan.supported).toBe(true);
    expect(plan.steps).toHaveLength(1);
  });

  it('反例：未知来源 schema ⇒ 拒绝迁移（不猜测转换）', () => {
    const plan = planMemoryMigration('potbot-memory-backup.v0-unknown');
    expect(plan.supported).toBe(false);
    expect(plan.steps.join(' ')).toContain('拒绝迁移');
    expect(plan.detail).toContain('不能迁移');
  });
});

describe('MEM-08 保留期与删除范围可解释', () => {
  it('正例：过期条目被清、保留期内条目不动；说明含删除范围', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('old-1', U1, 0)); // 很旧
    seed(repo, preference('fresh-1', U1, 950)); // 新

    const policy = { max_age: 100, retain_disabled: true, retain_deleted_audit: false };
    const now = asLogicalTime(1000);
    const plan = planMemoryRetention(repo, { policy, now });
    expect(plan.expired_ids).toContain(asMemoryId('old-1'));
    expect(plan.retained_ids).toContain(asMemoryId('fresh-1'));
    expect(plan.deletion_scope_explanation).toContain('保留期');

    const outcome = applyMemoryRetention(repo, { policy, now });
    expect(outcome.ok).toBe(true);
    expect(outcome.forgotten).toEqual([asMemoryId('old-1')]);
    expect(repo.get(asMemoryId('old-1'))).toBeUndefined();
    expect(repo.get(asMemoryId('fresh-1'))).toBeDefined(); // 未误删
    // 墓碑保留（不复活）
    expect(repo.snapshot().tombstones).toContain(asMemoryId('old-1'));
  });

  it('反例：retain_disabled=true 时停用的旧条目**不在**清除范围', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('old-active', U1, 0));
    seed(repo, preference('old-disabled', U1, 0));
    repo.disable(asMemoryId('old-disabled'), U1, asLogicalTime(1));

    const keepDisabled = planMemoryRetention(repo, {
      policy: { max_age: 100, retain_disabled: true, retain_deleted_audit: false },
      now: asLogicalTime(1000),
    });
    expect(keepDisabled.expired_ids).toContain(asMemoryId('old-active'));
    expect(keepDisabled.expired_ids).not.toContain(asMemoryId('old-disabled'));

    const dropDisabled = planMemoryRetention(repo, {
      policy: { max_age: 100, retain_disabled: false, retain_deleted_audit: false },
      now: asLogicalTime(1000),
    });
    expect(dropDisabled.expired_ids).toContain(asMemoryId('old-disabled'));
  });

  it('反例：非法保留期 ⇒ 抛', () => {
    const repo = createMemoryRepository();
    expect(() =>
      planMemoryRetention(repo, { policy: { max_age: -1, retain_disabled: true, retain_deleted_audit: true }, now: asLogicalTime(0) }),
    ).toThrow(ValidationError);
  });
});

describe('MEM-08 查不到 / 不确定 / 失败不编造"已经记住"（R240）', () => {
  it('反例：查不到 ⇒ not_found，can_claim_remembered:false，断言抛', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('pref-1', U1, 1));
    const report = reportMemoryAvailability(repo.recall({ owner_id: U1, text: '不存在的关键词' }));
    expect(report.availability).toBe('not_found');
    expect(report.can_claim_remembered).toBe(false);
    expect(() => assertCanClaimRemembered(report)).toThrow(/不得宣称/);
  });

  it('反例：完整性不确定 ⇒ unavailable，不得宣称已记住', () => {
    const repo = createMemoryRepository({ faults: { readIntegrity: () => 'uncertain' } });
    const report = reportMemoryAvailability(repo.recall({ owner_id: U1 }));
    expect(report.availability).toBe('unavailable');
    expect(report.source_status).toBe('uncertain');
    expect(report.can_claim_remembered).toBe(false);
    expect(() => assertCanClaimRemembered(report)).toThrow();
  });

  it('反例：读取失败 ⇒ unavailable，不得宣称已记住', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeRead: () => {
          throw new Error('模拟读失败');
        },
      },
    });
    const report = reportMemoryAvailability(repo.recall({ owner_id: U1 }));
    expect(report.availability).toBe('unavailable');
    expect(report.source_status).toBe('failed');
    expect(report.can_claim_remembered).toBe(false);
  });

  it('正例：真正命中才 available 且可宣称已记住', () => {
    const repo = createMemoryRepository();
    seed(repo, session('msg-1', U1, 1, '记住我喜欢宋体'));
    const report = reportMemoryAvailability(repo.recall({ owner_id: U1, text: '宋体' }));
    expect(report.availability).toBe('available');
    expect(report.can_claim_remembered).toBe(true);
    expect(() => assertCanClaimRemembered(report)).not.toThrow();
  });
});
