/**
 * M-I07 集成波次测试夹具（**不是**被收集的用例文件）。
 *
 * 本包是 M07（`src/mobile-plugins/meituan/order-submit`）在集成波次里的一个切片：
 * 落地 M-R04 提出的三条 integrationRequest——
 *   #1 「4xx 拆分：429 可重试限流 / 408 超时 / 409 未知 / 其余 4xx 确定性拒单」（修 DEFECT）；
 *   #2 「网络状态感知：离线 / 发出前失败必须落 `not_sent`，绝不落 `sent_unknown`」；
 *   以及 M07 自己提出的「可序列化存储，让『重启不重复下单』在进程内可证」。
 *
 * 夹具只驱动**注入**时钟与端口，零网络、零系统时间、零随机。
 * `paramsDigest` 用 M04 的真实结构指纹（`computeParamsDigest`），不是自证常量。
 */

import { computeParamsDigest } from '../../../src/mobile-plugins/meituan/cart/digest.js';
import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import {
  computeIdempotencyKey,
  createAuthorizationRef,
  createFixtureOrderExecutor,
  createFixtureOrderQueryPort,
  createInMemoryOrderStore,
  createOrderSubmitter,
  type AuthorizationRef,
  type FixtureOrderExecutor,
  type FixtureOrderQueryPort,
  type OrderBinding,
  type OrderNetworkStatePort,
  type OrderReceipt,
  type OrderSubmissionStore,
  type OrderSubmitRequest,
  type OrderSubmitter,
  type OrderTransportResult,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 5_100_000;

/** 默认授权有效期。 */
export const AUTH_TTL_MS = 300_000;

/** 由 M04 结构指纹算出的参数摘要（真实语义，非自证常量）。 */
export const DEFAULT_PARAMS_DIGEST = computeParamsDigest({
  merchantId: 'merchant-1',
  currency: 'CNY',
  lines: [
    {
      lineId: 'line-1',
      dishId: 'dish-noodle',
      skuId: 'sku-noodle',
      specs: [{ groupId: 'spice', optionId: 'mild' }],
      quantity: 2,
    },
  ],
  delivery: { addressRef: 'addr-home' },
  pricing: { couponCodes: [], serviceOptions: [] },
});

/** 默认九项绑定。 */
export function baseBinding(overrides: Partial<OrderBinding> = {}): OrderBinding {
  return Object.freeze({
    actionId: 'action-1',
    merchantId: 'merchant-1',
    accountRef: 'acct:meituan:7788',
    taskRevision: 3,
    paramsDigest: DEFAULT_PARAMS_DIGEST,
    quoteRef: 'quote-1',
    amount: 8300,
    currency: 'CNY',
    scope: 'submit-order' as const,
    ...overrides,
  });
}

/** 可切换的假网络状态（结构上等价于 M-R04 的 `NetworkMonitor.isOnline()`）。 */
export class FakeNetwork implements OrderNetworkStatePort {
  #online: boolean;
  constructor(online = true) {
    this.#online = online;
  }
  isOnline(): boolean {
    return this.#online;
  }
  setOnline(online: boolean): void {
    this.#online = online;
  }
}

export interface ScenarioOptions {
  readonly binding?: Partial<OrderBinding>;
  readonly grantId?: string;
  readonly expiresAt?: number;
  readonly clock?: FixtureClock;
  readonly respond?: (
    request: OrderSubmitRequest,
    callIndex: number,
  ) => OrderTransportResult | Promise<OrderTransportResult>;
  readonly queryRespond?: (
    request: { readonly idempotencyKey: string },
    callIndex: number,
  ) => OrderReceipt | null | Promise<OrderReceipt | null>;
  readonly withExecutor?: boolean;
  readonly withQueryPort?: boolean;
  readonly store?: OrderSubmissionStore;
  /** 注入网络状态端口；省略即「不检查网络」（旧行为）。 */
  readonly network?: OrderNetworkStatePort | null;
}

export interface Scenario {
  readonly clock: FixtureClock;
  readonly store: OrderSubmissionStore;
  readonly executor: FixtureOrderExecutor | null;
  readonly queryPort: FixtureOrderQueryPort | null;
  readonly network: OrderNetworkStatePort | null;
  readonly submitter: OrderSubmitter;
  readonly ref: AuthorizationRef;
  readonly key: string;
}

/** 造一个完整场景（时钟 / 存储 / 端口 / 网络都可替换）。 */
export function createScenario(options: ScenarioOptions = {}): Scenario {
  const clock = options.clock ?? new FixtureClock(T0);
  const store = options.store ?? createInMemoryOrderStore();
  const binding = baseBinding(options.binding);
  const ref = createAuthorizationRef({
    grantId: options.grantId ?? 'grant-action-1',
    grantedBy: 'native-confirm-surface',
    issuedAt: clock.now(),
    expiresAt: options.expiresAt ?? clock.now() + AUTH_TTL_MS,
    binding,
  });
  const executor =
    options.withExecutor === false
      ? null
      : createFixtureOrderExecutor({
          respond:
            options.respond ??
            ((request) =>
              Object.freeze({
                transport: 'response',
                httpStatus: 200,
                businessCode: 'ok',
                providerOrderRef: `MT-${request.idempotencyKey.slice(-4)}`,
              })),
        });
  const queryPort =
    options.withQueryPort === false
      ? null
      : createFixtureOrderQueryPort({ respond: options.queryRespond ?? (() => null) });
  const network = options.network ?? null;
  const submitter = createOrderSubmitter({ clock, executor, orderQuery: queryPort, store, network });
  return {
    clock,
    store,
    executor,
    queryPort,
    network,
    submitter,
    ref,
    key: computeIdempotencyKey(binding),
  };
}
