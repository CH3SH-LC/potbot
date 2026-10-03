/**
 * M08 边界五：**可信官方支付链接 / 回跳**。
 *
 * 反向对照（本文件的要害）：非 https、域名不在白名单、内嵌 `user:pass@`、
 * 后缀伪装域名一律判不可信；自造交接/回跳一律被拒。任何放宽 `checkPaymentUrl`
 * 的改动都会让本文件变红。
 */

import { describe, expect, it } from 'vitest';

import {
  PaymentError,
  PaymentTracker,
  checkPaymentUrl,
  createPaymentCallback,
  createPaymentHandoff,
  createTrustedLinkPolicy,
  describeExternalStep,
  isTrustedPaymentHandoff,
} from '../../../src/mobile-plugins/meituan/payment/index.js';
import { createClock, fixturePolicy, makeHandoff, makeIntent } from './support.js';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof PaymentError ? error.code : 'not-a-payment-error';
  }
}

const policy = fixturePolicy();

describe('M08 可信支付链接白名单', () => {
  it('https + 白名单域名 ⇒ 可信', () => {
    const check = checkPaymentUrl('https://pay.meituan.test/cashier?x=1', policy);
    expect(check.trusted).toBe(true);
    expect(check.host).toBe('pay.meituan.test');
  });

  it('非白名单域名被拒', () => {
    expect(checkPaymentUrl('https://evil.test/x', policy).trusted).toBe(false);
  });

  it('http（非 https）被拒', () => {
    const check = checkPaymentUrl('http://pay.meituan.test/x', policy);
    expect(check.trusted).toBe(false);
    expect(check.reason).toContain('https');
  });

  it('内嵌凭据 user:pass@ 被拒', () => {
    const check = checkPaymentUrl('https://user:pass@pay.meituan.test/x', policy);
    expect(check.trusted).toBe(false);
    expect(check.reason).toContain('内嵌凭据');
  });

  it('后缀伪装域名不算命中（精确匹配，不做后缀包含）', () => {
    expect(checkPaymentUrl('https://pay.meituan.test.evil.test/x', policy).trusted).toBe(false);
    expect(checkPaymentUrl('https://evilpay.meituan.test/x', policy).trusted).toBe(false);
  });

  it('空 URL / 无法解析一律不可信', () => {
    expect(checkPaymentUrl('', policy).trusted).toBe(false);
    expect(checkPaymentUrl('not a url', policy).trusted).toBe(false);
    expect(checkPaymentUrl(undefined, policy).trusted).toBe(false);
  });

  it('空白名单被拒（构造策略即抛）', () => {
    expect(codeOf(() => createTrustedLinkPolicy({ hosts: [], label: 'empty' }))).toBe('invalid_payment_request');
  });

  it('createPaymentHandoff 对非白名单链接抛 untrusted_payment_url', () => {
    expect(
      codeOf(() =>
        createPaymentHandoff({
          handoffRef: 'ho-x',
          paymentIntentRef: 'pi-1',
          mode: 'official_page',
          url: 'https://evil.test/pay',
          issuedAt: 0,
          expiresAt: 100,
          instructionForUser: 'x',
          linkPolicy: policy,
        }),
      ),
    ).toBe('untrusted_payment_url');
  });

  it('createPaymentCallback 对非白名单链接抛错', () => {
    expect(
      codeOf(() =>
        createPaymentCallback({
          callbackRef: 'cb-x',
          paymentIntentRef: 'pi-1',
          returnUrl: 'https://evil.test/return',
          receivedAt: 0,
          linkPolicy: policy,
        }),
      ),
    ).toBe('untrusted_payment_url');
  });

  it('自造（拷贝）的交接被拒：untrusted_payment_handoff', () => {
    const t = new PaymentTracker({ intent: makeIntent(), clock: createClock(), linkPolicy: policy });
    const genuine = makeHandoff();
    expect(isTrustedPaymentHandoff(genuine)).toBe(true);
    const forged = { ...genuine };
    expect(codeOf(() => t.begin(forged as unknown as typeof genuine))).toBe('untrusted_payment_handoff');
  });

  it('describeExternalStep 如实描述外部步骤，且明说不代填凭据', () => {
    const text = describeExternalStep(makeHandoff());
    expect(text).toContain('官方支付页');
    expect(text).toContain('不代填');
    expect(text).toContain('读回');
  });

  it('交接声明 externalStepRequired=true / collectsCredentials=false', () => {
    const handoff = makeHandoff();
    expect(handoff.externalStepRequired).toBe(true);
    expect(handoff.collectsCredentials).toBe(false);
  });
});
