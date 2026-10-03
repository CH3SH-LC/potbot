/**
 * F10 验收：选店 / 菜单 / 规格卡（选项不硬编码）、购物车卡（本地无价格）、地址卡（脱敏、不换地址）。
 *
 * 规格卡的「选项不硬编码」用**改写目录数据**来证明：同一函数在两组不同目录下产出不同的
 * 选项集合与建议选择——如果本模块内置了选项表，这两次输出就会相同，测试随之变红。
 * 购物车卡与地址卡分别消费真实的 M04 `CartState` 与 M05 `AddressBook` / `resolveDelivery`。
 */

import { describe, expect, it } from 'vitest';

import {
  buildAddressCard,
  buildCartCard,
  buildMenuCard,
  buildSpecCard,
  buildStoreCard,
  isAddressReady,
  menuItemById,
  validateSpecSelection,
  type FoodMenuItem,
  type FoodStore,
} from '../../../apps/mobile-ui/src/food/index.js';
import {
  AddressBook,
  resolveDelivery,
  toAddressViews,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { CartState } from '../../../src/mobile-plugins/meituan/cart/index.js';

// ---------------------------------------------------------------------------
// 目录夹具（供应商无关；真实目录来自 M03，尚未落地）
// ---------------------------------------------------------------------------

function hotpotItem(options: readonly { id: string; label: string; available?: boolean }[]): FoodMenuItem {
  return {
    dishId: 'dish-a',
    skuId: 'sku-a',
    name: '麻辣锅底',
    description: '含牛油',
    available: true,
    specGroups: [
      {
        groupId: 'spiciness',
        label: '辣度',
        required: true,
        options: options.map((o) => ({ optionId: o.id, label: o.label, available: o.available ?? true })),
      },
      {
        groupId: 'portion',
        label: '份量',
        required: false,
        options: [{ optionId: 'small', label: '小份', available: true }],
      },
    ],
  };
}

function storeWith(item: FoodMenuItem): FoodStore {
  return {
    storeId: 'store-1',
    name: 'fixture 火锅店',
    open: true,
    minOrderMinor: null,
    deliveryFeeMinor: 300,
    menu: [item],
  };
}

describe('F10 规格卡 · 选项来自目录，不硬编码', () => {
  it('卡片选项与目录逐项对应', () => {
    const item = hotpotItem([
      { id: 'mild', label: '微辣' },
      { id: 'medium', label: '中辣' },
      { id: 'hot', label: '特辣' },
    ]);
    const card = buildSpecCard(item);
    const spiciness = card.groups.find((g) => g.groupId === 'spiciness');
    expect(spiciness?.required).toBe(true);
    expect(spiciness?.options.map((o) => `${o.optionId}:${o.label}`)).toEqual([
      'mild:微辣',
      'medium:中辣',
      'hot:特辣',
    ]);
  });

  it('换一份目录（不同选项集）⇒ 卡片输出随之变化（证明无内置选项表）', () => {
    const a = buildSpecCard(hotpotItem([{ id: 'mild', label: '微辣' }]));
    const b = buildSpecCard(hotpotItem([{ id: 'x1', label: '不辣' }, { id: 'x2', label: '变态辣' }]));
    const optionsOf = (c: ReturnType<typeof buildSpecCard>) =>
      c.groups.find((g) => g.groupId === 'spiciness')?.options.map((o) => o.optionId) ?? [];
    expect(optionsOf(a)).toEqual(['mild']);
    expect(optionsOf(b)).toEqual(['x1', 'x2']);
    // 建议选择同样随目录变化（取必选组第一个可用项）。
    expect(a.suggestedSelection).toEqual([{ groupId: 'spiciness', optionId: 'mild' }]);
    expect(b.suggestedSelection).toEqual([{ groupId: 'spiciness', optionId: 'x1' }]);
  });

  it('必选组缺失 / 未知选项 / 不可用选项 / 重复组 分别显式报错', () => {
    const item = hotpotItem([
      { id: 'mild', label: '微辣' },
      { id: 'hot', label: '特辣', available: false },
    ]);

    const missing = validateSpecSelection(item, []);
    expect(missing.valid).toBe(false);
    expect(missing.violations.map((v) => v.kind)).toContain('missing_required');

    const unknown = validateSpecSelection(item, [{ groupId: 'spiciness', optionId: 'nope' }]);
    expect(unknown.violations.map((v) => v.kind)).toContain('unknown_option');

    const unavailable = validateSpecSelection(item, [{ groupId: 'spiciness', optionId: 'hot' }]);
    expect(unavailable.violations.map((v) => v.kind)).toContain('unavailable_option');

    const dup = validateSpecSelection(item, [
      { groupId: 'spiciness', optionId: 'mild' },
      { groupId: 'spiciness', optionId: 'hot' },
    ]);
    expect(dup.violations.map((v) => v.kind)).toContain('duplicate_group');
  });

  it('必选组无可选项时不给建议（不凭空造选项）', () => {
    const item = hotpotItem([{ id: 'hot', label: '特辣', available: false }]);
    expect(buildSpecCard(item).suggestedSelection).toEqual([]);
  });

  it('complete 随选择变化：满足必选后为真', () => {
    const item = hotpotItem([{ id: 'mild', label: '微辣' }]);
    expect(buildSpecCard(item, []).complete).toBe(false);
    expect(buildSpecCard(item, [{ groupId: 'spiciness', optionId: 'mild' }]).complete).toBe(true);
  });
});

describe('F10 选店卡 / 菜单卡', () => {
  it('起送价缺省时不补零（null ≠ 0），菜单标记必选规格', () => {
    const store = storeWith(hotpotItem([{ id: 'mild', label: '微辣' }]));
    const storeCard = buildStoreCard(store, 'CNY');
    expect(storeCard.minOrder).toBeNull();
    expect(storeCard.deliveryFee?.display).toBe('3.00');
    expect(storeCard.itemCount).toBe(1);
    expect(storeCard.availableItemCount).toBe(1);

    const menuCard = buildMenuCard(store);
    expect(menuCard.items[0]?.requiresSpecSelection).toBe(true);
    expect(menuCard.items[0]?.specGroupCount).toBe(2);

    expect(menuItemById(store, 'dish-a')?.name).toBe('麻辣锅底');
    expect(menuItemById(store, 'dish-missing')).toBeNull();
  });
});

describe('F10 购物车卡 · 本地没有价格', () => {
  it('同规格合并、地址与 revision 可见、hasLocalPrice 恒 false', () => {
    const cart = new CartState({ merchantId: 'store-1', currency: 'CNY' });
    cart.addLine({ dishId: 'dish-a', skuId: 'sku-a', specs: [{ groupId: 'spiciness', optionId: 'mild' }], quantity: 2 });
    // 同规格再入 ⇒ 合并到同一条，数量累加。
    cart.addLine({ dishId: 'dish-a', skuId: 'sku-a', specs: [{ groupId: 'spiciness', optionId: 'mild' }], quantity: 1 });

    const beforeRevision = cart.revision;
    cart.setDeliveryAddress('addr-1#v1');

    const card = buildCartCard({
      cart,
      dishLabels: { 'dish-a': '麻辣锅底' },
      specLabels: { 'spiciness=mild': '微辣' },
    });

    expect(card.itemCount).toBe(1);
    expect(card.items[0]?.dishLabel).toBe('麻辣锅底');
    expect(card.items[0]?.specs[0]?.label).toBe('微辣');
    expect(card.totalQuantity).toBe(3);
    expect(card.addressRef).toBe('addr-1#v1');
    expect(card.hasDeliveryAddress).toBe(true);
    expect(card.revision).toBeGreaterThan(beforeRevision);
    expect(card.hasLocalPrice).toBe(false);
    // 卡上没有任何金额字段（只有 hasLocalPrice 这个**显式为 false** 的标记）。
    expect('amount' in card).toBe(false);
    expect('total' in card).toBe(false);
    expect('price' in card).toBe(false);
    expect('amountMinor' in card).toBe(false);
  });

  it('空购物车：isEmpty 为真、没有地址', () => {
    const cart = new CartState({ merchantId: 'store-1', currency: 'CNY' });
    const card = buildCartCard({ cart });
    expect(card.isEmpty).toBe(true);
    expect(card.totalQuantity).toBe(0);
    expect(card.hasDeliveryAddress).toBe(false);
  });
});

describe('F10 地址卡 · 脱敏且权限被拒不换地址', () => {
  function book() {
    const b = new AddressBook();
    b.add({
      addressId: 'addr-1',
      label: '家',
      contactName: '张三',
      phone: '13800138000',
      region: '上海市徐汇区',
      detail: '某路 1 号',
    });
    b.setDefault('addr-1');
    return b;
  }

  it('定位被拒且无显式选择 ⇒ needs_explicit_selection、无选中地址、不替换', () => {
    const b = book();
    const resolution = resolveDelivery({ book: b, permission: 'denied' });
    const card = buildAddressCard({ resolution, addresses: toAddressViews(b.list(), b.defaultAddressId) });

    expect(card.status).toBe('needs_explicit_selection');
    expect(card.selectedAddressId).toBeNull();
    expect(card.selectedAddressRef).toBeNull();
    expect(card.requiresExplicitSelection).toBe(true);
    expect(card.substitutesOnDenied).toBe(false);
    expect(isAddressReady(card)).toBe(false);
    expect(card.entries).toHaveLength(1);
  });

  it('地址视图脱敏：卡里没有手机号明文（结构上也没有 phone 字段）', () => {
    const b = book();
    const addresses = toAddressViews(b.list(), b.defaultAddressId);
    const resolution = resolveDelivery({ book: b, permission: 'authorized', locatedAddressId: 'addr-1' });
    const card = buildAddressCard({ resolution, addresses });

    expect(card.status).toBe('ready');
    expect(isAddressReady(card)).toBe(true);
    expect(card.selectedAddressRef).toBe('addr-1#v1');
    expect(card.entries[0]?.phoneMasked).not.toBe('13800138000');
    expect(card.entries[0]?.phoneMasked).toContain('*');
    expect(JSON.stringify(card)).not.toContain('13800138000');
    expect(JSON.stringify(card)).not.toContain('张三');
  });

  it('显式选择不存在的地址 ⇒ invalid_selection（不替换为默认地址）', () => {
    const b = book();
    const resolution = resolveDelivery({ book: b, permission: 'authorized', explicitSelectionAddressId: 'addr-999' });
    const card = buildAddressCard({ resolution, addresses: toAddressViews(b.list(), b.defaultAddressId) });
    expect(card.status).toBe('invalid_selection');
    expect(card.selectedAddressId).toBeNull();
  });
});
