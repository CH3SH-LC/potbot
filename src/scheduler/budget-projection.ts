/**
 * 预算记账的**已提交事实投影**（合同 v1.2 R34.3；修复 F06）。
 *
 * ## 为什么不能"在事务体里记账"
 *
 * 旧实现把 `ledger.charge(...)` 放在 `startRunInTransaction` 事务体的最后一行，
 * 看起来"成功了才记"。但那一行**早于提交**：`MemoryStore.transact()` 在事务体返回后
 * 还要过 `beforeCommit` 接缝，接缝抛错意味着**事务未提交、存储里一个 run 都没有**，
 * 而外部台账已经多记了一笔。实测：配置 `runs = 1`、连续两次提交前失败后，
 * 存储 0 个 run、台账 `runs = 2`，移除故障后立刻 `budget_exhausted` —— 恢复路径被自己的账目堵死。
 *
 * ## 本模块的做法：记账 = 已提交事实的幂等投影
 *
 * 权威来源是**随事务一同提交或回滚的观测事件**：
 * - 运行轮次 → `run_started` 的 `run_id`（记为 `run:<run_id>`）；
 * - 停滞诊断 → `diagnosis_performed` 的 `event_id`（记为 `diagnosis:<event_id>`）。
 *
 * 事件在事务内写入，因此"提交前失败 ⇒ 无事件 ⇒ 无账目"**由事务本身保证**，
 * 不需要在事务里碰外部台账。投影在提交之后按**事件身份**幂等补齐：
 * 同一条已提交事件被重放多次，只会补一次。
 *
 * ## 闸门与账目必须同源（R34.5）
 *
 * 调度闸门读的就是本投影后的台账（`used()` 直接委托注入台账，不另存计数），
 * 因此不存在"事务账目"与"调度闸门"两套数值。
 *
 * ## 投影必须**先于返回**（R34.3 最后一条）
 *
 * `Scheduler` 在每个提交点之后**同步**调用 `reconcile()` 再返回；
 * 下一次 `start_run` 读到的闸门值必然已包含上一次提交。不做成异步/惰性，
 * 否则会出现"投影未更新即放行下一轮"的窗口。
 */

import type { InstanceId, KernelEvent, LogicalTime } from '../protocol/index.js';
import { BUDGET_KINDS, type BudgetKind } from '../clock/budget.js';
import type { StagnationBudgetLedger } from './stagnation.js';

/** 一条**已提交事实**折算出的记账项。`key` 是幂等身份（同一事实永远同一个 key）。 */
export interface CommittedBudgetFact {
  /** 幂等身份：`run:<run_id>` / `diagnosis:<event_id>`。 */
  readonly key: string;
  readonly kind: BudgetKind;
  readonly amount: number;
  readonly at: LogicalTime;
  readonly label: string;
}

/**
 * 从**已提交**的观测事件推导记账事实。
 *
 * 只认这两类事件：它们的产生与事务提交同生共死，因此是"已提交事实"的忠实代理。
 * 其余事件（消息受理、工作项变更、排队标记等）不参与预算计量。
 */
export function committedBudgetFactsOf(events: readonly KernelEvent[]): readonly CommittedBudgetFact[] {
  const facts: CommittedBudgetFact[] = [];
  for (const event of events) {
    if (event.kind === 'run_started' && event.run_id !== null) {
      facts.push(
        Object.freeze({
          key: `run:${event.run_id}`,
          kind: 'runs',
          amount: 1,
          at: event.at,
          label: `轮次 ${event.run_id} 启动（已提交事件 run_started）`,
        }),
      );
      continue;
    }
    if (event.kind === 'diagnosis_performed') {
      facts.push(
        Object.freeze({
          key: `diagnosis:${event.event_id}`,
          kind: 'diagnoses',
          amount: 1,
          at: event.at,
          label: `诊断 ${event.event_id} 记为报告（已提交事件 diagnosis_performed）`,
        }),
      );
    }
  }
  return Object.freeze(facts);
}

/** 投影的只读旁证（证据 / 自检用）。 */
export interface BudgetProjectionSnapshot {
  readonly usage: Readonly<Record<BudgetKind, number>>;
  readonly applied_keys: readonly string[];
  readonly reconciled_facts: number;
}

/**
 * 把已提交事实**幂等**补进注入台账。
 *
 * 台账仍归调用方注入（D06 的 `BudgetLedger`，或任何 `charge/used` 结构兼容者）；
 * 本类不定义第二套预算类型、不缓存第二份用量（`used()` 直接委托）。
 */
export class CommittedBudgetProjection {
  readonly #ledger: StagnationBudgetLedger;
  readonly #applied = new Set<string>();
  #reconciled = 0;

  constructor(ledger: StagnationBudgetLedger) {
    this.#ledger = ledger;
  }

  /**
   * 按事件身份补齐缺失的记账。返回**本次真正新补**的条数（幂等：重复调用返回 0）。
   */
  reconcile(events: readonly KernelEvent[]): number {
    let applied = 0;
    for (const fact of committedBudgetFactsOf(events)) {
      if (this.#applied.has(fact.key)) {
        continue;
      }
      this.#applied.add(fact.key);
      this.#ledger.charge(fact.kind, fact.amount, { at: fact.at, label: fact.label });
      applied += 1;
    }
    this.#reconciled += applied;
    return applied;
  }

  /** 某维度的已用量（与调度闸门**同一**真相源：直接读注入台账）。 */
  used(kind: BudgetKind): number {
    return this.#ledger.used(kind);
  }

  /** 全部维度的用量快照（`runs` / `diagnoses` / `time`）。 */
  usage(): Readonly<Record<BudgetKind, number>> {
    const usage = { runs: 0, diagnoses: 0, time: 0 } satisfies Record<BudgetKind, number>;
    for (const kind of BUDGET_KINDS) {
      usage[kind] = this.#ledger.used(kind);
    }
    return Object.freeze(usage);
  }

  snapshot(): BudgetProjectionSnapshot {
    return Object.freeze({
      usage: this.usage(),
      applied_keys: Object.freeze([...this.#applied]),
      reconciled_facts: this.#reconciled,
    });
  }
}

/** 便捷构造。`ledger` 为空时返回 null（= 本次运行没有预算台账，不做投影）。 */
export function createBudgetProjection(
  ledger: StagnationBudgetLedger | null | undefined,
): CommittedBudgetProjection | null {
  return ledger === null || ledger === undefined ? null : new CommittedBudgetProjection(ledger);
}

/* ------------------------------------------------------------------ *
 * 重启恢复（C2；R203 / R218 / R225）
 * ------------------------------------------------------------------ */

/** 重启恢复的结果（**只上不下**，见下方说明）。 */
export interface BudgetRestoreReport {
  /** 已提交事实折算出的目标用量（重启后**应当**是这个数）。 */
  readonly target: Readonly<Record<BudgetKind, number>>;
  /** 恢复**前**台账里的用量（新进程通常全 0——这正是要修的"白送额度"）。 */
  readonly before: Readonly<Record<BudgetKind, number>>;
  /** 本次真正补记的增量（通常 `target - before`；已对齐时全 0）。 */
  readonly charged: Readonly<Record<BudgetKind, number>>;
  /** 折算用到的已提交事实条数。 */
  readonly facts: number;
}

/**
 * 用**持久化的已提交事实**把预算台账恢复到应有用量。
 *
 * ## 为什么是"收敛到目标"而不是"补记缺失的 key"
 *
 * `CommittedBudgetProjection.reconcile()` 靠进程内的 `#applied` 集合做幂等 —— 那个集合
 * **随进程消失**，重启后为空。它在**同一进程内**是幂等的，但不足以表达重启语义。
 * 本函数改为**收敛式**：把台账对齐到"已提交事实折算出的目标用量"，
 *
 * - 新进程（台账 0）⇒ 补齐到 N（**不得从 0 开始**，R225）；
 * - 同一进程重复调用 ⇒ 增量 0（真幂等，与 `#applied` 无关）；
 * - 台账已高于目标 ⇒ **不回调**（见下）。
 *
 * ## 为什么只上不下（R218）
 *
 * `charge` 只能累加，没有"退账"接口——这是刻意的：**没有任何一条路径应该把已用额度退回去**。
 * 若某次恢复发现台账高于事实目标，正确处置是**保留较高的那个**（宁可更严），
 * 而不是"校正"回一个更宽松的值。所以本函数**从不减记账目**，
 * 并把这种不一致如实写进返回值（调用方据此可以告警）。
 *
 * ## 反例为什么有判别力
 *
 * 事实来源是**存储**。把持久化摘掉（内存实现 / 换一条空事件日志）⇒ `target` 全 0 ⇒
 * 恢复后台账仍是 0 ⇒ 闸门放行本应被拒的消费 ⇒ 负例变红。这正是"没落盘就会发现"。
 */
export function recoverBudgetFromCommittedFacts(
  ledger: StagnationBudgetLedger,
  events: readonly KernelEvent[],
): BudgetRestoreReport {
  const facts = committedBudgetFactsOf(events);
  const target = { runs: 0, diagnoses: 0, time: 0 } satisfies Record<BudgetKind, number>;
  for (const fact of facts) {
    target[fact.kind] += fact.amount;
  }

  const before = { runs: 0, diagnoses: 0, time: 0 } satisfies Record<BudgetKind, number>;
  const charged = { runs: 0, diagnoses: 0, time: 0 } satisfies Record<BudgetKind, number>;
  const at = facts.reduce((latest, fact) => (fact.at > latest ? fact.at : latest), 0 as LogicalTime);

  for (const kind of BUDGET_KINDS) {
    const current = ledger.used(kind);
    before[kind] = current;
    const delta = target[kind] - current;
    if (delta > 0) {
      ledger.charge(kind, delta, {
        at,
        label: `重启恢复：对齐已提交事实（${kind} ${String(current)} → ${String(target[kind])}）`,
      });
      charged[kind] = delta;
    }
  }

  return Object.freeze({
    target: Object.freeze({ ...target }),
    before: Object.freeze({ ...before }),
    charged: Object.freeze({ ...charged }),
    facts: facts.length,
  });
}

/** 只读辅助：事件来源的记账事实条数（自检用，不写任何东西）。 */
export function committedRunCount(events: readonly KernelEvent[]): number {
  return committedBudgetFactsOf(events).filter((fact) => fact.kind === 'runs').length;
}

/** 只读辅助：某实例最近一次提交语义的轮次 id（诊断读；不参与判定）。 */
export function latestRunIdOf(events: readonly KernelEvent[], instanceId: InstanceId): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (event.kind === 'run_started' && event.instance_id === instanceId && event.run_id !== null) {
      latest = event.run_id;
    }
  }
  return latest;
}
