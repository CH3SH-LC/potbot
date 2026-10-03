/**
 * 有限停止的**预算判定**（D05；合同 Q9-a / §九-8；任务书 §10、§19 A05）。
 *
 * 本文件是**端口（port）的一次应用**：D05 不实现预算台账（那是 D06 的 `BudgetLedger`），
 * 而是要求调用方在**场景执行前**把上限交给诊断：
 * - 上限**由调用方给出**，本模块只**判定**"是否超限"并**报告**消耗；
 * - 上限缺失/形状非法 ⇒ **抛错**（`DiagnosisBudgetError`），绝不静默取默认值——
 *   A05-01「场景执行前已登记 R_max / D_max / T_max，未登记 → 场景无效」的机器可执行形式；
 * - 超限 ⇒ `exceeded` 非空 + `assertWithinBudget()` 抛 `DiagnosisBudgetExceededError`，
 *   绝不静默通过（§九-8：上限在执行前给出，**禁止运行失败后调大**）。
 *
 * 数值来源：`src/protocol/constants.ts` 的 `DEFAULT_DIAGNOSIS_BUDGET` / `DEFAULT_RUN_LIMIT` /
 * `DEFAULT_TIME_BUDGET`（唯一字面量来源，本模块不另起一套常量）。
 *
 * 与 D06 `src/clock/budget.ts` 的关系：D06 的 `ScenarioBudget = {runs, diagnoses, time}`
 * 与本文件的 `DiagnosisBudget` **结构相同**，可直接传入（duck typing），无需适配层。
 * 本模块**不**复制 D06 的记账实现——记账归 D06，判定归 D05。
 */

import {
  DEFAULT_DIAGNOSIS_BUDGET,
  DEFAULT_RUN_LIMIT,
  DEFAULT_TIME_BUDGET,
} from '../protocol/index.js';
import { DependencyError } from './errors.js';

/** 预算的三个维度：轮次 / 诊断次数 / 逻辑时间（R_max / D_max / T_max）。 */
export const DIAGNOSIS_BUDGET_KINDS = ['runs', 'diagnoses', 'time'] as const;
export type DiagnosisBudgetKind = (typeof DIAGNOSIS_BUDGET_KINDS)[number];

/**
 * **调用方在场景执行前登记的**预算上限（R_max / D_max / T_max）。
 * 与 D06 的 `ScenarioBudget` 结构兼容。
 */
export interface DiagnosisBudget {
  readonly runs: number;
  readonly diagnoses: number;
  readonly time: number;
}

/** 已用量（三键齐全；缺省维度按 0 计）。 */
export type BudgetUsage = Readonly<Record<DiagnosisBudgetKind, number>>;

export const ZERO_BUDGET_USAGE: BudgetUsage = Object.freeze({ runs: 0, diagnoses: 0, time: 0 });

/**
 * 首轮默认预算上限（**组装**自 protocol 常量：D=4 / R=6 / T=10000）。
 * 注意：这只是"默认值"，**不会**在调用方未登记时被悄悄套用——未登记一律抛错。
 */
export const DEFAULT_SCENARIO_LIMITS: DiagnosisBudget = Object.freeze({
  runs: DEFAULT_RUN_LIMIT,
  diagnoses: DEFAULT_DIAGNOSIS_BUDGET,
  time: DEFAULT_TIME_BUDGET,
});

export class DiagnosisBudgetError extends DependencyError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiagnosisBudgetError';
  }
}

export class DiagnosisBudgetExceededError extends DiagnosisBudgetError {
  readonly exceeded: readonly DiagnosisBudgetKind[];
  readonly usage: BudgetUsage;
  readonly limits: DiagnosisBudget;

  constructor(
    exceeded: readonly DiagnosisBudgetKind[],
    usage: BudgetUsage,
    limits: DiagnosisBudget,
  ) {
    super(
      `预算超限：${exceeded
        .map((kind) => `${kind} ${usage[kind]} > ${limits[kind]}`)
        .join('；')}（Q9-a / §九-8：上限在场景执行前登记，禁止失败后调大）`,
    );
    this.name = 'DiagnosisBudgetExceededError';
    this.exceeded = [...exceeded];
    this.usage = usage;
    this.limits = limits;
  }
}

function requireLimit(value: unknown, kind: DiagnosisBudgetKind): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DiagnosisBudgetError(
      `预算上限 ${kind} 必须是非负有限数，收到 ${JSON.stringify(value)}——` +
        `算不出预算时不得静默通过（Q9-a）`,
    );
  }
  return value;
}

function requireUsageValue(value: unknown, kind: DiagnosisBudgetKind): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DiagnosisBudgetError(
      `预算用量 ${kind} 必须是非负有限数，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 校验并规范化上限；形状非法即抛 `DiagnosisBudgetError`。 */
export function normalizeBudgetLimits(limits: DiagnosisBudget): DiagnosisBudget {
  return Object.freeze({
    runs: requireLimit(limits.runs, 'runs'),
    diagnoses: requireLimit(limits.diagnoses, 'diagnoses'),
    time: requireLimit(limits.time, 'time'),
  });
}

/** 规范化用量；缺省维度按 0。 */
export function normalizeBudgetUsage(usage?: Partial<BudgetUsage> | null): BudgetUsage {
  const source = usage ?? {};
  return Object.freeze({
    runs: requireUsageValue(source.runs, 'runs'),
    diagnoses: requireUsageValue(source.diagnoses, 'diagnoses'),
    time: requireUsageValue(source.time, 'time'),
  });
}

/** 用量相加（不修改入参）。 */
export function addBudgetUsage(a: BudgetUsage, b: Partial<BudgetUsage>): BudgetUsage {
  return Object.freeze({
    runs: a.runs + (b.runs ?? 0),
    diagnoses: a.diagnoses + (b.diagnoses ?? 0),
    time: a.time + (b.time ?? 0),
  });
}

/** 一次诊断的用量增量（诊断次数 +1）。 */
export function diagnosisUsage(count = 1): BudgetUsage {
  if (!Number.isInteger(count) || count < 0) {
    throw new DiagnosisBudgetError(`诊断次数增量必须是非负整数，收到 ${String(count)}`);
  }
  return Object.freeze({ runs: 0, diagnoses: count, time: 0 });
}

export interface BudgetEvaluation {
  readonly limits: DiagnosisBudget;
  readonly usage: BudgetUsage;
  /** 用量**严格超过**上限的维度（A05-02/03/04 的判据：`≤` 即为在预算内）。 */
  readonly exceeded: readonly DiagnosisBudgetKind[];
  /** 用量**达到或超过**上限的维度（"恰在预算点"，A05-05 允许恰在预算点收敛）。 */
  readonly exhausted: readonly DiagnosisBudgetKind[];
  /** 全部维度都在上限内（`exceeded` 为空）。 */
  readonly ok: boolean;
}

/**
 * 校验上限已登记；未登记即抛 `DiagnosisBudgetError`（A05-01 的机器可执行形式）。
 * `evaluateBudget` 与 `wouldExceedNext` 共用本函数，保证两者的"不静默取默认值"纪律一致。
 */
function requireBudgetLimits(limits: DiagnosisBudget | null | undefined): DiagnosisBudget {
  if (limits === null || limits === undefined) {
    throw new DiagnosisBudgetError(
      '诊断预算未登记：R_max / D_max / T_max 必须在场景执行前由调用方给出（Q9-a / A05-01）。' +
        '本模块拒绝在未知上限下做有限停止判定',
    );
  }
  return normalizeBudgetLimits(limits);
}

/**
 * 判定预算。
 *
 * **A05-01 的机器可执行形式**：`limits` 为 `null` / `undefined` ⇒ 抛 `DiagnosisBudgetError`。
 * 这是刻意的"不静默取默认值"——若允许缺省兜底，"场景执行前已登记上限"这条前置断言
 * 就会在任何实现下恒真通过（与 v1.1 R4 禁止静默零值同一理由）。
 *
 * **注意（R34.2）**：本函数是**报告**判定（"是否已经超了"，`usage > limit`），
 * **不得**复用为启动许可。启动前闸门请用 `wouldExceedNext()`。
 */
export function evaluateBudget(
  limits: DiagnosisBudget | null | undefined,
  usage?: Partial<BudgetUsage> | null,
): BudgetEvaluation {
  const normalizedLimits = requireBudgetLimits(limits);
  const normalizedUsage = normalizeBudgetUsage(usage);
  const exceeded = DIAGNOSIS_BUDGET_KINDS.filter(
    (kind) => normalizedUsage[kind] > normalizedLimits[kind],
  );
  const exhausted = DIAGNOSIS_BUDGET_KINDS.filter(
    (kind) => normalizedUsage[kind] >= normalizedLimits[kind],
  );
  return {
    limits: normalizedLimits,
    usage: normalizedUsage,
    exceeded: Object.freeze([...exceeded]),
    exhausted: Object.freeze([...exhausted]),
    ok: exceeded.length === 0,
  };
}

/**
 * **启动前闸门**（合同 v1.2 R34.1；修复批 F08）：在提交**下一次**动作（启动一轮 / 记一次诊断）
 * 之前判断"再增加一次会不会超过预登记上限"。
 *
 * 判据：`used + 1 > limit` ⟺ `used >= limit` ⇒ 返回 `true`（拒绝）。
 * 于是 `R = 0` 启动 0 轮；`R = 1` 只启动 1 轮、第 2 次即拒；一般 `R = N` 不超过 N。
 *
 * ## 与 `evaluateBudget().exceeded` 的区别（R34.2，**两者不得互相替代**）
 * | | `wouldExceedNext` | `evaluateBudget().exceeded` |
 * |---|---|---|
 * | 回答的问题 | 能否**再发起一次**（前瞻，许可） | 是否**已经超了**（既成，报告） |
 * | 判据 | `used + 1 > limit`（等价 `used >= limit`） | `used > limit` |
 * | `used === limit` 时 | `true`（拒绝：不能再来一次） | `false`（未超限，不报告） |
 * | 用途 | `start_run` / 诊断提交点前的闸门 | D05 的 `budget_exhausted` 报告判定 |
 *
 * 为什么不能互相替代：旧实现（v1.1 R30.1）用 `exceeded` 当启动许可，于是上界变成
 * `R_max + 1`——配置 `runs = 1` 却实跑 2 轮。"事后断言"不是上限。
 *
 * `limits` 未登记（`null` / `undefined`）⇒ 抛 `DiagnosisBudgetError`（与 `evaluateBudget` 同纪律，
 * 闸门**不得**在未知上限下静默放行）。
 */
export function wouldExceedNext(
  limits: DiagnosisBudget | null | undefined,
  usage: Partial<BudgetUsage> | null | undefined,
  kind: DiagnosisBudgetKind,
): boolean {
  const normalizedLimits = requireBudgetLimits(limits);
  if (!DIAGNOSIS_BUDGET_KINDS.includes(kind)) {
    throw new DiagnosisBudgetError(
      `未知的预算维度 ${JSON.stringify(kind)}：只支持 ${DIAGNOSIS_BUDGET_KINDS.join(' / ')}`,
    );
  }
  const normalizedUsage = normalizeBudgetUsage(usage);
  return normalizedUsage[kind] + 1 > normalizedLimits[kind];
}

/**
 * **诊断的事前许可**（合同 v1.3 R44.1 / R44.7；G03 修复批）。
 *
 * 停滞检查点在实际调用诊断判定**之前**读本结构：`allowed === false` ⇒ 不得调用
 * `diagnoseStagnation()`，改为产出**不消费诊断额度**的耗尽报告（`exhaustedDiagnosis()`）。
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `allowed` | 还能不能再记一次诊断：`used + 1 <= limit` |
 * | `used` | 诊断维度的**已用量**（已提交事实投影后的台账值） |
 * | `limit` | 诊断维度的**预登记上限** `D_max` |
 *
 * ## 单一来源（R44.7）
 * `allowed` **只能**由 `wouldExceedNext(limits, usage, 'diagnoses')` 取反得到——
 * 调度侧与本函数都**不得**另写 `used + 1 > limit` 的第二套算术。
 *
 * `limits` 未登记（`null` / `undefined`）⇒ 抛 `DiagnosisBudgetError`
 * （与 `wouldExceedNext` 同纪律：闸门不得在未知上限下静默放行）。
 */
export interface DiagnosisPermit {
  /** 还能不能再记一次诊断：`used + 1 <= limit`。 */
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
}

/**
 * 诊断次数的事前许可（合同 v1.3 R44.1 / R44.7）。
 *
 * 内部复用 `wouldExceedNext(limits, usage, 'diagnoses')`，**不另写算术**；
 * `used` / `limit` 只是把同一份用量与上限**如实读出**供调用方记账 / 取证，不参与判定。
 *
 * @throws {DiagnosisBudgetError} 预算未登记或形状非法（与 `wouldExceedNext` 同纪律）。
 */
export function diagnosisPermit(
  limits: DiagnosisBudget | null | undefined,
  usage: Partial<BudgetUsage> | null | undefined,
): DiagnosisPermit {
  // 唯一判据：先问"再加一次诊断会不会超"，取反即许可。这行同时完成"未登记 ⇒ 抛错"。
  const allowed = !wouldExceedNext(limits, usage, 'diagnoses');
  const normalizedLimits = requireBudgetLimits(limits);
  const normalizedUsage = normalizeBudgetUsage(usage);
  return Object.freeze({
    allowed,
    used: normalizedUsage.diagnoses,
    limit: normalizedLimits.diagnoses,
  });
}

/** 断言全部维度都在上限内；超限即抛 `DiagnosisBudgetExceededError`（夹具的收敛判定点）。 */
export function assertWithinBudget(
  limits: DiagnosisBudget | null | undefined,
  usage?: Partial<BudgetUsage> | null,
): BudgetEvaluation {
  const evaluation = evaluateBudget(limits, usage);
  if (!evaluation.ok) {
    throw new DiagnosisBudgetExceededError(evaluation.exceeded, evaluation.usage, evaluation.limits);
  }
  return evaluation;
}
