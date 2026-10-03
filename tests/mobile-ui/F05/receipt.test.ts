/**
 * F05 验收：动作回执展示（含「未知」态）。
 *
 * 核心反向对照：**未知态不得被判为完成**——`done` 必须为 false、文案必须显式写「未知」，
 * 汇总里未知必须单列、不得并入已完成。
 */

import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_RECEIPT_LABEL,
  describeReceipt,
  isReceiptDone,
  isUnknownReceipt,
  rollupReceipts,
  type ExternalReceipt,
  type ExternalReceiptState,
  type VerificationMode,
} from '../../../apps/mobile-ui/src/decisions/index.js';

function receipt(
  observedState: ExternalReceiptState,
  verificationMode: VerificationMode,
  overrides: Partial<ExternalReceipt> = {},
): ExternalReceipt {
  return {
    actionId: 'act-1',
    provider: 'demo-provider',
    requestRef: 'req-1',
    externalId: 'ext-1',
    observedState,
    observedAt: '2026-10-03T10:00:00Z',
    evidenceRef: 'ev-1',
    verificationMode,
    ...overrides,
  };
}

describe('F05 / 回执展示：未知 ≠ 成功', () => {
  it('反向对照：unknown 回执 done 恒为 false 且文案显式标注未知', () => {
    const view = describeReceipt(receipt('unknown', 'real'));
    expect(view.isUnknown).toBe(true);
    expect(view.done).toBe(false);
    expect(view.label).toBe(UNKNOWN_RECEIPT_LABEL);
    expect(view.label).toContain('未知');
    expect(view.label).toContain('不得视为成功');
  });

  it('反向对照：submitted（尚未回执）不得判为完成', () => {
    const view = describeReceipt(receipt('submitted', 'real'));
    expect(view.isUnknown).toBe(false);
    expect(view.done).toBe(false);
    expect(view.label).toContain('尚无回执');
  });

  it('只有 real + confirmed 才 done', () => {
    const realConfirmed = describeReceipt(receipt('confirmed', 'real'));
    expect(realConfirmed.done).toBe(true);
    expect(realConfirmed.isUnknown).toBe(false);
    expect(realConfirmed.label).toContain('已完成');
  });

  it('反向对照：fixture + confirmed 不得作为真实完成证据', () => {
    const fixture = describeReceipt(receipt('confirmed', 'fixture'));
    expect(fixture.done).toBe(false);
    expect(fixture.label).toContain('fixture');
    expect(fixture.label).toContain('不得作为真实完成证据');
  });

  it('取消结果未知（providerSemantics=unknown）也判为未知', () => {
    const raw = receipt('cancelled', 'real', {
      cancellation: { cancelled: true, providerSemantics: 'unknown' },
    });
    expect(isUnknownReceipt(raw)).toBe(true);
    const view = describeReceipt(raw);
    expect(view.isUnknown).toBe(true);
    expect(view.done).toBe(false);
    expect(view.label).toBe(UNKNOWN_RECEIPT_LABEL);
  });

  it('取消被供应方确认 ⇒ 非未知、非完成', () => {
    const view = describeReceipt(
      receipt('cancelled', 'real', {
        cancellation: { cancelled: true, providerSemantics: 'provider-confirmed' },
      }),
    );
    expect(view.isUnknown).toBe(false);
    expect(view.done).toBe(false);
    expect(view.label).toBe('已取消');
  });

  it('isReceiptDone 与 describeReceipt(...).done 判定一致（不变量：done ⇔ real+confirmed）', () => {
    const states: readonly ExternalReceiptState[] = [
      'prepared',
      'authorized',
      'submitting',
      'submitted',
      'unknown',
      'confirmed',
      'failed',
      'cancelled',
    ];
    for (const state of states) {
      for (const mode of ['fixture', 'real'] as const) {
        const raw = receipt(state, mode);
        const expected = state === 'confirmed' && mode === 'real';
        expect(isReceiptDone(raw)).toBe(expected);
        expect(describeReceipt(raw).done).toBe(expected);
      }
    }
  });
});

describe('F05 / 回执汇总', () => {
  it('未知单列，绝不计入已完成；存在未知时整体未完成', () => {
    const rollup = rollupReceipts([
      receipt('confirmed', 'real'),
      receipt('unknown', 'real'),
      receipt('failed', 'real'),
    ]);
    expect(rollup.total).toBe(3);
    expect(rollup.done).toBe(1);
    expect(rollup.unknown).toBe(1);
    expect(rollup.failed).toBe(1);
    expect(rollup.allDone).toBe(false);
    expect(rollup.anyUnknown).toBe(true);
    expect(rollup.byState.unknown).toBe(1);
    expect(rollup.byState.confirmed).toBe(1);
    expect(rollup.summary).toContain('未知 1');
    expect(rollup.summary).toContain('整体未完成');
  });

  it('反向对照：全是 unknown 时 allDone 必须为 false', () => {
    const rollup = rollupReceipts([receipt('unknown', 'real'), receipt('unknown', 'real')]);
    expect(rollup.done).toBe(0);
    expect(rollup.unknown).toBe(2);
    expect(rollup.allDone).toBe(false);
  });

  it('只有全部 real+confirmed 时 allDone 为真', () => {
    const rollup = rollupReceipts([receipt('confirmed', 'real'), receipt('confirmed', 'real')]);
    expect(rollup.done).toBe(2);
    expect(rollup.allDone).toBe(true);
    expect(rollup.anyUnknown).toBe(false);
  });

  it('反向对照：fixture+confirmed 不能让 allDone 变真', () => {
    const rollup = rollupReceipts([receipt('confirmed', 'fixture')]);
    expect(rollup.done).toBe(0);
    expect(rollup.allDone).toBe(false);
  });

  it('空集：allDone 为 false（不真空为真）', () => {
    const rollup = rollupReceipts([]);
    expect(rollup.total).toBe(0);
    expect(rollup.allDone).toBe(false);
    expect(rollup.summary).toContain('共 0 条回执');
  });

  it('进行中状态归入 inFlight', () => {
    const rollup = rollupReceipts([
      receipt('prepared', 'real'),
      receipt('authorized', 'real'),
      receipt('submitting', 'real'),
      receipt('submitted', 'real'),
    ]);
    expect(rollup.inFlight).toBe(4);
    expect(rollup.done).toBe(0);
    expect(rollup.unknown).toBe(0);
  });
});
