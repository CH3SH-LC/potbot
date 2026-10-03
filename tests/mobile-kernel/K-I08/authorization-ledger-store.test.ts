/**
 * K-I08 ②：K07 授权 / 提交账本的落盘与冷启动恢复。
 *
 * 硬判据（本单元的核心）：
 * 1. 冷启动**恢复后**：`recover()` 只给"查原单"，`send()` 抛 `already_sent_query_only`、
 *    `consume()` 抛 `grant_already_consumed`、`issueGrant()` 抛 `grant_already_issued`
 *    ——**不重发、不另发授权**；
 * 2. 恢复期**绝不调用真实执行器**（用记录型执行器断言调用次数为 0）；
 * 3. 崩在"发出途中"（写前只有 `send-attempt`、无配对结果）也能恢复成"已发出未知"；
 * 4. 日志损坏 / 截断 / 类别不符 / 引用不存在的授权，一律 `invalid_snapshot`，绝不当空账本。
 */

import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_LEDGER_KEY,
  AuthorizationLedgerStore,
  DurableAuthorizationLedger,
  LedgerBlobStore,
  MemoryBlobStore,
  encodeEnvelope,
  isLedgerStoreError,
  type DurableAuthorizationLedgerOptions,
} from '../../../apps/mobile-kernel/adapters/ledger-store/index.js';
import {
  acceptingExecutor,
  baseConfirm,
  bindingOf as testBinding,
  dyingExecutor,
  emptyOrderQuery,
  manualClock,
  recordingExecutor,
  trustedReceipt,
} from './fixtures.js';

function authStore(blob: MemoryBlobStore): AuthorizationLedgerStore {
  return new AuthorizationLedgerStore(new LedgerBlobStore(blob, AUTHORIZATION_LEDGER_KEY));
}

/** 走完"入账 → 确认 → 发行 → 占用"。返回关键句柄。 */
async function scaffold() {
  const blob = new MemoryBlobStore();
  const store = authStore(blob);
  const clock = manualClock();
  const executor = acceptingExecutor();
  const ledger = await DurableAuthorizationLedger.create({ clock, executor, orderQuery: emptyOrderQuery(), store });
  const confirm = baseConfirm();
  await ledger.recordConfirmAction(confirm);
  const grant = await ledger.issueGrant(ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' }));
  const consumed = await ledger.consume({ grantId: grant.grantId, actual: testBinding(confirm) });
  return { blob, store, clock, executor, ledger, confirm, grant, consumed, submissionId: consumed.submission.submissionId };
}

function restoreOptions(
  store: AuthorizationLedgerStore,
  executor: DurableAuthorizationLedgerOptions['executor'],
): DurableAuthorizationLedgerOptions {
  return { clock: manualClock(), executor, orderQuery: emptyOrderQuery(), store };
}

async function expectInvalidSnapshot(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, '必须抛错').not.toBeUndefined();
  expect(isLedgerStoreError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe('invalid_snapshot');
}

describe('K-I08 ② 冷启动恢复：不重发 / 不另发授权', () => {
  it('发出且受理后，恢复出的账本拒绝对外重发与二次授权', async () => {
    const s = await scaffold();
    s.clock.advance(1000);
    const sent = await s.ledger.send(s.submissionId);
    expect(sent.state).toBe('submitted');
    expect(s.executor.calls).toHaveLength(1);

    const restoreExecutor = acceptingExecutor();
    const restored = await DurableAuthorizationLedger.open(restoreOptions(s.store, restoreExecutor));
    expect(restored).not.toBeNull();
    const r = restored!;

    // 恢复**没有**触碰真实执行器。
    expect(restoreExecutor.calls).toHaveLength(0);
    // 计数与原地完全一致（没有凭空多出授权 / 提交）。
    expect(r.counts()).toEqual(s.ledger.counts());
    expect(r.getSubmission(s.submissionId)!.state).toBe('submitted');
    expect(r.grantForAction(s.confirm.taskId, s.confirm.actionId)!.consumedAt).toBe(
      s.ledger.grantForAction(s.confirm.taskId, s.confirm.actionId)!.consumedAt,
    );

    // 恢复判据：受理待回执 ⇒ 只能查原单。
    const verdict = r.recover(s.submissionId);
    expect(verdict.kind).toBe('awaiting_receipt');
    expect(verdict.allowedAction).toBe('query_original_order');
    expect(verdict.mayIssueNewGrant).toBe(false);
    expect(verdict.mayCreateNewSubmission).toBe(false);

    // 重发被 API 拒绝，且执行器仍未被调用。
    await expectInvalidSnapshotless(r.send(s.submissionId), 'already_sent_query_only');
    expect(restoreExecutor.calls).toHaveLength(0);

    // 二次占用 / 二次授权都被拒。
    await expectInvalidSnapshotless(
      r.consume({ grantId: s.grant.grantId, actual: testBinding(s.confirm) }),
      'grant_already_consumed',
    );
    await expectInvalidSnapshotless(
      r.issueGrant(r.attest(s.confirm.taskId, s.confirm.actionId, { surface: 'native.confirm' })),
      'grant_already_issued',
    );
  });

  it('发出途中死亡（submitting + sendIntentAt）恢复为"已发出未知"，绝不重发', async () => {
    const blob = new MemoryBlobStore();
    const store = authStore(blob);
    const clock = manualClock();
    const executor = dyingExecutor();
    const ledger = await DurableAuthorizationLedger.create({ clock, executor, orderQuery: emptyOrderQuery(), store });
    const confirm = baseConfirm();
    await ledger.recordConfirmAction(confirm);
    const grant = await ledger.issueGrant(ledger.attest(confirm.taskId, confirm.actionId, { surface: 'native.confirm' }));
    const consumed = await ledger.consume({ grantId: grant.grantId, actual: testBinding(confirm) });
    const submissionId = consumed.submission.submissionId;
    clock.advance(10);
    await expect(ledger.send(submissionId)).rejects.toThrow();

    const restoreExecutor = acceptingExecutor();
    const restored = await DurableAuthorizationLedger.open(restoreOptions(store, restoreExecutor));
    const r = restored!;
    expect(restoreExecutor.calls).toHaveLength(0);

    const submission = r.getSubmission(submissionId)!;
    expect(submission.sendIntentAt).not.toBeNull();
    expect(submission.state).toBe('submitting');

    const verdict = r.recover(submissionId);
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');
    expect(verdict.mayIssueNewGrant).toBe(false);

    await expectInvalidSnapshotless(r.send(submissionId), 'already_sent_query_only');
    expect(restoreExecutor.calls).toHaveLength(0);
  });

  it('写前日志：崩在 send 之后、结果落盘之前，也只有 send-attempt——恢复仍判"已发出未知"', async () => {
    const s = await scaffold();
    s.clock.advance(1000);
    await s.ledger.send(s.submissionId);

    const kinds = s.ledger.journal().map((e) => e.kind);
    expect(kinds).toEqual(['confirm-recorded', 'grant-issued', 'grant-consumed', 'send-attempt', 'send-outcome']);

    // 模拟"发出意图已落盘、结果还没落盘"就崩了：把日志截到最后一条 send-outcome 之前。
    const truncated = s.ledger.journal().filter((e) => e.kind !== 'send-outcome');
    await s.blob.write(AUTHORIZATION_LEDGER_KEY, encodeEnvelope('authorization', truncated));

    const restoreExecutor = recordingExecutor(() => {
      throw new Error('恢复期不应调用执行器');
    });
    const restored = await DurableAuthorizationLedger.open(restoreOptions(s.store, restoreExecutor));
    const r = restored!;
    expect(restoreExecutor.calls).toHaveLength(0);
    const submission = r.getSubmission(s.submissionId)!;
    expect(submission.sendIntentAt).not.toBeNull();
    expect(r.recover(s.submissionId).kind).toBe('sent_unknown');
    expect(r.recover(s.submissionId).allowedAction).toBe('query_original_order');
  });

  it('恢复后账本是"活的"：新任务仍可入账 → 授权 → 占用 → 发出（真实执行器被调用一次）', async () => {
    const s = await scaffold();
    s.clock.advance(1000);
    await s.ledger.send(s.submissionId);

    const restoreExecutor = acceptingExecutor();
    const r = (await DurableAuthorizationLedger.open(restoreOptions(s.store, restoreExecutor)))!;

    const next = baseConfirm({ taskId: 'task-2', actionId: 'act-9' });
    await r.recordConfirmAction(next);
    const grant = await r.issueGrant(r.attest(next.taskId, next.actionId, { surface: 'native.confirm' }));
    const consumed = await r.consume({ grantId: grant.grantId, actual: testBinding(next) });
    const sent = await r.send(consumed.submission.submissionId);
    expect(sent.state).toBe('submitted');
    expect(restoreExecutor.calls).toHaveLength(1);
  });
});

describe('K-I08 ② 已确认 / 已撤权的状态也能复原', () => {
  it('可信回执确认后恢复：状态 confirmed，可声称完成', async () => {
    const s = await scaffold();
    s.clock.advance(1000);
    await s.ledger.send(s.submissionId);
    await s.ledger.observe(s.submissionId, trustedReceipt({ requestRef: s.submissionId }));

    const restoreExecutor = acceptingExecutor();
    const r = (await DurableAuthorizationLedger.open(restoreOptions(s.store, restoreExecutor)))!;
    expect(restoreExecutor.calls).toHaveLength(0);
    const submission = r.getSubmission(s.submissionId)!;
    expect(submission.state).toBe('confirmed');
    expect(() => r.assertCompletionClaimable(s.submissionId)).not.toThrow();
    expect(r.recover(s.submissionId).kind).toBe('settled');
  });

  it('撤权后恢复：isRevoked / 授权 cancelled 都不丢', async () => {
    const s = await scaffold();
    await s.ledger.revoke(s.confirm.taskId, s.confirm.actionId, '用户反悔');

    const r = (await DurableAuthorizationLedger.open(restoreOptions(s.store, acceptingExecutor())))!;
    expect(r.isRevoked(s.confirm.taskId, s.confirm.actionId)).toBe(true);
    expect(r.observedStateOf(s.confirm.taskId, s.confirm.actionId)).toBe('cancelled');
  });
});

describe('K-I08 ② 坏日志一律 invalid_snapshot（绝不当空账本）', () => {
  it('空 blob = 干净起点（null）', async () => {
    expect(await DurableAuthorizationLedger.open(restoreOptions(authStore(new MemoryBlobStore()), null))).toBeNull();
  });

  it('非 JSON / 类别不符 / payload 非数组 / 未知事件 / 引用不存在的授权 → invalid_snapshot', async () => {
    const good = await scaffold();
    const events = good.ledger.journal();

    const cases: Array<[string, string]> = [
      ['非 JSON', '{oops'],
      [
        '账本类别不符',
        encodeEnvelope('task', events as unknown as never),
      ],
      [
        'payload 非数组',
        JSON.stringify({ schema: 'potbot.ledger-store', ledger: 'authorization', version: 1, payload: { nope: true } }),
      ],
      [
        '未知事件 kind',
        encodeEnvelope('authorization', [{ kind: 'made-up-event' }] as unknown as never),
      ],
      [
        '占用引用不存在的授权',
        encodeEnvelope('authorization', [
          { kind: 'grant-consumed', grantId: 'grant:missing', submissionId: 'sub:x:y', actual: testBinding(baseConfirm()), at: 1 },
        ] as unknown as never),
      ],
    ];
    for (const [label, text] of cases) {
      const blob = new MemoryBlobStore({ key: AUTHORIZATION_LEDGER_KEY, text });
      await expectInvalidSnapshot(DurableAuthorizationLedger.open(restoreOptions(authStore(blob), null)));
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('读端口报错 → invalid_snapshot', async () => {
    const blob = new MemoryBlobStore(undefined, { failRead: { detail: '介质不可达' } });
    await expectInvalidSnapshot(DurableAuthorizationLedger.open(restoreOptions(authStore(blob), null)));
  });
});

/** 断言一个 promise 以指定 K07 拒因码失败（且不是本层的 invalid_snapshot）。 */
async function expectInvalidSnapshotless(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await promise;
  } catch (error) {
    caught = error;
    threw = true;
  }
  expect(threw, `期望抛出 ${code}`).toBe(true);
  expect((caught as { code?: unknown }).code).toBe(code);
}
