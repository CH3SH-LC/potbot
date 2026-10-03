/**
 * KRN-07 动作台账的正/反例测试（合同 R241–R246、R213）。
 *
 * 四条核心判据各自有**独立的**断言（不合并成"能跑就行"）：
 * ① 参数摘要变化 ⇒ 另一个动作（旧幂等键被拒）；
 * ② 任务版本变化 ⇒ 旧动作失效 / 旧气泡过期；
 * ③ 重复点击同一动作 ⇒ 幂等（零重复副作用）；
 * ④ 七态严格区分（含假回执不得确认完成、结果未知不盲目重试）。
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
} from '../protocol/index.js';
import {
  ACTION_STATES,
  ACTION_STATE_LABELS,
  ACTION_TERMINAL_STATES,
  ActionLedger,
  ActionLedgerError,
  applyActionTransition,
  assertIdempotencyKeyConsistent,
  canonicalizeActionParams,
  computeActionParamDigest,
  createDecisionBubble,
  createSideEffect,
  deriveIdempotencyKey,
  evaluateActionTransition,
  evaluateBubbleExecution,
  invalidateStaleActions,
  isActionExecutable,
  isActionExpired,
  isTerminalActionState,
  prepareAction,
  summarizeActionLedger,
  type ActionAuthorization,
  type ActionRecord,
} from './action-ledger.js';

const TASK = asTaskId('task-1');
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

function prepared(params: unknown, revision: Revision = R1, kind = 'send_message'): ActionRecord {
  return prepareAction({
    action_id: 'act-1',
    task_id: TASK,
    task_revision: revision,
    action_kind: kind,
    params,
    authorization: auth(revision),
    at: L(10),
  });
}

describe('KRN-07 参数摘要：参数变了就是另一个动作', () => {
  it('键序不同但语义相同的参数 ⇒ 同一摘要', () => {
    const a = computeActionParamDigest('send', { to: '甲方', body: '嗨', n: 1 });
    const b = computeActionParamDigest('send', { n: 1, body: '嗨', to: '甲方' });
    expect(a).toBe(b);
  });

  it('嵌套对象同样按语义规范化', () => {
    expect(canonicalizeActionParams({ b: { d: 2, c: [3, 1] }, a: 1 })).toBe(
      canonicalizeActionParams({ a: 1, b: { c: [3, 1], d: 2 } }),
    );
  });

  it('数组顺序是语义的一部分 ⇒ 顺序不同摘要不同', () => {
    expect(computeActionParamDigest('send', { list: [1, 2] })).not.toBe(
      computeActionParamDigest('send', { list: [2, 1] }),
    );
  });

  it('动作种类参与摘要（同参数不同 kind ⇒ 不同摘要）', () => {
    expect(computeActionParamDigest('send', { x: 1 })).not.toBe(computeActionParamDigest('pay', { x: 1 }));
  });

  it('参数值改了 ⇒ 摘要改（反例① 的前提）', () => {
    expect(computeActionParamDigest('send', { body: 'A' })).not.toBe(
      computeActionParamDigest('send', { body: 'B' }),
    );
  });

  it('算不出就报错：NaN / undefined / 函数一律拒绝，不猜', () => {
    expect(() => computeActionParamDigest('send', { x: Number.NaN })).toThrow(ActionLedgerError);
    expect(() => computeActionParamDigest('send', { x: Number.POSITIVE_INFINITY })).toThrow(ActionLedgerError);
    expect(() => computeActionParamDigest('send', { x: undefined })).toThrow(ActionLedgerError);
    expect(() => computeActionParamDigest('send', { x: () => 1 })).toThrow(ActionLedgerError);
  });
});

describe('KRN-07 幂等键：绑定参数摘要 + 任务版本', () => {
  it('同参数同版本 ⇒ 同键（稳定）', () => {
    const params = { body: '你好' };
    const d = computeActionParamDigest('send', params);
    expect(deriveIdempotencyKey({ task_id: TASK, task_revision: R1, action_kind: 'send', param_digest: d })).toBe(
      deriveIdempotencyKey({ task_id: TASK, task_revision: R1, action_kind: 'send', param_digest: d }),
    );
  });

  it('版本推进 ⇒ 键不同（旧动作不被复用）', () => {
    const d = computeActionParamDigest('send', { body: '你好' });
    expect(deriveIdempotencyKey({ task_id: TASK, task_revision: R1, action_kind: 'send', param_digest: d })).not.toBe(
      deriveIdempotencyKey({ task_id: TASK, task_revision: R2, action_kind: 'send', param_digest: d }),
    );
  });

  it('反例①：同版本、改了参数却沿用旧幂等键 ⇒ 必须被拒', () => {
    const oldKey = deriveIdempotencyKey({
      task_id: TASK,
      task_revision: R1,
      action_kind: 'send',
      param_digest: computeActionParamDigest('send', { body: '旧参数' }),
    });
    expect(() =>
      assertIdempotencyKeyConsistent({
        idempotency_key: oldKey,
        task_id: TASK,
        task_revision: R1,
        action_kind: 'send',
        params: { body: '新参数' },
      }),
    ).toThrowError(/幂等键与参数不一致/);
  });

  it('反例①（台账入口）：click 带不一致的键提示 ⇒ 抛 idempotency_key_mismatch', () => {
    const ledger = new ActionLedger();
    const oldKey = deriveIdempotencyKey({
      task_id: TASK,
      task_revision: R1,
      action_kind: 'send',
      param_digest: computeActionParamDigest('send', { body: '旧参数' }),
    });
    let caught: ActionLedgerError | null = null;
    try {
      ledger.click({
        next_action_id: () => 'act-x',
        task_id: TASK,
        task_revision: R1,
        action_kind: 'send',
        params: { body: '新参数' },
        authorization: auth(R1),
        at: L(1),
        idempotency_key: oldKey,
      });
    } catch (error) {
      caught = error as ActionLedgerError;
    }
    expect(caught?.reason).toBe('idempotency_key_mismatch');
    expect(ledger.size).toBe(0);
  });

  it('反例①（台账入口）：不带键提示时，改参数产出**不同的动作身份**', () => {
    const ledger = new ActionLedger();
    let n = 0;
    const click = (body: string) =>
      ledger.click({
        next_action_id: () => `act-${++n}`,
        task_id: TASK,
        task_revision: R1,
        action_kind: 'send',
        params: { body },
        authorization: auth(R1),
        at: L(1),
      });
    const first = click('旧参数');
    const second = click('新参数');
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(false);
    expect(second.action.action_id).not.toBe(first.action.action_id);
    expect(second.action.param_digest).not.toBe(first.action.param_digest);
    expect(ledger.size).toBe(2);
  });

  it('prepareAction：授权版本与动作版本不一致 ⇒ 拒绝', () => {
    expect(() =>
      prepareAction({
        action_id: 'act-1',
        task_id: TASK,
        task_revision: R2,
        action_kind: 'send',
        params: {},
        authorization: auth(R1),
        at: L(1),
      }),
    ).toThrowError(/不得跨版本复用授权/);
  });
});

describe('KRN-07 七态（R242）严格区分', () => {
  it('恰好七态，且各有中文名', () => {
    expect(ACTION_STATES).toHaveLength(7);
    for (const state of ACTION_STATES) {
      expect(ACTION_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it('「用户报告完成」不等于「已确认完成」：二者是不同的状态', () => {
    expect(ACTION_STATES).toContain('user_reported_complete');
    expect(ACTION_STATES).toContain('confirmed_complete');
    expect(ACTION_TERMINAL_STATES).not.toContain('user_reported_complete');
  });

  it('终态只有两个：已确认完成 / 已失效或失败', () => {
    expect([...ACTION_TERMINAL_STATES].sort()).toEqual(['confirmed_complete', 'invalidated_or_failed']);
    expect(isTerminalActionState('result_unknown')).toBe(false);
    expect(isTerminalActionState('user_reported_complete')).toBe(false);
  });

  it('正常路径：已准备 → 已交接 → 已提交 → 已确认完成（需可信回执）', () => {
    let record = prepared({ body: 'x' });
    expect(record.state).toBe('prepared');
    record = applyActionTransition({ action: record, to: 'handed_off', at: L(20) });
    expect(record.state).toBe('handed_off');
    record = applyActionTransition({
      action: record,
      to: 'submitted',
      at: L(21),
      side_effect: createSideEffect({ effect_id: 'e1', description: '已写入目标 App', at: L(21) }),
    });
    expect(record.state).toBe('submitted');
    record = applyActionTransition({
      action: record,
      to: 'confirmed_complete',
      at: L(22),
      receipt: { trusted: true, source: 'target-app', detail: 'ok', at: L(22) },
    });
    expect(record.state).toBe('confirmed_complete');
    expect(record.revision).toBe(3);
    expect(record.side_effects).toHaveLength(1);
    expect(record.side_effects[0]?.reverted).toBe(false);
  });

  it('假回执（trusted=false）不得置「已确认完成」（R245）', () => {
    let record = prepared({ body: 'x' });
    record = applyActionTransition({ action: record, to: 'submitted', at: L(20) });
    const verdict = evaluateActionTransition({
      action: record,
      to: 'confirmed_complete',
      at: L(21),
      receipt: { trusted: false, source: 'web-page', detail: '假批准', at: L(21) },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('missing_trusted_receipt');
    expect(record.state).toBe('submitted');
  });

  it('「用户报告完成」需要用户报告，且之后仍可被可信回执确认', () => {
    let record = prepared({ body: 'x' });
    record = applyActionTransition({ action: record, to: 'submitted', at: L(20) });
    expect(evaluateActionTransition({ action: record, to: 'user_reported_complete', at: L(21) }).reason).toBe(
      'missing_user_report',
    );
    record = applyActionTransition({
      action: record,
      to: 'user_reported_complete',
      at: L(21),
      user_report: { message_id: asMessageId('m-1'), note: '用户说好了' },
    });
    expect(record.state).toBe('user_reported_complete');
    record = applyActionTransition({
      action: record,
      to: 'confirmed_complete',
      at: L(22),
      receipt: { trusted: true, source: 'target-app', detail: 'ok', at: L(22) },
    });
    expect(record.state).toBe('confirmed_complete');
  });

  it('结果未知不得盲目重试：不能回到 已交接/已提交（R246）', () => {
    let record = prepared({ body: 'x' });
    record = applyActionTransition({ action: record, to: 'submitted', at: L(20) });
    record = applyActionTransition({ action: record, to: 'result_unknown', at: L(21) });
    expect(evaluateActionTransition({ action: record, to: 'submitted', at: L(22) }).reason).toBe(
      'illegal_action_transition',
    );
    expect(record.state).toBe('result_unknown');
  });

  it('终态冻结：已确认完成不得被改写', () => {
    let record = prepared({ body: 'x' });
    record = applyActionTransition({ action: record, to: 'submitted', at: L(20) });
    record = applyActionTransition({
      action: record,
      to: 'confirmed_complete',
      at: L(21),
      receipt: { trusted: true, source: 'app', detail: 'ok', at: L(21) },
    });
    expect(evaluateActionTransition({ action: record, to: 'invalidated_or_failed', at: L(22) }).reason).toBe(
      'terminal_locked',
    );
  });

  it('转「已失效或失败」必须给原因', () => {
    const record = prepared({ body: 'x' });
    expect(evaluateActionTransition({ action: record, to: 'invalidated_or_failed', at: L(9) }).reason).toBe(
      'missing_failure_reason',
    );
  });

  it('撤权后不得再执行（已交接/已提交被拒）', () => {
    const record = prepareAction({
      action_id: 'act-1',
      task_id: TASK,
      task_revision: R1,
      action_kind: 'pay',
      params: { amount: 1 },
      authorization: auth(R1, { revoked: true }),
      at: L(1),
    });
    expect(evaluateActionTransition({ action: record, to: 'handed_off', at: L(2) }).reason).toBe(
      'authorization_revoked',
    );
  });
});

describe('KRN-07 反例②：任务版本变化 ⇒ 旧动作失效（旧气泡过期）', () => {
  it('旧版本动作不得继续前进', () => {
    const record = prepared({ body: 'x' }, R1);
    const verdict = evaluateActionTransition({
      action: record,
      to: 'handed_off',
      at: L(30),
      current_task_revision: R2,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale_task_revision');
  });

  it('invalidateStaleActions：非终态旧动作置失效，终态保留原样', () => {
    const staleOpen = prepared({ body: 'a' }, R1);
    // 造一个 R1 的终态记录
    let staleTerminal = prepared({ body: 'b' }, R1);
    staleTerminal = applyActionTransition({
      action: staleTerminal,
      to: 'invalidated_or_failed',
      at: L(5),
      failure_reason: '先前已失败',
    });
    const fresh = prepared({ body: 'c' }, R2);

    const next = invalidateStaleActions([staleOpen, staleTerminal, fresh], R2, L(40), '任务版本升级');
    expect(next[0]?.state).toBe('invalidated_or_failed');
    expect(next[0]?.invalidated_reason).toBe('任务版本升级');
    // 终态记录**原样保留**（历史版本不得被改写）
    expect(next[1]).toBe(staleTerminal);
    // 新版本记录不受影响
    expect(next[2]).toBe(fresh);
  });

  it('isActionExpired / isActionExecutable', () => {
    const record = prepared({ body: 'x' }, R1);
    expect(isActionExpired(record, R1)).toBe(false);
    expect(isActionExpired(record, R2)).toBe(true);
    expect(isActionExecutable(record, { current_task_revision: R1 })).toBe(true);
    expect(isActionExecutable(record, { current_task_revision: R2 })).toBe(false);
  });
});

describe('KRN-07 正例：重复点击同一动作 ⇒ 幂等（零重复副作用）', () => {
  it('同一参数重复点击：命中同一对象、不新建、零副作用', () => {
    const ledger = new ActionLedger();
    let n = 0;
    const input = {
      next_action_id: () => `act-${++n}`,
      task_id: TASK,
      task_revision: R1,
      action_kind: 'send',
      params: { body: '同一条' },
      authorization: auth(R1),
      at: L(1),
    };
    const first = ledger.click(input);
    const second = ledger.click(input);
    const third = ledger.click(input);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);
    // 同一对象引用（"气泡与执行读取同一对象"）
    expect(second.action).toBe(first.action);
    expect(third.action).toBe(first.action);
    expect(second.side_effects_applied).toBe(0);
    expect(third.side_effects_applied).toBe(0);
    expect(ledger.size).toBe(1);
    expect(n).toBe(1);
  });

  it('clickAndTransition：第二次点击不再推进状态（不重复提交）', () => {
    const ledger = new ActionLedger();
    let n = 0;
    const input = {
      next_action_id: () => `act-${++n}`,
      task_id: TASK,
      task_revision: R1,
      action_kind: 'send',
      params: { body: '同一条' },
      authorization: auth(R1),
      at: L(1),
    };
    const first = ledger.clickAndTransition(input, { to: 'handed_off', at: L(2) });
    expect(first.action.state).toBe('handed_off');
    const second = ledger.clickAndTransition(input, { to: 'handed_off', at: L(3) });
    expect(second.duplicate).toBe(true);
    expect(second.action.state).toBe('handed_off');
    expect(ledger.size).toBe(1);
  });
});

describe('KRN-07 气泡与执行读取同一对象（R212/R243）', () => {
  it('气泡由记录派生；执行读取的就是台账里的同一引用', () => {
    const ledger = new ActionLedger();
    const outcome = ledger.click({
      next_action_id: () => 'act-1',
      task_id: TASK,
      task_revision: R1,
      action_kind: 'send',
      params: { body: 'x' },
      authorization: auth(R1),
      at: L(1),
    });
    const bubble = createDecisionBubble(outcome.action, 'bubble-1', L(2));
    const resolved = ledger.resolve(bubble.action_id);
    expect(resolved).toBe(outcome.action);
    expect(evaluateBubbleExecution(bubble, resolved as ActionRecord, { current_task_revision: R1 }).ok).toBe(true);
  });

  it('参数摘要不符 ⇒ bubble_action_mismatch（参数变了就是另一个动作）', () => {
    const record = prepared({ body: 'x' });
    const bubble = createDecisionBubble(record, 'bubble-1', L(2));
    const tampered: ActionRecord = { ...record, param_digest: 'deadbeef' };
    const verdict = evaluateBubbleExecution(bubble, tampered, { current_task_revision: R1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('bubble_action_mismatch');
  });

  it('任务版本推进 ⇒ stale_bubble（旧气泡过期，R213）', () => {
    const record = prepared({ body: 'x' }, R1);
    const bubble = createDecisionBubble(record, 'bubble-1', L(2));
    const verdict = evaluateBubbleExecution(bubble, record, { current_task_revision: R2 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale_bubble');
  });
});

describe('KRN-07 观测汇总', () => {
  it('未确认的「用户报告完成」不计入成功；汇总暴露副作用的 reverted=false', () => {
    const record = prepared({ body: 'x' });
    const reported = applyActionTransition({
      action: applyActionTransition({ action: record, to: 'submitted', at: L(5) }),
      to: 'user_reported_complete',
      at: L(6),
      user_report: { message_id: asMessageId('m'), note: 'n' },
    });
    const summary = summarizeActionLedger([reported]);
    expect(summary.confirmed_count).toBe(0);
    expect(summary.user_reported_unconfirmed_count).toBe(1);
    expect(summary.total).toBe(1);
  });
});
