/**
 * M-I18｜落盘下单意图的基本形状与落盘/恢复往返。
 *
 * 钉死：五字段逐项一致、记录冻结、只存事实（空观测 / 未阻断）、
 * 序列化 → 解析 → 恢复后逐项还原；金额必须是整数最小单位且带合法币种。
 */

import { describe, expect, it } from 'vitest';

import {
  PERSISTED_ORDER_INTENT_KIND,
  PERSISTED_ORDER_INTENT_VERSION,
  PersistedOrderIntentError,
  createPersistedOrderIntent,
  isPersistedOrderIntent,
  parsePersistedOrderIntent,
  restorePersistedOrderIntent,
  serializePersistedOrderIntent,
  type PersistedOrderIntent,
} from '../../../src/mobile-plugins/meituan/order-intent/index.js';
import { ACCOUNT_REF, AMOUNT_MINOR, CURRENCY, EXTERNAL_ID, IDEMPOTENCY_KEY, intentInput } from './support.js';

const EXPECTED_INTENT = Object.freeze({
  orderIntentRef: 'oi:fixture-1',
  externalId: EXTERNAL_ID,
  accountRef: ACCOUNT_REF,
  amountMinor: AMOUNT_MINOR,
  currency: CURRENCY,
});

describe('M-I18 生成：落盘意图的基本形状', () => {
  it('产出的是一份冻结的事实记录：五字段 + kind/version + 空观测 + 未阻断', () => {
    const intent = createPersistedOrderIntent(intentInput());
    expect(intent.version).toBe(PERSISTED_ORDER_INTENT_VERSION);
    expect(intent.kind).toBe(PERSISTED_ORDER_INTENT_KIND);
    expect(intent.intent).toEqual(EXPECTED_INTENT);
    expect(intent.subjectRef).toBe(IDEMPOTENCY_KEY);
    expect(intent.observations).toEqual([]);
    expect(intent.blockedReason).toBeNull();
    expect(typeof intent.integrityRef).toBe('string');
    expect(intent.integrityRef.startsWith('oi1-')).toBe(true);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.intent)).toBe(true);
  });

  it('externalId:null 被如实保留（本地还没有可核验的下单回执）', () => {
    const intent = createPersistedOrderIntent(intentInput({ externalId: null }));
    expect(intent.intent.externalId).toBeNull();
    expect(isPersistedOrderIntent(intent)).toBe(true);
  });

  it('相同五字段 + 相同溯源引用 ⇒ 指纹稳定（确定性）', () => {
    const a = createPersistedOrderIntent(intentInput());
    const b = createPersistedOrderIntent(intentInput());
    expect(a.integrityRef).toBe(b.integrityRef);
  });
});

describe('M-I18 落盘/恢复往返', () => {
  it('serialize → parse → restore 后逐项还原，且相互 equal', () => {
    const created = createPersistedOrderIntent(intentInput());
    const text = serializePersistedOrderIntent(created);
    const parsed = parsePersistedOrderIntent(text);
    const restored = restorePersistedOrderIntent(text);
    expect(parsed).toEqual(created);
    expect(restored).toEqual(created);
    expect(restored.intent).toEqual(EXPECTED_INTENT);
    expect(restored.integrityRef).toBe(created.integrityRef);
  });

  it('恢复也接受已解析对象（不只是文本）', () => {
    const created = createPersistedOrderIntent(intentInput());
    const parsed = parsePersistedOrderIntent(JSON.parse(serializePersistedOrderIntent(created)));
    expect(parsed).toEqual(created);
  });

  it('序列化只写出规范字段（运行期多余属性被丢弃）', () => {
    const created = createPersistedOrderIntent(intentInput());
    const noisy = { ...created, extraField: 'ignored', observations: [] } as PersistedOrderIntent;
    const text = serializePersistedOrderIntent(noisy);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'blockedReason',
      'integrityRef',
      'intent',
      'kind',
      'observations',
      'subjectRef',
      'version',
    ]);
  });
});

describe('M-I18 金额与币种：整数最小单位 + 必填币种（与 M09 同源）', () => {
  const cases: readonly { readonly label: string; readonly input: Record<string, unknown> }[] = [
    { label: 'amountMinor 为负', input: intentInput({ amountMinor: -1 }) },
    { label: 'amountMinor 是小数（元/分未换算）', input: intentInput({ amountMinor: 47.6 }) },
    { label: 'amountMinor 是字符串', input: intentInput({ amountMinor: '4760' }) },
    { label: 'amountMinor 是 NaN', input: intentInput({ amountMinor: Number.NaN }) },
    { label: 'currency 小写', input: intentInput({ currency: 'cny' }) },
    { label: 'currency 只有两位', input: intentInput({ currency: 'CN' }) },
    { label: '缺少 currency', input: intentInput({ currency: undefined }) },
    { label: 'orderIntentRef 为空串', input: intentInput({ orderIntentRef: '' }) },
    { label: 'accountRef 为空串', input: intentInput({ accountRef: '' }) },
    { label: 'subjectRef 为空串', input: intentInput({ subjectRef: '' }) },
    { label: 'subjectRef 缺失', input: intentInput({ subjectRef: undefined }) },
    { label: 'externalId 是数字', input: intentInput({ externalId: 42 }) },
  ];

  for (const { label, input } of cases) {
    it(`${label} ⇒ PersistedOrderIntentError`, () => {
      expect(() => createPersistedOrderIntent(input)).toThrow(PersistedOrderIntentError);
    });
  }

  it('非对象输入（null / 数组 / 字符串）一律拒绝', () => {
    for (const value of [null, [], 'oi:fixture-1', 42]) {
      expect(() => createPersistedOrderIntent(value)).toThrow(PersistedOrderIntentError);
    }
  });
});
