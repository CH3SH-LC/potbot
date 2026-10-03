/**
 * F-I01 `platform/KernelClient` —— F 线七个子包唯一的原生调用面。
 *
 * ## 为什么有这个文件
 *
 * F02/F03/F04/F05/F07/F09/F10 各自都发出了同一条集成请求："给我一个 KernelClient"，
 * 而此前并不存在。本文件是**一个**基于真实 K01 `LocalUiBridge` 的薄客户端：
 *
 *   - `sendCommand(command) -> CommandReceipt`：提交 → 规范化回执；
 *   - `subscribe(commandId, onEvent, onBreak) -> unsubscribe`：按命令订阅事件流，
 *     断流时 `onBreak -> progressUnknown`，**绝不成功**；
 *   - `cancel(commandId)`：中止在飞命令；
 *   - 可选注入真实 K07 `AuthorizationLedger`（泛型 `TNativeTrust`，见 types.ts 说明）。
 *
 * ## 硬口径（逐条由 tests/mobile-ui/platform 机器化断言）
 *
 *   C1 **断流不伪造**：桥通道断开 / 运行时停止 / `seq` 空洞 / 坏终局事件
 *      ⇒ 该命令 `onBreak({status:'progressUnknown'})`，**绝不**投递 `succeeded`。
 *   C2 **fail-closed**：`status=succeeded` 却缺 `resultRef` 的事件按坏流处理，
 *      不投递给 `onEvent`，改投 `onBreak`。
 *   C3 **seq 单调**：全局事件流偏离 `+1`（丢事件）即对所有在飞命令断流。
 *      （幂等重放**不**进订阅流，见 K01 dispatch 的早返回，故不影响本判据。）
 *   C4 **subscribe 后到不丢终局**：若订阅晚于 `publish`，`sendCommand` 解析时补投一次终局。
 *   C5 **提交被拒不静默**：内核边界错误（形状 / origin / 未启动）⇒ `sendCommand` reject，
 *      且若有订阅者则投一次 `onBreak('submit-rejected')`，绝不假装成功。
 *   C6 **caller 钉死**：客户端经适配器持有一个已校验的 `CallerIdentity`，调用方无法改。
 *
 * ## 明确未做（不得当成已完成）
 *   - **真机通道未接**：`signalStreamBreak` 是宿主注入点，本层不自造心跳 / 不断言桥还活着。
 *   - **不持久化 / 不重连**：断流后不同一 attempt 续传。
 *   - **原生信任路径未接真机**：注入的是 K07 账本实现，原生确认页 / Android 进程未接；
 *     本层只**承载**端口，签发/消费仍由 F05 `submitThroughNativeTrust` 调用。
 */

import {
  createLocalUiBridge,
  type BootstrapRuntime,
  type CallerIdentity,
  type CallerKind,
  type LocalUiBridge,
} from '../../../../apps/mobile-kernel/bootstrap/index.js';
import type {
  Command,
  CommandReceipt,
  Event,
  KernelBreakSink,
  KernelClient,
  KernelClientState,
  KernelEventSink,
  KernelStreamBreakReason,
  KernelTransport,
  KernelTransportBreakNotice,
  NativeTrustPortShape,
} from './types.js';
import { assertNativeTrustPort, KernelClientError } from './types.js';
import { createLocalBridgeAdapter, type LocalBridgeTransport } from './local-bridge-adapter.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'conflict', 'cancelled']);

const BREAK_DETAILS: Readonly<Record<KernelStreamBreakReason, string>> = Object.freeze({
  'transport-closed': '桥通道已关闭（WebView 卸载 / 原生侧断开）：在飞命令结果未知',
  'runtime-stopped': '内核运行时已停止：在飞命令被中止，结果未知',
  'sequence-gap': '事件流 seq 不连续（疑似丢事件）：该流已不可信',
  'invalid-terminal': '收到 status=succeeded 但缺 resultRef 的坏事件：按未知处理，绝不成功',
  'submit-rejected': '命令被内核边界拒绝：命令未进入执行层',
});

interface PendingSink {
  readonly onEvent: KernelEventSink;
  readonly onBreak: KernelBreakSink;
  lastSeq: number;
  lastEvent: Event | null;
}

export interface CreateKernelClientOptions<TNativeTrust extends NativeTrustPortShape = NativeTrustPortShape> {
  /** 传输端口（真实实现见 {@link createLocalBridgeAdapter}）。 */
  readonly transport: KernelTransport;
  /** 已钉住的调用方身份。 */
  readonly caller: CallerIdentity;
  /** 可选：真实 K07 账本，作为原生信任端口注入（运行期结构闸门校验）。 */
  readonly nativeTrust?: TNativeTrust | null;
  /** 可选：内核运行时；提供后 `stop()` 会连带停止运行时并断流。 */
  readonly runtime?: BootstrapRuntime | null;
}

export function createKernelClient<TNativeTrust extends NativeTrustPortShape = NativeTrustPortShape>(
  options: CreateKernelClientOptions<TNativeTrust>,
): KernelClient<TNativeTrust> {
  const { transport, caller } = options;
  const nativeTrust = assertNativeTrustPort(options.nativeTrust ?? null) as TNativeTrust | null;
  const runtime = options.runtime ?? null;

  let state: KernelClientState = 'open';
  let lastGlobalSeq: number | null = null;
  const pending = new Map<string, PendingSink[]>();

  const eventSubscription = transport.subscribe(handleEvent);
  const breakSubscription = transport.onBreak(handleTransportBreak);

  function isTerminalStatus(status: string): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  function close(): void {
    if (state === 'closed') return;
    state = 'closed';
    eventSubscription.unsubscribe();
    breakSubscription.unsubscribe();
  }

  function deliverBreak(commandId: string, reason: KernelStreamBreakReason, detail: string): void {
    const sinks = pending.get(commandId);
    if (sinks === undefined) return;
    pending.delete(commandId);
    for (const sink of sinks) {
      const lastEvent = sink.lastEvent;
      try {
        sink.onBreak({
          commandId,
          reason,
          status: 'progressUnknown',
          detail,
          lastEvent,
        });
      } catch {
        // 单个订阅者抛错不影响其他订阅者 / 不打断事件处理（I6 同源纪律）。
      }
    }
  }

  function breakAll(reason: KernelStreamBreakReason, detail: string): void {
    for (const commandId of [...pending.keys()]) {
      deliverBreak(commandId, reason, detail);
    }
  }

  /**
   * 投递一条事件给某命令的订阅者；终局时清掉订阅。
   * `succeeded` 缺 `resultRef` ⇒ 不投 `onEvent`，改投坏流。
   */
  function deliverEvent(commandId: string, event: Event): void {
    if (event.status === 'succeeded' && (event.resultRef === undefined || event.resultRef.length === 0)) {
      deliverBreak(commandId, 'invalid-terminal', BREAK_DETAILS['invalid-terminal']);
      return;
    }
    const sinks = pending.get(commandId);
    if (sinks === undefined) return;
    for (const sink of sinks) {
      if (event.seq <= sink.lastSeq) continue; // 重放 / 乱序：不重复投递
      sink.lastSeq = event.seq;
      sink.lastEvent = event;
      try {
        sink.onEvent(event);
      } catch {
        // 隔离订阅者异常。
      }
    }
    if (isTerminalStatus(event.status)) {
      pending.delete(commandId);
    }
  }

  function handleEvent(event: Event): void {
    if (lastGlobalSeq !== null && event.seq !== lastGlobalSeq + 1) {
      const expected = lastGlobalSeq + 1;
      lastGlobalSeq = event.seq;
      breakAll('sequence-gap', `${BREAK_DETAILS['sequence-gap']}（期望 seq ${expected}，收到 ${event.seq}）`);
      return;
    }
    lastGlobalSeq = event.seq;
    if (!pending.has(event.commandId)) return;
    deliverEvent(event.commandId, event);
  }

  function handleTransportBreak(notice: KernelTransportBreakNotice): void {
    if (notice.reason === 'transport-closed' || notice.reason === 'runtime-stopped') {
      close();
    }
    breakAll(notice.reason, notice.detail.length > 0 ? notice.detail : BREAK_DETAILS[notice.reason]);
  }

  function toReceipt(event: Event): CommandReceipt {
    return {
      commandId: event.commandId,
      event,
      status: event.status,
      resultRef: event.resultRef ?? null,
      error: event.error ?? null,
      revision: event.revision,
      verificationMode: event.verificationMode ?? 'fixture',
      idempotentReplay: event.idempotentReplay ?? false,
    };
  }

  async function sendCommand(command: Command): Promise<CommandReceipt> {
    if (state !== 'open') {
      throw new KernelClientError('client-closed', 'KernelClient 已关闭（桥通道断开 / 运行时停止），拒绝提交新命令');
    }
    let event: Event;
    try {
      event = await transport.submit(command);
    } catch (error) {
      // 边界错误：命令从未进入执行层。若有订阅者，按断流处理，绝不假装成功。
      deliverBreak(command.commandId, 'submit-rejected', `${BREAK_DETAILS['submit-rejected']}：${messageOf(error)}`);
      throw new KernelClientError('submit-rejected', `命令 ${command.commandId} 提交被内核拒绝`, error);
    }
    // publish 先于 promise 解析：订阅端通常已投递过终局。此处按 seq 去重，补齐漏投。
    if (pending.has(event.commandId)) {
      deliverEvent(event.commandId, event);
    }
    return toReceipt(event);
  }

  function subscribe(commandId: string, onEvent: KernelEventSink, onBreak: KernelBreakSink): () => void {
    if (state !== 'open') {
      throw new KernelClientError('client-closed', 'KernelClient 已关闭，无法订阅');
    }
    if (typeof commandId !== 'string' || commandId.length === 0) {
      throw new TypeError('subscribe 需要非空 commandId');
    }
    const sink: PendingSink = { onEvent, onBreak, lastSeq: 0, lastEvent: null };
    const sinks = pending.get(commandId);
    if (sinks === undefined) {
      pending.set(commandId, [sink]);
    } else {
      sinks.push(sink);
    }
    return () => {
      const current = pending.get(commandId);
      if (current === undefined) return;
      const index = current.indexOf(sink);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) pending.delete(commandId);
    };
  }

  function cancel(commandId: string): boolean {
    if (state !== 'open') return false;
    return transport.cancel(commandId);
  }

  function signalStreamBreak(reason: KernelStreamBreakReason, detail?: string): void {
    if (reason === 'transport-closed' || reason === 'runtime-stopped') {
      close();
    }
    breakAll(reason, detail !== undefined && detail.length > 0 ? detail : BREAK_DETAILS[reason]);
  }

  function stop(): void {
    if (runtime !== null && runtime.state !== 'stopped') {
      runtime.stop();
    }
    signalStreamBreak('runtime-stopped', BREAK_DETAILS['runtime-stopped']);
  }

  return {
    caller,
    get state(): KernelClientState {
      return state;
    },
    get nativeTrust(): TNativeTrust | null {
      return nativeTrust;
    },
    sendCommand,
    subscribe,
    cancel,
    signalStreamBreak,
    stop,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CreateKernelClientFromBridgeOptions<TNativeTrust extends NativeTrustPortShape = NativeTrustPortShape> {
  /** 真实 K01 运行时（`createBootstrapRuntime` 的产物）。 */
  readonly runtime: BootstrapRuntime;
  /** 已钉住的调用方身份（UI 应为 `kind:'ui-webview'`）。 */
  readonly caller: CallerIdentity;
  /** 复用已有桥；缺省用真实 `createLocalUiBridge` 新建。 */
  readonly bridge?: LocalUiBridge;
  /** 传给真实桥的 origin 白名单（缺省 K01 的三个本地 origin）。 */
  readonly allowedOrigins?: readonly string[];
  /** 传给真实桥的调用方种类白名单（UI 传 `['ui-webview']`）。 */
  readonly allowedKinds?: readonly CallerKind[];
  /** 可选注入真实 K07 `AuthorizationLedger` 作为原生信任端口。 */
  readonly nativeTrust?: TNativeTrust | null;
}

/** 便捷装配结果：一个真实运行时 + 一个真实桥 + 一个 `KernelClient`。 */
export interface KernelClientBridgeBundle<TNativeTrust extends NativeTrustPortShape = NativeTrustPortShape> {
  readonly client: KernelClient<TNativeTrust>;
  readonly bridge: LocalUiBridge;
  readonly transport: LocalBridgeTransport;
  readonly runtime: BootstrapRuntime;
  /** 启动内核运行时（幂等）。 */
  start(): void;
  /** 停止运行时并断流（幂等）。 */
  stop(): void;
}

/**
 * 一站式装配：用**真实** `createLocalUiBridge` 包住真实运行时，接上适配器与客户端。
 * 这是"单一原生面"的入口 —— 子包只拿 `bundle.client`，不碰裸桥 / 不用直接 import 桥。
 */
export function createKernelClientFromBridge<TNativeTrust extends NativeTrustPortShape = NativeTrustPortShape>(
  options: CreateKernelClientFromBridgeOptions<TNativeTrust>,
): KernelClientBridgeBundle<TNativeTrust> {
  const { runtime, caller } = options;
  const bridge: LocalUiBridge =
    options.bridge ??
    createLocalUiBridge(runtime, {
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
      ...(options.allowedKinds === undefined ? {} : { allowedKinds: options.allowedKinds }),
    });
  const transport = createLocalBridgeAdapter({ bridge, caller });
  const client = createKernelClient<TNativeTrust>({
    transport,
    caller,
    ...(options.nativeTrust === undefined ? {} : { nativeTrust: options.nativeTrust }),
    runtime,
  });

  return {
    client,
    bridge,
    transport,
    runtime,
    start(): void {
      if (runtime.state === 'stopped') runtime.start();
    },
    stop(): void {
      client.stop();
    },
  };
}
