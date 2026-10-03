/**
 * M-I22 §4：**M07 下单绑定金额**与 **M09 订单生命周期金额**也必须落在同一 wire 边界口径。
 *
 * - M07 `order-submit`：`OrderBinding.amount` 是整数最小单位，进幂等键；本文件把同一整数
 *   投影成 wire 串，断言与 M04 换算一致；
 * - M09 `order-lifecycle`：意图 / 观测 / 快照里的 `amountMinor` 必须**整数字节**地落盘，
 *   不得在持久化边界悄悄变成"元"字符串；本文件序列化 → 解析 → 恢复，断言逐分不变。
 *
 * M09 **自持**一份 `order-lifecycle/money.ts`（不跨包 import），故本文件额外断言那份模块
 * **只做整数校验、没有任何换算导出**——否则就成了"第二个手搓元/分换算"的藏身处。
 */

import { describe, expect, it } from 'vitest';

import {
  buildOrderSubmitRequest,
  computeIdempotencyKey,
  createAuthorizationRef,
  type OrderBinding,
} from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import * as lifecycleMoney from '../../../src/mobile-plugins/meituan/order-lifecycle/money.js';
import {
  parseOrderLifecycleSnapshot,
  restoreOrderLifecycleTracker,
  reviveOrderIntent,
  serializeOrderLifecycleSnapshot,
  snapshotForPersistedIntent,
} from '../../../src/mobile-plugins/meituan/order-lifecycle/index.js';
import { minorUnitsToWireAmount } from '../../../src/mobile-plugins/meituan/cart/index.js';
import { ACTION_ID, ACCOUNT_REF, CONFIRM_EXPIRES, T0, TASK_REVISION, fixtureQuote, loadWirePatterns } from './support.js';

const PARAMS_DIGEST = `sha256:${'b'.repeat(64)}`;

describe('M-I22 §4 M07 下单绑定金额', () => {
  it('绑定金额是整数最小单位，投影成 wire 与 M04 换算一致', async () => {
    const quote = await fixtureQuote('CNY');
    const binding: OrderBinding = {
      actionId: ACTION_ID,
      merchantId: 'merchant-1',
      accountRef: ACCOUNT_REF,
      taskRevision: TASK_REVISION,
      paramsDigest: PARAMS_DIGEST,
      quoteRef: quote.quoteRef,
      amount: quote.amount,
      currency: 'CNY',
      scope: 'submit-order',
    };
    const ref = createAuthorizationRef({
      grantId: 'grant-1',
      grantedBy: 'native.confirm',
      issuedAt: T0,
      expiresAt: CONFIRM_EXPIRES,
      binding,
    });
    const request = buildOrderSubmitRequest(ref, T0);

    expect(request.amount).toBe(8800);
    expect(Number.isInteger(request.amount)).toBe(true);
    const wire = minorUnitsToWireAmount(request.amount, request.currency);
    expect(wire).toBe('88.00');
    expect(loadWirePatterns().amount.test(wire)).toBe(true);
  });

  it('幂等键由整数金额导出：同金额同键、改一分即换键', async () => {
    const quote = await fixtureQuote('CNY');
    const base: OrderBinding = {
      actionId: ACTION_ID,
      merchantId: 'merchant-1',
      accountRef: ACCOUNT_REF,
      taskRevision: TASK_REVISION,
      paramsDigest: PARAMS_DIGEST,
      quoteRef: quote.quoteRef,
      amount: quote.amount,
      currency: 'CNY',
      scope: 'submit-order',
    };
    const keyA = computeIdempotencyKey(base);
    const keyB = computeIdempotencyKey({ ...base, amount: quote.amount });
    const keyC = computeIdempotencyKey({ ...base, amount: quote.amount + 1 });
    expect(keyB).toBe(keyA);
    expect(keyC).not.toBe(keyA);
  });

  it('非整数金额一旦进入绑定即被拒（M07 不接受浮点分）', async () => {
    const quote = await fixtureQuote('CNY');
    const bad: OrderBinding = {
      actionId: ACTION_ID,
      merchantId: 'merchant-1',
      accountRef: ACCOUNT_REF,
      taskRevision: TASK_REVISION,
      paramsDigest: PARAMS_DIGEST,
      quoteRef: quote.quoteRef,
      amount: 123.45,
      currency: 'CNY',
      scope: 'submit-order',
    };
    expect(() => createAuthorizationRef({ grantId: 'g', grantedBy: 'n', issuedAt: T0, expiresAt: CONFIRM_EXPIRES, binding: bad })).toThrow();
  });
});

describe('M-I22 §4 M09 订单生命周期金额', () => {
  it('意图金额整数字节落盘：JSON 里是 number，不是"元"小数串', async () => {
    const quote = await fixtureQuote('CNY');
    const intent = reviveOrderIntent({
      orderIntentRef: 'intent-1',
      externalId: 'MT-ORDER-1',
      accountRef: ACCOUNT_REF,
      amountMinor: quote.amount,
      currency: 'CNY',
    });
    const snapshot = snapshotForPersistedIntent(intent);
    const text = serializeOrderLifecycleSnapshot(snapshot);

    const parsedJson = JSON.parse(text) as { intent: { amountMinor: unknown } };
    expect(parsedJson.intent.amountMinor).toBe(8800);
    expect(typeof parsedJson.intent.amountMinor).toBe('number');
    expect(Number.isInteger(parsedJson.intent.amountMinor)).toBe(true);

    const parsed = parseOrderLifecycleSnapshot(text);
    expect(parsed.intent.amountMinor).toBe(quote.amount);

    const tracker = restoreOrderLifecycleTracker(parsed);
    expect(tracker.intent.amountMinor).toBe(8800);
    expect(tracker.intent.currency).toBe('CNY');
    // 同一个整数投影成 wire，仍与 M04 换算一致。
    expect(minorUnitsToWireAmount(tracker.intent.amountMinor, tracker.intent.currency)).toBe('88.00');
  });

  it('M09 自持的 money 模块没有任何换算出口（只做整数校验）', () => {
    const namespace = lifecycleMoney as unknown as Record<string, unknown>;
    for (const forbidden of [
      'minorUnitsToWireAmount',
      'wireAmountToMinorUnits',
      'formatWireAmount',
      'parseWireAmount',
      'formatMinorUnitsAsDecimalString',
      'decimalStringToMinorUnits',
    ]) {
      expect(namespace[forbidden], `M09 money 不应导出 ${forbidden}`).toBeUndefined();
    }
    // 它只承认整数最小单位：小数当场拒（不四舍五入）。
    expect(lifecycleMoney.asMinorUnits(8800, 'amount')).toBe(8800);
    expect(() => lifecycleMoney.asMinorUnits(88.0 + 0.5, 'amount')).toThrow();
    expect(() => lifecycleMoney.asMinorUnits(123.45, 'amount')).toThrow();
  });

  it('M09 意图金额非整数 / 负 / 非安全整数一律拒（落盘边界 fail-closed）', () => {
    for (const bad of [123.45, -1, Number.MAX_SAFE_INTEGER + 2, Number.NaN]) {
      expect(
        () =>
          reviveOrderIntent({
            orderIntentRef: 'intent-1',
            externalId: null,
            accountRef: ACCOUNT_REF,
            amountMinor: bad,
            currency: 'CNY',
          }),
        `应拒绝 ${String(bad)}`,
      ).toThrow();
    }
  });
});
