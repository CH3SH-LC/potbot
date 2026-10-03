/**
 * M-I12 —— **业务码权威对账**（落地 M-R01 集成请求 #2）。
 *
 * ## 被解决的风险
 *
 * wire 码表与领域码表分属两模块、各自演进。若适配器读 A、状态机认 B，就会静默错配
 * （目录说 `1003 → price_changed`，状态机却把 `price_changed` 的语义改了）。
 *
 * ## 本文件的断言
 *
 * 1. wire 源表在**生产副本**（protocol）与**M-R01 测试树副本**之间仍然一致（两份不漂移）；
 * 2. 权威目录逐项等于生产 wire 源表（无静默改写）；
 * 3. 对账零违规（`CATALOG_VIOLATIONS` 空、`assertCatalogIntegrity` 不抛）；
 * 4. 每条 wire 码要么映射到**已登记领域码**，要么落**显式 unknown** 哨兵；
 * 5. 映射闭集恰为同名项；桥接示例正确；
 * 6. 对账检测器**非空洞**：喂篡改表必能报出对应违规。
 */

import { describe, expect, it } from 'vitest';

import {
  WIRE_ERROR_CODE_TABLE as WIRE_FROM_PROTOCOL,
  type WireErrorCodeSpec,
} from '../../../src/mobile-plugins/meituan/protocol/index.js';
import { WIRE_ERROR_CODE_TABLE as WIRE_FROM_MR01 } from '../M-R01/error-codes.js';
import { ORDER_BUSINESS_CODE_TABLE } from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import {
  BUSINESS_CODE_CATALOG,
  CATALOG_VIOLATIONS,
  DOMAIN_UNKNOWN,
  WIRE_DOMAIN_MAPPINGS,
  assertCatalogIntegrity,
  bridgeWireToDomain,
  lookupReconciledBusinessCode,
  reconcileBusinessCodes,
  toDomainBusinessCode,
} from '../../../src/mobile-plugins/meituan/business-codes/index.js';

const DOMAIN_CODES: ReadonlySet<string> = new Set(ORDER_BUSINESS_CODE_TABLE.map((e) => e.code));

describe('M-I12 wire 源表：生产副本与 M-R01 测试树副本一致', () => {
  it('两份 WIRE_ERROR_CODE_TABLE 逐项相同（码/符号/类别/文案/两标志）', () => {
    expect(WIRE_FROM_PROTOCOL.map((e) => e.code)).toEqual(WIRE_FROM_MR01.map((e) => e.code));
    expect(WIRE_FROM_PROTOCOL).toEqual(WIRE_FROM_MR01);
    expect(WIRE_FROM_PROTOCOL.length).toBe(12);
  });
});

describe('M-I12 权威目录：逐项等于 wire 源表', () => {
  it('目录项数与 wire 源表一致，无新增 / 丢失', () => {
    expect(BUSINESS_CODE_CATALOG.length).toBe(WIRE_FROM_PROTOCOL.length);
    expect(BUSINESS_CODE_CATALOG.map((e) => e.wireCode)).toEqual(WIRE_FROM_PROTOCOL.map((e) => e.code));
  });

  it('每条目录项完整携带 wire 侧字段（与源表逐字一致）', () => {
    const byCode = new Map(WIRE_FROM_PROTOCOL.map((e) => [e.code, e] as const));
    for (const item of BUSINESS_CODE_CATALOG) {
      const src = byCode.get(item.wireCode);
      expect(src).toBeDefined();
      expect(item.wireSymbol).toBe(src?.symbol);
      expect(item.category).toBe(src?.category);
      expect(item.message).toBe(src?.message);
      expect(item.retryable).toBe(src?.retryable);
      expect(item.requiresOrderQuery).toBe(src?.requiresOrderQuery);
    }
  });
});

describe('M-I12 对账零违规 + 每条 wire 码要么映射领域码、要么显式 unknown', () => {
  it('CATALOG_VIOLATIONS 为空，assertCatalogIntegrity 不抛', () => {
    expect(CATALOG_VIOLATIONS).toEqual([]);
    expect(() => assertCatalogIntegrity()).not.toThrow();
  });

  it('映射项落在已登记领域码；未映射项落 DOMAIN_UNKNOWN 哨兵（且哨兵不是真实领域码）', () => {
    expect(DOMAIN_CODES.has(DOMAIN_UNKNOWN)).toBe(false); // 哨兵不得是真领域码
    for (const item of BUSINESS_CODE_CATALOG) {
      if (item.mapped) {
        expect(item.domainCode).not.toBe(DOMAIN_UNKNOWN);
        expect(DOMAIN_CODES.has(item.domainCode)).toBe(true);
      } else {
        expect(item.domainCode).toBe(DOMAIN_UNKNOWN);
        expect(DOMAIN_CODES.has(item.domainCode)).toBe(false);
      }
    }
  });

  it('映射闭集恰为同名项（不意外改名）', () => {
    const mapped = BUSINESS_CODE_CATALOG.filter((e) => e.mapped).map((e) => [e.wireCode, e.domainCode]);
    expect(mapped).toEqual([
      ['0', 'ok'],
      ['1003', 'price_changed'],
      ['2001', 'invalid_address'],
      ['4001', 'duplicate_order'],
      ['5000', 'system_busy'],
    ]);
    for (const item of BUSINESS_CODE_CATALOG) {
      if (item.mapped) {
        expect(item.wireSymbol).toBe(item.domainCode); // 同名规则
      }
    }
  });

  it('对账决定表覆盖全部 wire 码（无缺项、无孤儿）', () => {
    expect(WIRE_DOMAIN_MAPPINGS.map((m) => m.wireCode)).toEqual(WIRE_FROM_PROTOCOL.map((e) => e.code));
  });
});

describe('M-I12 桥接：wire 码 → 领域语义', () => {
  it('同名码桥接到对应领域码', () => {
    expect(toDomainBusinessCode('1003')).toBe('price_changed');
    expect(toDomainBusinessCode('4001')).toBe('duplicate_order');
    expect(toDomainBusinessCode('2001')).toBe('invalid_address');
    expect(toDomainBusinessCode('5000')).toBe('system_busy');
    expect(toDomainBusinessCode('0')).toBe('ok');
  });

  it('无同名领域码者 ⇒ 显式 unknown（保留 known/mapped 位）', () => {
    const b = bridgeWireToDomain('1000');
    expect(b.known).toBe(true);
    expect(b.mapped).toBe(false);
    expect(b.domainCode).toBe(DOMAIN_UNKNOWN);
    expect(b.kind).toBe('business_failure'); // business_reject 兜底
  });

  it('完全未登记的 wire 码 ⇒ known=false、kind=unknown、绝不 success', () => {
    const b = bridgeWireToDomain('7777');
    expect(b.known).toBe(false);
    expect(b.mapped).toBe(false);
    expect(b.domainCode).toBe(DOMAIN_UNKNOWN);
    expect(b.kind).toBe('unknown');
    expect(toDomainBusinessCode('7777')).toBe(DOMAIN_UNKNOWN);
  });

  it('lookupReconciledBusinessCode：命中返回登记项，未登记 undefined', () => {
    expect(lookupReconciledBusinessCode('1003')?.domainCode).toBe('price_changed');
    expect(lookupReconciledBusinessCode('7777')).toBeUndefined();
  });
});

describe('M-I12 对账检测器非空洞：篡改表必报对应违规', () => {
  it('孤儿映射（引用未登记 wire 码）⇒ orphan_mapping', () => {
    const bad = [
      ...WIRE_DOMAIN_MAPPINGS,
      { wireCode: '8888', domainCode: null, reason: '故意孤儿' },
    ];
    const res = reconcileBusinessCodes(WIRE_FROM_PROTOCOL, ORDER_BUSINESS_CODE_TABLE, bad);
    expect(res.violations.map((v) => v.code)).toContain('orphan_mapping');
  });

  it('缺对账决定 ⇒ missing_mapping', () => {
    const bad = WIRE_DOMAIN_MAPPINGS.filter((m) => m.wireCode !== '9999');
    const res = reconcileBusinessCodes(WIRE_FROM_PROTOCOL, ORDER_BUSINESS_CODE_TABLE, bad);
    expect(res.violations.map((v) => v.code)).toContain('missing_mapping');
  });

  it('映射到不存在的领域码 ⇒ unknown_domain_code', () => {
    const bad = WIRE_DOMAIN_MAPPINGS.map((m) =>
      m.wireCode === '1003' ? { ...m, domainCode: 'no_such_domain_code' } : m,
    );
    const res = reconcileBusinessCodes(WIRE_FROM_PROTOCOL, ORDER_BUSINESS_CODE_TABLE, bad);
    expect(res.violations.map((v) => v.code)).toContain('unknown_domain_code');
  });

  it('改名为不同领域码（1003 → sold_out）⇒ symbol_mismatch', () => {
    const bad = WIRE_DOMAIN_MAPPINGS.map((m) =>
      m.wireCode === '1003' ? { ...m, domainCode: 'sold_out' } : m,
    );
    const res = reconcileBusinessCodes(WIRE_FROM_PROTOCOL, ORDER_BUSINESS_CODE_TABLE, bad);
    expect(res.violations.map((v) => v.code)).toContain('symbol_mismatch');
  });

  it('unknown 类码被抹掉"须查原单" ⇒ unknown_must_query', () => {
    const tampered: readonly WireErrorCodeSpec[] = WIRE_FROM_PROTOCOL.map((e) =>
      e.code === '4001' ? { ...e, requiresOrderQuery: false } : e,
    );
    const res = reconcileBusinessCodes(tampered, ORDER_BUSINESS_CODE_TABLE, WIRE_DOMAIN_MAPPINGS);
    expect(res.violations.map((v) => v.code)).toContain('unknown_must_query');
  });

  it('把非 ok 码的类别改成 ok（造两个 ok）⇒ ok_count', () => {
    const tampered: readonly WireErrorCodeSpec[] = WIRE_FROM_PROTOCOL.map((e) =>
      e.code === '9999' ? { ...e, category: 'ok' } : e,
    );
    const res = reconcileBusinessCodes(tampered, ORDER_BUSINESS_CODE_TABLE, WIRE_DOMAIN_MAPPINGS);
    expect(res.violations.map((v) => v.code)).toContain('ok_count');
  });
});
