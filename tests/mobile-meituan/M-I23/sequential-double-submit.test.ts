/**
 * M-I23｜顺序双击（sequential double-submit）：M07 只发一次，M09 恢复只查原单。
 *
 * 判据（工作书：「双击不重复订单」）：
 * - 同键顺序提交两次 ⇒ 执行器真实只被调用 **1** 次；
 * - 第二次返回同一条记录（`deduplicated`），不新建记录；
 * - 确认后桥到 M09：`resumeAfterDisconnect` 用**原 externalId** 查询、只查一次，
 *   且**不触发任何新的提交**（M07 执行器调用数不变）。
 */

import { describe, expect, it } from 'vitest';

import { createOrderReceipt } from '../../../src/mobile-plugins/meituan/order-submit/index.js';

import {
  EXTERNAL_ID,
  T0,
  bridgeTracker,
  createSetup,
  lifecyclePort,
  lifecycleResultFor,
  queriedExternalIds,
} from './support.js';

describe('M-I23 顺序双击：单次提交、单次查询', () => {
  it('同键提交两次 ⇒ 执行器仅 1 次；确认后 M09 resume 只查原 externalId', async () => {
    const setup = createSetup({
      submitQueryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: EXTERNAL_ID,
          observedState: 'confirmed',
          observedAt: T0 + 100,
          verificationMode: 'real',
          detail: '平台查回：该单已受理',
        }),
    });

    const first = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(first.executorCalled).toBe(true);
    expect(first.record.state).toBe('submitted');

    const second = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    // 核心观测量：执行器真实收到的请求数 —— 双击不得变成两次下单。
    expect(setup.executor?.calls).toHaveLength(1);
    expect(second.executorCalled).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(setup.submitter.counts().records).toBe(1);

    // 结果收口：查原单取回可信回执。
    const { record } = await setup.submitter.queryOriginalOrder(setup.key);
    expect(record.state).toBe('confirmed');
    expect(record.providerOrderRef).toBe(EXTERNAL_ID);

    // 桥到 M09：恢复后用原 externalId 查询，只查一次；不重下。
    const tracker = bridgeTracker(record);
    const port = lifecyclePort([lifecycleResultFor(record)]);
    await tracker.resumeAfterDisconnect(port);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(queriedExternalIds(port)).toEqual([EXTERNAL_ID]);
    // resume 不产生任何新的提交。
    expect(setup.executor?.calls).toHaveLength(1);
    expect(setup.submitter.counts().records).toBe(1);
  });

  it('连续 5 次同键提交 ⇒ 执行器仍仅 1 次，账本仍仅 1 条', async () => {
    const setup = createSetup();

    for (let index = 0; index < 5; index += 1) {
      await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    }

    expect(setup.executor?.calls).toHaveLength(1);
    expect(setup.submitter.counts().records).toBe(1);
    expect(setup.submitter.counts().sent).toBe(1);
    expect(setup.submitter.getRecord(setup.key)?.attempt).toBe(1);
  });

  it('重复 resolve 返回的记录是冻结的（调用方无法就地改写账本）', async () => {
    const setup = createSetup();
    await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    const second = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });

    expect(Object.isFrozen(second.record)).toBe(true);
    // 账本里读到的记录同样冻结：改不动，也不会被后续调用偷偷换掉。
    const stored = setup.submitter.getRecord(setup.key);
    expect(stored).toBeDefined();
    expect(Object.isFrozen(stored)).toBe(true);
    expect(second.record).toEqual(stored);
  });
});
