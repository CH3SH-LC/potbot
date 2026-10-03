/**
 * K01 —— 手机内核引导层对外出口。
 *
 * 交付内容（对应 KERNEL.md K01 行）：
 *   - APK 内 JS/业务宿主：`createBootstrapRuntime`（启动/关闭、命令路由、事件扇出、
 *     幂等、revision 守卫、取消）；
 *   - 受限本地 UI 桥：`createLocalUiBridge`（提交/订阅/取消 + 调用方与本地 origin 校验）；
 *   - 载荷安全扫描：`scanPayload`（不暴露密钥/任意文件/代码执行）。
 *
 * 零依赖纯 TS，不 import node 内建，可在 QuickJS / V8 / Node 里加载。
 * 命令/事件形状只读消费 `contracts/mobile-v1`（v1 契约），不复制其字段定义。
 *
 * 用法与验证见同目录 `README.md`（含 arm64 真机 spike 计划与确切命令）。
 */

export {
  BOOTSTRAP_ERROR_CODES,
  BootstrapError,
  bootstrapError,
  isBootstrapError,
  type BootstrapErrorCode,
  type BootstrapIssue,
} from './errors.js';

export {
  COMMAND_OPERATIONS,
  CREATE_OPERATIONS,
  MUTATION_OPERATIONS,
  QUERY_OPERATIONS,
  validateCommand,
  type CommandValidation,
} from './validate.js';

export { FORBIDDEN_CODE_KEYS, FORBIDDEN_KEYS, scanPayload } from './guard.js';

export {
  DEFAULT_ALLOWED_ORIGINS,
  assertCaller,
  isAllowedOrigin,
  normalizeOrigin,
} from './origin.js';

export { createBootstrapRuntime } from './runtime.js';
export { createLocalUiBridge } from './bridge.js';

export {
  createManualClock,
  type BootstrapModule,
  type BootstrapRuntime,
  type BootstrapRuntimeOptions,
  type CallerIdentity,
  type CallerKind,
  type Clock,
  type Command,
  type CommandOperation,
  type Event,
  type EventError,
  type EventListener,
  type EventStatus,
  type LocalUiBridge,
  type LocalUiBridgeOptions,
  type OperationContext,
  type OperationHandler,
  type OperationOutcome,
  type ProgressEmit,
  type RuntimeState,
  type SchemaVersion,
  type Subscription,
  type VerificationMode,
} from './types.js';
