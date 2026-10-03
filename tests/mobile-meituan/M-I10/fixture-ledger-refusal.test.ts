/**
 * M-I10：fixture 台账**结构上**写不了 confirmed、也写不了 payment_confirmed 阶段；
 * real 台账（可信凭证）才可记录完成与支付——两者互不相干。
 */

import { describe, expect, it } from 'vitest';

import {
  createFixtureEvidenceLedger,
  createRealEvidenceLedger,
  EvidenceError,
  hasConfirmedEvidence,
  type EvidenceErrorCode,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { JOURNEY_ID, ports, realAttestation, T0 } from './support.js';

function expectCode(fn: () => unknown, code: EvidenceErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceError);
    expect((error as EvidenceError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`);
}

describe('M-I10 fixture 台账拒绝完成 / 支付阶段', () => {
  it('写 confirmed ⇒ fixture_cannot_claim_confirmed，且不落库', () => {
    const ledger = createFixtureEvidenceLedger({ clock: ports().clock });
    expectCode(
      () =>
        ledger.record({
          journeyId: JOURNEY_ID,
          stage: 'order_readback',
          observedState: 'confirmed',
          detail: 'fixture 试图冒充真实完成',
        }),
      'fixture_cannot_claim_confirmed',
    );
    expect(ledger.all()).toHaveLength(0);
  });

  it('记录 payment_confirmed 阶段 ⇒ fixture_cannot_record_payment（即便状态不是 confirmed）', () => {
    const ledger = createFixtureEvidenceLedger({ clock: ports().clock });
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
    expect(hasConfirmedEvidence(ledger)).toBe(false);
  });

  it('普通阶段可记录，mode 由台账决定', () => {
    const ledger = createFixtureEvidenceLedger({ clock: ports().clock });
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
    expect(record.observedAt).toBe(T0);
  });

  it('对照：real 台账（可信凭证）可记录 confirmed 与 payment_confirmed', () => {
    const ledger = createRealEvidenceLedger({ clock: ports().clock, attestation: realAttestation() });
    ledger.record({
      journeyId: 'journey-real-1',
      stage: 'order_readback',
      observedState: 'confirmed',
      externalOrderId: 'MT-REAL-1',
      amountMinor: 7100,
      currency: 'CNY',
      detail: '平台回读确认已下单',
    });
    ledger.record({
      journeyId: 'journey-real-1',
      stage: 'payment_confirmed',
      observedState: 'confirmed',
      detail: '平台回读确认已支付',
    });
    expect(ledger.summary().confirmedCount).toBe(2);
    expect(hasConfirmedEvidence(ledger)).toBe(true);
  });
});
