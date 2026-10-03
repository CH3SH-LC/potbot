/**
 * 存储的具体实现之一：进程内、单文件语义的**事务化内存存储**（D01）。
 *
 * 为什么是内存实现：合同 §一 Q6-d 选定 outbox 式"同一事务内的待投递事件记录"，
 * 单进程 + 单存储下用同一事务即可满足；guide:62 明确首轮只做"保存后未入队"的假恢复，
 * 不做 A10 完整应用重启。因此本实现提供**与真实事务相同的提交/回滚边界**，
 * 但持久化介质是可被测试完整观测的内存结构——接缝形状已按可替换实现设计。
 *
 * **它是 `Store` 接口的"易失"实现，不是落盘实现**：进程退出即空。
 * 需要跨重启/跨进程的持久语义请用同目录的 `file-store.ts`（`createFileStore`）；
 * 两者共享 `store-core.ts` 的事务机制，读侧口径一致（R214–R220 要求
 * 「不把 Map 落库称为完整恢复」，反过来说内存版也不得冒充持久版）。
 *
 * 事务语义：
 * - 写入只经 `transact()`；事务用**写时复制**（clone-on-write）+ 提交时原子替换，
 *   因此事务内任何抛错都不会留下半成品状态。
 * - 提交失败 → `PersistenceError`（`accepted === false`）：**不得报告消息已接受**（合同 §九-1）。
 * - 提交成功但发布前中断 → `PublicationError`（`accepted === true`）：消息已可靠保存，
 *   事件仍在 outbox，调用方走 `replayUndelivered()`。
 */

import {
  asLogicalTime,
  PersistenceError,
  PublicationError,
  type DeliveryHandler,
  type EventId,
  type LogicalTime,
  type MutableStoreFaultHooks,
  type PendingEvent,
  type StorageTransaction,
  type Store,
  type StoreOptions,
  type StoreSnapshot,
} from '../protocol/index.js';

import {
  cloneState,
  emptyState,
  markDeliveredIn,
  pendingEventsOf,
  snapshotOf,
  TouchTracker,
  TransactionView,
  type StoreState,
} from './store-core.js';

/** 内存存储实现。用 `createMemoryStore()` 构造；不建议直接 new。 */
class MemoryStore implements Store {
  private state: StoreState = emptyState();
  private inTransaction = false;
  private readonly clock: () => LogicalTime;
  readonly faults: MutableStoreFaultHooks;

  constructor(options: StoreOptions = {}) {
    this.clock = options.clock ?? (() => asLogicalTime(0));
    this.faults = options.faults ?? {};
  }

  private now(): LogicalTime {
    return this.clock();
  }

  transact<T>(work: (tx: StorageTransaction) => T): T {
    if (this.inTransaction) {
      throw new PersistenceError('不支持嵌套事务：请把写入合并到同一个 transact() 调用内');
    }
    this.inTransaction = true;
    const draft = cloneState(this.state);
    const touched = new TouchTracker();
    const tx = new TransactionView(draft, touched);

    let result: T;
    try {
      result = work(tx);
    } catch (error) {
      this.inTransaction = false;
      // 事务内任何抛错都意味着"未提交任何改动（未接受）"，统一以 `PersistenceError` 报出
      // （`accepted === false`；原始错误保留在 `cause` 里，不丢失细节）。
      // 这是既有接口行为，D02 的去重/快照测试依赖它，第二轮不改。
      throw error instanceof PersistenceError
        ? error
        : new PersistenceError('事务回滚：未提交任何改动（未接受）', { cause: error });
    }

    const summary = touched.summary();

    // 接缝 1：提交前 —— 抛错即"未接受"。
    try {
      this.faults.beforeCommit?.(summary, tx);
    } catch (error) {
      this.inTransaction = false;
      throw new PersistenceError('提交前故障注入：事务未提交（未接受）', { cause: error });
    }

    this.state = draft;
    this.inTransaction = false;

    // 接缝 2：提交后、投递前 —— 已接受，但事件仍待投递（P2 的故障窗口）。
    try {
      this.faults.afterCommitBeforePublish?.(summary);
    } catch (error) {
      throw new PublicationError(
        '事务已提交（消息已可靠保存），但发布前中断：待投递事件可由 replayUndelivered() 恢复',
        this.pendingEventIds(),
        { cause: error },
      );
    }

    return result;
  }

  snapshot(): StoreSnapshot {
    return snapshotOf(this.state);
  }

  pendingDeliveryEvents(): readonly PendingEvent[] {
    return pendingEventsOf(this.state);
  }

  private pendingEventIds(): readonly EventId[] {
    return Object.freeze(this.pendingDeliveryEvents().map((event) => event.event_id));
  }

  markDelivered(eventIds: readonly EventId[], at?: LogicalTime): number {
    const stamp = at ?? this.now();
    return this.applyInternal((draft) => markDeliveredIn(draft, eventIds, stamp));
  }

  publishPending(handler: DeliveryHandler): readonly PendingEvent[] {
    const pending = this.pendingDeliveryEvents();
    const published: PendingEvent[] = [];
    for (const event of pending) {
      try {
        this.faults.beforePublishEvent?.(event);
        handler(event);
      } catch (error) {
        throw new PublicationError(
          `投递事件 ${event.event_id} 失败：事务已提交（已接受），事件仍待投递`,
          this.pendingEventIds(),
          { cause: error },
        );
      }
      this.markDelivered([event.event_id]);
      published.push(event);
    }
    return Object.freeze(published);
  }

  replayUndelivered(handler: DeliveryHandler): readonly PendingEvent[] {
    return this.publishPending(handler);
  }

  reset(): void {
    this.state = emptyState();
    this.inTransaction = false;
  }

  /**
   * 内部维护性写入（如标记已投递）：不触发故障接缝，避免恢复路径被注入再次打断。
   */
  private applyInternal<T>(work: (draft: StoreState) => T): T {
    if (this.inTransaction) {
      throw new PersistenceError('不支持嵌套事务');
    }
    const draft = cloneState(this.state);
    const result = work(draft);
    this.state = draft;
    return result;
  }
}

/** 构造内存存储。`options.clock` 由 D06 的可控时钟注入（Q8-a）。 */
export function createMemoryStore(options: StoreOptions = {}): Store {
  return new MemoryStore(options);
}
