/**
 * **任务级"完成"口径**（design-06-P5 的 I-2；合同 `full-app-contract-v1` **附五 R261–R263**）。
 *
 * ## 这一层回答的问题
 *
 * "这个任务完成了吗？" —— 合同裁定它是**派生结论**，不是可写字段。本模块把它实现成
 * **三个可复算谓词的合取**，**没有任何写入面**：
 *
 * | 谓词 | 判据（R261） | 本模块的实现口径 |
 * |---|---|---|
 * | ① `all_work_items_terminal` | 该 task 的全部工作项都处于终态 | 每个 `WorkItem.status ∈ {completed, failed, cancelled}` |
 * | ② `no_in_flight_runs` | 没有在途轮次（含未过期的租约） | 没有 `status==='running'` **且租约未过期**的 run |
 * | ③ `no_unresolved_actions` | 没有未决的动作 | 没有处于 `已准备/已交接/已提交` 的动作记录 |
 *
 * `completed = ① && ② && ③`。同一组状态重复求值必得同一结论（纯函数、无 I/O、无墙钟）。
 *
 * ## 为什么没有"把任务置为完成"的函数
 *
 * R261 明文：任何入口（HTTP、门面、模型）都**不能**把任务置为完成。本模块因此**只导出
 * 读口**——`deriveTaskCompletion()` / `taskCompletionOf()` 都是纯函数，唯一副作用是把结论
 * 冻成对象。没有 `setCompleted` / `markCompleted` / `putTask` 之类的写口，也没有接受写入的
 * 参数。（`task-completion.test.ts` 有一条源码扫描反例守着这一点。）
 *
 * ## 边界（如实登记）
 *
 * - **轮次"结束"不等于任务完成**（R262）：本模块只看"有没有在途轮次"，不看"跑过几轮"。
 *   最后一轮发布成功、但仍有非终态工作项或在途动作 ⇒ **不判完成**。
 * - **完成与成功分开**（R263）：`completed` 只回答"没有未了之事"，不回答"办成了"。
 *   三个呈现口径见 `TASK_COMPLETION_LABELS`，各自的判据见 `#classify`。
 * - **未知动作状态按"未决"处理**（fail-closed）：介质里的动作行若 `state` 不是七态之一，
 *   本模块**不假装它没发生**，而是计入 `unknown_action_states` 并当作未决 ⇒ 不判完成。
 * - 本模块**不读别的任务的记录**：`taskCompletionOf()` 按 `task_id` 过滤，跨对象归属不做
 *   猜测（R201）。
 *
 * ## 本模块不做
 *
 * 状态写入（`src/workledger` / `src/scheduler` 的写口）、生命周期转换（`src/scheduler/task-lifecycle.ts`）、
 * HTTP 形状（`http.ts`）。本文件**零文件 IO、零墙钟、零随机**。
 */

import {
  isDeliveredArtifact,
  isLeaseExpired,
  isTerminalStatus,
  type ArtifactRecord,
  type LogicalTime,
  type RunRecord,
  type Store,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { isActionState, type ActionState } from '../../../src/workledger/index.js';

// ---------------------------------------------------------------------------
// 七态里"未决"的那三个
// ---------------------------------------------------------------------------

/**
 * R261 第 3 条的**字面口径**：处于这三个状态而**尚未到终态**的动作 = 未决。
 *
 * 为什么 `result_unknown` 与 `user_reported_complete` **不**在此列：
 * - `result_unknown`（结果未知）：R263 明文把它归入"**已完成但有未成之事**"——
 *   也就是说存在结果未知的动作时，任务**可以**完成。把它算作未决会与 R263 直接冲突。
 * - `user_reported_complete`（用户报告完成）：R242 说它不是"可信回执确认"，但它同样
 *   不是"还在途"——用户已经表态，后续只是等回执。R261 的枚举也没有它。
 *
 * 两者都**不被隐藏**：它们照实进 `flags.any_unknown_action` 与状态分布，只是不阻塞完成。
 */
export const UNRESOLVED_ACTION_STATES: readonly ActionState[] = Object.freeze([
  'prepared',
  'handed_off',
  'submitted',
]);

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 动作记录的最小结构面（介质里是"不透明行"，主键/状态由本模块结构读取）。 */
export interface TaskCompletionActionRow {
  readonly action_id?: string;
  readonly task_id?: string;
  readonly state: string;
}

export interface TaskCompletionInput {
  readonly task_id: string;
  /** 求值用的逻辑时间（判租约是否过期；**不是**墙钟）。 */
  readonly now: LogicalTime;
  readonly work_items: readonly WorkItem[];
  readonly runs: readonly RunRecord[];
  readonly actions: readonly TaskCompletionActionRow[];
  readonly artifacts: readonly ArtifactRecord[];
  /**
   * 任务**当前**版本。给了就启用"产物必须绑当前版本"的检查（外部监督 S-1026-01）；
   * 省略则只做"存在已交付产物"检查（旧行为，仅限直接调用派生函数的场景）。
   */
  readonly task_revision?: number;
}

export interface TaskCompletionPredicates {
  readonly all_work_items_terminal: boolean;
  readonly no_in_flight_runs: boolean;
  readonly no_unresolved_actions: boolean;
}

/**
 * R263 的**成功轴**标签。前三个是 `completed === true` 时的三态；`not_completed` 是
 * "还有未了之事"（三谓词未全真）时如实呈现的状态——**不得**与"已完成"混用。
 */
export type TaskCompletionLabel =
  | 'not_completed'
  | 'completed_and_successful'
  | 'completed_with_unfinished_business'
  | 'completed_and_cancelled';

export const TASK_COMPLETION_LABELS: Readonly<Record<TaskCompletionLabel, string>> = Object.freeze({
  not_completed: '尚未完成',
  completed_and_successful: '已完成且成功',
  completed_with_unfinished_business: '已完成但有未成之事',
  completed_and_cancelled: '已完成且被取消',
});

/** 成功轴的原始事实（**全部暴露**：标签有取舍，事实没有）。 */
export interface TaskCompletionFlags {
  readonly all_work_items_completed: boolean;
  readonly any_work_item_failed: boolean;
  readonly any_work_item_cancelled: boolean;
  /** 有动作处于七态里的 `result_unknown`（R263 明文归入"有未成之事"）。 */
  readonly any_result_unknown_action: boolean;
  /** 有动作的 `state` **不在七态之内**（数据异常，fail-closed 地按未决处理）。 */
  readonly any_unknown_action_state: boolean;
  readonly has_delivered_artifact: boolean;
}

export interface TaskCompletionCounts {
  readonly work_items: number;
  readonly work_items_terminal: number;
  readonly runs: number;
  readonly runs_in_flight: number;
  readonly runs_running_lease_expired: number;
  readonly actions: number;
  readonly actions_unresolved: number;
  readonly artifacts: number;
  readonly artifacts_delivered: number;
}

export interface TaskCompletionView {
  readonly task_id: string;
  readonly now: LogicalTime;
  /** 三谓词的合取。**派生**：没有任何入口能直接写它。 */
  readonly completed: boolean;
  readonly label: TaskCompletionLabel;
  readonly label_text: string;
  readonly detail: string;
  readonly predicates: TaskCompletionPredicates;
  readonly flags: TaskCompletionFlags;
  readonly counts: TaskCompletionCounts;
  /** 未过期的 running 轮次（判据 ② 的**反例证据**）。 */
  readonly in_flight_run_ids: readonly string[];
  /** 已过期的 running 轮次：**不算在途**，但如实列出（可被回收，不是"没发生"）。 */
  readonly expired_running_run_ids: readonly string[];
  /** 未决动作（判据 ③ 的**反例证据**）。 */
  readonly unresolved_action_ids: readonly string[];
  /** 七态之外的 `state` 值：按未决处理，且必须被看见。 */
  readonly unknown_action_states: readonly string[];
  /** 已发布**且已回读**的产物（R263 成功轴的事实依据）。 */
  readonly delivered_artifact_ids: readonly string[];
}

// ---------------------------------------------------------------------------
// 三个谓词（各自单独导出：反向对照可以逐项替换，证明它们是荷载的）
// ---------------------------------------------------------------------------

/** 谓词 ①：全部工作项终态。**空集也成立**（"没有工作项要等"就是没有未了之事）。 */
export function allWorkItemsTerminal(workItems: readonly WorkItem[]): boolean {
  // **空集不得当作"全部终态"**（外部监督 S-1026-01，2026-10-03）。
  // `[].every(...)` 恒为 `true` —— 一个**没有注册任何工作记录**的任务会因此"真空满足"
  // 谓词①，配上一条历史产物就推出 `completed_and_successful`。R261 的"全部工作项都处于终态"
  // **预设了存在工作项**；没有工作记录说明"这个口径不适用"，而不是"都做完了"。
  if (workItems.length === 0) return false;
  return workItems.every((item) => isTerminalStatus(item.status));
}

/**
 * 谓词 ②：没有在途轮次。
 *
 * 在途 = `status === 'running'` **且** 租约**未**过期。已过期的 running 轮次是"持有者没了"
 * 的残留记录（R216 的重启归位对象），不是"正在跑"，因此不计入在途——但它**被如实列出**，
 * 不会被悄悄忽略。
 */
export function inFlightRuns(runs: readonly RunRecord[], now: LogicalTime): readonly RunRecord[] {
  return runs.filter((run) => run.status === 'running' && !isLeaseExpired(run, now));
}

export function noInFlightRuns(runs: readonly RunRecord[], now: LogicalTime): boolean {
  return inFlightRuns(runs, now).length === 0;
}

/** 谓词 ③：没有未决动作。七态之外的取值按未决处理（fail-closed）。 */
export function isUnresolvedActionState(state: string): boolean {
  if (!isActionState(state)) return true;
  return (UNRESOLVED_ACTION_STATES as readonly string[]).includes(state);
}

export function noUnresolvedActions(actions: readonly TaskCompletionActionRow[]): boolean {
  return !actions.some((action) => isUnresolvedActionState(action.state));
}

// ---------------------------------------------------------------------------
// 派生
// ---------------------------------------------------------------------------

export function deriveTaskCompletion(input: TaskCompletionInput): TaskCompletionView {
  const predicates: TaskCompletionPredicates = Object.freeze({
    all_work_items_terminal: allWorkItemsTerminal(input.work_items),
    no_in_flight_runs: noInFlightRuns(input.runs, input.now),
    no_unresolved_actions: noUnresolvedActions(input.actions),
  });

  // 三谓词的合取是**唯一**的完成判据。反向对照（`task-completion.test.ts`）会逐项
  // 从这一行里摘掉一个谓词，并断言对应断言变红——所以这三个合取项都必须在这一行里。
  const completed =
    predicates.all_work_items_terminal && predicates.no_in_flight_runs && predicates.no_unresolved_actions;

  const inFlight = inFlightRuns(input.runs, input.now);
  const expiredRunning = input.runs.filter(
    (run) => run.status === 'running' && isLeaseExpired(run, input.now),
  );
  const unresolvedActions = input.actions.filter((action) => isUnresolvedActionState(action.state));
  const unknownActionStates = [
    ...new Set(input.actions.filter((action) => !isActionState(action.state)).map((action) => action.state)),
  ].sort();
  const delivered = input.artifacts.filter((record) => {
    if (!isDeliveredArtifact(record)) return false;
    // **产物必须绑当前版本**：旧 revision 的已发布产物不代表当前 revision 已交付。
    // 给了 `task_revision` 时严格比对；读不到该字段的行按**不匹配**处理（fail-closed）。
    if (input.task_revision === undefined) return true;
    return (record as { readonly task_revision?: number }).task_revision === input.task_revision;
  });

  const flags: TaskCompletionFlags = Object.freeze({
    all_work_items_completed: input.work_items.every((item) => item.status === 'completed'),
    any_work_item_failed: input.work_items.some((item) => item.status === 'failed'),
    any_work_item_cancelled: input.work_items.some((item) => item.status === 'cancelled'),
    any_result_unknown_action: input.actions.some((action) => action.state === 'result_unknown'),
    any_unknown_action_state: unknownActionStates.length > 0,
    has_delivered_artifact: delivered.length > 0,
  });

  const label = classify(completed, flags);

  return Object.freeze({
    task_id: input.task_id,
    now: input.now,
    completed,
    label,
    label_text: TASK_COMPLETION_LABELS[label],
    detail: describe(label, predicates, flags),
    predicates,
    flags,
    counts: Object.freeze({
      work_items: input.work_items.length,
      work_items_terminal: input.work_items.filter((item) => isTerminalStatus(item.status)).length,
      runs: input.runs.length,
      runs_in_flight: inFlight.length,
      runs_running_lease_expired: expiredRunning.length,
      actions: input.actions.length,
      actions_unresolved: unresolvedActions.length,
      artifacts: input.artifacts.length,
      artifacts_delivered: delivered.length,
    }),
    in_flight_run_ids: Object.freeze(inFlight.map((run) => String(run.run_id))),
    expired_running_run_ids: Object.freeze(expiredRunning.map((run) => String(run.run_id))),
    unresolved_action_ids: Object.freeze(
      unresolvedActions.map((action, index) => action.action_id ?? `(无 action_id 的第 ${String(index + 1)} 条)`),
    ),
    unknown_action_states: Object.freeze(unknownActionStates),
    delivered_artifact_ids: Object.freeze(delivered.map((record) => String(record.artifact_id))),
  });
}

/**
 * R263 的成功轴分类。
 *
 * **优先级**（三个事实同时成立时取最"重"的一个，但全部事实仍在 `flags` 里可见）：
 * `被取消` > `有未成之事` > `成功`。
 * 选这个顺序的理由：取消是**人对任务下的判断**，比"某个工作项失败"更该被先说出口。
 *
 * `全部工作项 completed 但没有已交付产物` 归入"有未成之事"：R262 说任务可以没有产物而完成，
 * 但那种"完成"**必须如实区分于"成功交付"**——所以它不落在"成功"这一档。
 */
function classify(completed: boolean, flags: TaskCompletionFlags): TaskCompletionLabel {
  if (!completed) return 'not_completed';
  if (flags.any_work_item_cancelled) return 'completed_and_cancelled';
  if (
    flags.any_work_item_failed ||
    flags.any_result_unknown_action ||
    flags.any_unknown_action_state ||
    !flags.all_work_items_completed ||
    !flags.has_delivered_artifact
  ) {
    return 'completed_with_unfinished_business';
  }
  return 'completed_and_successful';
}

function describe(
  label: TaskCompletionLabel,
  predicates: TaskCompletionPredicates,
  flags: TaskCompletionFlags,
): string {
  if (label === 'not_completed') {
    const pending: string[] = [];
    if (!predicates.all_work_items_terminal) pending.push('仍有非终态工作项');
    if (!predicates.no_in_flight_runs) pending.push('仍有在途轮次');
    if (!predicates.no_unresolved_actions) pending.push('仍有未决动作');
    return `尚未完成：${pending.join('；')}（单轮结束不构成任务完成，R262）`;
  }
  switch (label) {
    case 'completed_and_cancelled':
      return '已完成且被取消：没有未了之事，但有工作项是被取消的';
    case 'completed_with_unfinished_business': {
      const reasons: string[] = [];
      if (flags.any_work_item_failed) reasons.push('有工作项失败');
      if (flags.any_result_unknown_action) reasons.push('有动作结果未知（外部结果读不到）');
      if (flags.any_unknown_action_state) reasons.push('有动作的状态取值不在七态之内');
      if (!flags.has_delivered_artifact) reasons.push('没有已发布并回读的产物');
      if (!flags.all_work_items_completed && reasons.length === 0) reasons.push('有工作项不是 completed');
      return `已完成但有未成之事：${reasons.join('；')}`;
    }
    default:
      return '已完成且成功：全部工作项 completed，且产物已发布并回读';
  }
}

// ---------------------------------------------------------------------------
// 存储读口（把"哪个 task 的记录"这件事收敛在这里，R201）
// ---------------------------------------------------------------------------

/** 扩展快照（`actions` / `task_lifecycles` 由 `src/storage/store-core.ts` 在运行期提供）。 */
interface ExtendedSnapshot {
  /** `revision` 参与 R264 第 2 条（产物必须绑**当前**版本）；读不到就按 fail-closed 处理。 */
  readonly tasks: readonly { readonly task_id: string; readonly revision?: number }[];
  readonly work_items: readonly WorkItem[];
  readonly runs: readonly RunRecord[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly actions?: readonly unknown[];
}

/**
 * 从介质快照派生某个任务的完成视图（**只读**；任务不存在时返回 `undefined`）。
 *
 * 三个集合都按 `task_id` **过滤后才求值**：不把别的任务的记录算进来（R201 跨对象归属）。
 * 动作行在介质里是"不透明行"，这里结构读取 `state` / `action_id`，读不到就走 fail-closed。
 */
export function taskCompletionOf(
  store: Store,
  taskId: string,
  now: LogicalTime,
): TaskCompletionView | undefined {
  return completionInSnapshot(store.snapshot() as unknown as ExtendedSnapshot, taskId, now);
}

export function completionInSnapshot(
  snapshot: ExtendedSnapshot,
  taskId: string,
  now: LogicalTime,
): TaskCompletionView | undefined {
  const taskRow = snapshot.tasks.find((row) => String(row.task_id) === taskId);
  if (taskRow === undefined) {
    return undefined;
  }
  return deriveTaskCompletion({
    task_id: taskId,
    now,
    // R264 第 2 条：产物必须绑**当前**版本。
    //
    // **读不到任务版本时 fail-closed**：`-1` 不是一个合法 revision，因此任何产物的
    // `task_revision` 都不会与它相等 ⇒ `has_delivered_artifact` 为假。
    // 为什么不"省略 `task_revision`"：省略会让派生函数跳过版本检查（那是给**直接调用**
    // 派生函数的场景留的口），于是坏掉的任务行反而会被当成"有产物 = 已交付"。
    // 产品读口宁可少认一次成功，也不认一次没有证据的成功。
    task_revision: typeof taskRow.revision === 'number' ? taskRow.revision : -1,
    work_items: snapshot.work_items.filter((row) => String(row.task_id) === taskId),
    runs: snapshot.runs.filter((row) => String(row.task_id) === taskId),
    actions: actionRowsOf(snapshot.actions ?? [], taskId),
    artifacts: snapshot.artifacts.filter((row) => String(row.task_id) === taskId),
  });
}

/** 从"不透明行"里结构读出某个任务的动作行（读不到状态的行**仍然返回**，由下游按未决处理）。 */
function actionRowsOf(rows: readonly unknown[], taskId: string): readonly TaskCompletionActionRow[] {
  const out: TaskCompletionActionRow[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      // 形状不认识的行**不跳过**：以一个"状态不可识别"的行呈现，fail-closed 地阻塞完成。
      out.push({ state: '(不可识别的动作行)' });
      continue;
    }
    const record = row as { readonly action_id?: unknown; readonly task_id?: unknown; readonly state?: unknown };
    if (record.task_id !== undefined && String(record.task_id) !== taskId) {
      continue;
    }
    out.push({
      ...(typeof record.action_id === 'string' ? { action_id: record.action_id } : {}),
      state: typeof record.state === 'string' ? record.state : '(缺少 state)',
    });
  }
  return out;
}
