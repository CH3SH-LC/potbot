/**
 * F-R04 —— 大规模夹具构造器（纯数据、确定性、零依赖）。
 *
 * 为什么不是「用产品函数把列表滚大」：`createConversation` / `createChatState` 每次
 * 写入都整拷数组（O(当前长度)），用它们造 n=4000 的夹具本身就是二次成本，会把
 * 夹具构建时间混进被测操作的样本里。本文件直接按**已文档化的状态形状**构造合法
 * 状态对象：字段与 `apps/mobile-ui/src/**\/types.ts` 一致，但不经过写路径。
 * 被测操作仍调用**产品函数**（list/page/stream/append），保证测的是真实实现。
 *
 * 所有时间戳用固定常量，不读时钟；所有派生用 `lcg`，不用 `Math.random()`。
 */

import type { ChatMessageView, ChatState } from '../../../apps/mobile-ui/src/chat/types.js';
import type {
  ConversationView,
  ConversationsState,
  TaskBinding,
} from '../../../apps/mobile-ui/src/conversations/types.js';
import type { FileEntry, RevisionRecord } from '../../../apps/mobile-ui/src/files/types.js';

/** 固定基准时刻（UTC ISO 8601），避免读时钟。 */
export const T0 = '2026-10-03T00:00:00Z';

/** 由固定基准派生第 index 秒的 UTC 时间戳（不使用 Date/时钟）。 */
export function isoTimestampAt(offsetSeconds: number): string {
  const total = offsetSeconds;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  // 小时也取模 24：偏移量可能远超一天（大版本号），取模后仍是合法 UTC ISO 8601。
  const h = Math.floor(total / 3600) % 24;
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `2026-10-03T${pad(h)}:${pad(m)}:${pad(s)}Z`;
}

/**
 * 构造 n 个会话的列表状态（revision=1、无任务）。`lastActiveAt` 由确定性 LCG 打散，
 * 制造非同步排序键；`indexById` 与数组下标严格对应。
 */
export function buildConversationsState(n: number, seed = 7): ConversationsState {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n 必须是 >= 0 的整数');
  const rand = lcgLocal(seed);
  const conversations: ConversationView[] = [];
  const indexById: Record<string, number> = {};
  for (let i = 0; i < n; i += 1) {
    const id = `conv-${String(i).padStart(7, '0')}`;
    const view: ConversationView = {
      id,
      title: `会话 ${i}`,
      snippet: `第 ${i} 条会话内容片段`,
      revision: 1,
      lifecycle: 'active',
      lastActiveAt: isoTimestampAt(Math.floor(rand() * 86_400)),
      seq: i + 1,
      tasks: [],
    };
    indexById[id] = conversations.length;
    conversations.push(view);
  }
  return { conversations, indexById, selectedId: null, counter: n };
}

/** 给某个会话补上 k 个任务绑定（确定性 id）。用于 bindTask 的规模测试。 */
export function withTasks(state: ConversationsState, conversationId: string, k: number): ConversationsState {
  const index = state.indexById[conversationId];
  if (index === undefined) throw new Error(`未知会话：${conversationId}`);
  const view = state.conversations[index];
  if (view === undefined) throw new Error('会话下标失效');
  const tasks: TaskBinding[] = [];
  for (let i = 0; i < k; i += 1) {
    tasks.push({
      taskId: `t-${i}`,
      title: `任务 ${i}`,
      status: 'running',
      conversationId,
    });
  }
  const conversations = state.conversations.slice();
  conversations[index] = { ...view, tasks };
  return { ...state, conversations };
}

/**
 * 构造一条只有 1 个已终态助手消息、且对话正文已就位的会话状态，用于流式压测。
 * `existingMessages` 决定会话里已有多少条历史消息（测每片 slice 成本随会话长度）。
 */
export function buildStreamableChatState(existingMessages: number, targetChars = 0): ChatState {
  if (!Number.isInteger(existingMessages) || existingMessages < 0) {
    throw new RangeError('existingMessages 必须是 >= 0 的整数');
  }
  const messages: ChatMessageView[] = [];
  const indexById: Record<string, number> = {};
  for (let i = 0; i < existingMessages; i += 1) {
    const id = `h-${i}`;
    const msg: ChatMessageView = {
      id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `历史消息 ${i}`,
      status: 'complete',
      attemptId: null,
      retryOf: null,
      references: [],
      error: null,
      toolCalls: [],
      lastChunkSeq: null,
      ordinal: i + 1,
    };
    indexById[id] = messages.length;
    messages.push(msg);
  }
  const targetIndex = messages.length;
  const target: ChatMessageView = {
    id: 'a-target',
    role: 'assistant',
    text: targetChars > 0 ? 'x'.repeat(targetChars) : '',
    status: 'streaming',
    attemptId: 'attempt-target-1',
    retryOf: null,
    references: [],
    error: null,
    toolCalls: [],
    lastChunkSeq: 0,
    ordinal: existingMessages + 1,
  };
  indexById[target.id] = targetIndex;
  messages.push(target);
  return {
    conversationId: 'conv-stream',
    messages,
    indexById,
    draft: { conversationId: 'conv-stream', text: '', attachments: [] },
    counter: existingMessages + 1,
    entry: {
      kind: 'natural-language',
      channels: ['natural-language'],
      attachmentMode: 'placeholder',
      draftScope: 'per-conversation',
    },
  };
}

/**
 * 构造一个已有 `revisionCount` 个版本的文件条目（版本链自洽：revision 从 1 起 +1，
 * parentRevision 指回上一版，首版为 null）。
 */
export function buildFileEntry(revisionCount: number, fileId = 'file-0'): FileEntry {
  if (!Number.isInteger(revisionCount) || revisionCount < 1) {
    throw new RangeError('revisionCount 必须是 >= 1 的整数');
  }
  const revisions: RevisionRecord[] = [];
  for (let r = 1; r <= revisionCount; r += 1) {
    revisions.push({
      fileId,
      revision: r,
      revisionId: `rev-${fileId}-${r}`,
      parentRevision: r === 1 ? null : r - 1,
      origin: r === 1 ? 'created' : 'edited',
      partsChanged: [{ name: `part-${r}`, change: 'modified' }],
      createdAt: isoTimestampAt(r),
      bytes: { present: false },
    });
  }
  return {
    fileId,
    kind: 'word',
    title: `文档 ${fileId}`,
    revisions,
    currentRevision: revisionCount,
    updatedAt: isoTimestampAt(revisionCount),
  };
}

/** 构造 n 个文件的列表（每个 1 版），用于 listFiles 规模测试。 */
export function buildFileEntries(n: number, seed = 11): readonly FileEntry[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n 必须是 >= 0 的整数');
  const rand = lcgLocal(seed);
  const out: FileEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    const fileId = `file-${String(i).padStart(7, '0')}`;
    const kind = i % 3 === 0 ? 'word' : i % 3 === 1 ? 'excel' : 'ppt';
    out.push({
      fileId,
      kind,
      title: `文档 ${i}`,
      revisions: [
        {
          fileId,
          revision: 1,
          revisionId: `rev-${fileId}-1`,
          parentRevision: null,
          origin: 'created',
          partsChanged: [],
          createdAt: isoTimestampAt(Math.floor(rand() * 86_400)),
          bytes: { present: false },
        },
      ],
      currentRevision: 1,
      updatedAt: isoTimestampAt(Math.floor(rand() * 86_400)),
    });
  }
  return out;
}

/** 本地 LCG 副本（夹具专用，避免与 harness 的 lcg 形成循环依赖）。 */
function lcgLocal(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
