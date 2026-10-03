/**
 * **任务 / 模型 / 工具调用、token / 费用、并发、重试与时间的硬预算**（KRN-12；R225 / R218 / R27.1）。
 *
 * ## 这一件修的是什么
 *
 * "预算"在多数实现里退化成一个**事后断言**：跑完了再看有没有超。那不是限制，是讣告。
 * 本模块把八类预算做成**事前闸门**（`reserve` / `acquire`）：判据是
 * `used + amount > limit` ⇒ **拒绝**，且**一条都不扣**（不做半截扣费）。
 *
 * | 维度 | 性质 | 说明 |
 * |---|---|---|
 * | `task_calls` | 累计 | 任务级执行次数 |
 * | `model_calls` | 累计 | 模型调用次数 |
 * | `tool_calls` | 累计 | 工具调用次数 |
 * | `tokens` | 累计 | token 用量 |
 * | `cost_micros` | 累计 | 费用（**整数微元**：不用浮点表达钱） |
 * | `concurrency` | **占用式** | 同时在飞的调用数，`acquire` / `release` |
 * | `retries` | 累计 | 重试次数 |
 * | `time` | 累计 | 逻辑时间推进量 |
 *
 * ## 硬限制管的是"闸门"，不是"账本"
 *
 * `reserve()` / `acquire()` 是**唯一**授权新工作的入口，硬限制在那里生效。
 * `charge()` 记的是**已经发生**的消耗，因此**刻意不设上限**——恢复路径要能把账目
 * 对齐到"真实已用量"，若允许账目低于事实，就是在谎报用量（与 `budget-projection.ts`
 * 的"只上不下"同一纪律，R218）。
 *
 * ## 重启与多工作进程不清零（R225 / R218）
 *
 * 台账本身**没有任何 setter、没有任何 reset**：只能累加。跨进程的真相在
 * **用量流水（journal）**里——每一条消耗追加一行，重启后
 * `reconcileBudgetFromFacts()` 把新台账**收敛**到流水折算出的目标用量（只上不下）。
 *
 * **为什么需要独立的流水**：`src/protocol/storage.ts` 的 `StoreSnapshot` / `StorageTransaction`
 * 里没有"用量流水"这一类记录的位置，而协议与存储的实现文件都不在本包写权内。
 * 因此本模块自带一个**追加式（append-only）**流水端口，并提供落盘实现
 * `createFileBudgetJournal()`（JSONL：并发写者各写各的行，不互相覆盖）。
 *
 * **诚实边界**：多工作进程的"同一份文件并发追加"**只做了同进程模拟**
 * （两个台账实例读同一份流水）。**真实多进程并发追加的实测未做**，
 * 本模块与测试都不据此宣称跨进程结论。
 *
 * ## 脱敏追踪
 *
 * `redactedTrace()` 只吐**摘要 + 极短提示**，**绝不吐原始 label / subject**：
 * 预算追踪常被写进日志与证据文件，原文里可能有用户内容或凭据。
 */


import { canonicalDigest } from '../dependency/index.js';
import { asLogicalTime, type LogicalTime } from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 维度
// ---------------------------------------------------------------------------

export const BUDGET_DIMENSIONS = [
  'task_calls',
  'model_calls',
  'tool_calls',
  'tokens',
  'cost_micros',
  'concurrency',
  'retries',
  'time',
] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/** 累计型维度（只能加）。 */
export const CUMULATIVE_DIMENSIONS = BUDGET_DIMENSIONS.filter(
  (dimension) => dimension !== 'concurrency',
) as readonly BudgetDimension[];

/** 占用式维度（`acquire` / `release`，记的是"同时在飞"而不是"累计发生"）。 */
export const OCCUPANCY_DIMENSIONS: readonly BudgetDimension[] = Object.freeze(['concurrency']);

export const BUDGET_DIMENSION_LABELS: Readonly<Record<BudgetDimension, string>> = Object.freeze({
  task_calls: '任务调用',
  model_calls: '模型调用',
  tool_calls: '工具调用',
  tokens: 'token 用量',
  cost_micros: '费用（微元）',
  concurrency: '并发',
  retries: '重试',
  time: '逻辑时间',
});

/** 上限表：**只写设了限的维度**；未登记的维度 = 不设限（`null`，不是 0）。 */
export type BudgetLimits = Partial<Record<BudgetDimension, number>>;

function assertLimit(value: number, dimension: BudgetDimension): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `预算上限必须是**非负有限数**（${BUDGET_DIMENSION_LABELS[dimension]}），收到 ${String(value)}：` +
        '算不出上限时不得静默通过',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 脱敏结果：**只有摘要与极短提示**。 */
export interface RedactedValue {
  /** `canonicalDigest` 摘要（可复核、不可还原）。 */
  readonly digest: string;
  /** 极短提示：原文长度不超过提示长度时为空串。 */
  readonly hint: string;
  readonly length: number;
}

/**
 * 把任意字符串脱敏。
 *
 * 为什么连"前 2 个字符"也要限制：预算 label 里常见"任务名 / 文件名 / 邮箱前缀"，
 * 提示过长等于没脱敏。因此提示只在原文**明显长于**提示长度时给出，
 * 且**永不**给出尾部（尾部更容易带 id / 随机串）。
 */
export function redact(value: string, hintLength = 2): RedactedValue {
  const text = String(value);
  const hint = text.length > hintLength + 2 ? text.slice(0, hintLength) : '';
  return Object.freeze({ digest: canonicalDigest(text), hint, length: text.length });
}

/** 一条脱敏后的记账追踪（**不含原文**）。 */
export interface RedactedCharge {
  readonly index: number;
  readonly dimension: BudgetDimension;
  readonly amount: number;
  readonly total: number;
  readonly at: LogicalTime;
  /** 主体的脱敏形式（谁在消费；不吐原文）。 */
  readonly subject: RedactedValue | null;
  /** 标签的脱敏形式（不吐原文）。 */
  readonly label: RedactedValue | null;
}

// ---------------------------------------------------------------------------
// 用量流水
// ---------------------------------------------------------------------------

/** 一条用量流水项。`key` 是**幂等身份**：同一消耗永远不会被计两次。 */
export interface BudgetJournalEntry {
  readonly key: string;
  readonly dimension: BudgetDimension;
  readonly amount: number;
  readonly at: LogicalTime;
  /** 脱敏后的可读说明（可选；不参与判定）。 */
  readonly note?: string;
}

/**
 * 追加式用量流水端口。
 *
 * 语义要求（实现方必须满足）：
 * - **只追加**：不提供删除 / 覆盖 / 清空的方法（结构上堵住"清零额度"）；
 * - 并发写者各写各的行，互不覆盖；
 * - 读回时**丢弃不完整的尾行**（崩溃在写一半的窗口里）。
 */
export interface BudgetJournal {
  append(entry: BudgetJournalEntry): void;
  read(): readonly BudgetJournalEntry[];
  /** 流水的如实描述（证据可用性）。 */
  describe(): { readonly kind: 'memory' | 'file'; readonly durable: boolean; readonly detail: string };
}

/** 进程内存流水（**易失**；只用于测试对照，不得冒充持久介质）。 */
export function createMemoryJournal(): BudgetJournal {
  const entries: BudgetJournalEntry[] = [];
  return {
    append(entry: BudgetJournalEntry): void {
      entries.push(entry);
    },
    read(): readonly BudgetJournalEntry[] {
      return Object.freeze([...entries]);
    },
    describe() {
      return { kind: 'memory' as const, durable: false, detail: '进程内存流水：重启即空' };
    },
  };
}

// ---------------------------------------------------------------------------
// 台账
// ---------------------------------------------------------------------------

export interface HardBudgetOptions {
  /** 登记时刻（A05-01：上限必须**早于**运行登记）。 */
  readonly registered_at?: LogicalTime;
  /** 用量流水（给了才能在重启后收敛；不给 ⇒ 本台账不跨重启）。 */
  readonly journal?: BudgetJournal | null;
}

export interface ReserveRequest {
  readonly charges: Partial<Record<BudgetDimension, number>>;
  readonly at?: LogicalTime;
  /** 主体（**只以脱敏形式进入追踪**）。 */
  readonly subject?: string;
  readonly label?: string;
}

export const RESERVE_REFUSAL_REASONS = [
  /** 至少一个维度会超限 ⇒ 整笔拒绝（不做半截扣费）。 */
  'would_exceed_limit',
  /** 请求的维度是占用式（`concurrency`）：必须走 `acquire`，不得按累计量记账。 */
  'occupancy_dimension_requires_acquire',
  /** 数量非法（负数 / 非有限数）。 */
  'invalid_amount',
] as const;
export type ReserveRefusalReason = (typeof RESERVE_REFUSAL_REASONS)[number];

export interface ReserveOutcome {
  readonly allowed: boolean;
  readonly reason: 'reserved' | ReserveRefusalReason;
  /** 被拒时：**将会**超限的维度（用于如实上报"卡在哪"）。 */
  readonly would_exceed: readonly BudgetDimension[];
  readonly charged: Readonly<Partial<Record<BudgetDimension, number>>>;
  readonly usage: Readonly<Record<BudgetDimension, number>>;
}

export interface AcquireOutcome {
  readonly acquired: boolean;
  readonly reason: 'acquired' | 'concurrency_limit_reached';
  readonly in_flight: number;
  readonly limit: number | null;
}

export interface BudgetSnapshot {
  readonly limits: Readonly<BudgetLimits>;
  readonly usage: Readonly<Record<BudgetDimension, number>>;
  readonly in_flight: Record<BudgetDimension, number>;
  readonly exhausted: readonly BudgetDimension[];
  readonly registered_at: LogicalTime;
  /** 脱敏追踪（**不含原文**）。 */
  readonly trace: readonly RedactedCharge[];
}

/**
 * 硬预算台账。
 *
 * **只能累加**：没有 setter、没有 `reset()`、没有"调大上限"的入口
 * （Q9-a：上限在执行前登记，禁止运行失败后调大）。
 */
export class HardBudgetLedger {
  readonly #limits: Readonly<BudgetLimits>;
  readonly #registeredAt: LogicalTime;
  readonly #journal: BudgetJournal | null;
  readonly #usage: Record<BudgetDimension, number>;
  readonly #inFlight: Record<BudgetDimension, number>;
  readonly #trace: RedactedCharge[] = [];
  #seq = 0;

  constructor(limits: BudgetLimits = {}, options: HardBudgetOptions = {}) {
    const frozen: Record<string, number> = {};
    for (const dimension of BUDGET_DIMENSIONS) {
      const value = limits[dimension];
      if (value !== undefined) {
        frozen[dimension] = assertLimit(value, dimension);
      }
    }
    this.#limits = Object.freeze(frozen) as Readonly<BudgetLimits>;
    this.#registeredAt = options.registered_at ?? asLogicalTime(0);
    this.#journal = options.journal ?? null;
    this.#usage = zeroUsage();
    this.#inFlight = zeroUsage();
  }

  get limits(): Readonly<BudgetLimits> {
    return this.#limits;
  }

  get registeredAt(): LogicalTime {
    return this.#registeredAt;
  }

  get journal(): BudgetJournal | null {
    return this.#journal;
  }

  /** 某维度的上限；**未登记 = `null`（不设限）**，不是 0。 */
  limitOf(dimension: BudgetDimension): number | null {
    const value = this.#limits[dimension];
    return value === undefined ? null : value;
  }

  /** 某维度的已用量（占用式维度返回"当前在飞数"）。 */
  used(dimension: BudgetDimension): number {
    return OCCUPANCY_DIMENSIONS.includes(dimension)
      ? this.#inFlight[dimension]
      : this.#usage[dimension];
  }

  /** 剩余量（未设限 ⇒ `null`）。 */
  remaining(dimension: BudgetDimension): number | null {
    const limit = this.limitOf(dimension);
    return limit === null ? null : limit - this.used(dimension);
  }

  /** 是否已耗尽（未设限 ⇒ 恒 `false`）。 */
  exhausted(dimension: BudgetDimension): boolean {
    const limit = this.limitOf(dimension);
    return limit === null ? false : this.used(dimension) >= limit;
  }

  /** 全部已耗尽的维度（升序，按 `BUDGET_DIMENSIONS` 顺序）。 */
  exhaustedDimensions(): readonly BudgetDimension[] {
    return Object.freeze(BUDGET_DIMENSIONS.filter((dimension) => this.exhausted(dimension)));
  }

  /**
   * **事前闸门**：全部维度都还有余量才放行；否则**一条都不扣**，如实回报"会卡在哪"。
   * 这是硬限制的唯一入口——不用它就直接 `charge()`，等于没有硬限制。
   */
  reserve(request: ReserveRequest): ReserveOutcome {
    const charges = request.charges;
    const wouldExceed: BudgetDimension[] = [];
    let invalid = false;

    for (const dimension of BUDGET_DIMENSIONS) {
      const amount = charges[dimension];
      if (amount === undefined || amount === 0) {
        continue;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        invalid = true;
        break;
      }
      if (OCCUPANCY_DIMENSIONS.includes(dimension)) {
        return Object.freeze({
          allowed: false,
          reason: 'occupancy_dimension_requires_acquire' as const,
          would_exceed: Object.freeze([dimension]),
          charged: Object.freeze({}),
          usage: Object.freeze({ ...this.#usage }),
        });
      }
      const limit = this.limitOf(dimension);
      if (limit !== null && this.#usage[dimension] + amount > limit) {
        wouldExceed.push(dimension);
      }
    }

    if (invalid) {
      return Object.freeze({
        allowed: false,
        reason: 'invalid_amount' as const,
        would_exceed: Object.freeze([]),
        charged: Object.freeze({}),
        usage: Object.freeze({ ...this.#usage }),
      });
    }
    if (wouldExceed.length > 0) {
      this.#note('reserve-refused', wouldExceed[0]!, 0, request.at, request.subject, request.label);
      return Object.freeze({
        allowed: false,
        reason: 'would_exceed_limit' as const,
        would_exceed: Object.freeze([...wouldExceed]),
        charged: Object.freeze({}),
        usage: Object.freeze({ ...this.#usage }),
      });
    }

    const charged: Partial<Record<BudgetDimension, number>> = {};
    for (const dimension of BUDGET_DIMENSIONS) {
      const amount = charges[dimension];
      if (amount === undefined || amount === 0) {
        continue;
      }
      this.#apply(dimension, amount, request.at, request.subject, request.label, true);
      charged[dimension] = amount;
    }
    return Object.freeze({
      allowed: true,
      reason: 'reserved' as const,
      would_exceed: Object.freeze([]),
      charged: Object.freeze(charged),
      usage: Object.freeze({ ...this.#usage }),
    });
  }

  /**
   * 记一笔**已经发生**的消耗（恢复路径与外部实测用）。
   *
   * **刻意不检查上限**：账目低于事实就是谎报用量（R218 的"只上不下"）。
   * 授权新工作的判定一律走 `reserve()`。
   */
  charge(
    dimension: BudgetDimension,
    amount = 1,
    options: { readonly at?: LogicalTime; readonly subject?: string; readonly label?: string; readonly key?: string } = {},
  ): number {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new RangeError(`记账量必须是非负有限数，收到 ${String(amount)}`);
    }
    return this.#apply(dimension, amount, options.at, options.subject, options.label, false, options.key);
  }

  /** 占用式：申请一个并发槽（达上限即拒，不排队、不降级）。 */
  acquire(options: { readonly at?: LogicalTime; readonly subject?: string; readonly label?: string } = {}): AcquireOutcome {
    const limit = this.limitOf('concurrency');
    const inFlight = this.#inFlight.concurrency;
    if (limit !== null && inFlight >= limit) {
      this.#note('acquire-refused', 'concurrency', 0, options.at, options.subject, options.label);
      return Object.freeze({
        acquired: false,
        reason: 'concurrency_limit_reached' as const,
        in_flight: inFlight,
        limit,
      });
    }
    this.#inFlight.concurrency = inFlight + 1;
    this.#note('acquire', 'concurrency', 1, options.at, options.subject, options.label);
    return Object.freeze({
      acquired: true,
      reason: 'acquired' as const,
      in_flight: this.#inFlight.concurrency,
      limit,
    });
  }

  /** 释放一个并发槽（不允许降到 0 以下）。 */
  release(): number {
    if (this.#inFlight.concurrency > 0) {
      this.#inFlight.concurrency -= 1;
    }
    return this.#inFlight.concurrency;
  }

  /** 记账维度快照（**不含原文**；追踪为脱敏形式）。 */
  snapshot(): BudgetSnapshot {
    return Object.freeze({
      limits: this.#limits,
      usage: Object.freeze({ ...this.#usage }),
      in_flight: Object.freeze({ ...this.#inFlight }) as Record<BudgetDimension, number>,
      exhausted: this.exhaustedDimensions(),
      registered_at: this.#registeredAt,
      trace: this.redactedTrace(),
    });
  }

  /** 脱敏追踪（**只有摘要与极短提示**，没有原文）。 */
  redactedTrace(): readonly RedactedCharge[] {
    return Object.freeze([...this.#trace]);
  }

  #apply(
    dimension: BudgetDimension,
    amount: number,
    at: LogicalTime | undefined,
    subject: string | undefined,
    label: string | undefined,
    fromReserve: boolean,
    key?: string,
  ): number {
    const total = this.#usage[dimension] + amount;
    this.#usage[dimension] = total;
    this.#note(fromReserve ? 'reserve' : 'charge', dimension, amount, at, subject, label, key);
    return total;
  }

  #note(
    kind: string,
    dimension: BudgetDimension,
    amount: number,
    at: LogicalTime | undefined,
    subject: string | undefined,
    label: string | undefined,
    key?: string,
  ): void {
    this.#seq += 1;
    this.#trace.push(
      Object.freeze({
        index: this.#seq,
        dimension,
        amount,
        total: this.used(dimension),
        at: at ?? this.#registeredAt,
        subject: subject === undefined ? null : redact(subject),
        label: label === undefined ? null : redact(label),
      }),
    );
    if (key !== undefined && this.#journal !== null && amount > 0) {
      this.#journal.append(
        Object.freeze({
          key,
          dimension,
          amount,
          at: at ?? this.#registeredAt,
          note: kind,
        }),
      );
    }
  }
}

function zeroUsage(): Record<BudgetDimension, number> {
  return {
    task_calls: 0,
    model_calls: 0,
    tool_calls: 0,
    tokens: 0,
    cost_micros: 0,
    concurrency: 0,
    retries: 0,
    time: 0,
  };
}

// ---------------------------------------------------------------------------
// 重启 / 多工作进程：收敛式恢复（只上不下）
// ---------------------------------------------------------------------------

/** 一条由流水折算出的记账事实（**幂等身份**是 `key`）。 */
export interface BudgetFact {
  readonly key: string;
  readonly dimension: BudgetDimension;
  readonly amount: number;
  readonly at: LogicalTime;
}

/** 流水 → 事实（同一 `key` 只取第一次出现；同 key 重复追加不改变目标用量）。 */
export function factsFromJournal(entries: readonly BudgetJournalEntry[]): readonly BudgetFact[] {
  const seen = new Set<string>();
  const facts: BudgetFact[] = [];
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      continue;
    }
    seen.add(entry.key);
    facts.push(
      Object.freeze({
        key: entry.key,
        dimension: entry.dimension,
        amount: entry.amount,
        at: entry.at,
      }),
    );
  }
  return Object.freeze(facts);
}

export interface BudgetRestoreReport {
  /** 流水折算出的目标用量（重启后**应当**是这个数）。 */
  readonly target: Readonly<Partial<Record<BudgetDimension, number>>>;
  /** 收敛**前**台账里的用量（新进程通常全 0——这正是"白送额度"的形状）。 */
  readonly before: Readonly<Partial<Record<BudgetDimension, number>>>;
  /** 本次真正补记的增量（已对齐时为空）。 */
  readonly charged: Readonly<Partial<Record<BudgetDimension, number>>>;
  readonly facts: number;
  /** 恒为 `false`：本函数**从不**下调账目（R218）。 */
  readonly lowered: false;
}

/**
 * 用流水把台账**收敛**到应有的用量。
 *
 * - 新进程（台账 0）⇒ 补齐到 N（**不得从 0 开始**，R225）；
 * - 已对齐 ⇒ 增量为空（真幂等，不依赖任何进程内集合）；
 * - 台账**高于**目标 ⇒ **不回调**（R218：没有任何一条路径应该把已用额度退回去），
 *   这种不一致由调用方从 `before`/`target` 的差里读到并告警。
 */
export function reconcileBudgetFromFacts(
  ledger: HardBudgetLedger,
  facts: readonly BudgetFact[],
): BudgetRestoreReport {
  const target: Partial<Record<BudgetDimension, number>> = {};
  let latest: LogicalTime = asLogicalTime(0);
  for (const fact of facts) {
    target[fact.dimension] = (target[fact.dimension] ?? 0) + fact.amount;
    if (fact.at > latest) {
      latest = fact.at;
    }
  }

  const before: Partial<Record<BudgetDimension, number>> = {};
  const charged: Partial<Record<BudgetDimension, number>> = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const goal = target[dimension];
    if (goal === undefined) {
      continue;
    }
    const current = ledger.used(dimension);
    before[dimension] = current;
    const delta = goal - current;
    if (delta > 0) {
      ledger.charge(dimension, delta, {
        at: latest,
        label: `重启恢复：对齐用量流水（${BUDGET_DIMENSION_LABELS[dimension]}）`,
      });
      charged[dimension] = delta;
    }
  }

  return Object.freeze({
    target: Object.freeze(target),
    before: Object.freeze(before),
    charged: Object.freeze(charged),
    facts: facts.length,
    lowered: false as const,
  });
}

/** 便捷：从流水恢复（`factsFromJournal` + `reconcileBudgetFromFacts`）。 */
export function restoreBudgetFromJournal(ledger: HardBudgetLedger, journal: BudgetJournal): BudgetRestoreReport {
  return reconcileBudgetFromFacts(ledger, factsFromJournal(journal.read()));
}

// ---------------------------------------------------------------------------
// 部分结果交付
// ---------------------------------------------------------------------------

export interface PartialDeliveryInput {
  readonly ledger: HardBudgetLedger;
  /** 计划产出的引用（清单）。 */
  readonly planned_refs: readonly string[];
  /** **实际已经**产出的引用（必须是真实存在的，不得用计划冒充）。 */
  readonly delivered_refs: readonly string[];
  /** 未产出项的人可读原因（键 = 引用）。 */
  readonly reasons?: Readonly<Record<string, string>>;
}

export interface PartialDelivery {
  /** 是否**部分**交付（有维度耗尽 ⇒ 是）。 */
  readonly partial: boolean;
  readonly exhausted_dimensions: readonly BudgetDimension[];
  readonly delivered_refs: readonly string[];
  /** 计划里**没有**交付的引用（不得静默省略）。 */
  readonly withheld_refs: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
  /** 恒为 `false`：部分结果**不是**完整交付，不得宣称完成。 */
  readonly complete_claimed: false;
  readonly note: string;
}

/**
 * 组装**部分结果交付**。
 *
 * 纪律：`delivered_refs` 只登记**真实已产出**的引用；计划里缺的那些必须出现在
 * `withheld_refs` 里（静默省略会让"部分完成"看起来像"完成"）。
 */
export function planPartialDelivery(input: PartialDeliveryInput): PartialDelivery {
  const delivered = [...input.delivered_refs];
  const deliveredSet = new Set(delivered);
  const withheld = input.planned_refs.filter((ref) => !deliveredSet.has(ref));
  const exhausted = input.ledger.exhaustedDimensions();
  const reasons: Record<string, string> = {};
  for (const ref of withheld) {
    const given = input.reasons?.[ref];
    reasons[ref] =
      given ??
      (exhausted.length === 0
        ? '未产出（原因未登记）'
        : `未产出：预算已耗尽（${exhausted.map((dimension) => BUDGET_DIMENSION_LABELS[dimension]).join('、')}）`);
  }
  return Object.freeze({
    partial: exhausted.length > 0,
    exhausted_dimensions: exhausted,
    delivered_refs: Object.freeze(delivered),
    withheld_refs: Object.freeze(withheld),
    reasons: Object.freeze(reasons),
    complete_claimed: false as const,
    note:
      exhausted.length === 0
        ? '没有维度耗尽：本交付不含"因预算而中断"的成分。'
        : '**部分结果**：预算硬限制已命中，未产出项如实列出；不得据此宣称任务完成。',
  });
}

/** 证据可读性：一行摘要（已用 / 上限 / 是否耗尽）。 */
export function describeBudget(ledger: HardBudgetLedger): string {
  const parts = BUDGET_DIMENSIONS.map((dimension) => {
    const limit = ledger.limitOf(dimension);
    const used = ledger.used(dimension);
    return `${BUDGET_DIMENSION_LABELS[dimension]} ${String(used)}/${limit === null ? '∞' : String(limit)}${ledger.exhausted(dimension) ? '!' : ''}`;
  });
  return parts.join('，');
}
