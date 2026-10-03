/**
 * M-I17 测试夹具（不是被收集的用例文件）。
 *
 * 本单元是**集成切片**：把 M-R04 的网络韧性模型**提升为生产源码**
 * （`src/mobile-plugins/meituan/network-resilience/`），并验证它与 M-I02
 * （`src/mobile-plugins/meituan/mobile-transport/`）实际发出的 `NetworkOutcome`
 * 形状**可互操作**。
 *
 * 两条独立的夹具轨道：
 *  1. **韧性发送轨道**（{@link createSenderScenario}）：注入可控时钟 / 记录式 sleeper /
 *     脚本化传输端口，直接驱动提升后的 `ResilientSender`。
 *  2. **M-I02 传输轨道**（{@link createTransportScenario}）：用 M02 的 `TransportClient`
 *     走完一条真实调用链（白名单 → 会话 → 凭证 → 原生端口 → 协议），只取它发出的
 *     `NetworkOutcome`，证明提升后的 `classifyOutcome` / `planSubmitRecovery` 可直接消费。
 *
 * 这里没有真实美团接口、没有网络、没有系统时间、没有随机数。官方 host 用 `.test`
 * 保留域；令牌材质是测试占位符，**不是任何真实密钥**。
 */

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import {
  createBusinessCodeTable,
  createEndpointPolicy,
  RawTransportFault,
  SessionManager,
  TransportClient,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import type {
  CredentialResolverPort,
  NetworkErrorPhase,
  RawTransportFaultKind,
  RawTransportRequest,
  RawTransportResponse,
  SessionMinterPort,
  TransportClientOptions,
  TransportCredential,
  TransportPort,
} from '../../../src/mobile-plugins/meituan/mobile-transport/index.js';
import {
  DEFAULT_READ_RETRY_POLICY,
  DEFAULT_SUBMIT_RETRY_POLICY,
  NetworkMonitor,
  ResilientSender,
} from '../../../src/mobile-plugins/meituan/network-resilience/index.js';
import type {
  NetworkKind,
  NetworkOutcome,
  RawTransportPort,
  RetryPolicy,
  Sleeper,
} from '../../../src/mobile-plugins/meituan/network-resilience/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 5_000_000;

// ---------------------------------------------------------------------------
// 韧性发送轨道（直接驱动提升后的 ResilientSender）
// ---------------------------------------------------------------------------

/** 记录式 sleeper：不真实等待，记录每次等待时长（确定性、可断言）。 */
export interface RecordingSleeper extends Sleeper {
  readonly waits: readonly number[];
  readonly totalMs: number;
}

export function createRecordingSleeper(onSleep?: (ms: number, index: number) => void): RecordingSleeper {
  const waits: number[] = [];
  return {
    get waits(): readonly number[] {
      return Object.freeze([...waits]);
    },
    get totalMs(): number {
      return waits.reduce((sum, value) => sum + value, 0);
    },
    sleep(ms: number): Promise<void> {
      const index = waits.length;
      waits.push(ms);
      onSleep?.(ms, index);
      return Promise.resolve();
    },
  };
}

/**
 * 脚本化传输端口：按调用序号回放结果。
 *
 * `beforeCall` 可在**每次发送前**改写网络状态（用来模拟"重试等待期间切网/掉线"）。
 * 超出脚本长度的调用返回最后一项（便于断言"不该发生的调用"）。
 */
export interface FixtureTransport extends RawTransportPort {
  readonly calls: readonly string[];
}

export interface FixtureTransportConfig {
  readonly script: readonly NetworkOutcome[];
  readonly identity?: string;
  readonly beforeCall?: (callIndex: number) => void;
}

export function createFixtureTransport(config: FixtureTransportConfig): FixtureTransport {
  if (config === null || typeof config !== 'object' || !Array.isArray(config.script) || config.script.length === 0) {
    throw new Error('fixture 传输端口必须给出非空 script');
  }
  const calls: string[] = [];
  return {
    identity: config.identity ?? 'fixture-transport',
    get calls(): readonly string[] {
      return Object.freeze([...calls]);
    },
    send(ref: string): NetworkOutcome {
      const index = calls.length;
      calls.push(ref);
      config.beforeCall?.(index);
      const last = config.script[config.script.length - 1];
      const outcome = config.script[Math.min(index, config.script.length - 1)] ?? last;
      if (outcome === undefined) {
        throw new Error('fixture 传输端口没有可回放的结果');
      }
      return outcome;
    },
  };
}

export interface SenderScenario {
  readonly clock: FixtureClock;
  readonly monitor: NetworkMonitor;
  readonly transport: FixtureTransport;
  readonly sleeper: RecordingSleeper;
  readonly sender: ResilientSender;
}

export interface SenderScenarioOptions {
  readonly script: readonly NetworkOutcome[];
  readonly initialNetwork?: NetworkKind;
  readonly beforeCall?: (callIndex: number) => void;
  readonly readPolicy?: RetryPolicy;
  readonly submitPolicy?: RetryPolicy;
  readonly clock?: FixtureClock;
  readonly jitterFn?: (() => number) | null;
  /** 每次等待后被调用（可在此改写 `monitor`，模拟"重试等待期间切网/掉线"）。 */
  readonly sleeperHook?: (ms: number, index: number, monitor: NetworkMonitor) => void;
}

/** 造一个完整的韧性发送场景。 */
export function createSenderScenario(options: SenderScenarioOptions): SenderScenario {
  const clock = options.clock ?? new FixtureClock(T0);
  const monitor = new NetworkMonitor({ clock, initial: options.initialNetwork ?? 'wifi' });
  const transport = createFixtureTransport({ script: options.script, beforeCall: options.beforeCall });
  const sleeper = createRecordingSleeper((ms, index) => {
    options.sleeperHook?.(ms, index, monitor);
  });
  const sender = new ResilientSender({
    clock,
    monitor,
    transport,
    sleeper,
    readPolicy: options.readPolicy ?? DEFAULT_READ_RETRY_POLICY,
    submitPolicy: options.submitPolicy ?? DEFAULT_SUBMIT_RETRY_POLICY,
    jitterFn: options.jitterFn ?? null,
  });
  return { clock, monitor, transport, sleeper, sender };
}

// ---------------------------------------------------------------------------
// M-I02 传输轨道（真实走完 M02 TransportClient 调用链）
// ---------------------------------------------------------------------------

/** 假官方 host（**非真实域名**，`.test` 保留域）。 */
export const OFFICIAL_HOST = 'api.example-authorized.test';

export const TEST_KEY_REF = 'keyref:meituan-demo-primary';
export const TEST_ACCOUNT_REF = 'acct:test-user';

/** 占位令牌材质：**不是任何真实密钥**，仅用于让调用链可跑通。 */
const PLACEHOLDER_TOKEN = 'test-token-placeholder';
const PLACEHOLDER_MATERIAL = 'test-material-not-a-real-key';

/** 脚本化步骤：一次 HTTP 响应，或一次原生端口故障。 */
export type ScriptedStep =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'fault'; readonly fault: RawTransportFaultKind; readonly phase?: NetworkErrorPhase };

export interface ScriptedTransport extends TransportPort {
  callCount(): number;
}

/** 脚本化原生传输端口：按序回放响应 / 故障。 */
export function createScriptedTransport(steps: readonly ScriptedStep[]): ScriptedTransport {
  let index = 0;
  return Object.freeze({
    async send(_request: RawTransportRequest): Promise<RawTransportResponse> {
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        throw new RawTransportFault('network_error', `脚本已用尽（第 ${index} 次）`, 'during_send');
      }
      if (step.kind === 'fault') {
        throw new RawTransportFault(step.fault, `假故障：${step.fault}`, step.phase ?? 'during_send');
      }
      return Object.freeze({
        status: step.status,
        headers: Object.freeze({ ...(step.headers ?? {}) }),
        bodyText: JSON.stringify(step.body),
      });
    },
    callCount(): number {
      return index;
    },
  }) as ScriptedTransport;
}

export interface TransportScenario {
  readonly client: TransportClient;
  readonly transport: ScriptedTransport;
  readonly session: SessionManager;
}

/** 组装一条 M-I02 传输调用链（无真实网络、无真实凭证）。 */
export function createTransportScenario(steps: readonly ScriptedStep[]): TransportScenario {
  const transport = createScriptedTransport(steps);
  const resolver: CredentialResolverPort = Object.freeze({
    async resolve(keyRef: string): Promise<TransportCredential> {
      return Object.freeze({ keyRef, material: PLACEHOLDER_MATERIAL });
    },
  });
  let minted = 0;
  const minter: SessionMinterPort = Object.freeze({
    async mint(input: {
      readonly keyRef: string;
      readonly accountRef: string;
      readonly credential: TransportCredential;
      readonly now: number;
      readonly previousTokenRef: string | null;
    }) {
      minted += 1;
      return Object.freeze({
        tokenRef: `sessref:mi17-t${minted}`,
        token: PLACEHOLDER_TOKEN,
        scopes: Object.freeze(['meituan.query', 'meituan.order']),
        expiresAt: input.now + 60 * 60 * 1000,
        refreshable: true,
      });
    },
  });
  const session = new SessionManager(minter);
  const client = new TransportClient({
    policy: createEndpointPolicy([OFFICIAL_HOST]),
    session,
    credentialResolver: resolver,
    transport,
    businessCodes: createBusinessCodeTable([
      { code: 'ok', kind: 'success' },
      { code: 'sold_out', kind: 'business_failure' },
    ]),
    defaultTimeoutMs: 10_000,
  } satisfies TransportClientOptions);
  return { client, transport, session };
}

/** 打开标准会话（M-I02 轨道用）。 */
export async function openTransportSession(session: SessionManager, now = T0): Promise<void> {
  await session.open({
    keyRef: TEST_KEY_REF,
    accountRef: TEST_ACCOUNT_REF,
    credential: { keyRef: TEST_KEY_REF, material: PLACEHOLDER_MATERIAL },
    now,
  });
}

/** 标准请求描述符。 */
export function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    keyRef: TEST_KEY_REF,
    method: 'POST' as const,
    host: OFFICIAL_HOST,
    path: '/v1/x',
    body: {},
    ...overrides,
  };
}
