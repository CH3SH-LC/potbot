/**
 * F02 传输接线验收：`buildSendCommandForState` → `KernelClientPort.sendCommand`，
 * v1 `Event` 流 → `kernelEvent` / `eventStreamEnded`。
 *
 * 本文件锁死的**真实缺陷**：传输「抛出 / 中止 / 订阅失败」时，适配层必须把两条流都判为中断——
 *   - 正文流：`streamEnded` ⇒ `interrupted`（**绝不** `complete`）；
 *   - 事件流：`eventStreamEnded` ⇒ 未终态任务 `progressUnknown`（**绝不** 成功）。
 * 并验证完成口径仍只有一条：正文 `complete` **且** 内核任务 `succeeded` 且带 `resultRef`
 * （`isMessageFullyDone`），适配器不另立判据。
 *
 * 端口以 fake 注入——真机传输（`src/platform/KernelClient`）属 F 线协调者，本层为单元验收。
 *
 * 只跑定向：`npx vitest run tests/mobile-ui/F02/kernel-adapter.test.ts --reporter=basic`
 */

import { describe, expect, it } from 'vitest';

import {
  assertAttachmentsDescriptorOnly,
  buildSendCommandForState,
  createAttachmentPlaceholder,
  createChatKernelAdapter,
  createChatState,
  getMessage,
  getTask,
  latestAssistantMessage,
  reduce,
  type ChatAction,
  type ChatState,
  type Command,
  type Event,
  type EventStatus,
  type KernelClientPort,
  type KernelStreamBreak,
  type KernelStreamBreakReason,
  type Unsubscribe,
} from '../../../apps/mobile-ui/src/chat/index.js';

const CONVERSATION = 'conv-adapter';

// ---------------------------------------------------------------------------
// 测试替身：fake KernelClientPort + 可观察 store
// ---------------------------------------------------------------------------

class FakeKernelClient implements KernelClientPort {
  readonly sent: Command[] = [];
  subscribedCommandId: string | null = null;
  unsubscribed = 0;
  syncSendError: unknown = null;
  asyncSendError: unknown = null;
  subscribeError: unknown = null;
  private handlers: {
    onEvent: (event: Event) => void;
    onBreak: (breakEvent: KernelStreamBreak) => void;
  } | null = null;

  sendCommand(command: Command): void | Promise<void> {
    this.sent.push(command);
    if (this.syncSendError !== null) throw this.syncSendError;
    if (this.asyncSendError !== null) return Promise.reject(this.asyncSendError);
    return undefined;
  }

  subscribe(
    commandId: string,
    onEvent: (event: Event) => void,
    onBreak: (breakEvent: KernelStreamBreak) => void,
  ): Unsubscribe {
    if (this.subscribeError !== null) throw this.subscribeError;
    this.subscribedCommandId = commandId;
    this.handlers = { onEvent, onBreak };
    return () => {
      this.unsubscribed += 1;
      this.handlers = null;
    };
  }

  emit(event: Event): void {
    if (this.handlers === null) throw new Error('no active subscription');
    this.handlers.onEvent(event);
  }

  break(reason: KernelStreamBreakReason = 'aborted'): void {
    if (this.handlers === null) throw new Error('no active subscription');
    this.handlers.onBreak({ reason, message: 'test-break' });
  }
}

function makeStore(initial: ChatState): { dispatch: (action: ChatAction) => void; get: () => ChatState } {
  let state = initial;
  return {
    dispatch: (action) => {
      state = reduce(state, action);
    },
    get: () => state,
  };
}

function evt(commandId: string, seq: number, status: EventStatus, extra: Partial<Event> = {}): Event {
  return { eventId: `evt-${seq}`, seq, commandId, revision: 1, status, ...extra };
}

/** 真入口：填正文 → 发送，拿到助手占位。 */
function sendable(text = '把周报改成一页'): { state: ChatState; assistantId: string } {
  let state = createChatState(CONVERSATION);
  state = reduce(state, { type: 'setDraftText', text });
  state = reduce(state, { type: 'sendUserMessage' });
  const assistant = latestAssistantMessage(state);
  if (assistant === null) throw new Error('发送后应有助手占位');
  return { state, assistantId: assistant.id };
}

// ---------------------------------------------------------------------------
// 正向：命令下发 + 两条流都到位才算完成
// ---------------------------------------------------------------------------

describe('F02 / 传输接线：命令下发与事件归约', () => {
  it('send 下发命令、绑定 commandId，事件流进 reducer', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);

    const outcome = await adapter.send(store.get(), assistantId);
    expect(outcome.submitted).toBe(true);
    expect(outcome.broken).toBe(false);
    expect(outcome.commandId).not.toBeNull();
    expect(client.sent).toHaveLength(1);
    const sent = client.sent[0];
    if (sent === undefined || outcome.commandId === null) throw new Error('应已下发命令');
    expect(sent.commandId).toBe(outcome.commandId);
    expect(client.subscribedCommandId).toBe(outcome.commandId);
    expect(getTask(store.get(), assistantId)?.commandId).toBe(outcome.commandId);

    client.emit(evt(outcome.commandId, 1, 'running'));
    expect(getTask(store.get(), assistantId)?.status).toBe('running');
  });

  it('正文终帧 + 内核 succeeded(带 resultRef) ⇒ isFullyDone 为真', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    const outcome = await adapter.send(store.get(), assistantId);
    if (outcome.commandId === null) throw new Error('应已下发命令');

    adapter.deliverChunk(store.get(), assistantId, { type: 'text', text: '改好了。', done: true }, 0);
    expect(getMessage(store.get(), assistantId)?.status).toBe('complete');
    // 只有正文收完，内核流未到位 ⇒ 仍不算完成。
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);

    client.emit(evt(outcome.commandId, 1, 'succeeded', { resultRef: 'artifact:doc@1' }));
    expect(getTask(store.get(), assistantId)?.status).toBe('succeeded');
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(true);
  });

  it('内核 succeeded 缺 resultRef ⇒ fail-closed 降级 failed，绝不完成', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    const outcome = await adapter.send(store.get(), assistantId);
    if (outcome.commandId === null) throw new Error('应已下发命令');

    adapter.deliverChunk(store.get(), assistantId, { type: 'text', text: '改好了。', done: true }, 0);
    client.emit(evt(outcome.commandId, 1, 'succeeded')); // 缺 resultRef
    expect(getTask(store.get(), assistantId)?.status).toBe('failed');
    expect(getTask(store.get(), assistantId)?.failClosed).toBe(true);
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);
  });

  it('内核 failed ⇒ 错误码可见且不完成', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    const outcome = await adapter.send(store.get(), assistantId);
    if (outcome.commandId === null) throw new Error('应已下发命令');

    client.emit(evt(outcome.commandId, 1, 'failed', { error: { code: 'UPSTREAM', message: '模型不可用' } }));
    expect(getTask(store.get(), assistantId)?.status).toBe('failed');
    expect(getTask(store.get(), assistantId)?.error?.code).toBe('UPSTREAM');
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 真实缺陷：抛出 / 中止 / 订阅失败 ⇒ 两条流中断，绝不 complete
// ---------------------------------------------------------------------------

describe('F02 / 传输中断：streamEnded→interrupted + eventStreamEnded→progressUnknown', () => {
  function expectInterrupted(store: ReturnType<typeof makeStore>, assistantId: string, adapter: ReturnType<typeof createChatKernelAdapter>): void {
    expect(getMessage(store.get(), assistantId)?.status).not.toBe('complete');
    expect(getMessage(store.get(), assistantId)?.status).toBe('interrupted');
    expect(getTask(store.get(), assistantId)?.progressUnknown).toBe(true);
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);
  }

  it('sendCommand 同步抛出 ⇒ 中断，绝不 complete', async () => {
    const client = new FakeKernelClient();
    client.syncSendError = new Error('boom');
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);

    const outcome = await adapter.send(store.get(), assistantId);
    expect(outcome.submitted).toBe(false);
    expect(outcome.broken).toBe(true);
    expect(outcome.breakReason).toBe('transport-error');
    expectInterrupted(store, assistantId, adapter);
  });

  it('sendCommand 返回被拒 Promise ⇒ 中断，绝不 complete', async () => {
    const client = new FakeKernelClient();
    client.asyncSendError = new Error('rejected');
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);

    const outcome = await adapter.send(store.get(), assistantId);
    expect(outcome.submitted).toBe(false);
    expect(outcome.broken).toBe(true);
    // 失败后主动取消订阅，避免悬挂。
    expect(client.unsubscribed).toBe(1);
    expectInterrupted(store, assistantId, adapter);
  });

  it('subscribe 抛出 ⇒ 中断，绝不 complete', async () => {
    const client = new FakeKernelClient();
    client.subscribeError = new Error('no transport');
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);

    const outcome = await adapter.send(store.get(), assistantId);
    expect(outcome.submitted).toBe(false);
    expect(outcome.broken).toBe(true);
    expect(client.sent).toHaveLength(0); // 尚未下发
    expectInterrupted(store, assistantId, adapter);
  });

  it('onBreak 中途断流 ⇒ 中断；断流后迟到 succeeded 被丢弃', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    const outcome = await adapter.send(store.get(), assistantId);
    if (outcome.commandId === null) throw new Error('应已下发命令');

    client.emit(evt(outcome.commandId, 1, 'running'));
    client.break('aborted');
    expectInterrupted(store, assistantId, adapter);
    expect(getTask(store.get(), assistantId)?.status).toBe('running'); // 不谎报 failed/succeeded

    // 断流后本订阅已死：迟到事件不得改写，更不得制造完成。
    client.emit(evt(outcome.commandId, 9, 'succeeded', { resultRef: 'artifact:x@1' }));
    expect(getTask(store.get(), assistantId)?.status).toBe('running');
    expect(getTask(store.get(), assistantId)?.resultRef).toBeNull();
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);
  });

  it('正文已 complete 但事件流断开 ⇒ 仍不完成（另一条流没到位）', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    const outcome = await adapter.send(store.get(), assistantId);
    if (outcome.commandId === null) throw new Error('应已下发命令');

    adapter.deliverChunk(store.get(), assistantId, { type: 'text', text: '改好了。', done: true }, 0);
    expect(getMessage(store.get(), assistantId)?.status).toBe('complete');
    client.break('closed');
    // 正文流已终态：streamEnded 不改写它；事件流断 ⇒ 任务进度不可知。
    expect(getMessage(store.get(), assistantId)?.status).toBe('complete');
    expect(getTask(store.get(), assistantId)?.progressUnknown).toBe(true);
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 命令隔离 & 本地前置条件
// ---------------------------------------------------------------------------

describe('F02 / 传输接线：隔离与前置条件', () => {
  it('串台 commandId 的事件不投递（任务不变）', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    const outcome = await adapter.send(store.get(), assistantId);
    if (outcome.commandId === null) throw new Error('应已下发命令');

    client.emit(evt('cmd-foreign', 1, 'succeeded', { resultRef: 'artifact:other@1' }));
    expect(getTask(store.get(), assistantId)?.status).toBe('idle');
    expect(getTask(store.get(), assistantId)?.resultRef).toBeNull();
    expect(adapter.isFullyDone(store.get(), assistantId)).toBe(false);
  });

  it('找不到可发送正文 ⇒ 不发命令、不投递、不编造', async () => {
    // 空正文不产生消息：不存在可绑定的助手消息。
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'setDraftText', text: '   ' });
    state = reduce(state, { type: 'sendUserMessage' });
    const store = makeStore(state);
    const client = new FakeKernelClient();
    const adapter = createChatKernelAdapter(client, store.dispatch);

    const outcome = await adapter.send(store.get(), 'a-404');
    expect(outcome.preconditionFailed).toBe(true);
    expect(outcome.commandId).toBeNull();
    expect(outcome.submitted).toBe(false);
    expect(client.sent).toHaveLength(0);
    expect(store.get()).toBe(state); // 无任何动作投递
  });

  it('dispose 取消订阅，之后 send 抛错', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = sendable();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    await adapter.send(store.get(), assistantId);
    expect(client.unsubscribed).toBe(0);

    adapter.dispose();
    expect(client.unsubscribed).toBe(1);
    await expect(adapter.send(store.get(), assistantId)).rejects.toThrow('adapter-disposed');
  });
});

// ---------------------------------------------------------------------------
// 附件：只带描述，绝无字节
// ---------------------------------------------------------------------------

describe('F02 / 传输接线：附件仅描述（bytesRead=false）', () => {
  function withAttachment(): { state: ChatState; assistantId: string } {
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'setDraftText', text: '把这份周报改成一页' });
    state = reduce(state, {
      type: 'addAttachment',
      attachment: createAttachmentPlaceholder({
        id: 'att-1',
        name: 'zhoubao.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byteLength: 4096,
        uri: 'content://docs/zhoubao',
      }),
    });
    state = reduce(state, { type: 'sendUserMessage' });
    const assistant = latestAssistantMessage(state);
    if (assistant === null) throw new Error('发送后应有助手占位');
    return { state, assistantId: assistant.id };
  }

  it('下发的命令带附件描述，且不含 bytesRead / 本地路径', async () => {
    const client = new FakeKernelClient();
    const { state, assistantId } = withAttachment();
    const store = makeStore(state);
    const adapter = createChatKernelAdapter(client, store.dispatch);
    await adapter.send(store.get(), assistantId);

    const sent = client.sent[0];
    if (sent === undefined) throw new Error('应已下发命令');
    expect(() => assertAttachmentsDescriptorOnly(sent)).not.toThrow();

    const descriptors = sent.metadata?.['attachments'] as Array<Record<string, unknown>> | undefined;
    expect(descriptors).toHaveLength(1);
    expect(descriptors?.[0]?.['id']).toBe('att-1');
    expect(descriptors?.[0]?.['uri']).toBe('content://docs/zhoubao');

    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('bytesRead');
    expect(serialized).not.toContain('C:\\');
    expect(serialized).not.toContain('/home/');
  });

  it('守卫：附件描述含白名单外的键（如 bytes）⇒ 抛错', () => {
    const rogue: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-x',
      operation: 'create',
      idempotencyKey: 'idem-x',
      payload: { conversationId: 'c' },
      metadata: {
        attachments: [
          { id: 'a', name: 'a', mime: null, byteLength: 1, uri: null, uriRejected: false, bytes: [1, 2, 3] },
        ],
      },
    };
    expect(() => assertAttachmentsDescriptorOnly(rogue)).toThrow(/not-allowed/);
  });

  it('buildSendCommandForState 产出通过守卫的干净描述', () => {
    const { state, assistantId } = withAttachment();
    const command = buildSendCommandForState(state, assistantId);
    if (command === null) throw new Error('应能推导命令');
    expect(() => assertAttachmentsDescriptorOnly(command)).not.toThrow();
  });
});
