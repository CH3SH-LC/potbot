/**
 * F03 验收：`kernel-adapter.ts` —— 命令接线（commands.ts → 端口）与事件接线（内核事件 → 状态）。
 *
 * 用**结构化假端口**（形状与 `KernelClient` 一致）驱动，断言：
 *   - 命令方向：发送前校验分支不变量；**先订阅后发送**；中间事件转交 onEvent；断流转交 onBreak
 *     （恒为 progressUnknown）；结束后退订；订阅失败记为 submit-rejected 并抛出。
 *   - 事件方向：连续 revision 应用；过期/重复 replay；缺口扣留 + pendingResync，迟到补齐后续上；
 *     非本域事件忽略；未知会话忽略；非法 lifecycle 被 reducer 拒收且不改状态。
 *   - 绑定薄壳：事件汇入 stream、退订后不再接收。
 *
 * 另含一条**编译期**断言：真实 `platform.KernelClient` 结构上满足 `ConversationCommandPort`。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ConversationError,
  bindConversationEventStream,
  conversationIdOfEvent,
  createConversation,
  createConversationsState,
  dispatchConversationCommand,
  getConversation,
  isConversationEvent,
  reconcileConversationEvents,
  createConversationsStream,
  type ConversationCommandPort,
  type ConversationCommandReceipt,
  type ConversationsState,
  type ConversationStreamBreak,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { buildCreateConversationCommand } from '../../../apps/mobile-ui/src/conversations/commands.js';
import type { Command, Event } from '../../../contracts/mobile-v1/types.js';
import type { KernelClient } from '../../../apps/mobile-ui/src/platform/index.js';

// 编译期：真实 KernelClient 必须可直接作为命令端口传入（结构兼容，无需适配）。
const _kernelClientIsPort: ConversationCommandPort = {} as KernelClient;
void _kernelClientIsPort;

const CTX = { commandId: 'cmd-1', idempotencyKey: 'idem-1' };

function ev(partial: Partial<Event> & { eventId: string; revision: number }): Event {
  return {
    seq: partial.seq ?? partial.revision,
    commandId: partial.commandId ?? 'cmd-1',
    status: partial.status ?? 'running',
    ...partial,
  } as Event;
}

function conv(id: string): ConversationsState {
  return createConversation(createConversationsState(), { id, title: '会话', select: false });
}

// ---------------------------------------------------------------------------
// 命令方向
// ---------------------------------------------------------------------------

class FakeCommandPort implements ConversationCommandPort {
  readonly calls: string[] = [];
  subscribed: { commandId: string; onEvent: (e: Event) => void; onBreak: (b: ConversationStreamBreak) => void } | null = null;
  unsubscribed = false;
  constructor(
    private readonly behavior: {
      onSend?: (port: FakeCommandPort, command: Command) => Promise<ConversationCommandReceipt>;
      throwOnSubscribe?: boolean;
    } = {},
  ) {}

  subscribe(commandId: string, onEvent: (e: Event) => void, onBreak: (b: ConversationStreamBreak) => void): () => void {
    this.calls.push('subscribe');
    if (this.behavior.throwOnSubscribe === true) throw new Error('subscribe boom');
    this.subscribed = { commandId, onEvent, onBreak };
    return () => {
      this.unsubscribed = true;
    };
  }

  sendCommand(command: Command): Promise<ConversationCommandReceipt> {
    this.calls.push('sendCommand');
    if (this.behavior.onSend !== undefined) return this.behavior.onSend(this, command);
    return Promise.resolve({
      commandId: command.commandId,
      event: ev({ eventId: 'e-done', revision: 2, commandId: command.commandId, status: 'succeeded', resultRef: 'ref' }),
      status: 'succeeded',
      resultRef: 'ref',
      revision: 2,
      verificationMode: 'real',
      idempotentReplay: false,
    });
  }
}

describe('F03 / 命令接线：commands.ts → 端口', () => {
  it('先订阅后发送；中间事件转交 onEvent；返回回执；结束后退订', async () => {
    const port = new FakeCommandPort({
      onSend: (p, command) => {
        // 发送时订阅必须已建立，且能收到中间事件。
        expect(p.subscribed?.commandId).toBe(command.commandId);
        p.subscribed?.onEvent(ev({ eventId: 'e-mid', revision: 1, commandId: command.commandId, status: 'running' }));
        return Promise.resolve({
          commandId: command.commandId,
          event: ev({ eventId: 'e-done', revision: 2, commandId: command.commandId, status: 'succeeded', resultRef: 'r' }),
          status: 'succeeded',
          resultRef: 'r',
          revision: 2,
          verificationMode: 'real',
          idempotentReplay: false,
        });
      },
    });
    const seen: Event[] = [];
    const receipt = await dispatchConversationCommand(port, buildCreateConversationCommand(CTX, { goal: '写周报' }), {
      onEvent: (event) => seen.push(event),
    });
    expect(port.calls).toEqual(['subscribe', 'sendCommand']);
    expect(seen.map((e) => e.eventId)).toEqual(['e-mid']);
    expect(receipt.status).toBe('succeeded');
    expect(receipt.resultRef).toBe('r');
    expect(port.unsubscribed).toBe(true);
  });

  it('断流转交 onBreak，且恒为 progressUnknown（绝不升级为成功）', async () => {
    const port = new FakeCommandPort({
      onSend: (p, command) => {
        p.subscribed?.onBreak({
          commandId: command.commandId,
          reason: 'transport-closed',
          status: 'progressUnknown',
          detail: '桥通道断开',
          lastEvent: null,
        });
        return Promise.resolve({
          commandId: command.commandId,
          event: ev({ eventId: 'e-unknown', revision: 1, commandId: command.commandId, status: 'running' }),
          status: 'running',
          resultRef: null,
          revision: 1,
          verificationMode: 'fixture',
          idempotentReplay: false,
        });
      },
    });
    const breaks: ConversationStreamBreak[] = [];
    await dispatchConversationCommand(port, buildCreateConversationCommand(CTX), {
      onBreak: (info) => breaks.push(info),
    });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.status).toBe('progressUnknown');
    expect(breaks[0]?.reason).toBe('transport-closed');
  });

  it('形状不合法的命令在**发送前**被拒（不订阅、不投递）', async () => {
    const port = new FakeCommandPort();
    const bad: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'bad-1',
      operation: 'mutate',
      idempotencyKey: 'k',
      payload: { conversationId: 'conv-x' }, // 缺 expectedRevision ⇒ 违反 mutation 分支
    };
    await expect(dispatchConversationCommand(port, bad)).rejects.toBeInstanceOf(ConversationError);
    expect(port.calls).toEqual([]);
  });

  it('订阅失败 ⇒ onBreak 记 submit-rejected 且抛出（不吞掉）', async () => {
    const port = new FakeCommandPort({ throwOnSubscribe: true });
    const breaks: ConversationStreamBreak[] = [];
    await expect(
      dispatchConversationCommand(port, buildCreateConversationCommand(CTX), { onBreak: (b) => breaks.push(b) }),
    ).rejects.toThrow('subscribe boom');
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.reason).toBe('submit-rejected');
    expect(breaks[0]?.status).toBe('progressUnknown');
  });
});

// ---------------------------------------------------------------------------
// 事件方向
// ---------------------------------------------------------------------------

describe('F03 / 事件接线：内核事件 → applyConversationUpdate', () => {
  it('连续 revision 应用（patch 生效，revision 推进）；过期/重复记为 replay', () => {
    let stream = createConversationsStream(conv('conv-x'));
    const r1 = reconcileConversationEvents(
      stream,
      ev({ eventId: 'e2', revision: 2, metadata: { conversationId: 'conv-x', title: '新标题' } }),
    );
    stream = r1.stream;
    expect(r1.outcomes.map((o) => o.code)).toEqual(['applied']);
    expect(getConversation(stream.state, 'conv-x')?.title).toBe('新标题');
    expect(getConversation(stream.state, 'conv-x')?.revision).toBe(2);

    const r2 = reconcileConversationEvents(
      stream,
      ev({ eventId: 'e2-dup', revision: 2, metadata: { conversationId: 'conv-x', title: '过期' } }),
    );
    expect(r2.outcomes.map((o) => o.code)).toEqual(['replay']);
    expect(getConversation(r2.stream.state, 'conv-x')?.title).toBe('新标题');
  });

  it('缺口扣押并记 pendingResync；迟到补齐后连续段自动续上', () => {
    let stream = createConversationsStream(conv('conv-x'));
    // 收到 revision 4（缺 2、3）⇒ gap，扣留。
    const g = reconcileConversationEvents(
      stream,
      ev({ eventId: 'e4', revision: 4, metadata: { conversationId: 'conv-x', note: 'x' } }),
    );
    stream = g.stream;
    expect(g.outcomes.map((o) => o.code)).toEqual(['gap']);
    expect(g.needsResync).toEqual(['conv-x']);
    expect(getConversation(stream.state, 'conv-x')?.revision).toBe(1);

    // 补齐 revision 2 ⇒ 应用 2；4 仍缺 3，继续扣押并重报 gap。
    const s2 = reconcileConversationEvents(
      stream,
      ev({ eventId: 'e2', revision: 2, metadata: { conversationId: 'conv-x' } }),
    );
    stream = s2.stream;
    expect(s2.outcomes.map((o) => o.code)).toEqual(['applied', 'gap']);
    expect(s2.needsResync).toEqual(['conv-x']);

    // 补齐 revision 3 ⇒ 连续段 3、4 依次续上，缺口消除。
    const s3 = reconcileConversationEvents(
      stream,
      ev({ eventId: 'e3', revision: 3, metadata: { conversationId: 'conv-x' } }),
    );
    expect(s3.outcomes.map((o) => o.code)).toEqual(['applied', 'applied']);
    expect(getConversation(s3.stream.state, 'conv-x')?.revision).toBe(4);
    expect(s3.needsResync).toEqual([]);
  });

  it('非本域事件（无 conversationId）忽略；未知会话记为 unknown-conversation', () => {
    const stream = createConversationsStream(conv('conv-x'));
    expect(isConversationEvent(ev({ eventId: 'e', revision: 2 }))).toBe(false);
    expect(conversationIdOfEvent(ev({ eventId: 'e', revision: 2, metadata: { taskId: 't1' } }))).toBeNull();
    const r = reconcileConversationEvents(stream, [
      ev({ eventId: 'e-other', revision: 1, metadata: { taskId: 't1' } }),
      ev({ eventId: 'e-ghost', revision: 2, metadata: { conversationId: 'ghost' } }),
    ]);
    expect(r.outcomes.map((o) => o.code)).toEqual(['not-conversation-event', 'unknown-conversation']);
    expect(r.changed).toBe(false);
    expect(r.stream.state).toBe(stream.state);
  });

  it('非法 lifecycle 被 reducer 拒收（invalid-lifecycle）且不改状态', () => {
    const stream = createConversationsStream(conv('conv-x'));
    const r = reconcileConversationEvents(
      stream,
      ev({ eventId: 'e2', revision: 2, metadata: { conversationId: 'conv-x', lifecycle: 'deleted' } }),
    );
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]?.code).toBe('rejected');
    expect(r.outcomes[0]?.errorCode).toBe('invalid-lifecycle');
    expect(getConversation(r.stream.state, 'conv-x')?.lifecycle).toBe('active');
    expect(getConversation(r.stream.state, 'conv-x')?.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 订阅绑定
// ---------------------------------------------------------------------------

describe('F03 / 订阅绑定', () => {
  it('事件汇入 stream 并触发 onChange；退订后不再接收', () => {
    const listeners = new Set<(e: Event) => void>();
    const source = {
      subscribe(listener: (e: Event) => void) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    };
    const onChange = vi.fn();
    const binding = bindConversationEventStream(source, conv('conv-x'), { onChange });
    expect(binding.eventCount).toBe(0);

    for (const listener of listeners) {
      listener(ev({ eventId: 'e2', revision: 2, metadata: { conversationId: 'conv-x', title: 'A' } }));
    }
    expect(binding.eventCount).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getConversation(binding.stream.state, 'conv-x')?.title).toBe('A');

    binding.unsubscribe();
    for (const listener of listeners) {
      listener(ev({ eventId: 'e3', revision: 3, metadata: { conversationId: 'conv-x', title: 'B' } }));
    }
    expect(binding.eventCount).toBe(1);
    expect(getConversation(binding.stream.state, 'conv-x')?.title).toBe('A');
  });
});
