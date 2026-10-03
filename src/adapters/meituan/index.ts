/**
 * FA-M 美团适配器 —— **产品可调用入口**（MT-01–08）。
 *
 * ⚠️ 本批对美团**只做合同与不变量**（任务约定 + 合同 MT-02「不能用模型编候选」）：
 * 在**没有真实接口与账号**时，任何"能查候选"的实现都只能是编造，故**不实现**。
 *
 * 本入口导出的能力分两类：
 * 1. **可静态保证的部分**（已实现且有本机证据）：七态结算、不购买/不支付、不编造候选、
 *    规则筛选与排序、交接前校验分类；
 * 2. **未就绪部分**（如实登记原因）：真实候选查询、详情读取、受控链接。
 */

import {
  describeSearchStatus,
  searchCandidates,
  type AuthorizedMeituanSearchPort,
  type CandidateSearchResult,
  type SearchQuery,
} from './candidates.js';
import { meituanReadinessReport, type MeituanNotReadyCapability } from './not-ready.js';
import {
  classifyHandoffTarget,
  handoffToTarget,
  recordExternalInvalidation,
  recordExternalOutcome,
  recordUserReport,
  type HandoffReadiness,
  type HandoffResult,
  type HandoffTarget,
  type MeituanHandoffPort,
  type TargetCheck,
} from './handoff.js';
import type { SubitemReadiness } from '../clock/readiness.js';
import type { ActionState } from '../clock/action-contract.js';

export interface MeituanAdapterOptions {
  /** 已授权的搜索端口；**默认没有**（本批无账号，故为 null）。 */
  readonly search?: AuthorizedMeituanSearchPort | null;
  /** 目标页打开端口；未装配时交接会**抛出**（不静默假装已交接）。 */
  readonly handoffPort?: MeituanHandoffPort;
}

export interface MeituanAdapter {
  search(query: SearchQuery, fetchedAtMs: number): Promise<CandidateSearchResult>;
  classifyTarget(
    target: HandoffTarget,
    check: TargetCheck,
    currentSelectionRevision: number,
    nowMs: number,
  ): HandoffReadiness;
  handoff(readiness: HandoffReadiness): Promise<HandoffResult>;
  recordOutcome(from: ActionState, outcome: Parameters<typeof recordExternalOutcome>[1]): HandoffResult;
  recordUserReport(from: ActionState, userWords: string): HandoffResult;
  recordInvalidation(from: ActionState, detail: string): HandoffResult;
  describeStatus: typeof describeSearchStatus;
  readiness(): {
    readonly subitems: readonly SubitemReadiness[];
    readonly capabilities: readonly MeituanNotReadyCapability[];
  };
}

export function createMeituanAdapter(options: MeituanAdapterOptions = {}): MeituanAdapter {
  return {
    search(query, fetchedAtMs) {
      return searchCandidates(options.search ?? null, query, fetchedAtMs);
    },
    classifyTarget: classifyHandoffTarget,
    async handoff(readiness) {
      if (options.handoffPort === undefined) {
        throw new Error(
          '未装配目标页打开端口（MeituanHandoffPort）：本批不实现 Android 深链打开（apps/android 归 A 负责人）。' +
            '不得在没有端口的情况下假装已交接。',
        );
      }
      return handoffToTarget(options.handoffPort, readiness);
    },
    recordOutcome: recordExternalOutcome,
    recordUserReport,
    recordInvalidation: recordExternalInvalidation,
    describeStatus: describeSearchStatus,
    readiness() {
      return meituanReadinessReport();
    },
  };
}

export {
  MEITUAN_TOOLS,
  SEARCH_TOOL,
  DETAIL_TOOL,
  HANDOFF_TOOL,
  MEITUAN_TEMPLATE,
  FORBIDDEN_MEITUAN_ACTIONS,
  validateMeituanTools,
  assertNotPurchaseAction,
  externalResultWithoutReadback,
  isAllowedSideEffect,
} from './contract.js';

export {
  searchCandidates,
  normalizeCandidate,
  validateCandidate,
  candidatesFromUserShare,
  partitionBySource,
  describeVisibility,
  applyRules,
  rankCandidates,
  exportCandidateFacts,
  describeSearchStatus,
  known,
  unknown,
} from './candidates.js';

export {
  classifyHandoffTarget,
  handoffToTarget,
  recordExternalOutcome,
  recordUserReport,
  recordExternalInvalidation,
} from './handoff.js';

export { MEITUAN_SUBITEMS, MEITUAN_NOT_READY, meituanReadinessReport } from './not-ready.js';

export type {
  Candidate,
  CandidateProvenance,
  CandidatePrice,
  CandidateSearchResult,
  KnownValue,
  RawCandidate,
  SearchQuery,
  QueryVisibility,
  UserRules,
  HardRule,
  SoftRule,
  RuleOutcome,
  UserSharedItem,
  ExportedCandidateFact,
  AuthorizedMeituanSearchPort,
} from './candidates.js';
export type {
  HandoffTarget,
  TargetCheck,
  HandoffReadiness,
  HandoffResult,
  MeituanHandoffPort,
  ExternalOutcome,
} from './handoff.js';

// ---------------------------------------------------------------------------
// FA-WIRE-ADAPTERS-REACH：补齐 6 个**产品不可达**模块的 barrel 导出
// ---------------------------------------------------------------------------
//
// 最终普查点名：以下 6 个模块此前只在包内测试里被引用，barrel 未 re-export ⇒
// 产品侧（apps/**）无法从**同一入口**消费它们。本段**只做加法**：不改、不删任何
// 既有导出，只把已有实现挂到 barrel 上，使 `src/adapters/meituan/index.js` 真正
// 覆盖本包全部已实现能力（消费点见 `apps/demo/server/adapters-extra-routes.ts`）。

export {
  normalizeDetail,
  readCandidateDetail,
  describePriceLabel,
  listUnknownFields,
} from './candidate-detail.js';
export {
  resolveRegisteredSources,
  screenCandidates,
  buildResultScope,
  queryCandidates,
  describeQueryReadiness,
} from './candidate-model.js';
export {
  sortKeysFor,
  unknownFieldsFor,
  compareCandidates,
  recomputeComparison,
  attachPromotionalNote,
  withStructuredNoise,
} from './compare.js';
export {
  DOWNSTREAM_TEMPLATES,
  screenPublishableFacts,
  publishCandidateFacts,
  describeFact,
  listUnwiredTemplates,
} from './fact-publication.js';
export { shareToItems, intakeSharedCandidates, splitShareFromOnline } from './share-intake.js';
export {
  HANDOFF_ACTION_NAME,
  createHandoffLedger,
  generateHandoffBubble,
  assertTargetBoundToSelection,
  verifyAndHandoff,
  settleOnReturn,
} from './handoff-verify.js';

export type {
  DetailValidity,
  DetailPrice,
  DetailSource,
  CandidateDetail,
  AuthorizedMeituanDetailPort,
  RawCandidateDetail,
  CandidateDetailReadResult,
} from './candidate-detail.js';
export type { ResultScope, RejectedCandidateEntry, CandidateQueryOutcome } from './candidate-model.js';
export type {
  ComparisonSnapshot,
  SortKeyEntry,
  CandidateExplanation,
  ComparisonConflict,
  ComparisonResult,
} from './compare.js';
export type {
  DownstreamTemplate,
  FactScreenVerdict,
  FactPublicationPort,
  WireState,
  PublicationResult,
} from './fact-publication.js';
export type {
  ShareKind,
  UserShareInput,
  ShareExtractionPort,
  SkippedShare,
  ShareIntakeResult,
} from './share-intake.js';
export type {
  SelectionState,
  HandoffLinkPort,
  HandoffBubble,
  BubbleGeneration,
  HandoffAttempt,
  HandoffVerification,
} from './handoff-verify.js';
