/**
 * M06 升级后的美团业务合同（v2）：购买被**允许**，但只在**携带一次性用户确认**时；
 * 无确认的自主购买/支付在合同层面被拒。旧的静态禁止换成了运行期授权链——保护没有少。
 */

import { describe, expect, it } from 'vitest';

import {
  MEITUAN_ACTION_CONTRACT,
  MUTATING_MEITUAN_ACTIONS,
  PurchaseConfirmationError,
  PURCHASE_CONFIRMATION_BOUNDARY,
  actionRuleOf,
  assertAutonomousPurchaseForbidden,
  assertScopePermitted,
  validateMeituanBusinessContract,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';

function expectCode(fn: () => unknown, code: string, field?: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PurchaseConfirmationError);
  expect((caught as PurchaseConfirmationError).code).toBe(code);
  if (field !== undefined) {
    expect((caught as PurchaseConfirmationError).field).toBe(field);
  }
}

describe('M06 业务合同 v2：自洽', () => {
  it('合同静态自检无问题（改动外部世界 ⇒ 必须确认且不得自主）', () => {
    expect(validateMeituanBusinessContract()).toEqual([]);
  });

  it('旧合同的购买禁止被升级为「受确认保护的购买」：下单/支付/取消都在合同里', () => {
    for (const actionId of ['submit-order', 'pay-order', 'cancel-order'] as const) {
      const rule = MEITUAN_ACTION_CONTRACT[actionId];
      expect(rule.mutatesExternalWorld).toBe(true);
      expect(rule.requiresUserConfirmation).toBe(true);
      expect(rule.autonomousAllowed).toBe(false);
      expect(rule.requiredScope).not.toBeNull();
    }
  });

  it('只读动作（搜店/菜单/地址/计价/准备/查询）无需确认、无范围', () => {
    for (const actionId of ['search-merchant', 'read-menu', 'read-address', 'price-quote', 'prepare-purchase', 'query-order'] as const) {
      const rule = MEITUAN_ACTION_CONTRACT[actionId];
      expect(rule.mutatesExternalWorld).toBe(false);
      expect(rule.requiresUserConfirmation).toBe(false);
      expect(rule.requiredScope).toBeNull();
      expect(rule.autonomousAllowed).toBe(true);
    }
  });

  it('改动外部世界的动作清单由合同推导（不是手抄）', () => {
    expect([...MUTATING_MEITUAN_ACTIONS].sort()).toEqual(['cancel-order', 'pay-order', 'submit-order']);
  });
});

describe('M06 业务合同 v2：自主购买闸门', () => {
  it('下单动作无用户确认 ⇒ autonomous_purchase_forbidden', () => {
    expectCode(() => assertAutonomousPurchaseForbidden('submit-order', false), 'autonomous_purchase_forbidden', 'actionId');
    expectCode(() => assertAutonomousPurchaseForbidden('pay-order', false), 'autonomous_purchase_forbidden');
    expectCode(() => assertAutonomousPurchaseForbidden('cancel-order', false), 'autonomous_purchase_forbidden');
  });

  it('下单动作带了用户确认 ⇒ 放行（这是「升级」，不是「全禁」）', () => {
    expect(() => assertAutonomousPurchaseForbidden('submit-order', true)).not.toThrow();
  });

  it('只读动作无需确认也不触发自主闸门', () => {
    expect(() => assertAutonomousPurchaseForbidden('search-merchant', false)).not.toThrow();
    expect(() => assertAutonomousPurchaseForbidden('query-order', false)).not.toThrow();
  });

  it('未知动作 ⇒ action_not_in_contract（不静默当只读）', () => {
    expectCode(() => actionRuleOf('place-order'), 'action_not_in_contract', 'actionId');
  });
});

describe('M06 业务合同 v2：范围核对', () => {
  it('下单动作只接受 submit-order、支付只接受 payment', () => {
    expect(() => assertScopePermitted('submit-order', 'submit-order')).not.toThrow();
    expect(() => assertScopePermitted('pay-order', 'payment')).not.toThrow();
    expectCode(() => assertScopePermitted('submit-order', 'payment'), 'scope_not_permitted', 'scope');
    expectCode(() => assertScopePermitted('pay-order', 'submit-order'), 'scope_not_permitted', 'scope');
  });

  it('只读动作不接受任何范围', () => {
    expectCode(() => assertScopePermitted('price-quote', 'purchase'), 'scope_not_permitted', 'scope');
    expect(() => assertScopePermitted('price-quote', null)).not.toThrow();
  });
});

describe('M06 购买确认边界常量', () => {
  it('如实声明：不接真实平台、不允许自主购买、确认必须消费 K07', () => {
    expect(PURCHASE_CONFIRMATION_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(PURCHASE_CONFIRMATION_BOUNDARY.hasRealNetworkCall).toBe(false);
    expect(PURCHASE_CONFIRMATION_BOUNDARY.performsRealOrder).toBe(false);
    expect(PURCHASE_CONFIRMATION_BOUNDARY.allowsAutonomousPurchase).toBe(false);
    expect(PURCHASE_CONFIRMATION_BOUNDARY.requiresK07Consumption).toBe(true);
    expect(Object.isFrozen(PURCHASE_CONFIRMATION_BOUNDARY)).toBe(true);
  });
});
