/**
 * 跨模块集成（F04 groups ↔ F05 decisions）：改条件 → 确认卡**在位失效**。
 *
 * 这一层是 wave-1 workers 只在 integrationRequests 里「点名」、尚未落地的接缝：
 *   - F04 的 `task.pendingDecisions` 里的 `DecisionRef` 只是**引用**（`actionId` + `taskRevision`），
 *     真正的确认卡由 F05 `decisions/` 持有；
 *   - 改条件（`kind='condition'` 事件）会让 F04 的受影响待确认动作**原位失效**
 *     （`applyTaskEvent` → `applyConditionEvent` 从 `pendingDecisions` / `actionRefs` 里剔除）；
 *   - 但「卡」是 F05 的对象：F04 移除决策引用**不会**自动改变 F05 的 `ConfirmCardView`。
 *     因此交接必须显式：把 F04 的 `invalidatedDecisionIds` 落成 F05 的 `invalidateCard`。
 *
 * 本文件用**真实两类模块的公开 API** 跑通这条交接，并锁住三件事：
 *   I-a 出处一致：F05 卡的 `taskRevision` 就是 F04 决策引用的 `taskRevision`（同一 revision 血统）；
 *   I-b 在位失效：改条件只失效**受影响**的决策，未列出的决策与卡片保持 pending 可提交；
 *   I-c 保留证据：失效的卡**保留旧摘要**（对象/价格/范围不变）并带出**失效原因**；
 *       F04 的活动记录同样保留 summary/reason。
 *
 * 另含反向对照：F05 的 revision 闸门是**卡内部**的（请求 revision 必须等于卡 revision）——
 * 光靠它**抓不到**「任务已改条件、卡却还停留在旧任务 revision」这一交叉态；必须由 F04 的
 * 失效结果驱动显式作废。这条对照证明本集成交接不是可有可无的。
 *
 * 定向运行：`npx vitest run tests/mobile-ui/integration/decision-group-invalidation.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  applyTaskEvent,
  createGroup,
  createGroupsState,
  createTask,
  getTask,
  planChangeConditions,
  GroupError,
  type AffectedSummary,
  type ConditionChange,
  type DecisionRef,
  type GroupsState,
  type TaskEvent,
  type TaskEventMeta,
  type TaskView,
} from '../../../apps/mobile-ui/src/groups/index.js';
import {
  createConfirmCard,
  evaluateConfirmGate,
  invalidateCard,
  isCardActionable,
  type ConfirmCardView,
} from '../../../apps/mobile-ui/src/decisions/index.js';

// ---------------------------------------------------------------------------
// 夹具（自持，不复用别的单元的 fixture）：一个群组、一个任务、两条待确认决策
// ---------------------------------------------------------------------------

const GROUP = 'grp-weekly';
const CONV = 'conv-weekly';
const TASK = 'task-weekly-1';
const DECISION_AFFECTED = 'act-send';
const DECISION_UNTOUCHED = 'act-notify';
const ARTIFACT = 'art-draft';

const AT_CREATE = '2026-10-03T09:30:00Z';
const AT_CONDITION = '2026-10-03T10:30:00Z';
const CARD_EXPIRES = '2026-10-03T12:00:00Z';
const NOW_BEFORE_EXPIRY = '2026-10-03T11:00:00Z';

const DIGEST = `sha256:${'c'.repeat(64)}` as `sha256:${string}`;

/** 一个 processing 任务：两条待确认决策、两个外部动作引用、一个产物、两条约束。 */
function seed(): GroupsState {
  let state = createGroupsState();
  state = createGroup(state, {
    id: GROUP,
    name: '周报整理',
    conversationId: CONV,
    createdAt: '2026-10-03T08:00:00Z',
    summary: '把周报改成一页',
  });
  state = createTask(state, {
    taskId: TASK,
    groupId: GROUP,
    conversationId: CONV,
    title: '把周报改成一页',
    goal: '输出一页纸周报并发送',
    state: 'processing',
    stages: [
      { stageId: 'draft', label: '起草', status: 'active' },
      { stageId: 'export', label: '导出', status: 'pending' },
    ],
    activeStageIndex: 0,
    artifacts: [{ refId: ARTIFACT, label: '周报草稿', digest: DIGEST }],
    pendingDecisions: [
      { actionId: DECISION_AFFECTED, label: '发送周报', taskRevision: 1 },
      { actionId: DECISION_UNTOUCHED, label: '通知同事', taskRevision: 1 },
    ],
    actionRefs: [DECISION_AFFECTED, DECISION_UNTOUCHED],
    constraints: ['budget=已批准', 'deadline=2026-10-05'],
    updatedAt: AT_CREATE,
  });
  return state;
}

function taskOf(state: GroupsState, taskId: string): TaskView {
  const task = getTask(state, taskId);
  if (task === null) throw new Error(`夹具读取失败：${taskId} 缺失`);
  return task;
}

function decisionRefOf(task: TaskView, actionId: string): DecisionRef {
  const ref = task.pendingDecisions.find((d) => d.actionId === actionId);
  if (ref === undefined) throw new Error(`夹具读取失败：决策 ${actionId} 缺失`);
  return ref;
}

/** 契约形状的任务事件：metadata 承载任务语义，其余字段可覆盖。 */
function makeConditionEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  const meta: TaskEventMeta = {
    taskId: TASK,
    kind: 'condition',
    at: AT_CONDITION,
    summary: '预算改为已增加',
    reason: '用户改了预算',
    changes: [{ field: 'budget', value: '已增加' }] satisfies readonly ConditionChange[],
    affected: {
      artifactIds: [ARTIFACT],
      actionIds: [DECISION_AFFECTED],
      decisionIds: [DECISION_AFFECTED],
    } satisfies AffectedSummary,
  };
  const base: TaskEvent = {
    eventId: `evt-condition-${TASK}`,
    seq: 7,
    commandId: 'cmd-change-1',
    revision: 2,
    status: 'running',
    metadata: meta,
  };
  return { ...base, ...overrides };
}

/**
 * 交接胶水：由 F04 决策引用派生 F05 确认卡（**复用 F05 的构造器**，本文件不自造卡形状）。
 * 关键：卡的 `taskRevision` 必须取自 F04 的 `DecisionRef.taskRevision`——同一 revision 血统。
 */
function cardFromDecision(task: TaskView, actionId: string, cardId: string): ConfirmCardView {
  const ref = decisionRefOf(task, actionId);
  return createConfirmCard({
    cardId,
    actionId: ref.actionId,
    taskRevision: ref.taskRevision,
    subject: { objectRef: `${ARTIFACT}#v1`, objectLabel: ref.label },
    scope: 'submit-order',
    price: { amount: '0.00', currency: 'CNY' },
    expiresAt: CARD_EXPIRES,
    paramsDigest: DIGEST,
    accountRef: 'acct:weekly',
    quoteRef: 'quote-weekly-1',
  });
}

const CHANGES: readonly ConditionChange[] = [{ field: 'budget', value: '已增加' }];

// ===========================================================================
// I-a 出处一致：卡 revision === 决策 revision
// ===========================================================================

describe('集成 F04↔F05 · 决策引用与确认卡 revision 同源', () => {
  it('F05 卡的 taskRevision 与 F04 决策引用的 taskRevision 逐字一致', () => {
    const state = seed();
    const card = cardFromDecision(taskOf(state, TASK), DECISION_AFFECTED, 'card-send');
    const ref = decisionRefOf(taskOf(state, TASK), DECISION_AFFECTED);

    expect(card.taskRevision).toBe(ref.taskRevision);
    expect(card.taskRevision).toBe(1);
    expect(card.actionId).toBe(ref.actionId);
  });

  it('改条件预览把受影响的决策列为待失效项（只读、不改状态）', () => {
    const state = seed();
    const plan = planChangeConditions(state, {
      taskId: TASK,
      expectedRevision: 1,
      changes: CHANGES,
      affected: { artifactIds: [ARTIFACT], actionIds: [DECISION_AFFECTED], decisionIds: [DECISION_AFFECTED] },
    });

    expect(plan.currentRevision).toBe(1);
    expect(plan.nextRevision).toBe(2);
    expect(plan.invalidatedDecisionIds).toEqual([DECISION_AFFECTED]);
    expect(plan.nextConstraints).toContain('budget=已增加');
    // 只读：状态未变。
    expect(taskOf(state, TASK).revision).toBe(1);
    expect(taskOf(state, TASK).pendingDecisions.map((d) => d.actionId)).toContain(DECISION_AFFECTED);
  });
});

// ===========================================================================
// I-b / I-c 在位失效：只失效受影响项、保留旧摘要与失效原因
// ===========================================================================

describe('集成 F04↔F05 · 改条件使受影响确认卡在位失效', () => {
  it('只失效受影响决策，未列出的决策与卡片保持可提交', () => {
    const state = seed();
    const next = applyTaskEvent(state, makeConditionEvent());
    const task = taskOf(next, TASK);

    // F04：受影响决策被剔除，未列出的保留；产物保留；revision 前进。
    expect(task.pendingDecisions.map((d) => d.actionId)).toEqual([DECISION_UNTOUCHED]);
    expect(task.actionRefs).toEqual([DECISION_UNTOUCHED]);
    expect(task.artifacts.map((a) => a.refId)).toContain(ARTIFACT);
    expect(task.revision).toBe(2);

    // F05：未受影响的卡仍可提交（在位、精确）。
    const untouchedCard = cardFromDecision(taskOf(state, TASK), DECISION_UNTOUCHED, 'card-notify');
    expect(isCardActionable(untouchedCard, NOW_BEFORE_EXPIRY)).toBe(true);
    expect(
      evaluateConfirmGate(untouchedCard, {
        actionId: DECISION_UNTOUCHED,
        taskRevision: untouchedCard.taskRevision,
        now: NOW_BEFORE_EXPIRY,
      }).ok,
    ).toBe(true);
  });

  it('受影响的卡失效并保留旧摘要（对象/价格/范围不变），带出失效原因', () => {
    const state = seed();
    const card = cardFromDecision(taskOf(state, TASK), DECISION_AFFECTED, 'card-send');
    const before = {
      subject: { ...card.subject },
      price: card.price === null ? null : { ...card.price },
      scope: card.scope,
    };

    const next = applyTaskEvent(state, makeConditionEvent());
    const plan = planChangeConditions(state, {
      taskId: TASK,
      expectedRevision: 1,
      changes: CHANGES,
      affected: { artifactIds: [ARTIFACT], actionIds: [DECISION_AFFECTED], decisionIds: [DECISION_AFFECTED] },
    });

    // 交接：F04 的失效结果 → F05 的 invalidateCard（显式，不是自动）。
    const reason = `任务改条件使决策 ${plan.invalidatedDecisionIds.join(',')} 失效（revision ${plan.currentRevision} → ${plan.nextRevision}）`;
    const invalidated = invalidateCard(card, reason);

    expect(invalidated.status).toBe('invalidated');
    expect(invalidated.invalidReason).toBe(reason);
    // 旧摘要（对象 / 价格 / 范围）保留，不因失效被清空——用户仍能看到被作废的是什么。
    expect({ subject: invalidated.subject, price: invalidated.price, scope: invalidated.scope }).toEqual(before);
    // 已失效的卡不再接受提交。
    expect(isCardActionable(invalidated, NOW_BEFORE_EXPIRY)).toBe(false);
    const gate = evaluateConfirmGate(invalidated, {
      actionId: DECISION_AFFECTED,
      taskRevision: card.taskRevision,
      now: NOW_BEFORE_EXPIRY,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('not-pending');

    // F04 活动记录保留 summary / reason。
    const activity = taskOf(next, TASK).activity;
    const conditionEntry = activity[activity.length - 1];
    expect(conditionEntry?.kind).toBe('condition');
    expect(conditionEntry?.summary).toBe('预算改为已增加');
    expect(conditionEntry?.reason).toBe('用户改了预算');
  });

  it('反向对照：F05 revision 闸门是卡内部的，抓不到「任务已改条件、卡仍旧」的交叉态', () => {
    const state = seed();
    const card = cardFromDecision(taskOf(state, TASK), DECISION_AFFECTED, 'card-send');
    // 未显式失效：卡仍是 pending，且以**自身** revision 提交会通过闸门——这正是必须依赖
    // F04 失效结果驱动作废的原因（revision 闸门只比对请求与卡，不比对任务的当前 revision）。
    expect(isCardActionable(card, NOW_BEFORE_EXPIRY)).toBe(true);

    // 一旦提交方意识到任务已到 revision 2，用新 revision 提交旧卡 ⇒ revision-mismatch。
    const staleSubmit = evaluateConfirmGate(card, {
      actionId: DECISION_AFFECTED,
      taskRevision: 2,
      now: NOW_BEFORE_EXPIRY,
    });
    expect(staleSubmit.ok).toBe(false);
    if (!staleSubmit.ok) expect(staleSubmit.reason).toBe('revision-mismatch');
  });

  it('未知受影响决策 id ⇒ F04 预览拒绝（不凭空编造影响面）', () => {
    const state = seed();
    let code: string | null = null;
    try {
      planChangeConditions(state, {
        taskId: TASK,
        expectedRevision: 1,
        changes: CHANGES,
        affected: { artifactIds: [], actionIds: [], decisionIds: ['act-ghost'] },
      });
    } catch (error) {
      if (error instanceof GroupError) code = error.code;
      else throw error;
    }
    expect(code).toBe('unknown-affected-id');
  });
});
