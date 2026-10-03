/**
 * F02 验收：长会话不卡死。
 *
 * 口径是「能跑完、不漏消息、不串位」，不是「比谁快」——因此给了**显式且宽松**的
 * 单用例时限（本仓库约定：用例自带时限，配置文件不得设置时限）。
 *
 * 结构上的防护是本包自带的 `indexById`（消息 id → 数组下标，O(1) 定位）：
 * 流式分片直接按 id 命中目标消息，不随会话长度做全表扫描。这里同时断言该索引
 * 在几百轮之后依然与消息数组逐条一致，避免「索引漂了但没人发现」。
 */

import { describe, expect, it } from 'vitest';

import {
  createChatState,
  getMessage,
  isAwaitingResponse,
  latestAssistantMessage,
  reduce,
  type ChatState,
} from '../../../apps/mobile-ui/src/chat/index.js';

const CONVERSATION = 'conv-long';

function completeTurn(state: ChatState, index: number): ChatState {
  let next = reduce(state, { type: 'setDraftText', text: `第 ${index} 轮：把周报改成一页` });
  next = reduce(next, { type: 'sendUserMessage' });
  const assistant = latestAssistantMessage(next);
  if (assistant === null) throw new Error('缺少助手占位');
  return reduce(next, {
    type: 'streamChunk',
    delivery: {
      messageId: assistant.id,
      attemptId: assistant.attemptId ?? '',
      seq: 0,
      chunk: { type: 'text', text: `第 ${index} 轮完成`, done: true },
    },
  });
}

describe('F02 / 长会话', () => {
  it(
    '400 轮对话 + 3 万片流式：跑得完、正文正确、无悬挂等待',
    () => {
      const TURNS = 400;
      const CHUNKS = 30_000;

      let state = createChatState(CONVERSATION);
      for (let i = 1; i <= TURNS; i += 1) state = completeTurn(state, i);

      expect(state.messages).toHaveLength(TURNS * 2);
      expect(isAwaitingResponse(state)).toBe(false);

      // 再开一轮，把 3 万片打到这条**尚未有终帧**的助手消息上。
      state = reduce(state, { type: 'setDraftText', text: '把会议纪要整理成三页' });
      state = reduce(state, { type: 'sendUserMessage' });
      const target = latestAssistantMessage(state);
      if (target === null) throw new Error('缺少最后一条助手消息');
      expect(target.status).toBe('pending');

      const attempt = target.attemptId ?? '';
      for (let seq = 1; seq <= CHUNKS; seq += 1) {
        state = reduce(state, {
          type: 'streamChunk',
          delivery: {
            messageId: target.id,
            attemptId: attempt,
            seq,
            chunk: { type: 'text', text: '字字', done: seq === CHUNKS },
          },
        });
      }

      const finalMessage = getMessage(state, target.id);
      expect(finalMessage?.status).toBe('complete');
      expect(finalMessage?.text.length).toBe(CHUNKS * 2);
      expect(isAwaitingResponse(state)).toBe(false);
    },
    30_000,
  );

  it(
    '索引与消息数组在长会话后逐条一致（按 id 定位不串位）',
    () => {
      let state = createChatState(CONVERSATION);
      for (let i = 1; i <= 200; i += 1) state = completeTurn(state, i);

      expect(Object.keys(state.indexById)).toHaveLength(state.messages.length);
      state.messages.forEach((message, index) => {
        expect(state.indexById[message.id]).toBe(index);
        expect(getMessage(state, message.id)).toBe(message);
      });
    },
    20_000,
  );

  it('状态是纯数据：可 JSON 往返（无函数、无循环引用）', () => {
    let state = createChatState(CONVERSATION);
    state = completeTurn(state, 1);
    state = reduce(state, { type: 'retry', messageId: (latestAssistantMessage(state) ?? { id: '' }).id });

    expect(() => JSON.stringify(state)).not.toThrow();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
