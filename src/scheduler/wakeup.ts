/**
 * **给 D05 的注入式唤醒端口**（归属 D03；合同 v1.1 R16.2 补齐；任务书 §9.4、附录 B 末段）。
 *
 * ## 为什么要有这个端口
 *
 * D05（依赖解除与有限诊断）**不得** import `src/scheduler`：它只能通过**回调/端口**
 * 请求"某实例有新的可运行输入，请安排一次运行机会"。定义在这里、由 D05 的类型签名
 * 以结构兼容的方式镜像（D05 自己声明一份同形状的 interface 即可，无需依赖本模块）。
 *
 * ## 它补齐了 D02 明确缺的那一半（R16.2）
 *
 * D02 的 `markDependencyResolutionInput()` **只登记标记**：不置排队标记、不写
 * `dependency_resolved` 待投递事件。若没有本端口，依赖解除后的标记会停在"待消费"状态——
 * 实例既不排队也不被唤醒，A05 的"正常依赖到达后仍可继续"（A05-L-01）不成立。
 *
 * 本端口把三件事在同**一**事务里做完（§九-1 的一致提交）：
 * 1. 登记 `ActionableInputMark`（`source: 'dependency_resolution'`，Q5-c：不作为新消息入箱）；
 * 2. 写 `dependency_resolved` 待投递事件（outbox；提交后才发布，恢复时可重放）；
 * 3. 按附录 B 置排队标记（**合并语义**：已有活动轮次或已有排队标记时不再重复入队）。
 *
 * ## 合并的是运行机会，不是请求
 *
 * 实例正在跑时收到依赖解除：标记照样登记（它是"新的可运行输入"），但**不置排队标记**
 * （运行机会已被占用）；本轮结束时 `finish_run` 会因"仍有可运行输入"入队**至多一次**。
 * 结果是"运行中来三条解除仍保留三项工作"（§9.1）。
 */

import {
  findActionableInput,
  markDependencyResolutionInput,
  pendingActionableInputs,
  requireInstance,
} from '../inbox/index.js';
import type {
  ActionableInputMark,
  IdSource,
  InstanceId,
  KernelEvent,
  LogicalTime,
  PendingEvent,
  Revision,
  RunId,
  StorageTransaction,
  TaskId,
} from '../protocol/index.js';
import { SchedulerError } from './errors.js';
import { appendKernelEvent, enqueueDeliveryEvent } from './kernel-events.js';
import { markQueueFlagged } from './queue.js';

/** 通用唤醒：**有新的可运行输入**，请安排一次运行机会。 */
export interface WakeupRequest {
  /**
   * 该唤醒所属的任务（**必填**）。
   *
   * 为什么必填：待投递调度事件（outbox）必须携带 `task_id`（`PendingEvent.task_id`），
   * 而 `InstanceState` 不含任务身份（附录 A3 的字段清单里没有）。与其在这里
   * 编造一个 id，不如要求调用方给出它本来就知道的任务（D05 处理的工作项与消息都带 `task_id`）。
   */
  readonly task_id: TaskId;
  /** 被唤醒的实例。 */
  readonly instance_id: InstanceId;
  /** 人可读原因（证据可读性；不参与判定）。 */
  readonly reason: string;
  readonly at?: LogicalTime;
  /** 附加观测信息（原样进事件 `data`）。 */
  readonly label?: string;
}

/** 依赖解除唤醒（R16.2 的补齐路径）。 */
export interface DependencyWakeupRequest {
  readonly task_id: TaskId;
  readonly instance_id: InstanceId;
  /**
   * 依赖解除的引用 id（例如产出该结果的工作项 / 消息标识）。
   * 它是 `ActionableInputMark.ref_id`，会出现在下一轮的 `frozen_actionable_input_refs` 里。
   */
  readonly ref_id: string;
  /**
   * 该解除所属的任务版本（R37.3 的完整输入身份：`task_id + task_revision + 解除对象`）。
   * 省略时退化为裸 `ref_id`（保持向后兼容的调用方）。
   */
  readonly task_revision?: Revision;
  readonly reason?: string;
  readonly at?: LogicalTime;
}

/** 一次唤醒请求的结果。 */
export interface WakeupOutcome {
  readonly instance_id: InstanceId;
  /** 本事务写入的可运行输入标记（通用唤醒为 null）。 */
  readonly marked_actionable_input: ActionableInputMark | null;
  /** 本事务是否真的置位了排队标记。 */
  readonly queued: boolean;
  /** 是否因为"已有活动轮次或已有排队标记"而合并（未重复入队）。 */
  readonly merged: boolean;
  readonly observation_events: readonly KernelEvent[];
  readonly delivery_events: readonly PendingEvent[];
  /** 门面层填充：事务提交后实际发布的待投递事件。 */
  readonly published_events: readonly PendingEvent[];
}

/**
 * **D05 面向的端口**（结构兼容即可，D05 不必依赖本模块）。
 *
 * ```ts
 * // D05 侧（示意）
 * interface WakeupPort {                      // ← D05 自建同形状接口
 *   requestWakeup(request: {
 *     task_id: TaskId; instance_id: InstanceId; reason: string; at?: LogicalTime; label?: string;
 *   }): WakeupOutcome;
 *   wakeOnDependencyResolved(request: {
 *     task_id: TaskId; instance_id: InstanceId; ref_id: string; reason?: string; at?: LogicalTime;
 *   }): WakeupOutcome;
 * }
 * ```
 */
export interface SchedulerWakeupPort {
  requestWakeup(request: WakeupRequest): WakeupOutcome;
  wakeOnDependencyResolved(request: DependencyWakeupRequest): WakeupOutcome;
}

/** 事务内的通用唤醒。 */
export function requestWakeupInTransaction(
  tx: StorageTransaction,
  request: WakeupRequest,
  deps: { readonly idSource: IdSource; readonly at: LogicalTime },
): WakeupOutcome {
  const at = request.at ?? deps.at;
  const instance = requireInstance(tx, request.instance_id);
  const observationEvents: KernelEvent[] = [];
  const deliveryEvents: PendingEvent[] = [];

  const result = markQueueFlagged(tx, {
    instance,
    task_id: request.task_id,
    group_id: instance.group_id,
    at,
    delivery_kind: 'wakeup_queued',
    reason: request.reason,
    payload: {
      source: 'wakeup_request',
      ...(request.label === undefined ? {} : { label: request.label }),
    },
    event_ids: deps.idSource,
  });
  for (const event of result.kernel_events) {
    observationEvents.push(event);
  }
  if (result.pending_event !== null) {
    deliveryEvents.push(result.pending_event);
  }

  return Object.freeze({
    instance_id: instance.instance_id,
    marked_actionable_input: null,
    queued: result.queued,
    merged: result.merged,
    observation_events: Object.freeze(observationEvents),
    delivery_events: Object.freeze(deliveryEvents),
    published_events: Object.freeze([]),
  });
}

/**
 * 事务内的**依赖解除唤醒**（R16.2 的补齐）。
 *
 * 幂等：同一实例同一 `ref_id` 只登记一条标记（D02 的存储键唯一）——
 * 重复调用**不重复写** `dependency_resolved` 事件，但仍会补一次排队机会
 * （漏掉唤醒比重复一次唤醒更危险：重复唤醒被排队标记合并，漏唤醒则永久停摆）。
 */
export function wakeOnDependencyResolvedInTransaction(
  tx: StorageTransaction,
  request: DependencyWakeupRequest,
  deps: { readonly idSource: IdSource; readonly at: LogicalTime },
): WakeupOutcome {
  const at = request.at ?? deps.at;
  const instance = requireInstance(tx, request.instance_id);
  const observationEvents: KernelEvent[] = [];
  const deliveryEvents: PendingEvent[] = [];

  if (typeof request.ref_id !== 'string' || request.ref_id.length === 0) {
    throw new SchedulerError('依赖解除的可运行输入引用不能为空');
  }

  // **按完整输入身份判断幂等**（合同 v1.2 R37.3；修复 F10）。
  //
  // 旧实现只查 `pendingActionableInputs`（**未消费**的标记），于是"已经消费过的同一
  // ref_id 被重放"会被当成新输入：重新写 `dependency_resolved` 事件、重新置排队标记。
  // 实测同一解除通知在每轮结束后重放三次 → 3 轮 / 3 个解除事件，而实际只有一个标记被反复覆盖。
  //
  // 现在查 `findActionableInput`：**未消费与已消费都在内**。
  // - 完全没登记过 ⇒ 真正的新输入：写事件 + 置运行机会；
  // - 已登记但尚未消费 ⇒ 待处理的同一输入：不重复写事件（只是补一次排队机会，靠排队标记合并）；
  // - **已登记且已消费** ⇒ 旧通知重试：既不写事件、也不重新置运行机会，更不复位消费状态。
  const existing = findActionableInput(tx, instance.instance_id, request.ref_id);
  const consumedReplay = existing !== undefined && existing.consumed_in_run_id !== null;

  const mark = markDependencyResolutionInput(tx, {
    instance_id: instance.instance_id,
    ref_id: request.ref_id,
    at,
  });

  if (existing === undefined) {
    deliveryEvents.push(
      enqueueDeliveryEvent(
        tx,
        {
          kind: 'dependency_resolved',
          task_id: request.task_id,
          group_id: instance.group_id,
          instance_id: instance.instance_id,
          created_at: at,
          reason: request.reason ?? `依赖 ${request.ref_id} 已解除：产生新的可运行输入`,
          payload: {
            ref_id: request.ref_id,
            actionable_input_source: 'dependency_resolution',
            ...(request.task_revision === undefined
              ? {}
              : { task_revision: request.task_revision }),
          },
        },
        deps.idSource,
      ),
    );
  }

  // 两类事实、两条事件：`dependency_resolved`（上面那条，记录"依赖解除了"这一事实）
  // 与 `wakeup_queued`（下面这条，记录"置了运行机会"，仅真的入队时写）。
  // 不把二者合并成一条：合并后"运行中到达"的依赖解除就没有任何事件记录（被合并掉了）。
  const result = consumedReplay
    ? null
    : markQueueFlagged(tx, {
        instance,
        task_id: request.task_id,
        group_id: instance.group_id,
        at,
        delivery_kind: 'wakeup_queued',
        reason: request.reason ?? `依赖 ${request.ref_id} 已解除：安排一次运行机会`,
        payload: { ref_id: request.ref_id },
        event_ids: deps.idSource,
      });
  if (result !== null) {
    for (const event of result.kernel_events) {
      observationEvents.push(event);
    }
    if (result.pending_event !== null) {
      deliveryEvents.push(result.pending_event);
    }
  }

  return Object.freeze({
    instance_id: instance.instance_id,
    marked_actionable_input: mark,
    queued: result?.queued ?? false,
    merged: result === null ? true : result.merged,
    observation_events: Object.freeze(observationEvents),
    delivery_events: Object.freeze(deliveryEvents),
    published_events: Object.freeze([]),
  });
}

/** 只读辅助：该实例当前**未消费**的可运行输入引用（D05 判定"是否已有待处理解除"用）。 */
export function pendingActionableInputRefs(
  tx: StorageTransaction,
  instanceId: InstanceId,
): readonly string[] {
  return Object.freeze(pendingActionableInputs(tx, instanceId).map((mark) => mark.ref_id));
}

/** 只读辅助：把实例的排队/活动态读出来（D05/D07 的断言辅助）。 */
export function queuedFlagOf(
  tx: StorageTransaction,
  instanceId: InstanceId,
): {
  readonly queued: boolean;
  readonly queued_since: LogicalTime | null;
  readonly active_run_id: RunId | null;
} {
  const instance = requireInstance(tx, instanceId);
  return {
    queued: instance.queued_flag,
    queued_since: instance.queued_since,
    active_run_id: instance.active_run_id,
  };
}

/** 供 D05 判断"这次唤醒会不会被合并"：有活动轮次或已有排队标记时为真。 */
export function isWakeupMergedIntoActiveRun(tx: StorageTransaction, instanceId: InstanceId): boolean {
  const instance = requireInstance(tx, instanceId);
  return instance.active_run_id !== null || instance.queued_flag;
}
