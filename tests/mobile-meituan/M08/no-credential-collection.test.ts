/**
 * M08 边界一：**不代填银行卡 / 验证码 / PIN**。
 *
 * 反向对照（本文件的要害）：任一含支付凭据字段的载荷都必须抛
 * `forbidden_payment_credential_input`，且**不得**「删掉字段继续」。
 * 任何把 `assertNoCredentialFields` 改成静默过滤的改动都会让本文件变红。
 *
 * 全部占位值都是明显伪造的字符串（`0000…` 之类），**不是**任何真实凭据。
 */

import { describe, expect, it } from 'vitest';

import {
  PaymentError,
  assertNoCredentialFields,
  containsCredentialField,
  findCredentialField,
  isCredentialKey,
} from '../../../src/mobile-plugins/meituan/payment/index.js';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PaymentError ? error.code : 'not-a-payment-error';
  }
}

describe('M08 不代填支付凭据：命中即拒', () => {
  it('卡号 / CVV / 验证码 / PIN 字段一律拒绝', () => {
    const payloads: Record<string, string>[] = [
      { cardNumber: '0000-0000-0000-0000' },
      { cardNo: '0000000000000000' },
      { cvv: '000' },
      { cvc: '000' },
      { otp: '000000' },
      { pin: '0000' },
      { payPassword: 'placeholder' },
      { smsCode: '000000' },
    ];
    for (const payload of payloads) {
      expect(codeOf(() => assertNoCredentialFields(payload))).toBe('forbidden_payment_credential_input');
    }
  });

  it('嵌套对象与数组里的凭据字段同样拒绝', () => {
    expect(codeOf(() => assertNoCredentialFields({ payment: { instrument: { cvv: '000' } } }))).toBe(
      'forbidden_payment_credential_input',
    );
    expect(codeOf(() => assertNoCredentialFields({ items: [{ ok: 1 }, { otp: '000000' }] }))).toBe(
      'forbidden_payment_credential_input',
    );
  });

  it('干净载荷通过（金额 / 币种 / 引用是允许字段）', () => {
    expect(() =>
      assertNoCredentialFields({ paymentIntentRef: 'pi-1', amountMinor: 4760, currency: 'CNY' }),
    ).not.toThrow();
  });

  it('合法字段 expiresAt 不被误伤（不得拿过期期限当凭据）', () => {
    expect(containsCredentialField({ expiresAt: 1_700_000_000_000, issuedAt: 0 })).toBe(false);
    expect(() => assertNoCredentialFields({ expiresAt: 1 })).not.toThrow();
  });

  it('大小写 / 连字符 / 下划线无关', () => {
    expect(containsCredentialField({ 'Card-Number': 'x' })).toBe(true);
    expect(containsCredentialField({ CARD_NUMBER: 'x' })).toBe(true);
    expect(isCredentialKey('Pay_Pin')).toBe(true);
    expect(isCredentialKey('cardholder')).toBe(true);
  });

  it('findCredentialField 返回可定位的路径', () => {
    expect(findCredentialField({ a: { b: { otp: '000000' } } })).toBe('$.a.b.otp');
    expect(findCredentialField({ list: [{ pin: '0000' }] })).toBe('$.list[0].pin');
    expect(findCredentialField({ clean: 1 })).toBeNull();
  });

  it('非对象载荷不被当成凭据（结构扫描只认对象/数组）', () => {
    expect(containsCredentialField('000000')).toBe(false);
    expect(containsCredentialField(null)).toBe(false);
    expect(containsCredentialField(42)).toBe(false);
  });
});
