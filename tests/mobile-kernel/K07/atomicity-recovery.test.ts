/**
 * K07 独立验证 ②：一次性（原子占用 / 重放 / 重复下单）+ 崩溃恢复 + 完成口径自证阻断。
 *
 * 单进程内存实现里，"并发"只能以**重入**形式表达（JS 单线程、`consume()` 内无 await）。
 * 因此本文件的并发负例用两条可复现的探针：
 *   a) `onConsumed` 重入探针 —— 若实现在回调之后才落账，重入会成功、用例变红；
 *   b) 两次不 await 的 `send()` —— 若实现在 await 之后才落发出意图，第二次也会发出。
 * 这两条都**能咬动**：把实现改成错误顺序，它们会红。
 */

import { describe, expect, it } from 'vitest';

import {
  canTransitionSubmission,
  createTrustedReceipt,
  isAuthorizationError,
  mayClaimExternalCompletion,
  type AuthorizationError,
  type ExternalReceipt,
} from '../../../apps/mobile-kernel/actions/index.js';
import {
  T0,
  binding,
  expectError,
  expectErrorAsync,
  issuedGrant,
  recordingExecutor,
  recordingOrderQuery,
  setupFixture,
} from './fixtures.js';

describe('负例 ⑥：一次性授权 —— 重复占用 / 重放 / 重复下单全部拒绝', () => {
  it('同一授权第二次 consume ⇒ 拒，且只产生一条 submission', () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);

    const first = ledger.consume({ grantId: grant.grantId, actual: binding() });
    expect(ledger.counts().submissions).toBe(1);

    expectError(() => ledger.consume({ grantId: grant.grantId, actual: binding() }), 'grant_already_consumed');
    expect(ledger.counts().submissions).toBe(1);
    expect(ledger.allSubmissions().map((entry) => entry.submissionId)).toEqual([first.submission.submissionId]);
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('submitting');
  });

  it('原子段是同步的：consume 返回的不是 Promise / thenable（单线程下不可被插入）', () => {
    const fixture = setupFixture();
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);

    const outcome = ledger.consume({ grantId: grant.grantId, actual: binding() });
    expect(outcome).not.toBeInstanceOf(Promise);
    expect(typeof (outcome as { then?: unknown }).then).toBe('undefined');
    expect(typeof outcome.submission.submissionId).toBe('string');
  });

  it('重入对抗：回调里看到的已是"占用后"的账本，重入占用必然被拒', () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);

    let stateSeenInsideHook: string | null = null;
    let reentrantError: unknown = null;

    const consumed = ledger.consume({
      grantId: grant.grantId,
      actual: binding(),
      onConsumed: (info) => {
        stateSeenInsideHook = ledger.getSubmission(info.submission.submissionId)?.state ?? null;
        try {
          ledger.consume({ grantId: grant.grantId, actual: binding() });
        } catch (error) {
          reentrantError = error;
        }
      },
    });

    expect(stateSeenInsideHook).toBe('submitting');
    expect(isAuthorizationError(reentrantError)).toBe(true);
    expect((reentrantError as AuthorizationError).code).toBe('grant_already_consumed');
    expect(ledger.counts().submissions).toBe(1);
    expect(ledger.allSubmissions().map((entry) => entry.submissionId)).toEqual([consumed.submission.submissionId]);
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('submitting');
  });

  it('一个动作至多一张授权：再次发行 ⇒ grant_already_issued（堵死"再批一次"这条路）', () => {
    const fixture = setupFixture();
    const { ledger } = fixture;
    issuedGrant(fixture);

    const again = ledger.attest(fixture.confirm.taskId, fixture.confirm.actionId, { surface: 'native.confirm' });
    expectError(() => ledger.issueGrant(again), 'grant_already_issued');
    expect(ledger.counts().grants).toBe(1);
  });

  it('已发出的提交不得再发出（重复下单在 API 上不可表达）', async () => {
    const fixture = setupFixture();
    const { ledger, executor } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    await expectErrorAsync(() => ledger.send(consumed.submission.submissionId), 'already_sent_query_only');
    expect(executor!.calls).toHaveLength(1);
  });

  it('并发安全：两次不 await 的 send 只让执行器被调用一次', async () => {
    const executor = recordingExecutor(async () => {
      await Promise.resolve();
      return { outcome: 'accepted' as const };
    });
    const fixture = setupFixture({ executor });
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });

    const results = await Promise.allSettled([
      ledger.send(consumed.submission.submissionId),
      ledger.send(consumed.submission.submissionId),
    ]);

    expect(executor!.calls).toHaveLength(1);
    const rejected = results.filter((entry) => entry.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(((rejected[0] as PromiseRejectedResult).reason as AuthorizationError).code).toBe(
      'already_sent_query_only',
    );
  });
});

describe('负例 ⑦：崩溃 / 结果未知的恢复（辨明状态、不新建授权、不重复提交）', () => {
  it('占用后、发出前中断 ⇒ 判为"未发出"，只允许继续同一条提交', async () => {
    const fixture = setupFixture();
    const { ledger, executor } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    const before = ledger.counts();

    const verdict = ledger.recover(consumed.submission.submissionId);
    expect(verdict.kind).toBe('not_sent');
    expect(verdict.allowedAction).toBe('resume_same_submission');
    expect(verdict.mayIssueNewGrant).toBe(false);
    expect(verdict.mayCreateNewSubmission).toBe(false);
    expect(verdict.state).toBe('submitting');

    // 不得另发授权
    const reattest = ledger.attest(fixture.confirm.taskId, fixture.confirm.actionId, { surface: 'native.confirm' });
    expectError(() => ledger.issueGrant(reattest), 'grant_already_issued');
    // 不得新建提交：计数与中断时完全一致
    expect(ledger.counts()).toEqual(before);

    // 只允许"继续同一条提交"：submissionId 不变，执行器只被调用一次
    const resumed = await ledger.send(consumed.submission.submissionId);
    expect(resumed.submissionId).toBe(consumed.submission.submissionId);
    expect(resumed.state).toBe('submitted');
    expect(executor!.calls).toHaveLength(1);
    expect(ledger.counts().submissions).toBe(1);
  });

  it('发出途中崩溃（端口抛错）⇒ 判为"已发出未知"，只能查原单、不得重发', async () => {
    const executor = recordingExecutor(() => {
      throw new Error('进程在发出途中死亡');
    });
    const fixture = setupFixture({ executor });
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    const before = ledger.counts();

    await expect(ledger.send(consumed.submission.submissionId)).rejects.toThrow('进程在发出途中死亡');

    const after = ledger.getSubmission(consumed.submission.submissionId)!;
    expect(after.state).toBe('submitting');
    expect(after.sendIntentAt).not.toBeNull();

    const verdict = ledger.recover(consumed.submission.submissionId);
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');
    expect(verdict.mayIssueNewGrant).toBe(false);
    expect(verdict.mayCreateNewSubmission).toBe(false);

    await expectErrorAsync(() => ledger.send(consumed.submission.submissionId), 'already_sent_query_only');
    const reattest = ledger.attest(fixture.confirm.taskId, fixture.confirm.actionId, { surface: 'native.confirm' });
    expectError(() => ledger.issueGrant(reattest), 'grant_already_issued');

    expect(ledger.counts()).toEqual(before);
    expect(ledger.counts().submissions).toBe(1);
    expect(executor!.calls).toHaveLength(1);
  });

  it('端口回报"结果未知" ⇒ 查原单取回执收敛到 confirmed，全程只发出一次', async () => {
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '网关超时，未取回执' }));
    const orderQuery = recordingOrderQuery((request) =>
      createTrustedReceipt({
        actionId: request.actionId,
        provider: 'meituan',
        requestRef: request.requestRef,
        externalId: 'MT-LATE-0001',
        observedState: 'confirmed',
        observedAt: T0 + 5_000,
        evidenceRef: 'evidence://meituan/MT-LATE-0001',
        verificationMode: 'real',
        detail: '晚到回执：订单已受理',
      }),
    );
    const fixture = setupFixture({ executor, orderQuery });
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });

    const sent = await ledger.send(consumed.submission.submissionId);
    expect(sent.state).toBe('unknown');

    const verdict = ledger.recover(consumed.submission.submissionId);
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');

    const queried = await ledger.queryOriginalOrder(consumed.submission.submissionId);
    expect(queried.queried).toBe(true);
    expect(queried.submission.state).toBe('confirmed');
    expect(queried.submission.receipt?.externalId).toBe('MT-LATE-0001');
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('confirmed');

    // 查原单不是重下：执行器仍只被调用一次，查询端口恰好一次
    expect(executor!.calls).toHaveLength(1);
    expect(orderQuery.calls).toHaveLength(1);
    expect(orderQuery.calls[0]!.submissionId).toBe(consumed.submission.submissionId);
    expect(orderQuery.calls[0]!.requestRef).toBe(consumed.submission.submissionId);
    expect(ledger.counts().submissions).toBe(1);
  });

  it('查了但供应方也没结论 ⇒ 状态保持"结果未知"（不猜成失败、更不猜成完成）', async () => {
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '无回执' }));
    const fixture = setupFixture({ executor });
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    const queried = await ledger.queryOriginalOrder(consumed.submission.submissionId);
    expect(queried.queried).toBe(true);
    expect(queried.submission.state).toBe('unknown');
    expect(ledger.describeExternalOutcome(consumed.submission.submissionId).summary).toBe('结果未知');
    expect(ledger.describeExternalOutcome(consumed.submission.submissionId).claimableAsComplete).toBe(false);
  });

  it('没有查询端口 ⇒ 如实报缺（missing_order_query_port），不猜结果', async () => {
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '无回执' }));
    const fixture = setupFixture({ executor, orderQuery: null });
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    await expectErrorAsync(
      () => ledger.queryOriginalOrder(consumed.submission.submissionId),
      'missing_order_query_port',
    );
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('unknown');
  });

  it('"结果未知不得重试"写在转移表里：unknown 不得回到 submitted / submitting', () => {
    expect(canTransitionSubmission('unknown', 'submitted')).toBe(false);
    expect(canTransitionSubmission('unknown', 'submitting')).toBe(false);
    expect(canTransitionSubmission('submitted', 'submitting')).toBe(false);
    expect(canTransitionSubmission('unknown', 'confirmed')).toBe(true);
  });
});

describe('负例 ⑧：自证阻断 —— "结果未知"不得被写成"已完成"', () => {
  it('把 unknown 当成 confirmed ⇒ 判据必须报错', async () => {
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '无回执' }));
    const fixture = setupFixture({ executor });
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    const submissionId = consumed.submission.submissionId;
    await ledger.send(submissionId);
    expect(ledger.getSubmission(submissionId)?.state).toBe('unknown');

    // ① 伪造一份"形状相同"的回执：不是受控执行器签发的，一律拒
    const forged = {
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: submissionId,
      externalId: 'MT-FORGED',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'forged://self-proof',
      detail: '客户端自称已完成',
    } as unknown as ExternalReceipt;
    expectError(() => ledger.observe(submissionId, forged), 'untrusted_receipt');
    expect(ledger.getSubmission(submissionId)?.state).toBe('unknown');

    // ② 判据本身：unknown 不得声称完成
    expect(mayClaimExternalCompletion('unknown')).toBe(false);
    expectError(() => ledger.assertCompletionClaimable(submissionId), 'completion_not_claimable');
    expect(ledger.describeExternalOutcome(submissionId).claimableAsComplete).toBe(false);
    expect(ledger.describeExternalOutcome(submissionId).summary).toBe('结果未知');

    // ③ 结构上不可表达：回执根本不允许回报中间态（连"自称 submitted"都造不出来）
    expectError(
      () =>
        createTrustedReceipt({
          actionId: confirm.actionId,
          provider: 'meituan',
          requestRef: submissionId,
          externalId: 'MT-X',
          observedState: 'submitted' as never,
          observedAt: T0,
          evidenceRef: 'evidence://x',
          verificationMode: 'real',
        }),
      'untrusted_receipt',
    );
  });

  it('缺执行器：send 直接拒，提交留在"未发出"，永远拿不到完成', async () => {
    const fixture = setupFixture({ executor: null });
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });

    await expectErrorAsync(() => ledger.send(consumed.submission.submissionId), 'missing_executor');

    const submission = ledger.getSubmission(consumed.submission.submissionId)!;
    expect(submission.state).toBe('submitting');
    // 关键：缺执行器**不得**留下"已发出"痕迹，否则会被误判成"已发出未知"
    expect(submission.sendIntentAt).toBeNull();
    expect(ledger.recover(consumed.submission.submissionId).kind).toBe('not_sent');
    expectError(() => ledger.assertCompletionClaimable(consumed.submission.submissionId), 'completion_not_claimable');
    expect(ledger.describeExternalOutcome(consumed.submission.submissionId).claimableAsComplete).toBe(false);
  });
});
