/**
 * M10 纵切：fixture 可以跑通全部（fixture 可达的）状态；真实旅程走**另一条**路径。
 */

import { describe, expect, it } from 'vitest';

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import {
  assertNotProductionManifest,
  checkProductionActivation,
  createRealEvidenceLedger,
  driveFixtureJourney,
  EvidenceError,
  FIXTURE_RECORDABLE_STAGES,
  hasConfirmedEvidence,
  issueRealTransportAttestation,
  JOURNEY_STAGES,
  type JourneyStage,
  type RealTransportProof,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import { JOURNEY_ID, T0 } from './support.js';

describe('M10 纵切：fixture 宿主跑通全部可达状态', () => {
  it('驱动脚本真实调用报价端口并逐步记账', async () => {
    const result = await driveFixtureJourney({ journeyId: JOURNEY_ID });
    // 报价真实来自 M04 fixture 端口：2×3200 + 打包 200 + 配送 500。
    expect(result.quoteAmountMinor).toBe(7100);
    expect(result.quoteCurrency).toBe('CNY');
    expect(result.summary.total).toBe(FIXTURE_RECORDABLE_STAGES.length);
  });

  it('fixture 可记录 5 个阶段，payment_confirmed 结构性缺席', async () => {
    const result = await driveFixtureJourney({ journeyId: JOURNEY_ID });
    const present = new Set(result.summary.stages.filter((s) => s.present).map((s) => s.stage));
    for (const stage of FIXTURE_RECORDABLE_STAGES) {
      expect(present.has(stage)).toBe(true);
    }
    expect(present.has('payment_confirmed')).toBe(false);
    expect(result.summary.allStagesPresent).toBe(false); // 六阶段里差 payment
    expect(result.summary.confirmedCount).toBe(0);
    expect(hasConfirmedEvidence(result.host.ledger)).toBe(false);
  });

  it('fixture 可达阶段恰好是六阶段去掉 payment_confirmed', () => {
    const expected = JOURNEY_STAGES.filter((stage) => stage !== 'payment_confirmed');
    expect([...FIXTURE_RECORDABLE_STAGES]).toEqual([...expected]);
  });

  it('在 fixture 宿主台账上补录 payment_confirmed ⇒ 被拒', async () => {
    const result = await driveFixtureJourney({ journeyId: JOURNEY_ID });
    try {
      result.host.ledger.record({
        journeyId: JOURNEY_ID,
        stage: 'payment_confirmed',
        observedState: 'confirmed',
        detail: '绕过分离闸门',
      });
      throw new Error('期望被拒，但没有抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceError);
      expect((error as EvidenceError).code).toBe('fixture_cannot_record_payment');
    }
  });

  it('fixture 宿主的 manifest 过不了生产启用闸门', async () => {
    const result = await driveFixtureJourney({ journeyId: JOURNEY_ID });
    expect(result.host.mode).toBe('fixture');
    expect(checkProductionActivation(result.host.manifest).activatable).toBe(false);
    expect(() => assertNotProductionManifest(result.host.manifest)).not.toThrow();
  });
});

describe('M10 真实旅程走独立路径（六阶段可全记录）', () => {
  it('real 台账可记录全部六阶段（含支付），与 fixture 台账互不相干', () => {
    const proof: RealTransportProof = {
      verificationMode: 'real',
      deviceRef: 'device:honor-xyz',
      requestHostRef: 'host:api.meituan.example',
      transportEvidenceRef: 'net-1',
      observedAt: T0,
    };
    const attestation = issueRealTransportAttestation(proof, T0);
    const ledger = createRealEvidenceLedger({ clock: new FixtureClock(T0), attestation });
    for (const stage of JOURNEY_STAGES as readonly JourneyStage[]) {
      const confirmed = stage === 'order_readback' || stage === 'payment_confirmed';
      ledger.record({
        journeyId: 'journey-real-1',
        stage,
        observedState: confirmed ? 'confirmed' : 'submitted',
        externalOrderId: stage === 'order_readback' ? 'MT-REAL-1' : null,
        detail: `real ${stage}`,
      });
    }
    const summary = ledger.summary();
    expect(summary.mode).toBe('real');
    expect(summary.allStagesPresent).toBe(true);
    expect(summary.confirmedCount).toBe(2);
    expect(hasConfirmedEvidence(ledger)).toBe(true);
  });
});
