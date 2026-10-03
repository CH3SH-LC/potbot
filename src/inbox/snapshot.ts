/**
 * 输入快照冻结 + "已读"记录 + "依赖解除"可运行输入（合同 Q5-a / Q5-b / Q5-c、§九-5；
 * 任务书 §9.2/§9.4、附录 B 的 `start_run`）。
 *
 * 三条被冻结的语义，本文件是它们的**唯一落地处**：
 * 1. **Q5-a 冻结判定点**：冻结发生在 `start_run` 事务内，与抢占、run_id 分配、租约**同一事务**。
 *    冻结即"读当前收件箱 + 当前未消费的可运行输入"；**冻结之后到达的消息天然不属于本轮**
 *    （它们落在后续事务里，只能进后续轮次）。
 * 2. **Q5-b「已读」≠「已完成」**：本文件写的是 `ReadReceipt`（读即标记）与实例的
 *    `consumed_message_ids`；**绝不触碰 `WorkItem.status`**——那是 D04 的显式结局。
 * 3. **Q5-c 依赖解除的输入形态**：依赖解除作为"新的可运行输入"标记（`ActionableInputMark`）
 *    进入下一轮快照，**不作为新消息入箱**（无 `GroupMessage`、无 `InboxEntry`、不参与去重）。
 *
 * 本轮快照的内容 = 该实例**未读的收件箱条目** ∪ **未消费的可运行输入标记**。
 * 前者给出 `frozen_input_message_ids`，后者给出 `frozen_actionable_input_refs`；
 * `frozen_request_ids` 由被冻结消息携带的 `request_id` 去重得到。三者的载体是 `RunRecord`，
 * 由 D03 在同一个事务内用本模块的返回值构造。
 *
 * **R2 的两分**：快照读入**全部未读消息**（含 `requires_wakeup=false` 的公共进度，
 * 它们不会被剩下、也不会被遗漏），但"**是否值得为它起一轮**"只看 `wakingInboxEntries()`。
 * 二者不可混用：混用会分别导致空转（把公共进度当运行机会）或消息永久滞留（把它排除在读入之外）。
 *
 * ## 修复批增量（v1.2 R37.1 / R37.3）
 *
 * **F04 群作用域**：本文件的**所有**消息查询都走 `tx.getMessageInGroup(group_id, message_id)`，
 * 群身份取自**收件箱条目**（`InboxEntry.group_id`）。全局 `getMessage()` 在"同 id 跨群复用"
 * （合法，R6/Q1-d）时会抛歧义错，不得用于本文件。
 *
 * **F09 历史消息保存但不获运行资格**：这里要分清两个**不同的问题**（三者不可混用）：
 * - **快照内容**（能不能被读入本轮）→ `unreadInboxEntries()` / `computeFrozenInput()`：
 *   **未读即读入**，含陈旧历史消息与公共进度，**语义不变**（陈旧消息仍被保存、仍会被读入）。
 * - **执行资格**（值不值得为它起一轮）→ `wakingInboxEntries()` / `hasRunnableInput()`：
 *   `requires_wakeup` 为真**且**版本有效（`isRunnableInputEntry`）。
 *   版本低于当前任务版本的陈旧消息**不获得运行资格**：它仍留在收件箱里，但不会让实例
 *   起一轮空转（R37.3 第 1 条）。判据的"当前版本"与入口 `validateRouting` 的 stale 判据同源
 *   （`TaskRecord.revision`）；任务未注册时无法判定 ⇒ 不判陈旧（有则从严、无则放行）。
 *
 * **F10 已消费解除通知幂等**：依赖解除输入的**完整身份** = `task_id + task_revision + 解除对象`，
 * 由 **D05 的 `resolutionInputRefId` 唯一编码**（本模块不自带第二套编码器）。
 * 已消费的同一身份**不得**因重放被重置为未消费（`markDependencyResolutionInput` 幂等），
 * 真正的新解除事件（版本/对象不同）仍产生新输入。
 */

import {
  createActionableInputMark,
  createKernelEvent,
  createReadReceipt,
  ValidationError,
  type ActionableInputMark,
  type EventIdSource,
  type InboxEntry,
  type InstanceId,
  type KernelEvent,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type RunId,
  type StorageTransaction,
  type TaskId,
} from '../protocol/index.js';
import { appendUnique, patchInstance, requireInstance } from './instance-state.js';

export interface FreezeInputRequest {
  readonly instance_id: InstanceId;
  readonly run_id: RunId;
  readonly at: LogicalTime;
  /** 提供则写入 `inbox_message_consumed` 观测事件（证据面；不影响已读语义）。 */
  readonly event_ids?: EventIdSource;
}

/** 一轮的输入快照（`RunRecord` 的三个 frozen_* 字段的来源）。 */
export interface FrozenInputSnapshot {
  readonly instance_id: InstanceId;
  readonly run_id: RunId;
  readonly frozen_at: LogicalTime;
  /** 本轮读入的消息 id（按收件箱到达序）。 */
  readonly message_ids: readonly MessageId[];
  /** 本轮读入的工作请求 id（由被冻结消息携带，去重保序）。 */
  readonly request_ids: readonly RequestId[];
  /** 本轮读入的"依赖解除"可运行输入引用（Q5-c）。 */
  readonly actionable_input_refs: readonly string[];
}

/** 该实例**未读**的收件箱条目（按到达序号升序）。 */
export function unreadInboxEntries(
  tx: StorageTransaction,
  instanceId: InstanceId,
): readonly InboxEntry[] {
  const read = new Set<MessageId>(tx.getReadReceipts(instanceId).map((r) => r.message_id));
  return Object.freeze(
    [...tx.getInbox(instanceId)]
      .filter((entry) => !read.has(entry.message_id))
      .sort((a, b) => a.sequence - b.sequence),
  );
}

/**
 * 未读**且构成运行机会**的收件箱条目（R2：`stage_result` 等 `requires_wakeup=false`
 * 的公共进度消息不算）。
 *
 * 注意与 `unreadInboxEntries` 的分工（R2 的两个不同问题）：
 * - **"能不能被读入本轮"** → `unreadInboxEntries`（未读即读入，含公共进度）；
 * - **"值不值得为它起一轮"** → 本函数（只算唤醒类）。
 *
 * 若反过来把公共进度也算成运行机会，会违反 R2 并让实例空转；
 * 若把它排除在快照之外，它会**永远保持未读**、无限期留在收件箱里。
 * 故：读入仍读入，但不作为起轮次的理由。
 *
 * **F09 / R37.3 增量**：运行机会还要过**版本有效性**——陈旧历史消息（版本低于当前任务版本）
 * 不得因"未读"成为新的可运行输入。判据落在 `isRunnableInputEntry()`。
 */
export function wakingInboxEntries(
  tx: StorageTransaction,
  instanceId: InstanceId,
  options?: InboxRunEligibilityOptions,
): readonly InboxEntry[] {
  return Object.freeze(
    unreadInboxEntries(tx, instanceId).filter((entry) => isRunnableInputEntry(tx, entry, options)),
  );
}

// ---------------------------------------------------------------------------
// 运行资格（F09 / R37.3 第 1 条）：版本有效性判据
// ---------------------------------------------------------------------------

/** 运行资格判定选项（F09 / R37.3）。 */
export interface InboxRunEligibilityOptions {
  /**
   * 显式解析"当前任务版本"；省略时读存储的 `TaskRecord.revision`
   * （与入口 `validateRouting` 的 stale 判据**同源**，不再造第二份版本定义）。
   *
   * 返回 `null` / `undefined` 表示**无法判定**（任务未注册）——此时**不判陈旧**
   * （沿用"有则从严、无则放行"：宁可放行一次空轮，也不把合法新版本误判为历史）。
   */
  readonly currentTaskRevision?: (taskId: TaskId) => Revision | null | undefined;
}

/** 当前任务版本（无法判定时为 null）。默认读存储，可被 `options.currentTaskRevision` 覆盖。 */
function currentRevisionOf(
  tx: StorageTransaction,
  taskId: TaskId,
  options: InboxRunEligibilityOptions | undefined,
): Revision | null {
  const explicit = options?.currentTaskRevision;
  if (explicit !== undefined) {
    return explicit(taskId) ?? null;
  }
  return tx.getTask(taskId)?.revision ?? null;
}

/**
 * **版本有效性判据**（F09 / R37.3 第 1 条）：消息声明的任务版本是否**达到**当前任务版本。
 *
 * 这是"值不值得为它起一轮"的**唯一版本判定**，供调度层在写入收件箱 `requires_wakeup`
 * （或决定是否置排队标记）之前调用：
 * - 版本 == 当前 → 有效（`true`）；
 * - 版本 <  当前 → 陈旧历史（`false`，R37.3："历史消息入库留作历史，但不获得运行资格"）；
 * - 无法判定当前版本（任务未注册）→ `true`（有则从严、无则放行）。
 *
 * 注意：本判据**不**决定"能不能被读入本轮"——那是 `unreadInboxEntries()` 的读入语义，
 * 两者必须分清（读入 ≠ 获得运行资格）。
 */
export function hasEligibleTaskRevision(
  tx: StorageTransaction,
  taskId: TaskId,
  declaredRevision: Revision,
  options?: InboxRunEligibilityOptions,
): boolean {
  const current = currentRevisionOf(tx, taskId, options);
  return current === null || declaredRevision >= current;
}

/**
 * 该收件箱条目是否为**陈旧历史**（其消息版本低于当前任务版本，F09）。
 *
 * 消息经**群作用域**查询取回（F04：群身份取自条目 `entry.group_id`，不是全局查询）。
 * 消息缺失或任务未注册 → 无法证明陈旧 → `false`（历史项不被误杀）。
 */
export function isStaleInboxEntry(
  tx: StorageTransaction,
  entry: Pick<InboxEntry, 'group_id' | 'message_id' | 'task_id'>,
  options?: InboxRunEligibilityOptions,
): boolean {
  const message = tx.getMessageInGroup(entry.group_id, entry.message_id);
  if (message === undefined) {
    return false;
  }
  const current = currentRevisionOf(tx, entry.task_id, options);
  return current !== null && message.task_revision < current;
}

/**
 * **运行资格判定入口**（F09 / R37.3 第 1 条，供调度层调用）：
 * 该收件箱条目是否构成一次运行机会 =
 * `requires_wakeup` 为真 **且** 不是陈旧历史（版本有效）。
 *
 * 语义边界（务必分清，混用会分别导致两类错误）：
 * - **快照内容**（`unreadInboxEntries`）：未读即读入——陈旧消息**仍然会被读入**下一轮快照，
 *   作为历史留在上下文里；本函数**不**改变这一点。
 * - **执行资格**（本函数）：值不值得为它起一轮——陈旧消息不值得，故不进
 *   `wakingInboxEntries()` / `hasRunnableInput()`。
 *
 * 若反过来用本函数过滤快照，陈旧消息会永远保持未读而滞留收件箱；
 * 若不用本函数过滤运行机会，陈旧消息会起一轮无工作的空转。
 */
export function isRunnableInputEntry(
  tx: StorageTransaction,
  entry: Pick<InboxEntry, 'group_id' | 'message_id' | 'task_id' | 'requires_wakeup'>,
  options?: InboxRunEligibilityOptions,
): boolean {
  return entry.requires_wakeup && !isStaleInboxEntry(tx, entry, options);
}

/** 该实例**全部**可运行输入标记（**含已消费**，按登记时刻排序；F10 的"完整输入身份"）。
 *
 * 与 `pendingActionableInputs` 的区别：后者只看未消费（支撑"至多一次排队"），
 * 前者是**完整身份视图**，供调度层判断"这是真正的新解除输入还是旧通知重试"。
 */
export function actionableInputMarks(
  tx: StorageTransaction,
  instanceId: InstanceId,
): readonly ActionableInputMark[] {
  return Object.freeze(
    [...tx.getActionableInputs(instanceId)].sort(
      (a, b) => a.marked_at - b.marked_at || (a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0),
    ),
  );
}

/** 该实例**未被任何轮次消费**的可运行输入标记（Q5-c；`consumed_in_run_id === null`）。 */
export function pendingActionableInputs(
  tx: StorageTransaction,
  instanceId: InstanceId,
): readonly ActionableInputMark[] {
  return Object.freeze(
    actionableInputMarks(tx, instanceId).filter((mark) => mark.consumed_in_run_id === null),
  );
}

/**
 * 按**完整输入身份**（`ref_id`，含 task/revision/解除对象的编码）查一条标记——
 * **未消费与已消费都返回**（F10）。
 *
 * 调度层的正确用法（取代"只查 `pendingActionableInputs`"的旧写法）：
 * - 返回 `undefined` → 真正的**新**解除输入 → 登记标记 + 写 `dependency_resolved` + 置排队；
 * - 返回且 `consumed_in_run_id !== null` → **旧通知重试**（已被某轮消费）→ 不重置消费状态、
 *   不重复登记、不产生额外轮次；
 * - 返回且 `consumed_in_run_id === null` → 已登记未消费 → 不重复写事实事件。
 */
export function findActionableInput(
  tx: StorageTransaction,
  instanceId: InstanceId,
  refId: string,
): ActionableInputMark | undefined {
  return tx.getActionableInputs(instanceId).find((mark) => mark.ref_id === refId);
}

/** `ref_id` 是否已在**完整身份**（含已消费）中出现过（`findActionableInput` 的布尔形式）。 */
export function hasActionableInput(
  tx: StorageTransaction,
  instanceId: InstanceId,
  refId: string,
): boolean {
  return findActionableInput(tx, instanceId, refId) !== undefined;
}

/**
 * 是否还有**可运行输入**（未读的**唤醒类且版本有效**消息 或 未消费的可运行输入标记）。
 * D03 的"至多一次排队"与 §9.4"无有效工作不运行"都以此为判据。
 *
 * R2：公共进度（`requires_wakeup=false`）单独出现时**不**构成运行机会——
 * 它仍会被下一轮合法轮次读入，但不为它自己起一轮。
 * F09 / R37.3：**陈旧历史消息**同样不构成运行机会（读入语义不变，见 `isRunnableInputEntry`）。
 */
export function hasRunnableInput(
  tx: StorageTransaction,
  instanceId: InstanceId,
  options?: InboxRunEligibilityOptions,
): boolean {
  return (
    wakingInboxEntries(tx, instanceId, options).length > 0 ||
    pendingActionableInputs(tx, instanceId).length > 0
  );
}

/**
 * **只读**计算本轮快照，不写任何记录（供断言、预览与 D03 的"是否需要起轮次"判定）。
 * 需要真正占用本轮输入（标记已读、消费可运行输入）时用 `freezeInputSnapshot()`。
 */
export function computeFrozenInput(
  tx: StorageTransaction,
  request: Omit<FreezeInputRequest, 'event_ids'>,
): FrozenInputSnapshot {
  const entries = unreadInboxEntries(tx, request.instance_id);
  const marks = pendingActionableInputs(tx, request.instance_id);

  const messageIds: MessageId[] = [];
  const requestIds: RequestId[] = [];
  const seenRequests = new Set<RequestId>();
  for (const entry of entries) {
    messageIds.push(entry.message_id);
    // F09 / R37.3：**陈旧历史消息不进入工作认领与发布范围**。
    // 它仍被读入本轮（上行的 `messageIds`，读入 ≠ 运行资格），但它的 `request_id`
    // 不得成为本轮"认领工作项"的依据——否则一条历史 request_id 会被当前轮次认领/发布。
    if (isStaleInboxEntry(tx, entry)) {
      continue;
    }
    // F04 / R37.1：**群作用域**查询。群身份取自收件箱条目，不用全局 `getMessage()`
    // ——后者在"同 id 跨群复用"（合法，Q1-d/R6）时会抛歧义错，使两群都无法起轮。
    const requestId = tx.getMessageInGroup(entry.group_id, entry.message_id)?.request_id;
    if (requestId !== undefined && !seenRequests.has(requestId)) {
      seenRequests.add(requestId);
      requestIds.push(requestId);
    }
  }

  return Object.freeze({
    instance_id: request.instance_id,
    run_id: request.run_id,
    frozen_at: request.at,
    message_ids: Object.freeze(messageIds),
    request_ids: Object.freeze(requestIds),
    actionable_input_refs: Object.freeze(marks.map((mark) => mark.ref_id)),
  });
}

/**
 * **事务内冻结本轮输入**（Q5-a：必须与抢占、run_id 分配、租约在同一事务）。
 *
 * 写入两类记录，二者**分别独立**、永不互相推导（§九-5）：
 * - `ReadReceipt`（已读）+ 实例 `consumed_message_ids`：读取即标记，**不代表工作完成**；
 * - `ActionableInputMark.consumed_in_run_id = run_id`：标记该可运行输入已被本轮取用，
 *   从而支撑"至多一次排队"（同一输入不会被反复排入多轮）。
 *
 * 冻结**之后**同一事务内新投递的消息不会进入本次返回的快照（快照已经算出），
 * 由此满足"冻结后到达的消息不得进入本轮"。
 */
export function freezeInputSnapshot(
  tx: StorageTransaction,
  request: FreezeInputRequest,
): FrozenInputSnapshot {
  const instance = requireInstance(tx, request.instance_id);
  const snapshot = computeFrozenInput(tx, request);

  const alreadyRead = new Set<MessageId>(tx.getReadReceipts(request.instance_id).map((r) => r.message_id));
  const newlyRead: MessageId[] = [];
  for (const messageId of snapshot.message_ids) {
    if (alreadyRead.has(messageId)) {
      continue;
    }
    tx.appendReadReceipt(
      createReadReceipt({
        message_id: messageId,
        instance_id: request.instance_id,
        run_id: request.run_id,
        read_at: request.at,
      }),
    );
    newlyRead.push(messageId);
  }
  if (newlyRead.length > 0) {
    patchInstance(tx, instance, {
      consumed_message_ids: appendUnique(instance.consumed_message_ids, newlyRead),
      updated_at: request.at,
    });
  }

  for (const mark of pendingActionableInputs(tx, request.instance_id)) {
    tx.putActionableInput(Object.freeze({ ...mark, consumed_in_run_id: request.run_id }));
  }

  const eventIds = request.event_ids;
  if (eventIds !== undefined && newlyRead.length > 0) {
    const events: readonly KernelEvent[] = newlyRead.map((messageId) =>
      createKernelEvent(
        {
          kind: 'inbox_message_consumed',
          at: request.at,
          instance_id: request.instance_id,
          message_id: messageId,
          run_id: request.run_id,
          data: { consumed_in_run_id: request.run_id },
        },
        eventIds,
      ),
    );
    for (const event of events) {
      tx.appendKernelEvent(event);
    }
  }

  return snapshot;
}

/**
 * 依赖解除输入的**完整身份**（F10 / R37.3 第 2 条）由 **D05 的
 * `resolutionInputRefId({ task_id, task_revision, request_id, resolved_dependency_ids })`
 * 唯一编码**——本模块**不再自带第二套编码器**。
 *
 * 为什么删掉原来的那套：修复批曾在此处另有一个 `dependencyResolutionInputRefId`
 * （形状 `dep:<task>@<rev>:<target>`），与 D05 的编码**产出不同字符串**，两边注释还各自自称
 * "唯一处"。当时只有调度侧那一条路径被接线，所以没有当场出错；但那正是 F10 要消灭的
 * 失效模式——**同一概念两套身份，一旦第二条路径被启用，幂等就会静默失效**。
 * 独立复核（W，2026-10-02）把它列为 N-新1，本次直接**删除而非并存**。
 *
 * 因此 `ref_id` 由调用方（调度侧）用 D05 的编码器算好传入，本模块只负责
 * 按这个字符串做幂等登记与查询。
 */
export interface MarkDependencyInputRequest {
  readonly instance_id: InstanceId;
  /**
   * 依赖解除事件的引用 id。**必须**是上游（D05 的 `resolutionInputRefId`）算出的完整身份，
   * 含 `task_id + task_revision + 解除对象`——不得在此处临时拼一个短 id。
   */
  readonly ref_id: string;
  readonly at: LogicalTime;
}

/**
 * **Q5-c**：把"依赖解除"登记为新的**可运行输入**，供下一轮快照读入。
 *
 * 硬语义：**不作为新消息入箱**——不产生 `GroupMessage`、不产生 `InboxEntry`、不走去重，
 * 因而不会污染"消息守恒"类断言；它只出现在
 * `FrozenInputSnapshot.actionable_input_refs` / `RunRecord.frozen_actionable_input_refs` 里。
 *
 * **幂等（F10 / R37.3 第 3 条，本函数是唯一落地处）**：同一实例同一 `ref_id`（= 完整身份）
 * 只允许一条。区别两种重复：
 * - 已有且**未消费** → 只刷新登记时刻，不翻倍（沿用旧语义）；
 * - 已有且**已消费** → **原样返回，不写库、不把 `consumed_in_run_id` 重置为 `null`**。
 *   旧实现用 `createActionableInputMark` 无条件覆盖，会把已消费通知变回未消费，
 *   于是同一通知在每轮结束后重放都会再起一轮（实测 3 轮 / 3 个解除事件、1 个标记）。
 *
 * 置排队标记与写 `dependency_resolved` 待投递事件归 D03（合并唤醒）；D03 应改用
 * `findActionableInput()`（完整身份，含已消费）判断"新输入 or 旧通知重试"，不再只看未消费。
 */
export function markDependencyResolutionInput(
  tx: StorageTransaction,
  request: MarkDependencyInputRequest,
): ActionableInputMark {
  requireInstance(tx, request.instance_id);
  if (typeof request.ref_id !== 'string' || request.ref_id.length === 0) {
    throw new ValidationError('依赖解除的可运行输入引用不能为空');
  }
  const refId = request.ref_id;

  const existing = findActionableInput(tx, request.instance_id, refId);
  if (existing !== undefined) {
    if (existing.consumed_in_run_id !== null) {
      // 旧通知重试：保留消费事实，绝不复位为未消费。
      return existing;
    }
    if (existing.marked_at === request.at) {
      return existing;
    }
    const refreshed = Object.freeze({ ...existing, marked_at: request.at });
    tx.putActionableInput(refreshed);
    return refreshed;
  }

  const mark = createActionableInputMark({
    instance_id: request.instance_id,
    source: 'dependency_resolution',
    ref_id: refId,
    marked_at: request.at,
  });
  tx.putActionableInput(mark);
  return mark;
}
