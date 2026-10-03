/**
 * M01 —— 能力矩阵的**失败关闭构造器**。
 *
 * 唯一规则：**`verified` 必须由"官方 host 且有可读正文"的探针支撑，否则一律 `unverified`。**
 * 这条规则写在构造器里、由测试逐条钉死，而不是靠约定或注释。
 *
 * 具体地，一条 {@link CapabilityEvidence} 只有在同时满足以下**全部**条件时才生效：
 *   1. 引用的 `probeId` 在本次 `probes` 里存在；
 *   2. 该探针 `officialHost === true`（非官方页面连证据资格都没有）；
 *   3. 该探针 `readableContent === true`（空壳页/登录墙不算读过）。
 * 任何一条不满足 ⇒ 结论降级为 `unverified`，并在 `note` 里写明**降级原因**。
 *
 * 本批的五个官方探针全部 `readableContent === false`，因此八个能力 + 协议 + 手机直连
 * **全部 unverified**（见 `evidence.ts` 与 `blocker.ts`）。
 */

import { isOfficialMeituanHost } from './official.js';
import { CREDENTIAL_REF, RECORDED_PROBES } from './evidence.js';
import {
  DISCOVERY_TARGETS,
  MEITUAN_CAPABILITIES,
  type CapabilityEvidence,
  type CapabilityMatrix,
  type CredentialRef,
  type DiscoveryProtocol,
  type DiscoveryTarget,
  type EvidenceProbe,
  type MobileDirectConclusion,
  type ProtocolConclusion,
  type TargetConclusion,
} from './types.js';

export { isOfficialMeituanHost } from './official.js';

/** 构造能力矩阵的输入。全部可选——不给证据时结论就是"全 unverified"，这是有意为之。 */
export interface BuildCapabilityMatrixInput {
  /** 实际使用（并已记录原文）的探针；默认用本批真实抓取的 {@link RECORDED_PROBES}。 */
  readonly probes?: readonly EvidenceProbe[];
  /** 能力证据；默认为空 ⇒ 全部 unverified。 */
  readonly evidence?: readonly CapabilityEvidence[];
  /** 凭证引用；默认用本批真实记录（只记存在性）。 */
  readonly credentialRef?: CredentialRef | null;
  /** 协议类型判定；未经核实时默认 `'unknown'`。 */
  readonly protocolKind?: DiscoveryProtocol;
}

/** 单条证据的裁决结果。 */
interface Adjudication {
  readonly status: 'verified' | 'unverified';
  readonly evidenceUrl: string | null;
  readonly note: string;
}

const NO_EVIDENCE_NOTE = '无官方可读证据：按 M01 口径记 unverified';

/** 把一条 target 的证据裁决成结论（失败关闭）。 */
function adjudicate(
  target: DiscoveryTarget,
  index: ReadonlyMap<string, EvidenceProbe>,
  evidence: readonly CapabilityEvidence[],
): Adjudication {
  const hit = evidence.find((entry) => entry.target === target);
  if (hit === undefined) {
    return { status: 'unverified', evidenceUrl: null, note: NO_EVIDENCE_NOTE };
  }
  const probe = index.get(hit.probeId);
  if (probe === undefined) {
    return {
      status: 'unverified',
      evidenceUrl: null,
      note: `证据引用的探针 "${hit.probeId}" 不存在：降级为 unverified`,
    };
  }
  if (!probe.officialHost) {
    return {
      status: 'unverified',
      evidenceUrl: null,
      note: `证据来源非官方 host（${hit.evidenceUrl}）：非官方页面不具证据资格，降级为 unverified`,
    };
  }
  if (!probe.readableContent) {
    return {
      status: 'unverified',
      evidenceUrl: null,
      note: `证据页面无可读正文（${hit.evidenceUrl}）：空壳页/登录墙不算读过，降级为 unverified`,
    };
  }
  return {
    status: 'verified',
    evidenceUrl: probe.url,
    note: hit.note.length > 0 ? hit.note : `依据官方可读页面 ${probe.url}`,
  };
}

/**
 * 构造脱敏能力矩阵。
 *
 * 注意：`credentialRef` 只影响矩阵里那一行"凭证是否存在"的展示，
 * **不影响**任何能力的 `verified/unverified`——这正是"不凭 key 长度推断权限"的机器化表达。
 */
export function buildCapabilityMatrix(input: BuildCapabilityMatrixInput = {}): CapabilityMatrix {
  const probes = input.probes ?? RECORDED_PROBES;
  const evidence = input.evidence ?? [];
  const credentialRef = input.credentialRef === undefined ? CREDENTIAL_REF : input.credentialRef;

  const index = new Map<string, EvidenceProbe>();
  for (const probe of probes) {
    index.set(probe.probeId, probe);
  }

  const capabilities = {} as Record<(typeof MEITUAN_CAPABILITIES)[number], TargetConclusion>;
  for (const capability of MEITUAN_CAPABILITIES) {
    const verdict = adjudicate(capability, index, evidence);
    capabilities[capability] = Object.freeze({
      target: capability,
      status: verdict.status,
      evidenceUrl: verdict.evidenceUrl,
      note: verdict.note,
    });
  }

  const protocolVerdict = adjudicate('protocol', index, evidence);
  const mobileVerdict = adjudicate('mobileDirectConnectAllowed', index, evidence);

  const protocol: ProtocolConclusion = Object.freeze({
    target: 'protocol' as const,
    kind: input.protocolKind ?? 'unknown',
    status: protocolVerdict.status,
    evidenceUrl: protocolVerdict.evidenceUrl,
    note: protocolVerdict.note,
  });

  const mobileDirectConnectAllowed: MobileDirectConclusion = Object.freeze({
    target: 'mobileDirectConnectAllowed' as const,
    status: mobileVerdict.status,
    evidenceUrl: mobileVerdict.evidenceUrl,
    note: mobileVerdict.note,
  });

  const allUnverified = DISCOVERY_TARGETS.every((target) => {
    if (target === 'protocol') {
      return protocol.status === 'unverified';
    }
    if (target === 'mobileDirectConnectAllowed') {
      return mobileDirectConnectAllowed.status === 'unverified';
    }
    return capabilities[target].status === 'unverified';
  });

  return Object.freeze({
    packageId: 'M01' as const,
    schemaVersion: 'mobile-v1' as const,
    credentialTransmitted: false as const,
    authenticatedRequestMade: false as const,
    orderOrPaymentSubmitted: false as const,
    credentialRef,
    capabilities: Object.freeze(capabilities),
    protocol,
    mobileDirectConnectAllowed,
    probes: Object.freeze([...probes]),
    allUnverified,
  });
}

/** 只列出仍是 `unverified` 的目标（按 `DISCOVERY_TARGETS` 顺序）。 */
export function unverifiedTargets(matrix: CapabilityMatrix): readonly DiscoveryTarget[] {
  const out: DiscoveryTarget[] = [];
  for (const target of DISCOVERY_TARGETS) {
    if (target === 'protocol') {
      if (matrix.protocol.status === 'unverified') {
        out.push(target);
      }
    } else if (target === 'mobileDirectConnectAllowed') {
      if (matrix.mobileDirectConnectAllowed.status === 'unverified') {
        out.push(target);
      }
    } else if (matrix.capabilities[target].status === 'unverified') {
      out.push(target);
    }
  }
  return Object.freeze(out);
}

/** 结论查询：某能力是否被官方可读证据支撑。 */
export function isCapabilityVerified(matrix: CapabilityMatrix, capability: (typeof MEITUAN_CAPABILITIES)[number]): boolean {
  return matrix.capabilities[capability].status === 'verified';
}
