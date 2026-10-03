/**
 * M-I23｜崩溃恢复（crash-mid-send）：发出意图已落账 ⇒ 只能查原单，绝不自动重放。
 *
 * 机制：M07 在调用执行器**之前**落 `sendIntentAt`。执行器抛错 = 发出途中进程死亡，
 * 异常原样上抛、记录停在 `submitting + sendIntentAt`。重启后：
 * - `recover()` 判 `sent_unknown` → 唯一合法动作 `query_original_order`；
 * - 再 `submit()` 被拒（`already_sent_query_only`），新执行器 **0** 次调用；
 * - 查原单确认后，M09 恢复查的是**原 externalId**，一次。
 *
 * 对照：崩溃在**发出前**（缺执行器）⇒ 记录保持未发出，`recover()` 判 `not_sent`，
 * 允许**续发同一条**记录（同一幂等键，不新建订单）。
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
  expectRejectCode,
  lifecyclePort,
  lifecycleResultFor,
  queriedExternalIds,
  restartFromSnapshot,
  snapshotOf,
  successResponse,
} from './support.js';

describe('M-I23 崩溃恢复：发出途中死亡（sent_unknown）', () => {
  it('执行器发出途中抛错 → 落盘重启 → 只查原单；再提交被拒且新执行器 0 调用', async () => {
    const before = createSetup({
      respond: () => {
        throw new Error('socket died mid-send');
      },
    });

    await expect(
      before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key }),
    ).rejects.toThrow(/socket died mid-send/);

    const crashed = before.submitter.getRecord(before.key);
    expect(crashed?.state).toBe('submitting');
    expect(crashed?.sendIntentAt).not.toBeNull();
    expect(before.executor?.calls).toHaveLength(1);

    const snapshot = snapshotOf(before.store);
    const after = restartFromSnapshot(snapshot, {
      binding: bindingOf(before.ref),
      clock: new FixtureClock(T0 + 5),
      submitQueryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: EXTERNAL_ID,
          observedState: 'confirmed',
          observedAt: T0 + 10,
          verificationMode: 'real',
          detail: '崩溃后平台查回：该单其实已生成',
        }),
    });

    // 重启本身不发请求、不查单、不下单。
    expect(after.executor?.calls).toHaveLength(0);
    expect(after.submitQuery?.calls).toHaveLength(0);

    const verdict = after.submitter.recover(after.key);
    expect(verdict.state).toBe('submitting');
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);

    // 不自动重放：再提交被拒，新执行器一次都没被叫。
    await expectRejectCode(
      after.submitter.submit({ authorization: after.ref, idempotencyKey: after.key }),
      'already_sent_query_only',
    );
    expect(after.executor?.calls).toHaveLength(0);

    const { record } = await after.submitter.queryOriginalOrder(after.key);
    expect(record.state).toBe('confirmed');
    expect(record.providerOrderRef).toBe(EXTERNAL_ID);
    expect(after.submitQuery?.calls).toHaveLength(1);
    expect(after.executor?.calls).toHaveLength(0);

    const tracker = bridgeTracker(record);
    const port = lifecyclePort([lifecycleResultFor(record)]);
    await tracker.resumeAfterDisconnect(port);
    expect(queriedExternalIds(port)).toEqual([EXTERNAL_ID]);
    expect(after.executor?.calls).toHaveLength(0);
  });
});

describe('M-I23 崩溃恢复：发出前死亡（not_sent）续发同一条', () => {
  it('缺执行器（发出前崩溃）→ 重启后 recover 判 not_sent，续发复用同一记录/同一键', async () => {
    const before = createSetup({ withExecutor: false });
    await expectRejectCode(
      before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key }),
      'missing_executor',
    );
    const crashed = before.submitter.getRecord(before.key);
    expect(crashed?.state).toBe('submitting');
    expect(crashed?.sendIntentAt).toBeNull();

    const snapshot = snapshotOf(before.store);
    const after = restartFromSnapshot(snapshot, {
      binding: bindingOf(before.ref),
      clock: new FixtureClock(T0 + 5),
      respond: () => successResponse(),
    });
    expect(after.key).toBe(before.key);

    const verdict = after.submitter.recover(after.key);
    expect(verdict.kind).toBe('not_sent');
    expect(verdict.allowedAction).toBe('resume_same_submission');
    expect(verdict.mayCreateNewOrder).toBe(false);

    const resumed = await after.submitter.submit({ authorization: after.ref, idempotencyKey: after.key });
    expect(resumed.executorCalled).toBe(true);
    expect(resumed.record.idempotencyKey).toBe(before.key);
    expect(resumed.record.state).toBe('submitted');
    // 续发同一条：账本仍是 1 条，执行器恰好被叫 1 次。
    expect(after.submitter.counts().records).toBe(1);
    expect(after.executor?.calls).toHaveLength(1);
  });
});
