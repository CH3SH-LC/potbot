/**
 * M05 定位产生地址并绑定版本（`locate.ts`）。
 *
 * 工作书 M05 验收：「手填与定位都可用，绑定地址版本；拒绝权限不静默换地址」。
 * 本文件专测**定位**这一半：
 *
 * - `applyLocationFix` 把注入端口的定位固化成带版本的 `located` 地址；
 *   同内容重复定位不新增、不推进版本；
 * - `locateAndBind` 编排「权限 → 定位 → 落簿」：授权成功绑定引用；**被拒/失败时
 *   不调定位端口、不产生地址、不替换默认地址**，结果引用恒 `null`；
 * - 绑定结果同样受地址版本失效纪律约束，且不含敏感明文。
 *
 * 每个「应失败」的用例都同时断言**对照面**（授权态确实会绑定），避免「恒 null /
 * 恒失效」的空壳实现骗过测试。
 */

import { describe, expect, it } from 'vitest';

import {
  ADDRESS_DELIVERY_OPERATIONS,
  AddressBook,
  AddressValidationError,
  LocationPermissionMachine,
  applyLocationFix,
  bindingOf,
  checkAddressBinding,
  createFailingLocationFixPort,
  createFixtureLocationFixPort,
  createFixtureLocationPort,
  locateAndBind,
  maskPhone,
  resolveDelivery,
  toAddressView,
  toQuoteRequestDelivery,
  type LocationFix,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { makeBook } from './support.js';

/** 一次「定位得到的位置」。坐标/区划/详址全部来自端口，本包不产生任何真实坐标。 */
const FIX_HOME: LocationFix = {
  region: '上海市徐汇区',
  detail: '定位路 1 号',
  lat: 31.19,
  lng: 121.43,
  provider: 'fixture-geo',
};

const CONTACT = { contactName: '张三', phone: '13800008000' };

describe('M05 定位固化：applyLocationFix', () => {
  it('产生 source=located、v1、ref 含版本的地址记录', () => {
    const book = new AddressBook();
    const out = applyLocationFix(book, { fix: FIX_HOME, ...CONTACT });

    expect(out.reused).toBe(false);
    expect(out.version).toBe(1);
    expect(out.addressId.startsWith('loc-')).toBe(true);
    expect(out.ref).toBe(`${out.addressId}#v1`);
    expect(out.record.source).toBe('located');
    expect(out.record.contentDigest.startsWith('av1-')).toBe(true);
    expect(Object.isFrozen(out)).toBe(true);
    expect(book.get(out.addressId)).toBe(out.record);
    expect(book.latestLocatedAddress()?.addressId).toBe(out.addressId);
  });

  it('同内容重复定位 ⇒ 复用（不新增、不推进版本）；provider 不入指纹', () => {
    const book = new AddressBook();
    const first = applyLocationFix(book, { fix: FIX_HOME, ...CONTACT });
    const again = applyLocationFix(book, {
      fix: { ...FIX_HOME, provider: '另一个提供方' },
      ...CONTACT,
    });

    expect(again.reused).toBe(true);
    expect(again.addressId).toBe(first.addressId);
    expect(again.ref).toBe(first.ref);
    expect(again.version).toBe(1);
    expect(book.size).toBe(1);
  });

  it('位置变化 ⇒ 新地址、新引用，两条并存且 latest 指向新条', () => {
    const book = new AddressBook();
    const first = applyLocationFix(book, { fix: FIX_HOME, ...CONTACT });
    const moved = applyLocationFix(book, {
      fix: { ...FIX_HOME, detail: '定位路 2 号' },
      ...CONTACT,
    });

    expect(moved.reused).toBe(false);
    expect(moved.addressId).not.toBe(first.addressId);
    expect(moved.ref).not.toBe(first.ref);
    expect(book.size).toBe(2);
    expect(book.latestLocatedAddress()?.addressId).toBe(moved.addressId);
  });

  it('非法定位显式抛错，且**不产生**任何地址', () => {
    const book = new AddressBook();
    expect(() => applyLocationFix(book, { fix: { ...FIX_HOME, region: '' }, ...CONTACT })).toThrow(
      AddressValidationError,
    );
    expect(() => applyLocationFix(book, { fix: { ...FIX_HOME, lat: 999 }, ...CONTACT })).toThrow(
      AddressValidationError,
    );
    expect(() => applyLocationFix(book, { fix: { ...FIX_HOME, lng: Number.NaN }, ...CONTACT })).toThrow(
      AddressValidationError,
    );
    expect(book.size).toBe(0);
  });

  it('显式 id 与已有条目内容冲突 ⇒ 抛错且不覆盖', () => {
    const book = new AddressBook();
    applyLocationFix(book, { fix: FIX_HOME, addressId: 'loc-fixed', ...CONTACT });

    expect(() =>
      applyLocationFix(book, { fix: { ...FIX_HOME, detail: '另一个位置' }, addressId: 'loc-fixed', ...CONTACT }),
    ).toThrow(AddressValidationError);

    expect(book.require('loc-fixed').detail).toBe(FIX_HOME.detail);
    expect(book.size).toBe(1);
  });

  it('定位地址同样受绑定失效纪律约束（改内容 ⇒ 旧绑定失效）', () => {
    const book = new AddressBook();
    const out = applyLocationFix(book, { fix: FIX_HOME, ...CONTACT });
    const binding = bindingOf(out.record);

    expect(checkAddressBinding(binding, book).usable).toBe(true);

    book.update(out.addressId, { detail: '换了门牌 202 室' });

    const after = checkAddressBinding(binding, book);
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('version_changed');
  });
});

describe('M05 定位编排 locateAndBind：授权成功路径', () => {
  it('未授权 + 授权成功 ⇒ located，绑定版本，两个端口各调一次', async () => {
    const book = new AddressBook();
    const machine = new LocationPermissionMachine();
    const permissionPort = createFixtureLocationPort('granted');
    const fixPort = createFixtureLocationFixPort(FIX_HOME);

    const result = await locateAndBind({ book, machine, permissionPort, fixPort, ...CONTACT });

    expect(result.status).toBe('located');
    expect(result.permission).toBe('authorized');
    expect(result.requiresExplicitSelection).toBe(false);
    expect(result.addressRef).not.toBeNull();
    expect(permissionPort.calls).toBe(1);
    expect(fixPort.calls).toBe(1);

    const record = book.get(result.addressId ?? '');
    expect(record?.ref).toBe(result.addressRef);
    expect(record?.source).toBe('located');
  });

  it('已授权 ⇒ 不再请求权限端口，直接定位', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));

    const book = new AddressBook();
    const permissionPort = createFixtureLocationPort('granted');
    const fixPort = createFixtureLocationFixPort(FIX_HOME);

    const result = await locateAndBind({ book, machine, permissionPort, fixPort, ...CONTACT });

    expect(result.status).toBe('located');
    expect(permissionPort.calls).toBe(0);
    expect(fixPort.calls).toBe(1);
  });

  it('定位得到的 ref 可直接喂给 resolveDelivery 与 M04 配送参数', async () => {
    const book = new AddressBook();
    const machine = new LocationPermissionMachine();
    const result = await locateAndBind({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      ...CONTACT,
    });
    const addressId = result.addressId ?? '';

    const view = resolveDelivery({ book, permission: 'authorized', locatedAddressId: addressId });
    expect(view.status).toBe('ready');
    expect(view.selectionSource).toBe('locating_authorized');
    expect(view.selectedAddressRef).toBe(result.addressRef);

    expect(toQuoteRequestDelivery(book.require(addressId)).addressRef).toBe(result.addressRef);
  });
});

describe('M05 定位编排 locateAndBind：被拒不产生地址、不定位、不换地址', () => {
  it('被拒 ⇒ permission_denied，引用为 null，未定位、未新增、默认地址不变', async () => {
    const book = makeBook(); // 已含默认地址 addr-home
    const sizeBefore = book.size;
    const machine = new LocationPermissionMachine();
    const fixPort = createFixtureLocationFixPort(FIX_HOME);

    const result = await locateAndBind({
      book,
      machine,
      permissionPort: createFixtureLocationPort('denied'),
      fixPort,
      ...CONTACT,
    });

    expect(result.status).toBe('permission_denied');
    expect(result.permission).toBe('denied');
    expect(result.addressId).toBeNull();
    expect(result.addressRef).toBeNull();
    expect(result.requiresExplicitSelection).toBe(true);
    // 未授权不得尝试定位。
    expect(fixPort.calls).toBe(0);
    // 不得因被拒而新增/替换任何地址；默认地址原样保留。
    expect(book.size).toBe(sizeBefore);
    expect(book.defaultAddress?.addressId).toBe('addr-home');
    // 没有静默替换：结果引用与默认地址引用不同（前者为 null）。
    expect(result.addressRef).not.toBe(book.defaultAddress?.ref);
  });

  it('撤销后再被用户拒绝 ⇒ permission_denied，且不定位、不新增', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));
    machine.revoke();
    expect(machine.state).toBe('revoked');

    const book = new AddressBook();
    const fixPort = createFixtureLocationFixPort(FIX_HOME);

    // 撤销态是**可重新请求**的（用户可再次授权）；这里用户再次点了「拒绝」。
    const result = await locateAndBind({
      book,
      machine,
      permissionPort: createFixtureLocationPort('denied'),
      fixPort,
      ...CONTACT,
    });

    expect(result.status).toBe('permission_denied');
    expect(result.permission).toBe('denied');
    expect(result.addressRef).toBeNull();
    expect(fixPort.calls).toBe(0);
    expect(book.size).toBe(0);
  });

  it('撤销后用户重新授权 ⇒ 恢复到 located（撤销不是死路）', async () => {
    const machine = new LocationPermissionMachine();
    await machine.request(createFixtureLocationPort('granted'));
    machine.revoke();

    const book = new AddressBook();
    const result = await locateAndBind({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      ...CONTACT,
    });

    expect(result.status).toBe('located');
    expect(result.permission).toBe('authorized');
    expect(result.addressRef).not.toBeNull();
    expect(book.size).toBe(1);
  });

  it('**决定性对照**：同一地址簿，只有权限不同，结果就不同', async () => {
    const denied = await locateAndBind({
      book: new AddressBook(),
      machine: new LocationPermissionMachine(),
      permissionPort: createFixtureLocationPort('denied'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      ...CONTACT,
    });
    const granted = await locateAndBind({
      book: new AddressBook(),
      machine: new LocationPermissionMachine(),
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      ...CONTACT,
    });

    expect(granted.status).toBe('located');
    expect(granted.addressRef).not.toBeNull();
    expect(denied.status).toBe('permission_denied');
    expect(denied.addressRef).toBeNull();
    expect(denied.addressRef).not.toBe(granted.addressRef);
  });
});

describe('M05 定位编排 locateAndBind：定位失败路径', () => {
  it('授权但定位失败 ⇒ location_failed，引用为 null，未产生地址', async () => {
    const book = new AddressBook();
    const machine = new LocationPermissionMachine();

    const result = await locateAndBind({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFailingLocationFixPort('GPS 不可用'),
      ...CONTACT,
    });

    expect(result.status).toBe('location_failed');
    expect(result.permission).toBe('authorized');
    expect(result.addressId).toBeNull();
    expect(result.addressRef).toBeNull();
    expect(result.requiresExplicitSelection).toBe(true);
    expect(book.size).toBe(0);
  });
});

describe('M05 定位编排：敏感字段只走必要端口', () => {
  it('结果对象不含明文手机号 / 联系人全名；脱敏视图只给掩码', async () => {
    const book = new AddressBook();
    const machine = new LocationPermissionMachine();
    const result = await locateAndBind({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      ...CONTACT,
    });

    expect('phone' in result).toBe(false);
    expect('contactName' in result).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CONTACT.phone);
    expect(serialized).not.toContain(CONTACT.contactName);

    const view = toAddressView(book.require(result.addressId ?? ''));
    expect(view.phoneMasked).toBe(maskPhone(CONTACT.phone));
    expect(JSON.stringify(view)).not.toContain(CONTACT.phone);
    expect(JSON.stringify(view)).not.toContain(CONTACT.contactName);
  });
});

describe('M05 操作面声明', () => {
  it('全部操作不触碰真实平台；locateAndBind 标为需要权限，applyLocationFix 不需要', () => {
    expect(ADDRESS_DELIVERY_OPERATIONS.length).toBeGreaterThan(0);
    for (const op of ADDRESS_DELIVERY_OPERATIONS) {
      expect(op.touchesRealPlatform, `${op.name} 不应触碰真实平台`).toBe(false);
    }
    expect(ADDRESS_DELIVERY_OPERATIONS.find((op) => op.name === 'locateAndBind')?.needsPermission).toBe(true);
    expect(ADDRESS_DELIVERY_OPERATIONS.find((op) => op.name === 'applyLocationFix')?.needsPermission).toBe(false);
  });
});
