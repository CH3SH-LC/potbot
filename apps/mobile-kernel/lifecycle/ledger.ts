/**
 * K10 持久任务账本 —— **只追加日志 + 重放得出视图 + 游标派生**。
 *
 * ## 为什么是日志而不是"存一个状态字段"
 *
 * 进程回收后要回答的问题不是"任务几岁了"，而是"**从第几步继续**、**有没有未结清的外部副作用**"。
 * 只存当前状态字段回答不了：崩溃可能发生在"步骤已跑完、完成标记还没写"之间。因此账本存的是
 * **事件序列**，任务视图由 `replay` 重新推导——恢复因此是确定性的、可独立复算的。
 *
 * ## 三条不变量（由写入口强制，测试逐条打）
 *
 * 1. **不得重跑已完成步骤**：`completeStep()` 对重复步骤抛 `duplicate_step`；
 *    不在步骤表里的抛 `unknown_step`。这是"恢复从游标继续"的硬保证。
 * 2. **游标是派生的**：`cursor` = 步骤表里第一个未完成步骤的下标。没有"游标字段"可以被
 *    某次崩溃写成前后不一致的值。
 * 3. **读失败不当空库**：`replay()` 对空串 / 非法 JSON / 版本不符 / 序号乱序**一律抛**
 *    `invalid_snapshot`。把读失败当"没有任务"会把未结清的外部副作用静默丢掉——正是
 *    K08 对记忆库的同一条纪律（"读失败不当空库"）。
 *
 * ## 与 K07 `AuthorizationLedger` 的分工（不重复造）
 *
 * K07 管的是**授权与外部提交**的一次性占用、发出意图、查原单；本账本管的是**任务步骤游标**。
 * 二者通过 `externalIntentRef` 交汇：本账本的 `externalIntentRef` 指向 K07 的 submissionId，
 * 恢复计划据此决定"查原单"。本模块**不复制** K07 的状态机，只记录"某任务发起过一次外部
 * 副作用、是否取回结果"。
 */

import { LifecycleError } from './errors.js';
import type { DiagnosticsLog } from '../observability/diagnostics.js';
import {
  KERNEL_TASK_ID,
  JOURNAL_KINDS,
  isTerminalTaskState,
  isTaskState,
  type Clock,
  type JournalEntry,
  type JournalKind,
  type JournalValue,
  type KillMode,
  type TaskRecord,
  type TaskState,
} from './types.js';

const SNAPSHOT_VERSION = 1;

export interface TaskLedgerOptions {
  readonly clock: Clock;
  readonly diagnostics?: DiagnosticsLog;
}

interface MutableTask {
  taskId: string;
  stepIds: string[];
  completed: string[];
  state: TaskState;
  externalIntentRef: string | null;
  externalObservedState: string | null;
  failureReason: string | null;
  updatedAt: number;
  lastSeq: number;
}

export class TaskLedger {
  readonly #clock: Clock;
  readonly #diagnostics: DiagnosticsLog | undefined;
  readonly #tasks = new Map<string, MutableTask>();
  readonly #entries: JournalEntry[] = [];
  #seq = 0;
  #killMode: KillMode | null = null;

  constructor(options: TaskLedgerOptions) {
    if (options === null || typeof options !== 'object' || options.clock === undefined) {
      throw new LifecycleError('invalid_snapshot', '构造任务账本必须注入 clock');
    }
    this.#clock = options.clock;
    this.#diagnostics = options.diagnostics;
  }

  // -------------------------------------------------------------------------
  // 写入（唯一汇点 `#append`）
  // -------------------------------------------------------------------------

  registerTask(input: { readonly taskId: string; readonly stepIds: readonly string[]; readonly at?: number }): TaskRecord {
    const taskId = requireText(input?.taskId, 'taskId');
    if (!Array.isArray(input?.stepIds) || input.stepIds.length === 0) {
      throw new LifecycleError('unknown_step', `任务 ${taskId} 的步骤表必须是非空数组`);
    }
    for (const stepId of input.stepIds) {
      requireText(stepId, 'stepId');
    }
    this.#append('task-registered', taskId, '', {
      stepIds: Object.freeze([...input.stepIds]),
      totalSteps: input.stepIds.length,
    }, input.at);
    return this.#view(this.#require(taskId));
  }

  startRun(taskId: string, at?: number): TaskRecord {
    this.#append('run-started', taskId, '', { state: 'running' }, at, (task) => {
      if (isTerminalTaskState(task.state)) {
        throw new LifecycleError('illegal_transition', `任务 ${task.taskId} 已到 ${task.state}，不得重启`);
      }
      task.state = 'running';
    });
    return this.#view(this.#require(taskId));
  }

  completeStep(taskId: string, stepId: string, at?: number): TaskRecord {
    const step = requireText(stepId, 'stepId');
    this.#append('step-completed', taskId, '', { stepId: step }, at, (task) => {
      if (!task.stepIds.includes(step)) {
        throw new LifecycleError('unknown_step', `步骤 ${step} 不在任务 ${task.taskId} 的步骤表里`);
      }
      if (task.completed.includes(step)) {
        throw new LifecycleError(
          'duplicate_step',
          `步骤 ${step} 在任务 ${task.taskId} 里已完成过：恢复不得重跑已完成步骤`,
        );
      }
      task.completed.push(step);
    });
    return this.#view(this.#require(taskId));
  }

  /** 记录一次外部副作用**已发起**（引用 K07 的 submissionId）。 */
  beginExternalIntent(taskId: string, ref: string, at?: number): TaskRecord {
    const reference = requireText(ref, 'externalIntentRef');
    this.#append('external-intent', taskId, '', { ref: reference }, at, (task) => {
      if (task.externalIntentRef !== null) {
        throw new LifecycleError(
          'illegal_transition',
          `任务 ${task.taskId} 已有未结清的外部意图 ${task.externalIntentRef}：不得再发起一次`,
        );
      }
      task.externalIntentRef = reference;
    });
    return this.#view(this.#require(taskId));
  }

  /** 记录外部副作用**已结清**（凭据/回执由 K07 校验；这里只记观测状态）。 */
  settleExternal(taskId: string, observedState: string, at?: number): TaskRecord {
    const observed = requireText(observedState, 'observedState');
    this.#append('external-settled', taskId, '', { observedState: observed }, at, (task) => {
      if (task.externalIntentRef === null) {
        throw new LifecycleError('illegal_transition', `任务 ${task.taskId} 没有待结清的外部意图`);
      }
      task.externalObservedState = observed;
    });
    return this.#view(this.#require(taskId));
  }

  setState(taskId: string, state: TaskState, reason: string, at?: number): TaskRecord {
    if (!isTaskState(state)) {
      throw new LifecycleError('illegal_transition', `未知任务状态 ${String(state)}`);
    }
    this.#append('state-changed', taskId, requireText(reason, 'reason'), { state }, at, (task) => {
      if (isTerminalTaskState(task.state)) {
        throw new LifecycleError('illegal_transition', `任务 ${task.taskId} 已到终态 ${task.state}，不得再改`);
      }
      task.state = state;
      if (isTerminalTaskState(state)) {
        task.failureReason = state === 'completed' ? null : reason;
      }
    });
    return this.#view(this.#require(taskId));
  }

  /**
   * 观测到一次进程回收。内核级事件（`taskId = 'kernel'`）。
   *
   * 未结清任务：有未结清外部意图 ⇒ `unknown-external`（只能查原单）；
   * 否则 ⇒ `reclaimed`（可从此游标续跑）。终态任务不动。
   */
  observeReclaim(killMode: KillMode, at?: number): readonly TaskRecord[] {
    if (killMode !== 'reclaim' && killMode !== 'force-stop') {
      throw new LifecycleError('invalid_snapshot', `killMode 必须是 reclaim / force-stop，收到 ${String(killMode)}`);
    }
    this.#killMode = killMode;
    this.#append('reclaim-observed', KERNEL_TASK_ID, killMode, { killMode }, at, () => {
      for (const task of this.#tasks.values()) {
        if (isTerminalTaskState(task.state)) {
          continue;
        }
        task.state = task.externalIntentRef !== null && task.externalObservedState === null
          ? 'unknown-external'
          : 'reclaimed';
      }
    });
    this.#diagnostics?.record({
      kind: 'recovery',
      severity: 'warn',
      taskId: KERNEL_TASK_ID,
      code: 'reclaim-observed',
      detail: `killMode=${killMode}`,
    });
    return Object.freeze(this.tasks());
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  getTask(taskId: string): TaskRecord | undefined {
    const task = this.#tasks.get(String(taskId));
    return task === undefined ? undefined : this.#view(task);
  }

  tasks(): readonly TaskRecord[] {
    return Object.freeze([...this.#tasks.values()].map((t) => this.#view(t)).sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)));
  }

  cursor(taskId: string): number {
    return this.#cursorOf(this.#require(taskId).stepIds, this.#require(taskId).completed);
  }

  journal(): readonly JournalEntry[] {
    return Object.freeze([...this.#entries]);
  }

  lastKillMode(): KillMode | null {
    return this.#killMode;
  }

  // -------------------------------------------------------------------------
  // 快照 / 重放
  // -------------------------------------------------------------------------

  snapshot(): string {
    return JSON.stringify({
      version: SNAPSHOT_VERSION,
      seq: this.#seq,
      killMode: this.#killMode,
      entries: this.#entries,
    });
  }

  /**
   * 从快照重建。**任何解析/结构问题都抛 `invalid_snapshot`**——绝不返回空账本。
   */
  static replay(text: string, options: TaskLedgerOptions): TaskLedger {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(text));
    } catch {
      throw new LifecycleError('invalid_snapshot', '快照不是合法 JSON：拒绝当作空账本继续（读失败不当空库）');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LifecycleError('invalid_snapshot', '快照根必须是对象');
    }
    const envelope = parsed as { version?: unknown; entries?: unknown; killMode?: unknown; seq?: unknown };
    if (envelope.version !== SNAPSHOT_VERSION) {
      throw new LifecycleError(
        'invalid_snapshot',
        `快照版本 ${String(envelope.version)} 不受支持（本模块支持 ${SNAPSHOT_VERSION}）`,
      );
    }
    if (!Array.isArray(envelope.entries)) {
      throw new LifecycleError('invalid_snapshot', '快照 entries 必须是数组');
    }
    if (envelope.killMode !== undefined && envelope.killMode !== null && envelope.killMode !== 'reclaim' && envelope.killMode !== 'force-stop') {
      throw new LifecycleError('invalid_snapshot', `快照 killMode 非法：${String(envelope.killMode)}`);
    }

    const ledger = new TaskLedger(options);
    ledger.#killMode = (envelope.killMode as KillMode | null | undefined) ?? null;

    let expectedSeq = 0;
    for (const raw of envelope.entries) {
      const entry = validateEntry(raw, expectedSeq);
      ledger.#entries.push(entry);
      ledger.#applyToTasks(entry);
      expectedSeq += 1;
    }
    ledger.#seq = expectedSeq;
    if (typeof envelope.seq === 'number' && envelope.seq !== expectedSeq) {
      throw new LifecycleError(
        'invalid_snapshot',
        `快照声明的 seq=${envelope.seq} 与重放出的 ${expectedSeq} 不符`,
      );
    }
    return ledger;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #append(
    kind: JournalKind,
    taskId: string,
    detail: string,
    data: Readonly<Record<string, JournalValue>>,
    at: number | undefined,
    mutate: ((task: MutableTask) => void) | null = null,
  ): JournalEntry {
    const task = this.#tasks.get(taskId);
    if (kind === 'task-registered') {
      if (task !== undefined) {
        throw new LifecycleError('duplicate_task', `任务 ${taskId} 已登记，不得重复登记`);
      }
    } else if (kind === 'reclaim-observed') {
      // 内核级事件，不要求任务存在
    } else if (task === undefined) {
      throw new LifecycleError('unknown_task', `台账里没有任务 ${taskId}`);
    }

    const entry: JournalEntry = Object.freeze({
      seq: this.#seq,
      at: at ?? this.#clock.now(),
      kind,
      taskId,
      detail,
      data: Object.freeze({ ...data }),
    });

    if (kind === 'task-registered') {
      const stepIds = data['stepIds'];
      if (!Array.isArray(stepIds)) {
        throw new LifecycleError('invalid_snapshot', 'task-registered 必须带 stepIds');
      }
      this.#tasks.set(taskId, {
        taskId,
        stepIds: [...stepIds],
        completed: [],
        state: 'registered',
        externalIntentRef: null,
        externalObservedState: null,
        failureReason: null,
        updatedAt: entry.at,
        lastSeq: entry.seq,
      });
    } else {
      mutate?.(this.#tasks.get(taskId)!);
      const mutable = this.#tasks.get(taskId);
      if (mutable !== undefined) {
        mutable.updatedAt = entry.at;
        mutable.lastSeq = entry.seq;
      }
    }

    this.#entries.push(entry);
    this.#seq += 1;
    return entry;
  }

  /** 重放路径专用：**不再做业务校验**（校验已在 `validateEntry` 完成），只更新视图。 */
  #applyToTasks(entry: JournalEntry): void {
    if (entry.kind === 'task-registered') {
      const stepIds = entry.data['stepIds'];
      this.#tasks.set(entry.taskId, {
        taskId: entry.taskId,
        stepIds: Array.isArray(stepIds) ? [...(stepIds as readonly string[])] : [],
        completed: [],
        state: 'registered',
        externalIntentRef: null,
        externalObservedState: null,
        failureReason: null,
        updatedAt: entry.at,
        lastSeq: entry.seq,
      });
      return;
    }
    if (entry.kind === 'reclaim-observed') {
      for (const task of this.#tasks.values()) {
        if (isTerminalTaskState(task.state)) {
          continue;
        }
        task.state = task.externalIntentRef !== null && task.externalObservedState === null ? 'unknown-external' : 'reclaimed';
      }
      return;
    }
    const task = this.#tasks.get(entry.taskId);
    if (task === undefined) {
      throw new LifecycleError('invalid_snapshot', `条目 seq=${entry.seq} 引用了快照中不存在的任务 ${entry.taskId}`);
    }
    const apply = REPLAY_APPLIERS[entry.kind];
    apply(task, entry);
    task.updatedAt = entry.at;
    task.lastSeq = entry.seq;
  }

  #require(taskId: string): MutableTask {
    const task = this.#tasks.get(String(taskId));
    if (task === undefined) {
      throw new LifecycleError('unknown_task', `台账里没有任务 ${String(taskId)}`);
    }
    return task;
  }

  #cursorOf(stepIds: readonly string[], completed: readonly string[]): number {
    const done = new Set(completed);
    for (let i = 0; i < stepIds.length; i += 1) {
      const step = stepIds[i];
      if (step === undefined || !done.has(step)) {
        return i;
      }
    }
    return stepIds.length;
  }

  #view(task: MutableTask): TaskRecord {
    return Object.freeze({
      taskId: task.taskId,
      stepIds: Object.freeze([...task.stepIds]),
      totalSteps: task.stepIds.length,
      completedSteps: Object.freeze([...task.completed]),
      cursor: this.#cursorOf(task.stepIds, task.completed),
      state: task.state,
      externalIntentRef: task.externalIntentRef,
      externalObservedState: task.externalObservedState,
      failureReason: task.failureReason,
      updatedAt: task.updatedAt,
      lastSeq: task.lastSeq,
    });
  }
}

// ---------------------------------------------------------------------------
// 重放应用器
// ---------------------------------------------------------------------------

const REPLAY_APPLIERS: Readonly<Record<Exclude<JournalKind, 'task-registered' | 'reclaim-observed'>, (task: MutableTask, entry: JournalEntry) => void>> = {
  'run-started': (task) => {
    if (!isTerminalTaskState(task.state)) {
      task.state = 'running';
    }
  },
  'step-completed': (task, entry) => {
    const stepId = entry.data['stepId'];
    if (typeof stepId !== 'string' || !task.stepIds.includes(stepId) || task.completed.includes(stepId)) {
      throw new LifecycleError('invalid_snapshot', `快照 seq=${entry.seq} 的步骤完成记录非法：${String(stepId)}`);
    }
    task.completed.push(stepId);
  },
  'external-intent': (task, entry) => {
    const ref = entry.data['ref'];
    if (typeof ref !== 'string' || task.externalIntentRef !== null) {
      throw new LifecycleError('invalid_snapshot', `快照 seq=${entry.seq} 的外部意图记录非法`);
    }
    task.externalIntentRef = ref;
  },
  'external-settled': (task, entry) => {
    const observed = entry.data['observedState'];
    if (typeof observed !== 'string' || task.externalIntentRef === null) {
      throw new LifecycleError('invalid_snapshot', `快照 seq=${entry.seq} 的外部结清记录非法`);
    }
    task.externalObservedState = observed;
  },
  'state-changed': (task, entry) => {
    const state = entry.data['state'];
    if (!isTaskState(state) || isTerminalTaskState(task.state)) {
      throw new LifecycleError('invalid_snapshot', `快照 seq=${entry.seq} 的状态变更非法：${String(state)}`);
    }
    task.state = state;
    if (isTerminalTaskState(state)) {
      task.failureReason = state === 'completed' ? null : entry.detail;
    }
  },
};

function validateEntry(raw: unknown, expectedSeq: number): JournalEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LifecycleError('invalid_snapshot', `快照第 ${expectedSeq} 条不是对象`);
  }
  const e = raw as Partial<JournalEntry>;
  if (e.seq !== expectedSeq) {
    throw new LifecycleError('invalid_snapshot', `快照条目 seq 乱序：期望 ${expectedSeq}，实为 ${String(e.seq)}`);
  }
  if (typeof e.kind !== 'string' || !(JOURNAL_KINDS as readonly string[]).includes(e.kind)) {
    throw new LifecycleError('invalid_snapshot', `快照条目 seq=${expectedSeq} 的 kind 非法：${String(e.kind)}`);
  }
  if (typeof e.taskId !== 'string' || e.taskId.length === 0) {
    throw new LifecycleError('invalid_snapshot', `快照条目 seq=${expectedSeq} 缺 taskId`);
  }
  if (!Number.isSafeInteger(e.at)) {
    throw new LifecycleError('invalid_snapshot', `快照条目 seq=${expectedSeq} 的 at 非整数`);
  }
  if (e.data === null || typeof e.data !== 'object' || Array.isArray(e.data)) {
    throw new LifecycleError('invalid_snapshot', `快照条目 seq=${expectedSeq} 的 data 必须是对象`);
  }
  return Object.freeze({
    seq: e.seq,
    at: e.at as number,
    kind: e.kind as JournalKind,
    taskId: e.taskId,
    detail: typeof e.detail === 'string' ? e.detail : '',
    data: Object.freeze({ ...(e.data as Record<string, JournalValue>) }),
  });
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LifecycleError('unknown_task', `字段 ${field} 必须是非空字符串，收到 ${JSON.stringify(value)}`);
  }
  return value;
}
