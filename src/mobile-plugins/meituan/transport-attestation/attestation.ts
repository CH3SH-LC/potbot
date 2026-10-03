/**
 * 真机传输凭证的**信任根**（零依赖）。
 *
 * ## 为什么是"登记来源"而不是"逐字段校验"
 *
 * 形状可以照抄。调用方自造一份
 * `{ proof: { verificationMode: 'real', deviceRef: 'device:x', ... }, issuedAt: 1 }`
 * 在任何逐字段校验下都与真的无异。对策与 M07 `createAuthorizationRef`、M10 `evidence.ts`
 * 同源：**只有本模块签发的实例会被登记进模块私有 `WeakSet`**，
 * 消费端只认登记过的对象。因此：
 *
 * - 字面量、`{ ...attestation }` 拷贝、`JSON.parse(JSON.stringify(attestation))`
 *   ⇒ 都不是同一对象 ⇒ `untrusted_real_transport_attestation`（`{...}` 拷贝
 *   "拿一份拷贝当新凭证"走不通）。
 *
 * ## 两条签发前闸门
 *
 * 1. **能力矩阵闸门** {@link assertCapabilitySupportsRealMint}：无已核实能力 ⇒ 拒。
 * 2. **送达闸门**（仅 {@link issueRealTransportAttestationFromDelivered}）：只有
 *    `delivered === true && ok === true` 且证据自证脱敏（`redacted: true`,
 *    `plaintextSecretFields: 0`）才可签发。
 *
 * `verificationMode: 'real'` **由签发器设置**，调用方的 `OnDeviceTransportFact` 里没有
 * 这个字段——fixture 无法"自称 real"。
 */

import { assertCapabilitySupportsRealMint } from './capability.js';
import { TransportAttestationError } from './errors.js';
import { assertRedactedText } from './redact.js';
import {
  type CapabilityMatrixInput,
  type OnDeviceDeliveredTransport,
  type OnDeviceTransportFact,
  type RealTransportAttestation,
  type RealTransportProof,
} from './types.js';

/** 由本模块签发的凭证登记表。私有、不导出 ⇒ 调用方无法枚举、无法伪造。 */
const TRUSTED_REAL_ATTESTATIONS = new WeakSet<object>();

// ---------------------------------------------------------------------------
// 校验助手
// ---------------------------------------------------------------------------

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new TransportAttestationError('invalid_input', `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TransportAttestationError(
      'invalid_input',
      `${label} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TransportAttestationError(
      'invalid_input',
      `${label} 必须是有限数，收到 ${String(value)}`,
    );
  }
  return value;
}

/** 内部铸造：能力闸门 → 字段校验 → 脱敏闸门 → 冻结 → 登记。 */
function mint(
  fact: OnDeviceTransportFact,
  issuedAt: number,
  capabilityMatrix: CapabilityMatrixInput,
): RealTransportAttestation {
  // 1) 能力矩阵闸门：无已核实能力不得签发（M01 诚实默认为全部 unverified）。
  assertCapabilitySupportsRealMint(capabilityMatrix);

  // 2) 字段校验。
  const source = requireObject(fact, 'transport');
  const deviceRef = requireNonEmptyString(source.deviceRef, 'transport.deviceRef');
  const requestHostRef = requireNonEmptyString(source.requestHostRef, 'transport.requestHostRef');
  const transportEvidenceRef = requireNonEmptyString(
    source.transportEvidenceRef,
    'transport.transportEvidenceRef',
  );
  const observedAt = requireFiniteNumber(source.observedAt, 'transport.observedAt');
  const issuedAtValue = requireFiniteNumber(issuedAt, 'issuedAt');

  // 3) 脱敏闸门：引用不得夹带明文。verificationMode 由签发器设置，不由调用方传。
  assertRedactedText(deviceRef, 'transport.deviceRef');
  assertRedactedText(requestHostRef, 'transport.requestHostRef');
  assertRedactedText(transportEvidenceRef, 'transport.transportEvidenceRef');

  const proof: RealTransportProof = Object.freeze({
    verificationMode: 'real' as const,
    deviceRef,
    requestHostRef,
    transportEvidenceRef,
    observedAt,
  });
  const attestation: RealTransportAttestation = Object.freeze({
    proof,
    issuedAt: issuedAtValue,
  });
  TRUSTED_REAL_ATTESTATIONS.add(attestation);
  return attestation;
}

// ---------------------------------------------------------------------------
// 签发（生产端 / M-I02 传输层）
// ---------------------------------------------------------------------------

export interface IssueRealTransportAttestationInput {
  /** 真机传输事实（脱敏引用；无 `verificationMode` 字段）。 */
  readonly transport: OnDeviceTransportFact;
  readonly issuedAt: number;
  /** 注入的能力矩阵；诚实默认（全部 unverified）会让本调用失败。 */
  readonly capabilityMatrix: CapabilityMatrixInput;
}

/**
 * 由一份**真机传输事实**签发凭证（签发器设置 `verificationMode: 'real'`）。
 *
 * 生产端（M-I02 / M02）在真机发出并送达请求后调用。能力矩阵无已核实能力 ⇒ 拒。
 */
export function issueRealTransportAttestation(
  input: IssueRealTransportAttestationInput,
): RealTransportAttestation {
  const source = requireObject(input, 'input');
  return mint(
    source.transport as OnDeviceTransportFact,
    source.issuedAt as number,
    source.capabilityMatrix as CapabilityMatrixInput,
  );
}

export interface IssueRealTransportAttestationFromDeliveredInput {
  /** 结构兼容 M02 `TransportDelivered` 的已送达结果。 */
  readonly transport: OnDeviceDeliveredTransport;
  readonly deviceRef: string;
  readonly transportEvidenceRef: string;
  readonly observedAt: number;
  readonly issuedAt: number;
  readonly capabilityMatrix: CapabilityMatrixInput;
}

/**
 * 由**已送达**的传输结果签发凭证——生产端的规范入口。
 *
 * 比 {@link issueRealTransportAttestation} 多两道送达闸门：`delivered === true &&
 * ok === true`（未送达不能证明真机传输），且证据自证脱敏
 * （`redacted === true && plaintextSecretFields === 0`）。`requestHostRef` 由传输 host
 * 自动包装为 `host:<host>`。
 */
export function issueRealTransportAttestationFromDelivered(
  input: IssueRealTransportAttestationFromDeliveredInput,
): RealTransportAttestation {
  const source = requireObject(input, 'input');
  const transport = requireObject(source.transport, 'input.transport');

  // 送达闸门：只有真实送达且协议合法才可。
  if (transport.delivered !== true || transport.ok !== true) {
    throw new TransportAttestationError(
      'transport_not_delivered',
      '未送达（delivered !== true || ok !== true）不能证明真机传输，不得签发真机凭证',
    );
  }
  // 证据脱敏闸门：复用 M02 的自证不变量。
  const evidence = requireObject(transport.evidence, 'input.transport.evidence');
  if (evidence.redacted !== true || evidence.plaintextSecretFields !== 0) {
    throw new TransportAttestationError(
      'transport_evidence_not_redacted',
      '传输证据未声明脱敏（redacted !== true 或 plaintextSecretFields !== 0），不得据此签发凭证',
    );
  }
  const host = requireNonEmptyString(transport.host, 'input.transport.host');

  const fact: OnDeviceTransportFact = {
    deviceRef: source.deviceRef as string,
    requestHostRef: `host:${host}`,
    transportEvidenceRef: source.transportEvidenceRef as string,
    observedAt: source.observedAt as number,
  };
  return mint(fact, source.issuedAt as number, source.capabilityMatrix as CapabilityMatrixInput);
}

// ---------------------------------------------------------------------------
// 验证（消费端 / M-I10 createRealFeatureHost / createRealEvidenceLedger）
// ---------------------------------------------------------------------------

/** 该对象是否是**本模块签发**的可信凭证（形状相同的伪造对象返回 false）。 */
export function isTrustedRealTransportAttestation(
  value: unknown,
): value is RealTransportAttestation {
  return typeof value === 'object' && value !== null && TRUSTED_REAL_ATTESTATIONS.has(value);
}

/**
 * 消费端闸门：非登记凭证一律抛 `untrusted_real_transport_attestation`。
 * 这是 `createRealFeatureHost` / `createRealEvidenceLedger` 应当调用的断言。
 */
export function assertTrustedRealTransportAttestation(
  value: unknown,
): asserts value is RealTransportAttestation {
  if (!isTrustedRealTransportAttestation(value)) {
    throw new TransportAttestationError(
      'untrusted_real_transport_attestation',
      '真机传输凭证形状相同但未登记：只能由 issueRealTransportAttestation 签发，不得用自造/拷贝对象冒充',
    );
  }
}

/** 同 {@link assertTrustedRealTransportAttestation}，但返回凭证，便于链式消费。 */
export function requireTrustedRealTransportAttestation(value: unknown): RealTransportAttestation {
  assertTrustedRealTransportAttestation(value);
  return value;
}

/** 验证结果：`trusted` 为真当且仅当**结构合法且已登记**。 */
export interface AttestationVerification {
  readonly trusted: boolean;
  /** 结构问题清单（空 = 结构合法）；`trusted=false` 也可能是"结构合法但未登记"。 */
  readonly problems: readonly string[];
}

function structuralProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (value === null || typeof value !== 'object') {
    problems.push('凭证不是对象');
    return problems;
  }
  const record = value as Record<string, unknown>;
  const proof = record.proof;
  if (proof === null || typeof proof !== 'object') {
    problems.push('缺少 proof 对象');
  } else {
    const proofRecord = proof as Record<string, unknown>;
    if (proofRecord.verificationMode !== 'real') {
      problems.push(`proof.verificationMode 必须是 "real"，收到 ${JSON.stringify(proofRecord.verificationMode)}`);
    }
    for (const key of ['deviceRef', 'requestHostRef', 'transportEvidenceRef'] as const) {
      const field = proofRecord[key];
      if (typeof field !== 'string' || field.trim() === '') {
        problems.push(`proof.${key} 必须是非空字符串`);
      }
    }
    if (typeof proofRecord.observedAt !== 'number' || !Number.isFinite(proofRecord.observedAt)) {
      problems.push('proof.observedAt 必须是有限数');
    }
  }
  if (typeof record.issuedAt !== 'number' || !Number.isFinite(record.issuedAt)) {
    problems.push('issuedAt 必须是有限数');
  }
  return problems;
}

/**
 * 同时做结构校验与来源校验。`trusted = (结构无问题) && 已登记`。
 *
 * 注意：**结构合法但未登记**（自造 / 拷贝）会返回 `trusted: false` 且 `problems` 为空
 * ——这正是"形状挡不住、只有来源挡得住"的机读体现。
 */
export function verifyRealTransportAttestation(value: unknown): AttestationVerification {
  const problems = structuralProblems(value);
  const trusted = problems.length === 0 && isTrustedRealTransportAttestation(value);
  return Object.freeze({ trusted, problems: Object.freeze(problems) });
}
