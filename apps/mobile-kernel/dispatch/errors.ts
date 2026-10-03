/**
 * K05 手机内核 · 主智能体派发 —— **错误类型与词表**（零依赖）。
 *
 * ## 两套词表，刻意分开
 *
 * 1. `DISPATCH_ERROR_CODES` —— **结构性 / 编程性失败**：拆分不成形、依赖成环、
 *    声明了固定规划/审核角色、并发上限非法。这些是宿主或调用方的缺陷，**大声抛错**，
 *    不静默降级成"跳过这一条"。
 * 2. `SUBTASK_BLOCK_REASONS` —— **单个子任务的调度阻塞**：能力没发现到、模板未授权、
 *    端口未就绪、上游依赖被阻塞 / 失败。这些**不是错误**：任务照常成形，只是该子任务
 *    被如实登记为 blocked 并**不进调度波次**（不假装它会被执行）。
 *
 * 把两套压成一套会让"计划里有条子任务被阻塞"和"调用方给了个非法并发数"混为一谈——
 * 前者是正常结果，后者必须拒绝。
 *
 * 契约来源：`docs/other/ds-six-lanes-2026-10-03/KERNEL.md` K05 行、README §5 命令/事件契约。
 * 零依赖：不 import `node:*`，不 import `src/**`（手机 APK 运行时须能独立加载本包）。
 */

// ---------------------------------------------------------------------------
// 结构性错误词表
// ---------------------------------------------------------------------------

/** 派发链路上**全部**可机读的结构性错误码。新增须同时在此登记（测试逐条对照）。 */
export const DISPATCH_ERROR_CODES = [
  /** 命令不成形（缺字段 / 类型不符 / 未知字段 / 非法操作）。 */
  'invalid_command',
  /** 拆分结构非法（空目标 / 空子任务 / 子任务缺字段）。 */
  'invalid_split',
  /** 同一拆分里出现重复的子任务 id。 */
  'duplicate_subtask_id',
  /** 依赖指向拆分里不存在的子任务 id。 */
  'unknown_dependency',
  /** 依赖关系成环（无法排出调度顺序）。 */
  'dependency_cycle',
  /**
   * 声明了**固定规划 / 审核角色**。K05 明确"无固定规划/审核角色"：拆分由主智能体自己
   * （唯一规划者）产出，不得在群里再立一个 `planner` / `reviewer` 席位。
   */
  'fixed_role_forbidden',
  /** 并发上限不是 ≥ 1 的整数（"无上限"不是本层的选项）。 */
  'invalid_concurrency',
  /** 运行期用未知 task_id 操作（未派发过的任务）。 */
  'task_not_found',
] as const;

export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[number];

/**
 * 出错时可指认的**字段 / 子任务**：拆分层用 `split.subtasks[i].depends_on` 这类路径，
 * 运行期用 `subtask_id`。无法指认时为 null。
 */
export type DispatchErrorField = string | null;

/**
 * K05 派发链路**唯一**的错误类型。所有结构性拒绝都抛它；
 * 验收按 `code` / `field` 断言（见 `tests/mobile-kernel/K05/`）。
 */
export class DispatchError extends Error {
  readonly code: DispatchErrorCode;
  readonly field: DispatchErrorField;

  constructor(code: DispatchErrorCode, detail: string, field: DispatchErrorField = null) {
    super(`[${code}]${field === null ? '' : `[${field}]`} ${detail}`);
    this.name = 'DispatchError';
    this.code = code;
    this.field = field;
  }
}

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isDispatchError(value: unknown): value is DispatchError {
  return (
    value instanceof DispatchError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (DISPATCH_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

// ---------------------------------------------------------------------------
// 子任务调度阻塞词表（不是错误）
// ---------------------------------------------------------------------------

/** 一个子任务**为什么没进调度波次**（如实登记，不静默丢弃）。 */
export const SUBTASK_BLOCK_REASONS = [
  /** 需求的能力根本没被主智能体发现到（没装 / 目录里没有）。 */
  'missing_capability',
  /** 能力对应的模板**未授权**——"不能调未授权模板"这条纪律的落点。 */
  'capability_not_authorized',
  /** 发现了且已授权，但端口未就绪 / 仍是 stub（不可执行）。 */
  'capability_not_executable',
  /** 上游依赖本身被阻塞（依赖链传播）。 */
  'dependency_blocked',
  /** 上游依赖在运行期失败（依赖链传播）。 */
  'dependency_failed',
] as const;

export type SubtaskBlockReason = (typeof SUBTASK_BLOCK_REASONS)[number];

/** 阻塞原因的中文标签（展示用；**不参与判定**）。 */
export const SUBTASK_BLOCK_LABELS: Readonly<Record<SubtaskBlockReason, string>> = Object.freeze({
  missing_capability: '缺能力（未发现）',
  capability_not_authorized: '模板未授权',
  capability_not_executable: '端口未就绪',
  dependency_blocked: '上游依赖被阻塞',
  dependency_failed: '上游依赖失败',
});

// ---------------------------------------------------------------------------
// 小工具（本包自用，不 import 别处的私有工具）
// ---------------------------------------------------------------------------

/** 非空字符串校验。`field` 用于错误定位。 */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DispatchError('invalid_command', `${field} 必须是非空字符串`, field);
  }
  return value;
}

/** 并发上限校验：必须是 ≥ 1 的整数（不提供"无上限"）。 */
export function requireConcurrency(value: unknown, field = 'max_parallel'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new DispatchError('invalid_concurrency', `${field} 必须是 ≥ 1 的整数（"无上限"不是本层的选项）`, field);
  }
  return value;
}
