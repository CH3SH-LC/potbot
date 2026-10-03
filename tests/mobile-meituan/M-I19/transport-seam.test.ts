/**
 * M-I19 生产端 seam：由**已送达**的传输结果签发（M-I02 / M02 的规范入口）。
 *
 * 未送达 / 未声明脱敏的证据一律拒——这样"没真机发出过请求"就无法伪造真机凭证。
 */

import { describe, expect, it } from 'vitest';

import {
  issueRealTransportAttestationFromDelivered,
  isTrustedRealTransportAttestation,
} from '../../../src/mobile-plugins/meituan/transport-attestation/index.js';
import {
  catchError,
  deliveredTransport,
  EVIDENCE_REF,
  honestDefaultMatrix,
  oneVerified,
  T0,
} from './support.js';

describe('M-I19 送达闸门：只有真实送达 + 协议合法才可签发', () => {
  it('delivered=true 且 ok=true ⇒ 签发成功，requestHostRef 由 host 包装为 host:<host>', () => {
    const attestation = issueRealTransportAttestationFromDelivered({
      transport: deliveredTransport(),
      deviceRef: 'device:honor-fixture-hash',
      transportEvidenceRef: EVIDENCE_REF,
      observedAt: T0,
      issuedAt: T0,
      capabilityMatrix: oneVerified('search'),
    });
    expect(isTrustedRealTransportAttestation(attestation)).toBe(true);
    expect(attestation.proof.requestHostRef).toBe('host:api.authorized.test');
    expect(attestation.proof.verificationMode).toBe('real');
  });

  it('delivered=false（未送达）⇒ transport_not_delivered', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: { ...deliveredTransport(), delivered: false as never },
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: oneVerified('search'),
      }),
    );
    expect(failure.name).toBe('TransportAttestationError');
    expect(failure.code).toBe('transport_not_delivered');
  });

  it('delivered=true 但 ok=false（协议未成功解码）⇒ transport_not_delivered', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: { ...deliveredTransport(), ok: false as never },
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: oneVerified('search'),
      }),
    );
    expect(failure.code).toBe('transport_not_delivered');
  });

  it('证据未声明脱敏（redacted=false）⇒ transport_evidence_not_redacted', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: {
          ...deliveredTransport(),
          evidence: { host: 'api.authorized.test', redacted: false as never, plaintextSecretFields: 0 },
        },
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: oneVerified('search'),
      }),
    );
    expect(failure.code).toBe('transport_evidence_not_redacted');
  });

  it('证据含明文字段（plaintextSecretFields=1）⇒ transport_evidence_not_redacted', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: {
          ...deliveredTransport(),
          evidence: { host: 'api.authorized.test', redacted: true, plaintextSecretFields: 1 as never },
        },
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: oneVerified('search'),
      }),
    );
    expect(failure.code).toBe('transport_evidence_not_redacted');
  });

  it('送达但能力矩阵全部 unverified ⇒ capability_matrix_unverified（闸门仍先于送达生效）', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: deliveredTransport(),
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: honestDefaultMatrix(),
      }),
    );
    expect(failure.code).toBe('capability_matrix_unverified');
  });

  it('送达但 host 含令牌形态 ⇒ secret_like_text_rejected（包装后的 requestHostRef 也过脱敏闸）', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: deliveredTransport({ host: 'Bearer abcdefgh12345678' }),
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: oneVerified('search'),
      }),
    );
    expect(failure.code).toBe('secret_like_text_rejected');
  });

  it('缺 transport.evidence 对象 ⇒ invalid_input（不静默通过）', () => {
    const failure = catchError(() =>
      issueRealTransportAttestationFromDelivered({
        transport: { delivered: true, ok: true, host: 'api.authorized.test' } as never,
        deviceRef: 'device:x',
        transportEvidenceRef: EVIDENCE_REF,
        observedAt: T0,
        issuedAt: T0,
        capabilityMatrix: oneVerified('search'),
      }),
    );
    expect(failure.name).toBe('TransportAttestationError');
    expect(failure.code).toBe('invalid_input');
  });
});
