/**
 * `FaultInjector` → D01 存储故障接缝的适配器（归属 D06，`src/fake/`）。
 *
 * 背景（合同第十节）：故障注入接缝的形态由「D01 存储接缝」与「D06 调度推进接缝」共同定。
 * D01 在 `src/protocol/storage.ts` 落地了 `MutableStoreFaultHooks`：三个**同步返回 `void`** 的
 * 可选钩子，默认全部未设置（即默认关闭），挂在 `StoreOptions.faults` 上。
 *
 * 本模块把它们接到 `FaultInjector` 上：
 *
 * | D01 钩子 | 默认注入点 | P2 注入点 | 失败时的语义 |
 * |---|---|---|---|
 * | `beforeCommit` | `message.persist` | W2 | 事务回滚 → 存储抛 `PersistenceError`（**未接受**） |
 * | `afterCommitBeforePublish` | `scheduling.event.persist` | W1 | 事务已提交 → 存储抛 `PublicationError`（**已接受**，可重放） |
 * | `beforePublishEvent` | `execution.enqueue` | W3 | 单条事件投递失败 → 可通过 `replayUndelivered()` 补投 |
 *
 * 因为这三个钩子是**同步**的，这里一律走 `FaultInjector.tripSync()`——异步抛错无法同步传播。
 * `pause` 行为不能挂在同步钩子上（`tripSync` 会显式拒绝），需要停顿请用调度推进接缝的闸门。
 *
 * 本模块同时提供**恢复流的夹具侧封装**（`attemptRecovery` / `runRecoveryAttempts`）：
 * 覆盖 `Store.publishPending` / `Store.replayUndelivered` 两条恢复路径，并把每次尝试的结果
 * （补投了几条、是否报错）变成可追踪证据——P2 要求「连续两次恢复，第二次应为无待办」。
 */

import type {
  EventId,
  Store,
  DeliveryHandler,
  MutableStoreFaultHooks,
  PendingEvent,
  StorageTransaction,
  TransactionSummary,
} from '../protocol/index.js';
import { FaultInjector, INJECTION_POINTS, type InjectionPoint } from './fault-injection.js';

/** 三个钩子各自绑定的注入点（默认取本模块定义的三点常量）。 */
export interface StoreFaultHookOptions {
  readonly beforeCommit?: InjectionPoint;
  readonly afterCommitBeforePublish?: InjectionPoint;
  readonly beforePublishEvent?: InjectionPoint;
}

/** 三个钩子的默认注入点映射（与 `INJECTION_POINTS` 同名同义）。 */
export const STORE_HOOK_POINTS: Readonly<Required<StoreFaultHookOptions>> = Object.freeze({
  beforeCommit: INJECTION_POINTS.messagePersist,
  afterCommitBeforePublish: INJECTION_POINTS.schedulingEventPersist,
  beforePublishEvent: INJECTION_POINTS.executionEnqueue,
});

/**
 * 构造 `StoreOptions.faults` 用的三个同步钩子。
 *
 * **未启用注入时三个钩子都是空操作**——注入器默认关闭，本函数不会改变默认行为。
 * 用法（仅隔离测试配置）：
 * ```ts
 * const injector = new FaultInjector({ isolated: true, scenario: 'P2-W1' });
 * injector.register({ point: INJECTION_POINTS.schedulingEventPersist, behavior: 'interrupt',
 *   committed: ['message.persisted'], pending: ['queue.marked', 'scheduling.event.persisted'] });
 * const store = createMemoryStore({ faults: storeFaultHooks(injector) });
 * ```
 */
export function storeFaultHooks(
  injector: FaultInjector,
  options: StoreFaultHookOptions = {},
): MutableStoreFaultHooks {
  const beforeCommitPoint = options.beforeCommit ?? STORE_HOOK_POINTS.beforeCommit;
  const afterCommitPoint = options.afterCommitBeforePublish ?? STORE_HOOK_POINTS.afterCommitBeforePublish;
  const beforePublishPoint = options.beforePublishEvent ?? STORE_HOOK_POINTS.beforePublishEvent;

  return {
    beforeCommit: (summary: TransactionSummary, _tx: StorageTransaction): void => {
      injector.tripSync(beforeCommitPoint, transactionContext('beforeCommit', summary));
    },
    afterCommitBeforePublish: (summary: TransactionSummary): void => {
      injector.tripSync(afterCommitPoint, transactionContext('afterCommitBeforePublish', summary));
    },
    beforePublishEvent: (event: PendingEvent): void => {
      injector.tripSync(beforePublishPoint, {
        hook: 'beforePublishEvent',
        event_id: event.event_id,
        event_kind: event.kind,
        delivered: event.delivered,
      });
    },
  };
}

/** 把事务摘要折成注入证据里的上下文（保留标识，便于追溯哪条消息被中断）。 */
function transactionContext(
  hook: string,
  summary: TransactionSummary,
): Readonly<Record<string, unknown>> {
  return {
    hook,
    message_ids: [...summary.message_ids],
    request_ids: [...summary.request_ids],
    instance_ids: [...summary.instance_ids],
    event_ids: [...summary.event_ids],
  };
}

/** 一次恢复尝试的结果（证据）。 */
export interface RecoveryRun {
  /** 第几次恢复，从 1 开始。 */
  readonly attempt: number;
  /** 恢复前未投递事件数。 */
  readonly pending_before: number;
  /** 本次补投成功的事件数。 */
  readonly published: number;
  /** 补投成功的事件 id。 */
  readonly published_event_ids: readonly EventId[];
  /** 恢复后仍未投递的事件数；**第二次恢复应为 0**（P2-04）。 */
  readonly pending_after: number;
  /** 本次是否失败（被注入中断）；失败不算崩溃，属预期窗口。 */
  readonly failed: boolean;
  readonly error_name: string | null;
  readonly error_message: string | null;
  /** 使用的恢复入口。 */
  readonly via: 'replayUndelivered' | 'publishPending';
}

/**
 * 执行**一次**恢复：调用 `Store.replayUndelivered()`（Q6-b 的恢复路径）并记录结果。
 *
 * 恢复失败（`PublicationError`）被**记录**而非抛出——恢复窗口本身就是被测对象，
 * 夹具需要「先失败一次，再恢复成功」的脚本化序列。其它异常原样抛出。
 */
export function attemptRecovery(
  store: Store,
  deliver: DeliveryHandler,
  options: { readonly via?: RecoveryRun['via']; readonly attempt?: number } = {},
): RecoveryRun {
  const via = options.via ?? 'replayUndelivered';
  const pendingBefore = store.pendingDeliveryEvents();
  const pendingBeforeIds = new Set<EventId>(pendingBefore.map((event) => event.event_id));
  const attempt = options.attempt ?? 1;

  const publishedIds: EventId[] = [];
  const countingDeliver: DeliveryHandler = (event) => {
    deliver(event);
    publishedIds.push(event.event_id);
  };

  let error: unknown = null;
  try {
    if (via === 'replayUndelivered') {
      store.replayUndelivered(countingDeliver);
    } else {
      store.publishPending(countingDeliver);
    }
  } catch (caught) {
    error = caught;
  }

  const pendingAfter = store.pendingDeliveryEvents();
  // 只有「恢复前确实待投递」的事件才算数，避免把无关事件计进来。
  const published = publishedIds.filter((id) => pendingBeforeIds.has(id)).length;

  return {
    attempt,
    pending_before: pendingBefore.length,
    published,
    published_event_ids: [...publishedIds],
    pending_after: pendingAfter.length,
    failed: error !== null,
    error_name: error instanceof Error ? error.name : error === null ? null : typeof error,
    error_message: error instanceof Error ? error.message : error === null ? null : String(error),
    via,
  };
}

/**
 * 连续执行 `attempts` 次恢复（P2 要求至少两次：第二次应表现为「无待办」，不得多建业务工作）。
 * 每一次的结果都留在返回数组里，作为证据。
 */
export function runRecoveryAttempts(
  store: Store,
  deliver: DeliveryHandler,
  attempts = 2,
  options: { readonly via?: RecoveryRun['via'] } = {},
): readonly RecoveryRun[] {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`恢复次数必须是 ≥ 1 的整数，收到 ${String(attempts)}`);
  }
  const runs: RecoveryRun[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    runs.push(
      attemptRecovery(store, deliver, {
        attempt,
        ...(options.via === undefined ? {} : { via: options.via }),
      }),
    );
  }
  return runs;
}
