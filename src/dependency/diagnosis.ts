/**
 * **停滞诊断与有限停止判定**（D05；P5 / A05；任务书 §10、§19 A05；合同 Q9-a/Q9-b/Q9-c）。
 *
 * 输入：工作项集合 + **调用方在场景执行前登记的**预算 + 调用方给出的"当前有可运行输入的实例"。
 * 输出：一份可判定的诊断——**继续 / 暂停 / 报告**，以及"该释放哪些实例的执行槽"。
 *
 * ## 判定阶梯（顺序即优先级；测试依赖它给出确定性结果）
 *
 * | # | 条件 | verdict | disposition |
 * |---|---|---|---|
 * | 1 | 预算超限（且非受控缺陷） | `budget_exhausted` | `report` |
 * | 2 | 存在损坏记录（非终态却无阻塞原因） | `stalled` | `report` |
 * | 3 | 存在依赖环 | `cycle_detected` | `report` |
 * | 4 | 存在**永不可能满足**的依赖（目标已 failed/cancelled） | `stalled` | `report` |
 * | 5 | 有可解除的依赖 **或** 调用方报有可运行输入的实例 | `progress_possible` | `continue` |
 * | 6 | 存在正常等待（等用户 / 等外部条件） | `waiting` | `pause` |
 * | 7 | 存在等待依赖（依赖仍在产出的正常链路，无环） | `waiting` | `pause` |
 * | 8 | 存在其它阻塞（能力 / 授权 / 工具状态 / 预算 / 其它） | `waiting` | `pause` |
 * | 9 | 无任何未终态项 | `waiting` | `pause` |
 *
 * **第 1 条优先于第 3 条**：预算已超 ⇒ 场景已经失败，必须先如实报告
 * （A05 失败判据：「轮次数 / 诊断次数 / 虚拟时间任一超过预登记上限且未收敛 → 不通过」）。
 *
 * ## 正常等待 ≠ 死锁（A05 的关键、也是 R8 对照的目的）
 * - 「A 等 B、B 等 A」→ 第 3 条（环）⇒ **报告**；
 * - 「A 等 B、B 无依赖」→ 第 7 条（依赖链无环）⇒ **暂停**，且**不产生**停滞/死锁诊断事件
 *   （A05-L-03 / A05-L-06 的反向约束）；
 * - 「等用户 / 等外部」→ 第 6 条 ⇒ **暂停**（合同 Q9-c：暂停 = 存在等待用户或外部条件）。
 *
 * ## 执行槽释放（A05-07 / A05-08）
 * `disposition !== 'continue'` 时 `releasable_instance_ids` 列出**必须空闲**的实例：
 * 等待期间不得占用执行槽，也不得靠定时互相唤醒维持活跃（第 5 条之外的路径都不产生新输入）。
 */

import {
  isTerminalStatus,
  type BlockerKind,
  type DependencyRef,
  type InstanceId,
  type LogicalTime,
  type RequestId,
  type Revision,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import {
  evaluateBudget,
  ZERO_BUDGET_USAGE,
  type BudgetEvaluation,
  type BudgetUsage,
  type DiagnosisBudget,
} from './budget.js';
import {
  dependencyIdTags,
  findDependencyBlockedItems,
  findDependencyCycles,
  findResolvableItems,
  findUnsatisfiableItems,
  isBlocked,
  ownersOf,
  uniqueSorted,
  waitClassOf,
  NORMAL_WAIT_CLASSES,
  type DependencyCycle,
  type WaitClass,
} from './graph.js';
import {
  fingerprintOfBlockedItems,
  type BlockingFingerprint,
  type FingerprintFromItemsOptions,
} from './fingerprint.js';
import { describeScope, scopeWorkItems, type DependencyScope } from './scope.js';

// ---------------------------------------------------------------------------
// 判定取值
// ---------------------------------------------------------------------------

export const STAGNATION_VERDICTS = [
  'progress_possible', // 还能推进（有可解除依赖 / 有可运行输入）
  'waiting', // 正常等待（等用户 / 外部条件 / 依赖产出）⇒ 暂停
  'cycle_detected', // 循环依赖 ⇒ 报告
  'stalled', // 无可推进路径且无等待条件（损坏记录 / 永不满足的依赖）⇒ 报告
  'budget_exhausted', // 预算超限 ⇒ 报告（不得静默通过）
] as const;

export type StagnationVerdict = (typeof STAGNATION_VERDICTS)[number];

/** 停止处置：继续 / 暂停 / 报告（合同 Q9-c）。 */
export const STOP_DISPOSITIONS = ['continue', 'pause', 'report'] as const;
export type StopDisposition = (typeof STOP_DISPOSITIONS)[number];

const VERDICT_DISPOSITION: Readonly<Record<StagnationVerdict, StopDisposition>> = Object.freeze({
  progress_possible: 'continue',
  waiting: 'pause',
  cycle_detected: 'report',
  stalled: 'report',
  budget_exhausted: 'report',
});

// ---------------------------------------------------------------------------
// 受控缺陷注入（R7 / Q10-c：默认全关；仅在隔离测试配置打开）
// ---------------------------------------------------------------------------

/**
 * **受控缺陷注入接缝**（默认全部 `false`/省略 = 关闭）。
 *
 * 用途有且只有一个：证明 D05 的关键断言**真会失败**（R7）。
 * 打开任一开关后，对应断言必须在同样的输入下变红；测试同时断言"关闭时成立、打开时失败"。
 * 生产路径一律不传（见合同的故障注入纪律 Q10-c：不破坏共享源码、仅隔离配置启用）。
 */
export interface DiagnosisDefectOptions {
  /**
   * I-A05-1「无限互唤」：忽略预算检查 ⇒ 预算永不耗尽。
   * 打开后 `budget_exhausted` 永不出现、`budget` 字段为 `null`，且**未登记预算也不再抛错**。
   */
  readonly ignore_budget?: boolean;
  /** I-A05-1 变体：指纹忽略任务版本 ⇒ 不同版本被当成"同一情况"（或反之，见测试）。 */
  readonly ignore_task_revision_in_fingerprint?: boolean;
  /** I-A05-2「空转占槽」：等待期间仍视为占用执行槽 ⇒ `releasable_instance_ids` 为空。 */
  readonly holds_slot_while_waiting?: boolean;
}

// ---------------------------------------------------------------------------
// 诊断输入 / 输出
// ---------------------------------------------------------------------------

export interface BlockedWaitReason {
  readonly request_id: RequestId;
  readonly status: WorkItemStatus;
  readonly wait_class: WaitClass;
  readonly blocker_kind: BlockerKind | null;
  readonly blocker_detail: string | null;
  /** 等待对象的标识（带命名空间前缀）——A05-06「各自指出在等哪一项的哪个标识」。 */
  readonly dependency_ids: readonly string[];
  readonly dependency_refs: readonly DependencyRef[];
}

export interface StagnationDiagnosisRequest {
  readonly items: readonly WorkItem[];
  /**
   * **诊断作用域**（合同 v1.2 R37.2；修复批 F05）：只诊断"当前任务 + 当前版本"的项。
   *
   * 语义见 `scope.ts`：`task_id` 是闸门维度（未给 ⇒ 不限定，与旧行为逐位一致）；
   * 给了 `task_id` 后再给 `task_revision` ⇒ 收窄到该版本。
   *
   * 历史项（别的任务 / 旧版本）**保留在存储里**，只是不参与本次诊断。
   * 收窄之后**同一 scope 内**若仍出现跨版本阻塞项，指纹仍如实抛 `FingerprintError`
   * ——那是真实损坏，不得借此绕过。
   *
   * 注意：`runnable_instance_ids` 由调用方负责按同一范围筛好
   * （用 `selectScopedRunnableInstanceIds()`）；本函数只收窄 `items`。
   */
  readonly scope?: DependencyScope | null;
  /**
   * **调用方在场景执行前登记**的预算上限（A05-01）。
   * 省略 / `null` ⇒ 抛 `DiagnosisBudgetError`（本模块拒绝静默取默认值）。
   */
  readonly budget?: DiagnosisBudget | null;
  /** 调用方台账的**已用量**（省略 = 全 0）。 */
  readonly usage?: Partial<BudgetUsage> | null;
  readonly now: LogicalTime;
  /** 调用方（D02/D03）判定的"当前有可运行输入的实例"（省略 = 没有）。 */
  readonly runnable_instance_ids?: readonly InstanceId[];
  /** 已产出结果的请求 id（省略 = 只按集合内的 `completed` 项判定）。 */
  readonly completed_request_ids?: readonly RequestId[];
  /** 已被判定满足的依赖标识（instance / artifact 型引用、或集合外依赖）。 */
  readonly satisfied_dependency_ids?: readonly string[];
  /** 受控缺陷注入（默认关闭，见 `DiagnosisDefectOptions`）。 */
  readonly defects?: DiagnosisDefectOptions;
}

export interface StagnationDiagnosis {
  readonly verdict: StagnationVerdict;
  readonly disposition: StopDisposition;
  /** 阻塞项共同的任务版本；无阻塞项时为 `null`。 */
  readonly task_revision: Revision | null;
  /** 有阻塞原因的未终态项 id（升序）——阻塞指纹的成员。 */
  readonly blocked_request_ids: readonly RequestId[];
  /** 正在等待依赖结果的项 id（升序）。 */
  readonly dependency_blocked_request_ids: readonly RequestId[];
  readonly normal_wait_request_ids: readonly RequestId[];
  /** 非终态却无阻塞原因的损坏记录 id（升序）。 */
  readonly malformed_request_ids: readonly RequestId[];
  /** 依赖环（含自环）。 */
  readonly cycles: readonly DependencyCycle[];
  /** 环的可读路径（证据 / 失败信息用）。 */
  readonly cycle_descriptions: readonly string[];
  /** 依赖永不可能满足的项 id（目标已 failed/cancelled）。 */
  readonly unsatisfiable_request_ids: readonly RequestId[];
  /** 依赖已全部满足、可解除等待（`waiting_dependency → processing`）的项 id（升序）。 */
  readonly resolvable_request_ids: readonly RequestId[];
  /** 逐项的等待原因（A05-06）。 */
  readonly wait_reasons: readonly BlockedWaitReason[];
  /** Q9-b 阻塞指纹；无阻塞项时为 `null`。 */
  readonly fingerprint: BlockingFingerprint | null;
  /** 预算判定结果；受控缺陷 `ignore_budget` 打开时为 `null`。 */
  readonly budget: BudgetEvaluation | null;
  /** 本次诊断是否应计入"诊断次数"（`1` = 产生一次停滞/死锁诊断事件，`0` = 否）。 */
  readonly diagnosis_count: number;
  /**
   * 本次报告是否**消费诊断额度**（合同 v1.3 R44.2 / G03 修复批）。
   *
   * - `true`：一次**真实**诊断（含 `budget_exhausted` 等由 runs / time 维度触发的报告）——
   *   事件种类为 `diagnosis_performed`，**计入** `diagnosis_count` 与预算投影；
   * - `false`：**耗尽报告**（诊断预算已用尽、未做任何真实诊断）——事件种类为
   *   `diagnosis_budget_exhausted`，**不计入** `diagnosis_count`，也不进入
   *   `CommittedBudgetProjection` 的记账事实。
   *
   * `diagnoseStagnation()` 的返回值恒等于 `disposition === 'report'`（既有语义逐位不变）；
   * `exhaustedDiagnosis()` 的返回值恒为 `false`。
   */
  readonly consumes_diagnosis_budget: boolean;
  /** 暂停 / 报告时**必须空闲**的实例（A05-07：等待期间不得占用执行槽）。 */
  readonly releasable_instance_ids: readonly InstanceId[];
  /** 是否仍会产出新的可运行输入（暂停 / 报告时为 `false`，A05-05）。 */
  readonly produces_new_runnable_input: boolean;
  /** 是否应启动新的轮次（仅 `progress_possible` 为 `true`）。 */
  readonly should_start_run: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function describeCycle(cycle: DependencyCycle): string {
  const path = [...cycle.request_ids];
  const first = path[0];
  if (first !== undefined) {
    path.push(first);
  }
  return path.join(' → ');
}

function waitReasonOf(item: WorkItem): BlockedWaitReason {
  return {
    request_id: item.request_id,
    status: item.status,
    wait_class: waitClassOf(item),
    blocker_kind: item.blocker_reason === null ? null : item.blocker_reason.kind,
    blocker_detail: item.blocker_reason === null ? null : item.blocker_reason.detail,
    dependency_ids: dependencyIdTags(item.dependency_refs),
    dependency_refs: item.dependency_refs,
  };
}

/**
 * 停滞诊断（纯函数）。
 *
 * 传入 `scope` 时先按任务 / 版本收窄工作项集合（R37.2 / F05），再做判定；
 * 未传时与旧实现逐位一致。
 *
 * @throws {DiagnosisBudgetError} 预算未登记 / 形状非法（A05-01；受控缺陷 `ignore_budget` 除外）。
 * @throws {FingerprintError} **收窄后的**阻塞项跨越多个任务版本，无法算出单一指纹（Q9-b）。
 *   同一 scope 内的跨版本阻塞是真实损坏，仍必须抛出（scope 不是绕过指纹校验的开关）。
 */
export function diagnoseStagnation(request: StagnationDiagnosisRequest): StagnationDiagnosis {
  const { now } = request;
  const defects = request.defects ?? {};
  // 作用域限定（R37.2 / F05）：事件标签、依赖图、可运行输入与执行槽**使用同一范围**。
  // 未给 scope ⇒ `scopeWorkItems` 原样返回入参（与旧行为逐位一致）。
  const items = scopeWorkItems(request.items, request.scope ?? null);
  const ignoreBudget = defects.ignore_budget === true;

  // 1) 预算（A05-01 / Q9-a）。缺陷打开时不做任何预算判定，也不报告消耗。
  //
  // 用 `evaluateBudget`（不抛错）而不是 `assertWithinBudget`：超限在这里要**明确报告**
  // （verdict = budget_exhausted），而"抛错"的路径留给夹具的收敛判定点
  // （`assertWithinBudget` 仍可独立调用，两条路径都满足"不得静默通过"）。
  // 注意：**未登记预算仍然抛错**——那是前置纪律（A05-01），不是运行中的状态。
  const budget = ignoreBudget
    ? null
    : evaluateBudget(request.budget, request.usage ?? ZERO_BUDGET_USAGE);
  const budgetExceeded = budget !== null && !budget.ok;

  // 2) 阻塞项、环、依赖满足度
  const nonTerminalItems = items.filter((item) => !isTerminalStatus(item.status));
  const blockedItems = items.filter(isBlocked);
  const malformed = nonTerminalItems.filter((item) => item.blocker_reason === null);
  const cycles = findDependencyCycles(items);
  const cyclicIds = new Set<string>(cycles.flatMap((cycle) => cycle.request_ids.map(String)));

  const dependencyBlocked = findDependencyBlockedItems(items);
  const normalWaitIds = items
    .filter((item) => NORMAL_WAIT_CLASSES.includes(waitClassOf(item)))
    .map((item) => item.request_id)
    .sort();
  const evaluationOptions = {
    ...(request.completed_request_ids === undefined
      ? {}
      : { completed_request_ids: request.completed_request_ids }),
    ...(request.satisfied_dependency_ids === undefined
      ? {}
      : { satisfied_dependency_ids: request.satisfied_dependency_ids }),
  };
  const resolvable = findResolvableItems(items, evaluationOptions);
  const unsatisfiable = findUnsatisfiableItems(items, evaluationOptions);
  const runnableInstances = uniqueSorted(request.runnable_instance_ids ?? []) as InstanceId[];

  const fingerprintOptions: FingerprintFromItemsOptions = {
    ...(defects.ignore_task_revision_in_fingerprint === true
      ? { ignore_task_revision: true }
      : {}),
  };
  const fingerprint = fingerprintOfBlockedItems(items, fingerprintOptions);

  // 3) 判定阶梯（顺序即优先级）
  let verdict: StagnationVerdict;
  let reason: string;

  if (budgetExceeded) {
    verdict = 'budget_exhausted';
    reason =
      `预算超限（${budget === null ? '' : budget.exceeded.join(' / ')}）：` +
      `未在预登记上限内收敛，如实报告而不是继续推进（Q9-a / §九-8）`;
  } else if (malformed.length > 0) {
    verdict = 'stalled';
    reason =
      `存在损坏记录：${malformed.map((item) => item.request_id).join(', ')} ` +
      `处于非终态却没有等待/阻塞原因——无法判定其等待对象，如实报告`;
  } else if (cycles.length > 0) {
    verdict = 'cycle_detected';
    reason = `检测到循环依赖：${cycles.map(describeCycle).join('；')}（A05：有限诊断内转为报告）`;
  } else if (unsatisfiable.length > 0) {
    verdict = 'stalled';
    reason =
      `依赖永不可能满足：${unsatisfiable.join(', ')} 所依赖的目标已以 failed/cancelled 收场，` +
      `等待无法自行解除`;
  } else if (resolvable.length > 0 || runnableInstances.length > 0) {
    verdict = 'progress_possible';
    reason =
      resolvable.length > 0
        ? `依赖已解除，产生新的可运行输入：${resolvable.join(', ')}`
        : `以下实例有可运行输入：${runnableInstances.join(', ')}`;
  } else if (normalWaitIds.length > 0) {
    verdict = 'waiting';
    reason = `正常等待（等用户 / 外部条件）：${normalWaitIds.join(', ')}——暂停，不持续调用模型`;
  } else if (dependencyBlocked.length > 0) {
    verdict = 'waiting';
    reason =
      `等待尚未产出的依赖：${dependencyBlocked.join(', ')}——无环，属正常等待，` +
      `不得判为停滞或死锁（任务书 §10）`;
  } else if (blockedItems.length > 0) {
    verdict = 'waiting';
    reason =
      `存在外部阻塞：${blockedItems.map((item) => item.request_id).join(', ')}——暂停，等待条件具备`;
  } else {
    verdict = 'waiting';
    reason = nonTerminalItems.length === 0 ? '无未完成工作项，无需推进' : '暂无可推进输入';
  }

  const disposition = VERDICT_DISPOSITION[verdict];
  const holdsSlotDefect = defects.holds_slot_while_waiting === true;

  // 4) 执行槽释放（A05-07）
  const releasable =
    holdsSlotDefect || disposition === 'continue'
      ? ([] as readonly InstanceId[])
      : ownersOf(nonTerminalItems);

  // 诊断事件只在"报告"时产生：暂停是正常等待，不得计入停滞/死锁诊断
  // （A05-L-06 要求无环对照的停滞诊断事件数为 0）。
  const diagnosisCount = disposition === 'report' ? 1 : 0;

  return {
    verdict,
    disposition,
    task_revision: fingerprint === null ? null : fingerprint.task_revision,
    blocked_request_ids: Object.freeze(blockedItems.map((item) => item.request_id).sort()),
    dependency_blocked_request_ids: dependencyBlocked,
    normal_wait_request_ids: Object.freeze(normalWaitIds),
    malformed_request_ids: Object.freeze(malformed.map((item) => item.request_id).sort()),
    cycles,
    cycle_descriptions: Object.freeze(cycles.map(describeCycle)),
    unsatisfiable_request_ids: unsatisfiable,
    resolvable_request_ids: resolvable,
    wait_reasons: Object.freeze(blockedItems.map(waitReasonOf).sort((a, b) => (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0))),
    fingerprint,
    budget,
    diagnosis_count: diagnosisCount,
    // 消费诊断额度 ⟺ 本次是一次"报告"（R44.2：既有语义逐位不变；只有 report 才产生诊断事件）。
    consumes_diagnosis_budget: disposition === 'report',
    releasable_instance_ids: releasable,
    produces_new_runnable_input: disposition === 'continue',
    should_start_run: disposition === 'continue',
    reason,
  };
}

// ---------------------------------------------------------------------------
// 诊断额度耗尽报告（R44.2；G03 修复批）
// ---------------------------------------------------------------------------

export interface BudgetExhaustedDiagnosisInput {
  readonly items: readonly WorkItem[];
  readonly scope?: DependencyScope | null;
  readonly budget: DiagnosisBudget;
  readonly usage: BudgetUsage;
  readonly now: LogicalTime;
}

/**
 * **诊断额度已用尽时的「耗尽报告」**（合同 v1.3 R44.2 / R44.3；G03 修复批）。
 *
 * 调用时机：停滞检查点读 `diagnosisPermit(...)` 得 `allowed === false` 时——
 * 此时**不得**调用 `diagnoseStagnation()`（不产生依赖指纹、不做环判定、
 * 不落地循环停止计划），改由本函数给出如实、可取证、且**不消费诊断额度**的报告。
 *
 * ## 与 `diagnoseStagnation()` 的关系
 * 本函数**不是**一次诊断：
 * - `diagnosis_count = 0`、`consumes_diagnosis_budget = false`；
 * - `cycles` / `blocked_request_ids` / `malformed_request_ids` / `fingerprint` 一律为空 / `null`
 *   ——因为确实没做这些判定（不得用编造的空判定冒充"诊断过"）；
 * - `budget = evaluateBudget(budget, usage)`：如实给出各维度用量，
 *   但**不参与**许可判定（许可是调用方在调用本函数**之前**用 `diagnosisPermit` 做的；
 *   `evaluateBudget` 仍是"报告"判定，R34.2 / R44.7）。
 * - `disposition = 'report'`：耗尽本身是需要上报的停止原因，故**仍会产生一条内核事件**
 *   （`diagnosis_budget_exhausted`），只是该事件不计入诊断次数（R44.3）。
 * - `now` **收下但不参与判定**：报告不依赖逻辑时间（它不产生任何时间刻度的新事实）。
 *   保留该字段是为了让调度侧拿同一个 `at` 直接构造输入（与 `StagnationDiagnosisRequest` 形状对齐），
 *   调用点无需做字段映射（R44 的接缝要求）。
 *
 * ## 执行槽（A05-07）
 * `releasable_instance_ids = ownersOf(作用域内非终态项)`：报告期间**不得**占槽。
 * 作用域收窄**复用 `scopeWorkItems()`**（唯一实现，R37.2），不另写一套过滤。
 *
 * @throws {DiagnosisBudgetError} 预算未登记 / 形状非法（`evaluateBudget` 的前置纪律）。
 */
export function exhaustedDiagnosis(input: BudgetExhaustedDiagnosisInput): StagnationDiagnosis {
  // 作用域收窄的唯一实现（R37.2 / F05）：报告的作用域与诊断的作用域口径完全一致。
  const items = scopeWorkItems(input.items, input.scope ?? null);
  const nonTerminalItems = items.filter((item) => !isTerminalStatus(item.status));

  // 如实给出各维度用量（报告用）；**不参与**许可判定，许可是调用方事先用 diagnosisPermit 做的。
  const budget = evaluateBudget(input.budget, input.usage);

  return {
    verdict: 'budget_exhausted',
    disposition: 'report',
    task_revision: null,
    // 确实没做这些判定 ⇒ 一律空 / null（不得用编造的空判定冒充"诊断过"）。
    blocked_request_ids: Object.freeze([]),
    dependency_blocked_request_ids: Object.freeze([]),
    normal_wait_request_ids: Object.freeze([]),
    malformed_request_ids: Object.freeze([]),
    cycles: Object.freeze([]),
    cycle_descriptions: Object.freeze([]),
    unsatisfiable_request_ids: Object.freeze([]),
    resolvable_request_ids: Object.freeze([]),
    wait_reasons: Object.freeze([]),
    fingerprint: null,
    budget,
    diagnosis_count: 0,
    consumes_diagnosis_budget: false,
    releasable_instance_ids: ownersOf(nonTerminalItems),
    produces_new_runnable_input: false,
    should_start_run: false,
    reason:
      `诊断预算已用尽（used >= D_max），按预登记上限停止放行：` +
      `diagnoses ${budget.usage.diagnoses} >= ${budget.limits.diagnoses}（D_max）；` +
      `本次为耗尽报告，不调用诊断判定、不消费诊断额度（R44.2 / R44.3）；` +
      `作用域：${describeScope(input.scope ?? null)}`,
  };
}

/** 环上工作项 id 集合（诊断结果的快捷读取）。 */
export function cyclicRequestIdsOf(diagnosis: StagnationDiagnosis): readonly RequestId[] {
  return Object.freeze(uniqueSorted(diagnosis.cycles.flatMap((cycle) => cycle.request_ids)) as RequestId[]);
}

/** 诊断是否包含某个环成员。 */
export function isCyclicInDiagnosis(diagnosis: StagnationDiagnosis, requestId: RequestId): boolean {
  return diagnosis.cycles.some((cycle) => cycle.request_ids.includes(requestId));
}

/** 诊断的可读摘要（证据 / 日志）。 */
export function describeDiagnosis(diagnosis: StagnationDiagnosis): string {
  return `${diagnosis.verdict}/${diagnosis.disposition}: ${diagnosis.reason}`;
}
