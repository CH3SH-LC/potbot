/**
 * `transport-attestation` —— 真机传输凭证（RealTransportAttestation）的**词表与数据结构**。
 *
 * ## 本包在美团线里的位置（M-I19）
 *
 * 工作书要求「fixture 与真实旅程结构性分离」：真实台账 / 真机宿主**只能**由一枚
 * 已在真机上发出过真实请求的凭证开启。此前这枚凭证的定义、签发与验证分散在
 * M10 `mobile-feature/evidence.ts` 里（模块私有 WeakSet），生产端（M-I02 的传输层）
 * 却没有一处**规范来源**。本包把这条缝抽成**唯一**的签发 / 验证 seam：
 *
 * - **生产端**：M-I02 / M02 的传输层在真机发出并**送达**请求后，调用
 *   {@link import('./attestation.js').issueRealTransportAttestationFromDelivered} 签发；
 * - **消费端**：M-I10 的 `createRealFeatureHost` / `createRealEvidenceLedger` 调用
 *   {@link import('./attestation.js').assertTrustedRealTransportAttestation} 验证。
 *
 * ## 两条硬纪律
 *
 * 1. **可信根 = 模块私有 WeakSet**（照 M07 `createAuthorizationRef`、M10 的同一纪律）。
 *    形状完全相同的字面量、`{...attestation}` 拷贝、`JSON.parse(JSON.stringify(...))`
 *    都不是同一对象 ⇒ 一律不可信。逐字段校验挡不住照抄形状，只有**来源登记**挡得住。
 * 2. **无已核实能力就不得签发**（M01 结论：全部 unverified）。`verificationMode: 'real'`
 *    **由签发器设置**，不由调用方传；且签发前必须注入一份**含至少一项 verified 能力**
 *    的矩阵——诚实默认（全部 unverified）下签发**必然失败**，于是 fixture 通道
 *    （用 `unverifiedMatrix()`）结构上无法凭自造对象开启真实通道。
 *
 * ## 明确未做
 *
 * 本包**零依赖、零网络、零真实凭证**：它只登记一份上游给出的传输事实，不接受、不保存
 * 任何令牌 / 手机号 / 地址 / 设备序列号明文。真实 endpoint 由 M01 核实、真机原生 HTTPS
 * 由 M02/K01 接入——本包不替它们做任何结论。
 */

// ---------------------------------------------------------------------------
// 真机传输事实（生产端提供；verificationMode 不由调用方传）
// ---------------------------------------------------------------------------

/**
 * 真机设备上的传输事实：**脱敏引用**，不含序列号 / 手机号 / 令牌明文。
 *
 * 刻意**没有** `verificationMode` 字段：该字段由签发器在通过能力矩阵闸门后设置，
 * 调用方无法自称"这是 real"。这是"fixture 不得声明为真"的结构性落点。
 */
export interface OnDeviceTransportFact {
  /** 脱敏设备引用（如 `device:honor-<hash>`），不得含序列号明文。 */
  readonly deviceRef: string;
  /** 手机发起请求的目标 host（官方授权 host 的脱敏引用，如 `host:api.example`）。 */
  readonly requestHostRef: string;
  /** 观测引用（网络记录 / 回执的脱敏引用）。 */
  readonly transportEvidenceRef: string;
  /** 观测时刻（注入时钟域）。 */
  readonly observedAt: number;
}

/**
 * 结构兼容 M02 `TransportEvidence` 的**脱敏证据摘要**（只取本 seam 需要的字段）。
 *
 * `redacted: true` 与 `plaintextSecretFields: 0` 是 M02 自证的两条不变量；本 seam 复用
 * 它们作为"这份传输证据里没有明文秘密"的机读凭据，不重新引入跨包依赖。
 */
export interface OnDeviceTransportEvidence {
  readonly host: string;
  readonly redacted: true;
  readonly plaintextSecretFields: 0;
}

/**
 * 结构兼容 M02 `TransportDelivered` 的**已送达**传输结果。
 *
 * 只有真实送达且协议合法（`delivered === true && ok === true`）才满足：
 * **未送达**（`delivered: false`，例如策略拒绝 / 未发先败）不能证明真机传输，
 * 因此不能用来签发凭证。
 */
export interface OnDeviceDeliveredTransport {
  readonly delivered: true;
  readonly ok: true;
  readonly host: string;
  readonly evidence: OnDeviceTransportEvidence;
}

// ---------------------------------------------------------------------------
// 凭证（与 M10 `RealTransportProof` / `RealTransportAttestation` 结构一致）
// ---------------------------------------------------------------------------

/** 真机传输证据声明（**结构逐字对齐** M10 `mobile-feature/types.ts`）。 */
export interface RealTransportProof {
  /** 必须逐字为 `real`——由签发器设置，fixture 传输不得声明为真。 */
  readonly verificationMode: 'real';
  readonly deviceRef: string;
  readonly requestHostRef: string;
  readonly transportEvidenceRef: string;
  readonly observedAt: number;
}

/**
 * 可信真机传输凭证：由 {@link import('./attestation.js').issueRealTransportAttestation}
 * 签发并登记进模块私有 `WeakSet`；形状相同但未登记的对象一律不可信。
 */
export interface RealTransportAttestation {
  readonly proof: RealTransportProof;
  readonly issuedAt: number;
}

declare const realTransportAttestationBrand: unique symbol;
/** 品牌类型：让"凭空构造的凭证"在类型层面也走不通（运行期由 WeakSet 兜底）。 */
export type BrandedRealTransportAttestation = RealTransportAttestation & {
  readonly [realTransportAttestationBrand]: true;
};

// ---------------------------------------------------------------------------
// 能力矩阵（注入；结构兼容 M10 `CapabilityMatrix`）
// ---------------------------------------------------------------------------

/** 单项能力的核实结论（逐字对齐 M10 `ScopeAvailability`）。 */
export const CAPABILITY_AVAILABILITIES = ['verified', 'unverified', 'denied'] as const;
export type CapabilityAvailability = (typeof CAPABILITY_AVAILABILITIES)[number];

/** 单项核实结论（同样结构兼容 M10 `ScopeVerdict`）。 */
export interface AttestationCapabilityVerdict {
  readonly capability?: string;
  readonly availability: CapabilityAvailability;
  /** 证据引用；`verified` 必须有非空引用，`unverified` 必须为 `null`。 */
  readonly evidenceRef?: string | null;
  readonly detail?: string;
}

/**
 * 一份**强类型**能力矩阵（供本包调用方构造时用）。
 */
export interface AttestationCapabilityMatrix {
  readonly verdicts: Readonly<Record<string, AttestationCapabilityVerdict>>;
}

/**
 * 签发器**实际接受**的矩阵输入：任何带 `verdicts` 的对象。
 *
 * 这样 M01（经 M10）的 `CapabilityMatrix` 可**原样**传入，无需适配层或 `as`（本包不 import
 * mobile-feature，避免反向跨包依赖）。代价是类型层面宽松，因此 `verdicts` 的每一处在
 * {@link import('./capability.js').verifiedCapabilities} 里逐条**运行期校验**（非法条目不计数，
 * 而不是抛错），保证"无已核实能力 ⇒ 拒绝签发"这条闸门无法被残缺矩阵绕过。
 */
export interface AttestationCapabilityMatrixInput {
  readonly verdicts?: unknown;
}

export type CapabilityMatrixInput =
  | AttestationCapabilityMatrixInput
  | AttestationCapabilityMatrix
  | null
  | undefined;
