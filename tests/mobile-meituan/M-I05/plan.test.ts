/**
 * M-I05 合并配送方案（DeliveryPlan）：地址 + 时段 + 过期点 单一绑定。
 *
 * 背景（M05 nextIncrement）：此前地址绑定与时段选择是**两个独立对象**——改配送
 * 时间不会让地址绑定失效，改地址也不会让时段选择失效。本文件验证新引入的
 * `DeliveryPlan` 把三者合成一个 `planRef`：
 *
 * - 任一要素变化 ⇒ 新 `planRef`、旧方案失效；
 * - 被拒 / 定位失败 ⇒ 不产生方案、不产生地址、不替换默认地址（保留 locateAndBind 语义）；
 * - 每个「应失效」用例都同时断言**对照面**（未变化时确实可用），避免空壳实现骗过测试。
 *
 * 全部为本地纯逻辑：不接真实平台、不请求系统权限、不发起真实定位、不读系统时间。
 */

import { describe, expect, it } from 'vitest';

import {
  ADDRESS_DELIVERY_OPERATIONS,
  AddressBook,
  AddressValidationError,
  DELIVERY_PLAN_STALE_REASON_ORDER,
  DeliveryPlanStaleError,
  DeliverySlotSelector,
  LocationPermissionMachine,
  canonicalDeliveryPlanPayload,
  checkDeliveryPlan,
  computeDeliveryPlanDigest,
  createDeliveryPlan,
  createDeliveryPlanFromSlot,
  createFailingLocationFixPort,
  createFixtureLocationFixPort,
  createFixtureSlotPort,
  locateAndPlan,
  requireDeliveryPlan,
  type DeliveryPlan,
  type DeliverySlot,
  type LocationFix,
} from '../../../src/mobile-plugins/meituan/address-delivery/index.js';
import { createFixtureLocationPort, makeBook, standardSlots, STEP_MS, T0 } from './support.js';

/** 一次「定位得到的位置」。坐标/区划/详址全部来自端口，本包不产生任何真实坐标。 */
const FIX_HOME: LocationFix = {
  region: '上海市徐汇区',
  detail: '定位路 1 号',
  lat: 31.19,
  lng: 121.43,
  provider: 'fixture-geo',
};

const CONTACT = { contactName: '张三', phone: '13800008000' };

function slotById(slots: readonly DeliverySlot[], slotId: string): DeliverySlot {
  const found = slots.find((slot) => slot.slotId === slotId);
  if (found === undefined) throw new Error(`测试夹具缺少时段 ${slotId}`);
  return found;
}

/** 造一个已选好 slot-1 的选择器（供 checkDeliveryPlan 取「当前选择」）。 */
async function selectorWith(slotId: string, addressRef: string, now = T0): Promise<DeliverySlotSelector> {
  const selector = new DeliverySlotSelector();
  await selector.load(createFixtureSlotPort(standardSlots()), {
    merchantId: 'merchant-1',
    addressRef,
    now,
  });
  selector.select(slotId);
  return selector;
}

describe('M-I05 配送方案：三要素合成单一 planRef', () => {
  it('planRef 由内容导出：dp1- 前缀、确定性、冻结', () => {
    const a = createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: 'slot-1', slotExpiresAt: T0 + 2 * STEP_MS });
    const b = createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: 'slot-1', slotExpiresAt: T0 + 2 * STEP_MS });

    expect(a.planRef.startsWith('dp1-')).toBe(true);
    expect(a.planRef).toBe(b.planRef);
    expect(a.planRef).toBe(
      computeDeliveryPlanDigest({ addressRef: 'addr-home#v1', slotId: 'slot-1', slotExpiresAt: T0 + 2 * STEP_MS }),
    );
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('规范载荷确实覆盖三要素（地址、时段 id、过期点）', () => {
    const payload = canonicalDeliveryPlanPayload({
      addressRef: 'addr-home#v1',
      slotId: 'slot-7',
      slotExpiresAt: 123456,
    });
    expect(payload).toContain('addr-home#v1');
    expect(payload).toContain('slot-7');
    expect(payload).toContain('123456');
  });

  it('地址 / 时段 / 过期点任一变化 ⇒ planRef 必变（两两不同）', () => {
    const base = createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: 'slot-1', slotExpiresAt: T0 + 2 * STEP_MS });
    const otherAddress = createDeliveryPlan({
      addressRef: 'addr-home#v2',
      slotId: 'slot-1',
      slotExpiresAt: T0 + 2 * STEP_MS,
    });
    const otherSlot = createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: 'slot-2', slotExpiresAt: T0 + 2 * STEP_MS });
    const otherExpiry = createDeliveryPlan({
      addressRef: 'addr-home#v1',
      slotId: 'slot-1',
      slotExpiresAt: T0 + 3 * STEP_MS,
    });

    const refs = [base.planRef, otherAddress.planRef, otherSlot.planRef, otherExpiry.planRef];
    expect(new Set(refs).size).toBe(4);
  });

  it('createDeliveryPlanFromSlot 取 record.ref + slot.slotId + slot.endAt', () => {
    const book = makeBook();
    const slot = slotById(standardSlots(), 'slot-2');
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slot);

    expect(plan.addressRef).toBe(book.require('addr-home').ref);
    expect(plan.slotId).toBe('slot-2');
    expect(plan.slotExpiresAt).toBe(slot.endAt);
  });

  it('非法输入（空 ref / 空 slotId / 非有限过期点）显式抛错', () => {
    expect(() => createDeliveryPlan({ addressRef: '', slotId: 'slot-1', slotExpiresAt: T0 })).toThrow(
      AddressValidationError,
    );
    expect(() => createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: '', slotExpiresAt: T0 })).toThrow(
      AddressValidationError,
    );
    expect(() =>
      createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: 'slot-1', slotExpiresAt: Number.NaN }),
    ).toThrow(AddressValidationError);
    expect(() =>
      createDeliveryPlan({ addressRef: 'addr-home#v1', slotId: 'slot-1', slotExpiresAt: Number.POSITIVE_INFINITY }),
    ).toThrow(AddressValidationError);
  });
});

describe('M-I05 失效：地址变化 ⇒ 旧方案不再可用', () => {
  it('地址版本一变，旧 planRef 失效，重建得到不同 planRef', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const selector = await selectorWith('slot-1', book.require('addr-home').ref);
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    const input = { book, now: T0, currentSlotId: selector.selectedSlotId, slots };

    expect(checkDeliveryPlan(plan, input).usable).toBe(true);

    book.update('addr-home', { detail: '换了门牌 202 室' });

    const after = checkDeliveryPlan(plan, input);
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('address_changed');
    // 这是「当前状态」失效，不是方案自身被篡改。
    expect(after.reasons).not.toContain('plan_ref_mismatch');
    expect(() => requireDeliveryPlan(plan, input)).toThrow(DeliveryPlanStaleError);

    const rebuilt = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    expect(rebuilt.planRef).not.toBe(plan.planRef);
  });

  it('地址被删除 ⇒ address_removed', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const selector = await selectorWith('slot-1', book.require('addr-home').ref);
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));

    book.remove('addr-home');

    const after = checkDeliveryPlan(plan, { book, now: T0, currentSlotId: selector.selectedSlotId, slots });
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('address_removed');
  });
});

describe('M-I05 失效：时段变化 ⇒ 旧方案不再可用（补上「改配送时间不失效」的洞）', () => {
  it('地址引用不变，仅换时段 ⇒ 旧 planRef 失效，重建得到不同 planRef', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const selector = await selectorWith('slot-1', book.require('addr-home').ref);
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    const common = { book, now: T0, slots };

    expect(checkDeliveryPlan(plan, { ...common, currentSlotId: 'slot-1' }).usable).toBe(true);

    selector.select('slot-2');
    const after = checkDeliveryPlan(plan, { ...common, currentSlotId: selector.selectedSlotId });
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('slot_changed');

    const rebuilt = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-2'));
    expect(rebuilt.planRef).not.toBe(plan.planRef);
  });

  it('时段从可用表里消失 ⇒ slot_missing', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    const withoutSlot1 = slots.filter((slot) => slot.slotId !== 'slot-1');

    const after = checkDeliveryPlan(plan, { book, now: T0, currentSlotId: 'slot-1', slots: withoutSlot1 });
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('slot_missing');
  });

  it('同 id 时段变为不可用 ⇒ slot_unavailable', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    const slot1 = slotById(slots, 'slot-1');
    const flipped = slots.map((slot) => (slot.slotId === 'slot-1' ? { ...slot, available: false } : slot));

    const after = checkDeliveryPlan(plan, { book, now: T0, currentSlotId: 'slot-1', slots: flipped });
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('slot_unavailable');
    // 过期点没变，不该误报 slot_expiry_changed。
    expect(after.reasons).not.toContain('slot_expiry_changed');
    expect(slot1.available).toBe(true);
  });

  it('同 id 时段过期点变化 ⇒ slot_expiry_changed', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    const moved = slots.map((slot) =>
      slot.slotId === 'slot-1' ? { ...slot, endAt: slot.endAt + STEP_MS } : slot,
    );

    const after = checkDeliveryPlan(plan, { book, now: T0, currentSlotId: 'slot-1', slots: moved });
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('slot_expiry_changed');
  });
});

describe('M-I05 失效：过期点到达 ⇒ plan_expired', () => {
  it('过期前可用，到达过期点即失效（对照非空壳）', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const slot1 = slotById(slots, 'slot-1'); // endAt = T0 + 2*STEP
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slot1);
    const base = { book, currentSlotId: 'slot-1', slots };

    const before = checkDeliveryPlan(plan, { ...base, now: slot1.endAt - 1 });
    expect(before.usable).toBe(true);
    expect(before.reasons).toHaveLength(0);

    const atExpiry = checkDeliveryPlan(plan, { ...base, now: slot1.endAt });
    expect(atExpiry.usable).toBe(false);
    expect(atExpiry.reasons).toContain('plan_expired');
    expect(() => requireDeliveryPlan(plan, { ...base, now: slot1.endAt })).toThrow(DeliveryPlanStaleError);
  });
});

describe('M-I05 方案自洽与原因顺序', () => {
  it('planRef 与字段不符（被篡改）⇒ plan_ref_mismatch', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slotById(slots, 'slot-1'));
    const tampered: DeliveryPlan = { ...plan, planRef: 'dp1-00000000' };

    const after = checkDeliveryPlan(tampered, { book, now: T0, currentSlotId: 'slot-1', slots });
    expect(after.usable).toBe(false);
    expect(after.reasons).toContain('plan_ref_mismatch');
  });

  it('原因按固定顺序输出（address_changed 在 plan_expired 之前）', async () => {
    const book = makeBook();
    const slots = standardSlots();
    const slot1 = slotById(slots, 'slot-1');
    const plan = createDeliveryPlanFromSlot(book.require('addr-home'), slot1);

    book.update('addr-home', { detail: '又换了门牌' });

    const after = checkDeliveryPlan(plan, {
      book,
      now: slot1.endAt,
      currentSlotId: 'slot-1',
      slots,
    });
    expect(after.reasons).toEqual(['address_changed', 'plan_expired']);
    expect(DELIVERY_PLAN_STALE_REASON_ORDER).toEqual([
      'plan_ref_mismatch',
      'address_removed',
      'address_changed',
      'slot_changed',
      'slot_missing',
      'slot_unavailable',
      'slot_expiry_changed',
      'plan_expired',
    ]);
  });
});

describe('M-I05 编排 locateAndPlan：授权成功绑定单一方案', () => {
  it('已授权 + 显式时段 ⇒ bound，planRef 覆盖地址、时段与过期点', async () => {
    const book = makeBook();
    const machine = new LocationPermissionMachine();
    const selector = new DeliverySlotSelector();

    const result = await locateAndPlan({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      slotPort: createFixtureSlotPort(standardSlots()),
      slotSelector: selector,
      merchantId: 'merchant-1',
      now: T0,
      slotId: 'slot-2',
      ...CONTACT,
    });

    expect(result.status).toBe('bound');
    expect(result.plan).not.toBeNull();
    expect(result.planRef).not.toBeNull();
    expect(result.planRef).toBe(result.plan?.planRef);
    expect(result.requiresExplicitSelection).toBe(false);
    expect(result.addressRef).not.toBeNull();

    const record = book.require(result.plan?.addressRef.split('#')[0] ?? '');
    expect(result.plan?.addressRef).toBe(record.ref);
    expect(result.plan?.slotId).toBe('slot-2');
    expect(result.plan?.slotExpiresAt).toBe(slotById(standardSlots(), 'slot-2').endAt);
    expect(result.check?.usable).toBe(true);
  });
});

describe('M-I05 编排 locateAndPlan：被拒 / 失败不产生方案、不换默认地址', () => {
  it('被拒 ⇒ permission_denied，plan/planRef/addressRef 恒 null，未定位、未新增、默认地址不变', async () => {
    const book = makeBook();
    const sizeBefore = book.size;
    const machine = new LocationPermissionMachine();
    const fixPort = createFixtureLocationFixPort(FIX_HOME);
    const selector = new DeliverySlotSelector();

    const result = await locateAndPlan({
      book,
      machine,
      permissionPort: createFixtureLocationPort('denied'),
      fixPort,
      slotPort: createFixtureSlotPort(standardSlots()),
      slotSelector: selector,
      merchantId: 'merchant-1',
      now: T0,
      slotId: 'slot-1',
      ...CONTACT,
    });

    expect(result.status).toBe('permission_denied');
    expect(result.permission).toBe('denied');
    expect(result.plan).toBeNull();
    expect(result.planRef).toBeNull();
    expect(result.addressRef).toBeNull();
    expect(result.requiresExplicitSelection).toBe(true);
    expect(result.check).toBeNull();
    // 未授权不得尝试定位。
    expect(fixPort.calls).toBe(0);
    // 不得新增/替换地址；默认地址原样保留；也没有「回退到默认地址引用」。
    expect(book.size).toBe(sizeBefore);
    expect(book.defaultAddress?.addressId).toBe('addr-home');
    expect(result.addressRef).not.toBe(book.defaultAddress?.ref);
  });

  it('**决定性对照**：同一地址簿，只有权限不同，结果就不同', async () => {
    const make = () => ({
      book: makeBook(),
      machine: new LocationPermissionMachine(),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      slotPort: createFixtureSlotPort(standardSlots()),
      slotSelector: new DeliverySlotSelector(),
      merchantId: 'merchant-1',
      now: T0,
      slotId: 'slot-1',
      ...CONTACT,
    });

    const denied = await locateAndPlan({ ...make(), permissionPort: createFixtureLocationPort('denied') });
    const granted = await locateAndPlan({ ...make(), permissionPort: createFixtureLocationPort('granted') });

    expect(granted.status).toBe('bound');
    expect(granted.planRef).not.toBeNull();
    expect(denied.status).toBe('permission_denied');
    expect(denied.planRef).toBeNull();
    expect(denied.planRef).not.toBe(granted.planRef);
  });

  it('授权但定位失败 ⇒ location_failed，不产生方案与地址', async () => {
    const book = makeBook();
    const machine = new LocationPermissionMachine();
    const sizeBefore = book.size;

    const result = await locateAndPlan({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFailingLocationFixPort('GPS 不可用'),
      slotPort: createFixtureSlotPort(standardSlots()),
      slotSelector: new DeliverySlotSelector(),
      merchantId: 'merchant-1',
      now: T0,
      slotId: 'slot-1',
      ...CONTACT,
    });

    expect(result.status).toBe('location_failed');
    expect(result.plan).toBeNull();
    expect(result.planRef).toBeNull();
    expect(result.addressRef).toBeNull();
    expect(result.requiresExplicitSelection).toBe(true);
    expect(book.size).toBe(sizeBefore);
    expect(book.defaultAddress?.addressId).toBe('addr-home');
  });

  it('定位成功但未选时段 ⇒ no_slot：地址已绑定，方案未生成，不自动挑时段', async () => {
    const book = makeBook();
    const machine = new LocationPermissionMachine();

    const result = await locateAndPlan({
      book,
      machine,
      permissionPort: createFixtureLocationPort('granted'),
      fixPort: createFixtureLocationFixPort(FIX_HOME),
      slotPort: createFixtureSlotPort(standardSlots()),
      slotSelector: new DeliverySlotSelector(),
      merchantId: 'merchant-1',
      now: T0,
      ...CONTACT,
    });

    expect(result.status).toBe('no_slot');
    expect(result.plan).toBeNull();
    expect(result.planRef).toBeNull();
    expect(result.addressRef).not.toBeNull();
    expect(result.check).toBeNull();
    expect(book.defaultAddress?.addressId).toBe('addr-home');
  });
});

describe('M-I05 操作面声明', () => {
  it('createDeliveryPlan / checkDeliveryPlan 为本地纯逻辑；locateAndPlan 需要权限', () => {
    for (const op of ADDRESS_DELIVERY_OPERATIONS) {
      expect(op.touchesRealPlatform, `${op.name} 不应触碰真实平台`).toBe(false);
    }
    expect(ADDRESS_DELIVERY_OPERATIONS.find((op) => op.name === 'locateAndPlan')?.needsPermission).toBe(true);
    expect(ADDRESS_DELIVERY_OPERATIONS.find((op) => op.name === 'createDeliveryPlan')?.needsPermission).toBe(false);
  });
});
