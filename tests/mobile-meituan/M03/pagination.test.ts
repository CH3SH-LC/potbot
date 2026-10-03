/**
 * M03 分页：**完整可判定**。
 *
 * 游标回环、零进展、跨页重复、串商家、声明总数自相矛盾一律报错；
 * 未翻完只给 `partial`，绝不冒充完整菜单。
 */

import { describe, expect, it } from 'vitest';

import {
  CatalogPaginationError,
  CatalogProvenanceError,
  CatalogSourceError,
  buildItem,
  buildSku,
  requireComplete,
  type CatalogPage,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { createScenario, standardItems } from './support.js';

describe('M03 分页：完整翻页', () => {
  it('两页自然结束 ⇒ complete，条目齐全、游标序列正确', async () => {
    const scenario = createScenario();
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });

    expect(snapshot.completeness).toBe('complete');
    expect(snapshot.items.map((item) => item.itemId)).toEqual(['dish-noodle', 'dish-tea']);
    expect(snapshot.pageCount).toBe(2);
    expect(snapshot.stopReason.includes('nextCursor=null')).toBe(true);
    expect(scenario.port.pageFetches.map((request) => request.cursor)).toEqual([null, 'p1']);
  });

  it('体积不足一页（空菜单）保持为空，不补造菜品', async () => {
    const scenario = createScenario({ pages: [{ items: [], nextCursor: null }] });
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });

    expect(snapshot.completeness).toBe('complete');
    expect(snapshot.items).toEqual([]);
    expect(snapshot.pageCount).toBe(1);
  });

  it('requireComplete 对完整快照放行', async () => {
    const scenario = createScenario();
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });
    expect(() => requireComplete(snapshot)).not.toThrow();
  });
});

describe('M03 分页：不完整必须如实标记为 partial', () => {
  it('达到页数上限仍未翻完 ⇒ partial + stopReason，且 requireComplete 抛错', async () => {
    const scenario = createScenario();
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1', maxPages: 1 });

    expect(snapshot.completeness).toBe('partial');
    expect(snapshot.pageCount).toBe(1);
    expect(snapshot.items.map((item) => item.itemId)).toEqual(['dish-noodle']);
    expect(snapshot.stopReason.includes('上限')).toBe(true);
    expect(() => requireComplete(snapshot)).toThrow(CatalogPaginationError);
  });
});

describe('M03 分页：自相矛盾的分页一律报错', () => {
  it('游标回环（nextCursor 指回已取过的游标）⇒ CatalogPaginationError', async () => {
    const scenario = createScenario({
      tamperPage: (page: CatalogPage) => (page.pageIndex === 1 ? { ...page, nextCursor: 'p1' } : page),
    });
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1' })).rejects.toBeInstanceOf(CatalogPaginationError);
  });

  it('零进展（本页空却仍给 nextCursor）⇒ CatalogPaginationError', async () => {
    const scenario = createScenario({
      tamperPage: (page: CatalogPage) => (page.pageIndex === 0 ? { ...page, items: [], nextCursor: 'p1' } : page),
    });
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1' })).rejects.toBeInstanceOf(CatalogPaginationError);
  });

  it('同一菜品跨页重复出现 ⇒ CatalogPaginationError', async () => {
    const noodle = standardItems()[0]!;
    const scenario = createScenario({
      tamperPage: (page: CatalogPage) => (page.pageIndex === 1 ? { ...page, items: [noodle] } : page),
    });
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1' })).rejects.toBeInstanceOf(CatalogPaginationError);
  });

  it('分页串商家 ⇒ CatalogSourceError', async () => {
    const scenario = createScenario({
      tamperPage: (page: CatalogPage) => (page.pageIndex === 0 ? { ...page, merchantId: 'merchant-x' } : page),
    });
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1' })).rejects.toBeInstanceOf(CatalogSourceError);
  });

  it('声明总数小于本页条目数（自相矛盾）⇒ CatalogProvenanceError', async () => {
    const scenario = createScenario({ pages: [{ items: standardItems(), nextCursor: null, declaredTotal: 1 }] });
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1' })).rejects.toBeInstanceOf(CatalogProvenanceError);
  });

  it('请求不存在的菜品：显式抛错，绝不补造', async () => {
    const scenario = createScenario();
    const snapshot = await scenario.service.loadMenu({ merchantId: 'merchant-1' });
    expect(scenario.service.findItem(snapshot, 'dish-ghost')).toBeNull();
    expect(() => scenario.service.requireItem(snapshot, 'dish-ghost')).toThrow(CatalogSourceError);
  });
});

describe('M03 分页：非法入参显式拒绝', () => {
  it('pageSize / maxPages 必须是正整数', async () => {
    const scenario = createScenario();
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1', pageSize: 0 })).rejects.toThrow();
    await expect(scenario.service.loadMenu({ merchantId: 'merchant-1', maxPages: -1 })).rejects.toThrow();
  });

  it('未知游标 ⇒ CatalogSourceError（fixture 不会瞎猜页号）', async () => {
    const scenario = createScenario({ pages: [{ items: [], nextCursor: null }] });
    // 直接调用端口，喂一个非法游标
    await expect(
      scenario.port.fetchMenuPage({ merchantId: 'merchant-1', cursor: 'zzz', pageSize: 10, requestedAt: 0 }),
    ).rejects.toBeInstanceOf(CatalogSourceError);
  });
});

describe('M03 分页：SKU 构造器默认库存为未知（不瞎猜）', () => {
  it('buildSku 省略 stock ⇒ 未知', () => {
    const sku = buildSku({ skuId: 'sku-x', priceMinor: 100 });
    expect(sku.stock.state).toBe('unknown');
  });

  it('buildItem 保留传入的 skus 与规格组', () => {
    const item = buildItem({ itemId: 'dish-z', name: '菜', skus: [buildSku({ skuId: 'sku-z', priceMinor: 100 })] });
    expect(item.skus.length).toBe(1);
    expect(item.specGroups).toEqual([]);
  });
});
