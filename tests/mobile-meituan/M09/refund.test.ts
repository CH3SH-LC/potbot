/**
 * M09 退款：「已申请」与「已到账」必须分开。
 *
 * 反向对照（本文件的要害）：
 * - 已申请的报告**不得**与已到账的报告等价（值、说明、settled 三个维度同时断言）；
 * - `not_requested → settled` 的流转必须判非法。
 * 任何把 `applied` 渲染成 `settled` 的改动都会让本文件变红。
 */

import { describe, expect, it } from 'vitest';

import {
  IllegalTransitionError,
  OrderResultIntegrityError,
  assertRefundTransition,
  buildOrderLifecycleView,
  checkRefundTransition,
  isStageConfirmed,
  stageReport,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { AMOUNT_MINOR, CODE, makeResult } from './support.js';

/** 已申请退款的观察结果（退款金额已给出，但尚未到账）。 */
function appliedResult(refundAmountMinor = AMOUNT_MINOR) {
  return makeResult({
    rawStatusCode: CODE.cancelledAfterPay,
    refundStatusCode: CODE.refundApplied,
    refundAmountMinor,
  });
}

/** 已到账退款的观察结果。 */
function settledResult(refundAmountMinor = AMOUNT_MINOR) {
  return makeResult({
    rawStatusCode: CODE.cancelledAfterPay,
    refundStatusCode: CODE.refundSettled,
    refundAmountMinor,
  });
}

describe('M09 退款：申请与到账分开报告', () => {
  it('R_APPLIED ⇒ applied / settled=false / 说明是「已申请，尚未到账」', () => {
    const view = buildOrderLifecycleView(appliedResult());
    expect(view.refund.state).toBe('applied');
    expect(view.refund.settled).toBe(false);
    expect(view.refund.note).toContain('已申请');
    expect(view.refund.note).not.toContain('已到账');
  });

  it('R_APPLIED 的阶段报告是 pending，不是 confirmed', () => {
    const view = buildOrderLifecycleView(appliedResult());
    expect(stageReport(view, 'refund').state).toBe('pending');
    expect(isStageConfirmed(view, 'refund')).toBe(false);
    expect(stageReport(view, 'refund').note).toContain('尚未到账');
  });

  it('R_SETTLED ⇒ settled / settled=true / 说明是「已到账」', () => {
    const view = buildOrderLifecycleView(settledResult());
    expect(view.refund.state).toBe('settled');
    expect(view.refund.settled).toBe(true);
    expect(view.refund.note).toContain('已到账');
    expect(stageReport(view, 'refund').state).toBe('confirmed');
  });

  it('反向对照：已申请与已到账三处都不同（值 / 说明 / settled）', () => {
    const applied = buildOrderLifecycleView(appliedResult());
    const settled = buildOrderLifecycleView(settledResult());
    expect(applied.refund.state).not.toBe(settled.refund.state);
    expect(applied.refund.note).not.toBe(settled.refund.note);
    expect(applied.refund.settled).not.toBe(settled.refund.settled);
    expect(stageReport(applied, 'refund').state).not.toBe(stageReport(settled, 'refund').state);
  });

  it('未发起退款 ⇒ not_requested，金额为 null，settled=false', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.cancelledBeforePay }));
    expect(view.refund.state).toBe('not_requested');
    expect(view.refund.amountMinor).toBeNull();
    expect(view.refund.settled).toBe(false);
    expect(view.refund.note).toContain('未发起退款');
  });

  it('R_NONE 与「平台未给退款字段」口径一致', () => {
    const none = buildOrderLifecycleView(makeResult({ refundStatusCode: CODE.refundNone }));
    const missing = buildOrderLifecycleView(makeResult({ refundStatusCode: null }));
    expect(none.refund.state).toBe('not_requested');
    expect(missing.refund.state).toBe('not_requested');
    expect(none.refund.amountMinor).toBeNull();
  });

  it('R_REJECTED ⇒ rejected / settled=false', () => {
    const view = buildOrderLifecycleView(
      makeResult({ rawStatusCode: CODE.cancelledBeforePay, refundStatusCode: CODE.refundRejected, refundAmountMinor: 0 }),
    );
    expect(view.refund.state).toBe('rejected');
    expect(view.refund.settled).toBe(false);
    expect(stageReport(view, 'refund').state).toBe('failed');
  });

  it('未知退款码 ⇒ unknown，绝不算已到账', () => {
    const view = buildOrderLifecycleView(
      makeResult({ refundStatusCode: CODE.unknownRefundCode, refundAmountMinor: AMOUNT_MINOR }),
    );
    expect(view.refund.state).toBe('unknown');
    expect(view.refund.settled).toBe(false);
    expect(view.refund.note).toContain('不得计为已到账');
  });

  it('声称已到账却没给金额 ⇒ 结果不合法（不替平台补金额）', () => {
    let caught: unknown;
    try {
      buildOrderLifecycleView(makeResult({ refundStatusCode: CODE.refundSettled, refundAmountMinor: null }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrderResultIntegrityError);
    expect((caught as OrderResultIntegrityError).violations.join('；')).toContain('到账必须有金额');
  });
});

describe('M09 退款流转：跳级非法', () => {
  it('not_requested → settled 非法（没有已申请就没有已到账）', () => {
    const check = checkRefundTransition('not_requested', 'settled');
    expect(check.legal).toBe(false);
    expect(check.detail).toContain('不得把已申请显示成已到账');
    expect(() => assertRefundTransition('not_requested', 'settled')).toThrow(IllegalTransitionError);
  });

  it('applied → settled 合法；applied → rejected 合法', () => {
    expect(checkRefundTransition('applied', 'settled').legal).toBe(true);
    expect(checkRefundTransition('applied', 'rejected').legal).toBe(true);
  });

  it('applied → not_requested 非法（状态不得倒退）', () => {
    expect(checkRefundTransition('applied', 'not_requested').legal).toBe(false);
  });

  it('settled 是终态，不得再变', () => {
    expect(checkRefundTransition('settled', 'applied').legal).toBe(false);
    expect(checkRefundTransition('settled', 'not_requested').legal).toBe(false);
  });

  it('unknown 不得被推定为任何确定状态', () => {
    expect(checkRefundTransition('unknown', 'settled').legal).toBe(false);
    expect(checkRefundTransition('unknown', 'applied').legal).toBe(false);
  });

  it('同状态重复报告是幂等 no_op', () => {
    expect(checkRefundTransition('applied', 'applied')).toMatchObject({ legal: true, kind: 'no_op' });
  });
});
