/**
 * 一句话改多个关联产物的事务视图（FA-CHAT-FACTS / CHAT-06；R213 / R251）单测。
 *
 * 覆盖：事实更新 → 受影响产物集合 → 各自新版本，被编排成一次可核对的事务视图；
 * "无关信息不重写"的内部一致性 + 反向对照断言；
 * 事实值缺失如实标 null（不当零）；视图自相矛盾的三类内部违规必须被核对器抓到。
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
  buildMultiArtifactTransaction,
  checkTransactionView,
  describeTransactionView,
  type MultiArtifactInstruction,
  type MultiArtifactTransactionView,
  type MultiArtifactUpdateRequest,
} from './multi-artifact-update.js';
import { type SharedFactUpdate } from './dependency-invalidation.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T1 = asTaskId('T1');
const R1 = asRevision(1);
const R2 = asRevision(2);
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
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: input.id as ArtifactRef,
    task_id: input.task ?? T1,
    task_revision: R1,
    artifact_version: 1,
    template_kind: input.kind,
    byte_length: 128,
    content_digest: `digest-${input.id}`,
    source_fact_refs: input.facts as readonly FactRef[],
    dependency_artifact_refs: (input.deps ?? []) as readonly ArtifactRef[],
    created_by_instance_id: INSTANCE,
    status: 'published',
    verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '结构自检通过' }],
    receipt: { final_path: `/out/${input.id}`, readback_digest: `rb-${input.id}`, verifier: 'reader', at: AT },
    created_at: AT,
  });
}

function historical(input: {
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

function artifacts(): readonly ArtifactRecord[] {
  return [
    published({ id: 'artA', kind: 'document', facts: [F_HEAD_8] }),
    published({ id: 'artB', kind: 'presentation', facts: [F_HEAD_8] }),
    published({ id: 'artC', kind: 'spreadsheet', facts: [F_BUDGET] }),
    published({ id: 'artD', kind: 'document', facts: [F_BUDGET], deps: ['artA'] }),
    published({ id: 'artE', kind: 'presentation', facts: [F_BUDGET] }),
    historical({ id: 'artH', kind: 'document', facts: [F_HEAD_8] }),
  ];
}

const UPDATES: readonly SharedFactUpdate[] = [
  { fact_key: 'headcount', previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_10 },
];

function facts(): readonly SharedFactRecord[] {
  return [
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
}

function instruction(overrides: Partial<MultiArtifactInstruction> = {}): MultiArtifactInstruction {
  return {
    instruction_id: 'instr-1',
    utterance: '把人数改成十人',
    task_id: T1,
    from_revision: R1,
    to_revision: R2,
    at: AT,
    ...overrides,
  };
}

function build(overrides: Partial<MultiArtifactUpdateRequest> = {}): MultiArtifactTransactionView {
  return buildMultiArtifactTransaction({
    instruction: instruction(),
    updates: UPDATES,
    artifacts: artifacts(),
    facts: facts(),
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
// 视图内容
// ---------------------------------------------------------------------------

describe('事务视图：事实更新 → 受影响产物 → 各自新版本', () => {
  const view = build();

  it('事实变更摊开成"旧值 → 新值"（8 人 → 10 人）', () => {
    expect(view.fact_changes).toHaveLength(1);
    const change = view.fact_changes[0];
    expect(change?.fact_key).toBe('headcount');
    expect(change?.previous_value).toEqual({
      kind: 'known',
      value: { type: 'number', amount: 8, unit: '人', currency: null },
    });
    expect(change?.new_value).toEqual({
      kind: 'known',
      value: { type: 'number', amount: 10, unit: '人', currency: null },
    });
  });

  it('受影响产物各自带新版本与新 id（A / B 直接，D 传递）', () => {
    expect(view.artifact_entries.map((entry) => String(entry.artifact_id))).toEqual([
      'artA',
      'artB',
      'artD',
    ]);
    for (const entry of view.artifact_entries) {
      expect(entry.to_version).toBe(entry.from_version + 1);
      expect(entry.task_revision).toBe(R2);
      expect(String(entry.new_artifact_id)).not.toBe(String(entry.artifact_id));
    }
    expect(view.artifact_entries.find((entry) => String(entry.artifact_id) === 'artD')?.reason).toBe(
      'dependency_artifact_changed',
    );
  });

  it('无关产物进"不动清单"，历史产物进"保留清单"', () => {
    expect(view.untouched_artifact_ids.map(String)).toEqual(['artC', 'artE']);
    expect(view.preserved_artifact_ids).toEqual(['artH']);
  });

  it('汇总计数与明细一致', () => {
    expect(view.totals).toEqual({
      facts_changed: 1,
      artifacts_updated: 3,
      artifacts_untouched: 2,
      artifacts_preserved: 1,
      bubbles_total: 0,
      bubbles_expired: 0,
    });
  });

  it('版本绑定：视图记录 from_revision → to_revision', () => {
    expect(view.from_revision).toBe(R1);
    expect(view.to_revision).toBe(R2);
  });

  it('重放同一输入 ⇒ 同一复核摘要（确定性）', () => {
    expect(build().review_digest).toBe(view.review_digest);
  });

  it('可读摘要含"改了哪些、哪些没动"', () => {
    const text = describeTransactionView(view);
    expect(text).toContain('8 人 → 10 人');
    expect(text).toContain('未动 2 个');
    expect(text).toContain('artA');
  });
});

describe('事实值缺失：如实标 null，不当零（R248）', () => {
  it('未提供 facts 记录 ⇒ previous_value / new_value 都是 null，而非 0', () => {
    const view = build({ facts: [] });
    expect(view.fact_changes[0]?.previous_value).toBeNull();
    expect(view.fact_changes[0]?.new_value).toBeNull();
    expect(describeTransactionView(view)).toContain('未登记，≠ 0');
  });
});

// ---------------------------------------------------------------------------
// 无关信息不重写：正向 + 反向对照
// ---------------------------------------------------------------------------

describe('"无关信息不重写"：正向无违规，反向必须被抓到', () => {
  const view = build();

  it('正向：按视图更新 affected 并保留历史 ⇒ 无违规', () => {
    const violations = checkTransactionView(view, {
      updated_artifact_ids: view.artifact_entries.map((entry) => entry.artifact_id),
    });
    expect(violations).toEqual([]);
  });

  it('反例①：改了人数却把无关产物 artC 也重写 ⇒ unrelated_artifact_rewritten（反向对照）', () => {
    const violations = checkTransactionView(view, {
      updated_artifact_ids: [...view.artifact_entries.map((entry) => entry.artifact_id), asArtifactRef('artC')],
    });
    expect(violations.map((entry) => entry.code)).toContain('unrelated_artifact_rewritten');
    expect(violations.find((entry) => entry.code === 'unrelated_artifact_rewritten')?.subject_id).toBe('artC');
  });

  it('反例②：该更新的产物没更新 ⇒ affected_artifact_missing（反向对照）', () => {
    const violations = checkTransactionView(view, { updated_artifact_ids: [] });
    const missing = violations.filter((entry) => entry.code === 'affected_artifact_missing');
    expect(missing.map((entry) => entry.subject_id)).toEqual(['artA', 'artB', 'artD']);
  });

  it('反例③：旧气泡仍被执行 ⇒ expired_bubble_executed（反向对照）', () => {
    const record = action('act-old', R1, { to: 'a@b.com' });
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const withBubble = build({ bubbles: [bubble], actions: [record] });
    expect(withBubble.totals.bubbles_expired).toBe(1);
    const violations = checkTransactionView(withBubble, {
      updated_artifact_ids: withBubble.artifact_entries.map((entry) => entry.artifact_id),
      executed_bubble_ids: ['bub-old'],
    });
    expect(violations.map((entry) => entry.code)).toContain('expired_bubble_executed');
  });
});

// ---------------------------------------------------------------------------
// 内部一致性：自相矛盾的视图必须被抓到
// ---------------------------------------------------------------------------

describe('内部一致性核对：视图自相矛盾必须被 checkTransactionView 抓到', () => {
  const view = build();

  it('"不动清单"与"条目清单"相交 ⇒ untouched_overlaps_updated', () => {
    const first = view.artifact_entries[0];
    expect(first).toBeDefined();
    const broken: MultiArtifactTransactionView = {
      ...view,
      untouched_artifact_ids: [...view.untouched_artifact_ids, first!.artifact_id],
    };
    expect(checkTransactionView(broken).map((entry) => entry.code)).toContain('untouched_overlaps_updated');
  });

  it('同一源产物出现两次 ⇒ duplicate_artifact_entry', () => {
    const first = view.artifact_entries[0];
    expect(first).toBeDefined();
    const broken: MultiArtifactTransactionView = {
      ...view,
      artifact_entries: [first!, first!],
    };
    expect(checkTransactionView(broken).map((entry) => entry.code)).toContain('duplicate_artifact_entry');
  });

  it('汇总计数与明细不符 ⇒ totals_mismatch', () => {
    const broken: MultiArtifactTransactionView = {
      ...view,
      totals: { ...view.totals, artifacts_updated: 99 },
    };
    expect(checkTransactionView(broken).map((entry) => entry.code)).toContain('totals_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 版本绑定：形状与拒绝
// ---------------------------------------------------------------------------

describe('版本绑定：形状与拒绝', () => {
  it('to_revision < from_revision ⇒ 抛（任务版本只增不减）', () => {
    expect(() =>
      buildMultiArtifactTransaction({
        instruction: instruction({ from_revision: R2, to_revision: R1 }),
        updates: UPDATES,
        artifacts: artifacts(),
      }),
    ).toThrow();
  });

  it('同版更新（from === to）合法，产物新版本仍由 artifact_version 区分', () => {
    const view = buildMultiArtifactTransaction({
      instruction: instruction({ from_revision: R1, to_revision: R1 }),
      updates: UPDATES,
      artifacts: artifacts(),
    });
    expect(view.to_revision).toBe(R1);
    for (const entry of view.artifact_entries) {
      expect(String(entry.new_artifact_id)).not.toBe(String(entry.artifact_id));
    }
  });

  it('指令绑定版本落后于当前版本 ⇒ 抛 DependencyError（迟到指令拒绝执行）', () => {
    expect(() =>
      buildMultiArtifactTransaction({
        instruction: instruction({ to_revision: R1, current_task_revision: R2 }),
        updates: UPDATES,
        artifacts: artifacts(),
      }),
    ).toThrow(DependencyError);
  });

  it('一次指令里事实键重复 ⇒ 抛', () => {
    expect(() =>
      buildMultiArtifactTransaction({
        instruction: instruction(),
        updates: [
          ...UPDATES,
          { fact_key: 'headcount', previous_fact_id: F_HEAD_10, new_fact_id: asFactRef('fact-headcount-12') },
        ],
        artifacts: artifacts(),
      }),
    ).toThrow();
  });

  it('空指令 id / 空原话 ⇒ 抛（不静默）', () => {
    expect(() => buildMultiArtifactTransaction({ instruction: instruction({ instruction_id: '' }), updates: UPDATES, artifacts: [] })).toThrow();
    expect(() => buildMultiArtifactTransaction({ instruction: instruction({ utterance: '' }), updates: UPDATES, artifacts: [] })).toThrow();
  });
});
