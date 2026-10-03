/**
 * F-I05 host/mount —— 无头 App 引导（把 client + shell + 渲染组合成可跑的 App）。
 *
 * `mount()` 做三件事（都是集成 payoff 的要求）：
 *   1. 组合注入的 **KernelClient**（F-I01，结构面 `HostKernelClientPort`）与
 *      **壳/渲染**（F-I02 shell + F-I03 render，经 `createHostSession`）；
 *   2. `send()` 派发一条**真实命令**（F02 `buildSendCommandForState` → v1 契约形状），
 *      在真实 K01 `BootstrapRuntime` 上执行，把返回的 v1 `Event` 归约进 chat 状态；
 *   3. 用 **F-I03 渲染序列化器**（`renderText` / `renderHtml`）产出可断言的一帧。
 *
 * `mountOnRuntime(runtime, conversationId)` 是完整装配：用 F-I01 的
 * `createKernelClientFromBridge` 把真实运行时包成真实桥 + 真实 `KernelClient`，
 * 再挂到本宿主上。这样「命令出、事件回、回执落、渲染出」是**真链路**，不是 mock。
 *
 * 类型层面 `import type { KernelClient }`（仅用于断言结构兼容），运行期只 import
 * `platform` 的装配函数；宿主自身不复制桥 / 不直连内核。
 */

import type { KernelClient, CallerIdentity } from '../platform/index.js';
import { createKernelClientFromBridge, type KernelClientBridgeBundle } from '../platform/index.js';
import type { BootstrapRuntime } from '../../../mobile-kernel/bootstrap/index.js';
import type { ChatState } from '../chat/index.js';
import type { ScreenId } from '../shell/index.js';
import {
  createHostSession,
  type HostKernelClientPort,
  type HostSendOutcome,
  type HostSession,
  type HostView,
  type RenderFrame,
} from './session.js';

/** 编译期结构兼容断言：F-I01 的真实 `KernelClient` 必须满足宿主端口。 */
export type KernelClientSatisfiesHostPort = KernelClient extends HostKernelClientPort ? true : never;

export interface MountOptions {
  readonly client: HostKernelClientPort;
  readonly conversationId: string;
  readonly initialState?: ChatState;
  readonly rootScreen?: ScreenId;
}

/** 无头 App 句柄。 */
export interface HostApp {
  readonly session: HostSession;
  send(text: string): Promise<HostSendOutcome>;
  view(): HostView;
  frame(): RenderFrame;
  /** 当前帧的可访问性文本序列化（`renderText`）。 */
  renderText(): string;
  /** 当前帧的 HTML 序列化（`renderHtml`）。 */
  renderHtml(): string;
  dispose(): void;
}

/** 组合 client + shell + chat 会话 + 渲染，返回无头 App。 */
export function mount(options: MountOptions): HostApp {
  const session = createHostSession(options);
  return {
    session,
    send: (text: string) => session.send(text),
    view: () => session.view(),
    frame: () => session.frame(),
    renderText: () => session.frame().text,
    renderHtml: () => session.frame().html,
    dispose: () => session.dispose(),
  };
}

export interface HostRuntimeOptions {
  /** 调用方身份；缺省本地 WebView（`app://local` / `ui-webview`）。 */
  readonly caller?: CallerIdentity;
  readonly initialState?: ChatState;
  readonly rootScreen?: ScreenId;
}

/** 直接在真实 K01 运行时上运行的宿主（含完整 F-I01 桥装配）。 */
export interface HostRuntimeApp extends HostApp {
  readonly bundle: KernelClientBridgeBundle;
  readonly runtime: BootstrapRuntime;
}

const DEFAULT_CALLER: CallerIdentity = { origin: 'app://local', kind: 'ui-webview' };

/**
 * 完整装配：真实 K01 运行时 → 真实桥 → 真实 `KernelClient` → 本宿主。
 *
 * 调用方负责 `runtime.start()` 与 `runtime.registerModule(...)`（命令处理器由业务侧注册；
 * 宿主只发命令、收事件、渲染）。
 */
export function mountOnRuntime(
  runtime: BootstrapRuntime,
  conversationId: string,
  options: HostRuntimeOptions = {},
): HostRuntimeApp {
  const caller: CallerIdentity = options.caller ?? DEFAULT_CALLER;
  const bundle = createKernelClientFromBridge({ runtime, caller });
  const app = mount({
    client: bundle.client,
    conversationId,
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
    ...(options.rootScreen === undefined ? {} : { rootScreen: options.rootScreen }),
  });
  return { ...app, bundle, runtime };
}
