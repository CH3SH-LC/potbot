/**
 * M09 阶段报告：**必须分别报告，不得合并成一个 ok**。
 *
 * 断言的是「哪几个阶段被明确确认」这一真实语义，而不是照抄映射表：
 * 用例先声明某状态码下**应当**发生的阶段集合，再要求视图的
 * `confirmedStages` 与之**完全相等**（多一个少一个都红）。
 */

import { describe, expect, it } from 'vitest';

import {
  ORDER_STAGES,
  buildOrderLifecycleView,
  confirmedStages,
  describeStages,
  isStageConfirmed,
  stageReport,
  type OrderStage,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { CODE, makeResult } from './support.js';

/** 该状态码下「到这一刻为止真实发生」的线性阶段（退款另算）。 */
const EXPECTED_CONFIRMED: Readonly<Record<string, readonly OrderStage[]>> = Object.freeze({
  [CODE.created]: ['placed'],
  [CODE.paidWaitAccept]: ['placed', 'paid'],
  [CODE.merchantAccepted]: ['placed', 'paid', 'merchant_accepted'],
  [CODE.delivering]: ['placed', 'paid', 'merchant_accepted', 'delivering'],
  [CODE.completed]: ['placed', 'paid', 'merchant_accepted', 'delivering', 'completed'],
  [CODE.cancelledBeforePay]: ['placed', 'cancelled'],
  [CODE.cancelledAfterPay]: ['placed', 'paid', 'cancelled'],
});

describe('M09 阶段报告：七阶段各自成型', () => {
  it('视图恒有 7 条阶段报告，顺序与 ORDER_STAGES 一致', () => {
    const view = buildOrderLifecycleView(makeResult());
    expect(ORDER_STAGES.length).toBe(7);
    expect(view.stages.map((entry) => entry.stage)).toEqual([...ORDER_STAGES]);
  });

  for (const [code, expected] of Object.entries(EXPECTED_CONFIRMED)) {
    it(`${code} 只确认 ${expected.join('、')}`, () => {
      const view = buildOrderLifecycleView(makeResult({ rawStatusCode: code }));
      expect(confirmedStages(view)).toEqual([...expected]);
    });
  }

  it('支付链路上「商家接单」不会因为「已支付」被顺手带成已确认', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.paidWaitAccept }));
    expect(isStageConfirmed(view, 'paid')).toBe(true);
    expect(isStageConfirmed(view, 'merchant_accepted')).toBe(false);
    expect(stageReport(view, 'merchant_accepted').state).toBe('absent');
    expect(stageReport(view, 'merchant_accepted').note).toContain('未发生');
  });

  it('支付失败是 failed，不是「未支付」也不是成功', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.payFailed }));
    expect(stageReport(view, 'paid').state).toBe('failed');
    expect(stageReport(view, 'paid').note).toContain('失败');
    expect(confirmedStages(view)).toEqual(['placed']);
  });

  it('「完成」只有确认的四阶段都在时才会出现', () => {
    const delivering = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.delivering }));
    expect(isStageConfirmed(delivering, 'completed')).toBe(false);
    const completed = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.completed }));
    expect(isStageConfirmed(completed, 'completed')).toBe(true);
    expect(isStageConfirmed(completed, 'cancelled')).toBe(false);
  });

  it('取消单不会因为「已支付」而被报成完成', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.cancelledAfterPay }));
    expect(isStageConfirmed(view, 'cancelled')).toBe(true);
    expect(isStageConfirmed(view, 'completed')).toBe(false);
    expect(isStageConfirmed(view, 'delivering')).toBe(false);
  });

  it('描述是逐阶段的行，不是一个合并结论', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.merchantAccepted }));
    const lines = describeStages(view);
    expect(lines.length).toBe(7);
    expect(new Set(lines).size).toBe(7);
    expect(lines.filter((line) => line.includes('(confirmed)')).length).toBe(3);
  });
});

describe('M09 阶段报告：视图上没有合并的成功字段', () => {
  it('视图不含 ok / success / status 之类的合并字段', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.completed }));
    const keys = Object.keys(view);
    expect(keys).not.toContain('ok');
    expect(keys).not.toContain('success');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('overall');
  });

  it('视图上唯一的布尔量是「状态码是否被识别」', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.completed }));
    const booleans = Object.entries(view)
      .filter(([, value]) => typeof value === 'boolean')
      .map(([key]) => key);
    expect(booleans).toEqual(['statusRecognized']);
  });

  it('退款报告不与订单阶段合并：它是独立对象，且自带 settled 语义', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.completed }));
    expect(typeof view.refund).toBe('object');
    expect(view.refund.state).toBe('not_requested');
    expect(view.refund.settled).toBe(false);
  });
});
