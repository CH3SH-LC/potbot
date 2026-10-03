/**
 * M-I07 —— **网络状态感知**：离线 / 发出前失败必须落 `not_sent`，绝不落 `sent_unknown`。
 *
 * 落地 M-R04 integrationRequest #2。手机最常见的扰动是"掉线 / 换网 / 回网"：
 *
 * - 掉线时的"发送"必须是"**没发出**"（可安全续发同一条），
 *   绝不能记成"发出后未知"——那会凭空制造一次"可能已下单"；
 * - "发出前失败"（DNS / 连接建立 / TLS）可判定**未到达平台**，同样落 not-sent；
 * - "发出中失败"（请求已在途）可能已到达平台，只能落 sent-unknown 并查原单。
 *
 * 两种触发路径都被覆盖：
 *   1. **前置**：注入网络端口 `isOnline()===false` ⇒ 提交拒绝发出（`submit_offline_not_sent`）；
 *   2. **结果**：执行器回报 `offline` / `not_sent(before_send)` ⇒ 撤销发出意图。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderSubmitError,
  classifySubmitResponse,
  notSentResult,
  offlineResult,
  okResponse,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import { FakeNetwork, createScenario } from './support.js';

describe('M-I07 分类层：offline / not_sent 的语义', () => {
  it('offline ⇒ not_sent，needsQuery=false，retryable=true', () => {
    const c = classifySubmitResponse(offlineResult());
    expect(c.kind).toBe('not_sent');
    expect(c.notSent).toBe(true);
    expect(c.needsQuery).toBe(false);
    expect(c.retryable).toBe(true);
  });

  it('not_sent(before_send) ⇒ not_sent（可判定未到达）', () => {
    const c = classifySubmitResponse(notSentResult('before_send'));
    expect(c.kind).toBe('not_sent');
    expect(c.notSent).toBe(true);
    expect(c.needsQuery).toBe(false);
  });

  it('not_sent(during_send) ⇒ unknown，needsQuery=true（可能已到达，不可当未发出）', () => {
    const c = classifySubmitResponse(notSentResult('during_send'));
    expect(c.kind).toBe('unknown');
    expect(c.notSent).toBe(false);
    expect(c.needsQuery).toBe(true);
  });
});

describe('M-I07 前置：离线时提交拒绝发出（never sent-unknown）', () => {
  it('注入离线网络 ⇒ submit 抛 submit_offline_not_sent，执行器零调用，recover 判 not_sent', async () => {
    const network = new FakeNetwork(false);
    const scenario = createScenario({ network });

    await expect(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
    ).rejects.toMatchObject({ code: 'submit_offline_not_sent' });

    // 执行器**从未**被调用——离线不是"发出后未知"。
    expect(scenario.executor?.calls.length).toBe(0);

    const record = scenario.submitter.getRecord(scenario.key);
    expect(record?.sendIntentAt).toBeNull();
    expect(record?.state).toBe('submitting');

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.kind).toBe('not_sent'); // 绝不是 sent_unknown
    expect(verdict.allowedAction).toBe('resume_same_submission');
    expect(verdict.mayCreateNewOrder).toBe(false);
    expect(verdict.mayIssueNewAuthorizationRef).toBe(false);
  });

  it('回网后可续发同一条（同幂等键，不新建订单）', async () => {
    const network = new FakeNetwork(false);
    const scenario = createScenario({ network, respond: () => okResponse('MT-1') });

    await expect(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
    ).rejects.toMatchObject({ code: 'submit_offline_not_sent' });

    network.setOnline(true);
    const outcome = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });

    expect(outcome.executorCalled).toBe(true);
    expect(scenario.executor?.calls.length).toBe(1);
    expect(outcome.record.state).toBe('submitted');
    expect(scenario.submitter.counts().records).toBe(1); // 仍只有一条记录
  });
});

describe('M-I07 结果层：执行器回报未发出 ⇒ 撤销发出意图', () => {
  it('执行器回报 offline ⇒ 记录落 not_sent（sendIntentAt 撤回为 null），非 sent-unknown', async () => {
    const scenario = createScenario({ respond: () => offlineResult() });
    const outcome = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });

    expect(outcome.executorCalled).toBe(true);
    expect(outcome.record.state).toBe('submitting');
    expect(outcome.record.outcomeKind).toBe('not_sent');
    expect(outcome.record.sendIntentAt).toBeNull();

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.kind).toBe('not_sent');
    expect(verdict.allowedAction).toBe('resume_same_submission');
  });

  it('执行器回报 not_sent(before_send) ⇒ 同上，落 not_sent', async () => {
    const scenario = createScenario({ respond: () => notSentResult('before_send') });
    await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.kind).toBe('not_sent');
    expect(scenario.submitter.getRecord(scenario.key)?.sendIntentAt).toBeNull();
  });

  it('执行器回报 not_sent(during_send) ⇒ sent-unknown，只能查原单（不得重放）', async () => {
    const scenario = createScenario({ respond: () => notSentResult('during_send') });
    const outcome = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });

    expect(outcome.record.sendIntentAt).not.toBeNull();
    expect(outcome.record.state).toBe('unknown');

    const verdict = scenario.submitter.recover(scenario.key);
    expect(verdict.kind).toBe('sent_unknown');
    expect(verdict.allowedAction).toBe('query_original_order');

    // 再次提交被拒（结果未知不得重放）。
    await expect(
      scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key }),
    ).rejects.toMatchObject({ code: 'already_sent_query_only' });
  });
});

describe('M-I07 边界：未注入网络端口时不做前置检查（旧行为不回归）', () => {
  it('省略 network ⇒ 正常提交（无离线前置）', async () => {
    const scenario = createScenario();
    expect(scenario.network).toBeNull();
    const outcome = await scenario.submitter.submit({
      authorization: scenario.ref,
      idempotencyKey: scenario.key,
    });
    expect(outcome.record.state).toBe('submitted');
  });

  it('离线拒绝是 OrderSubmitError，且不留下任何"已发出"证据', async () => {
    const scenario = createScenario({ network: new FakeNetwork(false) });
    let caught: unknown;
    try {
      await scenario.submitter.submit({ authorization: scenario.ref, idempotencyKey: scenario.key });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrderSubmitError);
    expect((caught as OrderSubmitError).code).toBe('submit_offline_not_sent');
    expect(scenario.executor?.calls.length).toBe(0);
  });
});
