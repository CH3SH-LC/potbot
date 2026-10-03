/**
 * FA-CHAT-BUBBLE / CHAT-07 决策气泡测试。
 *
 * 四条判据各自**独立**断言（不合并成"能跑就行"）：
 * ① 气泡从真实动作对象派生（参数摘要 / 幂等键 / 版本 / 目标全等）；
 * ② 用户改参数 ⇒ 旧气泡失效（含反向对照：动作没改时气泡仍绑定）；
 * ③ 重复点击 ⇒ 第二次不得再执行（含幂等键去重）；
 * ④ 过期点击（真实过期判据 + 版本不匹配）；
 * ⑤ 返回目标 App：交接后无回执 ⇒ 最高只到"已交接"，不得标完成。
 */

import { describe, expect, it } from 'vitest';
import {
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRevision,
  asTaskId,
  type LogicalTime,
  type Revision,
  type TaskId,
} from '../protocol/index.js';
import {
  applyActionTransition,
  createSideEffect,
  evaluateActionTransition,
  prepareAction,
  type ActionAuthorization,
  type ActionRecord,
} from '../workledger/action-ledger.js';
import {
  buildDecisionBubble,
  evaluateBubbleClick,
  isBubbleBoundToAction,
  type BubbleClick,
} from './decision-bubble.js';

const TASK: TaskId = asTaskId('task-chat-07');
const R1 = asRevision(1);
const R2 = asRevision(2);
/** 逻辑时间字面量助手（内核禁用墙钟；时间一律显式传入）。 */
const L = (n: number): LogicalTime => asLogicalTime(n);

function auth(revision: Revision, overrides: Partial<ActionAuthorization> = {}): ActionAuthorization {
  return {
    source: 'conversation-confirm',
    user_approved: true,
    task_revision: revision,
    revoked: false,
    subject_instance_id: asInstanceId('inst-1'),
    granted_at: L(5),
    ...overrides,
  };
}

function prepared(params: unknown, revision: Revision = R1, kind = 'share_doc', id = 'act-1'): ActionRecord {
  return prepareAction({
    action_id: id,
    task_id: TASK,
    task_revision: revision,
    action_kind: kind,
    params,
    authorization: auth(revision),
    at: L(10),
  });
}

type Step = Omit<Parameters<typeof applyActionTransition>[0], 'action'>;

/** 便捷：从一条记录出发，走完一串转换（每步都断言成功，失败即测试红）。 */
function advance(action: ActionRecord, ...steps: Step[]): ActionRecord {
  let current = action;
  for (const step of steps) {
    current = applyActionTransition({ ...step, action: current });
  }
  return current;
}

function click(record: ActionRecord, currentRevision: Revision = R1, priorKeys?: readonly string[]): BubbleClick {
  return { record, current_task_revision: currentRevision, prior_click_keys: priorKeys };
}

// ---------------------------------------------------------------------------
// ① 气泡从真实动作对象派生
// ---------------------------------------------------------------------------

describe('buildDecisionBubble 绑定真实动作对象', () => {
  it('参数摘要 / 幂等键 / 版本 / 目标全部与动作对象相等（无第二份副本）', () => {
    const action = prepared({ to: '甲方', body: '合同已发', n: 3 });
    const bubble = buildDecisionBubble(action);

    expect(bubble.param_digest).toBe(action.param_digest);
    expect(bubble.idempotency_key).toBe(action.idempotency_key);
    expect(bubble.task_revision).toBe(action.task_revision);
    expect(bubble.action_id).toBe(action.action_id);
    expect(bubble.task_id).toBe(action.task_id);
    expect(bubble.action_kind).toBe(action.action_kind);
    expect(bubble.target.task_id).toBe(action.task_id);
    expect(bubble.target.action_kind).toBe(action.action_kind);
    expect(bubble.target.subject_instance_id).toBe(action.authorization.subject_instance_id);
    // 幂等键由 (task_id, 版本, kind, 参数摘要) 派生：参数摘要变 ⇒ 键也变（KRN-07）。
    const changedParams = buildDecisionBubble(prepared({ to: '甲方', body: '合同已发', n: 4 }));
    expect(changedParams.param_digest).not.toBe(bubble.param_digest);
    expect(changedParams.idempotency_key).not.toBe(bubble.idempotency_key);
  });

  it('气泡 id 确定性派生（同对象 ⇒ 同 id；无随机源）', () => {
    const action = prepared({ a: 1 });
    expect(buildDecisionBubble(action).bubble_id).toBe(buildDecisionBubble(action).bubble_id);
    expect(buildDecisionBubble(action).bubble_id).toBe(`bubble:${action.action_id}:r0`);
  });

  it('后果从对象派生：prepared 无副作用；已提交带副作用且 reverted 恒为 false', () => {
    const action = prepared({ a: 1 });
    const preparedBubble = buildDecisionBubble(action);
    expect(preparedBubble.consequence.side_effect_count).toBe(0);
    expect(preparedBubble.consequence.any_reverted).toBe(false);
    expect(preparedBubble.consequence.receipt_confirmed).toBe(false);
    expect(preparedBubble.consequence.summary).toContain('尚未执行');

    const submitted = advance(action, {
      to: 'submitted',
      at: L(11),
      side_effect: createSideEffect({ effect_id: 'fx-1', description: '已向甲方发送', at: L(11), declared_reversible: true }),
    });
    const submittedBubble = buildDecisionBubble(submitted);
    expect(submittedBubble.consequence.side_effect_count).toBe(1);
    expect(submittedBubble.consequence.declared_reversible).toBe(true);
    // R205：已发生的外部副作用不得假称被撤销。
    expect(submittedBubble.consequence.any_reverted).toBe(false);
    expect(submittedBubble.consequence.summary).toContain('1 项外部副作用');
    expect(submittedBubble.state_label).toBe('已提交');
  });

  it('气泡展示面与动作对象状态始终一致（状态推进后重建即同步）', () => {
    const action = prepared({ a: 1 });
    const handedOff = advance(action, { to: 'handed_off', at: L(11) });
    expect(buildDecisionBubble(action).state_label).toBe('已准备');
    expect(buildDecisionBubble(handedOff).state_label).toBe('已交接');
    expect(buildDecisionBubble(handedOff).action_revision).toBe(handedOff.revision);
  });
});

// ---------------------------------------------------------------------------
// ② 用户改参数 ⇒ 旧气泡失效（含反向对照）
// ---------------------------------------------------------------------------

describe('用户改参数：旧气泡失效、需新气泡', () => {
  it('动作没改 ⇒ 气泡仍绑定（反向对照的阳性侧）', () => {
    const action = prepared({ body: 'A' });
    const bubble = buildDecisionBubble(action);
    expect(isBubbleBoundToAction(bubble, action)).toBe(true);
    expect(evaluateBubbleClick(bubble, click(action)).ok).toBe(true);
  });

  it('改了参数 ⇒ 参数摘要变化，旧气泡失效（反向对照的阴性侧）', () => {
    const oldAction = prepared({ body: 'A' }, R1, 'share_doc', 'act-1');
    const bubble = buildDecisionBubble(oldAction);

    const changedAction = prepared({ body: 'B' }, R1, 'share_doc', 'act-1');
    expect(changedAction.param_digest).not.toBe(oldAction.param_digest);

    expect(isBubbleBoundToAction(bubble, changedAction)).toBe(false);
    const verdict = evaluateBubbleClick(bubble, click(changedAction));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('bubble_action_mismatch');
    expect(verdict.message).toContain('必须基于新参数重建新气泡');
  });

  it('改参数后新建气泡即可执行（新气泡绑定新对象）', () => {
    const changedAction = prepared({ body: 'B' }, R1, 'share_doc', 'act-1');
    const newBubble = buildDecisionBubble(changedAction);
    expect(isBubbleBoundToAction(newBubble, changedAction)).toBe(true);
    expect(evaluateBubbleClick(newBubble, click(changedAction)).ok).toBe(true);
    // 新气泡的参数摘要与旧的不同：是另一个动作。
    const oldBubble = buildDecisionBubble(prepared({ body: 'A' }, R1, 'share_doc', 'act-1'));
    expect(newBubble.param_digest).not.toBe(oldBubble.param_digest);
  });
});

// ---------------------------------------------------------------------------
// ③ 重复点击：第二次不得再执行
// ---------------------------------------------------------------------------

describe('重复点击：第二次不得再执行', () => {
  it('首次点击可执行；动作交接后同一气泡再点 ⇒ duplicate、不执行', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const first = evaluateBubbleClick(bubble, click(action));
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBe(false);

    // 第一次点击后动作推进为「已交接」（由调用方执行，本层只判定）。
    const handedOff = advance(action, { to: 'handed_off', at: L(11) });
    const second = evaluateBubbleClick(bubble, click(handedOff));
    expect(second.ok).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.reason).toBe('duplicate_click');
    expect(second.completed).toBe(false);
  });

  it('幂等键已在本会话点过 ⇒ 即使记录仍是 prepared，也算重复', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const verdict = evaluateBubbleClick(bubble, click(action, R1, [bubble.idempotency_key]));
    expect(verdict.ok).toBe(false);
    expect(verdict.duplicate).toBe(true);
    expect(verdict.reason).toBe('duplicate_click');
  });

  it('结果未知不得盲目重试（R246）：再点被拒且提示不重试', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const unknown = advance(action, { to: 'handed_off', at: L(11) }, { to: 'result_unknown', at: L(12) });
    const verdict = evaluateBubbleClick(bubble, click(unknown));
    expect(verdict.duplicate).toBe(true);
    expect(verdict.message).toContain('不得盲目重试');
    expect(verdict.completed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ④ 过期点击：真实过期判据 + 版本不匹配
// ---------------------------------------------------------------------------

describe('过期点击', () => {
  it('动作版本落后于当前任务版本 ⇒ stale_bubble（isActionExpired / R213）', () => {
    const action = prepared({ a: 1 }, R1);
    const bubble = buildDecisionBubble(action);
    const verdict = evaluateBubbleClick(bubble, click(action, R2));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale_bubble');
    expect(verdict.message).toContain('旧气泡过期');
  });

  it('气泡绑定版本与记录版本不符 ⇒ stale_bubble（版本不匹配）', () => {
    const oldAction = prepared({ a: 1 }, R1);
    const bubble = buildDecisionBubble(oldAction);
    // 同一动作在 R2 上重建（记录版本已推进，当前版本也是 R2 ⇒ 记录本身未过期）。
    const rewound = prepared({ a: 1 }, R2);
    const verdict = evaluateBubbleClick(bubble, click(rewound, R2));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale_bubble');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 返回目标 App：交接后无回执 ⇒ 最高只到"已交接"，不得标完成
// ---------------------------------------------------------------------------

describe('返回目标 App：交接后无回执不得标完成', () => {
  it('已交接（handed_off）无回执 ⇒ completed=false、awaiting_receipt=true、label 已交接', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const handedOff = advance(action, { to: 'handed_off', at: L(11) });

    const verdict = evaluateBubbleClick(bubble, click(handedOff));
    expect(verdict.completed).toBe(false);
    expect(verdict.awaiting_receipt).toBe(true);
    expect(verdict.displayed_state).toBe('handed_off');
    expect(verdict.displayed_label).toBe('已交接');
    expect(verdict.message).toContain('已交接');
    expect(verdict.message).toContain('不得重复执行');
  });

  it('已提交无回执 ⇒ 仍不得标完成（已提交 ≠ 完成）', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const submitted = advance(
      action,
      { to: 'handed_off', at: L(11) },
      { to: 'submitted', at: L(12), side_effect: createSideEffect({ effect_id: 'fx-1', description: '已发送', at: L(12) }) },
    );
    const bubbleView = buildDecisionBubble(submitted);
    expect(bubbleView.consequence.receipt_confirmed).toBe(false);

    const verdict = evaluateBubbleClick(bubble, click(submitted));
    expect(verdict.completed).toBe(false);
    expect(verdict.displayed_label).toBe('已提交');
  });

  it('用户报告完成但无可信回执 ⇒ 不得标完成（R242）', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const reported = advance(
      action,
      { to: 'handed_off', at: L(11) },
      { to: 'user_reported_complete', at: L(12), user_report: { message_id: asMessageId('msg-1'), note: '我那边做好了' } },
    );
    const verdict = evaluateBubbleClick(bubble, click(reported));
    expect(verdict.completed).toBe(false);
    expect(verdict.displayed_label).toBe('用户报告完成');
    expect(buildDecisionBubble(reported).consequence.user_reported_unconfirmed).toBe(true);
  });

  it('只有可信回执确认才算完成；且终态不得再点（terminal_locked）', () => {
    const action = prepared({ a: 1 });
    const bubble = buildDecisionBubble(action);
    const confirmed = advance(
      action,
      { to: 'handed_off', at: L(11) },
      { to: 'confirmed_complete', at: L(12), receipt: { trusted: true, source: 'target-app', detail: '已送达', at: L(12) } },
    );
    expect(buildDecisionBubble(confirmed).consequence.receipt_confirmed).toBe(true);

    const verdict = evaluateBubbleClick(bubble, click(confirmed));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('terminal_locked');
    // 真实对象确已完成：completed 反映对象真相（但这次点击不可执行）。
    expect(verdict.completed).toBe(true);
    expect(verdict.displayed_label).toBe('已确认完成');
  });

  it('不可信回执不得把动作置为已确认完成（假回执无效，R245）', () => {
    const action = prepared({ a: 1 });
    const handedOff = advance(action, { to: 'handed_off', at: L(11) });
    const verdict = evaluateActionTransition({
      action: handedOff,
      to: 'confirmed_complete',
      at: L(12),
      receipt: { trusted: false, source: 'web-page', detail: '网页里的批准', at: L(12) },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('missing_trusted_receipt');
  });
});

// ---------------------------------------------------------------------------
// 授权撤权（R244）—— 点击门禁
// ---------------------------------------------------------------------------

describe('撤权后点击被拒', () => {
  it('授权已撤销 ⇒ authorization_revoked，不执行', () => {
    const revoked = prepareAction({
      action_id: 'act-r',
      task_id: TASK,
      task_revision: R1,
      action_kind: 'share_doc',
      params: { a: 1 },
      authorization: auth(R1, { revoked: true }),
      at: L(10),
    });
    const bubble = buildDecisionBubble(revoked);
    const verdict = evaluateBubbleClick(bubble, click(revoked));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('authorization_revoked');
    expect(verdict.message).toContain('R244');
  });
});
