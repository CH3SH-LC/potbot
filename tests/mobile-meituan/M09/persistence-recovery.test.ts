/**
 * M09 落盘 / 恢复：重启后带回「本地真相」，且**先查询原单、不重下**。
 *
 * 反向对照（本文件的要害）：
 * - 快照存的是**事实**（原始观测），不是结论；被篡改的金额 / externalId 在恢复时
 *   必须**抛错**，而不是被静默当成一份「看起来正常」的状态（否则落盘就成了伪造订单的通道）；
 * - 重启**不能**解除阻断：阻断状态随快照一起回来（否则「杀进程躲过阻断」就成立了）；
 * - 恢复**不发请求**，恢复后要继续跟踪只能 `resumeAfterDisconnect`（先查原单）。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderLifecycleTracker,
  OrderMismatchError,
  OrderSnapshotError,
  OrderTrackingBlockedError,
  OrderValidationError,
  confirmedStages,
  createFixtureOrderQueryPort,
  parseOrderLifecycleSnapshot,
  restoreOrderLifecycleTracker,
  serializeOrderLifecycleSnapshot,
  snapshotOrderLifecycleTracker,
  stageReport,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { ACCOUNT_REF, AMOUNT_MINOR, CODE, EXTERNAL_ID, T0, makeIntent, makeResult } from './support.js';

/** 一个已推进到「配送中 → 已完成」的跟踪器。 */
function trackerDeliveringThenCompleted(): OrderLifecycleTracker {
  const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
  tracker.observe(makeResult({ rawStatusCode: CODE.delivering, observedAt: T0 }));
  tracker.observe(makeResult({ rawStatusCode: CODE.completed, observedAt: T0 + 1000 }));
  return tracker;
}

/** 经 JSON 文本往返的辅助。 */
function roundTrip(tracker: OrderLifecycleTracker): OrderLifecycleTracker {
  const snapshot = snapshotOrderLifecycleTracker(tracker);
  return restoreOrderLifecycleTracker(parseOrderLifecycleSnapshot(serializeOrderLifecycleSnapshot(snapshot)));
}

describe('M09 落盘/恢复：往返保真', () => {
  it('意图、观测序列与七阶段报告逐项一致', () => {
    const tracker = trackerDeliveringThenCompleted();
    const restored = roundTrip(tracker);

    expect(restored.intent).toEqual(tracker.intent);
    expect(restored.history.length).toBe(2);
    expect(restored.view?.rawStatusCode).toBe(CODE.completed);
    expect(restored.view?.stages.map((entry) => `${entry.stage}:${entry.state}`)).toEqual(
      tracker.view?.stages.map((entry) => `${entry.stage}:${entry.state}`),
    );
    expect(stageReport(restored.view!, 'completed').state).toBe('confirmed');
    expect(confirmedStages(restored.view!)).toEqual([
      'placed',
      'paid',
      'merchant_accepted',
      'delivering',
      'completed',
    ]);
  });

  it('恢复后再快照：与首次快照逐字节一致（派生字段无漂移）', () => {
    const tracker = trackerDeliveringThenCompleted();
    const first = snapshotOrderLifecycleTracker(tracker);
    const second = snapshotOrderLifecycleTracker(roundTrip(tracker));
    expect(serializeOrderLifecycleSnapshot(second)).toBe(serializeOrderLifecycleSnapshot(first));
  });

  it('退款「已申请」经落盘/恢复仍是 applied，绝不变 settled', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(
      makeResult({
        rawStatusCode: CODE.cancelledAfterPay,
        refundStatusCode: CODE.refundApplied,
        refundAmountMinor: AMOUNT_MINOR,
      }),
    );
    const restored = roundTrip(tracker);
    expect(restored.view?.refund.state).toBe('applied');
    expect(restored.view?.refund.settled).toBe(false);
    expect(stageReport(restored.view!, 'refund').state).toBe('pending');
  });

  it('快照是冻结的可序列化副本（不与跟踪器共享可变数组）', () => {
    const snapshot = snapshotOrderLifecycleTracker(trackerDeliveringThenCompleted());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.observations)).toBe(true);
    expect(snapshot.observations.length).toBe(2);
    expect(snapshot.version).toBe(1);
  });
});

describe('M09 落盘/恢复：重启后先查询原单（不重下）', () => {
  it('恢复后断线：只发一次查询，查的是原 externalId，原因标为断线恢复', async () => {
    const restored = roundTrip(trackerDeliveringThenCompleted());
    const port = createFixtureOrderQueryPort({
      results: [makeResult({ rawStatusCode: CODE.completed, observedAt: T0 + 2000 })],
    });
    const view = await restored.resumeAfterDisconnect(port);

    expect(port.calls.length).toBe(1);
    expect(port.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(port.calls[0]?.accountRef).toBe(ACCOUNT_REF);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(view.rawStatusCode).toBe(CODE.completed);
  });

  it('意图没有 externalId：恢复后断线查询被拒，且一次查询都不发', async () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent({ externalId: null }) });
    const restored = roundTrip(tracker);
    expect(restored.history.length).toBe(0);
    expect(restored.view).toBeNull();

    const port = createFixtureOrderQueryPort({ results: [makeResult()] });
    await expect(restored.resumeAfterDisconnect(port)).rejects.toThrow(OrderValidationError);
    expect(port.calls.length).toBe(0);
  });
});

describe('M09 落盘/恢复：阻断状态跨重启存活', () => {
  it('重启前的阻断随快照回来：仍不可跟踪，仍不发查询', async () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult({ rawStatusCode: CODE.delivering }));
    expect(() => tracker.observe(makeResult({ amountMinor: AMOUNT_MINOR + 1 }))).toThrow(OrderMismatchError);
    expect(tracker.trackable).toBe(false);

    const restored = roundTrip(tracker);
    expect(restored.trackable).toBe(false);
    expect(restored.blockedReason).toContain('金额不符');
    // 阻断前的观测保留，阻断本身不被「杀进程」洗掉。
    expect(restored.history.length).toBe(1);

    const port = createFixtureOrderQueryPort({ results: [makeResult()] });
    await expect(restored.resumeAfterDisconnect(port)).rejects.toThrow(OrderTrackingBlockedError);
    expect(port.calls.length).toBe(0);
  });
});

describe('M09 落盘/恢复：被篡改的快照不被信任', () => {
  interface MutableObservation {
    amountMinor: number;
    externalId: string;
    rawStatusCode: string;
  }
  interface MutableSnapshot {
    version: number;
    observations: MutableObservation[];
  }

  function tamperedText(mutate: (snapshot: MutableSnapshot) => void): string {
    const text = serializeOrderLifecycleSnapshot(snapshotOrderLifecycleTracker(trackerDeliveringThenCompleted()));
    const parsed = JSON.parse(text) as MutableSnapshot;
    mutate(parsed);
    return JSON.stringify(parsed);
  }

  it('篡改观测金额（+1 分）⇒ 恢复即抛不匹配，不产出跟踪器', () => {
    const text = tamperedText((snapshot) => {
      const first = snapshot.observations[0]!;
      first.amountMinor = first.amountMinor + 1;
    });
    expect(() => restoreOrderLifecycleTracker(parseOrderLifecycleSnapshot(text))).toThrow(OrderMismatchError);
  });

  it('篡改观测 externalId（换成别的单）⇒ 恢复即抛不匹配', () => {
    const text = tamperedText((snapshot) => {
      snapshot.observations[0]!.externalId = 'MT-OTHER-9999';
    });
    try {
      restoreOrderLifecycleTracker(parseOrderLifecycleSnapshot(text));
      expect.unreachable('应当抛不匹配');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderMismatchError);
      expect((error as OrderMismatchError).fields).toContain('external_id');
    }
  });

  it('快照只存事实：改不了派生结论（未知订单码恢复后仍全 unknown）', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult({ rawStatusCode: CODE.delivering }));
    const text = serializeOrderLifecycleSnapshot(snapshotOrderLifecycleTracker(tracker));
    const parsed = JSON.parse(text) as MutableSnapshot;
    parsed.observations[0]!.rawStatusCode = CODE.unknownOrderCode;

    const restored = restoreOrderLifecycleTracker(parseOrderLifecycleSnapshot(JSON.stringify(parsed)));
    expect(restored.view?.statusRecognized).toBe(false);
    expect(confirmedStages(restored.view!)).toEqual([]);
    expect(stageReport(restored.view!, 'completed').state).toBe('unknown');
  });

  it('未知订单码 + 平台给了「已到账」退款码：恢复后整份视图仍全 unknown，退款不算到账', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    // 平台订单码本地不认识：整份应答不可解释，退款字段也不得单独当真。
    const view = tracker.observe(
      makeResult({
        rawStatusCode: CODE.unknownOrderCode,
        refundStatusCode: CODE.refundSettled,
        refundAmountMinor: AMOUNT_MINOR,
      }),
    );
    expect(view.statusRecognized).toBe(false);

    const restored = roundTrip(tracker);
    expect(restored.view?.statusRecognized).toBe(false);
    expect(restored.view?.refund.state).toBe('unknown');
    expect(restored.view?.refund.settled).toBe(false);
    expect(confirmedStages(restored.view!)).toEqual([]);
  });
});

describe('M09 落盘/恢复：坏快照与版本', () => {
  it('版本不符 ⇒ OrderSnapshotError（不跨版本静默迁移）', () => {
    const base = snapshotOrderLifecycleTracker(new OrderLifecycleTracker({ intent: makeIntent() }));
    const bumped = JSON.parse(serializeOrderLifecycleSnapshot(base)) as { version: number };
    bumped.version = 999;
    expect(() => parseOrderLifecycleSnapshot(JSON.stringify(bumped))).toThrow(OrderSnapshotError);
    expect(() => restoreOrderLifecycleTracker(bumped)).toThrow(OrderSnapshotError);
  });

  it('非 JSON / 非对象 / 缺字段 ⇒ OrderSnapshotError', () => {
    expect(() => parseOrderLifecycleSnapshot('{')).toThrow(OrderSnapshotError);
    expect(() => parseOrderLifecycleSnapshot('[]')).toThrow(OrderSnapshotError);
    expect(() => parseOrderLifecycleSnapshot('{"version":1}')).toThrow(OrderSnapshotError);
    expect(() => parseOrderLifecycleSnapshot('{"version":1,"intent":{},"observations":[],"blockedReason":7}')).toThrow(
      OrderSnapshotError,
    );
  });

  it('空历史恢复：视图为空、可跟踪，且不含任何被确认的阶段', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    const restored = roundTrip(tracker);
    expect(restored.view).toBeNull();
    expect(restored.history.length).toBe(0);
    expect(restored.trackable).toBe(true);
  });
});
