/**
 * F-R04 验收（确定性部分）—— 长列表 / 长流式消息 / 大文件预览的**资源保留**检查。
 *
 * 本文件**不含计时**，因此不受机器负载影响：它检查纯数据状态在长会话 / 长列表 /
 * 长版本链压力下的「保留行为」，即「资源泄漏」在无 I/O 的状态机里等价的那个问题：
 *
 *   R1 **拒绝路径零分配**：终态后迟到的分片、重复序号、错误 attemptId、未知 messageId
 *      都必须原样返回**同一个 state 引用**（`reduce(...) === state`）。若不返回同一引用，
 *      说明每次被拒的分片都在制造新对象 —— 长流式会话下这是真实的分配泄漏。
 *   R2 **索引不漂移**：`indexById` 的键数必须恒等于消息/会话条数，且每个 id 映射到
 *      自己的下标（无孤儿键 → 无泄漏的索引表）。
 *   R3 **增长有界**：重试每次只新增 1 条消息；附件增删对称；删除会话只移除 1 个键。
 *   R4 **无别名泄漏**：产品函数的「返回新对象」语义必须真的不原地改写旧对象
 *      （旧 entry 的 `revisions` 数组引用与长度不变）。
 *   R5 **调用方数组不被扣留**：绑定任务时复制引用数组，调用方随后改自己的数组
 *      不得影响已提交状态。
 *
 * 这些断言全部是确定性的（同一输入必得同一结果），与性能无关，属"必须通过"。
 */

import { describe, expect, it } from 'vitest';

import { countReachable, keyCount } from './perf-harness.js';
import { buildConversationsState, buildFileEntry, isoTimestampAt } from './fixtures.js';
import {
  createChatState,
  getMessage,
  latestAssistantMessage,
  reduce,
  type ChatState,
} from '../../../apps/mobile-ui/src/chat/index.js';
import {
  listConversations,
  pageConversations,
} from '../../../apps/mobile-ui/src/conversations/state.js';
import {
  bindTask,
  createConversation,
  deleteConversation,
} from '../../../apps/mobile-ui/src/conversations/actions.js';
import { createFile, appendRevision, revisionAt } from '../../../apps/mobile-ui/src/files/versions.js';
import { listFiles } from '../../../apps/mobile-ui/src/files/list.js';

const SCOPE = { tasks: 'retain', files: 'retain', memory: 'retain', externalActions: 'keep' } as const;

/** 完成一轮问答：用户消息 + 助手终帧。 */
function completeTurn(state: ChatState, index: number): ChatState {
  let next = reduce(state, { type: 'setDraftText', text: `第 ${index} 轮` });
  next = reduce(next, { type: 'sendUserMessage' });
  const assistant = latestAssistantMessage(next);
  if (assistant === null) throw new Error('缺少助手占位');
  return reduce(next, {
    type: 'streamChunk',
    delivery: {
      messageId: assistant.id,
      attemptId: assistant.attemptId ?? '',
      seq: 1,
      chunk: { type: 'text', text: '完成', done: true },
    },
  });
}

function isMessageShape(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ordinal' in value &&
    'lastChunkSeq' in value &&
    'attemptId' in value
  );
}

function isRevisionShape(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'revisionId' in value && 'parentRevision' in value
  );
}

describe('F-R04 / R1 拒绝路径零分配（长流式消息）', () => {
  function completedTurn(): { state: ChatState; messageId: string; attemptId: string } {
    const state = completeTurn(createChatState('c1'), 1);
    const msg = latestAssistantMessage(state);
    if (msg === null) throw new Error('缺少助手消息');
    return { state, messageId: msg.id, attemptId: msg.attemptId ?? '' };
  }

  it('终态后迟到的分片：返回同一 state 引用（零分配）', () => {
    const { state, messageId, attemptId } = completedTurn();
    const after = reduce(state, {
      type: 'streamChunk',
      delivery: { messageId, attemptId, seq: 2, chunk: { type: 'text', text: '迟到', done: false } },
    });
    expect(after).toBe(state);
    expect(getMessage(state, messageId)?.status).toBe('complete');
  });

  it('重复/回退序号：返回同一 state 引用', () => {
    const { state, messageId, attemptId } = completedTurn();
    const replayed = reduce(state, {
      type: 'streamChunk',
      delivery: { messageId, attemptId, seq: 1, chunk: { type: 'text', text: '重放', done: false } },
    });
    expect(replayed).toBe(state);
  });

  it('错误 attemptId（串台分片）：返回同一 state 引用', () => {
    let state = createChatState('c2');
    state = reduce(state, { type: 'setDraftText', text: '你好' });
    state = reduce(state, { type: 'sendUserMessage' });
    const msg = latestAssistantMessage(state);
    if (msg === null) throw new Error('缺少助手占位');
    const before = state;
    const after = reduce(state, {
      type: 'streamChunk',
      delivery: {
        messageId: msg.id,
        attemptId: 'attempt-wrong',
        seq: 1,
        chunk: { type: 'text', text: 'x', done: false },
      },
    });
    expect(after).toBe(before);
    expect(getMessage(state, msg.id)?.text).toBe('');
  });

  it('未知 messageId / 非助手消息：返回同一 state 引用', () => {
    const { state } = completedTurn();
    const after = reduce(state, {
      type: 'streamChunk',
      delivery: {
        messageId: 'does-not-exist',
        attemptId: 'a',
        seq: 1,
        chunk: { type: 'text', text: 'x', done: true },
      },
    });
    expect(after).toBe(state);
  });

  it('1000 次无效分片：state 引用始终不变，未产生新对象', () => {
    const { state, messageId, attemptId } = completedTurn();
    let current = state;
    for (let i = 0; i < 1000; i += 1) {
      current = reduce(current, {
        type: 'streamChunk',
        delivery: {
          messageId,
          attemptId,
          seq: 100 + i,
          chunk: { type: 'text', text: 'y', done: false },
        },
      });
      expect(current).toBe(state);
    }
    expect(countReachable(current, isMessageShape)).toBe(state.messages.length);
  });
});

describe('F-R04 / R2+R3 长会话有界增长', () => {
  it('200 轮后 indexById 键数 == 消息数，且逐条映射正确（无孤儿索引）', () => {
    let state = createChatState('c3');
    for (let i = 1; i <= 200; i += 1) state = completeTurn(state, i);

    expect(state.messages).toHaveLength(400);
    expect(keyCount(state.indexById)).toBe(state.messages.length);
    state.messages.forEach((message, index) => {
      expect(state.indexById[message.id]).toBe(index);
    });
  });

  it('重试未完成的助手消息：旧尝试被冻结为 cancelled（不接受迟到分片）', () => {
    let state = createChatState('c4a');
    state = reduce(state, { type: 'setDraftText', text: '再试一次' });
    state = reduce(state, { type: 'sendUserMessage' });
    const pending = latestAssistantMessage(state);
    if (pending === null) throw new Error('缺少助手占位');
    expect(pending.status).toBe('pending');

    const before = state.messages.length;
    state = reduce(state, { type: 'retry', messageId: pending.id });
    expect(state.messages.length).toBe(before + 1);
    expect(getMessage(state, pending.id)?.status).toBe('cancelled');
  });

  it('重试已完成的助手消息：旧消息保持原状不改写，仅新增 1 条', () => {
    let state = completeTurn(createChatState('c4b'), 1);
    const finished = latestAssistantMessage(state);
    if (finished === null) throw new Error('缺少助手消息');
    expect(finished.status).toBe('complete');

    const before = state.messages.length;
    state = reduce(state, { type: 'retry', messageId: finished.id });
    expect(state.messages.length).toBe(before + 1);
    // 终态消息不被重试改写（retry 只对未完成尝试做 cancelled 冻结）
    expect(getMessage(state, finished.id)?.status).toBe('complete');
  });

  it('20 次连续重试（每次目标都是未完成尝试）：每次只新增 1 条，旧尝试冻结', () => {
    // 起始就是一个 pending 助手消息：每次重试都精确命中断言路径。
    let state = createChatState('c4c');
    state = reduce(state, { type: 'setDraftText', text: '开始' });
    state = reduce(state, { type: 'sendUserMessage' });
    const afterFirst = state.messages.length;

    for (let r = 0; r < 20; r += 1) {
      const last = latestAssistantMessage(state);
      if (last === null) throw new Error('缺少助手消息');
      expect(last.status).toBe('pending');
      const before = state.messages.length;
      state = reduce(state, { type: 'retry', messageId: last.id });
      expect(state.messages.length).toBe(before + 1);
      // 旧尝试必须已终态（cancelled），否则它还会接受后续分片 → 双写风险
      expect(getMessage(state, last.id)?.status).toBe('cancelled');
    }
    expect(state.messages.length).toBe(afterFirst + 20);
    expect(countReachable(state, isMessageShape)).toBe(state.messages.length);
  });

  it('附件草稿增删对称：不遗留已移除的附件', () => {
    let state = createChatState('c5');
    for (let i = 0; i < 5; i += 1) {
      state = reduce(state, {
        type: 'addAttachment',
        attachment: {
          id: `att-${i}`,
          name: `文件${i}`,
          mime: null,
          byteLength: null,
          uri: null,
          uriRejected: false,
          bytesRead: false,
        },
      });
    }
    expect(state.draft.attachments).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) {
      state = reduce(state, { type: 'removeAttachment', attachmentId: `att-${i}` });
    }
    expect(state.draft.attachments).toHaveLength(0);
  });
});

describe('F-R04 / R2+R3 长列表保留检查', () => {
  it('listConversations 不修改输入状态，且复用原 view 引用（不重建）', () => {
    const state = buildConversationsState(3000);
    const arrayBefore = state.conversations;
    const firstView = state.conversations[0];
    const rows = listConversations(state);
    expect(state.conversations).toBe(arrayBefore);
    expect(state.conversations[0]).toBe(firstView);
    expect(rows).toHaveLength(3000);
    // 返回的是新数组（排序副本），不是内部数组本身
    expect(rows).not.toBe(arrayBefore as unknown as typeof rows);
  });

  it('pageConversations 不改状态，且页内元素与状态中 view 同一引用', () => {
    const state = buildConversationsState(5000);
    const page = pageConversations(state, { offset: 100, limit: 50 });
    expect(page.items).toHaveLength(50);
    expect(page.total).toBe(5000);
    for (const item of page.items) {
      const index = state.indexById[item.id];
      expect(index).toBeDefined();
      expect(state.conversations[index as number]).toBe(item);
    }
  });

  it('deleteConversation 只移除目标键，其余会话对象引用不变', () => {
    let state = buildConversationsState(2000);
    const survivor = state.conversations[1];
    const target = state.conversations[0];
    if (survivor === undefined || target === undefined) throw new Error('夹具异常');

    state = deleteConversation(state, {
      conversationId: target.id,
      expectedRevision: target.revision,
      scope: SCOPE,
    });

    expect(keyCount(state.indexById)).toBe(1999);
    expect(state.indexById[target.id]).toBeUndefined();
    expect(state.conversations).toHaveLength(1999);
    // 幸存会话仍是同一个对象引用（未被重建 / 重编号）
    const sIndex = state.indexById[survivor.id];
    expect(state.conversations[sIndex as number]).toBe(survivor);
    // 索引与数组逐条一致
    state.conversations.forEach((view, i) => {
      expect(state.indexById[view.id]).toBe(i);
    });
  });
});

describe('F-R04 / R5 调用方数组不被扣留', () => {
  it('bindTask 复制引用数组：调用方随后修改自己的数组不影响已提交状态', () => {
    const base = createConversation(buildConversationsState(0), { id: 'conv-x' });
    const conv = base.conversations[0];
    if (conv === undefined) throw new Error('夹具异常');

    const callerFileRefs = ['f1', 'f2'];
    let state = bindTask(base, {
      conversationId: conv.id,
      expectedRevision: conv.revision,
      task: { taskId: 't1', title: '任务一', status: 'running', fileRefs: callerFileRefs },
    });

    const bound = state.conversations[0]?.tasks[0];
    if (bound === undefined) throw new Error('任务未绑定');
    expect(bound.fileRefs).toEqual(['f1', 'f2']);
    expect(bound.fileRefs).not.toBe(callerFileRefs);

    callerFileRefs.push('f3');
    expect(state.conversations[0]?.tasks[0]?.fileRefs).toEqual(['f1', 'f2']);
  });
});

describe('F-R04 / R4 大版本链无别名泄漏', () => {
  it('appendRevision 不改写旧 entry 与其 revisions 数组（返回全新对象）', () => {
    const entry = buildFileEntry(50);
    const revisionsBefore = entry.revisions;
    const lengthBefore = entry.revisions.length;

    const next = appendRevision(entry, {
      expectedRevision: entry.currentRevision,
      createdAt: isoTimestampAt(entry.currentRevision + 1),
    });

    // 旧 entry 逐字段不变
    expect(entry.revisions).toBe(revisionsBefore);
    expect(entry.revisions).toHaveLength(lengthBefore);
    expect(entry.currentRevision).toBe(50);
    // 新 entry 是不同对象、不同数组
    expect(next).not.toBe(entry);
    expect(next.revisions).not.toBe(revisionsBefore);
    expect(next.revisions).toHaveLength(51);
    expect(next.currentRevision).toBe(51);
  });

  it('版本链上每个版本恰好保留一次（对象图无重复可达）', () => {
    const entry = buildFileEntry(100);
    expect(countReachable(entry, isRevisionShape)).toBe(100);
    expect(entry.revisions).toHaveLength(100);
    // 逐个取版仍返回链上同一对象（不是每次新建）
    for (const r of [1, 50, 100]) {
      expect(revisionAt(entry, r)).toBe(entry.revisions[r - 1]);
    }
  });

  it('listFiles 不修改输入条目数组，返回冻结的新数组', () => {
    const a = createFile({ fileId: 'fa', kind: 'word', title: 'A', createdAt: isoTimestampAt(0) });
    const b = createFile({ fileId: 'fb', kind: 'excel', title: 'B', createdAt: isoTimestampAt(1) });
    const entries = [a, b];
    const rows = listFiles(entries);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe(a);
    expect(rows).toHaveLength(2);
    expect(Object.isFrozen(rows)).toBe(true);
  });
});
