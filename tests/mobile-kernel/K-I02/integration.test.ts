/**
 * K-I02 集成验证（lane K · slot 2）—— **非全局动作身份 + 幂等重复回执观测**。
 *
 * 本包是 K-R06 记录的两条 open 缺口落地后的**集成验收**：
 *
 * - **B1/B2（跨任务授权）**：`ActionBinding` 增加必需 `taskId` 并纳入逐项复核；账本内部
 *   一律以 `(taskId, actionId)` 为键。于是"任务内"的 actionId 不再是全局命名空间，
 *   而"甲任务的授权被乙任务使用"可表达、可机器拒绝（`grant_binding_mismatch` + `field=taskId`）。
 * - **D2（重复回执）**：`observe()` 对**同一份**回执（去重键 actionId+requestRef+externalId+
 *   observedState）幂等——重复投递返回原提交（no-op），不再抛 `illegal_submission_transition`；
 *   而**换一份**回执仍受状态机约束，伪造回执仍被 `untrusted_receipt` 拦下。
 *
 * 纪律：每条"能咬动"的判据都配对照组（改了那一项才拒 / 合法值照样通过），
 * 否则"恒拒"也能骗过负例。真实驱动 K07 公开 API，不 mock 账本。
 */

import { describe, expect, it } from 'vitest';

import {
  createAuthorizationLedger,
  createManualClock,
  createTrustedReceipt,
  isAuthorizationError,
  type ActionBinding,
  type AuthorizationError,
  type AuthorizationLedger,
  type ConfirmAction,
  type ExecutorOutcome,
  type ExternalReceipt,
  type ExternalSubmitRequest,
  type ManualClock,
  type OrderQueryPort,
  type OrderQueryRequest,
  type ReceiptObservedState,
} from '../../../apps/mobile-kernel/actions/index.js';

const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function confirm(over: Partial<ConfirmAction> = {}): ConfirmAction {
  return {
    taskId: 'task:alpha',
    actionId: 'act-1',
    accountRef: 'acct:demo:0001', // 契约形状的**引用**占位，非真实账号
    taskRevision: 1,
    paramsDigest: 'sha256:' + '1'.repeat(64),
    quoteRef: 'quote:demo-1',
    amount: 3980,
    currency: 'CNY',
    scope: 'purchase',
    expiresAt: T0 + 60_000,
    ...over,
  };
}

/** 九项绑定的浅拷贝（去掉 expiresAt，用于构造"只改一项"的实际值）。 */
function bindingOf(over: Partial<ActionBinding> = {}): ActionBinding {
  const { expiresAt: _drop, ...rest } = confirm();
  void _drop;
  return { ...rest, ...over };
}

interface RecordingExecutor {
  readonly identity: string;
  readonly calls: ExternalSubmitRequest[];
  send(request: ExternalSubmitRequest): ExecutorOutcome | Promise<ExecutorOutcome>;
}

function recordingExecutor(
  handler: (request: ExternalSubmitRequest, index: number) => ExecutorOutcome | Promise<ExecutorOutcome>,
): RecordingExecutor {
  const calls: ExternalSubmitRequest[] = [];
  return {
    identity: 'ki02.executor',
    calls,
    send(request) {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

interface RecordingQuery extends OrderQueryPort {
  readonly identity: string;
  readonly calls: OrderQueryRequest[];
}

function recordingQuery(handler: (request: OrderQueryRequest, index: number) => ExternalReceipt | null): RecordingQuery {
  const calls: OrderQueryRequest[] = [];
  return {
    identity: 'ki02.query',
    calls,
    query(request) {
      calls.push(request);
      return handler(request, calls.length - 1);
    },
  };
}

interface Fixture {
  readonly ledger: AuthorizationLedger;
  readonly clock: ManualClock;
  readonly executor: RecordingExecutor;
  readonly orderQuery: RecordingQuery;
}

function setup(options: { readonly executor?: RecordingExecutor; readonly orderQuery?: RecordingQuery } = {}): Fixture {
  const clock = createManualClock(T0);
  const executor = options.executor ?? recordingExecutor(() => ({ outcome: 'accepted' as const }));
  const orderQuery = options.orderQuery ?? recordingQuery(() => null);
  const ledger = createAuthorizationLedger({ clock, executor, orderQuery });
  return { ledger, clock, executor, orderQuery };
}

function receipt(
  actionId: string,
  requestRef: string,
  externalId: string,
  observedState: ReceiptObservedState,
  observedAt = T0 + 1,
): ExternalReceipt {
  return createTrustedReceipt({
    actionId,
    provider: 'demo-provider',
    requestRef,
    externalId,
    observedState,
    observedAt,
    evidenceRef: `evidence://ki02/${externalId}`,
    verificationMode: 'real',
  });
}

function expectCode(fn: () => unknown, code: string, field?: string): AuthorizationError {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) {
    throw new Error(`期望抛出 ${code}，但调用没有抛错（判据是空壳：该拒的没拒）`);
  }
  if (!isAuthorizationError(caught)) {
    throw new Error(`期望 AuthorizationError(${code})，实际收到 ${String(caught)}`);
  }
  const error = caught as AuthorizationError;
  if (error.code !== code) {
    throw new Error(`期望错误码 ${code}，实际是 ${error.code}：${error.message}`);
  }
  if (field !== undefined && error.field !== field) {
    throw new Error(`期望拒因字段 ${field}，实际是 ${String(error.field)}：${error.message}`);
  }
  return error;
}

/** 走完"入账 → 确认 → 发行 → 占用 → 提交"一条链，返回 submissionId。 */
async function submitChain(
  fixture: Fixture,
  taskId: string,
  actionId: string,
): Promise<string> {
  fixture.ledger.recordConfirmAction(confirm({ taskId, actionId }));
  const grant = fixture.ledger.issueGrant(fixture.ledger.attest(taskId, actionId, { surface: 'native.confirm' }));
  const consumed = fixture.ledger.consume({ grantId: grant.grantId, actual: bindingOf({ taskId, actionId }) });
  await fixture.ledger.send(consumed.submission.submissionId);
  return consumed.submission.submissionId;
}

// ---------------------------------------------------------------------------
// B1/B2：非全局动作身份
// ---------------------------------------------------------------------------

describe('K-I02 ①：taskId 是必需绑定项（非全局动作身份）', () => {
  it('缺省 / 空串 taskId ⇒ invalid_confirm_action（field=taskId），不落入账本', () => {
    const { ledger } = setup();
    const missing = { ...confirm(), taskId: undefined } as unknown as ConfirmAction;
    expectCode(() => ledger.recordConfirmAction(missing), 'invalid_confirm_action', 'taskId');
    expectCode(() => ledger.recordConfirmAction(confirm({ taskId: '' })), 'invalid_confirm_action', 'taskId');
    expectCode(() => ledger.recordConfirmAction(confirm({ taskId: '   ' })), 'invalid_confirm_action', 'taskId');
    expect(ledger.counts().confirms).toBe(0);
  });

  it('跨任务占用被机器拒绝：grant_binding_mismatch（field=taskId），零提交；合法值照样通过', () => {
    const { ledger } = setup();
    ledger.recordConfirmAction(confirm({ taskId: 'task:alpha', actionId: 'act-1' }));
    const grant = ledger.issueGrant(ledger.attest('task:alpha', 'act-1', { surface: 'native.confirm' }));

    // 任务 beta 拿着任务 alpha 的授权来占用：taskId 与绑定不符 ⇒ 拒
    expectCode(
      () => ledger.consume({ grantId: grant.grantId, actual: bindingOf({ taskId: 'task:beta' }) }),
      'grant_binding_mismatch',
      'taskId',
    );
    expect(ledger.counts().submissions).toBe(0);

    // 对照组：任务身份一致 ⇒ 放行，且提交记录携带 taskId
    const ok = ledger.consume({ grantId: grant.grantId, actual: bindingOf({ taskId: 'task:alpha' }) });
    expect(ok.submission.state).toBe('submitting');
    expect(ok.submission.taskId).toBe('task:alpha');
    expect(ledger.counts().submissions).toBe(1);
  });

  it('actionId 是任务内键：两个任务同名动作各自登记、各自走链，互不干扰', async () => {
    const fixture = setup();
    const { ledger } = fixture;
    ledger.recordConfirmAction(confirm({ taskId: 'task:alpha', actionId: 'shared' }));
    ledger.recordConfirmAction(confirm({ taskId: 'task:beta', actionId: 'shared' }));
    expect(ledger.counts().confirms).toBe(2);
    expect(ledger.observedStateOf('task:alpha', 'shared')).toBe('prepared');
    expect(ledger.observedStateOf('task:beta', 'shared')).toBe('prepared');

    const gA = ledger.issueGrant(ledger.attest('task:alpha', 'shared', { surface: 'native.confirm' }));
    const gB = ledger.issueGrant(ledger.attest('task:beta', 'shared', { surface: 'native.confirm' }));
    expect(gA.grantId).not.toBe(gB.grantId); // 默认 id 生成器以 (taskId, actionId) 为键

    const sA = ledger.consume({ grantId: gA.grantId, actual: bindingOf({ taskId: 'task:alpha', actionId: 'shared' }) });
    const sB = ledger.consume({ grantId: gB.grantId, actual: bindingOf({ taskId: 'task:beta', actionId: 'shared' }) });
    expect(sA.submission.submissionId).not.toBe(sB.submission.submissionId);

    await ledger.send(sA.submission.submissionId);
    await ledger.send(sB.submission.submissionId);
    expect(ledger.observedStateOf('task:alpha', 'shared')).toBe('submitted');
    expect(ledger.observedStateOf('task:beta', 'shared')).toBe('submitted');
    expect(ledger.counts()).toEqual({ confirms: 2, grants: 2, submissions: 2, revoked: 0 });
    expect(fixture.executor.calls).toHaveLength(2);

    // 撤权只影响被撤的任务
    ledger.revoke('task:alpha', 'shared', '用户撤 A');
    expect(ledger.isRevoked('task:alpha', 'shared')).toBe(true);
    expect(ledger.isRevoked('task:beta', 'shared')).toBe(false);
    expect(ledger.observedStateOf('task:beta', 'shared')).toBe('submitted');
  });

  it('getDisplay 从账本带出 taskId；声明 taskId 不符 ⇒ confirm_digest_mismatch（field=taskId）', () => {
    const { ledger } = setup();
    ledger.recordConfirmAction(confirm({ taskId: 'task:alpha', actionId: 'act-1' }));

    const display = ledger.getDisplay('task:alpha', 'act-1');
    expect(display.source).toBe('ledger');
    expect(display.taskId).toBe('task:alpha');

    expectCode(
      () => ledger.getDisplay('task:alpha', 'act-1', { taskId: 'task:beta' }),
      'confirm_digest_mismatch',
      'taskId',
    );
    // 换任务键即换动作 ⇒ 找不到确认请求
    expectCode(() => ledger.getDisplay('task:beta', 'act-1'), 'confirm_not_found');
  });

  it('默认 id 生成器任务内唯一：同名动作在不同任务下不撞 grantId / submissionId', () => {
    const { ledger } = setup();
    ledger.recordConfirmAction(confirm({ taskId: 'task:alpha', actionId: 'dup' }));
    ledger.recordConfirmAction(confirm({ taskId: 'task:beta', actionId: 'dup' }));
    const gA = ledger.issueGrant(ledger.attest('task:alpha', 'dup', { surface: 's' }));
    const gB = ledger.issueGrant(ledger.attest('task:beta', 'dup', { surface: 's' }));
    expect(gA.grantId).toBe('grant:task:alpha:dup');
    expect(gB.grantId).toBe('grant:task:beta:dup');
  });
});

// ---------------------------------------------------------------------------
// D2：幂等重复回执观测
// ---------------------------------------------------------------------------

describe('K-I02 ②：observe 对同一份回执幂等（重复投递为 no-op）', () => {
  it('同一份 confirmed 回执送达两次：第二次返回原提交，不抛错、状态与计数不变', async () => {
    const fixture = setup();
    const submissionId = await submitChain(fixture, 'task:alpha', 'act-1');
    const { ledger } = fixture;

    const first = ledger.observe(submissionId, receipt('act-1', submissionId, 'EXT-1', 'confirmed'));
    expect(first.state).toBe('confirmed');

    // observedAt 不同但四项去重键相同 ⇒ 视为同一份回执，no-op
    const replay = ledger.observe(submissionId, receipt('act-1', submissionId, 'EXT-1', 'confirmed', T0 + 999));
    expect(replay).toBe(first); // 返回**同一**冻结记录，updatedAt / receipt 都未被重写
    expect(replay.state).toBe('confirmed');
    expect(ledger.counts().submissions).toBe(1);
  });

  it('去重不吞伪造回执；换 externalId 的另一份回执仍受状态机约束', async () => {
    const fixture = setup();
    const submissionId = await submitChain(fixture, 'task:alpha', 'act-1');
    const { ledger } = fixture;
    ledger.observe(submissionId, receipt('act-1', submissionId, 'EXT-1', 'confirmed'));

    // 伪造：形状相同但**不是**受控执行器签发的实例（WeakSet 不在册）⇒ 仍 untrusted_receipt
    const forged = { ...receipt('act-1', submissionId, 'EXT-1', 'confirmed') } as unknown as ExternalReceipt;
    expectCode(() => ledger.observe(submissionId, forged), 'untrusted_receipt');

    // 另一份回执（externalId 不同）不是"重复投递" ⇒ 走状态机 ⇒ confirmed 无出边 ⇒ 拒
    expectCode(
      () => ledger.observe(submissionId, receipt('act-1', submissionId, 'EXT-2', 'confirmed')),
      'illegal_submission_transition',
    );
    expect(ledger.getSubmission(submissionId)?.state).toBe('confirmed');
  });

  it('查原单返回的同一份回执也幂等：第二次查单不再改变已 confirmed 的提交', async () => {
    const orderQuery = recordingQuery((request) =>
      receipt(request.actionId, request.requestRef, 'EXT-Q', 'confirmed', T0 + 5_000),
    );
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '网关超时' }));
    const fixture = setup({ executor, orderQuery });
    const { ledger } = fixture;
    const submissionId = await submitChain(fixture, 'task:gamma', 'act-1');

    const firstQuery = await ledger.queryOriginalOrder(submissionId);
    expect(firstQuery.submission.state).toBe('confirmed');

    const secondQuery = await ledger.queryOriginalOrder(submissionId);
    // 终态：再次查单直接短路（queried=false），提交保持不变
    expect(secondQuery.queried).toBe(false);
    expect(secondQuery.submission.state).toBe('confirmed');
    expect(fixture.executor.calls).toHaveLength(1);
  });

  it('查原单请求携带 taskId（供应方回执可归属到任务）', async () => {
    const orderQuery = recordingQuery((request) =>
      receipt(request.actionId, request.requestRef, 'EXT-Q', 'confirmed', T0 + 5_000),
    );
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '网关超时' }));
    const fixture = setup({ executor, orderQuery });
    const submissionId = await submitChain(fixture, 'task:gamma', 'act-1');

    const outcome = await fixture.ledger.reconcileUnknown(submissionId);
    expect(fixture.orderQuery.calls).toHaveLength(1);
    expect(fixture.orderQuery.calls[0]!.taskId).toBe('task:gamma');
    expect(fixture.orderQuery.calls[0]!.actionId).toBe('act-1');
    expect(outcome.submission.state).toBe('confirmed');
  });
});
