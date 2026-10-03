/**
 * K07 独立验证 ⑤：提交恢复的边角（`recover` / `reconcileUnknown` / 撤权与终态）。
 *
 * 本文件补的是既有三份用例**没钉过**的判据（不重复已有覆盖）：
 *   - 已发出的提交被撤权 ⇒ **不**改写成 cancelled（订单已在路上，不编造结果）；
 *   - 执行器受理后（`submitted`）的恢复 ⇒ `awaiting_receipt`，查原单；
 *   - 崩溃窗口（占用后未发出却收到可信回执）⇒ 以证据为准，收口为 confirmed；
 *   - 回执动作不符 / 重复观测终态 ⇒ 机读拒因；
 *   - `reconcileUnknown()`：结果未知时一步恢复（查原单），**永不**代发、**永不**另发授权。
 */

import { describe, expect, it } from 'vitest';

import {
  createTrustedReceipt,
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

describe('K07 恢复边角 ①：撤权只影响"尚未发出"的提交', () => {
  it('已发出的提交不因撤权被改写为 cancelled（真实订单不会因本地撤权消失）', async () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('submitted');

    const revoked = ledger.revoke(confirm.taskId, confirm.actionId, '用户改主意了');

    // 提交记录保持 submitted，不因撤权失真
    expect(revoked.submission?.state).toBe('submitted');
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('submitted');
    // 授权标记已撤（可审计），但因已被占用保持 submitting（订单可能已在路上）
    expect(revoked.grant?.revokedAt).toBe(T0);
    expect(revoked.grant?.state).toBe('submitting');
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('submitted');

    // 撤权后仍不得重发（发出意图是不可逆事实）
    await expectErrorAsync(() => ledger.send(consumed.submission.submissionId), 'already_sent_query_only');
    expect(fixture.executor?.calls).toHaveLength(1);

    // 恢复判据：已受理、等回执 ⇒ 查原单
    const verdict = ledger.recover(consumed.submission.submissionId);
    expect(verdict.kind).toBe('awaiting_receipt');
    expect(verdict.allowedAction).toBe('query_original_order');
  });

  it('结果未知后撤权 ⇒ 状态仍是未知，恢复只允许查原单', async () => {
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '网关超时' }));
    const fixture = setupFixture({ executor });
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('unknown');

    ledger.revoke(confirm.taskId, confirm.actionId, '撤权');

    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('unknown');
    expect(ledger.recover(consumed.submission.submissionId).kind).toBe('sent_unknown');
    expect(ledger.recover(consumed.submission.submissionId).allowedAction).toBe('query_original_order');
  });
});

describe('K07 恢复边角 ②：回执观测的拒因（动作不符 / 终态不可再变）', () => {
  it('回执指向的动作与该提交不符 ⇒ receipt_action_mismatch', async () => {
    const fixture = setupFixture();
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    const foreign = createTrustedReceipt({
      actionId: 'act-someone-else',
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-OTHER',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-OTHER',
      verificationMode: 'real',
    });
    expectError(() => ledger.observe(consumed.submission.submissionId, foreign), 'receipt_action_mismatch');
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('submitted');
  });

  it('同一份 confirmed 回执重复投递 ⇒ 幂等空操作（K-R06 D2 已关闭）', async () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    const ok = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-1',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-1',
      verificationMode: 'real',
    });
    const first = ledger.observe(consumed.submission.submissionId, ok);
    expect(first.state).toBe('confirmed');
    expect(first.receipt?.externalId).toBe('MT-1');

    // 重复投递同一份回执（去重键 actionId+requestRef+externalId+observedState；observedAt 可不同）
    const again = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-1',
      observedState: 'confirmed',
      observedAt: T0 + 1,
      evidenceRef: 'evidence://meituan/MT-1',
      verificationMode: 'real',
    });
    const replay = ledger.observe(consumed.submission.submissionId, again);
    // no-op：返回原封不动的当前提交（状态、回执、updatedAt 都不变）
    expect(replay.state).toBe('confirmed');
    expect(replay).toBe(first);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('confirmed');
  });

  it('终态（confirmed）不可被**另一份**回执改写（confirmed 无出边）', async () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    const ok = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-1',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-1',
      verificationMode: 'real',
    });
    ledger.observe(consumed.submission.submissionId, ok);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('confirmed');

    // 换一个 externalId：不是"重复投递"，仍走状态机 ⇒ confirmed 无出边 ⇒ 拒
    const different = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-2',
      observedState: 'confirmed',
      observedAt: T0 + 1,
      evidenceRef: 'evidence://meituan/MT-2',
      verificationMode: 'real',
    });
    expectError(() => ledger.observe(consumed.submission.submissionId, different), 'illegal_submission_transition');
  });

  it('可信 failed 回执 ⇒ 终态 failed 并记下失败原因', async () => {
    const fixture = setupFixture();
    const { ledger, confirm } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);

    const failed = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-FAIL',
      observedState: 'failed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-FAIL',
      verificationMode: 'real',
      detail: '商家拒单',
    });
    const record = ledger.observe(consumed.submission.submissionId, failed);
    expect(record.state).toBe('failed');
    expect(record.failureReason).toBe('商家拒单');
    expectError(() => ledger.assertCompletionClaimable(consumed.submission.submissionId), 'completion_not_claimable');
  });
});

describe('K07 恢复边角 ③：崩溃窗口 —— 证据优先于本地猜测', () => {
  it('占用后未发出却收到可信 confirmed 回执 ⇒ 收口为 confirmed（submitting→confirmed）', () => {
    const fixture = setupFixture();
    const { ledger, confirm, executor } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    // 崩在"占用后、发出前"：sendIntentAt 仍为 null
    expect(ledger.getSubmission(consumed.submission.submissionId)?.sendIntentAt).toBeNull();

    const receipt = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-CRASH',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-CRASH',
      verificationMode: 'real',
    });
    const record = ledger.observe(consumed.submission.submissionId, receipt);
    expect(record.state).toBe('confirmed');
    // 本地从未调用执行器：这是"证据胜于猜测"的收口，不是重发
    expect(executor?.calls).toHaveLength(0);
    expect(ledger.recover(consumed.submission.submissionId).kind).toBe('settled');
  });

  it('占用后未发出被观测为 unknown ⇒ 判为已发出未知（查原单），本地仍未调用执行器', async () => {
    const fixture = setupFixture();
    const { ledger, confirm, executor, orderQuery } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });

    const unknown = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-?',
      observedState: 'unknown',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-?',
      verificationMode: 'real',
    });
    ledger.observe(consumed.submission.submissionId, unknown);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('unknown');
    expect(ledger.recover(consumed.submission.submissionId).kind).toBe('sent_unknown');

    const queried = await ledger.queryOriginalOrder(consumed.submission.submissionId);
    expect(queried.queried).toBe(true);
    expect(executor?.calls).toHaveLength(0);
    expect(orderQuery?.calls).toHaveLength(1);
  });
});

describe('K07 恢复边角 ④：reconcileUnknown —— 一步恢复，绝不代发/另发授权', () => {
  it('结果未知 + 查询端口收回执 ⇒ 收敛 confirmed，发出与查询各恰好一次', async () => {
    const executor = recordingExecutor(() => ({ outcome: 'unknown' as const, detail: '网关超时' }));
    const orderQuery = recordingOrderQuery((request) =>
      createTrustedReceipt({
        actionId: request.actionId,
        provider: 'meituan',
        requestRef: request.requestRef,
        externalId: 'MT-RECON',
        observedState: 'confirmed',
        observedAt: T0 + 5_000,
        evidenceRef: 'evidence://meituan/MT-RECON',
        verificationMode: 'real',
      }),
    );
    const fixture = setupFixture({ executor, orderQuery });
    const { ledger } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);
    const before = ledger.counts();

    const outcome = await ledger.reconcileUnknown(consumed.submission.submissionId);

    expect(outcome.queried).toBe(true);
    expect(outcome.verdict.kind).toBe('sent_unknown');
    expect(outcome.submission.state).toBe('confirmed');
    expect(outcome.submission.receipt?.externalId).toBe('MT-RECON');
    expect(outcome.mayIssueNewGrant).toBe(false);
    expect(outcome.mayCreateNewSubmission).toBe(false);
    // 没有新增授权 / 没有第二条提交 / 没有重发
    expect(ledger.counts()).toEqual(before);
    expect(executor!.calls).toHaveLength(1);
    expect(orderQuery.calls).toHaveLength(1);
  });

  it('判为"未发出"时不代发：queried=false，执行器零调用，提交不变', async () => {
    const fixture = setupFixture();
    const { ledger, executor } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    const before = ledger.counts();

    const outcome = await ledger.reconcileUnknown(consumed.submission.submissionId);

    expect(outcome.queried).toBe(false);
    expect(outcome.verdict.kind).toBe('not_sent');
    expect(outcome.verdict.allowedAction).toBe('resume_same_submission');
    expect(outcome.submission.state).toBe('submitting');
    expect(outcome.mayIssueNewGrant).toBe(false);
    // 关键：没有代发。发出是对外动作，必须由调用方显式 send()。
    expect(executor!.calls).toHaveLength(0);
    expect(ledger.counts()).toEqual(before);
  });

  it('终态时 queried=false 且不调用查询端口', async () => {
    const fixture = setupFixture();
    const { ledger, confirm, orderQuery } = fixture;
    const { grant } = issuedGrant(fixture);
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    await ledger.send(consumed.submission.submissionId);
    const receipt: ExternalReceipt = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-1',
      observedState: 'confirmed',
      observedAt: T0,
      evidenceRef: 'evidence://meituan/MT-1',
      verificationMode: 'real',
    });
    ledger.observe(consumed.submission.submissionId, receipt);
    const before = ledger.counts();

    const outcome = await ledger.reconcileUnknown(consumed.submission.submissionId);
    expect(outcome.queried).toBe(false);
    expect(outcome.verdict.kind).toBe('settled');
    expect(outcome.submission.state).toBe('confirmed');
    expect(orderQuery!.calls).toHaveLength(0);
    expect(ledger.counts()).toEqual(before);
  });
});
