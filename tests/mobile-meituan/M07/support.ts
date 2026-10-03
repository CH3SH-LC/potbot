/**
 * M07 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景都由**显式 fixture** 驱动：可控时钟（复用 M04 的 `FixtureClock`）+
 * 脚本化执行器 + 脚本化原单查询端口。这里没有任何真实美团接口、没有网络、没有系统时间。
 *
 * `paramsDigest` 用 **M04 的真实结构指纹**（`computeParamsDigest`）而不是随手编的常量，
 * 这样"M07 的授权绑定的是 M04 算出来的参数"是真实语义，不是自证。
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
  type OrderReceipt,
  type OrderSubmissionStore,
  type OrderSubmitRequest,
  type OrderSubmitter,
  type OrderTransportResult,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 4_000_000;

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

export interface ScenarioOptions {
  readonly binding?: Partial<OrderBinding>;
  readonly grantId?: string;
  readonly grantedBy?: string;
  readonly expiresAt?: number;
  readonly clock?: FixtureClock;
  /** 省略即用「业务码 ok、HTTP 200」的成功 fixture。 */
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
}

export interface Scenario {
  readonly clock: FixtureClock;
  readonly store: OrderSubmissionStore;
  readonly executor: FixtureOrderExecutor | null;
  readonly queryPort: FixtureOrderQueryPort | null;
  readonly submitter: OrderSubmitter;
  readonly ref: AuthorizationRef;
  readonly key: string;
}

/** 造一个完整场景（时钟 / 存储 / 端口都可替换）。 */
export function createScenario(options: ScenarioOptions = {}): Scenario {
  const clock = options.clock ?? new FixtureClock(T0);
  const store = options.store ?? createInMemoryOrderStore();
  const binding = baseBinding(options.binding);
  const ref = createAuthorizationRef({
    grantId: options.grantId ?? 'grant-action-1',
    grantedBy: options.grantedBy ?? 'native-confirm-surface',
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
      : createFixtureOrderQueryPort({
          respond: options.queryRespond ?? ((request) => null),
        });
  const submitter = createOrderSubmitter({ clock, executor, orderQuery: queryPort, store });
  return {
    clock,
    store,
    executor,
    queryPort,
    submitter,
    ref,
    key: computeIdempotencyKey(binding),
  };
}

/** 用**同一份存储**再造一个提交器（模拟进程重启：新实例、新端口、共享记录）。 */
export function restartScenario(
  previous: Scenario,
  options: ScenarioOptions = {},
): Scenario {
  const clock = options.clock ?? previous.clock;
  const store = options.store ?? previous.store;
  const executor =
    options.withExecutor === false
      ? null
      : createFixtureOrderExecutor({
          respond:
            options.respond ??
            (() => Object.freeze({ transport: 'response', httpStatus: 200, businessCode: 'ok', providerOrderRef: 'MT-RESTART' })),
        });
  const queryPort =
    options.withQueryPort === false
      ? null
      : createFixtureOrderQueryPort({ respond: options.queryRespond ?? (() => null) });
  const submitter = createOrderSubmitter({ clock, executor, orderQuery: queryPort, store });
  return { clock, store, executor, queryPort, submitter, ref: previous.ref, key: previous.key };
}
