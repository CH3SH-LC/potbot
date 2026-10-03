/**
 * **X-R06 增量（X-I26）**：把「一句话改多个关联产物」的事务视图接到
 * **单位 / 金额 / 事实版本跨产物一致性**契约上——即"表格线真实声明"的唯一生产点。
 *
 * ## 为什么要有这一层
 *
 * 基座 `cross-artifact-consistency.ts` 定义了一致性**契约**（{@link ArtifactFactClaim} /
 * {@link ExpectedFact} / {@link CrossArtifactConsistencyReport}），但声明从哪来没有规定。
 * 本文件把既有实现 `src/facts/multi-artifact-update.ts` 的
 * {@link MultiArtifactTransactionView} 作为**表格线的真实声明源**：
 *
 * - 版本绑定：事务文档写明"事实与产物的新版本都落在 `to_revision` 上"，因此
 *   `fact_version = Number(view.to_revision)`——**不另立一套版本口径**；
 * - 值：事务的 `fact_changes[].new_value` 是共享事实新版本的**唯一值来源**
 *   （`sharedFactValueToClaimedValue`，定点 `Quantity`，不经浮点）；
 * - 产物身份：取自事务里 `template_kind === 'spreadsheet'` 的产物条目（`new_artifact_id`），
 *   即真正被重写的那份表格产物。
 *
 * ## 缺失不当零（R248）与 multi-artifact-update 同口径
 *
 * 事务的 `new_value` 在**未提供事实记录**时为 `null`——那表示"未登记"，**不表示 0**
 * （见 `multi-artifact-update.ts` 顶部纪律）。本层沿用同一纪律：
 *
 * - `new_value === null`（或 `unknown` / `not_applicable`）⇒ 该键进 `unregistered_fact_keys`，
 *   **不产出任何声明、不补 0**；对齐权威快照后如实落 `missing_claim`（`claimed_display === null`）；
 * - 值种类不在一致性契约的值类型内（`date`）⇒ 进 `unsupported_fact_keys`，
 *   **绝不**静默转成文本或 0。
 *
 * ## 本线写权边界
 *
 * 文档线（W）/ 幻灯片线（P）是**跨线写权**，不在本线范围内：本层只产出 `spreadsheet`
 * 车道的真实声明；`docx` / `pptx` 一律由调用方以夹具声明（{@link RealLaneClaimOptions.other_claims}）
 * 参与核对，并保持 `contract-only`（不列入 `wired_targets`）。绝不把"表格线真实"冒充成"文档线也真实"。
 *
 * 纯函数、零 IO、无墙钟、无随机数；时间统一由事务的 `at`（{@link LogicalTime}）带入。
 */

import {
  type NumberFactValue,
  type SharedFactValue,
  type TemplateKind,
} from '../../../../src/protocol/index.js';
import { compareStrings } from '../../../../src/dependency/graph.js';
import { type Quantity, parseQuantity } from '../../../../src/spreadsheets/quantity.js';
import { type PublicationTarget } from '../../../../src/spreadsheets/facts-binding.js';
import type { MultiArtifactTransactionView } from '../../../../src/facts/multi-artifact-update.js';
import {
  type ArtifactFactClaim,
  type ClaimedValue,
  type ConsistencyTarget,
  type CrossArtifactConsistencyReport,
  type ExpectedFact,
  checkCrossArtifactConsistency,
} from './cross-artifact-consistency.js';

// ---------------------------------------------------------------------------
// 模板种类 → 一致性目标车道（封闭映射，单一来源）
// ---------------------------------------------------------------------------

/** `TemplateKind`（`document`/`spreadsheet`/`presentation`）→ 一致性目标车道的**唯一映射**。 */
const TEMPLATE_KIND_TO_TARGET: Readonly<Record<TemplateKind, ConsistencyTarget>> = Object.freeze({
  document: 'docx',
  spreadsheet: 'spreadsheet',
  presentation: 'pptx',
});

/** 模板种类 → 一致性目标车道。 */
export function templateKindToConsistencyTarget(kind: TemplateKind): ConsistencyTarget {
  return TEMPLATE_KIND_TO_TARGET[kind];
}

/** 表格线真实声明的 `verification_mode`（本层唯一产出）。 */
export const REAL_LANE_VERIFICATION_MODE = 'real' as const;

/** 事务里没有表格产物条目时的默认产物 id（仅在调用方显式覆盖时使用）。 */
export const DEFAULT_SPREADSHEET_ARTIFACT_ID = 'spreadsheet:primary';

// ---------------------------------------------------------------------------
// 事实值 → 一致性声明值（定点；缺失不当零；不支持的种类不硬凑）
// ---------------------------------------------------------------------------

/** 一次值换算的结果：要么给出契约值，要么给出**如实的原因**（绝不硬凑成 0 / 文本）。 */
export type ClaimValueResolution =
  | { readonly ok: true; readonly value: ClaimedValue }
  | { readonly ok: false; readonly code: 'unregistered' | 'unsupported_kind'; readonly detail: string };

/** `String(number)` 的小数位数（最短往返十进制；`1e21` 这类会给 0，随后解析阶段显式失败）。 */
function fractionDigits(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * 协议层的 `number` 事实 → 定点 `Quantity`。
 *
 * 走 `String(amount)` 的**最短往返十进制**（与 `parseQuantity` 处理 `number` 入参同一口径），
 * 再做定点解析：任何一步都不做静默舍入——解析不出来（如 `1e21`）就**显式失败**，
 * 而不是把人看不出来的浮点误差当成一个"金额"。
 *
 * @throws {ValidationError} 金额非有限数 / 十进制展开无法定点解析
 */
export function quantityFromNumberFact(fact: NumberFactValue): Quantity {
  const text = String(fact.amount);
  return parseQuantity(text, fractionDigits(text), fact.unit, fact.currency);
}

/**
 * 共享事实值 → 一致性契约的声明值。**缺失不当零，未知不硬凑**。
 *
 * - `null`（未登记）/ `unknown` / `not_applicable` ⇒ `unregistered`（≠ 0）；
 * - `known` + `number` ⇒ 定点 `Quantity`；
 * - `known` + `text` ⇒ 文本；
 * - `known` + `date` ⇒ `unsupported_kind`（本层值类型只有金额 / 文本，日期不得被静默转字符串）。
 */
export function sharedFactValueToClaimedValue(value: SharedFactValue | null): ClaimValueResolution {
  if (value === null) {
    return { ok: false, code: 'unregistered', detail: '事实值未登记（缺失，≠ 0）' };
  }
  switch (value.kind) {
    case 'unknown':
      return { ok: false, code: 'unregistered', detail: `事实值未知（${value.reason}）：不得当成 0 / 空` };
    case 'not_applicable':
      return { ok: false, code: 'unregistered', detail: `事实值不适用（${value.reason}）：不得当成 0 / 空` };
    case 'known':
      switch (value.value.type) {
        case 'number':
          return { ok: true, value: { kind: 'amount', quantity: quantityFromNumberFact(value.value) } };
        case 'text':
          return { ok: true, value: { kind: 'text', text: value.value.text } };
        case 'date':
          return {
            ok: false,
            code: 'unsupported_kind',
            detail: '日期事实不在一致性契约的值类型内（只有 amount / text）：不得静默转字符串',
          };
        default: {
          /* c8 ignore next -- 判别联合已穷尽；仅为 never 收窄 */
          const never: never = value.value;
          throw new Error(`未覆盖的事实值种类：${String(never)}`);
        }
      }
    default: {
      /* c8 ignore next -- 判别联合已穷尽 */
      const never: never = value;
      throw new Error(`未覆盖的事实值载荷：${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 事务 → 表格线真实声明（生产点）
// ---------------------------------------------------------------------------

export interface RealLaneClaimOptions {
  /**
   * 权威事实快照（单一来源）。**省略** ⇒ 由事务的新值推导（仅已登记的键才有条目）。
   * 提供时按"权威是唯一事实快照"的口径对齐——缺失的声明会落 `missing_claim`。
   */
  readonly expected?: readonly ExpectedFact[];
  /** 覆盖真实产物 id（默认取事务里表格产物的 `new_artifact_id`）。 */
  readonly artifact_id?: string;
  /** 覆盖声明版本（默认 = 事务 `to_revision`）；用于构造过期 / 超前的反面对照。 */
  readonly fact_version?: number;
}

/** 表格线真实声明生产的结果（含缺失 / 不支持键的**如实**清单）。 */
export interface RealLaneClaims {
  /** 权威事实快照（调用方给出，或由事务已登记的新值推导）。 */
  readonly expected: readonly ExpectedFact[];
  /** 表格线（`spreadsheet`）真实声明（`verification_mode: 'real'`）。 */
  readonly claims: readonly ArtifactFactClaim[];
  /** 事实变更里值**未登记**的键（`null`/`unknown`/`not_applicable`）：如实标缺失，**不当零**。 */
  readonly unregistered_fact_keys: readonly string[];
  /** 值种类不在契约内的键（如日期）：**不得**硬凑成 0 / 文本。 */
  readonly unsupported_fact_keys: readonly string[];
  /** 本批声明使用的版本（= 事务 `to_revision`，除非显式覆盖）。 */
  readonly fact_version: number;
  /** 本批声明使用的产物 id。 */
  readonly artifact_id: string;
}

/** 事务里的表格产物条目（按新 id 升序，确定性遍历）。 */
function spreadsheetEntries(
  view: MultiArtifactTransactionView,
): readonly MultiArtifactTransactionView['artifact_entries'][number][] {
  return [...view.artifact_entries]
    .filter((entry) => entry.template_kind === 'spreadsheet')
    .sort((left, right) => compareStrings(String(left.new_artifact_id), String(right.new_artifact_id)));
}

/** 事务里表格产物的新版本 id（升序、去重）；无表格产物 ⇒ 空。 */
function spreadsheetArtifactIds(view: MultiArtifactTransactionView): readonly string[] {
  return Object.freeze([...new Set(spreadsheetEntries(view).map((entry) => String(entry.new_artifact_id)))]);
}

/**
 * 从一次性多产物更新事务里，产出**表格线真实声明**（{@link ArtifactFactClaim}）
 * 与权威快照（{@link ExpectedFact}）。
 *
 * 版本口径来自事务（`to_revision`），值口径来自事务的 `new_value`：
 * 事实新版本与产物新版本落在同一版本上，两支不会各说一套。
 *
 * @throws {ValidationError} 金额事实无法定点解析（显式失败，不静默舍入）
 */
export function realLaneClaimsFromTransaction(
  view: MultiArtifactTransactionView,
  options: RealLaneClaimOptions = {},
): RealLaneClaims {
  const factVersion = options.fact_version ?? Number(view.to_revision);

  const unregistered: string[] = [];
  const unsupported: string[] = [];
  /** 逐键解析后的契约值（仅供已解析的键）。 */
  const resolvedValues = new Map<string, ClaimedValue>();
  const derivedExpected: ExpectedFact[] = [];

  for (const change of [...view.fact_changes].sort((left, right) => compareStrings(left.fact_key, right.fact_key))) {
    const resolution = sharedFactValueToClaimedValue(change.new_value);
    if (!resolution.ok) {
      if (resolution.code === 'unregistered') unregistered.push(change.fact_key);
      else unsupported.push(change.fact_key);
      continue;
    }
    resolvedValues.set(change.fact_key, resolution.value);
    derivedExpected.push(Object.freeze({ fact_key: change.fact_key, version: factVersion, value: resolution.value }));
  }

  const expected = Object.freeze(
    options.expected === undefined ? derivedExpected : [...options.expected],
  );

  const sortedChanges = [...view.fact_changes].sort((left, right) => compareStrings(left.fact_key, right.fact_key));

  const claim = (artifactId: string, factKey: string, value: ClaimedValue): ArtifactFactClaim =>
    Object.freeze({
      target: 'spreadsheet' as const,
      artifact_id: artifactId,
      fact_key: factKey,
      fact_version: factVersion,
      value,
      verification_mode: REAL_LANE_VERIFICATION_MODE,
    });

  const claims: ArtifactFactClaim[] = [];
  if (options.artifact_id !== undefined) {
    /* 调用方显式给了产物 id：按其自报渲染的每个已解析事实键出声明。 */
    for (const change of sortedChanges) {
      const value = resolvedValues.get(change.fact_key);
      if (value === undefined) continue;
      claims.push(claim(options.artifact_id, change.fact_key, value));
    }
  } else {
    /* 默认：只有**直接引用**了被改事实键的表格产物才重渲染它（via_fact_keys）。 */
    for (const entry of spreadsheetEntries(view)) {
      const referenced = new Set(entry.via_fact_keys);
      for (const change of sortedChanges) {
        if (!referenced.has(change.fact_key)) continue;
        const value = resolvedValues.get(change.fact_key);
        if (value === undefined) continue;
        claims.push(claim(String(entry.new_artifact_id), change.fact_key, value));
      }
    }
  }

  return Object.freeze({
    expected,
    claims: Object.freeze(claims),
    unregistered_fact_keys: Object.freeze(unregistered.slice().sort(compareStrings)),
    unsupported_fact_keys: Object.freeze(unsupported.slice().sort(compareStrings)),
    fact_version: factVersion,
    artifact_id:
      options.artifact_id ?? spreadsheetArtifactIds(view)[0] ?? DEFAULT_SPREADSHEET_ARTIFACT_ID,
  });
}

// ---------------------------------------------------------------------------
// 事务 → 一致性报告（表格线真实 + 文档/幻灯片契约层）
// ---------------------------------------------------------------------------

export interface TransactionConsistencyOptions extends RealLaneClaimOptions {
  /** 文档 / 幻灯片线的**夹具**声明（跨线写权不在本线：它们只参与契约层核对）。 */
  readonly other_claims?: readonly ArtifactFactClaim[];
  /** 显式声明已接线的目标；**默认空** ⇒ docx / pptx 保持 `contract-only`。 */
  readonly wired_targets?: readonly PublicationTarget[];
  /** 报告快照 id；省略 ⇒ 由事务 `task_id@to_revision` 派生（确定性）。 */
  readonly snapshot_id?: string;
}

export interface TransactionConsistencyResult {
  readonly claims: RealLaneClaims;
  readonly report: CrossArtifactConsistencyReport;
}

/**
 * 从一次性多产物更新事务产出一致性报告：
 *
 * - `spreadsheet` 声明来自本层真实生产点（{@link realLaneClaimsFromTransaction}）；
 * - `docx` / `pptx` 只承载调用方给出的夹具声明，且**默认不接线**（保持 `contract-only`）；
 * - 权威快照默认由事务的新值推导（单一来源），也可由调用方覆盖。
 */
export function consistencyReportFromTransaction(
  view: MultiArtifactTransactionView,
  options: TransactionConsistencyOptions = {},
): TransactionConsistencyResult {
  const claims = realLaneClaimsFromTransaction(view, options);
  const report = checkCrossArtifactConsistency({
    snapshot_id: options.snapshot_id ?? `${String(view.task_id)}@r${String(Number(view.to_revision))}`,
    generated_at: view.at,
    expected: claims.expected,
    claims: [...claims.claims, ...(options.other_claims ?? [])],
    ...(options.wired_targets === undefined ? {} : { wired_targets: options.wired_targets }),
  });
  return Object.freeze({ claims, report });
}
