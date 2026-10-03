/**
 * 地址绑定与失效判定 —— 「地址版本不符的确认必须失效」的执行点。
 *
 * 一份报价/确认在生成时钉住当时的地址状态（`AddressBinding`）。之后地址一旦
 * 被修改或删除，`checkAddressBinding` 就会给出显式失效原因，`requireAddressBinding`
 * 则直接抛 `AddressStaleError`——**不静默沿用**。
 *
 * 复用 M04 的思路与类型：`AddressBinding` 与 `QuoteRequestDelivery` 的关键字段
 * （`addressRef`）一致，因此 M05 的绑定检查与 M04 的 `paramsDigest` 检查互相印证。
 *
 * ## 合并配送方案（`DeliveryPlan`）
 *
 * 地址绑定与时段选择此前是**两个独立对象**：改配送时间不会让地址绑定失效。
 * 本文件下半部分把三者（`addressRef` + `slotId` + `slotExpiresAt`）合成**一个**
 * 指纹引用 `planRef`：`createDeliveryPlan` 生成，`checkDeliveryPlan` /
 * `requireDeliveryPlan` 判定，任一要素变化即失效。
 */

import { computeDeliveryPlanDigest, parseAddressRef } from './digest.js';
import { AddressStaleError, AddressValidationError, DeliveryPlanStaleError } from './errors.js';
import type {
  AddressBinding,
  AddressBindingCheck,
  AddressBookView,
  AddressRecord,
  AddressStaleReason,
  DeliveryPlan,
  DeliveryPlanCheck,
  DeliveryPlanCheckInput,
  DeliveryPlanInput,
  DeliveryPlanStaleReason,
  DeliverySlot,
} from './types.js';

/** 失效原因的固定顺序（便于验收逐条比对）。 */
export const ADDRESS_STALE_REASON_ORDER: readonly AddressStaleReason[] = Object.freeze([
  'address_removed',
  'version_changed',
  'content_changed',
]);

/** 从地址记录取出绑定。 */
export function bindingOf(record: AddressRecord): AddressBinding {
  return Object.freeze({
    addressRef: record.ref,
    addressId: record.addressId,
    version: record.version,
    contentDigest: record.contentDigest,
  });
}

/** 判定一份地址绑定现在还能不能用。**显式给出全部原因**，不静默沿用。 */
export function checkAddressBinding(binding: AddressBinding, book: AddressBookView): AddressBindingCheck {
  const current = book.get(binding.addressId);
  const reasons: AddressStaleReason[] = [];
  if (current === undefined) {
    reasons.push('address_removed');
  } else {
    if (current.version !== binding.version || current.ref !== binding.addressRef) {
      reasons.push('version_changed');
    }
    if (current.contentDigest !== binding.contentDigest) {
      reasons.push('content_changed');
    }
  }
  const ordered = ADDRESS_STALE_REASON_ORDER.filter((reason) => reasons.includes(reason));
  const detail =
    ordered.length === 0
      ? '地址绑定可用：版本与内容均未变化'
      : ordered
          .map((reason) => {
            switch (reason) {
              case 'address_removed':
                return '地址已被删除';
              case 'version_changed':
                return `地址版本已变化（绑定 v${binding.version}，当前 v${current?.version ?? -1}）`;
              case 'content_changed':
                return '地址内容已变化（内容指纹不符）';
            }
          })
          .join('；');
  return Object.freeze({
    usable: ordered.length === 0,
    addressRef: binding.addressRef,
    reasons: Object.freeze(ordered),
    detail,
  });
}

/** 要求绑定可用：不可用则抛 `AddressStaleError`。这是「旧确认不能继续往下走」的关卡。 */
export function requireAddressBinding(binding: AddressBinding, book: AddressBookView): AddressBinding {
  const check = checkAddressBinding(binding, book);
  if (!check.usable) {
    throw new AddressStaleError(binding.addressRef, check.reasons, check.detail);
  }
  return binding;
}

/* -------------------------------------------------------------------------- */
/* 合并配送方案（DeliveryPlan）：地址 + 时段 + 过期点 单一绑定                    */
/* -------------------------------------------------------------------------- */

/** 配送方案失效原因的固定顺序（便于验收逐条比对）。 */
export const DELIVERY_PLAN_STALE_REASON_ORDER: readonly DeliveryPlanStaleReason[] = Object.freeze([
  'plan_ref_mismatch',
  'address_removed',
  'address_changed',
  'slot_changed',
  'slot_missing',
  'slot_unavailable',
  'slot_expiry_changed',
  'plan_expired',
]);

function requirePlanText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AddressValidationError(`配送方案 ${label} 不能为空`);
  }
  return value;
}

/**
 * 由三要素构造配送方案。`planRef` **由内容导出**，不由调用方给——因此三者
 * 任一变化必然得到不同的 `planRef`，旧方案必然对不上。
 *
 * `slotExpiresAt` 必须是有限数（拒绝 `NaN` / `Infinity`，避免被规范化成 `null`
 * 而与别的方案撞指纹）。
 */
export function createDeliveryPlan(input: DeliveryPlanInput): DeliveryPlan {
  const addressRef = requirePlanText(input.addressRef, 'addressRef');
  const slotId = requirePlanText(input.slotId, 'slotId');
  if (typeof input.slotExpiresAt !== 'number' || !Number.isFinite(input.slotExpiresAt)) {
    throw new AddressValidationError(
      `配送方案 slotExpiresAt 必须是有限数，收到 ${String(input.slotExpiresAt)}`,
    );
  }
  const planRef = computeDeliveryPlanDigest({ addressRef, slotId, slotExpiresAt: input.slotExpiresAt });
  return Object.freeze({ planRef, addressRef, slotId, slotExpiresAt: input.slotExpiresAt });
}

/** 由「地址记录 + 已选时段」构造方案：取 `record.ref` 与 `slot.slotId` / `slot.endAt`。 */
export function createDeliveryPlanFromSlot(record: AddressRecord, slot: DeliverySlot): DeliveryPlan {
  return createDeliveryPlan({
    addressRef: record.ref,
    slotId: slot.slotId,
    slotExpiresAt: slot.endAt,
  });
}

/**
 * 判定一份配送方案现在还能不能用。**显式给出全部原因**，不静默沿用。
 *
 * 判定四组：
 * 1. **方案自洽**：字段重算的指纹须等于 `planRef`（防手改字段留下旧引用）；
 * 2. **地址**：`addressRef` 解析出的地址须仍存在且引用逐字相符（版本/内容变了即不符）；
 * 3. **时段**：当前选中的时段 id 须与方案一致，且该时段仍在可用表里、仍 `available`、
 *    过期点未变；
 * 4. **过期**：`now >= slotExpiresAt` 即过期。
 */
export function checkDeliveryPlan(plan: DeliveryPlan, input: DeliveryPlanCheckInput): DeliveryPlanCheck {
  const reasons: DeliveryPlanStaleReason[] = [];

  const recomputed = computeDeliveryPlanDigest({
    addressRef: plan.addressRef,
    slotId: plan.slotId,
    slotExpiresAt: plan.slotExpiresAt,
  });
  if (recomputed !== plan.planRef) {
    reasons.push('plan_ref_mismatch');
  }

  const parsed = parseAddressRef(plan.addressRef);
  if (parsed === null) {
    reasons.push('address_removed');
  } else {
    const current = input.book.get(parsed.addressId);
    if (current === undefined) {
      reasons.push('address_removed');
    } else if (current.ref !== plan.addressRef) {
      reasons.push('address_changed');
    }
  }

  if (input.currentSlotId === null || input.currentSlotId !== plan.slotId) {
    reasons.push('slot_changed');
  } else {
    const slot = input.slots.find((candidate) => candidate.slotId === plan.slotId);
    if (slot === undefined) {
      reasons.push('slot_missing');
    } else {
      if (!slot.available) reasons.push('slot_unavailable');
      if (slot.endAt !== plan.slotExpiresAt) reasons.push('slot_expiry_changed');
    }
  }

  if (Number.isFinite(input.now) && input.now >= plan.slotExpiresAt) {
    reasons.push('plan_expired');
  }

  const ordered = DELIVERY_PLAN_STALE_REASON_ORDER.filter((reason) => reasons.includes(reason));
  const detail =
    ordered.length === 0
      ? '配送方案可用：地址、时段与过期点均未变化'
      : ordered
          .map((reason) => {
            switch (reason) {
              case 'plan_ref_mismatch':
                return '方案指纹与字段不符（引用被篡改或字段被改）';
              case 'address_removed':
                return '方案绑定的地址已被删除或引用形状非法';
              case 'address_changed':
                return '方案绑定的地址已变化（版本/内容不符）';
              case 'slot_changed':
                return '当前选中的时段与方案不一致';
              case 'slot_missing':
                return '方案绑定的时段已不在当前时段表里';
              case 'slot_unavailable':
                return '方案绑定的时段当前不可用';
              case 'slot_expiry_changed':
                return '方案绑定的时段过期点已变化';
              case 'plan_expired':
                return `配送方案已过期（过期点 ${String(plan.slotExpiresAt)}，当前 ${String(input.now)}）`;
            }
          })
          .join('；');
  return Object.freeze({
    usable: ordered.length === 0,
    planRef: plan.planRef,
    reasons: Object.freeze(ordered),
    detail,
  });
}

/** 要求配送方案可用：不可用则抛 `DeliveryPlanStaleError`。旧的 `planRef` 到此为止。 */
export function requireDeliveryPlan(plan: DeliveryPlan, input: DeliveryPlanCheckInput): DeliveryPlan {
  const check = checkDeliveryPlan(plan, input);
  if (!check.usable) {
    throw new DeliveryPlanStaleError(plan.planRef, check.reasons, check.detail);
  }
  return plan;
}
