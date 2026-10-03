/**
 * M09 断线恢复：**先查询原单**。
 *
 * 断言的是「端口被问的是哪一个 externalId」这一真实语义：
 * - 本地没有 externalId ⇒ **一次查询都不发**（不许凭猜测跟踪）；
 * - 查回来的单不是原单 / 金额对不上 ⇒ 报不匹配并阻断。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderLifecycleTracker,
  OrderMismatchError,
  OrderQueryUnavailableError,
  OrderTrackingBlockedError,
  OrderValidationError,
  createFixtureOrderQueryPort,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { ACCOUNT_REF, AMOUNT_MINOR, CODE, EXTERNAL_ID, makeIntent, makeResult } from './support.js';

describe('M09 断线恢复：查询原单', () => {
  it('resumeAfterDisconnect 用原 externalId 查询，且只查一次', async () => {
    const port = createFixtureOrderQueryPort({
      results: [makeResult({ rawStatusCode: CODE.delivering, observedAt: 1_700_000_100_000 })],
    });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    const view = await tracker.resumeAfterDisconnect(port);

    expect(port.calls.length).toBe(1);
    expect(port.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(port.calls[0]?.accountRef).toBe(ACCOUNT_REF);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(view.rawStatusCode).toBe(CODE.delivering);
  });

  it('本地没有 externalId ⇒ 拒绝，且一次查询都不发（不猜单、不重下）', async () => {
    const port = createFixtureOrderQueryPort({ results: [makeResult()] });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent({ externalId: null }) });
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toThrow(OrderValidationError);
    expect(port.calls.length).toBe(0);
    expect(tracker.view).toBeNull();
  });

  it('查回来的单不是原单 ⇒ 报不匹配并阻断', async () => {
    const port = createFixtureOrderQueryPort({ results: [makeResult({ externalId: 'MT-OTHER-9999' })] });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toThrow(OrderMismatchError);
    expect(tracker.trackable).toBe(false);
    expect(tracker.history.length).toBe(0);
  });

  it('查回来的金额与原单不符（差 1 分）⇒ 报不匹配并阻断', async () => {
    const port = createFixtureOrderQueryPort({ results: [makeResult({ amountMinor: AMOUNT_MINOR - 1 })] });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    try {
      await tracker.resumeAfterDisconnect(port);
      expect.unreachable('应当报金额不匹配');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderMismatchError);
      expect((error as OrderMismatchError).fields).toEqual(['amount']);
    }
    expect(tracker.trackable).toBe(false);
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toThrow(OrderTrackingBlockedError);
  });

  it('端口拒答 ⇒ 明确是「结果未知」，不推断任何状态', async () => {
    const port = createFixtureOrderQueryPort({ results: [] });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toThrow(OrderQueryUnavailableError);
    expect(tracker.view).toBeNull();
    expect(tracker.trackable).toBe(true);
  });

  it('断线恢复后继续推进：查询 → 匹配 → 记录，走同一条闸门', async () => {
    const port = createFixtureOrderQueryPort({
      results: [
        makeResult({ rawStatusCode: CODE.delivering }),
        makeResult({ rawStatusCode: CODE.completed }),
      ],
    });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    await tracker.resumeAfterDisconnect(port);
    const view = await tracker.poll(port);
    expect(tracker.history.length).toBe(2);
    expect(view.rawStatusCode).toBe(CODE.completed);
    expect(port.calls.map((call) => call.externalId)).toEqual([EXTERNAL_ID, EXTERNAL_ID]);
    expect(port.calls.map((call) => call.reason)).toEqual(['resume_after_disconnect', 'poll']);
  });

  it('故障注入：篡改回执金额 ⇒ 本地报不匹配而不是圆场', async () => {
    const port = createFixtureOrderQueryPort({
      results: [makeResult()],
      tamper: (result) => ({ ...result, amountMinor: result.amountMinor + 100 }),
    });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toThrow(OrderMismatchError);
    expect(tracker.trackable).toBe(false);
  });

  it('退款核对查询同样只查原单', async () => {
    const port = createFixtureOrderQueryPort({
      results: [makeResult({ refundStatusCode: CODE.refundApplied, refundAmountMinor: AMOUNT_MINOR })],
    });
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    const view = await tracker.refreshRefund(port);
    expect(port.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(port.calls[0]?.reason).toBe('refund_check');
    expect(view.refund.state).toBe('applied');
  });
});
