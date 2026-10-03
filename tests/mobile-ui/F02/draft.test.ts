/**
 * F02 验收：输入与草稿（未发送草稿可恢复 / 附件占位）。
 *
 * 断言的是**纯函数往返**：serialize → deserialize 后内容一致（含空草稿与附件占位），
 * 且附件只是结构占位、绝不读字节；本地路径不会被当成可访问引用。
 */

import { describe, expect, it } from 'vitest';

import {
  createAttachmentPlaceholder,
  deserializeDraft,
  deserializeDraftStore,
  emptyDraft,
  getDraft,
  normalizeDraft,
  putDraft,
  recoverDraft,
  removeDraft,
  serializeDraft,
  serializeDraftStore,
  type ChatDraft,
  type DraftStore,
} from '../../../apps/mobile-ui/src/chat/index.js';

const CONVERSATION = 'conv-42';

function draftWith(text: string, attachments: ReturnType<typeof createAttachmentPlaceholder>[]): ChatDraft {
  return { conversationId: CONVERSATION, text, attachments };
}

describe('F02 / 附件占位（仅结构，不读 bytes）', () => {
  it('占位恒为 bytesRead=false，内容 URI 原样保留', () => {
    const att = createAttachmentPlaceholder({
      id: 'att-1',
      name: '周报.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteLength: 2048,
      uri: 'content://docs/zhoubao',
    });
    expect(att.bytesRead).toBe(false);
    expect(att.uri).toBe('content://docs/zhoubao');
    expect(att.uriRejected).toBe(false);
    expect(att.byteLength).toBe(2048);
  });

  it('本地绝对路径不会被当作可访问引用', () => {
    const winPath = createAttachmentPlaceholder({ id: 'a', name: 'x.docx', uri: 'D:\\<owner>\\x.docx' });
    expect(winPath.uri).toBeNull();
    expect(winPath.uriRejected).toBe(true);
    expect(winPath.bytesRead).toBe(false);

    const posixPath = createAttachmentPlaceholder({ id: 'b', name: 'y.docx', uri: '/home/u/y.docx' });
    expect(posixPath.uri).toBeNull();
    expect(posixPath.uriRejected).toBe(true);
  });

  it('缺失字段被规范化，不抛错（恢复路径要能容错）', () => {
    const att = createAttachmentPlaceholder({ id: 'att-2', name: '' });
    expect(att.name).toBe('未命名附件');
    expect(att.mime).toBeNull();
    expect(att.byteLength).toBeNull();
    expect(att.uri).toBeNull();
    expect(att.uriRejected).toBe(false);
  });
});

describe('F02 / 草稿序列化往返', () => {
  it('带附件占位的草稿：序列化→反序列化内容一致', () => {
    const draft = draftWith('把这份周报改成一页', [
      createAttachmentPlaceholder({ id: 'att-1', name: '周报.docx', mime: 'application/msword', uri: 'content://a/1' }),
    ]);
    const restored = deserializeDraft(serializeDraft(draft), CONVERSATION);
    expect(restored).toEqual(draft);
  });

  it('空草稿往返仍为空草稿', () => {
    const draft = emptyDraft(CONVERSATION);
    const restored = deserializeDraft(serializeDraft(draft), CONVERSATION);
    expect(restored).toEqual(draft);
    expect(restored?.text).toBe('');
    expect(restored?.attachments).toEqual([]);
  });

  it('序列化定序：同一草稿两次序列化逐字节相同', () => {
    const draft = draftWith('草稿', [createAttachmentPlaceholder({ id: 'att-1', name: 'a.txt' })]);
    expect(serializeDraft(draft)).toBe(serializeDraft(draft));
  });

  it('反序列化容错：缺失/损坏输入返回 null（不抛错）', () => {
    expect(deserializeDraft(null, CONVERSATION)).toBeNull();
    expect(deserializeDraft('', CONVERSATION)).toBeNull();
    expect(deserializeDraft('{不是 JSON', CONVERSATION)).toBeNull();
    expect(deserializeDraft('"字符串"', CONVERSATION)).toBeNull();
    expect(deserializeDraft('42', CONVERSATION)).toBeNull();
  });

  it('会话不匹配的草稿不得恢复进别的会话', () => {
    const raw = serializeDraft(draftWith('属于 conv-42', []));
    expect(deserializeDraft(raw, 'conv-99')).toBeNull();
    expect(deserializeDraft(raw, CONVERSATION)?.text).toBe('属于 conv-42');
  });

  it('normalizeDraft 丢弃形状不对的附件，不整份报废', () => {
    const normalized = normalizeDraft(
      { text: '半份草稿', attachments: [null, 'x', { id: 'ok', name: 'ok.txt' }, { name: '无 id' }] },
      CONVERSATION,
    );
    expect(normalized.text).toBe('半份草稿');
    expect(normalized.attachments.map((a) => a.id)).toEqual(['ok']);
  });
});

describe('F02 / 多会话草稿存储与恢复', () => {
  const store: DraftStore = (() => {
    let s: DraftStore = {};
    s = putDraft(s, draftWith('会话 A 的草稿', []));
    s = putDraft(s, { conversationId: 'conv-99', text: '会话 B 的草稿', attachments: [] });
    return s;
  })();

  it('按会话取草稿，互不串台', () => {
    expect(getDraft(store, CONVERSATION)?.text).toBe('会话 A 的草稿');
    expect(getDraft(store, 'conv-99')?.text).toBe('会话 B 的草稿');
    expect(getDraft(store, 'conv-404')).toBeNull();
  });

  it('存储序列化往返保留每个会话的草稿', () => {
    const restored = deserializeDraftStore(serializeDraftStore(store));
    expect(restored[CONVERSATION]?.text).toBe('会话 A 的草稿');
    expect(restored['conv-99']?.text).toBe('会话 B 的草稿');
  });

  it('空草稿不落盘（避免持久化一堆空壳）', () => {
    const withEmpty = putDraft(store, emptyDraft('conv-empty'));
    const raw = serializeDraftStore(withEmpty);
    expect(raw).not.toContain('conv-empty');
    expect(deserializeDraftStore(raw)['conv-empty']).toBeUndefined();
  });

  it('removeDraft 移除单个会话，其余不受影响', () => {
    const next = removeDraft(store, CONVERSATION);
    expect(getDraft(next, CONVERSATION)).toBeNull();
    expect(getDraft(next, 'conv-99')?.text).toBe('会话 B 的草稿');
    expect(removeDraft(next, CONVERSATION)).toBe(next); // 幂等
  });

  it('损坏的存储串返回空存储而不是崩溃', () => {
    expect(deserializeDraftStore('{坏')).toEqual({});
    expect(deserializeDraftStore(null)).toEqual({});
    expect(deserializeDraftStore('{"v":1}')).toEqual({});
  });

  it('recoverDraft：有内容才恢复，空草稿返回 null', () => {
    expect(recoverDraft(store, CONVERSATION)?.text).toBe('会话 A 的草稿');
    expect(recoverDraft({}, 'conv-none')).toBeNull();
    expect(recoverDraft({}, 'conv-none', emptyDraft('conv-none'))).toBeNull();
  });

  it('recoverDraft 优先使用会话内联草稿', () => {
    const inline: ChatDraft = { conversationId: CONVERSATION, text: '内联最新', attachments: [] };
    expect(recoverDraft(store, CONVERSATION, inline)?.text).toBe('内联最新');
  });
});
