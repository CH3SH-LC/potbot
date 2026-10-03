/**
 * M05 地址与配送 —— 错误类型。
 *
 * 纪律：所有失败都**显式抛出**。尤其是「权限被拒且没有显式选择」时，
 * 必须抛 `AddressSelectionRequiredError`，绝不静默换成另一个地址。
 */

import type { AddressStaleReason, DeliveryPlanStaleReason, SlotStaleReason } from './types.js';

/** 本包全部错误的基类。 */
export class AddressDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressDeliveryError';
  }
}

/** 入参/状态不合法（空 id、非法手机号、未知地址等）。 */
export class AddressValidationError extends AddressDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = 'AddressValidationError';
  }
}

/** 地址不存在。 */
export class AddressNotFoundError extends AddressDeliveryError {
  constructor(addressId: string) {
    super(`地址簿中不存在地址 ${addressId}`);
    this.name = 'AddressNotFoundError';
  }
}

/** 地址绑定已失效（版本/内容变化或被删除）。 */
export class AddressStaleError extends AddressDeliveryError {
  readonly addressRef: string;
  readonly reasons: readonly AddressStaleReason[];

  constructor(addressRef: string, reasons: readonly AddressStaleReason[], detail: string) {
    super(`地址绑定 ${addressRef} 已失效（${reasons.join(' / ')}）：${detail}`);
    this.name = 'AddressStaleError';
    this.addressRef = addressRef;
    this.reasons = Object.freeze([...reasons]);
  }
}

/**
 * 需要用户显式选择地址（未授权/被拒/撤销且没有显式选择）。
 *
 * **这条错误就是「拒绝权限不得静默换地址」的执行点**：宁可失败，
 * 也不回退到默认地址或定位地址。
 */
export class AddressSelectionRequiredError extends AddressDeliveryError {
  readonly permission: string;

  constructor(permission: string, detail: string) {
    super(`需要用户显式选择地址（定位状态：${permission}）：${detail}`);
    this.name = 'AddressSelectionRequiredError';
    this.permission = permission;
  }
}

/** 定位授权状态机非法转移。 */
export class LocationPermissionError extends AddressDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = 'LocationPermissionError';
  }
}

/** 配送时段相关错误（未加载、未知时段、时段不可用/已过期）。 */
export class DeliverySlotError extends AddressDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = 'DeliverySlotError';
  }
}

/** 时段选择失效。 */
export class SlotStaleError extends AddressDeliveryError {
  readonly slotId: string;
  readonly reasons: readonly SlotStaleReason[];

  constructor(slotId: string, reasons: readonly SlotStaleReason[], detail: string) {
    super(`时段选择 ${slotId} 已失效（${reasons.join(' / ')}）：${detail}`);
    this.name = 'SlotStaleError';
    this.slotId = slotId;
    this.reasons = Object.freeze([...reasons]);
  }
}

/** 是否本包错误（便于用例做类型安全的断言）。 */
export function isAddressDeliveryError(value: unknown): value is AddressDeliveryError {
  return value instanceof AddressDeliveryError;
}

/**
 * 配送方案已失效（地址变化、时段变化 / 缺失 / 不可用 / 过期点变化，或方案已过期）。
 *
 * 与 `AddressStaleError` / `SlotStaleError` 对应：这是「地址 + 时段 + 过期点」
 * 合并绑定后**单一**的失效执行点——旧的 `planRef` 不能再往下走。
 */
export class DeliveryPlanStaleError extends AddressDeliveryError {
  readonly planRef: string;
  readonly reasons: readonly DeliveryPlanStaleReason[];

  constructor(planRef: string, reasons: readonly DeliveryPlanStaleReason[], detail: string) {
    super(`配送方案 ${planRef} 已失效（${reasons.join(' / ')}）：${detail}`);
    this.name = 'DeliveryPlanStaleError';
    this.planRef = planRef;
    this.reasons = Object.freeze([...reasons]);
  }
}
