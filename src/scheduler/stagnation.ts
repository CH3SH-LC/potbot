/**
 * **停滞检查点**（归属 D03；合同 §六附录 B 的最后一行 `check task progress and waiting conditions`；
 * v1.1 R25.3/R25.4/R25.1、Q9-a/Q9-b/Q9-c）。
 *
 * ## 为什么这一步必须在这里、且必须由 D03 做
 *
 * 附录 B 的 `finish_run` 末尾就是"检查任务进度与等待条件"。D05 的 `diagnoseStagnation()` 是**纯函数**
 * （只返回 `diagnosis_count`），而 `diagnosis_performed` 事件要有人写进事务——
 * 若没人写，事件流里诊断次数恒为 0，**A05-03 会以恒真方式通过**（R25.3 点名的空跑陷阱）。
 * 所以：**判定归 D05，写事件归 D03，记账归已提交事件的幂等投影**（合同 v1.2 R34.3）。
 *
 * ## 三条纪律（都对 A05/A05-L 的断言有直接后果）
 *
 * 1. **只有"报告"才计诊断次数**（D05 的 `shouldEmitDiagnosis`）：正常等待（等用户 / 等外部 /
 *    等尚未产出的依赖）是 `pause`，**不写事件、不记账**。否则 A05-L-06「无环对照的停滞/死锁
 *    诊断事件数 = 0」会被正常等待污染——这正是 R8 对照场景要防的事。
 * 2. **预算未登记就不做有界停止判定**：`diagnoseStagnation` 在预算缺省时**抛错**
 *    （A05-01 的机器可执行形式）。因此本检查点**只在调用方给出预算时运行**；
 *    不给预算 ⇒ 根本不启动停滞判定，也绝不静默套用默认值。
 * 3. **异常大声失败**：检查点内的异常会让整个 `finish_run` 事务回滚（不吞异常、不降级为警告）。
 *    这是刻意的——"静默通过"比"轮次结束失败"危险得多。
 * 4. **诊断次数是事前上限**（合同 v1.3 R44.1；修复 G03）：许可不足时**不做诊断**，
 *    只写不消费额度的耗尽报告（`diagnosis_budget_exhausted`）。见 `runStagnationCheckpoint`。
 *
 * ## 预算类型的单一来源（R25.4）
 *
 * 上限用 D05 的 `DiagnosisBudget`（D06 的 `ScenarioBudget` 与它结构相同，可直接传入）。
 * 台账走**一个方法的注入端口**（`StagnationBudgetLedger`），D06 的 `BudgetLedger` 天然满足——
 * 本模块**不定义任何预算类型**，也不写适配层。
 *
 * ## 循环报告的落点（R25.1）
 *
 * 判定为环 ⇒ `disposition === 'report'` ⇒ 按 D05 的 `planCycleStop()`（默认 `report_failed`）
 * 把环上项落为 `failed` + `failure_reason`（A05-12：不得标成"已完成"）。
 */

import {
  type EventIdSource,
  type GroupId,
  type InstanceId,
  type KernelEvent,
  type LogicalTime,
  type RequestId,
  type Revision,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import {
  diagnoseStagnation,
  diagnosisPermit,
  evaluateBudget,
  exhaustedDiagnosis,
  planCycleStop,
  recordDiagnosis,
  scopeWorkItems,
  shouldEmitDiagnosis,
  type BudgetUsage,
  type CycleStopMode,
  type CycleStopPlan,
  type DiagnosisBudget,
  type DiagnosisBudgetKind,
  type DiagnosisDefectOptions,
  type StagnationDiagnosis,
} from '../dependency/index.js';
import { hasRunnableInput } from '../inbox/index.js';
import { RunBudgetConfigError, runBudgetConfigMessage } from './errors.js';
import { appendKernelEvent, workItemStatusChangedEvent } from './kernel-events.js';

/**
 * 预算台账的最小注入形状（**只有一个方法**；R25.4：不造第三种预算类型）。
 *
 * D06 的 `BudgetLedger` 结构兼容本接口（`charge` 与 `used` 同名同形），可直接注入；
 * 本模块不 import `src/clock`，也不复制它的记账实现。
 */
export interface StagnationBudgetLedger {
  /** 记账（不抛错）：返回该维度累计用量。 */
  charge(
    kind: DiagnosisBudgetKind,
    amount?: number,
    options?: { readonly at?: LogicalTime; readonly label?: string },
  ): number;
  /** 某维度的已用量（判定预算是否超限的输入）。 */
  used(kind: DiagnosisBudgetKind): number;
}

export interface StagnationOptions {
  /**
   * **场景执行前登记**的预算上限（R_max / D_max / T_max）。
   * 用 D05 的 `DiagnosisBudget`；D06 的 `ScenarioBudget` 结构相同，可直接传。
   */
  readonly budget: DiagnosisBudget;
  /** 预算台账（D06 的 `BudgetLedger` 结构兼容）。省略 = 不记台账（事件仍会写）。 */
  readonly ledger?: StagnationBudgetLedger | null;
  /** 受控缺陷注入（默认关闭；只在隔离测试配置启用，Q10-c）。 */
  readonly defects?: DiagnosisDefectOptions;
  /** 循环停止形态；默认 `report_failed`（R25.1）。 */
  readonly cycle_stop_mode?: CycleStopMode;
}

export interface StagnationCheckpointInput {
  readonly at: LogicalTime;
  readonly event_ids: EventIdSource;
  readonly options: StagnationOptions;
  /** 事件溯源（可读性）。 */
  readonly task_id?: TaskId | null;
  readonly group_id?: GroupId | null;
  readonly instance_id?: InstanceId | null;
  /**
   * **诊断作用域**（合同 v1.2 R37.2；修复 F05）：只诊断"当前任务 + 当前版本"的项。
   *
   * 为什么必须限定：旧实现把 `tx.listWorkItems()` **整库**送进诊断。当 T1 rev1 与 T2 rev2
   * 各存在非终态项时，阻塞项跨任务版本 ⇒ `FingerprintError` ⇒ **整个 `finish_run` 事务回滚**，
   * run 永远停在 running。跨任务/跨版本并存是**正常**状态（历史项本来就要保留），
   * 不能让它把一个正常收尾变成失败。
   *
   * 语义：给了 `task_id` 就只保留 `item.task_id === task_id` 的项；
   * 再给 `task_revision` 就进一步只保留 `item.task_revision === task_revision` 的项。
   * 历史项**保留在存储里**，只是不参与本次诊断——不得删旧项、改版本或关掉指纹校验。
   */
  readonly task_revision?: Revision | null;
}

// ---------------------------------------------------------------------------
// 轮次预算的闸断（R27.1）：`R_max` 是内核强制的停止判据
// ---------------------------------------------------------------------------

/** 轮次预算闸断所需的两件东西：上限（D05 的 `DiagnosisBudget`）+ 台账（D06 的 `BudgetLedger`）。 */
export interface RunBudgetGate {
  readonly limits: DiagnosisBudget;
  readonly ledger: StagnationBudgetLedger;
}

/**
 * 取出轮次预算闸断所需的部件。
 *
 * 三种情形（**R30.3**，别把第二种做成静默降级）：
 * - **完全未登记预算**（`undefined`）⇒ 返回 `null`：这不是"配置不完整"，而是有意的
 *   "无预算运行"（A02/A03/A04/P2 的夹具就是这种），不做闸断、不抛错；
 * - **登记了预算却没给台账** ⇒ **抛 `RunBudgetConfigError`**：调用方以为有硬上限，
 *   内核却读不到用量——静默放行无限轮次正是 R27.1 要消灭的失效模式；
 * - 两者齐备 ⇒ 返回闸断部件。
 *
 * 为什么必须要求台账：用量必须与记账是**同一个真相源**。若内核自己再存一份"已启动轮次数"，
 * 就等于另造了第三种记账口径（R25.4/单一定义来源原则）。
 */
export function runBudgetGateOf(options: StagnationOptions | undefined): RunBudgetGate | null {
  if (options === undefined) {
    return null;
  }
  if (options.ledger === null || options.ledger === undefined) {
    throw new RunBudgetConfigError(runBudgetConfigMessage());
  }
  return { limits: options.budget, ledger: options.ledger };
}

/**
 * **R34.1（合同 v1.2）**：运行轮次预算的**启动前闸门**。
 *
 * 判据是"**再启动这一轮会不会超过预登记上限**"：
 * `used + 1 > limit` ⇔ `used >= limit` ⇒ 拒绝。
 * 因此 `R = 0` 启动 0 轮、`R = 1` 只启动 1 轮（第 2 次即拒）、一般 `R = N` 不超过 N。
 *
 * ## 与 v1.1 R30.1（`R_max + 1`）的区别（**本次修复的核心之一**）
 *
 * 旧口径用 `evaluateBudget(...).exceeded` 即 `used > limit` 判断"能否启动"，
 * 于是上界变成 `R_max + 1`：配置 `runs = 1` 时**实际跑了 2 轮**，A05-B 还把这当成通过。
 * 那是**事后断言**不是上限。新口径把判定前移到"获取执行权、消费快照、认领工作之前"。
 *
 * ## 与"诊断的已超限"的分工（R34.2）
 *
 * `evaluateBudget(...).exceeded`（`usage > limit`）**仍然存在**，但只用于**报告**
 * （D05 的 `budget_exhausted` 判定），**不得**复用为启动许可。两者由下面的
 * `used + 1` 与 `evaluateBudget` 分别承担，不互相替代。
 */
export function runBudgetExhausted(gate: RunBudgetGate): boolean {
  // 复用 D05 的比较实现（`evaluateBudget` 只做"用量 vs 上限"的算术，不另造预算类型）：
  // "再加一轮"是否超限 = 把 used+1 交给同一判定。
  return evaluateBudget(gate.limits, { runs: gate.ledger.used('runs') + 1 }).exceeded.includes('runs');
}

export interface StagnationCheckpointOutcome {
  readonly diagnosis: StagnationDiagnosis;
  /** 写下的 `diagnosis_performed` 事件；正常等待 / 可推进时为 `null`（不写任何东西）。 */
  readonly diagnosis_event: KernelEvent | null;
  /**
   * 本次诊断是否产生了一条**计入诊断次数**的报告事件（0 或 1）。
   * **不是**台账变更量——记账由已提交事件投影完成（R34.3）。
   */
  readonly charged_diagnoses: number;
  /** 循环停止计划（无环时为 null）。 */
  readonly cycle_stop: CycleStopPlan | null;
  /** 循环停止落地的项（环上项 → `failed`）。 */
  readonly cycle_stopped_request_ids: readonly RequestId[];
  readonly kernel_events: readonly KernelEvent[];
  /** 是否"停止"（`disposition !== 'continue'`）。 */
  readonly stopped: boolean;
  /** 暂停 / 报告时必须空闲的实例（A05-07：等待期间不得占用执行槽）。 */
  readonly releasable_instance_ids: readonly InstanceId[];
  readonly usage: BudgetUsage;
}

/**
 * 执行一次停滞检查（**事务内**，由 `finish_run` 在轮次收尾时调用）。
 *
 * 判定 → 写事件（仅"报告"）→ 有环则按 `report_failed` 落地。
 * **记账不在此处**：见 `budget-projection.ts`（R34.3）。
 */
export function runStagnationCheckpoint(
  tx: StorageTransaction,
  input: StagnationCheckpointInput,
): StagnationCheckpointOutcome {
  const { at, event_ids, options } = input;
  const ledger = options.ledger ?? null;

  // 作用域限定（R37.2）：事件标签、依赖图、可运行输入**使用同一范围**。
  const items = scopeWorkItems(tx.listWorkItems(), input);
  const runnableInstanceIds = tx
    .listInstances()
    .filter(
      (instance) =>
        (input.group_id === undefined || input.group_id === null || instance.group_id === input.group_id) &&
        hasRunnableInput(tx, instance.instance_id),
    )
    .map((instance) => instance.instance_id);

  const usage: BudgetUsage = Object.freeze({
    runs: ledger === null ? 0 : ledger.used('runs'),
    diagnoses: ledger === null ? 0 : ledger.used('diagnoses'),
    time: ledger === null ? 0 : ledger.used('time'),
  });

  // -------------------------------------------------------------------------
  // **诊断的事前许可**（合同 v1.3 R44.1/R44.2；修复 G03）
  //
  // 旧实现把"诊断是否超限"当成**事后断言**（`usage.diagnoses > D_max` 才报 budget_exhausted），
  // 于是 `D = 0` 仍会实做 1 次诊断（0 > 0 为假 ⇒ 照常走 cycle_detected 并写
  // `diagnosis_performed`，事件计数与台账都变成 1），`D = 1` 更可累计 3 次。
  // 而且预算耗尽报告自己也走 `diagnosis_performed`，继续消耗额度——"报告超限"这一动作本身在超限。
  //
  // 现在把许可前移到**实际诊断之前**，判据是已提交事实（`diagnosis_performed` 经
  // `CommittedBudgetProjection` 投影后的台账用量）：
  //   allowed ⇔ used + 1 <= D_max
  // 许可不足时**不再调用 `diagnoseStagnation()`**（不算指纹、不做环判定、不落地停止计划），
  // 只产出一份不消费额度的耗尽报告（事件种类 `diagnosis_budget_exhausted`）。
  // 于是恒有：`diagnosis_performed` 事件数 = 台账 `diagnoses` 用量 ≤ `D_max`。
  // -------------------------------------------------------------------------
  const permit = diagnosisPermit(options.budget, usage);
  if (!permit.allowed) {
    const exhausted = exhaustedDiagnosis({
      items,
      scope: { task_id: input.task_id ?? null, task_revision: input.task_revision ?? null },
      budget: options.budget,
      usage,
      now: at,
    });
    const exhaustedEvent = recordDiagnosis(tx, exhausted, {
      at,
      event_ids,
      task_id: input.task_id ?? null,
      group_id: input.group_id ?? null,
      instance_id: input.instance_id ?? null,
    });
    return Object.freeze({
      diagnosis: exhausted,
      diagnosis_event: exhaustedEvent,
      // 耗尽报告**不**消费诊断额度（R44.2/R44.3）：事件种类不同，计数器与投影都不认它。
      charged_diagnoses: 0,
      cycle_stop: null,
      cycle_stopped_request_ids: Object.freeze([]) as readonly RequestId[],
      kernel_events: exhaustedEvent === null ? Object.freeze([]) : Object.freeze([exhaustedEvent]),
      stopped: true,
      releasable_instance_ids: exhausted.releasable_instance_ids,
      usage,
    });
  }

  const diagnosis = diagnoseStagnation({
    items,
    budget: options.budget,
    usage,
    now: at,
    runnable_instance_ids: runnableInstanceIds,
    // 作用域同时交给 D05 的纯函数（R37.2）：本地已按同一口径预筛，
    // 这里再传一次是**同一判据的第二道闸**——直接调用 `diagnoseStagnation` 的场景
    // 也拿得到同样的隔离语义，不依赖调用方自己先筛干净。
    scope: { task_id: input.task_id ?? null, task_revision: input.task_revision ?? null },
    ...(options.defects === undefined ? {} : { defects: options.defects }),
  });

  // 只有"报告"才写事件（D05 的 `shouldEmitDiagnosis`；暂停是正常等待，见文件头第 1 条）。
  const diagnosisEvent = recordDiagnosis(tx, diagnosis, {
    at,
    event_ids,
    task_id: input.task_id ?? null,
    group_id: input.group_id ?? null,
    instance_id: input.instance_id ?? null,
  });

  // **记账不在这里做**（合同 v1.2 R34.3；修复 F06）：事务体内直接 `ledger.charge()` 早于提交，
  // 提交前失败时存储里没有事件、台账却已经多记一笔。诊断次数改由 `Scheduler` 在**提交之后**
  // 按已提交的 `diagnosis_performed` 事件幂等投影（见 `budget-projection.ts`）。
  // 本字段只表示"本次已产生一条**计入诊断次数**的报告事件"，不再承担记账职责；
  // 判据取 `consumes_diagnosis_budget`（R44.2：耗尽报告不计入，因此恒有事件数 ≤ D_max）。
  const chargedDiagnoses =
    diagnosisEvent !== null && diagnosis.consumes_diagnosis_budget ? 1 : 0;
  void ledger;

  const kernelEvents: KernelEvent[] = diagnosisEvent === null ? [] : [diagnosisEvent];
  const stoppedRequestIds: RequestId[] = [];
  let cycleStop: CycleStopPlan | null = null;

  // 只在**判定为环**时落地停止计划：若优先级更高的 budget_exhausted 先命中，
  // 说明场景已因超限失败（不该再顺手改工作项状态，掩盖真正的失败原因）。
  if (diagnosis.verdict === 'cycle_detected' && diagnosis.cycles.length > 0) {
    cycleStop = planCycleStop(items, {
      at,
      mode: options.cycle_stop_mode ?? 'report_failed',
    });
    for (const verdict of cycleStop.transitions) {
      if (!verdict.ok || verdict.next === null) {
        continue;
      }
      tx.putWorkItem(verdict.next);
      stoppedRequestIds.push(verdict.next.request_id);
      kernelEvents.push(
        appendKernelEvent(tx, workItemStatusChangedEvent(verdict.next, at), event_ids),
      );
    }
  }

  return Object.freeze({
    diagnosis,
    diagnosis_event: diagnosisEvent,
    charged_diagnoses: chargedDiagnoses,
    cycle_stop: cycleStop,
    cycle_stopped_request_ids: Object.freeze(stoppedRequestIds),
    kernel_events: Object.freeze(kernelEvents),
    stopped: diagnosis.disposition !== 'continue',
    releasable_instance_ids: diagnosis.releasable_instance_ids,
    usage,
  });
}
