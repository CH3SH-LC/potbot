/**
 * **会话内的多任务面板**（CHAT-05；完整能力目录 2026-10-03）。
 *
 * ## 这个模块回答什么
 *
 * > 同一会话可以有**多个任务**；多个会话可以**并行执行**；任务卡、进度、文件、
 * > 等待条件和决策气泡**各自归位**。
 *
 * "各自归位"是本文件存在的**唯一理由**。界面最容易出的错是把这些数据放进一个
 * **全局池**（`progressByTask` 尚可，`currentProgress` 就完了）——于是任务 A 的进度
 * 会出现在任务 B 的卡片上、A 的决策气泡会顶到 B 的标题下。本层用**二维键**
 * `(conversation_id, task_id)` 把这些数据**钉死**在自己的任务卡上：
 *
 * ```text
 * ConversationTaskBoard
 *   └─ conversation A ─┬─ task A1 → { progress, files, waiting, decisions }
 *                      └─ task A2 → { progress, files, waiting, decisions }
 *   └─ conversation B ──── task B1 → { progress, files, waiting, decisions }
 * ```
 *
 * 任何"按 task_id 单键"的查询都被**拒绝**——`taskCard` 必须同时给出会话 id，
 * 且校验该任务**确实**属于这个会话（否则 `task_not_in_session`）。于是
 * "A 的进度不会出现在 B 上"不是一句承诺，而是**类型与运行时的双重约束**。
 *
 * ## 并行
 *
 * 并行是**跨会话**的：每个任务有独立的 `run_id`；`runningSessions()` 会同时列出
 * 多个正在跑的会话。本层只**记账**（谁在跑、跑成什么样），**不执行**——真正的执行
 * 由内核与宿主承担。
 *
 * ## 纪律
 *
 * 纯数据 + 零 IO + 时间由调用方传入。失败结构化（`TaskResult`），不抛异常。
 */

import { asLogicalTime, type LogicalTime, type TaskId } from '../protocol/index.js';
import type { ConversationId } from './session-model.js';

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

/** 任务的运行状态（封闭枚举）。 */
export type TaskRunState =
  /** 已排队，尚未开始。 */
  | 'queued'
  /** 正在执行。 */
  | 'running'
  /** 在等条件（等待条件见 {@link WaitingCondition}）。 */
  | 'waiting'
  /** 被用户暂停。 */
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** 任务进度（**只属于它所在的那张任务卡**）。 */
export interface TaskProgress {
  /** 0–100 的整数百分比。 */
  readonly percent: number;
  /** 人类可读的阶段说明。 */
  readonly label: string;
  readonly updated_at: LogicalTime;
}

/** 任务产出/引用的文件（**归位**：只挂在本任务卡上）。 */
export interface TaskFileRef {
  readonly file_id: string;
  readonly filename: string;
  /** 内容摘要；**未回读核对时为 `null`**（不以"应该有"冒充"已验证"）。 */
  readonly digest: string | null;
  readonly created_at: LogicalTime;
}

/** 等待条件：任务卡在等什么（**归位**到具体任务）。 */
export interface WaitingCondition {
  readonly kind: 'decision' | 'external' | 'resource' | 'user_input';
  readonly detail: string;
  readonly since: LogicalTime;
}

/** 决策气泡：需要用户拍板的动作对象（**归位**到具体任务）。 */
export interface DecisionBubble {
  readonly decision_id: string;
  readonly task_id: TaskId;
  readonly conversation_id: ConversationId;
  readonly prompt: string;
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly raised_at: LogicalTime;
  readonly resolved_at: LogicalTime | null;
}

/** 一张任务卡（`(conversation_id, task_id)` 是它在板子上的唯一坐标）。 */
export interface TaskCard {
  readonly conversation_id: ConversationId;
  readonly task_id: TaskId;
  readonly title: string;
  readonly goal: string;
  readonly run_state: TaskRunState;
  readonly progress: TaskProgress;
  readonly files: readonly TaskFileRef[];
  readonly waiting: WaitingCondition | null;
  readonly decisions: readonly DecisionBubble[];
  /** 本次执行轮次 id（`null` = 尚未开始）。并行时各任务**互不相同**。 */
  readonly run_id: string | null;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

// ---------------------------------------------------------------------------
// 结果类型与失败码
// ---------------------------------------------------------------------------

export type TaskFailureCode =
  /** 任务不存在。 */
  | 'task_not_found'
  /** 任务存在，但**不属于**给定会话（跨会话访问被拒）。 */
  | 'task_not_in_session'
  | 'task_already_exists'
  | 'invalid_progress'
  | 'invalid_title'
  | 'file_already_attached'
  | 'file_not_found'
  | 'decision_not_found';

export type TaskResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TaskFailureCode; readonly message: string };

function taskOk<T>(value: T): TaskResult<T> {
  return Object.freeze({ ok: true as const, value });
}

function taskFail<T>(code: TaskFailureCode, message: string): TaskResult<T> {
  return Object.freeze({ ok: false as const, code, message });
}

// ---------------------------------------------------------------------------
// 任务板
// ---------------------------------------------------------------------------

export class ConversationTaskBoard {
  /** 外层键 = 会话，内层键 = 任务。**不存在任何"按 task_id 单键"的全局索引。** */
  readonly #byConversation = new Map<ConversationId, Map<TaskId, TaskCard>>();

  /** 新建任务卡（同一 `task_id` 在**全板**唯一；重复即拒绝，不做静默覆盖）。 */
  createTask(input: {
    readonly conversation_id: ConversationId;
    readonly task_id: TaskId;
    readonly title: string;
    readonly goal: string;
    readonly at: LogicalTime;
  }): TaskResult<TaskCard> {
    const title = input.title.trim();
    if (title.length === 0) {
      return taskFail('invalid_title', '任务标题不能为空');
    }
    if (this.#locate(input.task_id) !== null) {
      return taskFail('task_already_exists', `任务 ${input.task_id} 已存在（任务 id 全板唯一）`);
    }
    const at = asLogicalTime(input.at);
    const card: TaskCard = Object.freeze({
      conversation_id: input.conversation_id,
      task_id: input.task_id,
      title,
      goal: input.goal,
      run_state: 'queued',
      progress: Object.freeze({ percent: 0, label: '已排队', updated_at: at }),
      files: Object.freeze([]),
      waiting: null,
      decisions: Object.freeze([]),
      run_id: null,
      created_at: at,
      updated_at: at,
    });
    this.#bucket(input.conversation_id).set(input.task_id, card);
    return taskOk(card);
  }

  // --- 查询（**必须带会话 id**：这是归位的运行时约束）---------------------

  /**
   * 取一张任务卡。**必须同时给出会话 id**：任务属于别的会话时返回 `task_not_in_session`。
   * 这正是"A 的进度不会出现在 B 上"的判据——按 B 的坐标**根本取不到** A 的任务。
   */
  taskCard(conversation_id: ConversationId, task_id: TaskId): TaskResult<TaskCard> {
    const located = this.#locate(task_id);
    if (located === null) {
      return taskFail('task_not_found', `没有任务 ${task_id}`);
    }
    if (located.conversation_id !== conversation_id) {
      return taskFail(
        'task_not_in_session',
        `任务 ${task_id} 属于会话 ${located.conversation_id}，不是 ${conversation_id}（拒绝跨会话归位）`,
      );
    }
    return taskOk(located);
  }

  /** **只**返回本会话的任务卡（别的会话的任务不会出现在这里）。 */
  tasksOf(conversation_id: ConversationId): readonly TaskCard[] {
    return Object.freeze([...(this.#byConversation.get(conversation_id)?.values() ?? [])]);
  }

  taskCount(conversation_id: ConversationId): number {
    return this.#byConversation.get(conversation_id)?.size ?? 0;
  }

  hasTask(conversation_id: ConversationId, task_id: TaskId): boolean {
    return this.taskCard(conversation_id, task_id).ok;
  }

  // --- 执行与并行 ---------------------------------------------------------

  /**
   * 开始一次执行轮次。`run_id` 由调用方给出；同一任务重复开始（已在跑）会被拒绝，
   * 避免同一任务出现两个并行轮次（那是同一任务的串扰，不是并行）。
   */
  startRun(
    conversation_id: ConversationId,
    task_id: TaskId,
    run_id: string,
    at: LogicalTime,
  ): TaskResult<TaskCard> {
    if (run_id.trim().length === 0) {
      return taskFail('invalid_progress', 'run_id 不能为空');
    }
    return this.#update(conversation_id, task_id, at, (card) => {
      if (card.run_state === 'running') {
        return null;
      }
      return Object.freeze({ ...card, run_state: 'running' as const, run_id, waiting: null });
    });
  }

  /** **正在执行任务的会话**（并行性的断言面：一次可同时列出多个会话）。 */
  runningSessions(): readonly ConversationId[] {
    const out: ConversationId[] = [];
    for (const [conversation_id, tasks] of this.#byConversation) {
      for (const card of tasks.values()) {
        if (card.run_state === 'running') {
          out.push(conversation_id);
          break;
        }
      }
    }
    return Object.freeze(out);
  }

  /** 全局正在跑的任务数（并行度的旁证）。 */
  runningTaskCount(): number {
    let count = 0;
    for (const tasks of this.#byConversation.values()) {
      for (const card of tasks.values()) {
        if (card.run_state === 'running') {
          count += 1;
        }
      }
    }
    return count;
  }

  // --- 进度（归位的核心断言面）-------------------------------------------

  /**
   * 更新进度。**二维键**：只有 `(conversation_id, task_id)` 都匹配时才会改到那张卡，
   * 因此"任务 A 的进度跑到任务 B 上"在接口层就**不可能**发生。
   */
  updateProgress(
    conversation_id: ConversationId,
    task_id: TaskId,
    input: { readonly percent: number; readonly label?: string; readonly at: LogicalTime },
  ): TaskResult<TaskCard> {
    const percent = input.percent;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return taskFail('invalid_progress', `进度必须是 0–100，收到 ${String(percent)}`);
    }
    return this.#update(conversation_id, task_id, input.at, (card) =>
      Object.freeze({
        ...card,
        progress: Object.freeze({
          percent: Math.round(percent),
          label: input.label ?? card.progress.label,
          updated_at: asLogicalTime(input.at),
        }),
      }),
    );
  }

  // --- 文件 ---------------------------------------------------------------

  attachFile(
    conversation_id: ConversationId,
    task_id: TaskId,
    file: { readonly file_id: string; readonly filename: string; readonly digest?: string | null; readonly at: LogicalTime },
  ): TaskResult<TaskCard> {
    return this.#update(conversation_id, task_id, file.at, (card) => {
      if (card.files.some((item) => item.file_id === file.file_id)) {
        return card; // 幂等：同一文件重复登记不产生第二份
      }
      const ref: TaskFileRef = Object.freeze({
        file_id: file.file_id,
        filename: file.filename,
        digest: file.digest ?? null,
        created_at: asLogicalTime(file.at),
      });
      return Object.freeze({ ...card, files: Object.freeze([...card.files, ref]) });
    });
  }

  removeFile(conversation_id: ConversationId, task_id: TaskId, file_id: string, at: LogicalTime): TaskResult<TaskCard> {
    const card = this.taskCard(conversation_id, task_id);
    if (!card.ok) {
      return card;
    }
    if (!card.value.files.some((item) => item.file_id === file_id)) {
      return taskFail('file_not_found', `任务 ${task_id} 上没有文件 ${file_id}`);
    }
    return this.#update(conversation_id, task_id, at, (current) =>
      Object.freeze({ ...current, files: Object.freeze(current.files.filter((item) => item.file_id !== file_id)) }),
    );
  }

  // --- 等待条件 -----------------------------------------------------------

  setWaiting(
    conversation_id: ConversationId,
    task_id: TaskId,
    waiting: { readonly kind: WaitingCondition['kind']; readonly detail: string; readonly at: LogicalTime },
  ): TaskResult<TaskCard> {
    return this.#update(conversation_id, task_id, waiting.at, (card) =>
      Object.freeze({
        ...card,
        run_state: 'waiting' as const,
        waiting: Object.freeze({
          kind: waiting.kind,
          detail: waiting.detail,
          since: asLogicalTime(waiting.at),
        }),
      }),
    );
  }

  clearWaiting(conversation_id: ConversationId, task_id: TaskId, at: LogicalTime): TaskResult<TaskCard> {
    return this.#update(conversation_id, task_id, at, (card) =>
      Object.freeze({ ...card, waiting: null, run_state: card.run_state === 'waiting' ? ('running' as const) : card.run_state }),
    );
  }

  // --- 决策气泡 -----------------------------------------------------------

  raiseDecision(
    conversation_id: ConversationId,
    task_id: TaskId,
    decision: { readonly decision_id: string; readonly prompt: string; readonly at: LogicalTime },
  ): TaskResult<TaskCard> {
    return this.#update(conversation_id, task_id, decision.at, (card) => {
      if (card.decisions.some((item) => item.decision_id === decision.decision_id)) {
        return card; // 幂等
      }
      const bubble: DecisionBubble = Object.freeze({
        decision_id: decision.decision_id,
        task_id,
        conversation_id,
        prompt: decision.prompt,
        state: 'pending' as const,
        raised_at: asLogicalTime(decision.at),
        resolved_at: null,
      });
      return Object.freeze({ ...card, decisions: Object.freeze([...card.decisions, bubble]) });
    });
  }

  resolveDecision(
    conversation_id: ConversationId,
    task_id: TaskId,
    decision_id: string,
    resolution: 'approved' | 'rejected' | 'expired',
    at: LogicalTime,
  ): TaskResult<TaskCard> {
    const card = this.taskCard(conversation_id, task_id);
    if (!card.ok) {
      return card;
    }
    if (!card.value.decisions.some((item) => item.decision_id === decision_id)) {
      return taskFail('decision_not_found', `任务 ${task_id} 上没有决策 ${decision_id}`);
    }
    return this.#update(conversation_id, task_id, at, (current) =>
      Object.freeze({
        ...current,
        decisions: Object.freeze(
          current.decisions.map((item) =>
            item.decision_id === decision_id
              ? Object.freeze({ ...item, state: resolution, resolved_at: asLogicalTime(at) })
              : item,
          ),
        ),
      }),
    );
  }

  /** 某任务上**仍未定局**的决策（归位的断言面）。 */
  pendingDecisionsOf(conversation_id: ConversationId, task_id: TaskId): readonly DecisionBubble[] {
    const card = this.taskCard(conversation_id, task_id);
    if (!card.ok) {
      return Object.freeze([]);
    }
    return Object.freeze(card.value.decisions.filter((item) => item.state === 'pending'));
  }

  // --- 终态 ---------------------------------------------------------------

  completeTask(conversation_id: ConversationId, task_id: TaskId, at: LogicalTime): TaskResult<TaskCard> {
    return this.#settle(conversation_id, task_id, at, 'completed');
  }

  failTask(conversation_id: ConversationId, task_id: TaskId, at: LogicalTime): TaskResult<TaskCard> {
    return this.#settle(conversation_id, task_id, at, 'failed');
  }

  /** 取消任务（CHAT-08 的一种删除语义；见 {@link ./delete-semantics.js}）。 */
  cancelTask(conversation_id: ConversationId, task_id: TaskId, at: LogicalTime): TaskResult<TaskCard> {
    return this.#settle(conversation_id, task_id, at, 'cancelled');
  }

  /** 从板上**移除**一条任务（用于会话删除后的清理；终态标记请用 `cancelTask`）。 */
  removeTask(conversation_id: ConversationId, task_id: TaskId): TaskResult<TaskCard> {
    const card = this.taskCard(conversation_id, task_id);
    if (!card.ok) {
      return card;
    }
    this.#byConversation.get(conversation_id)?.delete(task_id);
    return taskOk(card.value);
  }

  #settle(
    conversation_id: ConversationId,
    task_id: TaskId,
    at: LogicalTime,
    state: 'completed' | 'failed' | 'cancelled',
  ): TaskResult<TaskCard> {
    return this.#update(conversation_id, task_id, at, (card) =>
      Object.freeze({
        ...card,
        run_state: state,
        waiting: null,
        progress:
          state === 'completed'
            ? Object.freeze({ percent: 100, label: '已完成', updated_at: asLogicalTime(at) })
            : card.progress,
      }),
    );
  }

  // --- 内部 ---------------------------------------------------------------

  /** 全局定位（只在本文件内用：对外**不暴露**单键查询）。 */
  #locate(task_id: TaskId): TaskCard | null {
    for (const tasks of this.#byConversation.values()) {
      const card = tasks.get(task_id);
      if (card !== undefined) {
        return card;
      }
    }
    return null;
  }

  #bucket(conversation_id: ConversationId): Map<TaskId, TaskCard> {
    const existing = this.#byConversation.get(conversation_id);
    if (existing !== undefined) {
      return existing;
    }
    const fresh = new Map<TaskId, TaskCard>();
    this.#byConversation.set(conversation_id, fresh);
    return fresh;
  }

  #update(
    conversation_id: ConversationId,
    task_id: TaskId,
    at: LogicalTime,
    mutate: (card: TaskCard) => TaskCard | null,
  ): TaskResult<TaskCard> {
    const card = this.taskCard(conversation_id, task_id);
    if (!card.ok) {
      return card;
    }
    const next = mutate(card.value);
    const base = next === null ? card.value : next;
    const written = Object.freeze({ ...base, updated_at: asLogicalTime(at) });
    this.#byConversation.get(conversation_id)?.set(task_id, written);
    return taskOk(written);
  }
}
