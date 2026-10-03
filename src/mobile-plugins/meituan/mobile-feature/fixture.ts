/**
 * M10 的 **fixture 实现**：一套可独立跑通旅程的注入端口 + 一条驱动脚本。
 *
 * ## 这不是真实美团能力
 *
 * 复用 M04 的 `FixtureQuotePort`、M07 的 `FixtureOrderExecutor` / `FixtureOrderQueryPort`
 * 与确定性 `FixtureClock`。**零网络**；所有"成功"都来自显式 fixture 配置，不构成真实
 * 报价、订单或支付回执。
 *
 * ## "可以跑通全部状态"的准确含义
 *
 * `driveFixtureJourney()` 会用 fixture 宿主记录**fixture 能到达的全部阶段**：
 * `capability_discovered / on_device_transport / user_authorized / order_submitted /
 * order_readback`。它**故意不记录** `payment_confirmed`——fixture 台账会拒（见
 * `evidence.ts`），这正是"fixture 与真实旅程分开"的可执行证明。
 */

import { computeParamsDigest } from '../cart/digest.js';
import { FixtureClock, createFixtureQuotePort, type FixtureQuotePort } from '../cart/fixture.js';
import {
  createFixtureOrderExecutor,
  createFixtureOrderQueryPort,
  type FixtureOrderExecutor,
  type FixtureOrderQueryPort,
} from '../order-submit/index.js';
import { createFixtureFeatureHost, type FeatureHost, type FeatureHostPorts } from './host.js';
import { unverifiedMatrix, type CapabilityMatrix, type JourneyStage } from './types.js';
import type { EvidenceSummary } from './types.js';

/** 逻辑时间起点（非零，用来暴露"偷偷按 0 起算"的错误）。 */
export const FIXTURE_T0 = 1_700_000_000_000;

/** fixture 宿主**能**记录的阶段（`payment_confirmed` 结构性缺席）。 */
export const FIXTURE_RECORDABLE_STAGES: readonly JourneyStage[] = Object.freeze([
  'capability_discovered',
  'on_device_transport',
  'user_authorized',
  'order_submitted',
  'order_readback',
]);

export interface FixtureJourneyPorts {
  readonly ports: FeatureHostPorts;
  readonly clock: FixtureClock;
  readonly quote: FixtureQuotePort;
  readonly executor: FixtureOrderExecutor;
  readonly query: FixtureOrderQueryPort;
}

/** 造一套 fixture 端口（报价 + 提交 + 查原单），全部整数最小单位。 */
export function createFixtureJourneyPorts(options: { readonly start?: number } = {}): FixtureJourneyPorts {
  const clock = new FixtureClock(options.start ?? FIXTURE_T0);
  const quote = createFixtureQuotePort({
    unitAmountsMinor: { 'sku-noodle': 3200, 'sku-tea': 600 },
    deliveryFeeMinor: 500,
    fees: [{ code: 'pack', label: '打包费', amountMinor: 200 }],
  });
  const executor = createFixtureOrderExecutor({
    respond: (request) =>
      Object.freeze({
        transport: 'response',
        httpStatus: 200,
        businessCode: 'ok',
        providerOrderRef: `MT-${request.idempotencyKey.slice(-4)}`,
      }),
  });
  const query = createFixtureOrderQueryPort({ respond: () => null });
  return Object.freeze({
    clock,
    quote,
    executor,
    query,
    ports: Object.freeze({
      clock,
      quote,
      orderExecutor: executor,
      orderQuery: query,
    }),
  });
}

export interface DriveFixtureJourneyOptions {
  readonly journeyId?: string;
  readonly matrix?: CapabilityMatrix;
  readonly ports?: FixtureJourneyPorts;
}

export interface FixtureJourneyResult {
  readonly host: FeatureHost;
  /** 真实调用报价端口得到的最终金额（证明端口确实被接线，不是自证）。 */
  readonly quoteAmountMinor: number;
  readonly quoteCurrency: string;
  readonly quoteRef: string;
  readonly summary: EvidenceSummary;
}

/**
 * 用 fixture 宿主跑通一条完整（fixture 可达的）旅程并采集证据。
 *
 * 步骤：造端口 → 造宿主 → **真实调用**报价端口 → 逐阶段记账。
 * 不触碰网络、不构造支付证据。
 */
export async function driveFixtureJourney(options: DriveFixtureJourneyOptions = {}): Promise<FixtureJourneyResult> {
  const journeyId = options.journeyId ?? 'journey-fixture-1';
  const scenario = options.ports ?? createFixtureJourneyPorts();
  const host = createFixtureFeatureHost({
    ports: scenario.ports,
    matrix: options.matrix ?? unverifiedMatrix(),
  });

  const paramsDigest = computeParamsDigest({
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

  const quote = await scenario.quote.price({
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
    paramsDigest,
    requestedAt: scenario.clock.now(),
  });

  const ledger = host.ledger;
  ledger.record({
    journeyId,
    stage: 'capability_discovered',
    observedState: 'authorized',
    detail: 'fixture：未核实任何真实能力，矩阵全部 unverified',
  });
  ledger.record({
    journeyId,
    stage: 'on_device_transport',
    observedState: 'unknown',
    detail: 'fixture：无手机网络传输，仅本地端口；不得当作真机传输',
  });
  ledger.record({
    journeyId,
    stage: 'user_authorized',
    observedState: 'authorized',
    accountRef: 'acct:meituan:0000',
    detail: 'fixture：确认授权由本地签发器产生，仅用于独立驱动',
  });
  ledger.record({
    journeyId,
    stage: 'order_submitted',
    observedState: 'submitted',
    requestRef: 'req-fixture-1',
    amountMinor: quote.amount,
    currency: quote.currency,
    quoteRef: quote.quoteRef,
    paramsDigest,
    detail: 'fixture：提交回执来自脚本化执行器，不构成真实下单',
  });
  ledger.record({
    journeyId,
    stage: 'order_readback',
    observedState: 'unknown',
    requestRef: 'req-fixture-1',
    amountMinor: quote.amount,
    currency: quote.currency,
    detail: 'fixture：查原单端口未返回结论，如实记为 unknown',
  });

  return Object.freeze({
    host,
    quoteAmountMinor: quote.amount,
    quoteCurrency: quote.currency,
    quoteRef: quote.quoteRef,
    summary: ledger.summary(),
  });
}
