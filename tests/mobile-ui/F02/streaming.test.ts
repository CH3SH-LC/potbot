/**
 * F02 验收：消息流 / 流式输出 / 停止 / 重试。
 *
 * 本文件的核心是**双向对照**（验收口径「断流不伪造完成」）：
 *   - 正例：完整流式（多 chunk + 终帧）⇒ `complete`；
 *   - 反例：只给部分 chunk、不给终帧 ⇒ **不得**为 `complete`。
 * 两个用例都断言**累积正文**，因此反例不是「什么都没发生」的空壳：
 * 如果实现把所有 chunk 都丢掉，反例的正文断言会失败；如果实现把断流当完成，
 * 反例的状态断言会失败。
 *
 * 只跑定向：`pnpm vitest run tests/mobile-ui/F02/`
 */

import { describe, expect, it } from 'vitest';

import {
  canSubmit,
  createChatState,
  getMessage,
  isAwaitingResponse,
  isCompleted,
  isTerminal,
  latestAssistantMessage,
  reduce,
  type ChatAction,
  type ChatMessageView,
  type ChatState,
} from '../../../apps/mobile-ui/src/chat/index.js';

const CONVERSATION = 'conv-42';
const SENT_TEXT = '把这份周报改成一页';

interface Sent {
  readonly state: ChatState;
  readonly assistant: ChatMessageView;
  readonly userId: string;
}

/** 走一遍真实入口：填草稿 → 发送。 */
function send(text: string = SENT_TEXT): Sent {
  let state = createChatState(CONVERSATION);
  state = reduce(state, { type: 'setDraftText', text });
  state = reduce(state, { type: 'sendUserMessage' });
  const assistant = latestAssistantMessage(state);
  if (assistant === null) throw new Error('发送后应存在助手占位消息');
  const user = state.messages.find((m) => m.role === 'user');
  if (user === undefined) throw new Error('发送后应存在用户消息');
  return { state, assistant, userId: user.id };
}

function textChunk(
  messageId: string,
  attemptId: string,
  seq: number,
  text: string,
  done = false,
): ChatAction {
  return { type: 'streamChunk', delivery: { messageId, attemptId, seq, chunk: { type: 'text', text, done } } };
}

describe('F02 / 消息流与唯一自然语言入口', () => {
  it('发送产生稳定的用户消息与助手占位，id 与尝试 id 可复现', () => {
    const first = send();
    const second = send();

    expect(first.userId).toBe('u-1');
    expect(first.assistant.id).toBe('a-1');
    expect(first.assistant.attemptId).toBe('a-1#t1');
    expect(first.assistant.status).toBe('pending');
    expect(first.assistant.retryOf).toBeNull();

    // 同一输入 ⇒ 同 id（不依赖时钟/随机数）。
    expect(second.userId).toBe(first.userId);
    expect(second.assistant.id).toBe(first.assistant.id);

    // 消息顺序稳定：用户在前，助手占位在后。
    expect(first.state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(isAwaitingResponse(first.state)).toBe(true);
  });

  it('空正文不产生消息（唯一自然语言入口必须有自然语言）', () => {
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'addAttachment', attachment: attachment('att-1') });
    expect(canSubmit(state)).toBe(false);

    const after = reduce(state, { type: 'sendUserMessage' });
    expect(after).toBe(state); // 原样返回，不制造幽灵消息
    expect(after.messages).toHaveLength(0);
  });

  it('发送后清空正文与附件草稿', () => {
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'setDraftText', text: SENT_TEXT });
    state = reduce(state, { type: 'addAttachment', attachment: attachment('att-1') });
    state = reduce(state, { type: 'sendUserMessage' });
    expect(state.draft.text).toBe('');
    expect(state.draft.attachments).toHaveLength(0);
  });

  it('系统/错误提示可入流，且不变动助手尝试', () => {
    let { state } = send();
    state = reduce(state, { type: 'appendNotice', role: 'system', text: '已切换到手机内核' });
    state = reduce(state, { type: 'appendNotice', role: 'error', text: '网络不可用', references: [] });

    const roles = state.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'system', 'error']);
    const notice = state.messages[2];
    expect(notice?.id).toBe('s-2');
    expect(notice?.status).toBe('complete');
    expect(notice?.attemptId).toBeNull();
    // 新消息进入索引，可 O(1) 取回。
    expect(getMessage(state, 'e-3')?.text).toBe('网络不可用');
  });
});

describe('F02 / 流式输出：正例（终帧 ⇒ 完成）', () => {
  it('多 chunk + 终帧 ⇒ streaming 中间态，最后 complete', () => {
    const { state: s0, assistant } = send();

    const s1 = reduce(s0, textChunk(assistant.id, assistant.attemptId ?? '', 0, '好的，'));
    const m1 = getMessage(s1, assistant.id);
    expect(m1?.status).toBe('streaming');
    expect(m1 === null ? null : isCompleted(m1.status)).toBe(false);

    const s2 = reduce(s1, textChunk(assistant.id, assistant.attemptId ?? '', 1, '我来改成'));
    expect(getMessage(s2, assistant.id)?.text).toBe('好的，我来改成');

    const s3 = reduce(s2, textChunk(assistant.id, assistant.attemptId ?? '', 2, '一页。', true));
    const m3 = getMessage(s3, assistant.id);
    expect(m3?.text).toBe('好的，我来改成一页。');
    expect(m3?.status).toBe('complete');
    expect(m3 === null ? null : isCompleted(m3.status)).toBe(true);
    expect(isAwaitingResponse(s3)).toBe(false);
  });

  it('重复/回退序号的分片不影响正文（重放不写两遍）', () => {
    const { state: s0, assistant } = send();
    const attempt = assistant.attemptId ?? '';

    let state = reduce(s0, textChunk(assistant.id, attempt, 0, 'A'));
    state = reduce(state, textChunk(assistant.id, attempt, 0, 'A')); // 重放
    state = reduce(state, textChunk(assistant.id, attempt, 1, 'B'));
    state = reduce(state, textChunk(assistant.id, attempt, 0, 'A')); // 回退

    expect(getMessage(state, assistant.id)?.text).toBe('AB');
  });
});

describe('F02 / 断流不伪造完成（反例 · 反向对照）', () => {
  it('部分 chunk、无终帧 ⇒ 必须停在 interrupted，绝不是 complete', () => {
    const { state: s0, assistant } = send();
    const attempt = assistant.attemptId ?? '';

    // 只给部分正文，**不给任何 done 终帧**。
    let state = reduce(s0, textChunk(assistant.id, attempt, 0, '正在读取'));
    state = reduce(state, textChunk(assistant.id, attempt, 1, '文档…'));
    // 连接结束（没有终帧）。
    state = reduce(state, { type: 'streamEnded', messageId: assistant.id });

    const message = getMessage(state, assistant.id);
    expect(message?.text).toBe('正在读取文档…'); // 分片确实被应用 ⇒ 反例不是空壳
    expect(message?.status).toBe('interrupted');
    expect(message === null ? null : isCompleted(message.status)).toBe(false);
    expect(message === null ? null : isTerminal(message.status)).toBe(true);
    expect(isAwaitingResponse(state)).toBe(false);
  });

  it('断流后迟到的终帧不得把消息改判为 complete', () => {
    const { state: s0, assistant } = send();
    const attempt = assistant.attemptId ?? '';

    let state = reduce(s0, textChunk(assistant.id, attempt, 0, '半截'));
    state = reduce(state, { type: 'streamEnded', messageId: assistant.id });
    // 断点重连后姗姗来迟的终帧：属于同一次尝试，但该尝试已中断。
    state = reduce(state, textChunk(assistant.id, attempt, 1, '补齐', true));

    const message = getMessage(state, assistant.id);
    expect(message?.status).toBe('interrupted');
    expect(message?.text).toBe('半截'); // 迟到内容也不追加
  });

  it('一个流都没开始的断流 ⇒ interrupted（不是 pending 悬挂，也不是 complete）', () => {
    const { state: s0, assistant } = send();
    const state = reduce(s0, { type: 'streamEnded', messageId: assistant.id });
    expect(getMessage(state, assistant.id)?.status).toBe('interrupted');
  });

  it('错误帧 ⇒ failed（终态，非完成）', () => {
    const { state: s0, assistant } = send();
    const attempt = assistant.attemptId ?? '';
    let state = reduce(s0, textChunk(assistant.id, attempt, 0, '开始'));
    state = reduce(state, {
      type: 'streamChunk',
      delivery: {
        messageId: assistant.id,
        attemptId: attempt,
        seq: 1,
        chunk: { type: 'error', error: { code: 'UPSTREAM_UNAVAILABLE', message: '模型服务在超时前未返回' }, done: true },
      },
    });

    const message = getMessage(state, assistant.id);
    expect(message?.status).toBe('failed');
    expect(message?.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(message?.text).toBe('开始'); // 错误帧不污染正文
    expect(message === null ? null : isCompleted(message.status)).toBe(false);
  });
});

describe('F02 / 停止（停止即冻结）', () => {
  it('停止 ⇒ cancelled；后续 chunk 一律被忽略', () => {
    const { state: s0, assistant } = send();
    const attempt = assistant.attemptId ?? '';

    let state = reduce(s0, textChunk(assistant.id, attempt, 0, '已生成一半'));
    state = reduce(state, { type: 'stop', messageId: assistant.id });
    expect(getMessage(state, assistant.id)?.status).toBe('cancelled');

    state = reduce(state, textChunk(assistant.id, attempt, 1, '—不该出现—'));
    state = reduce(state, textChunk(assistant.id, attempt, 2, '—也不该出现—', true));

    const message = getMessage(state, assistant.id);
    expect(message?.status).toBe('cancelled');
    expect(message?.text).toBe('已生成一半');
  });

  it('停止是幂等的：重复停止不改变状态', () => {
    const { state: s0, assistant } = send();
    const s1 = reduce(s0, { type: 'stop', messageId: assistant.id });
    const s2 = reduce(s1, { type: 'stop', messageId: assistant.id });
    expect(s2).toBe(s1);
  });

  it('已停止的消息不再接受迟到引用', () => {
    const { state: s0, assistant } = send();
    let state = reduce(s0, { type: 'stop', messageId: assistant.id });
    state = reduce(state, {
      type: 'attachReference',
      messageId: assistant.id,
      reference: { kind: 'file', refId: 'file-9', label: '周报.docx' },
    });
    expect(getMessage(state, assistant.id)?.references).toHaveLength(0);
  });

  it('用户消息不可被停止（只对助手尝试生效）', () => {
    const { state: s0, userId } = send();
    expect(reduce(s0, { type: 'stop', messageId: userId })).toBe(s0);
  });
});

describe('F02 / 重试（尝试隔离）', () => {
  it('重试产生新消息与新 attemptId，旧尝试结果不污染新尝试', () => {
    const { state: s0, assistant } = send();
    const oldId = assistant.id;
    const oldAttempt = assistant.attemptId ?? '';

    let state = reduce(s0, textChunk(oldId, oldAttempt, 0, '旧的一半'));
    state = reduce(state, { type: 'stop', messageId: oldId });

    state = reduce(state, { type: 'retry', messageId: oldId });
    const retried = latestAssistantMessage(state);
    if (retried === null) throw new Error('重试应产生新的助手消息');

    expect(retried.id).not.toBe(oldId);
    expect(retried.attemptId).toBe(`${retried.id}#t1`);
    expect(retried.attemptId).not.toBe(oldAttempt);
    expect(retried.retryOf).toBe(oldId);
    expect(retried.status).toBe('pending');
    expect(retried.text).toBe('');

    // 旧尝试迟到的终帧：既不能改写旧消息，也不能写进新尝试。
    state = reduce(state, textChunk(oldId, oldAttempt, 1, '旧的另一半', true));
    expect(getMessage(state, oldId)?.status).toBe('cancelled');
    expect(getMessage(state, oldId)?.text).toBe('旧的一半');
    expect(getMessage(state, retried.id)?.text).toBe('');
    expect(getMessage(state, retried.id)?.status).toBe('pending');

    // 张冠李戴：拿新消息 id 配旧 attemptId，仍必须被拒绝。
    state = reduce(state, textChunk(retried.id, oldAttempt, 2, '串台内容', true));
    expect(getMessage(state, retried.id)?.text).toBe('');
    expect(getMessage(state, retried.id)?.status).toBe('pending');

    // 用正确的尝试坐标才能推进新尝试。
    state = reduce(state, textChunk(retried.id, retried.attemptId ?? '', 0, '新的结果', true));
    expect(getMessage(state, retried.id)?.status).toBe('complete');
    expect(getMessage(state, retried.id)?.text).toBe('新的结果');
    expect(getMessage(state, oldId)?.status).toBe('cancelled'); // 旧尝试保持冻结
  });

  it('对仍在流式的消息重试：旧尝试先被冻结为 cancelled，之后再写不进去', () => {
    const { state: s0, assistant } = send();
    const oldId = assistant.id;
    const oldAttempt = assistant.attemptId ?? '';

    let state = reduce(s0, textChunk(oldId, oldAttempt, 0, '进行中'));
    expect(getMessage(state, oldId)?.status).toBe('streaming');

    state = reduce(state, { type: 'retry', messageId: oldId });
    expect(getMessage(state, oldId)?.status).toBe('cancelled');

    state = reduce(state, textChunk(oldId, oldAttempt, 1, '迟到的完成', true));
    expect(getMessage(state, oldId)?.status).toBe('cancelled');
    expect(getMessage(state, oldId)?.text).toBe('进行中');
  });

  it('重试后历史保留：两条助手消息都在流里', () => {
    const { state: s0, assistant } = send();
    let state = reduce(s0, { type: 'stop', messageId: assistant.id });
    state = reduce(state, { type: 'retry', messageId: assistant.id });
    const assistants = state.messages.filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.id)).toEqual(['a-1', 'a-2']);
  });

  it('未知消息/用户消息不可重试', () => {
    const { state: s0, userId } = send();
    expect(reduce(s0, { type: 'retry', messageId: 'nope' })).toBe(s0);
    expect(reduce(s0, { type: 'retry', messageId: userId })).toBe(s0);
  });
});

function attachment(id: string) {
  return {
    id,
    name: '周报.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteLength: 2048,
    uri: 'content://docs/zhoubao',
    uriRejected: false,
    bytesRead: false as const,
  };
}
