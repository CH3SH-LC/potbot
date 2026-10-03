/** K10 生命周期错误词表（零依赖）。拒因**机读可辨**，不合并成一句"失败了"。 */

export const LIFECYCLE_ERROR_CODES = [
  // --- 前台服务 / 通知 ---
  /** 长任务未声明为前台可见却想当后台常驻：必须走前台服务或系统调度。 */
  'long_task_requires_foreground',
  /** 通知权限未授予：不得靠"无通知的常驻"绕过（fail-closed）。 */
  'notification_permission_denied',
  /** 任务未被提升到前台就被要求运行。 */
  'task_not_foreground',
  /** 通知标题/正文命中明文密钥。 */
  'notification_secret_detected',
  /** 任务 id 重复登记。 */
  'duplicate_task',
  /** 台账里没有这个任务。 */
  'unknown_task',
  // --- 常驻预算 ---
  /** 常驻时长超出预算：本模块不承诺无限常驻，到点停并如实上报。 */
  'resident_budget_exhausted',
  // --- 网络恢复 ---
  /** 网络不可用。 */
  'network_unreachable',
  /** 重试次数耗尽：如实报失败，不静默挂起。 */
  'retry_exhausted',
  // --- 账本 / 恢复 ---
  /** 快照无法解析：**拒绝当空库**继续。 */
  'invalid_snapshot',
  /** 重复完成同一步骤（"不得重跑已完成步骤"的落地判据）。 */
  'duplicate_step',
  /** 完成了一个不在任务步骤表里的步骤。 */
  'unknown_step',
  /** 非法状态迁移。 */
  'illegal_transition',
] as const;
export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number];

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}
