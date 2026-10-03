/**
 * KRN-09 补充：**取消后迟到结果不得变当前成功**；**已发生副作用保留真实记录**。
 *
 * ## 复用纪律（本模块**不另造一套**）
 *
 * 迟到判定与留痕的**唯一实现**是 `./task-lifecycle.js` 的 `classifyResultArrival()`
 * （它自己在 `lateReasonOf()` 里按 `cancelled / timed_out / failed / paused / 版本落后`
 * 分类）。本模块只做三件**它没做的事**：
 * 1. 把"结果到达"与"取消到达"的**先后**变成一个可判定的输入（`at` 逻辑时间 + 有序归约）；
 * 2. 把判定结果翻译成**发布决定**（`publish`）——即"这是不是当前成功"；
 * 3. 提供一个**同步临界区**的并发门面（`ConcurrentResultGate`），
 *    使取消与结果真正竞态时可被验证。
 *
 * 正常到达（任务运行中且结果版本一致）的分支沿用既有接线 `task-action-wiring.ts` 的语义：
 * **不把单轮发布当任务完成**（R213 —— 任务完成是任务级判定，不是一轮 `completed` 推导出来的）。
 * 该判定直接调用 `isTaskAcceptingResults()`，**不复制它的实现**。
 *
 * ## 三条被冻结的语义
 *
 * 1. **迟到结果不得成为当前成功**：`gateRunResult()` 在迟到时 `publish === false`，
 *    且任务状态**不变**（`classifyResultArrival` 的结论）。
 * 2. **已发生副作用如实保留**：迟到结果自带的副作用照实收进 `side_effects`
 *    （`reverted` 恒 `false`，来自 `src/workledger` 的 `ActionSideEffect`）——**不假称撤销**。
 * 3. **取消不可复活**：`cancelled` 是终态；任何后续结果都只能被留痕，不能把任务推回成功。
 *
 * ## 两个"恒 false"判据的真实性质（V-1：不再假装它们是运行期检测器）
 *
 * 本模块对外暴露的两个布尔判据——`any_side_effect_reverted_outside_type_contract` 与
 * `any_late_honored`——在**类型系统内不可达**，其原因两条都写死在**别处的字面量类型**上：
 * - `ActionSideEffect.reverted` 是字面量 `false`（`src/workledger/action-ledger.ts`）；
 * - `LateResultRecord.honored_as_success` 是字面量 `false`（`src/scheduler/task-lifecycle.ts`，
 *   design 钉死：本模块不提供"把迟到结果当成功"的表达能力）。
 *
 * 因此这两个字段**不是**"检测器在观测世界里找到了坏状态"，而是**防御性输入校验**：
 * 只有绕过类型系统的构造（`as unknown as`、未校验的反序列化）才可能让它们变真。
 * 真正的保证在类型层；判据的名字与注释如实说明这一点，测试也不再拿它们冒充运行期实测
 * （见 `late-result-gate.test.ts` 的类型级钉子 + 旁路注入正反例）。
 *
 * ## 顺序规则（本模块唯一的自有规则，显式声明）
 *
 * 当两件事的 `at` **相同**时，归约顺序是 **先取消、后结果**（`SAME_TIME_TIE_ORDER`）：
 * 相同的逻辑时间意味着"顺序无法从时间推出"，此时**从严**——宁可把结果判为迟到，
 * 也不接受"时间相同却抢先发布"。反向对照见测试：同刻的完成结果必须被判迟到。
 *
 * ## 纪律与边界
 *
 * - 纯函数 + 不可变记录；时间以 `LogicalTime` 传入（无墙钟 / 无随机）。
 * - `ConcurrentResultGate` 的方法是**同步临界区**：JS 单线程下"至多一次发布"是结构性保证；
 *   `Promise` 交错验证的是"交错发生在临界区之间"的语义。**这不是线程 / 跨进程安全**。
 */

import {
  type LogicalTime,
  type MessageId,
  type Revision,
  type RunId,
  type TaskId,
} from '../protocol/index.js';
import { type ActionSideEffect } from '../workledger/index.js';
import {
  applyTaskLifecycleTransition,
  cancelTask,
  classifyResultArrival,
  createTaskLifecycle,
  isTerminalTaskStatus,
  type LateResultReason,
  type ResultOutcome,
  type TaskLifecycleState,
} from './task-lifecycle.js';
import { isTaskAcceptingResults } from './task-action-wiring.js';

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 一次到达的轮次结果（`finish_run` 的发布载荷）。 */
export interface RunResultEnvelope {
  readonly run_id: RunId;
  /** 结果**属于**的任务版本（本轮启动时冻结的那一版）。 */
  readonly result_task_revision: Revision;
  readonly outcome: ResultOutcome;
  readonly at: LogicalTime;
  /** 本次到达携带的、**实际已发生**的副作用（如实保留，不假称撤销）。 */
  readonly side_effects?: readonly ActionSideEffect[];
  readonly note?: string;
}

/** 取消到达的载荷（`on_message` 的取消分支）。 */
export interface CancelEnvelope {
  readonly at: LogicalTime;
  readonly reason: string;
  readonly message_id?: MessageId;
  /** 取消时在途动作**已发生**的副作用。 */
  readonly side_effects?: readonly ActionSideEffect[];
}

// ---------------------------------------------------------------------------
// 判定结果
// ---------------------------------------------------------------------------

export const GATE_DECISIONS = ['publish', 'late', 'unknown'] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];

export interface LateResultGateVerdict {
  readonly decision: GateDecision;
  /** 是否迟到（任务已不接受"成功"，或结果版本已过期）。 */
  readonly late: boolean;
  readonly late_reason: LateResultReason | null;
  /**
   * **是否允许把本结果当作当前成功发布**（迟到 / 未知一律 `false`）。
   *
   * 这是本门面**唯一**的发布决定口径。V-3：此前这里另设了一个与其**取值恒等**的
   * `honored_as_success: boolean`，与 `LateResultRecord.honored_as_success: false`
   * 同名不同型；现已删除——"是否被当作当前成功"由本字段表达，记录层的
   * `honored_as_success: false` 是另一种语义（"这条记录的类型不允许是成功"），不再同名混用。
   */
  readonly publish: boolean;
  /** 判定后的生命周期（迟到时状态不变、只增留痕）。 */
  readonly state: TaskLifecycleState;
  /** 本次到达的副作用中，被**如实保留**的条数（迟到结果也照留）。 */
  readonly side_effects_retained: number;
  /**
   * 是否存在"绕过类型系统"的副作用记录（`reverted !== false`）。
   *
   * **类型系统内不可达**（`ActionSideEffect.reverted` 是字面量 `false`）：对所有经类型检查的
   * 状态恒 `false`。只对 `as unknown as` / 未校验反序列化这类**绕过类型系统**的构造可达 ——
   * 即它是**防御性输入校验**，不是运行期"检测器"。见文件头。
   */
  readonly any_side_effect_reverted_outside_type_contract: boolean;
  readonly reason: string;
}

function retainedCount(state: TaskLifecycleState): number {
  return state.side_effects.length;
}

/**
 * 副作用是否声称"已撤销"（`reverted !== false`）。
 *
 * **防御性输入校验，不是运行期检测器**：`ActionSideEffect.reverted` 是字面量 `false`，
 * 故本谓词对所有经类型检查的状态恒 `false`；只有绕过类型系统的构造才可能让它变真。
 * 名称带 `OutsideTypeContract` 就是为了不让人把它读成"检测器在真实路径上发现了坏状态"。
 */
function anySideEffectRevertedOutsideTypeContract(state: TaskLifecycleState): boolean {
  return state.side_effects.some((effect) => effect.reverted !== false);
}

/** 把副作用照实收进生命周期（正常到达路径用；迟到路径由 `classifyResultArrival` 收）。 */
function retainSideEffects(
  state: TaskLifecycleState,
  effects: readonly ActionSideEffect[] | undefined,
  at: LogicalTime,
): TaskLifecycleState {
  if (effects === undefined || effects.length === 0) {
    return state;
  }
  return Object.freeze({
    ...state,
    side_effects: Object.freeze([...state.side_effects, ...effects]),
    updated_at: at,
  });
}

// ---------------------------------------------------------------------------
// 闸门（单次判定）
// ---------------------------------------------------------------------------

/**
 * 判定一个到达的轮次结果，并给出**发布决定**。
 *
 * - **正常到达**（任务 `running` 且结果版本一致）⇒ `decision: 'publish'`，任务运行态不变
 *   （单轮发布 ≠ 任务完成，R213）；
 * - **结果未知** ⇒ `decision: 'unknown'`，`publish: false`，只留痕、不盲目重试（R246）；
 * - **迟到**（`cancelled / timed_out / failed / paused` 或版本落后）⇒ `decision: 'late'`，
 *   `publish: false`，状态不变（判定与留痕全部委托 `classifyResultArrival`）。
 */
export function gateRunResult(state: TaskLifecycleState, envelope: RunResultEnvelope): LateResultGateVerdict {
  const accepting = isTaskAcceptingResults(state) && envelope.result_task_revision === state.revision;

  if (!accepting) {
    const verdict = classifyResultArrival({
      state,
      run_id: envelope.run_id,
      result_task_revision: envelope.result_task_revision,
      outcome: envelope.outcome,
      at: envelope.at,
      side_effects: envelope.side_effects,
      note: envelope.note,
    });
    return Object.freeze({
      decision: 'late',
      late: true,
      late_reason: verdict.late_reason,
      publish: false,
      state: verdict.next,
      side_effects_retained: retainedCount(verdict.next),
      any_side_effect_reverted_outside_type_contract: anySideEffectRevertedOutsideTypeContract(verdict.next),
      reason: verdict.message,
    });
  }

  if (envelope.outcome === 'unknown') {
    const verdict = classifyResultArrival({
      state,
      run_id: envelope.run_id,
      result_task_revision: envelope.result_task_revision,
      outcome: 'unknown',
      at: envelope.at,
      side_effects: envelope.side_effects,
      note: envelope.note,
    });
    return Object.freeze({
      decision: 'unknown',
      late: false,
      late_reason: null,
      publish: false,
      state: verdict.next,
      side_effects_retained: retainedCount(verdict.next),
      any_side_effect_reverted_outside_type_contract: anySideEffectRevertedOutsideTypeContract(verdict.next),
      reason: verdict.message,
    });
  }

  // 正常到达：允许发布，但**不改任务运行态**（R213）。副作用照实入账。
  const next = retainSideEffects(state, envelope.side_effects, envelope.at);
  return Object.freeze({
    decision: 'publish',
    late: false,
    late_reason: null,
    publish: true,
    state: next,
    side_effects_retained: retainedCount(next),
    any_side_effect_reverted_outside_type_contract: anySideEffectRevertedOutsideTypeContract(next),
    reason: '结果按期到达：允许发布为当前成功（任务完成由任务级判定，不由单轮发布推导，R213）',
  });
}

/** 便捷：结果是否会被当作当前成功（迟到 / 未知 ⇒ false）。等价于 `verdict.publish`。 */
export function isResultHonorable(state: TaskLifecycleState, envelope: RunResultEnvelope): boolean {
  return gateRunResult(state, envelope).publish;
}

// ---------------------------------------------------------------------------
// 有序归约（取消 / 暂停 / 超时 / 失败 / 恢复 / 结果）
// ---------------------------------------------------------------------------

export const LIFECYCLE_GATE_EVENT_KINDS = ['cancel', 'pause', 'resume', 'timeout', 'fail', 'recover', 'result'] as const;
export type LifecycleGateEventKind = (typeof LIFECYCLE_GATE_EVENT_KINDS)[number];

export type LifecycleGateEvent =
  | { readonly kind: 'cancel'; readonly cancel: CancelEnvelope }
  | { readonly kind: 'pause' | 'resume' | 'timeout' | 'fail' | 'recover'; readonly at: LogicalTime; readonly reason: string }
  | { readonly kind: 'result'; readonly envelope: RunResultEnvelope };

/**
 * 同刻事件的归约顺序：**先取消，后结果**（从严）。见文件头"顺序规则"。
 * 其余同刻事件按 `LIFECYCLE_GATE_EVENT_KINDS` 的声明顺序稳定排序。
 */
export const SAME_TIME_TIE_ORDER: Readonly<Record<LifecycleGateEventKind, number>> = Object.freeze({
  cancel: 0,
  pause: 1,
  timeout: 2,
  fail: 3,
  result: 4,
  recover: 5,
  resume: 6,
});

function eventAt(event: LifecycleGateEvent): LogicalTime {
  return event.kind === 'result' ? event.envelope.at : event.kind === 'cancel' ? event.cancel.at : event.at;
}

function eventReason(event: LifecycleGateEvent): string {
  switch (event.kind) {
    case 'cancel':
      return event.cancel.reason;
    case 'result':
      return event.envelope.note ?? `轮次 ${event.envelope.run_id} 结果到达`;
    default:
      return event.reason;
  }
}

export interface OrderedGateOutcome {
  readonly state: TaskLifecycleState;
  /** 每一个"结果"事件对应的发布决定（按归约顺序）。 */
  readonly result_verdicts: readonly LateResultGateVerdict[];
  /** 取消是否被应用（已是终态时为 false，表示未改写历史）。 */
  readonly cancel_applied: boolean;
  /** 任何被当作当前成功发布的结果 id（迟到场景下应为空）。 */
  readonly published_run_ids: readonly RunId[];
}

/**
 * 按 `at` 升序归约一串事件，产出最终生命周期与逐个结果的发布决定。
 *
 * 这是本模块对"取消与结果谁先到"的**唯一**处理路径：先排序，再逐个委托
 * `gateRunResult()`（它自己再委托 `classifyResultArrival()`）。
 */
export function applyOrderedLifecycleEvents(
  initial: TaskLifecycleState,
  events: readonly LifecycleGateEvent[],
): OrderedGateOutcome {
  const ordered = [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const atDifference = eventAt(a.event) - eventAt(b.event);
      if (atDifference !== 0) return atDifference;
      const tie = SAME_TIME_TIE_ORDER[a.event.kind] - SAME_TIME_TIE_ORDER[b.event.kind];
      return tie !== 0 ? tie : a.index - b.index;
    });

  let state = initial;
  let cancelApplied = false;
  const verdicts: LateResultGateVerdict[] = [];
  const published: RunId[] = [];

  for (const { event } of ordered) {
    switch (event.kind) {
      case 'cancel': {
        if (isTerminalTaskStatus(state.status)) {
          break; // 已是终态：不改写历史（取消不可复活，也不可被二次取消覆盖）
        }
        state = cancelTask(state, event.cancel.at, event.cancel.reason, {
          cancelled_by_message_id: event.cancel.message_id,
          side_effects: event.cancel.side_effects,
        });
        cancelApplied = true;
        break;
      }
      case 'result': {
        const verdict = gateRunResult(state, event.envelope);
        state = verdict.state;
        verdicts.push(verdict);
        if (verdict.publish) {
          published.push(event.envelope.run_id);
        }
        break;
      }
      default: {
        const to = event.kind === 'resume' || event.kind === 'recover' ? 'running' : event.kind === 'timeout' ? 'timed_out' : event.kind === 'fail' ? 'failed' : 'paused';
        state = applyTaskLifecycleTransition({
          state,
          to,
          at: event.at,
          reason: eventReason(event),
        });
        break;
      }
    }
  }

  return Object.freeze({
    state,
    result_verdicts: Object.freeze(verdicts),
    cancel_applied: cancelApplied,
    published_run_ids: Object.freeze(published),
  });
}

// ---------------------------------------------------------------------------
// 并发门面（同步临界区；Promise 交错可验证）
// ---------------------------------------------------------------------------

/**
 * 结果闸门的并发门面。`cancel()` 与 `submit()` 都是**同步临界区**，
 * 因此"至多一次发布 / 取消后不再发布"在同进程内是结构性保证。
 *
 * **判定依据是"到达序"（真实调用顺序），不是 `at` 的大小**——这正是单线程事件循环
 * 里"事件按到达顺序被处理"的语义。若调用方的逻辑时钟可能回退（结果 `at=11` 先到、
 * 取消 `at=10` 后到），到达序与逻辑序会不一致；此时以到达序为准，
 * 需要逻辑序的调用方应先经 `applyOrderedLifecycleEvents()` 按 `at` 排序再逐个送入。
 */
export class ConcurrentResultGate {
  private current: TaskLifecycleState;

  constructor(input: { readonly task_id: TaskId; readonly revision: Revision; readonly at: LogicalTime }) {
    this.current = createTaskLifecycle({
      task_id: input.task_id,
      revision: input.revision,
      at: input.at,
    });
  }

  public get state(): TaskLifecycleState {
    return this.current;
  }

  /** 到达一次取消（幂等：已终态时原样返回，不改写历史）。 */
  public cancel(envelope: CancelEnvelope): TaskLifecycleState {
    if (isTerminalTaskStatus(this.current.status)) {
      return this.current;
    }
    this.current = cancelTask(this.current, envelope.at, envelope.reason, {
      cancelled_by_message_id: envelope.message_id,
      side_effects: envelope.side_effects,
    });
    return this.current;
  }

  /** 到达一次轮次结果；返回发布决定（迟到 ⇒ 不可发布）。 */
  public submit(envelope: RunResultEnvelope): LateResultGateVerdict {
    const verdict = gateRunResult(this.current, envelope);
    this.current = verdict.state;
    return verdict;
  }

  /**
   * 不变量违规清单（空 = 无违规）：终态上不得再产生"当前成功"。
   *
   * **两条判据都只在"绕过类型系统"的输入上可达**（`LateResultRecord.honored_as_success` 与
   * `ActionSideEffect.reverted` 都是字面量 `false`）：本方法经公开入口 `cancel()` / `submit()`
   * 拿到的一定是类型检查过的状态，因此对本门面的真实调用路径**恒返回空数组**。
   * 保留它们是为了在**未校验的反序列化边界**（持久化行只校验 `task_id`）上仍能兜底，
   * 而不是假装这是运行期检测（见文件头"两个恒 false 判据的真实性质"）。
   */
  public invariantViolations(): readonly string[] {
    const violations: string[] = [];
    if (isTerminalTaskStatus(this.current.status)) {
      for (const record of this.current.late_results) {
        if (record.honored_as_success !== false) {
          violations.push(`终态 ${this.current.status} 上出现被当作成功的迟到结果 ${record.run_id}`);
        }
      }
    }
    for (const effect of this.current.side_effects) {
      if (effect.reverted !== false) {
        violations.push(`副作用 ${effect.effect_id} 被声称撤销，而 reverted 在类型上必须是 false（仅可能来自绕过类型系统的输入）`);
      }
    }
    return Object.freeze(violations);
  }
}

// ---------------------------------------------------------------------------
// 观测汇总
// ---------------------------------------------------------------------------

export interface LateResultGateSummary {
  readonly task_id: TaskId;
  readonly status: TaskLifecycleState['status'];
  readonly terminal: boolean;
  readonly late_result_count: number;
  readonly side_effect_count: number;
  /**
   * 迟到结果是否曾被当作成功。
   *
   * **类型系统内恒 false**（`LateResultRecord.honored_as_success` 是字面量 `false`，design 钉死）；
   * 只有绕过类型系统的输入才可能让它变真 —— 是防御性输入校验，不是运行期检测器。
   */
  readonly any_late_honored: boolean;
  /**
   * 副作用是否被声称撤销（`reverted !== false`）。
   *
   * **类型系统内恒 false**（`ActionSideEffect.reverted` 是字面量 `false`）；含义同
   * {@link LateResultGateVerdict.any_side_effect_reverted_outside_type_contract}。
   */
  readonly any_side_effect_reverted_outside_type_contract: boolean;
  readonly invariant_violations: readonly string[];
}

export function summarizeLateResultGate(state: TaskLifecycleState): LateResultGateSummary {
  const violations: string[] = [];
  for (const record of state.late_results) {
    if (record.honored_as_success !== false) {
      violations.push(`迟到结果 ${record.run_id} 被当作成功`);
    }
  }
  for (const effect of state.side_effects) {
    if (effect.reverted !== false) {
      violations.push(`副作用 ${effect.effect_id} 被声称撤销，而 reverted 在类型上必须是 false`);
    }
  }
  return Object.freeze({
    task_id: state.task_id,
    status: state.status,
    terminal: isTerminalTaskStatus(state.status),
    late_result_count: state.late_results.length,
    side_effect_count: state.side_effects.length,
    any_late_honored: state.late_results.some((record) => record.honored_as_success),
    any_side_effect_reverted_outside_type_contract: state.side_effects.some((effect) => effect.reverted !== false),
    invariant_violations: Object.freeze(violations),
  });
}
