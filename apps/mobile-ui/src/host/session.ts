/**
 * F-I05 host/session —— 无头 App 会话控制器（integration slice F-I05）。
 *
 * 这是集成 payoff 的核心：把 **KernelClient（F-I01 / `src/platform`）**、
 * **壳（F-I02 / `src/shell`）**、**渲染序列化器（F-I03 / `src/render`）** 与
 * **chat reducer（F02）** 组合成一个「无头 App」——没有 DOM / Android View，
 * 但仍跑通真实的 **命令派发 → 内核事件回执 → 归约 → 渲染序列化**。
 *
 * 组合方式（不重写任何兄弟模块）：
 *   - 命令下发 + 事件归约：复用 F02 `createChatKernelAdapter`
 *     （`buildSendCommandForState` → `sendCommand`；`Event` → `kernelEvent`；
 *      断流 → `streamEnded` + `eventStreamEnded`）。本包只做「真实 KernelClient 结构面
 *      → F02 端口」的薄适配与「状态 → ViewNode → 序列化」的渲染接线。
 *   - 传输：只看 F-I01 `KernelClient` 的**结构面** {@link HostKernelClientPort}，
 *     真实 `KernelClient` 直接结构化满足（见 `mount.ts` 的 `mountOnRuntime`）。
 *   - 壳：用 F-I02 `createNavState` / `currentScreen` 钉住当前屏幕（缺省 C01 对话）。
 *   - 渲染：把会话快照映射成 F-I03 `ViewNode` 树，再经 `renderText` / `renderHtml`
 *     序列化（fail-closed：视图树非法会抛 `ViewError`）。
 *
 * 不变量（由 `tests/mobile-ui/host/roundtrip.test.ts` 机器化断言）：
 *   H1 **单次订阅**：一条命令只创建 **一个** 内核订阅，且事件只归约一次。
 *   H2 **回执往返**：内核 `succeeded` 必须带 `resultRef` 才渲染出「回执行」。
 *   H3 **断流不伪造**：派发失败/事件流断开 ⇒ 消息 `interrupted`、任务 `progressUnknown`，
 *      **绝不**渲染成成功。
 *   H4 **命令隔离**：只归约本命令的事件（由 F-I01 的按命令订阅 + F02 适配器共同保证）。
 *
 * 本包纯 TS（除既有模块外零新增依赖），不读时钟 / 随机数 / 网络 / 文件。
 */

import type { Command, Event } from '../../../../contracts/mobile-v1/types.js';
import {
  createChatKernelAdapter,
  createChatState,
  getTask,
  isTaskSucceeded,
  reduce,
  type ChatAction,
  type ChatMessageView,
  type ChatState,
  type KernelClientPort as ChatKernelClientPort,
  type KernelStreamBreakReason as ChatStreamBreakReason,
} from '../chat/index.js';
import { renderHtml, renderText, type ViewNode } from '../render/index.js';
import { createNavState, currentScreen, type NavState, type ScreenId } from '../shell/index.js';

// ---------------------------------------------------------------------------
// KernelClient 端口（F-I01 结构面）
// ---------------------------------------------------------------------------

/** 内核事件流断开（脱敏）：只带原因与说明，不含错误体/密钥/本地路径。 */
export interface HostStreamBreak {
  readonly reason: string;
  readonly detail: string;
}

/**
 * 宿主需要的 KernelClient 结构面。F-I01 的真实 `KernelClient` **结构化满足**它：
 *   - `sendCommand(command) -> Promise<CommandReceipt>`（`Promise<unknown>` 兼容）；
 *   - `subscribe(commandId, onEvent, onBreak) -> () => void`（按命令订阅）。
 * 刻意只留这两个方法：宿主不碰桥、不取消、不上报断流（那些由上层宿主/适配器持有）。
 */
export interface HostKernelClientPort {
  sendCommand(command: Command): void | Promise<unknown>;
  subscribe(
    commandId: string,
    onEvent: (event: Event) => void,
    onBreak: (breakInfo: HostStreamBreak) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------
// 渲染（经 F-I03 序列化器）
// ---------------------------------------------------------------------------

const MESSAGE_ROLE_LABEL: Readonly<Record<ChatMessageView['role'], string>> = {
  user: '我',
  assistant: '助手',
  system: '系统',
  error: '错误',
};

/** 会话快照（交给壳/渲染层）。 */
export interface HostView {
  readonly state: ChatState;
  readonly interrupted: boolean;
  readonly screen: ScreenId;
  readonly pendingCommandId: string | null;
}

/** 一帧可序列化的渲染结果（含 ViewNode 树与文本 / HTML 序列化）。 */
export interface RenderFrame {
  readonly conversationId: string;
  readonly screen: ScreenId;
  readonly interrupted: boolean;
  /** 是否至少有一条任务拿到带 `resultRef` 的内核成功回执。 */
  readonly hasReceipt: boolean;
  readonly node: ViewNode;
  /** `renderText(node)`：逐行可访问性文本。 */
  readonly text: string;
  /** `renderHtml(node)`：确定性 HTML 字符串。 */
  readonly html: string;
}

function hasReceipt(state: ChatState): boolean {
  for (const message of state.messages) {
    if (isTaskSucceeded(getTask(state, message.id))) return true;
  }
  return false;
}

/**
 * 把会话快照映射成 F-I03 `ViewNode` 树（fail-closed：只用白名单标签/角色）。
 * 回执行只在任务 `succeeded` **且** `resultRef` 非空时出现。
 */
export function buildConversationNode(view: HostView): ViewNode {
  const children: ViewNode[] = [{ tag: 'header', role: 'header', ariaLabel: 'potbot 对话' }];

  for (const message of view.state.messages) {
    const body = message.text.length > 0 ? message.text : '(空)';
    children.push({ tag: 'p', role: 'text', ariaLabel: `${MESSAGE_ROLE_LABEL[message.role]}: ${body}` });

    const task = getTask(view.state, message.id);
    if (task === null || task.status === 'idle') continue;

    const suffix = task.progressUnknown ? '（进度未知）' : '';
    children.push({ tag: 'span', role: 'status', ariaLabel: `内核:${task.status}${suffix}` });

    const resultRef = task.status === 'succeeded' ? task.resultRef : null;
    if (resultRef !== null && resultRef.length > 0) {
      children.push({ tag: 'span', role: 'status', ariaLabel: `回执:${resultRef}` });
    }
  }

  if (view.interrupted) {
    children.push({ tag: 'span', role: 'status', ariaLabel: '事件流中断：任务进度未知，未确认完成' });
  }

  return {
    tag: 'main',
    role: 'screen',
    ariaLabel: `对话 ${view.state.conversationId}（${view.screen}）`,
    children,
  };
}

/** 用 F-I03 渲染序列化器把 ViewNode 树序列化成文本 + HTML。 */
export function serializeConversationView(view: HostView): RenderFrame {
  const node = buildConversationNode(view);
  return {
    conversationId: view.state.conversationId,
    screen: view.screen,
    interrupted: view.interrupted,
    hasReceipt: hasReceipt(view.state),
    node,
    text: renderText(node),
    html: renderHtml(node),
  };
}

// ---------------------------------------------------------------------------
// 会话控制器
// ---------------------------------------------------------------------------

export interface HostSendOutcome {
  readonly assistantMessageId: string;
  /** 本地前置条件不满足（找不到可发送正文）时为 null。 */
  readonly commandId: string | null;
  /** 命令是否成功交给内核（**不代表**任务成功）。 */
  readonly submitted: boolean;
  /** 本次派发是否以断流结束（内核拒绝 / 事件流断开）。 */
  readonly interrupted: boolean;
  readonly preconditionFailed: boolean;
  readonly frame: RenderFrame;
}

export interface HostSession {
  view(): HostView;
  frame(): RenderFrame;
  /** 订阅渲染变化（每次状态推进后回调一帧）。 */
  subscribe(listener: (frame: RenderFrame) => void): { unsubscribe(): void };
  /** 唯一自然语言入口：发送一条消息，等待内核事件回执。 */
  send(text: string): Promise<HostSendOutcome>;
  /** 逃生门：把一条 chat reducer 动作（如模型正文分片）投递进状态。 */
  applyAction(action: ChatAction): void;
  dispose(): void;
}

export interface HostSessionOptions {
  readonly client: HostKernelClientPort;
  readonly conversationId: string;
  readonly initialState?: ChatState;
  /** 壳根屏幕；缺省 C01（对话主屏）。 */
  readonly rootScreen?: ScreenId;
}

/** 把 F-I01 的断流原因映射到 F02 适配器的原因词表（仅用于观测字段）。 */
function toChatBreakReason(reason: string): ChatStreamBreakReason {
  switch (reason) {
    case 'runtime-stopped':
      return 'aborted';
    case 'transport-closed':
      return 'closed';
    case 'submit-rejected':
    case 'sequence-gap':
    case 'invalid-terminal':
      return 'transport-error';
    default:
      return 'unknown';
  }
}

/**
 * 创建无头会话。组合真实 KernelClient（结构面）+ shell 导航 + chat reducer + render。
 */
export function createHostSession(options: HostSessionOptions): HostSession {
  const nav: NavState = createNavState(options.rootScreen ?? 'C01');
  let state = options.initialState ?? createChatState(options.conversationId);
  let interrupted = false;
  let pendingCommandId: string | null = null;
  const renderListeners = new Set<(frame: RenderFrame) => void>();

  function view(): HostView {
    return { state, interrupted, screen: currentScreen(nav), pendingCommandId };
  }

  function frame(): RenderFrame {
    return serializeConversationView(view());
  }

  function notify(): void {
    const next = frame();
    for (const listener of [...renderListeners]) listener(next);
  }

  function dispatch(action: ChatAction): void {
    const next = reduce(state, action);
    if (next !== state) {
      state = next;
      notify();
    }
  }

  // 真实 KernelClient（F-I01）→ F02 适配器端口的薄适配。
  const chatPort: ChatKernelClientPort = {
    sendCommand: (command: Command) =>
      Promise.resolve(options.client.sendCommand(command)).then(() => undefined),
    subscribe: (commandId, onEvent, onBreak) =>
      options.client.subscribe(commandId, onEvent, (breakInfo) =>
        onBreak({ reason: toChatBreakReason(breakInfo.reason), message: breakInfo.detail }),
      ),
  };
  const adapter = createChatKernelAdapter(chatPort, dispatch);

  async function send(text: string): Promise<HostSendOutcome> {
    if (text.trim().length === 0) {
      throw new Error('send 需要非空自然语言正文（唯一入口不接受空消息）');
    }

    state = reduce(state, { type: 'setDraftText', text });
    state = reduce(state, { type: 'sendUserMessage' });
    const assistantMessageId = `a-${state.counter}`;

    notify();
    const outcome = await adapter.send(state, assistantMessageId);
    pendingCommandId = outcome.commandId;
    if (outcome.broken) interrupted = true;
    notify();

    return {
      assistantMessageId,
      commandId: outcome.commandId,
      submitted: outcome.submitted,
      interrupted: outcome.broken,
      preconditionFailed: outcome.preconditionFailed,
      frame: frame(),
    };
  }

  function subscribe(listener: (frame: RenderFrame) => void): { unsubscribe(): void } {
    renderListeners.add(listener);
    return {
      unsubscribe: () => {
        renderListeners.delete(listener);
      },
    };
  }

  function dispose(): void {
    adapter.dispose();
    renderListeners.clear();
  }

  return { view, frame, subscribe, send, applyAction: dispatch, dispose };
}
