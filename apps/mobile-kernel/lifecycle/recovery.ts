/**
 * K10 进程回收恢复计划 —— **从账本推出"下一步做什么"，而不是"假装还活着"**。
 *
 * ## 两种"死"必须分开
 *
 * - `reclaim`（系统内存回收）：系统允许下次启动续跑。计划给出 `resume-from-cursor` /
 *   `query-external` / `finalize` / `start`。
 * - `force-stop`（用户或系统强制停止）：**系统不允许自动复活**——定时器、前台服务、
 *   JobScheduler 全部被清除，本进程不可能自己醒来。计划对全部未结清任务给出
 *   `blockedBySystem`，`resumed` 为空。这就是"不用无限常驻承诺替代恢复设计"的落点：
 *   我们**不承诺**强停后自动恢复，只承诺"用户下次主动打开 App 时按账本重建"。
 *
 * ## 优先级（顺序即语义）
 *
 * 1. 终态任务 ⇒ `none`（已结清，不重跑）。
 * 2. `force-stop` 且非终态 ⇒ `none` + `blockedBySystem`。
 * 3. 有悬而未决的外部副作用 ⇒ `query-external`（**绝不重做**，与 K07 同纪律：
 *    结果未知先查原单）。
 * 4. 全部步骤已完成但未标完成 ⇒ `finalize`（补齐完成标记，不重跑步骤）。
 * 5. 从未启动 ⇒ `start`。
 * 6. 其余 ⇒ `resume-from-cursor`，`resumeFromStep = cursor`。
 *
 * `mayRedoCompletedSteps` 在类型上是字面量 `false`——"重跑已完成步骤"在本模块的表达能力里
 * 根本不存在。
 */

import { LifecycleError } from './errors.js';
import { isExternalPending } from './types.js';
import type { RecoveryPlan, TaskRecoveryPlan } from './types.js';
import type { TaskLedger } from './ledger.js';
import type { KillMode, TaskRecord } from './types.js';

export interface PlanRecoveryOptions {
  readonly killMode: KillMode;
}

export function planRecovery(ledger: TaskLedger, options: PlanRecoveryOptions): RecoveryPlan {
  if (options === null || typeof options !== 'object' || (options.killMode !== 'reclaim' && options.killMode !== 'force-stop')) {
    throw new LifecycleError('invalid_snapshot', `planRecovery 需要 killMode = reclaim / force-stop`);
  }
  const killMode = options.killMode;
  const tasks = ledger.tasks().map((record) => planTask(record, killMode));

  const resume: string[] = [];
  const queryExternal: string[] = [];
  const settled: string[] = [];
  const blockedBySystem: string[] = [];

  for (const plan of tasks) {
    if (plan.action === 'resume-from-cursor' || plan.action === 'start') {
      resume.push(plan.taskId);
    } else if (plan.action === 'query-external') {
      queryExternal.push(plan.taskId);
    } else if (plan.action === 'finalize') {
      resume.push(plan.taskId);
    } else if (plan.action === 'none') {
      if (isTerminalState(plan.state)) {
        settled.push(plan.taskId);
      } else {
        blockedBySystem.push(plan.taskId);
      }
    }
  }

  const sort = (ids: string[]): readonly string[] => Object.freeze([...ids].sort());
  return Object.freeze({
    killMode,
    resume: sort(resume),
    queryExternal: sort(queryExternal),
    settled: sort(settled),
    blockedBySystem: sort(blockedBySystem),
    tasks: Object.freeze(tasks),
  });
}

function planTask(record: TaskRecord, killMode: KillMode): TaskRecoveryPlan {
  const base = {
    taskId: record.taskId,
    state: record.state,
    totalSteps: record.totalSteps,
    externalPending: isExternalPending(record),
    mayRedoCompletedSteps: false as const,
  };

  if (isTerminalState(record.state)) {
    return Object.freeze({
      ...base,
      action: 'none' as const,
      resumeFromStep: null,
      detail: `任务已结清（${record.state}）：恢复无需动作，也不得重跑`,
    });
  }

  if (killMode === 'force-stop') {
    return Object.freeze({
      ...base,
      action: 'none' as const,
      resumeFromStep: null,
      detail:
        'force-stop 后系统不允许自动复活（定时器/前台服务/调度任务均被清除）：' +
        '本模块不承诺自动恢复；等用户下次主动打开 App 再按账本重建',
    });
  }

  if (base.externalPending) {
    return Object.freeze({
      ...base,
      action: 'query-external' as const,
      resumeFromStep: null,
      detail:
        `外部副作用 ${record.externalIntentRef ?? ''} 已发起、未结清：只能查原单（query-external），` +
        '不得重做、不得另发起一次',
    });
  }

  const cursor = record.cursor;
  if (cursor >= record.totalSteps) {
    return Object.freeze({
      ...base,
      action: 'finalize' as const,
      resumeFromStep: cursor,
      detail: `全部 ${record.totalSteps} 步已完成但未标完成：补齐完成标记，不重跑步骤`,
    });
  }

  if (cursor === 0 && record.state === 'registered') {
    return Object.freeze({
      ...base,
      action: 'start' as const,
      resumeFromStep: 0,
      detail: '任务从未启动：从第 0 步开始',
    });
  }

  return Object.freeze({
    ...base,
    action: 'resume-from-cursor' as const,
    resumeFromStep: cursor,
    detail: `从第 ${cursor} 步继续（已完成 ${record.completedSteps.length} 步不重跑）`,
  });
}

function isTerminalState(state: TaskRecord['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
