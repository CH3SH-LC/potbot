/**
 * M05 **反向对照（核心）**：权限被拒后自动换地址必须不可能。
 *
 * 判据要能咬：不仅断言「被拒 ⇒ null」，还断言「同一条地址在授权态下确实会被
 * 选中」——两组对照放在一起，「恒 null 的空壳」就骗不过去。
 */

import { describe, expect, it } from 'vitest';

import {
  AddressSelectionRequiredError,
  requireDeliveryAddressRef,
  resolveDelivery,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { makeBook } from './support.js';

describe('M05 配送解析：权限被拒 / 未授权 / 撤销时不得自动换地址', () => {
  it('被拒 + 有默认地址 + 无显式选择 ⇒ 需要显式选择，选中为空（**不**用默认地址）', () => {
    const book = makeBook();
    expect(book.defaultAddress?.addressId).toBe('addr-home');

    const view = resolveDelivery({ book, permission: 'denied' });

    expect(view.status).toBe('needs_explicit_selection');
    expect(view.selectedAddressId).toBeNull();
    expect(view.selectedAddressRef).toBeNull();
    expect(view.selectionSource).toBe('none');
    expect(view.requiresExplicitSelection).toBe(true);
  });

  it('被拒 + 定位候选地址 ⇒ 定位候选必须被忽略，选中仍为空', () => {
    const book = makeBook();
    book.add({
      addressId: 'addr-located',
      label: '当前位置',
      contactName: '张三',
      phone: '13800008000',
      region: '上海市静安区',
      detail: '定位得到的位置',
      lat: 31.22,
      lng: 121.45,
      source: 'located',
    });

    const view = resolveDelivery({ book, permission: 'denied', locatedAddressId: 'addr-located' });

    expect(view.status).toBe('needs_explicit_selection');
    expect(view.selectedAddressId).toBeNull();
  });

  it('未授权 / 撤销同样只要求显式选择', () => {
    const book = makeBook();
    for (const permission of ['unauthorized', 'revoked'] as const) {
      const view = resolveDelivery({ book, permission });
      expect(view.status).toBe('needs_explicit_selection');
      expect(view.selectedAddressId).toBeNull();
      expect(view.requiresExplicitSelection).toBe(true);
    }
  });

  it('需要显式选择时 requireDeliveryAddressRef 抛 AddressSelectionRequiredError（显式失败）', () => {
    const book = makeBook();
    const view = resolveDelivery({ book, permission: 'denied' });
    expect(() => requireDeliveryAddressRef(view)).toThrow(AddressSelectionRequiredError);
  });
});

describe('M05 配送解析：对照——授权态确实会选中地址（判据非空壳）', () => {
  it('授权 + 有默认地址 ⇒ 选中默认地址（证明解析器能给出非空引用）', () => {
    const book = makeBook();
    const view = resolveDelivery({ book, permission: 'authorized' });

    expect(view.status).toBe('ready');
    expect(view.selectionSource).toBe('default_authorized');
    expect(view.selectedAddressId).toBe('addr-home');
    expect(view.selectedAddressRef).toBe(book.require('addr-home').ref);
  });

  it('授权 + 定位候选 ⇒ 优先用定位候选', () => {
    const book = makeBook();
    book.add({
      addressId: 'addr-located',
      label: '当前位置',
      contactName: '张三',
      phone: '13800008000',
      region: '上海市静安区',
      detail: '定位得到的位置',
      lat: 31.22,
      lng: 121.45,
      source: 'located',
    });

    const view = resolveDelivery({ book, permission: 'authorized', locatedAddressId: 'addr-located' });

    expect(view.status).toBe('ready');
    expect(view.selectionSource).toBe('locating_authorized');
    expect(view.selectedAddressId).toBe('addr-located');
  });

  it('授权但没有默认地址也没有定位候选 ⇒ 仍要求显式选择', () => {
    const book = makeBook();
    book.clearDefault();
    const view = resolveDelivery({ book, permission: 'authorized' });
    expect(view.status).toBe('needs_explicit_selection');
    expect(view.requiresExplicitSelection).toBe(true);
  });

  it('**决定性对照**：同一条地址簿，只有权限不同，结果就不同', () => {
    const book = makeBook();

    const denied = resolveDelivery({ book, permission: 'denied' });
    const authorized = resolveDelivery({ book, permission: 'authorized' });

    expect(authorized.selectedAddressId).toBe('addr-home');
    expect(denied.selectedAddressId).toBeNull();
    expect(authorized.selectedAddressRef).not.toBe(denied.selectedAddressRef);
  });
});

describe('M05 配送解析：显式选择是唯一能绕开权限的路径', () => {
  it('被拒 + 显式选择 ⇒ 使用显式选择的地址', () => {
    const book = makeBook();

    const view = resolveDelivery({
      book,
      permission: 'denied',
      explicitSelectionAddressId: 'addr-office',
    });

    expect(view.status).toBe('ready');
    expect(view.selectionSource).toBe('explicit_user_selection');
    expect(view.selectedAddressId).toBe('addr-office');
    expect(view.selectedAddressRef).toBe(book.require('addr-office').ref);
  });

  it('显式选择优先于定位候选（用户意图高于自动定位）', () => {
    const book = makeBook();
    book.add({
      addressId: 'addr-located',
      label: '当前位置',
      contactName: '张三',
      phone: '13800008000',
      region: '上海市静安区',
      detail: '定位得到的位置',
      lat: 31.22,
      lng: 121.45,
      source: 'located',
    });

    const view = resolveDelivery({
      book,
      permission: 'authorized',
      explicitSelectionAddressId: 'addr-office',
      locatedAddressId: 'addr-located',
    });

    expect(view.selectedAddressId).toBe('addr-office');
    expect(view.selectionSource).toBe('explicit_user_selection');
  });

  it('显式选择了一个不存在的地址 ⇒ invalid_selection（显式失败，**不**替换成默认地址）', () => {
    const book = makeBook();

    const view = resolveDelivery({
      book,
      permission: 'authorized',
      explicitSelectionAddressId: 'addr-ghost',
    });

    expect(view.status).toBe('invalid_selection');
    expect(view.selectedAddressId).toBeNull();
    expect(view.selectedAddressRef).toBeNull();
    expect(view.requiresExplicitSelection).toBe(true);
    expect(() => requireDeliveryAddressRef(view)).toThrow(AddressSelectionRequiredError);
  });

  it('就绪时 requireDeliveryAddressRef 返回的真实引用与地址记录一致', () => {
    const book = makeBook();
    const view = resolveDelivery({ book, permission: 'authorized' });
    expect(requireDeliveryAddressRef(view)).toBe('addr-home#v1');
  });
});
