/**
 * M-I09｜可注入的状态码注册表（登记缝）+ 已知码覆盖一致性。
 *
 * 原来订单/退款码表是写死的 fixture 常量。本文件钉死「登记缝」落地后的口径：
 *
 * - **默认不变**：不传注册表时行为与旧实现逐位一致（默认即 fixture 注册表）；
 * - **注入生效**：注入自定义注册表后，只有登记过的码才被当作已识别；
 *   fixture 的码在新表里**自动变成不认识**（证明表被真正替换，而不是叠加）；
 * - **覆盖一致性**：每个登记码必须完整覆盖七个阶段且取值合法；退款码必须映射到合法
 *   退款状态；未登记的码**不能**被通配。这张检查是「已知码覆盖」的机器化前置条件；
 * - **登记本身 fail-closed**：登记表结构/取值有问题时抛 `StatusRegistryError`；
 * - **纪律在新表下自动成立**：订单码不认识 ⇒ 七阶段（含退款）全 unknown，
 *   即使平台在同一应答里给了「已到账」退款码也**不得**算到账。
 * - **同一份注册表贯穿落盘/恢复**：快照存的是原始状态码（事实），恢复时用哪份注册表
 *   就按哪份重算；恢复必须传入与打快照时相同的注册表。
 */

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_ORDER_STATUS_REGISTRY,
  ORDER_STATUS_TABLE,
  REFUND_STATUS_TABLE,
  REFUND_STATES,
  STAGE_STATES,
  OrderLifecycleTracker,
  ORDER_STAGES,
  StatusRegistryError,
  UnknownOrderStatusError,
  assertOrderStatusRegistryConformance,
  buildOrderLifecycleView,
  createFixtureOrderQueryPort,
  createOrderStatusRegistry,
  isRecognizedOrderStatus,
  orderStatusRegistryCoverage,
  parseOrderLifecycleSnapshot,
  restoreOrderLifecycleTracker,
  serializeOrderLifecycleSnapshot,
  snapshotOrderLifecycleTracker,
  stageReport,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import type { OrderQueryResult, OrderStatusRegistry } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { AMOUNT_MINOR, CODE, makeIntent, makeResult } from './support.js';

/** 一份自定义「已核验」码表：码值与 fixture 完全不同，用于证明 replace 而非 merge。 */
const CUSTOM_REGISTRY: OrderStatusRegistry = createOrderStatusRegistry({
  registryRef: 'custom-real-v1',
  orderStatusTable: {
    C_NEW_ACCEPTED: { placed: 'confirmed', paid: 'confirmed', merchant_accepted: 'confirmed' },
    C_NEW_DELIVERING: {
      placed: 'confirmed',
      paid: 'confirmed',
      merchant_accepted: 'confirmed',
      delivering: 'confirmed',
    },
    C_NEW_CANCELLED: { placed: 'confirmed', paid: 'confirmed', cancelled: 'confirmed' },
  },
  refundStatusTable: {
    CR_APPLIED: 'applied',
    CR_SETTLED: 'settled',
    CR_NONE: 'not_requested',
  },
});

describe('M-I09 登记缝：fixture 注册表是登记缝的一份实现', () => {
  it('FIXTURE_ORDER_STATUS_REGISTRY 如实标明来源并包住既有码表', () => {
    expect(FIXTURE_ORDER_STATUS_REGISTRY.registryRef).toBe('fixture-local-vocab');
    expect(FIXTURE_ORDER_STATUS_REGISTRY.orderStatusTable).toBe(ORDER_STATUS_TABLE);
    expect(FIXTURE_ORDER_STATUS_REGISTRY.refundStatusTable).toBe(REFUND_STATUS_TABLE);
    expect(Object.isFrozen(FIXTURE_ORDER_STATUS_REGISTRY)).toBe(true);
  });

  it('缺省注册表 = fixture：不传注册表时视图与旧实现一致（向后兼容）', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.delivering }));
    expect(view.statusRecognized).toBe(true);
    expect(stageReport(view, 'delivering').state).toBe('confirmed');
  });
});

describe('M-I09 已知码覆盖一致性（conformance）', () => {
  it('fixture 注册表通过一致性检查', () => {
    expect(() => assertOrderStatusRegistryConformance(FIXTURE_ORDER_STATUS_REGISTRY)).not.toThrow();
    expect(() => assertOrderStatusRegistryConformance(CUSTOM_REGISTRY)).not.toThrow();
  });

  it('每个登记码：都能被识别、都完整覆盖七个阶段且取值合法（无 undefined 漏网）', () => {
    for (const code of Object.keys(FIXTURE_ORDER_STATUS_REGISTRY.orderStatusTable)) {
      expect(isRecognizedOrderStatus(FIXTURE_ORDER_STATUS_REGISTRY, code), `${code} 应被识别`).toBe(true);
      const view = buildOrderLifecycleView(makeResult({ rawStatusCode: code }));
      expect(view.statusRecognized, `${code} 的视图应标记为已识别`).toBe(true);
      expect(view.stages.length).toBe(7);
      expect(view.stages.map((entry) => entry.stage)).toEqual([...ORDER_STAGES]);
      for (const entry of view.stages) {
        expect((STAGE_STATES as readonly string[]).includes(entry.state), `${code}.${entry.stage} 状态非法`).toBe(true);
      }
    }
  });

  it('每个退款码都映射到合法退款状态', () => {
    for (const [code, state] of Object.entries(FIXTURE_ORDER_STATUS_REGISTRY.refundStatusTable)) {
      expect((REFUND_STATES as readonly string[]).includes(state), `${code} → ${state} 非法`).toBe(true);
    }
  });

  it('未登记的码没有通配：既不识别，也不参与行匹配', () => {
    const probe = 'W_NOT_REGISTERED_ANYWHERE';
    expect(isRecognizedOrderStatus(FIXTURE_ORDER_STATUS_REGISTRY, probe)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(FIXTURE_ORDER_STATUS_REGISTRY.orderStatusTable, probe)).toBe(false);
    expect(buildOrderLifecycleView(makeResult({ rawStatusCode: probe })).statusRecognized).toBe(false);
  });

  it('覆盖度报告如实统计（fixture 认识 6 个订单阶段事实、4 种退款状态）', () => {
    const coverage = orderStatusRegistryCoverage(FIXTURE_ORDER_STATUS_REGISTRY);
    expect(coverage.registryRef).toBe('fixture-local-vocab');
    expect(coverage.orderCodeCount).toBe(Object.keys(ORDER_STATUS_TABLE).length);
    expect(coverage.refundCodeCount).toBe(Object.keys(REFUND_STATUS_TABLE).length);
    expect(coverage.stageStates).toEqual(['confirmed', 'absent', 'failed']);
    expect(coverage.refundStates).toEqual(['not_requested', 'applied', 'settled', 'rejected']);
    expect(coverage.factualStages).toEqual([
      'placed',
      'paid',
      'merchant_accepted',
      'delivering',
      'completed',
      'cancelled',
    ]);
  });

  it('一致性检查会抓出缺失阶段 / 非法退款状态，并一次列全（不是遇到第一条就停）', () => {
    const broken = {
      registryRef: 'broken',
      orderStatusTable: {
        B_MISSING: { placed: 'confirmed', paid: 'confirmed' }, // 缺 5 个阶段
      },
      refundStatusTable: {
        BR_BAD: 'refunded', // 非法退款状态
      },
    } as unknown as OrderStatusRegistry;
    try {
      assertOrderStatusRegistryConformance(broken);
      expect.unreachable('应当抛 StatusRegistryError');
    } catch (error) {
      expect(error).toBeInstanceOf(StatusRegistryError);
      const violations = (error as StatusRegistryError).violations;
      expect(violations.length).toBeGreaterThanOrEqual(5);
      expect(violations.some((entry) => entry.includes('缺少阶段'))).toBe(true);
      expect(violations.some((entry) => entry.includes('BR_BAD'))).toBe(true);
    }
  });
});

describe('M-I09 登记入口 fail-closed', () => {
  const badInputs: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: '不是对象', value: 7 },
    { label: 'null', value: null },
    { label: 'registryRef 为空串', value: { registryRef: '', orderStatusTable: {}, refundStatusTable: {} } },
    { label: 'orderStatusTable 不是对象', value: { registryRef: 'x', orderStatusTable: 3, refundStatusTable: {} } },
    { label: '空字符串状态码', value: { registryRef: 'x', orderStatusTable: { '': { placed: 'confirmed' } }, refundStatusTable: {} } },
    { label: '某码登记了未知阶段名', value: { registryRef: 'x', orderStatusTable: { C: { placed: 'confirmed', teleported: 'confirmed' } }, refundStatusTable: {} } },
    { label: '某码阶段状态非法', value: { registryRef: 'x', orderStatusTable: { C: { placed: 'ok' } }, refundStatusTable: {} } },
    { label: '某码一行全 absent（等于把未知当已知）', value: { registryRef: 'x', orderStatusTable: { C: { placed: 'absent' } }, refundStatusTable: {} } },
    { label: '退款码状态非法', value: { registryRef: 'x', orderStatusTable: {}, refundStatusTable: { R: 'done' } } },
    { label: '退款码为空串', value: { registryRef: 'x', orderStatusTable: {}, refundStatusTable: { '': 'settled' } } },
  ];

  for (const { label, value } of badInputs) {
    it(`${label} ⇒ StatusRegistryError`, () => {
      expect(() => createOrderStatusRegistry(value)).toThrow(StatusRegistryError);
    });
  }

  it('合法登记：省略的阶段按 absent 补齐成完整七阶段行，并冻结', () => {
    const registry = createOrderStatusRegistry({
      registryRef: 'real-v1',
      orderStatusTable: { OK_PLACED: { placed: 'confirmed' } },
      refundStatusTable: {},
    });
    const row = registry.orderStatusTable.OK_PLACED;
    expect(row).toBeDefined();
    expect(Object.keys(row!).length).toBe(7);
    expect(row!.paid).toBe('absent');
    expect(row!.placed).toBe('confirmed');
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.orderStatusTable)).toBe(true);
    expect(Object.isFrozen(registry.refundStatusTable)).toBe(true);
    expect(() => assertOrderStatusRegistryConformance(registry)).not.toThrow();
  });
});

describe('M-I09 注入生效：只有登记过的码被识别', () => {
  it('自定义码在自定义注册表下被识别，其阶段如实报告', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: 'C_NEW_ACCEPTED' }), CUSTOM_REGISTRY);
    expect(view.statusRecognized).toBe(true);
    expect(stageReport(view, 'merchant_accepted').state).toBe('confirmed');
    expect(stageReport(view, 'delivering').state).toBe('absent');
  });

  it('反向对照：fixture 的码在自定义注册表下**不认识**（表被替换，不是叠加）', () => {
    const view = buildOrderLifecycleView(makeResult({ rawStatusCode: CODE.delivering }), CUSTOM_REGISTRY);
    expect(view.statusRecognized).toBe(false);
    expect(view.stages.map((entry) => entry.state)).toEqual(new Array(7).fill('unknown'));
  });

  it('反向对照：自定义码在缺省（fixture）注册表下也不认识', () => {
    expect(buildOrderLifecycleView(makeResult({ rawStatusCode: 'C_NEW_ACCEPTED' })).statusRecognized).toBe(false);
  });

  it('退款码同样走注册表：CR_SETTLED 在自定义表下到账，在 fixture 表下未知', () => {
    const settled: Partial<OrderQueryResult> = {
      rawStatusCode: 'C_NEW_ACCEPTED',
      refundStatusCode: 'CR_SETTLED',
      refundAmountMinor: AMOUNT_MINOR,
    };
    const injected = buildOrderLifecycleView(makeResult(settled), CUSTOM_REGISTRY);
    expect(injected.refund.state).toBe('settled');
    expect(injected.refund.settled).toBe(true);
    expect(stageReport(injected, 'refund').state).toBe('confirmed');

    const fixture = buildOrderLifecycleView(makeResult(settled));
    expect(fixture.statusRecognized).toBe(false);
    expect(fixture.refund.state).toBe('unknown');
    expect(fixture.refund.settled).toBe(false);
  });
});

describe('M-I09 纪律在新表下自动成立：未知码强制七阶段全 unknown', () => {
  it('自定义注册表 + 未登记订单码：即使平台给了已到账退款码，整份应答仍全 unknown', () => {
    const view = buildOrderLifecycleView(
      makeResult({
        rawStatusCode: 'C_UNKNOWN_2099',
        refundStatusCode: 'CR_SETTLED',
        refundAmountMinor: AMOUNT_MINOR,
      }),
      CUSTOM_REGISTRY,
    );
    expect(view.statusRecognized).toBe(false);
    expect(view.stages.map((entry) => entry.state)).toEqual(new Array(7).fill('unknown'));
    expect(view.refund.state).toBe('unknown');
    expect(view.refund.settled).toBe(false);
    expect(stageReport(view, 'refund').state).toBe('unknown');
  });
});

describe('M-I09 跟踪器与落盘/恢复共享同一注册表', () => {
  it('跟踪器按注入的注册表识别状态；缺省跟踪器不识别自定义码', () => {
    const injected = new OrderLifecycleTracker({ intent: makeIntent(), registry: CUSTOM_REGISTRY });
    injected.observe(makeResult({ rawStatusCode: 'C_NEW_DELIVERING' }));
    expect(injected.registry).toBe(CUSTOM_REGISTRY);
    expect(injected.requireRecognizedView().statusRecognized).toBe(true);
    expect(stageReport(injected.view!, 'delivering').state).toBe('confirmed');

    const fallback = new OrderLifecycleTracker({ intent: makeIntent() });
    fallback.observe(makeResult({ rawStatusCode: 'C_NEW_DELIVERING' }));
    expect(fallback.view?.statusRecognized).toBe(false);
    expect(() => fallback.requireRecognizedView()).toThrow(UnknownOrderStatusError);
  });

  it('恢复必须传同一份注册表：传入则识别，不传则用 fixture 表重算成 unknown', () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent(), registry: CUSTOM_REGISTRY });
    tracker.observe(makeResult({ rawStatusCode: 'C_NEW_DELIVERING' }));
    const text = serializeOrderLifecycleSnapshot(snapshotOrderLifecycleTracker(tracker));
    const parsed = parseOrderLifecycleSnapshot(text);

    const withRegistry = restoreOrderLifecycleTracker(parsed, CUSTOM_REGISTRY);
    expect(withRegistry.view?.statusRecognized).toBe(true);
    expect(stageReport(withRegistry.view!, 'delivering').state).toBe('confirmed');

    // 不带注册表：原始状态码是事实、没变，但按 fixture 词汇重算 ⇒ 不认识。
    const withoutRegistry = restoreOrderLifecycleTracker(parsed);
    expect(withoutRegistry.view?.statusRecognized).toBe(false);
    expect(withoutRegistry.view?.refund.state).toBe('unknown');
  });

  it('快照存的是原始状态码（事实），不因注册表而变；注册表只决定如何解释', async () => {
    const tracker = new OrderLifecycleTracker({ intent: makeIntent(), registry: CUSTOM_REGISTRY });
    tracker.observe(makeResult({ rawStatusCode: 'C_NEW_DELIVERING' }));
    const snapshot = snapshotOrderLifecycleTracker(tracker);
    expect(snapshot.observations[0]?.rawStatusCode).toBe('C_NEW_DELIVERING');

    // 换一份「不认这个码」的注册表重放同一批事实 ⇒ 结论随之变为 unknown（事实未被篡改）。
    const port = createFixtureOrderQueryPort({ results: [makeResult({ rawStatusCode: 'C_NEW_DELIVERING' })] });
    expect(port.calls.length).toBe(0);
    const restoredFixture = restoreOrderLifecycleTracker(snapshot);
    expect(restoredFixture.view?.statusRecognized).toBe(false);
    expect(snapshot.observations[0]?.rawStatusCode).toBe('C_NEW_DELIVERING');
  });
});
