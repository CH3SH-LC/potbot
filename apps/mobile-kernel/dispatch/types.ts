/**
 * K05 手机内核 · 主智能体派发 —— **词表、数据结构与端口**（零依赖、纯类型 + 纯函数）。
 *
 * ## 这一层解决什么
 *
 * 主智能体收到一个自然语言目标后，**自己**（唯一规划者）把目标拆成若干子任务、给每个
 * 子任务声明"需要哪种能力"，然后由本层：发现能力 → 建**临时群组** → 按**依赖**排调度 →
 * 受**并发上限**约束地运行 → 支持**取消**与**晚到结果**处置。
 *
 * ## 与既有内核件的边界（只读复用其语义，不 import）
 *
 * `src/scheduler/` 已有 `capability-registry`（五态能力发现）、`task-group-isolation`
 * （任务/群组/实例/轮次四层身份 + 临时群组释放）、`task-lifecycle`（暂停/取消/超时）、
 * `late-result-gate`（迟到结果门）、`work-queue`（队列与租约）。本包**不 import** 它们：
 *
 * 1. **架构要求**：README §3 明确规定正式 APK 路径不得回退电脑 Node；`apps/mobile-kernel/*`
 *    各包（K06/K07/K09 同例）都是**零依赖自包含**模块，才能在 arm64 运行时独立加载。
 *    `src/scheduler` 依赖 `src/storage` / `src/inbox` / `src/workledger` 等 node 侧设施，
 *    把它整体拖进手机运行时与本方案的迁移纪律冲突。
 * 2. **不重复语义**：本层把"能力发现 / 临时群组 / 依赖调度 / 取消 / 迟到结果"组合成
 *    一条**手机可运行的派发链**；五态词汇、七态生命周期等处**保持与上游同口径**（见下），
 *    差异只在于本层把"主智能体拆任务"这一步显式建模——上游没有这一层。
 *
 * ## 诚实的边界标注
 *
 * - 本包**纯函数 / 零 IO**：无 `node:fs`、无墙钟（时钟经注入）、无随机数（id 经注入）。
 * - 本包**不调用真实模型、不执行任何子任务**：它只产出**计划 / 调度 / 运行时快照**。
 *   "子任务真的产出了文件"属真实执行器证据，不在本层范围。
 * - `verificationMode` 一律为 `fixture`：本层的单测不签发任何真实回执。
 */

import type { SubtaskBlockReason } from './errors.js';

// ---------------------------------------------------------------------------
// 身份类型（结构上就是字符串；本包不品牌化，避免与上游 protocol 品牌类型冲突）
// ---------------------------------------------------------------------------

export type TaskId = string;
export type GroupId = string;
export type InstanceId = string;
export type SubtaskId = string;
export type CapabilityId = string;

// ---------------------------------------------------------------------------
// 子任务状态（**与上游同口径**：闭环七态里去掉"租约/唤醒"这层运行期细节）
// ---------------------------------------------------------------------------

/**
 * 子任务的六态。`blocked` 是**调度期**结论（进不了波次）；`cancelled` 由取消产生。
 * `succeeded` / `failed` / `cancelled` 为终态。
 */
export const SUBTASK_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type SubtaskState = (typeof SUBTASK_STATES)[number];

/** 终态：到达后不再被 `launchReady()` 选中，也不再被结果改状态。 */
export const TERMINAL_SUBTASK_STATES = ['succeeded', 'failed', 'cancelled'] as const;

export function isTerminalSubtaskState(state: SubtaskState): boolean {
  return (TERMINAL_SUBTASK_STATES as readonly string[]).includes(state);
}

export const SUBTASK_STATE_LABELS: Readonly<Record<SubtaskState, string>> = Object.freeze({
  pending: '待运行',
  running: '运行中',
  succeeded: '已成功',
  failed: '已失败',
  blocked: '已阻塞',
  cancelled: '已取消',
});

// ---------------------------------------------------------------------------
// 角色：**只有执行者**，没有固定规划 / 审核席位
// ---------------------------------------------------------------------------

/** 群内唯一的基础席位（主智能体拆分出的执行单元）。 */
export const EXECUTOR_ROLE = 'worker' as const;
export type ExecutorRole = typeof EXECUTOR_ROLE;

/**
 * **禁止**在群里声明的固定角色。K05 明确"无固定规划/审核角色"——拆分由主智能体自己
 * 完成，群里再立一个规划 / 审核席位既不必要，也会把串行瓶颈写进拓扑。
 */
export const FORBIDDEN_FIXED_ROLES = ['planner', 'reviewer', 'orchestrator', 'supervisor'] as const;
export type ForbiddenFixedRole = (typeof FORBIDDEN_FIXED_ROLES)[number];

export function isForbiddenFixedRole(role: string): role is ForbiddenFixedRole {
  return (FORBIDDEN_FIXED_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// 时钟（确定性；不读墙钟）
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
}

export interface ManualClock extends Clock {
  set(value: number): void;
  advance(delta: number): void;
}

/** 确定性时钟：测试与夹具用，**不读墙钟**。 */
export function createManualClock(start: number): ManualClock {
  let current = start;
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    advance(delta: number) {
      current += delta;
    },
  };
}

// ---------------------------------------------------------------------------
// 能力发现（主智能体侧）
// ---------------------------------------------------------------------------

/**
 * 主智能体**发现到的**一项能力。四态里与派发相关的两个布尔：
 * `authorized`（模板是否已授权）与 `executable`（端口是否真的就绪 / 非 stub）。
 *
 * 未发现 ⇒ 不在这个列表里（`missing_capability`）。发现到但 `authorized === false`
 * ⇒ 该能力**不可调度**（"不能调未授权模板"）。
 */
export interface DiscoveredCapability {
  readonly capability_id: CapabilityId;
  /** 承载该能力的模板 id（发现到才有）。 */
  readonly template_id: string;
  readonly authorized: boolean;
  readonly executable: boolean;
  /** 如实记录为何不可用（可空）。 */
  readonly note?: string;
}

/** 能力发现端口。手机侧由模板平台（K06）的探针结果供应。 */
export interface CapabilityDiscoveryPort {
  discover(): readonly DiscoveredCapability[];
}

/** 一个静态能力目录（测试 / 夹具用；**不是**真机探针）。 */
export function createStaticDiscovery(
  capabilities: readonly DiscoveredCapability[],
): CapabilityDiscoveryPort {
  const snapshot = Object.freeze(capabilities.map((capability) => Object.freeze({ ...capability })));
  return { discover: () => snapshot };
}

// ---------------------------------------------------------------------------
// 拆分（主智能体产出）
// ---------------------------------------------------------------------------

/** 主智能体拆分出的**一条子任务规格**。 */
export interface SubtaskSpec {
  readonly id: SubtaskId;
  /** 该子任务要做的事（自然语言；本层不解析）。 */
  readonly goal: string;
  /** 该子任务**需要的能力**。发现不到 / 未授权 ⇒ 阻塞，不进调度。 */
  readonly capability_id: CapabilityId;
  /** 必须**先成功**的前置子任务 id。 */
  readonly depends_on: readonly string[];
  /**
   * 可选角色。合法值只有 `'worker'`；声明固定规划 / 审核角色 ⇒ `fixed_role_forbidden`。
   * 省略时视为 `'worker'`。
   */
  readonly role?: string;
}

/** 主智能体一次拆分的完整产出。 */
export interface TaskSplit {
  readonly goal: string;
  readonly subtasks: readonly SubtaskSpec[];
}

// ---------------------------------------------------------------------------
// 计划产物（发现 + 拆分 + 群组 + 调度）
// ---------------------------------------------------------------------------

/** 一条**可调度**子任务（能力已发现、已授权、可执行、依赖未阻塞）。 */
export interface SubtaskPlan {
  readonly id: SubtaskId;
  readonly goal: string;
  readonly capability_id: CapabilityId;
  readonly template_id: string;
  readonly depends_on: readonly string[];
  readonly role: ExecutorRole;
}

/** 一条**被阻塞**子任务（如实登记五态里的缺项，不进波次）。 */
export interface BlockedSubtaskPlan {
  readonly id: SubtaskId;
  readonly goal: string;
  readonly capability_id: CapabilityId;
  /** 发现到能力时才有模板 id；缺失时为 null。 */
  readonly template_id: string | null;
  readonly depends_on: readonly string[];
  readonly block_reason: SubtaskBlockReason;
  readonly block_detail: string;
  /** 直接导致阻塞的引用（能力 id 或上游子任务 id），便于逐项核对。 */
  readonly blocked_by: readonly string[];
}

/** 一个调度波次（同一波内互不依赖；波次之间严格有序）。 */
export interface ScheduleWave {
  readonly wave: number;
  readonly subtask_ids: readonly SubtaskId[];
}

/**
 * 依赖调度结果。
 *
 * 不变量：`waves` 里每个子任务恰好出现一次；同一波内 ≤ `max_parallel`；
 * 任一波内子任务的依赖都在**更早**的波里（拓扑序）；`blocked_ids` 与波次不相交。
 */
export interface DispatchSchedule {
  readonly max_parallel: number;
  readonly waves: readonly ScheduleWave[];
  readonly scheduled_ids: readonly SubtaskId[];
  readonly blocked_ids: readonly SubtaskId[];
  readonly digest: string;
}

/** 临时群组里的一名成员（一名成员 = 一条子任务的执行席位）。 */
export interface GroupMember {
  readonly instance_id: InstanceId;
  readonly subtask_id: SubtaskId;
  readonly capability_id: CapabilityId;
  readonly role: ExecutorRole;
}

/**
 * **临时**群组：任务级容器。任务终态后可释放（`released === true`），
 * 但群组历史 / 任务记录**保留**（对照 `src/scheduler/task-group-isolation.ts` 的不变量 4）。
 */
export interface TemporaryGroup {
  readonly group_id: GroupId;
  readonly task_id: TaskId;
  readonly created_at: number;
  readonly members: readonly GroupMember[];
  readonly released: boolean;
  readonly released_at: number | null;
}

/** 一次派发的完整计划（`plan` 操作的输出）。 */
export interface DispatchPlan {
  readonly task_id: TaskId;
  readonly goal: string;
  readonly group: TemporaryGroup;
  readonly schedule: DispatchSchedule;
  readonly subtasks: readonly SubtaskPlan[];
  readonly blocked: readonly BlockedSubtaskPlan[];
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// 运行期（并发运行 / 取消 / 晚到结果）
// ---------------------------------------------------------------------------

/** 运行时里一条子任务的状态快照。 */
export interface SubtaskRuntime {
  readonly id: SubtaskId;
  readonly capability_id: CapabilityId;
  readonly template_id: string | null;
  readonly depends_on: readonly string[];
  readonly role: ExecutorRole;
  readonly state: SubtaskState;
  /** 已启动次数（当前最多 1；留字段给未来重试，不静默重试）。 */
  readonly attempt: number;
  readonly block_reason: SubtaskBlockReason | null;
}

/** 一次派发的运行时快照（不可变；每次状态迁移产生新快照）。 */
export interface DispatchRuntimeSnapshot {
  readonly task_id: TaskId;
  readonly goal: string;
  readonly group_id: GroupId;
  readonly max_parallel: number;
  readonly cancelled: boolean;
  readonly cancel_reason: string | null;
  readonly subtasks: readonly SubtaskRuntime[];
  readonly running_ids: readonly SubtaskId[];
  /** 到达终态 / 被阻塞的子任务 id。 */
  readonly settled_ids: readonly SubtaskId[];
  /** 快照修订号（每次迁移 +1）。 */
  readonly revision: number;
}

/**
 * 一条**结果到达**的处置结论。
 *
 * - `accepted`：结果被接受（子任务转 succeeded/failed）。
 * - `late_after_cancel`：任务已取消后到达的**迟到结果**——如实记录但**不得**把子任务
 *   变回 succeeded（K05 的核心纪律之一）。
 * - `duplicate`：子任务已在终态，重复结果幂等忽略（不重复产生副作用）。
 * - `blocked`：子任务被阻塞，不接受结果。
 * - `not_running`：子任务还没被启动（`pending`），此时无在途执行，结果无从谈起。
 * - `unknown_subtask`：结果指向拆分里不存在的子任务。
 */
export const RESULT_VERDICTS = [
  'accepted',
  'late_after_cancel',
  'duplicate',
  'blocked',
  'not_running',
  'unknown_subtask',
] as const;
export type ResultVerdict = (typeof RESULT_VERDICTS)[number];

/** 结果处置结论 + 处置后的子任务状态（供验收逐条断言）。 */
export interface ResultDecision {
  readonly subtask_id: SubtaskId;
  readonly verdict: ResultVerdict;
  readonly accepted: boolean;
  /** 处置后该子任务的状态（`unknown_subtask` 时为 null）。 */
  readonly state: SubtaskState | null;
  readonly detail: string;
}

/** 一条被门掉的迟到结果（如实保留，不静默丢弃）。 */
export interface LateResultRecord {
  readonly subtask_id: SubtaskId;
  readonly outcome: 'succeeded' | 'failed';
  readonly arrived_at: number;
  readonly reason: string;
}

/** 取消结论。 */
export interface CancelReport {
  readonly task_id: TaskId;
  readonly cancelled: boolean;
  /** 已取消（此前就已是终态、未被本次取消触碰）时为 false，并在 detail 里说明。 */
  readonly reason: string;
  readonly cancelled_ids: readonly SubtaskId[];
  /** 取消时**正在运行**的子任务 id（其晚到结果必须被门掉）。 */
  readonly was_running_ids: readonly SubtaskId[];
  readonly already_terminal_ids: readonly SubtaskId[];
  readonly at: number;
}

/** 群组释放结论。 */
export interface GroupReleaseReport {
  readonly group_id: GroupId;
  readonly released: boolean;
  readonly released_at: number | null;
  readonly detail: string;
}
