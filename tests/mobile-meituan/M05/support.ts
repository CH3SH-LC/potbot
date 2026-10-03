/**
 * M05 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景都由**显式 fixture** 驱动：地址簿、定位端口、时段端口全部本地可控。
 * 这里没有真实定位、没有系统权限、没有网络、没有系统时间。
 */

import {
  AddressBook,
  buildSlots,
  createFixtureLocationPort,
  createFixtureSlotPort,
  type AddressInput,
  type DeliverySlot,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 1_700_000_000_000;

/** 一个时段的长度（30 分钟）。 */
export const STEP_MS = 30 * 60 * 1000;

export function baseAddressInput(overrides: Partial<AddressInput> = {}): AddressInput {
  return {
    addressId: 'addr-home',
    label: '家',
    contactName: '张三',
    phone: '13800008000',
    region: '上海市徐汇区',
    detail: '某某路 100 弄 1 号 101 室',
    lat: 31.19,
    lng: 121.43,
    source: 'manual',
    ...overrides,
  };
}

/** 地址簿：家（默认）+ 公司。定位地址由用例按需再加。 */
export function makeBook(): AddressBook {
  const book = new AddressBook();
  book.add(baseAddressInput());
  book.add(
    baseAddressInput({
      addressId: 'addr-office',
      label: '公司',
      contactName: '李四',
      phone: '13900009000',
      region: '上海市浦东新区',
      detail: '某某大道 200 号 5 楼',
      lat: 31.23,
      lng: 121.47,
    }),
  );
  book.setDefault('addr-home');
  return book;
}

/** 标准时段：4 段，第 3 段（slot-3）不可用。 */
export function standardSlots(): readonly DeliverySlot[] {
  return buildSlots(T0 + STEP_MS, STEP_MS, 4, { unavailableIndexes: [2] });
}

export { createFixtureLocationPort, createFixtureSlotPort };
