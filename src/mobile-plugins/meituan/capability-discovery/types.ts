/**
 * M01 能力发现 —— 类型定义（零依赖、纯数据）。
 *
 * ## 本包边界（美团线工作书 MEITUAN.md / M01）
 *
 * 「指定 Token 平台指南、endpoint、凭证类型、scope/工具 schemas、有效期」，
 * 独立验收口径是「脱敏矩阵逐项标 search/menu/address/preview/submit/pay/query/cancel
 * 是否真实可用、允许手机直连与依据；**无证据用 unverified**」。
 *
 * 因此本包的核心不是"发现了很多能力"，而是把「**没证据就是 unverified**」做成
 * 类型层面的**失败关闭（fail-closed）**：`DiscoveryStatus` 只有两个值，
 * 而 `verified` 在 {@link ./matrix.ts} 的构造器里**必须**挂到一条"官方 host 且
 * 有可读正文"的探针上——否则一律降回 `unverified`。
 *
 * ## 三条结构性纪律
 *
 * 1. **只看证据，不看凭证外形**：key 长度、文件大小、包名、是否 MCP 之类的
 *    表面特征**不得**推断任何权限（工作书：不凭 key 长度或非官方包名称推断权限）。
 * 2. **发现阶段只读**：`credentialTransmitted` / `authenticatedRequestMade` /
 *    `orderOrPaymentSubmitted` 在类型上恒为字面量 `false`。
 * 3. **不记密钥**：`CredentialRef` 只有「是否存在」这一个布尔 + 「内容从未读取」，
 *    **没有**大小、前缀、指纹等任何可由之重建密钥的字段。
 */

/** 独立验收要求逐项标注的八个能力（顺序即矩阵的叙述顺序，固定）。 */
export const MEITUAN_CAPABILITIES = [
  'search',
  'menu',
  'address',
  'preview',
  'submit',
  'pay',
  'query',
  'cancel',
] as const;

/** 一个消费者外卖能力的名字。 */
export type MeituanCapability = (typeof MEITUAN_CAPABILITIES)[number];

/** 除八个能力外，同样必须给出结论的两个发现目标。 */
export const DISCOVERY_EXTRAS = ['protocol', 'mobileDirectConnectAllowed'] as const;

/** 所有需要给出 `verified | unverified` 结论的发现目标。 */
export const DISCOVERY_TARGETS = [...MEITUAN_CAPABILITIES, ...DISCOVERY_EXTRAS] as const;

/** 一个发现目标的联合类型。 */
export type DiscoveryTarget = (typeof DISCOVERY_TARGETS)[number];

/**
 * 发现结论。**只有两个值**——没有 `unknown` / `partial` / `assumed`。
 * 「读不到」与「读到了但没这条能力」在证据层面不同，但在**授权结论**上都只能记
 * `unverified`，直到有可读的官方证据为止。
 */
export type DiscoveryStatus = 'verified' | 'unverified';

/** 协议类型。默认 `unknown`——未经核实的 MCP/REST/SDK 一律不猜。 */
export type DiscoveryProtocol = 'mcp' | 'rest' | 'sdk' | 'unknown';

/**
 * 一次**只读**官方页面探测的真实记录。
 *
 * `observedText` 存的是**逐字可见文本**（例如只有一句页面标题），
 * `readableContent` 表示是否拿到了可用于判定能力的正文（endpoint / scope / schema）。
 */
export interface EvidenceProbe {
  /** 探针 ID（供能力证据引用）。 */
  readonly probeId: string;
  readonly url: string;
  /** 是否官方美团域名（由 {@link ./matrix.ts} 的 `isOfficialMeituanHost` 判定）。 */
  readonly officialHost: boolean;
  /** 固定为只读、未认证的抓取——本包**没有**其他探测方式。 */
  readonly method: 'unauthenticated-readonly-fetch';
  /** 页面是否可被取到（返回了文档，哪怕是空壳）。 */
  readonly reachable: boolean;
  /** 是否读到可用于判定能力的正文。空壳页 / 登录墙 ⇒ `false`。 */
  readonly readableContent: boolean;
  /** 可见标题（逐字）；取不到为 `null`。 */
  readonly observedTitle: string | null;
  /** 逐字可见文本（逐字引用，供追责）。 */
  readonly observedText: string;
  readonly conclusion: string;
}

/**
 * 把一条能力结论**挂到一条真实探针上**的证据。`probeId` 必须能在 `probes` 里找到，
 * 且该探针必须官方 + 可读，否则结论只能是 `unverified`。
 */
export interface CapabilityEvidence {
  readonly target: DiscoveryTarget;
  readonly probeId: string;
  /** 与探针一致的官方 URL（冗余记录，便于矩阵直接引用）。 */
  readonly evidenceUrl: string;
  readonly note: string;
}

/** 单个发现目标的最终结论。 */
export interface TargetConclusion {
  readonly target: DiscoveryTarget;
  readonly status: DiscoveryStatus;
  /** 仅 `verified` 时非空：可读官方证据的 URL。 */
  readonly evidenceUrl: string | null;
  /** 判定依据或降级原因（**必须**说明，不允许空）。 */
  readonly note: string;
}

/** 凭证**引用**——只记存在性，绝不记大小/内容/前缀。 */
export interface CredentialRef {
  /** 凭证来源是否已知存在。 */
  readonly present: boolean;
  /** 恒为 `false`：内容从未读取。 */
  readonly contentRead: false;
  readonly note: string;
}

/** 协议结论（比 `TargetConclusion` 多一个 `kind`）。 */
export interface ProtocolConclusion {
  readonly target: 'protocol';
  readonly kind: DiscoveryProtocol;
  readonly status: DiscoveryStatus;
  readonly evidenceUrl: string | null;
  readonly note: string;
}

/** 手机直连是否被平台允许的结论。 */
export interface MobileDirectConclusion {
  readonly target: 'mobileDirectConnectAllowed';
  readonly status: DiscoveryStatus;
  readonly evidenceUrl: string | null;
  readonly note: string;
}

/**
 * 脱敏能力矩阵。**这是 M01 的唯一交付物**：逐项给出八个能力 + 协议 + 手机直连的
 * `verified | unverified`，外加三条恒为 `false` 的只读不变量、探针原文与凭证引用。
 */
export interface CapabilityMatrix {
  readonly packageId: 'M01';
  readonly schemaVersion: 'mobile-v1';
  /** 恒 `false`：全程未发送任何凭证。 */
  readonly credentialTransmitted: false;
  /** 恒 `false`：全程未做认证请求（未登录）。 */
  readonly authenticatedRequestMade: false;
  /** 恒 `false`：全程未提交订单、未支付。 */
  readonly orderOrPaymentSubmitted: false;
  readonly credentialRef: CredentialRef | null;
  readonly capabilities: Readonly<Record<MeituanCapability, TargetConclusion>>;
  readonly protocol: ProtocolConclusion;
  readonly mobileDirectConnectAllowed: MobileDirectConclusion;
  /** 实际使用（并已记录原文）的探针。 */
  readonly probes: readonly EvidenceProbe[];
  /** 是否所有目标都仍是 `unverified`（首批的真实结论为 `true`）。 */
  readonly allUnverified: boolean;
}
