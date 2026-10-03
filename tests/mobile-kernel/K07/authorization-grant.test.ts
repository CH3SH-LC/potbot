/**
 * K07 独立验证 ①：完整授权链 + 绑定/修订/期限/撤权四类负例。
 *
 * 每条负例都配**对照组**（"没改动的那一项照样能占用"），否则"恒拒"也能骗过负例。
 */

import { describe, expect, it } from 'vitest';

import {
  SUBMISSION_STATES,
  createTrustedReceipt,
  mayClaimExternalCompletion,
  type ActionBinding,
} from '../../../apps/mobile-kernel/actions/index.js';
import { T0, binding, expectError, expectErrorAsync, issuedGrant, setupFixture } from './fixtures.js';

describe('K07 正例：入账 → 确认 → 发行 → 占用 → 提交 → confirmed 全链', () => {
  it('每一步的可观测状态都严格落在八态词表里，且只有 confirmed 能声称完成', async () => {
    const fixture = setupFixture();
    const { ledger, confirm, executor, clock } = fixture;

    // ① 入账 = prepared
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('prepared');
    expect(SUBMISSION_STATES as readonly string[]).toContain(ledger.observedStateOf(confirm.taskId, confirm.actionId));

    // 原生确认页读到的载荷来自账本
    const display = ledger.getDisplay(confirm.taskId, confirm.actionId);
    expect(display.source).toBe('ledger');
    expect(display.amount).toBe(3980);
    expect(display.currency).toBe('CNY');
    expect(display.accountRef).toBe(confirm.accountRef);
    expect(Object.isFrozen(display)).toBe(true);

    // ② 发行 = authorized
    const { grant } = issuedGrant(fixture);
    expect(grant.state).toBe('authorized');
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('authorized');
    // 绑定的九项全部逐字绑定（含任务身份 taskId）
    expect(grant.taskId).toBe(confirm.taskId);
    expect(grant.actionId).toBe(confirm.actionId);
    expect(grant.accountRef).toBe(confirm.accountRef);
    expect(grant.taskRevision).toBe(confirm.taskRevision);
    expect(grant.paramsDigest).toBe(confirm.paramsDigest);
    expect(grant.quoteRef).toBe(confirm.quoteRef);
    expect(grant.amount).toBe(confirm.amount);
    expect(grant.currency).toBe(confirm.currency);
    expect(grant.scope).toBe(confirm.scope);
    expect(grant.expiresAt).toBe(confirm.expiresAt);

    // ③ 占用 = submitting（此时尚未留下发出意图）
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    expect(consumed.submission.state).toBe('submitting');
    expect(consumed.submission.sendIntentAt).toBeNull();
    expect(consumed.grant.consumedAt).toBe(T0);
    expect(consumed.grant.consumedBySubmissionId).toBe(consumed.submission.submissionId);
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('submitting');

    // ④ 提交 = submitted（执行器恰好被调用一次）
    const sent = await ledger.send(consumed.submission.submissionId);
    expect(sent.state).toBe('submitted');
    expect(sent.sentAt).toBe(T0);
    expect(executor!.calls).toHaveLength(1);
    expect(executor!.calls[0]!.submissionId).toBe(consumed.submission.submissionId);
    expect(executor!.calls[0]!.amount).toBe(3980);
    expect(executor!.calls[0]!.currency).toBe('CNY');

    // ⑤ 可信回执到达 = confirmed
    const receipt = createTrustedReceipt({
      actionId: confirm.actionId,
      provider: 'meituan',
      requestRef: consumed.submission.submissionId,
      externalId: 'MT-2026-0001',
      observedState: 'confirmed',
      observedAt: clock.now(),
      evidenceRef: 'evidence://meituan/MT-2026-0001',
      verificationMode: 'real',
      detail: '商家已接单',
    });
    const confirmed = ledger.observe(consumed.submission.submissionId, receipt);
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.receipt?.externalId).toBe('MT-2026-0001');
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('confirmed');

    expect(ledger.describeExternalOutcome(consumed.submission.submissionId)).toEqual({
      state: 'confirmed',
      summary: '已确认',
      claimableAsComplete: true,
    });
    expect(() => ledger.assertCompletionClaimable(consumed.submission.submissionId)).not.toThrow();
    expect(ledger.counts()).toEqual({ confirms: 1, grants: 1, submissions: 1, revoked: 0 });
  });
});

describe('负例 ①：入账/授权/提交途中，任何中间态都不得声称"外部动作完成"', () => {
  it('八态里只有 confirmed 通过判据，其余七态一律被拒', () => {
    const claimable = SUBMISSION_STATES.filter((state) => mayClaimExternalCompletion(state));
    expect(claimable).toEqual(['confirmed']);
    for (const state of SUBMISSION_STATES) {
      if (state === 'confirmed') {
        continue;
      }
      expect(mayClaimExternalCompletion(state)).toBe(false);
    }
  });

  it('已提交但无回执（submitted）不得被当成完成', async () => {
    const { ledger, executor, clock, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });
    const sent = await ledger.send(consumed.submission.submissionId);

    expect(sent.state).toBe('submitted');
    expectError(
      () => ledger.assertCompletionClaimable(sent.submissionId),
      'completion_not_claimable',
    );
    expect(ledger.describeExternalOutcome(sent.submissionId).claimableAsComplete).toBe(false);
    expect(ledger.describeExternalOutcome(sent.submissionId).summary).toBe('已提交');
  });
});

describe('负例 ②：参数变化后用旧授权一律拒绝（逐项对照）', () => {
  it('paramsDigest / amount / quoteRef / scope / accountRef / currency / actionId 任一改动即拒，且拒因field指认该字段', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });

    const changed: ReadonlyArray<readonly [string, Partial<ActionBinding>]> = [
      ['paramsDigest', { paramsDigest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999' }],
      ['amount', { amount: 1 }],
      ['quoteRef', { quoteRef: 'quote:mt-002' }],
      ['scope', { scope: 'external-mutation' }],
      ['accountRef', { accountRef: 'acct:attacker:0001' }],
      ['currency', { currency: 'USD' }],
      ['actionId', { actionId: 'act-other' }],
    ];

    for (const [field, patch] of changed) {
      expectError(
        () => ledger.consume({ grantId: grant.grantId, actual: binding(patch) }),
        'grant_binding_mismatch',
        field,
      );
    }

    // 一条提交都没产生，授权也仍未被占用
    expect(ledger.counts().submissions).toBe(0);
    expect(ledger.observedStateOf(confirm.taskId, confirm.actionId)).toBe('authorized');
    expect(executor!.calls).toHaveLength(0);

    // 对照组：原始值仍然可以正常占用 —— 证明上面的拒绝来自"改了那一项"，不是恒拒
    const ok = ledger.consume({ grantId: grant.grantId, actual: binding() });
    expect(ok.submission.state).toBe('submitting');
  });
});

describe('负例 ③：任务修订推进后用旧授权一律拒绝', () => {
  it('提交时 taskRevision 与授权绑定不符 ⇒ 拒（field=taskRevision）', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });

    expectError(
      () => ledger.consume({ grantId: grant.grantId, actual: binding({ taskRevision: 8 }) }),
      'grant_binding_mismatch',
      'taskRevision',
    );
    expect(ledger.counts().submissions).toBe(0);
  });

  it('账本里确认请求被改写到新修订后，旧确认凭证失效（attestation_binding_mismatch）', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const attestation = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });

    // 任务推进：账本侧的确认请求被改写（新修订 + 新参数摘要）
    ledger.amendConfirmAction(confirm.taskId, confirm.actionId, {
      ...confirm,
      taskRevision: 8,
      paramsDigest: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
    });

    expectError(() => ledger.issueGrant(attestation), 'attestation_binding_mismatch');

    // 对照组：对**账本最新内容**重新确认后可以正常发行
    const fresh = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });
    const grant = ledger.issueGrant(fresh);
    expect(grant.taskRevision).toBe(8);
  });

  it('已发行授权的动作不得被改写（grant_already_issued）', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    issuedGrant({ ledger, clock, executor, confirm, orderQuery });
    expectError(
      () => ledger.amendConfirmAction(confirm.taskId, confirm.actionId, { ...confirm, taskRevision: 8 }),
      'grant_already_issued',
    );
  });
});

describe('负例 ④：过期一律拒绝（注入时钟推过 expiresAt）', () => {
  it('占用时已过期 ⇒ grant_expired（含"到点即失效"边界）', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });

    // 边界前一格仍可用
    clock.set(confirm.expiresAt - 1);
    expect(() => ledger.consume({ grantId: grant.grantId, actual: binding() })).not.toThrow();

    // 另一条独立链路：正好到点即失效
    const second = setupFixture({ confirm: { actionId: 'act-boundary' } });
    const secondGrant = issuedGrant(second).grant;
    second.clock.set(second.confirm.expiresAt);
    expectError(
      () => second.ledger.consume({ grantId: secondGrant.grantId, actual: binding({ actionId: 'act-boundary' }) }),
      'grant_expired',
      'expiresAt',
    );
    expect(second.ledger.counts().submissions).toBe(0);
  });

  it('过期后确认与发行都被拒（confirm_expired / grant_expired）', () => {
    const late = setupFixture();
    late.clock.advance(60_001);
    expectError(
      () => late.ledger.attest(late.confirm.taskId, late.confirm.actionId, { surface: 'native.confirm' }),
      'confirm_expired',
      'expiresAt',
    );

    const justInTime = setupFixture();
    const attestation = justInTime.ledger.attest(justInTime.confirm.taskId, justInTime.confirm.actionId, {
      surface: 'native.confirm',
    });
    justInTime.clock.advance(60_001);
    expectError(() => justInTime.ledger.issueGrant(attestation), 'grant_expired', 'expiresAt');
  });

  it('占用后、发出前过期 ⇒ 不得发出（grant_expired，且执行器一次都没被调用）', async () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });

    clock.advance(60_001);
    await expectErrorAsync(() => ledger.send(consumed.submission.submissionId), 'grant_expired', 'expiresAt');
    expect(executor!.calls).toHaveLength(0);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('cancelled');
  });
});

describe('负例 ⑤：撤权一律拒绝（发行 / 占用 / 发出三处都拦）', () => {
  it('撤权后占用 ⇒ grant_revoked', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });

    ledger.revoke(confirm.taskId, confirm.actionId, '用户改主意了');
    expectError(() => ledger.consume({ grantId: grant.grantId, actual: binding() }), 'grant_revoked');
    expect(ledger.counts().submissions).toBe(0);
  });

  it('撤权后确认与发行 ⇒ grant_revoked', () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const attestation = ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' });
    ledger.revoke(confirm.taskId, confirm.actionId, '用户改主意了');

    expectError(() => ledger.issueGrant(attestation), 'grant_revoked');

    const other = setupFixture();
    other.ledger.revoke(other.confirm.taskId, other.confirm.actionId, '用户改主意了');
    expectError(
      () => other.ledger.attest(other.confirm.taskId, other.confirm.actionId, { surface: 'native.confirm' }),
      'grant_revoked',
    );
    // 还没发行过授权就撤权：可观测状态是"已取消"，不得仍报成"已准备"
    expect(other.ledger.observedStateOf(other.confirm.taskId, other.confirm.actionId)).toBe('cancelled');
    expect(other.ledger.isRevoked(other.confirm.taskId, other.confirm.actionId)).toBe(true);
    expect(other.ledger.observedStateOf(other.confirm.taskId, 'act-never-existed')).toBeNull();
  });

  it('占用后、发出前撤权 ⇒ 不得发出，执行器一次都没被调用', async () => {
    const { ledger, clock, executor, confirm, orderQuery } = setupFixture();
    const { grant } = issuedGrant({ ledger, clock, executor, confirm, orderQuery });
    const consumed = ledger.consume({ grantId: grant.grantId, actual: binding() });

    ledger.revoke(confirm.taskId, confirm.actionId,'撤销授权');
    await expectErrorAsync(() => ledger.send(consumed.submission.submissionId), 'grant_revoked');
    expect(executor!.calls).toHaveLength(0);
    expect(ledger.getSubmission(consumed.submission.submissionId)?.state).toBe('cancelled');
    expect(ledger.getSubmission(consumed.submission.submissionId)?.sendIntentAt).toBeNull();
  });

  it('撤权只影响被撤的动作：另一个动作照常走完全链', async () => {
    const first = setupFixture();
    const second = setupFixture({ confirm: { actionId: 'act-2' } });
    issuedGrant(first);
    first.ledger.revoke(first.confirm.taskId, first.confirm.actionId, '撤销 A');

    const secondGrant = issuedGrant(second).grant;
    const consumed = second.ledger.consume({ grantId: secondGrant.grantId, actual: binding({ actionId: 'act-2' }) });
    const sent = await second.ledger.send(consumed.submission.submissionId);
    expect(sent.state).toBe('submitted');
    expect(second.executor?.calls).toHaveLength(1);
    expect(second.ledger.isRevoked(second.confirm.taskId, second.confirm.actionId)).toBe(false);
  });
});
