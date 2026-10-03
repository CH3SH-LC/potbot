/**
 * F-R03 —— 断网 / 重连 / 应用被杀 / 返回栈 / 键盘 / 草稿恢复的类型与不变量。
 *
 * 本包是前端线的**备用验证包**（FRONTEND.md 备用包表 F-R03），独占写区
 * `tests/mobile-ui/F-R03/`。它不改产品代码，只**只读消费**已有实现：
 *   - `apps/mobile-ui/src/chat/draft.ts` —— 未发送草稿的序列化 / 恢复（F02 已交付）。
 *   - `apps/mobile-ui/src/chat/types.ts` —— `DraftStore` / `ChatDraft` 结构。
 *   - `contracts/mobile-v1/types.ts` —— v1 `Command`（离线队列里排队的正是它）。
 *
 * 交付形态：本目录是一个**自包含的可执行规格**（types + 纯 reducer + 独立测试 +
 * RUNBOOK）。既有的 F02 草稿恢复覆盖「单会话序列化往返」；本包补齐它没有覆盖的
 * 进程死亡、返回栈、键盘与离线队列四个场景，并把它们串成一条可断言的恢复链。
 *
 * 核心不变量（由 `resilience.test.ts` 机器化断言）：
 *   R1 离线不得伪完成：连接非 `online` 时提交的命令只能进入 `queue`，disposition 必须是
 *      `queued`，且**任何**未经真实回执（resultRef）的命令都不能被当作「已送达」。
 *   R2 重连保序且保幂等键：drain 必须 FIFO 且逐条保留原 `idempotencyKey`——掉线前
 *      可能已到达内核的命令，重发时靠同一个幂等键去重，不能生成新键造成重复副作用。
 *   R3 重连失败不丢队列：drain 中途失败，未确认的命令按原序放回队首，一条不丢。
 *   R4 进程死亡可恢复：导航栈、每页滚动锚点、每会话草稿必须能整份序列化并在冷启动
 *      反序列化回**等价**结构；损坏 / 版本不符的片段被丢弃而不是让启动崩溃。
 *   R5 键盘不吞草稿：开 / 关软键盘只改视口 inset，草稿内容逐字节不变。
 *   R6 返回栈安全带：根节点 pop 是 no-op（不下溢），超过深度上限的 push 被拒绝且
 *      不静默截断；返回时恢复上一页保存的滚动位置。
 *
 * 本包**未做**（如实标注，不算完成）：真实 Android 生命周期回调、真实 `NetworkCapabilities`
 * 监听、真实软键盘 IME inset、真实 `KernelClient` 投递与回执、真机进程回收——这些是
 * 运行期依赖，见 `RUNBOOK.md`「未验证层」。
 */

import type { Command } from '../../../contracts/mobile-v1/types.js';
import type { ChatDraft, DraftStore } from '../../../apps/mobile-ui/src/chat/types.js';

export type { Command, ChatDraft, DraftStore };

// ---------------------------------------------------------------------------
// 连接状态机
// ---------------------------------------------------------------------------

/**
 * 连接态。`online` 是唯一允许**直接投递**命令的状态；其余一律排队。
 * 没有 `unknown`：启动即视为 `online`，由第一个失败信号降到 `offline`；
 * 不引入会让人误以为「已连接」的模糊态。
 */
export type ConnectionState = 'online' | 'offline' | 'reconnecting';

/** 网络信号。全部来自宿主层（Android `ConnectivityManager` / 桥），本模块只做迁移。 */
export type NetworkSignal =
  | { readonly type: 'networkLost' }
  | { readonly type: 'networkRestored' }
  | { readonly type: 'reconnectStarted' }
  | { readonly type: 'reconnectSucceeded' }
  | { readonly type: 'reconnectFailed' };

/** 离线队列里的一条：命令本体 + 入队序号（FIFO 与幂等键可复现的基础）。 */
export interface QueuedCommand {
  readonly seq: number;
  readonly command: Command;
}

/** 离线命令队列（不可变；`nextSeq` 单调递增，不使用时钟/随机数）。 */
export interface OfflineQueue {
  readonly items: readonly QueuedCommand[];
  readonly nextSeq: number;
}

/** 提交一条命令后的处置。**只有** `sent` 允许进入「已投递」；`queued` 不是完成。 */
export type DispatchDisposition = 'sent' | 'queued';

export interface DispatchResult {
  readonly connection: ConnectionState;
  readonly queue: OfflineQueue;
  readonly disposition: DispatchDisposition;
  readonly commandId: string;
}

/** drain 结果：要按序提交的命令 + 剩余队列（通常为空，失败时按序回填）。 */
export interface DrainResult {
  readonly queue: OfflineQueue;
  readonly submitting: readonly QueuedCommand[];
}

// ---------------------------------------------------------------------------
// 键盘 / 视口
// ---------------------------------------------------------------------------

/**
 * 键盘视口。`keyboardInsetPx` 是软键盘从屏幕底部遮挡的高度（0 = 键盘收起）。
 * `safeAreaBottomPx` 是系统手势条 / 导航栏安全区。输入区底边 = 安全区 + 键盘 inset。
 */
export interface KeyboardViewport {
  readonly keyboardInsetPx: number;
  readonly safeAreaBottomPx: number;
  readonly screenHeightPx: number;
  /** design-07 §4 行 117：正式 App 输入区固定在键盘上方。 */
  readonly inputPlacement: 'above-keyboard-fixed';
}

/** 输入区相对屏幕底部的布局描述（供渲染层直接使用，本包不渲染）。 */
export interface ComposerLayout {
  readonly placement: 'above-keyboard-fixed';
  readonly bottomOffsetPx: number;
  readonly keyboardVisible: boolean;
}

// ---------------------------------------------------------------------------
// 返回栈
// ---------------------------------------------------------------------------

/** 稳定的滚动锚点：翻回某页时用它恢复滚动位置（不依赖绝对像素估算）。 */
export interface ScrollAnchor {
  /** 定位键，例如某会话 id（与 F03 `locateConversation` 的锚点语义一致）。 */
  readonly key: string;
  readonly offsetPx: number;
}

export interface NavEntry {
  /** 路由名，例如 `chat` / `conversations` / `conversations.list`。 */
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  /** 该页离开时保存的滚动锚点；未设置时为 null（不编造位置）。 */
  readonly scroll: ScrollAnchor | null;
}

export interface NavStack {
  readonly entries: readonly NavEntry[];
}

// ---------------------------------------------------------------------------
// 会话级韧性状态与快照
// ---------------------------------------------------------------------------

export type AppPhase = 'foreground' | 'backgrounded';

/** 前端会话的韧性状态：连接 + 离线队列 + 返回栈 + 视口 + 每会话草稿 + 生命周期。 */
export interface SessionState {
  readonly connection: ConnectionState;
  readonly queue: OfflineQueue;
  readonly nav: NavStack;
  readonly viewport: KeyboardViewport;
  readonly drafts: DraftStore;
  readonly phase: AppPhase;
}

/**
 * 持久化快照。**只**装可跨进程死亡存活的数据：
 *  - 不含连接态（冷启动重新探测，不假装还连着）；
 *  - 不含 app phase（冷启动即前台）；
 *  - 含导航栈、视口、每会话草稿。
 */
export interface UiSnapshot {
  readonly v: 1;
  readonly nav: NavStack;
  readonly viewport: KeyboardViewport;
  readonly drafts: DraftStore;
}

export class ResilienceError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'ResilienceError';
    this.code = code;
    this.detail = detail;
  }
}
