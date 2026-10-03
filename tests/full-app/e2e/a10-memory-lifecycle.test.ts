/**
 * FA-A-E2E —— 需求簇 5：**释放实例、形成经验、忘记、跨用户隔离**（A10 / A15 / A17）。
 *
 * 主张：任务完成后依据真实证据形成经验；下一任务相关经验可用；**修改/忘记后不再注入**；
 * **跨用户不能泄露**；重复点击不重复提交；内存清空后从记录恢复。
 *
 * 真跑落点：
 * - `src/roles/experience-agent.ts` + `src/memory/**` 的经验生命周期（候选 → 评审 → 提交）；
 * - `buildInstanceRecallInjection()` 的有上限注入与隔离审计；
 * - `forgetMemory()` / `invalidateExperience()` 的"忘记后不复活、不再注入"；
 * - 跨用户：B 读不到 A 的经验，B 改 A 的经验被拒；
 * - `VersionFreezer` 同批的实例规则固定（此处用 `bindInstanceExperience` / `resolveInstanceRule`）；
 * - `ActionLedger.click()` 的幂等去重。
 */
import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTemplateId } from '../../../src/protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryRepository,
  evaluateExperienceCandidate,
  type ExperienceCandidate,
  type ExperienceContext,
  type MemorySource,
  type OwnerId,
  type TemplateExperienceMemory,
} from '../../../src/memory/index.js';
import { buildInstanceRecallInjection } from '../../../src/memory/recall-limits.js';
import { forgetMemory, modifyMemory } from '../../../src/memory/forget-cascade.js';
import { invalidateExperience } from '../../../src/memory/experience-merge.js';
import {
  bindInstanceExperience,
  pendingNewLessons,
  rebindInstance,
  resolveInstanceRule,
} from '../../../src/memory/experience-concurrency.js';
import {
  acceptedEntries,
  proposeExperienceCandidates,
  reviewExperienceCandidates,
  type SealedEvidence,
} from '../../../src/roles/index.js';
import { ActionLedger } from '../../../src/workledger/index.js';

import { DEMO_TASK, INSTANCE_A, REV_10, T1, T2 } from './harness.js';

const USER_A: OwnerId = asOwnerId('user-a');
const USER_B: OwnerId = asOwnerId('user-b');
const TPL = asTemplateId('template.document');
const SOURCE: MemorySource = { kind: 'tool_result', detail: '已封存的产物回执' };

function contextFor(existing: readonly TemplateExperienceMemory[], owner: OwnerId, ids: () => string): ExperienceContext {
  return {
    owner_id: owner,
    existing,
    isSensitive: () => false,
    detectConflict: () => false,
    source: SOURCE,
    newMemoryId: () => asMemoryId(ids()),
  };
}

function sealedSuccess(lesson: string): SealedEvidence {
  return {
    evidence_ref: `ev-${lesson}`,
    template_id: TPL,
    sealed: true,
    readback_verified: true,
    outcome: 'success',
    lesson,
    applies_to_version: '0.9.0',
  };
}

/** 走真实角色/记忆层，把一条"已核验成功"固化成经验并返回其记录。 */
function commitLesson(
  repo: ReturnType<typeof createMemoryRepository>,
  lesson: string,
  ids: () => string,
): TemplateExperienceMemory {
  const proposal = proposeExperienceCandidates([sealedSuccess(lesson)]);
  expect(proposal.rejections).toEqual([]);
  const existing = repo.listByKind('template_experience') as readonly TemplateExperienceMemory[];
  const review = reviewExperienceCandidates(proposal.candidates, contextFor(existing, USER_A, ids), asLogicalTime(10));
  const accepted = acceptedEntries(review);
  expect(accepted.length).toBe(1);
  const entry = accepted[0]!;
  const written = repo.remember(entry);
  expect(written.ok).toBe(true);
  return entry;
}

describe('任务完成后形成经验；下一任务可用；忘记后不再注入', () => {
  it('经验在后续任务被注入；忘记后不再注入且不复活', () => {
    const repo = createMemoryRepository();
    let n = 0;
    const ids = () => `exp-${String(++n)}`;
    const entry = commitLesson(repo, '图表与表格用同一套配色', ids);

    // 下一任务：注入。
    const before = buildInstanceRecallInjection(repo, {
      owner_id: USER_A,
      instance_id: 'inst-next',
      template_id: TPL,
      kinds: ['template_experience'],
    });
    expect(before.status).toBe('found');
    expect(before.digest).toContain('图表与表格用同一套配色');
    expect(before.included_ids).toContain(entry.memory_id);

    // 忘记。
    const forgotten = forgetMemory(repo, { memory_id: entry.memory_id, owner_id: USER_A });
    expect(forgotten.ok).toBe(true);
    expect(forgotten.affected).toContain(entry.memory_id);

    const after = buildInstanceRecallInjection(repo, {
      owner_id: USER_A,
      instance_id: 'inst-after-forget',
      template_id: TPL,
      kinds: ['template_experience'],
    });
    expect(after.status).toBe('not_found');
    expect(after.digest).toBe('');
    expect(after.included_ids).not.toContain(entry.memory_id);

    // 忘记不复活：同一条经验再写入被拒。
    expect(repo.remember(entry)).toEqual({ ok: false, reason: 'forgotten_id', detail: expect.any(String) });
  });

  it('修改经验：内容更新；要停止注入必须失效/停用而非改文', () => {
    const repo = createMemoryRepository();
    let n = 0;
    const ids = () => `exp-${String(++n)}`;
    const entry = commitLesson(repo, '初版经验', ids);

    const edited = modifyMemory(repo, {
      memory_id: entry.memory_id,
      owner_id: USER_A,
      patch: { lesson: '修订后的经验' },
      at: asLogicalTime(20),
    });
    expect(edited.ok).toBe(true);
    const injection = buildInstanceRecallInjection(repo, {
      owner_id: USER_A,
      instance_id: 'inst-edit',
      template_id: TPL,
      kinds: ['template_experience'],
    });
    expect(injection.digest).toContain('修订后的经验');

    // 失效后不再注入（内容仍在，可带 include_disabled 读回）。
    const invalidated = invalidateExperience({
      repository: repo,
      owner_id: USER_A,
      memory_id: entry.memory_id,
      at: asLogicalTime(21),
      reason: '已被更新的做法取代',
    });
    expect(invalidated.kind).toBe('invalidated');
    const gone = buildInstanceRecallInjection(repo, {
      owner_id: USER_A,
      instance_id: 'inst-invalidated',
      template_id: TPL,
      kinds: ['template_experience'],
    });
    expect(gone.status).toBe('not_found');
    const readback = repo.recall({ owner_id: USER_A, kinds: ['template_experience'], include_disabled: true });
    expect(readback.entries.map((row) => row.memory_id)).toContain(entry.memory_id);
  });

  it('跨用户不泄露：B 读不到 A 的经验，也改不动', () => {
    const repo = createMemoryRepository();
    let n = 0;
    const ids = () => `exp-${String(++n)}`;
    const entry = commitLesson(repo, 'A 的私有经验', ids);

    const asB = buildInstanceRecallInjection(repo, {
      owner_id: USER_B,
      instance_id: 'inst-b',
      template_id: TPL,
      kinds: ['template_experience'],
    });
    expect(asB.status).toBe('not_found');
    expect(asB.digest).toBe('');
    expect(asB.audit.foreign_excluded).toBeGreaterThanOrEqual(1);

    const bEdit = repo.modify(entry.memory_id, USER_B, { lesson: 'B 想改' }, asLogicalTime(30));
    expect(bEdit.ok).toBe(false);
    if (!bEdit.ok) expect(bEdit.reason).toBe('owner_mismatch');
  });

  it('A17 污染防护：未核验成功不得固化', () => {
    // (a) 未封存的证据在候选阶段就被拒。
    const unsealed = proposeExperienceCandidates([
      { ...sealedSuccess('未封存的做法'), sealed: false },
    ]);
    expect(unsealed.candidates).toEqual([]);
    expect(unsealed.rejections.map((r) => r.code)).toContain('evidence_not_sealed');

    // (b) 结果未知的外部操作不得固化为经验。
    const unknown: ExperienceCandidate = {
      template_id: TPL,
      lesson: '外部结果未知的做法',
      evidence_refs: ['ev-x'],
      evidence_kind: 'unknown_external',
      applies_to_version: '0.9.0',
      supersedes_lesson: null,
    };
    let n = 0;
    const decision = evaluateExperienceCandidate(unknown, contextFor([], USER_A, () => `x-${String(++n)}`), asLogicalTime(40));
    expect(decision.decision).toBe('reject');
    expect(decision.entry).toBeNull();
  });

  it('A17 实例规则固定：绑定后新增的经验不被旧实例采纳，重绑才生效', () => {
    const repo = createMemoryRepository();
    let n = 0;
    const ids = () => `exp-${String(++n)}`;
    commitLesson(repo, '绑定时的经验', ids);

    const binding = bindInstanceExperience(repo, {
      instance_id: 'inst-frozen',
      owner_id: USER_A,
      template_id: TPL,
      at: asLogicalTime(50),
    });
    expect(resolveInstanceRule(binding, '绑定时的经验').allowed).toBe(true);

    // 绑定后新增一条经验。
    const later = '绑定后新增的经验';
    const proposal = proposeExperienceCandidates([sealedSuccess(later)]);
    const existing = repo.listByKind('template_experience') as readonly TemplateExperienceMemory[];
    const review = reviewExperienceCandidates(proposal.candidates, contextFor(existing, USER_A, ids), asLogicalTime(51));
    for (const entry of acceptedEntries(review)) expect(repo.remember(entry).ok).toBe(true);

    // 旧实例不热换规则：新经验不被采纳。
    expect(resolveInstanceRule(binding, later).allowed).toBe(false);
    expect(pendingNewLessons(binding, repo)).toContain(later);

    const rebound = rebindInstance(binding, repo, { new_instance_id: 'inst-frozen-2', at: asLogicalTime(52) });
    expect(resolveInstanceRule(rebound, later).allowed).toBe(true);
  });
});

describe('A10 释放实例/内存清空后从记录恢复', () => {
  it('记忆仓库 snapshot → 新仓库 restore：仍能检索到', () => {
    const repo = createMemoryRepository();
    let n = 0;
    const ids = () => `exp-${String(++n)}`;
    const entry = commitLesson(repo, '可恢复的经验', ids);
    const snapshot = repo.snapshot();

    // “释放实例” = 丢掉原仓库，从序列化快照重建。
    const restored = createMemoryRepository();
    restored.restoreSnapshot(snapshot);
    const injection = buildInstanceRecallInjection(restored, {
      owner_id: USER_A,
      instance_id: 'inst-restored',
      template_id: TPL,
      kinds: ['template_experience'],
    });
    expect(injection.status).toBe('found');
    expect(injection.included_ids).toContain(entry.memory_id);
  });
});

describe('A15 重复点击气泡：内核不重复提交同一动作', () => {
  it('两次点击命中同一台账对象，第二次零新增副作用', () => {
    const ledger = new ActionLedger();
    let n = 0;
    const input = {
      next_action_id: () => `act-${String(++n)}`,
      task_id: DEMO_TASK,
      task_revision: REV_10,
      action_kind: 'calendar.create',
      params: { title: '筹备会', at: '2026-10-04' },
      authorization: {
        source: 'conversation-confirm',
        user_approved: true,
        task_revision: REV_10,
        revoked: false,
        subject_instance_id: INSTANCE_A,
        granted_at: T1,
      },
      at: T1,
    };
    const first = ledger.click(input);
    const second = ledger.click(input);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.action).toBe(first.action);
    expect(second.side_effects_applied).toBe(0);
    expect(ledger.size).toBe(1);

    // 同版本改参数 ⇒ 是另一个动作（不同幂等键）。
    const third = ledger.click({ ...input, params: { title: '筹备会', at: '2026-10-05' }, at: T2 });
    expect(third.duplicate).toBe(false);
    expect(ledger.size).toBe(2);
  });
});

describe('记忆/经验 —— 显式跳过（需真机/真实模型）', () => {
  it.skip('跨用户隔离的真机多账号实测 → 需真机 + 多账号；本批只证明模型层隔离', () => {
    // 见 a-items.ts 的 A17 honesty：真实实例的行为改变未验证。
  });
});
