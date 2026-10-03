/**
 * 备份计划 / 迁移计划 / 保留期与**删除范围可解释**的单测
 * （design-06 P4 / MEM-08 尚未闭合的部分；合同 R234 / R235 / R237 / R238 / R240）。
 *
 * 正反例（每条能力至少一正一反）：
 * - **备份**：四类分型说明；**凭据泄漏必须被检出**（含凭据条目被剔除并记名）；正常条目不误剔；
 * - **迁移**：同版本 no-op；**未知 schema 必须拒绝**；有登记路径但变换未实现 ⇒ 拒绝；**可回滚**；
 * - **保留期**：按范围（用户/任务/模板）与时间给出删除清单；**执行前 dry-run 可预览**；
 * - **fail-closed**：**不确定项不得被删**（时间戳/范围/状态/种类不可判定一律进 `uncertain`）。
 *
 * ⚠️ 本模块是计划 / 纯函数层，不落盘、不起进程；回滚用 `reopenMemoryStore`，属**同进程模拟**，
 * **不代表**已做真实跨进程验证。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError, asLogicalTime, asTaskId, asTemplateId } from '../protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type MemoryEntry,
  type MemoryId,
  type OwnerId,
  type PreferenceMemory,
  type SessionMessageMemory,
  type TaskFactMemory,
  type TemplateExperienceMemory,
} from './types.js';
import { createMemoryRepository, type MemoryRepository } from './repository.js';
import { MEMORY_BACKUP_SCHEMA } from './restart.js';
import {
  applyMemoryUpgrade,
  applyRetentionPlan,
  assertNoCredentialLeak,
  classifyRetention,
  entryHasCredentials,
  planMemoryBackup,
  planMemoryRetentionScoped,
  planMemoryUpgrade,
  previewRetention,
  rollbackMemoryUpgrade,
  scanEntryForCredentials,
  type MemoryUpgradeStep,
} from './backup-plan.js';

const U1: OwnerId = asOwnerId('user-a');
const U2: OwnerId = asOwnerId('user-b');
const T1 = asTaskId('task-1');
const TP1 = asTemplateId('tpl-1');

const POLICY = { max_age: 100, retain_disabled: true, retain_deleted_audit: false } as const;

function preference(id: string, owner: OwnerId, at: number, value = '宋体', key = 'font'): PreferenceMemory {
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

function taskFact(id: string, owner: OwnerId, at: number, key = 'deadline', value = '周五'): TaskFactMemory {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'task', task_id: T1, template_id: null },
    source: { kind: 'tool_result', detail: '工具结果' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    task_id: T1,
    fact_key: key,
    value_text: value,
  }) as TaskFactMemory;
}

function templateExperience(id: string, owner: OwnerId, at: number, lesson = '标题用三号'): TemplateExperienceMemory {
  return createMemoryEntry({
    kind: 'template_experience',
    memory_id: asMemoryId(id),
    owner_id: owner,
    scope: { kind: 'template', task_id: null, template_id: TP1 },
    source: { kind: 'inference', detail: '系统推断' },
    confirmation: 'confirmed',
    created_at: at,
    updated_at: at,
    version: 0,
    status: 'active',
    template_id: TP1,
    lesson,
    applies_to_version: 'v1',
  }) as TemplateExperienceMemory;
}

function seed(repo: MemoryRepository, entry: MemoryEntry): void {
  const result = repo.remember(entry);
  if (!result.ok) throw new Error(result.detail);
}

// ---------------------------------------------------------------------------
// 1. 备份计划
// ---------------------------------------------------------------------------

describe('MEM-08 备份计划：四类分型 + 凭据一律不进', () => {
  it('正例：四类分型分别说明，四类都进备份', () => {
    const repo = createMemoryRepository();
    seed(repo, session('msg-1', U1, 1, '我喜欢简洁的排版'));
    seed(repo, taskFact('fact-1', U1, 2, 'deadline', '周五'));
    seed(repo, preference('pref-1', U1, 3));
    seed(repo, templateExperience('tpl-1', U1, 4));

    const plan = planMemoryBackup(repo, { at: asLogicalTime(100) });
    expect(plan.kinds).toHaveLength(4);
    expect(plan.kinds.map((k) => k.kind)).toEqual([
      'session_message',
      'task_fact',
      'preference',
      'template_experience',
    ]);
    // 分型说明：每类都给出范围与理由
    for (const summary of plan.kinds) {
      expect(summary.included).toBe(true);
      expect(summary.total).toBe(1);
      expect(summary.included_count).toBe(1);
      expect(summary.credential_excluded_count).toBe(0);
      expect(summary.reason.length).toBeGreaterThan(0);
    }
    expect(plan.kinds.map((k) => k.scope)).toEqual(['user', 'task', 'user', 'template']);
    expect(plan.included_count).toBe(4);
    expect(plan.credential_leak_detected).toBe(false);
    expect(() => assertNoCredentialLeak(plan)).not.toThrow();
  });

  it('反例（核心）：含凭据字段的条目被剔除并记名；凭据泄漏被检出', () => {
    const repo = createMemoryRepository();
    // (a) 字段名本身就是凭据字段：preference_key = 'api_key'
    seed(repo, preference('leak-key', U1, 1, 'placeholder', 'api_key'));
    // (b) 自由文本里夹带密钥形态
    seed(repo, session('leak-text', U1, 2, '我的 key 是 sk-ABCDEF0123456789ABCDEF 请记住'));
    // (c) 自由文本里的 key=value 赋值
    seed(repo, session('leak-assign', U1, 3, 'password=hunter2secret'));
    // (d) 干净条目（不得误剔）
    seed(repo, preference('clean-1', U1, 4));

    const plan = planMemoryBackup(repo, { at: asLogicalTime(100) });

    const leakedIds = plan.credential_exclusions.map((e) => String(e.memory_id)).sort();
    expect(leakedIds).toEqual(['leak-assign', 'leak-key', 'leak-text']);
    for (const exclusion of plan.credential_exclusions) {
      expect(exclusion.findings.length).toBeGreaterThan(0);
      for (const finding of exclusion.findings) {
        expect(finding.kind === 'sensitive_field' || finding.kind === 'secret_value').toBe(true);
      }
    }
    expect(plan.credential_leak_detected).toBe(true);
    // 剔除后：干净条目仍进备份
    expect(plan.included_ids).toEqual([asMemoryId('clean-1')]);
    expect(plan.included_count).toBe(1);
    // 执行期闸门：带凭据 ⇒ 抛（不编造"备份干净"）
    expect(() => assertNoCredentialLeak(plan)).toThrow(ValidationError);
    expect(() => assertNoCredentialLeak(plan)).toThrow(/凭据/);
  });

  it('反例：无凭据时 exclusions 为空、闸门放行（不误报）', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('pref-1', U1, 1, '宋体', 'font'));
    seed(repo, taskFact('fact-1', U1, 2, 'deadline', '周五'));

    const plan = planMemoryBackup(repo, { at: asLogicalTime(100) });
    expect(plan.credential_exclusions).toEqual([]);
    expect(plan.credential_leak_detected).toBe(false);
    expect(() => assertNoCredentialLeak(plan)).not.toThrow();
    expect(entryHasCredentials(preference('pref-2', U1, 1))).toBe(false);
    expect(scanEntryForCredentials(taskFact('fact-2', U1, 1))).toEqual([]);
  });

  it('备份范围可解释：给 owners 只覆盖该主体', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('pref-1', U1, 1));
    seed(repo, preference('pref-2', U2, 2));

    const plan = planMemoryBackup(repo, { at: asLogicalTime(100), owners: [U1] });
    expect(plan.owner_scope).toEqual([U1]);
    expect(plan.included_ids).toEqual([asMemoryId('pref-1')]);
    expect(plan.total_entries).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 迁移计划（未知必拒 + 可回滚）
// ---------------------------------------------------------------------------

describe('MEM-08 迁移计划：未知 schema 必须拒绝，且可回滚', () => {
  it('正例：同版本 ⇒ 支持且 no-op（变换可用）', () => {
    const plan = planMemoryUpgrade(MEMORY_BACKUP_SCHEMA, MEMORY_BACKUP_SCHEMA);
    expect(plan.supported).toBe(true);
    expect(plan.no_op).toBe(true);
    expect(plan.transform_available).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it('反例：未知来源 / 未知目标 schema ⇒ 拒绝迁移（不猜转换）', () => {
    const unknownFrom = planMemoryUpgrade('potbot-memory-backup.v0-unknown');
    expect(unknownFrom.supported).toBe(false);
    expect(unknownFrom.transform_available).toBe(false);
    expect(unknownFrom.steps).toEqual([]);
    expect(unknownFrom.detail).toContain('拒绝迁移');

    const unknownTo = planMemoryUpgrade(MEMORY_BACKUP_SCHEMA, 'potbot-memory-backup.v9-unknown');
    expect(unknownTo.supported).toBe(false);
    expect(unknownTo.detail).toContain('拒绝迁移');
  });

  it('反例：有登记边但变换未实现 ⇒ 只报路径、不可执行', () => {
    // 合成边：**不代表**任何真实历史版本，仅验证链解析逻辑
    const edges: readonly MemoryUpgradeStep[] = [
      { from: 'synthetic.v0', to: 'synthetic.v1', description: '测试用合成边' },
      { from: 'synthetic.v1', to: MEMORY_BACKUP_SCHEMA, description: '测试用合成边' },
    ];
    const plan = planMemoryUpgrade('synthetic.v0', MEMORY_BACKUP_SCHEMA, { edges });
    expect(plan.supported).toBe(true);
    expect(plan.no_op).toBe(false);
    expect(plan.steps).toHaveLength(2);
    expect(plan.transform_available).toBe(false);
    expect(plan.detail).toContain('未实现');

    const repo = createMemoryRepository();
    const applied = applyMemoryUpgrade(repo, {
      from_schema: 'synthetic.v0',
      at: asLogicalTime(10),
      edges,
    });
    expect(applied.kind).toBe('rejected');
  });

  it('正例：迁移前保留快照 ⇒ 迁移后可回滚到迁移前状态', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('pref-1', U1, 1, '宋体'));
    seed(repo, session('msg-1', U1, 2, '记住我喜欢宋体'));

    const applied = applyMemoryUpgrade(repo, {
      from_schema: MEMORY_BACKUP_SCHEMA,
      at: asLogicalTime(100),
    });
    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') return;
    expect(applied.rollback.entry_count).toBe(2);
    expect(applied.rollback.pre_migration_snapshot).toContain(MEMORY_BACKUP_SCHEMA);

    // 迁移后模拟"出了岔子"：把一条记忆忘记
    repo.forget(asMemoryId('pref-1'), U1);
    expect(repo.get(asMemoryId('pref-1'))).toBeUndefined();

    const rolledBack = rollbackMemoryUpgrade(applied.rollback);
    expect(rolledBack.kind).toBe('rolled_back');
    if (rolledBack.kind !== 'rolled_back') return;
    expect(rolledBack.report.restart_mode).toBe('same_process');
    expect(rolledBack.repository.get(asMemoryId('pref-1'))).toBeDefined();
    expect(rolledBack.repository.get(asMemoryId('msg-1'))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. 保留期：按范围与时间的删除清单 + dry-run 预览
// ---------------------------------------------------------------------------

describe('MEM-08 保留期：按范围与时间给出删除清单，执行前可预览', () => {
  it('正例：按范围（用户/任务/模板）过滤，删除清单带可解释依据', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('u-old', U1, 0)); // 用户范围，很旧
    seed(repo, preference('u-fresh', U1, 950)); // 用户范围，新
    seed(repo, taskFact('t-old', U1, 0)); // 任务范围，很旧
    seed(repo, templateExperience('tpl-old', U1, 0)); // 模板范围，很旧

    const now = asLogicalTime(1000);
    const scoped = planMemoryRetentionScoped(repo, { policy: POLICY, now, filter: { scope_kinds: ['user'] } });
    expect(scoped.dry_run).toBe(true);
    expect(scoped.to_delete.map((c) => String(c.memory_id))).toEqual(['u-old']);
    expect(scoped.keep.map((c) => String(c.memory_id))).toEqual(['u-fresh']);
    // 范围外条目（任务 / 模板）不处理
    expect(scoped.out_of_scope_ids.map(String).sort()).toEqual(['t-old', 'tpl-old']);
    // 每条删除都带"为什么它属于该范围"的依据
    const reason = scoped.to_delete[0]?.reason ?? '';
    expect(reason).toContain('范围 user');
    expect(reason).toContain('超期');
    // 全范围时三类旧条目都在删除清单
    const all = planMemoryRetentionScoped(repo, { policy: POLICY, now });
    expect(all.to_delete.map((c) => String(c.memory_id)).sort()).toEqual(['t-old', 'tpl-old', 'u-old']);
  });

  it('正例：dry-run 预览给出将删 id 列表，且预览不改库', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('u-old', U1, 0));
    seed(repo, preference('u-fresh', U1, 950));

    const plan = planMemoryRetentionScoped(repo, { policy: POLICY, now: asLogicalTime(1000) });
    const preview = previewRetention(plan);
    expect(preview.dry_run).toBe(true);
    expect(preview.will_delete_ids).toEqual([asMemoryId('u-old')]);
    expect(preview.detail).toContain('dry-run');
    // 预览不改库
    expect(repo.get(asMemoryId('u-old'))).toBeDefined();

    // 执行：只删过期，保留期内条目不动
    const outcome = applyRetentionPlan(repo, plan);
    expect(outcome.ok).toBe(true);
    expect(outcome.preview_matched).toBe(true);
    expect(outcome.deleted).toEqual([asMemoryId('u-old')]);
    expect(repo.get(asMemoryId('u-old'))).toBeUndefined();
    expect(repo.get(asMemoryId('u-fresh'))).toBeDefined();
    // 墓碑保留（不复活）
    expect(repo.snapshot().tombstones).toContain(asMemoryId('u-old'));
  });

  it('反例：retain_disabled=true 时停用的旧条目不在删除清单', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('old-disabled', U1, 0));
    repo.disable(asMemoryId('old-disabled'), U1, asLogicalTime(1));

    const keepDisabled = planMemoryRetentionScoped(repo, { policy: POLICY, now: asLogicalTime(1000) });
    expect(keepDisabled.to_delete).toEqual([]);
    expect(keepDisabled.keep.map((c) => String(c.memory_id))).toEqual(['old-disabled']);

    const dropDisabled = planMemoryRetentionScoped(repo, {
      policy: { ...POLICY, retain_disabled: false },
      now: asLogicalTime(1000),
    });
    expect(dropDisabled.to_delete.map((c) => String(c.memory_id))).toEqual(['old-disabled']);
  });
});

// ---------------------------------------------------------------------------
// 4. fail-closed：不确定的一律不删
// ---------------------------------------------------------------------------

describe('MEM-08 fail-closed：不确定项不得被删', () => {
  function malformed(overrides: Record<string, unknown>): MemoryEntry {
    return {
      kind: 'preference',
      memory_id: 'weird-1',
      owner_id: U1,
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: '用户陈述' },
      confirmation: 'confirmed',
      created_at: 0,
      updated_at: 0,
      version: 0,
      status: 'active',
      preference_key: 'font',
      value_text: '宋体',
      ...overrides,
    } as unknown as MemoryEntry;
  }

  it('反例：时间戳不可读 ⇒ 进 uncertain 且绝不进 to_delete', () => {
    const now = asLogicalTime(1000);
    const result = classifyRetention([malformed({ updated_at: Number.NaN })], { policy: POLICY, now });
    expect(result.uncertain).toHaveLength(1);
    expect(result.uncertain[0]?.memory_id).toBe('weird-1');
    expect(result.uncertain[0]?.reason).toContain('时间戳');
    expect(result.to_delete).toEqual([]);
  });

  it('反例：范围种类未知 / 状态未知 / 种类未知 ⇒ 一律不删', () => {
    const now = asLogicalTime(1000);
    const unknownScope = classifyRetention([malformed({ scope: { kind: 'org' } })], { policy: POLICY, now });
    expect(unknownScope.uncertain[0]?.reason).toContain('范围');
    expect(unknownScope.to_delete).toEqual([]);

    const unknownStatus = classifyRetention([malformed({ status: 'archived' })], { policy: POLICY, now });
    expect(unknownStatus.uncertain[0]?.reason).toContain('状态');
    expect(unknownStatus.to_delete).toEqual([]);

    const unknownKind = classifyRetention([malformed({ kind: 'mystery' })], { policy: POLICY, now });
    expect(unknownKind.uncertain[0]?.reason).toContain('种类');
    expect(unknownKind.to_delete).toEqual([]);
  });

  it('正例/反例对照：确定过期的删、不确定的留，二者不相交', () => {
    const now = asLogicalTime(1000);
    const good = preference('clean-old', U1, 0);
    const weird = malformed({ updated_at: Number.NaN });

    const result = classifyRetention([good, weird], { policy: POLICY, now });
    expect(result.to_delete.map((c) => String(c.memory_id))).toEqual(['clean-old']);
    const deleted = new Set(result.to_delete.map((c) => String(c.memory_id)));
    for (const item of result.uncertain) expect(deleted.has(item.memory_id)).toBe(false);
  });

  it('反例：非法保留期 ⇒ 抛（不静默按 0 处理）', () => {
    expect(() =>
      classifyRetention([preference('p', U1, 0)], {
        policy: { max_age: -1, retain_disabled: true, retain_deleted_audit: true },
        now: asLogicalTime(0),
      }),
    ).toThrow(ValidationError);
  });

  it('执行期：applyRetentionPlan 只删重算后仍过期的条目，uncertain 保持不动', () => {
    const repo = createMemoryRepository();
    seed(repo, preference('u-old', U1, 0));
    seed(repo, preference('u-fresh', U1, 950));

    const plan = planMemoryRetentionScoped(repo, { policy: POLICY, now: asLogicalTime(1000) });
    // 结构保证：uncertain 的 id 不会出现在删除清单里
    const deletable = new Set(plan.to_delete.map((c) => String(c.memory_id)));
    for (const item of plan.uncertain) expect(deletable.has(item.memory_id)).toBe(false);
    expect(plan.fail_closed_overrides).toEqual([]);

    const outcome = applyRetentionPlan(repo, plan);
    expect(outcome.uncertain_untouched).toEqual([]);
    expect(outcome.drift).toEqual([]);
    expect(outcome.deleted).toEqual([asMemoryId('u-old')]);
  });
});
