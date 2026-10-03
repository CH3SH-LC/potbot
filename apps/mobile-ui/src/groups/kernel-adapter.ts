/**
 * F04 groups —— 把内核 `KernelClient` 事件流接入 `applyTaskEvent` 的适配层。
 *
 * 为什么需要这一层：reducer 有一条**硬**不变量（见 `reducer.ts` 与 `types.ts` I1）——
 * 事件 `revision` 必须**恰好**是「当前 + 1」：
 *   - `revision <= 当前`      ⇒ `stale-revision`（拒绝）
 *   - `revision >  当前 + 1`  ⇒ `unknown-revision`（缺口，需重同步）
 * 而真实事件流不会保证这些：
 *   1) 宿主桥/`KernelClient` 可能把一批事件一次性回投（**批**）；
 *   2) 多路订阅/异步投递会让同一任务的多个 revision **乱序**到达；
 *   3) 内核的 revision 计数可能包含**视图层本就不受理**的事件（如内部 Agent 对话类别
 *      被 I2 拒收、或属于别的人机边界），于是**可渲染**事件之间会出现 revision 缺口。
 *
 * 因此适配层的职责是「**在进 reducer 之前**把批次拆开、按 revision 排好、把连续段喂给
 * reducer，把不连续的部分隔离并如实上报」——本模块只做这件事，**绝不**伪造 revision、
 * 不静默丢事件、不绕过 `applyTaskEvent`（I1）：
 *   - 批次/乱序：按 (revision, seq, eventId) 稳定排序；同一任务内取**连续前缀**逐条喂入；
 *   - 缺口：不喂给 reducer（那会抛 `unknown-revision` 并打断整批），而是**扣留**（有界缓冲）
 *     并把该任务记入 `pendingResync`，让调用方向内核重拉状态；
 *   - 迟到补齐：一旦补上了缺的那条 revision，缓冲里更高 revision 的连续段会自动续上；
 *   - 过期/重复：`revision <= 当前` 记为 `replay` 丢弃（幂等重放，幂等重投的常见结果）；
 *   - 非任务事件：`metadata` 无 `taskId`（属于别的流/别的域）⇒ `not-task-event`，忽略；
 *   - reducer 自身拒收（`illegal-transition` / `internal-chat-rejected` …）⇒ 记为
 *     `rejected` 并带原错误码，**不**重试、**不**改状态。
 *
 * 依赖与边界：零框架、零 I/O、不读时钟/随机数。事件到达时间以事件自身 `metadata.at`
 * 为准（由调用方/内核注入）。`held` 缓冲有上限 `MAX_HELD_PER_TASK`，超出部分记为
 * `buffer-overflow` 并要求重同步——**不**会无限增长，也**不**会悄悄吞掉。
 */

import { applyTaskEvent } from './reducer.js';
import { getTask } from './state.js';
import { GroupError } from './types.js';
import type { Event, GroupErrorCode, GroupsState, TaskEvent } from './types.js';

/** 每个任务扣留的事件条数上限；超出即 `buffer-overflow`（要求重同步，不无限增长）。 */
export const MAX_HELD_PER_TASK = 64;

// ---------------------------------------------------------------------------
// 端口（结构性；F 线协调者的 `platform/KernelClient` 需满足）
// ---------------------------------------------------------------------------

/** 事件订阅句柄。只要求 `unsubscribe`，兼容 K01 `Subscription`（多带一个 id 也满足）。 */
export interface EventSubscription {
  unsubscribe(): void;
}

/**
 * 任务事件源。F 线协调者需要在 `apps/mobile-ui/src/platform/KernelClient` 暴露**单参数**
 * `subscribe(listener)`；K01 桥的 `subscribe(caller, listener)` 需要被其包一层（调用方身份由
 * 协调者注入），本包不直接依赖 K01，避免跨线耦合。
 */
export interface TaskEventSource {
  subscribe(listener: (event: TaskEvent) => void): EventSubscription;
}

// ---------------------------------------------------------------------------
// 归约结果
// ---------------------------------------------------------------------------

/** 单条事件的处置码。 */
export type ReconcileCode =
  | 'applied' // 连续、受理，状态已推进
  | 'replay' // revision <= 当前：过期/重复/幂等重放，丢弃（不改状态）
  | 'gap' // revision > 当前+1：缺口，扣留并记 pendingResync
  | 'rejected' // reducer 拒收（非法迁移 / 内部对话类别等），带 errorCode
  | 'not-task-event' // metadata 无 taskId：非本域事件，忽略
  | 'unknown-task' // taskId 不是已知任务
  | 'buffer-overflow'; // 扣留缓冲达上限，丢弃并要求重同步

export interface ReconcileOutcome {
  readonly code: ReconcileCode;
  readonly taskId: string | null;
  readonly eventId: string | null;
  readonly revision: number | null;
  readonly seq: number | null;
  /** 仅 `code='rejected'`：reducer 抛出的错误码。 */
  readonly errorCode?: GroupErrorCode;
}

/**
 * 群组 + 事件流的合并状态。`state` 是纯视图状态（reducer 产出）；`pendingResync`/`held`
 * 是适配层为「批/乱序/缺口」维护的调度元数据，**不是**任务态的一部分。
 */
export interface GroupsStreamState {
  readonly state: GroupsState;
  /** 出现了 revision 缺口、需重同步的任务 id（升序去重）。 */
  readonly pendingResync: readonly string[];
  /** 已收到但尚不可受理的事件（按 revision 升序，按 eventId 去重，容量上限）。 */
  readonly held: Readonly<Record<string, readonly TaskEvent[]>>;
}

export interface ReconcileResult {
  readonly stream: GroupsStreamState;
  readonly outcomes: readonly ReconcileOutcome[];
  /** 本轮状态实际推进的任务 id（去重，按首次受理顺序）。 */
  readonly appliedTaskIds: readonly string[];
  /** 本轮结束后仍需重同步的任务 id（升序）。 */
  readonly needsResync: readonly string[];
  /** 是否有任务状态发生了推进。 */
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// 判定与排序工具
// ---------------------------------------------------------------------------

/**
 * 是否携带任务语义的事件（`metadata.taskId`/`kind`/`at` 齐全且为字符串）。
 * 事件流是**多域共享**的，本包只认领带 taskId 的事件，其余一律忽略（不抢别人的消息）。
 */
export function isTaskEvent(value: unknown): value is TaskEvent {
  if (typeof value !== 'object' || value === null) return false;
  const meta = (value as { metadata?: unknown }).metadata;
  if (typeof meta !== 'object' || meta === null) return false;
  const record = meta as Record<string, unknown>;
  return (
    typeof record.taskId === 'string' &&
    record.taskId !== '' &&
    typeof record.kind === 'string' &&
    typeof record.at === 'string'
  );
}

/** 从一批通用 v1 `Event` 中挑出任务事件（供调用方在原始流上预筛）。 */
export function selectTaskEvents(events: readonly Event[]): readonly TaskEvent[] {
  const out: TaskEvent[] = [];
  for (const event of events) if (isTaskEvent(event)) out.push(event);
  return out;
}

/** 确定性排序：revision 升序 → seq 升序 → eventId 升序（三级 tie-break，环境无关）。 */
function compareEvents(a: TaskEvent, b: TaskEvent): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/** 合并「已扣留」与「新到」事件：按 eventId 去重后稳定排序。 */
function mergeEvents(existing: readonly TaskEvent[], incoming: readonly TaskEvent[]): TaskEvent[] {
  const byId = new Map<string, TaskEvent>();
  for (const event of existing) byId.set(event.eventId, event);
  for (const event of incoming) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  return [...byId.values()].sort(compareEvents);
}

function outcomeOf(code: ReconcileCode, event: TaskEvent, errorCode?: GroupErrorCode): ReconcileOutcome {
  return {
    code,
    taskId: event.metadata.taskId,
    eventId: event.eventId,
    revision: event.revision,
    seq: event.seq,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function isGroupsStreamState(value: GroupsState | GroupsStreamState): value is GroupsStreamState {
  return typeof value === 'object' && value !== null && 'state' in value;
}

// ---------------------------------------------------------------------------
// 归约入口
// ---------------------------------------------------------------------------

/** 用一份视图状态初始化事件流状态（无扣留、无待重同步）。 */
export function createGroupsStream(state: GroupsState): GroupsStreamState {
  return { state, pendingResync: [], held: {} };
}

/**
 * 把一批（或单条）任务事件并入流状态。纯函数：同输入必得同输出，不读时钟。
 *
 * 对每个任务：合并「已扣留 + 新到」→ 反复取 `revision === 当前+1` 的连续事件喂给
 * `applyTaskEvent` → 剩余部分按 `replay` / `gap` / `buffer-overflow` 分类。任何 reducer
 * 抛出的 `GroupError` 都被本地捕获成 `rejected` 结果，**不**向上冒泡打断整批。
 */
export function reconcileTaskEvents(
  stream: GroupsStreamState,
  events: TaskEvent | readonly TaskEvent[],
): ReconcileResult {
  const incoming: readonly TaskEvent[] = Array.isArray(events) ? events : [events as TaskEvent];

  const outcomes: ReconcileOutcome[] = [];
  const perTask = new Map<string, TaskEvent[]>();

  for (const event of incoming) {
    if (!isTaskEvent(event)) {
      outcomes.push({ code: 'not-task-event', taskId: null, eventId: null, revision: null, seq: null });
      continue;
    }
    const taskId = event.metadata.taskId;
    if (getTask(stream.state, taskId) === null) {
      outcomes.push(outcomeOf('unknown-task', event));
      continue;
    }
    const bucket = perTask.get(taskId);
    if (bucket === undefined) perTask.set(taskId, [event]);
    else bucket.push(event);
  }

  let state = stream.state;
  const held: Record<string, readonly TaskEvent[]> = { ...stream.held };
  const pendingResync = new Set<string>(stream.pendingResync);
  const appliedTaskIds: string[] = [];

  for (const taskId of [...perTask.keys()].sort()) {
    const merged = mergeEvents(held[taskId] ?? [], perTask.get(taskId) ?? []);
    let queue = merged;
    let appliedHere = false;

    // 连续段：只喂 `revision === 当前 + 1` 的事件；缺口留给后面的分类。
    for (;;) {
      const task = getTask(state, taskId);
      if (task === null) break;
      const wanted = task.revision + 1;
      const nextIndex = queue.findIndex((event) => event.revision === wanted);
      if (nextIndex < 0) break;
      const event = queue[nextIndex];
      if (event === undefined) break;
      try {
        state = applyTaskEvent(state, event);
        outcomes.push(outcomeOf('applied', event));
        appliedHere = true;
        pendingResync.delete(taskId);
      } catch (error) {
        if (error instanceof GroupError) {
          // reducer 拒收（非法迁移 / 内部对话类别 / 时间戳非法…）：记录并丢弃，不重试。
          outcomes.push(outcomeOf('rejected', event, error.code));
        } else {
          throw error;
        }
      }
      queue = queue.filter((_, index) => index !== nextIndex);
    }

    // 余下事件：过期/重复 ⇒ replay；缺口 ⇒ 有界扣留 + 记 pendingResync。
    const current = getTask(state, taskId)?.revision ?? 0;
    const stillHeld: TaskEvent[] = [];
    for (const event of queue) {
      if (event.revision <= current) {
        outcomes.push(outcomeOf('replay', event));
      } else if (stillHeld.length < MAX_HELD_PER_TASK) {
        outcomes.push(outcomeOf('gap', event));
        stillHeld.push(event);
        pendingResync.add(taskId);
      } else {
        outcomes.push(outcomeOf('buffer-overflow', event));
        pendingResync.add(taskId);
      }
    }
    if (stillHeld.length > 0) held[taskId] = stillHeld;
    else delete held[taskId];

    if (appliedHere) appliedTaskIds.push(taskId);
  }

  const needsResync = [...pendingResync].sort();
  return {
    stream: { state, pendingResync: needsResync, held },
    outcomes,
    appliedTaskIds,
    needsResync,
    changed: appliedTaskIds.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 订阅绑定（有状态薄壳；逻辑全在上面这个纯函数里）
// ---------------------------------------------------------------------------

export interface GroupsStreamBinding {
  /** 当前流状态（含最新视图状态）。 */
  readonly stream: GroupsStreamState;
  /** 最近一次归约结果（尚未收到事件时为 null）。 */
  readonly lastResult: ReconcileResult | null;
  /** 已受理并归约的事件总数。 */
  readonly eventCount: number;
  unsubscribe(): void;
}

export interface BindGroupsOptions {
  /** 每次归约后回调（用于驱动渲染 / 触发重同步）。 */
  readonly onChange?: (result: ReconcileResult) => void;
}

/**
 * 把一个 `TaskEventSource` 绑到群组状态上。返回句柄可读 `stream` 并 `unsubscribe`。
 *
 * 注意：本绑定**不**处理事件流断开语义。群组视图没有「进度未知」标记（不像 F02 chat 的
 * `progressUnknown`），断流时应由协调者触发一次全量重拉（清空扣留 + 重取任务态），
 * 这属于 `platform/KernelClient` 的职责，不在本包编造状态。
 */
export function bindTaskEventStream(
  source: TaskEventSource,
  initial: GroupsState | GroupsStreamState,
  options: BindGroupsOptions = {},
): GroupsStreamBinding {
  let stream = isGroupsStreamState(initial) ? initial : createGroupsStream(initial);
  let lastResult: ReconcileResult | null = null;
  let eventCount = 0;
  let subscription: EventSubscription | undefined;

  const binding: GroupsStreamBinding = {
    get stream() {
      return stream;
    },
    get lastResult() {
      return lastResult;
    },
    get eventCount() {
      return eventCount;
    },
    unsubscribe() {
      subscription?.unsubscribe();
      subscription = undefined;
    },
  };

  subscription = source.subscribe((event) => {
    const result = reconcileTaskEvents(stream, event);
    stream = result.stream;
    lastResult = result;
    eventCount += 1;
    options.onChange?.(result);
  });

  return binding;
}
