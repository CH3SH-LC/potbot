/**
 * M-I23 测试夹具（不是被收集的用例文件）。
 *
 * 本单元把 M07（下单提交的状态机与**幂等账本**）与 M09（订单生命周期**恢复/查原单**）
 * 缝在一起做一致性核验：
 *
 * - 每一次提交都经**注入的执行器**，观测「执行器真实收到几次请求」；
 * - 每一次恢复/跟踪都经**注入的 M09 查询端口**，观测「问的是哪一个 externalId、问了几次」；
 * - 两条缝都不触网、不读系统时钟、不接真实平台。
 *
 * 「重启」用两种方式落真实：
 * 1. **共享 store 实例**（进程内重启：新提交器 / 新执行器 / 同一账本）；
 * 2. **持久化替身**（跨进程重启：`serializeOrderSubmissionStore` → `restoreOrderSubmissionStore`）。
 *
 * M07 提交记录 → M09 可跟踪意图的桥，走 `order-intent` 包的
 * `persistedOrderIntentFromSubmission`（`providerOrderRef` 即 `externalId`）+
 * `serializePersistedOrderIntent` → `restoreLifecycleTrackerFromIntent`。
 * 这样「M09 resume 查的 externalId」能否与「M07 那一次提交的平台单号」逐字节一致，
 * 是一个可执行断言，而不是一句注释。
 */

import { expect } from 'vitest';

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import {
  OrderSubmitError,
  bindingOf,
  computeIdempotencyKey,
  createAuthorizationRef,
  createFixtureOrderExecutor,
  createFixtureOrderQueryPort as createSubmitQueryPort,
  createInMemoryOrderStore,
  createOrderSubmitter,
  restoreOrderSubmissionStore,
  serializeOrderSubmissionStore,
  type AuthorizationRef,
  type FixtureOrderExecutor,
  type FixtureOrderQueryPort as FixtureSubmitQueryPort,
  type OrderBinding,
  type OrderQueryRequest as SubmitQueryRequest,
  type OrderReceipt,
  type OrderSubmissionRecord,
  type OrderSubmissionStore,
  type OrderSubmitRequest,
  type OrderSubmitter,
  type OrderTransportResult,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import {
  OrderLifecycleTracker,
  createFixtureOrderQueryPort as createLifecycleQueryPort,
  type FixtureOrderQueryPort as FixtureLifecycleQueryPort,
  type OrderQueryResult,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import {
  persistedOrderIntentFromSubmission,
  restoreLifecycleTrackerFromIntent,
  serializePersistedOrderIntent,
} from '../../../src/mobile-plugins/meituan/order-intent/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起算」的错误）。 */
export const T0 = 4_100_000;

/** 默认授权有效期（毫秒，逻辑时钟口径）。 */
export const AUTH_TTL_MS = 300_000;

/** 参数摘要（形状合法，非自证常量：M04 结构指纹格式 `v1-xxxxxxxx`）。 */
export const PARAMS_DIGEST = 'v1-abcdef01';

/** 平台单号（M07 `providerOrderRef` ⇄ M09 `externalId`）。 */
export const EXTERNAL_ID = 'MT-I23-ORDER-0001';

/** M09 fixture 平台状态码：配送中（fixture 本地登记表认识它）。 */
export const DELIVERING_CODE = 'W_DELIVERING';

/** 执行器应答器签名（与 M07 `FixtureOrderExecutorConfig.respond` 一致）。 */
export type Respond = (
  request: OrderSubmitRequest,
  callIndex: number,
) => OrderTransportResult | Promise<OrderTransportResult>;

/** M07 原单查询端口应答器签名。 */
export type SubmitQueryRespond = (
  request: SubmitQueryRequest,
  callIndex: number,
) => OrderReceipt | null | Promise<OrderReceipt | null>;

/** 默认九项绑定。 */
export function baseBinding(overrides: Partial<OrderBinding> = {}): OrderBinding {
  return Object.freeze({
    actionId: 'act-i23',
    merchantId: 'merchant-i23',
    accountRef: 'acct:meituan:7788',
    taskRevision: 1,
    paramsDigest: PARAMS_DIGEST,
    quoteRef: 'quote-i23',
    amount: 4760,
    currency: 'CNY',
    scope: 'submit-order' as const,
    ...overrides,
  });
}

/** 造一个「HTTP 2xx + 业务码 ok」的传输结果。 */
export function successResponse(providerOrderRef: string = EXTERNAL_ID): OrderTransportResult {
  return Object.freeze({
    transport: 'response',
    httpStatus: 200,
    businessCode: 'ok',
    providerOrderRef,
  });
}

export interface SetupOptions {
  readonly clock?: FixtureClock;
  readonly store?: OrderSubmissionStore;
  readonly binding?: Partial<OrderBinding>;
  readonly grantId?: string;
  readonly expiresAt?: number;
  readonly respond?: Respond;
  readonly submitQueryRespond?: SubmitQueryRespond;
  readonly withExecutor?: boolean;
  readonly withSubmitQuery?: boolean;
}

export interface Setup {
  readonly clock: FixtureClock;
  readonly store: OrderSubmissionStore;
  readonly executor: FixtureOrderExecutor | null;
  readonly submitQuery: FixtureSubmitQueryPort | null;
  readonly submitter: OrderSubmitter;
  readonly ref: AuthorizationRef;
  readonly key: string;
}

/** 造一个完整的 M07 提交场景（时钟 / 存储 / 端口都可注入）。 */
export function createSetup(options: SetupOptions = {}): Setup {
  const clock = options.clock ?? new FixtureClock(T0);
  const store = options.store ?? createInMemoryOrderStore();
  const binding = baseBinding(options.binding);
  const ref = createAuthorizationRef({
    grantId: options.grantId ?? 'grant-i23',
    grantedBy: 'native-confirm-surface',
    issuedAt: clock.now(),
    expiresAt: options.expiresAt ?? clock.now() + AUTH_TTL_MS,
    binding,
  });
  const executor =
    options.withExecutor === false
      ? null
      : createFixtureOrderExecutor({ respond: options.respond ?? (() => successResponse()) });
  const submitQuery =
    options.withSubmitQuery === false
      ? null
      : createSubmitQueryPort({ respond: options.submitQueryRespond ?? (() => null) });
  const submitter = createOrderSubmitter({ clock, executor, orderQuery: submitQuery, store });
  return {
    clock,
    store,
    executor,
    submitQuery,
    submitter,
    ref,
    key: computeIdempotencyKey(binding),
  };
}

/** 把提交账本导出为可序列化 JSON 文本（真实持久化介质的替身）。 */
export function snapshotOf(store: OrderSubmissionStore): string {
  return serializeOrderSubmissionStore(store);
}

export interface RestartFromSnapshotOptions {
  readonly binding: OrderBinding;
  readonly clock?: FixtureClock;
  readonly grantId?: string;
  readonly expiresAt?: number;
  readonly respond?: Respond;
  readonly submitQueryRespond?: SubmitQueryRespond;
  readonly withExecutor?: boolean;
  readonly withSubmitQuery?: boolean;
}

/**
 * **跨进程重启**：由一个 JSON 快照重建账本，再装配一套全新的提交器/执行器/查询端口。
 *
 * 幂等键由**同一绑定**重新确定性导出；调用方应断言
 * `restartFromSnapshot(...).key === 原 key`——这正是「重启算不出不同键」的判据。
 */
export function restartFromSnapshot(snapshot: string, options: RestartFromSnapshotOptions): Setup {
  const clock = options.clock ?? new FixtureClock(T0);
  return createSetup({
    clock,
    store: restoreOrderSubmissionStore(snapshot),
    binding: options.binding,
    grantId: options.grantId,
    expiresAt: options.expiresAt ?? clock.now() + AUTH_TTL_MS,
    respond: options.respond,
    submitQueryRespond: options.submitQueryRespond,
    withExecutor: options.withExecutor,
    withSubmitQuery: options.withSubmitQuery,
  });
}

/**
 * M07 → M09 桥：由一条**已确认下单**的提交记录恢复出 M09 跟踪器。
 * 走「序列化 → 恢复」的持久化路径，顺带证明这条桥本身可落盘。
 */
export function bridgeTracker(record: OrderSubmissionRecord): OrderLifecycleTracker {
  const persisted = persistedOrderIntentFromSubmission(record);
  return restoreLifecycleTrackerFromIntent(serializePersistedOrderIntent(persisted));
}

/** 由一条提交记录构造与之逐项相符的 M09 查询结果（默认配送中、未发起退款）。 */
export function lifecycleResultFor(
  record: OrderSubmissionRecord,
  overrides: Partial<OrderQueryResult> = {},
): OrderQueryResult {
  return Object.freeze({
    externalId: record.providerOrderRef ?? EXTERNAL_ID,
    accountRef: record.accountRef,
    amountMinor: record.amount,
    currency: record.currency,
    rawStatusCode: DELIVERING_CODE,
    refundStatusCode: null,
    refundAmountMinor: null,
    observedAt: T0 + 1,
    evidenceRef: 'ev-i23-query-1',
    ...overrides,
  });
}

/** 造一个只回放给定结果的 M09 生命周期查询端口（记录 calls 供断言）。 */
export function lifecyclePort(results: readonly OrderQueryResult[]): FixtureLifecycleQueryPort {
  return createLifecycleQueryPort({ results });
}

/** 断言 Promise 以指定**拒因码**被拒（不是「抛了个错」）。 */
export async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OrderSubmitError);
    expect((error as OrderSubmitError).code).toBe(code);
    return;
  }
  throw new Error(`期望被拒（${code}），但调用成功了`);
}

/** 断言同步调用以指定**拒因码**抛出。 */
export function expectThrowCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OrderSubmitError);
    expect((error as OrderSubmitError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出（${code}），但没有抛错`);
}

/** 断言的辅助：一条 M09 查询端口调用是否「恰好一次、且查的是给定 externalId」。 */
export function queriedExternalIds(port: FixtureLifecycleQueryPort): readonly string[] {
  return port.calls.map((call) => call.externalId);
}

export { bindingOf };
