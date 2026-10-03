/**
 * M-I18｜篡改即拒 + 只存事实 + 恢复不发网络。
 *
 * 核心断言：恢复时重算指纹，`amountMinor` +1 或 `externalId` 被换——只要字节被改、
 * 指纹没跟着改，恢复就抛 `OrderIntentIntegrityError`，绝不「按改后的值继续跟踪」。
 */

import { describe, expect, it } from 'vitest';

import {
  OrderIntentIntegrityError,
  PersistedOrderIntentError,
  createPersistedOrderIntent,
  restoreLifecycleTrackerFromIntent,
  restorePersistedOrderIntent,
  serializePersistedOrderIntent,
} from '../../../src/mobile-plugins/meituan/order-intent/index.js';
import { EXTERNAL_ID, intentInput } from './support.js';

/** 落盘 → 读回成一棵可改的普通对象（模拟磁盘上被人动过的字节）。 */
function persistedObject(): Record<string, unknown> {
  const created = createPersistedOrderIntent(intentInput());
  return JSON.parse(serializePersistedOrderIntent(created)) as Record<string, unknown>;
}

function intentOf(obj: Record<string, unknown>): Record<string, unknown> {
  return obj.intent as Record<string, unknown>;
}

describe('M-I18 篡改即拒：内容被改、指纹不符', () => {
  it('金额 +1 分（指纹未同步）⇒ OrderIntentIntegrityError，且报出期望/实收指纹', () => {
    const obj = persistedObject();
    intentOf(obj).amountMinor = (intentOf(obj).amountMinor as number) + 1;
    try {
      restorePersistedOrderIntent(obj);
      expect.unreachable('应当抛指纹不符');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderIntentIntegrityError);
      const integrity = error as OrderIntentIntegrityError;
      expect(integrity.found).toBe(obj.integrityRef);
      expect(integrity.expected).not.toBe(integrity.found);
    }
  });

  it('externalId 被换成另一单（指纹未同步）⇒ OrderIntentIntegrityError', () => {
    const obj = persistedObject();
    intentOf(obj).externalId = 'MT-ORDER-OTHER-9999';
    expect(() => restorePersistedOrderIntent(obj)).toThrow(OrderIntentIntegrityError);
  });

  it('币种被改 / 意图引用被改 / 溯源引用被改 ⇒ 都抛 OrderIntentIntegrityError', () => {
    const currency = persistedObject();
    intentOf(currency).currency = 'USD';
    expect(() => restorePersistedOrderIntent(currency)).toThrow(OrderIntentIntegrityError);

    const ref = persistedObject();
    intentOf(ref).orderIntentRef = 'oi:tampered';
    expect(() => restorePersistedOrderIntent(ref)).toThrow(OrderIntentIntegrityError);

    const subject = persistedObject();
    subject.subjectRef = 'idem-tampered';
    expect(() => restorePersistedOrderIntent(subject)).toThrow(OrderIntentIntegrityError);
  });

  it('指纹本身被改成一个自洽之外的随机值 ⇒ OrderIntentIntegrityError', () => {
    const obj = persistedObject();
    obj.integrityRef = 'oi1-0000000000000000';
    expect(() => restorePersistedOrderIntent(obj)).toThrow(OrderIntentIntegrityError);
  });

  it('篡改后的字节也能被序列化读回文本再恢复时被抓（不只在对象路径）', () => {
    const obj = persistedObject();
    intentOf(obj).amountMinor = (intentOf(obj).amountMinor as number) + 1;
    expect(() => restorePersistedOrderIntent(JSON.stringify(obj))).toThrow(OrderIntentIntegrityError);
  });
});

describe('M-I18 只存事实：观测必须为空、初始不得阻断', () => {
  it('非空 observations ⇒ PersistedOrderIntentError（意图不携带结论）', () => {
    const obj = persistedObject();
    obj.observations = [
      {
        externalId: EXTERNAL_ID,
        accountRef: 'acct-ref-home',
        amountMinor: 4760,
        currency: 'CNY',
        rawStatusCode: 'W_DELIVERING',
        refundStatusCode: null,
        refundAmountMinor: null,
        observedAt: 1,
        evidenceRef: 'ev',
      },
    ];
    expect(() => restorePersistedOrderIntent(obj)).toThrow(PersistedOrderIntentError);
  });

  it('blockedReason 非 null ⇒ PersistedOrderIntentError（阻断属于 M09 跟踪期）', () => {
    const obj = persistedObject();
    obj.blockedReason = 'some-block';
    expect(() => restorePersistedOrderIntent(obj)).toThrow(PersistedOrderIntentError);
  });

  it('版本不符 / kind 不符 / 坏 JSON ⇒ PersistedOrderIntentError', () => {
    const badVersion = persistedObject();
    badVersion.version = 2;
    expect(() => restorePersistedOrderIntent(badVersion)).toThrow(PersistedOrderIntentError);

    const badKind = persistedObject();
    badKind.kind = 'authorization-grant';
    expect(() => restorePersistedOrderIntent(badKind)).toThrow(PersistedOrderIntentError);

    expect(() => restorePersistedOrderIntent('{not json')).toThrow(PersistedOrderIntentError);
  });
});

describe('M-I18 恢复不发网络（结构性 + 行为性）', () => {
  it('恢复入口是同步的，返回的不是 Promise', () => {
    const created = createPersistedOrderIntent(intentInput());
    const restored = restorePersistedOrderIntent(serializePersistedOrderIntent(created));
    expect(restored).not.toBeInstanceOf(Promise);
  });

  it('恢复期间即便把 fetch 换成「一调用就炸」也安然无恙（证明未联网）', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('恢复阶段不得发起任何网络请求');
    }) as unknown as typeof fetch;
    try {
      const created = createPersistedOrderIntent(intentInput());
      const text = serializePersistedOrderIntent(created);
      const restored = restorePersistedOrderIntent(text);
      const tracker = restoreLifecycleTrackerFromIntent(text);
      expect(restored.intent.externalId).toBe(EXTERNAL_ID);
      expect(tracker.trackable).toBe(true);
      expect(tracker.history.length).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
