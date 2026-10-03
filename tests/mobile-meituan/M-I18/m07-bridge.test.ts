/**
 * M-I18｜M07 → M09 桥：由 M07 提交记录派生落盘意图。
 *
 * 只有**已确认下单**（`confirmed`）且携带非空平台单号的提交记录才能派生：
 * 其余状态没有可核验的 externalId，重启后无法跟踪。
 */

import { describe, expect, it } from 'vitest';

import {
  PersistedOrderIntentError,
  persistedOrderIntentFromSubmission,
  restorePersistedOrderIntent,
  serializePersistedOrderIntent,
  toLifecycleSnapshot,
} from '../../../src/mobile-plugins/meituan/order-intent/index.js';
import { restoreOrderLifecycleTracker } from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { ORDER_SUBMISSION_STATES } from '../../../src/mobile-plugins/meituan/order-submit/index.js';

import { ACCOUNT_REF, AMOUNT_MINOR, CURRENCY, EXTERNAL_ID, IDEMPOTENCY_KEY, confirmedSubmissionRecord } from './support.js';

describe('M-I18 M07 桥：confirmed 提交记录 → 可跟踪意图', () => {
  it('映射正确：providerOrderRef→externalId、amount→amountMinor、幂等键→引用与溯源', () => {
    const intent = persistedOrderIntentFromSubmission(confirmedSubmissionRecord());
    expect(intent.intent.externalId).toBe(EXTERNAL_ID);
    expect(intent.intent.accountRef).toBe(ACCOUNT_REF);
    expect(intent.intent.amountMinor).toBe(AMOUNT_MINOR);
    expect(intent.intent.currency).toBe(CURRENCY);
    expect(intent.intent.orderIntentRef).toBe(`oi:${IDEMPOTENCY_KEY}`);
    expect(intent.subjectRef).toBe(IDEMPOTENCY_KEY);
  });

  it('同一条提交记录两次派生得到相同引用（确定性）', () => {
    const a = persistedOrderIntentFromSubmission(confirmedSubmissionRecord());
    const b = persistedOrderIntentFromSubmission(confirmedSubmissionRecord());
    expect(a).toEqual(b);
  });

  it('派生的意图可正常落盘/恢复往返', () => {
    const intent = persistedOrderIntentFromSubmission(confirmedSubmissionRecord());
    const restored = restorePersistedOrderIntent(serializePersistedOrderIntent(intent));
    expect(restored).toEqual(intent);
    expect(restored.intent.externalId).toBe(EXTERNAL_ID);
  });

  it('M09 原生恢复入口可吃本记录（结构兼容）：投影成四字段快照后恢复出跟踪器', () => {
    const intent = persistedOrderIntentFromSubmission(confirmedSubmissionRecord());
    const snapshot = toLifecycleSnapshot(intent);
    expect(Object.keys(snapshot).sort()).toEqual(['blockedReason', 'intent', 'observations', 'version']);
    expect(snapshot.observations).toEqual([]);
    expect(snapshot.blockedReason).toBeNull();
    const tracker = restoreOrderLifecycleTracker(snapshot);
    expect(tracker.trackable).toBe(true);
    expect(tracker.intent.externalId).toBe(EXTERNAL_ID);
    expect(tracker.intent.amountMinor).toBe(AMOUNT_MINOR);
  });
});

describe('M-I18 M07 桥：只有 confirmed 才派生（fail-closed）', () => {
  const nonConfirmed = ORDER_SUBMISSION_STATES.filter((state) => state !== 'confirmed');

  for (const state of nonConfirmed) {
    it(`state=${state} ⇒ PersistedOrderIntentError（没有可核验的平台单号）`, () => {
      expect(() => persistedOrderIntentFromSubmission(confirmedSubmissionRecord({ state }))).toThrow(
        PersistedOrderIntentError,
      );
    });
  }

  it('providerOrderRef 为 null / 空串 ⇒ 拒绝', () => {
    expect(() =>
      persistedOrderIntentFromSubmission(confirmedSubmissionRecord({ providerOrderRef: null })),
    ).toThrow(PersistedOrderIntentError);
    expect(() =>
      persistedOrderIntentFromSubmission(confirmedSubmissionRecord({ providerOrderRef: '' })),
    ).toThrow(PersistedOrderIntentError);
  });

  it('幂等键缺失 ⇒ 拒绝', () => {
    const record = confirmedSubmissionRecord();
    const withoutKey = { ...record, idempotencyKey: undefined } as unknown as typeof record;
    expect(() => persistedOrderIntentFromSubmission(withoutKey)).toThrow(PersistedOrderIntentError);
  });
});
