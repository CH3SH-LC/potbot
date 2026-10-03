/**
 * 调度内核的错误与拒绝原因（归属 D03；合同 §六 on_message / start_run / finish_run、§九）。
 *
 * 归属与复用纪律：
 * - **发布被拒的原因不另造一套**：轮次级判据一律复用 `src/protocol` 的
 *   `PublicationRejectionReason`（`evaluateRunOwnership()` 判定后原样透出，R11：实为 5 个）。
 * - 工作项级拒因同样不另造：`src/workledger` 的 `WorkLedgerError.reason` 原样透出（D04）。
 * - 本文件只定义**调度层独有**的两个枚举：轮次启动被拒的原因（正常路径，不是错误）、
 *   以及调度层参数错误（异常路径）。
 */

import { ValidationError, type PublicationRejectionReason } from '../protocol/index.js';

/**
 * 轮次**无法启动**的原因（§六 `start_run` 的「验证可运行」）。
 *
 * 这些是**正常路径**：一个没有可运行输入的调度决策点应当表现为"空推进"
 * （D06 的 `SchedulerAdvanceSeam` 以 `startedRuns === 0` 记账），**不得抛错**，
 * 否则 A02 的 R2…R6「空推进」与 A02-L/A03 的收敛判定都会被异常打断。
 */
export const START_RUN_REJECTION_REASONS = [
  /** 该实例已有活动轮次（§9.1：同一实例最多一个正在运行的轮次）。 */
  'already_active',
  /** 没有可运行输入（§9.4：无有效工作不运行）。 */
  'no_runnable_input',
  /**
   * 运行轮次预算**已用满**，本轮的启动被闸门拒绝（**R34.1**：`R_max` 是**启动前**硬上限）。
   *
   * 判据是"**再启动这一轮会不会超过预登记上限**"（`used + 1 > limit` ⇔ `used >= limit`），
   * 判定发生在获取执行权 / 消费快照 / 认领工作**之前**——被拒时零已读、零认领、零消费。
   *
   * **与 v1.1 R30.1 的区别**：旧口径用 `used > limit` 判"能否启动"，上界成了 `R_max + 1`
   * （配置 `runs = 1` 实际跑 2 轮）；那是**事后断言**，不是上限，已作废。
   * 诊断侧的"已超限"（`usage > limit` ⇒ `budget_exhausted` 报告）仍然存在，但**只用于报告**（R34.2）。
   *
   * 关闭条件只有受控缺陷 `defects.ignore_budget`（与 D05 的判定口径保持一致）。
   */
  'budget_exhausted',
  /** 无法确定本次轮次所属的任务（实例上无 task_id，快照里也没有消息可推断）。 */
  'task_unresolved',
  /**
   * **任务已被取消**（合同 v1.2 R33.6）。
   *
   * 取消是**任务级**事实：已取消任务不得再产生有效业务执行——包括"未开始"的轮次。
   * 判定发生在写任何记录**之前**（不写已读、不认领工作项、不消费可运行输入、不冻加快照）；
   * 若实例上残留排队标记，则在同一事务内**清除**它（"排队状态被正确收尾"），
   * 而**不是**以"避免残留排队标记"为理由继续执行。
   */
  'task_cancelled',
] as const;

export type StartRunRejectionReason = (typeof START_RUN_REJECTION_REASONS)[number];

export const START_RUN_REJECTION_LABELS: Readonly<Record<StartRunRejectionReason, string>> = {
  already_active: '该实例已有活动轮次',
  no_runnable_input: '没有可运行输入（无有效工作不运行）',
  budget_exhausted: '运行轮次预算已超限（内核停止放行新轮次）',
  task_unresolved: '无法确定本次轮次所属任务',
  task_cancelled: '任务已被取消（取消是任务级事实，不产生新的有效业务执行）',
};

/**
 * 结束轮次被拒的原因：**复用** protocol 的 5 个发布拒因，另加一个"实例不存在"的防御性原因。
 * 不复制字面量、不另开一套（R4/R11 的"单一定义来源"要求）。
 */
export type FinishRunRejectionReason =
  | PublicationRejectionReason
  | 'instance_not_registered'
  /**
   * **任务级生命周期不接受结果**（FA-S 接线；KRN-09 / R205 / R213）。
   *
   * 与 `task_cancelled` 分开的原因：`task_cancelled` 是**协议层**的单调取消事实
   * （`TaskControlState`），而这一条说的是**任务运行态**里的
   * `paused` / `timed_out` / `failed` —— 它们同样"不接受成功"，
   * 但在协议层根本没有对应字段（协议只有 `cancelled`）。
   * 两者都判"迟到"，但**拒因必须能分辨**，否则验收分不清是哪一层拦下的。
   */
  | 'task_not_accepting_result';

export function describeStartRunRejection(reason: StartRunRejectionReason): string {
  return START_RUN_REJECTION_LABELS[reason];
}

/**
 * 调度层参数错误（异常路径：调用方给了不可能的输入）。
 *
 * 继承 `ValidationError` ⇒ `accepted === false`；在事务内抛出会让整个事务回滚，
 * 调用方**不得**把该次操作当成已接受（合同 §九-1）。
 */
export class SchedulerError extends ValidationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchedulerError';
  }
}

/**
 * **预算配置不完整**（R30.3）：登记了运行轮次预算，却没有注入预算台账。
 *
 * 为什么是**错误**而不是"静默不闸断"：调用方配了预算就会以为存在硬上限，
 * 而内核若一声不响地放行无限轮次，就等于把 R27.1 要消灭的失效模式
 * （"上限只是事后断言"）从另一个入口放了回来。本项目对同类"静默降级"已纠正多次
 * （R17/R22/R28.1/R28.2/R29.1/R30.3），这里同样选择大声失败。
 *
 * 边界（保持现状）：**完全不登记预算** ⇒ 不做闸断、也不抛错（那是有意的"无预算运行"）。
 */
export class RunBudgetConfigError extends SchedulerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunBudgetConfigError';
  }
}

/** 预算配置不完整时抛出的**固定文案**（调用方据它自查接线）。 */
export function runBudgetConfigMessage(): string {
  return (
    '运行轮次预算（R_max）已登记，但**未注入预算台账**：内核无法读取已用轮次数，' +
    '闸断与记账都无法进行。为不静默放行无限轮次（R27.1/R30.3），此处抛错而不是降级。' +
    '请二选一：① 在 createScheduler({ stagnation: { budget, ledger } }) 里同时注入 ' +
    'D06 的 BudgetLedger（或结构兼容的台账：charge/used 两个方法）；' +
    '② 若不打算做轮次预算闸断，请**不要**登记 budget（省略整个 stagnation 配置）。'
  );
}
