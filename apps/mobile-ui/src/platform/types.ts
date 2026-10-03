/**
 * F-I01 `platform/KernelClient` —— 平台层类型与端口。
 *
 * 这个文件是 F 线七个子包（F02/F03/F04/F05/F07/F09/F10）共同要求的**唯一**原生入口的
 * 类型面。它的权威形状有且只有一处：
 *
 *   - 命令 / 事件：`contracts/mobile-v1/types.ts`（v1 契约，**只读消费**，不复制字段）；
 *   - 调用方身份：K01 `apps/mobile-kernel/bootstrap/types.ts` 的 `CallerIdentity`
 *     （**只读消费**，避免 platform 与内核各造一套 origin/kind 词表）。
 *
 * 原生信任端口（K07 `AuthorizationLedger`）刻意用**泛型**注入（{@link NativeTrustPortShape}
 * 为最小结构约束），而不是 import F05 `decisions/trust.ts` 的 `NativeTrustPort`。原因有二：
 *   1. platform 是"单一原生面"，不应把某个业务包（decisions）拖成它的编译依赖；
 *   2. `trust.ts` 以 `import type` 引用真实 K07 账本，若 platform 依赖它，K07 的编译错误会
 *      穿透到 platform 的独立类型检查里（真机内核与本层应当各自可编译）。
 * 泛型让真实账本**原样注入**、调用方拿到原类型，同时本层零耦合。
 *
 * 本文件为**纯类型 + 一个错误类 + 一个运行期守卫**，零外部依赖、不读时钟、不碰网络 /
 * 文件系统 / 随机数。
 *
 * 明确未做（不得当成已完成）：
 *   - 真实 WebView 通道：本层只把 K01 桥包成可注入的 {@link KernelTransport}；
 *     桥通道断开由宿主（Android WebView onDestroy / 内核 stop）通过
 *     {@link KernelClient.signalStreamBreak} 如实上报，本层不自造心跳。
 *   - 持久化与重连：断流后**不**在同一 attempt 上续传，只把未终态标 `progressUnknown`。
 */

import type { CallerIdentity } from '../../../../apps/mobile-kernel/bootstrap/index.js';
import type {
  Command,
  Event,
  EventError,
  EventStatus,
  VerificationMode,
} from '../../../../contracts/mobile-v1/types.js';

export type { CallerIdentity };
export type { Command, Event, EventError, EventStatus, VerificationMode };

// ---------------------------------------------------------------------------
// 原生信任端口（结构化最小约束；K07 AuthorizationLedger 满足）
// ---------------------------------------------------------------------------

/**
 * 原生信任端口的**最小结构约束**：只要求五个方法名存在、可调用。
 *
 * 方法签名一律用 `(...args: never[]) => unknown` —— 这是"任何函数都可赋值给它"的上界
 * （`never` 是每个参数类型的子类型），因此不会伪造或限制 K07 / F05 的真实签名，只做
 * "这确实像个信任端口"的形状闸门。真实账本注入后，调用方按自己的 `NativeTrustPort`
 * （F05 `decisions/trust.ts`）使用 `client.nativeTrust`，类型不丢失。
 */
export interface NativeTrustPortShape {
  readonly recordConfirmAction: (...args: never[]) => unknown;
  readonly getConfirmAction: (...args: never[]) => unknown;
  readonly attest: (...args: never[]) => unknown;
  readonly issueGrant: (...args: never[]) => unknown;
  readonly consume: (...args: never[]) => unknown;
}

const REQUIRED_TRUST_METHODS: readonly (keyof NativeTrustPortShape)[] = [
  'recordConfirmAction',
  'getConfirmAction',
  'attest',
  'issueGrant',
  'consume',
];

/**
 * 运行期结构闸门：注入的信任端口必须五个方法齐备（fail-closed）。
 * 传入 `null` / `undefined` 视为"未注入"，返回 `null`；对象缺方法即抛。
 */
export function assertNativeTrustPort(value: unknown): NativeTrustPortShape | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') {
    throw new TypeError('nativeTrust 必须是对象（K07 AuthorizationLedger）或 null');
  }
  const record = value as Record<string, unknown>;
  for (const name of REQUIRED_TRUST_METHODS) {
    if (typeof record[name] !== 'function') {
      throw new TypeError(`nativeTrust 缺方法 ${name}：不像 K07 AuthorizationLedger`);
    }
  }
  return value as NativeTrustPortShape;
}

// ---------------------------------------------------------------------------
// 客户端状态与订阅
// ---------------------------------------------------------------------------

/** 客户端状态。`closed` = 桥通道已断（或运行时已停），不再受理新命令。 */
export type KernelClientState = 'open' | 'closed';

/** 事件接收器：收到该命令的一条内核 `Event`（含中间进度与终局）。 */
export type KernelEventSink = (event: Event) => void;

/** 退订句柄（`subscribe` 的返回值）。 */
export interface KernelSubscription {
  unsubscribe(): void;
}

/** 断流原因。**每一种都必须落到 `progressUnknown`，绝不升级为成功。** */
export type KernelStreamBreakReason =
  /** 桥通道关闭（WebView 卸载 / 原生侧断开）。 */
  | 'transport-closed'
  /** 内核运行时停止（stop 中止在飞命令，且不发终局事件）。 */
  | 'runtime-stopped'
  /** 事件流 `seq` 出现空洞（丢事件），流已不可信。 */
  | 'sequence-gap'
  /** 收到 `status=succeeded` 但缺 `resultRef` 的坏事件（fail-closed）。 */
  | 'invalid-terminal'
  /** 提交本身被内核拒绝（形状 / origin / 未启动），命令从未进入执行层。 */
  | 'submit-rejected';

/**
 * 断流信息。`status` **恒为** `progressUnknown`：断流只表示"结果未知"，不是失败也不是成功。
 * `lastEvent` 是断流前该命令收到的最后一条事件（没有则为 `null`），供 UI 展示。
 */
export interface KernelStreamBreak {
  readonly commandId: string;
  readonly reason: KernelStreamBreakReason;
  readonly status: 'progressUnknown';
  readonly detail: string;
  readonly lastEvent: Event | null;
}

/** 断流接收器。 */
export type KernelBreakSink = (info: KernelStreamBreak) => void;

// ---------------------------------------------------------------------------
// 传输端口（真实 LocalUiBridge 的结构化封装）
// ---------------------------------------------------------------------------

/** 传输层上报的断流通知（未绑定到具体命令，由客户端按在飞命令展开）。 */
export interface KernelTransportBreakNotice {
  readonly reason: KernelStreamBreakReason;
  readonly detail: string;
}

/**
 * 传输端口 —— `KernelClient` 唯一依赖的外部面。
 *
 * `local-bridge-adapter.ts` 把 K01 的真实 `LocalUiBridge`（`submit/subscribe/cancel`）
 * 适配成本接口，并补一个 `onBreak`：真实桥本身不通报通道生死，由宿主把断流注入。
 */
export interface KernelTransport {
  /** 提交一条命令，解析为其**终局**事件；边界非法时 reject。 */
  submit(command: unknown): Promise<Event>;
  /** 订阅**全局**事件流。 */
  subscribe(listener: KernelEventSink): KernelSubscription;
  /** 中止在飞命令；命中返回 `true`。 */
  cancel(commandId: string): boolean;
  /** 订阅桥通道断流通知；返回退订句柄。 */
  onBreak(listener: (notice: KernelTransportBreakNotice) => void): KernelSubscription;
}

// ---------------------------------------------------------------------------
// 命令回执
// ---------------------------------------------------------------------------

/** `sendCommand` 的回执：对内核返回的终局事件做一次规范化投影，字段一律显式。 */
export interface CommandReceipt {
  readonly commandId: string;
  /** 内核返回的终局事件原文（不裁剪、不改写）。 */
  readonly event: Event;
  readonly status: EventStatus;
  /** `succeeded` 时必有；其余为 `null`（fail-closed：没有就是没有）。 */
  readonly resultRef: string | null;
  readonly error: EventError | null;
  readonly revision: number;
  readonly verificationMode: VerificationMode;
  readonly idempotentReplay: boolean;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/**
 * F 线唯一的原生调用面：提交 / 订阅 / 取消 / 断流上报。
 *
 * `TNativeTrust` 是注入的原生信任端口类型（真实 K07 `AuthorizationLedger`）。泛型让本层
 * 不依赖 decisions/K07；调用方（F05）用自己导入的 `submitThroughNativeTrust(card, req,
 * client.nativeTrust)` 消费它——类型在调用方那侧保持精确。
 */
export interface KernelClient<TNativeTrust extends NativeTrustPortShape = NativeTrustPortShape> {
  /** 构造时钉住的调用方身份（只读；调用方无法改写）。 */
  readonly caller: CallerIdentity;
  readonly state: KernelClientState;
  /** 注入的原生信任端口（真实 K07 账本）；未注入为 `null`。 */
  readonly nativeTrust: TNativeTrust | null;
  /** 提交命令 → 规范化回执；边界非法时 reject {@link KernelClientError}。 */
  sendCommand(command: Command): Promise<CommandReceipt>;
  /** 按 `commandId` 订阅事件流；断流时 `onBreak` 收到 `progressUnknown`。返回退订函数。 */
  subscribe(commandId: string, onEvent: KernelEventSink, onBreak: KernelBreakSink): () => void;
  /** 中止在飞命令；命中返回 `true`。 */
  cancel(commandId: string): boolean;
  /** 宿主上报桥通道断流（WebView 卸载 / 内核停止 / 通道丢失）。 */
  signalStreamBreak(reason: KernelStreamBreakReason, detail?: string): void;
  /** 停止运行时（若已注入）并对所有在飞命令断流。 */
  stop(): void;
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type KernelClientErrorCode =
  /** 客户端已关闭（桥通道断开 / 运行时停止）。 */
  | 'client-closed'
  /** 提交被内核拒绝（形状非法 / origin 被拒 / 运行时未启动）。 */
  | 'submit-rejected';

/** `KernelClient` 的结构化错误（`cause` 保留内核原始错误，便于如实上报）。 */
export class KernelClientError extends Error {
  readonly code: KernelClientErrorCode;

  constructor(code: KernelClientErrorCode, message: string, cause: unknown = null) {
    super(message);
    this.name = 'KernelClientError';
    this.code = code;
    if (cause !== null && cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export function isKernelClientError(value: unknown): value is KernelClientError {
  return value instanceof KernelClientError;
}
