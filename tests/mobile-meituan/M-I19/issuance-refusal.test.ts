/**
 * M-I19 签发闸门：**无已核实能力就签不出 real 凭证**，字段/脱敏非法一律拒。
 *
 * 这条是"fixture 与真实通道不得混同"的关键：M01 诚实默认为全部 unverified，
 * 因此 fixture 通道无法用自造对象签发凭证。
 */

import { describe, expect, it } from 'vitest';

import {
  issueRealTransportAttestation,
  TransportAttestationError,
} from '../../../src/mobile-plugins/meituan/transport-attestation/index.js';
import {
  catchError,
  deniedOnly,
  honestDefaultMatrix,
  oneVerified,
  T0,
  transportFact,
  verifiedWithoutEvidence,
} from './support.js';

describe('M-I19 能力矩阵闸门：无已核实能力 ⇒ 拒绝签发', () => {
  it('M01 诚实默认（全部 unverified）⇒ capability_matrix_unverified', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact(),
        issuedAt: T0,
        capabilityMatrix: honestDefaultMatrix(),
      }),
    );
    expect(failure.name).toBe('TransportAttestationError');
    expect(failure.code).toBe('capability_matrix_unverified');
  });

  it('缺矩阵（undefined）⇒ capability_matrix_unverified', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact(),
        issuedAt: T0,
        capabilityMatrix: undefined as never,
      }),
    );
    expect(failure.code).toBe('capability_matrix_unverified');
  });

  it('全部 denied（没有任何 verified）⇒ capability_matrix_unverified', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact(),
        issuedAt: T0,
        capabilityMatrix: deniedOnly(),
      }),
    );
    expect(failure.code).toBe('capability_matrix_unverified');
  });

  it('标 verified 却无证据引用 ⇒ 不计数 ⇒ capability_matrix_unverified', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact(),
        issuedAt: T0,
        capabilityMatrix: verifiedWithoutEvidence(),
      }),
    );
    expect(failure.code).toBe('capability_matrix_unverified');
  });

  it('矩阵残缺（verdicts 不是对象）⇒ capability_matrix_unverified（不被绕过）', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact(),
        issuedAt: T0,
        capabilityMatrix: { verdicts: 'not-an-object' } as never,
      }),
    );
    expect(failure.code).toBe('capability_matrix_unverified');
  });

  it('有一项 verified ⇒ 正常签发，且 verificationMode 恒为 real（不由调用方传）', () => {
    const attestation = issueRealTransportAttestation({
      transport: transportFact(),
      issuedAt: T0,
      capabilityMatrix: oneVerified('search'),
    });
    expect(attestation.proof.verificationMode).toBe('real');
    expect(attestation.proof.deviceRef).toBe('device:honor-fixture-hash');
    expect(attestation.proof.requestHostRef).toBe('host:api.authorized.test');
    expect(attestation.proof.transportEvidenceRef).toBe('net-receipt:fixture-0001');
    expect(attestation.proof.observedAt).toBe(T0);
    expect(attestation.issuedAt).toBe(T0);
  });
});

describe('M-I19 签发字段校验（矩阵合格后才校验字段）', () => {
  const matrix = oneVerified('search');

  it('deviceRef 空串 ⇒ invalid_input（错误类型为 TransportAttestationError）', () => {
    let captured: unknown = null;
    try {
      issueRealTransportAttestation({
        transport: transportFact({ deviceRef: '   ' }),
        issuedAt: T0,
        capabilityMatrix: matrix,
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TransportAttestationError);
    expect((captured as TransportAttestationError).code).toBe('invalid_input');
  });

  it('requestHostRef 非字符串 ⇒ invalid_input', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact({ requestHostRef: undefined as never }),
        issuedAt: T0,
        capabilityMatrix: matrix,
      }),
    );
    expect(failure.code).toBe('invalid_input');
  });

  it('issuedAt = NaN ⇒ invalid_input', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact(),
        issuedAt: Number.NaN,
        capabilityMatrix: matrix,
      }),
    );
    expect(failure.code).toBe('invalid_input');
  });

  it('observedAt = Infinity ⇒ invalid_input', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact({ observedAt: Number.POSITIVE_INFINITY }),
        issuedAt: T0,
        capabilityMatrix: matrix,
      }),
    );
    expect(failure.code).toBe('invalid_input');
  });

  it('deviceRef 含 Bearer 令牌形态 ⇒ secret_like_text_rejected', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact({ deviceRef: 'Bearer abcdefgh12345678' }),
        issuedAt: T0,
        capabilityMatrix: matrix,
      }),
    );
    expect(failure.code).toBe('secret_like_text_rejected');
  });

  it('transportEvidenceRef 含手机号形态 ⇒ secret_like_text_rejected', () => {
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact({ transportEvidenceRef: 'recv-13800138000' }),
        issuedAt: T0,
        capabilityMatrix: matrix,
      }),
    );
    expect(failure.code).toBe('secret_like_text_rejected');
  });

  it('脱敏错误信息不回显命中内容（避免把敏感串写进日志）', () => {
    const secret = 'Bearer abcdefgh12345678';
    const failure = catchError(() =>
      issueRealTransportAttestation({
        transport: transportFact({ deviceRef: secret }),
        issuedAt: T0,
        capabilityMatrix: matrix,
      }),
    );
    expect(failure.message.includes(secret)).toBe(false);
  });
});
