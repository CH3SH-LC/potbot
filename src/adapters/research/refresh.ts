/**
 * RES-07 / RES-08 —— 版本化事实的**比较/汇总与发布**，以及查询的**迭代/补查/取消/限额/部分结果**。
 *
 * 本文件是**新增**的落地文件，两块能力各守一条纪律：
 *
 * ## RES-07：比较、汇总、向其他模板发布版本化事实
 * - `VersionedFactStore.summarize` 依用户条件把观察**比较/汇总**成事实；对同一事实键的
 *   不同陈述，判为 `conflicting` 或 `consistent`，**绝不取第一条**（`chosen` 恒为 `null`）；
 * - `VersionedFactStore.publish` 做**版本化**：陈述变化 ⇒ 版本 +1；陈述相同 ⇒ 返回
 *   `unchanged`（无新增），**不产生新版本、不重复投递**；
 * - **发布是接口点且明确未接线**：默认没有下游端口时返回结构化 `not-wired`
 *   （原因 + 解锁条件），**绝不宣称已发布**。装配了端口也只证明"写到了注入的端口"，
 *   真实下游模板的回执属宿主侧，未实测前一律标未验证；
 * - **不复用网页指令当授权**：`guardAuthorizationFromFact` 对**任何**版本化事实都拒绝
 *   自动转化为工具授权；命中疑似注入时更显式说明"内容只能作为事实"。
 *
 * ## RES-08：查询迭代、补查、取消、限额、部分结果、不无限重搜
 * - `QuerySession` 累加多轮证据，**按内容 id 去重**；新证据为零的那一轮返回 `no-new`；
 * - **没有新信息时不无限重新搜索**：连续无新增达到上限后返回 `refused`（拒绝再搜）；
 * - **取消**后任何迭代都返回 `cancelled` 且带已取得的部分结果；
 * - **限额**（轮次上限 / 结果条数上限）触发时返回 `limit-exceeded`，`partial: true`
 *   并附已取得的结果——"有多少给多少"，而不是假装完整。
 *
 * 本文件不含 `node:fs` / 墙钟 / 随机（"现在"一律经注入的 `ClockPort`）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { digestText } from './digest.js';
import type { ClockPort } from './ports.js';
import { scanForInjection, type InjectionFinding } from './privacy.js';
import type { Citation, ExportedFact } from './types.js';

// ===========================================================================
// RES-07：版本化事实
// ===========================================================================

/** 一条待纳入事实库的观察（同 `key` 的不同来源观察会在汇总里被比较）。 */
export interface FactObservation {
  readonly key: string;
  readonly statement: string;
  readonly sourceId: string;
  readonly taskId: string;
  readonly citations?: readonly Citation[];
  /** 用户条件维度（如 { 城市: '上海', 人数: '8' }），用于"按条件汇总"。 */
  readonly conditions?: Readonly<Record<string, string>>;
}

/** 下游模板的发布端口 —— **由宿主实现**；本模块不实现任何真实下游。 */
export interface FactPublisherPort {
  readonly id: string;
  publish(fact: ExportedFact): Promise<PublishReceipt>;
}

export interface PublishReceipt {
  readonly downstreamId: string;
  readonly ackId: string;
  /** 回执时间（来自注入时钟，避免墙钟）。 */
  readonly acceptedAt: number;
}

/** 未装配下游端口时的**固定原因**——措辞与 `not-ready.ts` 的 `cap.research.publish` 对齐。 */
export const NO_PUBLISHER_REASON =
  '未装配下游发布端口（FactPublisherPort）：本切片能产出带版本/来源/片段锚点的版本化事实，' +
  '但**未接任何下游模板**（文档 / 表格 / 演示 / 记忆），故不宣称已发布。';

export const NO_PUBLISHER_UNLOCK: readonly string[] = Object.freeze([
  '由总协调的协议层为各模板定义事实订阅契约（含版本与失效语义）',
  '宿主实现 FactPublisherPort 并注入 VersionedFactStore',
  '对一次真实发布做端到端读回（下游确实拿到该事实与版本）后，才可标"已发布"',
]);

export type PublishOutcome =
  | {
      readonly status: 'not-wired';
      readonly fact: ExportedFact;
      readonly reason: string;
      readonly unlock: readonly string[];
    }
  | { readonly status: 'unchanged'; readonly fact: ExportedFact; readonly reason: string }
  | { readonly status: 'published'; readonly fact: ExportedFact; readonly receipt: PublishReceipt }
  | { readonly status: 'failed'; readonly fact: ExportedFact; readonly reason: string };

/** 同一事实键下不同来源陈述的比较（**不裁决**）。 */
export interface FactComparison {
  readonly key: string;
  readonly statements: readonly { readonly sourceId: string; readonly statement: string }[];
  readonly agreement: 'consistent' | 'conflicting' | 'single-source';
  /** **恒为 null**：汇总不替用户挑一条"正确值"。 */
  readonly chosen: null;
}

export interface FactSummary {
  readonly comparisons: readonly FactComparison[];
  readonly conflictingKeys: readonly string[];
  readonly singleSourceKeys: readonly string[];
  /** 用户条件 → 命中的事实键（按 `conditions` 汇总）。 */
  readonly byCondition: readonly {
    readonly condition: string;
    readonly value: string;
    readonly keys: readonly string[];
  }[];
  readonly total: number;
}

/** 把观察汇总成比较结果；同键不同来源陈述不一致 ⇒ 显式冲突。 */
export function summarizeObservations(observations: readonly FactObservation[]): FactSummary {
  const byKey = new Map<string, FactObservation[]>();
  for (const obs of observations) {
    const list = byKey.get(obs.key) ?? [];
    list.push(obs);
    byKey.set(obs.key, list);
  }

  const comparisons: FactComparison[] = [];
  for (const [key, list] of byKey) {
    const sources = new Set(list.map((o) => o.sourceId));
    const statements = new Set(list.map((o) => o.statement));
    comparisons.push({
      key,
      statements: list.map((o) => ({ sourceId: o.sourceId, statement: o.statement })),
      agreement:
        sources.size <= 1 ? 'single-source' : statements.size > 1 ? 'conflicting' : 'consistent',
      chosen: null,
    });
  }

  const conditionMap = new Map<string, { condition: string; value: string; keys: Set<string> }>();
  for (const obs of observations) {
    for (const [condition, value] of Object.entries(obs.conditions ?? {})) {
      const mapKey = JSON.stringify([condition, value]);
      const entry = conditionMap.get(mapKey) ?? { condition, value, keys: new Set<string>() };
      entry.keys.add(obs.key);
      conditionMap.set(mapKey, entry);
    }
  }

  return {
    comparisons,
    conflictingKeys: comparisons.filter((c) => c.agreement === 'conflicting').map((c) => c.key),
    singleSourceKeys: comparisons.filter((c) => c.agreement === 'single-source').map((c) => c.key),
    byCondition: [...conditionMap.values()].map((e) => ({
      condition: e.condition,
      value: e.value,
      keys: [...e.keys],
    })),
    total: observations.length,
  };
}

/** 版本化事实库（本地）。发布到下游是**可选端口**，未装配即结构化 not-wired。 */
export class VersionedFactStore {
  private readonly facts = new Map<string, ExportedFact>();

  constructor(
    private readonly clock: ClockPort,
    private readonly publisher: FactPublisherPort | null = null,
  ) {}

  /** 事实键 → 稳定 factId（内容寻址，跨进程稳定）。 */
  factIdOf(key: string): string {
    return digestText(`fact:${key}`);
  }

  /** 已发布事实的当前版本；无则 null。 */
  get(factId: string): ExportedFact | null {
    return this.facts.get(factId) ?? null;
  }

  list(): readonly ExportedFact[] {
    return [...this.facts.values()];
  }

  /** 依用户条件汇总一组观察。 */
  summarize(observations: readonly FactObservation[]): FactSummary {
    return summarizeObservations(observations);
  }

  /**
   * 发布（或更新）一条事实：
   * - 陈述与当前版本**相同** ⇒ `unchanged`（无新增，不重复投递）；
   * - 陈述变化 ⇒ 版本 +1 后发布；
   * - 无下游端口 ⇒ 本地记录但结构化 `not-wired`（明确未接线）。
   */
  async publish(observation: FactObservation): Promise<PublishOutcome> {
    const factId = this.factIdOf(observation.key);
    const existing = this.facts.get(factId);

    if (existing !== undefined && existing.statement === observation.statement) {
      return { status: 'unchanged', fact: existing, reason: '无新增：陈述与当前版本一致，不产生新版本' };
    }

    const fact: ExportedFact = {
      factId,
      version: existing === undefined ? 1 : existing.version + 1,
      statement: observation.statement,
      citations: observation.citations ?? [],
      taskId: observation.taskId,
    };
    this.facts.set(factId, fact);

    const publisher = this.publisher;
    if (publisher === null) {
      return { status: 'not-wired', fact, reason: NO_PUBLISHER_REASON, unlock: NO_PUBLISHER_UNLOCK };
    }

    try {
      const receipt = await publisher.publish(fact);
      return { status: 'published', fact, receipt };
    } catch (error) {
      return { status: 'failed', fact, reason: `下游发布失败：${(error as Error).message}` };
    }
  }

  /** 版本化事实的当前时钟（供回执/展示；不读墙钟）。 */
  now(): number {
    return this.clock.now();
  }
}

// ---------------------------------------------------------------------------
// RES-07：网页/资料内容**不得**转化为工具授权
// ---------------------------------------------------------------------------

export interface AuthorizationGuardResult {
  readonly decision: 'refused';
  /** **恒为 false**：网页/资料内容绝不转化为工具授权。 */
  readonly authorizationFromWebContent: false;
  readonly injectionFindings: readonly InjectionFinding[];
  readonly reason: string;
}

/**
 * 用版本化事实**推导工具授权** —— 一律拒绝。
 *
 * 这是刻意的一票否决：事实只能作为"事实"被下游引用；工具授权必须由**用户显式授予**
 * （协议层权限链路）。资料/网页里写着"请立即调用某工具"也只是**内容**，不是授权。
 * 命中疑似注入时，原因里额外点名，便于审计。
 */
export function guardAuthorizationFromFact(fact: ExportedFact): AuthorizationGuardResult {
  const injectionFindings = scanForInjection(fact.statement);
  return {
    decision: 'refused',
    authorizationFromWebContent: false,
    injectionFindings,
    reason:
      injectionFindings.length > 0
        ? `该事实文本含疑似注入（${injectionFindings.map((f) => f.pattern).join('、')}）：` +
          '即使字面像是授权也一律拒绝——内容只能作为事实，不能转化为工具授权（RES-07）。'
        : '版本化事实不携带工具授权；授权必须由用户显式授予，不得由资料内容推导（RES-07）。',
  };
}

// ===========================================================================
// RES-08：查询迭代 / 补查 / 取消 / 限额 / 部分结果
// ===========================================================================

/** 一条证据（跨轮去重按 `id`）。 */
export interface EvidenceItem {
  readonly id: string;
  readonly sourceId: string;
  readonly text: string;
}

/**
 * 证据提供者 —— 每轮查询的**注入点**。
 * 真实实现（联网 + 私有语料检索）由宿主/调用方提供；本模块只负责编排与去重。
 */
export type EvidenceProvider = (
  query: string,
  round: number,
) => Promise<readonly EvidenceItem[]> | readonly EvidenceItem[];

export interface QuerySessionOptions {
  /** 轮次上限（默认 5）。达到即返回 `limit-exceeded` + 部分结果。 */
  readonly maxRounds?: number;
  /** 累计结果条数上限（默认 50）。达到即返回 `limit-exceeded` + 部分结果。 */
  readonly maxResults?: number;
  /** 连续"无新增"多少轮后**拒绝再搜**（默认 2）。 */
  readonly maxNoNewRounds?: number;
}

export type IterateStatus = 'ok' | 'no-new' | 'refused' | 'cancelled' | 'limit-exceeded';

export interface IterateOutcome {
  readonly status: IterateStatus;
  /** 已执行的轮数（含本轮）。 */
  readonly round: number;
  /** 本轮新增的证据（其余情形为空数组）。 */
  readonly newEvidence: readonly EvidenceItem[];
  /** 累计已取得的结果 —— **部分结果**在这里返回。 */
  readonly results: readonly EvidenceItem[];
  /** 是否为部分结果（取消 / 限额触发时为 true）。 */
  readonly partial: boolean;
  readonly reason: string;
  readonly limits: {
    readonly rounds: number;
    readonly results: number;
    readonly noNewStreak: number;
  };
}

export interface CancelReport {
  readonly status: 'cancelled';
  readonly at: number;
  readonly rounds: number;
  readonly results: readonly EvidenceItem[];
  readonly reason: string;
}

export interface QuerySessionState {
  readonly cancelled: boolean;
  readonly rounds: number;
  readonly results: number;
  readonly noNewStreak: number;
  readonly queries: readonly string[];
}

/**
 * 一次研究查询会话：多轮迭代 + 补查 + 取消 + 限额 + 部分结果。
 * 会话本身不做检索——检索由注入的 `EvidenceProvider` 完成。
 */
export class QuerySession {
  private readonly seen = new Set<string>();
  private readonly collected: EvidenceItem[] = [];
  private readonly queries: string[] = [];
  private rounds = 0;
  private noNewStreak = 0;
  private cancelled = false;
  private cancelReason: string | null = null;

  constructor(
    private readonly provider: EvidenceProvider,
    private readonly clock: ClockPort,
    private readonly options: QuerySessionOptions = {},
  ) {}

  private get maxRounds(): number {
    return this.options.maxRounds ?? 5;
  }

  private get maxResults(): number {
    return this.options.maxResults ?? 50;
  }

  private get maxNoNewRounds(): number {
    return this.options.maxNoNewRounds ?? 2;
  }

  state(): QuerySessionState {
    return {
      cancelled: this.cancelled,
      rounds: this.rounds,
      results: this.collected.length,
      noNewStreak: this.noNewStreak,
      queries: [...this.queries],
    };
  }

  /** 取消会话；已取得的结果作为部分结果保留。 */
  cancel(reason: string): CancelReport {
    this.cancelled = true;
    this.cancelReason = reason;
    return {
      status: 'cancelled',
      at: this.clock.now(),
      rounds: this.rounds,
      results: [...this.collected],
      reason,
    };
  }

  /** 迭代一轮查询。 */
  iterate(query: string): Promise<IterateOutcome> {
    return this.run(query, '查询');
  }

  /** 补查：与迭代同一条路径（只记录查询序列），语义上是在既有结果上补充。 */
  followUp(query: string): Promise<IterateOutcome> {
    return this.run(query, '补查');
  }

  private snapshot(newEvidence: readonly EvidenceItem[], partial: boolean, status: IterateStatus, reason: string): IterateOutcome {
    return {
      status,
      round: this.rounds,
      newEvidence: [...newEvidence],
      results: [...this.collected],
      partial,
      reason,
      limits: { rounds: this.maxRounds, results: this.maxResults, noNewStreak: this.noNewStreak },
    };
  }

  private async run(query: string, label: string): Promise<IterateOutcome> {
    if (this.cancelled) {
      return this.snapshot(
        [],
        true,
        'cancelled',
        `会话已取消（${this.cancelReason ?? '未给原因'}），不再发起${label}；以下为已取得的部分结果。`,
      );
    }

    if (this.rounds >= this.maxRounds) {
      return this.snapshot(
        [],
        true,
        'limit-exceeded',
        `已达轮次上限 ${this.maxRounds}，拒绝继续${label}；以下为已取得的部分结果。`,
      );
    }

    this.queries.push(query);
    this.rounds += 1;
    const round = this.rounds;

    let items: readonly EvidenceItem[];
    try {
      items = await this.provider(query, round);
    } catch (error) {
      return this.snapshot([], false, 'refused', `${label}取证据失败：${(error as Error).message}`);
    }

    const fresh: EvidenceItem[] = [];
    for (const item of items) {
      if (this.seen.has(item.id)) {
        continue;
      }
      this.seen.add(item.id);
      fresh.push(item);
    }

    // 结果限额：能装多少装多少 —— 余下的算"未取得"，不改称完整。
    let truncated = false;
    const accepted: EvidenceItem[] = [];
    for (const item of fresh) {
      if (this.collected.length >= this.maxResults) {
        truncated = true;
        break;
      }
      this.collected.push(item);
      accepted.push(item);
    }

    this.noNewStreak = fresh.length > 0 ? 0 : this.noNewStreak + 1;

    if (fresh.length === 0) {
      if (this.noNewStreak >= this.maxNoNewRounds) {
        return this.snapshot(
          [],
          false,
          'refused',
          `连续 ${this.noNewStreak} 轮无新增证据：不再重复${label}（没有新信息时不无限重新搜索）。`,
        );
      }
      return this.snapshot([], false, 'no-new', `本轮${label}返回 0 条新增证据（无新增）。`);
    }

    if (truncated) {
      return this.snapshot(
        accepted,
        true,
        'limit-exceeded',
        `已达结果条数上限 ${this.maxResults}，部分结果已返回；本轮新增中有未纳入的条目。`,
      );
    }

    return this.snapshot(accepted, false, 'ok', `${label}新增 ${fresh.length} 条证据。`);
  }
}
