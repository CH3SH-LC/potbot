/**
 * M03 来源与时间：**每条数据必须能指回具体来源，时间来自注入时钟**。
 *
 * 这是「真实来源/时间」与「未知不补造」两条验收口径的落点：
 * 没有 sourceRef 的条目一律拒绝，而不是默默接受一条来路不明的菜。
 */

import { describe, expect, it } from 'vitest';

import {
  CatalogProvenanceError,
  asOpaqueId,
  assertSourceRef,
  contentDigest,
  fixtureSourceRef,
  fnv1a32Hex,
  sourceRefKey,
  validateCatalogItem,
  validateCatalogMerchant,
  type CatalogItem,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { T0, createScenario, standardItems, standardMerchant } from './support.js';

describe('M03 来源：每条数据都带 sourceRef', () => {
  it('标准菜品的来源齐备（provider/endpoint/retrievedAt 均来自注入时钟）', () => {
    for (const item of standardItems()) {
      expect(item.sourceRef.provider).toBe('fixture');
      expect(item.sourceRef.endpoint.length).toBeGreaterThan(0);
      expect(item.sourceRef.retrievedAt).toBe(0);
    }
  });

  it('商家来源齐备且校验通过', () => {
    const merchant = standardMerchant();
    expect(merchant.sourceRef.provider).toBe('fixture');
    expect(() => validateCatalogMerchant(merchant)).not.toThrow();
  });

  it('分页页面的来源齐备，且取数时刻等于注入时钟当下', async () => {
    const scenario = createScenario();
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });
    expect(snapshot.sourceRefs.length).toBe(2);
    for (const ref of snapshot.sourceRefs) {
      expect(ref.retrievedAt).toBe(T0);
    }
    expect(snapshot.fetchedAt).toBe(T0);
  });

  it('没有来源的菜品**构造不出合法目录**（拒绝编造）', () => {
    const base = standardItems()[0]!;
    const broken = { ...base, sourceRef: undefined } as unknown as CatalogItem;
    expect(() => validateCatalogItem(broken)).toThrow(CatalogProvenanceError);
  });

  it('来源缺失/字段非法逐项被拒', () => {
    expect(() => assertSourceRef(undefined, 'x')).toThrow(CatalogProvenanceError);
    expect(() => assertSourceRef({ provider: '', endpoint: 'e', retrievedAt: 0 }, 'x')).toThrow(CatalogProvenanceError);
    expect(() => assertSourceRef({ provider: 'p', endpoint: '', retrievedAt: 0 }, 'x')).toThrow(CatalogProvenanceError);
    expect(() => assertSourceRef({ provider: 'p', endpoint: 'e', retrievedAt: -1 }, 'x')).toThrow(CatalogProvenanceError);
    expect(() => assertSourceRef({ provider: 'p', endpoint: 'e', retrievedAt: 0, traceRef: '' }, 'x')).toThrow(
      CatalogProvenanceError,
    );
  });

  it('来源键包含取数时刻：同一端点在两个时刻取到的是两条来源', () => {
    const a = sourceRefKey(fixtureSourceRef(1000));
    const b = sourceRefKey(fixtureSourceRef(2000));
    expect(a).not.toBe(b);
    expect(a.includes('1000')).toBe(true);
  });
});

describe('M03 标识符：自由文本不得冒充 id', () => {
  it('合法不透明 id 通过', () => {
    expect(asOpaqueId('dish-noodle', 'x')).toBe('dish-noodle');
    expect(asOpaqueId('merchant_1:v2', 'x')).toBe('merchant_1:v2');
  });

  it('空白、换行、中文、引号、标记一律拒绝', () => {
    for (const bad of ['dish noodle', 'a\nb', '坏的', '<script>', 'a;b', '', ' name']) {
      expect(() => asOpaqueId(bad, 'x'), `应拒绝 ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe('M03 内容指纹：稳定且与键序无关（结构指纹，非安全摘要）', () => {
  it('fnv1a32Hex 确定且为 8 位十六进制', () => {
    expect(fnv1a32Hex('abc')).toBe(fnv1a32Hex('abc'));
    expect(/^[0-9a-f]{8}$/.test(fnv1a32Hex('abc'))).toBe(true);
  });

  it('contentDigest 与键序无关、随值变化', () => {
    expect(contentDigest({ a: 1, b: [2, 3] })).toBe(contentDigest({ b: [2, 3], a: 1 }));
    expect(contentDigest({ a: 1 })).not.toBe(contentDigest({ a: 2 }));
  });
});
