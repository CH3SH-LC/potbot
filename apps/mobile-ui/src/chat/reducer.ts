/**
 * F02 chat —— 对话状态机（纯函数 reducer，零依赖、框架无关）。
 *
 * 设计要点：
 *
 * 1) **终态只能由显式终帧触发。** 唯一能把助手消息置为 `complete` 的路径是
 *    `chunk.done === true`（text / tool-call / usage 分支）。`streamEnded`（连接结束、
 *    没有终帧）只能得到 `interrupted`。这条是验收「**断流不伪造完成**」的实现核心；
 *    `tests/mobile-ui/F02/streaming.test.ts` 用「正例 + 反例」双向对照机器化锁死。
 *
 * 2) **停止即冻结。** `stop` 把消息置为 `cancelled`；`cancelled` 属于终态集合，
 *    后续 chunk 一律忽略（I2）。
 *
 * 3) **尝试隔离。** chunk 携带 `messageId + attemptId`，二者必须同时与目标消息匹配
 *    才被应用；重试追加**新的助手消息**（新 id ⇒ 新 attemptId）。因此旧尝试迟到的
 *    chunk 只会落到已经终态的旧消息上并被忽略，不可能写进新尝试（I3）。
 *
 * 4) **不做 I/O。** 不读时钟、不读随机数、不发请求；id 与顺序完全由 `counter` 决定，
 *    同输入必得同输出，测试才能逐字节断言。
 */

import { attemptIdFor } from './ids.js';
import { applyKernelEvent, markProgressUnknown } from './events.js';
import {
  CHAT_ENTRY,
  idleTask,
  isTaskSucceeded,
  isTerminal,
  type AttachmentRef,
  type ChatAction,
  type ChatMessageView,
  type ChatState,
  type KernelTaskView,
  type StreamChunkDelivery,
  type MessageReference,
  type MessageStatus,
} from './types.js';

export interface CreateChatStateOptions {
  /** 恢复的草稿正文。 */
  readonly draftText?: string;
  /** 恢复的草稿附件（占位）。 */
  readonly draftAttachments?: readonly AttachmentRef[];
}

/** 创建空会话状态。 */
export function createChatState(conversationId: string, options: CreateChatStateOptions = {}): ChatState {
  return {
    conversationId,
    messages: [],
    indexById: {},
    draft: {
      conversationId,
      text: options.draftText ?? '',
      attachments: options.draftAttachments ?? [],
    },
    counter: 0,
    entry: CHAT_ENTRY,
    tasks: {},
  };
}

/** 任务表（对旧状态缺省安全）。 */
function taskRecord(state: ChatState): Readonly<Record<string, KernelTaskView>> {
  return state.tasks ?? {};
}

/** 某助手消息当前的任务视图；没有则 null（**不是**构造一个假的 idle）。 */
export function getTask(state: ChatState, messageId: string): KernelTaskView | null {
  const task = taskRecord(state)[messageId];
  return task === undefined ? null : task;
}

/**
 * 消息是否「真的完成」——**两条流都到位**才算：
 *   1) 正文流必须 `complete`（收到显式终帧，非断流/停止/错误）；
 *   2) 必须存在内核任务视图，且它 `succeeded` 并带 `resultRef`。
 * 缺任一 ⇒ false。没有内核任务时返回 false 是有意为之的 fail-closed：
 * 「文字收完了」不等于「内核已交付结果」。
 */
export function isMessageFullyDone(state: ChatState, messageId: string): boolean {
  const message = getMessage(state, messageId);
  if (message === null || message.role !== 'assistant') return false;
  if (message.status !== 'complete') return false;
  return isTaskSucceeded(getTask(state, messageId));
}

// ---------------------------------------------------------------------------
// 读取辅助
// ---------------------------------------------------------------------------

export function getMessage(state: ChatState, messageId: string): ChatMessageView | null {
  const index = state.indexById[messageId];
  if (index === undefined) return null;
  return state.messages[index] ?? null;
}

/** 最近一条助手消息（含占位）；无则 null。 */
export function latestAssistantMessage(state: ChatState): ChatMessageView | null {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const msg = state.messages[i];
    if (msg !== undefined && msg.role === 'assistant') return msg;
  }
  return null;
}

/** 是否仍在等待助手输出（存在 pending/streaming 的助手消息）。 */
export function isAwaitingResponse(state: ChatState): boolean {
  for (const msg of state.messages) {
    if (msg.role === 'assistant' && (msg.status === 'pending' || msg.status === 'streaming')) return true;
  }
  return false;
}

/**
 * 能否发送。**唯一自然语言入口**：必须有自然语言正文；附件占位是附属数据，
 * 单独点附件不构成一条消息（本包明确不允许「无正文的附件发送」）。
 */
export function canSubmit(state: ChatState): boolean {
  return state.draft.text.trim().length > 0;
}

/** 某个 attemptId 当前对应的助手消息；被重试取代后仍能查到旧消息。 */
export function messageByAttempt(state: ChatState, attemptId: string): ChatMessageView | null {
  for (const msg of state.messages) {
    if (msg.attemptId === attemptId) return msg;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内部写入
// ---------------------------------------------------------------------------

function withMessage(state: ChatState, index: number, next: ChatMessageView): ChatState {
  const messages = state.messages.slice();
  messages[index] = next;
  return { ...state, messages };
}

function appendMessage(state: ChatState, message: ChatMessageView): ChatState {
  const index = state.messages.length;
  return {
    ...state,
    messages: [...state.messages, message],
    indexById: { ...state.indexById, [message.id]: index },
  };
}

function assistantSkeleton(
  id: string,
  ordinal: number,
  attemptId: string,
  retryOf: string | null,
): ChatMessageView {
  return {
    id,
    role: 'assistant',
    text: '',
    status: 'pending',
    attemptId,
    retryOf,
    references: [],
    error: null,
    toolCalls: [],
    attachments: [],
    lastChunkSeq: null,
    ordinal,
  };
}

// ---------------------------------------------------------------------------
// chunk 应用
// ---------------------------------------------------------------------------

/** 用已通过全部守卫的 chunk 生成下一版消息。`complete` 只在 `done === true` 时出现。 */
function applyChunk(message: ChatMessageView, delivery: StreamChunkDelivery): ChatMessageView {
  const { chunk } = delivery;
  const nextSeq = delivery.seq ?? message.lastChunkSeq;
  switch (chunk.type) {
    case 'text': {
      // done === true 是**唯一**进入 complete 的文本路径；否则维持 streaming（非完成）。
      const status: MessageStatus = chunk.done === true ? 'complete' : 'streaming';
      return { ...message, text: message.text + chunk.text, status, lastChunkSeq: nextSeq };
    }
    case 'tool-call': {
      const status: MessageStatus = chunk.done === true ? 'complete' : 'streaming';
      return {
        ...message,
        status,
        toolCalls: [...message.toolCalls, { toolCallId: chunk.toolCallId, toolName: chunk.toolName }],
        lastChunkSeq: nextSeq,
      };
    }
    case 'usage': {
      // 令牌计量交由后续「预算」包消费，本视图模型不落库；只认它的终帧语义。
      const status: MessageStatus = chunk.done === true ? 'complete' : message.status;
      return { ...message, status, lastChunkSeq: nextSeq };
    }
    case 'error': {
      // 错误帧一律 failed，且**不**累积正文。
      return {
        ...message,
        status: 'failed',
        error: { code: chunk.error.code, message: chunk.error.message },
        lastChunkSeq: nextSeq,
      };
    }
    default:
      return message;
  }
}

// ---------------------------------------------------------------------------
// reducer
// ---------------------------------------------------------------------------

export function reduce(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'setDraftText':
      return { ...state, draft: { ...state.draft, text: action.text } };

    case 'addAttachment':
      return { ...state, draft: { ...state.draft, attachments: [...state.draft.attachments, action.attachment] } };

    case 'removeAttachment': {
      const attachments = state.draft.attachments.filter((att) => att.id !== action.attachmentId);
      if (attachments.length === state.draft.attachments.length) return state;
      return { ...state, draft: { ...state.draft, attachments } };
    }

    case 'clearDraft':
      return { ...state, draft: { ...state.draft, text: '', attachments: [] } };

    case 'sendUserMessage': {
      if (!canSubmit(state)) return state; // 空正文：不产生消息，也不清空附件草稿
      const ordinal = state.counter + 1;
      const userMessageId = action.userMessageId ?? `u-${ordinal}`;
      const assistantMessageId = action.assistantMessageId ?? `a-${ordinal}`;
      const user: ChatMessageView = {
        id: userMessageId,
        role: 'user',
        // 用户消息在本包内即「本地已完整提交」，其 complete 描述的是**消息内容完整性**，
        // 不代表内核已受理或任务已完成（内核受理由事件流另行表达，见 events.ts）。
        text: state.draft.text,
        status: 'complete',
        attemptId: null,
        retryOf: null,
        references: [],
        error: null,
        toolCalls: [],
        // 附件占位随消息一起保留，避免发送时把附件静默丢弃（design-07 行 119）。
        attachments: state.draft.attachments,
        lastChunkSeq: null,
        ordinal,
      };
      const assistant = assistantSkeleton(
        assistantMessageId,
        ordinal,
        attemptIdFor(assistantMessageId, 1),
        null,
      );
      const sent: ChatState = {
        ...state,
        counter: ordinal,
        draft: { ...state.draft, text: '', attachments: [] },
      };
      return appendMessage(appendMessage(sent, user), assistant);
    }

    case 'streamChunk': {
      const { delivery } = action;
      const index = state.indexById[delivery.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      // I3：消息与尝试必须同时匹配，否则视为串台分片，丢弃。
      if (message.attemptId === null || message.attemptId !== delivery.attemptId) return state;
      // I1/I2：终态冻结（cancelled / interrupted / failed / complete 都不再接受分片）。
      if (isTerminal(message.status)) return state;
      // 重复或回退的序号丢弃：同一分片重放不会把正文写两遍。
      if (delivery.seq !== undefined && message.lastChunkSeq !== null && delivery.seq <= message.lastChunkSeq) {
        return state;
      }
      return withMessage(state, index, applyChunk(message, delivery));
    }

    case 'streamEnded': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      if (isTerminal(message.status)) return state;
      // 没有终帧 = 未完成。绝不在这里写 complete。
      return withMessage(state, index, { ...message, status: 'interrupted' });
    }

    case 'stop': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      if (isTerminal(message.status)) return state;
      return withMessage(state, index, { ...message, status: 'cancelled' });
    }

    case 'retry': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const previous = state.messages[index];
      if (previous === undefined || previous.role !== 'assistant') return state;

      const ordinal = state.counter + 1;
      const newMessageId = action.newMessageId ?? `a-${ordinal}`;
      // 被取代的旧尝试：若还没终态，先冻结为 cancelled，防止它之后再变 complete。
      const settled = isTerminal(previous.status)
        ? state
        : withMessage(state, index, { ...previous, status: 'cancelled' });
      const attempt = assistantSkeleton(
        newMessageId,
        ordinal,
        attemptIdFor(newMessageId, 1),
        previous.id,
      );
      return appendMessage({ ...settled, counter: ordinal }, attempt);
    }

    case 'appendNotice': {
      const ordinal = state.counter + 1;
      const prefix = action.role === 'system' ? 's' : 'e';
      const notice: ChatMessageView = {
        id: `${prefix}-${ordinal}`,
        role: action.role,
        text: action.text,
        status: 'complete',
        attemptId: null,
        retryOf: null,
        references: action.references ?? [],
        error: null,
        toolCalls: [],
        attachments: [],
        lastChunkSeq: null,
        ordinal,
      };
      return appendMessage({ ...state, counter: ordinal }, notice);
    }

    case 'attachReference': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      // 已停止的消息不再接受任何新信息（与「停止即冻结」一致）。
      if (message.status === 'cancelled') return state;
      const reference: MessageReference = action.reference;
      if (message.references.some((ref) => ref.refId === reference.refId && ref.kind === reference.kind)) {
        return state;
      }
      return withMessage(state, index, { ...message, references: [...message.references, reference] });
    }

    case 'commandSubmitted': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      const tasks = taskRecord(state);
      const existing = tasks[action.messageId] ?? idleTask();
      // 已绑定到别的命令 ⇒ 串台，忽略；同命令重复绑定幂等。
      if (existing.commandId !== null && existing.commandId !== action.commandId) return state;
      if (existing.commandId === action.commandId) return state;
      return {
        ...state,
        tasks: { ...tasks, [action.messageId]: { ...existing, commandId: action.commandId } },
      };
    }

    case 'kernelEvent': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      const tasks = taskRecord(state);
      const current = tasks[action.messageId] ?? idleTask();
      const next = applyKernelEvent(current, action.event);
      if (next === current) return state; // 被丢弃/无变化：保持状态引用稳定
      return { ...state, tasks: { ...tasks, [action.messageId]: next } };
    }

    case 'eventStreamEnded': {
      const index = state.indexById[action.messageId];
      if (index === undefined) return state;
      const message = state.messages[index];
      if (message === undefined || message.role !== 'assistant') return state;
      const tasks = taskRecord(state);
      const current = tasks[action.messageId];
      if (current === undefined) return state; // 没有跟踪的任务：不凭空造一个
      const next = markProgressUnknown(current);
      if (next === current) return state;
      return { ...state, tasks: { ...tasks, [action.messageId]: next } };
    }

    default:
      return state;
  }
}

/** 顺序应用一串动作（便于适配层与测试复用）。 */
export function reduceAll(state: ChatState, actions: readonly ChatAction[]): ChatState {
  let current = state;
  for (const action of actions) current = reduce(current, action);
  return current;
}
