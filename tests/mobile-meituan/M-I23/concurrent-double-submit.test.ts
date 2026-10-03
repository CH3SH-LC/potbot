/**
 * M-I23｜并发双击（concurrent double-submit）：同键在途时第二次提交必须被拒，绝不发起第二单。
 *
 * 机制：M07 在**调用执行器之前**就把 `sendIntentAt` 落账（在第一个 `await` 之前）。
 * 因此任何同时抵达的第二次 `submit()` 必然看见「已留下发出意图」，落到
 * `already_sent_query_only` —— 这正是「并发双击不重复下单」的结构化落地。
 *
 * 断言的是**执行器真实收到的请求数**（并发下仍为 1），而不是本地自报字段。
 */

import { describe, expect, it } from 'vitest';

import { OrderSubmitError, createOrderReceipt } from '../../../src/mobile-plugins/meituan/order-submit/index.js';

import {
  EXTERNAL_ID,
  T0,
  bridgeTracker,
  createSetup,
  expectRejectCode,
  lifecyclePort,
  lifecycleResultFor,
  queriedExternalIds,
  successResponse,
} from './support.js';

describe('M-I23 并发双击：在途时的第二次提交被拒', () => {
  it('同一 tick 发起 3 次同键提交 ⇒ 恰好 1 次执行器调用，其余 already_sent_query_only', async () => {
    const setup = createSetup();

    // 数组字面量从左到右求值：第 1 次调用同步跑到 `await executor.send` 之前就把发出意图落账，
    // 后 2 次调用随即看见它。
    const attempts = [
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
    ];

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const entry of rejected) {
      const reason = (entry as PromiseRejectedResult).reason as OrderSubmitError;
      expect(reason).toBeInstanceOf(OrderSubmitError);
      expect(reason.code).toBe('already_sent_query_only');
    }

    expect(setup.executor?.calls).toHaveLength(1);
    expect(setup.submitter.counts().records).toBe(1);
    expect(setup.submitter.counts().sent).toBe(1);
    expect(fulfilled[0]).toBeDefined();
  });

  it('执行器在途（未返回）时再次提交 ⇒ 立即被拒，且不发出第二次；随后第一次正常收口', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = createSetup({
      respond: async () => {
        await gate;
        return successResponse();
      },
    });

    const inFlight = setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    // 第一次已落发出意图；此刻并发第二次必须被拒。
    await expectRejectCode(
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
      'already_sent_query_only',
    );
    expect(setup.executor?.calls).toHaveLength(1);

    release();
    const settled = await inFlight;
    expect(settled.record.state).toBe('submitted');
    expect(setup.executor?.calls).toHaveLength(1);
  });

  it('并发收口后确认并桥到 M09：resume 仍只查原 externalId 一次，执行器数不变', async () => {
    const setup = createSetup({
      submitQueryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: EXTERNAL_ID,
          observedState: 'confirmed',
          observedAt: T0 + 100,
          verificationMode: 'real',
        }),
    });

    const attempts = [
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
    ];
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(setup.executor?.calls).toHaveLength(1);

    const { record } = await setup.submitter.queryOriginalOrder(setup.key);
    expect(record.state).toBe('confirmed');
    expect(record.providerOrderRef).toBe(EXTERNAL_ID);

    const tracker = bridgeTracker(record);
    const port = lifecyclePort([lifecycleResultFor(record)]);
    await tracker.resumeAfterDisconnect(port);

    expect(queriedExternalIds(port)).toEqual([EXTERNAL_ID]);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(setup.executor?.calls).toHaveLength(1);
  });
});
