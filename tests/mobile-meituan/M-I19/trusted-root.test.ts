/**
 * M-I19 信任根：只有**本模块签发**的凭证可信；形状相同的字面量 / 拷贝 / 深拷贝一律不可信。
 *
 * 这是"逐字段校验挡不住照抄形状，只有来源登记挡得住"的机读证据。照 M07
 * `createAuthorizationRef`、M10 `evidence.ts` 的同一纪律。
 */

import { describe, expect, it } from 'vitest';

import {
  assertTrustedRealTransportAttestation,
  isTrustedRealTransportAttestation,
  issueRealTransportAttestation,
  requireTrustedRealTransportAttestation,
  TransportAttestationError,
  verifyRealTransportAttestation,
} from '../../../src/mobile-plugins/meituan/transport-attestation/index.js';
import { catchError, oneVerified, T0, transportFact } from './support.js';

function mint() {
  return issueRealTransportAttestation({
    transport: transportFact(),
    issuedAt: T0,
    capabilityMatrix: oneVerified('search'),
  });
}

describe('M-I19 来源登记：签发实例可信', () => {
  it('签发即登记：isTrusted 为 true，且 proof 冻结', () => {
    const attestation = mint();
    expect(isTrustedRealTransportAttestation(attestation)).toBe(true);
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.proof)).toBe(true);
  });

  it('verify 对已登记凭证返回 trusted=true 且无结构问题', () => {
    const result = verifyRealTransportAttestation(mint());
    expect(result.trusted).toBe(true);
    expect(result.problems).toEqual([]);
  });
});

describe('M-I19 来源登记：形状相同但未登记一律不可信', () => {
  it('自造字面量（逐字段与真凭证一致）⇒ isTrusted=false', () => {
    const real = mint();
    const literal = {
      proof: {
        verificationMode: 'real' as const,
        deviceRef: real.proof.deviceRef,
        requestHostRef: real.proof.requestHostRef,
        transportEvidenceRef: real.proof.transportEvidenceRef,
        observedAt: real.proof.observedAt,
      },
      issuedAt: real.issuedAt,
    };
    expect(isTrustedRealTransportAttestation(literal)).toBe(false);
  });

  it('浅拷贝 {...attestation} ⇒ isTrusted=false（"拿拷贝当新凭证"走不通）', () => {
    const spread = { ...mint() };
    expect(isTrustedRealTransportAttestation(spread)).toBe(false);
  });

  it('深拷贝 JSON.parse(JSON.stringify(...)) ⇒ isTrusted=false', () => {
    const deep = JSON.parse(JSON.stringify(mint())) as unknown;
    expect(isTrustedRealTransportAttestation(deep)).toBe(false);
  });

  it('结构合法但未登记：verify 的 trusted=false 而 problems 为空（形状挡不住、来源才挡得住）', () => {
    const real = mint();
    const literal = {
      proof: { ...real.proof },
      issuedAt: real.issuedAt,
    };
    const result = verifyRealTransportAttestation(literal);
    expect(result.trusted).toBe(false);
    expect(result.problems).toEqual([]);
  });

  it('结构非法（verificationMode 非 real / 缺字段）⇒ problems 非空', () => {
    const result = verifyRealTransportAttestation({
      proof: { verificationMode: 'fixture', deviceRef: '', requestHostRef: 'host:x', transportEvidenceRef: 'e', observedAt: T0 },
      issuedAt: T0,
    });
    expect(result.trusted).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('非对象 ⇒ trusted=false 且 problems 非空', () => {
    expect(verifyRealTransportAttestation(null).trusted).toBe(false);
    expect(verifyRealTransportAttestation(42).problems.length).toBeGreaterThan(0);
  });
});

describe('M-I19 消费端闸门', () => {
  it('assertTrusted 对伪造对象抛 untrusted_real_transport_attestation（且不回显对象）', () => {
    const failure = catchError(() => assertTrustedRealTransportAttestation({ proof: {}, issuedAt: T0 }));
    expect(failure.name).toBe('TransportAttestationError');
    expect(failure.code).toBe('untrusted_real_transport_attestation');
  });

  it('requireTrusted 对可信凭证原样返回同一对象', () => {
    const attestation = mint();
    expect(requireTrustedRealTransportAttestation(attestation)).toBe(attestation);
  });

  it('assertTrusted 对可信凭证不抛，并收窄类型', () => {
    const attestation = mint();
    expect(() => assertTrustedRealTransportAttestation(attestation)).not.toThrow();
    expectTransportAttestationErrorOnce();
  });

  function expectTransportAttestationErrorOnce(): void {
    // 反向控制：确认断言对伪造对象确实会抛（证明上面的 not.toThrow 非空断言）。
    let threw = false;
    try {
      assertTrustedRealTransportAttestation({ ...mint() });
    } catch (error) {
      threw = error instanceof TransportAttestationError;
    }
    expect(threw).toBe(true);
  }
});
