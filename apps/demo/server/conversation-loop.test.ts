/**
 * 连续对话闭环门面（CHAT-01 / CHAT-04 / CHAT-05 / CHAT-06 产品侧闭环）定向单测。
 *
 * 覆盖四件事 + 每件事的反向对照：
 * 1. **指代解析** —— "这个文件 / 刚才那个 / 改一下它" ⇒ 显式 (task_id, artifact_id, revision)；
 *    并列 / 对不上 ⇒ 需要澄清 + 候选，**绝不按标题相似度猜**；
 * 2. **多轮归属** —— 追问 / 补资料归属同一任务（连续三轮不新建第二个任务）；
 * 3. **一句话改多个关联产物** —— 接 `buildMultiArtifactTransaction`，无关产物不重写、旧气泡失效；
 * 4. **结果解释** —— 用户可读、**不含内部术语**，机器依据另存。
 *
 * 反向对照（每条子项至少一条）：措辞相近但指向不同任务的指令不得被猜归属；无关产物被重写必须被抓；
 * 旧气泡仍可执行必须被抓。
 *
 * 纪律：**不调用任何真实模型**——目录端口注入（测试夹具）；未注入端口即"未就绪"。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  type ArtifactRecord,
  type ArtifactRef,
  type FactRef,
  type Revision,
  type SharedFactRecord,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import { createDecisionBubble, prepareAction, type ActionRecord } from '../../../src/workledger/index.js';
import type { SharedFactUpdate } from '../../../src/facts/index.js';

import {
  ConversationLoop,
  type ConversationCatalogPort,
  type LoopArtifact,
  type LoopTask,
} from './conversation-loop.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const AT = asLogicalTime(100);
const INSTANCE = asInstanceId('inst-A');
const T1 = asTaskId('T1');
const R1 = asRevision(1);
const R2 = asRevision(2);

function loopTask(id: string, revision = 1): LoopTask {
  return Object.freeze({
    task_id: asTaskId(id),
    title: `任务 ${id}`,
    revision: asRevision(revision),
    status: 'running' as const,
  });
}

function loopArt(id: string, over: Partial<LoopArtifact> = {}): LoopArtifact {
  return Object.freeze({
    artifact_id: asArtifactRef(id),
    task_id: T1,
    revision: R1,
    version: 1,
    template_kind: 'document' as TemplateKind,
    title: '文档',
    digest: null,
    updated_at: AT,
    ...over,
  });
}

/** 目录端口夹具（按会话返回任务与产物；不注入 ⇒ 未就绪）。 */
function catalogFrom(
  byConversation: Record<string, { readonly tasks?: readonly LoopTask[]; readonly artifacts?: readonly LoopArtifact[] }>,
): ConversationCatalogPort {
  return Object.freeze({
    listTasks: (id: string): readonly LoopTask[] => byConversation[id]?.tasks ?? [],
    listArtifacts: (id: string): readonly LoopArtifact[] => byConversation[id]?.artifacts ?? [],
  });
}

function published(input: {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly facts: readonly string[];
  readonly deps?: readonly string[];
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: input.id as ArtifactRef,
    task_id: T1,
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

const F_HEAD_8 = asFactRef('fact-headcount-8');
const F_HEAD_10 = asFactRef('fact-headcount-10');
const F_BUDGET = asFactRef('fact-budget-5000');

const UPDATES: readonly SharedFactUpdate[] = [
  { fact_key: 'headcount', previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_10 },
];

function artifactRecords(): readonly ArtifactRecord[] {
  return [
    published({ id: 'artA', kind: 'document', facts: [F_HEAD_8] }),
    published({ id: 'artB', kind: 'presentation', facts: [F_HEAD_8] }),
    published({ id: 'artC', kind: 'spreadsheet', facts: [F_BUDGET] }), // 无关
    published({ id: 'artD', kind: 'document', facts: [F_BUDGET], deps: ['artA'] }), // 传递命中
  ];
}

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

function action(actionId: string, revision: Revision): ActionRecord {
  return prepareAction({
    action_id: actionId,
    task_id: T1,
    task_revision: revision,
    action_kind: 'send_document',
    params: { to: 'a@b.com' },
    authorization: {
      source: 'user_session',
      user_approved: true,
      task_revision: revision,
      revoked: false,
      subject_instance_id: INSTANCE,
      granted_at: AT,
    },
    at: AT,
  });
}

// ---------------------------------------------------------------------------
// 就绪（无端口 ⇒ 未就绪）
// ---------------------------------------------------------------------------

describe('就绪：不注入目录端口 ⇒ 未就绪，操作结构化拒绝（不假装能用）', () => {
  it('readiness 如实返回 not ready', () => {
    const loop = new ConversationLoop();
    expect(loop.readiness()).toEqual({ ready: false, reason: 'no_catalog_port' });
  });

  it('未就绪时指代解析 / 提交 / 多产物均结构化拒绝', () => {
    const loop = new ConversationLoop({ catalog: null });
    const ref = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'last_modified' } });
    expect(ref.status).toBe('rejected');
    if (ref.status === 'rejected') expect(ref.code).toBe('not_ready');

    const turn = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份通知' });
    expect(turn.ok).toBe(false);
    if (!turn.ok) expect(turn.code).toBe('not_ready');

    const plan = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'i0',
      utterance: '改一下它',
      task_id: T1,
      from_revision: R1,
      to_revision: R1,
      updates: UPDATES,
      artifacts: [],
      at: AT,
    });
    expect(plan.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// CHAT-01：指代解析
// ---------------------------------------------------------------------------

describe('指代解析：显式指针 ⇒ 显式 (task_id, artifact_id, revision)', () => {
  it('显式产物 id ⇒ 直接命中所属任务与版本', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { tasks: [loopTask('T1')], artifacts: [loopArt('artA', { task_id: T1 })] } }),
    });
    const res = loop.resolveReference({
      conversation_id: 'c1',
      hint: { kind: 'artifact', artifact_id: asArtifactRef('artA') },
    });
    expect(res.status).toBe('resolved');
    if (res.status === 'resolved') {
      expect(res.binding.task_id).toBe(T1);
      expect(res.binding.artifact_id).toBe(asArtifactRef('artA'));
      expect(res.binding.revision).toBe(R1);
      expect(res.binding.by).toBe('artifact');
    }
  });

  it('"这个文件"（当前指针）在 UI 打开后可解析', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { artifacts: [loopArt('artA')] } }),
    });
    expect(
      loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'current' } }).status,
    ).toBe('rejected'); // 还没打开任何文件
    loop.noteCurrentArtifact('c1', asArtifactRef('artA'));
    const res = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'current' } });
    expect(res.status).toBe('resolved');
    if (res.status === 'resolved') expect(res.binding.by).toBe('current');
  });

  it('"就这条"（消息绑定）解析出任务与版本', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const submitted = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份通知' });
    expect(submitted.ok).toBe(true);
    const res = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'message', message_id: asMessageId('m1') } });
    expect(res.status).toBe('resolved');
    if (res.status === 'resolved') {
      expect(res.binding.by).toBe('message');
      expect(submitted.ok && submitted.message.task_id).toBe(res.binding.task_id);
    }
  });
});

describe('指代解析的反向对照：绝不按文本相似度猜', () => {
  it('两个产物标题完全相同、改动时刻并列 ⇒ 需要澄清 + 给出候选（不挑一个像的）', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({
        c1: {
          artifacts: [
            loopArt('artA', { title: '季度总结', updated_at: asLogicalTime(500) }),
            loopArt('artB', { title: '季度总结', updated_at: asLogicalTime(500) }),
          ],
        },
      }),
    });
    const res = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'last_modified' } });
    expect(res.status).toBe('needs_clarification');
    if (res.status === 'needs_clarification') {
      expect(res.candidates.map((item) => String(item.artifact_id))).toEqual(['artA', 'artB']);
    }
  });

  it('"刚才那个"唯一定位到最近改动的那一个（时间指针，非文本匹配）', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({
        c1: {
          artifacts: [
            loopArt('artA', { updated_at: asLogicalTime(100) }),
            loopArt('artB', { updated_at: asLogicalTime(300) }),
          ],
        },
      }),
    });
    const res = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'last_modified' } });
    expect(res.status).toBe('resolved');
    if (res.status === 'resolved') expect(res.binding.artifact_id).toBe(asArtifactRef('artB'));
  });

  it('产物不属于本会话 ⇒ 拒绝（不跨会话认领、不按名字相近猜）', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({
        c1: { artifacts: [loopArt('artA')] },
        c2: { artifacts: [loopArt('artZ', { title: '文档' })] },
      }),
    });
    const res = loop.resolveReference({
      conversation_id: 'c1',
      hint: { kind: 'artifact', artifact_id: asArtifactRef('artZ') },
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.code).toBe('artifact_not_in_conversation');
  });

  it('未知任务 id ⇒ 拒绝（不回退到相近任务）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: { tasks: [loopTask('T1')] } }) });
    const res = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'task', task_id: asTaskId('T999') } });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.code).toBe('unknown_task');
  });
});

// ---------------------------------------------------------------------------
// CHAT-01：多轮归属同一任务
// ---------------------------------------------------------------------------

describe('多轮：追问 / 补资料归属同一任务（连续三轮不新建第二个任务）', () => {
  it('三轮连续对话只产生一个任务，且消息都挂在该任务上', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const first = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份活动通知' });
    const second = loop.submit({ conversation_id: 'c1', client_id: 'm2', text: '再加一段背景介绍' });
    const third = loop.submit({ conversation_id: 'c1', client_id: 'm3', text: '语气改正式一点' });

    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(loop.taskCount('c1')).toBe(1);
    expect(first.ownership).toBe('created');
    expect(second.ownership).toBe('sole_active_run');
    expect(third.ownership).toBe('sole_active_run');
    expect(second.message.task_id).toBe(first.message.task_id);
    expect(third.message.task_id).toBe(first.message.task_id);
  });

  it('同一 client_id 重发 ⇒ 同一条消息，不新建任务（幂等）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const first = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份通知' });
    const again = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份通知' });
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.task_created).toBe(false);
    expect(again.message.message_id).toBe(first.message.message_id);
    expect(loop.taskCount('c1')).toBe(1);
  });

  it('反向对照：另一会话里措辞相近的消息不会被猜归属到 c1 的任务', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {}, c2: {} }) });
    const inC1 = loop.submit({ conversation_id: 'c1', client_id: 'a1', text: '写一份活动通知' });
    const inC2 = loop.submit({ conversation_id: 'c2', client_id: 'b1', text: '写一份活动通知' });
    expect(inC1.ok && inC2.ok).toBe(true);
    if (!inC1.ok || !inC2.ok) return;
    // 两条**文案完全相同**的消息落在**不同**任务上，各归各的会话。
    expect(inC2.message.task_id).not.toBe(inC1.message.task_id);
    expect(loop.taskCount('c1')).toBe(1);
    expect(loop.taskCount('c2')).toBe(1);
  });

  it('反向对照：会话内有多个任务且未显式绑定 ⇒ 需要澄清 + 候选（不按措辞猜）', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { tasks: [loopTask('T1'), loopTask('T2')] } }),
    });
    const res = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '把那份文件再润色一下' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('ambiguous_task');
      expect(res.candidates?.map((run) => String(run.task_id))).toEqual(['T1', 'T2']);
    }
  });
});

// ---------------------------------------------------------------------------
// CHAT-04：运行中改约束 / 补资料（归属同一任务）
// ---------------------------------------------------------------------------

describe('CHAT-04：运行中的要求按显式判据归属（复用 run-constraints）', () => {
  it('唯一活动任务 ⇒ 要求归属它（origin.by = sole_active_run）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const submitted = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份通知' });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const applied = loop.applyRequirement({ conversation_id: 'c1', kind: 'constraint', text: '字数改成 800' });
    expect(applied.status).toBe('applied');
    if (applied.status === 'applied') {
      expect(applied.requirement.task_id).toBe(submitted.message.task_id);
      expect(applied.requirement.origin.by).toBe('sole_active_run');
      expect(applied.requirement.kind).toBe('constraint');
    }
  });

  it('反向对照：两个任务、措辞相同的指令 ⇒ 需要澄清（不猜归属）；显式绑定才落库', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { tasks: [loopTask('T1'), loopTask('T2')] } }),
    });
    const guess = loop.applyRequirement({ conversation_id: 'c1', kind: 'constraint', text: '字数改成 800' });
    expect(guess.status).toBe('needs_clarification');
    if (guess.status === 'needs_clarification') {
      expect(guess.candidates.map((run) => String(run.task_id)).sort()).toEqual(['T1', 'T2']);
    }

    const explicit = loop.applyRequirement({
      conversation_id: 'c1',
      kind: 'constraint',
      text: '字数改成 800',
      task_id: asTaskId('T2'),
    });
    expect(explicit.status).toBe('applied');
    if (explicit.status === 'applied') {
      expect(explicit.requirement.task_id).toBe(asTaskId('T2'));
      expect(explicit.requirement.origin.by).toBe('task');
    }
  });

  it('反向对照：会话内无活动任务 ⇒ no_active_run（不回退去改别的会话的任务）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: { tasks: [loopTask('T1')] }, c2: {} }) });
    const res = loop.applyRequirement({ conversation_id: 'c2', kind: 'constraint', text: '字数改成 800' });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.code).toBe('no_active_run');
  });

  it('绑定版本与当前版本不一致 ⇒ revision_mismatch（不就近套用）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: { tasks: [loopTask('T1')] } }) });
    const res = loop.applyRequirement({
      conversation_id: 'c1',
      kind: 'material',
      text: '这是补充的资料',
      task_id: T1,
      revision: asRevision(9),
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.code).toBe('revision_mismatch');
  });
});

// ---------------------------------------------------------------------------
// CHAT-06：一句话改多个关联产物
// ---------------------------------------------------------------------------

describe('CHAT-06：一句话改多个关联产物（接 buildMultiArtifactTransaction）', () => {
  function plan(loop: ConversationLoop) {
    return loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      task_id: T1,
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      facts: facts(),
      at: AT,
    });
  }

  it('只更新受影响产物；无关产物进"不动清单"', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const result = plan(loop);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const view = result.view;
    expect(view.artifact_entries.map((entry) => String(entry.artifact_id))).toEqual(['artA', 'artB', 'artD']);
    expect(view.untouched_artifact_ids.map(String)).toEqual(['artC']);
    expect(view.totals.artifacts_untouched).toBe(1);
  });

  it('正向：按计划更新受影响产物、不动无关产物 ⇒ 无违规', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const result = plan(loop);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const violations = loop.verifyMultiArtifact(result.view, {
      updated_artifact_ids: result.view.artifact_entries.map((entry) => entry.artifact_id),
    });
    expect(violations).toEqual([]);
  });

  it('反向对照①：无关产物被重写必须被抓（unrelated_artifact_rewritten）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const result = plan(loop);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const violations = loop.verifyMultiArtifact(result.view, {
      updated_artifact_ids: [...result.view.artifact_entries.map((entry) => entry.artifact_id), asArtifactRef('artC')],
    });
    expect(violations.map((entry) => entry.code)).toContain('unrelated_artifact_rewritten');
    expect(violations.find((entry) => entry.code === 'unrelated_artifact_rewritten')?.subject_id).toBe('artC');
  });

  it('反向对照②：受影响产物漏改必须被抓（affected_artifact_missing）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const result = plan(loop);
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const violations = loop.verifyMultiArtifact(result.view, { updated_artifact_ids: [] });
    expect(violations.filter((entry) => entry.code === 'affected_artifact_missing')).toHaveLength(3);
  });

  it('旧决策气泡失效：改版本后旧气泡被判定过期', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const record = action('act-old', R1);
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      task_id: T1,
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      facts: facts(),
      bubbles: [bubble],
      actions: [record],
      at: AT,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.view.totals.bubbles_expired).toBe(1);
    expect(result.view.bubble_entries[0]?.expired).toBe(true);
  });

  it('反向对照③：旧气泡仍被执行必须被抓（expired_bubble_executed）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const record = action('act-old', R1);
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      task_id: T1,
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      facts: facts(),
      bubbles: [bubble],
      actions: [record],
      at: AT,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const violations = loop.verifyMultiArtifact(result.view, {
      updated_artifact_ids: result.view.artifact_entries.map((entry) => entry.artifact_id),
      executed_bubble_ids: ['bub-old'],
    });
    expect(violations.map((entry) => entry.code)).toContain('expired_bubble_executed');
  });

  it('会话内有多个任务且未显式绑定 ⇒ 需要澄清（不猜改哪个任务）', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { tasks: [loopTask('T1'), loopTask('T2')] } }),
    });
    const result = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      at: AT,
    });
    expect(result.status).toBe('needs_clarification');
  });
});

// ---------------------------------------------------------------------------
// CHAT-01：结果解释（用户可读、无内部术语）
// ---------------------------------------------------------------------------

describe('结果解释：用户可读，不含内部术语；证据另存', () => {
  const JARGON = /\bartifact|revision|digest|bubble|instruction|stale|readiness|task_id|T-\w|r\d/i;

  it('按文件种类给出可读汇总，用户文案无内部术语', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({
        c1: {
          artifacts: [
            loopArt('artA', { title: '季度总结', template_kind: 'document' }),
            loopArt('artB', { title: '季度总结演示', template_kind: 'presentation' }),
          ],
        },
      }),
    });
    const explanation = loop.explain({ conversation_id: 'c1' });
    expect(explanation.user_text).toContain('2 份文件');
    expect(explanation.user_text).toContain('Word 文档');
    expect(explanation.user_text).toContain('演示文稿');
    expect(JARGON.test(explanation.user_text)).toBe(false);
    // 证据里保留机器可核对的 id（不进用户文案）。
    expect(explanation.evidence.some((line) => line.includes('artA'))).toBe(true);
  });

  it('带事务视图时说明"改了哪些、哪些没动、哪些失效"', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { artifacts: [loopArt('artA')] } }),
    });
    const record = action('act-old', R1);
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      task_id: T1,
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      facts: facts(),
      bubbles: [bubble],
      actions: [record],
      at: AT,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;

    const explanation = loop.explain({
      conversation_id: 'c1',
      view: result.view,
      pending_decisions: [{ prompt: '是否把这份文件发给对方' }],
    });
    expect(explanation.user_text).toContain('重做了 3 份相关文件');
    expect(explanation.user_text).toContain('1 份文件没有受到影响');
    expect(explanation.user_text).toContain('已经失效');
    expect(explanation.user_text).toContain('1 项操作在等你确认');
    expect(JARGON.test(explanation.user_text)).toBe(false);
    expect(explanation.evidence.some((line) => line.startsWith('transaction '))).toBe(true);
  });

  it('没有产物时如实说"还没有文件"（不编造）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    expect(loop.explain({ conversation_id: 'c1' }).user_text).toContain('还没有产出任何文件');
  });
});
