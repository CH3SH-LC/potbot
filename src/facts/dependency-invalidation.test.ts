/**
 * 共享事实更新的依赖失效（FA-CHAT-FACTS / CHAT-06；R213 / R251）单测。
 *
 * 覆盖四条：版本绑定（含迟到指令拒绝）、依赖闭包（含环 / 自环下的终止）、
 * 只更新受影响产物（无关产物不得被无谓重写）、旧气泡过期（旧 revision 不可再执行）。
 * 并含**反向对照**：改人数却把无关产物也重写、旧气泡仍被执行、历史未保留、该改的没改
 * ——四类错误都必须被 `checkInvalidationPlan()` 抓到。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  type ArtifactRecord,
  type ArtifactRef,
  type FactRef,
  type Revision,
  type SharedFactRecord,
  type TaskId,
  type TemplateKind,
} from '../protocol/index.js';
import { DependencyError } from '../dependency/index.js';
import { createDecisionBubble, prepareAction, type ActionRecord } from '../workledger/index.js';

import {
  checkInvalidationPlan,
  isInstructionStale,
  planInvalidation,
  type FactChangeBinding,
  type InvalidationRequest,
  type SharedFactUpdate,
} from './dependency-invalidation.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T1 = asTaskId('T1');
const T2 = asTaskId('T2');
const R1 = asRevision(1);
const R2 = asRevision(2);
const R3 = asRevision(3);
const AT = asLogicalTime(100);
const INSTANCE = asInstanceId('inst-A');

const F_HEAD_8 = asFactRef('fact-headcount-8');
const F_HEAD_10 = asFactRef('fact-headcount-10');
const F_BUDGET = asFactRef('fact-budget-5000');

function published(input: {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly facts: readonly string[];
  readonly deps?: readonly string[];
  readonly task?: TaskId;
  readonly revision?: Revision;
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: input.id as ArtifactRef,
    task_id: input.task ?? T1,
    task_revision: input.revision ?? R1,
    artifact_version: 1,
    template_kind: input.kind,
    byte_length: 128,
    content_digest: `digest-${input.id}`,
    source_fact_refs: input.facts as readonly FactRef[],
    dependency_artifact_refs: (input.deps ?? []) as readonly ArtifactRef[],
    created_by_instance_id: INSTANCE,
    status: 'published',
    verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '结构自检通过' }],
    receipt: {
      final_path: `/out/${input.id}`,
      readback_digest: `rb-${input.id}`,
      verifier: 'independent-reader',
      at: AT,
    },
    created_at: AT,
  });
}

function superseded(input: {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly facts: readonly string[];
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: input.id as ArtifactRef,
    task_id: T1,
    task_revision: R1,
    artifact_version: 1,
    template_kind: input.kind,
    byte_length: 64,
    content_digest: `digest-${input.id}`,
    source_fact_refs: input.facts as readonly FactRef[],
    created_by_instance_id: INSTANCE,
    status: 'superseded',
    created_at: AT,
  });
}

/** 一句话改人数的标准夹具：A / B 引用人数；D 依赖 A；C / E 与人数无关；H 是历史版本。 */
function standardArtifacts(): readonly ArtifactRecord[] {
  return [
    published({ id: 'artA', kind: 'document', facts: [F_HEAD_8] }),
    published({ id: 'artB', kind: 'presentation', facts: [F_HEAD_8] }),
    published({ id: 'artC', kind: 'spreadsheet', facts: [F_BUDGET] }),
    published({ id: 'artD', kind: 'document', facts: [F_BUDGET], deps: ['artA'] }),
    published({ id: 'artE', kind: 'presentation', facts: [F_BUDGET] }),
    superseded({ id: 'artH', kind: 'document', facts: [F_HEAD_8] }),
  ];
}

const HEADCOUNT_UPDATE: readonly SharedFactUpdate[] = [
  { fact_key: 'headcount', previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_10 },
];

function binding(overrides: Partial<FactChangeBinding> = {}): FactChangeBinding {
  return {
    instruction_id: 'instr-1',
    utterance: '把人数改成十人',
    task_id: T1,
    task_revision: R2,
    at: AT,
    ...overrides,
  };
}

function plan(overrides: Partial<InvalidationRequest> = {}) {
  return planInvalidation({
    binding: binding(),
    updates: HEADCOUNT_UPDATE,
    artifacts: standardArtifacts(),
    ...overrides,
  });
}

function auth(revision: Revision) {
  return {
    source: 'user_session',
    user_approved: true,
    task_revision: revision,
    revoked: false,
    subject_instance_id: INSTANCE,
    granted_at: AT,
  };
}

function action(actionId: string, revision: Revision, params: unknown): ActionRecord {
  return prepareAction({
    action_id: actionId,
    task_id: T1,
    task_revision: revision,
    action_kind: 'send_document',
    params,
    authorization: auth(revision),
    at: AT,
  });
}

// ---------------------------------------------------------------------------
// 版本绑定
// ---------------------------------------------------------------------------

describe('版本绑定：一句话钉到任务 + 版本', () => {
  it('绑定版本 = 当前版本 ⇒ 不判过期', () => {
    expect(isInstructionStale(binding({ task_revision: R2, current_task_revision: R2 }))).toBe(false);
  });

  it('绑定版本落后于当前版本 ⇒ 指令过期（迟到指令不得改错版本）', () => {
    const stale = binding({ task_revision: R1, current_task_revision: R3 });
    expect(isInstructionStale(stale)).toBe(true);
    expect(() =>
      planInvalidation({ binding: stale, updates: HEADCOUNT_UPDATE, artifacts: standardArtifacts() }),
    ).toThrow(DependencyError);
  });

  it('未给 current_task_revision ⇒ 不判过期（向后兼容路径）', () => {
    expect(isInstructionStale(binding())).toBe(false);
    expect(() => plan()).not.toThrow();
  });

  it('事实更新落在绑定版本上：新产物 id 由绑定版本派生', () => {
    const result = plan();
    expect(result.affected.length).toBeGreaterThan(0);
    expect(String(result.affected[0]?.new_artifact_id)).toMatch(/^art-/);
  });
});

// ---------------------------------------------------------------------------
// 依赖闭包
// ---------------------------------------------------------------------------

describe('依赖闭包：直接命中 + 传递命中，且只更新受影响产物', () => {
  const result = plan();

  it('直接命中：引用被改事实的产物受影响（A / B）', () => {
    const direct = result.affected.filter((entry) => entry.reason === 'source_fact_changed');
    expect(direct.map((entry) => String(entry.artifact_id))).toEqual(['artA', 'artB']);
    for (const entry of direct) {
      expect(entry.via_fact_keys).toEqual(['headcount']);
      expect(entry.depth).toBe(0);
    }
  });

  it('传递命中：依赖到受影响产物的产物也受影响（D 依赖 A）', () => {
    const transitive = result.affected.filter((entry) => entry.reason === 'dependency_artifact_changed');
    expect(transitive.map((entry) => String(entry.artifact_id))).toEqual(['artD']);
    expect(transitive[0]?.via_artifact_ids).toEqual(['artA']);
    expect(transitive[0]?.depth).toBe(1);
  });

  it('无关产物在"不动清单"里、且**不在**受影响集合里（无关信息不重写）', () => {
    expect(result.untouched_artifact_ids.map(String)).toEqual(['artC', 'artE']);
    expect(result.affected.map((entry) => String(entry.artifact_id))).not.toContain('artC');
    expect(result.affected.map((entry) => String(entry.artifact_id))).not.toContain('artE');
  });

  it('历史产物（superseded）保留、不得被重写', () => {
    expect(result.preserved_artifact_ids).toContain('artH');
    expect(result.affected.map((entry) => String(entry.artifact_id))).not.toContain('artH');
  });

  it('新版本号 = 旧版本号 + 1，且新 id 与旧 id 不同（版本化写入，旧文件不被覆盖）', () => {
    for (const entry of result.affected) {
      expect(entry.to_version).toBe(entry.from_version + 1);
      expect(String(entry.new_artifact_id)).not.toBe(String(entry.artifact_id));
    }
  });

  it('闭包终止：每个产物最多出队一次（closure_visits 每项恒为 1）', () => {
    for (const visits of Object.values(result.closure_visits)) {
      expect(visits).toBe(1);
    }
  });

  it('重放同一输入 ⇒ 同一计划摘要（确定性）', () => {
    expect(plan().digest).toBe(result.digest);
  });

  it('只判本任务的产物：其它任务的产品既不进受影响也不进不动清单', () => {
    const artifacts = [...standardArtifacts(), published({ id: 'artOther', kind: 'document', facts: [F_HEAD_8], task: T2 })];
    const scoped = planInvalidation({ binding: binding(), updates: HEADCOUNT_UPDATE, artifacts });
    const all = [...scoped.affected.map((e) => String(e.artifact_id)), ...scoped.untouched_artifact_ids.map(String)];
    expect(all).not.toContain('artOther');
  });
});

describe('闭包终止：环与自环下仍是有限步', () => {
  it('产物依赖成环（artX ⇄ artY），只处理一次、不无限循环', () => {
    const artifacts = [
      published({ id: 'artX', kind: 'document', facts: [F_HEAD_8], deps: ['artY'] }),
      published({ id: 'artY', kind: 'presentation', facts: [F_BUDGET], deps: ['artX'] }),
    ];
    const result = planInvalidation({ binding: binding(), updates: HEADCOUNT_UPDATE, artifacts });
    expect(result.affected.map((e) => String(e.artifact_id))).toEqual(['artX', 'artY']);
    expect(result.closure_visits).toEqual({ artX: 1, artY: 1 });
  });

  it('产物依赖自环（artZ 依赖自己），不无限循环', () => {
    const artifacts = [published({ id: 'artZ', kind: 'document', facts: [F_HEAD_8], deps: ['artZ'] })];
    const result = planInvalidation({ binding: binding(), updates: HEADCOUNT_UPDATE, artifacts });
    expect(result.affected.map((e) => String(e.artifact_id))).toEqual(['artZ']);
    expect(result.closure_visits).toEqual({ artZ: 1 });
  });
});

// ---------------------------------------------------------------------------
// 旧气泡过期
// ---------------------------------------------------------------------------

describe('旧气泡过期：旧 revision 的气泡不可再执行', () => {
  it('气泡绑定旧版本 ⇒ stale_bubble，进 expired_bubble_ids', () => {
    const record = action('act-1', R1, { to: 'a@b.com' });
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = planInvalidation({
      binding: binding(), // 绑定 R2
      updates: HEADCOUNT_UPDATE,
      artifacts: standardArtifacts(),
      bubbles: [bubble],
      actions: [record],
    });
    expect(result.expired_bubble_ids).toEqual(['bub-old']);
    const entry = result.bubbles[0];
    expect(entry?.expired).toBe(true);
    expect(entry?.reason).toBe('stale_bubble');
  });

  it('参数已变（同 action_id 但参数摘要不同）⇒ bubble_action_mismatch', () => {
    const shown = action('act-2', R2, { to: 'a@b.com' });
    const bubble = createDecisionBubble(shown, 'bub-param', AT);
    const changed = action('act-2', R2, { to: 'c@d.com' }); // 参数变了就是另一个动作
    const result = planInvalidation({
      binding: binding({ task_revision: R2, current_task_revision: R2 }),
      updates: HEADCOUNT_UPDATE,
      artifacts: standardArtifacts(),
      bubbles: [bubble],
      actions: [changed],
    });
    expect(result.bubbles[0]?.expired).toBe(true);
    expect(result.bubbles[0]?.reason).toBe('bubble_action_mismatch');
  });

  it('绑当前版本且参数未变 ⇒ 未过期（可执行）', () => {
    const record = action('act-3', R2, { to: 'a@b.com' });
    const bubble = createDecisionBubble(record, 'bub-ok', AT);
    const result = planInvalidation({
      binding: binding({ task_revision: R2, current_task_revision: R2 }),
      updates: HEADCOUNT_UPDATE,
      artifacts: standardArtifacts(),
      bubbles: [bubble],
      actions: [record],
    });
    expect(result.expired_bubble_ids).toEqual([]);
    expect(result.bubbles[0]?.expired).toBe(false);
    expect(result.bubbles[0]?.reason).toBeNull();
  });

  it('动作记录缺失 ⇒ 判过期（unknown_action），拒绝猜测', () => {
    const record = action('act-4', R1, { to: 'a@b.com' });
    const bubble = createDecisionBubble(record, 'bub-gone', AT);
    const result = planInvalidation({
      binding: binding(),
      updates: HEADCOUNT_UPDATE,
      artifacts: standardArtifacts(),
      bubbles: [bubble],
      actions: [],
    });
    expect(result.bubbles[0]?.expired).toBe(true);
    expect(result.bubbles[0]?.reason).toBe('unknown_action');
  });

  it('给了 bubbles 却没给 actions ⇒ 抛 DependencyError（没有动作对象不判）', () => {
    const record = action('act-5', R1, { to: 'a@b.com' });
    const bubble = createDecisionBubble(record, 'bub-x', AT);
    expect(() =>
      planInvalidation({
        binding: binding(),
        updates: HEADCOUNT_UPDATE,
        artifacts: standardArtifacts(),
        bubbles: [bubble],
      }),
    ).toThrow(DependencyError);
  });
});

// ---------------------------------------------------------------------------
// 反向对照：抓错器必须抓到
// ---------------------------------------------------------------------------

describe('反向对照：错误实现必须被 checkInvalidationPlan 抓到', () => {
  it('正向：按计划重写 affected、保留历史、不执行过期气泡 ⇒ 无违规', () => {
    const result = plan();
    const violations = checkInvalidationPlan(result, {
      rewritten_artifact_ids: result.affected.map((entry) => entry.artifact_id),
      preserved_artifact_ids: result.affected.map((entry) => entry.artifact_id),
      executed_bubble_ids: [],
    });
    expect(violations).toEqual([]);
  });

  it('反例①：改了人数却把无关产物 artC 也重写 ⇒ unaffected_artifact_rewritten', () => {
    const result = plan();
    const violations = checkInvalidationPlan(result, {
      rewritten_artifact_ids: [...result.affected.map((entry) => entry.artifact_id), asArtifactRef('artC')],
      preserved_artifact_ids: result.affected.map((entry) => entry.artifact_id),
    });
    const codes = violations.map((entry) => entry.code);
    expect(codes).toContain('unaffected_artifact_rewritten');
    expect(violations.find((entry) => entry.code === 'unaffected_artifact_rewritten')?.subject_id).toBe('artC');
  });

  it('反例②：旧气泡仍被执行 ⇒ expired_bubble_executed', () => {
    const record = action('act-old', R1, { to: 'a@b.com' });
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = planInvalidation({
      binding: binding(),
      updates: HEADCOUNT_UPDATE,
      artifacts: standardArtifacts(),
      bubbles: [bubble],
      actions: [record],
    });
    expect(result.expired_bubble_ids).toEqual(['bub-old']);
    const violations = checkInvalidationPlan(result, {
      rewritten_artifact_ids: result.affected.map((entry) => entry.artifact_id),
      preserved_artifact_ids: result.affected.map((entry) => entry.artifact_id),
      executed_bubble_ids: ['bub-old'],
    });
    expect(violations.map((entry) => entry.code)).toContain('expired_bubble_executed');
  });

  it('反例③：历史未保留（旧版本被覆盖）⇒ history_not_preserved', () => {
    const result = plan();
    const violations = checkInvalidationPlan(result, {
      rewritten_artifact_ids: result.affected.map((entry) => entry.artifact_id),
      preserved_artifact_ids: [],
    });
    expect(violations.map((entry) => entry.code)).toContain('history_not_preserved');
  });

  it('反例④：该改的没改 ⇒ affected_artifact_not_rewritten', () => {
    const result = plan();
    const violations = checkInvalidationPlan(result, {
      rewritten_artifact_ids: [],
      preserved_artifact_ids: result.affected.map((entry) => entry.artifact_id),
    });
    const codes = violations.map((entry) => entry.code);
    expect(codes).toContain('affected_artifact_not_rewritten');
    expect(codes.filter((code) => code === 'affected_artifact_not_rewritten')).toHaveLength(result.affected.length);
  });

  it('反例⑤：同一产物被重写两次 ⇒ duplicate_rewrite', () => {
    const result = plan();
    const first = result.affected[0];
    expect(first).toBeDefined();
    const violations = checkInvalidationPlan(result, {
      rewritten_artifact_ids: [first!.artifact_id, first!.artifact_id],
      preserved_artifact_ids: result.affected.map((entry) => entry.artifact_id),
    });
    expect(violations.map((entry) => entry.code)).toContain('duplicate_rewrite');
  });
});

// ---------------------------------------------------------------------------
// 形状校验
// ---------------------------------------------------------------------------

describe('形状校验：不猜、不静默', () => {
  it('一次指令里同一事实键出现两次 ⇒ 抛 ValidationError', () => {
    const duplicated: readonly SharedFactUpdate[] = [
      { fact_key: 'headcount', previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_10 },
      { fact_key: 'headcount', previous_fact_id: F_HEAD_10, new_fact_id: asFactRef('fact-headcount-12') },
    ];
    expect(() => planInvalidation({ binding: binding(), updates: duplicated, artifacts: [] })).toThrow();
  });

  it('事实取代自己 ⇒ 抛（新事实不得等于旧事实）', () => {
    expect(() =>
      planInvalidation({
        binding: binding(),
        updates: [{ fact_key: 'headcount', previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_8 }],
        artifacts: [],
      }),
    ).toThrow();
  });

  it('首次登记（previous_fact_id = null）⇒ 不直接命中任何产物', () => {
    const result = planInvalidation({
      binding: binding(),
      updates: [{ fact_key: 'new.key', previous_fact_id: null, new_fact_id: asFactRef('fact-new') }],
      artifacts: standardArtifacts(),
    });
    expect(result.affected).toEqual([]);
    expect(result.untouched_artifact_ids.map(String)).toEqual(['artA', 'artB', 'artC', 'artD', 'artE']);
  });

  it('事实值（夹具级）：headcount 8 / 10 都是合法 known 事实，且 10 取代 8', () => {
    const facts: SharedFactRecord[] = [
      createSharedFactRecord({
        fact_id: F_HEAD_8,
        task_id: T1,
        task_revision: R1,
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
        source: { kind: 'user_confirmation', detail: '用户确认' },
        confirmed_by: INSTANCE,
        confirmed_at: AT,
      }),
      createSharedFactRecord({
        fact_id: F_HEAD_10,
        task_id: T1,
        task_revision: R2,
        fact_key: 'headcount',
        value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
        source: { kind: 'user_confirmation', detail: '用户改口' },
        confirmed_by: INSTANCE,
        confirmed_at: asLogicalTime(200),
        supersedes_fact_id: F_HEAD_8,
      }),
    ];
    expect(facts[1]?.supersedes_fact_id).toBe(F_HEAD_8);
  });
});
