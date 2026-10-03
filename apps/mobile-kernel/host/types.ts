/**
 * K-I04 宿主装配 —— 类型。
 *
 * `KernelHost` 是本单元交付的**手机内核宿主**：把 K01 引导层（`createBootstrapRuntime` +
 * `createLocalUiBridge`）与五个真实业务模块适配器（K04 对话 / K08 记忆 / K05 派发 /
 * K06 模板 / K07 账本）装到一起，并暴露启动 / 关闭生命周期与桥的三个入口。
 *
 * 依赖全部由调用方注入（时钟、存储端口、探针端口、执行器/查单端口、平台描述），
 * 因此宿主在测试里可确定性驱动、在真机里由 Android Service 装配。宿主**不**读墙钟、
 * **不** import `node:*`。
 */

import type {
  BootstrapModule,
  BootstrapRuntime,
  CallerIdentity,
  CallerKind,
  Clock,
  Event,
  EventListener,
  LocalUiBridge,
  Subscription,
  VerificationMode,
} from '../bootstrap/index.js';
import type { MobileConversationPersistencePort, MobileConversationStore } from '../conversation/index.js';
import type { CapabilityDiscoveryPort, Clock as NumericClock } from '../dispatch/index.js';
import type { MemoryPersistencePort, PhoneMemoryStore } from '../memory/index.js';
import type { HostPlatform, TemplateLifecycle, TemplateProbePort } from '../templates/index.js';
import type { AuthorizationLedger, ExternalExecutorPort, OrderQueryPort } from '../actions/index.js';

export type { NumericClock };

export interface KernelHostOptions {
  /** 必需：注入时钟。引导层要 ISO 串；模板/派发/账本用其 epoch 数字视图（宿主内部换算）。 */
  readonly clock: Clock;
  /** 默认写入事件的验证模式；缺省 `fixture`（不签发真实外部完成）。 */
  readonly verificationMode?: VerificationMode;
  /** 桥的本地 origin 白名单；缺省用 K01 的 `DEFAULT_ALLOWED_ORIGINS`。 */
  readonly allowedOrigins?: readonly string[];
  /** 桥允许的调用方种类；缺省全部允许。 */
  readonly allowedKinds?: readonly CallerKind[];

  /** 必需：K08 记忆库的窄持久化端口（三值读：ok / not_found / failed）。 */
  readonly memoryPort: MemoryPersistencePort;
  /** 记忆库在介质上的 key；缺省 K08 的 `DEFAULT_MEMORY_KEY`。 */
  readonly memoryKey?: string;
  /** 可选：K04 会话持久端口（缺省内存态，刷新不保证还在）。 */
  readonly conversationPersistence?: MobileConversationPersistencePort | null;

  /** 必需：K05 能力发现端口（真机由 K06 模板平台探针供应）。 */
  readonly capabilityDiscovery: CapabilityDiscoveryPort;
  /** 必需：K06 四态探针端口（真机上是异步的：查包管理器 / 端口 / 权限）。 */
  readonly templateProbe: TemplateProbePort;
  /** 必需：K06 宿主平台描述（运行时兼容判定的对照面）。 */
  readonly hostPlatform: HostPlatform;

  /** 可选：K07 真实执行器端口；缺省 ⇒ `send` 抛 `missing_executor`（不留下发出痕迹）。 */
  readonly executor?: ExternalExecutorPort | null;
  /** 可选：K07 原单查询端口；缺省 ⇒ 结果未知时抛 `missing_order_query_port`。 */
  readonly orderQuery?: OrderQueryPort | null;

  /** K05 缺省并发上限（`args.maxParallel` 未给时用）。缺省 4。 */
  readonly defaultMaxParallel?: number;
}

export interface KernelHost {
  /** 引导层运行时（启动/关闭、路由、扇出、幂等、revision 守卫、取消）。 */
  readonly runtime: BootstrapRuntime;
  /** 受限本地 UI 桥（submit / subscribe / cancel + 调用方校验）。 */
  readonly bridge: LocalUiBridge;
  /** 注册进运行时的业务模块（互不重叠地认领 operation）。 */
  readonly modules: readonly BootstrapModule[];
  /** 注入时钟（透出，便于调用方对齐时间）。 */
  readonly clock: Clock;

  // 业务模块实例（供集成方直接读回证据；宿主不复制其状态）。
  readonly conversation: MobileConversationStore;
  readonly memory: PhoneMemoryStore;
  readonly templates: TemplateLifecycle;
  readonly actions: AuthorizationLedger;

  /** 启动运行时。重复启动抛 `RUNTIME_ALREADY_RUNNING`。 */
  start(): void;
  /** 关闭运行时：中止在飞命令并拒绝后续 dispatch。 */
  stop(): void;

  submit(caller: CallerIdentity, command: unknown): Promise<Event>;
  subscribe(caller: CallerIdentity, listener: EventListener): Subscription;
  cancel(caller: CallerIdentity, commandId: string): boolean;
}
