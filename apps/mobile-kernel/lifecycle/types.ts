/**
 * K10 生命周期 —— **契约形状与端口接口**（零依赖，纯类型 + 纯函数）。
 *
 * 本文件把三件在真机上必须分清、在旧"假后台"里被混为一谈的东西**拆开**：
 *
 * 1. **进程/服务层**（`FGS_STATES`）：任务在本进程里是前台服务成员还是被推迟的延迟工作。
 *    Android 的规则是：*可见的长任务*用前台服务 + 通知；不抢占用户的活交给系统调度器。
 *    本层没有"常驻"这个状态——只有 `residencyBudgetMs` 覆盖的有界区间。
 * 2. **网络层**（`NETWORK_STATES`）：断网时任务进 `awaiting-network` 并**保存游标**，
 *    恢复后从游标继续，不从头再来、不重复已完成步骤。
 * 3. **持久层**（`TASK_STATES` + 账本）：进程被回收后，从手机账本**重放日志**重建任务视图，
 *    得到"从第几步继续 / 查原单 / 已结清"的恢复计划。
 *
 * 三个词表**不共用**：前台服务状态是运行期的、"网络等待"是外部依赖的、"reclaimed"
 * 是内核被系统回收的——合并会把"进程还在但网断了"误报成"进程死了"。
 */

// ---------------------------------------------------------------------------
// 进程 / 前台服务层
// ---------------------------------------------------------------------------

/** 前台服务成员状态（运行期，不持久化）。 */
export const FGS_STATES = ['registered', 'foreground', 'running', 'finished', 'cancelled', 'failed'] as const;
export type FgsState = (typeof FGS_STATES)[number];

/**
 * 任务可见性。`foreground-visible` = 用户可见的长任务（前台服务 + 常驻通知）；
 * `background-deferred` = 不抢占用户、交给系统调度器的延迟工作。
 */
export const TASK_VISIBILITIES = ['foreground-visible', 'background-deferred'] as const;
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];

export const NOTIFICATION_PERMISSIONS = ['granted', 'denied', 'not-determined'] as const;
export type NotificationPermission = (typeof NOTIFICATION_PERMISSIONS)[number];

export interface NotificationRequest {
  readonly notificationId: string;
  readonly title: string;
  readonly text: string;
  /** 长任务通知为 true（用户不能随手划掉，但**可以**在系统设置里强制停止）。 */
  readonly ongoing: boolean;
}

export interface NotificationHandle {
  readonly notificationId: string;
  readonly postedAt: number;
}

export interface NotificationPort {
  permission(): NotificationPermission;
  post(request: NotificationRequest, at: number): NotificationHandle;
  update(handle: NotificationHandle, patch: { readonly text: string }, at: number): void;
  stop(notificationId: string): void;
  /** 当前存活的通知数（测试用它证明"完成/取消后通知被撤掉，没有泄漏的常驻通知"）。 */
  activeCount(): number;
}

/** 只读时钟视图（结构上与 K07 `Clock` 兼容；此处自持类型避免跨包耦合）。 */
export interface Clock {
  /** 当前时间，整数、与所有 `*At` 字段同单位同原点。 */
  now(): number;
}

// ---------------------------------------------------------------------------
// 网络层
// ---------------------------------------------------------------------------

export const NETWORK_STATES = ['online', 'offline'] as const;
export type NetworkState = (typeof NETWORK_STATES)[number];

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  /** 至多尝试次数；达到即 `exhausted`，**不再无限等待**。 */
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  maxAttempts: 6,
});

// ---------------------------------------------------------------------------
// 持久任务账本层
// ---------------------------------------------------------------------------

/**
 * 持久任务状态。
 *
 * - `reclaimed`：进程被系统回收时该任务未结清——由 `observeReclaim` 写入。
 * - `unknown-external`：已发起外部副作用、未取回结果——**只能查原单**，不得重做。
 *   这是 K07 提交账本"结果未知"在后台任务层的镜像（同一纪律，不同对象）。
 */
export const TASK_STATES = [
  'registered',
  'running',
  'awaiting-network',
  'unknown-external',
  'completed',
  'failed',
  'cancelled',
  'reclaimed',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminalTaskState(state: TaskState): state is TerminalTaskState {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** 日志条目种类（账本只追加这些条目，视图由重放得出）。 */
export const JOURNAL_KINDS = [
  'task-registered',
  'run-started',
  'step-completed',
  'external-intent',
  'external-settled',
  'state-changed',
  'reclaim-observed',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** 日志载荷只允许 JSON 安全的标量/字符串数组（无嵌套对象 = 无夹带字段的空间）。 */
export type JournalValue = string | number | boolean | readonly string[];

export interface JournalEntry {
  readonly seq: number;
  readonly at: number;
  readonly kind: JournalKind;
  /** 归属任务；内核级事件（如 `reclaim-observed`）用保留 id `kernel`。 */
  readonly taskId: string;
  readonly detail: string;
  readonly data: Readonly<Record<string, JournalValue>>;
}

export const KERNEL_TASK_ID = 'kernel';

/** 由日志重放得出的任务视图（不可直接构造，只从 `TaskLedger` 读取）。 */
export interface TaskRecord {
  readonly taskId: string;
  readonly stepIds: readonly string[];
  readonly totalSteps: number;
  readonly completedSteps: readonly string[];
  /** 下一个待执行步骤的下标；全部完成时等于 `totalSteps`。 */
  readonly cursor: number;
  readonly state: TaskState;
  /** 已发起、未结清的外部副作用引用；无则为 null。 */
  readonly externalIntentRef: string | null;
  readonly externalObservedState: string | null;
  readonly failureReason: string | null;
  readonly updatedAt: number;
  readonly lastSeq: number;
}

/** 外部副作用是否**悬而未决**（已发起、未结清）。 */
export function isExternalPending(record: TaskRecord): boolean {
  return record.externalIntentRef !== null && record.externalObservedState === null;
}

// ---------------------------------------------------------------------------
// 恢复层
// ---------------------------------------------------------------------------

/**
 * 进程消失的方式。
 *
 * Android 的两种"死"性质完全不同，恢复策略必须分开：
 * - `reclaim`：系统因内存压力回收进程。系统**允许**我们下次启动时恢复续跑。
 * - `force-stop`：用户在设置里"强制停止"，或系统 force-stop。此后**系统不允许**自动复活，
 *   所有定时器/AlarmManager/前台服务都被清除。**不得承诺自动恢复**——只如实记录限制，
 *   等用户下次主动打开 App 再按账本重建。
 */
export const KILL_MODES = ['reclaim', 'force-stop'] as const;
export type KillMode = (typeof KILL_MODES)[number];

export const RECOVERY_ACTIONS = ['none', 'start', 'resume-from-cursor', 'query-external', 'finalize'] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export interface TaskRecoveryPlan {
  readonly taskId: string;
  readonly state: TaskState;
  readonly action: RecoveryAction;
  /** 从第几步继续；`none` / `query-external` 为 null。 */
  readonly resumeFromStep: number | null;
  readonly totalSteps: number;
  readonly externalPending: boolean;
  /** **恒为 false**：恢复入口在类型层面就不允许重跑已完成步骤。 */
  readonly mayRedoCompletedSteps: false;
  readonly detail: string;
}

export interface RecoveryPlan {
  readonly killMode: KillMode;
  /** 会从游标续跑的任务（按 taskId 字典序）。 */
  readonly resume: readonly string[];
  /** 需要查原单的任务。 */
  readonly queryExternal: readonly string[];
  /** 已结清、无需动作的任务。 */
  readonly settled: readonly string[];
  /** force-stop 下被系统限制、本进程**不自动复活**的任务。 */
  readonly blockedBySystem: readonly string[];
  readonly tasks: readonly TaskRecoveryPlan[];
}
