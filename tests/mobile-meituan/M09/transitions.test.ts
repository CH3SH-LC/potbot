/**
 * M09 流转合法性：阶段不得回退 / 跳级 / 终态反复。
 *
 * 反向对照：`delivering → paid` 这样的回退必须判非法；
 * 若把 `checkStageTransition` 改成恒 `legal: true`，本文件立刻变红。
 */

import { describe, expect, it } from 'vitest';

import {
  IllegalTransitionError,
  OrderLifecycleTracker,
  assertProgression,
  assertStageTransition,
  buildOrderLifecycleView,
  checkProgression,
  checkStageTransition,
  highestConfirmedRank,
  terminalStageOf,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import type { OrderStage } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { CODE, makeIntent, makeResult } from './support.js';

describe('M09 阶段流转：线性推进', () => {
  const adjacent: readonly (readonly [OrderStage, OrderStage])[] = [
    ['placed', 'paid'],
    ['paid', 'merchant_accepted'],
    ['merchant_accepted', 'delivering'],
    ['delivering', 'completed'],
  ];

  for (const [from, to] of adjacent) {
    it(`${from} → ${to} 合法`, () => {
      expect(checkStageTransition(from, to)).toMatchObject({ legal: true, kind: 'forward' });
    });
  }

  it('同阶段重报是幂等 no_op', () => {
    expect(checkStageTransition('delivering', 'delivering')).toMatchObject({ legal: true, kind: 'no_op' });
  });

  it('从任一非终态都可取消（取消是分支，不算回退）', () => {
    for (const from of ['placed', 'paid', 'merchant_accepted', 'delivering'] as const) {
      expect(checkStageTransition(from, 'cancelled')).toMatchObject({ legal: true, kind: 'forward' });
    }
  });
});

describe('M09 阶段流转：非法流转各自可咬', () => {
  it('回退非法（delivering → paid）', () => {
    const check = checkStageTransition('delivering', 'paid');
    expect(check.legal).toBe(false);
    expect(check.kind).toBe('backward');
    expect(check.detail).toContain('回退');
  });

  it('跳级非法（placed → delivering）', () => {
    const check = checkStageTransition('placed', 'delivering');
    expect(check.legal).toBe(false);
    expect(check.kind).toBe('skip');
  });

  it('终态之后不得再变（completed → delivering，cancelled → placed）', () => {
    expect(checkStageTransition('completed', 'delivering')).toMatchObject({ legal: false, kind: 'terminal' });
    expect(checkStageTransition('cancelled', 'placed')).toMatchObject({ legal: false, kind: 'terminal' });
  });

  it('refund 不是线性阶段（必须走退款流转检查）', () => {
    expect(checkStageTransition('placed', 'refund')).toMatchObject({ legal: false, kind: 'refund_separate' });
  });

  it('assertStageTransition 非法即抛，且带上两端与原因', () => {
    try {
      assertStageTransition('completed', 'delivering');
      expect.unreachable('应当抛非法流转');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).kind).toBe('terminal');
      expect((error as IllegalTransitionError).from).toBe('completed');
      expect((error as IllegalTransitionError).to).toBe('delivering');
    }
  });
});

describe('M09 阶段流转：观测之间的推进', () => {
  const delivering = () => buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.delivering }));
  const paid = () => buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.paidWaitAccept }));
  const completed = () => buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.completed }));
  const cancelled = () => buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.cancelledAfterPay }));

  it('名次与终态判定符合语义', () => {
    expect(highestConfirmedRank(delivering())).toBe(4);
    expect(highestConfirmedRank(paid())).toBe(2);
    expect(terminalStageOf(completed())).toBe('completed');
    expect(terminalStageOf(cancelled())).toBe('cancelled');
    expect(terminalStageOf(delivering())).toBeNull();
  });

  it('前进合法，重复观测是 no_op', () => {
    expect(checkProgression(delivering(), completed()).legal).toBe(true);
    expect(checkProgression(delivering(), delivering()).kind).toBe('no_op');
  });

  it('回退非法（delivering → paid）', () => {
    const check = checkProgression(delivering(), paid());
    expect(check.legal).toBe(false);
    expect(check.kind).toBe('backward');
    expect(() => assertProgression(delivering(), paid())).toThrow(IllegalTransitionError);
  });

  it('终态反复非法（completed → cancelled）', () => {
    expect(checkProgression(completed(), cancelled())).toMatchObject({ legal: false, kind: 'terminal' });
  });

  it('不同订单之间的推进非法', () => {
    const other = buildOrderLifecycleView(makeResult({ externalId: 'MT-OTHER-9999' }));
    expect(checkProgression(delivering(), other)).toMatchObject({ legal: false, kind: 'different_order' });
  });

  it('跟踪器遇到回退即抛错并阻断，已记录的观测不被覆盖', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent() });
    tracker.observe(makeResult({ rawStatusCode: CODE.delivering }));
    expect(() => tracker.observe(makeResult({ rawStatusCode: CODE.paidWaitAccept }))).toThrow(IllegalTransitionError);
    expect(tracker.trackable).toBe(false);
    expect(tracker.history.length).toBe(1);
    expect(tracker.view?.rawStatusCode).toBe(CODE.delivering);
  });
});
