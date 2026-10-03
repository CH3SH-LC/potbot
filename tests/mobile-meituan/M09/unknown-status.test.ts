/**
 * M09 未知状态：平台状态码本地不认识时**不得计为成功**。
 *
 * 这条判据的可咬性依赖两件事同时成立：
 * 1. 未知码确实**不在**映射表里（直接对表断言，防止实现偷偷加通配）；
 * 2. 同一套断言用在**已知完成码**上会得到相反结论（证明断言不是空壳）。
 */

import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUS_TABLE,
  OrderLifecycleTracker,
  UnknownOrderStatusError,
  buildOrderLifecycleView,
  confirmedStages,
  describeStages,
  isStageConfirmed,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { CODE, makeIntent, makeResult } from './support.js';

const UNKNOWN = CODE.unknownOrderCode;

describe('M09 未知状态：结构上无法冒充成功', () => {
  it('未知码不在映射表里（判据本身可核验）', () => {
    expect(Object.prototype.hasOwnProperty.call(ORDER_STATUS_TABLE, UNKNOWN)).toBe(false);
    expect(ORDER_STATUS_TABLE[UNKNOWN]).toBeUndefined();
  });

  it('未知码 ⇒ statusRecognized=false，七阶段全 unknown', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: UNKNOWN }));
    expect(view.statusRecognized).toBe(false);
    expect(view.stages.length).toBe(7);
    expect(view.stages.map((entry) => entry.state)).toEqual(new Array(7).fill('unknown'));
  });

  it('未知码 ⇒ 没有任何阶段被确认，完成不算完成', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: UNKNOWN }));
    expect(confirmedStages(view)).toEqual([]);
    expect(isStageConfirmed(view, 'completed')).toBe(false);
    expect(isStageConfirmed(view, 'paid')).toBe(false);
    expect(isStageConfirmed(view, 'placed')).toBe(false);
  });

  it('未知码的说明里带原文码，且明确写「不得计为成功」', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: UNKNOWN }));
    const lines = describeStages(view);
    expect(lines.every((line) => line.includes('不得计为成功') || line.includes('不得计为已到账'))).toBe(true);
    expect(lines.join('\n')).toContain(UNKNOWN);
  });

  it('未知码与「明确取消」不会互相混淆', () => {
    const unknown = buildOrderLifecycleView(makeResult({ rawStatusCode: UNKNOWN }));
    const cancelled = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.cancelledBeforePay }));
    expect(isStageConfirmed(unknown, 'cancelled')).toBe(false);
    expect(isStageConfirmed(cancelled, 'cancelled')).toBe(true);
  });

  it('requireRecognizedView() 对未知状态直接抛错（不返回一个「大概没问题」的视图）', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult({ rawStatusCode: UNKNOWN }));
    expect(() => tracker.requireRecognizedView()).toThrow(UnknownOrderStatusError);
    try {
      tracker.requireRecognizedView();
    } catch (error) {
      expect((error as UnknownOrderStatusError).code).toBe(UNKNOWN);
    }
  });

  it('对照：已知完成码下同样的断言方向相反（证明上面的断言不是空壳）', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.completed }));
    expect(view.statusRecognized).toBe(true);
    expect(isStageConfirmed(view, 'completed')).toBe(true);
    expect(confirmedStages(view)).toContain('completed');

    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult({ rawStatusCode: CODE.completed }));
    expect(() => tracker.requireRecognizedView()).not.toThrow();
    expect(tracker.requireRecognizedView().statusRecognized).toBe(true);
  });

  it('未知状态仍可被如实记录（观测不丢），只是不得当作成功', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    const view = tracker.observe(makeResult({ rawStatusCode: UNKNOWN }));
    expect(tracker.history.length).toBe(1);
    expect(view.rawStatusCode).toBe(UNKNOWN);
    expect(view.evidenceRef).toBe('ev-ref-query-1');
  });
});
