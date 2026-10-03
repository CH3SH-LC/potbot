/**
 * M05 配送视图解析 + 敏感字段出口。
 *
 * ## 核心纪律：权限被拒不换地址
 *
 * `resolveDelivery` 的解析优先级是**固定**的：
 *
 * 1. **用户显式选择的地址**（`explicitSelectionAddressId`）——唯一能绕开权限的路径。
 *    显式选了一个不存在的 id ⇒ `invalid_selection`（显式失败，不替换成别的地址）。
 * 2. 定位**已授权**时：优先用定位候选地址（`locatedAddressId`），否则用默认地址。
 * 3. 其余情况（未授权 / 被拒 / 撤销且无显式选择）⇒ `needs_explicit_selection`，
 *    `selectedAddressId` 恒为 `null`——**绝不**回退到默认地址或定位地址。
 *
 * 因此「被拒后自动换地址」在本模块里不是「靠自觉」，而是**没有那条代码路径**。
 */

import { parseAddressRef } from './digest.js';
import { AddressNotFoundError, AddressSelectionRequiredError, AddressValidationError } from './errors.js';
import { maskContactName, maskPhone } from './mask.js';
import type {
  AddressBookView,
  AddressRecord,
  AddressView,
  DeliveryDetail,
  DeliveryResolution,
  DeliveryResolutionInput,
  DeliverySelectionSource,
} from './types.js';

/** 把地址记录转成**脱敏**视图：不含手机号明文、不含联系人全名。 */
export function toAddressView(record: AddressRecord, options: { readonly isDefault?: boolean } = {}): AddressView {
  return Object.freeze({
    addressId: record.addressId,
    label: record.label,
    contactMasked: maskContactName(record.contactName),
    phoneMasked: maskPhone(record.phone),
    region: record.region,
    detail: record.detail,
    source: record.source,
    ref: record.ref,
    version: record.version,
    isDefault: options.isDefault ?? false,
  });
}

/** 地址簿的脱敏视图列表（顺序与 `list()` 一致；需要 `list` 的调用方传入）。 */
export function toAddressViews(
  records: readonly AddressRecord[],
  defaultAddressId: string | null,
): readonly AddressView[] {
  return Object.freeze(
    records.map((record) => toAddressView(record, { isDefault: record.addressId === defaultAddressId })),
  );
}

/**
 * 解析配送视图。见文件头「核心纪律」。
 */
export function resolveDelivery(input: DeliveryResolutionInput): DeliveryResolution {
  const explicitId = input.explicitSelectionAddressId ?? null;
  if (explicitId !== null) {
    const record = input.book.get(explicitId);
    if (record === undefined) {
      return freezeResolution({
        status: 'invalid_selection',
        permission: input.permission,
        selectedAddressId: null,
        selectedAddressRef: null,
        selectionSource: 'none',
        requiresExplicitSelection: true,
        detail: `显式选择的地址 ${explicitId} 不存在；不替换为其他地址，请重新选择`,
      });
    }
    return freezeResolution({
      status: 'ready',
      permission: input.permission,
      selectedAddressId: record.addressId,
      selectedAddressRef: record.ref,
      selectionSource: 'explicit_user_selection',
      requiresExplicitSelection: false,
      detail: '使用用户显式选择的地址',
    });
  }

  if (input.permission === 'authorized') {
    const locatedId = input.locatedAddressId ?? null;
    if (locatedId !== null) {
      const located = input.book.get(locatedId);
      if (located !== undefined) {
        return freezeResolution({
          status: 'ready',
          permission: input.permission,
          selectedAddressId: located.addressId,
          selectedAddressRef: located.ref,
          selectionSource: 'locating_authorized',
          requiresExplicitSelection: false,
          detail: '定位已授权，使用定位得到的地址',
        });
      }
    }
    const fallback = input.book.defaultAddress;
    if (fallback !== null) {
      return freezeResolution({
        status: 'ready',
        permission: input.permission,
        selectedAddressId: fallback.addressId,
        selectedAddressRef: fallback.ref,
        selectionSource: 'default_authorized',
        requiresExplicitSelection: false,
        detail: '定位已授权，使用默认地址',
      });
    }
  }

  // 未授权 / 被拒 / 撤销且没有显式选择：只要求用户显式选择，绝不自动换地址。
  return freezeResolution({
    status: 'needs_explicit_selection',
    permission: input.permission,
    selectedAddressId: null,
    selectedAddressRef: null,
    selectionSource: 'none',
    requiresExplicitSelection: true,
    detail: '定位不可用且没有显式选择的地址；必须由用户显式选择，不自动替换地址',
  });
}

function freezeResolution(resolution: DeliveryResolution): DeliveryResolution {
  return Object.freeze({
    ...resolution,
    selectedAddressId: resolution.selectedAddressId,
    selectedAddressRef: resolution.selectedAddressRef,
  });
}

/**
 * 要求解析结果给出可用地址引用：未就绪则抛 `AddressSelectionRequiredError`。
 * 这是「必须显式失败」的执行点——调用方拿到的是异常，不是某个「顺手挑的」地址。
 */
export function requireDeliveryAddressRef(resolution: DeliveryResolution): string {
  if (resolution.status !== 'ready' || resolution.selectedAddressRef === null) {
    throw new AddressSelectionRequiredError(resolution.permission, resolution.detail);
  }
  return resolution.selectedAddressRef;
}

/**
 * 完整配送明细端口。**唯一**带手机号明文的出口。
 *
 * `purpose` 必填且只接受 `order_delivery`；引用必须与当前记录**逐字**匹配
 * （版本不符即拒绝），避免拿旧引用取到新地址的明文。
 */
export function createDeliveryDetailPort(book: AddressBookView): {
  resolveDeliveryDetail(addressRef: string, purpose: string): Promise<DeliveryDetail>;
} {
  return Object.freeze({
    async resolveDeliveryDetail(addressRef: string, purpose: string): Promise<DeliveryDetail> {
      if (purpose !== 'order_delivery') {
        throw new AddressValidationError(
          `DeliveryDetailPort 只允许在 order_delivery 用途下取用完整地址，收到 ${JSON.stringify(purpose)}`,
        );
      }
      const parsed = parseAddressRef(addressRef);
      if (parsed === null) {
        throw new AddressValidationError(`地址引用形状非法：${JSON.stringify(addressRef)}`);
      }
      const record = book.get(parsed.addressId);
      if (record === undefined) {
        throw new AddressNotFoundError(parsed.addressId);
      }
      if (record.ref !== addressRef) {
        throw new AddressValidationError(
          `地址引用版本不符：请求 ${addressRef}，当前 ${record.ref}（拒绝用旧引用取明文）`,
        );
      }
      return Object.freeze({
        addressRef: record.ref,
        addressId: record.addressId,
        version: record.version,
        contactName: record.contactName,
        phone: record.phone,
        region: record.region,
        detail: record.detail,
        lat: record.lat,
        lng: record.lng,
        purpose: 'order_delivery',
      });
    },
  });
}
