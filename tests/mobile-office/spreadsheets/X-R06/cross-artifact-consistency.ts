/**
 * **X-R06（预留包）**：单位 / 金额 / 事实版本的**跨文档与幻灯片一致性**契约层。
 *
 * 工作书写明：`单位/金额/事实版本跨文档与幻灯片一致性；缺另组时只关本线契约层`。
 * 本模块交付的正是这一层**契约**：一个消费者（表格 / 文档 / 幻灯片）对外声明"我把事实键
 * `K` 的第 `V` 版渲染成了什么值（金额以 `Quantity` 定点表达）"，本层把这些声明与
 * **唯一权威事实快照**逐一比对，产出可核对的判定。
 *
 * ## 权威是谁（单一来源，不猜第二份）
 *
 * 按本仓既有教义（`src/facts/snapshot.ts` 的 R48「单一来源」）：事实快照是唯一权威。
 * 因此"文档与幻灯片一致"不是让两者互相迁就，而是**两者都对同版权威快照成立**。
 * 在此之上，本层再加一道**产物间两两分歧**探测（{@link InterTargetDivergence}），
 * 用于直接回答"文档说的和幻灯片说的是不是同一个数/同一个单位"。
 *
 * ## 复用，不重写
 *
 * - 金额 / 单位 / 精度的**唯一实现**在 `src/spreadsheets/quantity.ts`：本层只调用
 *   {@link parseQuantity} / {@link compareQuantities} / {@link formatQuantity}，
 *   **不另造一套定点运算**，也**不经过任何浮点**（`0.1 + 0.2` 那类静默丢精度在本层
 *   不可能发生——比较发生在 `bigint` 最小单位上）。
 * - 通道接线状态复用 `src/spreadsheets/facts-binding.ts` 的
 *   {@link publishSharedFacts}：**未接通道 ⇒ 结构化 `not-wired`**，
 *   `claimed_published` 恒为字面量 `false`——"接口点存在"与"已在其他模板生效"必须可区分。
 *
 * ## 「缺另组时只关本线契约层」怎么落地
 *
 * 文档线（W）/ 幻灯片线（P）在本仓**可能尚未接线**。此时：
 * - 本层**仍然**接受来自它们的 `verification_mode: 'fixture'` 声明并算出判定——
 *   契约先立，实现后接；
 * - 但 {@link describeLaneContractStateViaReport} 会把这些车道标为 `contract-only`（**契约层已关**），
 *   而不是 `wired`。绝不把"契约测试绿"冒充成"文档/幻灯片真已生效"。
 * - 表格车道（`spreadsheet`）在仓内由 X 引擎产出真实 `Quantity`，默认按 `wired` 计。
 *
 * 纯函数、零 IO、无墙钟、无随机数：时间由调用方以 `LogicalTime` 传入。
 */

import {
  type LogicalTime,
  ValidationError,
} from '../../../../src/protocol/index.js';
import { canonicalDigest } from '../../../../src/dependency/digest.js';
import { compareStrings } from '../../../../src/dependency/graph.js';
import {
  type Quantity,
  compareQuantities,
  formatQuantity,
  parseQuantity,
} from '../../../../src/spreadsheets/quantity.js';
import {
  type CrossTemplatePublishPort,
  type PublicationTarget,
  type PublicationWireState,
  PUBLICATION_TARGETS,
  publishSharedFacts,
} from '../../../../src/spreadsheets/facts-binding.js';

// ---------------------------------------------------------------------------
// 契约：目标车道
// ---------------------------------------------------------------------------

/**
 * 一致性检查覆盖的三条产物车道。`spreadsheet` 对应 X 线（仓内真实引擎），
 * `docx` / `pptx` 对应文档线与幻灯片线（本包只立契约，不实现它们的渲染）。
 */
export const CONSISTENCY_TARGETS = ['spreadsheet', 'docx', 'pptx'] as const;
export type ConsistencyTarget = (typeof CONSISTENCY_TARGETS)[number];

/** 声明是怎么来的：`real` = 车道真实产出；`fixture` = 契约夹具（车道未接线时使用）。 */
export const VERIFICATION_MODES = ['real', 'fixture'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

// ---------------------------------------------------------------------------
// 契约：权威事实 + 消费者声明
// ---------------------------------------------------------------------------

/** 权威事实值：金额走定点 `Quantity`，文本走原文。 */
export type ExpectedFactValue =
  | { readonly kind: 'amount'; readonly quantity: Quantity }
  | { readonly kind: 'text'; readonly text: string };

/** 权威事实：稳定键 + 版本 + 值。这是**唯一权威**，消费者必须对齐它。 */
export interface ExpectedFact {
  readonly fact_key: string;
  /** 权威版本（单调；消费者声明低于它 ⇒ 过期，高于它 ⇒ 超前）。 */
  readonly version: number;
  readonly value: ExpectedFactValue;
}

/** 消费者声明值（必须与权威同类）。 */
export type ClaimedValue =
  | { readonly kind: 'amount'; readonly quantity: Quantity }
  | { readonly kind: 'text'; readonly text: string };

/**
 * 一条"某产物的某事实渲染成了什么"的声明。
 *
 * 这是本包交给文档 / 幻灯片线的**契约形状**：接线后，它们照此把"我渲染的事实键 + 版本 + 值"
 * 报上来；未接线时用 `verification_mode: 'fixture'` 的夹具声明先关契约层。
 */
export interface ArtifactFactClaim {
  readonly target: ConsistencyTarget;
  /** 产物身份（如 `sheet:Summary@r3` / `docx:report@r2`），供定位。 */
  readonly artifact_id: string;
  readonly fact_key: string;
  /** 该产物**自认**渲染的是第几版事实。 */
  readonly fact_version: number;
  readonly value: ClaimedValue;
  readonly verification_mode: VerificationMode;
}

// ---------------------------------------------------------------------------
// 判定词表（封闭枚举）
// ---------------------------------------------------------------------------

export const CONSISTENCY_VERDICT_CODES = [
  'ok', // 版本 + 值（金额：单位/币种/数值）全对
  'stale_version', // 声明版本 < 权威版本（用了旧版）
  'ahead_version', // 声明版本 > 权威版本（超前，权威尚未有这样的版本）
  'unit_mismatch', // 金额单位不同
  'currency_mismatch', // 金额币种不同
  'amount_mismatch', // 同类同精度对齐后数值仍不同
  'value_kind_mismatch', // 权威是金额、声明是文本（或反之）
  'text_mismatch', // 文本值不同
  'unknown_fact', // 声明引用了权威快照里没有的事实键
  'missing_claim', // 权威有该事实，但该车道没有任何声明（**缺失不当零**）
] as const;
export type ConsistencyVerdict = (typeof CONSISTENCY_VERDICT_CODES)[number];

/** 非 `ok` 的判定（供计数类型收窄）。 */
export type ConsistencyViolation = Exclude<ConsistencyVerdict, 'ok'>;

/** 一条判定。 */
export interface FactConsistencyFinding {
  readonly target: ConsistencyTarget;
  readonly fact_key: string;
  readonly verdict: ConsistencyVerdict;
  readonly expected_version: number | null;
  readonly claimed_version: number | null;
  /** 权威值的可读文本（金额 `formatQuantity` + 单位/币种；文本原样）。 */
  readonly expected_display: string | null;
  /** 声明值的可读文本；`missing_claim` 时为 `null`（**不是 `"0"`**）。 */
  readonly claimed_display: string | null;
  readonly reason: string;
}

/** 两条车道对同一事实键、同一类金额值渲染出**不同**定点值。 */
export interface InterTargetDivergence {
  readonly fact_key: string;
  readonly left_target: ConsistencyTarget;
  readonly left_display: string;
  readonly right_target: ConsistencyTarget;
  readonly right_display: string;
  readonly reason: string;
}

/** 车道契约状态：`wired` = 该车道有真实声明（或 X 线内建）；`contract-only` = 只有夹具声明。 */
export interface LaneContractEntry {
  readonly target: ConsistencyTarget;
  readonly state: 'wired' | 'contract-only';
  readonly has_claims: boolean;
  readonly verification_modes: readonly VerificationMode[];
  readonly note: string;
}

/** 一致性报告（可核对、可复现、确定性）。 */
export interface CrossArtifactConsistencyReport {
  readonly snapshot_id: string;
  readonly generated_at: LogicalTime;
  readonly findings: readonly FactConsistencyFinding[];
  readonly divergences: readonly InterTargetDivergence[];
  readonly lanes: readonly LaneContractEntry[];
  readonly targets_checked: readonly ConsistencyTarget[];
  /** 全部判定均为 `ok` 且无产物间分歧 ⇒ `true`。 */
  readonly consistent: boolean;
  /** 每个非 `ok` 判定的计数（确定性键序）。 */
  readonly violation_counts: Readonly<Record<string, number>>;
  /** 复核摘要（确定性；含全部输入要素）。 */
  readonly review_digest: string;
}

export interface CrossArtifactConsistencyRequest {
  readonly snapshot_id: string;
  /** 权威事实（键唯一）。 */
  readonly expected: readonly ExpectedFact[];
  readonly claims: readonly ArtifactFactClaim[];
  readonly generated_at: LogicalTime;
  /**
   * 已接线的发布目标。`spreadsheet` 恒为内建（不列在此）。省略 ⇒ docx/pptx 均按未接线计，
   * 对应车道标 `contract-only`（"缺另组时只关契约层"）。
   */
  readonly wired_targets?: readonly PublicationTarget[];
}

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串（收到 ${JSON.stringify(value ?? null)}）`);
  }
  return value;
}

function requireVersion(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} 必须是 ≥ 0 的整数，收到 ${String(value)}`);
  }
  return value;
}

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间）`);
  }
  return value as LogicalTime;
}

function requireTarget(value: unknown, field: string): ConsistencyTarget {
  if (typeof value !== 'string' || !(CONSISTENCY_TARGETS as readonly string[]).includes(value)) {
    throw new ValidationError(
      `${field} 必须是 ${CONSISTENCY_TARGETS.join(' / ')} 之一，收到 ${JSON.stringify(value ?? null)}`,
    );
  }
  return value as ConsistencyTarget;
}

function requireVerificationMode(value: unknown, field: string): VerificationMode {
  if (typeof value !== 'string' || !(VERIFICATION_MODES as readonly string[]).includes(value)) {
    throw new ValidationError(
      `${field} 必须是 ${VERIFICATION_MODES.join(' / ')} 之一，收到 ${JSON.stringify(value ?? null)}`,
    );
  }
  return value as VerificationMode;
}

// ---------------------------------------------------------------------------
// 显示
// ---------------------------------------------------------------------------

/** `Quantity` 的可读文本（**不** `JSON.stringify`——它含 `bigint`，会抛）。 */
export function describeQuantity(quantity: Quantity): string {
  const currency = quantity.currency === null ? '' : ` ${quantity.currency}`;
  return `${formatQuantity(quantity)} ${quantity.unit}${currency}`;
}

function describeExpected(value: ExpectedFactValue): string {
  return value.kind === 'amount' ? describeQuantity(value.quantity) : value.text;
}

function describeClaimed(value: ClaimedValue): string {
  return value.kind === 'amount' ? describeQuantity(value.quantity) : value.text;
}

// ---------------------------------------------------------------------------
// 金额比较（单位 / 币种 / 数值分步判，**不经过浮点**）
// ---------------------------------------------------------------------------

type AmountVerdict = Extract<
  ConsistencyVerdict,
  'ok' | 'unit_mismatch' | 'currency_mismatch' | 'amount_mismatch'
>;

function compareAmounts(
  expected: Quantity,
  claimed: Quantity,
): { readonly verdict: AmountVerdict; readonly reason: string } {
  if (expected.unit !== claimed.unit) {
    return {
      verdict: 'unit_mismatch',
      reason: `单位不同：权威 ${JSON.stringify(expected.unit)} vs 声明 ${JSON.stringify(claimed.unit)}`,
    };
  }
  if (expected.currency !== claimed.currency) {
    return {
      verdict: 'currency_mismatch',
      reason: `币种不同：权威 ${JSON.stringify(expected.currency)} vs 声明 ${JSON.stringify(claimed.currency)}`,
    };
  }
  if (compareQuantities(expected, claimed) !== 0) {
    return {
      verdict: 'amount_mismatch',
      reason: `数值不同：权威 ${describeQuantity(expected)} vs 声明 ${describeQuantity(claimed)}`,
    };
  }
  return { verdict: 'ok', reason: '' };
}

// ---------------------------------------------------------------------------
// 版本比对
// ---------------------------------------------------------------------------

function versionVerdict(claimedVersion: number, expectedVersion: number): 'ok' | 'stale_version' | 'ahead_version' {
  if (claimedVersion < expectedVersion) return 'stale_version';
  if (claimedVersion > expectedVersion) return 'ahead_version';
  return 'ok';
}

// ---------------------------------------------------------------------------
// 单条声明 vs 权威
// ---------------------------------------------------------------------------

function judgeClaim(expected: ExpectedFact, claim: ArtifactFactClaim): FactConsistencyFinding {
  const expectedDisplay = describeExpected(expected.value);
  const claimedDisplay = describeClaimed(claim.value);
  const base = {
    target: claim.target,
    fact_key: claim.fact_key,
    expected_version: expected.version,
    claimed_version: claim.fact_version,
    expected_display: expectedDisplay,
    claimed_display: claimedDisplay,
  } as const;

  const versionProblem = versionVerdict(claim.fact_version, expected.version);
  if (versionProblem !== 'ok') {
    return Object.freeze({
      ...base,
      verdict: versionProblem,
      reason:
        versionProblem === 'stale_version'
          ? `声明版本 ${String(claim.fact_version)} 早于权威版本 ${String(expected.version)}：产物用的是旧版事实`
          : `声明版本 ${String(claim.fact_version)} 高于权威版本 ${String(expected.version)}：权威尚未有该版本`,
    });
  }

  if (expected.value.kind !== claim.value.kind) {
    return Object.freeze({
      ...base,
      verdict: 'value_kind_mismatch' as const,
      reason: `值类型不同：权威 ${expected.value.kind} vs 声明 ${claim.value.kind}`,
    });
  }

  if (expected.value.kind === 'amount' && claim.value.kind === 'amount') {
    const compared = compareAmounts(expected.value.quantity, claim.value.quantity);
    return Object.freeze({ ...base, verdict: compared.verdict, reason: compared.reason });
  }

  /* 同为 text（金额分支已在上方 return）。 */
  const expectedText = expected.value.kind === 'text' ? expected.value.text : '';
  const claimedText = claim.value.kind === 'text' ? claim.value.text : '';
  if (expectedText !== claimedText) {
    return Object.freeze({
      ...base,
      verdict: 'text_mismatch' as const,
      reason: `文本不同：权威 ${JSON.stringify(expectedText)} vs 声明 ${JSON.stringify(claimedText)}`,
    });
  }
  return Object.freeze({ ...base, verdict: 'ok' as const, reason: '' });
}

// ---------------------------------------------------------------------------
// 产物间两两分歧（文档说的 vs 幻灯片说的）
// ---------------------------------------------------------------------------

function findDivergences(claims: readonly ArtifactFactClaim[]): readonly InterTargetDivergence[] {
  const byFact = new Map<string, ArtifactFactClaim[]>();
  for (const claim of claims) {
    if (claim.value.kind !== 'amount') continue;
    const list = byFact.get(claim.fact_key);
    if (list === undefined) byFact.set(claim.fact_key, [claim]);
    else list.push(claim);
  }

  const divergences: InterTargetDivergence[] = [];
  const factKeys = [...byFact.keys()].sort(compareStrings);
  for (const factKey of factKeys) {
    const list = byFact.get(factKey);
    /* c8 ignore next -- factKeys 来自 byFact，必存在 */
    if (list === undefined) continue;
    const sorted = [...list].sort((a, b) => compareStrings(a.target, b.target));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const left = sorted[i];
        const right = sorted[j];
        /* c8 ignore next -- 索引在界内 */
        if (left === undefined || right === undefined) continue;
        if (left.target === right.target) continue;
        if (left.value.kind !== 'amount' || right.value.kind !== 'amount') continue;
        const compared = compareAmounts(left.value.quantity, right.value.quantity);
        if (compared.verdict === 'ok') continue;
        divergences.push(
          Object.freeze({
            fact_key: factKey,
            left_target: left.target,
            left_display: describeQuantity(left.value.quantity),
            right_target: right.target,
            right_display: describeQuantity(right.value.quantity),
            reason: `产物间分歧（${compared.verdict}）：${compared.reason}`,
          }),
        );
      }
    }
  }
  return Object.freeze(divergences);
}

// ---------------------------------------------------------------------------
// 车道契约状态
// ---------------------------------------------------------------------------

const SPREADSHEET_BUILTIN_REASON =
  '表格车道由本仓 X 引擎产出真实 Quantity，按 wired 计。';
const CONTRACT_ONLY_REASON =
  '该车道未接线：本包只关**契约层**（接线后按同一形状声明即可接入，不代表已在用户可见处生效）。';

function buildLaneEntries(
  claims: readonly ArtifactFactClaim[],
  wiredTargets: readonly PublicationTarget[],
): readonly LaneContractEntry[] {
  const wired = new Set<string>([...wiredTargets, 'spreadsheet']);
  return Object.freeze(
    CONSISTENCY_TARGETS.map((target) => {
      const laneClaims = claims.filter((claim) => claim.target === target);
      const modes = Object.freeze(
        [...new Set(laneClaims.map((claim) => claim.verification_mode))].sort(compareStrings) as VerificationMode[],
      );
      const isWired = wired.has(target);
      return Object.freeze({
        target,
        state: isWired ? ('wired' as const) : ('contract-only' as const),
        has_claims: laneClaims.length > 0,
        verification_modes: modes,
        note: target === 'spreadsheet' ? SPREADSHEET_BUILTIN_REASON : isWired ? '该车道已接线。' : CONTRACT_ONLY_REASON,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function normalizeExpected(expected: readonly ExpectedFact[]): readonly ExpectedFact[] {
  const seen = new Set<string>();
  const normalized: ExpectedFact[] = [];
  for (const fact of expected) {
    const key = requireNonEmptyString(fact.fact_key, 'ExpectedFact.fact_key');
    if (seen.has(key)) {
      throw new ValidationError(
        `权威快照出现重复事实键 ${JSON.stringify(key)}：同一键只能有一条权威值（单一来源）`,
      );
    }
    seen.add(key);
    requireVersion(fact.version, `ExpectedFact[${key}].version`);
    if (fact.value.kind === 'amount') {
      /* parseQuantity 复核算术字段的合法性（scale/unit），结果丢弃——只为校验。 */
      const quantity = fact.value.quantity;
      parseQuantity(formatQuantity(quantity), quantity.scale, quantity.unit, quantity.currency);
    }
    normalized.push(fact);
  }
  return Object.freeze(normalized);
}

function normalizeClaim(claim: ArtifactFactClaim): ArtifactFactClaim {
  requireTarget(claim.target, 'ArtifactFactClaim.target');
  requireNonEmptyString(claim.artifact_id, 'ArtifactFactClaim.artifact_id');
  const factKey = requireNonEmptyString(claim.fact_key, 'ArtifactFactClaim.fact_key');
  requireVersion(claim.fact_version, `ArtifactFactClaim[${factKey}].fact_version`);
  requireVerificationMode(claim.verification_mode, 'ArtifactFactClaim.verification_mode');
  if (claim.value.kind === 'amount') {
    const quantity = claim.value.quantity;
    parseQuantity(formatQuantity(quantity), quantity.scale, quantity.unit, quantity.currency);
  }
  return claim;
}

/**
 * 跨产物核对单位 / 金额 / 事实版本一致性。
 *
 * 对每个权威事实键 × 每个车道：有声明 ⇒ 逐条判定；无声明 ⇒ `missing_claim`
 * （**缺失不当零**）。另附产物间两两分歧与车道契约状态。
 *
 * @throws {ValidationError} 权威键重复 / 形状非法；声明引用非法目标或非法 `Quantity`
 */
export function checkCrossArtifactConsistency(
  request: CrossArtifactConsistencyRequest,
): CrossArtifactConsistencyReport {
  const snapshotId = requireNonEmptyString(request.snapshot_id, 'snapshot_id');
  const generatedAt = requireLogicalTime(request.generated_at, 'generated_at');
  const expected = normalizeExpected(request.expected);
  const claims = Object.freeze(request.claims.map(normalizeClaim));

  const expectedByKey = new Map<string, ExpectedFact>();
  for (const fact of expected) expectedByKey.set(fact.fact_key, fact);

  const findings: FactConsistencyFinding[] = [];

  /* ① 对齐方向一：权威 × 车道 ⇒ 有声明判定 / 无声明 missing_claim。 */
  for (const fact of expected) {
    for (const target of CONSISTENCY_TARGETS) {
      const laneClaims = claims.filter((claim) => claim.target === target && claim.fact_key === fact.fact_key);
      if (laneClaims.length === 0) {
        findings.push(
          Object.freeze({
            target,
            fact_key: fact.fact_key,
            verdict: 'missing_claim' as const,
            expected_version: fact.version,
            claimed_version: null,
            expected_display: describeExpected(fact.value),
            claimed_display: null,
            reason: `权威有事实键 ${fact.fact_key}@v${String(fact.version)}，但车道 ${target} 无任何声明：缺失如实上报，不当零`,
          }),
        );
        continue;
      }
      for (const claim of laneClaims) {
        findings.push(judgeClaim(fact, claim));
      }
    }
  }

  /* ② 对齐方向二：声明 → 权威（引用未知键）。 */
  for (const claim of claims) {
    if (expectedByKey.has(claim.fact_key)) continue;
    findings.push(
      Object.freeze({
        target: claim.target,
        fact_key: claim.fact_key,
        verdict: 'unknown_fact' as const,
        expected_version: null,
        claimed_version: claim.fact_version,
        expected_display: null,
        claimed_display: describeClaimed(claim.value),
        reason: `声明引用了权威快照里不存在的事实键 ${JSON.stringify(claim.fact_key)}：无法核对`,
      }),
    );
  }

  findings.sort((a, b) => {
    const byTarget = compareStrings(a.target, b.target);
    if (byTarget !== 0) return byTarget;
    const byKey = compareStrings(a.fact_key, b.fact_key);
    if (byKey !== 0) return byKey;
    return compareStrings(a.claimed_version === null ? '' : String(a.claimed_version), b.claimed_version === null ? '' : String(b.claimed_version));
  });

  const divergences = findDivergences(claims);
  const lanes = buildLaneEntries(claims, request.wired_targets ?? []);

  const violationCounts: Record<string, number> = {};
  for (const finding of findings) {
    if (finding.verdict === 'ok') continue;
    violationCounts[finding.verdict] = (violationCounts[finding.verdict] ?? 0) + 1;
  }

  const consistent = findings.every((finding) => finding.verdict === 'ok') && divergences.length === 0;

  /* 摘要分量先各自排序再拼——输入顺序不得影响摘要（否则确定性不成立）。 */
  const expectedLines = expected
    .map((fact) => `${fact.fact_key}@${String(fact.version)}=${describeExpected(fact.value)}`)
    .sort(compareStrings);
  const claimLines = claims
    .map(
      (claim) =>
        `${claim.target}:${claim.artifact_id}:${claim.fact_key}@${String(claim.fact_version)}=${describeClaimed(claim.value)}[${claim.verification_mode}]`,
    )
    .sort(compareStrings);
  const digestPayload = [snapshotId, ...expectedLines, ...claimLines].join('\n');

  return Object.freeze({
    snapshot_id: snapshotId,
    generated_at: generatedAt,
    findings: Object.freeze(findings),
    divergences,
    lanes,
    targets_checked: CONSISTENCY_TARGETS,
    consistent,
    violation_counts: Object.freeze(violationCounts),
    review_digest: canonicalDigest(digestPayload),
  });
}

/**
 * 从报告里取"车道 → 契约状态"映射（供展示 / 断言直接遍历）。
 * `spreadsheet` 恒 `wired`；未接线车道 `contract-only`。
 */
export function describeLaneContractStateViaReport(
  report: CrossArtifactConsistencyReport,
): ReadonlyMap<ConsistencyTarget, 'wired' | 'contract-only'> {
  return new Map(report.lanes.map((entry) => [entry.target, entry.state] as const));
}

// ---------------------------------------------------------------------------
// 接线探测（复用 facts-binding 的 not-wired 语义）
// ---------------------------------------------------------------------------

export interface LaneWiringEntry {
  readonly target: PublicationTarget;
  readonly wire_state: PublicationWireState;
  readonly acknowledged: boolean;
  /** **恒为 `false`**：即便通道受理，也只是受理回执，谈不上"已在用户可见处生效"。 */
  readonly claimed_published: false;
}

/**
 * 探测文档 / 幻灯片发布通道的接线状态：未装配的目标 ⇒ `not-wired`（结构化，不冒充已发布）。
 * 复用 `publishSharedFacts`（`src/spreadsheets/facts-binding.ts`），不重造第二套发布点。
 */
export async function checkPublicationWiring(
  channels: readonly CrossTemplatePublishPort[],
): Promise<readonly LaneWiringEntry[]> {
  const results = await publishSharedFacts({ channels, publications: [] });
  return Object.freeze(
    results.map((result) =>
      Object.freeze({
        target: result.target,
        wire_state: result.wire_state,
        acknowledged: result.acknowledged,
        claimed_published: false as const,
      }),
    ),
  );
}

/** 全部目标顺序（供展示层固定遍历）。 */
export const ALL_PUBLICATION_TARGETS: readonly PublicationTarget[] = PUBLICATION_TARGETS;
