/**
 * M-I12 —— 对账目录的**不变量**：标志自洽、分类只认登记、未登记绝不成功。
 *
 * 这些是与具体码值无关的**结构性判据**：即便将来 M01 核验后替换了码值，
 * 只要对账正确，它们仍应成立；反之若有人把"未登记码"或"须查原单的码"当成功，必红。
 */

import { describe, expect, it } from 'vitest';

import { ORDER_BUSINESS_CODE_TABLE, classifyBusinessCode } from '../../../src/mobile-plugins/meituan/order-submit/index.js';
import {
  BUSINESS_CODE_CATALOG,
  CATEGORY_TO_DOMAIN_KIND,
  DOMAIN_UNKNOWN,
  classifyDomainBusinessCode,
  classifyWireBusinessCode,
  listDomainCodes,
  mayReportSuccess,
  mayReportWireSuccess,
} from '../../../src/mobile-plugins/meituan/business-codes/index.js';
import { WIRE_ERROR_CODE_TABLE } from '../../../src/mobile-plugins/meituan/protocol/index.js';

const ALL_KINDS = ['success', 'business_failure', 'unknown', 'rate_limited', 'not_sent'] as const;

describe('M-I12 标志 × 类别一致性（逐条目录项）', () => {
  it('success 项：类别为 ok，且不可重试、不必查原单', () => {
    for (const item of BUSINESS_CODE_CATALOG.filter((e) => e.kind === 'success')) {
      expect(item.category).toBe('ok');
      expect(item.retryable).toBe(false);
      expect(item.requiresOrderQuery).toBe(false);
    }
  });

  it('unknown 项：必须要求查原单', () => {
    for (const item of BUSINESS_CODE_CATALOG.filter((e) => e.kind === 'unknown')) {
      expect(item.requiresOrderQuery).toBe(true);
    }
  });

  it('rate_limited 项：必须可重试', () => {
    for (const item of BUSINESS_CODE_CATALOG.filter((e) => e.kind === 'rate_limited')) {
      expect(item.retryable).toBe(true);
    }
  });

  it('business_failure 项：不得要求查原单（平台已明确拒绝，未产生订单）', () => {
    for (const item of BUSINESS_CODE_CATALOG.filter((e) => e.kind === 'business_failure')) {
      expect(item.requiresOrderQuery).toBe(false);
    }
  });

  it('要求查原单的项绝不可能是 success', () => {
    for (const item of BUSINESS_CODE_CATALOG.filter((e) => e.requiresOrderQuery)) {
      expect(item.kind).not.toBe('success');
    }
  });

  it('目录项的 kind 与类别兜底映射一致（映射命中项亦然）', () => {
    for (const item of BUSINESS_CODE_CATALOG) {
      expect(item.kind).toBe(CATEGORY_TO_DOMAIN_KIND[item.category]);
    }
  });
});

describe('M-I12 success 的唯一性：只有 kind===success 可声称成功', () => {
  it('mayReportSuccess 仅对 success 为 true', () => {
    for (const kind of ALL_KINDS) {
      expect(mayReportSuccess(kind)).toBe(kind === 'success');
    }
  });

  it('mayReportWireSuccess 仅对码 "0" 为 true', () => {
    for (const entry of WIRE_ERROR_CODE_TABLE) {
      expect(mayReportWireSuccess(entry.code)).toBe(entry.code === '0');
    }
  });

  it('未登记 / 空 / 大小写变体 wire 码一律 unknown、绝不成功', () => {
    for (const code of ['', '7777', 'brand_new_code', '0 ', 'OK', 'ok', '-1', '1e3']) {
      expect(classifyWireBusinessCode(code)).toBe('unknown');
      expect(mayReportWireSuccess(code)).toBe(false);
    }
  });
});

describe('M-I12 领域码分类：未登记 / 空串一律 unknown', () => {
  it('每一条已登记领域码分类与 M07 判定一致', () => {
    for (const entry of ORDER_BUSINESS_CODE_TABLE) {
      expect(classifyDomainBusinessCode(entry.code)).toBe(entry.kind);
      expect(classifyDomainBusinessCode(entry.code)).toBe(classifyBusinessCode(entry.code));
    }
  });

  it('未登记 / 空串 / 近似词一律 unknown（不猜成功）', () => {
    for (const code of ['', 'success', 'SUCCESS', 'ok ', 'done', 'unknown_domain']) {
      expect(classifyDomainBusinessCode(code)).toBe('unknown');
    }
    expect(mayReportSuccess(classifyDomainBusinessCode(''))).toBe(false);
  });

  it('显式 unknown 哨兵本身不是已登记领域码，分类为 unknown', () => {
    expect(listDomainCodes()).not.toContain(DOMAIN_UNKNOWN);
    expect(classifyDomainBusinessCode(DOMAIN_UNKNOWN)).toBe('unknown');
  });

  it('listDomainCodes 等于 M07 领域源表的码集合', () => {
    expect(listDomainCodes()).toEqual(ORDER_BUSINESS_CODE_TABLE.map((e) => e.code));
  });
});
