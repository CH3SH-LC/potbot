/**
 * M09 未知订单码的一致性（回归锁）。
 *
 * 背景：`types.ts` 明文契约是「`statusRecognized === false` ⇒ 七个阶段全 `'unknown'`」。
 * 但退款阶段此前是从**另一个字段**（`refundStatusCode`）推导的，导致订单码未知时
 * 仍会输出 `退款 absent / applied` 等结论，出现「订单码本地不认识，却报告退款状态」
 * 的自相矛盾视图。本文件把修复后的口径钉死：
 *
 * - 订单码本地不认识 ⇒ 整份应答不可解释，退款阶段与退款报告**同在 unknown**；
 * - 反向对照：订单码**已知**时，同一退款码如实显示（证明上面的断言不是空壳）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildOrderLifecycleView,
  isStageConfirmed,
  stageReport,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { AMOUNT_MINOR, CODE, makeResult } from './support.js';

describe('M09 未知订单码：整份应答不可解释（含退款字段）', () => {
  it('订单码不认识 + 平台给「已到账」退款码 ⇒ 七阶段全 unknown，退款绝不算到账', () => {
    const view = buildOrderLifecycleView(
      makeResult({
        rawStatusCode: CODE.unknownOrderCode,
        refundStatusCode: CODE.refundSettled,
        refundAmountMinor: AMOUNT_MINOR,
      }),
    );
    expect(view.statusRecognized).toBe(false);
    expect(view.stages.map((entry) => entry.state)).toEqual(new Array(7).fill('unknown'));
    expect(stageReport(view, 'refund').state).toBe('unknown');
    expect(isStageConfirmed(view, 'refund')).toBe(false);
    expect(view.refund.state).toBe('unknown');
    expect(view.refund.settled).toBe(false);
    expect(view.refund.note).toContain('不得计为已到账');
  });

  it('订单码不认识且平台未给退款字段 ⇒ 也不得报成「未发起退款」', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.unknownOrderCode }));
    expect(view.refund.state).toBe('unknown');
    expect(view.refund.settled).toBe(false);
  });

  it('反向对照：订单码已知时，同一「已到账」退款码如实显示', () => {
    const view = buildOrderLifecycleView(
      makeResult({
        rawStatusCode: CODE.cancelledAfterPay,
        refundStatusCode: CODE.refundSettled,
        refundAmountMinor: AMOUNT_MINOR,
      }),
    );
    expect(view.statusRecognized).toBe(true);
    expect(stageReport(view, 'refund').state).toBe('confirmed');
    expect(view.refund.state).toBe('settled');
    expect(view.refund.settled).toBe(true);
  });
});
