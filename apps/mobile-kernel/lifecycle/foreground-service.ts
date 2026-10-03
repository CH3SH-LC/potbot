/**
 * K10 前台服务协调器 —— **"可见长任务用前台服务 + 通知；常驻有界，不承诺无限"**。
 *
 * ## 它取代的是什么
 *
 * 旧手机方案把后台任务做成"轮询电脑后端"：进程是否活着不重要，因为进度在电脑上。
 * 手机独立内核之后，任务真实跑在手机上，就**必须**遵守 Android 生命周期：
 *
 * 1. **可见长任务必须前台化**。`register()` 拒绝"声明为后台延迟、却预期跑很久"的任务
 *    （`long_task_requires_foreground`）——那种写法在真机上会被系统在几秒内冻结，
 *    结果不是"慢"而是"看起来在跑、实际停了"，正是要消掉的假象。
 * 2. **前台 = 必须有通知**。`promote()` 在通知权限非 `granted` 时抛
 *    `notification_permission_denied` 且**不改任务状态**（fail-closed）。不存在
 *    "悄悄常驻、不告诉用户"这条路径。
 * 3. **常驻是有界的**。`residencyModel` 恒为字面量 `'bounded'`；`checkResidency()`
 *    在超过 `residentBudgetMs` 时**停掉**通知并把任务置 `failed`
 *    （`resident_budget_exhausted`）。系统可以在任何时候回收进程；本模块给出的不是
 *    "我一直活着"的承诺，而是"被回收后能从账本恢复"的判据（见 `recovery.ts`）。
 *
 * ## 不读墙钟
 *
 * 所有时间经注入 `clock`；测试用 `checkResidency` 推过预算即可复现"长时间运行"，
 * 无需真的睡 `residentBudgetMs`。
 */

import { LifecycleError } from './errors.js';
import { DiagnosticsLog } from '../observability/diagnostics.js';
import { assertNoPlaintextSecret } from '../observability/redact.js';
import type {
  Clock,
  FgsState,
  NotificationHandle,
  NotificationPort,
  TaskVisibility,
} from './types.js';

export interface RegisterTaskInput {
  readonly taskId: string;
  readonly visibility: TaskVisibility;
  /** 用户可见的标题；会进通知，因此必须无明文密钥。 */
  readonly title: string;
  /** 预期运行时长（毫秒，安全整数）。 */
  readonly expectedDurationMs: number;
}

export interface TaskRegistration {
  readonly taskId: string;
  readonly visibility: TaskVisibility;
  readonly title: string;
  readonly expectedDurationMs: number;
  readonly registeredAt: number;
  readonly state: FgsState;
}

export interface PromotionRecord {
  readonly taskId: string;
  readonly notificationId: string;
  readonly promotedAt: number;
}

export interface TaskView {
  readonly taskId: string;
  readonly visibility: TaskVisibility;
  readonly state: FgsState;
  readonly notificationId: string | null;
  readonly promotedAt: number | null;
  readonly failureReason: string | null;
}

export interface ResidencyCheck {
  readonly taskId: string;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly withinBudget: boolean;
  /** true = 已停任务并撤通知（本模块不承诺无限常驻）。 */
  readonly degraded: boolean;
  readonly examinedAt: number;
}

export interface ForegroundTaskCoordinatorOptions {
  readonly clock: Clock;
  readonly notifications: NotificationPort;
  /** 单次前台常驻的时长预算（毫秒）。超过即停。 */
  readonly residentBudgetMs: number;
  /**
   * 判定"长任务"的门槛（毫秒）。声明为 `background-deferred` 且预期时长超过它 ⇒ 拒绝登记。
   */
  readonly foregroundThresholdMs: number;
  /** 可选：把生命周期事件写进脱敏诊断日志。 */
  readonly diagnostics?: DiagnosticsLog;
}

interface MutableTask {
  taskId: string;
  visibility: TaskVisibility;
  title: string;
  expectedDurationMs: number;
  state: FgsState;
  registeredAt: number;
  promotedAt: number | null;
  handle: NotificationHandle | null;
  failureReason: string | null;
}

export class ForegroundTaskCoordinator {
  /** **本模块不承诺无限常驻**：这是给消费者与测试读的机器可判定字段。 */
  readonly residencyModel = 'bounded' as const;

  readonly #clock: Clock;
  readonly #notifications: NotificationPort;
  readonly #residentBudgetMs: number;
  readonly #thresholdMs: number;
  readonly #diagnostics: DiagnosticsLog | undefined;
  readonly #tasks = new Map<string, MutableTask>();

  constructor(options: ForegroundTaskCoordinatorOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new LifecycleError('unknown_task', '构造协调器必须注入 clock');
    }
    if (!Number.isSafeInteger(options.residentBudgetMs) || options.residentBudgetMs < 1) {
      throw new LifecycleError(
        'resident_budget_exhausted',
        `residentBudgetMs 必须是正的安全整数，收到 ${String(options.residentBudgetMs)}`,
      );
    }
    if (!Number.isSafeInteger(options.foregroundThresholdMs) || options.foregroundThresholdMs < 0) {
      throw new LifecycleError(
        'long_task_requires_foreground',
        `foregroundThresholdMs 必须是非负安全整数，收到 ${String(options.foregroundThresholdMs)}`,
      );
    }
    this.#clock = options.clock;
    this.#notifications = options.notifications;
    this.#residentBudgetMs = options.residentBudgetMs;
    this.#thresholdMs = options.foregroundThresholdMs;
    this.#diagnostics = options.diagnostics;
  }

  register(input: RegisterTaskInput): TaskRegistration {
    const taskId = requireId(input?.taskId, 'taskId');
    const title = requireId(input?.title, 'title');
    // 标题会进通知 → 先过脱敏判据。
    guardNoSecret(title, '任务标题');
    const visibility = requireVisibility(input?.visibility);
    if (!Number.isSafeInteger(input?.expectedDurationMs) || input.expectedDurationMs < 0) {
      throw new LifecycleError(
        'long_task_requires_foreground',
        `expectedDurationMs 必须是非负安全整数，收到 ${String(input?.expectedDurationMs)}`,
      );
    }
    if (this.#tasks.has(taskId)) {
      throw new LifecycleError('duplicate_task', `任务 ${taskId} 已登记，不得重复登记`);
    }
    // 长任务必须前台可见——后台延迟工作不能承担长任务。
    if (visibility === 'background-deferred' && input.expectedDurationMs > this.#thresholdMs) {
      throw new LifecycleError(
        'long_task_requires_foreground',
        `任务 ${taskId} 声明为后台延迟但预期 ${input.expectedDurationMs}ms > 门槛 ${this.#thresholdMs}ms：` +
          `长任务必须前台可见（前台服务 + 通知），否则系统会冻结进程而任务看似在跑`,
      );
    }

    const task: MutableTask = {
      taskId,
      visibility,
      title,
      expectedDurationMs: input.expectedDurationMs,
      state: 'registered',
      registeredAt: this.#clock.now(),
      promotedAt: null,
      handle: null,
      failureReason: null,
    };
    this.#tasks.set(taskId, task);
    this.#diag('lifecycle', 'info', taskId, 'task-registered', `visibility=${visibility}`);
    return Object.freeze({
      taskId,
      visibility,
      title,
      expectedDurationMs: input.expectedDurationMs,
      registeredAt: task.registeredAt,
      state: task.state,
    });
  }

  /**
   * 提升为前台服务：**必须有通知权限**。权限不足即抛，且**不改任务状态**。
   */
  promote(taskId: string): PromotionRecord {
    const task = this.#require(taskId);
    if (task.visibility !== 'foreground-visible') {
      throw new LifecycleError(
        'long_task_requires_foreground',
        `任务 ${taskId} 是后台延迟工作，不能提升为前台服务`,
      );
    }
    if (task.state === 'foreground' || task.state === 'running') {
      throw new LifecycleError('illegal_transition', `任务 ${taskId} 已是 ${task.state}，不得重复提升`);
    }
    if (task.state === 'finished' || task.state === 'cancelled' || task.state === 'failed') {
      throw new LifecycleError('illegal_transition', `任务 ${taskId} 已到 ${task.state}，不得再提升`);
    }
    const permission = this.#notifications.permission();
    if (permission !== 'granted') {
      // fail-closed：没有通知就不当常驻。状态保持 registered，不产生任何通知。
      throw new LifecycleError(
        'notification_permission_denied',
        `通知权限为 ${permission}：不得在无通知的情况下前台常驻（fail-closed）。` +
          `任务 ${taskId} 保持 registered，等待用户授权或改走系统调度`,
      );
    }

    const at = this.#clock.now();
    const notificationId = `fgs:${taskId}`;
    const handle = this.#notifications.post(
      { notificationId, title: task.title, text: '任务进行中', ongoing: true },
      at,
    );
    task.state = 'foreground';
    task.promotedAt = at;
    task.handle = handle;
    this.#diag('notification', 'info', taskId, 'foreground-promoted', `notificationId=${notificationId}`);
    return Object.freeze({ taskId, notificationId, promotedAt: at });
  }

  /** 前台服务已在跑，开始执行任务体。 */
  markRunning(taskId: string): TaskView {
    const task = this.#require(taskId);
    if (task.state !== 'foreground') {
      throw new LifecycleError(
        'task_not_foreground',
        `任务 ${taskId} 处于 ${task.state}：必须先经 promote() 成为前台服务才能运行`,
      );
    }
    task.state = 'running';
    this.#diag('lifecycle', 'info', taskId, 'run-started', '');
    return this.#view(task);
  }

  /** 更新前台通知正文（进度）。文本同样过脱敏判据（在端口内）。 */
  reportProgress(taskId: string, text: string): void {
    const task = this.#require(taskId);
    if (task.handle === null) {
      throw new LifecycleError('task_not_foreground', `任务 ${taskId} 没有存活的前台通知，无法报告进度`);
    }
    this.#notifications.update(task.handle, { text }, this.#clock.now());
  }

  /** 正常结束：撤通知，状态 `finished`。 */
  finish(taskId: string): TaskView {
    const task = this.#require(taskId);
    if (task.state === 'finished' || task.state === 'cancelled' || task.state === 'failed') {
      throw new LifecycleError('illegal_transition', `任务 ${taskId} 已到 ${task.state}，不得重复结束`);
    }
    this.#stopNotification(task);
    task.state = 'finished';
    this.#diag('lifecycle', 'info', taskId, 'task-finished', '');
    return this.#view(task);
  }

  /** 取消：撤通知，状态 `cancelled`。 */
  cancel(taskId: string, reason: string): TaskView {
    const task = this.#require(taskId);
    if (task.state === 'finished' || task.state === 'cancelled' || task.state === 'failed') {
      throw new LifecycleError('illegal_transition', `任务 ${taskId} 已到 ${task.state}，不得取消`);
    }
    this.#stopNotification(task);
    task.state = 'cancelled';
    task.failureReason = requireId(reason, 'reason');
    this.#diag('lifecycle', 'warn', taskId, 'task-cancelled', task.failureReason);
    return this.#view(task);
  }

  /**
   * 检查常驻是否还在预算内。超预算 ⇒ **停任务 + 撤通知**，返回 `degraded: true`。
   *
   * 这一步就是"不承诺无限常驻"的可执行落点：超过预算必须**主动降级并如实上报**，
   * 而不是继续假装任务在跑。
   */
  checkResidency(taskId: string): ResidencyCheck {
    const task = this.#require(taskId);
    const at = this.#clock.now();
    const elapsedMs = task.promotedAt === null ? 0 : at - task.promotedAt;
    const withinBudget = task.promotedAt !== null && elapsedMs < this.#residentBudgetMs;
    if (!withinBudget) {
      if (task.state === 'foreground' || task.state === 'running') {
        this.#stopNotification(task);
        task.state = 'failed';
        task.failureReason = 'resident_budget_exhausted';
        this.#diag(
          'lifecycle',
          'error',
          taskId,
          'resident-budget-exhausted',
          `elapsed=${elapsedMs}ms budget=${this.#residentBudgetMs}ms`,
        );
        return Object.freeze({
          taskId,
          elapsedMs,
          budgetMs: this.#residentBudgetMs,
          withinBudget: false,
          degraded: true,
          examinedAt: at,
        });
      }
    }
    return Object.freeze({
      taskId,
      elapsedMs,
      budgetMs: this.#residentBudgetMs,
      withinBudget,
      degraded: false,
      examinedAt: at,
    });
  }

  get(taskId: string): TaskView | undefined {
    const task = this.#tasks.get(String(taskId));
    return task === undefined ? undefined : this.#view(task);
  }

  /** 存活的前台通知数（协调器视角；应与端口 `activeCount()` 一致）。 */
  activeForegroundCount(): number {
    let count = 0;
    for (const task of this.#tasks.values()) {
      if (task.handle !== null) {
        count += 1;
      }
    }
    return count;
  }

  #stopNotification(task: MutableTask): void {
    if (task.handle !== null) {
      this.#notifications.stop(task.handle.notificationId);
      task.handle = null;
    }
  }

  #view(task: MutableTask): TaskView {
    return Object.freeze({
      taskId: task.taskId,
      visibility: task.visibility,
      state: task.state,
      notificationId: task.handle?.notificationId ?? null,
      promotedAt: task.promotedAt,
      failureReason: task.failureReason,
    });
  }

  #require(taskId: string): MutableTask {
    const task = this.#tasks.get(String(taskId));
    if (task === undefined) {
      throw new LifecycleError('unknown_task', `协调器里没有任务 ${String(taskId)}`);
    }
    return task;
  }

  #diag(
    kind: 'lifecycle' | 'network' | 'recovery' | 'notification' | 'task',
    severity: 'debug' | 'info' | 'warn' | 'error',
    taskId: string,
    code: string,
    detail: string,
  ): void {
    this.#diagnostics?.record({ kind, severity, taskId, code, detail });
  }
}

/** 命中明文密钥 ⇒ 转成本包机读错误码（原文不回显）。 */
function guardNoSecret(value: unknown, what: string): void {
  try {
    assertNoPlaintextSecret(value, what);
  } catch {
    throw new LifecycleError(
      'notification_secret_detected',
      `${what}命中明文密钥特征：拒绝登记/投递（原文已隐去，不落盘）`,
    );
  }
}

function requireVisibility(value: unknown): TaskVisibility {
  if (value !== 'foreground-visible' && value !== 'background-deferred') {
    throw new LifecycleError(
      'long_task_requires_foreground',
      `visibility 必须是 foreground-visible / background-deferred 之一，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LifecycleError(
      'duplicate_task',
      `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}
