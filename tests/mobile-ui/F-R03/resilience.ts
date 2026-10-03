/**
 * F-R03 —— 断网 / 重连 / 应用被杀 / 返回栈 / 键盘 / 草稿恢复的纯函数实现。
 *
 * 零依赖（只 import 已交付的纯 TS 实现与契约类型，不改动它们）；不读真实网络、
 * 不读时钟、不读随机数、不写磁盘。所有函数是纯函数：同输入同输出。
 *
 * 恢复链（`resilience.test.ts` 逐步断言）：
 *   前台发消息（online） → 掉线（networkLost） → 提交进离线队列（queued，非完成）
 *   → 进程被杀（snapshot） → 冷启动（coldStart，键盘收起、连接重探、草稿与返回栈还原）
 *   → 重连成功（online） → drain 保序保幂等键 → 真实回执逐条 ack。
 */

import type { Command } from '../../../contracts/mobile-v1/types.js';
import {
  createAttachmentPlaceholder,
  deserializeDraftStore,
  emptyDraft,
  getDraft,
  normalizeDraft,
  putDraft,
  recoverDraft,
  removeDraft,
  serializeDraftStore,
  type AttachmentInput,
  type ChatDraft,
  type DraftStore,
} from '../../../apps/mobile-ui/src/chat/index.js';
import {
  ResilienceError,
  type AppPhase,
  type ComposerLayout,
  type ConnectionState,
  type DispatchDisposition,
  type DispatchResult,
  type DrainResult,
  type KeyboardViewport,
  type NavEntry,
  type NavStack,
  type NetworkSignal,
  type OfflineQueue,
  type QueuedCommand,
  type ScrollAnchor,
  type SessionState,
  type UiSnapshot,
} from './types.js';

/** 返回栈深度上限；超过即拒绝 push（不静默截断，见 R6）。 */
export const MAX_NAV_DEPTH = 16;

// ===========================================================================
// 1. 连接状态机 + 离线队列
// ===========================================================================

export function initialConnection(): ConnectionState {
  return 'online';
}

/**
 * 连接迁移。未知组合一律**保持原态**（不猜、不升级为 online）。
 *
 *   online       + networkLost        → offline
 *   offline      + networkRestored    → reconnecting
 *   offline      + reconnectStarted   → reconnecting
 *   reconnecting + reconnectSucceeded → online
 *   reconnecting + reconnectFailed    → offline
 *   reconnecting + networkLost        → offline
 *   其余（含已 online 再 reconnectSucceeded）→ 原态
 */
export function reduceConnection(state: ConnectionState, signal: NetworkSignal): ConnectionState {
  switch (signal.type) {
    case 'networkLost':
      return 'offline';
    case 'networkRestored':
      return state === 'online' ? 'online' : 'reconnecting';
    case 'reconnectStarted':
      return state === 'online' ? 'online' : 'reconnecting';
    case 'reconnectSucceeded':
      return 'online';
    case 'reconnectFailed':
      return 'offline';
    default:
      return state;
  }
}

/** 是否发生了「非 online → online」的跃迁（此时才应发起 drain）。 */
export function shouldDrain(previous: ConnectionState, next: ConnectionState): boolean {
  return previous !== 'online' && next === 'online';
}

export function emptyQueue(): OfflineQueue {
  return { items: [], nextSeq: 0 };
}

/**
 * 提交命令。**只有** `online` 才直接投递（disposition `sent`）；否则入队。
 * 离线入队**不**是完成——调用方不得据 `queued` 渲染成功态（R1）。
 */
export function dispatchCommand(
  connection: ConnectionState,
  queue: OfflineQueue,
  command: Command,
): DispatchResult {
  if (connection === 'online') {
    return { connection, queue, disposition: 'sent', commandId: command.commandId };
  }
  const item: QueuedCommand = { seq: queue.nextSeq, command };
  return {
    connection,
    queue: { items: [...queue.items, item], nextSeq: queue.nextSeq + 1 },
    disposition: 'queued',
    commandId: command.commandId,
  };
}

/** 队列长度。 */
export function queueLength(queue: OfflineQueue): number {
  return queue.items.length;
}

/**
 * 开始 drain：按**入队序**返回待提交命令；队列本体**保持不变**，
 * 直到每条命令拿到真实回执再 ack 移除（R2 保序、R3 失败不丢）。
 *
 * 幂等：连续调用两次得到逐字节相同的提交序与不变的队列。
 */
export function beginDrain(queue: OfflineQueue): DrainResult {
  const submitting = [...queue.items].sort((a, b) => a.seq - b.seq);
  return { queue, submitting };
}

/**
 * 收到真实回执后把单条命令移出队列。
 *
 * fail-closed：`receipt.resultRef` 必须是非空字符串；缺失即抛 `missing-receipt`，
 * 绝不「无凭证也算完成」（R1）。幂等：命令不在队列时返回原队列。
 */
export function ackCommand(
  queue: OfflineQueue,
  commandId: string,
  receipt: { readonly resultRef: string },
): OfflineQueue {
  if (typeof receipt.resultRef !== 'string' || receipt.resultRef.length === 0) {
    throw new ResilienceError('missing-receipt', 'ack 必须携带真实 resultRef，缺失不得视为完成', {
      commandId,
    });
  }
  const next = queue.items.filter((item) => item.command.commandId !== commandId);
  if (next.length === queue.items.length) return queue;
  return { items: next, nextSeq: queue.nextSeq };
}

// ===========================================================================
// 2. 键盘 / 视口
// ===========================================================================

export function createViewport(input: {
  readonly screenHeightPx: number;
  readonly safeAreaBottomPx?: number;
}): KeyboardViewport {
  return {
    keyboardInsetPx: 0,
    safeAreaBottomPx: input.safeAreaBottomPx ?? 0,
    screenHeightPx: input.screenHeightPx,
    inputPlacement: 'above-keyboard-fixed',
  };
}

function assertInset(insetPx: number, screenHeightPx: number): void {
  if (!Number.isInteger(insetPx) || insetPx < 0) {
    throw new ResilienceError('invalid-inset', '键盘 inset 必须是 >= 0 的整数像素', { insetPx });
  }
  if (insetPx > screenHeightPx) {
    throw new ResilienceError('invalid-inset', '键盘 inset 不得超过屏幕高度', {
      insetPx,
      screenHeightPx,
    });
  }
}

/** 键盘弹出：只改 inset。不改草稿、不改返回栈（R5）。 */
export function openKeyboard(viewport: KeyboardViewport, insetPx: number): KeyboardViewport {
  assertInset(insetPx, viewport.screenHeightPx);
  return { ...viewport, keyboardInsetPx: insetPx };
}

/** 键盘收起。 */
export function closeKeyboard(viewport: KeyboardViewport): KeyboardViewport {
  return { ...viewport, keyboardInsetPx: 0 };
}

/** 输入区布局：底边偏移 = 安全区 + 键盘遮挡高度（design-07 §4 行 117）。 */
export function composerLayout(viewport: KeyboardViewport): ComposerLayout {
  return {
    placement: 'above-keyboard-fixed',
    bottomOffsetPx: viewport.safeAreaBottomPx + viewport.keyboardInsetPx,
    keyboardVisible: viewport.keyboardInsetPx > 0,
  };
}

// ===========================================================================
// 3. 返回栈
// ===========================================================================

export function emptyNavStack(): NavStack {
  return { entries: [] };
}

export function topEntry(nav: NavStack): NavEntry | null {
  return nav.entries.length === 0 ? null : (nav.entries[nav.entries.length - 1] ?? null);
}

/**
 * 压栈。超过 `MAX_NAV_DEPTH` 抛 `nav-depth-exceeded`（拒绝，不静默截断旧页）。
 * 浅拷贝入参保证调用方对象不被别名修改。
 */
export function pushEntry(nav: NavStack, entry: NavEntry): NavStack {
  if (nav.entries.length >= MAX_NAV_DEPTH) {
    throw new ResilienceError('nav-depth-exceeded', '返回栈超过深度上限', {
      depth: nav.entries.length,
      max: MAX_NAV_DEPTH,
    });
  }
  return { entries: [...nav.entries, entry] };
}

/** 出栈。根节点（长度 <= 1）pop 是 no-op（R6，不下溢）。 */
export function popEntry(nav: NavStack): NavStack {
  if (nav.entries.length <= 1) return nav;
  return { entries: nav.entries.slice(0, -1) };
}

/** 替换栈顶。空栈抛 `empty-nav-stack`。 */
export function replaceTop(nav: NavStack, entry: NavEntry): NavStack {
  if (nav.entries.length === 0) {
    throw new ResilienceError('empty-nav-stack', '空栈无法替换栈顶', {});
  }
  return { entries: [...nav.entries.slice(0, -1), entry] };
}

/** 记录栈顶页的滚动锚点（离开该页前调用）；空栈抛错。 */
export function setTopScroll(nav: NavStack, anchor: ScrollAnchor): NavStack {
  const top = topEntry(nav);
  if (top === null) {
    throw new ResilienceError('empty-nav-stack', '空栈无法记录滚动锚点', {});
  }
  return replaceTop(nav, { ...top, scroll: anchor });
}

/** 构造导航项（默认无滚动锚点）。 */
export function navEntry(
  route: string,
  params: Readonly<Record<string, string>> = {},
  scroll: ScrollAnchor | null = null,
): NavEntry {
  return { route, params, scroll };
}

// ===========================================================================
// 4. 会话状态 / 进程死亡快照
// ===========================================================================

export function createSessionState(viewport: KeyboardViewport): SessionState {
  return {
    connection: initialConnection(),
    queue: emptyQueue(),
    nav: emptyNavStack(),
    viewport,
    drafts: {},
    phase: 'foreground',
  };
}

export function snapshotOf(state: SessionState): UiSnapshot {
  return { v: 1, nav: state.nav, viewport: state.viewport, drafts: state.drafts };
}

/**
 * 序列化快照为定序 JSON。`nav` 逐字段写出，`viewport` 逐字段写出，
 * `drafts` 交给 F02 的 `serializeDraftStore`（空草稿不落盘）。
 * 同一快照两次序列化逐字节相同。
 */
export function serializeSnapshot(snapshot: UiSnapshot): string {
  return JSON.stringify({
    v: 1,
    nav: {
      entries: snapshot.nav.entries.map((entry) => ({
        route: entry.route,
        params: entry.params,
        scroll:
          entry.scroll === null ? null : { key: entry.scroll.key, offsetPx: entry.scroll.offsetPx },
      })),
    },
    viewport: {
      keyboardInsetPx: snapshot.viewport.keyboardInsetPx,
      safeAreaBottomPx: snapshot.viewport.safeAreaBottomPx,
      screenHeightPx: snapshot.viewport.screenHeightPx,
      inputPlacement: snapshot.viewport.inputPlacement,
    },
    drafts: JSON.parse(serializeDraftStore(snapshot.drafts)) as unknown,
  });
}

function fallbackViewport(): KeyboardViewport {
  return { keyboardInsetPx: 0, safeAreaBottomPx: 0, screenHeightPx: 0, inputPlacement: 'above-keyboard-fixed' };
}

function normalizeAnchor(value: unknown): ScrollAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const key = record['key'];
  const offsetPx = record['offsetPx'];
  if (typeof key !== 'string' || key.length === 0) return null;
  if (typeof offsetPx !== 'number' || !Number.isFinite(offsetPx)) return null;
  return { key, offsetPx };
}

function normalizeNav(value: unknown): NavStack {
  if (typeof value !== 'object' || value === null) return emptyNavStack();
  const entriesRaw = (value as Record<string, unknown>)['entries'];
  if (!Array.isArray(entriesRaw)) return emptyNavStack();
  const entries: NavEntry[] = [];
  for (const raw of entriesRaw) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const route = record['route'];
    if (typeof route !== 'string' || route.length === 0) continue;
    const paramsRaw = record['params'];
    const params: Record<string, string> = {};
    if (typeof paramsRaw === 'object' && paramsRaw !== null) {
      for (const [k, v] of Object.entries(paramsRaw as Record<string, unknown>)) {
        if (typeof v === 'string') params[k] = v;
      }
    }
    entries.push({ route, params, scroll: normalizeAnchor(record['scroll']) });
  }
  return { entries };
}

function normalizeViewport(value: unknown): KeyboardViewport {
  if (typeof value !== 'object' || value === null) return fallbackViewport();
  const record = value as Record<string, unknown>;
  const screenHeightPx = record['screenHeightPx'];
  const safeAreaBottomPx = record['safeAreaBottomPx'];
  const keyboardInsetPx = record['keyboardInsetPx'];
  return {
    // 冷启动键盘必为收起：持久化时可能记了打开态，这里一律归零（见 coldStart 注释）。
    keyboardInsetPx:
      typeof keyboardInsetPx === 'number' && Number.isInteger(keyboardInsetPx) && keyboardInsetPx >= 0
        ? 0
        : 0,
    safeAreaBottomPx:
      typeof safeAreaBottomPx === 'number' && Number.isFinite(safeAreaBottomPx) && safeAreaBottomPx >= 0
        ? safeAreaBottomPx
        : 0,
    screenHeightPx:
      typeof screenHeightPx === 'number' && Number.isFinite(screenHeightPx) && screenHeightPx > 0
        ? screenHeightPx
        : 0,
    inputPlacement: 'above-keyboard-fixed',
  };
}

/**
 * 反序列化快照。**容错**：空串 / 非法 JSON / 非对象 / 版本不符 → `null`（没有可恢复项）。
 * 版本正确但局部损坏 → 丢弃损坏部分回退，绝不因一条脏数据让冷启动崩溃（R4）。
 */
export function deserializeSnapshot(raw: string | null | undefined): UiSnapshot | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['v'] !== 1) return null;
  return {
    v: 1,
    nav: normalizeNav(record['nav']),
    viewport: normalizeViewport(record['viewport']),
    drafts: deserializeDraftStore(JSON.stringify(record['drafts'] ?? {})),
  };
}

/**
 * 冷启动：从快照重建会话状态。
 *
 * 关键取舍（R4）：
 *   - 连接**重新探测**（回到 `online`），不沿用死亡前的离线态；
 *   - `phase` 回到 `foreground`；
 *   - 离线队列**不**从快照恢复（队列只是内存投递意图，崩溃后由内核账本去重）；
 *   - 键盘 inset 归零（系统进程死亡后 IME 不再挂着）；
 *   - 返回栈、滚动锚点、每会话草稿**原样还原**。
 */
export function coldStart(snapshot: UiSnapshot | null): SessionState {
  const base = createSessionState(snapshot === null ? fallbackViewport() : snapshot.viewport);
  if (snapshot === null) return base;
  return {
    ...base,
    nav: snapshot.nav,
    viewport: closeKeyboard(snapshot.viewport),
    drafts: snapshot.drafts,
  };
}

// ===========================================================================
// 5. 生命周期 + 草稿操作（消费 F02 实现）
// ===========================================================================

export function background(state: SessionState): SessionState {
  return { ...state, phase: 'backgrounded' satisfies AppPhase };
}

export function foreground(state: SessionState): SessionState {
  return { ...state, phase: 'foreground' satisfies AppPhase };
}

/** 写入某会话草稿正文（保留其附件）。 */
export function setDraftText(state: SessionState, conversationId: string, text: string): SessionState {
  const existing = getDraft(state.drafts, conversationId) ?? emptyDraft(conversationId);
  const next: ChatDraft = { conversationId, text, attachments: existing.attachments };
  return { ...state, drafts: putDraft(state.drafts, next) };
}

/** 给某会话草稿追加附件占位（不读真实字节）。 */
export function addDraftAttachment(
  state: SessionState,
  conversationId: string,
  input: AttachmentInput,
): SessionState {
  const existing = getDraft(state.drafts, conversationId) ?? emptyDraft(conversationId);
  const next: ChatDraft = {
    conversationId,
    text: existing.text,
    attachments: [...existing.attachments, createAttachmentPlaceholder(input)],
  };
  return { ...state, drafts: putDraft(state.drafts, next) };
}

/** 清空某会话草稿（如发送成功后）。 */
export function clearDraft(state: SessionState, conversationId: string): SessionState {
  return { ...state, drafts: removeDraft(state.drafts, conversationId) };
}

/** 恢复某会话未发送草稿；确实没有时返回 null（不返回空壳）。 */
export function recoverDraftFor(state: SessionState, conversationId: string): ChatDraft | null {
  return recoverDraft(state.drafts, conversationId);
}

/** 更新连接态（不触发 drain；drain 由调用方据 `shouldDrain` 决定）。 */
export function setConnection(state: SessionState, next: ConnectionState): SessionState {
  return { ...state, connection: next };
}

/** 规范化外部传入的草稿片段（透出 F02 能力，供宿主恢复半份草稿）。 */
export { normalizeDraft };

/** 便捷：把命令入队/直发并同步连接态（不改变 phase/nav/drafts）。 */
export function submitCommand(state: SessionState, command: Command): {
  readonly state: SessionState;
  readonly disposition: DispatchDisposition;
} {
  const result = dispatchCommand(state.connection, state.queue, command);
  return { state: { ...state, queue: result.queue }, disposition: result.disposition };
}

// ===========================================================================
// 6. 经 KernelClient 的真实 drain（F-I01 会话生命周期接线）
// ===========================================================================
//
// 这一段把前面 5 节的**纯队列**接到 F-I01 `apps/mobile-ui/src/platform/KernelClient`
// 上：离线入队的命令在重连后不再只是「本地挪个位置」，而是**真的**逐条经桥提交给内核，
// 拿到带真实 `resultRef` 的回执才 ack 出队。三条硬口径：
//
//   D1 只有非 online → online 跃迁触发 drain（复用 `shouldDrain`）；
//   D2 逐条 FIFO 提交，**保原幂等键**（命令对象原样下发，不重造，内核据此去重）；
//   D3 fail-closed：非 succeeded / 缺 resultRef / 提交抛错 / 桥已关闭，一律**不 ack**，
//      当前条及其后按原序保留在队列（R1、R3 在桥路径上的延伸）。
//
// 端口用**结构**声明，而非 import platform：真实 `KernelClient` 的
// `sendCommand(command) -> Promise<CommandReceipt>` 与 `state` 天然满足，本包不反向
// 依赖 platform（与 F02 `KernelClientPort` 同一纪律）。

/** 桥回执的结构投影：只取本层判定所需的三个字段（真实 `CommandReceipt` 是其超集）。 */
export interface BridgeReceipt {
  readonly commandId: string;
  readonly status: string;
  /** `succeeded` 时必为非空字符串；其余为 null（fail-closed：没有就是没有）。 */
  readonly resultRef: string | null;
}

/**
 * 桥客户端端口（结构接口）。真实 F-I01 `KernelClient` 直接满足：
 *   - `sendCommand(command)`：下发一条 v1 `Command`，解析为终局回执；边界非法时 reject。
 *   - `state`：`'open' | 'closed'`（断流后关闭，不再受理）。
 */
export interface BridgeClientPort {
  readonly state?: 'open' | 'closed';
  sendCommand(command: Command): Promise<BridgeReceipt>;
}

/** drain 停止原因。除 `complete` / `empty` 外，每一种都表示「队列里还有未确认命令」。 */
export type DrainStopReason =
  /** 全部命令拿到真实成功回执并 ack，队列归零。 */
  | 'complete'
  /** 队列本就为空，无可投递。 */
  | 'empty'
  /** 桥通道已关闭（KernelClient `closed`），不再投递剩余命令。 */
  | 'client-closed'
  /** `sendCommand` 抛出（提交被内核拒绝 / 边界错误），剩余命令保留。 */
  | 'submit-rejected'
  /** 回执非 succeeded 或缺 `resultRef`：**不得**视为完成，剩余命令保留。 */
  | 'not-succeeded';

/** 经桥 drain 的结果。`queue` 是 ack 之后的剩余队列（未确认命令一条不丢、保序）。 */
export interface BridgeDrainOutcome {
  readonly queue: OfflineQueue;
  /** 已成功 ack 的 commandId，按提交序。 */
  readonly acked: readonly string[];
  /** 已收到的真实成功回执（与 `acked` 一一对应）。 */
  readonly receipts: readonly BridgeReceipt[];
  readonly stopReason: DrainStopReason;
  readonly detail: string;
}

/**
 * 把离线队列**经 KernelClient** 逐条投递、逐条以真实回执 ack。
 *
 * 保序（FIFO by seq）、保幂等键（命令对象原样下发）、fail-closed（非真实成功回执不 ack）。
 * 中途断流时：已 ack 的移除，**未 ack 的按原序整条保留**——这正是「部分 ack」负例要挡住的
 * 「假装全清」。
 */
export async function drainThroughClient(
  client: BridgeClientPort,
  queue: OfflineQueue,
): Promise<BridgeDrainOutcome> {
  const ordered = [...queue.items].sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) {
    return { queue, acked: [], receipts: [], stopReason: 'empty', detail: '离线队列为空，无需 drain' };
  }
  let current = queue;
  const acked: string[] = [];
  const receipts: BridgeReceipt[] = [];
  for (const item of ordered) {
    // D3：桥已关闭则不再投递——当前条及其后的全部命令保留在队列。
    if (client.state !== undefined && client.state !== 'open') {
      return { queue: current, acked, receipts, stopReason: 'client-closed', detail: '桥通道已关闭，剩余命令按原序保留' };
    }
    let receipt: BridgeReceipt;
    try {
      receipt = await client.sendCommand(item.command);
    } catch {
      return {
        queue: current,
        acked,
        receipts,
        stopReason: 'submit-rejected',
        detail: `命令 ${item.command.commandId} 提交被内核拒绝（未进入执行层），剩余命令按原序保留`,
      };
    }
    if (receipt.status !== 'succeeded' || typeof receipt.resultRef !== 'string' || receipt.resultRef.length === 0) {
      // R1 延伸：没有真实 resultRef 就没有完成，绝不 ack。
      return {
        queue: current,
        acked,
        receipts,
        stopReason: 'not-succeeded',
        detail: `命令 ${item.command.commandId} 未取得真实成功回执（status=${receipt.status}），队列保留`,
      };
    }
    current = ackCommand(current, item.command.commandId, { resultRef: receipt.resultRef });
    acked.push(item.command.commandId);
    receipts.push(receipt);
  }
  return { queue: current, acked, receipts, stopReason: 'complete', detail: '全部命令已按序取得真实回执并 ack' };
}

/** `reconnectDrain` 的结果：会话状态 + 是否触发了 drain + drain 结局。 */
export interface ReconnectDrainOutcome {
  readonly state: SessionState;
  readonly drained: boolean;
  readonly stopReason: DrainStopReason | 'not-online';
  readonly acked: readonly string[];
}

/**
 * 会话生命周期接线：把网络信号喂给连接状态机，**只有**「非 online → online」的跃迁
 * 才经 `drainThroughClient` 把离线队列投递到桥，并把 ack 后的队列写回会话状态。
 *
 * 非触发路径（已在 online 收到恢复信号、或信号使其仍非 online）**不触碰客户端**：
 * 不投递、不 ack、队列原样——避免重复下发造成重复副作用（配合内核幂等键双保险）。
 */
export async function reconnectDrain(
  state: SessionState,
  client: BridgeClientPort,
  signal: NetworkSignal,
): Promise<ReconnectDrainOutcome> {
  const next = reduceConnection(state.connection, signal);
  const nextState = setConnection(state, next);
  if (!shouldDrain(state.connection, next)) {
    return { state: nextState, drained: false, stopReason: 'not-online', acked: [] };
  }
  const outcome = await drainThroughClient(client, state.queue);
  return {
    state: { ...nextState, queue: outcome.queue },
    drained: true,
    stopReason: outcome.stopReason,
    acked: outcome.acked,
  };
}

// ===========================================================================
// 7. 快照体量 / 重复会话守卫（冷启动恢复边界）
// ===========================================================================
//
// 冷启动会从**持久化字节**恢复。正常人不会写坏，但被截断/被篡改/被别的写入者覆盖的
// 快照必须 fail-closed，而不是悄悄恢复出一份错的界面。两个已知危害：
//
//   - 体量失控：一份含巨型正文（或大量会话）的快照在启动期被整份反序列化，拖垮内存/主线程；
//   - 重复会话：`serializeDraftStore` 产出的是**数组**，`deserializeDraftStore` 用
//     `putDraft` 逐条覆盖——若同一 conversationId 出现两次，恢复时**静默 last-wins**，
//     用户以为还在的第一份草稿被悄悄丢掉。

/** 快照体量上限（UTF-8 字节）。超过即拒绝恢复。 */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** 快照内草稿条数上限。 */
export const MAX_SNAPSHOT_DRAFTS = 100;

export interface SnapshotGuardLimits {
  readonly maxBytes?: number;
  readonly maxDrafts?: number;
}

export type SnapshotGuardIssueCode = 'snapshot-too-large' | 'too-many-drafts' | 'duplicate-conversation';

export interface SnapshotGuardIssue {
  readonly code: SnapshotGuardIssueCode;
  readonly detail: Readonly<Record<string, unknown>>;
}

const SNAPSHOT_GUARD_MESSAGES: Readonly<Record<SnapshotGuardIssueCode, string>> = Object.freeze({
  'snapshot-too-large': '快照超过体量上限，拒绝恢复（防止启动期被巨型快照拖垮）',
  'too-many-drafts': '快照草稿条数超过上限，拒绝恢复',
  'duplicate-conversation': '快照含重复会话草稿，恢复会静默丢草稿，拒绝恢复',
});

/** 按 UTF-8 编码计算字节数（纯函数，不依赖 node 内建 / TextEncoder）。 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 检查一份**原始**持久化字节是否可安全恢复。纯判定，不抛错。
 * 非法 JSON 不在此报错（那交给容错的 `deserializeSnapshot` 返回 null）。
 */
export function snapshotGuardIssues(
  raw: string | null | undefined,
  limits: SnapshotGuardLimits = {},
): readonly SnapshotGuardIssue[] {
  const issues: SnapshotGuardIssue[] = [];
  if (typeof raw !== 'string' || raw.length === 0) return issues;
  const maxBytes = limits.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const maxDrafts = limits.maxDrafts ?? MAX_SNAPSHOT_DRAFTS;

  const size = utf8ByteLength(raw);
  if (size > maxBytes) {
    issues.push({ code: 'snapshot-too-large', detail: { size, maxBytes } });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return issues; // 坏 JSON 由 deserializeSnapshot 容错处理，不在守卫里报错
  }
  if (typeof parsed !== 'object' || parsed === null) return issues;

  const draftsField = (parsed as Record<string, unknown>)['drafts'];
  const list =
    typeof draftsField === 'object' && draftsField !== null
      ? (draftsField as Record<string, unknown>)['drafts']
      : undefined;
  if (!Array.isArray(list)) return issues;

  if (list.length > maxDrafts) {
    issues.push({ code: 'too-many-drafts', detail: { count: list.length, maxDrafts } });
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const conversationId = (entry as Record<string, unknown>)['conversationId'];
    if (typeof conversationId !== 'string' || conversationId.length === 0) continue;
    if (seen.has(conversationId)) duplicates.add(conversationId);
    else seen.add(conversationId);
  }
  if (duplicates.size > 0) {
    issues.push({ code: 'duplicate-conversation', detail: { conversations: [...duplicates].sort() } });
  }
  return issues;
}

/** 守卫判定结果。`ok === true` 时才给出可恢复快照；否则 `snapshot` 恒为 null（fail-closed）。 */
export interface SnapshotGuardResult {
  readonly ok: boolean;
  readonly issues: readonly SnapshotGuardIssue[];
  readonly snapshot: UiSnapshot | null;
}

/**
 * 带守卫的恢复读取：先过体量 / 重复会话 / 条数闸门，全部通过才真正反序列化。
 * 任何 issue ⇒ `{ ok:false, snapshot:null }`——调用方不得据被判负的字节恢复界面。
 */
export function readSnapshotGuarded(
  raw: string | null | undefined,
  limits: SnapshotGuardLimits = {},
): SnapshotGuardResult {
  const issues = snapshotGuardIssues(raw, limits);
  if (issues.length > 0) return { ok: false, issues, snapshot: null };
  return { ok: true, issues: [], snapshot: deserializeSnapshot(raw) };
}

/** 抛错式守卫：任一 issue 抛 `ResilienceError(code)`（供希望 fail-fast 的调用方使用）。 */
export function assertSnapshotGuard(raw: string | null | undefined, limits: SnapshotGuardLimits = {}): void {
  const issues = snapshotGuardIssues(raw, limits);
  const first = issues[0];
  if (first === undefined) return;
  throw new ResilienceError(first.code, SNAPSHOT_GUARD_MESSAGES[first.code], first.detail);
}
