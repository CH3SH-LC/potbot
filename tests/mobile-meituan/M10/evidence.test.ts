/**
 * M10 证据采集：fixture 与真实旅程结构性分离。
 */

import { describe, expect, it } from 'vitest';

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import {
  containsSecretLikeText,
  createFixtureEvidenceLedger,
  createRealEvidenceLedger,
  EvidenceError,
  hasConfirmedEvidence,
  isTrustedRealTransportAttestation,
  issueRealTransportAttestation,
  type RealTransportProof,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { JOURNEY_ID, T0 } from './support.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    expect((error as EvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}

const realProof: RealTransportProof = {
  verificationMode: 'real',
  deviceRef: 'device:honor-abc123',
  requestHostRef: 'host:api.meituan.example',
  transportEvidenceRef: 'net-receipt-1',
  observedAt: T0,
};

describe('M10 fixture 台账：结构上写不了完成/支付', () => {
  it('普通阶段可记录，记录 mode 由台账决定', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    const record = ledger.record({
      journeyId: JOURNEY_ID,
      stage: 'order_submitted',
      observedState: 'submitted',
      requestRef: 'req-1',
      amountMinor: 7100,
      currency: 'CNY',
      detail: 'fixture 提交回执',
    });
    expect(record.mode).toBe('fixture');
    expect(record.recordId).toBe('fixture-0001');
    expect(record.observedAt).toBe(T0);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('写 confirmed ⇒ fixture_cannot_claim_confirmed', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    expectCode(
      () =>
        ledger.record({
          journeyId: JOURNEY_ID,
          stage: 'order_readback',
          observedState: 'confirmed',
          detail: '试图冒充真实完成',
        }),
      'fixture_cannot_claim_confirmed',
    );
    expect(ledger.all()).toHaveLength(0);
  });

  it('记录 payment_confirmed 阶段 ⇒ fixture_cannot_record_payment', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    expectCode(
      () =>
        ledger.record({
          journeyId: JOURNEY_ID,
          stage: 'payment_confirmed',
          observedState: 'submitted',
          detail: 'fixture 无支付能力',
        }),
      'fixture_cannot_record_payment',
    );
  });

  it('金额非整数最小单位 ⇒ invalid_amount', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    expectCode(
      () =>
        ledger.record({
          journeyId: JOURNEY_ID,
          stage: 'order_submitted',
          observedState: 'submitted',
          amountMinor: 71.5,
          detail: '浮点金额',
        }),
      'invalid_amount',
    );
  });

  it('自由文本含疑似手机号 ⇒ secret_like_text_rejected', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    // 以拼接方式构造一个"手机号形态"的字符串做负例，避免在用例里写真实号码字面量。
    const phoneLike = ['1', '3', '5', '0000', '0000'].join('');
    expect(containsSecretLikeText(`联系 ${phoneLike}`)).toBe(true);
    expectCode(
      () =>
        ledger.record({
          journeyId: JOURNEY_ID,
          stage: 'order_submitted',
          observedState: 'submitted',
          detail: `联系 ${phoneLike}`,
        }),
      'secret_like_text_rejected',
    );
  });

  it('自由文本含 Bearer 令牌 ⇒ secret_like_text_rejected', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    expectCode(
      () =>
        ledger.record({
          journeyId: JOURNEY_ID,
          stage: 'order_submitted',
          observedState: 'submitted',
          detail: 'header Bearer eyJhbGciOiJIUzI1NiJ9abcdef',
        }),
      'secret_like_text_rejected',
    );
  });
});

describe('M10 real 台账：需要可信真机传输凭证', () => {
  it('没有凭证 / 伪造对象 ⇒ untrusted_real_attestation', () => {
    const forged = { proof: realProof, issuedAt: T0 };
    expect(isTrustedRealTransportAttestation(forged)).toBe(false);
    expectCode(
      () => createRealEvidenceLedger({ clock: new FixtureClock(T0), attestation: forged as never }),
      'untrusted_real_attestation',
    );
  });

  it('verificationMode 不是 real 的 proof ⇒ 签发即拒', () => {
    expectCode(
      () =>
        issueRealTransportAttestation(
          { ...realProof, verificationMode: 'fixture' as never },
          T0,
        ),
      'invalid_input',
    );
  });

  it('合法凭证 ⇒ real 台账可记录 confirmed 与 payment_confirmed', () => {
    const attestation = issueRealTransportAttestation(realProof, T0);
    expect(isTrustedRealTransportAttestation(attestation)).toBe(true);
    const ledger = createRealEvidenceLedger({ clock: new FixtureClock(T0), attestation });
    expect(ledger.mode).toBe('real');
    const confirmed = ledger.record({
      journeyId: JOURNEY_ID,
      stage: 'order_readback',
      observedState: 'confirmed',
      externalOrderId: 'MT-REAL-1',
      amountMinor: 7100,
      currency: 'CNY',
      detail: '平台回读确认已下单',
    });
    expect(confirmed.mode).toBe('real');
    ledger.record({
      journeyId: JOURNEY_ID,
      stage: 'payment_confirmed',
      observedState: 'confirmed',
      detail: '平台回读确认已支付',
    });
    expect(hasConfirmedEvidence(ledger)).toBe(true);
    expect(ledger.summary().confirmedCount).toBe(2);
  });
});

describe('M10 证据小结：逐阶段报告，无合并 ok', () => {
  it('summary 逐阶段给出 presence，缺席阶段如实为 false', () => {
    const ledger = createFixtureEvidenceLedger({ clock: new FixtureClock(T0) });
    for (const stage of ['capability_discovered', 'on_device_transport', 'user_authorized'] as const) {
      ledger.record({ journeyId: JOURNEY_ID, stage, observedState: 'unknown', detail: `${stage} fixture` });
    }
    const summary = ledger.summary();
    expect(summary.mode).toBe('fixture');
    expect(summary.total).toBe(3);
    expect(summary.allStagesPresent).toBe(false);
    const byStage = new Map(summary.stages.map((entry) => [entry.stage, entry.present]));
    expect(byStage.get('capability_discovered')).toBe(true);
    expect(byStage.get('payment_confirmed')).toBe(false);
    expect(byStage.get('order_readback')).toBe(false);
  });
});
