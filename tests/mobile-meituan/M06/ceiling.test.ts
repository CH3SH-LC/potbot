/**
 * M06 金额上限：**没有上限就不放行**；等于上限放行、超过即拒；币种必须一致。
 */

import { describe, expect, it } from 'vitest';

import {
  PurchaseConfirmationError,
  assertWithinCeiling,
  isWithinCeiling,
  validateCeiling,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PurchaseConfirmationError);
    return (error as PurchaseConfirmationError).code;
  }
  throw new Error('期望被拒，但调用成功了（判据是空壳）');
}

const CEILING = { ceilingMinor: 10_000, currency: 'CNY', setBy: 'user' } as const;

describe('M06 金额上限', () => {
  it('恰好等于上限时放行（<= 即通过）', () => {
    expect(() => assertWithinCeiling(10_000, 'CNY', CEILING)).not.toThrow();
    expect(isWithinCeiling(10_000, 'CNY', CEILING)).toBe(true);
  });

  it('超过上限 ⇒ amount_exceeds_ceiling', () => {
    expect(codeOf(() => assertWithinCeiling(10_001, 'CNY', CEILING))).toBe('amount_exceeds_ceiling');
    expect(isWithinCeiling(10_001, 'CNY', CEILING)).toBe(false);
  });

  it('未配置上限（null / undefined）⇒ ceiling_not_configured（不默认无限额）', () => {
    expect(codeOf(() => validateCeiling(null))).toBe('ceiling_not_configured');
    expect(codeOf(() => validateCeiling(undefined))).toBe('ceiling_not_configured');
    expect(codeOf(() => assertWithinCeiling(1, 'CNY', null as never))).toBe('ceiling_not_configured');
  });

  it('上限金额非法（浮点 / 负数）⇒ ceiling_not_configured', () => {
    expect(codeOf(() => validateCeiling({ ceilingMinor: 12.5, currency: 'CNY', setBy: 'user' }))).toBe(
      'ceiling_not_configured',
    );
    expect(codeOf(() => validateCeiling({ ceilingMinor: -1, currency: 'CNY', setBy: 'user' }))).toBe(
      'ceiling_not_configured',
    );
  });

  it('上限未标明由谁设定 ⇒ ceiling_not_configured（要可审计）', () => {
    expect(codeOf(() => validateCeiling({ ceilingMinor: 100, currency: 'CNY', setBy: '  ' }))).toBe(
      'ceiling_not_configured',
    );
  });

  it('币种不符 ⇒ ceiling_currency_mismatch（不得跨币种套用上限）', () => {
    expect(codeOf(() => assertWithinCeiling(1, 'USD', CEILING))).toBe('ceiling_currency_mismatch');
  });

  it('订单金额不是整数最小单位 ⇒ invalid_view_model_input', () => {
    expect(codeOf(() => assertWithinCeiling(10.5, 'CNY', CEILING))).toBe('invalid_view_model_input');
  });
});
