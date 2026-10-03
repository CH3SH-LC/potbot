/**
 * **预算硬限制接入产品运行链路**（FA-KRN-BUDGET-PRODUCT）。
 *
 * ## 这一层修的是什么
 *
 * 内核（`src/scheduler/budgets.ts` / `budget-projection.ts` / `loop-limits.ts`）已经能算硬限制，
 * 但**产品面**上还没有一条路径把它接进真实运行目录。本模块是**接线**，不是第二套语义：
 * 闸门仍是 `HardBudgetLedger.reserve()`，收敛仍是 `restoreBudgetFromJournal()`，
 * 部分结果仍是 `planPartialDelivery()`，脱敏仍是 `ledger.redactedTrace()`。
 * 本文件只做四件产品化的事：
 *
 * | # | 事 | 依据 |
 * |---|---|---|
 * | 1 | 把**八维上限**从产品配置装配；**缺项即抛**（"没有上限"不是合法配置） | R225 / R27.1 |
 * | 2 | 事前闸门走 `reserve()`；超限**整笔拒、一条都不扣** | R225 |
 * | 3 | 用量**落盘**到运行目录下 JSONL（追加写），重启后**只上不下**地收敛 | R218 / R225 |
 * | 4 | 追踪脱敏、耗尽时给**部分结果 + 未产出项 + 原因**，`complete_claimed` 恒 `false` | R225 |
 *
 * ## 为什么"缺项即抛"而**不是**"缺项=不设限"
 *
 * 内核的 `BudgetLimits` 里，未登记的维度语义是 `null`（不设限）。若产品层直接把
 * `Partial<Record<..>>` 透传给内核，"忘记配 token 上限"会退化成"token 无限"——这正是
 * 硬限制失效的最短路径。因此 `resolveProductBudgetLimits()` 对八个维度**逐个要求**显式给全，
 * 缺项一律抛 `ValidationError`（与 `loop-limits.ts` 对循环上限同一纪律）。
 *
 * ## 事前闸门 + 落盘流水的分工（**重要，避免双重记账**）
 *
 * 内核的 `reserve()` 只改**进程内**账目，**不写流水**（只有带 `key` 的 `charge()` 才写）。
 * 所以本接线层把"授权并落盘"合成一个动作 `admit({ charges, ... })`：
 *
 * 1. 先 `ledger.reserve(charges)`——超限整笔拒、一条都不扣；
 * 2. 放行后把每个被扣维度**以 `<身份>::dimension` 追加进落盘流水**（**无条件**写，见下）。
 *
 * 这样**同一条消耗只记一次**：进程内账目由 `reserve` 记，跨重启的真相由流水记，
 * 后者在重启时经 `restoreBudgetFromJournal()` 收敛成新台账的用量（`factsFromJournal` 按 `key` 去重）。
 * 额度按"放行即计入"（**宁严不松**）：放行后被取消的工作不会退额度。
 *
 * ### 持久幂等身份由**服务端**确定，且**一律落盘**（本次修的两条病灶）
 *
 * - **不接受"没有 key 就不落盘"**：旧实现只在调用方给了 `key` 时才写流水，于是"不带 key 的一笔"
 *   在重启后查无实据 ⇒ 额度**回升**（等于没扣）。现在 `admit()` **无条件**落盘：调用方给了 `key`
 *   就用它；没给就由服务端生成一个**进程内唯一、不含任何随机量**的身份
 *   （`pid` + 起始毫秒 + 序号，与 `ProductBudgetGate.nextKey()` 同一纪律）。跨重启起始毫秒不同
 *   ⇒ 不与上一进程重号，因此**每一笔放行都对应一条不同的流水**，重启收敛时逐笔补齐。
 *   为什么身份**不**用"请求内容摘要"：同毫秒 + 同内容的两次调用会撞号，流水按 `key` 去重后
 *   只折算一笔，重启后额度照样回升——那正是本次要根除的病灶。
 * - **计费量由服务端确定**（`serverDeterminedCharges()`）：客户端送来的 `charges` 数字**只作参考**，
 *   记账量一律由服务端按"声明的维度 + 实测输入规模"算出，**绝不**采用调用方给的数量；
 *   请求体里的数字进不了台账。
 *
 * `concurrency` 是**占用式**维度，刻意**不落盘**：在飞数在进程退出后没有意义，
 * 重启后正确地回到 0；尝试把并发当累计量 `reserve()` 会被内核以
 * `occupancy_dimension_requires_acquire` 拒掉，本层不改写这一语义。
 *
 * ## 诚实边界（不得据此宣称的结论）
 *
 * - **未做真实多进程**：JSONL 追加用一次 `appendFileSync`（单次 `O_APPEND` 写、不重写整文件），
 *   这是"并发写者各写各的行"的**近似**；**两个真实进程并发追加的实测未做**，本模块与测试都
 *   只做**同进程**的"新台账读同一份流水"模拟。真实跨进程并发追加的原子性**未验证**。
 * - 本模块不发明第二套计量：用量真相始终在注入的 `HardBudgetLedger` 与流水里。
 * - 本模块不提供任何"清零 / 调大上限"的入口（结构上堵死"运行失败后放宽"）。
 * - **持久幂等身份是进程作用域的**：同一份流水由两个**同时存活**的进程追加时，两侧的身份基
 *   （`pid` + 起始毫秒）不同、不会互相撞号；但"两个真实进程并发追加的原子性"仍未实测（见上条）。
 * - "额度不回升"这条结论只覆盖**同一个运行目录**：换目录即换台账，不跨目录收敛（反向对照见测试）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ValidationError, asLogicalTime, type LogicalTime } from '../../../src/protocol/index.js';
import {
  BUDGET_DIMENSIONS,
  BUDGET_DIMENSION_LABELS,
  HardBudgetLedger,
  planPartialDelivery,
  restoreBudgetFromJournal,
  type BudgetDimension,
  type BudgetJournal,
  type BudgetJournalEntry,
  type BudgetSnapshot,
  type PartialDelivery,
  type PartialDeliveryInput,
  type ModelTurnInput,
  type ModelTurnOutput,
  type ModelTurnPort,
  type RedactedCharge,
  type ReserveOutcome,
  type ReserveRequest,
  type ToolCallRequest,
  type ToolExecutorPort,
  type ToolReceipt,
} from '../../../src/scheduler/index.js';
// `BudgetRestoreReport` 在 `src/scheduler` 桶里**同名但有歧义**：`budget-projection.ts` 的
// `runs / time / diagnoses` 版本与 `budgets.ts` 的**八维**版本重名，桶解析到前者。
// 本接线层要的是八维那一份（与 `restoreBudgetFromJournal()` 的返回类型**同源**），
// 因此直接从 `./budgets.js` 具名导入，不靠桶。
import type { BudgetRestoreReport } from '../../../src/scheduler/budgets.js';
// 只借**类型**（`gateToolLoopHost` 要包一层 `ToolLoopHost`）；不进运行时依赖图。
import type { ToolLoopHost } from './tool-loop-product.js';

// ---------------------------------------------------------------------------
// 1：八维上限的装配（缺项即抛）
// ---------------------------------------------------------------------------

/** 产品的**八维**预算配置：八个维度**一个都不能少**。 */
export type ProductBudgetConfig = Readonly<Record<BudgetDimension, number>>;

/** 产品配置的宽松输入（允许缺项，缺项会在 `resolve` 时被点名抛出）。 */
export type ProductBudgetConfigInput = Partial<Record<BudgetDimension, number>>;

/** 维度 → 产品配置键（默认取环境变量名；`budgetLimitsFromEnv()` 用同一张表）。 */
export const PRODUCT_BUDGET_ENV_KEYS: Readonly<Record<BudgetDimension, string>> = Object.freeze({
  task_calls: 'POTBOT_BUDGET_TASK_CALLS',
  model_calls: 'POTBOT_BUDGET_MODEL_CALLS',
  tool_calls: 'POTBOT_BUDGET_TOOL_CALLS',
  tokens: 'POTBOT_BUDGET_TOKENS',
  cost_micros: 'POTBOT_BUDGET_COST_MICROS',
  concurrency: 'POTBOT_BUDGET_CONCURRENCY',
  retries: 'POTBOT_BUDGET_RETRIES',
  time: 'POTBOT_BUDGET_TIME',
});

/**
 * **只读探测器**：这份配置里哪些维度没有声明上限（`undefined` / `null`）。
 *
 * 它是"可超限的闸门必须被检出"的判据：未登记的维度在**内核**里等于不设限，
 * 因此产品层必须能一眼列出"漏配了哪几维"。
 */
export function detectUnboundedDimensions(raw: ProductBudgetConfigInput): readonly BudgetDimension[] {
  return Object.freeze(
    BUDGET_DIMENSIONS.filter((dimension) => {
      const value = raw[dimension];
      return value === undefined || value === null;
    }),
  );
}

/**
 * 校验八维上限并冻结。
 *
 * **缺项 ⇒ 抛**：不静默套默认、不把缺项当"不设限"。数值必须是**非负整数**
 * （费用用整数微元，不用浮点表达钱；时间 / token 也一律整数计数）。
 */
export function resolveProductBudgetLimits(raw: ProductBudgetConfigInput): ProductBudgetConfig {
  const missing = detectUnboundedDimensions(raw);
  if (missing.length > 0) {
    throw new ValidationError(
      `预算配置缺少 ${String(missing.length)} 个维度的上限（${missing
        .map((dimension) => BUDGET_DIMENSION_LABELS[dimension])
        .join('、')}）："没有上限"不是合法配置——` +
        '八个维度必须显式给全，未登记的维度在本产品里**不得**被当成"不设限"',
    );
  }

  const frozen: Partial<Record<BudgetDimension, number>> = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const value = raw[dimension];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new ValidationError(
        `预算上限必须是**非负整数**（${BUDGET_DIMENSION_LABELS[dimension]}），收到 ${String(value)}：` +
          '算不出上限时不得静默通过',
      );
    }
    frozen[dimension] = value;
  }
  return Object.freeze(frozen) as ProductBudgetConfig;
}

/**
 * 从环境变量装配八维上限（`POTBOT_BUDGET_*`，见 `PRODUCT_BUDGET_ENV_KEYS`）。
 *
 * 缺键 / 空串 / 非数字**都不算"没设"**：它们会走到 `resolveProductBudgetLimits()` 并抛错。
 * 这是刻意的——把"忘了配"变成一个**响亮的启动失败**，而不是一个安静的无限额度。
 */
export function budgetLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): ProductBudgetConfig {
  const raw: ProductBudgetConfigInput = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const text = env[PRODUCT_BUDGET_ENV_KEYS[dimension]];
    if (text !== undefined && text.trim() !== '') {
      raw[dimension] = Number(text);
    }
  }
  return resolveProductBudgetLimits(raw);
}

// ---------------------------------------------------------------------------
// 3：运行目录下的 JSONL 落盘流水
// ---------------------------------------------------------------------------

/** 运行目录下预算流水的默认文件名（与 `kernel-store/`、`sessions/` 各占各的文件）。 */
export const DEFAULT_BUDGET_JOURNAL_FILE = 'budget-journal.jsonl';

export interface RunDirBudgetJournalOptions {
  /** 流水文件名（默认 `budget-journal.jsonl`）。 */
  readonly fileName?: string;
  /** 读到坏行 / 不完整尾行时的回调（证据可读性；不参与判定）。 */
  readonly onDrop?: (info: { readonly dropped: number; readonly path: string }) => void;
}

class RunDirJournal implements BudgetJournal {
  readonly path: string;
  readonly #fileName: string;
  readonly #onDrop: RunDirBudgetJournalOptions['onDrop'];
  #dropped = 0;

  constructor(runDir: string, options: RunDirBudgetJournalOptions) {
    this.#fileName = options.fileName ?? DEFAULT_BUDGET_JOURNAL_FILE;
    this.#onDrop = options.onDrop;
    this.path = join(runDir, this.#fileName);
  }

  /** 最后一次 `read()` 丢弃的坏行数（不完整尾行 / 非法行）。 */
  get droppedLines(): number {
    return this.#dropped;
  }

  /**
   * 追加一行。
   *
   * 一次 `appendFileSync` = 一次 `O_APPEND` 写，**不重写整文件**（重写才会让并发写者互相覆盖）。
   * **未验证**：两个真实进程并发追加的原子性（见文件头"诚实边界"）。
   */
  append(entry: BudgetJournalEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // 结尾带换行：JSONL 的"行"是自定界的，缺换行的尾行会被读成"写了一半"。
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 只追加读取：坏行 / 不完整尾行**丢弃**（不让半个 JSON 伪装成有效用量）。 */
  read(): readonly BudgetJournalEntry[] {
    if (!existsSync(this.path)) {
      return Object.freeze([]);
    }
    const text = readFileSync(this.path, 'utf8');
    const entries: BudgetJournalEntry[] = [];
    this.#dropped = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line === '') {
        continue;
      }
      const entry = parseJournalEntry(line);
      if (entry === null) {
        this.#dropped += 1;
        continue;
      }
      entries.push(entry);
    }
    if (this.#dropped > 0) {
      this.#onDrop?.({ dropped: this.#dropped, path: this.path });
    }
    return Object.freeze(entries);
  }

  describe(): { readonly kind: 'file'; readonly durable: true; readonly detail: string } {
    return Object.freeze({
      kind: 'file' as const,
      durable: true as const,
      detail:
        `JSONL 落盘流水（追加写）：${this.path}；重启后收敛且只上不下。` +
        '**未验证**：两个真实进程并发追加的原子性（本次只做同进程模拟）。',
    });
  }
}

/**
 * 建一个落在运行目录下的 JSONL 流水。
 *
 * 位置：`<runDir>/<fileName>`。与 `kernel-store/store.json`、`sessions/`、`app-index.json`
 * **各占各的文件**，互不覆盖。
 */
export function createRunDirBudgetJournal(
  runDir: string,
  options: RunDirBudgetJournalOptions = {},
): BudgetJournal & { readonly path: string; readonly droppedLines: number } {
  return new RunDirJournal(runDir, options);
}

/** 单行 JSON → 流水项；形状不符（含半个 JSON）⇒ `null`（调用方丢弃）。 */
function parseJournalEntry(line: string): BudgetJournalEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const key = record['key'];
  const dimension = record['dimension'];
  const amount = record['amount'];
  const at = record['at'];
  const note = record['note'];
  if (typeof key !== 'string' || key === '') {
    return null;
  }
  if (typeof dimension !== 'string' || !(BUDGET_DIMENSIONS as readonly string[]).includes(dimension)) {
    return null;
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return null;
  }
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    return null;
  }
  return Object.freeze({
    key,
    dimension: dimension as BudgetDimension,
    amount,
    at: asLogicalTime(at),
    ...(typeof note === 'string' ? { note } : {}),
  });
}

// ---------------------------------------------------------------------------
// 只读探测器（反向对照的判据）
// ---------------------------------------------------------------------------

/** 换目录后"仍读到旧额度"的探针输入。 */
export interface ForeignQuotaProbe {
  readonly dimension: BudgetDimension;
  /** 探针申请量；应取"在**全新**额度下放行"的量（否则无法把旧用量与新上限区分开）。 */
  readonly amount: number;
}

export interface ForeignQuotaVerdict {
  /** `true` = 该台账读到了不属于本运行目录的额度（换目录仍读到旧额度）。 */
  readonly foreign_usage_detected: boolean;
  /** 探测前该维度的已用量（独立运行目录必须是 0）。 */
  readonly before_usage: number;
  /** 探针是否落在"全新额度"里（只读计算，**不**改动台账）。 */
  readonly fits_fresh_quota: boolean;
}

/**
 * **只读**判定：一份台账是否"带着别处的额度"。
 *
 * 独立运行目录的正确形状是 `before_usage === 0` 且探针放行；若接线误把新实例指向旧流水，
 * `before_usage > 0`（或探针被旧用量挤掉）⇒ 检出。**不调用 `reserve`**，不改动台账。
 */
export function detectForeignQuota(ledger: HardBudgetLedger, probe: ForeignQuotaProbe): ForeignQuotaVerdict {
  const before = ledger.used(probe.dimension);
  const limit = ledger.limitOf(probe.dimension);
  const fits = limit === null ? true : before + probe.amount <= limit;
  return Object.freeze({
    foreign_usage_detected: before > 0 || !fits,
    before_usage: before,
    fits_fresh_quota: fits,
  });
}

/**
 * **只读**判定：追踪里是否出现了原文。
 *
 * 预算追踪常被写进日志与证据文件，原文里可能有用户内容或凭据。
 * 返回**被泄露的原文清单**（空 = 干净）。
 */
export function detectRawLeak(
  trace: readonly RedactedCharge[],
  secrets: readonly string[],
): readonly string[] {
  const serialized = JSON.stringify(trace);
  return Object.freeze(secrets.filter((secret) => secret !== '' && serialized.includes(secret)));
}

// ---------------------------------------------------------------------------
// 服务端计费策略：**计费量由服务端确定**，请求体里的数字只作参考
// ---------------------------------------------------------------------------

/**
 * 服务端计费策略。
 *
 * 客户端在请求体里送来的 `charges` **只用来声明"这次算哪几维"**（维度），
 * **数量一律由服务端按本策略算出**——请求体里的数字进不了台账。
 * 这样"这次只花 0.0001"这类自报就无效了：硬限制不再受被限制方控制。
 */
export interface ServerChargePolicy {
  /** 每个被声明的维度，服务端固定计多少（默认 `1`：一次调用记 1 笔）。 */
  readonly per_dimension: number;
  /** 输入规模折算：每多少字节输入折 1 个 token（服务端**测量**实际收到的字节数；`0` ⇒ 不按规模计费）。 */
  readonly bytes_per_token: number;
  /** 声明了 `tokens` 维度时，固定计入的 token 底数。 */
  readonly base_tokens: number;
}

/** 默认策略：一次调用记 1 笔；`tokens` 按 **实测输入字节 / 64** 上取整（另加 `base_tokens` 底数，默认 0）。 */
export const DEFAULT_SERVER_CHARGE_POLICY: ServerChargePolicy = Object.freeze({
  per_dimension: 1,
  bytes_per_token: 64,
  base_tokens: 0,
});

/**
 * **由服务端确定**这一次调用记多少账。
 *
 * - `declared`：请求体声明的维度（键在 = 声明了该维；**值被忽略**）。
 * - `measured.input_bytes`：服务端**实测**收到的请求体字节数（不是调用方报的数）。
 *
 * 返回值里没有任何一个数字来自调用方：维度来自"声明了哪几维"，
 * 数量来自策略常数与实测规模。占用式维度（`concurrency`）**不得**在这里计成累计量
 * （`reserve()` 会以 `occupancy_dimension_requires_acquire` 拒掉，本函数不改写该语义）。
 */
export function serverDeterminedCharges(
  declared: Partial<Record<BudgetDimension, number>>,
  measured: { readonly input_bytes: number },
  policy: ServerChargePolicy = DEFAULT_SERVER_CHARGE_POLICY,
): Readonly<Partial<Record<BudgetDimension, number>>> {
  const charges: Partial<Record<BudgetDimension, number>> = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    if (declared[dimension] === undefined) {
      continue;
    }
    // 注意：这里**不读** declared[dimension] 的值——调用方给的数字只用来判"有没有声明"。
    charges[dimension] = policy.per_dimension;
  }
  if (declared['tokens'] !== undefined && policy.bytes_per_token > 0) {
    const size = Math.max(0, Math.floor(measured.input_bytes));
    const bySize = Math.ceil(size / policy.bytes_per_token);
    charges['tokens'] = (charges['tokens'] ?? 0) + policy.base_tokens + bySize;
  }
  return Object.freeze(charges);
}

// ---------------------------------------------------------------------------
// 产品接线：闸门 + 落盘 + 收敛
// ---------------------------------------------------------------------------

/**
 * 进程内实例序号：即使同一毫秒里建了两个接线实例（同一份运行目录），它们的身份基也**不同**，
 * 因此两边的放行各写各的流水、不会因 key 撞号在重启收敛时被去重成一笔（那会少扣）。
 */
let budgetInstanceSeq = 0;

export interface ProductBudgetOptions {
  /** 八维上限（缺项即抛）。 */
  readonly config: ProductBudgetConfigInput;
  /** 运行目录；流水落 `<runDir>/<journalFileName>`。 */
  readonly runDir: string;
  readonly journalFileName?: string;
  /** 登记时刻（A05-01：上限必须**早于**运行登记）。 */
  readonly registered_at?: LogicalTime;
}

/**
 * 一次放行申请：在 `ReserveRequest` 上补一个**幂等身份** `key`。
 *
 * **`key` 是可选的，但"省略"不再意味着"不落盘"**：省略时由服务端生成一个
 * **进程内唯一**的持久身份（见 `ProductBudgetWiring.admit()`），本笔照样写流水、照样跨重启收敛。
 */
export interface ProductReserveRequest extends ReserveRequest {
  /**
   * 持久幂等身份（**只应由服务端调用方提供**；`ProductBudgetGate` 传的就是服务端生成的键）。
   * 省略 ⇒ 服务端**代生成**一个进程内唯一的身份（`pid` + 起始毫秒 + 序号），**绝不**因此不落盘。
   * 面向客户端的 HTTP 边界**不得**把请求体里的 key 透传进来——那会让被限制方控制流水身份。
   */
  readonly key?: string;
}

/**
 * 产品预算接线：**唯一**的预算权威入口。
 *
 * 结构上**没有** `reset()` / `clear()` / `raiseLimit()` / 任何 setter——额度不能被清零或调大。
 */
export class ProductBudgetWiring {
  readonly #config: ProductBudgetConfig;
  readonly #journal: BudgetJournal & { readonly path: string; readonly droppedLines: number };
  readonly #ledger: HardBudgetLedger;
  readonly #restore: BudgetRestoreReport;
  /** 服务端身份基（`pid` + 起始毫秒）：不含随机量；跨重启不重号。 */
  readonly #keyBase: string;
  #keySeq = 0;

  constructor(options: ProductBudgetOptions) {
    this.#config = resolveProductBudgetLimits(options.config);
    this.#journal = createRunDirBudgetJournal(options.runDir, {
      ...(options.journalFileName === undefined ? {} : { fileName: options.journalFileName }),
    });
    this.#ledger = new HardBudgetLedger(this.#config, {
      ...(options.registered_at === undefined ? {} : { registered_at: options.registered_at }),
      journal: this.#journal,
    });
    // 服务端身份基：进程内唯一（pid + 起始毫秒 + 实例序号），不含随机量、不取客户端任何值。
    budgetInstanceSeq += 1;
    this.#keyBase = `budget-admit-${String(process.pid)}-${String(Date.now())}-${String(budgetInstanceSeq)}`;
    // 重启收敛（只上不下）：首启（流水空）时 target 为空、增量为空；有流水则补齐到应有用量。
    this.#restore = restoreBudgetFromJournal(this.#ledger, this.#journal);
  }

  /** 服务端代生成的持久幂等身份（`key` 省略时使用）；**绝不**用调用方给的数量或身份。 */
  #deriveKey(): string {
    this.#keySeq += 1;
    return `${this.#keyBase}:${String(this.#keySeq)}`;
  }

  /** 登记后的八维上限（冻结，只读）。 */
  get config(): ProductBudgetConfig {
    return this.#config;
  }

  /** 底层台账（**唯一**用量真相源；闸门与追踪都从它读）。 */
  get ledger(): HardBudgetLedger {
    return this.#ledger;
  }

  /** 流水文件路径（证据可用性）。 */
  get journalPath(): string {
    return this.#journal.path;
  }

  /** 本次构造的收敛报告（`lowered` 恒 `false`）。 */
  get restoreReport(): BudgetRestoreReport {
    return this.#restore;
  }

  /** 介质如实描述（落盘 = durable；detail 里写明"真实多进程未验证"）。 */
  medium(): { readonly kind: 'memory' | 'file'; readonly durable: boolean; readonly detail: string } {
    return this.#journal.describe();
  }

  /**
   * **事前闸门**：`reserve()` 超限 ⇒ **整笔拒、一条都不扣**；放行则把被扣维度**一律落盘**。
   *
   * 这是授权新工作的**唯一**入口（绕过它直接改账目 = 没有硬限制）。
   *
   * **放行后必写流水**（不再有"没给 key 就不落盘"这条路径）：`key` 省略时由服务端
   * 代生成一个进程内唯一的持久身份 ⇒ 重启后这笔照样被 `restoreBudgetFromJournal()` 收敛回来，
   * 额度**不会回升**。
   */
  admit(request: ProductReserveRequest): ReserveOutcome {
    const outcome = this.#ledger.reserve({
      charges: request.charges,
      ...(request.at === undefined ? {} : { at: request.at }),
      ...(request.subject === undefined ? {} : { subject: request.subject }),
      ...(request.label === undefined ? {} : { label: request.label }),
    });
    if (outcome.allowed) {
      const at = request.at ?? this.#ledger.registeredAt;
      // 身份：给了就用（内部调用方的服务端键），没给就**由服务端代生成**。
      const identity = request.key ?? this.#deriveKey();
      for (const dimension of BUDGET_DIMENSIONS) {
        const amount = outcome.charged[dimension];
        if (amount === undefined || amount === 0) {
          continue;
        }
        // 幂等身份 = `<身份>::<dimension>`：同一笔消耗在重启收敛时只折算一次。
        this.#journal.append(
          Object.freeze({
            key: `${identity}::${dimension}`,
            dimension,
            amount,
            at,
            note: 'product-admit',
          }),
        );
      }
    }
    return outcome;
  }

  /** 占用式：申请一个并发槽（达上限即拒，不排队、不降级）。 */
  acquire(options: { readonly at?: LogicalTime; readonly subject?: string; readonly label?: string } = {}) {
    return this.#ledger.acquire(options);
  }

  /** 释放一个并发槽。 */
  release(): number {
    return this.#ledger.release();
  }

  /** 记账快照（追踪为**脱敏**形式）。 */
  snapshot(): BudgetSnapshot {
    return this.#ledger.snapshot();
  }

  /** 脱敏追踪（**只有摘要与极短提示**，没有原文）。 */
  trace(): readonly RedactedCharge[] {
    return this.#ledger.redactedTrace();
  }

  /** 已用 / 上限 / 是否耗尽的一行摘要。 */
  describe(): string {
    return BUDGET_DIMENSIONS.map((dimension) => {
      const limit = this.#ledger.limitOf(dimension);
      const used = this.#ledger.used(dimension);
      return `${BUDGET_DIMENSION_LABELS[dimension]} ${String(used)}/${limit === null ? '∞' : String(limit)}${
        this.#ledger.exhausted(dimension) ? '!' : ''
      }`;
    }).join('，');
  }

  /** 额度耗尽时的**部分结果 + 未产出项 + 原因**（复用内核 `planPartialDelivery`）。 */
  partialDelivery(input: PartialDeliveryInput): PartialDelivery {
    return planPartialDelivery(input);
  }
}

/** 便捷构造。 */
export function createProductBudget(options: ProductBudgetOptions): ProductBudgetWiring {
  return new ProductBudgetWiring(options);
}

// ---------------------------------------------------------------------------
// N-7-10：把闸门接进**真模型 / 真工具调用**的事前路径
// ---------------------------------------------------------------------------
//
// 这一节修的缺陷：`ProductBudgetWiring` 之前只被自己的 test 与一条**合成**端点
// （`/api/session-adapters/tool-call`）引用，**真实**的模型往返（`/api/tool-loop/run`
// 的 `ModelTurnPort.nextTurn`）与真实工具执行（`ToolExecutorPort.invoke`）从未过闸门——
// 预算耗尽照样发请求。本节的装饰器把"授权"钉在**调用边界**上：
//
// - `gateToolLoopHost()`：整轮 `run()` 之前先 `admit('task')`（`task_calls`）——拒绝给出
//   **干净的 HTTP 状态**（耗尽 ⇒ `429`；未装配 ⇒ `503`）与 `planPartialDelivery` 的部分结果；
// - `gateModelTurnPort()`：`nextTurn` 之前先 `admit('model')`；拒绝 ⇒ **抛**，
//   底层端口的 `nextTurn` 一次都不会被触到（真实 HTTP 请求因此在发出前被拦住）。
// - `gateToolExecutor()`：`invoke` 之前先 `admit('tool')`；拒绝 ⇒ 返回**结构化回执**
//   （`ok:false` + `code`），**不**调用底层执行器（工具没有真的执行、没有副作用）。
//
// 三道记的是**不同维度**（`task_calls` / `model_calls` / `tool_calls`）⇒ **不重复记账**。
//
// ## 为什么"没有上限"是**拒绝**而不是"放行"
//
// `ProductBudgetGate` 允许 `budget === null`（否则整个服务器会因缺配而启动失败），
// 但**每一次**用它 `admit()` 都会抛 `BudgetGateRefusal`（`budget_not_configured`）。
// 于是"忘了配预算"= 每次真调用都被结构化拒，**绝不**退化成"不设限"。
//
// ## 诚实边界（不得据此宣称的结论）
//
// - 本节的幂等键带**进程内唯一后缀**（`pid` + 起始毫秒 + 序号）：同一进程内两次调用
//   不会共号；跨重启也不会与上一进程重号（起始毫秒不同）。这避免了"同 key 被流水去重 ⇒
//   重启后少算"。**两个真实进程**在同一毫秒启动且同 pid 的极端碰撞**未验证**。
// - 只接在**工具循环**这条真实链路上（`/api/tool-loop/**`）。连续对话链
//   （`/api/conversations/**`）的模型调用**未接**本节闸门——这是刻意的**未接线**边界，
//   不是"已接通"。

/** 一次"调用"的类别：整轮任务 / 模型往返 / 工具执行。 */
export type GatedCallKind = 'task' | 'model' | 'tool';

/** 类别 → 该次调用在**八维**里记哪一维（整轮记 `task_calls`，模型往返记 `model_calls`，工具执行记 `tool_calls`）。 */
export const GATED_CALL_CHARGES: Readonly<Record<GatedCallKind, Partial<Record<BudgetDimension, number>>>> =
  Object.freeze({
    task: Object.freeze({ task_calls: 1 }),
    model: Object.freeze({ model_calls: 1 }),
    tool: Object.freeze({ tool_calls: 1 }),
  });

/** 类别 → 中文标签（如实回报用）。 */
const GATED_KIND_LABELS: Readonly<Record<GatedCallKind, string>> = Object.freeze({
  task: '任务',
  model: '模型',
  tool: '工具',
});

/** 闸门拒绝的结构化信息（`BudgetGateRefusal` 的载荷）。 */
export interface BudgetGateRefusalInfo {
  readonly code: 'budget_exhausted' | 'budget_not_configured';
  readonly kind: GatedCallKind;
  readonly message: string;
  /** 耗尽时：底层 `reserve()` 的拒绝结果（未装配时为 `null`）。 */
  readonly outcome: ReserveOutcome | null;
  readonly would_exceed: readonly BudgetDimension[];
  readonly describe: string;
  /** 部分结果（`planPartialDelivery` 口径；`complete_claimed` 恒 `false`）。 */
  readonly partial: PartialDelivery;
}

/**
 * 闸门拒绝：**这一次调用没有发出**的结构化证据。
 *
 * 它是 `Error` 的子类（模型端口这条接缝只能靠抛出来阻止请求发出），但携带的字段足以让
 * 上层**不靠解析错误文本**就能如实上报"卡在哪一维、没发出什么"。
 */
export class BudgetGateRefusal extends Error {
  readonly code: 'budget_exhausted' | 'budget_not_configured';
  readonly kind: GatedCallKind;
  readonly outcome: ReserveOutcome | null;
  readonly would_exceed: readonly BudgetDimension[];
  readonly describe: string;
  readonly partial: PartialDelivery;
  readonly info: BudgetGateRefusalInfo;

  constructor(info: BudgetGateRefusalInfo) {
    super(info.message);
    this.name = 'BudgetGateRefusal';
    this.code = info.code;
    this.kind = info.kind;
    this.outcome = info.outcome;
    this.would_exceed = info.would_exceed;
    this.describe = info.describe;
    this.partial = info.partial;
    this.info = info;
  }
}

export interface ProductBudgetGateOptions {
  /** 预算接线；`null` ⇒ 每次 `admit()` 都抛 `budget_not_configured`（**不**放行）。 */
  readonly budget: ProductBudgetWiring | null;
  /** 未装配的**原因**（如实回报；不参与判定）。 */
  readonly reason?: string | null;
  /** 幂等键前缀（证据可读性）。 */
  readonly keyPrefix?: string;
  /** "现在"（毫秒）；默认墙钟（本文件在 `apps/**`，允许）。 */
  readonly now?: () => number;
}

/** 一次 `admit()` 的可选上下文（全部只影响追踪 / 部分结果的可读性）。 */
export interface AdmitCallOptions {
  readonly subject?: string;
  readonly label?: string;
  /** 计划产出的引用（部分结果用；默认按类别给一条）。 */
  readonly planned_refs?: readonly string[];
  /** 实际已产出的引用（部分结果用；默认空）。 */
  readonly delivered_refs?: readonly string[];
  readonly reasons?: Readonly<Record<string, string>>;
}

/**
 * **事前闸门**：真实模型 / 工具调用在发出之前的**唯一**放行点。
 *
 * - 放行 ⇒ 返回内核 `ReserveOutcome`（且用量已落盘，跨重启收敛）；
 * - 拒绝 ⇒ **抛** `BudgetGateRefusal`（`budget_exhausted` / `budget_not_configured`）；
 * - 结构上**没有** `reset()` / `clear()` / `raiseLimit()`。
 */
export class ProductBudgetGate {
  readonly #budget: ProductBudgetWiring | null;
  readonly #reason: string;
  readonly #keyBase: string;
  readonly #now: () => number;
  #seq = 0;

  constructor(options: ProductBudgetGateOptions) {
    this.#budget = options.budget;
    this.#reason = options.reason ?? '八维预算上限未配置';
    // 进程内唯一键基：pid + 起始毫秒。跨重启起始毫秒不同 ⇒ 不与上一进程重号。
    this.#keyBase = `${options.keyPrefix ?? 'budget-gate'}-${String(process.pid)}-${String(Date.now())}`;
    this.#now = options.now ?? ((): number => Date.now());
  }

  /** 是否装配了预算台账（`false` ⇒ 每次真调用都会被拒）。 */
  get wired(): boolean {
    return this.#budget !== null;
  }

  /** 底层预算接线（只读；`null` = 未装配）。 */
  get budget(): ProductBudgetWiring | null {
    return this.#budget;
  }

  /** 已用 / 上限摘要（未装配时如实说明原因）。 */
  describe(): string {
    return this.#budget === null ? `未装配（${this.#reason}）` : this.#budget.describe();
  }

  /** 下一次调用的**幂等身份**（进程内唯一；跨重启不重号）。 */
  nextKey(kind: GatedCallKind): string {
    this.#seq += 1;
    return `${this.#keyBase}:${kind}:${String(this.#seq)}`;
  }

  /** 部分结果（复用内核 `planPartialDelivery`）。未装配时**不编造**"哪一维耗尽"。 */
  partialDelivery(input: PartialDeliveryInput): PartialDelivery {
    if (this.#budget !== null) {
      return this.#budget.partialDelivery(input);
    }
    return this.#unwiredPartial(input.planned_refs, input.delivered_refs, input.reasons);
  }

  /** 未装配时的部分结果：`exhausted_dimensions` 为空（**没有台账就不编造"哪一维耗尽"**）。 */
  #unwiredPartial(
    planned: readonly string[],
    deliveredRefs: readonly string[],
    given?: Readonly<Record<string, string>>,
  ): PartialDelivery {
    const delivered = new Set(deliveredRefs);
    const withheld = planned.filter((ref) => !delivered.has(ref));
    const reasons: Record<string, string> = {};
    for (const ref of withheld) {
      reasons[ref] = given?.[ref] ?? `未产出：预算闸门未装配（${this.#reason}）`;
    }
    return Object.freeze({
      partial: withheld.length > 0,
      exhausted_dimensions: Object.freeze([] as BudgetDimension[]),
      delivered_refs: Object.freeze([...deliveredRefs]),
      withheld_refs: Object.freeze(withheld),
      reasons: Object.freeze(reasons),
      complete_claimed: false as const,
      note: '**预算闸门未装配**：本次调用未发出；不得据此宣称任务完成（`complete_claimed` 恒 false）。',
    });
  }

  /**
   * **事前放行**一次调用。
   *
   * 返回 `ReserveOutcome` = 放行（调用方随即可发出请求）；任何其它情况**抛** `BudgetGateRefusal`，
   * 调用方**不得**在捕获后继续发出请求。
   */
  admit(kind: GatedCallKind, options: AdmitCallOptions = {}): ReserveOutcome {
    const charge = GATED_CALL_CHARGES[kind];
    const planned = options.planned_refs ?? [`${kind}-call`];
    const delivered = options.delivered_refs ?? [];
    const kindLabel = GATED_KIND_LABELS[kind];

    if (this.#budget === null) {
      throw new BudgetGateRefusal({
        code: 'budget_not_configured',
        kind,
        message:
          `预算闸门未装配：**没有上限不是合法配置**（${this.#reason}）。` +
          `本次${kindLabel}调用**未发出**——本产品没有"未登记 = 不设限"这条路径。`,
        outcome: null,
        would_exceed: Object.freeze([]),
        describe: this.describe(),
        partial: this.#unwiredPartial(planned, delivered, options.reasons),
      });
    }

    const ledger = this.#budget.ledger;
    const outcome = this.#budget.admit({
      charges: charge,
      at: asLogicalTime(this.#now()),
      key: this.nextKey(kind),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(options.label === undefined ? {} : { label: options.label }),
    });

    if (!outcome.allowed) {
      throw new BudgetGateRefusal({
        code: 'budget_exhausted',
        kind,
        message:
          `预算闸门拒绝本次放行（${outcome.reason}）：会超限的维度为 ` +
          `${outcome.would_exceed.map((dimension) => BUDGET_DIMENSION_LABELS[dimension]).join('、')}` +
          `（整笔拒、一条都不扣）——本次${kindLabel}调用**未发出**。`,
        outcome,
        would_exceed: outcome.would_exceed,
        describe: this.#budget.describe(),
        partial: this.#budget.partialDelivery({
          ledger,
          planned_refs: planned,
          delivered_refs: delivered,
          ...(options.reasons === undefined ? {} : { reasons: options.reasons }),
        }),
      });
    }
    return outcome;
  }
}

/** 便捷构造（`budget === null` 也允许：服务器照常启动，真调用一律被结构化拒）。 */
export function createProductBudgetGate(
  budget: ProductBudgetWiring | null,
  reason: string | null = null,
  options: { readonly keyPrefix?: string; readonly now?: () => number } = {},
): ProductBudgetGate {
  return new ProductBudgetGate({
    budget,
    ...(reason === null ? {} : { reason }),
    ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface GatedCallOptions {
  /** 记账主体（**只以脱敏形式**进追踪）。 */
  readonly subject?: string;
  /** 标签（脱敏）。 */
  readonly label?: string;
}

/**
 * 把 `ModelTurnPort` 包一层**事前闸门**：每次 `nextTurn` 之前先 `admit('model')`。
 *
 * 拒绝 ⇒ 抛 `BudgetGateRefusal` ⇒ 底层 `nextTurn` **不被调用**，真实请求一次都不发。
 * 工具循环会把这次抛错记成结构化的失败步（`reason` 里带"预算"字样）；调用方据 `code`
 * 判定"这是拒绝，不是格式违约"。
 */
export function gateModelTurnPort(
  port: ModelTurnPort,
  gate: ProductBudgetGate,
  options: GatedCallOptions = {},
): ModelTurnPort {
  return Object.freeze({
    provider: port.provider,
    model: port.model,
    real_executor: port.real_executor,
    async nextTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
      // 事前闸门：**先授权，后发请求**。拒绝在这里抛出 ⇒ 下面的 port.nextTurn 永不执行。
      gate.admit('model', {
        planned_refs: [`model-turn-step-${String(input.step)}`],
        delivered_refs: [],
        ...(options.subject === undefined ? {} : { subject: options.subject }),
        ...(options.label === undefined ? {} : { label: options.label }),
      });
      return port.nextTurn(input);
    },
  });
}

/**
 * 把 `ToolExecutorPort` 包一层**事前闸门**：每次 `invoke` 之前先 `admit('tool')`。
 *
 * 拒绝 ⇒ 返回**结构化回执**（`ok:false` + `error.code`）且**不调用**底层执行器：
 * 工具没有真的运行、没有副作用；`content` 里带部分结果与原因，循环会把它**如实回喂**给模型。
 */
export function gateToolExecutor(
  executor: ToolExecutorPort,
  gate: ProductBudgetGate,
  options: GatedCallOptions = {},
): ToolExecutorPort {
  return Object.freeze({
    name: executor.name,
    real_executor: executor.real_executor,
    async invoke(call: ToolCallRequest, signal: AbortSignal | null): Promise<ToolReceipt | null> {
      try {
        gate.admit('tool', {
          planned_refs: [`tool:${call.tool}`],
          delivered_refs: [],
          ...(options.subject === undefined ? {} : { subject: options.subject }),
          label: options.label ?? call.tool,
        });
      } catch (error) {
        if (!(error instanceof BudgetGateRefusal)) {
          throw error;
        }
        // 结构化拒绝回执：**未调用底层执行器**（工具没有真的执行、没有副作用）。
        return Object.freeze({
          call_id: call.call_id,
          ok: false as const,
          content: JSON.stringify({
            ok: false,
            code: error.code,
            tool: call.tool,
            message: error.message,
            describe: error.describe,
            partial: error.partial,
          }),
          error: Object.freeze({ code: error.code, detail: error.message, fatal: false }),
        });
      }
      return executor.invoke(call, signal);
    },
  });
}

/**
 * 把 `ToolLoopHost` 包一层**整轮事前闸门**（`task_calls`）：`run()` 之前先 `admit('task')`。
 *
 * 为什么在**调用边界**之外还要在**轮次边界**再放一道：
 * - 轮次边界给出**干净的 HTTP 状态**（耗尽 ⇒ 429 `budget_exhausted`；未装配 ⇒ 503），
 *   而不是让模型端口的抛错被工具循环记成 `malformed_response`（那是**格式违约**的语义，
 *   拿来表示"预算拒绝"会误导读者）；
 * - 一并把 `planPartialDelivery` 的部分结果（**`complete_claimed` 恒 `false`**）放进拒绝体。
 *
 * 两道闸门记的是**不同维度**（`task_calls` vs `model_calls`/`tool_calls`），因此**不重复记账**。
 */
export function gateToolLoopHost(host: ToolLoopHost, gate: ProductBudgetGate): ToolLoopHost {
  return Object.freeze({
    catalog: host.catalog,
    modelPort: host.modelPort,
    toolExecutor: host.toolExecutor,
    status: (): Record<string, unknown> => host.status(),
    parse: (raw: unknown) => host.parse(raw),
    async run(input: Parameters<ToolLoopHost['run']>[0]) {
      try {
        gate.admit('task', { planned_refs: ['tool-loop-run'], delivered_refs: [], label: 'tool-loop-run' });
      } catch (error) {
        if (!(error instanceof BudgetGateRefusal)) {
          throw error;
        }
        return Object.freeze({
          ok: false,
          status: error.code === 'budget_exhausted' ? 429 : 503,
          body: Object.freeze({
            ok: false,
            code: error.code,
            message: error.message,
            retryable: false,
            root: '/api/tool-loop',
            outcome: error.outcome,
            describe: error.describe,
            partial: error.partial,
          }),
        });
      }
      return host.run(input);
    },
  });
}
