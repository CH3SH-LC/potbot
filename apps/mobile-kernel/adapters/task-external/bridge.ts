/**
 * K-I12 任务↔外部副作用桥（K10 任务游标 ⇄ K07 授权/提交账本）。
 *
 * ## 落地的集成请求（K10 集成请求 #3）
 *
 * > 确认并落地 `externalIntentRef` 约定（= K07 submissionId），使
 * > `beginExternalIntent` / `settleExternal` 把任务游标桥到授权/提交账本；
 * > 结清必须**查询优先**，**绝不假定成功**。
 *
 * ## 约定（本文件把它从注释变成判据）
 *
 * K10 `TaskRecord.externalIntentRef` 的取值就是 K07 `SubmissionRecord.submissionId`。
 * 本桥在两个写入口各钉一次：
 *
 * - `beginExternalIntent(taskId, submissionId)`：先确认 K07 账本里**确有**这条提交，
 *   且 `submission.taskId === taskId`，才允许在任务台账写下意图。引用约定被破坏
 *   （拼错的 id / 别的任务的提交）**当场拒绝**，不写进任务台账——否则恢复期
 *   `query-external` 会去查一条不存在的原单，把"从未发出"误报成"发出未知"。
 * - `settleExternal(taskId)`：只从 `externalIntentRef` 反查 K07 提交的**实际状态**，
 *   用该状态结清任务。**绝不**用调用方给的字符串、也绝不用"看起来像成功"。
 *
 * ## 结清为什么必须查询优先（三条纪律）
 *
 * 1. **只有 confirmed 才算成功**：`settleExternal` 只在 K07 提交进入**终态**
 *    （`confirmed` / `failed` / `cancelled`）时才结清任务；`submitting` / `submitted` /
 *    `unknown` **一律不结清**，任务保持"外部意图未结清"。K07 的
 *    `reconcileUnknown()` 会在允许时查原单，本桥只消费它的结论。
 * 2. **绝不代发**：提交处于"已占用、未发出"（`submitting` + `sendIntentAt === null`）时，
 *    合法动作是"继续同一条提交"，但**发出是对外动作**——本桥只如实返回
 *    `awaiting-send`，**不**调用 `send()`（`tests/` 用执行器调用计数钉住这一点）。
 * 3. **写回的值 = K07 的真实状态**：任务 `externalObservedState` 就是 K07 提交状态的
 *    逐字拷贝。把 `unknown` 写成 `confirmed` 与 K07「结果未知不得冒充完成」直接冲突。
 *
 * ## 幂等
 *
 * 重复结清**不改写新事实**：任务已有 `externalObservedState` 时，`settleExternal`
 * 直接返回 `already-settled`，**不追加日志、不重查原单**（K10 审计可用
 * `lastSeq` / `journal()` 长度证明"没有第二次结清写入"）。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - 未接原生 Android 进程/前台服务；本桥是纯 TS 内存装配，真机上的持久化由 K09 端口负责。
 * - 未改 `apps/android/**` / `contracts/**` / 任何兄弟包——全在 `adapters/task-external/**`
 *   写权内新建。
 */

// 只 import 用到的**定义模块**，不经过 `actions/index.js` / `lifecycle/index.js` barrel：
// K10 测试已有同样先例（直接 import `lifecycle/ledger.js`），且 barrel 里若有无关模块
// 未就绪，会把不相关的编译错误带进本包。这里用到的东西都在下列三个文件里。
import type { TaskLedger } from '../../lifecycle/ledger.js';
import type { TaskRecord } from '../../lifecycle/types.js';
import { isTerminalSubmissionState } from '../../actions/types.js';
import type { AuthorizationLedger } from '../../actions/ledger.js';
import type { SubmissionRecord, SubmissionState } from '../../actions/types.js';
import { TaskExternalBridgeError } from './errors.js';

/** `settleExternal` 的机器化结论。 */
export type SettleOutcome =
  /** 本次把任务结清了（写入了 K07 的真实终态）。 */
  | 'settled'
  /** 任务此前已结清；本次是幂等空操作。 */
  | 'already-settled'
  /** 提交已占用但**尚未发出**：本桥不代发，任务保持未结清。 */
  | 'awaiting-send'
  /** 查了原单（或无需查）但仍拿不到终态结论：如实保持未结清，不假定成功。 */
  | 'still-unknown';

export interface SettleExternalResult {
  readonly taskId: string;
  readonly submissionId: string;
  /** 本次是否已把任务结清。 */
  readonly settled: boolean;
  /** K07 提交在本次调用结束时的真实状态。 */
  readonly submissionState: SubmissionState;
  /** 写入任务游标的外部观测状态；未结清时为 `null`。 */
  readonly observedState: SubmissionState | null;
  /** 本次是否真的调用了原单查询端口（K07 `reconcileUnknown().queried`）。 */
  readonly queried: boolean;
  readonly outcome: SettleOutcome;
  readonly detail: string;
  /** 结清后的任务视图（未结清时是当前视图）。 */
  readonly task: TaskRecord;
}

export interface TaskExternalBridgeOptions {
  /** K10 任务游标台账。 */
  readonly tasks: TaskLedger;
  /** K07 授权/提交账本。 */
  readonly actions: AuthorizationLedger;
}

/**
 * 任务游标 ⇄ 外部提交账本的双向桥。无状态（两端账本自带状态），可安全复用。
 */
export class TaskExternalBridge {
  readonly #tasks: TaskLedger;
  readonly #actions: AuthorizationLedger;

  constructor(options: TaskExternalBridgeOptions) {
    if (options === null || typeof options !== 'object' || options.tasks === undefined || options.actions === undefined) {
      throw new TaskExternalBridgeError(
        'unknown_task',
        '构造任务↔外部桥必须同时注入 K10 任务台账 tasks 与 K07 提交账本 actions',
      );
    }
    this.#tasks = options.tasks;
    this.#actions = options.actions;
  }

  /**
   * 记录一次外部副作用**已发起**：把 K07 的 submissionId 写进任务的 `externalIntentRef`。
   *
   * 写入前**校验引用约定**（提交存在 + 同任务），因此任务台账里不会出现解析不出的引用。
   * 重复发起由 K10 台账自身拒绝（`LifecycleError('illegal_transition')`），本桥不重包。
   */
  beginExternalIntent(taskId: string, submissionId: string, at?: number): TaskRecord {
    const task = this.#tasks.getTask(taskId);
    if (task === undefined) {
      throw new TaskExternalBridgeError(
        'unknown_task',
        `K10 任务台账里没有任务 ${JSON.stringify(taskId)}：不得为不存在的任务登记外部意图`,
      );
    }
    const submission = this.#requireSubmission(submissionId);
    if (submission.taskId !== task.taskId) {
      throw new TaskExternalBridgeError(
        'submission_task_mismatch',
        `提交 ${submission.submissionId} 属于任务 ${JSON.stringify(submission.taskId)}，` +
          `却被登记到任务 ${JSON.stringify(task.taskId)} 名下：跨任务引用不得当作同一任务的外部意图`,
      );
    }
    return this.#tasks.beginExternalIntent(task.taskId, submission.submissionId, at);
  }

  /**
   * 按 `(taskId, actionId)` 解析出唯一提交后登记外部意图（K07 侧一个动作至多一条提交）。
   * 解析不到即拒——不猜 id、不新建提交。
   */
  beginFromAction(taskId: string, actionId: string, at?: number): TaskRecord {
    const submission = this.#actions.submissionForAction(taskId, actionId);
    if (submission === undefined) {
      throw new TaskExternalBridgeError(
        'unknown_submission',
        `任务 ${JSON.stringify(taskId)} 的动作 ${JSON.stringify(actionId)} 没有提交记录：` +
          `没有已占用的提交就不存在"已发起的外部意图"`,
      );
    }
    return this.beginExternalIntent(taskId, submission.submissionId, at);
  }

  /**
   * **查询优先**地结清任务的外部意图。
   *
   * 流程：读任务 → 读 `externalIntentRef` → 反查 K07 提交 → 已结清则幂等返回 →
   * 否则用 K07 `reconcileUnknown()` 判明并（仅在允许时）查原单 →
   * 提交进入终态才结清任务，否则如实保持未结清。
   *
   * **调用方无法影响写回的状态**：本方法不接受 `observedState` 参数，写回值只能来自
   * K07 账本。这是"绝不假定成功"在签名层面的落点。
   */
  async settleExternal(taskId: string): Promise<SettleExternalResult> {
    const task = this.#tasks.getTask(taskId);
    if (task === undefined) {
      throw new TaskExternalBridgeError(
        'unknown_task',
        `K10 任务台账里没有任务 ${JSON.stringify(taskId)}：无从结清`,
      );
    }
    const ref = task.externalIntentRef;
    if (ref === null) {
      throw new TaskExternalBridgeError(
        'no_pending_external_intent',
        `任务 ${task.taskId} 没有待结清的外部意图：没有发起过，就没有可结清的结果`,
      );
    }
    const submission = this.#requireSubmission(ref);

    // 幂等：已结清 ⇒ 不改写、不重查。
    if (task.externalObservedState !== null) {
      const recorded = task.externalObservedState as SubmissionState;
      return this.#result({
        task,
        submission,
        settled: true,
        observedState: recorded,
        queried: false,
        outcome: 'already-settled',
        detail:
          `任务 ${task.taskId} 外部意图已结清（观测状态 ${recorded}，提交 ${submission.submissionId} 当前 ` +
          `${submission.state}）：重复结清不改写既有观测事实，不重查原单`,
      });
    }

    // 查询优先：让 K07 判明状态并在合法时查原单；本桥不代发、不新建授权/提交。
    // 缺原单查询端口（missing_order_query_port）等域内拒因**原样上抛**——
    // 把"查不了"降级成"已结清"正是本桥要关掉的洞。
    const reconciled = await this.#actions.reconcileUnknown(submission.submissionId);
    const outcome = {
      submission: reconciled.submission,
      queried: reconciled.queried,
      detail: reconciled.verdict.detail,
    };

    const latest = outcome.submission;
    if (isTerminalSubmissionState(latest.state)) {
      const settledTask = this.#tasks.settleExternal(task.taskId, latest.state);
      return this.#result({
        task: settledTask,
        submission: latest,
        settled: true,
        observedState: latest.state,
        queried: outcome.queried,
        outcome: 'settled',
        detail:
          `提交 ${latest.submissionId} 到达终态 ${latest.state}：按 K07 真实状态结清任务 ${task.taskId}` +
          `（观测状态即提交状态，逐字拷贝）`,
      });
    }

    // 非终态 ⇒ 不结清。发出仍是调用方显式动作；未知仍是未知。
    const awaitingSend = latest.state === 'submitting' && latest.sendIntentAt === null;
    return this.#result({
      task: this.#tasks.getTask(task.taskId)!,
      submission: latest,
      settled: false,
      observedState: null,
      queried: outcome.queried,
      outcome: awaitingSend ? 'awaiting-send' : 'still-unknown',
      detail: awaitingSend
        ? `提交 ${latest.submissionId} 已占用但尚未发出（sendIntentAt=null）：合法动作是继续同一条提交，` +
          `但发出是对外动作，本桥不代发；任务 ${task.taskId} 保持未结清`
        : `提交 ${latest.submissionId} 处于 ${latest.state}，未到终态：` +
          `如实保持任务 ${task.taskId} 外部意图未结清（不得假定成功）。K07 判据：${outcome.detail}`,
    });
  }

  /** 读任务当前的 `externalIntentRef`（= K07 submissionId）；无则 null。 */
  refOf(taskId: string): string | null {
    const task = this.#tasks.getTask(taskId);
    if (task === undefined) {
      throw new TaskExternalBridgeError(
        'unknown_task',
        `K10 任务台账里没有任务 ${JSON.stringify(taskId)}`,
      );
    }
    return task.externalIntentRef;
  }

  #requireSubmission(submissionId: string): SubmissionRecord {
    if (typeof submissionId !== 'string' || submissionId.trim().length === 0) {
      throw new TaskExternalBridgeError(
        'unknown_submission',
        `externalIntentRef 必须是非空字符串（= K07 submissionId），收到 ${JSON.stringify(submissionId)}`,
      );
    }
    const submission = this.#actions.getSubmission(submissionId);
    if (submission === undefined) {
      throw new TaskExternalBridgeError(
        'unknown_submission',
        `K07 提交账本里没有 ${JSON.stringify(submissionId)}：externalIntentRef 约定为 submissionId，` +
          `解析不出的引用一律当作约定被破坏（fail-closed），不得当作已发起`,
      );
    }
    return submission;
  }

  #result(input: {
    readonly task: TaskRecord;
    readonly submission: SubmissionRecord;
    readonly settled: boolean;
    readonly observedState: SubmissionState | null;
    readonly queried: boolean;
    readonly outcome: SettleOutcome;
    readonly detail: string;
  }): SettleExternalResult {
    return Object.freeze({
      taskId: input.task.taskId,
      submissionId: input.submission.submissionId,
      settled: input.settled,
      submissionState: input.submission.state,
      observedState: input.observedState,
      queried: input.queried,
      outcome: input.outcome,
      detail: input.detail,
      task: input.task,
    });
  }
}
