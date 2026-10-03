/**
 * M-I19 消费端契约：凭证结构与 M10 `mobile-feature/types.ts` **逐字对齐**；能力矩阵可
 * 原样注入；并证明可信根是**每模块私有**的（迁移接线前两模块互不承认——这正是 M-I10
 * 需要改接线去消费本 seam 的原因）。
 *
 * 说明：本文件对 M10 的 import 是**只读**的（类型 + 真实现函数），用来核对接口，不修改
 * 任何非本单元 allowlist 的文件。
 */

import { describe, expect, it } from 'vitest';

import {
  assertTrustedRealTransportAttestation,
  isTrustedRealTransportAttestation as isTrustedMine,
  issueRealTransportAttestation as issueMine,
  requireTrustedRealTransportAttestation,
  TRANSPORT_ATTESTATION_BOUNDARY,
  type RealTransportAttestation,
} from '../../../src/mobile-plugins/meituan/transport-attestation/index.js';
import {
  isTrustedRealTransportAttestation as isTrustedM10,
  issueRealTransportAttestation as issueM10,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import type {
  CapabilityMatrix as M10CapabilityMatrix,
  RealTransportAttestation as M10Attestation,
  RealTransportProof as M10Proof,
} from '../../../src/mobile-plugins/meituan/mobile-feature/types.js';
import { honestDefaultMatrix, oneVerified, T0, transportFact } from './support.js';

const myAttestation = issueMine({
  transport: transportFact(),
  issuedAt: T0,
  capabilityMatrix: oneVerified('search'),
});

// —— 编译期契约（tsc 不过即红线；runtime 用 var 引用避免 unused）——
// 本 seam 的凭证可与 M10 的类型**双向**赋值：结构逐字对齐，无需适配层。
const _mineToM10: M10Attestation = myAttestation;
const _m10ToMine: RealTransportAttestation = {} as M10Attestation;
const _proofCompat: M10Proof = myAttestation.proof;
// M10 的 CapabilityMatrix 可**原样**注入本 seam（不需要 as）。
const _matrixCompat: ReturnType<typeof honestDefaultMatrix> = {} as M10CapabilityMatrix;
void _mineToM10;
void _m10ToMine;
void _proofCompat;
void _matrixCompat;

describe('M-I19 消费端契约：结构逐字对齐 M10', () => {
  it('凭证键集与 M10 期望一致（proof + issuedAt；proof 五个字段）', () => {
    expect(Object.keys(myAttestation).sort()).toEqual(['issuedAt', 'proof']);
    expect(Object.keys(myAttestation.proof).sort()).toEqual([
      'deviceRef',
      'observedAt',
      'requestHostRef',
      'transportEvidenceRef',
      'verificationMode',
    ]);
  });

  it('本签发凭证通过本 seam 的消费端断言', () => {
    expect(() => assertTrustedRealTransportAttestation(myAttestation)).not.toThrow();
    expect(requireTrustedRealTransportAttestation(myAttestation)).toBe(myAttestation);
  });

  it('本模块的 M10-capable 类型别名在运行期仍是同一对象（零适配）', () => {
    // 反向控制：确认上面两个编译期赋值不是把对象换掉了。
    expect(_mineToM10).toBe(myAttestation);
  });
});

describe('M-I19 可信根是每模块私有的（迁移前互不承认）', () => {
  it('M10 签发的凭证不被本 seam 承认；本 seam 签发的凭证不被 M10 承认', () => {
    const m10Attestation = issueM10(
      {
        verificationMode: 'real',
        deviceRef: 'device:honor-m10',
        requestHostRef: 'host:api.authorized.test',
        transportEvidenceRef: 'net-receipt:m10',
        observedAt: T0,
      },
      T0,
    );
    // 各自模块内可信……
    expect(isTrustedM10(m10Attestation)).toBe(true);
    expect(isTrustedMine(myAttestation)).toBe(true);
    // ……但跨模块互不承认：这正是 M10 的 evidence/host 需改为 import 本 seam 验证器的原因。
    expect(isTrustedMine(m10Attestation)).toBe(false);
    expect(isTrustedM10(myAttestation)).toBe(false);
  });

  it('伪造一份形状相同的 M10 凭证仍不被本 seam 承认', () => {
    const forged = {
      proof: { ...myAttestation.proof },
      issuedAt: myAttestation.issuedAt,
    };
    expect(isTrustedMine(forged)).toBe(false);
  });
});

describe('M-I19 边界常量（结构性声明）', () => {
  it('fixture 与真实通道不得混同的各项恒为 false / true', () => {
    expect(TRANSPORT_ATTESTATION_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.mintsRealWithoutVerifiedCapability).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.callerSetsVerificationMode).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.acceptsUndeliveredTransport).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.acceptsUnredactedEvidence).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.trustsShapeIdenticalLiteral).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.consumerCanBypassVerification).toBe(false);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.trustRootIsSourceRegistry).toBe(true);
    expect(TRANSPORT_ATTESTATION_BOUNDARY.verificationMode).toBe('fixture');
  });
});
