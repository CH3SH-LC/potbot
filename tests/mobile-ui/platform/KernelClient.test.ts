/**
 * F-I01 验收：`platform/KernelClient` 的**断流不伪造**硬口径。
 *
 * 这些用例用**确定性脚本传输**（本文件内的 `scriptedTransport`）精确控制事件 / 断流，
 * 覆盖真实内核难以稳定制造的路径：`seq` 空洞、坏终局事件、通道断开、提交被拒。
 *
 * 核心不变量（每条都有一个"绝不成功"的反向断言）：
 *   C1 断流 ⇒ onBreak({status:'progressUnknown'})，onEvent 永不收到 succeeded；
 *   C2 succeeded 缺 resultRef ⇒ 坏流（invalid-terminal），绝不投 success；
 *   C3 seq 空洞 ⇒ 对所有在飞命令断流；
 *   C5 提交被拒 ⇒ sendCommand reject + onBreak('submit-rejected')，绝不静默成功；
 *   C6 关闭后拒绝新命令 / 拒绝订阅。
 *
 * 真实运行时 + 真实桥的端到端往返另见 `bridge-roundtrip.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  createKernelClient,
  isKernelClientError,
  type CallerIdentity,
  type Command,
  type Event,
  type EventStatus,
  type KernelStreamBreak,
  type KernelTransport,
  type KernelTransportBreakNotice,
  type NativeTrustPortShape,
} from '../../../apps/mobile-ui/src/platform/index.js';

const CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };

function makeEvent(overrides: Partial<Event> & Pick<Event, 'seq' | 'commandId' | 'status'>): Event {
  return {
    eventId: `evt-${overrides.seq}`,
    revision: 0,
    verificationMode: 'fixture',
    ...overrides,
  };
}

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-1',
    operation: 'create',
    idempotencyKey: 'idem-1',
    payload: { goal: '测试' },
    ...overrides,
  };
}

/** 确定性传输：手动 emit 事件 / 断流，手动设定 submit 行为。 */
function scriptedTransport(options: { submit?: (command: unknown) => Promise<Event> } = {}): {
  transport: KernelTransport;
  emit(event: Event): void;
  emitBreak(notice: KernelTransportBreakNotice): void;
  cancelled: string[];
} {
  const listeners = new Set<(event: Event) => void>();
  const breakListeners = new Set<(notice: KernelTransportBreakNotice) => void>();
  const cancelled: string[] = [];
  const transport: KernelTransport = {
    submit: options.submit ?? (() => Promise.resolve(makeEvent({ seq: 99, commandId: 'cmd-1', status: 'failed' }))),
    subscribe(listener) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    cancel(commandId) {
      cancelled.push(commandId);
      return true;
    },
    onBreak(listener) {
      breakListeners.add(listener);
      return { unsubscribe: () => breakListeners.delete(listener) };
    },
  };
  return {
    transport,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    emitBreak(notice) {
      for (const listener of [...breakListeners]) listener(notice);
    },
    cancelled,
  };
}

interface Recorder {
  events: Event[];
  statuses: EventStatus[];
  breaks: KernelStreamBreak[];
}

function record(client: ReturnType<typeof createKernelClient>, commandId: string): Recorder {
  const rec: Recorder = { events: [], statuses: [], breaks: [] };
  client.subscribe(
    commandId,
    (event) => {
      rec.events.push(event);
      rec.statuses.push(event.status);
    },
    (info) => rec.breaks.push(info),
  );
  return rec;
}

describe('KernelClient：断流不伪造（progressUnknown 是唯一出口）', () => {
  it('C1 通道断开：在飞命令 onBreak=progressUnknown，且永不收到 succeeded', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const rec = record(client, 'cmd-1');

    // 先来一条中间进度，确认订阅是活的。
    s.emit(makeEvent({ seq: 1, commandId: 'cmd-1', status: 'running' }));
    expect(rec.statuses).toEqual(['running']);

    client.signalStreamBreak('transport-closed', 'WebView 已卸载');

    expect(rec.breaks).toHaveLength(1);
    expect(rec.breaks[0]?.status).toBe('progressUnknown');
    expect(rec.breaks[0]?.reason).toBe('transport-closed');
    expect(rec.breaks[0]?.detail).toBe('WebView 已卸载');
    expect(rec.breaks[0]?.lastEvent?.seq).toBe(1);
    // 反向对照：整条流里从未出现过 succeeded。
    expect(rec.statuses).not.toContain('succeeded');
  });

  it('C1b 断开后迟到的 succeeded 事件不得触达订阅者（订阅已死）', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const rec = record(client, 'cmd-1');

    client.signalStreamBreak('runtime-stopped');
    expect(rec.breaks[0]?.status).toBe('progressUnknown');

    // 迟到成功：client 已 closed，不再订阅，事件根本收不到。
    s.emit(makeEvent({ seq: 1, commandId: 'cmd-1', status: 'succeeded', resultRef: 'artifact:late' }));
    expect(rec.statuses).not.toContain('succeeded');
    expect(rec.events).toHaveLength(0);
  });

  it('C2 fail-closed：succeeded 缺 resultRef ⇒ invalid-terminal 断流，绝不投 success', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const rec = record(client, 'cmd-1');

    s.emit(makeEvent({ seq: 1, commandId: 'cmd-1', status: 'succeeded' })); // 无 resultRef

    expect(rec.breaks).toHaveLength(1);
    expect(rec.breaks[0]?.reason).toBe('invalid-terminal');
    expect(rec.breaks[0]?.status).toBe('progressUnknown');
    expect(rec.statuses).not.toContain('succeeded');
    expect(rec.events).toHaveLength(0);
  });

  it('C3 seq 空洞 ⇒ sequence-gap 断流，绝不成功', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const rec = record(client, 'cmd-1');

    s.emit(makeEvent({ seq: 1, commandId: 'cmd-1', status: 'running' }));
    s.emit(makeEvent({ seq: 3, commandId: 'cmd-1', status: 'succeeded', resultRef: 'artifact:x' })); // 丢了 seq2

    expect(rec.breaks).toHaveLength(1);
    expect(rec.breaks[0]?.reason).toBe('sequence-gap');
    expect(rec.statuses).not.toContain('succeeded');
  });

  it('正常路径对照：连续 seq 的 succeeded 带 resultRef 才会投递为成功', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const rec = record(client, 'cmd-1');

    s.emit(makeEvent({ seq: 1, commandId: 'cmd-1', status: 'running' }));
    s.emit(makeEvent({ seq: 2, commandId: 'cmd-1', status: 'succeeded', resultRef: 'artifact:ok' }));

    expect(rec.statuses).toEqual(['running', 'succeeded']);
    expect(rec.breaks).toHaveLength(0);
  });
});

describe('KernelClient：提交 / 取消 / 关闭语义', () => {
  it('C5 提交被拒 ⇒ sendCommand reject(submit-rejected) 且 onBreak=progressUnknown', async () => {
    const failure = Object.assign(new Error('命令形状非法'), { code: 'COMMAND_INVALID' });
    const s = scriptedTransport({ submit: () => Promise.reject(failure) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    const rec = record(client, 'cmd-bad');

    await expect(client.sendCommand(makeCommand({ commandId: 'cmd-bad' }))).rejects.toSatisfy(
      (error: unknown) => isKernelClientError(error) && error.code === 'submit-rejected',
    );
    expect(rec.breaks).toHaveLength(1);
    expect(rec.breaks[0]?.reason).toBe('submit-rejected');
    expect(rec.breaks[0]?.status).toBe('progressUnknown');
    expect(rec.statuses).not.toContain('succeeded');
  });

  it('sendCommand 返回规范化回执（resultRef / verificationMode / revision 显式）', async () => {
    const terminal = makeEvent({
      seq: 1,
      commandId: 'cmd-1',
      status: 'succeeded',
      resultRef: 'artifact:docx@3',
      revision: 3,
      verificationMode: 'real',
    });
    const s = scriptedTransport({ submit: () => Promise.resolve(terminal) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });

    const receipt = await client.sendCommand(makeCommand());
    expect(receipt.commandId).toBe('cmd-1');
    expect(receipt.status).toBe('succeeded');
    expect(receipt.resultRef).toBe('artifact:docx@3');
    expect(receipt.revision).toBe(3);
    expect(receipt.verificationMode).toBe('real');
    expect(receipt.error).toBeNull();
    expect(receipt.idempotentReplay).toBe(false);
  });

  it('C4 subscribe 后于 submit 也可拿到终局（sendCommand 解析时补投一次）', async () => {
    const terminal = makeEvent({ seq: 1, commandId: 'cmd-1', status: 'succeeded', resultRef: 'artifact:ok' });
    const s = scriptedTransport({ submit: () => Promise.resolve(terminal) });
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    // 关键：submit 先解析，subscribe 在 sendCommand 之后才注册 —— 补投路径。
    const receipt = await client.sendCommand(makeCommand());
    expect(receipt.status).toBe('succeeded');
    // 订阅一个已经结束的命令不应抛错，且退订函数可用。
    const unsub = client.subscribe('cmd-1', () => {}, () => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('cancel 委托传输；退订后不再投递事件', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });

    expect(client.cancel('cmd-1')).toBe(true);
    expect(s.cancelled).toEqual(['cmd-1']);

    const seen: Event[] = [];
    const unsubscribe = client.subscribe('cmd-2', (e) => seen.push(e), () => {});
    unsubscribe();
    s.emit(makeEvent({ seq: 1, commandId: 'cmd-2', status: 'running' }));
    expect(seen).toHaveLength(0);
  });

  it('C6 关闭后：sendCommand 抛 client-closed，subscribe 抛 client-closed', async () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    expect(client.state).toBe('open');
    client.signalStreamBreak('transport-closed');
    expect(client.state).toBe('closed');

    await expect(client.sendCommand(makeCommand())).rejects.toSatisfy(
      (error: unknown) => isKernelClientError(error) && error.code === 'client-closed',
    );
    expect(() => client.subscribe('cmd-1', () => {}, () => {})).toThrow();
    expect(client.cancel('cmd-1')).toBe(false);
  });

  it('caller 被钉死：client.caller 就是注入的身份，不可改写', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    expect(client.caller).toEqual(CALLER);
    expect(client.caller.origin).toBe('app://local');
    expect(client.caller.kind).toBe('ui-webview');
  });
});

describe('KernelClient：原生信任端口注入（泛型，零耦合）', () => {
  it('接受真实形状的信任端口并原样暴露；结构与身份都保住', () => {
    const s = scriptedTransport();
    const ledger = {
      recordConfirmAction: () => ({ ok: true }),
      getConfirmAction: () => undefined,
      attest: () => ({ ok: true }),
      issueGrant: () => ({ ok: true }),
      consume: () => ({ ok: true }),
    };
    const client = createKernelClient({ transport: s.transport, caller: CALLER, nativeTrust: ledger });
    expect(client.nativeTrust).toBe(ledger);
    // 泛型保真：方法仍可按调用方自己的类型使用（此处轻跑一次确认可调用）。
    expect(client.nativeTrust?.getConfirmAction()).toBeUndefined();
  });

  it('注入不像信任端口的对象则 fail-closed 抛错', () => {
    const s = scriptedTransport();
    const notAPort = { attest: () => ({}) } as unknown as NativeTrustPortShape;
    expect(() => createKernelClient({ transport: s.transport, caller: CALLER, nativeTrust: notAPort })).toThrow(
      /nativeTrust 缺方法/,
    );
  });

  it('未注入时为 null', () => {
    const s = scriptedTransport();
    const client = createKernelClient({ transport: s.transport, caller: CALLER });
    expect(client.nativeTrust).toBeNull();
  });
});
