/**
 * M07 幂等 / 重复请求 / 超时恢复 —— **本包验收判据的核心切片**。
 *
 * 工作书 M07 的独立验收口径：
 * 1. 双击不重复订单；
 * 2. 重启不重复订单；
 * 3. HTTP 成功且业务失败不能报成功（另见 business-codes.test.ts）；
 * 4. 结果未知先查原单，无可核验幂等保障时不自动重放。
 *
 * 本文件把 (1)(2)(4) 变成**可执行断言**：每个用例都用脚本化执行器/查询端口观测
 * "执行器真实收到几次请求"，而不是读本地自报的字段。任何"成功"都来自显式 fixture，
 * **不构成**真实订单或平台回执。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderSubmitError,
  createOrderReceipt,
  timeoutResult,
  type OrderReceipt,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import { T0, createScenario, restartScenario } from './support.js';

/** 断言 Promise 以指定**拒因码**被拒（不是"抛了个错"）。 */
function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`期望被拒（${code}），但调用成功了`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(OrderSubmitError);
      expect((error as OrderSubmitError).code).toBe(code);
    },
  );
}

describe('M07 幂等：双击 / 并发不重复下单', () => {
  it('同键顺序提交两次 ⇒ 执行器只被调用一次，第二次返回同一条记录', async () => {
    const scenario = createScenario();
    const first = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });
    expect(first.executorCalled).toBe(true);
    expect(first.record.state).toBe('submitted');

    const second = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });

    // 核心观测量：执行器真实收到的请求数。
    expect(scenario.executor?.calls).toHaveLength(1);
    expect(second.executorCalled).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(scenario.submitter.counts().records).toBe(1);
    expect(scenario.submitter.counts().sent).toBe(1);
  });

  it('第一次提交尚未返回（在途）时再次提交 ⇒ already_sent_query_only，执行器仍只被调用一次', async () => {
    const scenario = createScenario();

    const inFlight = scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });
    // 第一次调用已在 await 之前落账发出意图，故此处必然看见它。
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'already_sent_query_only',
    );

    const settled = await inFlight;
    expect(settled.record.state).toBe('submitted');
    expect(scenario.executor?.calls).toHaveLength(1);
    expect(scenario.submitter.counts().records).toBe(1);
  });

  it('业务拒单后再次提交 ⇒ 返回同一条 rejected 记录，不重下', async () => {
    const scenario = createScenario({
      respond: () => Object.freeze({ transport: 'response', httpStatus: 200, businessCode: 'sold_out', providerOrderRef: null }),
    });
    const first = await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    expect(first.record.state).toBe('rejected');

    const second = await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    expect(second.executorCalled).toBe(false);
    expect(second.record.state).toBe('rejected');
    expect(scenario.executor?.calls).toHaveLength(1);
  });

  it('幂等键由绑定决定：金额不同 ⇒ 不同键 ⇒ 是两单（不是被误当成重复）', async () => {
    const scenario = createScenario();
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });

    // 另一份绑定（金额不同）→ 另一个键；本用例只断言键确实不同，
    // 不发起第二单（新绑定需要新的授权引用，超出本用例范围）。
    const { computeIdempotencyKey } = await import(
      '../../../src/mobile-plugins/meituan/order-submit/index.js'
    );
    const otherKey = computeIdempotencyKey({
      actionId: 'action-1',
      merchantId: 'merchant-1',
      accountRef: 'acct:meituan:7788',
      taskRevision: 3,
      paramsDigest: scenario.ref.paramsDigest,
      quoteRef: 'quote-1',
      amount: 9900,
      currency: 'CNY',
      scope: 'submit-order',
    });
    expect(otherKey).not.toBe(scenario.key);
    expect(scenario.submitter.getRecord(otherKey)).toBeUndefined();
  });
});

describe('M07 幂等：重启后不重复下单（共享存储模拟）', () => {
  it('重启（新提交器 / 新执行器 / 同一存储）后同键提交 ⇒ 不调执行器，返回原记录', async () => {
    const before = createScenario();
    const first = await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });
    expect(first.record.state).toBe('submitted');

    const after = restartScenario(before);
    // 新进程：新执行器（before.executor 已不可达），共享同一份提交账本。
    const resumed = await after.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });

    expect(after.executor?.calls).toHaveLength(0); // 新执行器从未被调用
    expect(resumed.executorCalled).toBe(false);
    expect(resumed.deduplicated).toBe(true);
    expect(resumed.record.state).toBe('submitted');
    expect(after.submitter.counts().records).toBe(1);
  });

  it('重启后对同一键 recover ⇒ settled/none（已落定，无需任何动作）', async () => {
    const before = createScenario();
    await before.submitter.submit({ authorization: before.ref, idempotencyKey: before.key });

    const after = restartScenario(before);
    const verdict = after.submitter.recover(before.key);
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);
    expect(['awaiting_receipt', 'settled']).toContain(verdict.kind);
  });
});

describe('M07 超时 / 结果未知：只查原单，不自动重放', () => {
  it('超时 ⇒ unknown（非终态），再次 submit 被拒且执行器只调用一次', async () => {
    const scenario = createScenario({ respond: () => timeoutResult('socket timeout') });
    const outcome = await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });

    expect(outcome.record.state).toBe('unknown');
    expect(outcome.record.sendIntentAt).not.toBeNull();
    expect(outcome.record.failureReason).not.toBeNull();

    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'already_sent_query_only',
    );
    expect(scenario.executor?.calls).toHaveLength(1);
  });

  it('未知态 recover ⇒ sent_unknown / query_original_order，且类型层面不表达"新建订单 / 另发授权"', async () => {
    const scenario = createScenario({ respond: () => timeoutResult() });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.state).toBe('unknown');
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);
  });

  it('缺原单查询端口 ⇒ missing_order_query_port（如实报缺，不重下）', async () => {
    const scenario = createScenario({ respond: () => timeoutResult(), withQueryPort: false });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    await expectRejectCode(scenario.submitter.queryOriginalOrder(scenario.key), 'missing_order_query_port');
    expect(scenario.executor?.calls).toHaveLength(1);
  });

  it('查原单取回可信 confirmed 回执 ⇒ confirmed；**此时**才可声称订单已下达', async () => {
    const clock = new FixtureClock(T0);
    const scenario = createScenario({
      clock,
      respond: () => timeoutResult(),
      queryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: 'MT-7777',
          observedState: 'confirmed',
          observedAt: clock.now(),
          verificationMode: 'real',
          detail: '平台查回：订单已受理',
        }),
    });

    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    expect(scenario.submitter.describeExternalOutcome(scenario.key).placedClaimable).toBe(false);

    const { queried, record } = await scenario.submitter.queryOriginalOrder(scenario.key);
    expect(queried).toBe(true);
    expect(record.receipt?.providerOrderRef).toBe('MT-7777');
    expect(record.state).toBe('confirmed');
    expect(scenario.submitter.describeExternalOutcome(scenario.key).placedClaimable).toBe(true);
    expect(() => scenario.submitter.assertOrderPlacedClaimable(scenario.key)).not.toThrow();
    // 查原单没有触发任何新的提交。
    expect(scenario.executor?.calls).toHaveLength(1);
  });

  it('查原单无结论（端口返回 null）⇒ 状态保持 unknown，不猜、不改写成失败', async () => {
    const scenario = createScenario({ respond: () => timeoutResult(), queryRespond: () => null });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });

    const { queried, record } = await scenario.submitter.queryOriginalOrder(scenario.key);
    expect(queried).toBe(true);
    expect(record.state).toBe('unknown');
    expect(scenario.submitter.describeExternalOutcome(scenario.key).placedClaimable).toBe(false);
  });

  it('自造回执（非受控签发）自称 confirmed ⇒ untrusted_order_receipt', async () => {
    const scenario = createScenario({
      respond: () => timeoutResult(),
      queryRespond: (request) =>
        ({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: 'MT-FAKE',
          observedState: 'confirmed',
          observedAt: T0,
          verificationMode: 'real',
          detail: '模型自称已下单',
        }) as OrderReceipt,
    });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    await expectRejectCode(scenario.submitter.queryOriginalOrder(scenario.key), 'untrusted_order_receipt');
  });

  it('fixture 回执不得报 confirmed（契约不变量，签发即拒）', () => {
    expect(() =>
      createOrderReceipt({
        idempotencyKey: 'idem-v1-00000000',
        providerOrderRef: 'MT-X',
        observedState: 'confirmed',
        observedAt: T0,
        verificationMode: 'fixture',
      }),
    ).toThrowError(OrderSubmitError);
    // 换成 real 则允许（本包内只用于验证判定链路，不代表真实平台已接通）。
    expect(() =>
      createOrderReceipt({
        idempotencyKey: 'idem-v1-00000000',
        providerOrderRef: 'MT-X',
        observedState: 'confirmed',
        observedAt: T0,
        verificationMode: 'real',
      }),
    ).not.toThrow();
  });

  it('回执幂等键与提交记录不符 ⇒ receipt_key_mismatch', async () => {
    const clock = new FixtureClock(T0);
    const scenario = createScenario({
      clock,
      respond: () => timeoutResult(),
      queryRespond: () =>
        createOrderReceipt({
          idempotencyKey: 'idem-v1-someotherkey',
          providerOrderRef: 'MT-OTHER',
          observedState: 'confirmed',
          observedAt: clock.now(),
          verificationMode: 'real',
        }),
    });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    await expectRejectCode(scenario.submitter.queryOriginalOrder(scenario.key), 'receipt_key_mismatch');
  });
});

describe('M07 崩溃恢复：占用后未发出 / 发出途中死亡', () => {
  it('缺执行器 ⇒ missing_executor，且**不**留下发出意图；recover 判 not_sent，可续发同一键', async () => {
    const scenario = createScenario({ withExecutor: false });
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'missing_executor',
    );

    const record = scenario.submitter.getRecord(scenario.key);
    expect(record?.state).toBe('submitting');
    expect(record?.sendIntentAt).toBeNull();

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.kind).toBe('not_sent');
    expect(verdict.allowedAction).toBe('resume_same_submission');
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);
  });

  it('发出途中执行器抛错 ⇒ 记录停在 submitting + sendIntentAt；recover 判 sent_unknown；查原单可收口为 confirmed', async () => {
    const clock = new FixtureClock(T0);
    const scenario = createScenario({
      clock,
      respond: () => {
        throw new Error('socket died mid-send');
      },
      queryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: 'MT-CRASH',
          observedState: 'confirmed',
          observedAt: clock.now(),
          verificationMode: 'real',
          detail: '崩溃后平台查回：该单其实已生成',
        }),
    });

    await expect(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
    ).rejects.toThrow(/socket died mid-send/);

    const record = scenario.submitter.getRecord(scenario.key);
    expect(record?.state).toBe('submitting');
    expect(record?.sendIntentAt).not.toBeNull();

    // 不重放：再次 submit 被拒。
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'already_sent_query_only',
    );
    expect(scenario.executor?.calls).toHaveLength(1);

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');

    // 崩溃发生在发出途中、平台其实已受理：查原单必须能收口到 confirmed。
    const { record: settled } = await scenario.submitter.queryOriginalOrder(scenario.key);
    expect(settled.state).toBe('confirmed');
    expect(scenario.submitter.describeExternalOutcome(scenario.key).placedClaimable).toBe(true);
    expect(scenario.executor?.calls).toHaveLength(1);
  });

  it('已终态（confirmed）后 recover ⇒ settled / none，不再有任何后续动作', async () => {
    const clock = new FixtureClock(T0);
    const scenario = createScenario({
      clock,
      respond: () => timeoutResult(),
      queryRespond: (request) =>
        createOrderReceipt({
          idempotencyKey: request.idempotencyKey,
          providerOrderRef: 'MT-DONE',
          observedState: 'confirmed',
          observedAt: clock.now(),
          verificationMode: 'real',
        }),
    });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    await scenario.submitter.queryOriginalOrder(scenario.key);

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.state).toBe('confirmed');
    expect(verdict.kind).toBe('settled');
    expect(verdict.allowedAction).toBe('none');
    expect(verdict.mayCreateNewOrder).toBe(false);
  });

  it('占用后未发出、但授权已过期 ⇒ 拒绝续发（authorization_expired），不发出任何请求', async () => {
    const clock = new FixtureClock(T0);
    const scenario = createScenario({ clock, withExecutor: false, expiresAt: T0 + 1_000 });

    // 崩溃在发出前：占用已落账、无发出意图。
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'missing_executor',
    );
    expect(scenario.submitter.getRecord(scenario.key)?.sendIntentAt).toBeNull();

    // 恢复时授权已过期：不得续发。
    clock.advanceTo(T0 + 1_000);
    await expectRejectCode(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
      'authorization_expired',
    );
    expect(scenario.submitter.counts().sent).toBe(0);
  });

  it('未知键 recover / queryOriginalOrder ⇒ submission_not_found（不虚构记录）', async () => {
    const scenario = createScenario();
    expect(() => scenario.submitter.recover('idem-v1-not-a-key')).toThrowError(OrderSubmitError);
    await expectRejectCode(scenario.submitter.queryOriginalOrder('idem-v1-not-a-key'), 'submission_not_found');
  });
});
