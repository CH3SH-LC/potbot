/**
 * F02 验收：输入/附件在发送路径上不被静默丢弃。
 *
 * design-07 行 119：每个会话分别保存消息、输入草稿与未发送附件；未发送附件可单独移除；
 * 「失败附件不阻止无关文本安全发送」。本文件锁定三点：
 *   1) 发送时草稿附件随**用户消息**保留（可回看本条消息带了什么），并被清出草稿；
 *   2) 从状态推导的发送命令把附件（**仅描述，绝无字节/本地路径**）带进 `metadata`；
 *   3) 一个 uri 被拒/未就绪的附件**不会**阻止非空文本安全发送（唯一自然语言入口照常）。
 *
 * 只跑定向：`pnpm vitest run tests/mobile-ui/F02/send-attachments.test.ts`
 */

import { describe, expect, it } from 'vitest';

import {
  buildSendCommandForState,
  canSubmit,
  createAttachmentPlaceholder,
  createChatState,
  getMessage,
  latestAssistantMessage,
  reduce,
  type AttachmentDescriptor,
  type ChatState,
} from '../../../apps/mobile-ui/src/chat/index.js';

const CONVERSATION = 'conv-att';

function attachment(id: string, uri: string) {
  return createAttachmentPlaceholder({
    id,
    name: `${id}.docx`,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteLength: 4096,
    uri,
  });
}

/** 填文本 + 附件 → 发送；返回发送后的状态与用户消息 id。 */
function sendWith(text: string, attachments: ReturnType<typeof attachment>[]) {
  let state = createChatState(CONVERSATION);
  state = reduce(state, { type: 'setDraftText', text });
  for (const att of attachments) state = reduce(state, { type: 'addAttachment', attachment: att });
  state = reduce(state, { type: 'sendUserMessage' });
  const userId = state.messages.find((m) => m.role === 'user')?.id;
  if (userId === undefined) throw new Error('发送后应有用户消息');
  return { state, userId };
}

describe('F02 / 附件随消息保留（不被静默丢弃）', () => {
  it('发送把草稿附件带到用户消息上', () => {
    const { state, userId } = sendWith('把这份周报改成一页', [attachment('att-1', 'content://docs/zhoubao')]);
    const user = getMessage(state, userId);
    expect(user?.attachments?.map((a) => a.id)).toEqual(['att-1']);
    expect(user?.attachments?.[0]?.uri).toBe('content://docs/zhoubao');
    expect(user?.attachments?.[0]?.bytesRead).toBe(false); // 仍是占位，不读字节
  });

  it('发送后草稿清空（正文与附件）', () => {
    const { state } = sendWith('带着附件发出去', [attachment('att-1', 'content://docs/a')]);
    expect(state.draft.text).toBe('');
    expect(state.draft.attachments).toHaveLength(0);
  });

  it('多个附件保持输入顺序', () => {
    const { state, userId } = sendWith('两个文件一起', [
      attachment('att-1', 'content://docs/a'),
      attachment('att-2', 'content://docs/b'),
    ]);
    expect(getMessage(state, userId)?.attachments?.map((a) => a.id)).toEqual(['att-1', 'att-2']);
  });
});

describe('F02 / 命令携带附件（仅描述，无字节/无本地路径）', () => {
  it('从状态推导的发送命令带 attachments 元数据', () => {
    const { state } = sendWith('把这份周报改成一页', [attachment('att-1', 'content://docs/zhoubao')]);
    const assistant = latestAssistantMessage(state);
    if (assistant === null) throw new Error('应有助手占位');

    const command = buildSendCommandForState(state, assistant.id);
    expect(command).not.toBeNull();
    const descriptors = command?.metadata?.['attachments'] as AttachmentDescriptor[] | undefined;
    expect(descriptors).toHaveLength(1);
    expect(descriptors?.[0]?.id).toBe('att-1');
    expect(descriptors?.[0]?.uri).toBe('content://docs/zhoubao');
  });

  it('本地绝对路径附件：命令里 uri 为 null、uriRejected 为真，且整份命令不含盘符路径', () => {
    const bad = createAttachmentPlaceholder({ id: 'att-bad', name: 'report.docx', uri: 'C:\\temp\\report.docx' });
    expect(bad.uri).toBeNull();
    expect(bad.uriRejected).toBe(true);

    const { state } = sendWith('附件路径不合法也照发正文', [bad]);
    const assistant = latestAssistantMessage(state);
    if (assistant === null) throw new Error('应有助手占位');
    const command = buildSendCommandForState(state, assistant.id);
    const descriptors = command?.metadata?.['attachments'] as AttachmentDescriptor[] | undefined;
    expect(descriptors?.[0]?.uri).toBeNull();
    expect(descriptors?.[0]?.uriRejected).toBe(true);

    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain('C:\\');
    expect(serialized).not.toContain('report.docx\\');
    expect(serialized).not.toContain('bytesRead');
  });

  it('无附件时不写 attachments 键（既有命令形状不变）', () => {
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'setDraftText', text: '只是说句话' });
    state = reduce(state, { type: 'sendUserMessage' });
    const assistant = latestAssistantMessage(state);
    if (assistant === null) throw new Error('应有助手占位');
    const command = buildSendCommandForState(state, assistant.id);
    expect(command?.metadata?.['attachments']).toBeUndefined();
  });
});

describe('F02 / 失败附件不阻止文本安全发送', () => {
  it('被拒路径的附件 + 非空文本 ⇒ 仍可提交（唯一自然语言入口照常）', () => {
    let state: ChatState = createChatState(CONVERSATION);
    state = reduce(state, { type: 'setDraftText', text: '正文照发' });
    state = reduce(state, {
      type: 'addAttachment',
      attachment: createAttachmentPlaceholder({ id: 'att-bad', name: 'x.docx', uri: '/home/u/x.docx' }),
    });
    expect(state.draft.attachments[0]?.uriRejected).toBe(true);
    expect(canSubmit(state)).toBe(true);

    const after = reduce(state, { type: 'sendUserMessage' });
    expect(after.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('未发送附件可单独移除，其余保留', () => {
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'addAttachment', attachment: attachment('att-1', 'content://docs/a') });
    state = reduce(state, { type: 'addAttachment', attachment: attachment('att-2', 'content://docs/b') });
    state = reduce(state, { type: 'removeAttachment', attachmentId: 'att-1' });
    expect(state.draft.attachments.map((a) => a.id)).toEqual(['att-2']);
    // 移除不存在的附件是幂等的（引用不变）。
    expect(reduce(state, { type: 'removeAttachment', attachmentId: 'att-1' })).toBe(state);
  });
});
