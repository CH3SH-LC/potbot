/**
 * M-I18｜这是「事实」，不是「授权」。
 *
 * 落盘意图不能被误当成 K07 `AuthorizationGrant` / M07 `AuthorizationRef`：
 * 带授权标记字段的输入一律被拒；边界常量把「授权 / 消费 / 重放」声明为 false；
 * 本包不导出任何授权 / 消费 / 重放类的函数。
 */

import * as orderIntent from '../../../src/mobile-plugins/meituan/order-intent/index.js';
import { describe, expect, it } from 'vitest';

import {
  ORDER_INTENT_BOUNDARY,
  OrderIntentGrantShapeError,
  createPersistedOrderIntent,
  parsePersistedOrderIntent,
  serializePersistedOrderIntent,
} from '../../../src/mobile-plugins/meituan/order-intent/index.js';
import { intentInput } from './support.js';

describe('M-I18 边界常量：结构性声明为「非授权」', () => {
  it('canAuthorizeSubmit / consumable / replayable / performsNetwork 恒为 false', () => {
    expect(ORDER_INTENT_BOUNDARY.isAuthorizationGrant).toBe(false);
    expect(ORDER_INTENT_BOUNDARY.canAuthorizeSubmit).toBe(false);
    expect(ORDER_INTENT_BOUNDARY.consumable).toBe(false);
    expect(ORDER_INTENT_BOUNDARY.replayable).toBe(false);
    expect(ORDER_INTENT_BOUNDARY.performsNetwork).toBe(false);
    expect(ORDER_INTENT_BOUNDARY.carriesConclusions).toBe(false);
  });
});

describe('M-I18 授权标记字段：混进意图即被拒', () => {
  const markers: readonly string[] = [
    'grantId',
    'grantedBy',
    'expiresAt',
    'consumed',
    'consumedAt',
    'consumedByKey',
    'authorizationRef',
    'authorizationGrant',
  ];

  for (const marker of markers) {
    it(`顶层出现 ${marker} ⇒ OrderIntentGrantShapeError`, () => {
      expect(() => createPersistedOrderIntent(intentInput({ [marker]: 'x' }))).toThrow(
        OrderIntentGrantShapeError,
      );
    });
  }

  it('授权标记嵌在 intent 内层同样被拒（不能靠嵌套躲过）', () => {
    expect(() =>
      createPersistedOrderIntent({
        intent: intentInput({ grantId: 'g-1' }),
        subjectRef: 's-1',
      }),
    ).toThrow(OrderIntentGrantShapeError);
  });

  it('被拒时列出触发的标记字段（便于定位）', () => {
    try {
      createPersistedOrderIntent(intentInput({ grantId: 'g-1', consumed: true }));
      expect.unreachable('应当被拒');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderIntentGrantShapeError);
      const markers = (error as OrderIntentGrantShapeError).markers;
      expect(markers).toContain('grantId');
      expect(markers).toContain('consumed');
    }
  });

  it('恢复时读到带授权标记的字节也被拒（不只是生成侧）', () => {
    const created = createPersistedOrderIntent(intentInput());
    const obj = JSON.parse(serializePersistedOrderIntent(created)) as Record<string, unknown>;
    obj.consumed = true;
    expect(() => parsePersistedOrderIntent(obj)).toThrow(OrderIntentGrantShapeError);
  });

  it('合法记录自身不含任何授权标记字段', () => {
    const created = createPersistedOrderIntent(intentInput());
    for (const key of Object.keys(created)) {
      expect(markers).not.toContain(key);
    }
    for (const key of Object.keys(created.intent)) {
      expect(markers).not.toContain(key);
    }
  });
});

describe('M-I18 导出面：没有授权 / 消费 / 重放类函数', () => {
  it('index 导出的**能力函数**名不含 grant / authoriz / consume / replay / expire', () => {
    // 排除错误类（名字以 Error 结尾，是诊断类型，不是可调用的授权能力）。
    const suspicious = Object.entries(orderIntent)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter((name) => !name.endsWith('Error'))
      .filter((name) => /grant|authoriz|consume|replay|expire/i.test(name));
    expect(suspicious).toEqual([]);
  });
});
