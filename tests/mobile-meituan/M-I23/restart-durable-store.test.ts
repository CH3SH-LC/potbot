/**
 * M-I23｜重启不重复订单（restart via a shared/durable store）。
 *
 * 两种「重启」都必须让同键再次提交**不再调用执行器**：
 * 1. **共享 store 实例**（进程内重启：同一账本、新提交器/新执行器）；
 * 2. **持久化替身**（跨进程重启：`serializeOrderSubmissionStore` → `restoreOrderSubmissionStore`）。
 *
 * 幂等键由**绑定**确定性导出、且不含任何时间字段——所以重启后即便换了时钟实例，
 * 仍必须算出**同一个键**。这是本文件第二条核心断言。
 *
 * 业务上还要证明：重启后确认的单，M09 恢复查的是**原 externalId**，一次、且不重下。
 */

import { describe, expect, it } from 'vitest';

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import { createOrderReceipt } from '../../../src/mobile-plugins/meituan/order-submit/index.js';

import {
  EXTERNAL_ID,
  T0,
  bindingOf,
  bridgeTracker,
  createSetup,
  lifecyclePort,
  lifecycleResultFor,
  queriedExternalIds,
  restartFromSnapshot,
  snapshotOf,
} from './support.js';

describe('M-I23 重启：持久化快照（serialize → restore）不重复下单', () => {
  it('跨进程重启：同一绑定重算出同一键；同键再提交 0 次执行器调用，返回原记录', async () => {
    const before = createSetup();
    const first = await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });
    expect(first.record.state).toBe('submitted');
    expect(before.executor?.calls).toHaveLength(1);

    const snapshot = snapshotOf(before.store);
    // 真·新进程：新时钟实例（时间前进）、新账本（由快照重建）、新执行器。
    const after = restartFromSnapshot(snapshot, {
      binding: bindingOf(before.ref),
      clock: new FixtureClock(T0 + 1_000),
    });

    // 幂等键可重现：重启算出的键必须与原键逐字节相同。
    expect(after.key).toBe(before.key);
    expect(after.executor?.calls).toHaveLength(0);

    // 快照往返保真：记录仍在、状态/发出意图/平台单号都对得上。
    const restored = after.store.getByKey(before.key);
    expect(restored?.state).toBe('submitted');
    expect(restored?.providerOrderRef).toBe(EXTERNAL_ID);
    expect(restored?.sendIntentAt).toBe(T0);
    expect(restored?.attempt).toBe(1);

    const resumed = await after.submitter.submit({ authorization: after.ref, idempotencyKey: after.key });
    expect(resumed.executorCalled).toBe(false);
    expect(resumed.deduplicated).toBe(true);
    expect(resumed.record.state).toBe('submitted');
    // 核心：新执行器从未被调用 —— 重启没有变成第二单。
    expect(after.executor?.calls).toHaveLength(0);
    expect(after.submitter.counts().records).toBe(1);
  });

  it('跨进程重启后确认并桥到 M09：resume 只查原 externalId 一次，执行器仍 0 次', async () => {
    const before = createSetup();
    await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });
    const snapshot = snapshotOf(before.store);

    const after = restartFromSnapshot(snapshot, {
      binding: bindingOf(before.ref),
      clock: new FixtureClock(T0 + 2_000),
      submitQueryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: EXTERNAL_ID,
          observedState: 'confirmed',
          observedAt: T0 + 2_100,
          verificationMode: 'real',
        }),
    });

    const { record } = await after.submitter.queryOriginalOrder(after.key);
    expect(record.state).toBe('confirmed');
    expect(record.providerOrderRef).toBe(EXTERNAL_ID);
    // 查原单端口只发了一次，且问的是**本单**的幂等键。
    expect(after.submitQuery?.calls).toHaveLength(1);
    expect(after.submitQuery?.calls[0]?.idempotencyKey).toBe(after.key);
    expect(after.executor?.calls).toHaveLength(0);

    const tracker = bridgeTracker(record);
    const port = lifecyclePort([lifecycleResultFor(record)]);
    await tracker.resumeAfterDisconnect(port);
    expect(queriedExternalIds(port)).toEqual([EXTERNAL_ID]);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    // 恢复没有触发任何提交。
    expect(after.executor?.calls).toHaveLength(0);
  });

  it('重启时账本里是 rejected 记录 ⇒ 再提交仍 dedup、返回 rejected，不重下', async () => {
    const before = createSetup({
      respond: () => Object.freeze({ transport: 'response', httpStatus: 200, businessCode: 'sold_out', providerOrderRef: null }),
    });
    const first = await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });
    expect(first.record.state).toBe('rejected');
    const snapshot = snapshotOf(before.store);

    const after = restartFromSnapshot(snapshot, {
      binding: bindingOf(before.ref),
      clock: new FixtureClock(T0 + 500),
    });
    const resumed = await after.submitter.submit({ authorization: after.ref, idempotencyKey: after.key });

    expect(resumed.deduplicated).toBe(true);
    expect(resumed.executorCalled).toBe(false);
    expect(resumed.record.state).toBe('rejected');
    expect(after.executor?.calls).toHaveLength(0);
  });
});

describe('M-I23 重启：共享 store（进程内新实例）不重复下单', () => {
  it('新提交器 / 新执行器共享同一账本 ⇒ 同键提交不再调执行器', async () => {
    const before = createSetup();
    await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });

    const after = createSetup({
      store: before.store,
      clock: before.clock,
      binding: bindingOf(before.ref),
      grantId: before.ref.grantId,
      expiresAt: before.ref.expiresAt,
    });
    expect(after.executor).not.toBe(before.executor);

    const resumed = await after.submitter.submit({ authorization: after.ref, idempotencyKey: after.key });
    expect(resumed.executorCalled).toBe(false);
    expect(resumed.deduplicated).toBe(true);
    expect(after.executor?.calls).toHaveLength(0);
    expect(after.submitter.counts().records).toBe(1);
  });

  it('共享账本重启后 recover ⇒ settled / awaiting_receipt，类型层面不表达新建订单', async () => {
    const before = createSetup();
    await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });

    const after = createSetup({
      store: before.store,
      clock: before.clock,
      binding: bindingOf(before.ref),
      grantId: before.ref.grantId,
      expiresAt: before.ref.expiresAt,
    });
    const verdict = after.submitter.recover(after.key);
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);
    expect(['awaiting_receipt', 'settled']).toContain(verdict.kind);
    expect(verdict.allowedAction).toBe('query_original_order');
  });
});
