/**
 * M-I23｜「HTTP 成功且业务失败不能报成功」——在 M07+M09 缝上钉死。
 *
 * 这是本线最要害的假成功来源：`HTTP 200 + 业务码非 ok`。判据必须落到
 * `rejected` / `unknown`，**绝不**落 `submitted`/`confirmed`；更不得被桥成一条
 * M09 可跟踪的「已下单」意图（`providerOrderRef` 为空 ⇒ 派生即拒）。
 *
 * 反向对照同时钉住：即使业务码 `ok`（`submitted`），`submitted` 也**不是**
 * 「订单已下达」——只有查原单收口到 `confirmed` 才可以声称。
 */

import { describe, expect, it } from 'vitest';

import {
  businessFailureResponse,
  createOrderReceipt,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { PersistedOrderIntentError, persistedOrderIntentFromSubmission } from '../../../src/mobile-plugins/meituan/order-intent/index.js';

import {
  EXTERNAL_ID,
  T0,
  bridgeTracker,
  createSetup,
  expectThrowCode,
  lifecyclePort,
  lifecycleResultFor,
  queriedExternalIds,
} from './support.js';

describe('M-I23 HTTP 成功 + 业务失败：绝不报成功', () => {
  it('HTTP 200 + sold_out ⇒ rejected；不可声称已下单，也不可桥成 M09 可跟踪意图', async () => {
    const setup = createSetup({ respond: () => businessFailureResponse('sold_out') });

    const outcome = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    // 传输层确实成功、业务码确实失败 —— 两者都被如实保存。
    expect(outcome.record.httpStatus).toBe(200);
    expect(outcome.record.businessCode).toBe('sold_out');
    expect(outcome.record.outcomeKind).toBe('business_failure');
    expect(outcome.record.state).toBe('rejected');
    // 不得声称订单已下达。
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
    expectThrowCode(() => setup.submitter.assertOrderPlacedClaimable(setup.key), 'order_not_placed');
    // 没有可核验平台单号 ⇒ 不能派生 M09 可跟踪意图。
    expect(outcome.record.providerOrderRef).toBeNull();
    expect(() => persistedOrderIntentFromSubmission(outcome.record)).toThrow(PersistedOrderIntentError);

    // 再次提交仍 dedup、不重下。
    const second = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(second.deduplicated).toBe(true);
    expect(second.executorCalled).toBe(false);
    expect(second.record.state).toBe('rejected');
    expect(setup.executor?.calls).toHaveLength(1);
  });

  it('HTTP 200 + price_changed ⇒ rejected（业务失败，不是未知、不是成功）', async () => {
    const setup = createSetup({ respond: () => businessFailureResponse('price_changed') });
    const outcome = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(outcome.record.state).toBe('rejected');
    expect(outcome.record.outcomeKind).toBe('business_failure');
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
  });

  it('HTTP 200 + 空业务码 ⇒ unknown（不猜成功），且不可声称已下单', async () => {
    const setup = createSetup({ respond: () => businessFailureResponse('') });
    const outcome = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(outcome.record.state).toBe('unknown');
    expect(outcome.record.businessCode).toBe('');
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
    expectThrowCode(() => setup.submitter.assertOrderPlacedClaimable(setup.key), 'order_not_placed');
  });
});

describe('M-I23 对照：submitted（HTTP + 业务 ok）也还不是「已下单」', () => {
  it('HTTP 200 + ok ⇒ submitted，但只有查原单收口到 confirmed 才可声称；M09 查原单', async () => {
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

    const outcome = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(outcome.record.state).toBe('submitted');
    // submitted 只是「平台业务码说受理了」，不算已下达。
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
    expectThrowCode(() => setup.submitter.assertOrderPlacedClaimable(setup.key), 'order_not_placed');

    const { record } = await setup.submitter.queryOriginalOrder(setup.key);
    expect(record.state).toBe('confirmed');
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(true);

    const tracker = bridgeTracker(record);
    const port = lifecyclePort([lifecycleResultFor(record)]);
    await tracker.resumeAfterDisconnect(port);
    expect(queriedExternalIds(port)).toEqual([EXTERNAL_ID]);
    expect(setup.executor?.calls).toHaveLength(1);
  });
});
