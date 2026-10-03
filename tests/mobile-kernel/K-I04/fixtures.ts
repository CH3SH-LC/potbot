/**
 * K-I04 集成测试夹具。
 *
 * 这里只装配**真实模块**：宿主（`createKernelHost`）+ K04 会话 + K08 记忆 + K05 派发 +
 * K06 模板 + K07 账本，端口用确定性的内存夹具（记忆端口 / 能力发现 / 四态探针 / 执行器）。
 * 不 mock 任何被交付的模块内部逻辑。
 *
 * 命令构造遵守 `contracts/mobile-v1` 形状（见 `bootstrap/validate.ts`）：模块参数放
 * create/mutation 的 `args`、query 的 `filters`；mutation 分支带 `expectedRevision` +
 * `taskId|conversationId`（由 `makeSession` 按键追踪自动补正）。
 */

import {
  createManualClock,
  type CallerIdentity,
  type Command,
  type Event,
  type EventListener,
  type Subscription,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import { createKernelHost, type KernelHost } from '../../../apps/mobile-kernel/host/index.js';
import {
  createStaticDiscovery,
  type CapabilityDiscoveryPort,
  type Clock as NumericClock,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import {
  MemoryPersistenceBackend,
  type MemoryPersistencePort,
} from '../../../apps/mobile-kernel/memory/index.js';
import type {
  HostPlatform,
  ProbeOutcome,
  ProbeRequest,
  TemplateManifest,
  TemplateProbePort,
} from '../../../apps/mobile-kernel/templates/index.js';
import type {
  ActionBinding,
  ConfirmAction,
  ExternalExecutorPort,
  ExternalSubmitRequest,
  ExecutorOutcome,
} from '../../../apps/mobile-kernel/actions/index.js';

export const CALLER: CallerIdentity = {
  origin: 'app://local',
  kind: 'ui-webview',
  packageName: 'com.potbot.demo',
};

export { createManualClock };

/** 一个合法的契约形状摘要（`^sha256:[0-9a-f]{64}$`）。 */
export const PARAMS_DIGEST = `sha256:${'a'.repeat(64)}`;

/** 手动时钟起点（ISO）与账本期限（epoch 毫秒）。 */
export const T0_ISO = '2026-10-03T00:00:00.000Z';
export const T0_MS = Date.parse(T0_ISO);
export const EXPIRES_AT = T0_MS + 600_000;

// ---------------------------------------------------------------------------
// 命令构造
// ---------------------------------------------------------------------------

export function makeCommand(overrides: Partial<Command> & { payload?: Record<string, unknown> }): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-0001',
    operation: 'create',
    idempotencyKey: 'idem-0001',
    payload: {},
    ...overrides,
    ...(overrides.payload === undefined ? {} : { payload: overrides.payload as Command['payload'] }),
  };
}

/** 与引导层 `targetKey` 同口径，用于按键追踪 revision。 */
export function targetKeyOf(command: Command): string | undefined {
  const payload = command.payload as Record<string, unknown>;
  for (const key of ['targetId', 'id', 'taskId', 'conversationId'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

const MUTATION_OPS = new Set(['mutate', 'apply', 'export', 'undo', 'redo']);

/**
 * 一个桥会话：订阅事件、按键补正 `expectedRevision`、提交命令并记录 revision。
 *
 * `expectedRevision` 是契约的乐观并发槽（`command.schema.json` mutation 分支必需）；
 * 客户端按目标当前版本提交是正常用法，因此这里如实追踪而非绕过运行时守卫。
 */
export function makeSession(host: KernelHost, caller: CallerIdentity = CALLER) {
  const revisions = new Map<string, number>();
  const events: Event[] = [];
  const subscription: Subscription = host.subscribe(caller, (event) => {
    events.push(event);
  });

  return {
    events,
    subscription,
    async submit(command: Command): Promise<Event> {
      const key = targetKeyOf(command);
      let prepared = command;
      if (key !== undefined && MUTATION_OPS.has(command.operation)) {
        prepared = {
          ...command,
          payload: {
            ...(command.payload as Record<string, unknown>),
            expectedRevision: revisions.get(key) ?? 0,
          } as Command['payload'],
        };
      }
      const event = await host.submit(caller, prepared);
      if (key !== undefined) revisions.set(key, event.revision);
      return event;
    },
  };
}

export function subscribeRaw(host: KernelHost, listener: EventListener, caller: CallerIdentity = CALLER): Subscription {
  return host.subscribe(caller, listener);
}

// ---------------------------------------------------------------------------
// 端口夹具
// ---------------------------------------------------------------------------

export function makeMemoryPort(): MemoryPersistencePort {
  return new MemoryPersistenceBackend();
}

export function makeDiscovery(): CapabilityDiscoveryPort {
  return createStaticDiscovery([
    { capability_id: 'order.place', template_id: 'meituan', authorized: true, executable: true },
    { capability_id: 'order.read', template_id: 'meituan', authorized: true, executable: true },
  ]);
}

export function makeProbe(): TemplateProbePort {
  const ok: ProbeOutcome = { ok: true, evidenceRef: 'evidence://probe/fixture' };
  const outcome = (_request: ProbeRequest): ProbeOutcome => ok;
  return {
    identity: 'fixture.probe',
    probeInstalled: outcome,
    probeEnabled: outcome,
    probeAuthorized: outcome,
    probePorts: outcome,
  };
}

export function makeHostPlatform(): HostPlatform {
  return {
    os: 'android',
    apiLevel: 34,
    runtimes: ['node'],
    abis: ['arm64-v8a'],
    capabilities: ['order.place', 'order.read'],
  };
}

export function makeManifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    id: 'meituan',
    displayName: '美团下单模板',
    version: '1.0.0',
    capabilities: ['order.place', 'order.read'],
    schemas: ['mobile-v1/external-receipt'],
    permissions: ['network', 'external-order'],
    runtimeCompatibility: { os: 'android', minimumOs: 26, runtimes: ['node'], abis: ['arm64-v8a'] },
    migration: { from: '', to: '1.0.0', strategy: 'none', reversible: true },
    probe: {
      installed: true,
      enabled: true,
      authorized: true,
      portReady: true,
      verificationMode: 'fixture',
      layers: ['unit', 'contract'],
    },
    ...overrides,
  };
}

/** 执行器：所有 `send` 都返回 `accepted`（happy path）。 */
export function makeAcceptingExecutor(): ExternalExecutorPort {
  return {
    identity: 'fixture.accepting-executor',
    send: (_request: ExternalSubmitRequest): ExecutorOutcome => ({ outcome: 'accepted' }),
  };
}

export interface ControlledExecutor {
  readonly port: ExternalExecutorPort;
  readonly calls: ExternalSubmitRequest[];
  /** 结算当前未决的 `send`（没有未决调用则抛错——避免"没发出却以为发出了"的空壳）。 */
  settle(outcome: ExecutorOutcome): void;
  readonly pending: () => number;
}

/** 执行器：`send` 挂起直到测试显式 `settle`（用于在飞中取消）。 */
export function makeControlledExecutor(): ControlledExecutor {
  const calls: ExternalSubmitRequest[] = [];
  const resolvers: Array<(outcome: ExecutorOutcome) => void> = [];
  const port: ExternalExecutorPort = {
    identity: 'fixture.controlled-executor',
    send(request: ExternalSubmitRequest): Promise<ExecutorOutcome> {
      calls.push(request);
      return new Promise<ExecutorOutcome>((resolve) => {
        resolvers.push(resolve);
      });
    },
  };
  return {
    port,
    calls,
    settle(outcome: ExecutorOutcome): void {
      const resolve = resolvers.shift();
      if (resolve === undefined) throw new Error('没有未决的执行器调用可结算');
      resolve(outcome);
    },
    pending: () => resolvers.length,
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** 让在飞处理器真正进入 `await`（多跑几轮微任务）。 */
export async function settleMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 宿主构建
// ---------------------------------------------------------------------------

export interface TestHostOptions {
  readonly memoryPort?: MemoryPersistencePort;
  readonly executor?: ExternalExecutorPort | null;
  readonly clock?: NumericClock;
  readonly hostPlatform?: HostPlatform;
  readonly probe?: TemplateProbePort;
  readonly discovery?: CapabilityDiscoveryPort;
  readonly start?: boolean;
}

/** 建宿主（默认已 `start()`；`start:false` 用于验证未启动边界）。 */
export async function createTestHost(options: TestHostOptions = {}): Promise<KernelHost> {
  const host = await createKernelHost({
    clock: createManualClock(T0_ISO),
    memoryPort: options.memoryPort ?? makeMemoryPort(),
    capabilityDiscovery: options.discovery ?? makeDiscovery(),
    templateProbe: options.probe ?? makeProbe(),
    hostPlatform: options.hostPlatform ?? makeHostPlatform(),
    ...(options.executor === undefined ? {} : { executor: options.executor }),
  });
  if (options.start !== false) host.start();
  return host;
}

// ---------------------------------------------------------------------------
// K07 确认动作构造（九项绑定 + 期限）
// ---------------------------------------------------------------------------

export function makeActionBinding(overrides: Partial<ActionBinding> = {}): ActionBinding {
  return {
    taskId: 'task-meituan',
    actionId: 'act-1001',
    accountRef: 'acct:meituan:7788',
    taskRevision: 0,
    paramsDigest: PARAMS_DIGEST,
    quoteRef: 'quote-2026-10-03',
    amount: 12900,
    currency: 'CNY',
    scope: 'purchase',
    ...overrides,
  };
}

export function makeConfirmAction(overrides: Partial<ConfirmAction> = {}): ConfirmAction {
  return { ...makeActionBinding(overrides), expiresAt: EXPIRES_AT, ...overrides };
}
