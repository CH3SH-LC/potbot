/**
 * F02 chat —— 对话视图模型的类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包只产出**可断言的视图状态与纯函数**：不渲染、不引框架、不读真实文件字节、
 * 不发网络请求、不持久化。未做项（真实 `KernelClient` 接线、DOM/Android 渲染、
 * 附件真实读取、事件流回填）见本目录 `index.ts` 顶部说明。
 *
 * 只读消费（不改动）：
 *   - `contracts/mobile-v1/types.ts`：v1 契约类型（`Command` / `StreamChunk`）。
 *   - `apps/mobile-ui/src/foundation/tokens.ts`：F01 设计令牌（引用卡配色，见 references.ts）。
 *
 * 核心不变量（由 `tests/mobile-ui/F02/` 机器化断言）：
 *   I1 断流不伪造完成：**只有**显式终帧（chunk.done === true）或终态错误帧才允许
 *      离开 streaming / 进入终态；连接中断（`streamEnded`）只能得到 `interrupted`，
 *      永远得不到 `complete`。
 *   I2 停止即冻结：`stop` 之后的消息不再接受任何 chunk。
 *   I3 尝试隔离：chunk 必须同时匹配 `messageId` 与 `attemptId` 才被应用；重试产生
 *      新的消息/尝试 id，旧尝试迟到的 chunk 与结果不得写入新尝试。
 *   I4 幂等键可复现：发送命令的 `idempotencyKey` 由 (会话, 尝试, 正文) 确定性推导；
 *      重试因尝试 id 不同而得到**不同**的键（否则内核会幂等复用旧结果）。
 *   I5 内核事件 fail-closed：v1 `Event` 的 `succeeded` 必须携带 `resultRef`；缺失即拒绝
 *      标记为成功（见本文件 `KernelTaskView` / `isTaskSucceeded` 与 `events.ts`）。因此
 *      「模型正文收完终帧」与「任务被内核判成功」是**两件事**，只看前者会把断流/未执行
 *      当完成（见 `isMessageFullyDone`）。
 */

import type {
  Command,
  Event,
  EventStatus,
  SchemaVersion,
  StreamChunk,
} from '../../../../contracts/mobile-v1/types.js';

export type { Command, Event, EventStatus, SchemaVersion, StreamChunk };

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/** 视图层消息角色。`system` / `error` 为系统提示与错误提示，不参与流式累积。 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'error';

/**
 * 消息状态机取值。
 *
 *   pending      —— 已创建、尚未收到任何 chunk（助手占位）
 *   streaming    —— 正在累积增量，**不是**完成
 *   complete     —— 收到显式终帧且无错误：唯一的「成功完成」态
 *   interrupted  —— 连接中断/无终帧结束：**非完成**
 *   cancelled    —— 用户停止，或尝试已被重试取代
 *   failed       —— 收到错误帧
 */
export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'complete'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

/** 终态集合：进入其一后不再接受新 chunk（I1、I2）。 */
export const TERMINAL_STATUSES: readonly MessageStatus[] = [
  'complete',
  'interrupted',
  'cancelled',
  'failed',
];

/** 是否终态（不接受后续 chunk）。 */
export function isTerminal(status: MessageStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 是否是「成功完成」——**唯一**可被渲染为成功的状态。 */
export function isCompleted(status: MessageStatus): boolean {
  return status === 'complete';
}

/** 错误帧脱敏后的结构（与契约 event.error 同形，不含密钥/请求体）。 */
export interface MessageError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/** 工具调用足迹（仅结构，本包不执行）。 */
export interface ToolCallTrace {
  readonly toolCallId: string;
  readonly toolName: string;
}

/** 助手消息可携带的产物/文件引用（只描述，不读真实 bytes）。 */
export type ReferenceKind = 'artifact' | 'file' | 'decision' | 'task';

export interface MessageReference {
  readonly kind: ReferenceKind;
  /** 内核侧对象 id（artifactId / fileId / …）。 */
  readonly refId: string;
  /** 展示标题；**不得**用作「已完成」证据。 */
  readonly label: string;
  readonly revision?: number;
  /** 完成证据：只有合法的 `sha256:<64 位小写十六进制>` 才算可核验。 */
  readonly digest?: `sha256:${string}`;
  /** 手机内容 URI 引用（content:// / blob:// / app://），不是本地路径。 */
  readonly uri?: string;
  readonly mime?: string;
}

export interface ChatMessageView {
  /** 稳定 id：同一消息在任何重渲染下 id 不变。 */
  readonly id: string;
  readonly role: MessageRole;
  /** 已累积正文（流式期间为「目前收到的部分」）。 */
  readonly text: string;
  readonly status: MessageStatus;
  /** 助手消息的尝试 id；用户/系统/错误消息为 null。 */
  readonly attemptId: string | null;
  /** 本尝试重试自哪条助手消息（非重试为 null）。 */
  readonly retryOf: string | null;
  readonly references: readonly MessageReference[];
  readonly error: MessageError | null;
  readonly toolCalls: readonly ToolCallTrace[];
  /**
   * 该消息携带的附件**占位**（发送时由草稿带入，避免附件被静默丢弃）。
   * 可选：旧状态/压测夹具不构造该字段，读取处一律 `?? []`。
   */
  readonly attachments?: readonly AttachmentRef[];
  /** 已应用的最后一个 chunk 序号（用于丢弃重复/乱序分片）。 */
  readonly lastChunkSeq: number | null;
  /** 创建序号：确定性排序用，不依赖时钟。 */
  readonly ordinal: number;
}

// ---------------------------------------------------------------------------
// 输入与草稿
// ---------------------------------------------------------------------------

/**
 * 附件**占位**：只有结构，不做真实文件读取（`bytesRead` 恒为 false）。
 * `uri` 仅接受手机内容 URI 形状；非法（含盘符/POSIX 绝对路径）时置 null 并置位
 * `uriRejected`，绝不把一个本地路径当可访问引用。
 */
export interface AttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly mime: string | null;
  readonly byteLength: number | null;
  readonly uri: string | null;
  readonly uriRejected: boolean;
  readonly bytesRead: false;
}

/** 每会话独立的未发送草稿（FRONTEND.md 行 9：每个会话独立保存草稿和附件）。 */
export interface ChatDraft {
  readonly conversationId: string;
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
}

/** 草稿存储：conversationId → 草稿。用于「应用被杀后恢复未发送草稿」。 */
export type DraftStore = Readonly<Record<string, ChatDraft>>;

/**
 * 唯一自然语言入口描述（验收口径「唯一自然语言入口」）。
 * 入口只有一条：自然语言输入框；附件是它的**附属**，不构成第二条发送通道。
 */
export interface ChatEntryDescriptor {
  readonly kind: 'natural-language';
  readonly channels: readonly ['natural-language'];
  /** 附件只有占位结构，不做真实读取。 */
  readonly attachmentMode: 'placeholder';
  /** 草稿与附件按会话隔离保存。 */
  readonly draftScope: 'per-conversation';
}

export const CHAT_ENTRY: ChatEntryDescriptor = {
  kind: 'natural-language',
  channels: ['natural-language'],
  attachmentMode: 'placeholder',
  draftScope: 'per-conversation',
};

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export interface ChatState {
  readonly conversationId: string;
  readonly messages: readonly ChatMessageView[];
  /** id → messages 下标：O(1) 定位，避免长会话下每片全表扫描（「长会话不卡死」）。 */
  readonly indexById: Readonly<Record<string, number>>;
  readonly draft: ChatDraft;
  /** 已创建消息计数，用于确定性 id（不使用时钟/随机数）。 */
  readonly counter: number;
  readonly entry: ChatEntryDescriptor;
  /**
   * 助手消息 id → 内核命令生命周期。可选：旧状态/压测夹具不构造该字段，读取处一律
   * `?? {}`。它记录的是**内核事件流**（v1 `Event`）的结果，独立于模型正文流。
   */
  readonly tasks?: Readonly<Record<string, KernelTaskView>>;
}

// ---------------------------------------------------------------------------
// 内核命令生命周期（v1 `Event` → 视图）
// ---------------------------------------------------------------------------

/**
 * 内核命令生命周期取值。`idle` 表示尚未收到任何内核事件；其余与契约 `EventStatus`
 * 一一对应（`pending`/`running`/`succeeded`/`failed`/`conflict`/`cancelled`）。
 */
export type KernelTaskStatus = 'idle' | EventStatus;

/** 终态：进入其一后不再接受任何后续事件（冻结）。 */
export const TERMINAL_TASK_STATUSES: readonly KernelTaskStatus[] = [
  'succeeded',
  'failed',
  'conflict',
  'cancelled',
];

export function isTerminalTask(status: KernelTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** 事件缺 `resultRef` 却自称 `succeeded` 时的降级错误码（fail-closed）。 */
export const FAIL_CLOSED_CODE = 'INVALID_EVENT_MISSING_RESULT_REF';

/** 内核任务生命周期视图（一条助手消息对应一个命令）。 */
export interface KernelTaskView {
  /** 命令 id；收到 `commandSubmitted` 或首个事件后确定。 */
  readonly commandId: string | null;
  readonly status: KernelTaskStatus;
  /** 最近一次事件的 revision（旧修订用于排障/冲突提示）。 */
  readonly revision: number;
  /** 已应用的最大 seq；更小/相等的序号视为幂等重放或乱序重复而丢弃。 */
  readonly lastSeq: number | null;
  /** `succeeded` 时的结果引用；非成功态恒为 null。 */
  readonly resultRef: string | null;
  readonly error: MessageError | null;
  readonly verificationMode: 'fixture' | 'real' | null;
  readonly idempotentReplay: boolean;
  /** 事件流断开且任务未终态：进度不可知（design-07 行 220「无法获取进度」）。 */
  readonly progressUnknown: boolean;
  /** 曾收到「succeeded 但缺 resultRef」的非法事件并被 fail-closed 降级。 */
  readonly failClosed: boolean;
  /** 已应用的事件 id（排障用；重复 id 不重复记录）。 */
  readonly appliedEventIds: readonly string[];
}

export function idleTask(): KernelTaskView {
  return {
    commandId: null,
    status: 'idle',
    revision: 0,
    lastSeq: null,
    resultRef: null,
    error: null,
    verificationMode: null,
    idempotentReplay: false,
    progressUnknown: false,
    failClosed: false,
    appliedEventIds: [],
  };
}

/**
 * 任务是否被内核**明确**判为成功：必须 `status === 'succeeded'` 且带非空 `resultRef`。
 * 这是「只有拿到回执才算完成」的唯一判据；`idle`/`running`/`failed`/`conflict`/`cancelled`
 * 以及被 fail-closed 降级的非法 succeeded 都返回 false。
 */
export function isTaskSucceeded(task: KernelTaskView | null | undefined): boolean {
  return (
    task !== null &&
    task !== undefined &&
    task.status === 'succeeded' &&
    typeof task.resultRef === 'string' &&
    task.resultRef.length > 0
  );
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 适配层投递到视图模型的流式分片：显式带目标消息与尝试，杜绝「隐式写当前消息」。 */
export interface StreamChunkDelivery {
  readonly messageId: string;
  readonly attemptId: string;
  /** 分片序号；提供时按严格递增应用，重复/回退的序号被丢弃。 */
  readonly seq?: number;
  readonly chunk: StreamChunk;
}

export type ChatAction =
  | { readonly type: 'setDraftText'; readonly text: string }
  | { readonly type: 'addAttachment'; readonly attachment: AttachmentRef }
  | { readonly type: 'removeAttachment'; readonly attachmentId: string }
  | { readonly type: 'clearDraft' }
  /** 发送：草稿 → 用户消息，并追加助手占位（pending）。 */
  | {
      readonly type: 'sendUserMessage';
      readonly userMessageId?: string;
      readonly assistantMessageId?: string;
    }
  | { readonly type: 'streamChunk'; readonly delivery: StreamChunkDelivery }
  /** 连接结束。**不带终帧** ⇒ interrupted；已终态的消息不变。 */
  | { readonly type: 'streamEnded'; readonly messageId: string }
  /** 用户停止 ⇒ cancelled，之后不再接受 chunk。 */
  | { readonly type: 'stop'; readonly messageId: string }
  /** 重试 ⇒ 新助手消息 + 新 attemptId；旧尝试若未终态先置 cancelled。 */
  | { readonly type: 'retry'; readonly messageId: string; readonly newMessageId?: string }
  | {
      readonly type: 'appendNotice';
      readonly role: 'system' | 'error';
      readonly text: string;
      readonly references?: readonly MessageReference[];
    }
  | {
      readonly type: 'attachReference';
      readonly messageId: string;
      readonly reference: MessageReference;
    }
  /** 把一条助手消息绑定到内核命令 id（收到首个事件前也可先绑定）。 */
  | { readonly type: 'commandSubmitted'; readonly messageId: string; readonly commandId: string }
  /**
   * 内核事件（v1 `Event`）投递。只有它能让任务进入 `succeeded`，且**必须**带 `resultRef`；
   * 缺 `resultRef` 的 `succeeded` 被 fail-closed 降级为 `failed`。
   */
  | { readonly type: 'kernelEvent'; readonly messageId: string; readonly event: Event }
  /** 内核事件流断开：未终态的任务标记「进度不可知」，**绝不**置为成功。 */
  | { readonly type: 'eventStreamEnded'; readonly messageId: string };
