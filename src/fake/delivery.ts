/**
 * 投递入口 fixture：按脚本构造并记录一次投递（归属 D06，`src/fake/`）。
 *
 * 对应验收规格 0.3 第 1 条：「按指定的 message_id / request_id / 发送者 / 目标 / 类型 /
 * 是否需唤醒 / 内容语义构造并投递；返回三值之一——`已接受` / `重复且未新建` / `失败`」。
 *
 * 边界（重要）：**本模块不实现内核的消息入口**。它只做两件事：
 * 1. 用 D01 的 `createMessage()` 把脚本构造为一条 `GroupMessage`（发送者经 `SenderBinder` 绑定，
 *    草稿里没有 sender 字段——P8 的字段约束由 D01 的结构保证，这里不绕过）；
 * 2. 把投递结果（D01 的三值 `DeliveryResult`）与夹具逻辑步号记成可追踪回执。
 * 「落库 + 去重 + 排队」一律由 D02/D03 经由 `src/storage` 完成。
 */

import {
  asArtifactRef,
  createIdSource,
  createMessage,
  SenderBinding,
  type ArtifactRef,
  type CapabilityId,
  type DeliveryResult,
  type GroupId,
  type GroupMessage,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type MessageType,
  type RequestId,
  type Revision,
  type TaskId,
} from '../protocol/index.js';
import { contentDigest } from './digest.js';
import { FakeAgentScriptError } from './errors.js';

/**
 * 发送者绑定接缝。
 *
 * `GroupMessage.sender_instance_id` 只能经 `SenderBinding.bind()` 落到消息上（D01 的名义化类型），
 * 本接缝把这个动作显式化：内核入口用默认实现；P8 的负向用例（伪造发送者 / 错误路由）
 * 可以换一个**拒绝式**实现来证明「未绑定的发送者无法进入有效收件箱」。
 */
export interface SenderBinder {
  bind(
    senderInstanceId: InstanceId,
    scope: { readonly group_id: GroupId; readonly task_id: TaskId },
  ): SenderBinding;
}

/** 默认绑定器：直接调用 D01 的内核绑定入口。 */
export const kernelSenderBinder: SenderBinder = {
  bind: (senderInstanceId: InstanceId, scope: { group_id: GroupId; task_id: TaskId }): SenderBinding =>
    SenderBinding.bind(senderInstanceId, scope),
};

/** 拒绝一切绑定的接缝（P8 负向：未绑定的发送者）。 */
export const rejectingSenderBinder: SenderBinder = {
  bind: (senderInstanceId: InstanceId): SenderBinding => {
    throw new FakeAgentScriptError(
      `拒绝绑定发送者 ${senderInstanceId}：该来源未经内核校验（P8 负向用例）`,
    );
  },
};

/**
 * `requires_wakeup` 的默认值（合同冻结 v1.1 的 **R2** 裁决）：
 * - 公共进度类消息 `stage_result` 默认 `false`（只写收件箱与公共上下文，**不**标记可执行输入、**不**入队）；
 * - 其余消息类型默认 `true`。
 *
 * 依据：任务书:201「仅发布公共进度 → 不默认唤醒所有成员」；
 * 这是 A03「公共进度不触发多余轮次」的实现依据（内核在 `on_message` 事务里按本字段分支）。
 */
export function defaultRequiresWakeup(type: MessageType): boolean {
  return type !== 'stage_result';
}

/** 一次投递的构造输入（对应验收规格 0.3 第 1 条的字段清单）。 */
export interface DeliveryRequestInput {
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly task_revision: Revision;
  /** **测试直接注入**的 message_id（Q3-a：内核必须接受注入，A04 依赖）。 */
  readonly message_id: MessageId;
  readonly sender_instance_id: InstanceId;
  /** 落定的具体接收实例（Q1-c：不得用能力名代替身份）。 */
  readonly recipient_instance_id: InstanceId;
  readonly type: MessageType;
  /** 内容语义（A04-C 用它证明两条消息「逐字相同」）。 */
  readonly content: string;
  /**
   * 是否需唤醒接收者。**省略时按 R2 默认值推导**（`stage_result` → false，其余 → true）。
   * 落库消息上该字段恒为显式布尔值（合同 v1.1 R2「每条消息显式带 requires_wakeup」）。
   */
  readonly requires_wakeup?: boolean;
  readonly request_id?: RequestId;
  readonly reply_to?: RequestId;
  readonly artifact_refs?: readonly ArtifactRef[];
  readonly target_capability?: CapabilityId;
  readonly at?: LogicalTime;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** 构造好的一条待投递消息（含内容语义与指纹）。 */
export interface DeliveryRequest {
  readonly message: GroupMessage;
  readonly content: string;
  /** 内容指纹（`sha256:...`）：A04-C 的「内容逐字相同」自证。 */
  readonly content_fingerprint: string;
  readonly request_id: RequestId | null;
  readonly sender_instance_id: InstanceId;
  readonly recipient_instance_id: InstanceId;
  /** 落库消息上的显式唤醒标记（R2：恒为布尔值，绝不留空）。 */
  readonly requires_wakeup: boolean;
  readonly at: LogicalTime;
}

export interface DeliveryRequestDeps {
  readonly binder?: SenderBinder;
}

/**
 * 由脚本构造一条待投递消息。
 *
 * `message_id` 一律显式给出并原样采用（A04 需要同一 id 重复投递），
 * `payload` 默认承载 `{ content }`，使内容语义可靠落库。
 */
export function createDeliveryRequest(
  input: DeliveryRequestInput,
  deps: DeliveryRequestDeps = {},
): DeliveryRequest {
  if (typeof input.content !== 'string') {
    throw new FakeAgentScriptError('投递内容语义必须是字符串');
  }
  const binder = deps.binder ?? kernelSenderBinder;
  // 绑定携带 (sender, group, task) 三元组，且必须与消息草稿同源（合同 v1.2 R35.2）。
  const binding = binder.bind(input.sender_instance_id, {
    group_id: input.group_id,
    task_id: input.task_id,
  });
  // R2：保留字面上显式给出的值；省略时按消息类型推导（stage_result → false）。
  const requiresWakeup = input.requires_wakeup ?? defaultRequiresWakeup(input.type);

  const message = createMessage(
    {
      message_id: input.message_id,
      task_id: input.task_id,
      group_id: input.group_id,
      task_revision: input.task_revision,
      recipient_instance_id: input.recipient_instance_id,
      ...(input.target_capability === undefined
        ? {}
        : { target_capability: input.target_capability }),
      type: input.type,
      ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
      ...(input.reply_to === undefined ? {} : { reply_to: input.reply_to }),
      requires_wakeup: requiresWakeup,
      payload: { content: input.content, ...(input.payload ?? {}) },
      ...(input.artifact_refs === undefined ? {} : { artifact_refs: input.artifact_refs }),
      ...(input.at === undefined ? {} : { created_at: input.at }),
    },
    binding,
    // message_id 恒为显式注入，此生成器不会被调用。
    { idSource: createIdSource() },
  );

  return {
    message,
    content: input.content,
    content_fingerprint: contentDigest(input.content),
    request_id: input.request_id ?? null,
    sender_instance_id: input.sender_instance_id,
    recipient_instance_id: input.recipient_instance_id,
    requires_wakeup: requiresWakeup,
    at: input.at ?? message.created_at,
  };
}

/** 一次投递尝试的回执（结果三值 + 夹具逻辑步号，不用墙钟）。 */
export interface DeliveryReceipt {
  readonly message_id: MessageId;
  readonly request_id: RequestId | null;
  readonly sender_instance_id: InstanceId;
  readonly recipient_instance_id: InstanceId;
  /** D01 的三值结果：`accepted` / `duplicate_not_created` / `failed`。 */
  readonly result: DeliveryResult;
  readonly step: LogicalTime;
  /** 投递时已完成的调度推进次数（`0` = 仍在任何快照冻结之前）。 */
  readonly advance_seq: number;
  readonly content_fingerprint: string;
  readonly note?: string;
}

/** 造一条投递回执。 */
export function makeDeliveryReceipt(
  request: DeliveryRequest,
  result: DeliveryResult,
  context: { readonly step: LogicalTime; readonly advance_seq: number; readonly note?: string },
): DeliveryReceipt {
  return {
    message_id: request.message.message_id,
    request_id: request.request_id,
    sender_instance_id: request.sender_instance_id,
    recipient_instance_id: request.recipient_instance_id,
    result,
    step: context.step,
    advance_seq: context.advance_seq,
    content_fingerprint: request.content_fingerprint,
    ...(context.note === undefined ? {} : { note: context.note }),
  };
}

/** 投递记录汇总（观测字段表要的「消息 ID 列表 / 请求 ID 列表 / 返回值」三件套）。 */
export interface DeliveryLogSnapshot {
  readonly total: number;
  readonly accepted: number;
  readonly duplicate_not_created: number;
  readonly failed: number;
  readonly message_ids_in_order: readonly MessageId[];
  readonly request_ids_in_order: readonly RequestId[];
  readonly receipts: readonly DeliveryReceipt[];
}

/**
 * 投递日志：按投递顺序记录每次调用及其三值结果。
 * A02-04/05/09、A04-01/04/06 的守恒与反作弊断言直接取自这里。
 */
export class DeliveryLog {
  readonly #receipts: DeliveryReceipt[] = [];

  get size(): number {
    return this.#receipts.length;
  }

  get receipts(): readonly DeliveryReceipt[] {
    return this.#receipts;
  }

  /** 记一条投递回执。 */
  record(receipt: DeliveryReceipt): DeliveryReceipt {
    this.#receipts.push(receipt);
    return receipt;
  }

  /** 按投递顺序的消息 id 列表（含重复——重复正是 A04 要看的东西）。 */
  messageIdsInOrder(): readonly MessageId[] {
    return this.#receipts.map((receipt) => receipt.message_id);
  }

  /** 按投递顺序的请求 id 列表（无请求 id 的回执缺席）。 */
  requestIdsInOrder(): readonly RequestId[] {
    const ids: RequestId[] = [];
    for (const receipt of this.#receipts) {
      if (receipt.request_id !== null) ids.push(receipt.request_id);
    }
    return ids;
  }

  /** 取某 message_id 的全部回执（A04 的重复投递证据）。 */
  receiptsFor(messageId: MessageId): readonly DeliveryReceipt[] {
    return this.#receipts.filter((receipt) => receipt.message_id === messageId);
  }

  /** 汇总。 */
  snapshot(): DeliveryLogSnapshot {
    let accepted = 0;
    let duplicate = 0;
    let failed = 0;
    for (const receipt of this.#receipts) {
      if (receipt.result === 'accepted') accepted += 1;
      else if (receipt.result === 'duplicate_not_created') duplicate += 1;
      else failed += 1;
    }
    return {
      total: this.#receipts.length,
      accepted,
      duplicate_not_created: duplicate,
      failed,
      message_ids_in_order: this.messageIdsInOrder(),
      request_ids_in_order: this.requestIdsInOrder(),
      receipts: [...this.#receipts],
    };
  }
}

/** 造一个结果产物引用（确定、可追溯；首轮不产出真实文件）。 */
export function artifactRefFor(requestId: RequestId, suffix = 'result'): ArtifactRef {
  return asArtifactRef(`${requestId}#${suffix}`);
}
