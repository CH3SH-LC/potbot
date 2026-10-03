/**
 * M05 **反向对照（核心）**：地址一旦被修改，绑定它的报价/确认必须可判定失效。
 *
 * 每个用例都先断言「修改之前绑定可用」——否则失效判定可能只是恒假的空壳
 * （永远报失效的测试也能"通过"，那没有意义）。
 */

import { describe, expect, it } from 'vitest';

import {
  AddressStaleError,
  bindingOf,
  checkAddressBinding,
  requireAddressBinding,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { makeBook } from './support.js';

/** 先钉住绑定，执行 `mutate`，再断言绑定被判失效。 */
function expectInvalidated(
  mutate: (book: ReturnType<typeof makeBook>) => void,
  expectedReason: 'address_removed' | 'version_changed',
): void {
  const book = makeBook();
  const binding = bindingOf(book.require('addr-home'));

  const before = checkAddressBinding(binding, book);
  expect(before.usable).toBe(true);
  expect(before.reasons).toEqual([]);

  mutate(book);

  const after = checkAddressBinding(binding, book);
  expect(after.usable).toBe(false);
  expect(after.reasons).toContain(expectedReason);
  expect(after.detail.length).toBeGreaterThan(0);
  expect(() => requireAddressBinding(binding, book)).toThrow(AddressStaleError);
}

describe('M05 地址版本失效：修改使绑定失效', () => {
  it('改手机号 ⇒ 版本不符，绑定失效', () => {
    expectInvalidated((book) => {
      book.update('addr-home', { phone: '13800008001' });
    }, 'version_changed');
  });

  it('改详细地址 ⇒ 绑定失效', () => {
    expectInvalidated((book) => {
      book.update('addr-home', { detail: '换了门牌' });
    }, 'version_changed');
  });

  it('改坐标 ⇒ 绑定失效', () => {
    expectInvalidated((book) => {
      book.update('addr-home', { lat: 30.5, lng: 120.1 });
    }, 'version_changed');
  });

  it('删除地址 ⇒ 绑定失效（address_removed）', () => {
    expectInvalidated((book) => {
      book.remove('addr-home');
    }, 'address_removed');
  });
});

describe('M05 地址版本失效：不误伤', () => {
  it('未修改时绑定仍然可用（防止「恒失效」的空壳实现）', () => {
    const book = makeBook();
    const binding = bindingOf(book.require('addr-home'));
    expect(checkAddressBinding(binding, book).usable).toBe(true);
    expect(requireAddressBinding(binding, book)).toBe(binding);
  });

  it('设默认地址不是内容变更，绑定不失效', () => {
    const book = makeBook();
    const binding = bindingOf(book.require('addr-home'));

    book.setDefault('addr-office');

    const check = checkAddressBinding(binding, book);
    expect(check.usable).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it('把字段设成原值属无操作，绑定不失效', () => {
    const book = makeBook();
    const binding = bindingOf(book.require('addr-home'));
    book.update('addr-home', { phone: '13800008000' });
    expect(checkAddressBinding(binding, book).usable).toBe(true);
  });

  it('改另一条地址不影响本条绑定', () => {
    const book = makeBook();
    const binding = bindingOf(book.require('addr-home'));
    book.update('addr-office', { phone: '13900009001' });
    expect(checkAddressBinding(binding, book).usable).toBe(true);
  });
});

describe('M05 地址版本失效：判定确实随内容变化', () => {
  it('绑定里的 ref / version / contentDigest 三者都随修改同步变化', () => {
    const book = makeBook();
    const binding = bindingOf(book.require('addr-home'));
    book.update('addr-home', { phone: '13800008002' });
    const current = book.require('addr-home');

    expect(current.ref).not.toBe(binding.addressRef);
    expect(current.version).not.toBe(binding.version);
    expect(current.contentDigest).not.toBe(binding.contentDigest);
  });

  it('失效原因顺序固定为 address_removed → version_changed → content_changed', () => {
    const book = makeBook();
    const binding = bindingOf(book.require('addr-home'));
    book.update('addr-home', { detail: 'X' });
    expect(checkAddressBinding(binding, book).reasons).toEqual(['version_changed', 'content_changed']);
  });
});
