/**
 * M05 地址簿：增删改、设默认、版本推进。
 *
 * 每个「版本推进」用例都先断言**未修改前**的版本/引用，避免把「恒 +1」的空壳
 * 当成通过。
 */

import { describe, expect, it } from 'vitest';

import {
  AddressBook,
  AddressNotFoundError,
  AddressValidationError,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { baseAddressInput, makeBook } from './support.js';

describe('M05 地址簿：增与查', () => {
  it('新增地址从 v1 起，引用与内容指纹形状正确', () => {
    const book = new AddressBook();
    const record = book.add(baseAddressInput());

    expect(record.addressId).toBe('addr-home');
    expect(record.version).toBe(1);
    expect(record.ref).toBe('addr-home#v1');
    expect(record.contentDigest.startsWith('av1-')).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('list 保持插入顺序，get / require 语义分明', () => {
    const book = makeBook();
    expect(book.size).toBe(2);
    expect(book.list().map((r) => r.addressId)).toEqual(['addr-home', 'addr-office']);
    expect(book.get('addr-office')?.label).toBe('公司');
    expect(book.get('addr-nope')).toBeUndefined();
    expect(() => book.require('addr-nope')).toThrow(AddressNotFoundError);
  });

  it('重复 addressId / 非法字段一律显式抛错', () => {
    const book = new AddressBook();
    book.add(baseAddressInput());
    expect(() => book.add(baseAddressInput())).toThrow(AddressValidationError);
    expect(() => book.add(baseAddressInput({ addressId: '' }))).toThrow(AddressValidationError);
    expect(() => book.add(baseAddressInput({ addressId: 'a2', phone: 'abc' }))).toThrow(AddressValidationError);
    expect(() => book.add(baseAddressInput({ addressId: 'a3', lat: 999 }))).toThrow(AddressValidationError);
    expect(() => book.add(baseAddressInput({ addressId: 'a4', detail: '' }))).toThrow(AddressValidationError);
  });
});

describe('M05 地址簿：改（版本推进）', () => {
  it('改手机号 ⇒ 版本 +1、引用与指纹都变', () => {
    const book = makeBook();
    const before = book.require('addr-home');
    expect(before.version).toBe(1);

    const after = book.update('addr-home', { phone: '13800008001' });

    expect(after.version).toBe(2);
    expect(after.ref).toBe('addr-home#v2');
    expect(after.ref).not.toBe(before.ref);
    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(book.get('addr-home')?.ref).toBe('addr-home#v2');
  });

  it('改详情 / 改标签同样推进版本（任何实质修改都算）', () => {
    const book = makeBook();
    const v1 = book.require('addr-home').version;
    const afterDetail = book.update('addr-home', { detail: '某某路 100 弄 2 号 202 室' });
    expect(afterDetail.version).toBe(v1 + 1);
    const afterLabel = book.update('addr-home', { label: '老家' });
    expect(afterLabel.version).toBe(v1 + 2);
  });

  it('把字段设成原值属无操作：不推进版本（失效规则不制造噪音）', () => {
    const book = makeBook();
    const before = book.require('addr-home');

    const after = book.update('addr-home', { phone: '13800008000' });

    expect(after).toBe(before);
    expect(book.require('addr-home').version).toBe(1);
    expect(book.require('addr-home').ref).toBe('addr-home#v1');
  });

  it('版本单调严格递增', () => {
    const book = makeBook();
    const versions = [book.require('addr-home').version];
    versions.push(book.update('addr-home', { detail: 'A' }).version);
    versions.push(book.update('addr-home', { detail: 'B' }).version);
    versions.push(book.update('addr-home', { detail: 'C' }).version);
    expect(versions).toEqual([1, 2, 3, 4]);
  });

  it('改不存在的地址抛 AddressNotFoundError', () => {
    const book = makeBook();
    expect(() => book.update('addr-nope', { label: 'x' })).toThrow(AddressNotFoundError);
  });
});

describe('M05 地址簿：删与默认地址', () => {
  it('设默认只改元数据，不改内容、不计版本', () => {
    const book = makeBook();
    const before = book.require('addr-office');

    const returned = book.setDefault('addr-office');

    expect(book.defaultAddressId).toBe('addr-office');
    expect(returned).toBe(before);
    expect(book.require('addr-office').version).toBe(before.version);
    expect(book.require('addr-office').ref).toBe(before.ref);
  });

  it('删掉默认地址后默认归 null，**不**静默改指另一条', () => {
    const book = makeBook();
    expect(book.defaultAddressId).toBe('addr-home');
    expect(book.get('addr-office')).toBeDefined();

    const removed = book.remove('addr-home');

    expect(removed.addressId).toBe('addr-home');
    expect(book.defaultAddressId).toBeNull();
    expect(book.defaultAddress).toBeNull();
    // 另一条地址还在，但不得自动成为默认。
    expect(book.get('addr-office')).toBeDefined();
  });

  it('删除地址后 list 与 size 同步收缩', () => {
    const book = makeBook();
    book.remove('addr-office');
    expect(book.size).toBe(1);
    expect(book.list().map((r) => r.addressId)).toEqual(['addr-home']);
    expect(() => book.remove('addr-office')).toThrow(AddressNotFoundError);
  });
});

describe('M05 地址簿：定位地址', () => {
  it('latestLocatedAddress 只认定位来源，且取最近一条', () => {
    const book = makeBook();
    expect(book.latestLocatedAddress()).toBeNull();

    book.add(baseAddressInput({ addressId: 'addr-located-1', source: 'located' }));
    book.add(baseAddressInput({ addressId: 'addr-located-2', source: 'located' }));

    expect(book.latestLocatedAddress()?.addressId).toBe('addr-located-2');
  });

  it('删除最近的定位地址后回退到上一条定位地址', () => {
    const book = makeBook();
    book.add(baseAddressInput({ addressId: 'addr-located-1', source: 'located' }));
    book.add(baseAddressInput({ addressId: 'addr-located-2', source: 'located' }));
    book.remove('addr-located-2');
    expect(book.latestLocatedAddress()?.addressId).toBe('addr-located-1');
  });
});
