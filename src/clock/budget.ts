/**
 * 有限停止的**预算登记与记账**（接口合同 Q9-a / Q9-b，第六节「时钟与诊断预算」）。
 *
 * 冻结语义：
 * - 上限**在执行前登记**，登记后**不可调大**（Q9-a：「禁止运行失败后调大」）。
 *   本模块把上限放在冻结对象里、不提供任何 setter，从结构上堵住「失败后放宽」。
 * - 内部数值引用 `src/protocol/constants.ts` 的默认预算常量（`DEFAULT_DIAGNOSIS_BUDGET`、
 *   `DEFAULT_RUN_LIMIT`、`DEFAULT_TIME_BUDGET`），**不另起一套常量**。
 * - 记账**不抛出**：是否停止由内核决定（Q9-c 的「暂停 / 报告」判定属 D05/D09）。
 *   夹具在收敛判定时调用 `assertWithinBudget()` 取得显式失败。
 * - 记账逐条留痕（`charges`），供证据汇总与「不得超过上限」的判据使用。
 */

import {
  DEFAULT_DIAGNOSIS_BUDGET,
  DEFAULT_RUN_LIMIT,
  DEFAULT_TIME_BUDGET,
  asLogicalTime,
  type LogicalTime,
} from '../protocol/index.js';

/** 预算的种类：轮次数 / 诊断次数 / 逻辑时间。 */
export const BUDGET_KINDS = ['runs', 'diagnoses', 'time'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

/** 场景预算上限（R_max / D_max / T_max）。 */
export interface ScenarioBudget {
  /** 运行轮次上限 R_max。 */
  readonly runs: number;
  /** 诊断次数上限 D_max。 */
  readonly diagnoses: number;
  /** 逻辑时间上限 T_max。 */
  readonly time: number;
}

/**
 * 合同 Q9-a 的首轮默认预算：`D=4 / R=6 / T=10000`
 * （数值来自 `src/protocol/constants.ts`，本模块只组装）。
 */
export const DEFAULT_SCENARIO_BUDGET: ScenarioBudget = Object.freeze({
  runs: DEFAULT_RUN_LIMIT,
  diagnoses: DEFAULT_DIAGNOSIS_BUDGET,
  time: DEFAULT_TIME_BUDGET,
});

/** 预算被突破（夹具在收敛判定时显式抛出——验收必须看见失败原因）。 */
export class BudgetExceededError extends Error {
  readonly exceeded: readonly BudgetKind[];
  readonly usage: Readonly<Record<BudgetKind, number>>;
  readonly limits: ScenarioBudget;

  constructor(
    exceeded: readonly BudgetKind[],
    usage: Readonly<Record<BudgetKind, number>>,
    limits: ScenarioBudget,
  ) {
    super(
      `预算超限：${exceeded
        .map((kind) => `${kind} ${usage[kind]} > ${String(limits[kind])}`)
        .join('；')}（Q9-a：上限在场景执行前登记，禁止失败后调大）`,
    );
    this.name = 'BudgetExceededError';
    this.exceeded = [...exceeded];
    this.usage = usage;
    this.limits = limits;
  }
}

/** 一次记账（证据）。 */
export interface BudgetCharge {
  readonly index: number;
  readonly kind: BudgetKind;
  readonly amount: number;
  readonly total: number;
  readonly at: LogicalTime;
  readonly label?: string;
}

/** 记账快照。 */
export interface BudgetSnapshot {
  readonly limits: ScenarioBudget;
  readonly usage: Readonly<Record<BudgetKind, number>>;
  readonly remaining: Readonly<Record<BudgetKind, number>>;
  readonly registered_at: LogicalTime;
  readonly charges: readonly BudgetCharge[];
}

function assertLimit(value: number, kind: BudgetKind): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`预算上限 ${kind} 必须是非负有限数，收到 ${String(value)}`);
  }
  return value;
}

/**
 * 预算台账。
 *
 * 用法（夹具脚本头）：
 * ```ts
 * const budget = new BudgetLedger(
 *   { runs: 2, diagnoses: 1, time: 20 },   // 场景执行前登记
 *   { registeredAt: clock.now() },
 * );
 * budget.charge('runs', 1, 'run-1');
 * budget.chargeTimeFrom(clock);            // 按时钟累计推进量同步时间用量
 * budget.assertWithinBudget();             // 收敛判定
 * ```
 */
export class BudgetLedger {
  readonly #limits: ScenarioBudget;
  #usage: Record<BudgetKind, number> = { runs: 0, diagnoses: 0, time: 0 };
  readonly #charges: BudgetCharge[] = [];
  readonly #registeredAt: LogicalTime;

  constructor(
    limits: ScenarioBudget = DEFAULT_SCENARIO_BUDGET,
    options: { readonly registeredAt?: LogicalTime } = {},
  ) {
    const frozen: ScenarioBudget = Object.freeze({
      runs: assertLimit(limits.runs, 'runs'),
      diagnoses: assertLimit(limits.diagnoses, 'diagnoses'),
      time: assertLimit(limits.time, 'time'),
    });
    this.#limits = frozen;
    this.#registeredAt = options.registeredAt ?? asLogicalTime(0);
  }

  /** 登记的上限（冻结；不提供修改入口）。 */
  get limits(): ScenarioBudget {
    return this.#limits;
  }

  /** 登记时刻（A05-01：登记时间必须早于运行）。 */
  get registeredAt(): LogicalTime {
    return this.#registeredAt;
  }

  /** 记账。**不抛错**：只累加并留痕。 */
  charge(kind: BudgetKind, amount = 1, options: { at?: LogicalTime; label?: string } = {}): number {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`记账量必须是非负有限数，收到 ${String(amount)}`);
    }
    const total = this.#usage[kind] + amount;
    this.#usage[kind] = total;
    this.#charges.push({
      index: this.#charges.length + 1,
      kind,
      amount,
      total,
      at: options.at ?? asLogicalTime(0),
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    return total;
  }

  /**
   * 按逻辑时钟的累计推进量同步「时间」用量（记为增量）。
   * 用于 A05-04「实际推进的虚拟时间 ≤ T_max」。
   */
  chargeTimeFrom(clock: { readonly totalAdvanced: number }, at?: LogicalTime): number {
    const target = clock.totalAdvanced;
    const delta = target - this.#usage.time;
    if (delta < 0) {
      throw new RangeError(
        `时钟累计推进量 ${target} 小于已记账时间用量 ${this.#usage.time}（时间不可倒流）`,
      );
    }
    return this.charge('time', delta, at === undefined ? { label: 'sync' } : { at, label: 'sync' });
  }

  /** 某类预算的已用量。 */
  used(kind: BudgetKind): number {
    return this.#usage[kind];
  }

  /** 某类预算的剩余量（可为负 = 已超）。 */
  remaining(kind: BudgetKind): number {
    return this.#limits[kind] - this.#usage[kind];
  }

  /** 某类预算是否已耗尽（用量 ≥ 上限）。 */
  isExhausted(kind: BudgetKind): boolean {
    return this.#usage[kind] >= this.#limits[kind];
  }

  /** 已超限的预算种类（空数组 = 全部在上限内）。 */
  exceededKinds(): readonly BudgetKind[] {
    return BUDGET_KINDS.filter((kind) => this.#usage[kind] > this.#limits[kind]);
  }

  /**
   * 断言全部在预算内；超限即抛 `BudgetExceededError` 并列出哪几项超了。
   * （夹具的收敛判定点：未收敛必须在预算点被判「不通过」，而不是继续跑。）
   */
  assertWithinBudget(): void {
    const exceeded = this.exceededKinds();
    if (exceeded.length > 0) {
      throw new BudgetExceededError(exceeded, { ...this.#usage }, this.#limits);
    }
  }

  /** 记账快照（证据）。 */
  snapshot(): BudgetSnapshot {
    return {
      limits: this.#limits,
      usage: { ...this.#usage },
      remaining: {
        runs: this.remaining('runs'),
        diagnoses: this.remaining('diagnoses'),
        time: this.remaining('time'),
      },
      registered_at: this.#registeredAt,
      charges: [...this.#charges],
    };
  }
}
