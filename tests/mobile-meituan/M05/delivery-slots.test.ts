/**
 * M05 配送时间段：加载、选择、失效判定。
 *
 * 纪律：未知/不可用时段显式抛错；换地址后旧选择作废。
 */

import { describe, expect, it } from 'vitest';

import {
  DeliverySlotError,
  DeliverySlotSelector,
  SlotStaleError,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { STEP_MS, T0, createFixtureSlotPort, standardSlots } from './support.js';

const HOME_REF = 'addr-home#v1';
const OFFICE_REF = 'addr-office#v1';

async function loadedSelector() {
  const selector = new DeliverySlotSelector();
  const port = createFixtureSlotPort(standardSlots());
  await selector.load(port, { merchantId: 'merchant-1', addressRef: HOME_REF, now: T0 });
  return { selector, port };
}

describe('M05 配送时段：加载', () => {
  it('加载后 slots / addressRef / fetchedAt 就位，且没有默认选择', async () => {
    const { selector, port } = await loadedSelector();

    expect(selector.loaded).toBe(true);
    expect(selector.slots.map((s) => s.slotId)).toEqual(['slot-1', 'slot-2', 'slot-3', 'slot-4']);
    expect(selector.addressRef).toBe(HOME_REF);
    expect(selector.fetchedAt).toBe(T0);
    expect(selector.selectedSlotId).toBeNull();
    expect(port.requests).toEqual([{ merchantId: 'merchant-1', addressRef: HOME_REF, now: T0 }]);
  });

  it('非法入参（空引用 / 非有限 now）显式抛错', async () => {
    const selector = new DeliverySlotSelector();
    const port = createFixtureSlotPort(standardSlots());
    await expect(selector.load(port, { merchantId: 'm', addressRef: '', now: T0 })).rejects.toThrow(DeliverySlotError);
    await expect(selector.load(port, { merchantId: 'm', addressRef: HOME_REF, now: Number.NaN })).rejects.toThrow(
      DeliverySlotError,
    );
  });

  it('端口给出重复 slotId / 非法区间 ⇒ 显式抛错', async () => {
    const selector = new DeliverySlotSelector();
    const duplicated = createFixtureSlotPort([
      { slotId: 'slot-1', label: 'a', startAt: T0, endAt: T0 + STEP_MS, available: true },
      { slotId: 'slot-1', label: 'b', startAt: T0, endAt: T0 + STEP_MS, available: true },
    ]);
    await expect(selector.load(duplicated, { merchantId: 'm', addressRef: HOME_REF, now: T0 })).rejects.toThrow(
      DeliverySlotError,
    );

    const inverted = createFixtureSlotPort([
      { slotId: 'slot-1', label: 'a', startAt: T0 + STEP_MS, endAt: T0, available: true },
    ]);
    await expect(selector.load(inverted, { merchantId: 'm', addressRef: HOME_REF, now: T0 })).rejects.toThrow(
      DeliverySlotError,
    );
  });
});

describe('M05 配送时段：选择', () => {
  it('选中可用时段', async () => {
    const { selector } = await loadedSelector();
    const slot = selector.select('slot-1');
    expect(slot.slotId).toBe('slot-1');
    expect(selector.selectedSlotId).toBe('slot-1');
    expect(selector.selectedSlot()?.slotId).toBe('slot-1');
  });

  it('选中不可用时段 ⇒ 抛错', async () => {
    const { selector } = await loadedSelector();
    expect(() => selector.select('slot-3')).toThrow(DeliverySlotError);
    expect(selector.selectedSlotId).toBeNull();
  });

  it('选中未知时段 ⇒ 抛错', async () => {
    const { selector } = await loadedSelector();
    expect(() => selector.select('slot-99')).toThrow(DeliverySlotError);
  });

  it('未加载就选择 ⇒ 抛错', () => {
    const selector = new DeliverySlotSelector();
    expect(() => selector.select('slot-1')).toThrow(DeliverySlotError);
  });

  it('重新加载（换地址）会清空旧选择，旧选择不再成立', async () => {
    const { selector } = await loadedSelector();
    selector.select('slot-1');
    expect(selector.selectedSlotId).toBe('slot-1');

    await selector.load(createFixtureSlotPort(standardSlots()), {
      merchantId: 'merchant-1',
      addressRef: OFFICE_REF,
      now: T0,
    });

    expect(selector.selectedSlotId).toBeNull();
    const check = selector.checkSelection({ now: T0, addressRef: OFFICE_REF });
    expect(check.usable).toBe(false);
    expect(check.reasons).toContain('no_selection');
  });
});

describe('M05 配送时段：失效判定', () => {
  it('未加载 ⇒ not_loaded', () => {
    const selector = new DeliverySlotSelector();
    expect(selector.checkSelection({ now: T0, addressRef: HOME_REF }).reasons).toContain('not_loaded');
  });

  it('已加载未选择 ⇒ no_selection', async () => {
    const { selector } = await loadedSelector();
    expect(selector.checkSelection({ now: T0, addressRef: HOME_REF }).reasons).toContain('no_selection');
  });

  it('选择后立即可用（防止「恒失效」空壳）', async () => {
    const { selector } = await loadedSelector();
    selector.select('slot-1');
    const check = selector.checkSelection({ now: T0, addressRef: HOME_REF });
    expect(check.usable).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(selector.requireUsableSelection({ now: T0, addressRef: HOME_REF }).slotId).toBe('slot-1');
  });

  it('地址引用变化 ⇒ address_changed', async () => {
    const { selector } = await loadedSelector();
    selector.select('slot-1');
    const check = selector.checkSelection({ now: T0, addressRef: OFFICE_REF });
    expect(check.usable).toBe(false);
    expect(check.reasons).toContain('address_changed');
  });

  it('时段已结束 ⇒ slot_expired，requireUsableSelection 抛 SlotStaleError', async () => {
    const { selector } = await loadedSelector();
    selector.select('slot-1');
    const expiredAt = T0 + STEP_MS * 5;

    const check = selector.checkSelection({ now: expiredAt, addressRef: HOME_REF });
    expect(check.usable).toBe(false);
    expect(check.reasons).toContain('slot_expired');
    expect(() => selector.requireUsableSelection({ now: expiredAt, addressRef: HOME_REF })).toThrow(SlotStaleError);
  });
});
