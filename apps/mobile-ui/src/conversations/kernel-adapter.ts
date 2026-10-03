/**
 * F03 conversations —— 把会话命令接到 `KernelClient`、把内核事件接回 `applyConversationUpdate`。
 *
 * 本包此前只**构造** v1 命令对象（`commands.ts`）**不投递**、也不订阅事件流（见 README「未做」）。
 * 本文件补上这条接线，仍然是零框架、纯逻辑（网络 I/O 全部通过注入的端口）：
 *
 *   命令方向（`commands.ts` → `KernelClient`）：
 *     {@link dispatchConversationCommand} 先按 `commandId` **订阅**、再 `sendCommand`，把中间事件
 *     交给 `onEvent`，把断流交给 `onBreak`（断流恒为 `progressUnknown`，绝不升级为成功）；
 *     结束后退订。发送前先用 `assertConversationCommand` 校验分支不变量，形状不合法的命令**不投递**。
 *
 *   事件方向（内核事件 → `applyConversationUpdate`）：
 *     {@link reconcileConversationEvents} 把一批（或单条）内核 `Event` 归约进会话视图状态。
 *     reducer 的硬不变量（I3）要求 revision **恰好 +1**，而真实事件流不保证：
 *     因此按 (revision, seq, eventId) 稳定排序、只喂**连续前缀**，缺口**扣留**（有界）并记
 *     `pendingResync`，迟到补齐后自动续上；过期/重复记为 `replay` 丢弃。**绝不**伪造 revision、
 *     不静默丢事件、不绕过 `applyConversationUpdate`。
 *
 * 端口与边界：命令端口 `ConversationCommandPort` 的**结构化形状与 `KernelClient` 一致**
 * （`sendCommand` + 按 `commandId` 的 `subscribe`），因此真实 `KernelClient` 可直接传入，
 * 本包不 import `platform/**`，避免跨线耦合。事件源 `ConversationEventSource` 是**单参数**
 * 全局订阅；`KernelClient` 目前只提供**按命令**订阅，故「全局事件源」由 F 线协调者包一层
 * （把每个在飞命令的事件汇聚成一条流）——这一点属未接线（见 README 与 integrationRequests）。
 *
 * 未做（不得当成已完成）：真实桥通道 / 心跳 / 持久化 / 重连；事件 revision 流是否与本地
 * `ConversationView.revision` 逐 +1 对齐**未经真实内核验证**（本包只**断言**该假设并隔离缺口，
 * 不替内核决定）。渲染层未实现。
 */

import { assertConversationCommand } from './commands.js';
import { applyConversationUpdate } from './actions.js';
import { getConversation } from './state.js';
import { ConversationError, type ConversationLifecycle, type ConversationsState } from './types.js';
import type { Command, Event, EventStatus, VerificationMode } from '../../../../contracts/mobile-v1/types.js';

/** 每个会话扣留的事件条数上限；超出即 `buffer-overflow`（要求重同步，不无限增长）。 */
export const MAX_HELD_PER_CONVERSATION = 64;

// ---------------------------------------------------------------------------
// 端口（结构性；F 线协调者的 `platform/KernelClient` 需满足）
// ---------------------------------------------------------------------------

/** 订阅句柄。只要求 `unsubscribe`，兼容 `KernelClient.subscribe` 返回的 `() => void`... 见下。 */
export interface EventSubscription {
  unsubscribe(): void;
}

/**
 * 命令端口：`sendCommand` 返回终局事件的规范化回执。
 * 结构与 `platform.KernelClient.sendCommand` 返回的 `CommandReceipt` 一致（无需 import platform）。
 */
export interface ConversationCommandReceipt {
  readonly commandId: string;
  readonly event: Event;
  readonly status: EventStatus;
  readonly resultRef: string | null;
  readonly revision: number;
  readonly verificationMode: VerificationMode;
  readonly idempotentReplay: boolean;
}

/** 断流信息。`status` 恒为 `progressUnknown`：断流只表示结果未知，不是失败也不是成功。 */
export interface ConversationStreamBreak {
  readonly commandId: string;
  readonly reason: string;
  readonly status: 'progressUnknown';
  readonly detail: string;
  readonly lastEvent: Event | null;
}

/** 命令端口：真实 `KernelClient` 直接满足（`subscribe` 返回 `() => void`）。 */
export interface ConversationCommandPort {
  sendCommand(command: Command): Promise<ConversationCommandReceipt>;
  /** 按 `commandId` 订阅该命令的事件流；返回退订函数（不返回句柄对象）。 */
  subscribe(commandId: string, onEvent: (event: Event) => void, onBreak: (info: ConversationStreamBreak) => void): () => void;
}

/**
 * 全局事件源。F 线协调者需在 `platform/KernelClient` 之上包一层，把各在飞命令的事件
 * 汇聚成一条全局流（`KernelClient` 目前只按命令订阅）。本包不直接依赖 K01 桥。
 */
export interface ConversationEventSource {
  subscribe(listener: (event: Event) => void): EventSubscription;
}

// ---------------------------------------------------------------------------
// 命令方向：commands.ts → KernelClient
// ---------------------------------------------------------------------------

export interface ConversationCommandListener {
  readonly onEvent?: (event: Event) => void;
  readonly onBreak?: (info: ConversationStreamBreak) => void;
}

/**
 * 投递一条会话命令：先订阅（避免竞态漏掉早期事件）、再 `sendCommand`，返回终局回执。
 * - 发送前 `assertConversationCommand` 校验分支不变量（形状不合法 ⇒ 抛 `ConversationError`，不投递）；
 * - 订阅失败 ⇒ 记为 `submit-rejected` 的 `progressUnknown` 并抛出（绝不吞掉）；
 * - 无论成功/失败都退订（不泄漏监听器）。
 */
export async function dispatchConversationCommand(
  port: ConversationCommandPort,
  command: Command,
  listener: ConversationCommandListener = {},
): Promise<ConversationCommandReceipt> {
  assertConversationCommand(command);
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = port.subscribe(
      command.commandId,
      (event) => listener.onEvent?.(event),
      (info) => listener.onBreak?.(info),
    );
  } catch (error) {
    listener.onBreak?.({
      commandId: command.commandId,
      reason: 'submit-rejected',
      status: 'progressUnknown',
      detail: `订阅失败，命令未投递：${error instanceof Error ? error.message : String(error)}`,
      lastEvent: null,
    });
    throw error;
  }
  try {
    return await port.sendCommand(command);
  } finally {
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// 事件方向：内核事件 → applyConversationUpdate
// ---------------------------------------------------------------------------

/** 事件携带的会话 id（`metadata.conversationId`）；非本域事件返回 null。 */
export function conversationIdOfEvent(event: Event): string | null {
  const meta = event.metadata;
  if (typeof meta !== 'object' || meta === null) return null;
  const cid = (meta as Record<string, unknown>).conversationId;
  return typeof cid === 'string' && cid !== '' ? cid : null;
}

/** 是否携带会话语义的事件（事件流是**多域共享**的，本包只认领带 conversationId 的事件）。 */
export function isConversationEvent(event: Event): boolean {
  return conversationIdOfEvent(event) !== null;
}

/** 从事件 `metadata` 派生一次会话更新 patch（白名单字段；缺省即不改该字段）。 */
export function conversationPatchOf(event: Event): {
  title?: string;
  snippet?: string;
  lifecycle?: ConversationLifecycle;
  lastActiveAt?: string;
} {
  const meta = event.metadata;
  const patch: { title?: string; snippet?: string; lifecycle?: ConversationLifecycle; lastActiveAt?: string } = {};
  if (typeof meta !== 'object' || meta === null) return patch;
  const rec = meta as Record<string, unknown>;
  if (typeof rec.title === 'string') patch.title = rec.title;
  if (typeof rec.snippet === 'string') patch.snippet = rec.snippet;
  if (typeof rec.lifecycle === 'string') patch.lifecycle = rec.lifecycle as ConversationLifecycle;
  if (typeof rec.lastActiveAt === 'string') patch.lastActiveAt = rec.lastActiveAt;
  return patch;
}

/** 单条事件的处置码。 */
export type ConversationReconcileCode =
  | 'applied' // 连续、受理，状态已推进
  | 'replay' // revision <= 当前：过期/重复/幂等重放，丢弃（不改状态）
  | 'gap' // revision > 当前+1：缺口，扣留并记 pendingResync
  | 'rejected' // reducer 拒收（非法字段等），带 errorCode
  | 'not-conversation-event' // metadata 无 conversationId：非本域事件，忽略
  | 'unknown-conversation' // conversationId 不是已知会话
  | 'buffer-overflow'; // 扣留缓冲达上限，丢弃并要求重同步

export interface ConversationReconcileOutcome {
  readonly code: ConversationReconcileCode;
  readonly conversationId: string | null;
  readonly eventId: string | null;
  readonly revision: number | null;
  readonly seq: number | null;
  /** 仅 `code='rejected'`：reducer 抛出的错误码。 */
  readonly errorCode?: ConversationError['code'];
}

/**
 * 会话 + 事件流的合并状态。`state` 是纯视图状态；`pendingResync`/`held` 是适配层为
 * 「乱序/缺口」维护的调度元数据，**不是**会话态的一部分。
 */
export interface ConversationsStreamState {
  readonly state: ConversationsState;
  /** 出现了 revision 缺口、需重同步的会话 id（升序去重）。 */
  readonly pendingResync: readonly string[];
  /** 已收到但尚不可受理的事件（按 revision 升序，按 eventId 去重，容量上限）。 */
  readonly held: Readonly<Record<string, readonly Event[]>>;
}

export interface ReconcileResult {
  readonly stream: ConversationsStreamState;
  readonly outcomes: readonly ConversationReconcileOutcome[];
  /** 本轮状态实际推进的会话 id（去重，按首次受理顺序）。 */
  readonly appliedConversationIds: readonly string[];
  /** 本轮结束后仍需重同步的会话 id（升序）。 */
  readonly needsResync: readonly string[];
  readonly changed: boolean;
}

/** 确定性排序：revision 升序 → seq 升序 → eventId 升序（环境无关）。 */
function compareEvents(a: Event, b: Event): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

function mergeEvents(existing: readonly Event[], incoming: readonly Event[]): Event[] {
  const byId = new Map<string, Event>();
  for (const event of existing) byId.set(event.eventId, event);
  for (const event of incoming) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  return [...byId.values()].sort(compareEvents);
}

function outcomeOf(
  code: ConversationReconcileCode,
  event: Event,
  conversationId: string | null,
  errorCode?: ConversationError['code'],
): ConversationReconcileOutcome {
  return {
    code,
    conversationId,
    eventId: event.eventId,
    revision: event.revision,
    seq: event.seq,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function isStreamState(value: ConversationsState | ConversationsStreamState): value is ConversationsStreamState {
  return typeof value === 'object' && value !== null && 'state' in value;
}

/** 用一份视图状态初始化事件流状态（无扣留、无待重同步）。 */
export function createConversationsStream(state: ConversationsState): ConversationsStreamState {
  return { state, pendingResync: [], held: {} };
}

/**
 * 把一批（或单条）内核事件并入流状态。纯函数：同输入必得同输出，不读时钟。
 *
 * 对每个会话：合并「已扣留 + 新到」→ 反复取 `revision === 当前+1` 的连续事件喂给
 * `applyConversationUpdate`（patch 由 `conversationPatchOf` 派生）→ 剩余按 `replay`/`gap`/
 * `buffer-overflow` 分类。reducer 抛出的 `ConversationError` 被本地捕获成 `rejected`，
 * **不**向上冒泡打断整批。
 */
export function reconcileConversationEvents(
  stream: ConversationsStreamState,
  events: Event | readonly Event[],
): ReconcileResult {
  const incoming: readonly Event[] = Array.isArray(events) ? events : [events as Event];

  const outcomes: ConversationReconcileOutcome[] = [];
  const perConversation = new Map<string, Event[]>();

  for (const event of incoming) {
    const conversationId = conversationIdOfEvent(event);
    if (conversationId === null) {
      outcomes.push(outcomeOf('not-conversation-event', event, null));
      continue;
    }
    if (getConversation(stream.state, conversationId) === null) {
      outcomes.push(outcomeOf('unknown-conversation', event, conversationId));
      continue;
    }
    const bucket = perConversation.get(conversationId);
    if (bucket === undefined) perConversation.set(conversationId, [event]);
    else bucket.push(event);
  }

  let state = stream.state;
  const held: Record<string, readonly Event[]> = { ...stream.held };
  const pendingResync = new Set<string>(stream.pendingResync);
  const appliedConversationIds: string[] = [];

  for (const conversationId of [...perConversation.keys()].sort()) {
    const merged = mergeEvents(held[conversationId] ?? [], perConversation.get(conversationId) ?? []);
    let queue = merged;
    let appliedHere = false;

    for (;;) {
      const view = getConversation(state, conversationId);
      if (view === null) break;
      const wanted = view.revision + 1;
      const nextIndex = queue.findIndex((event) => event.revision === wanted);
      if (nextIndex < 0) break;
      const event = queue[nextIndex];
      if (event === undefined) break;
      try {
        state = applyConversationUpdate(state, {
          conversationId,
          expectedRevision: view.revision,
          patch: conversationPatchOf(event),
        });
        outcomes.push(outcomeOf('applied', event, conversationId));
        appliedHere = true;
        pendingResync.delete(conversationId);
      } catch (error) {
        if (error instanceof ConversationError) {
          outcomes.push(outcomeOf('rejected', event, conversationId, error.code));
        } else {
          throw error;
        }
      }
      queue = queue.filter((_, index) => index !== nextIndex);
    }

    const current = getConversation(state, conversationId)?.revision ?? 0;
    const stillHeld: Event[] = [];
    for (const event of queue) {
      if (event.revision <= current) {
        outcomes.push(outcomeOf('replay', event, conversationId));
      } else if (stillHeld.length < MAX_HELD_PER_CONVERSATION) {
        outcomes.push(outcomeOf('gap', event, conversationId));
        stillHeld.push(event);
        pendingResync.add(conversationId);
      } else {
        outcomes.push(outcomeOf('buffer-overflow', event, conversationId));
        pendingResync.add(conversationId);
      }
    }
    if (stillHeld.length > 0) held[conversationId] = stillHeld;
    else delete held[conversationId];

    if (appliedHere) appliedConversationIds.push(conversationId);
  }

  const needsResync = [...pendingResync].sort();
  return {
    stream: { state, pendingResync: needsResync, held },
    outcomes,
    appliedConversationIds,
    needsResync,
    changed: appliedConversationIds.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 订阅绑定（有状态薄壳；逻辑全在上面这个纯函数里）
// ---------------------------------------------------------------------------

export interface ConversationsStreamBinding {
  readonly stream: ConversationsStreamState;
  readonly lastResult: ReconcileResult | null;
  readonly eventCount: number;
  unsubscribe(): void;
}

export interface BindConversationsOptions {
  readonly onChange?: (result: ReconcileResult) => void;
}

/**
 * 把一个 `ConversationEventSource` 绑到会话状态上。返回句柄可读 `stream` 并 `unsubscribe`。
 *
 * 注意：本绑定**不**处理事件流断开语义（会话视图没有「进度未知」标记）；断流时应由协调者
 * 触发一次全量重拉（清空扣留 + 重取会话态），这属于 `platform/KernelClient` 的职责。
 */
export function bindConversationEventStream(
  source: ConversationEventSource,
  initial: ConversationsState | ConversationsStreamState,
  options: BindConversationsOptions = {},
): ConversationsStreamBinding {
  let stream = isStreamState(initial) ? initial : createConversationsStream(initial);
  let lastResult: ReconcileResult | null = null;
  let eventCount = 0;
  let subscription: EventSubscription | undefined;

  const binding: ConversationsStreamBinding = {
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
    const result = reconcileConversationEvents(stream, event);
    stream = result.stream;
    lastResult = result;
    eventCount += 1;
    options.onChange?.(result);
  });

  return binding;
}
