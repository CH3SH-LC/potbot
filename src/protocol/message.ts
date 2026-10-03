/**
 * 群消息（附录 A4 GroupMessage；合同 §二 / §三）。
 *
 * 四条硬语义：
 * 1. **发送者身份由内核绑定**（合同 Q3-a / 需求 8 / P8；修复批 R35.2）：模型可提供的
 *    `MessageDraft` 里**没有** sender 字段；`GroupMessage.sender_instance_id` 只能经
 *    内核签发的 `SenderBinding` 绑定。绑定是**签发**对象：实例 `Object.freeze`，并登记进
 *    模块私有 `WeakSet`，判据见 `isKernelIssuedBinding()`。
 * 2. **显式实例标识**（合同 Q1-c）：落库消息的接收者恒为具体 `instance_id`；
 *    `target_capability` 只作为原始寻址声明的溯源保留，**绝不作为身份**。
 * 3. **message_id 由内核生成**，但内核**必须接受测试直接注入任意 message_id**（Q3-a，A04 依赖）。
 * 4. **绑定与消息必须同源**（R35.2）：`createMessage` 校验
 *    `draft.group_id === binding.group_id` 且 `draft.task_id === binding.task_id`，
 *    跨群 / 跨任务的绑定直接抛错，不落库。
 *
 * ## 信任边界（合同 v1.2 R35.4，必须如实声明，不得夸大）
 *
 * 本机制保护的是**不可信消息输入**：模型侧提供的消息体（`MessageDraft`）不得自带发送者身份，
 * 落库消息的身份只能来自内核签发的 `SenderBinding`。它挡住的是
 * `Object.create(SenderBinding.prototype)`、结构化字面量、事后在原型链上伪造并冻结的对象，
 * 以及"冻结副本改 `sender_instance_id`"这类**消息体侧**的伪造。
 *
 * 它**不宣称**同进程任意恶意代码的完全隔离：任何能 import 本模块的代码仍可调用
 * `SenderBinding.bind()` 自行签发一个完全合法的绑定。`bind()` 是**内核内部入口**，
 * 不是对外授权接口；内核的权限门是"入口只接受内核构造的消息"这一约定，
 * 以及对已注册成员、群身份与接收路由的校验（归调度入口）。因此本模块的结论只能声明到
 * 「消息输入侧不可伪造 + 绑定签发登记可核对」这一层。
 */

import {
  asMessageId,
  type CapabilityId,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type TaskId,
  type ArtifactRef,
} from './ids.js';
import { MESSAGE_TYPE_LABELS, type MessageType, type TrustLabel } from './constants.js';
import { ValidationError } from './errors.js';

/**
 * 内核签发的发送者身份绑定（合同 v1.2 R35.2）。
 *
 * 与 v1.1 的区别：v1.1 的运行时判据只有 `instanceof`，因此
 * `Object.create(SenderBinding.prototype)` 能通过；本版把判据升级为
 * **`instanceof` + 模块私有登记 + 冻结**三合一（见 `isKernelIssuedBinding()`）。
 *
 * - 私有成员 `kernelBound` 仍需保留：它使本类**名义化**，任何对象字面量或结构等价类型
 *   都无法被*赋值*给 `SenderBinding`（编译期约束，测试用 `@ts-expect-error` 固化）。
 * - 运行时另有**签发登记**：只有经 `bind()` 构造、`Object.freeze` 并登记进模块私有
 *   `WeakSet` 的实例才算合法。模块外无法访问该 `WeakSet`，因此事后在
 *   `SenderBinding.prototype` 上伪造并冻结的对象仍然失败。
 * - 绑定的构造入口是 `SenderBinding.bind(sender, { group_id, task_id })`：只由内核的
 *   消息入口事务调用；模型不得触达（信任边界见文件头注释 R35.4）。
 */
export class SenderBinding {
  readonly sender_instance_id: InstanceId;
  /** 绑定的群身份：`GroupMessage.group_id` 必须与之一致（R35.2 第 3 项）。 */
  readonly group_id: GroupId;
  /** 绑定的任务身份：`GroupMessage.task_id` 必须与之一致（R35.2 第 3 项）。 */
  readonly task_id: TaskId;
  readonly bound_by_kernel: true = true;
  /** 名义化锚点：结构性伪造无法满足本私有成员（**仅编译期**）。 */
  private readonly kernelBound!: never;

  private constructor(senderInstanceId: InstanceId, groupId: GroupId, taskId: TaskId) {
    this.sender_instance_id = senderInstanceId;
    this.group_id = groupId;
    this.task_id = taskId;
  }

  /**
   * 内核侧签发入口：构造 → `Object.freeze` → 登记进模块私有 `WeakSet`。
   *
   * 三步缺一不可：只冻结不登记会被"事后伪造并冻结"绕过；只登记不冻结会被
   * `Object.assign` 改掉 `sender_instance_id` 后继续用。
   */
  static bind(
    senderInstanceId: InstanceId,
    options: { group_id: GroupId; task_id: TaskId },
  ): SenderBinding {
    const instance = new SenderBinding(
      senderInstanceId,
      options.group_id,
      options.task_id,
    );
    Object.freeze(instance);
    KERNEL_ISSUED_BINDINGS.add(instance);
    return instance;
  }
}

/**
 * 内核签发登记表：**模块私有**（不在 `index.ts` 导出，也不出现在任何公开 API 上）。
 * 只记录经 `SenderBinding.bind()` 签发的实例，是 `isKernelIssuedBinding()` 的第二判据。
 */
const KERNEL_ISSUED_BINDINGS = new WeakSet<object>();

/**
 * 是否为**内核签发**的发送者绑定（合同 v1.2 R35.2）。三条同时成立才为真：
 *
 * 1. `value instanceof SenderBinding` —— 挡住结构化字面量 / 结构等价对象；
 * 2. `KERNEL_ISSUED_BINDINGS.has(value)` —— 挡住 `Object.create(SenderBinding.prototype)`
 *    这类在原型链上伪造、但从未经 `bind()` 登记的对象；
 * 3. `Object.isFrozen(value)` —— 挡住对已签发对象"解开再改"的路径（冻结不可逆，此条为
 *    纵深防御：它与登记互为冗余，任何一条被绕过仍有一层）。
 *
 * 注意 `Object.create(SenderBinding.prototype)` 能通过第 1 条，但过不了第 2 条；
 * 一个字面量对象连第 1 条都过不了。
 */
export function isKernelIssuedBinding(value: unknown): value is SenderBinding {
  return (
    value instanceof SenderBinding &&
    KERNEL_ISSUED_BINDINGS.has(value) &&
    Object.isFrozen(value)
  );
}

/**
 * 模型 / 调用方可提供的消息草稿：**没有 sender 字段**，也没有 resolved recipient 之外的走私通道。
 * `message_id` 可选：省略时由内核生成，提供时原样采用（Q3-a 注入）。
 */
export interface MessageDraft {
  readonly message_id?: MessageId;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly task_revision: Revision;
  /** 解析后落定的**具体接收实例**（Q2-a：入箱目标必须在入队前确定）。 */
  readonly recipient_instance_id: InstanceId;
  /** 原始能力寻址声明（仅溯源，不参与身份判定）。 */
  readonly target_capability?: CapabilityId;
  readonly type: MessageType;
  readonly request_id?: RequestId;
  readonly reply_to?: RequestId;
  /** 是否需要唤醒接收者（合同 Q2-a/Q2-d：与路由是同一入口事务的两个分支）。 */
  readonly requires_wakeup: boolean;
  readonly payload?: unknown;
  readonly artifact_refs?: readonly ArtifactRef[];
  readonly source_refs?: readonly string[];
  readonly trust_label?: TrustLabel;
  readonly created_at?: LogicalTime;
}

/** 消息如何被寻址（用于溯源；身份一律以 `recipient_instance_id` 为准）。 */
export type MessageAddressedVia = 'recipient' | 'target_capability';

/** 落库的群消息记录（附录 A4）。 */
export interface GroupMessage {
  readonly message_id: MessageId;
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly task_revision: Revision;
  /** 内核绑定的发送者实例身份（模型不得伪造）；与 `sender_binding.sender_instance_id` 恒等。 */
  readonly sender_instance_id: InstanceId;
  /**
   * 内核签发的发送者绑定（R35.2）：冻结记录的一部分，入口鉴权凭此判别身份来源。
   * 判据见 `isKernelIssuedBinding()`。
   */
  readonly sender_binding: SenderBinding;
  /** 解析后的具体接收实例身份（Q1-c：不得用模板名/能力名代替）。 */
  readonly recipient_instance_id: InstanceId;
  readonly addressed_via: MessageAddressedVia;
  readonly target_capability?: CapabilityId;
  readonly type: MessageType;
  readonly request_id?: RequestId;
  readonly reply_to?: RequestId;
  readonly requires_wakeup: boolean;
  readonly payload?: unknown;
  readonly artifact_refs: readonly ArtifactRef[];
  readonly source_refs: readonly string[];
  readonly trust_label: TrustLabel;
  readonly created_at: LogicalTime;
}

/** `createMessage` 需要的额外输入，全部由调用方显式给出（本模块不做路由解析）。 */
export interface CreateMessageOptions {
  /** 消息 id 生成器；仅在 `draft.message_id` 省略时调用。 */
  readonly idSource: { newMessageId(): MessageId };
}

/**
 * 由内核构造一条可用消息（**本合同里唯一的消息构造入口**）。
 *
 * - sender 只能来自 `binding`：即使调用方在运行时多塞一个 `sender_instance_id`，
 *   也会被忽略（P8 的字段约束在运行时同样成立）。
 * - `binding` 必须是**内核签发**的（`isKernelIssuedBinding`），且其 `group_id` / `task_id`
 *   必须与 draft 同源；否则抛 `ValidationError`，消息不落库。
 * - `message_id` 省略时经 `idSource` 生成，提供时原样采用（A04 需要注入固定 id）。
 */
export function createMessage(
  draft: MessageDraft,
  binding: SenderBinding,
  options: CreateMessageOptions,
): GroupMessage {
  if (!isKernelIssuedBinding(binding)) {
    throw new ValidationError(
      'sender 必须由内核通过 SenderBinding.bind() 签发并登记，模型不得自带或伪造绑定',
    );
  }
  // 运行时防御：JS 调用方可能漏传（Q1-c：不得以能力名/模板名代替实例身份）。
  if (typeof (draft as { recipient_instance_id?: unknown }).recipient_instance_id !== 'string') {
    throw new ValidationError('必须给出解析后的 recipient_instance_id（不得以能力名代替实例身份）');
  }
  // R35.2：绑定与消息必须同源，禁止跨群 / 跨任务复用绑定。
  if (draft.group_id !== binding.group_id) {
    throw new ValidationError(
      'sender_binding 的 group_id 与消息 group_id 不一致：发送者绑定必须与消息同群',
    );
  }
  if (draft.task_id !== binding.task_id) {
    throw new ValidationError(
      'sender_binding 的 task_id 与消息 task_id 不一致：发送者绑定必须与消息同任务',
    );
  }
  const messageId = draft.message_id ?? options.idSource.newMessageId();
  return Object.freeze({
    message_id: asMessageId(messageId),
    task_id: draft.task_id,
    group_id: draft.group_id,
    task_revision: draft.task_revision,
    sender_instance_id: binding.sender_instance_id,
    sender_binding: binding,
    recipient_instance_id: draft.recipient_instance_id,
    addressed_via: draft.target_capability === undefined ? 'recipient' : 'target_capability',
    ...(draft.target_capability === undefined
      ? {}
      : { target_capability: draft.target_capability }),
    type: draft.type,
    ...(draft.request_id === undefined ? {} : { request_id: draft.request_id }),
    ...(draft.reply_to === undefined ? {} : { reply_to: draft.reply_to }),
    requires_wakeup: draft.requires_wakeup,
    ...(draft.payload === undefined ? {} : { payload: draft.payload }),
    artifact_refs: draft.artifact_refs ?? [],
    source_refs: draft.source_refs ?? [],
    trust_label: draft.trust_label ?? 'agent',
    created_at: draft.created_at ?? (0 as LogicalTime),
  });
}

/** 消息类型的中文标签（证据输出用）。 */
export function messageTypeLabel(type: MessageType): string {
  return MESSAGE_TYPE_LABELS[type];
}
