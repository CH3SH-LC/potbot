/**
 * K01 —— 引导层类型。
 *
 * **只读消费** `contracts/mobile-v1/types.ts`（v1 契约类型），不复制其字段定义：
 * 命令/事件的权威形状在 `contracts/mobile-v1/schemas/*.json`，本文件只补引导层
 * 自己的注入口（时钟、模块、桥、调用方身份）。
 *
 * 时间一律经**注入时钟**（契约《金额与时间编码》第 4 条），禁止实现里直接读系统时间，
 * 好让"过期/顺序"可被确定性测试。
 */

import type {
  Command,
  CommandOperation,
  Event,
  EventError,
  EventStatus,
  SchemaVersion,
  VerificationMode,
} from '../../../contracts/mobile-v1/types.js';

export type {
  Command,
  CommandOperation,
  Event,
  EventError,
  EventStatus,
  SchemaVersion,
  VerificationMode,
};

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

/** 注入时钟：返回 UTC ISO-8601（`YYYY-MM-DDTHH:MM:SS[.ffffff]Z`）。 */
export interface Clock {
  now(): string;
}

/** 确定性手动时钟：从给定起点按 `stepMs` 递增。测试用，不读墙钟。 */
export function createManualClock(startIso = '2026-10-03T00:00:00.000Z', stepMs = 1): Clock & { advance(ms?: number): string } {
  let current = Date.parse(startIso);
  if (Number.isNaN(current)) throw new Error(`invalid startIso: ${startIso}`);
  return {
    now(): string {
      const iso = new Date(current).toISOString();
      current += stepMs;
      return iso;
    },
    advance(ms = stepMs): string {
      current += ms;
      return new Date(current).toISOString();
    },
  };
}

// ---------------------------------------------------------------------------
// 调用方身份（本地 origin 校验的输入）
// ---------------------------------------------------------------------------

/** 调用方种类。UI 只应来自本地 WebView；原生与测试各有自己的种类。 */
export type CallerKind = 'ui-webview' | 'native' | 'test';

export interface CallerIdentity {
  /** 本地 origin，如 `app://local` / `file:///android_asset` / `https://localhost`。 */
  readonly origin: string;
  readonly kind?: CallerKind;
  /** 调用方包名（Android 侧透传；用于审计，不参与信任判定）。 */
  readonly packageName?: string;
}

// ---------------------------------------------------------------------------
// 事件订阅
// ---------------------------------------------------------------------------

export type EventListener = (event: Event) => void;

export interface Subscription {
  readonly id: string;
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// 业务模块（可嵌入的 JS 业务宿主按 operation 声明能力）
// ---------------------------------------------------------------------------

/** 处理器可主动发出的进度事件（中间状态，不终局）。 */
export interface ProgressEmit {
  readonly status: EventStatus;
  readonly revision?: number;
  readonly error?: EventError;
}

/** 处理器返回的终局结果。 */
export interface OperationOutcome {
  readonly status: EventStatus;
  readonly resultRef?: string;
  readonly error?: EventError;
  readonly revision?: number;
  readonly verificationMode?: VerificationMode;
}

export interface OperationContext {
  readonly command: Command;
  /** 取消信号：处理器应观察它并尽快返回；引导层在 settle 时会以 signal 为准覆盖状态。 */
  readonly signal: AbortSignal;
  readonly now: string;
  /** 发中间进度事件（进入事件流，递增 seq）。 */
  emit(progress: ProgressEmit): void;
}

export type OperationHandler = (
  command: Command,
  ctx: OperationContext,
) => OperationOutcome | Promise<OperationOutcome>;

/** 一个业务模块声明它认领哪些 operation，并实现处理逻辑。 */
export interface BootstrapModule {
  readonly id: string;
  readonly operations: readonly CommandOperation[];
  readonly handle: OperationHandler;
}

// ---------------------------------------------------------------------------
// 运行时 / 桥
// ---------------------------------------------------------------------------

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'stopping';

export interface BootstrapRuntimeOptions {
  /** 必需：注入时钟（确定性测试的关键）。 */
  readonly clock: Clock;
  /** 默认写入事件的验证模式；缺省 `fixture`（不签发真实外部完成）。 */
  readonly verificationMode?: VerificationMode;
}

export interface BootstrapRuntime {
  readonly state: RuntimeState;
  start(): void;
  stop(): void;
  /** 注册业务模块；operation 已被别的模块认领 ⇒ 抛 MODULE_CONFLICT（不许静默覆盖）。 */
  registerModule(module: BootstrapModule): void;
  /** 执行一条已通过形状校验的命令，返回终局事件。未启动 / 校验失败会抛边界错误。 */
  dispatch(command: unknown): Promise<Event>;
  subscribe(listener: EventListener): Subscription;
  /** 中止在飞命令（按 commandId）；命中返回 true。 */
  cancelInFlight(commandId: string): boolean;
  /** 当前在飞 commandId 列表（只读快照）。 */
  inFlight(): readonly string[];
}

export interface LocalUiBridgeOptions {
  /** 允许的本地 origin 白名单；缺省 `DEFAULT_ALLOWED_ORIGINS`。 */
  readonly allowedOrigins?: readonly string[];
  /** 允许的调用方种类；缺省全部允许（origin 已足够）。 */
  readonly allowedKinds?: readonly CallerKind[];
}

export interface LocalUiBridge {
  submit(caller: CallerIdentity, command: unknown): Promise<Event>;
  subscribe(caller: CallerIdentity, listener: EventListener): Subscription;
  /** 中止在飞命令；返回是否命中。 */
  cancel(caller: CallerIdentity, commandId: string): boolean;
}
