/**
 * M09 匹配校验：externalId / 账号 / 金额 / 币种任一不符 ⇒ 报不匹配，
 * 且**不得继续跟踪**。
 *
 * 反向对照在 `金额不符` 一组里：差 1 分也必须红（不做容差、不四舍五入）。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderLifecycleTracker,
  OrderMismatchError,
  OrderTrackingBlockedError,
  matchOrderToIntent,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { ACCOUNT_REF, AMOUNT_MINOR, CURRENCY, EXTERNAL_ID, makeIntent, makeResult } from './support.js';

describe('M09 匹配校验：相符', () => {
  it('四项全符 ⇒ matched，fields 为空', () => {
    const match = matchOrderToIntent(makeResult(), makeIntent());
    expect(match.matched).toBe(true);
    expect(match.fields).toEqual([]);
    expect(match.detail).toContain('全部相符');
  });
});

describe('M09 匹配校验：不符（每项各自可咬）', () => {
  it('金额不符（差 1 分）⇒ 报 amount', () => {
    const match = matchOrderToIntent(makeResult({ amountMinor: AMOUNT_MINOR + 1 }), makeIntent());
    expect(match.matched).toBe(false);
    expect(match.fields).toEqual(['amount']);
    expect(match.detail).toContain('金额不符');
    expect(match.detail).toContain('不做容差');
  });

  it('金额不符（差 1 分，方向相反）⇒ 同样报 amount', () => {
    const match = matchOrderToIntent(makeResult({ amountMinor: AMOUNT_MINOR - 1 }), makeIntent());
    expect(match.fields).toEqual(['amount']);
  });

  it('externalId 不符 ⇒ 报 external_id', () => {
    const match = matchOrderToIntent(makeResult({ externalId: 'MT-OTHER-9999' }), makeIntent());
    expect(match.fields).toEqual(['external_id']);
  });

  it('本地意图没有 externalId ⇒ 报 external_id，且说明不得凭猜测跟踪', () => {
    const match = matchOrderToIntent(makeResult(), makeIntent({ externalId: null }));
    expect(match.fields).toEqual(['external_id']);
    expect(match.detail).toContain('不得凭猜测跟踪');
  });

  it('账号引用不符 ⇒ 报 account', () => {
    const match = matchOrderToIntent(makeResult({ accountRef: 'acct-ref-other' }), makeIntent());
    expect(match.fields).toEqual(['account']);
    expect(match.detail).toContain(ACCOUNT_REF);
  });

  it('币种不符 ⇒ 报 currency', () => {
    const match = matchOrderToIntent(makeResult({ currency: 'USD' }), makeIntent());
    expect(match.fields).toEqual(['currency']);
    expect(CURRENCY).toBe('CNY');
  });

  it('多项不符 ⇒ 按固定顺序全部列出', () => {
    const match = matchOrderToIntent(
      makeResult({ externalId: 'MT-OTHER', accountRef: 'acct-ref-other', amountMinor: 1, currency: 'USD' }),
      makeIntent(),
    );
    expect(match.fields).toEqual(['external_id', 'account', 'amount', 'currency']);
  });
});

describe('M09 匹配校验：不匹配后不得继续跟踪', () => {
  it('金额不符时 observe 抛 OrderMismatchError，且不记录任何观测', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    expect(() => tracker.observe(makeResult({ amountMinor: AMOUNT_MINOR + 1 }))).toThrow(OrderMismatchError);
    expect(tracker.view).toBeNull();
    expect(tracker.history.length).toBe(0);
    expect(tracker.trackable).toBe(false);
    expect(tracker.blockedReason).toContain('金额不符');
  });

  it('阻断之后再次 observe 被拒（不是静默忽略）', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    expect(() => tracker.observe(makeResult({ amountMinor: 1 }))).toThrow(OrderMismatchError);
    expect(() => tracker.observe(makeResult())).toThrow(OrderTrackingBlockedError);
    expect(tracker.view).toBeNull();
  });

  it('阻断之后 resumeAfterDisconnect 也被拒', async () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    expect(() => tracker.observe(makeResult({ accountRef: 'acct-ref-other' }))).toThrow(OrderMismatchError);
    const port = { query: async () => makeResult() };
    await expect(tracker.resumeAfterDisconnect(port)).rejects.toThrow(OrderTrackingBlockedError);
  });

  it('acknowledge() 显式处置后才恢复跟踪，历史观测不被篡改', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult({ rawStatusCode: 'W_DELIVERING' }));
    expect(tracker.history.length).toBe(1);
    expect(() => tracker.observe(makeResult({ amountMinor: AMOUNT_MINOR + 1 }))).toThrow(OrderMismatchError);
    expect(tracker.history.length).toBe(1);

    tracker.acknowledge();
    expect(tracker.trackable).toBe(true);
    const view = tracker.observe(makeResult({ rawStatusCode: 'W_COMPLETED' }));
    expect(view.rawStatusCode).toBe('W_COMPLETED');
    expect(tracker.history.length).toBe(2);
  });

  it('acknowledge() 不解除匹配要求：恢复后金额仍不符会再次阻断', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult());
    expect(() => tracker.observe(makeResult({ amountMinor: AMOUNT_MINOR + 1 }))).toThrow(OrderMismatchError);
    tracker.acknowledge();
    expect(() => tracker.observe(makeResult({ amountMinor: AMOUNT_MINOR + 1 }))).toThrow(OrderMismatchError);
    expect(tracker.history.length).toBe(1);
  });

  it('匹配结果对象的 fields 与错误对象一致（可追溯到判据）', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    const result = makeResult({ currency: 'USD' });
    const match = matchOrderToIntent(result, tracker.intent);
    try {
      tracker.observe(result);
      expect.unreachable('应当抛不匹配');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderMismatchError);
      expect((error as OrderMismatchError).fields).toEqual(match.fields);
    }
  });
});

describe('M09 匹配校验：意图本身必须合法', () => {
  it('金额非整数最小单位 ⇒ 构造期即抛', () => {
    expect(() => new OrderLifecycleTracker({ intent: makeIntent({ amountMinor: 47.6 }) })).toThrow();
  });

  it('账号引用为空 ⇒ 构造期即抛', () => {
    expect(() => new OrderLifecycleTracker({ intent: makeIntent({ accountRef: '' }) })).toThrow();
  });
});
