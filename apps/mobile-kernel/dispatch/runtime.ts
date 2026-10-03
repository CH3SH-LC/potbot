/**
 * K05 手机内核 · 主智能体派发 —— **运行期**：并发启动、取消、晚到结果门。
 *
 * 消费一份 `DispatchPlan`，维护子任务状态机：
 *
 * ```text
 * pending ──launchReady()──▶ running ──applyResult('succeeded')──▶ succeeded
 *                                   └─applyResult('failed')─────▶ failed ─┐
 * blocked（计划期已阻塞 / 上游失败 / 上游阻塞传播）                        │
 *                   任何非终态 ──cancel()──▶ cancelled                   │
 *                   失败子任务的下游 ─────▶ blocked(dependency_failed) ◀──┘
 * ```
 *
 * ## 三条被冻结的不变量（各有独立负例测试）
 *
 * 1. **并发上限**：`snapshot().running_ids.length ≤ max_parallel` 恒成立；
 *    `launchReady()` 永不超发。
 * 2. **取消后迟到结果不得变成功**：任务取消后到达的结果一律判 `late_after_cancel`，
 *    子任务状态**保持 cancelled**，如实记入 `lateResults()`，**绝不翻回 succeeded**。
 * 3. **已终态幂等**：对已 succeeded/failed 的子任务重复到达结果判 `duplicate`，
 *    状态不变（不重复产生副作用）。
 *
 * 纯函数语义（内部可变、对外只出不可变快照）；时钟经注入；无墙钟、无随机、无 IO。
 * **不执行真实子任务**——结果由调用方经 `applyResult()` 送入。
 */

import { requireConcurrency, requireNonEmptyString, type SubtaskBlockReason } from './errors.js';
import type {
  CancelReport,
  Clock,
  DispatchPlan,
  DispatchRuntimeSnapshot,
  GroupReleaseReport,
  LateResultRecord,
  ResultDecision,
  ResultVerdict,
  SubtaskId,
  SubtaskRuntime,
  SubtaskState,
} from './types.js';
import { isTerminalSubtaskState } from './types.js';

export interface DispatchRuntimeDeps {
  readonly clock: Clock;
}

interface SubtaskMeta {
  readonly id: SubtaskId;
  readonly capability_id: string;
  readonly template_id: string | null;
  readonly depends_on: readonly string[];
  readonly role: 'worker';
}

interface SubtaskCell {
  state: SubtaskState;
  attempt: number;
  block_reason: SubtaskBlockReason | null;
}

export interface DispatchRuntime {
  /** 启动所有"依赖已成功且有空闲并发位"的 pending 子任务；返回本次启动的 id（升序）。 */
  launchReady(): readonly SubtaskId[];
  /** 送入一条结果（可能迟到）。返回处置结论。 */
  applyResult(subtaskId: SubtaskId, outcome: 'succeeded' | 'failed'): ResultDecision;
  /** 取消任务：所有非终态子任务转 cancelled，运行中的记入 `was_running`。 */
  cancel(reason: string): CancelReport;
  /** 任务终态后释放临时群组（任务记录保留）。 */
  releaseGroup(): GroupReleaseReport;
  /** 当前不可变快照。 */
  snapshot(): DispatchRuntimeSnapshot;
  /** 被门掉的迟到结果（如实保留）。 */
  lateResults(): readonly LateResultRecord[];
  /** 任务是否已达终态（取消或全部子任务终态）。 */
  isTerminal(): boolean;
  /**
   * 把一条结果处置翻译成共享调度器口径（唯一发布词表，见文件末"口径对齐"段）。
   * 等价于 `resolveResultDisposition(decision, this.snapshot())`。
   */
  align(decision: ResultDecision): ResolvedResultDisposition;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createDispatchRuntime(plan: DispatchPlan, deps: DispatchRuntimeDeps): DispatchRuntime {
  const maxParallel = requireConcurrency(plan.schedule.max_parallel);
  const meta = new Map<SubtaskId, SubtaskMeta>();
  const cells = new Map<SubtaskId, SubtaskCell>();

  for (const spec of plan.subtasks) {
    meta.set(spec.id, {
      id: spec.id,
      capability_id: spec.capability_id,
      template_id: spec.template_id,
      depends_on: spec.depends_on,
      role: spec.role,
    });
    cells.set(spec.id, { state: 'pending', attempt: 0, block_reason: null });
  }
  for (const blocked of plan.blocked) {
    meta.set(blocked.id, {
      id: blocked.id,
      capability_id: blocked.capability_id,
      template_id: blocked.template_id,
      depends_on: blocked.depends_on,
      role: 'worker',
    });
    cells.set(blocked.id, { state: 'blocked', attempt: 0, block_reason: blocked.block_reason });
  }

  let cancelled = false;
  let cancelReason: string | null = null;
  const lateResults: LateResultRecord[] = [];
  let revision = 0;

  const sortedIds = [...cells.keys()].sort(compareIds);

  function subTasksSnapshot(): readonly SubtaskRuntime[] {
    return Object.freeze(
      sortedIds.map((id) => {
        const cell = cells.get(id) as SubtaskCell;
        const info = meta.get(id) as SubtaskMeta;
        return Object.freeze({
          id,
          capability_id: info.capability_id,
          template_id: info.template_id,
          depends_on: info.depends_on,
          role: info.role,
          state: cell.state,
          attempt: cell.attempt,
          block_reason: cell.block_reason,
        });
      }),
    );
  }

  function snapshot(): DispatchRuntimeSnapshot {
    const subtasks = subTasksSnapshot();
    const runningIds = subtasks.filter((entry) => entry.state === 'running').map((entry) => entry.id);
    const settledIds = subtasks
      .filter((entry) => isTerminalSubtaskState(entry.state) || entry.state === 'blocked')
      .map((entry) => entry.id);
    return Object.freeze({
      task_id: plan.task_id,
      goal: plan.goal,
      group_id: plan.group.group_id,
      max_parallel: maxParallel,
      cancelled,
      cancel_reason: cancelReason,
      subtasks,
      running_ids: Object.freeze(runningIds),
      settled_ids: Object.freeze(settledIds),
      revision,
    });
  }

  /** 上游失败 ⇒ 下游 pending 转 blocked(dependency_failed) 并向上游继续传播。 */
  function propagateFailure(failedId: SubtaskId): void {
    const newlyBlocked = new Set<string>([failedId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of sortedIds) {
        const cell = cells.get(id) as SubtaskCell;
        if (cell.state !== 'pending') {
          continue;
        }
        const info = meta.get(id) as SubtaskMeta;
        const blocker = info.depends_on.find((dependency) => newlyBlocked.has(dependency));
        if (blocker !== undefined) {
          cell.state = 'blocked';
          cell.block_reason = 'dependency_failed';
          newlyBlocked.add(id);
          changed = true;
        }
      }
    }
  }

  function depsSucceeded(id: SubtaskId): boolean {
    const info = meta.get(id) as SubtaskMeta;
    return info.depends_on.every((dependency) => cells.get(dependency)?.state === 'succeeded');
  }

  function runningCount(): number {
    let count = 0;
    for (const cell of cells.values()) {
      if (cell.state === 'running') {
        count += 1;
      }
    }
    return count;
  }

  function launchReady(): readonly SubtaskId[] {
    if (cancelled) {
      return Object.freeze([]);
    }
    const slots = maxParallel - runningCount();
    if (slots <= 0) {
      return Object.freeze([]);
    }
    const ready = sortedIds.filter((id) => {
      const cell = cells.get(id) as SubtaskCell;
      return cell.state === 'pending' && depsSucceeded(id);
    });
    const launched = ready.slice(0, slots);
    for (const id of launched) {
      const cell = cells.get(id) as SubtaskCell;
      cell.state = 'running';
      cell.attempt += 1;
    }
    if (launched.length > 0) {
      revision += 1;
    }
    return Object.freeze(launched);
  }

  function applyResult(subtaskId: SubtaskId, outcome: 'succeeded' | 'failed'): ResultDecision {
    const cell = cells.get(subtaskId);
    if (cell === undefined) {
      return Object.freeze({
        subtask_id: subtaskId,
        verdict: 'unknown_subtask' as const,
        accepted: false,
        state: null,
        detail: `拆分里不存在子任务 ${subtaskId}，结果无处归属`,
      });
    }

    // 已终态：幂等忽略（含任务取消后仍在终态的既有成功/失败）。
    if (isTerminalSubtaskState(cell.state)) {
      if (cancelled && cell.state === 'cancelled') {
        lateResults.push({
          subtask_id: subtaskId,
          outcome,
          arrived_at: deps.clock.now(),
          reason: `任务已取消（${cancelReason ?? '未具名'}）：迟到结果不得翻转为成功`,
        });
        revision += 1;
        return Object.freeze({
          subtask_id: subtaskId,
          verdict: 'late_after_cancel' as const,
          accepted: false,
          state: cell.state,
          detail: '任务已取消：迟到结果如实记录，子任务保持 cancelled，不变成功',
        });
      }
      return Object.freeze({
        subtask_id: subtaskId,
        verdict: 'duplicate' as const,
        accepted: false,
        state: cell.state,
        detail: `子任务已是终态 ${cell.state}：重复结果幂等忽略`,
      });
    }

    if (cancelled) {
      // 任务已取消，但该子任务本应是 cancelled；防御性兜底也按迟到处理。
      lateResults.push({
        subtask_id: subtaskId,
        outcome,
        arrived_at: deps.clock.now(),
        reason: '任务已取消：迟到结果不得翻转为成功',
      });
      revision += 1;
      return Object.freeze({
        subtask_id: subtaskId,
        verdict: 'late_after_cancel' as const,
        accepted: false,
        state: cell.state,
        detail: '任务已取消：迟到结果如实记录，子任务状态不变',
      });
    }

    if (cell.state === 'blocked') {
      return Object.freeze({
        subtask_id: subtaskId,
        verdict: 'blocked' as const,
        accepted: false,
        state: cell.state,
        detail: `子任务被阻塞（${cell.block_reason ?? '未知'}）：不接受结果`,
      });
    }

    if (cell.state === 'pending') {
      return Object.freeze({
        subtask_id: subtaskId,
        verdict: 'not_running' as const,
        accepted: false,
        state: cell.state,
        detail: '子任务尚未启动（pending），此时无在途执行，结果无从谈起',
      });
    }

    // state === 'running'
    if (outcome === 'succeeded') {
      cell.state = 'succeeded';
      revision += 1;
      return Object.freeze({
        subtask_id: subtaskId,
        verdict: 'accepted' as const,
        accepted: true,
        state: cell.state,
        detail: '结果接受：子任务成功',
      });
    }
    cell.state = 'failed';
    revision += 1;
    propagateFailure(subtaskId);
    return Object.freeze({
      subtask_id: subtaskId,
      verdict: 'accepted' as const,
      accepted: true,
      state: cell.state,
      detail: '结果接受：子任务失败，其下游转 blocked(dependency_failed)',
    });
  }

  function cancel(reason: string): CancelReport {
    const safeReason = requireNonEmptyString(reason, 'cancel.reason');
    const at = deps.clock.now();
    if (cancelled) {
      return Object.freeze({
        task_id: plan.task_id,
        cancelled: false,
        reason: safeReason,
        cancelled_ids: Object.freeze([]),
        was_running_ids: Object.freeze([]),
        already_terminal_ids: Object.freeze([]),
        at,
      });
    }
    cancelled = true;
    cancelReason = safeReason;
    const cancelledIds: string[] = [];
    const wasRunning: string[] = [];
    const alreadyTerminal: string[] = [];
    for (const id of sortedIds) {
      const cell = cells.get(id) as SubtaskCell;
      if (isTerminalSubtaskState(cell.state)) {
        alreadyTerminal.push(id);
        continue;
      }
      if (cell.state === 'running') {
        wasRunning.push(id);
      }
      cell.state = 'cancelled';
      cancelledIds.push(id);
    }
    revision += 1;
    return Object.freeze({
      task_id: plan.task_id,
      cancelled: true,
      reason: safeReason,
      cancelled_ids: Object.freeze(cancelledIds),
      was_running_ids: Object.freeze(wasRunning),
      already_terminal_ids: Object.freeze(alreadyTerminal),
      at,
    });
  }

  function isTerminalInternal(): boolean {
    if (cancelled) {
      return true;
    }
    for (const cell of cells.values()) {
      if (!isTerminalSubtaskState(cell.state) && cell.state !== 'blocked') {
        return false;
      }
    }
    return true;
  }

  function releaseGroup(): GroupReleaseReport {
    const at = deps.clock.now();
    if (!isTerminalInternal()) {
      return Object.freeze({
        group_id: plan.group.group_id,
        released: false,
        released_at: null,
        detail: '任务尚未终态（仍有 pending/running 子任务）：临时群组不得提前释放',
      });
    }
    return Object.freeze({
      group_id: plan.group.group_id,
      released: true,
      released_at: at,
      detail: '临时群组已释放；任务记录与证据引用保留（对照 task-group-isolation 不变量 4）',
    });
  }

  return {
    launchReady,
    applyResult,
    cancel,
    releaseGroup,
    snapshot,
    lateResults: () => Object.freeze([...lateResults]),
    isTerminal: isTerminalInternal,
    align: (decision) => resolveResultDisposition(decision, snapshot()),
  };
}

/** 结果处置结论的守卫（供测试与调用方断言，不是空壳）。 */
export function isAccepted(decision: ResultDecision): boolean {
  return decision.accepted && decision.verdict === ('accepted' satisfies ResultVerdict);
}

/** 便于外部在未建运行时前就校验并发上限。 */
export function assertConcurrency(value: unknown): number {
  return requireConcurrency(value);
}

// ---------------------------------------------------------------------------
// 与共享调度器（`src/scheduler`）的口径对齐 —— **唯一发布**的处置词表 + 显式映射表
// ---------------------------------------------------------------------------

/**
 * ## 为什么在这里对齐，而不是 import 共享实现
 *
 * `src/scheduler/late-result-gate.ts` 与 `src/scheduler/task-lifecycle.ts` 是电脑侧迟到判定的
 * **唯一实现**（见其文件头"复用纪律"）。但手机内核包（本包，及 K06/K07/K09）**零依赖自包含、
 * 不 import `src/**`**：`src/scheduler` 依赖 `src/storage` / `src/inbox` / `src/workledger` 等
 * node 侧设施，整体拖进 arm64 运行时会与迁移纪律冲突（见本包 `types.ts` 头注）。
 *
 * 于是两侧各持一套词表，K05 此前只发布了自己的六态 `ResultVerdict`，与共享侧
 * `GATE_DECISIONS`（`publish`/`late`/`unknown`）与 `LATE_RESULT_REASONS` 只在语义上"心照不宣"。
 * 本段把两者**逐项钉成一张显式映射表**，并以**归一化处置**作为唯一发布口径：
 *
 * - 共享侧闸门决定：{@link SCHEDULER_GATE_DECISIONS}（镜像 `late-result-gate.ts` 的 `GATE_DECISIONS`）；
 * - 共享侧迟到原因：{@link SCHEDULER_LATE_RESULT_REASONS}（镜像 `task-lifecycle.ts` 的 `LATE_RESULT_REASONS`）；
 * - 归一化处置：{@link CANONICAL_RESULT_DISPOSITIONS}；
 * - 逐 verdict 映射：{@link RESULT_VERDICT_ALIGNMENT}（`ResultVerdict` → 上面三者）。
 *
 * **镜像 ≠ 复制实现**：本段只有 `as const` 字面量与一张表，**不含任何判定逻辑**——真正的判定
 * 仍由 `applyResult()` 完成，判定后经 {@link resolveResultDisposition} / `runtime.align()` 翻译成
 * 共享口径。镜像的字面量由 `tests/mobile-kernel/K-I17` 导入**真实源文件常量**逐项深比较钉住，
 * 两侧一旦分叉测试立即失败。
 *
 * ## 两侧词表的真实差异（如实登记，不粉饰）
 *
 * 1. **`duplicate` 是子任务本地口径**：共享闸门是**任务级**的（结果到达时按任务状态判定），
 *    而 K05 的 `duplicate` 是**子任务级**幂等（同一子任务已终态、不重复产生副作用）。两者都
 *    归 `late`（"不得成为当前成功"），但共享侧原因随任务状态而变：任务已取消 ⇒
 *    `task_cancelled`；任务仍在跑（其它子任务未终态）⇒ **共享侧无对应原因**（`null`）——
 *    因为该重复对应的子任务在共享模型里从来不是一个"任务级结果"。见
 *    {@link schedulerLateReasonForDuplicate}。
 * 2. **`unknown` 处置共享侧独有**：本包 `applyResult()` 只接受 `succeeded`/`failed`
 *    （`schema.ts` 的 `RESULT_OUTCOMES`），**没有**共享侧 `unknown` 结局的入口，故没有任何
 *    `ResultVerdict` 映射到 `disposition: 'unknown'`。这是**已知缺口**（结果未知时不盲目重试
 *    R246 的语义尚未落到手机派发运行时），登记在案而非假称已对齐。
 * 3. **`rejected` 是手机侧独有**：`blocked` / `not_running` / `unknown_subtask` 三条都被
 *    **闸门之前**拒掉（结果根本没有可归属的、正在运行的目标），共享闸门没有对应决定，故
 *    `scheduler_decision: null`。
 */

/**
 * 共享侧闸门决定词表（**只读镜像**，键与取值须与 `src/scheduler/late-result-gate.ts` 的
 * `GATE_DECISIONS` **逐项相等**，由 K-I17 对真实源文件断言）。
 */
export const SCHEDULER_GATE_DECISIONS = ['publish', 'late', 'unknown'] as const;
export type SchedulerGateDecision = (typeof SCHEDULER_GATE_DECISIONS)[number];

/**
 * 共享侧迟到原因词表（**只读镜像**，须与 `src/scheduler/task-lifecycle.ts` 的
 * `LATE_RESULT_REASONS` **逐项相等**，由 K-I17 对真实源文件断言）。
 */
export const SCHEDULER_LATE_RESULT_REASONS = [
  'task_cancelled',
  'task_timed_out',
  'task_failed',
  'task_paused',
  'stale_task_revision',
] as const;
export type SchedulerLateResultReason = (typeof SCHEDULER_LATE_RESULT_REASONS)[number];

/**
 * **归一化处置**：两侧词表合成后的唯一发布口径。
 *
 * - `published`：结果被当作当前成功（共享侧 `publish` / 本侧 `accepted`）；
 * - `late`：迟到，不得成为当前成功（共享侧 `late`；本侧 `late_after_cancel`、`duplicate`）；
 * - `unknown`：结果未知，不盲目重试（共享侧 `unknown`）——**本侧暂无入口**，见段首差异 2；
 * - `rejected`：到达闸门**之前**即被拒（本侧 `blocked`/`not_running`/`unknown_subtask`）。
 */
export const CANONICAL_RESULT_DISPOSITIONS = ['published', 'late', 'unknown', 'rejected'] as const;
export type CanonicalResultDisposition = (typeof CANONICAL_RESULT_DISPOSITIONS)[number];

/**
 * 归一化处置 ↔ 共享闸门决定的**词表级**映射（逐 verdict 细节见 {@link RESULT_VERDICT_ALIGNMENT}）。
 *
 * `rejected` 映射为 `null`：该处置发生在闸门之前，共享侧（任务级闸门）无对应决定。
 */
export const DISPOSITION_TO_SCHEDULER_DECISION: Readonly<
  Record<CanonicalResultDisposition, SchedulerGateDecision | null>
> = Object.freeze({
  published: 'publish',
  late: 'late',
  unknown: 'unknown',
  rejected: null,
});

/** 一条 `ResultVerdict` 的口径对齐（唯一发布词表的一行）。 */
export interface ResultVerdictAlignment {
  readonly verdict: ResultVerdict;
  /** 归一化处置（唯一发布口径）。 */
  readonly disposition: CanonicalResultDisposition;
  /**
   * 共享侧闸门决定；`null` 表示该处置发生在闸门之前（`rejected`），共享侧无对应决定。
   */
  readonly scheduler_decision: SchedulerGateDecision | null;
  /**
   * 共享侧迟到原因。
   *
   * 静态值仅在原因**与任务状态无关**时给出；`duplicate` 的原因随任务状态而变，此处为 `null`，
   * 运行期由 {@link schedulerLateReasonForDuplicate} 解析（见段首差异 1）。
   */
  readonly scheduler_late_reason: SchedulerLateResultReason | null;
  /** 是否被当作当前成功（与共享侧 `publish === true` 同义）。 */
  readonly honored_as_success: boolean;
  /** 处置观测层级：任务闸门级 / 子任务本地级。 */
  readonly observed_at: 'task_gate' | 'subtask_local';
  readonly note: string;
}

/**
 * **显式映射表**（本单元的唯一交付物核心）：`ResultVerdict` → 共享调度器口径。
 *
 * 覆盖 **全部六个** `ResultVerdict`（由 `RESULT_VERDICTS` 定义），无遗漏、无多余；缺失或
 * 多出的键由 K-I17 的完备性断言捕获。
 */
export const RESULT_VERDICT_ALIGNMENT: Readonly<Record<ResultVerdict, ResultVerdictAlignment>> = Object.freeze({
  accepted: Object.freeze({
    verdict: 'accepted',
    disposition: 'published',
    scheduler_decision: 'publish',
    scheduler_late_reason: null,
    honored_as_success: true,
    observed_at: 'task_gate',
    note: '正常到达：结果被接受并发布为当前成功（共享侧 publish；单轮发布 ≠ 任务完成，R213）',
  }),
  late_after_cancel: Object.freeze({
    verdict: 'late_after_cancel',
    disposition: 'late',
    scheduler_decision: 'late',
    scheduler_late_reason: 'task_cancelled',
    honored_as_success: false,
    observed_at: 'task_gate',
    note: '任务取消后到达的迟到结果：如实记录、状态保持 cancelled、绝不翻回 succeeded（共享侧 late / task_cancelled）',
  }),
  duplicate: Object.freeze({
    verdict: 'duplicate',
    disposition: 'late',
    scheduler_decision: 'late',
    scheduler_late_reason: null,
    honored_as_success: false,
    observed_at: 'subtask_local',
    note:
      '子任务已终态，重复结果幂等忽略（不重复产生副作用）。共享侧是同义的 late（不得成为当前成功）；' +
      '原因随任务状态而定，见 schedulerLateReasonForDuplicate()：任务已取消 ⇒ task_cancelled，任务仍在跑 ⇒ null',
  }),
  blocked: Object.freeze({
    verdict: 'blocked',
    disposition: 'rejected',
    scheduler_decision: null,
    scheduler_late_reason: null,
    honored_as_success: false,
    observed_at: 'subtask_local',
    note: '子任务被阻塞，结果到达闸门之前即被拒（共享任务级闸门无对应决定）',
  }),
  not_running: Object.freeze({
    verdict: 'not_running',
    disposition: 'rejected',
    scheduler_decision: null,
    scheduler_late_reason: null,
    honored_as_success: false,
    observed_at: 'subtask_local',
    note: '子任务尚未启动（pending），无在途执行，结果到达闸门之前即被拒（共享无对应决定）',
  }),
  unknown_subtask: Object.freeze({
    verdict: 'unknown_subtask',
    disposition: 'rejected',
    scheduler_decision: null,
    scheduler_late_reason: null,
    honored_as_success: false,
    observed_at: 'subtask_local',
    note: '结果指向拆分里不存在的子任务，无处归属，在闸门之前即被拒（共享无对应决定）',
  }),
});

/**
 * `duplicate` 的共享侧迟到原因：随**任务级**状态而定。
 *
 * - 任务已取消（含"某子任务先成功、随后取消、再收到重复结果"）⇒ `task_cancelled`，与
 *   `late_after_cancel` 同因；
 * - 任务仍在运行（同一子任务重复结果、其它子任务未终态）⇒ 返回 `null`：该重复对应的子任务
 *   在共享模型里从来不是一个"任务级结果"，共享闸门无此原因（见段首差异 1）。
 *
 * 本包运行时不建模任务级 `timed_out`/`failed`/`paused`（只有 `cancelled` 布尔），故这里只可能
 * 产出 `task_cancelled` 或 `null`，其余原因留给共享侧任务级模型。
 */
export function schedulerLateReasonForDuplicate(
  snapshot: Pick<DispatchRuntimeSnapshot, 'cancelled'>,
): SchedulerLateResultReason | null {
  return snapshot.cancelled ? 'task_cancelled' : null;
}

/** 结果处置的**已解析**共享口径（`duplicate` 的迟到原因已按任务状态定下）。 */
export interface ResolvedResultDisposition extends Omit<ResultVerdictAlignment, 'scheduler_late_reason'> {
  /** 解析后的迟到原因：`duplicate` 随任务状态而定，其余与静态表一致。 */
  readonly scheduler_late_reason: SchedulerLateResultReason | null;
}

/**
 * 把一条结果处置翻译成共享调度器口径（唯一发布词表的运行期入口）。
 *
 * 派生而非另判：`disposition`/`scheduler_decision`/`honored_as_success` 全部取自
 * {@link RESULT_VERDICT_ALIGNMENT}；仅 `duplicate` 的 `scheduler_late_reason` 按 `snapshot` 解析。
 * 与 `decision.accepted` 的一致性由 K-I17 断言（`honored_as_success === decision.accepted`）。
 */
export function resolveResultDisposition(
  decision: ResultDecision,
  snapshot: Pick<DispatchRuntimeSnapshot, 'cancelled'>,
): ResolvedResultDisposition {
  const base = RESULT_VERDICT_ALIGNMENT[decision.verdict];
  const lateReason =
    decision.verdict === 'duplicate' ? schedulerLateReasonForDuplicate(snapshot) : base.scheduler_late_reason;
  return Object.freeze({ ...base, scheduler_late_reason: lateReason });
}
