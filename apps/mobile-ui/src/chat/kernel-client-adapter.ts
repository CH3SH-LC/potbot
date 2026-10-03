/**
 * F02 chat —— KernelClient 传输接线（把「发送命令」下发、把 v1 `Event` 流接进 reducer）。
 *
 * 这个模块补的是 F02 自己标注的缺口：「本包只产出命令对象、并**接收** `Event` 做归约，
 * 但未真正订阅传输」。它把三件事接起来：
 *
 *   1) 命令下发：`buildSendCommandForState` → `KernelClientPort.sendCommand`；
 *      命令在 `metadata.attachments` 里只带**描述**（`AttachmentDescriptor`，**不含**
 *      任何字节，也不带 `bytesRead` 字段）——附件仍是占位。
 *   2) 事件归约：把订阅到的 v1 `Event` 翻译成 reducer 动作 `kernelEvent`；
 *      事件流断开翻译成 `eventStreamEnded`（任务 → `progressUnknown`）。
 *   3) 完成判定：沿用 reducer 的 `isMessageFullyDone`（正文 `complete` **且** 任务
 *      `succeeded` 且带 `resultRef`），本模块**不另立**完成口径。
 *
 * **真实缺陷（本模块要挡住的）**：传输「抛出 / 中止」时，如果适配层什么都不做，界面会
 * 一直停在 pending/streaming；更糟的是有人把「正文收完」当成完成。规则是：
 *   - 传输抛出/中止 ⇒ 同时投递 `streamEnded`（正文流无终帧 ⇒ `interrupted`）
 *     与 `eventStreamEnded`（事件流断 ⇒ `progressUnknown`）；
 *   - **任何**中断路径都**不产生** `complete`，也不产生「succeeded 无 resultRef」的假成功。
 *
 * 关于 `KernelClientPort`：真实的 `apps/mobile-ui/src/platform/KernelClient` 由 F 线协调者
 * 单写（本包不改公共文件）。这里只声明**结构化端口**，协调者的实现只要具备同名同形方法即
 * 可结构化满足（无需 import 本文件）。端口刻意不暴露字节读取：本层不读文件字节。
 */

import type {
  Command,
  Event,
  StreamChunk,
} from '../../../../contracts/mobile-v1/types.js';
import { buildSendCommandForState } from './command.js';
import { getMessage, isMessageFullyDone } from './reducer.js';
import type { ChatAction, ChatState } from './types.js';

// ---------------------------------------------------------------------------
// 端口（由 F 线协调者单写的 src/platform/KernelClient 结构化实现）
// ---------------------------------------------------------------------------

/** 订阅取消句柄。调用后该订阅不再投递任何事件。 */
export type Unsubscribe = () => void;

/** 事件流断开的原因（**只**描述断开方式，不含错误体/密钥/本地路径）。 */
export type KernelStreamBreakReason =
  | 'transport-error'
  | 'aborted'
  | 'closed'
  | 'unknown';

/** 事件流断开信号（脱敏）。 */
export interface KernelStreamBreak {
  readonly reason: KernelStreamBreakReason;
  /** 可读说明；调用方不得在此放密钥、请求体或本地路径。 */
  readonly message: string;
}

/**
 * 内核客户端端口（结构化接口）。真实实现见 `src/platform/KernelClient`（协调者所有）。
 *
 * `sendCommand`：把一条 v1 `Command` 下发给内核。返回/Promise 拒绝均表示**未成功下发**。
 * `subscribe`：订阅某命令的 v1 `Event` 流。`onEvent` 收到事件；`onBreak` 表示流断开
 * （错误/中止），**不是**正常结束——正常完成是通过一条终态事件表达的。
 */
export interface KernelClientPort {
  sendCommand(command: Command): void | Promise<void>;
  subscribe(
    commandId: string,
    onEvent: (event: Event) => void,
    onBreak: (breakEvent: KernelStreamBreak) => void,
  ): Unsubscribe;
}

/** reducer 投递入口：适配层只发动作，不直接改状态。 */
export type ChatDispatch = (action: ChatAction) => void;

// ---------------------------------------------------------------------------
// 附件「只带描述」守卫
// ---------------------------------------------------------------------------

/**
 * `AttachmentDescriptor` 允许的键（见 `command.ts`）。**没有** `bytesRead`、`bytes`、
 * `content`、`path` 等——描述里不许出现字节或字节来源字段。
 */
const DESCRIPTOR_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'mime',
  'byteLength',
  'uri',
  'uriRejected',
]);

/**
 * 断言命令里的附件描述**只有结构、没有字节**。任何白名单外的键（例如有人塞进
 * `bytes`/`content`/`bytesRead`/`path`）一律抛错——把「附件是占位」这条从类型约定
 * 升级成运行时可拦截的守卫。
 */
export function assertAttachmentsDescriptorOnly(command: Command): void {
  const attachments = command.metadata?.['attachments'];
  if (attachments === undefined) return;
  if (!Array.isArray(attachments)) {
    throw new Error('attachments-descriptor-invalid: attachments 不是数组');
  }
  attachments.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`attachments-descriptor-invalid: 第 ${index} 项不是对象`);
    }
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!DESCRIPTOR_KEYS.has(key)) {
        throw new Error(`attachments-descriptor-not-allowed: 附件描述含不允许的键 ${key}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/** 一次发送的结果。**`submitted` 不代表任务完成**，只表示命令已交给内核。 */
export interface SendOutcome {
  readonly messageId: string;
  /** 构造出的命令 id；本地前置条件不满足时为 null。 */
  readonly commandId: string | null;
  /** 命令是否成功交给内核（不含任务是否成功）。 */
  readonly submitted: boolean;
  /** 传输是否断开（抛出 / 订阅失败 / `onBreak`）。 */
  readonly broken: boolean;
  readonly breakReason: KernelStreamBreakReason | null;
  /** 本地前置条件不满足（例如找不到可发送的用户正文）：**不发命令**，也不编造正文。 */
  readonly preconditionFailed: boolean;
}

/** 适配器对外能力。 */
export interface ChatKernelAdapter {
  /**
   * 发送一条助手消息对应的命令：构造 → 绑定 → 订阅 → 下发。
   * 任何传输失败都会投递中断信号（`streamEnded` + `eventStreamEnded`），绝不置完成。
   */
  send(state: ChatState, messageId: string): Promise<SendOutcome>;
  /** 投递一帧模型正文分片（尝试 id 从 state 中的助手消息读取）。 */
  deliverChunk(state: ChatState, messageId: string, chunk: StreamChunk, seq?: number): void;
  /** 消息是否**真的**完成（两条流都到位）。语义同 reducer.isMessageFullyDone。 */
  isFullyDone(state: ChatState, messageId: string): boolean;
  /** 释放全部订阅；释放后再 send 会抛错。 */
  dispose(): void;
}

const BREAK_MESSAGE: Readonly<Record<KernelStreamBreakReason, string>> = {
  'transport-error': '内核传输异常，命令未能完成',
  aborted: '内核传输被中止，命令未能完成',
  closed: '内核事件流已关闭，命令进度不可知',
  unknown: '内核事件流中断，命令进度不可知',
};

/**
 * 创建传输适配器。
 *
 * @param client   内核客户端端口（协调者的 KernelClient 结构化实现）。
 * @param dispatch reducer 动作投递函数。
 */
export function createChatKernelAdapter(client: KernelClientPort, dispatch: ChatDispatch): ChatKernelAdapter {
  const subscriptions = new Set<Unsubscribe>();
  let disposed = false;

  /**
   * 投递「两条流都断了」的信号：
   *   - `streamEnded`：正文流没有终帧就结束 ⇒ `interrupted`（**绝不** complete）；
   *   - `eventStreamEnded`：事件流断开 ⇒ 未终态任务标 `progressUnknown`（**绝不** 成功）。
   */
  function signalBreak(messageId: string, reason: KernelStreamBreakReason): void {
    void reason; // 原因仅供调用方观测；reducer 动作不携带，避免泄漏错误体
    dispatch({ type: 'streamEnded', messageId });
    dispatch({ type: 'eventStreamEnded', messageId });
  }

  function remember(unsubscribe: Unsubscribe): void {
    if (disposed) {
      safeUnsubscribe(unsubscribe);
      return;
    }
    subscriptions.add(unsubscribe);
  }

  function forget(unsubscribe: Unsubscribe): void {
    subscriptions.delete(unsubscribe);
    safeUnsubscribe(unsubscribe);
  }

  function safeUnsubscribe(unsubscribe: Unsubscribe): void {
    try {
      unsubscribe();
    } catch {
      // 取消订阅失败不应把发送路径带崩。
    }
  }

  async function send(state: ChatState, messageId: string): Promise<SendOutcome> {
    if (disposed) throw new Error('adapter-disposed');
    const base = {
      messageId,
      commandId: null as string | null,
      submitted: false,
      broken: false,
      breakReason: null as KernelStreamBreakReason | null,
      preconditionFailed: false,
    };

    const command = buildSendCommandForState(state, messageId);
    if (command === null) {
      // fail-closed：找不到可发送的用户正文就不发，也不编造内容。
      return { ...base, preconditionFailed: true };
    }
    assertAttachmentsDescriptorOnly(command);

    // 先绑定（记录发送意图），再订阅、再下发：任何一步失败都留下可观测的任务视图。
    dispatch({ type: 'commandSubmitted', messageId, commandId: command.commandId });

    let broken = false;
    let unsubscribe: Unsubscribe | null = null;
    const onBreak = (breakEvent: KernelStreamBreak): void => {
      if (broken) return;
      broken = true;
      signalBreak(messageId, breakEvent.reason);
    };
    const onEvent = (event: Event): void => {
      // E4 命令隔离：串台事件不投递（reducer 还会再兜一层）。
      if (event.commandId !== command.commandId) return;
      // 断流后本订阅已死：迟到事件不再改写状态（绝不制造 complete）。
      if (broken) return;
      dispatch({ type: 'kernelEvent', messageId, event });
    };

    try {
      const raw = client.subscribe(command.commandId, onEvent, onBreak);
      unsubscribe = typeof raw === 'function' ? raw : () => {};
      remember(unsubscribe);
    } catch {
      broken = true;
      signalBreak(messageId, 'transport-error');
      return { ...base, commandId: command.commandId, broken: true, breakReason: 'transport-error' };
    }

    try {
      await client.sendCommand(command);
    } catch {
      if (unsubscribe !== null) forget(unsubscribe);
      broken = true;
      signalBreak(messageId, 'transport-error');
      return { ...base, commandId: command.commandId, broken: true, breakReason: 'transport-error' };
    }

    return { ...base, commandId: command.commandId, submitted: true };
  }

  function deliverChunk(state: ChatState, messageId: string, chunk: StreamChunk, seq?: number): void {
    const message = getMessage(state, messageId);
    const attemptId = message?.attemptId ?? null;
    if (message === null || message.role !== 'assistant' || attemptId === null) return;
    dispatch({
      type: 'streamChunk',
      delivery: { messageId, attemptId, ...(seq === undefined ? {} : { seq }), chunk },
    });
  }

  function isFullyDone(state: ChatState, messageId: string): boolean {
    // 唯一完成口径来自 reducer：正文 complete 且内核任务 succeeded 且带 resultRef。
    return isMessageFullyDone(state, messageId);
  }

  function dispose(): void {
    disposed = true;
    for (const unsubscribe of subscriptions) safeUnsubscribe(unsubscribe);
    subscriptions.clear();
  }

  return { send, deliverChunk, isFullyDone, dispose };
}
