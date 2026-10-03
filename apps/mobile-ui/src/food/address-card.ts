/**
 * F10 food / 地址卡 —— 消费 M05 配送解析结果，**权限被拒不换地址**。
 *
 * ## 纪律来自 M05
 *
 * M05 的 `resolveDelivery` 已经保证：定位被拒 / 撤销且无显式选择时，只返回
 * `needs_explicit_selection` 且 `selectedAddressRef === null`。本卡**只反映**这个结论，
 * 不自行回退到默认地址（`substitutesOnDenied` 恒为字面量 `false`）。
 *
 * ## 脱敏
 *
 * 卡面只使用 M05 的 `AddressView`（已脱敏：无手机号明文、无联系人全名）。
 * 完整字段唯一出口是 M05 的 `DeliveryDetailPort`（声明用途 + 引用版本校验），
 * 本卡**不碰**，也不持有任何明文。
 */

import type {
  AddressView,
  DeliveryResolution,
  DeliveryStatus,
  LocationPermissionState,
} from '../../../../src/mobile-plugins/meituan/address-delivery/index.js';

import type { FoodCardBase } from './types.js';

export interface AddressCardEntryView {
  readonly addressId: string;
  readonly label: string;
  readonly contactMasked: string;
  readonly phoneMasked: string;
  readonly region: string;
  readonly detail: string;
  readonly ref: string;
  readonly version: number;
  readonly isDefault: boolean;
  readonly selected: boolean;
}

export interface AddressCardView extends FoodCardBase {
  readonly kind: 'address';
  readonly status: DeliveryStatus;
  readonly permission: LocationPermissionState;
  readonly entries: readonly AddressCardEntryView[];
  readonly selectedAddressId: string | null;
  readonly selectedAddressRef: string | null;
  /** 选中地址的一行脱敏摘要；未选中为 `null`。 */
  readonly selectedMaskedLine: string | null;
  readonly requiresExplicitSelection: boolean;
  /** 恒为 `false`：权限被拒/撤销时**绝不**静默替换地址。 */
  readonly substitutesOnDenied: false;
  readonly detail: string;
}

export interface BuildAddressCardInput {
  readonly resolution: DeliveryResolution;
  /** 经过 M05 `toAddressViews` 脱敏的地址列表。 */
  readonly addresses: readonly AddressView[];
}

export function buildAddressCard(input: BuildAddressCardInput): AddressCardView {
  const { resolution } = input;
  const selectedId = resolution.selectedAddressId;

  const entries: AddressCardEntryView[] = input.addresses.map((address) =>
    Object.freeze({
      addressId: address.addressId,
      label: address.label,
      contactMasked: address.contactMasked,
      phoneMasked: address.phoneMasked,
      region: address.region,
      detail: address.detail,
      ref: address.ref,
      version: address.version,
      isDefault: address.isDefault,
      selected: address.addressId === selectedId,
    }),
  );

  const selected = input.addresses.find((address) => address.addressId === selectedId) ?? null;
  const selectedMaskedLine =
    selected === null
      ? null
      : `${selected.contactMasked} ${selected.phoneMasked} · ${selected.region}${selected.detail}`;

  return Object.freeze({
    kind: 'address',
    title: '配送地址',
    status: resolution.status,
    permission: resolution.permission,
    entries: Object.freeze(entries),
    selectedAddressId: selectedId,
    selectedAddressRef: resolution.selectedAddressRef,
    selectedMaskedLine,
    requiresExplicitSelection: resolution.requiresExplicitSelection,
    substitutesOnDenied: false,
    detail: resolution.detail,
  });
}

/** 该地址卡是否已就绪（可继续取价）。 */
export function isAddressReady(card: AddressCardView): boolean {
  return card.status === 'ready' && card.selectedAddressRef !== null;
}
