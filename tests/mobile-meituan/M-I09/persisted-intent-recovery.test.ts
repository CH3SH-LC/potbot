/**
 * M-I09｜已落地的下单意图：登记口 + 落盘/恢复缝（重启后跟踪原单，不重下）。
 *
 * 上游（下单）确认回执后把 `{orderIntentRef, externalId, accountRef, amountMinor, currency}`
 * 交给本包。本文件钉死三件事：
 *
 * 1. **登记口 fail-closed**：持久化介质里的字节不可信，任何缺字段 / 类型不符 /
 *    小数金额 / 小写币种都**立即抛错**，绝不「补一个默认值」蒙混过关；
 * 2. **结构兼容**：只取那五个字段，携带更多字段的上游记录（提交记录等）照样接受；
 * 3. **恢复缝**：`snapshotForPersistedIntent` → 序列化 → 解析 → `restore` 后，
 *    intent 与原单逐项一致、可跟踪；要继续跟踪只能 `resumeAfterDisconnect` **先查原单**
 *    （一次查询、原 externalId、不重下）；恢复本身**不发任何请求**。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderLifecycleTracker,
  OrderMismatchError,
  OrderSnapshotError,
  OrderValidationError,
  createFixtureOrderQueryPort,
  parseOrderLifecycleSnapshot,
  restoreOrderLifecycleTracker,
  reviveOrderIntent,
  serializeOrderLifecycleSnapshot,
  snapshotForPersistedIntent,
  snapshotOrderLifecycleTracker,
  stageReport,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { ACCOUNT_REF, AMOUNT_MINOR, CODE, CURRENCY, EXTERNAL_ID, T0, persistedIntent } from './support.js';

const EXPECTED_INTENT = Object.freeze({
  orderIntentRef: 'intent-i09-1',
  externalId: EXTERNAL_ID,
  accountRef: ACCOUNT_REF,
  amountMinor: AMOUNT_MINOR,
  currency: CURRENCY,
});

describe('M-I09 登记口：接受已落地的下单意图', () => {
  it('JSON 往返后的五字段意图被登记且冻结', () => {
    const intent = reviveOrderIntent(persistedIntent());
    expect(intent).toEqual(EXPECTED_INTENT);
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it('externalId:null 被如实保留（本地还没有可核验的下单回执）', () => {
    const intent = reviveOrderIntent(persistedIntent({ externalId: null }));
    expect(intent.externalId).toBeNull();
  });

  it('结构兼容：携带更多字段的上游记录只取五个，其余忽略', () => {
    const upstreamRecord = {
      // 上游（如下单提交记录）常带的字段——本包一个都不读，但也不因此判非法。
      actionId: 'act-1',
      merchantId: 'merchant-1',
      providerOrderRef: 'provider-1',
      taskRevision: 3,
      quoteRef: 'quote-1',
      orderIntentRef: 'intent-up-9',
      externalId: EXTERNAL_ID,
      accountRef: ACCOUNT_REF,
      amountMinor: AMOUNT_MINOR,
      currency: CURRENCY,
    };
    const intent = reviveOrderIntent(upstreamRecord);
    expect(Object.keys(intent).sort()).toEqual([
      'accountRef',
      'amountMinor',
      'currency',
      'externalId',
      'orderIntentRef',
    ]);
    expect(intent.orderIntentRef).toBe('intent-up-9');
  });
});

describe('M-I09 登记口：坏数据 fail-closed（绝不补默认值）', () => {
  const cases: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: 'null', value: null },
    { label: '数组', value: [] },
    { label: '字符串', value: 'intent-1' },
    { label: '缺 orderIntentRef', value: { externalId: EXTERNAL_ID, accountRef: ACCOUNT_REF, amountMinor: AMOUNT_MINOR, currency: CURRENCY } },
    { label: 'orderIntentRef 为空串', value: persistedIntent({ orderIntentRef: '' }) },
    { label: 'accountRef 为空串', value: persistedIntent({ accountRef: '' }) },
    { label: 'externalId 字段缺失（不得默认为 null）', value: { orderIntentRef: 'i', accountRef: ACCOUNT_REF, amountMinor: AMOUNT_MINOR, currency: CURRENCY } },
    { label: 'externalId 是数字', value: persistedIntent({ externalId: 42 }) },
    { label: 'amountMinor 为负', value: persistedIntent({ amountMinor: -1 }) },
    { label: 'amountMinor 是小数（元/分未换算）', value: persistedIntent({ amountMinor: 47.6 }) },
    { label: 'amountMinor 是字符串', value: persistedIntent({ amountMinor: '4760' }) },
    { label: 'currency 小写', value: persistedIntent({ currency: 'cny' }) },
    { label: 'currency 只有两位', value: persistedIntent({ currency: 'CN' }) },
  ];

  for (const { label, value } of cases) {
    it(`${label} ⇒ OrderValidationError`, () => {
      expect(() => reviveOrderIntent(value)).toThrow(OrderValidationError);
    });
  }
});

describe('M-I09 落盘/恢复缝：已落地意图 → 快照 → 恢复（先查原单）', () => {
  it('初始快照是「事实为零」的诚实快照：v1、空观测、未阻断、冻结', () => {
    const snapshot = snapshotForPersistedIntent(persistedIntent());
    expect(snapshot.version).toBe(1);
    expect(snapshot.observations).toEqual([]);
    expect(snapshot.blockedReason).toBeNull();
    expect(snapshot.intent).toEqual(EXPECTED_INTENT);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('经 JSON 文本往返恢复：意图逐项一致、可跟踪、尚无视图', () => {
    const snapshot = snapshotForPersistedIntent(persistedIntent());
    const restored = restoreOrderLifecycleTracker(
      parseOrderLifecycleSnapshot(serializeOrderLifecycleSnapshot(snapshot)),
    );
    expect(restored.intent).toEqual(EXPECTED_INTENT);
    expect(restored.trackable).toBe(true);
    expect(restored.view).toBeNull();
    expect(restored.history.length).toBe(0);
  });

  it('恢复本身不发请求；重启后 resumeAfterDisconnect 只查一次原 externalId', async () => {
    // 恢复阶段：造一个「被调用就炸」的端口证明恢复没有偷偷联网。
    const neverPort = createFixtureOrderQueryPort({
      responder: () => {
        throw new Error('恢复阶段不得发起任何查询');
      },
    });
    void neverPort; // 恢复路径根本没有端口参数，构造本身也不产生调用。
    const restored = restoreOrderLifecycleTracker(
      parseOrderLifecycleSnapshot(serializeOrderLifecycleSnapshot(snapshotForPersistedIntent(persistedIntent()))),
    );
    expect(restored.history.length).toBe(0);

    // 要继续跟踪：显式查原单。
    const port = createFixtureOrderQueryPort({
      results: [makeDeliveringResult()],
    });
    const view = await restored.resumeAfterDisconnect(port);

    expect(port.calls.length).toBe(1);
    expect(port.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(port.calls[0]?.accountRef).toBe(ACCOUNT_REF);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(view.externalId).toBe(EXTERNAL_ID);
    expect(stageReport(view, 'delivering').state).toBe('confirmed');
    expect(restored.history.length).toBe(1);
  });

  it('意图没有 externalId：可恢复但拒绝查询，且一次请求都不发（不猜单）', async () => {
    const restored = restoreOrderLifecycleTracker(
      parseOrderLifecycleSnapshot(
        serializeOrderLifecycleSnapshot(snapshotForPersistedIntent(persistedIntent({ externalId: null }))),
      ),
    );
    expect(restored.trackable).toBe(true);

    const port = createFixtureOrderQueryPort({ results: [makeDeliveringResult()] });
    await expect(restored.resumeAfterDisconnect(port)).rejects.toThrow(OrderValidationError);
    expect(port.calls.length).toBe(0);
  });

  it('缝本身 fail-closed：坏持久化数据在下单落地那一刻就被拒', () => {
    expect(() => snapshotForPersistedIntent(persistedIntent({ currency: 'cny' }))).toThrow(OrderValidationError);
    expect(() => snapshotForPersistedIntent(null)).toThrow(OrderValidationError);
  });
});

describe('M-I09 快照边界：intent 与观测同在闸门内', () => {
  it('快照里 intent 结构被破坏 ⇒ OrderSnapshotError（不是恢复半程才炸）', () => {
    const text = serializeOrderLifecycleSnapshot(snapshotForPersistedIntent(persistedIntent()));
    const mutated = JSON.parse(text) as { intent: { currency: string } };
    mutated.intent.currency = 'cny';
    expect(() => parseOrderLifecycleSnapshot(JSON.stringify(mutated))).toThrow(OrderSnapshotError);
    expect(() => restoreOrderLifecycleTracker(mutated)).toThrow(OrderSnapshotError);
  });

  it('快照里 intent 金额为小数 ⇒ OrderSnapshotError', () => {
    const snapshot = snapshotForPersistedIntent(persistedIntent());
    const mutated = { ...snapshot, intent: { ...snapshot.intent, amountMinor: 47.6 } };
    expect(() => restoreOrderLifecycleTracker(mutated)).toThrow(OrderSnapshotError);
  });

  it('篡改快照里的 intent 金额（+1 分）⇒ 恢复时与观测不匹配，抛 OrderMismatchError', () => {
    const tracker = new OrderLifecycleTracker({ intent: reviveOrderIntent(persistedIntent()) });
    tracker.observe(makeDeliveringResult());

    const text = serializeOrderLifecycleSnapshot(snapshotOrderLifecycleTracker(tracker));
    const mutated = JSON.parse(text) as { intent: { amountMinor: number } };
    mutated.intent.amountMinor = mutated.intent.amountMinor + 1;

    try {
      restoreOrderLifecycleTracker(parseOrderLifecycleSnapshot(JSON.stringify(mutated)));
      expect.unreachable('应当抛不匹配');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderMismatchError);
      expect((error as OrderMismatchError).fields).toContain('amount');
    }
  });
});

/** 配送中、未发起退款的平台回执。 */
function makeDeliveringResult() {
  return Object.freeze({
    externalId: EXTERNAL_ID,
    accountRef: ACCOUNT_REF,
    amountMinor: AMOUNT_MINOR,
    currency: CURRENCY,
    rawStatusCode: CODE.delivering,
    refundStatusCode: null,
    refundAmountMinor: null,
    observedAt: T0 + 5,
    evidenceRef: 'ev-ref-i09-query-2',
  });
}
