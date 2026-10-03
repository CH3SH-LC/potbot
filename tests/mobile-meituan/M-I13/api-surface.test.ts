/**
 * M-I13 —— M-R02 目录预检模块**生产化落地**的导出面契约。
 *
 * 验证 M-R02 集成请求 #1：「把 tests/mobile-meituan/M-R02/{specs,stock,fulfillment,
 * preflight,schemas,types,errors,index}.ts 提升到生产源码，复用同一 API，不另建并行实现」。
 *
 * 本用例只 import **生产路径** `src/mobile-plugins/meituan/spec-preflight/index.js`，
 * 断言：
 *   (a) 两个只读操作 schema 描述符存在且 operation 名精确为
 *       `catalog.validate-line` / `cart.preflight-merchant`；
 *   (b) 全部校验函数从生产出口可见（同一 API 面）；
 *   (c) 边界常量如实、冻结；
 *   (d) **不导出 M-R02 的 fixture**——fixture 只作测试数据，不得从生产出口泄漏。
 */

import { describe, expect, it } from 'vitest';

import * as prod from '../../../src/mobile-plugins/meituan/spec-preflight/index.js';

describe('M-I13 生产出口：只读操作 schema 描述符', () => {
  it('声明两个只读操作，operation 名与 schemaVersion 精确', () => {
    expect(prod.CATALOG_OPERATIONS.map((op) => op.operation)).toEqual([
      'catalog.validate-line',
      'cart.preflight-merchant',
    ]);
    for (const op of prod.CATALOG_OPERATIONS) {
      expect(op.schemaVersion).toBe('1');
      expect(op.readOnly).toBe(true);
    }
  });

  it('两个描述符声明自身只读、且输入 schema 无下单/支付动词字段', () => {
    const banned = /pay|submit|place|checkout|purchase|buy/i;
    for (const op of prod.CATALOG_OPERATIONS) {
      for (const key of Object.keys(op.input.properties)) {
        expect(banned.test(key), `${op.operation} 输入字段 ${key} 可疑`).toBe(false);
      }
    }
  });
});

describe('M-I13 生产出口：同一 API 面', () => {
  it('导出全部校验函数（规格/库存/数量/履约/单条预检/schema）', () => {
    for (const name of [
      'validateSpecSelection',
      'effectiveStock',
      'checkLineQuantity',
      'maxAddableQuantity',
      'checkMinOrderAmount',
      'minOrderShortfall',
      'checkDeliveryRange',
      'preflightMerchant',
      'preflightLine',
      'canAddLine',
      'validateOperationPayload',
      'describeIssues',
    ] as const) {
      expect(typeof (prod as Record<string, unknown>)[name], `缺少导出 ${name}`).toBe('function');
    }
  });

  it('导出错误类型与常量', () => {
    expect(typeof prod.CatalogError).toBe('function');
    expect(typeof prod.CatalogValidationError).toBe('function');
    expect(prod.M_R02_VERIFICATION_MODE).toBe('fixture');
    expect(prod.MONEY_MINOR_UNIT_NOTE).toContain('分');
  });

  it('边界常量如实声明且冻结（本包不是下单/支付通道）', () => {
    expect(prod.CATALOG_PREFLIGHT_BOUNDARY.canSubmitOrder).toBe(false);
    expect(prod.CATALOG_PREFLIGHT_BOUNDARY.canPay).toBe(false);
    expect(prod.CATALOG_PREFLIGHT_BOUNDARY.connectsRealPlatform).toBe(false);
    expect(prod.CATALOG_PREFLIGHT_BOUNDARY.holdsPrices).toBe(false);
    expect(prod.CATALOG_PREFLIGHT_BOUNDARY.mode).toBe('fixture');
    expect(Object.isFrozen(prod.CATALOG_PREFLIGHT_BOUNDARY)).toBe(true);
  });
});

describe('M-I13 生产出口：fixture 不泄漏', () => {
  it('生产出口不含 M-R02 的本地 fixture（测试数据不得成为生产开关）', () => {
    const surface = prod as Record<string, unknown>;
    for (const name of ['FIXTURE_SKUS', 'FIXTURE_MERCHANTS', 'SKU_NOODLE_BASE', 'MERCHANT_NOODLE', 'skuById'] as const) {
      expect(surface[name], `生产出口不应含 fixture 符号 ${name}`).toBeUndefined();
    }
  });

  it('导出的函数里没有下单/支付动词前缀', () => {
    const forbidden = ['submit', 'place', 'pay', 'checkout', 'purchase', 'buy', 'createorder'];
    const exported = Object.entries(prod).filter(([, value]) => typeof value === 'function');
    expect(exported.length).toBeGreaterThan(0);
    for (const [name] of exported) {
      const lower = name.toLowerCase();
      expect(forbidden.some((prefix) => lower.startsWith(prefix)), `导出符号 ${name} 像下单/支付能力`).toBe(false);
    }
  });
});
