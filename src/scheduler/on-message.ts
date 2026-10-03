/**
 * `on_message` 入口事务编排（归属 D03；合同 §六、§九-1/§九-4；任务书 §9.1–§9.3、附录 B）。
 *
 * ```text
 * on_message(message):
 *     transaction:
 *         authenticate_sender_and_validate_routing(message)
 *         if message.message_id already exists:            → D02 的 isDuplicateDelivery（写入前判重）
 *             return
 *         persist_message(message)                          → D02 的 deliverToInbox
 *         update_work_ledger_when_applicable(message)       → 建工作项（work_request）
 *         if message changes task revision or cancels task:
 *             update_task_control_state_first(message)      → 同事务写 TaskControlState（B4）
 *         if message should wake recipient:
 *             mark_actionable_input(recipient, message)
 *             if recipient has neither active run nor queued item:
 *                 set queued flag and persist scheduling event
 *     publish committed scheduling events
 * ```
 *
 * ## 三处必须如实说明的实现口径
 *
 * 1. **「标记可执行输入」的载体是收件箱条目本身**（`InboxEntry.requires_wakeup`，D02 落地）：
 *    不为同一条消息再写一条 `ActionableInputMark`——那会让同一输入在快照里出现两次
 *    （既在 `frozen_input_message_ids` 又在 `frozen_actionable_input_refs`），
 *    并使"至多一次排队"的判定出现两个真相源。
 *    `ActionableInputMark` 只承载**依赖解除**这类"不作为新消息入箱"的输入（Q5-c，见 `wakeup.ts`）。
 * 2. **本入口绝不启动轮次**：只保存 + 置排队标记 + 写待投递事件（附录 B 的 `on_message` 止于此）。
 *    启动轮次是 `start_run` 的职责，由夹具持有的调度决策点触发（D06 的 `SchedulerAdvanceSeam`
 *    结构性保证"投递不触发推进"——A02「全部投递在快照冻结之前到达」的依据）。
 * 3. **取消消息同步生效、且不收进"唤醒类"**：§9.3 要求"取消和用户需求更新优先写入任务状态，
 *    不能只作为普通群消息排队"。取消在**同一事务内**直接落到工作项（终态 `cancelled`）
 *    与任务控制状态，因此它的收件箱条目被标为**安静**（`requires_wakeup = false`）：
 *    取消不再需要一次运行机会。若照 `MessageDraft.requires_wakeup = true` 原样入箱，
 *    `finish_run` 会为这条未读的唤醒类消息再入队一次，产生一轮**没有有效工作**的轮次
 *    （§9.4），并使 P4-08「取消后空推进不产生新轮次」失真。
 *    显式传 `options.requires_wakeup` 可覆盖（构造对照用）。
 *    （`GroupMessage.requires_wakeup` 保持调用方声明的值不变——改动的是内核侧的收件箱视图。）
 */

import {
  PersistenceError,
  applyTaskControlIntent,
  createTaskControlState,
  createWorkItem,
  isKernelIssuedBinding,
  isTerminalStatus,
  type ArtifactRef,
  type BlockerReason,
  type DeliveryResult,
  type GroupMessage,
  type IdSource,
  type InboxEntry,
  type InstanceId,
  type InstanceState,
  type KernelEvent,
  type KernelEventInput,
  type LogicalTime,
  type MessageId,
  type PendingEvent,
  type RequestId,
  type StorageTransaction,
  type TaskControlState,
  type TaskId,
  type WorkItem,
} from '../protocol/index.js';
import { deliverToInbox, hasRunnableInput, patchInstance, requireInstance } from '../inbox/index.js';
import { applyWorkItemTransition, isWorkLedgerError } from '../workledger/index.js';
import { SchedulerError } from './errors.js';
import {
  appendKernelEvent,
  staleMessageEvent,
  taskControlStateUpdatedEvent,
  workItemCreatedEvent,
  workItemStatusChangedEvent,
} from './kernel-events.js';
import { markQueueFlagged } from './queue.js';
import { cancelTaskLifecycle } from './task-action-wiring.js';
import { resolveTaskActionPort, type TaskActionStorePort } from './task-action-store.js';

// ---------------------------------------------------------------------------
// 鉴权（P8 的第 2 层：入口事务；第 1 层是 D01 的编译期形状约束）
// ---------------------------------------------------------------------------

/**
 * 发送者鉴权接缝（可注入；默认 `kernelSenderAuthenticator`）。
 *
 * - 默认实现做**可信来源校验**（合同 v1.2 R35.2；修复 F07）：见
 *   `kernelSenderAuthenticator` 的四项判据。
 * - 需要**负向用例**时（P8：伪造发送者不得进入有效收件箱），
 *   注入一个抛错的实现即可——抛错会让整个入口事务回滚，消息**不落库**。
 * - 注入的鉴权器**替换**默认判据（如 `rejectingSenderAuthenticator` 只用于负向夹具），
 *   不得把"注入一个拒绝一切的鉴权器"当作默认行为。
 */
export type SenderAuthenticator = (message: GroupMessage, tx: StorageTransaction) => void;

/**
 * 默认鉴权：**内核签发的可信绑定 + 成员资格 + 路由自洽**（合同 v1.2 R35.2；修复 F07）。
 *
 * ## 旧实现的缺陷（本批要修的就是它）
 *
 * 旧版只检查"消息是冻结的、`sender_instance_id` 是非空字符串"，于是
 * **复制一条合法消息、把 sender 换成别人、再 `Object.freeze` 一次**就能通过：
 * `Object.freeze`、TypeScript 类型和 `instanceof` 都不能证明**调用者是谁**。
 * 现有 P8 测试已实证这一伪造被 `accepted` 并创建了工作项（`runtime_forgery_blocked = false`）。
 *
 * ## 现在的四项判据（缺一即抛错 → 事务回滚 → 消息不落库）
 *
 * 1. 消息携带的 `sender_binding` 是**内核签发**对象
 *    （`instanceof` + 模块私有 WeakSet + 冻结；挡住 `Object.create(prototype)` 与字面量伪造）；
 * 2. 绑定的 `sender_instance_id` 与消息声明的一致
 *    （挡住"冻结副本改 sender"——副本字段被改写，绑定仍是内核签发的那个）；
 * 3. 绑定与消息的 `group_id` / `task_id` 同源（挡住跨群/跨任务挪用绑定）；
 * 4. 发送者是**本群已注册实例**（成员资格；R35.5 要求夹具注册合法发送成员）。
 *
 * ## 信任边界（如实声明，R35.4）
 *
 * 本层保护的是**不可信消息输入**：模型侧提供的消息不得自带身份。
 * 它**不宣称**同进程任意恶意代码的完全隔离——能 import `src/protocol` 的代码仍可调用
 * `SenderBinding.bind()`。那个约定是"入口只接受内核构造的消息"，`bind()` 是内核内部入口，
 * **不是权限门**。若要更强的运行时保证（一次性 token、入口白名单），属另开点。
 */
export const kernelSenderAuthenticator: SenderAuthenticator = (message, tx) => {
  if (!Object.isFrozen(message)) {
    throw new SchedulerError(
      '消息必须是内核经 createMessage() 构造的不可变记录：入口不接受模型侧自建的可变对象（P8）',
    );
  }
  const binding: unknown = message.sender_binding;
  if (!isKernelIssuedBinding(binding)) {
    throw new SchedulerError(
      '消息缺少内核签发的发送者绑定：发送者身份不得由消息体自称（P8/F07 第 1 项判据）',
    );
  }
  if (binding.sender_instance_id !== message.sender_instance_id) {
    throw new SchedulerError(
      `发送者绑定（${binding.sender_instance_id}）与消息声明的 sender（${message.sender_instance_id}）不一致：` +
        '消息副本被改写（P8/F07 第 2 项判据）',
    );
  }
  if (binding.group_id !== message.group_id || binding.task_id !== message.task_id) {
    throw new SchedulerError(
      '发送者绑定与消息的群/任务不同源：绑定不得跨群或跨任务挪用（P8/F07 第 3 项判据）',
    );
  }
  // 第 4 项：**成员资格**。发送者必须是该群的已登记成员（`putGroupMember`）。
  // 用独立的成员表而不是 `InstanceState`：成员资格不参与调度判定，登记它不得改变
  // `instances` 的观测口径（见 `src/protocol/membership.ts` 的说明）。
  if (tx.getGroupMember(message.group_id, message.sender_instance_id) === undefined) {
    throw new SchedulerError(
      `发送者 ${message.sender_instance_id} 不是群 ${message.group_id} 的已登记成员：` +
        '成员资格校验失败（P8/F07 第 4 项判据）',
    );
  }
  const addressedViaCapability = message.addressed_via === 'target_capability';
  if (addressedViaCapability && message.target_capability === undefined) {
    throw new SchedulerError('寻址声明为 target_capability 但未给出 target_capability（路由校验失败）');
  }
};

/** 拒绝一切来源的鉴权器（负向用例夹具；绝不用于生产路径）。 */
export function rejectingSenderAuthenticator(reason = '该来源未经内核校验（P8 负向用例）'): SenderAuthenticator {
  return () => {
    throw new SchedulerError(reason);
  };
}

// ---------------------------------------------------------------------------
// 路由校验（P8 / Q2-a / Q1-c / Q1-b）
// ---------------------------------------------------------------------------

/** 路由校验结果。 */
export interface RouteValidation {
  readonly recipient: InstanceState;
  /** 任务是否已注册。未注册时**不做**版本判定（见 `validateRouting()` 的说明）。 */
  readonly task_registered: boolean;
  /** 消息的任务版本低于当前版本 → 仅入库留作历史，不产生业务工作（Q1-b）。 */
  readonly stale_revision: boolean;
}

/** 已注册任务的当前版本（未注册时为 null）。 */
export function currentTaskRevision(
  tx: StorageTransaction,
  taskId: TaskId,
): { readonly registered: boolean; readonly revision: number | null } {
  const task = tx.getTask(taskId);
  return task === undefined
    ? { registered: false, revision: null }
    : { registered: true, revision: task.revision };
}

/**
 * 入口事务的鉴权与路由校验（P8；Q1-c 显式实例标识；Q2-a 会话内解析后才入库）。
 *
 * 校验项与不校验项的**如实声明**：
 * - 校验：`recipient_instance_id` 必须是**已注册且与消息同群**的实例（否则抛错 → 事务回滚 →
 *   消息不进入有效收件箱，P8）"路由与目标不符的消息不得进入有效收件箱"。
 * - 校验：消息版本**不得高于**当前任务版本（高于 = 不可能的来源 → 拒绝）；低于 = 陈旧
 *   （Q1-b：入库留历史、不产生业务工作）。
 * - **不校验**：发送者是否为已注册实例。首版基线（验收规格 0.2）只注册接收者 C，
 *   发送者 S1…S4 是"同群其他成员"的标识而非已注册实例；强制注册发送者会让 A02/A03/A04
 *   全部无法投递。发送者的真实性由第 1 层（D01 的 `SenderBinding` 编译期约束）与本层的
 *   可注入鉴权器共同承担。
 * - **任务未注册时不判版本**：规格 0.2 的夹具基线不要求写 `TaskRecord`（D06 的
 *   `createScenarioBaseline` 只造实例）。因此版本判定是**有则从严、无则放行**，
 *   并把 `task_registered` 如实回报给调用方（D09 需要验 stale 时须先注册任务，
 *   或用 `finish_run` 的 `current_task_revision` 显式覆盖）。
 */
export function validateRouting(
  tx: StorageTransaction,
  message: GroupMessage,
): RouteValidation {
  const recipient = requireInstance(tx, message.recipient_instance_id);
  if (recipient.group_id !== message.group_id) {
    throw new SchedulerError(
      `路由校验失败：目标实例 ${recipient.instance_id} 属于群组 ${recipient.group_id}，` +
        `而消息属于群组 ${message.group_id}（P8：路由必须解析为**本群内**的实例）`,
    );
  }

  const task = tx.getTask(message.task_id);
  if (task === undefined) {
    return { recipient, task_registered: false, stale_revision: false };
  }
  if (task.current_group_id !== null && task.current_group_id !== message.group_id) {
    throw new SchedulerError(
      `路由校验失败：任务 ${task.task_id} 的当前群组是 ${task.current_group_id}，与消息群组 ${message.group_id} 不符`,
    );
  }
  if (message.task_revision > task.revision) {
    throw new SchedulerError(
      `路由校验失败：消息声明的任务版本 ${message.task_revision} 高于当前版本 ${task.revision}` +
        '（高于当前版本的消息不可能来自本任务的合法来源）',
    );
  }
  return {
    recipient,
    task_registered: true,
    stale_revision: message.task_revision < task.revision,
  };
}

// ---------------------------------------------------------------------------
// 取消目标的授权与路由校验（F01）
// ---------------------------------------------------------------------------

/** 取消目标校验结果。`target_request_id` 为 null 表示"任务级取消，未指认具体工作项"。 */
export interface CancelTargetValidation {
  readonly target_request_id: RequestId | null;
}

/**
 * **取消目标的授权与路由校验**（合同 v1.2 R33.3；修复 F01）。
 *
 * ## 旧实现的缺陷
 *
 * 旧版按 `reply_to` **全局**取工作项后直接用 kernel 身份取消，不做任何范围校验。
 * 实测：T1/G1/C 的消息指定 T2/G2/D 的请求 ID，入口返回 `accepted`，**T2 的工作项被取消**，
 * 控制状态却只记在 T1 —— 一条消息越权改动了另一个任务的工作。
 *
 * ## 判据（任一不中即抛错 → 整个入口失败 → 事务回滚，不留任何业务变更）
 *
 * - **目标存在**：`reply_to ?? request_id` 指向的工作项确实存在才做范围校验；
 *   不存在时不取消任何项（任务级取消意图仍成立，不算非法目标）；
 * - **同任务**：`item.task_id === message.task_id`（取消不得跨任务）；
 * - **同群**：目标负责人的实例属于消息群（取消不得跨群）；
 * - **接收者即负责人**：`message.recipient_instance_id === item.owner_instance_id`。
 *   **不能用 `sender == owner` 代替**：合法协作的发送者可以不是工作负责人（R33.3）；
 * - **非旧版本目标**：目标版本低于当前任务版本时拒绝（旧版本只作历史，Q1-b）。
 *
 * 校验发生在**任何写入之前**：不得"先改控制状态再检查"。
 */
export function validateCancelTarget(
  tx: StorageTransaction,
  message: GroupMessage,
): CancelTargetValidation {
  if (message.type !== 'cancel') {
    return Object.freeze({ target_request_id: null });
  }
  const targetRequestId = message.reply_to ?? message.request_id;
  if (targetRequestId === undefined) {
    return Object.freeze({ target_request_id: null });
  }
  const item = tx.getWorkItem(targetRequestId);
  if (item === undefined) {
    return Object.freeze({ target_request_id: null });
  }

  if (item.task_id !== message.task_id) {
    throw new SchedulerError(
      `取消目标 ${targetRequestId} 属于任务 ${item.task_id}，与消息任务 ${message.task_id} 不符：` +
        '取消不得跨任务（F01）',
    );
  }
  const owner = tx.getInstance(item.owner_instance_id);
  if (owner === undefined || owner.group_id !== message.group_id) {
    throw new SchedulerError(
      `取消目标 ${targetRequestId} 的负责人 ${item.owner_instance_id} 不在消息群 ${message.group_id} 内：` +
        '取消不得跨群（F01）',
    );
  }
  if (item.owner_instance_id !== message.recipient_instance_id) {
    throw new SchedulerError(
      `取消消息的接收者 ${message.recipient_instance_id} 不是目标工作项 ${targetRequestId} 的负责人 ` +
        `${item.owner_instance_id}：路由不符（F01）`,
    );
  }
  const task = tx.getTask(message.task_id);
  if (task !== undefined && item.task_revision < task.revision) {
    throw new SchedulerError(
      `取消目标 ${targetRequestId} 基于旧任务版本 ${item.task_revision}（当前 ${task.revision}）：` +
        '旧版本目标不得被取消（F01 / Q1-b）',
    );
  }
  return Object.freeze({ target_request_id: targetRequestId });
}

// ---------------------------------------------------------------------------
// 入口编排
// ---------------------------------------------------------------------------

/** 入口选项。 */
export interface OnMessageOptions {
  /** 到达时刻；省略时取 `message.created_at`（确定性：不读隐藏时钟）。 */
  readonly at?: LogicalTime;
  /**
   * 观测 / 待投递事件的 id 源（**必填**）。
   *
   * 为什么必填（与 D02 的 `deliverToInbox` 的"可选事件面"不同）：入口编排**必须**写
   * outbox 的待投递调度事件（附录 B「persist scheduling event」），而事件必须有 id；
   * 观测事件则是 R4 计数口径的唯一来源（`inbox_message_count` 等）。若允许省略，
   * 就得为"没有 id 源"另造一套 id 生成，必然与注入的 id 源冲突。
   */
  readonly event_ids: IdSource;
  /** 覆盖收件箱条目的唤醒标记（默认取 `message.requires_wakeup`）。 */
  readonly requires_wakeup?: boolean;
  /** 发送者鉴权器（默认 `kernelSenderAuthenticator`）。 */
  readonly authenticator?: SenderAuthenticator;
  /**
   * 动作台账 / 任务生命周期的持久端口（FA-S；KRN-07 + KRN-09 接线）。
   *
   * 取消消息到达时用它把**任务级运行态**一并置 `cancelled`（与协议层
   * `TaskControlState.cancelled` 同一事务），避免"轮次级说取消、任务级还说 running"的漂移。
   * 省略且介质也没实现接缝 ⇒ `'unwired'`：不写、如实回报，**不静默降级**。
   */
  readonly taskActions?: TaskActionStorePort | undefined;
}

/** 入口事务的结果（三值 + 各条被写入记录的取证引用）。 */
export interface OnMessageOutcome {
  /** `accepted` / `duplicate_not_created` / `failed`（验收规格 0.3 的投递入口三值）。 */
  readonly result: DeliveryResult;
  readonly message_id: MessageId;
  readonly request_id: RequestId | null;
  readonly recipient_instance_id: InstanceId;
  readonly inbox_entry: InboxEntry | null;
  readonly duplicate_of: MessageId | null;
  readonly failure_reason: string | null;
  /** 本次建立的工作项（`work_request` 才有；重复送达与陈旧版本为 null）。 */
  readonly work_item: WorkItem | null;
  /** 本次是否**新建**了工作项（同一 `request_id` 的第二条消息为 false，不重复建）。 */
  readonly work_item_created: boolean;
  /** 本次是否置位了排队标记（运行机会被合并时为 false）。 */
  readonly queued: boolean;
  /** 是否因"已有活动轮次或已有排队标记"而合并了本次唤醒。 */
  readonly merged_wakeup: boolean;
  /** 陈旧版本消息（Q1-b：入库留历史，无业务工作）。 */
  readonly stale_revision: boolean;
  readonly task_registered: boolean;
  /** 本次写入的任务控制状态（仅取消 / 需求更新消息）。 */
  readonly task_control_state: TaskControlState | null;
  readonly observation_events: readonly KernelEvent[];
  /** 本次写下的待投递调度事件（outbox；事务提交后才发布）。 */
  readonly delivery_events: readonly PendingEvent[];
}

const PENDING_BLOCKER: BlockerReason = Object.freeze({
  kind: 'other',
  detail: '已受理：等待运行轮次处理',
});

function payloadContent(message: GroupMessage): string | null {
  const payload: unknown = message.payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const content = (payload as { readonly content?: unknown }).content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function payloadText(message: GroupMessage, field: string): string | null {
  const payload: unknown = message.payload;
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const value = (payload as Readonly<Record<string, unknown>>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 入口事务的**唯一编排实现**。调用方必须把它放在自己的 `store.transact()` 内
 * （本函数不自开事务——`Store.transact` 不支持嵌套），提交后再发布待投递事件。
 */
export function onMessageInTransaction(
  tx: StorageTransaction,
  message: GroupMessage,
  options: OnMessageOptions,
): OnMessageOutcome {
  const at = options.at ?? message.created_at;
  const eventIds = options.event_ids;
  const observationEvents: KernelEvent[] = [];
  const deliveryEvents: PendingEvent[] = [];

  const pushEvent = (event: KernelEvent): void => {
    observationEvents.push(event);
  };
  const emit = (build: KernelEventInput): void => {
    pushEvent(appendKernelEvent(tx, build, eventIds));
  };

  // 取消消息：**已在同一事务内同步生效**（`handleControlMessage`），故它的收件箱条目是
  // **安静条目**（`requires_wakeup = false`）——§9.3「取消不能只作为普通群消息排队」。
  // 不这么做的话：取消虽已同步落库，消息本身仍是"未读的唤醒类消息"，
  // `finish_run` 会因它再入队一次运行机会，产生一轮**没有任何有效工作**的轮次
  // （§9.4），并让 P4-08「取消后空推进不产生新轮次」失真。
  // 显式的 `options.requires_wakeup` 覆盖优先（调用方要构造对照时用）。
  const quietControlMessage = message.type === 'cancel';
  const declaredWakeup = quietControlMessage ? false : message.requires_wakeup;

  // ① 鉴权 + 路由校验（P8/F07）+ 取消目标校验（F01）：
  // 任何失败都抛错 → 事务回滚 → 消息不落库、不留任何业务变更。
  // 顺序刻意为"先校验、后写入"：不得先改控制状态再检查目标是否越权。
  (options.authenticator ?? kernelSenderAuthenticator)(message, tx);
  const route = validateRouting(tx, message);
  const cancelTarget = validateCancelTarget(tx, message);

  // **陈旧版本消息不获得运行资格**（合同 v1.2 R37.3；修复 F09）。
  //
  // 旧实现先按 `message.requires_wakeup` 写收件箱条目，**之后**才在 ③ 判 stale 并 return。
  // 于是旧消息虽被标为"仅入库留作历史"，条目上却仍带 `requires_wakeup = true`：
  // `wakingInboxEntries()` 把它算成运行机会，`hasRunnableInput()` 为真，
  // 推进后照样起一个"零工作项"的空轮次（实测 rev2 只收到 rev1 请求 → 仍启动 1 轮）。
  //
  // 修法：在写收件箱**之前**就定好运行资格——陈旧消息一律安静入库。
  // 消息本身照常保留（历史不许丢），只是不作为起轮次的理由；
  // 快照仍会读到它（读入 ≠ 运行资格，R2 的两分）。
  // 调用方显式给出的 `options.requires_wakeup` 仍然优先（构造对照用）。
  const requiresWakeup =
    options.requires_wakeup ?? (route.stale_revision ? false : declaredWakeup);

  // ② 持久化（含写入前判重，D02）——重复送达只写一条 `message_duplicate_rejected` 观测事件。
  const delivery = deliverToInbox(tx, message, {
    received_at: at,
    requires_wakeup: requiresWakeup,
    event_ids: eventIds,
  });
  for (const event of delivery.observation_events) {
    pushEvent(event);
  }
  if (delivery.result === 'duplicate_not_created') {
    return Object.freeze({
      result: 'duplicate_not_created' as const,
      message_id: message.message_id,
      request_id: message.request_id ?? null,
      recipient_instance_id: message.recipient_instance_id,
      inbox_entry: null,
      duplicate_of: delivery.duplicate_of,
      failure_reason: null,
      work_item: null,
      work_item_created: false,
      queued: false,
      merged_wakeup: false,
      stale_revision: false,
      task_registered: route.task_registered,
      task_control_state: null,
      observation_events: Object.freeze(observationEvents),
      delivery_events: Object.freeze(deliveryEvents),
    });
  }

  // ③ 陈旧版本消息：仅入库留作历史，**不产生业务工作、不唤醒**（Q1-b）。
  if (route.stale_revision) {
    const revision = currentTaskRevision(tx, message.task_id);
    emit(
      staleMessageEvent({
        at,
        message_id: message.message_id,
        instance_id: message.recipient_instance_id,
        task_id: message.task_id,
        task_revision: message.task_revision,
        current_revision: revision.revision ?? message.task_revision,
      }),
    );
    return Object.freeze({
      result: 'accepted' as const,
      message_id: message.message_id,
      request_id: message.request_id ?? null,
      recipient_instance_id: message.recipient_instance_id,
      inbox_entry: delivery.inbox_entry,
      duplicate_of: null,
      failure_reason: null,
      work_item: null,
      work_item_created: false,
      queued: false,
      merged_wakeup: false,
      stale_revision: true,
      task_registered: route.task_registered,
      task_control_state: null,
      observation_events: Object.freeze(observationEvents),
      delivery_events: Object.freeze(deliveryEvents),
    });
  }

  // ④ 工作承诺表（合同 §六 `update_work_ledger_when_applicable`）。
  const ledger = updateWorkLedger(tx, message, at);
  if (ledger.work_item !== null) {
    if (ledger.created) {
      emit(workItemCreatedEvent(ledger.work_item));
    } else {
      emit(workItemStatusChangedEvent(ledger.work_item, at));
    }
  }

  // ⑤ 任务控制状态（取消 / 需求更新优先写；§9.3、B4）：与消息同事务。
  // 取消的目标已由 `validateCancelTarget` 校验过（F01），此处只应用已授权的那个目标，
  // 不再自行从 `reply_to` 重新推导——避免两处推导不一致。
  const control = handleControlMessage(tx, message, at, cancelTarget.target_request_id);
  if (control.state !== null) {
    emit(
      taskControlStateUpdatedEvent({
        at,
        task_id: control.state.task_id,
        message_id: message.message_id,
        intent: message.type,
        cancelled: control.state.cancelled,
        requirement_update_pending: control.state.requirement_update_pending,
        control_epoch: control.state.control_epoch,
      }),
    );
  }

  // ⑤b **KRN-09 接线点**：取消消息同时置任务级生命周期（与 ⑤ 同一事务）。
  //
  // 取消是任务级事实。协议层只有 `TaskControlState.cancelled`（单调、不可撤），
  // 而任务级运行态（含 paused/timed_out/failed）只有 `TaskLifecycleState` 有。
  // 两处若只置一处，`finish_run` 的迟到闸门就会与轮次级判定漂移（FA-O 接口声明 §2-2 登记的风险）。
  // 未接线时此段一行不写，既有行为逐字不变。
  if (control.state !== null && control.state.cancelled) {
    const cancelPort = resolveTaskActionPort(tx, options.taskActions).port;
    if (cancelPort !== null) {
      cancelTaskLifecycle(cancelPort, {
        task_id: control.state.task_id,
        revision: control.state.revision,
        at,
        reason: payloadText(message, 'reason') ?? '取消消息：任务级生命周期一并置取消',
        message_id: message.message_id,
      });
    }
  }

  // ⑥ 唤醒：只在需要唤醒、且该实例确有可运行输入时置排队标记（附录 B 的条件）。
  const freshInstance = requireInstance(tx, message.recipient_instance_id);
  let queued = false;
  let merged = false;
  if (requiresWakeup) {
    if (hasRunnableInput(tx, freshInstance.instance_id)) {
      const result = markQueueFlagged(tx, {
        instance: freshInstance,
        task_id: message.task_id,
        group_id: message.group_id,
        at,
        delivery_kind: 'wakeup_queued',
        reason: `消息 ${message.message_id}（${message.type}）到达，标记运行机会`,
        payload: {
          message_id: message.message_id,
          request_id: message.request_id ?? null,
          message_type: message.type,
        },
        event_ids: eventIds,
      });
      queued = result.queued;
      merged = result.merged;
      for (const event of result.kernel_events) {
        pushEvent(event);
      }
      if (result.pending_event !== null) {
        deliveryEvents.push(result.pending_event);
      }
    }
  }

  return Object.freeze({
    result: 'accepted' as const,
    message_id: message.message_id,
    request_id: message.request_id ?? null,
    recipient_instance_id: message.recipient_instance_id,
    inbox_entry: delivery.inbox_entry,
    duplicate_of: null,
    failure_reason: null,
    work_item: ledger.work_item,
    work_item_created: ledger.created,
    queued,
    merged_wakeup: merged,
    stale_revision: false,
    task_registered: route.task_registered,
    task_control_state: control.state,
    observation_events: Object.freeze(observationEvents),
    delivery_events: Object.freeze(deliveryEvents),
  });
}

// ---------------------------------------------------------------------------
// 工作承诺表更新
// ---------------------------------------------------------------------------

interface LedgerUpdate {
  readonly work_item: WorkItem | null;
  readonly created: boolean;
}

/**
 * `update_work_ledger_when_applicable(message)`：
 * **只有工作请求**建立工作项（`WorkItem` 的键是 `request_id`，见附录 A5）。
 *
 * - 同一 `request_id` 的第二条消息（不同 `message_id`）：**不重复建项**，
 *   只把该消息登记进 `triggering_message_ids`（Q4-a）。这既满足"重复建业务工作"的探测器，
 *   也满足 A04-C"内容相同但 id 不同"时两条消息各自可追踪。
 * - 工作结果 / 阻塞报告 / 公共进度不建项：结果与依赖解除归 D05（依赖解除不产生新工作项，
 *   而是把等待项转回可运行 —— Q5-c）。
 */
function updateWorkLedger(
  tx: StorageTransaction,
  message: GroupMessage,
  at: LogicalTime,
): LedgerUpdate {
  if (message.type !== 'work_request') {
    return { work_item: null, created: false };
  }
  const requestId = message.request_id;
  if (requestId === undefined) {
    // 工作请求缺 request_id：没有可追踪的请求身份，建项会让工作承诺表出现"无身份项"。
    return { work_item: null, created: false };
  }

  const existing = tx.getWorkItem(requestId);
  if (existing === undefined) {
    const item = createWorkItem({
      request_id: requestId,
      owner_instance_id: message.recipient_instance_id,
      created_at: at,
      task_id: message.task_id,
      task_revision: message.task_revision,
      description: payloadContent(message) ?? `工作请求 ${requestId}`,
      expected_output: payloadText(message, 'expected_output') ?? '',
      status: 'pending',
      blocker_reason: PENDING_BLOCKER,
      // 结果引用**不**取自消息的 artifact_refs：那是请求的输入/来源声明，
      // 而 `result_refs` 的语义是"本项产生了什么"（附录 A6/A5），只能由完成发布写入（P4-10）。
      triggering_message_ids: [message.message_id],
      updated_at: at,
    });
    tx.putWorkItem(item);
    return { work_item: item, created: true };
  }

  if (existing.triggering_message_ids.includes(message.message_id)) {
    return { work_item: null, created: false };
  }
  try {
    // 单一写路径：走 D04 的转换判定（非终态自环 = 只更新元数据，绝不改变状态）。
    const next = applyWorkItemTransition({
      item: existing,
      to: existing.status,
      at,
      origin: { kind: 'kernel', note: '同一 request_id 的第二条消息：登记触发消息' },
      add_triggering_message_ids: [message.message_id],
    });
    tx.putWorkItem(next);
    return { work_item: next, created: false };
  } catch (error) {
    if (!isWorkLedgerError(error)) {
      throw error;
    }
    // 终态项不接受任何改写（D04 的 `terminal_locked`）。**不因此回滚投递**：
    // 消息守恒优先（A02-09/A03-05 要求消息一条不少），该消息仍然可靠入箱，
    // 只是登记不到一个已冻结的历史项上——由此产生的"读过但未完成"由 D05/D09 看见。
    return { work_item: null, created: false };
  }
}

// ---------------------------------------------------------------------------
// 任务控制状态（取消 / 需求更新）
// ---------------------------------------------------------------------------

interface ControlUpdate {
  readonly state: TaskControlState | null;
}

/**
 * `update_task_control_state_first(message)`（§9.3 / B4 / Q6-c）：
 * 取消与需求更新**在同一事务内**落到任务控制状态与目标工作项，不靠"作为普通群消息排队"生效。
 *
 * 取消的两个动作：
 * 1. 目标工作项（`reply_to ?? request_id` 指向的项）非终态 → 内核发起转 `cancelled`，
 *    取消原因落 `blocker_reason.detail`（D04 因 protocol 无该字段所定的载体，R14-1）；
 * 2. 任务控制状态记 `cancelled = true`（不可被后续需求更新撤销）。
 *
 * 注意 `onMessageInTransaction` 里对取消消息把收件箱条目标为**安静**（`requires_wakeup = false`）：
 * 取消既已同步生效，就没有"为它起一轮"的必要；否则会多出一轮无有效工作的轮次，
 * 并让 P4-08「取消后空推进不产生新轮次」失真（详见那里的注释）。
 */
function handleControlMessage(
  tx: StorageTransaction,
  message: GroupMessage,
  at: LogicalTime,
  authorizedCancelTarget?: RequestId | null,
): ControlUpdate {
  const isCancel = message.type === 'cancel';
  const isRequirementUpdate = message.type === 'requirement_update';
  if (!isCancel && !isRequirementUpdate) {
    return { state: null };
  }

  const reason =
    payloadText(message, 'reason') ??
    payloadText(message, 'detail') ??
    (isCancel ? '用户取消（未附原因）' : '用户需求更新（未附说明）');

  if (isCancel) {
    const targetRequestId = authorizedCancelTarget ?? message.reply_to ?? message.request_id;
    if (targetRequestId !== undefined) {
      const item = tx.getWorkItem(targetRequestId);
      if (item !== undefined && !isTerminalStatus(item.status)) {
        const cancelled = applyWorkItemTransition({
          item,
          to: 'cancelled',
          at,
          origin: { kind: 'kernel', note: `取消消息 ${message.message_id}` },
          cancellation_reason: reason,
          add_triggering_message_ids: [message.message_id],
        });
        tx.putWorkItem(cancelled);
      }
    }
  }

  const current =
    tx.getTaskControlState(message.task_id) ??
    createTaskControlState({ task_id: message.task_id, updated_at: at });
  const intent = applyTaskControlIntent(current, {
    kind: isCancel ? 'cancel' : 'requirement_update',
    message_id: message.message_id,
    task_revision: message.task_revision,
    at,
    reason,
  });
  tx.putTaskControlState(intent);

  return { state: intent };
}

// ---------------------------------------------------------------------------
// 失败出口
// ---------------------------------------------------------------------------

/** 事务未接受时的出口（三值的 `failed`；合同 §九-1：不得报告已接受）。 */
export function rejectedOutcome(
  message: GroupMessage,
  failureReason: string,
): OnMessageOutcome {
  return Object.freeze({
    result: 'failed' as const,
    message_id: message.message_id,
    request_id: message.request_id ?? null,
    recipient_instance_id: message.recipient_instance_id,
    inbox_entry: null,
    duplicate_of: null,
    failure_reason: failureReason,
    work_item: null,
    work_item_created: false,
    queued: false,
    merged_wakeup: false,
    stale_revision: false,
    task_registered: false,
    task_control_state: null,
    observation_events: Object.freeze([]),
    delivery_events: Object.freeze([]),
  });
}

/** 把捕获到的异常压成人可读原因（与 D02 的 `deliverMessage` 同一口径）。 */
export function describeEntryFailure(error: unknown): string {
  if (error instanceof PersistenceError) {
    const cause = error.cause;
    return cause instanceof Error ? cause.message : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
