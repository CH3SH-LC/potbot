/**
 * M10 手机功能包 —— **词表、数据结构与端口**（零依赖、纯类型 + 纯函数 + 少量纯逻辑校验）。
 *
 * ## 本包在美团线里的位置
 *
 * M04（购物车/报价）、M05（地址/配送）、M07（下单提交）、M09（订单生命周期）各自是
 * **一个模型**；M10 是它们的**装配点**：把业务 Agent 工具、模板 manifest、前端可消费的
 * ViewModel、一个可独立运行的宿主与**证据采集**串成一条可跑通的纵切。
 *
 * ## M10 要关掉的两个洞
 *
 * 1. **工具暴露超出实际 scope**。工作书 M01 要求逐项核实
 *    `search/menu/address/preview/submit/pay/query/cancel` 是否真实可用。在没有任何
 *    证据前，把 `submitOrder` 之类的工具挂出来会诱导模型去调一个不存在的平台能力。
 *    本包用 {@link CapabilityMatrix}（逐项 `verified` / `unverified` / `denied`）作为
 *    **唯一**的暴露开关：只有 `verified` 的能力对应的工具才 `enabled`；其余一律 `blocked`
 *    并带可机读原因。**支付（pay）在任何情况下都不是一个工具**——见 `PAYMENT_IS_NOT_A_TOOL`。
 *
 * 2. **fixture 被当成真实路径**。工作书写明「独立 fixture 可以跑通全部状态；真实手机
 *    旅程单独记录，不能把 fixture 接入生产开关」。本包把这条纪律做成**结构性**的：
 *    - 宿主在构造时就被钉死为 `fixture` 或 `real`，**没有**任何运行期开关能翻转它；
 *    - 证据台账在构造时绑定 `mode`，`fixture` 台账**结构上无法**写入 `confirmed`
 *      与 `payment_confirmed` 这类只有真实平台回读才可能的状态；
 *    - `real` 台账需要一枚由模块私有 `WeakSet` 登记的可信 `RealTransportAttestation`
 *      （照 M07 `createAuthorizationRef` 的同一纪律）——伪造的对象一律
 *      `untrusted_real_attestation`。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **不接真实美团接口**：未登录、无 token、无工具清单（M01 尚未交付）；本包内的宿主与
 *   端口全是 fixture，**零网络**。
 * - **未在真机验证**；`createRealFeatureHost` 是**诚实存根**：直接抛
 *   `real_host_not_wired`，等 M01/M02 核实出官方 endpoint 与手机直连能力后再实现。
 * - **支付不落地**：pay 能力无工具、无端口；平台支付页/回跳归 M08，本包不代填凭据。
 */

// ---------------------------------------------------------------------------
// 能力 scope（工作书 M01 的逐项矩阵）
// ---------------------------------------------------------------------------

/** 工作书要求逐项核实的能力（顺序照工作书 M01 行的列举）。 */
export const SCOPE_CAPABILITIES = [
  'search',
  'menu',
  'address',
  'preview',
  'submit',
  'pay',
  'query',
  'cancel',
] as const;

export type ScopeCapability = (typeof SCOPE_CAPABILITIES)[number];

/**
 * 单项能力的核实结论。
 *
 * - `verified`：有证据（官方指南 / 已授权接口实测）证明该 Token 在手机上真实可用；
 * - `unverified`：**尚未**取得任何证据（M01 未交付时的默认值）；
 * - `denied`：有证据表明该 Token **没有**该权限（如要求开发者服务端签名）。
 *
 * 只有 `verified` 才会把对应工具置为 `enabled`——`unverified` 与 `denied` 都是
 * `blocked`（前者"等证据"，后者"确实没有"），但原因不同、可机读区分。
 */
export const SCOPE_AVAILABILITIES = ['verified', 'unverified', 'denied'] as const;
export type ScopeAvailability = (typeof SCOPE_AVAILABILITIES)[number];

/** 单项能力的核实结论（`evidenceRef` 在 `unverified` 时恒为 `null`：没有证据就是没有）。 */
export interface ScopeVerdict {
  readonly capability: ScopeCapability;
  readonly availability: ScopeAvailability;
  /** 证据引用（M01 的脱敏矩阵条目）；`unverified` 时必须为 `null`。 */
  readonly evidenceRef: string | null;
  readonly detail: string;
}

/** 逐项核实矩阵：**每个**能力都必须有一条结论（不得缺项，缺项即 `unverified` 语义缺失）。 */
export interface CapabilityMatrix {
  readonly verdicts: Readonly<Record<ScopeCapability, ScopeVerdict>>;
}

/** 造一个"全部未核实"的矩阵——M01 未交付时的**诚实默认**。 */
export function unverifiedMatrix(detail = 'M01 尚未核实：无官方指南/工具清单证据'): CapabilityMatrix {
  const verdicts = {} as Record<ScopeCapability, ScopeVerdict>;
  for (const capability of SCOPE_CAPABILITIES) {
    verdicts[capability] = Object.freeze({
      capability,
      availability: 'unverified' as const,
      evidenceRef: null,
      detail,
    });
  }
  return Object.freeze({ verdicts: Object.freeze(verdicts) });
}

/** 校验矩阵：每个能力都在场；`unverified` 不得带证据引用。返回问题清单（空 = 通过）。 */
export function validateCapabilityMatrix(matrix: CapabilityMatrix): readonly string[] {
  const problems: string[] = [];
  for (const capability of SCOPE_CAPABILITIES) {
    const verdict = matrix.verdicts[capability];
    if (verdict === undefined) {
      problems.push(`能力 ${capability} 缺少核实结论（缺项按 unverified 语义缺失处理）`);
      continue;
    }
    if (verdict.capability !== capability) {
      problems.push(`能力 ${capability} 的结论挂错键：verdict.capability=${verdict.capability}`);
    }
    if (!(SCOPE_AVAILABILITIES as readonly string[]).includes(verdict.availability)) {
      problems.push(`能力 ${capability} 的 availability 非法：${String(verdict.availability)}`);
    }
    if (verdict.availability === 'unverified' && verdict.evidenceRef !== null) {
      problems.push(`能力 ${capability} 标 unverified 却带证据引用 ${String(verdict.evidenceRef)}：不诚实`);
    }
    if (verdict.availability === 'verified' && (verdict.evidenceRef === null || verdict.evidenceRef.trim() === '')) {
      problems.push(`能力 ${capability} 标 verified 却没有证据引用：不得无证据声明可用`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 工具暴露
// ---------------------------------------------------------------------------

/** 工具暴露结论：`enabled` 才会出现在交给模型的工具清单里。 */
export const TOOL_EXPOSURES = ['enabled', 'blocked'] as const;
export type ToolExposure = (typeof TOOL_EXPOSURES)[number];

/** 暴露原因码（可机读，供前端/验收逐条比对）。 */
export const EXPOSURE_REASONS = [
  'scope_verified',
  'scope_unverified',
  'scope_denied',
  'no_scope_capability',
] as const;
export type ExposureReason = (typeof EXPOSURE_REASONS)[number];

// ---------------------------------------------------------------------------
// 旅程阶段与证据（工作书「真实下单验收条件」的六个命名阶段）
// ---------------------------------------------------------------------------

/**
 * 证据阶段，**逐字**取自工作书 MEITUAN.md 的验收条件：
 * `capability_discovered / on_device_transport / user_authorized / order_submitted /
 * payment_confirmed / order_readback`。**六个必须分别记录**，不得只填一个 ok。
 */
export const JOURNEY_STAGES = [
  'capability_discovered',
  'on_device_transport',
  'user_authorized',
  'order_submitted',
  'payment_confirmed',
  'order_readback',
] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

/** 证据模式：与契约 `$defs.verificationMode` 逐字对齐。 */
export const EVIDENCE_MODES = ['fixture', 'real'] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

/** 外部回执状态：与契约 `vocab/status.json` 的外部回执词表逐字对齐。 */
export const EVIDENCE_STATES = [
  'prepared',
  'authorized',
  'submitting',
  'submitted',
  'unknown',
  'confirmed',
  'failed',
  'cancelled',
] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/** **唯一**可以声称"外部动作已完成"的状态（契约不变量 2）。 */
export function mayClaimCompleted(state: EvidenceState): boolean {
  return state === 'confirmed';
}

/**
 * 一条旅程证据。字段对齐工作书「至少保存脱敏 requestRef、externalOrderId、账号引用、
 * 金额/币种、报价及参数摘要、授权时间、查询时间/状态和错误原因」。
 *
 * **脱敏**：本结构**没有**手机号明文、没有地址明文、没有密钥/凭据字段。
 */
export interface JourneyEvidenceRecord {
  readonly recordId: string;
  readonly journeyId: string;
  /** 该条证据所属模式，由台账在构造时决定，**不由调用方传**（防止自己给自己盖章）。 */
  readonly mode: EvidenceMode;
  readonly stage: JourneyStage;
  readonly observedState: EvidenceState;
  readonly requestRef: string | null;
  readonly externalOrderId: string | null;
  /** 账号引用（如 `acct:meituan:7788`），不是凭据。 */
  readonly accountRef: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly quoteRef: string | null;
  readonly paramsDigest: string | null;
  /** 观测时刻（注入时钟域）。 */
  readonly observedAt: number;
  readonly detail: string;
  readonly errorReason: string | null;
}

/** 记录一条证据时，调用方**能**提供的字段（`mode` 与 `recordId`/`observedAt` 不在其中）。 */
export interface JourneyEvidenceInput {
  readonly journeyId: string;
  readonly stage: JourneyStage;
  readonly observedState: EvidenceState;
  readonly requestRef?: string | null;
  readonly externalOrderId?: string | null;
  readonly accountRef?: string | null;
  readonly amountMinor?: number | null;
  readonly currency?: string | null;
  readonly quoteRef?: string | null;
  readonly paramsDigest?: string | null;
  readonly detail: string;
  readonly errorReason?: string | null;
}

/** 逐阶段证据小结：**每个阶段分别出现**，没有合并的成功布尔。 */
export interface EvidenceStageSummary {
  readonly stage: JourneyStage;
  readonly present: boolean;
  readonly observedState: EvidenceState | null;
  readonly detail: string | null;
}

export interface EvidenceSummary {
  readonly mode: EvidenceMode;
  readonly journeyId: string | null;
  readonly total: number;
  /** 按 `JOURNEY_STAGES` 顺序的逐阶段小结。 */
  readonly stages: readonly EvidenceStageSummary[];
  /** 六阶段是否**都**有记录（仅描述"齐全"，**不是**"验证通过"）。 */
  readonly allStagesPresent: boolean;
  readonly confirmedCount: number;
}

// ---------------------------------------------------------------------------
// 真机可信凭证（照 M07 一次性授权引用的同一纪律）
// ---------------------------------------------------------------------------

/**
 * 真机传输证据声明。**只有**在真机上、以真实网络发过请求才应出现这些事实。
 *
 * 本包**不产生**真机传输；结构照契约 `external-receipt` 的 `verificationMode`
 * 与 `evidenceRef` 语义，用于将来 M02 交付后由真实宿主签发。
 */
export interface RealTransportProof {
  /** 必须逐字为 `real`——fixture 传输不得声明为真。 */
  readonly verificationMode: 'real';
  /** 脱敏设备引用（如 `device:honor-<hash>`），不得含序列号明文。 */
  readonly deviceRef: string;
  /** 手机发起请求的目标 host（必须是官方授权 host，脱敏记录）。 */
  readonly requestHostRef: string;
  /** 观测引用（网络记录/回执的脱敏引用）。 */
  readonly transportEvidenceRef: string;
  readonly observedAt: number;
}

/**
 * 可信真机传输凭证。由 {@link import('./evidence.js').issueRealTransportAttestation}
 * 签发并登记进模块私有 `WeakSet`；形状相同但未登记的对象一律不可信。
 */
export interface RealTransportAttestation {
  readonly proof: RealTransportProof;
  readonly issuedAt: number;
}

declare const realAttestationBrand: unique symbol;
/** 品牌类型：让"凭空构造的 `RealTransportAttestation`"在类型层面也走不通。 */
export type BrandedRealAttestation = RealTransportAttestation & {
  readonly [realAttestationBrand]: true;
};

// ---------------------------------------------------------------------------
// 端口（注入；本包自身零网络）
// ---------------------------------------------------------------------------

/** 注入时钟（禁止直接读墙钟）。 */
export interface Clock {
  now(): number;
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

/** 宿主模式：构造时钉死，无运行期开关。 */
export const HOST_MODES = ['fixture', 'real'] as const;
export type HostMode = (typeof HOST_MODES)[number];

/** 暴露给模型的工具条目（含暴露结论与原因）。 */
export interface ExposedTool {
  readonly toolId: string;
  /** 该工具所属能力；`null` = 无对应 scope 能力（永不因 scope 被阻断）。 */
  readonly capability: ScopeCapability | null;
  readonly exposure: ToolExposure;
  readonly reason: ExposureReason;
  readonly detail: string;
  /** 原始工具声明（R241），供上层直接交给 ModelPort 的 `toolSchemas`。 */
  readonly contract: import('../../../adapters/clock/action-contract.js').ToolContract;
}
