/**
 * 运行中约束修改（能力 **CHAT-04**）—— 改约束 / 补资料 / 暂停 / 取消，且**归属可核对**。
 *
 * ## 这个模块回答什么
 *
 * 任务正在跑的时候，用户还能接着说话：改个约束（"字数改成 800"）、补一份资料、暂停或取消。
 * 本模块负责三件事：
 *
 * 1. **归属**（哪条指令改动哪个任务、哪个版本）；
 * 2. **执行**（把约束 / 资料落到该任务的那个版本上，或对运行施加暂停 / 取消）；
 * 3. **可核对**（每条落库的指令都记下它是**凭什么**归到这个任务上的 —— `origin`）。
 *
 * ## 唯一硬约束：**不靠文本相似度猜**
 *
 * 归属只认三种**显式**判据，`origin.by` 把它们逐字记下来：
 *
 * | `origin.by` | 触发条件 | 说明 |
 * |---|---|---|
 * | `'task'` | 指令带 `task_id` | 最强，直接命中 |
 * | `'message'` | 指令带 `message_id`（"就这条"） | 经消息绑定表解析出任务与**版本** |
 * | `'sole_active_run'` | 既无 `task_id` 也无 `message_id`，且**恰好只有一个**在跑的任务 | 按**数量**归属，仍然零文本比对 |
 *
 * 其余情况**一律不猜**：
 * - 有 **两个及以上**在跑的任务而无显式绑定 ⇒ `needs_clarification`（返回候选，请用户点一下）；
 * - **一个都没有** ⇒ `rejected: no_active_run`。
 *
 * 本文件**不含**任何字符串相似度 / 关键词 / 标题匹配的代码路径 —— 不是"没用到"，是**没有这个能力**。
 * `run-constraints.test.ts` 用一组**文案完全相同**的指令证明：归属只由显式绑定决定。
 *
 * ## 版本绑定
 *
 * 改约束 / 补资料必须绑定到任务**当前的版本**（`revision`）。绑定到别的版本 ⇒
 * `rejected: revision_mismatch` 且回带 `current_revision`（让调用方能提示"任务已推进到第 N 版"）。
 * 已落库的约束在任务推进后用 `supersededRequirements()` 复核：`requirement.revision <
 * run.revision` 的那些就是**绑定已过期**、需要重新确认的。
 *
 * ## 与其他模块的分工
 *
 * - **消息 / 轮次生命周期**（增量回复、重试、断线续取、中止回复 vs 取消任务）在
 *   `turn-model.ts`（CHAT-03）；本模块**只管"运行中的要求归属与控制"**，不碰消息表。
 * - 与 `fa/chat-session` 的 `session-model.ts` / `session-tasks.ts` 无耦合：本模块是纯逻辑，
 *   运行记录由调用方（宿主 / 执行器）灌入。
 */

import { asRevision, asTaskId, createIdSource, type IdSource, type MessageId, type Revision, type TaskId } from '../protocol/ids.js';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

export type RunStatus = 'running' | 'paused' | 'cancelled' | 'completed';

/** 新增要求的种类：改约束（`constraint`）/ 补资料（`material`）。 */
export type RequirementKind = 'constraint' | 'material';

/** 一条正在执行的运行（任务 + 版本 + 状态）。 */
export interface ActiveRun {
  readonly task_id: TaskId;
  readonly title: string;
  readonly revision: Revision;
  readonly status: RunStatus;
}

/**
 * 归属判据（**逐条可核对**）。没有任何一种叫"文本像"。
 */
export type RequirementOrigin =
  | { readonly by: 'task'; readonly task_id: TaskId }
  | { readonly by: 'message'; readonly message_id: MessageId }
  | { readonly by: 'sole_active_run'; readonly task_id: TaskId };

/** 一条已落库的要求（冻结）。 */
export interface RunRequirement {
  readonly task_id: TaskId;
  /** 绑定当时的任务版本。 */
  readonly revision: Revision;
  readonly kind: RequirementKind;
  readonly text: string;
  readonly origin: RequirementOrigin;
}

export interface RequirementInput {
  readonly kind: RequirementKind;
  readonly text: string;
  /** 显式绑定：任务 id。 */
  readonly task_id?: TaskId;
  /** 显式绑定：消息 id（"就这条"），经 `registerMessageBinding` 解析出任务与版本。 */
  readonly message_id?: MessageId;
  /** 显式版本文档；省略时取任务当前版本。 */
  readonly revision?: Revision;
}

export type RejectCode =
  | 'empty_text'
  | 'unknown_task'
  | 'unknown_message'
  | 'revision_mismatch'
  | 'no_active_run'
  | 'run_terminal'
  | 'invalid_state'
  | 'already_terminal';

export type ApplyRequirementResult =
  | { readonly status: 'applied'; readonly requirement: RunRequirement; readonly run: ActiveRun }
  | {
      readonly status: 'needs_clarification';
      readonly reason: 'ambiguous_task';
      readonly candidates: readonly ActiveRun[];
      readonly question: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: RejectCode;
      readonly message: string;
      /** 仅在 `revision_mismatch` 时回带，便于提示"任务已推进"。 */
      readonly current_revision?: Revision;
    };

export type ControlResult =
  | { readonly status: 'ok'; readonly run: ActiveRun }
  | { readonly status: 'rejected'; readonly code: RejectCode; readonly message: string };

export interface StartRunInput {
  readonly title: string;
  readonly task_id?: TaskId;
  readonly revision?: Revision;
}

export interface RunConstraintBoardOptions {
  readonly seed?: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const rejected = (
  code: RejectCode,
  message: string,
  currentRevision?: Revision,
): { status: 'rejected'; code: RejectCode; message: string; current_revision?: Revision } =>
  Object.freeze({
    status: 'rejected' as const,
    code,
    message,
    ...(currentRevision === undefined ? {} : { current_revision: currentRevision }),
  });

const isActive = (run: ActiveRun): boolean => run.status === 'running' || run.status === 'paused';

// ---------------------------------------------------------------------------
// 约束板
// ---------------------------------------------------------------------------

/**
 * 运行中约束板：登记在跑的任务、把用户的新要求**按显式绑定**归到任务 + 版本上，
 * 并提供暂停 / 继续 / 取消控制。
 */
export class RunConstraintBoard {
  readonly #ids: IdSource;
  readonly #runs = new Map<TaskId, ActiveRun>();
  readonly #requirements = new Map<TaskId, RunRequirement[]>();
  readonly #messageBindings = new Map<MessageId, { readonly task_id: TaskId; readonly revision: Revision }>();

  constructor(options: RunConstraintBoardOptions = {}) {
    this.#ids = createIdSource(options.seed === undefined ? {} : { seed: options.seed });
  }

  // -------------------------------------------------------------------------
  // 运行登记
  // -------------------------------------------------------------------------

  /** 登记一个正在跑的任务（`task_id` 省略时按确定序生成）。 */
  startRun(input: StartRunInput): ActiveRun {
    const taskId = input.task_id ?? asTaskId(this.#ids.next('run'));
    const run: ActiveRun = Object.freeze({
      task_id: taskId,
      title: input.title,
      revision: input.revision ?? asRevision(0),
      status: 'running' as RunStatus,
    });
    this.#runs.set(taskId, run);
    if (!this.#requirements.has(taskId)) this.#requirements.set(taskId, []);
    return run;
  }

  /**
   * 登记一条消息到任务 + 版本（供 `message_id` 归属解析）。
   * 消息 id 由调用方（`turn-model.ts` 的轮次）给出。
   */
  registerMessageBinding(input: {
    readonly message_id: MessageId;
    readonly task_id: TaskId;
    readonly revision?: Revision;
  }): ControlResult {
    const run = this.#runs.get(input.task_id);
    if (run === undefined) return rejected('unknown_task', `未知任务 ${input.task_id}`);
    this.#messageBindings.set(
      input.message_id,
      Object.freeze({ task_id: input.task_id, revision: input.revision ?? run.revision }),
    );
    return Object.freeze({ status: 'ok' as const, run });
  }

  listRuns(): readonly ActiveRun[] {
    return Object.freeze([...this.#runs.values()]);
  }

  getRun(taskId: TaskId): ActiveRun | undefined {
    return this.#runs.get(taskId);
  }

  requirementsFor(taskId: TaskId): readonly RunRequirement[] {
    return Object.freeze([...(this.#requirements.get(taskId) ?? [])]);
  }

  /**
   * 绑定已过期的要求：`requirement.revision < run.revision` 的那些。
   * 任务版本推进后用它对账，"绑的是第几版"是数据，不是文案。
   */
  supersededRequirements(taskId: TaskId): readonly RunRequirement[] {
    const run = this.#runs.get(taskId);
    if (run === undefined) return Object.freeze([]);
    return Object.freeze((this.#requirements.get(taskId) ?? []).filter((r) => r.revision < run.revision));
  }

  /** 推进任务版本（实质性需求变更被内核判成立时调用）。 */
  advanceRevision(taskId: TaskId): ActiveRun | undefined {
    const run = this.#runs.get(taskId);
    if (run === undefined) return undefined;
    const updated: ActiveRun = Object.freeze({ ...run, revision: asRevision(run.revision + 1) });
    this.#runs.set(taskId, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // 归属 + 应用
  // -------------------------------------------------------------------------

  /**
   * 应用一条新要求（改约束 / 补资料）。
   *
   * 归属只走显式绑定或"唯一活动运行"计数规则；**绝不比对文本**。
   * 无法确定时返回 `needs_clarification`（带候选），而不是挑一个。
   */
  applyRequirement(input: RequirementInput): ApplyRequirementResult {
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      return rejected('empty_text', '要求正文不能为空');
    }

    // ---- 归属 1：显式任务 id（最强，直接命中，不看一个字） ----
    if (input.task_id !== undefined) {
      const run = this.#runs.get(input.task_id);
      if (run === undefined) return rejected('unknown_task', `未知任务 ${input.task_id}`);
      return this.#bind(run, { by: 'task', task_id: run.task_id }, input);
    }

    // ---- 归属 2：显式消息 id（"就这条"），经消息绑定表解出任务与版本 ----
    if (input.message_id !== undefined) {
      const binding = this.#messageBindings.get(input.message_id);
      if (binding === undefined) {
        return rejected('unknown_message', `未知消息绑定 ${input.message_id}：无法据此确定任务`);
      }
      const run = this.#runs.get(binding.task_id);
      if (run === undefined) return rejected('unknown_task', `消息绑定的任务不存在 ${binding.task_id}`);
      return this.#bind(
        run,
        { by: 'message', message_id: input.message_id },
        { ...input, revision: binding.revision },
      );
    }

    // ---- 归属 3：无显式绑定 —— 只按"活动运行数量"判定，仍然零文本比对 ----
    const active = this.listRuns().filter(isActive);
    if (active.length === 0) {
      return rejected('no_active_run', '当前没有正在执行的任务：无法确定这条要求改动哪个任务');
    }
    if (active.length > 1) {
      return Object.freeze({
        status: 'needs_clarification' as const,
        reason: 'ambiguous_task' as const,
        candidates: Object.freeze(active),
        question: '当前有多个任务在执行：请指明要改哪一个（点任务卡或引用那条消息），我不按措辞猜',
      });
    }
    const only = active[0];
    if (only === undefined) {
      return rejected('no_active_run', '当前没有正在执行的任务');
    }
    return this.#bind(only, { by: 'sole_active_run', task_id: only.task_id }, input);
  }

  // -------------------------------------------------------------------------
  // 控制：暂停 / 继续 / 取消
  // -------------------------------------------------------------------------

  /** 暂停一个正在跑的任务。 */
  pause(taskId: TaskId): ControlResult {
    const run = this.#runs.get(taskId);
    if (run === undefined) return rejected('unknown_task', `未知任务 ${taskId}`);
    if (run.status !== 'running') {
      return rejected('invalid_state', `任务处于 ${run.status}，只有 running 可暂停`);
    }
    return Object.freeze({ status: 'ok' as const, run: this.#setStatus(taskId, 'paused') });
  }

  /** 继续一个被暂停的任务。 */
  resumeRun(taskId: TaskId): ControlResult {
    const run = this.#runs.get(taskId);
    if (run === undefined) return rejected('unknown_task', `未知任务 ${taskId}`);
    if (run.status !== 'paused') {
      return rejected('invalid_state', `任务处于 ${run.status}，只有 paused 可继续`);
    }
    return Object.freeze({ status: 'ok' as const, run: this.#setStatus(taskId, 'running') });
  }

  /** 取消一个在跑或被暂停的任务（终态，之后的新要求一律 `run_terminal`）。 */
  cancel(taskId: TaskId): ControlResult {
    const run = this.#runs.get(taskId);
    if (run === undefined) return rejected('unknown_task', `未知任务 ${taskId}`);
    if (run.status === 'cancelled' || run.status === 'completed') {
      return rejected('already_terminal', `任务已处于 ${run.status}，不能取消`);
    }
    return Object.freeze({ status: 'ok' as const, run: this.#setStatus(taskId, 'cancelled') });
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #bind(run: ActiveRun, origin: RequirementOrigin, input: RequirementInput): ApplyRequirementResult {
    if (!isActive(run)) {
      return rejected('run_terminal', `任务已处于 ${run.status}：不能再改约束或补资料`);
    }
    const wanted = input.revision ?? run.revision;
    if (wanted !== run.revision) {
      return rejected(
        'revision_mismatch',
        `绑定版本 ${String(wanted)} 与任务当前版本 ${String(run.revision)} 不一致：请按当前版本重新下达`,
        run.revision,
      );
    }
    const requirement: RunRequirement = Object.freeze({
      task_id: run.task_id,
      revision: run.revision,
      kind: input.kind,
      text: input.text,
      origin: Object.freeze(origin),
    });
    const list = this.#requirements.get(run.task_id) ?? [];
    this.#requirements.set(run.task_id, [...list, requirement]);
    return Object.freeze({ status: 'applied' as const, requirement, run });
  }

  #setStatus(taskId: TaskId, status: RunStatus): ActiveRun {
    const current = this.#runs.get(taskId);
    if (current === undefined) {
      throw new Error(`内部不一致：对不存在的任务改状态 ${taskId}`);
    }
    const updated: ActiveRun = Object.freeze({ ...current, status });
    this.#runs.set(taskId, updated);
    return updated;
  }
}
