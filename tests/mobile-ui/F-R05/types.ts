/**
 * F-R05 —— 十二条设计验收旅程 ↔ 真实事件映射的类型与操作绑定。
 *
 * 目标（FRONTEND.md 备用包表 F-R05 行）：把 design-07 §11 的十二条关键设计验收旅程
 * 映射到**公共契约的真实事件**（`command` / `event` / `external-receipt` / `facts-port`
 * / `template-manifest`），并机器化检查「fixture 无法冒充产品成功」。
 *
 * 设计纪律（与 README「关键不变量」逐条对齐）：
 *   - 契约不变量 1：`verificationMode = fixture` 的产物**不得**签发真实订单/支付/手机通过回执；
 *     回执 `fixture` + `observedState = confirmed` 会被 schema 的 `oneOf` 直接拒绝。
 *   - 契约不变量 3（fail-closed）：缺执行器 ⇒ 不得产出 `succeeded`；
 *     `event.status = succeeded` 必须携带 `resultRef`。
 *   - 因此本包把「一个旅程被真实事件证明」与「产物在契约里是否合法」绑在一起：
 *     凡本包判为 `masquerade` 的产物，契约校验器（`contracts/mobile-v1/validate.mjs`）
 *     必须同样报错；凡本包判为 `real` 的成功产物，校验器必须通过。
 *
 * 本包**只读消费** `contracts/mobile-v1/types.ts`，不修改任何共享文件。
 * 本包不渲染、不发网络、不读文件、不触碰时钟或随机数（证据为纯数据，可逐字节比较）。
 */

import type {
  CommandOperation,
  EventStatus,
  ExternalReceiptState,
  VerificationMode,
} from '../../../contracts/mobile-v1/types.js';

export type {
  CommandOperation,
  EventStatus,
  ExternalReceiptState,
  VerificationMode,
};

/** 十二条旅程的稳定编号（与 design-07 §11 的列表顺序一一对应）。 */
export type JourneyId =
  | 'J01'
  | 'J02'
  | 'J03'
  | 'J04'
  | 'J05'
  | 'J06'
  | 'J07'
  | 'J08'
  | 'J09'
  | 'J10'
  | 'J11'
  | 'J12';

/** 证据产物种类——对应公共契约里的四类真实事件/端口对象。 */
export type ArtifactKind = 'event' | 'receipt' | 'facts' | 'manifest';

// ---------------------------------------------------------------------------
// 证据产物（每类的形状即对应 schema 的可断言子集）
// ---------------------------------------------------------------------------

/** `event.schema.json` 的可断言子集。`verificationMode` 在 schema 中可选。 */
export interface EventArtifact {
  readonly type: 'event';
  readonly eventId: string;
  readonly commandId: string;
  readonly operation: CommandOperation;
  readonly status: EventStatus;
  readonly revision: number;
  /** fail-closed：`status === 'succeeded'` 必须非空。 */
  readonly resultRef?: string;
  readonly verificationMode?: VerificationMode;
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly targetId?: string;
  /** `error.code`（失败路径用）。 */
  readonly errorCode?: string;
}

/** `external-receipt.schema.json` 的可断言子集。`verificationMode` 实质必需（由 oneOf 强制）。 */
export interface ReceiptArtifact {
  readonly type: 'receipt';
  readonly actionId: string;
  readonly observedState: ExternalReceiptState;
  readonly verificationMode: VerificationMode;
  readonly provider: string;
  readonly requestRef: string;
  readonly externalId: string;
  readonly evidenceRef: string;
}

/** `facts-port.schema.json` 的可断言子集（无 verificationMode 字段）。 */
export interface FactsArtifact {
  readonly type: 'facts';
  readonly snapshotId: string;
  readonly revision: number;
  /** `facts-port.schema.json` 没有 verificationMode 字段；这里用外部标记承载证据层级。 */
  readonly evidenceLayer: 'real' | 'fixture';
}

/** `template-manifest.schema.json` 的 probe 子集：四态必须分别报告，不得合并。 */
export interface ManifestArtifact {
  readonly type: 'manifest';
  readonly id: string;
  readonly probe: {
    readonly installed: boolean;
    readonly enabled: boolean;
    readonly authorized: boolean;
    readonly portReady: boolean;
    readonly verificationMode: VerificationMode;
  };
  /**
   * 若为 true，表示产物试图用一个 `ready` 合并字段冒充四态就绪——
   * 契约根对象 `additionalProperties: false` 会拒绝，本包亦判 masquerade。
   */
  readonly mergedReady?: boolean;
}

export type Artifact = EventArtifact | ReceiptArtifact | FactsArtifact | ManifestArtifact;

/** 一次旅程观察：喂给审计器的原始证据集合。 */
export interface JourneyObservation {
  readonly journeys: readonly JourneyId[];
  readonly artifacts: readonly Artifact[];
  /** 说明性注释（不参与判定）。 */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// 旅程定义
// ---------------------------------------------------------------------------

/** 槽位判定的证据状态。优先级（高 → 低）：masquerade > real > fixture > unmarked > missing。 */
export type EvidenceStatus = 'real' | 'fixture' | 'unmarked' | 'missing' | 'masquerade';

/** 一个证据槽：某类产物里的某个可判定条件，是某条旅程被真实事件证明的必要证据。 */
export interface EvidenceSlot {
  readonly id: string;
  readonly artifact: ArtifactKind;
  /**
   * 该槽是否断言「产品成功」。仅当 `guard === true` 时才对契约不变量做 masquerade 检查；
   * 断言失败路径（conflict / failed / cancelled / unknown）的槽 `guard === false`。
   */
  readonly guard: boolean;
  /** 需要至少 N 个匹配产物（默认 1）。 */
  readonly minCount?: number;
  /** 事件类：需要至少 N 个不同 `targetId|conversationId|taskId` 的匹配产物。 */
  readonly minDistinctTargets?: number;
  /** 事件类断言：要求的 `status`。缺省表示任意状态。 */
  readonly eventStatus?: EventStatus;
  /** 回执类断言：要求的 `observedState`。 */
  readonly receiptState?: ExternalReceiptState;
  /** 清单类断言：要求 `probe.authorized === true`。 */
  readonly manifestAuthorized?: boolean;
  readonly description: string;
}

/** 旅程级不变量（跨槽的时序约束）。 */
export type JourneyInvariant =
  /** 同一 actionId 的 submitting/submitted/confirmed 回执**至多一次**——双击/重放不得重复提交。 */
  | { readonly kind: 'no-duplicate-submission' }
  /** 同一 target 的事件 revision 必须随 seq 单调不减——迟到的旧轮次不得覆盖。 */
  | { readonly kind: 'monotonic-events' };

export interface JourneyDefinition {
  readonly id: JourneyId;
  /** design-07 §11 的标题。 */
  readonly title: string;
  /** design-07 §11 引用的需求编号（如 A13–14 / CHAT-04）。 */
  readonly requirementCodes: readonly string[];
  readonly slots: readonly EvidenceSlot[];
  readonly invariants?: readonly JourneyInvariant[];
}

// ---------------------------------------------------------------------------
// 审计结果
// ---------------------------------------------------------------------------

export interface SlotVerdict {
  readonly slotId: string;
  readonly status: EvidenceStatus;
  /** 参与判定的产物 id（eventId / actionId / snapshotId / manifest id）。 */
  readonly matchedIds: readonly string[];
  readonly reason: string;
}

export interface InvariantVerdict {
  readonly kind: JourneyInvariant['kind'];
  readonly ok: boolean;
  readonly reason: string;
}

export interface JourneyVerdict {
  readonly journeyId: JourneyId;
  readonly title: string;
  readonly requirementCodes: readonly string[];
  readonly status: EvidenceStatus;
  readonly slots: readonly SlotVerdict[];
  readonly invariants: readonly InvariantVerdict[];
  /** 仅当 status === 'real' 且全部不变量成立时为 true。 */
  readonly productSuccess: boolean;
  readonly summary: string;
}

export interface AuditReport {
  readonly schemaVersion: 'mobile-v1';
  readonly journeys: readonly JourneyVerdict[];
  readonly realCount: number;
  readonly fixtureOnlyCount: number;
  readonly unmarkedCount: number;
  readonly missingCount: number;
  readonly masqueradeCount: number;
  /**
   * 报告级 masquerade 产物 id 列表：观察中**任意位置**出现「断言成功却违反契约不变量」
   * 的产物（fixture 回执 confirmed / succeeded 事件缺 resultRef / 清单合并四态就绪）。
   * 与槽位级 masquerade 互补——即使没有槽位匹配它，也不得被当作产品成功。
   */
  readonly masqueradeArtifacts: readonly string[];
  /** 十二条旅程是否**全部**可被真实事件证成为产品成功，且无任何 masquerade。 */
  readonly productSuccess: boolean;
  /** 本包证据**未覆盖**的验证层（如实列出，不声称已做）。 */
  readonly unverifiedLayers: readonly string[];
  readonly summary: string;
}

/** 证据严重度排序（数字越大越严重），用于旅程级汇总与排序。 */
export const EVIDENCE_SEVERITY: Readonly<Record<EvidenceStatus, number>> = {
  real: 0,
  fixture: 1,
  unmarked: 2,
  missing: 3,
  masquerade: 4,
};
