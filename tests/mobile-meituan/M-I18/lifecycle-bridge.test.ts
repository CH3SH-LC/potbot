/**
 * M-I18｜恢复后的行为：先查原单、绝不重下；以及指纹的诚实强度。
 *
 * 恢复只重建本地意图；要继续跟踪必须显式对 M09 `resumeAfterDisconnect(port)`
 * ——一次查询、原 externalId。指纹是**非密钥**校验：一个能重算指纹的攻击者可绕过它，
 * 所以真正的权威核验是 M09 拿平台回执与本地意图逐项比对（本文件用反例钉死这层）。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderIntentIntegrityError,
  computeOrderIntentIntegrityRef,
  createPersistedOrderIntent,
  restoreLifecycleTrackerFromIntent,
  restorePersistedOrderIntent,
  serializePersistedOrderIntent,
} from '../../../src/mobile-plugins/meituan/order-intent/index.js';
import {
  OrderMismatchError,
  createFixtureOrderQueryPort,
  restoreOrderLifecycleTracker,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import type { OrderIntent } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';

import { ACCOUNT_REF, AMOUNT_MINOR, EXTERNAL_ID, intentInput, makeQueryResult } from './support.js';

const EXPECTED_INTENT = Object.freeze({
  orderIntentRef: 'oi:fixture-1',
  externalId: EXTERNAL_ID,
  accountRef: ACCOUNT_REF,
  amountMinor: AMOUNT_MINOR,
  currency: 'CNY',
});

describe('M-I18 生命周期桥：恢复出跟踪器（先查原单）', () => {
  it('恢复后 trackable、历史为空、意图与原单逐项一致', () => {
    const text = serializePersistedOrderIntent(createPersistedOrderIntent(intentInput()));
    const tracker = restoreLifecycleTrackerFromIntent(text);
    expect(tracker.trackable).toBe(true);
    expect(tracker.view).toBeNull();
    expect(tracker.history.length).toBe(0);
    expect(tracker.intent).toEqual(EXPECTED_INTENT);
  });

  it('恢复后 resumeAfterDisconnect 只查一次、查的是原 externalId', async () => {
    const text = serializePersistedOrderIntent(createPersistedOrderIntent(intentInput()));
    const tracker = restoreLifecycleTrackerFromIntent(text);

    const port = createFixtureOrderQueryPort({ results: [makeQueryResult()] });
    await tracker.resumeAfterDisconnect(port);

    expect(port.calls.length).toBe(1);
    expect(port.calls[0]?.externalId).toBe(EXTERNAL_ID);
    expect(port.calls[0]?.accountRef).toBe(ACCOUNT_REF);
    expect(port.calls[0]?.reason).toBe('resume_after_disconnect');
    expect(tracker.history.length).toBe(1);
  });

  it('M09 原生入口可直接接受本记录（超集：多余字段被忽略）', () => {
    const intent = createPersistedOrderIntent(intentInput());
    const tracker = restoreOrderLifecycleTracker(intent);
    expect(tracker.intent).toEqual(EXPECTED_INTENT);
  });
});

describe('M-I18 指纹的诚实强度：重算指纹可绕过，但 M09 逐项比对兜底', () => {
  it('攻击者改金额并重算指纹 ⇒ 通过结构恢复，但查原单时被 M09 报不匹配（amount）', async () => {
    const created = createPersistedOrderIntent(intentInput());
    const obj = JSON.parse(serializePersistedOrderIntent(created)) as {
      intent: Record<string, unknown>;
      subjectRef: string;
      integrityRef: string;
    };
    obj.intent.amountMinor = AMOUNT_MINOR + 1;
    obj.integrityRef = computeOrderIntentIntegrityRef({
      intent: obj.intent as unknown as OrderIntent,
      subjectRef: obj.subjectRef,
    });

    // 指纹是自洽的（非密钥），结构恢复会通过——这正是它作为 MAC 的局限。
    const restored = restorePersistedOrderIntent(obj);
    expect(restored.intent.amountMinor).toBe(AMOUNT_MINOR + 1);

    // 权威核验在 M09：平台回执金额仍是原值，逐项比对直接报不匹配。
    const tracker = restoreLifecycleTrackerFromIntent(obj);
    const port = createFixtureOrderQueryPort({ results: [makeQueryResult()] });
    try {
      await tracker.resumeAfterDisconnect(port);
      expect.unreachable('金额被改后应当报不匹配');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderMismatchError);
      expect((error as OrderMismatchError).fields).toContain('amount');
    }
  });

  it('朴素改金额（未重算指纹）在结构恢复那一步就被拦下', () => {
    const created = createPersistedOrderIntent(intentInput());
    const obj = JSON.parse(serializePersistedOrderIntent(created)) as { intent: Record<string, unknown> };
    obj.intent.amountMinor = AMOUNT_MINOR + 1;
    expect(() => restorePersistedOrderIntent(obj)).toThrow(OrderIntentIntegrityError);
  });
});
