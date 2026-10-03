/**
 * F-R03 验收：断网 / 重连 / 应用被杀 / 返回栈 / 键盘 / 草稿恢复。
 *
 * 断言的是纯函数不变量 R1–R6（见 `types.ts` 顶部）。命令由**真实**的
 * `buildSendMessageCommand` 构造（F02 已交付），不是手搓的字面量——幂等键、
 * commandId 都由它确定性生成，本测试据此断言重发保键。
 */

import { describe, expect, it } from 'vitest';

import {
  createBootstrapRuntime,
  createManualClock,
  type CallerIdentity,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import { buildSendMessageCommand } from '../../../apps/mobile-ui/src/chat/index.js';
import {
  createKernelClient,
  createKernelClientFromBridge,
  type KernelStreamBreakReason,
  type KernelTransport,
  type KernelTransportBreakNotice,
} from '../../../apps/mobile-ui/src/platform/index.js';
import type { Command, Event } from '../../../contracts/mobile-v1/types.js';
import {
  MAX_NAV_DEPTH,
  MAX_SNAPSHOT_BYTES,
  ackCommand,
  addDraftAttachment,
  assertSnapshotGuard,
  background,
  beginDrain,
  clearDraft,
  closeKeyboard,
  coldStart,
  composerLayout,
  createSessionState,
  createViewport,
  deserializeSnapshot,
  dispatchCommand,
  drainThroughClient,
  emptyNavStack,
  emptyQueue,
  foreground,
  initialConnection,
  navEntry,
  openKeyboard,
  popEntry,
  pushEntry,
  queueLength,
  readSnapshotGuarded,
  reconnectDrain,
  recoverDraftFor,
  reduceConnection,
  replaceTop,
  serializeSnapshot,
  setConnection,
  setDraftText,
  setTopScroll,
  shouldDrain,
  snapshotGuardIssues,
  snapshotOf,
  submitCommand,
  topEntry,
  utf8ByteLength,
} from './resilience.js';
import { ResilienceError, type SessionState } from './types.js';

let seq = 0;
function cmd(conversationId: string, content: string): Command {
  seq += 1;
  return buildSendMessageCommand({
    conversationId,
    attemptMessageId: `asst-${seq}`,
    content,
    userMessageId: `user-${seq}`,
  });
}

describe('F-R03 / R1 离线不得伪完成', () => {
  it('online 提交直接投递，离线提交只入队', () => {
    const q0 = emptyQueue();
    const ok = dispatchCommand('online', q0, cmd('c1', '在线上'));
    expect(ok.disposition).toBe('sent');
    expect(queueLength(ok.queue)).toBe(0);

    const off = dispatchCommand('offline', q0, cmd('c1', '离线时'));
    expect(off.disposition).toBe('queued');
    expect(queueLength(off.queue)).toBe(1);
  });

  it('reconnecting 也不是 online，提交仍必须入队', () => {
    const r = dispatchCommand('reconnecting', emptyQueue(), cmd('c1', '重连中'));
    expect(r.disposition).toBe('queued');
    expect(queueLength(r.queue)).toBe(1);
  });

  it('无 resultRef 的 ack 抛 missing-receipt（fail-closed）', () => {
    const r = dispatchCommand('offline', emptyQueue(), cmd('c1', 'x'));
    expect(() => ackCommand(r.queue, r.commandId, { resultRef: '' })).toThrowError(ResilienceError);
    expect(queueLength(r.queue)).toBe(1); // 抛错后队列不动
  });
});

describe('F-R03 / R2 重连保序且保幂等键', () => {
  it('离线期间入队三条，drain 按入队序返回且逐条保留 idempotencyKey', () => {
    let q = emptyQueue();
    const built: Command[] = [cmd('c1', '一'), cmd('c1', '二'), cmd('c1', '三')];
    for (const c of built) {
      const r = dispatchCommand('offline', q, c);
      q = r.queue;
    }
    const drain = beginDrain(q);
    expect(drain.submitting.map((item) => item.command.payload)).toEqual(
      built.map((c) => c.payload),
    );
    expect(drain.submitting.map((item) => item.command.idempotencyKey)).toEqual(
      built.map((c) => c.idempotencyKey),
    );
    // 队列本体在 ack 之前保持不动（未完成）
    expect(queueLength(drain.queue)).toBe(3);
  });

  it('beginDrain 幂等：连续两次得到相同提交序与相同队列', () => {
    let q = emptyQueue();
    q = dispatchCommand('offline', q, cmd('c1', 'a')).queue;
    q = dispatchCommand('offline', q, cmd('c1', 'b')).queue;
    const d1 = beginDrain(q);
    const d2 = beginDrain(q);
    expect(d1.submitting).toEqual(d2.submitting);
    expect(d1.queue).toBe(d2.queue);
  });

  it('真实回执到位后逐条 ack 移除，且只移除目标条', () => {
    let q = emptyQueue();
    const a = cmd('c1', '甲');
    const b = cmd('c1', '乙');
    q = dispatchCommand('offline', q, a).queue;
    q = dispatchCommand('offline', q, b).queue;
    q = ackCommand(q, a.commandId, { resultRef: 'ref://event/1' });
    expect(queueLength(q)).toBe(1);
    expect(q.items[0]?.command.commandId).toBe(b.commandId);
    // 对不在队列里的 id ack 是幂等 no-op
    expect(ackCommand(q, a.commandId, { resultRef: 'ref://event/1' })).toBe(q);
  });
});

describe('F-R03 / R3 连接状态机与 drain 触发', () => {
  it('未知信号保持原态，不升级为 online', () => {
    expect(initialConnection()).toBe('online');
    expect(reduceConnection('offline', { type: 'networkLost' })).toBe('offline');
    expect(reduceConnection('offline', { type: 'reconnectSucceeded' })).toBe('online');
    expect(reduceConnection('reconnecting', { type: 'reconnectFailed' })).toBe('offline');
    expect(reduceConnection('offline', { type: 'networkRestored' })).toBe('reconnecting');
  });

  it('仅非 online → online 的跃迁才应 drain', () => {
    expect(shouldDrain('offline', 'online')).toBe(true);
    expect(shouldDrain('reconnecting', 'online')).toBe(true);
    expect(shouldDrain('online', 'online')).toBe(false);
    expect(shouldDrain('online', 'offline')).toBe(false);
  });

  it('重连失败：队列原样保留（一条不丢）', () => {
    let q = emptyQueue();
    q = dispatchCommand('offline', q, cmd('c1', 'p')).queue;
    q = dispatchCommand('offline', q, cmd('c1', 'q')).queue;
    const drain = beginDrain(q);
    // 模拟：drain 全部失败 → 未 ack → 队列仍有 2 条，顺序不变
    const afterFail = reduceConnection('reconnecting', { type: 'reconnectFailed' });
    expect(afterFail).toBe('offline');
    expect(queueLength(drain.queue)).toBe(2);
    expect(drain.queue.items.map((i) => i.command.commandId)).toEqual(
      q.items.map((i) => i.command.commandId),
    );
  });
});

describe('F-R03 / R4 应用被杀 → 冷启动恢复', () => {
  function sessionWithWork(): SessionState {
    const viewport = createViewport({ screenHeightPx: 2400, safeAreaBottomPx: 48 });
    let s = createSessionState(viewport);
    s = setDraftText(s, 'conv-a', '未发送的周报需求');
    s = addDraftAttachment(s, 'conv-a', { id: 'att-1', name: '周报.docx', uri: 'content://docs/1' });
    s = setDraftText(s, 'conv-b', '另一个会话的草稿');
    s = { ...s, nav: pushEntry(s.nav, navEntry('conversations', { filter: 'active' })) };
    s = { ...s, nav: pushEntry(s.nav, navEntry('chat', { id: 'conv-a' })) };
    s = { ...s, nav: setTopScroll(s.nav, { key: 'conv-a', offsetPx: 320 }) };
    return s;
  }

  it('前后台切换只改 phase，不碰草稿与返回栈', () => {
    const s = sessionWithWork();
    const bg = background(s);
    expect(bg.phase).toBe('backgrounded');
    expect(bg.drafts).toBe(s.drafts);
    expect(bg.nav).toBe(s.nav);
    expect(foreground(bg).phase).toBe('foreground');
  });

  it('序列化→反序列化后导航栈、滚动锚点、每会话草稿等价', () => {
    const s = sessionWithWork();
    const snap = snapshotOf(s);
    const restored = deserializeSnapshot(serializeSnapshot(snap));
    expect(restored).not.toBeNull();
    expect(restored?.nav).toEqual(s.nav);
    expect(restored?.drafts['conv-a']?.text).toBe('未发送的周报需求');
    expect(restored?.drafts['conv-a']?.attachments[0]?.uri).toBe('content://docs/1');
    expect(restored?.drafts['conv-b']?.text).toBe('另一个会话的草稿');
  });

  it('冷启动：键盘归零、连接重探、草稿与返回栈还原', () => {
    let s = sessionWithWork();
    s = { ...s, viewport: openKeyboard(s.viewport, 900) };
    s = setConnection(s, 'offline');
    const killed = deserializeSnapshot(serializeSnapshot(snapshotOf(s)));
    const fresh = coldStart(killed);
    expect(fresh.viewport.keyboardInsetPx).toBe(0); // IME 不再挂着
    expect(fresh.connection).toBe('online'); // 重新探测
    expect(fresh.phase).toBe('foreground');
    expect(queueLength(fresh.queue)).toBe(0); // 内存投递意图不持久化
    expect(topEntry(fresh.nav)?.route).toBe('chat');
    expect(recoverDraftFor(fresh, 'conv-a')?.text).toBe('未发送的周报需求');
  });

  it('损坏 / 版本不符的整个快照返回 null（冷启动走空态，不崩）', () => {
    expect(deserializeSnapshot(null)).toBeNull();
    expect(deserializeSnapshot('')).toBeNull();
    expect(deserializeSnapshot('{坏')).toBeNull();
    expect(deserializeSnapshot('{"v":2,"nav":{"entries":[]}}')).toBeNull();
    expect(coldStart(null).nav.entries).toEqual([]);
  });

  it('版本正确但局部损坏：只丢坏片段，好草稿仍在', () => {
    const raw = JSON.stringify({
      v: 1,
      nav: { entries: [null, { route: '' }, { route: 'chat', params: { id: 'conv-a' }, scroll: { key: 'conv-a', offsetPx: 10 } }, 42] },
      viewport: 'not-an-object',
      drafts: { drafts: [{ conversationId: 'conv-a', text: '幸存草稿', attachments: [] }, { text: '无会话 id 应丢' }] },
    });
    const restored = deserializeSnapshot(raw);
    expect(restored).not.toBeNull();
    expect(restored?.nav.entries.map((e) => e.route)).toEqual(['chat']);
    expect(restored?.nav.entries[0]?.scroll).toEqual({ key: 'conv-a', offsetPx: 10 });
    expect(restored?.drafts['conv-a']?.text).toBe('幸存草稿');
    expect(Object.keys(restored?.drafts ?? {})).toEqual(['conv-a']);
  });
});

describe('F-R03 / R5 键盘不吞草稿', () => {
  it('开 / 关键盘只改 inset，草稿正文与附件逐字段不变', () => {
    const viewport = createViewport({ screenHeightPx: 2000, safeAreaBottomPx: 40 });
    let s = createSessionState(viewport);
    s = setDraftText(s, 'conv-a', '键盘弹出前写的字');
    s = addDraftAttachment(s, 'conv-a', { id: 'a', name: 'n.txt' });
    const before = s.drafts;

    const opened = { ...s, viewport: openKeyboard(s.viewport, 800) };
    expect(opened.drafts).toBe(before); // 引用相等：根本没碰草稿
    const closed = { ...opened, viewport: closeKeyboard(opened.viewport) };
    expect(closed.drafts).toBe(before);
    expect(recoverDraftFor(closed, 'conv-a')?.text).toBe('键盘弹出前写的字');
    expect(recoverDraftFor(closed, 'conv-a')?.attachments).toHaveLength(1);
  });

  it('输入区底边 = 安全区 + 键盘 inset', () => {
    const viewport = createViewport({ screenHeightPx: 2000, safeAreaBottomPx: 40 });
    expect(composerLayout(viewport)).toEqual({
      placement: 'above-keyboard-fixed',
      bottomOffsetPx: 40,
      keyboardVisible: false,
    });
    expect(composerLayout(openKeyboard(viewport, 800))).toEqual({
      placement: 'above-keyboard-fixed',
      bottomOffsetPx: 840,
      keyboardVisible: true,
    });
  });

  it('非法 inset 抛 invalid-inset', () => {
    const viewport = createViewport({ screenHeightPx: 1000 });
    expect(() => openKeyboard(viewport, -1)).toThrowError(ResilienceError);
    expect(() => openKeyboard(viewport, 2000)).toThrowError(ResilienceError);
  });
});

describe('F-R03 / R6 返回栈安全带与滚动恢复', () => {
  const list = navEntry('conversations.list', { filter: 'active' }, { key: 'conv-a', offsetPx: 512 });
  const chat = navEntry('chat', { id: 'conv-a' });

  it('根节点 pop 是 no-op（不下溢）', () => {
    const single = pushEntry(emptyNavStack(), list);
    expect(popEntry(single)).toBe(single);
    expect(popEntry(emptyNavStack()).entries).toEqual([]);
  });

  it('返回时还原上一页保存的滚动位置', () => {
    let nav = pushEntry(emptyNavStack(), list);
    nav = pushEntry(nav, chat);
    expect(topEntry(nav)?.route).toBe('chat');
    const back = popEntry(nav);
    expect(topEntry(back)?.route).toBe('conversations.list');
    expect(topEntry(back)?.scroll).toEqual({ key: 'conv-a', offsetPx: 512 });
  });

  it('超过深度上限的 push 抛错且不静默截断', () => {
    let nav = emptyNavStack();
    for (let i = 0; i < MAX_NAV_DEPTH; i += 1) nav = pushEntry(nav, navEntry('page', { n: String(i) }));
    expect(nav.entries).toHaveLength(MAX_NAV_DEPTH);
    expect(() => pushEntry(nav, navEntry('overflow'))).toThrowError(ResilienceError);
    expect(nav.entries).toHaveLength(MAX_NAV_DEPTH);
  });

  it('空栈 replaceTop / setTopScroll 抛 empty-nav-stack', () => {
    expect(() => replaceTop(emptyNavStack(), list)).toThrowError(ResilienceError);
    expect(() => setTopScroll(emptyNavStack(), { key: 'k', offsetPx: 0 })).toThrowError(ResilienceError);
  });

  it('返回栈整体跨进程死亡还原（含每页滚动锚点）', () => {
    let s = createSessionState(createViewport({ screenHeightPx: 2400 }));
    s = { ...s, nav: pushEntry(s.nav, list) };
    s = { ...s, nav: pushEntry(s.nav, chat) };
    const restored = coldStart(deserializeSnapshot(serializeSnapshot(snapshotOf(s))));
    expect(restored.nav.entries).toEqual(s.nav.entries);
    const back = popEntry(restored.nav);
    expect(topEntry(back)?.scroll).toEqual({ key: 'conv-a', offsetPx: 512 });
  });
});

describe('F-R03 / 端到端恢复链', () => {
  it('在线发送→掉线入队→被杀→冷启动→重连 drain 保序保键', () => {
    let s = createSessionState(createViewport({ screenHeightPx: 2400, safeAreaBottomPx: 40 }));
    // 在线一条：直接投递
    const online = submitCommand(s, cmd('conv-a', '在线发送'));
    s = online.state;
    expect(online.disposition).toBe('sent');

    // 掉线
    const offline = reduceConnection(s.connection, { type: 'networkLost' });
    s = setConnection(s, offline);
    // 离线两条：入队
    const q1 = submitCommand(s, cmd('conv-a', '离线 1'));
    const q2 = submitCommand(q1.state, cmd('conv-a', '离线 2'));
    s = q2.state;
    expect(q1.disposition).toBe('queued');
    expect(q2.disposition).toBe('queued');
    const keys = s.queue.items.map((i) => i.command.idempotencyKey);

    // 进程被杀 → 冷启动
    const fresh = coldStart(deserializeSnapshot(serializeSnapshot(snapshotOf(s))));
    expect(fresh.connection).toBe('online'); // 重探
    expect(queueLength(fresh.queue)).toBe(0); // 队列不持久化

    // 重连 drain（用掉线期间的队列做保序保键断言）
    const drained = beginDrain(s.queue);
    expect(drained.submitting.map((i) => i.command.idempotencyKey)).toEqual(keys);
    // 逐条真实回执
    let q = drained.queue;
    for (const item of drained.submitting) {
      q = ackCommand(q, item.command.commandId, { resultRef: `ref://${item.command.commandId}` });
    }
    expect(queueLength(q)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 集成：经**真实** KernelClient（F-I01）+ 真实 LocalUiBridge + 真实运行时 drain
// ---------------------------------------------------------------------------

const UI_CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview', packageName: 'com.potbot.demo' };
const ALLOWED_ORIGINS = ['app://local', 'file:///android_asset', 'https://localhost'] as const;

interface Dispatched {
  readonly commandId: string;
  readonly idempotencyKey: string;
}

/** 真实运行时（认领 create，返回带 resultRef 的成功终局）+ 真实桥 + 真实 KernelClient。 */
function realBridge(): {
  bundle: ReturnType<typeof createKernelClientFromBridge>;
  dispatched: Dispatched[];
} {
  const dispatched: Dispatched[] = [];
  const runtime = createBootstrapRuntime({ clock: createManualClock() });
  runtime.registerModule({
    id: 'chat-fixture',
    operations: ['create'],
    handle: async (command) => {
      dispatched.push({ commandId: command.commandId, idempotencyKey: command.idempotencyKey });
      return { status: 'succeeded', resultRef: `artifact:msg:${command.commandId}@1` };
    },
  });
  const bundle = createKernelClientFromBridge({
    runtime,
    caller: UI_CALLER,
    allowedOrigins: ALLOWED_ORIGINS,
    allowedKinds: ['ui-webview'],
  });
  bundle.start();
  return { bundle, dispatched };
}

/** 掉线后把命令入队，得到一个 offline 会话。 */
function offlineStateWith(commands: readonly Command[]): SessionState {
  let s = createSessionState(createViewport({ screenHeightPx: 2400, safeAreaBottomPx: 40 }));
  s = setConnection(s, reduceConnection(s.connection, { type: 'networkLost' })); // → offline
  for (const c of commands) s = submitCommand(s, c).state;
  return s;
}

// ---------------------------------------------------------------------------
// 确定性脚本传输（精确控制第 N 条之后断流），用于「部分 ack」负例。
// ---------------------------------------------------------------------------

interface PlanStep {
  readonly status: 'succeeded' | 'failed';
  readonly reject?: boolean;
  /** 本次提交解析出终局**之后**，宿主注入 `transport-closed` 断流（模拟桥恰在此刻掉）。 */
  readonly breakAfter?: boolean;
}

function planTransport(steps: readonly PlanStep[]): {
  transport: KernelTransport;
  submitted: string[];
  emitBreak(reason: KernelStreamBreakReason, detail?: string): void;
} {
  const listeners = new Set<(event: Event) => void>();
  const breakListeners = new Set<(notice: KernelTransportBreakNotice) => void>();
  let seq = 0;
  let index = 0;
  const submitted: string[] = [];
  const transport: KernelTransport = {
    submit(command: unknown): Promise<Event> {
      const cmd = command as Command;
      const step = steps[index] ?? { status: 'succeeded' as const };
      index += 1;
      submitted.push(cmd.commandId);
      if (step.reject === true) {
        return Promise.reject(new Error('bridge channel dropped mid-drain'));
      }
      seq += 1;
      const event: Event = {
        eventId: `evt-${seq}`,
        seq,
        commandId: cmd.commandId,
        revision: 0,
        status: step.status,
        verificationMode: 'fixture',
        ...(step.status === 'succeeded' ? { resultRef: `ref://${cmd.commandId}` } : {}),
      };
      for (const listener of [...listeners]) listener(event);
      if (step.breakAfter === true) {
        for (const listener of [...breakListeners]) listener({ reason: 'transport-closed', detail: 'WebView 已卸载' });
      }
      return Promise.resolve(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    cancel() {
      return false;
    },
    onBreak(listener) {
      breakListeners.add(listener);
      return { unsubscribe: () => breakListeners.delete(listener) };
    },
  };
  return {
    transport,
    submitted,
    emitBreak(reason, detail = '') {
      for (const listener of [...breakListeners]) listener({ reason, detail });
    },
  };
}

describe('F-R03 / 端到端恢复链 · 经真实 KernelClient（F-I01）drain', () => {
  it('离线入队 → 被杀冷启动 → 重连 drain 经真实桥逐条投递、保序保键、ack 归零', async () => {
    const { bundle, dispatched } = realBridge();
    let s = createSessionState(createViewport({ screenHeightPx: 2400, safeAreaBottomPx: 40 }));
    s = setDraftText(s, 'conv-a', '离线期间写的草稿');
    s = setConnection(s, reduceConnection(s.connection, { type: 'networkLost' }));
    expect(s.connection).toBe('offline');

    const c1 = cmd('conv-a', '离线一');
    const c2 = cmd('conv-a', '离线二');
    const c3 = cmd('conv-a', '离线三');
    s = submitCommand(s, c1).state;
    s = submitCommand(s, c2).state;
    s = submitCommand(s, c3).state;
    expect(queueLength(s.queue)).toBe(3);
    const queuedIds = s.queue.items.map((i) => i.command.commandId);
    const queuedKeys = s.queue.items.map((i) => i.command.idempotencyKey);

    // 进程被杀：快照持久化 → 冷启动（队列不持久化，草稿还原）
    const persisted = serializeSnapshot(snapshotOf(s));
    const fresh = coldStart(deserializeSnapshot(persisted));
    expect(fresh.connection).toBe('online');
    expect(queueLength(fresh.queue)).toBe(0);
    expect(recoverDraftFor(fresh, 'conv-a')?.text).toBe('离线期间写的草稿');

    // 重连：经真实 KernelClient 桥 drain 掉线期间的队列
    const outcome = await drainThroughClient(bundle.client, s.queue);
    expect(outcome.stopReason).toBe('complete');
    expect(outcome.acked).toEqual(queuedIds);
    expect(outcome.receipts.map((r) => r.resultRef)).toEqual(queuedIds.map((id) => `artifact:msg:${id}@1`));
    expect(queueLength(outcome.queue)).toBe(0);
    // 内核**确实**收到这 3 条：顺序与幂等键逐条一致（R2 在真桥路径上成立）
    expect(dispatched.map((d) => d.commandId)).toEqual(queuedIds);
    expect(dispatched.map((d) => d.idempotencyKey)).toEqual(queuedKeys);
    bundle.stop();
  });

  it('重发同一幂等键：内核幂等去重（idempotentReplay），处理器不重复副作用', async () => {
    const { bundle, dispatched } = realBridge();
    const c1 = cmd('conv-a', '只应执行一次');
    const s = offlineStateWith([c1]);
    const first = await drainThroughClient(bundle.client, s.queue);
    expect(first.stopReason).toBe('complete');
    expect(dispatched).toHaveLength(1);

    // 模拟崩溃后重放同一条（同幂等键、同 commandId）：内核返回原事件并标 idempotentReplay。
    const replay = await bundle.client.sendCommand(c1);
    expect(replay.idempotentReplay).toBe(true);
    expect(dispatched).toHaveLength(1); // 处理器**未**再被调用
    bundle.stop();
  });

  it('reconnectDrain 只在非 online→online 跃迁时经桥投递；已在 online 收恢复信号不重复投递', async () => {
    const { bundle, dispatched } = realBridge();
    const s = offlineStateWith([cmd('conv-a', '重连投递一'), cmd('conv-a', '重连投递二')]);
    expect(s.connection).toBe('offline');

    const first = await reconnectDrain(s, bundle.client, { type: 'reconnectSucceeded' });
    expect(first.drained).toBe(true);
    expect(first.stopReason).toBe('complete');
    expect(first.state.connection).toBe('online');
    expect(queueLength(first.state.queue)).toBe(0);
    expect(dispatched).toHaveLength(2);

    const second = await reconnectDrain(first.state, bundle.client, { type: 'networkRestored' });
    expect(second.drained).toBe(false);
    expect(second.stopReason).toBe('not-online');
    expect(dispatched).toHaveLength(2); // 未新增投递
    bundle.stop();
  });
});

describe('F-R03 / R2-R3 负例：drain 中途断流（部分 ack 保序）', () => {
  it('部分 ack 后提交被拒：已 ack 的移除，未 ack 的按原序整条保留', async () => {
    const s = planTransport([
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'succeeded', reject: true },
    ]);
    const client = createKernelClient({ transport: s.transport, caller: UI_CALLER });
    const cs = [cmd('c1', '一'), cmd('c1', '二'), cmd('c1', '三')];
    let q = emptyQueue();
    for (const c of cs) q = dispatchCommand('offline', q, c).queue;

    const outcome = await drainThroughClient(client, q);
    expect(outcome.acked).toEqual([cs[0]!.commandId, cs[1]!.commandId]);
    expect(outcome.stopReason).toBe('submit-rejected');
    expect(queueLength(outcome.queue)).toBe(1);
    expect(outcome.queue.items[0]?.command.commandId).toBe(cs[2]!.commandId);
    expect(outcome.queue.items[0]?.command.idempotencyKey).toBe(cs[2]!.idempotencyKey);
    expect(outcome.queue.items[0]?.seq).toBe(2);
    // 未 ack 的第三条不得被当成完成（R1）
    expect(outcome.acked).not.toContain(cs[2]!.commandId);
  });

  it('部分 ack 后桥通道断开（client closed）：剩余按原序保留，且不再投递', async () => {
    const s = planTransport([
      { status: 'succeeded' },
      { status: 'succeeded', breakAfter: true },
      { status: 'succeeded' },
    ]);
    const client = createKernelClient({ transport: s.transport, caller: UI_CALLER });
    const cs = [cmd('c1', '甲'), cmd('c1', '乙'), cmd('c1', '丙')];
    let q = emptyQueue();
    for (const c of cs) q = dispatchCommand('offline', q, c).queue;

    const outcome = await drainThroughClient(client, q);
    expect(outcome.acked).toEqual([cs[0]!.commandId, cs[1]!.commandId]);
    expect(outcome.stopReason).toBe('client-closed');
    expect(client.state).toBe('closed');
    expect(outcome.queue.items.map((i) => i.command.commandId)).toEqual([cs[2]!.commandId]);
    expect(s.submitted).toEqual([cs[0]!.commandId, cs[1]!.commandId]); // 第三条未投递
  });

  it('非 succeeded 回执不得 ack（fail-closed）：该条及其后全部保留', async () => {
    const s = planTransport([
      { status: 'succeeded' },
      { status: 'failed' },
      { status: 'succeeded' },
    ]);
    const client = createKernelClient({ transport: s.transport, caller: UI_CALLER });
    const cs = [cmd('c1', 'p'), cmd('c1', 'q'), cmd('c1', 'r')];
    let q = emptyQueue();
    for (const c of cs) q = dispatchCommand('offline', q, c).queue;

    const outcome = await drainThroughClient(client, q);
    expect(outcome.acked).toEqual([cs[0]!.commandId]);
    expect(outcome.stopReason).toBe('not-succeeded');
    expect(outcome.queue.items.map((i) => i.command.commandId)).toEqual([cs[1]!.commandId, cs[2]!.commandId]);
    expect(s.submitted).toEqual([cs[0]!.commandId, cs[1]!.commandId]);
  });
});

describe('F-R03 / R4 负例：快照体量 / 重复会话守卫', () => {
  it('utf8ByteLength 按 UTF-8 计字节（多字节字符）', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('a中😀')).toBe(8);
  });

  it('体量超过上限：守卫拒绝，不返回可恢复快照', () => {
    const viewport = createViewport({ screenHeightPx: 2000, safeAreaBottomPx: 40 });
    let s = createSessionState(viewport);
    s = setDraftText(s, 'conv-a', 'x'.repeat(MAX_SNAPSHOT_BYTES));
    const raw = serializeSnapshot(snapshotOf(s));
    expect(utf8ByteLength(raw)).toBeGreaterThan(MAX_SNAPSHOT_BYTES);

    expect(snapshotGuardIssues(raw).map((i) => i.code)).toContain('snapshot-too-large');
    const verdict = readSnapshotGuarded(raw);
    expect(verdict.ok).toBe(false);
    expect(verdict.snapshot).toBeNull();
    expect(() => assertSnapshotGuard(raw)).toThrowError(ResilienceError);
  });

  it('体量守卫可配置：小上限即可触发（不必造巨型字符串）', () => {
    const raw = serializeSnapshot(snapshotOf(createSessionState(createViewport({ screenHeightPx: 1000 }))));
    const issues = snapshotGuardIssues(raw, { maxBytes: 8 });
    expect(issues.map((i) => i.code)).toEqual(['snapshot-too-large']);
  });

  it('重复会话草稿：容错反序列化会静默 last-wins，守卫 fail-closed 拒绝', () => {
    const raw = JSON.stringify({
      v: 1,
      nav: { entries: [] },
      viewport: { keyboardInsetPx: 0, safeAreaBottomPx: 0, screenHeightPx: 1000, inputPlacement: 'above-keyboard-fixed' },
      drafts: {
        v: 1,
        drafts: [
          { v: 1, conversationId: 'conv-a', text: '第一份草稿', attachments: [] },
          { v: 1, conversationId: 'conv-a', text: '第二份草稿', attachments: [] },
        ],
      },
    });
    // 危害演示：容错路径 last-wins，第一份被悄悄丢掉。
    expect(deserializeSnapshot(raw)?.drafts['conv-a']?.text).toBe('第二份草稿');
    // 守卫：拒绝恢复。
    expect(snapshotGuardIssues(raw).map((i) => i.code)).toContain('duplicate-conversation');
    const verdict = readSnapshotGuarded(raw);
    expect(verdict.ok).toBe(false);
    expect(verdict.snapshot).toBeNull();
    expect(() => assertSnapshotGuard(raw)).toThrowError(ResilienceError);
  });

  it('草稿条数超过上限：too-many-drafts 拒绝', () => {
    const drafts = Array.from({ length: 5 }, (_, i) => ({
      v: 1,
      conversationId: `conv-${i}`,
      text: 't',
      attachments: [],
    }));
    const raw = JSON.stringify({
      v: 1,
      nav: { entries: [] },
      viewport: { keyboardInsetPx: 0, safeAreaBottomPx: 0, screenHeightPx: 1000, inputPlacement: 'above-keyboard-fixed' },
      drafts: { v: 1, drafts },
    });
    expect(snapshotGuardIssues(raw, { maxDrafts: 3 }).map((i) => i.code)).toContain('too-many-drafts');
  });

  it('干净快照通过守卫并恢复（与容错反序列化等价）', () => {
    const viewport = createViewport({ screenHeightPx: 2400, safeAreaBottomPx: 40 });
    let s = createSessionState(viewport);
    s = setDraftText(s, 'conv-a', '干净的草稿');
    s = { ...s, nav: pushEntry(s.nav, navEntry('chat', { id: 'conv-a' })) };
    const raw = serializeSnapshot(snapshotOf(s));

    expect(snapshotGuardIssues(raw)).toEqual([]);
    const verdict = readSnapshotGuarded(raw);
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.snapshot?.drafts['conv-a']?.text).toBe('干净的草稿');
    expect(verdict.snapshot).toEqual(deserializeSnapshot(raw));
  });

  it('被守卫判负的字节 → snapshot 为 null → coldStart 走空态，不崩', () => {
    const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES);
    const raw = JSON.stringify({
      v: 1,
      nav: { entries: [] },
      viewport: { keyboardInsetPx: 0, safeAreaBottomPx: 0, screenHeightPx: 1000, inputPlacement: 'above-keyboard-fixed' },
      drafts: { v: 1, drafts: [{ v: 1, conversationId: 'conv-a', text: huge, attachments: [] }] },
    });
    const verdict = readSnapshotGuarded(raw);
    expect(verdict.ok).toBe(false);
    const state = coldStart(verdict.snapshot);
    expect(state.nav.entries).toEqual([]);
    expect(queueLength(state.queue)).toBe(0);
  });
});
