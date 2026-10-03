/**
 * M-I23｜`duplicate_order` 业务码：**结果未知**，只能查原单，绝不自动重放。
 *
 * 平台在「这一单其实已经存在」时常返回业务码 `duplicate_order`。它**不是**成功，
 * 也**不是**确定性失败——本地拿不到平台订单详情，唯一合法的收口动作是**查原单**。
 *
 * 判据：
 * - `HTTP 200 + duplicate_order` ⇒ 状态 `unknown`（非成功、非拒单）；
 * - 再次 `submit()` 被拒（`already_sent_query_only`），执行器仍只被调用一次；
 * - 查原单取回可信回执后才 `confirmed`；M09 恢复查的是**原 externalId**，一次；
 * - 查询无结论（端口返回 null）⇒ 保持 `unknown`，不猜、不改写成成功。
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
  expectRejectCode,
  expectThrowCode,
  lifecyclePort,
  lifecycleResultFor,
  queriedExternalIds,
} from './support.js';

describe('M-I23 duplicate_order：判定为未知，先查原单', () => {
  it('HTTP 200 + duplicate_order ⇒ unknown；再提交被拒；查原单确认后 M09 只查原单', async () => {
    const setup = createSetup({
      respond: () => businessFailureResponse('duplicate_order'),
      submitQueryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: EXTERNAL_ID,
          observedState: 'confirmed',
          observedAt: T0 + 100,
          verificationMode: 'real',
          detail: '查原单证实：该单确实已经生成',
        }),
    });

    const outcome = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(outcome.record.state).toBe('unknown');
    expect(outcome.record.outcomeKind).toBe('unknown');
    expect(outcome.record.httpStatus).toBe(200);
    expect(outcome.record.businessCode).toBe('duplicate_order');
    // 绝不当成功。
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
    expectThrowCode(() => setup.submitter.assertOrderPlacedClaimable(setup.key), 'order_not_placed');

    // 不自动重放：再提交被拒，执行器仍只被调用一次。
    await expectRejectCode(
      setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key }),
      'already_sent_query_only',
    );
    expect(setup.executor?.calls).toHaveLength(1);

    // 恢复指引：查原单。
    const verdict = setup.submitter.recover(setup.key);
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);

    const { record } = await setup.submitter.queryOriginalOrder(setup.key);
    expect(record.state).toBe('confirmed');
    expect(record.providerOrderRef).toBe(EXTERNAL_ID);
    expect(setup.executor?.calls).toHaveLength(1);

    const tracker = bridgeTracker(record);
    const port = lifecyclePort([lifecycleResultFor(record)]);
    await tracker.resumeAfterDisconnect(port);
    expect(queriedExternalIds(port)).toEqual([EXTERNAL_ID]);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(setup.executor?.calls).toHaveLength(1);
  });

  it('duplicate_order 后查原单无结论（端口返回 null）⇒ 保持 unknown，不猜成功、不可桥成可跟踪意图', async () => {
    const setup = createSetup({
      respond: () => businessFailureResponse('duplicate_order'),
      submitQueryRespond: () => null,
    });

    await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    const { queried, record } = await setup.submitter.queryOriginalOrder(setup.key);

    expect(queried).toBe(true);
    expect(record.state).toBe('unknown');
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
    // 未经确认的结果没有可核验的平台单号，不得派生为 M09 可跟踪意图。
    expect(record.providerOrderRef).toBeNull();
    expect(() => persistedOrderIntentFromSubmission(record)).toThrow(PersistedOrderIntentError);
  });

  it('未登记业务码（HTTP 200）同样 ⇒ unknown，绝不猜成功', async () => {
    const setup = createSetup({ respond: () => businessFailureResponse('brand_new_code_2099') });
    const outcome = await setup.submitter.submit({ authorization: setup.ref, idempotencyKey: setup.key });
    expect(outcome.record.state).toBe('unknown');
    expect(setup.submitter.describeExternalOutcome(setup.key).placedClaimable).toBe(false);
    expect(setup.executor?.calls).toHaveLength(1);
  });
});
