/**
 * M05 收货地址簿（无端口、无价格、纯确定性）。
 *
 * ## 版本纪律（本模块的核心）
 *
 * 每次**实质**修改（任何字段的值真的变了）都会：
 * - `version` +1；
 * - `contentDigest` 重算（`av1-` 指纹）；
 * - `ref` 变成 `<addressId>#v<version>`。
 *
 * 于是「地址一旦被修改，绑定它的报价/确认必须可判定失效」不再依赖调用方自觉：
 * 引用本身就变了（`./binding.ts` 之外，M04 的 `paramsDigest` 也会随之变化）。
 *
 * 无操作（把某字段设成原值、`setDefault` 指向已经默认的地址）**不**计版本——
 * 与 M04 的 `revision` 同一纪律：没变也失效会让失效规则变成噪音。
 *
 * 本类不读时钟、不读随机、不读环境。
 */

import { computeAddressContentDigest, makeAddressRef } from './digest.js';
import { AddressNotFoundError, AddressValidationError } from './errors.js';
import type {
  AddressInput,
  AddressPatch,
  AddressRecord,
  AddressSource,
} from './types.js';

const PHONE_PATTERN = /^\+?\d{5,20}$/;

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AddressValidationError(`${label} 不能为空`);
  }
  return value;
}

function normalizePhone(value: unknown): string {
  if (typeof value !== 'string' || !PHONE_PATTERN.test(value)) {
    throw new AddressValidationError(
      `phone 必须是 5–20 位数字（可带前导 +），收到 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function normalizeCoordinate(value: number | null | undefined, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AddressValidationError(`${label} 必须是 [${min}, ${max}] 内的有限数，收到 ${String(value)}`);
  }
  return value;
}

function freezeRecord(record: AddressRecord): AddressRecord {
  return Object.freeze({ ...record });
}

/** 地址簿。 */
export class AddressBook {
  readonly #records = new Map<string, AddressRecord>();
  /** 插入顺序，用于 `list()` 稳定输出。 */
  readonly #order: string[] = [];
  /** 定位产生的地址 id，按产生顺序，用于 `latestLocatedAddress()`。 */
  readonly #locatedOrder: string[] = [];
  #defaultAddressId: string | null = null;

  /** 新增地址（版本从 1 起）。 */
  add(input: AddressInput): AddressRecord {
    const addressId = requireNonEmpty(input.addressId, 'addressId');
    if (this.#records.has(addressId)) {
      throw new AddressValidationError(`地址 ${addressId} 已存在`);
    }
    const source: AddressSource = input.source ?? 'manual';
    if (source !== 'manual' && source !== 'located') {
      throw new AddressValidationError(`source 只能是 manual / located，收到 ${String(source)}`);
    }
    const record = this.#buildRecord(addressId, 1, {
      label: requireNonEmpty(input.label, 'label'),
      contactName: requireNonEmpty(input.contactName, 'contactName'),
      phone: normalizePhone(input.phone),
      region: requireNonEmpty(input.region, 'region'),
      detail: requireNonEmpty(input.detail, 'detail'),
      lat: normalizeCoordinate(input.lat, 'lat', -90, 90),
      lng: normalizeCoordinate(input.lng, 'lng', -180, 180),
      source,
    });
    this.#records.set(addressId, record);
    this.#order.push(addressId);
    if (source === 'located') {
      this.#locatedOrder.push(addressId);
    }
    return record;
  }

  /**
   * 修改地址。任何字段值真的变了 ⇒ 版本 +1（引用与指纹同步变化）。
   * 全部给的值与现值相同 ⇒ 无操作（不计版本）。
   */
  update(addressId: string, patch: AddressPatch): AddressRecord {
    const current = this.require(addressId);
    const next = {
      label: patch.label === undefined ? current.label : requireNonEmpty(patch.label, 'label'),
      contactName:
        patch.contactName === undefined ? current.contactName : requireNonEmpty(patch.contactName, 'contactName'),
      phone: patch.phone === undefined ? current.phone : normalizePhone(patch.phone),
      region: patch.region === undefined ? current.region : requireNonEmpty(patch.region, 'region'),
      detail: patch.detail === undefined ? current.detail : requireNonEmpty(patch.detail, 'detail'),
      lat: patch.lat === undefined ? current.lat : normalizeCoordinate(patch.lat, 'lat', -90, 90),
      lng: patch.lng === undefined ? current.lng : normalizeCoordinate(patch.lng, 'lng', -180, 180),
      source: current.source,
    };
    const samePayload =
      computeAddressContentDigest(next) === current.contentDigest;
    if (samePayload) {
      return current;
    }
    const updated = this.#buildRecord(addressId, current.version + 1, next);
    this.#records.set(addressId, updated);
    return updated;
  }

  /**
   * 删除地址。
   *
   * 若删掉的正是默认地址，`defaultAddressId` 归 `null`，**不**静默改指另一条
   * ——默认地址的变更必须由用户显式 `setDefault`。
   */
  remove(addressId: string): AddressRecord {
    const current = this.require(addressId);
    this.#records.delete(addressId);
    const orderIndex = this.#order.indexOf(addressId);
    if (orderIndex >= 0) this.#order.splice(orderIndex, 1);
    const locatedIndex = this.#locatedOrder.indexOf(addressId);
    if (locatedIndex >= 0) this.#locatedOrder.splice(locatedIndex, 1);
    if (this.#defaultAddressId === addressId) {
      this.#defaultAddressId = null;
    }
    return current;
  }

  /** 设默认地址。这是**元数据**变更，不改内容、不计版本（报价不受影响）。 */
  setDefault(addressId: string): AddressRecord {
    const current = this.require(addressId);
    this.#defaultAddressId = addressId;
    return current;
  }

  /** 清除默认地址。 */
  clearDefault(): void {
    this.#defaultAddressId = null;
  }

  get size(): number {
    return this.#records.size;
  }

  get defaultAddressId(): string | null {
    return this.#defaultAddressId;
  }

  get defaultAddress(): AddressRecord | null {
    if (this.#defaultAddressId === null) return null;
    return this.#records.get(this.#defaultAddressId) ?? null;
  }

  get(addressId: string): AddressRecord | undefined {
    return this.#records.get(addressId);
  }

  /** 取地址，不存在则抛 `AddressNotFoundError`。 */
  require(addressId: string): AddressRecord {
    const found = this.#records.get(addressId);
    if (found === undefined) {
      throw new AddressNotFoundError(addressId);
    }
    return found;
  }

  /** 按插入顺序列出全部地址。 */
  list(): readonly AddressRecord[] {
    return Object.freeze(this.#order.map((id) => this.#records.get(id)).filter((r): r is AddressRecord => r !== undefined));
  }

  /** 最近一次由定位产生的地址；没有则为 `null`。 */
  latestLocatedAddress(): AddressRecord | null {
    for (let index = this.#locatedOrder.length - 1; index >= 0; index -= 1) {
      const id = this.#locatedOrder[index];
      if (id === undefined) continue;
      const found = this.#records.get(id);
      if (found !== undefined) return found;
    }
    return null;
  }

  #buildRecord(
    addressId: string,
    version: number,
    fields: {
      label: string;
      contactName: string;
      phone: string;
      region: string;
      detail: string;
      lat: number | null;
      lng: number | null;
      source: AddressSource;
    },
  ): AddressRecord {
    return freezeRecord({
      addressId,
      label: fields.label,
      contactName: fields.contactName,
      phone: fields.phone,
      region: fields.region,
      detail: fields.detail,
      lat: fields.lat,
      lng: fields.lng,
      source: fields.source,
      version,
      contentDigest: computeAddressContentDigest(fields),
      ref: makeAddressRef(addressId, version),
    });
  }
}
