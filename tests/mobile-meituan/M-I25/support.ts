/**
 * M-I25 集成夹具（**不是**被收集的用例文件——不含 `.test.ts` 后缀）。
 *
 * ## 本单元做什么
 *
 * 跨 M01 / M02 / M10 的**失败关闭一致性命中测试**：把 M01 真实的"全 unverified"
 * 能力矩阵，通过消费面 {@link featureMatrixFromDiscovery} 喂进 M10 的
 * `resolveExposedTools`，并从 **已核实结论** 派生 M02 的 host 白名单
 * （{@link verifiedHostsFromDiscovery}）。诚实矩阵必须**一个 scoped 工具都不解锁、
 * 一个 host 都不放行**；只有"官方 host + 有可读正文"的探针才能翻转单个目标。
 *
 * ## 桥接为什么放测试里
 *
 * M01 的原生矩阵形状是 `capabilities[target].status`，M10 的工具暴露吃的是
 * `verdicts[capability].availability`——两者**没有** `src/` 内的桥接函数。M01 只在
 * `consumer.ts` 暴露了 `unlockVerdictOf` 这一条**归一化裁决**接口。本模块用它把
 * M01 矩阵翻成 M10 形状，正是 M01 集成请求 #3 所指的消费点：
 * 「任何想把某个能力标 verified 的下游都应走 M01 的失败关闭结论」。
 *
 * 所有探针都是**显式假设 fixture**：零网络、零时钟、零真实凭证、零手机号/地址。
 */

import {
  MEITUAN_CAPABILITIES,
  buildCapabilityMatrix,
  unlockVerdictOf,
  type CapabilityEvidence,
  type CapabilityMatrix as DiscoveryCapabilityMatrix,
  type CredentialRef,
  type DiscoveryTarget,
  type EvidenceProbe,
  type UnlockVerdict,
} from '../../../src/mobile-plugins/meituan/capability-discovery/index.js';
import {
  SCOPE_CAPABILITIES,
  type CapabilityMatrix as FeatureCapabilityMatrix,
  type ScopeAvailability,
  type ScopeCapability,
  type ScopeVerdict,
} from '../../../src/mobile-plugins/meituan/mobile-feature/index.js';
import type { VerifiedOfficialHost } from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';

/** 假设的"官方 host + 有可读正文"探针地址（**不代表**真实页面）。 */
export const OFFICIAL_READABLE_URL =
  'https://developer.meituan.com/zh/v2/dev/scope-manifest';

/** 假设的**非官方**页面地址（仅作负对照，绝不是常见第三方站点）。 */
export const NON_OFFICIAL_URL = 'https://third-party-of-meituan.example.com/api/scope';

/**
 * 假设的"下单路径 host"负向量：**没有任何证据**证明这些 host 属于官方授权范围。
 * 仅用于断言 M02 不会因为它们"看起来像美团"就放行（精确匹配、无后缀通配）。
 */
export const HYPOTHETICAL_ORDERING_HOSTS: readonly string[] = Object.freeze([
  'api.meituan.com',
  'order.meituan.com',
  'waimai.meituan.com',
]);

/** M10 无 scope 的本地确认工具 ID（`capability === null`，设计上恒 enabled）。 */
export const CONFIRM_TOOL_ID = 'cap.meituan.confirm';

/** 单个 scope 能力 → 它对应的 M10 工具 ID（pay 无工具，故意不在表内）。 */
export const TARGET_TOOLS: readonly { readonly target: ScopeCapability; readonly toolId: string }[] =
  Object.freeze([
    { target: 'search', toolId: 'cap.meituan.search' },
    { target: 'menu', toolId: 'cap.meituan.menu' },
    { target: 'address', toolId: 'cap.meituan.address' },
    { target: 'preview', toolId: 'cap.meituan.quote' },
    { target: 'submit', toolId: 'cap.meituan.submitOrder' },
    { target: 'query', toolId: 'cap.meituan.queryOrder' },
    { target: 'cancel', toolId: 'cap.meituan.cancelOrder' },
  ]);

/** 本批**真实**的诚实矩阵（真实只读探针 + 零证据 ⇒ 全 unverified）。 */
export function honestDiscoveryMatrix(): DiscoveryCapabilityMatrix {
  return buildCapabilityMatrix();
}

/** 造一条"官方 + 有可读正文"的假设探针（正对照；不代表真实抓取）。 */
export function officialReadableProbe(overrides: Partial<EvidenceProbe> = {}): EvidenceProbe {
  return Object.freeze({
    probeId: 'probe-official-readable',
    url: OFFICIAL_READABLE_URL,
    officialHost: true,
    method: 'unauthenticated-readonly-fetch' as const,
    reachable: true,
    readableContent: true,
    observedTitle: '假设：官方可读页面（fixture）',
    observedText: 'hypothetical official readable content — 仅用于失败关闭正负对照',
    conclusion: '假设探针：用于验证"只有官方可读探针才能支撑 verified"。',
    ...overrides,
  });
}

/** 一条把 target 挂到指定探针上的假设证据。 */
export function evidenceFor(
  target: DiscoveryTarget,
  probeId: string,
  url: string = OFFICIAL_READABLE_URL,
): CapabilityEvidence {
  return Object.freeze({
    target,
    probeId,
    evidenceUrl: url,
    note: '假设证据：仅用于构造器裁决。',
  });
}

/** 把 M01 裁决词归一化成 M10 的 `ScopeAvailability`（缺项/未知一律 `unverified`）。 */
function toAvailability(verdict: UnlockVerdict): ScopeAvailability {
  if (verdict === 'verified') {
    return 'verified';
  }
  if (verdict === 'denied') {
    return 'denied';
  }
  return 'unverified';
}

/**
 * **M01 → M10 桥接**：用 M01 的归一化裁决（`unlockVerdictOf`）把原生能力矩阵翻成
 * M10 `resolveExposedTools` 吃的 `verdicts[capability].availability` 形状。
 *
 * 失败关闭：任何 M01 不认的裁决词（含缺项 `'missing'`）都落到 `'unverified'`——绝不
 * 默认放行。`verified` 必须带 M01 的可读证据 URL（M10 校验器要求 verified 有证据引用）。
 */
export function featureMatrixFromDiscovery(
  discovery: DiscoveryCapabilityMatrix,
): FeatureCapabilityMatrix {
  const verdicts = {} as Record<ScopeCapability, ScopeVerdict>;
  for (const capability of SCOPE_CAPABILITIES) {
    const raw: UnlockVerdict = unlockVerdictOf(discovery, capability);
    const availability = toAvailability(raw);
    const scoped = discovery.capabilities[capability];
    verdicts[capability] = Object.freeze({
      capability,
      availability,
      evidenceRef: availability === 'verified' ? scoped.evidenceUrl : null,
      detail: scoped.note,
    });
  }
  return Object.freeze({ verdicts: Object.freeze(verdicts) });
}

/** 取 URL 的 host（小写）；非法 URL 返回 `null`（失败关闭）。 */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * **M01 → M02 桥接**：官方 host 只来自 M01 **已核实**结论的 `evidenceUrl`。
 * 未核实（honest 矩阵）⇒ 空列表；随后 `createEndpointPolicyFromDiscovery([])` 会抛错，
 * 绝不退化成"空 = 全放行"。
 */
export function verifiedHostsFromDiscovery(
  discovery: DiscoveryCapabilityMatrix,
): readonly VerifiedOfficialHost[] {
  const seen = new Set<string>();
  const out: VerifiedOfficialHost[] = [];
  for (const capability of MEITUAN_CAPABILITIES) {
    const verdict = discovery.capabilities[capability];
    if (verdict.status !== 'verified' || verdict.evidenceUrl === null) {
      continue;
    }
    const host = hostnameOf(verdict.evidenceUrl);
    if (host === null || seen.has(host)) {
      continue;
    }
    seen.add(host);
    out.push(Object.freeze({ host, status: 'verified' as const }));
  }
  return Object.freeze(out);
}

/**
 * 造一个"只是凭证引用、却夹带了违规推断字段"的对象（负对照）。
 * 类型上 `CredentialRef` 没有这些字段，因此用结构化 cast 注入，模拟一个想凭外形
 * 推断权限的坏消费者。
 */
export function credentialRefWithSignal(name: string, value: unknown): CredentialRef {
  const base: Record<string, unknown> = {
    present: true,
    contentRead: false,
    note: '含违规推断字段的凭证引用（负对照；不代表真实凭证）。',
  };
  base[name] = value;
  return base as unknown as CredentialRef;
}

/** 已 enabled 的工具 ID（按暴露顺序）。 */
export function enabledToolIds(tools: readonly { toolId: string; exposure: string }[]): readonly string[] {
  return tools.filter((tool) => tool.exposure === 'enabled').map((tool) => tool.toolId);
}
