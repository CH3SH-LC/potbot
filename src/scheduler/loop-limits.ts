/**
 * **轮次 / 工具调用 / 时间的硬闸门**（KRN-04 下半，R225 / R218 / R27.1）。
 *
 * ## 这一件修的是什么
 *
 * 工具循环最典型的失效模式是"**没有上限**"：模型每轮都调一个工具、每次都差一点点，
 * 循环就一直转下去——烧 token、烧时间，最后连"停下来"这个事实都不记录。
 * 事后看日志只能说"它跑了很久"，说不出"它在第几轮撞上了哪条闸门"。
 *
 * 本模块把三件事做成**事前闸门**：
 *
 * | 本层叫法 | 落到既有维度（`budgets.ts`） | 判据 |
 * |---|---|---|
 * | 轮次（一次模型往返） | `model_calls` | `used + 1 > limit` ⇒ 拒绝 |
 * | 工具调用次数 | `tool_calls` | `used + 1 > limit` ⇒ 拒绝 |
 * | 逻辑时间推进量 | `time` | `used + amount > limit` ⇒ 拒绝 |
 *
 * **复用既有 budgets 语义，不另造一套**：闸门就是 `HardBudgetLedger.reserve()`——
 * 同一个"整笔拒绝、一条都不扣"的拒绝语义，同一批维度名，同一份脱敏追踪与流水（重启不清零）。
 * `LoopLimitGate` 只做两件事：① 把 `turns / tool_calls / time` 三个说法映射到既有维度；
 * ② 把"到顶了"如实组装成**部分结果 + 原因**（复用 `planPartialDelivery()`）。
 *
 * ## "没有上限"不是合法配置
 *
 * 三项上限**必须显式给全**；缺项 / 负数 / 非整数一律抛 `ValidationError`。
 * 这与 `context-assembly.ts` 对上下文预算的处理同一纪律：静默的无限循环正是本条要修的病。
 *
 * ## 诚实边界
 *
 * 闸门的内核是 `HardBudgetLedger`；**没有注入 `journal` 时它不跨重启**（`medium()` 会如实说明）。
 * 跨重启的实测由既有预算恢复路径（`recoverAfterRestart` / `restoreBudgetFromJournal`）承担，
 * 本模块**不**据此宣称循环上限的跨进程结论。
 */

import { ValidationError } from '../protocol/index.js';
import type { LogicalTime } from '../protocol/index.js';
import {
  BUDGET_DIMENSION_LABELS,
  HardBudgetLedger,
  describeBudget,
  planPartialDelivery,
  type BudgetDimension,
  type BudgetJournal,
  type BudgetLimits,
  type PartialDelivery,
} from './budgets.js';

// ---------------------------------------------------------------------------
// 规格（三项必须显式给全）
// ---------------------------------------------------------------------------

/** 一次工具循环的三条硬上限。 */
export interface LoopLimitSpec {
  /** 最多几轮模型往返（一轮 = 一次模型请求）。 */
  readonly max_turns: number;
  /** 最多几次工具调用。 */
  readonly max_tool_calls: number;
  /** 逻辑时间推进量上限（由调用方按步推进）。 */
  readonly max_time: number;
}

/** 本层说法 → 既有预算维度的**唯一**映射（不另造维度名）。 */
export const LOOP_LIMIT_DIMENSIONS: Readonly<Record<'turns' | 'tool_calls' | 'time', BudgetDimension>> =
  Object.freeze({
    turns: 'model_calls',
    tool_calls: 'tool_calls',
    time: 'time',
  });

/** 便捷默认值。**它不是"兜底"**：用默认值也需要调用方显式传入 `DEFAULT_LOOP_LIMIT_SPEC`。 */
export const DEFAULT_LOOP_LIMIT_SPEC: LoopLimitSpec = Object.freeze({
  max_turns: 8,
  max_tool_calls: 16,
  max_time: 64,
});

function requireCount(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ValidationError(
      `循环上限的 ${field} 必须是 ≥ ${String(minimum)} 的整数，收到 ${String(value)}：` +
        '"没有上限"不是合法配置（KRN-04 要求有界的工具循环）',
    );
  }
  return value;
}

/** 校验三项上限并冻结（缺项抛错，**不静默套默认**）。 */
export function validateLoopLimitSpec(raw: LoopLimitSpec): LoopLimitSpec {
  return Object.freeze({
    max_turns: requireCount(raw.max_turns, 'max_turns', 1),
    max_tool_calls: requireCount(raw.max_tool_calls, 'max_tool_calls', 0),
    max_time: requireCount(raw.max_time, 'max_time', 0),
  });
}

/** 把三上限投影成既有预算维度表（交给 `HardBudgetLedger`）。 */
export function loopLimitBudgets(spec: LoopLimitSpec): BudgetLimits {
  const frozen = validateLoopLimitSpec(spec);
  return Object.freeze({
    model_calls: frozen.max_turns,
    tool_calls: frozen.max_tool_calls,
    time: frozen.max_time,
  });
}

// ---------------------------------------------------------------------------
// 闸门判定
// ---------------------------------------------------------------------------

export const LOOP_LIMIT_REASONS = [
  /** 放行（闸门已扣费）。 */
  'admitted',
  /** 会超限 ⇒ 整笔拒绝，一条都不扣。 */
  'would_exceed_limit',
  /** 数量非法（负数 / 非有限数）。 */
  'invalid_amount',
  /** 占用式维度必须走 `acquire`（本闸门不该出现，如实透出以便发现误用）。 */
  'occupancy_dimension_requires_acquire',
] as const;
export type LoopLimitReason = (typeof LOOP_LIMIT_REASONS)[number];

/** 一次闸门判定。`admitted: false` 时 `detail` 说明"卡在哪一条上限上"。 */
export interface LoopLimitDecision {
  readonly admitted: boolean;
  readonly reason: LoopLimitReason;
  /** 本次判定针对的维度（轮次 → `model_calls`、工具调用 → `tool_calls`、时间 → `time`）。 */
  readonly dimension: BudgetDimension;
  /** 被拒时：**将会**超限的维度（如实上报，用于定位）。 */
  readonly would_exceed: readonly BudgetDimension[];
  /** 当前所有已耗尽的维度（不管本次判定是否放行）。 */
  readonly exhausted_dimensions: readonly BudgetDimension[];
  readonly detail: string;
}

function describeDimensionUse(ledger: HardBudgetLedger, dimension: BudgetDimension): string {
  const limit = ledger.limitOf(dimension);
  return `${BUDGET_DIMENSION_LABELS[dimension]} ${String(ledger.used(dimension))}/${limit === null ? '∞' : String(limit)}`;
}

// ---------------------------------------------------------------------------
// 部分结果报告
// ---------------------------------------------------------------------------

export interface LoopLimitReportInput {
  /** 计划产出的引用清单（给了才会组装 `delivery`）。 */
  readonly planned_refs?: readonly string[] | undefined;
  /** **实际**已产出的引用（不得用计划冒充）。 */
  readonly delivered_refs?: readonly string[] | undefined;
  readonly reasons?: Readonly<Record<string, string>> | undefined;
}

export interface LoopLimitUsageRow {
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly limit: number | null;
  readonly exhausted: boolean;
}

export interface LoopLimitReport {
  readonly status: 'within_limits' | 'exhausted';
  /** 到上限 ⇒ **部分结果**（不是完成）。 */
  readonly partial: boolean;
  /** 恒 `false`：到上限**不等于**完成，不得据此宣称交付完整。 */
  readonly complete_claimed: false;
  readonly exhausted_dimensions: readonly BudgetDimension[];
  /** 到上限的**原因**（人可读）。 */
  readonly reason: string;
  readonly usage: readonly LoopLimitUsageRow[];
  /** 复用的既有部分交付结构（只给了 `planned_refs` 时非空）。 */
  readonly delivery: PartialDelivery | null;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// 闸门
// ---------------------------------------------------------------------------

export interface LoopLimitGateOptions {
  /** 登记时刻（A05-01：上限必须**早于**运行登记）。 */
  readonly registered_at?: LogicalTime | undefined;
  /** 用量流水（给了才跨重启；不给则 `medium()` 如实说"易失"）。 */
  readonly journal?: BudgetJournal | null | undefined;
}

/**
 * 工具循环的硬闸门。
 *
 * **没有 setter、没有 reset、不能调大上限**：上限在执行前登记（Q9-a），
 * 一切都经既有 `HardBudgetLedger`（唯一权威）。
 */
export class LoopLimitGate {
  readonly #spec: LoopLimitSpec;
  readonly #ledger: HardBudgetLedger;

  constructor(spec: LoopLimitSpec, options: LoopLimitGateOptions = {}) {
    this.#spec = validateLoopLimitSpec(spec);
    this.#ledger = new HardBudgetLedger(loopLimitBudgets(this.#spec), {
      ...(options.registered_at === undefined ? {} : { registered_at: options.registered_at }),
      ...(options.journal === undefined ? {} : { journal: options.journal }),
    });
  }

  /** 登记的三条上限（只读）。 */
  get spec(): LoopLimitSpec {
    return this.#spec;
  }

  /** 底层预算台账（**唯一权威**：既有的 `charge` / `exhausted` / 流水都从它读）。 */
  get ledger(): HardBudgetLedger {
    return this.#ledger;
  }

  /** 申请一轮模型往返（↔ `model_calls`）。 */
  beginTurn(): LoopLimitDecision {
    return this.#admit('model_calls', 1, '轮次');
  }

  /** 申请一次工具调用（↔ `tool_calls`）。 */
  beginToolCall(): LoopLimitDecision {
    return this.#admit('tool_calls', 1, '工具调用');
  }

  /** 推进逻辑时间（↔ `time`）；达到上限即拒绝，**不部分推进**。 */
  advanceTime(amount: number): LoopLimitDecision {
    return this.#admit('time', amount, '时间');
  }

  /** 已用 / 上限 / 是否耗尽的一行摘要（复用 `describeBudget`）。 */
  describe(): string {
    return describeBudget(this.#ledger);
  }

  /** 介质如实描述：没有流水 = 不跨重启（**未验证**，不得宣称跨进程结论）。 */
  medium(): { readonly kind: 'memory' | 'file'; readonly durable: boolean; readonly detail: string } {
    const journal = this.#ledger.journal;
    return journal === null
      ? {
          kind: 'memory' as const,
          durable: false,
          detail: '进程内存台账：未注入用量流水 ⇒ 上限与用量不跨重启（跨重启恢复未接线）',
        }
      : journal.describe();
  }

  /** 到上限的**部分结果 + 原因**（复用既有 `planPartialDelivery`）。 */
  report(input: LoopLimitReportInput = {}): LoopLimitReport {
    const exhausted = this.#ledger.exhaustedDimensions();
    const usage: LoopLimitUsageRow[] = (
      [
        LOOP_LIMIT_DIMENSIONS.turns,
        LOOP_LIMIT_DIMENSIONS.tool_calls,
        LOOP_LIMIT_DIMENSIONS.time,
      ] as const
    ).map((dimension) =>
      Object.freeze({
        dimension,
        used: this.#ledger.used(dimension),
        limit: this.#ledger.limitOf(dimension),
        exhausted: this.#ledger.exhausted(dimension),
      }),
    );

    const delivery =
      input.planned_refs === undefined
        ? null
        : planPartialDelivery({
            ledger: this.#ledger,
            planned_refs: input.planned_refs,
            delivered_refs: input.delivered_refs ?? [],
            ...(input.reasons === undefined ? {} : { reasons: input.reasons }),
          });

    const partial = exhausted.length > 0;
    return Object.freeze({
      status: partial ? ('exhausted' as const) : ('within_limits' as const),
      partial,
      complete_claimed: false as const,
      exhausted_dimensions: exhausted,
      reason: partial
        ? `循环上限命中：${exhausted.map((dimension) => BUDGET_DIMENSION_LABELS[dimension]).join('、')} 已达上限，循环必须停止（这是**部分结果**，不是完成）`
        : '未命中任何循环上限',
      usage: Object.freeze(usage),
      delivery,
      note: partial
        ? '**部分结果**：撞上硬上限而中断；未产出项由 `delivery.withheld_refs` 如实列出，不得据此宣称任务完成。'
        : '在限内结束：完成与否由**结局**判定（`answered` 才算回答），不由"没超限"推断。',
    });
  }

  #admit(dimension: BudgetDimension, amount: number, label: string): LoopLimitDecision {
    const charges: Partial<Record<BudgetDimension, number>> = {};
    charges[dimension] = amount;
    const outcome = this.#ledger.reserve({ charges });
    const exhausted = this.#ledger.exhaustedDimensions();
    if (outcome.allowed) {
      return Object.freeze({
        admitted: true,
        reason: 'admitted' as const,
        dimension,
        would_exceed: Object.freeze([]),
        exhausted_dimensions: exhausted,
        detail: `${label}放行：${describeDimensionUse(this.#ledger, dimension)}`,
      });
    }
    const reason: LoopLimitReason = outcome.reason === 'reserved' ? 'admitted' : outcome.reason;
    return Object.freeze({
      admitted: false,
      reason,
      dimension,
      would_exceed: outcome.would_exceed,
      exhausted_dimensions: exhausted,
      detail:
        reason === 'would_exceed_limit'
          ? `${label}被拒：本次申请会超过上限（${describeDimensionUse(this.#ledger, dimension)}），整笔未扣`
          : `${label}被拒：${reason}`,
    });
  }
}

/** 便捷构造。 */
export function createLoopLimitGate(spec: LoopLimitSpec, options: LoopLimitGateOptions = {}): LoopLimitGate {
  return new LoopLimitGate(spec, options);
}
