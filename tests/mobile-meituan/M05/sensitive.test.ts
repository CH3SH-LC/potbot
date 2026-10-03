/**
 * M05 敏感信息纪律：手机号/全名只在必要的端口出现，视图里只有脱敏值。
 */

import { describe, expect, it } from 'vitest';

import {
  AddressNotFoundError,
  AddressValidationError,
  createDeliveryDetailPort,
  maskContactName,
  maskPhone,
  toAddressView,
  toAddressViews,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { makeBook } from './support.js';

const RAW_PHONE = '13800008000';

describe('M05 脱敏函数', () => {
  it('maskPhone 保留前 3 后 4，短号只留末 2，空串返回空串', () => {
    expect(maskPhone(RAW_PHONE)).toBe('138****8000');
    expect(maskPhone('12345')).toBe('***45');
    expect(maskPhone('1234')).toBe('****');
    expect(maskPhone('')).toBe('');
  });

  it('maskContactName 保留首字符', () => {
    expect(maskContactName('张三')).toBe('张*');
    expect(maskContactName('欧阳修')).toBe('欧**');
    expect(maskContactName('甲')).toBe('*');
    expect(maskContactName('')).toBe('');
  });
});

describe('M05 地址视图：不含敏感明文', () => {
  it('视图里没有手机号明文、没有联系人全名', () => {
    const book = makeBook();
    const view = toAddressView(book.require('addr-home'), { isDefault: true });

    expect(view.phoneMasked).toBe('138****8000');
    expect(view.contactMasked).toBe('张*');
    expect('phone' in view).toBe(false);
    expect('contactName' in view).toBe(false);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(RAW_PHONE);
    expect(serialized).not.toContain('张三');
  });

  it('批量视图按默认地址标记 isDefault，其余为 false', () => {
    const book = makeBook();
    const views = toAddressViews(book.list(), book.defaultAddressId);

    expect(views.map((v) => v.addressId)).toEqual(['addr-home', 'addr-office']);
    expect(views[0]?.isDefault).toBe(true);
    expect(views[1]?.isDefault).toBe(false);
    expect(JSON.stringify(views)).not.toContain(RAW_PHONE);
    expect(JSON.stringify(views)).not.toContain('13900009000');
  });
});

describe('M05 完整明细端口：唯一的敏感明文出口', () => {
  it('在 order_delivery 用途下返回手机号明文', async () => {
    const book = makeBook();
    const port = createDeliveryDetailPort(book);
    const detail = await port.resolveDeliveryDetail('addr-home#v1', 'order_delivery');

    expect(detail.phone).toBe(RAW_PHONE);
    expect(detail.contactName).toBe('张三');
    expect(detail.purpose).toBe('order_delivery');
    expect(detail.addressRef).toBe('addr-home#v1');
  });

  it('其他用途一律拒绝（明文只给必要端口）', async () => {
    const book = makeBook();
    const port = createDeliveryDetailPort(book);
    await expect(port.resolveDeliveryDetail('addr-home#v1', 'analytics')).rejects.toThrow(AddressValidationError);
    await expect(port.resolveDeliveryDetail('addr-home#v1', '')).rejects.toThrow(AddressValidationError);
  });

  it('地址更新后用旧引用取明文 ⇒ 拒绝（版本不符）', async () => {
    const book = makeBook();
    const port = createDeliveryDetailPort(book);
    book.update('addr-home', { phone: '13800008001' });

    await expect(port.resolveDeliveryDetail('addr-home#v1', 'order_delivery')).rejects.toThrow(AddressValidationError);
    const fresh = await port.resolveDeliveryDetail('addr-home#v2', 'order_delivery');
    expect(fresh.phone).toBe('13800008001');
  });

  it('不存在的地址 / 非法引用形状显式抛错', async () => {
    const book = makeBook();
    const port = createDeliveryDetailPort(book);
    await expect(port.resolveDeliveryDetail('addr-ghost#v1', 'order_delivery')).rejects.toThrow(AddressNotFoundError);
    await expect(port.resolveDeliveryDetail('not-a-ref', 'order_delivery')).rejects.toThrow(AddressValidationError);
  });
});
