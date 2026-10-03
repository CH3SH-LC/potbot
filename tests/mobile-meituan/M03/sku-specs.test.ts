/**
 * M03 SKU / 规格：结构自洽是硬校验。
 *
 * 规格引用必须指向本菜品的组/选项；必选组必须恰好覆盖一次；SKU/组/选项 id 不得重复。
 * 这些不是「约定」，是 `validateCatalogItem` 会当场拒绝的规则。
 */

import { describe, expect, it } from 'vitest';

import {
  CatalogValidationError,
  buildItem,
  buildOption,
  buildSku,
  buildSpecGroup,
  validateCatalogItem,
  type CatalogItem,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { spiceGroup, standardItems } from './support.js';

function item(specGroups: CatalogItem['specGroups'], skus: CatalogItem['skus']): CatalogItem {
  return buildItem({ itemId: 'dish-x', name: '测试菜', specGroups, skus });
}

describe('M03 规格：合法结构通过', () => {
  it('标准牛肉面（必选辣度，两个 SKU）通过校验', () => {
    expect(() => validateCatalogItem(standardItems()[0]!)).not.toThrow();
  });

  it('无规格单品通过校验', () => {
    expect(() => validateCatalogItem(standardItems()[1]!)).not.toThrow();
  });
});

describe('M03 规格：引用不自洽一律拒绝', () => {
  it('SKU 引用不存在的规格组', () => {
    const bad = item(
      [spiceGroup()],
      [buildSku({ skuId: 's1', priceMinor: 100, specSelections: [{ groupId: 'ghost', optionId: 'mild' }] })],
    );
    expect(() => validateCatalogItem(bad)).toThrow(CatalogValidationError);
  });

  it('SKU 引用组内不存在的选项', () => {
    const bad = item(
      [spiceGroup()],
      [buildSku({ skuId: 's1', priceMinor: 100, specSelections: [{ groupId: 'spice', optionId: 'ghost' }] })],
    );
    expect(() => validateCatalogItem(bad)).toThrow(CatalogValidationError);
  });

  it('SKU 缺少必选组', () => {
    const bad = item([spiceGroup()], [buildSku({ skuId: 's1', priceMinor: 100 })]);
    expect(() => validateCatalogItem(bad)).toThrow(/必选/);
  });

  it('SKU 重复选择同一规格组', () => {
    const bad = item(
      [spiceGroup()],
      [
        buildSku({
          skuId: 's1',
          priceMinor: 100,
          specSelections: [
            { groupId: 'spice', optionId: 'mild' },
            { groupId: 'spice', optionId: 'hot' },
          ],
        }),
      ],
    );
    expect(() => validateCatalogItem(bad)).toThrow(CatalogValidationError);
  });

  it('菜品内 SKU id 重复', () => {
    const bad = item(
      [],
      [buildSku({ skuId: 'dup', priceMinor: 100 }), buildSku({ skuId: 'dup', priceMinor: 200 })],
    );
    expect(() => validateCatalogItem(bad)).toThrow(/重复/);
  });

  it('菜品内规格组 id 重复', () => {
    const bad = item([spiceGroup(), spiceGroup()], [buildSku({ skuId: 's1', priceMinor: 100 })]);
    expect(() => validateCatalogItem(bad)).toThrow(/重复/);
  });

  it('规格组没有任何选项', () => {
    const empty = buildSpecGroup({ groupId: 'size', name: '份量', options: [] });
    const bad = item([empty], [buildSku({ skuId: 's1', priceMinor: 100 })]);
    expect(() => validateCatalogItem(bad)).toThrow(/没有任何选项/);
  });

  it('规格组内选项 id 重复', () => {
    const group = buildSpecGroup({
      groupId: 'size',
      name: '份量',
      options: [buildOption('large', '大份'), buildOption('large', '大份2')],
    });
    const bad = item([group], [buildSku({ skuId: 's1', priceMinor: 100 })]);
    expect(() => validateCatalogItem(bad)).toThrow(/重复/);
  });

  it('菜品没有任何 SKU', () => {
    const bad = item([], []);
    expect(() => validateCatalogItem(bad)).toThrow(/没有任何 SKU/);
  });

  it('价格非整数最小单位被拒', () => {
    const bad = item([], [buildSku({ skuId: 's1', priceMinor: 12.5 })]);
    expect(() => validateCatalogItem(bad)).toThrow(/整数最小单位/);
  });
});
